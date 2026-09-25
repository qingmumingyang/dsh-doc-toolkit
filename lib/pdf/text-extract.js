/**
 * 自研 PDF 文本提取器（零第三方依赖、无任何 I/O）。
 *
 * ## 为什么自己写
 *
 * 插件的运行时依赖必须为零（DSH STORE 的固定源自动策略不允许运行依赖），而 `pdf-parse`
 * 内置整份 pdf.js，既不能随包发布（体积/许可证），也不能作为依赖声明。这里只实现
 * "读出文本层"这一件事，遇到不会的东西**降级**而不是猜：解不开的流返回"无文本"，
 * 加密文件明确报错，损坏的交叉引用回退到全文件扫描。
 *
 * ## 覆盖范围
 *
 * - 交叉引用：经典 `xref` 表、交叉引用流（`/Type /XRef` + `/W` + `/Index`）、
 *   `/Prev` 链、对象流（`/Type /ObjStm`）；三者任一损坏时回退到扫描 `N G obj` 重建索引。
 * - 流解码：`/FlateDecode`（含 PNG/TIFF 预测器）、`/ASCIIHexDecode`、`/ASCII85Decode`、
 *   无过滤器；其余过滤器（DCT/JPX/JBIG2/CCITT/LZW/加密）视为"无法解码"，
 *   该页按无文本处理，不抛错也不输出乱码。
 * - 文本算子：`BT`/`ET`、`Tf`、`Td`/`TD`/`Tm`/`T*`/`TL`、`Tj`/`TJ`/`'`/`"`，
 *   字面字符串（含 `\ddd` 八进制、`\(`、`\\`、续行）与十六进制字符串。
 * - 字体：`/ToUnicode` CMap（`bfchar`/`bfrange`，含数组形式）优先；
 *   简单字体的 `/Encoding`（WinAnsi 走 cp1252、Standard/MacRoman 近似 Latin-1）
 *   与 `/Differences` 字形名；都没有时按码位回退。
 * - 边界：`maxBytes`（解析前拒绝）、`maxPages`、`maxChars`、`maxObjects`，
 *   触顶时置 `truncated` 并停止收集，绝不无界循环。
 */
import { inflateRawSync, inflateSync } from 'node:zlib';
/** 缺省边界：足够大以覆盖正常文档，又能在恶意输入上兜住内存与时间。 */
export const PDF_EXTRACT_DEFAULTS = {
    maxBytes: 64 * 1024 * 1024,
    maxPages: 2000,
    maxChars: 4_000_000,
    maxObjects: 200_000,
};
/**
 * `TJ` 数组里小于等于该值的调整量视为词间空格（PDF 中负值表示把文字向右推）。
 * 取 -120/1000 em：常见字距调整远小于它，真正的词间空格远大于它。
 */
export const TJ_FORWARD_WORD_GAP = -120;
/** 本实现**明确不做**的事，供使用方与复核者判断适用性。 */
export const UNSUPPORTED = [
    '加密文档（/Encrypt）：明确报错，绝不输出乱码',
    'CFF/Type1 字形名表：Unicode 只来自 /ToUnicode、/Encoding /Differences 或码位本身',
    '竖排（/Identity-V、/WMode 1）：码位仍走 /ToUnicode，但不建模列序与旋转',
    'Type3 /FontMatrix 与字形过程（按默认 500/1000 宽度处理）',
    '图像滤镜（DCT/JPX/JBIG2/CCITT）：这类流没有可提取文本，按无文本处理',
    '/UseCMap 间接引用：不解析被引用的 CMap',
    '标签化 PDF（/StructTreeRoot、/ActualText）：阅读顺序即内容流顺序',
    '表单 XObject、注释、页标签与文档元数据',
    'Unicode 规范化、跨行断词还原与分栏检测',
];
/* ==========================================================================
 * 字节工具
 * ======================================================================== */
const CH_NUL = 0x00;
const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_FF = 0x0c;
const CH_CR = 0x0d;
const CH_SP = 0x20;
/** 该字节是否是 PDF 的空白字符。 */
function isWhite(byte) {
    return byte === CH_SP || byte === CH_LF || byte === CH_CR || byte === CH_TAB || byte === CH_FF || byte === CH_NUL;
}
/** 该字节是否是 PDF 的分隔符。 */
function isDelimiter(byte) {
    return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b
        || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}
/** 该字节是否是 PDF 的常规字符（名字/数字的组成字符）。 */
function isRegular(byte) {
    return !isWhite(byte) && !isDelimiter(byte);
}
/** 把字节区间解码为 latin1 字符串（PDF 的语法层是字节导向的）。 */
function latin1(bytes, start, end) {
    let out = '';
    const stop = Math.min(end, bytes.length);
    for (let index = start; index < stop; index += 1)
        out += String.fromCharCode(bytes[index]);
    return out;
}
/** 在字节数组里查找 ASCII 串，找不到返回 -1。 */
function indexOfText(bytes, needle, from = 0) {
    const first = needle.charCodeAt(0);
    const limit = bytes.length - needle.length;
    for (let index = Math.max(0, from); index <= limit; index += 1) {
        if (bytes[index] !== first)
            continue;
        let matched = true;
        for (let offset = 1; offset < needle.length; offset += 1) {
            if (bytes[index + offset] !== needle.charCodeAt(offset)) {
                matched = false;
                break;
            }
        }
        if (matched)
            return index;
    }
    return -1;
}
/** 从后往前查找 ASCII 串，找不到返回 -1。 */
function lastIndexOfText(bytes, needle, from) {
    const start = from === undefined ? bytes.length - needle.length : Math.min(from, bytes.length - needle.length);
    for (let index = start; index >= 0; index -= 1) {
        let matched = true;
        for (let offset = 0; offset < needle.length; offset += 1) {
            if (bytes[index + offset] !== needle.charCodeAt(offset)) {
                matched = false;
                break;
            }
        }
        if (matched)
            return index;
    }
    return -1;
}
const NULL_VALUE = { k: 'null' };
/** 解析游标：在字节数组上前后移动。 */
class Cursor {
    bytes;
    pos;
    constructor(bytes, pos = 0) {
        this.bytes = bytes;
        this.pos = pos;
    }
    atEnd() { return this.pos >= this.bytes.length; }
    peek() { return this.pos < this.bytes.length ? this.bytes[this.pos] : -1; }
}
/** 跳过空白与 `%` 注释。 */
function skipSpace(cursor) {
    const { bytes } = cursor;
    while (cursor.pos < bytes.length) {
        const byte = bytes[cursor.pos];
        if (isWhite(byte)) {
            cursor.pos += 1;
            continue;
        }
        if (byte === 0x25) { // '%'
            while (cursor.pos < bytes.length && bytes[cursor.pos] !== CH_LF && bytes[cursor.pos] !== CH_CR)
                cursor.pos += 1;
            continue;
        }
        break;
    }
}
/** 读一个常规 token（名字体、数字体、关键字）。 */
function readRegular(cursor) {
    const start = cursor.pos;
    while (cursor.pos < cursor.bytes.length && isRegular(cursor.bytes[cursor.pos]))
        cursor.pos += 1;
    return latin1(cursor.bytes, start, cursor.pos);
}
/**
 * 跳过空白后读一个 token。
 *
 * PDF 里 token 之间几乎总隔着空白（`1 0 R`、`5 0 obj`、`n \n`），而 {@link readRegular}
 * 不跳空白——凡是"期望这里有个 token"的地方都必须用这个函数，否则会读到空串并停住。
 */
function readToken(cursor) {
    skipSpace(cursor);
    return readRegular(cursor);
}
/** 解析一个名字（已确认当前字符是 `/`）。 */
function parseName(cursor) {
    cursor.pos += 1; // '/'
    const start = cursor.pos;
    while (cursor.pos < cursor.bytes.length && isRegular(cursor.bytes[cursor.pos]))
        cursor.pos += 1;
    const raw = latin1(cursor.bytes, start, cursor.pos);
    // `#xx` 十六进制转义
    return raw.replace(/#([0-9A-Fa-f]{2})/g, (_all, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
/** 解析字面字符串 `(...)`，处理转义与嵌套括号。 */
function parseLiteralString(cursor) {
    cursor.pos += 1; // '('
    const out = [];
    let depth = 1;
    const { bytes } = cursor;
    while (cursor.pos < bytes.length) {
        const byte = bytes[cursor.pos];
        if (byte === 0x5c) { // 反斜杠
            cursor.pos += 1;
            const next = bytes[cursor.pos];
            if (next === undefined)
                break;
            if (next === CH_LF) {
                cursor.pos += 1;
                continue;
            }
            if (next === CH_CR) {
                cursor.pos += 1;
                if (bytes[cursor.pos] === CH_LF)
                    cursor.pos += 1;
                continue;
            }
            const octal = /^[0-7]$/.test(String.fromCharCode(next));
            if (octal) {
                let value = 0;
                let digits = 0;
                while (digits < 3 && cursor.pos < bytes.length) {
                    const digit = bytes[cursor.pos];
                    if (digit < 0x30 || digit > 0x37)
                        break;
                    value = value * 8 + (digit - 0x30);
                    cursor.pos += 1;
                    digits += 1;
                }
                out.push(value & 0xff);
                continue;
            }
            const simple = { n: CH_LF, r: CH_CR, t: CH_TAB, b: 0x08, f: CH_FF };
            const mapped = simple[String.fromCharCode(next)];
            out.push(mapped === undefined ? next : mapped);
            cursor.pos += 1;
            continue;
        }
        if (byte === 0x28) {
            depth += 1;
            out.push(byte);
            cursor.pos += 1;
            continue;
        }
        if (byte === 0x29) {
            depth -= 1;
            cursor.pos += 1;
            if (depth === 0)
                break;
            out.push(byte);
            continue;
        }
        out.push(byte);
        cursor.pos += 1;
    }
    return Uint8Array.from(out);
}
/** 解析十六进制字符串 `<...>`。非法字符按宽容处理（跳过），对齐到字节。 */
function parseHexString(cursor) {
    cursor.pos += 1; // '<'
    const digits = [];
    const { bytes } = cursor;
    while (cursor.pos < bytes.length) {
        const byte = bytes[cursor.pos];
        cursor.pos += 1;
        if (byte === 0x3e)
            break; // '>'
        const char = String.fromCharCode(byte);
        if (/[0-9A-Fa-f]/.test(char))
            digits.push(Number.parseInt(char, 16));
        else if (isWhite(byte))
            continue;
        // 其它字符（畸形输入）跳过，保证不抛错
    }
    if (digits.length % 2 === 1)
        digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let index = 0; index < out.length; index += 1)
        out[index] = (digits[index * 2] << 4) | digits[index * 2 + 1];
    return out;
}
/** 解析对象体的第一个数字（用于判断 `num gen R`）。 */
function lookupNumberStart(cursor) {
    const save = cursor.pos;
    skipSpace(cursor);
    const start = cursor.pos;
    const token = readRegular(cursor);
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
        cursor.pos = save;
        return undefined;
    }
    return { value: Number(token), next: start };
}
/** 解析一个完整对象（不含 `obj`/`endobj` 包裹）。 */
function parseValue(cursor, depth = 0) {
    if (depth > 64)
        return NULL_VALUE;
    skipSpace(cursor);
    const byte = cursor.peek();
    if (byte < 0)
        return NULL_VALUE;
    if (byte === 0x2f)
        return { k: 'name', s: parseName(cursor) };
    if (byte === 0x28)
        return { k: 'str', bytes: parseLiteralString(cursor) };
    if (byte === 0x5b) { // '['
        cursor.pos += 1;
        const items = [];
        for (;;) {
            skipSpace(cursor);
            if (cursor.atEnd())
                break;
            if (cursor.peek() === 0x5d) {
                cursor.pos += 1;
                break;
            }
            const before = cursor.pos;
            items.push(parseValue(cursor, depth + 1));
            if (cursor.pos === before) {
                cursor.pos += 1;
            } // 防御：绝不原地打转
            if (items.length > 1_000_000)
                break;
        }
        return { k: 'arr', items };
    }
    if (byte === 0x3c) { // '<'
        if (cursor.bytes[cursor.pos + 1] === 0x3c) {
            cursor.pos += 2;
            const map = new Map();
            for (;;) {
                skipSpace(cursor);
                if (cursor.atEnd())
                    break;
                if (cursor.peek() === 0x3e && cursor.bytes[cursor.pos + 1] === 0x3e) {
                    cursor.pos += 2;
                    break;
                }
                if (cursor.peek() !== 0x2f) {
                    // 畸形的字典（缺键）:前进一步继续找，绝不一路吞掉后面的内容。
                    cursor.pos += 1;
                    continue;
                }
                const key = parseName(cursor);
                skipSpace(cursor);
                // 键后直接是 `>>`：畸形但常见，按空值处理并结束，不要把它当成值的开始
                // （否则值解析会吃掉第一个 '>'，剩下的 '>' 让 `>>` 检测失效，进而吞掉整段内容流）。
                if (cursor.peek() === 0x3e && cursor.bytes[cursor.pos + 1] === 0x3e) {
                    cursor.pos += 2;
                    break;
                }
                map.set(key, parseValue(cursor, depth + 1));
                if (map.size > 100_000)
                    break;
            }
            return { k: 'dict', map };
        }
        return { k: 'str', bytes: parseHexString(cursor) };
    }
    // 数字 / 引用 / 布尔 / null 都以常规字符开头
    const save = cursor.pos;
    const token = readRegular(cursor);
    if (token === '') {
        cursor.pos = save + 1;
        return NULL_VALUE;
    }
    if (token === 'true')
        return { k: 'bool', b: true };
    if (token === 'false')
        return { k: 'bool', b: false };
    if (token === 'null')
        return NULL_VALUE;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
        // 可能是 `num gen R`
        const afterFirst = cursor.pos;
        const second = lookupNumberStart(cursor);
        if (second !== undefined) {
            const afterSecond = cursor.pos;
            const keyword = readToken(cursor);
            if (keyword === 'R')
                return { k: 'ref', num: Number(token), gen: second.value };
            cursor.pos = afterSecond;
        }
        cursor.pos = afterFirst;
        return { k: 'num', n: Number(token) };
    }
    return NULL_VALUE;
}
/** 一份已加载的 PDF。 */
class PdfDocument {
    bytes;
    maxObjects;
    cache = new Map();
    xref = new Map();
    trailer = new Map();
    objectStreams = new Map();
    scanOffsets;
    parsedObjects = 0;
    constructor(bytes, maxObjects) {
        this.bytes = bytes;
        this.maxObjects = maxObjects;
    }
    countObject() {
        this.parsedObjects += 1;
        return this.parsedObjects <= this.maxObjects;
    }
    /** 取一个间接对象；不存在或无法解析时返回 undefined。 */
    getObject(num) {
        const cached = this.cache.get(num);
        if (cached !== undefined)
            return cached;
        if (!this.countObject())
            return undefined;
        const entry = this.xref.get(num);
        let value;
        if (entry?.kind === 1)
            value = this.parseObjectAt(entry.offset, num);
        else if (entry?.kind === 2)
            value = this.objectStreams.get(entry.streamNum)?.get(num) ?? this.loadObjectStream(entry.streamNum)?.get(num);
        if (value === undefined) {
            // 交叉引用不可信（损坏或被裁剪）：回退到全文件扫描。
            const offsets = this.scanIndex();
            const fallback = offsets.get(num);
            if (fallback !== undefined)
                value = this.parseObjectAt(fallback, num);
        }
        if (value === undefined)
            return undefined;
        this.cache.set(num, value);
        return value;
    }
    /** 解引用：ref 取对象，其它原样返回。 */
    resolve(value) {
        let current = value;
        for (let hops = 0; hops < 32 && current?.k === 'ref'; hops += 1)
            current = this.getObject(current.num);
        return current;
    }
    /** 解析字典（自动解引用）。 */
    resolveDict(value) {
        const resolved = this.resolve(value);
        return resolved?.k === 'dict' ? resolved.map : undefined;
    }
    /** 读取字典里的数字字段（自动解引用）。 */
    numberField(map, key) {
        if (map === undefined)
            return undefined;
        const resolved = this.resolve(map.get(key));
        return resolved?.k === 'num' ? resolved.n : undefined;
    }
    /** 读取字典里的名字字段（自动解引用）。 */
    nameField(map, key) {
        if (map === undefined)
            return undefined;
        const resolved = this.resolve(map.get(key));
        return resolved?.k === 'name' ? resolved.s : undefined;
    }
    /** 在指定偏移解析间接对象，并校验对象号。 */
    parseObjectAt(offset, expected) {
        if (offset < 0 || offset >= this.bytes.length)
            return undefined;
        const cursor = new Cursor(this.bytes, offset);
        skipSpace(cursor);
        const head = lookupNumberStart(cursor);
        if (head === undefined || head.value !== expected)
            return undefined;
        const gen = lookupNumberStart(cursor);
        if (gen === undefined)
            return undefined;
        if (readToken(cursor) !== 'obj')
            return undefined;
        const value = parseValue(cursor);
        if (value.k !== 'dict')
            return value;
        // 可能是流：`stream` 关键字必须紧跟字典。
        const save = cursor.pos;
        if (readToken(cursor) !== 'stream') {
            cursor.pos = save;
            return value;
        }
        // 流数据从 `stream` 后的行尾开始
        if (this.bytes[cursor.pos] === CH_CR)
            cursor.pos += 1;
        if (this.bytes[cursor.pos] === CH_LF)
            cursor.pos += 1;
        const start = cursor.pos;
        const declared = this.numberField(value.map, 'Length');
        let length = declared !== undefined && declared >= 0 ? declared : -1;
        if (length < 0 || start + length > this.bytes.length) {
            const end = indexOfText(this.bytes, 'endstream', start);
            length = end < 0 ? this.bytes.length - start : end - start;
        }
        const data = this.bytes.subarray(start, Math.min(start + length, this.bytes.length));
        return { k: 'stream', map: value.map, data };
    }
    /** 全文件扫描 `N G obj`，重建对象号 → 偏移的索引（仅建立一次）。 */
    scanIndex() {
        if (this.scanOffsets !== undefined)
            return this.scanOffsets;
        const offsets = new Map();
        const bytes = this.bytes;
        for (let index = 0; index + 3 < bytes.length; index += 1) {
            if (bytes[index] !== 0x6f || bytes[index + 1] !== 0x62 || bytes[index + 2] !== 0x6a)
                continue; // 'obj'
            if (index > 0 && isRegular(bytes[index - 1]))
                continue;
            // 往回读 `<num> <gen> obj`
            let back = index - 1;
            while (back >= 0 && isWhite(bytes[back]))
                back -= 1;
            const genEnd = back + 1;
            while (back >= 0 && bytes[back] >= 0x30 && bytes[back] <= 0x39)
                back -= 1;
            const genStart = back + 1;
            if (genStart === genEnd)
                continue;
            while (back >= 0 && isWhite(bytes[back]))
                back -= 1;
            const numEnd = back + 1;
            while (back >= 0 && bytes[back] >= 0x30 && bytes[back] <= 0x39)
                back -= 1;
            const numStart = back + 1;
            if (numStart === numEnd)
                continue;
            if (numStart > 0 && isRegular(bytes[numStart - 1]))
                continue;
            const num = Number(latin1(bytes, numStart, numEnd));
            if (!Number.isSafeInteger(num) || num <= 0 || offsets.has(num))
                continue;
            offsets.set(num, numStart);
        }
        this.scanOffsets = offsets;
        return offsets;
    }
    /** 加载一个对象流，返回其中所有对象。 */
    loadObjectStream(streamNum) {
        const existing = this.objectStreams.get(streamNum);
        if (existing !== undefined)
            return existing;
        const stream = this.resolve({ k: 'ref', num: streamNum, gen: 0 });
        if (stream?.k !== 'stream')
            return undefined;
        if (this.nameField(stream.map, 'Type') !== 'ObjStm')
            return undefined;
        const data = this.decodeStream(stream);
        if (data === undefined)
            return undefined;
        const count = this.numberField(stream.map, 'N') ?? 0;
        const first = this.numberField(stream.map, 'First') ?? 0;
        const header = latin1(data, 0, Math.min(first, data.length));
        const numbers = header.split(/\s+/).filter((token) => token.length > 0).map(Number);
        const objects = new Map();
        for (let index = 0; index < count; index += 1) {
            const num = numbers[index * 2];
            const offset = numbers[index * 2 + 1];
            if (num === undefined || offset === undefined || !Number.isFinite(num) || !Number.isFinite(offset))
                break;
            const cursor = new Cursor(data, Math.min(first + offset, data.length));
            objects.set(num, parseValue(cursor));
            if (objects.size > 100_000)
                break;
        }
        this.objectStreams.set(streamNum, objects);
        return objects;
    }
    /** 按 /Filter（与 /DecodeParms）解码流；无法解码时返回 undefined。 */
    decodeStream(stream) {
        const filters = [];
        const filterValue = this.resolve(stream.map.get('Filter'));
        if (filterValue?.k === 'name')
            filters.push(filterValue.s);
        else if (filterValue?.k === 'arr') {
            for (const item of filterValue.items) {
                const resolved = this.resolve(item);
                if (resolved?.k === 'name')
                    filters.push(resolved.s);
                else if (resolved?.k === 'arr' && resolved.items.length > 0) {
                    const first = this.resolve(resolved.items[0]);
                    if (first?.k === 'name')
                        filters.push(first.s); // [/FlateDecode /Predictor] 旧式写法
                }
            }
        }
        const parmsValue = this.resolve(stream.map.get('DecodeParms'));
        const parmsList = [];
        if (parmsValue?.k === 'dict')
            parmsList.push(parmsValue.map);
        else if (parmsValue?.k === 'arr')
            for (const item of parmsValue.items)
                parmsList.push(this.resolveDict(item));
        let data = stream.data;
        if (filters.length === 0)
            return data;
        for (let index = 0; index < filters.length; index += 1) {
            const filter = filters[index];
            const parms = parmsList[index] ?? parmsList[0];
            if (filter === 'FlateDecode' || filter === 'Fl') {
                const inflated = inflate(data);
                if (inflated === undefined)
                    return undefined;
                data = inflated;
                const predicted = applyPredictor(data, this.numberField(parms, 'Predictor'), this.numberField(parms, 'Colors'), this.numberField(parms, 'BitsPerComponent'), this.numberField(parms, 'Columns'));
                if (predicted === undefined)
                    return undefined;
                data = predicted;
                continue;
            }
            if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
                data = asciiHexDecode(data);
                continue;
            }
            if (filter === 'ASCII85Decode' || filter === 'A85') {
                const decoded = ascii85Decode(data);
                if (decoded === undefined)
                    return undefined;
                data = decoded;
                continue;
            }
            // 其它过滤器（图像、LZW、加密）一律"无法解码"，由调用方按无文本处理。
            return undefined;
        }
        return data;
    }
    /** 已知的对象号（升序）：用于没有 Catalog 时的页扫描回退。 */
    objectNumbers() {
        return [...this.scanIndex().keys()].sort((a, b) => a - b);
    }
    /** 从 trailer 或全文件扫描里找文档目录。 */
    catalog() {
        const direct = this.resolveDict(this.trailer.get('Root'));
        if (direct !== undefined)
            return direct;
        // 没有可用 trailer：扫描所有对象，找 /Type /Catalog。
        for (const num of this.objectNumbers()) {
            const dict = this.resolveDict({ k: 'ref', num, gen: 0 });
            if (dict !== undefined && this.nameField(dict, 'Type') === 'Catalog')
                return dict;
        }
        return undefined;
    }
}
/** zlib 解压：先按 zlib 头解，失败再按裸 deflate 解。 */
function inflate(data) {
    try {
        return new Uint8Array(inflateSync(data));
    }
    catch { /* 继续尝试 */ }
    try {
        return new Uint8Array(inflateRawSync(data));
    }
    catch {
        return undefined;
    }
}
/** ASCIIHex 解码：遇到 `>` 结束，忽略空白。 */
function asciiHexDecode(data) {
    const digits = [];
    for (const byte of data) {
        if (byte === 0x3e)
            break;
        const char = String.fromCharCode(byte);
        if (/[0-9A-Fa-f]/.test(char))
            digits.push(Number.parseInt(char, 16));
    }
    if (digits.length % 2 === 1)
        digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let index = 0; index < out.length; index += 1)
        out[index] = (digits[index * 2] << 4) | digits[index * 2 + 1];
    return out;
}
/** ASCII85 解码。 */
function ascii85Decode(data) {
    const out = [];
    let group = [];
    for (let index = 0; index < data.length; index += 1) {
        const byte = data[index];
        if (isWhite(byte))
            continue;
        if (byte === 0x7e)
            break; // '~' 之后的 '>' 是结束标记
        if (byte === 0x7a && group.length === 0) {
            out.push(0, 0, 0, 0);
            continue;
        } // 'z'
        if (byte < 0x21 || byte > 0x75)
            return undefined;
        group.push(byte - 0x21);
        if (group.length === 5) {
            let value = 0;
            for (const digit of group)
                value = value * 85 + digit;
            out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
            group = [];
        }
    }
    if (group.length > 1) {
        const padding = 5 - group.length;
        let value = 0;
        for (let index = 0; index < 5; index += 1)
            value = value * 85 + (group[index] ?? 84);
        const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
        out.push(...bytes.slice(0, 4 - padding));
    }
    return Uint8Array.from(out);
}
/** 应用 PNG/TIFF 预测器；无法处理时返回 undefined。 */
function applyPredictor(data, predictor, colors, bits, columns) {
    if (predictor === undefined || predictor <= 1)
        return data;
    const colorCount = colors !== undefined && colors > 0 ? colors : 1;
    const bitsPerComponent = bits !== undefined && bits > 0 ? bits : 8;
    const columnCount = columns !== undefined && columns > 0 ? columns : 1;
    const bpp = Math.max(1, Math.ceil((colorCount * bitsPerComponent) / 8));
    const rowLength = Math.max(1, Math.ceil((colorCount * bitsPerComponent * columnCount) / 8));
    if (predictor === 2) {
        // TIFF predictor 2：仅支持 8 位分量（最常见），其它位宽按原样返回。
        if (bitsPerComponent !== 8)
            return data;
        const rows = Math.floor(data.length / rowLength);
        const out = Uint8Array.from(data);
        for (let row = 0; row < rows; row += 1) {
            const base = row * rowLength;
            for (let index = bpp; index < rowLength; index += 1) {
                out[base + index] = (out[base + index] + out[base + index - bpp]) & 0xff;
            }
        }
        return out;
    }
    if (predictor < 10 || predictor > 15)
        return undefined;
    // PNG 预测器：每行前面有一个过滤器类型字节
    const rows = Math.floor(data.length / (rowLength + 1));
    const out = new Uint8Array(rows * rowLength);
    let previous = new Uint8Array(rowLength);
    for (let row = 0; row < rows; row += 1) {
        const filter = data[row * (rowLength + 1)];
        const line = data.subarray(row * (rowLength + 1) + 1, row * (rowLength + 1) + 1 + rowLength);
        const current = new Uint8Array(rowLength);
        for (let index = 0; index < rowLength; index += 1) {
            const raw = line[index];
            const left = index >= bpp ? current[index - bpp] : 0;
            const up = previous[index];
            const upLeft = index >= bpp ? previous[index - bpp] : 0;
            let value;
            switch (filter) {
                case 0:
                    value = raw;
                    break;
                case 1:
                    value = raw + left;
                    break;
                case 2:
                    value = raw + up;
                    break;
                case 3:
                    value = raw + ((left + up) >> 1);
                    break;
                case 4: {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
                    break;
                }
                default: return undefined;
            }
            current[index] = value & 0xff;
        }
        out.set(current, row * rowLength);
        previous = current;
    }
    return out;
}
/* ==========================================================================
 * 交叉引用解析
 * ======================================================================== */
/** 解析经典 xref 表或交叉引用流，返回是否成功。 */
function readXrefSection(doc, offset, depth) {
    if (depth > 32 || offset < 0 || offset >= doc.bytes.length)
        return false;
    const cursor = new Cursor(doc.bytes, offset);
    skipSpace(cursor);
    if (indexOfText(doc.bytes, 'xref', offset) === offset) {
        cursor.pos = offset + 4;
        // 小节：`<start> <count>` 后跟 count 条 20 字节记录
        for (;;) {
            skipSpace(cursor);
            const peek = cursor.peek();
            if (peek === 0x74) { // 't' → trailer
                readToken(cursor);
                const trailerValue = parseValue(cursor);
                if (trailerValue.k === 'dict') {
                    for (const [key, value] of trailerValue.map)
                        if (!doc.trailer.has(key))
                            doc.trailer.set(key, value);
                    const prev = doc.numberField(trailerValue.map, 'Prev');
                    if (prev !== undefined)
                        readXrefSection(doc, prev, depth + 1);
                }
                return true;
            }
            if (!/[0-9]/.test(String.fromCharCode(peek)))
                break;
            const start = Number(readToken(cursor));
            const count = Number(readToken(cursor));
            if (!Number.isFinite(start) || !Number.isFinite(count))
                break;
            for (let index = 0; index < count; index += 1) {
                const entryOffset = Number(readToken(cursor));
                skipSpace(cursor);
                const gen = Number(readToken(cursor));
                const flag = readToken(cursor);
                if (!Number.isFinite(entryOffset))
                    return false;
                const num = start + index;
                if (flag === 'n' && !doc.xref.has(num))
                    doc.xref.set(num, { kind: 1, offset: entryOffset });
                void gen;
            }
        }
        return true;
    }
    // 交叉引用流
    const head = lookupNumberStart(cursor);
    if (head === undefined)
        return false;
    const gen = lookupNumberStart(cursor);
    if (gen === undefined)
        return false;
    if (readToken(cursor) !== 'obj')
        return false;
    const value = parseValue(cursor);
    if (value.k !== 'dict')
        return false;
    if (doc.nameField(value.map, 'Type') !== 'XRef')
        return false;
    // 读流数据
    const save = cursor.pos;
    if (readToken(cursor) !== 'stream') {
        cursor.pos = save;
        return false;
    }
    if (doc.bytes[cursor.pos] === CH_CR)
        cursor.pos += 1;
    if (doc.bytes[cursor.pos] === CH_LF)
        cursor.pos += 1;
    const dataStart = cursor.pos;
    const declaredLength = doc.numberField(value.map, 'Length') ?? 0;
    let stream = {
        map: value.map,
        data: doc.bytes.subarray(dataStart, Math.min(dataStart + declaredLength, doc.bytes.length)),
    };
    const decoded = doc.decodeStream(stream);
    if (decoded === undefined)
        return false;
    const widths = doc.resolve(value.map.get('W'));
    if (widths?.k !== 'arr' || widths.items.length < 3)
        return false;
    const widthsNumbers = widths.items.map((item) => {
        const resolved = doc.resolve(item);
        return resolved?.k === 'num' ? resolved.n : 0;
    });
    const size = doc.numberField(value.map, 'Size') ?? 0;
    const indexValue = doc.resolve(value.map.get('Index'));
    const ranges = [];
    if (indexValue?.k === 'arr') {
        for (const item of indexValue.items) {
            const resolved = doc.resolve(item);
            ranges.push(resolved?.k === 'num' ? resolved.n : 0);
        }
    }
    else {
        ranges.push(0, size);
    }
    const rowLength = widthsNumbers.reduce((sum, width) => sum + width, 0);
    if (rowLength <= 0)
        return false;
    let position = 0;
    for (let range = 0; range + 1 < ranges.length; range += 2) {
        const start = ranges[range];
        const count = ranges[range + 1];
        for (let index = 0; index < count; index += 1) {
            if (position + rowLength > decoded.length)
                break;
            const fields = readXrefFields(decoded, position, widthsNumbers);
            position += rowLength;
            const num = start + index;
            const type = widthsNumbers[0] === 0 ? 1 : fields[0];
            if (doc.xref.has(num))
                continue;
            if (type === 1)
                doc.xref.set(num, { kind: 1, offset: fields[1] });
            else if (type === 2)
                doc.xref.set(num, { kind: 2, streamNum: fields[1], index: fields[2] });
        }
    }
    for (const [key, item] of value.map)
        if (!doc.trailer.has(key))
            doc.trailer.set(key, item);
    const prev = doc.numberField(value.map, 'Prev');
    if (prev !== undefined)
        readXrefSection(doc, prev, depth + 1);
    return true;
}
/** 按 /W 宽度读一条交叉引用记录。 */
function readXrefFields(data, offset, widths) {
    const fields = [];
    let position = offset;
    for (const width of widths) {
        let value = 0;
        for (let index = 0; index < width; index += 1)
            value = value * 256 + (data[position + index] ?? 0);
        position += width;
        fields.push(value);
    }
    return fields;
}
/** 从文件尾部找 `startxref` 并加载交叉引用；失败返回 false。 */
function loadXref(doc) {
    const marker = lastIndexOfText(doc.bytes, 'startxref');
    if (marker >= 0) {
        const cursor = new Cursor(doc.bytes, marker + 'startxref'.length);
        const offset = Number(readToken(cursor));
        if (Number.isFinite(offset) && readXrefSection(doc, offset, 0))
            return true;
    }
    // 没有可用 startxref：扫描 trailer 字典
    const trailerAt = lastIndexOfText(doc.bytes, 'trailer');
    if (trailerAt >= 0) {
        const cursor = new Cursor(doc.bytes, trailerAt + 'trailer'.length);
        const value = parseValue(cursor);
        if (value.k === 'dict') {
            for (const [key, item] of value.map)
                doc.trailer.set(key, item);
            const root = doc.resolve(value.map.get('Root'));
            if (root?.k === 'ref') {
                const prev = doc.numberField(value.map, 'Prev');
                if (prev !== undefined)
                    readXrefSection(doc, prev, 0);
                return true;
            }
        }
    }
    return false;
}
/* ==========================================================================
 * 字体与编码
 * ======================================================================== */
/** cp1252 在 0x80..0x9F 的映射（其余与 Latin-1 相同）。 */
const CP1252_HIGH = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
/** WinAnsi（cp1252）字节 → Unicode 码位。 */
function winAnsi(code) {
    if (code >= 0x80 && code <= 0x9f)
        return CP1252_HIGH[code - 0x80];
    return code;
}
/** 常见字形的 Unicode 码位（供 /Differences 使用；未知字形按码位回退）。 */
const GLYPH_NAMES = {
    space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25,
    ampersand: 0x26, quoteright: 0x2019, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a,
    plus: 0x2b, comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f,
    zero: 0x30, one: 0x31, two: 0x32, three: 0x33, four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39,
    colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40,
    bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
    quoteleft: 0x2018, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
    quotedblleft: 0x201c, quotedblright: 0x201d, endash: 0x2013, emdash: 0x2014,
    bullet: 0x2022, ellipsis: 0x2026, trademark: 0x2122, fi: 0xfb01, fl: 0xfb02,
    euro: 0x20ac, florin: 0x0192, dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030,
    guilsinglleft: 0x2039, guilsinglright: 0x203a, quotesinglbase: 0x201a, quotedblbase: 0x201e,
    circumflex: 0x02c6, tilde: 0x02dc, OE: 0x0152, oe: 0x0153, Scaron: 0x0160, scaron: 0x0161,
    Ydieresis: 0x0178, Zcaron: 0x017d, zcaron: 0x017e,
    Aacute: 0xc1, Acircumflex: 0xc2, Adieresis: 0xc4, Agrave: 0xc0, Aring: 0xc5, Atilde: 0xc3,
    Ccedilla: 0xc7, Eacute: 0xc9, Ecircumflex: 0xca, Edieresis: 0xcb, Egrave: 0xc8,
    Iacute: 0xcd, Icircumflex: 0xce, Idieresis: 0xcf, Igrave: 0xcc, Ntilde: 0xd1,
    Oacute: 0xd3, Ocircumflex: 0xd4, Odieresis: 0xd6, Ograve: 0xd2, Oslash: 0xd8, Otilde: 0xd5,
    Uacute: 0xda, Ucircumflex: 0xdb, Udieresis: 0xdc, Ugrave: 0xd9, Yacute: 0xdd,
    // 希腊字母（AGL 里的常见名，/Differences 常用到）
    Alpha: 0x391, Beta: 0x392, Gamma: 0x393, Delta: 0x394, Epsilon: 0x395, Zeta: 0x396,
    Eta: 0x397, Theta: 0x398, Iota: 0x399, Kappa: 0x39a, Lambda: 0x39b, Mu: 0x39c,
    Nu: 0x39d, Xi: 0x39e, Omicron: 0x39f, Pi: 0x3a0, Rho: 0x3a1, Sigma: 0x3a3,
    Tau: 0x3a4, Upsilon: 0x3a5, Phi: 0x3a6, Chi: 0x3a7, Psi: 0x3a8, Omega: 0x3a9,
    alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5, zeta: 0x3b6,
    eta: 0x3b7, theta: 0x3b8, iota: 0x3b9, kappa: 0x3ba, lambda: 0x3bb, mu2: 0x3bc,
    nu: 0x3bd, xi: 0x3be, omicron: 0x3bf, pi: 0x3c0, rho: 0x3c1, sigma1: 0x3c2,
    sigma: 0x3c3, tau: 0x3c4, upsilon: 0x3c5, phi: 0x3c6, chi: 0x3c7, psi: 0x3c8,
    omega: 0x3c9,
    aacute: 0xe1, acircumflex: 0xe2, adieresis: 0xe4, agrave: 0xe0, aring: 0xe5, atilde: 0xe3,
    ccedilla: 0xe7, eacute: 0xe9, ecircumflex: 0xea, edieresis: 0xeb, egrave: 0xe8,
    iacute: 0xed, icircumflex: 0xee, idieresis: 0xef, igrave: 0xec, ntilde: 0xf1,
    oacute: 0xf3, ocircumflex: 0xf4, odieresis: 0xf6, ograve: 0xf2, oslash: 0xf8, otilde: 0xf5,
    uacute: 0xfa, ucircumflex: 0xfb, udieresis: 0xfc, ugrave: 0xf9, yacute: 0xfd, ydieresis: 0xff,
    germandbls: 0xdf, ae: 0xe6, eth: 0xf0, thorn: 0xfe, sterling: 0xa3, section: 0xa7,
    paragraph: 0xb6, periodcentered: 0xb7, registered: 0xae, copyright: 0xa9, degree: 0xb0,
    plusminus: 0xb1, twosuperior: 0xb2, threesuperior: 0xb3, onesuperior: 0xb9, onequarter: 0xbc,
    onehalf: 0xbd, threequarters: 0xbe, multiply: 0xd7, divide: 0xf7, mu: 0xb5, nbspace: 0xa0,
    exclamdown: 0xa1, cent: 0xa2, currency: 0xa4, yen: 0xa5, brokenbar: 0xa6, dieresis: 0xa8,
    ordfeminine: 0xaa, guillemotleft: 0xab, logicalnot: 0xac, macron: 0xaf,
    ordmasculine: 0xba, guillemotright: 0xbb, questiondown: 0xbf,
    AE: 0xc6,
};
/** 把字形名解析为 Unicode 码位：`uniXXXX`、`uXXXXX`、常见表、单字符名。 */
function glyphToUnicode(name) {
    const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
    if (uni?.[1] !== undefined)
        return Number.parseInt(uni[1], 16);
    const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (u?.[1] !== undefined)
        return Number.parseInt(u[1], 16);
    if (name === '.notdef' || name === '')
        return undefined;
    const mapped = GLYPH_NAMES[name];
    if (mapped !== undefined)
        return mapped;
    // A-Z / a-z / 0-9 等的直接对照
    if (name.length === 1)
        return name.codePointAt(0);
    if (/^[A-Za-z]$/.test(name))
        return name.codePointAt(0);
    return undefined;
}
/** 解析 /ToUnicode CMap 文本。 */
function parseToUnicode(text) {
    const map = new Map();
    const utf16 = (hex) => {
        const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
        let out = '';
        for (let index = 0; index + 3 < clean.length + 1 && index + 4 <= clean.length; index += 4) {
            out += String.fromCharCode(Number.parseInt(clean.slice(index, index + 4), 16));
        }
        return out;
    };
    const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
    for (let match = bfchar.exec(text); match !== null; match = bfchar.exec(text)) {
        const pairs = match[1].match(/<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>/g) ?? [];
        for (const pair of pairs) {
            const parts = /<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>/.exec(pair);
            if (parts === null)
                continue;
            map.set(Number.parseInt(parts[1] || '0', 16), utf16(parts[2] ?? ''));
        }
    }
    const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
    for (let match = bfrange.exec(text); match !== null; match = bfrange.exec(text)) {
        const body = match[1];
        // 三种写法：`<lo> <hi> <dst>`、`<lo> <hi> [<d1> <d2> ...]`、以及被换行拆开的版本，
        // 所以整段一次性匹配，而不是逐行匹配（数组形式常常跨行）。
        const entry = /<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*(<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
        for (let item = entry.exec(body); item !== null; item = entry.exec(body)) {
            const low = Number.parseInt(item[1] || '0', 16);
            const high = Number.parseInt(item[2] || '0', 16);
            if (!Number.isFinite(low) || !Number.isFinite(high))
                continue;
            if (item[4] !== undefined) {
                const start = Number.parseInt(item[4] || '0', 16);
                for (let code = low; code <= high && code - low < 65536; code += 1) {
                    map.set(code, String.fromCharCode(start + (code - low)));
                }
                continue;
            }
            const destinations = (item[5] ?? '').match(/<([0-9A-Fa-f]*)>/g) ?? [];
            destinations.forEach((destination, offset) => {
                const hex = /<([0-9A-Fa-f]*)>/.exec(destination)?.[1] ?? '';
                map.set(low + offset, utf16(hex));
            });
        }
    }
    return map;
}
/** 为一个字体字典构建解码器。 */
function buildFontDecoder(doc, fontDict) {
    const map = new Map();
    const subtype = doc.nameField(fontDict, 'Subtype');
    const toUnicode = doc.resolve(fontDict?.get('ToUnicode'));
    if (toUnicode?.k === 'stream') {
        const decoded = doc.decodeStream(toUnicode);
        if (decoded !== undefined) {
            for (const [code, text] of parseToUnicode(latin1(decoded, 0, decoded.length)))
                map.set(code, text);
        }
    }
    const encodingValue = doc.resolve(fontDict?.get('Encoding'));
    let baseEncoding;
    if (encodingValue?.k === 'name')
        baseEncoding = encodingValue.s;
    else if (encodingValue?.k === 'dict')
        baseEncoding = doc.nameField(encodingValue.map, 'BaseEncoding');
    if (encodingValue?.k === 'dict') {
        const differences = doc.resolve(encodingValue.map.get('Differences'));
        if (differences?.k === 'arr') {
            let code = 0;
            for (const item of differences.items) {
                const resolved = doc.resolve(item);
                if (resolved?.k === 'num') {
                    code = resolved.n;
                    continue;
                }
                if (resolved?.k === 'name') {
                    const unicode = glyphToUnicode(resolved.s);
                    if (unicode !== undefined)
                        map.set(code, String.fromCodePoint(unicode));
                    code += 1;
                }
            }
        }
    }
    const twoByte = subtype === 'Type0' || encodingValue?.k === 'name' && /Identity-[HV]/.test(encodingValue.s);
    return { twoByte, map, baseEncoding };
}
/** 用解码器把一段字节转成文本。 */
function decodeWithFont(bytes, decoder) {
    if (bytes.length === 0)
        return '';
    const winAnsiBase = decoder?.baseEncoding === undefined || decoder.baseEncoding === 'WinAnsiEncoding';
    const simpleBase = decoder?.baseEncoding === 'StandardEncoding' || decoder?.baseEncoding === 'MacRomanEncoding';
    if (decoder?.twoByte === true) {
        let out = '';
        for (let index = 0; index + 1 < bytes.length; index += 2) {
            const code = (bytes[index] << 8) | bytes[index + 1];
            const mapped = decoder.map.get(code);
            out += mapped ?? String.fromCodePoint(code);
        }
        return out;
    }
    let out = '';
    for (const byte of bytes) {
        const mapped = decoder?.map.get(byte);
        if (mapped !== undefined) {
            out += mapped;
            continue;
        }
        const codePoint = simpleBase ? byte : winAnsiBase ? winAnsi(byte) : byte;
        out += String.fromCodePoint(codePoint);
    }
    return out;
}
/** 同一个 y 上的抖动小于该值就不算换行（不同 PDF 生成器的浮点写法差异）。 */
const SAME_LINE_EPSILON = 0.5;
/** 解析内容流里的一个字符串或数组元素，返回其字节。 */
function isNumberToken(token) {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token);
}
/**
 * 从解码后的内容流里提取文本。
 *
 * 语义要点：
 * - **只有在 y 真的变化时才换行**。很多 PDF（含 W3C 的样例）会用 `Td`/`Tm` 做逐词定位，
 *   若一见移动算子就换行，`dummy` 会被拆成 `dumm` + `y`。因此这里累计 `Td`/`Tm` 的 y，
 *   与上次写出文字时的 y 比较；差异超过 {@link SAME_LINE_EPSILON} 才落 `\n`。
 * - `BT` 开启新文本块 → 强制换行（常见生成器一个 BT 一行），但首行不落空行。
 * - `TJ` 数组里 `<= TJ_FORWARD_WORD_GAP` 的调整量落一个空格；小调整不落。
 */
function extractFromContent(content, resources, doc, budget) {
    const cursor = new Cursor(content);
    const state = { output: '', decoder: undefined, lineY: 0, emittedY: 0, wrote: false, forcedBreak: false, x: 0, leading: 0 };
    const fonts = doc.resolveDict(resources?.get('Font'));
    const decoderCache = new Map();
    const operands = [];
    const decoderFor = (name) => {
        const cached = decoderCache.get(name);
        if (cached !== undefined)
            return cached;
        const fontDict = doc.resolveDict(fonts?.get(name));
        const decoder = buildFontDecoder(doc, fontDict);
        decoderCache.set(name, decoder);
        return decoder;
    };
    const needsBreak = () => {
        if (state.forcedBreak)
            return true;
        return state.wrote && Math.abs(state.lineY - state.emittedY) > SAME_LINE_EPSILON;
    };
    const emit = (text) => {
        if (text.length === 0)
            return;
        if (needsBreak() && state.output.length > 0)
            state.output += '\n';
        state.forcedBreak = false;
        state.emittedY = state.lineY;
        state.wrote = true;
        const room = budget.chars - state.output.length;
        if (room <= 0)
            return;
        state.output += text.length > room ? text.slice(0, room) : text;
    };
    /** 取最近的一个数字算子。 */
    const lastNumber = () => {
        for (let index = operands.length - 1; index >= 0; index -= 1) {
            const operand = operands[index];
            if (operand?.k === 'num')
                return operand.n;
        }
        return undefined;
    };
    while (!cursor.atEnd()) {
        skipSpace(cursor);
        if (cursor.atEnd())
            break;
        const byte = cursor.peek();
        const before = cursor.pos;
        if (byte === 0x2f) {
            operands.push({ k: 'name', s: parseName(cursor) });
            continue;
        }
        if (byte === 0x28) {
            operands.push({ k: 'str', bytes: parseLiteralString(cursor) });
            continue;
        }
        if (byte === 0x5b) {
            operands.push(parseValue(cursor));
            continue;
        }
        if (byte === 0x3c) {
            if (cursor.bytes[cursor.pos + 1] === 0x3c) {
                parseValue(cursor);
                continue;
            } // 跳过内联字典
            operands.push({ k: 'str', bytes: parseHexString(cursor) });
            continue;
        }
        if (byte === 0x5d || byte === 0x3e || byte === 0x29) {
            cursor.pos += 1;
            continue;
        }
        const token = readRegular(cursor);
        if (token === '') {
            cursor.pos = before + 1;
            continue;
        }
        if (isNumberToken(token)) {
            operands.push({ k: 'num', n: Number(token) });
            if (operands.length > 64)
                operands.shift();
            continue;
        }
        switch (token) {
            case 'Tf': {
                const nameOperand = operands[operands.length - 2];
                state.decoder = nameOperand?.k === 'name' ? decoderFor(nameOperand.s) : undefined;
                break;
            }
            case 'TL': {
                const operand = lastNumber();
                if (operand !== undefined)
                    state.leading = operand;
                break;
            }
            case 'Td':
            case 'TD': {
                const numbers = operands.filter((item) => item.k === 'num');
                const ty = numbers[numbers.length - 1]?.n;
                const tx = numbers[numbers.length - 2]?.n;
                if (ty !== undefined && Number.isFinite(ty))
                    state.lineY += ty;
                if (tx !== undefined && Number.isFinite(tx))
                    state.x += tx;
                if (token === 'TD' && ty !== undefined)
                    state.leading = -ty;
                break;
            }
            case 'Tm': {
                const numbers = operands.filter((item) => item.k === 'num');
                const ty = numbers[numbers.length - 1]?.n;
                const tx = numbers[numbers.length - 2]?.n;
                if (ty !== undefined && Number.isFinite(ty))
                    state.lineY = ty;
                if (tx !== undefined && Number.isFinite(tx))
                    state.x = tx;
                break;
            }
            case 'T*':
                state.lineY -= state.leading;
                state.forcedBreak = true;
                break;
            case 'Tj':
            case "'":
            case '"': {
                if (token !== 'Tj') {
                    state.lineY -= state.leading;
                    state.forcedBreak = true;
                }
                const operand = [...operands].reverse().find((item) => item.k === 'str');
                if (operand?.k === 'str')
                    emit(decodeWithFont(operand.bytes, state.decoder));
                break;
            }
            case 'TJ': {
                const array = [...operands].reverse().find((item) => item.k === 'arr');
                if (array?.k === 'arr') {
                    let text = '';
                    for (const item of array.items) {
                        if (item.k === 'str')
                            text += decodeWithFont(item.bytes, state.decoder);
                        else if (item.k === 'num' && item.n <= TJ_FORWARD_WORD_GAP)
                            text += ' ';
                    }
                    emit(text);
                }
                break;
            }
            case 'BT':
                // 新文本块：文本矩阵复位（y 归零），并按"一个 BT 一行"的常见约定换行。
                state.lineY = 0;
                state.forcedBreak = true;
                break;
            default:
                break;
        }
        operands.length = 0;
        if (budget.chars > 0 && state.output.length >= budget.chars)
            break;
    }
    return state.output;
}
/* ==========================================================================
 * 主入口
 * ======================================================================== */
/** 收集页面对象：优先走 /Root → /Pages → /Kids，失败时扫描 /Type /Page。 */
function collectPages(doc, maxPages) {
    const pages = [];
    const seen = new Set();
    let truncated = false;
    const catalog = doc.catalog();
    const rootRef = catalog?.get('Pages');
    const rootDict = doc.resolveDict(rootRef);
    const walk = (dict, depth) => {
        if (dict === undefined || depth > 64 || truncated)
            return;
        const type = doc.nameField(dict, 'Type');
        if (type === 'Page') {
            if (pages.length >= maxPages) {
                truncated = true;
                return;
            }
            pages.push(dict);
            return;
        }
        const kids = doc.resolve(dict.get('Kids'));
        if (kids?.k !== 'arr')
            return;
        for (const kid of kids.items) {
            if (truncated)
                return;
            if (kid.k === 'ref') {
                if (seen.has(kid.num))
                    continue;
                seen.add(kid.num);
                walk(doc.resolveDict(kid), depth + 1);
            }
            else if (kid.k === 'dict') {
                walk(kid.map, depth + 1);
            }
        }
    };
    walk(rootDict, 0);
    if (pages.length > 0)
        return { pages, truncated };
    // 回退：按对象号扫描 /Type /Page（顺序稳定，且只在已知对象里找，不猜对象号）。
    for (const num of doc.objectNumbers()) {
        if (pages.length >= maxPages) {
            truncated = true;
            break;
        }
        const dict = doc.resolveDict({ k: 'ref', num, gen: 0 });
        if (dict === undefined)
            continue;
        if (doc.nameField(dict, 'Type') === 'Page')
            pages.push(dict);
    }
    return { pages, truncated };
}
/** 读取一页的内容流字节（可能由多条流组成）。 */
function pageContent(doc, page) {
    const contents = doc.resolve(page.get('Contents'));
    const streams = [];
    const push = (value) => {
        const resolved = doc.resolve(value);
        if (resolved?.k !== 'stream')
            return;
        const decoded = doc.decodeStream(resolved);
        if (decoded !== undefined)
            streams.push(decoded);
    };
    if (contents?.k === 'stream')
        push(contents);
    else if (contents?.k === 'arr')
        for (const item of contents.items)
            push(item);
    return streams;
}
/**
 * 提取 PDF 文本。
 *
 * @param bytes 完整文件字节
 * @param limits 边界（见 {@link PdfExtractLimits}）
 * @throws 输入为空、不是 PDF、超过 `maxBytes`、或文档加密时抛出带说明的 Error
 */
export function extractPdfText(bytes, limits = {}) {
    const maxBytes = limits.maxBytes ?? PDF_EXTRACT_DEFAULTS.maxBytes;
    const maxPages = limits.maxPages ?? PDF_EXTRACT_DEFAULTS.maxPages;
    const maxChars = limits.maxChars ?? PDF_EXTRACT_DEFAULTS.maxChars;
    const maxObjects = limits.maxObjects ?? PDF_EXTRACT_DEFAULTS.maxObjects;
    if (bytes.length === 0)
        throw new Error('empty input: no PDF bytes were provided');
    if (bytes.length > maxBytes)
        throw new Error(`PDF is ${bytes.length} bytes, above the maxBytes limit of ${maxBytes}`);
    // 头部可能在前面有少量垃圾（邮件转发、前导空行），但必须是 PDF。
    const head = indexOfText(bytes, '%PDF-', 0);
    if (head < 0 || head > 1024)
        throw new Error('not a PDF: no %PDF- header was found in the first 1024 bytes');
    const doc = new PdfDocument(bytes, maxObjects);
    loadXref(doc);
    // 加密检测：trailer 里直接声明，或（没有可用 trailer 时）文件里出现 /Encrypt。
    if (doc.trailer.has('Encrypt') || (!doc.trailer.has('Root') && indexOfText(bytes, '/Encrypt') >= 0)) {
        throw new Error('this PDF is encrypted (/Encrypt): text cannot be extracted; save an unencrypted copy and retry');
    }
    const catalog = doc.catalog();
    if (catalog === undefined) {
        // 连文档目录都找不到，说明这不是一份可用的 PDF（被截断/结构损坏），
        // 明确报错比静默返回空文本更有用——调用方要能区分"空文档"和"读不了"。
        throw new Error('malformed PDF: the document catalog (/Root) could not be resolved');
    }
    const collected = collectPages(doc, maxPages);
    const chunks = [];
    let used = 0;
    let truncated = collected.truncated;
    let reported = 0;
    for (const page of collected.pages) {
        reported += 1;
        if (used >= maxChars) {
            truncated = true;
            break;
        }
        const resources = doc.resolveDict(page.get('Resources'));
        let pageText = '';
        for (const stream of pageContent(doc, page)) {
            pageText += extractFromContent(stream, resources, doc, { chars: maxChars - used });
            if (used + pageText.length >= maxChars) {
                truncated = true;
                break;
            }
        }
        used += pageText.length;
        if (pageText.trim().length > 0)
            chunks.push(pageText.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'));
    }
    const text = chunks.join('\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (text.length > maxChars)
        return { text: text.slice(0, maxChars), pages: reported, truncated: true };
    return { text, pages: reported, truncated };
}
