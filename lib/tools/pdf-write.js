/**
 * 纯 JS PDF 生成器（零第三方运行时依赖）。
 *
 * 特性：
 * - A4 页面、自动换行与分页；支持标题（居中）、段落、表格（rows，首行作表头）。
 * - 纯 ASCII 内容 → 标准 14 字体 Helvetica，文件极小。
 * - 含中文等内容 → 自动查找系统 CJK TrueType 字体（TTF/TTC），解析并子集化后嵌入，
 *   输出 Type0(CIDFontType2) + Identity-H + ToUnicode 结构，文本可复制、可搜索。
 * - 字体中缺失的字符（如 emoji）降级为 .notdef，并在返回消息中注明数量。
 *
 * 环境变量 DSH_CJK_FONT 可指定字体路径（TTF/TTC，分号分隔多个），优先级最高。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
// ---------- 页面常量（pt） ----------
const PAGE_W = 595.28; // A4 宽
const PAGE_H = 841.89; // A4 高
const MARGIN = 56.7; // 2cm
const USABLE_W = PAGE_W - MARGIN * 2;
const LINE_SCALE = 1.6;
// ---------- 二进制工具 ----------
const u16 = (b, o) => b.readUInt16BE(o);
const i16 = (b, o) => b.readInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);
/** TrueType 表校验和：按大端 uint32 求和，不足 4 字节补零。 */
function tableChecksum(buf) {
    let sum = 0;
    const n = Math.floor(buf.length / 4);
    for (let i = 0; i < n; i++)
        sum = (sum + u32(buf, i * 4)) >>> 0;
    if (buf.length % 4 > 0) {
        const tail = Buffer.alloc(4);
        buf.copy(tail, 0, n * 4);
        sum = (sum + u32(tail, 0)) >>> 0;
    }
    return sum >>> 0;
}
function padEven(buf) {
    return buf.length % 2 === 0 ? buf : Buffer.concat([buf, Buffer.from([0])]);
}
function pad4(buf) {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}
/**
 * 解析 TrueType 字体（或 TTC 集合中的第 fontIndex 个字体）。
 * 仅支持 TrueType 轮廓（glyf）；CFF/OTF 抛错。
 */
export function parseFont(buf, fontIndex = 0) {
    const tag = buf.subarray(0, 4).toString('latin1');
    let base = 0;
    if (tag === 'ttcf') {
        const numFonts = u32(buf, 8);
        if (fontIndex >= numFonts)
            throw new Error(`TTC 字体索引越界: ${fontIndex}/${numFonts}`);
        base = u32(buf, 12 + fontIndex * 4);
    }
    if (u16(buf, base) !== 0x0001)
        throw new Error('不是有效的 TrueType 字体');
    const numTables = u16(buf, base + 4);
    const tables = new Map();
    for (let i = 0; i < numTables; i++) {
        const rec = base + 12 + i * 16;
        const name = buf.subarray(rec, rec + 4).toString('latin1');
        tables.set(name, { offset: base + u32(buf, rec + 8), length: u32(buf, rec + 12) });
    }
    const need = (tagName) => {
        const t = tables.get(tagName);
        if (!t)
            throw new Error(`字体缺少 ${tagName} 表`);
        return buf.subarray(t.offset, t.offset + t.length);
    };
    const head = need('head');
    const hhea = need('hhea');
    const maxp = need('maxp');
    if (u32(maxp, 0) === 0x00005000)
        throw new Error('OTF/CFF 字体暂不支持（仅支持 TrueType/TTC）');
    const numGlyphs = u16(maxp, 4);
    const unitsPerEm = u16(head, 18);
    if (unitsPerEm === 0)
        throw new Error('字体 unitsPerEm 为 0');
    const indexToLocFormat = i16(head, 50);
    const locaTable = need('loca');
    const loca = [];
    if (indexToLocFormat === 0) {
        for (let i = 0; i <= numGlyphs; i++)
            loca.push(u16(locaTable, i * 2) * 2);
    }
    else {
        for (let i = 0; i <= numGlyphs; i++)
            loca.push(u32(locaTable, i * 4));
    }
    const numberOfHMetrics = u16(hhea, 34);
    const hmtxTable = need('hmtx');
    const advances = [];
    for (let i = 0; i < numberOfHMetrics; i++)
        advances.push(u16(hmtxTable, i * 4));
    const lastAdvance = advances[advances.length - 1] ?? 0;
    for (let i = numberOfHMetrics; i < numGlyphs; i++)
        advances.push(lastAdvance);
    return {
        unitsPerEm,
        ascent: i16(hhea, 4),
        descent: i16(hhea, 6),
        numGlyphs,
        advances,
        loca,
        glyf: need('glyf'),
        charToGid: parseCmap(need('cmap')),
        head,
        hhea,
        maxp,
        os2: tables.has('OS/2') ? need('OS/2') : undefined,
        post: tables.has('post') ? need('post') : undefined,
        name: tables.has('name') ? need('name') : undefined,
        xMin: i16(head, 36),
        yMin: i16(head, 38),
        xMax: i16(head, 40),
        yMax: i16(head, 42),
    };
}
/** 解析 cmap 表，合并各子表为 字符码点 → 字形ID 映射。 */
function parseCmap(cmap) {
    const numTables = u16(cmap, 2);
    const subs = [];
    for (let i = 0; i < numTables; i++) {
        const rec = 4 + i * 8;
        const platform = u16(cmap, rec);
        const encoding = u16(cmap, rec + 2);
        const offset = u32(cmap, rec + 4);
        if (offset + 2 > cmap.length)
            continue;
        const format = u16(cmap, offset);
        const map = new Map();
        try {
            if (format === 0) {
                for (let c = 0; c < 256; c++) {
                    const g = cmap[offset + 6 + c];
                    if (g !== 0)
                        map.set(c, g);
                }
            }
            else if (format === 4) {
                const segCountX2 = u16(cmap, offset + 6);
                const segCount = segCountX2 / 2;
                const endBase = offset + 14;
                const startBase = endBase + segCountX2 + 2;
                const deltaBase = startBase + segCountX2;
                const rangeBase = deltaBase + segCountX2;
                for (let s = 0; s < segCount; s++) {
                    const end = u16(cmap, endBase + s * 2);
                    const start = u16(cmap, startBase + s * 2);
                    const delta = i16(cmap, deltaBase + s * 2);
                    const ro = u16(cmap, rangeBase + s * 2);
                    if (end === 0xffff)
                        continue; // 结束哨兵段
                    for (let c = start; c <= end; c++) {
                        let g;
                        if (ro === 0) {
                            g = (c + delta) & 0xffff;
                        }
                        else {
                            const idx = rangeBase + s * 2 + ro + (c - start) * 2;
                            if (idx + 2 > cmap.length)
                                continue;
                            g = u16(cmap, idx);
                            if (g !== 0)
                                g = (g + delta) & 0xffff;
                        }
                        if (g !== 0)
                            map.set(c, g);
                    }
                }
            }
            else if (format === 6) {
                const firstCode = u16(cmap, offset + 6);
                const entryCount = u16(cmap, offset + 8);
                for (let i = 0; i < entryCount; i++) {
                    const g = u16(cmap, offset + 10 + i * 2);
                    if (g !== 0)
                        map.set(firstCode + i, g);
                }
            }
            else if (format === 12) {
                const nGroups = u32(cmap, offset + 12);
                for (let g = 0; g < nGroups; g++) {
                    const base = offset + 16 + g * 12;
                    const start = u32(cmap, base);
                    const end = u32(cmap, base + 4);
                    const startGid = u32(cmap, base + 8);
                    for (let c = start; c <= end; c++)
                        map.set(c, startGid + (c - start));
                }
            }
        }
        catch {
            // 损坏子表跳过
        }
        subs.push({ platform, encoding, map });
    }
    // 优先级：Windows BMP (3,1) > Unicode BMP (0,3) > Windows 全量 (3,10) > Unicode 全量 (0,4)
    const order = [[3, 1], [0, 3], [3, 10], [0, 4]];
    const merged = new Map();
    for (const [p, e] of order) {
        const sub = subs.find((s) => s.platform === p && s.encoding === e);
        if (sub)
            for (const [c, g] of sub.map)
                merged.set(c, g);
    }
    if (merged.size === 0) {
        for (const sub of subs)
            for (const [c, g] of sub.map)
                if (!merged.has(c))
                    merged.set(c, g);
    }
    return merged;
}
/**
 * 在 TTF/TTC 中选择对给定字符集覆盖最好的字体。
 */
export function selectBestFont(buf, cps) {
    if (buf.subarray(0, 4).toString('latin1') === 'ttcf') {
        const numFonts = u32(buf, 8);
        let best;
        let bestScore = -1;
        let bestIndex = -1;
        for (let i = 0; i < numFonts; i++) {
            let f;
            try {
                f = parseFont(buf, i);
            }
            catch {
                continue;
            }
            const score = cps.reduce((s, c) => s + (f.charToGid.has(c) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                best = f;
                bestIndex = i;
            }
        }
        if (!best)
            throw new Error('TTC 中无可用 TrueType 字体');
        return { font: best, index: bestIndex };
    }
    return { font: parseFont(buf, 0), index: 0 };
}
// ============================================================
// 字体子集化（保留原始字形 ID，未使用字形留空槽位）
// ============================================================
/**
 * 从已解析字体构建子集字体：
 * - 只保留用到的字形（递归包含复合字形的组件），未用槽位写空轮廓；
 * - 重建 cmap（format 4，必要时加 format 12）、hmtx、loca、glyf；
 * - 修正 head/hhea/maxp 字段并重算所有表校验和与 checkSumAdjustment。
 */
export function buildSubset(font, usedChars) {
    const usedGids = new Set([0]);
    for (const c of usedChars) {
        const g = font.charToGid.get(c);
        if (g !== undefined)
            usedGids.add(g);
    }
    // 递归收集复合字形（numberOfContours < 0）引用的组件
    let changed = true;
    while (changed) {
        changed = false;
        for (const gid of [...usedGids]) {
            if (gid >= font.numGlyphs)
                continue;
            const off = font.loca[gid];
            const len = font.loca[gid + 1] - off;
            if (len < 10)
                continue;
            if (i16(font.glyf, off) >= 0)
                continue;
            let p = off + 10;
            const end = off + len;
            while (p + 4 <= end) {
                const flags = u16(font.glyf, p);
                const compGid = u16(font.glyf, p + 2);
                if (!usedGids.has(compGid)) {
                    usedGids.add(compGid);
                    changed = true;
                }
                p += 4;
                if (flags & 0x0001)
                    p += 2; // ARG_1_AND_2_ARE_WORDS
                if (flags & 0x0008)
                    p += 2; // WE_HAVE_A_SCALE
                else if (flags & 0x0040)
                    p += 4; // X_AND_Y_SCALE
                else if (flags & 0x0080)
                    p += 8; // TWO_BY_TWO
                if (!(flags & 0x0020))
                    break; // MORE_COMPONENTS
            }
        }
    }
    const maxGid = Math.max(...usedGids);
    const numGlyphs = maxGid + 1;
    // glyf：用到的字形拷原数据（补偶），未用槽位写 10 字节空轮廓
    const emptyGlyph = Buffer.alloc(10);
    const glyphs = [];
    for (let gid = 0; gid < numGlyphs; gid++) {
        if (usedGids.has(gid)) {
            const off = font.loca[gid];
            const len = font.loca[gid + 1] - off;
            glyphs.push(len > 0 ? padEven(Buffer.from(font.glyf.subarray(off, off + len))) : emptyGlyph);
        }
        else {
            glyphs.push(emptyGlyph);
        }
    }
    const glyf = Buffer.concat(glyphs);
    // loca：短格式（2 字节）上限 131070 字节
    const long = glyf.length > 0x1fffe;
    const loca = Buffer.alloc((numGlyphs + 1) * (long ? 4 : 2));
    let acc = 0;
    for (let i = 0; i < glyphs.length; i++) {
        if (long)
            loca.writeUInt32BE(acc, i * 4);
        else
            loca.writeUInt16BE(acc / 2, i * 2);
        acc += glyphs[i].length;
    }
    if (long)
        loca.writeUInt32BE(acc, numGlyphs * 4);
    else
        loca.writeUInt16BE(acc / 2, numGlyphs * 2);
    // hmtx：numGlyphs 项（advance 保留原值，lsb 置 0）
    const hmtx = Buffer.alloc(numGlyphs * 4);
    for (let gid = 0; gid < numGlyphs; gid++) {
        hmtx.writeUInt16BE(font.advances[Math.min(gid, font.advances.length - 1)], gid * 4);
    }
    const head = Buffer.from(font.head);
    head.writeUInt32BE(0, 8); // checkSumAdjustment 占位，组装时修正
    head.writeInt16BE(long ? 1 : 0, 50); // indexToLocFormat
    const hhea = Buffer.from(font.hhea);
    hhea.writeUInt16BE(numGlyphs, 34); // numberOfHMetrics = numGlyphs
    const maxp = Buffer.from(font.maxp);
    maxp.writeUInt16BE(numGlyphs, 4);
    const tables = [
        ['cmap', buildCmap(usedChars, font)],
        ['glyf', glyf],
        ['head', head],
        ['hhea', hhea],
        ['hmtx', hmtx],
        ['loca', loca],
        ['maxp', maxp],
    ];
    if (font.os2)
        tables.push(['OS/2', font.os2]);
    if (font.post)
        tables.push(['post', font.post]);
    if (font.name)
        tables.push(['name', font.name]);
    return assembleTtf(tables);
}
/** 重建 cmap：format 4（BMP）+ 必要时 format 12（含非 BMP）。 */
function buildCmap(usedChars, font) {
    const bmp = [...new Set(usedChars.filter((c) => c <= 0xffff && c !== 0xffff && c !== 0xfffe))].sort((a, b) => a - b);
    const nonBmp = [...new Set(usedChars.filter((c) => c > 0xffff))].sort((a, b) => a - b);
    const sub4 = buildCmap4(bmp, font);
    const subs = [[3, 1, sub4], [0, 3, sub4]];
    if (nonBmp.length > 0) {
        const sub12 = buildCmap12([...bmp, ...nonBmp], font);
        subs.push([3, 10, sub12], [0, 4, sub12]);
    }
    const headerSize = 4 + subs.length * 8;
    const total = headerSize + subs.reduce((s, [, , b]) => s + b.length, 0);
    const cmap = Buffer.alloc(total);
    cmap.writeUInt16BE(0, 0); // version
    cmap.writeUInt16BE(subs.length, 2);
    let off = headerSize;
    for (let i = 0; i < subs.length; i++) {
        const [p, e, b] = subs[i];
        cmap.writeUInt16BE(p, 4 + i * 8);
        cmap.writeUInt16BE(e, 4 + i * 8 + 2);
        cmap.writeUInt32BE(off, 4 + i * 8 + 4);
        b.copy(cmap, off);
        off += b.length;
    }
    return cmap;
}
function buildCmap4(sortedBmp, font) {
    const segCount = sortedBmp.length + 1;
    const segCountX2 = segCount * 2;
    const entrySelector = Math.floor(Math.log2(segCount));
    const searchRange = 2 * 2 ** entrySelector;
    const rangeShift = segCountX2 - searchRange;
    const size = 16 + segCountX2 * 4;
    const buf = Buffer.alloc(size);
    buf.writeUInt16BE(4, 0); // format
    buf.writeUInt16BE(size, 2); // length
    buf.writeUInt16BE(0, 4); // language
    buf.writeUInt16BE(segCountX2, 6);
    buf.writeUInt16BE(searchRange, 8);
    buf.writeUInt16BE(entrySelector, 10);
    buf.writeUInt16BE(rangeShift, 12);
    const endBase = 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let i = 0; i < segCount; i++) {
        const code = i < sortedBmp.length ? sortedBmp[i] : 0xffff;
        buf.writeUInt16BE(code, endBase + i * 2);
        buf.writeUInt16BE(code, startBase + i * 2);
        const gid = i < sortedBmp.length ? (font.charToGid.get(code) ?? 0) : 0;
        buf.writeUInt16BE((gid - code) & 0xffff, deltaBase + i * 2);
        buf.writeUInt16BE(0, rangeBase + i * 2); // idRangeOffset = 0
    }
    return buf;
}
function buildCmap12(sorted, font) {
    const groups = [];
    for (const c of sorted) {
        const last = groups[groups.length - 1];
        if (last && c === last[1] + 1)
            last[1] = c;
        else
            groups.push([c, c]);
    }
    const nGroups = groups.length;
    const size = 16 + nGroups * 12;
    const buf = Buffer.alloc(size);
    buf.writeUInt16BE(12, 0); // format
    buf.writeUInt16BE(0, 2); // reserved
    buf.writeUInt32BE(size, 4); // length
    buf.writeUInt32BE(0, 8); // language
    buf.writeUInt32BE(nGroups, 12);
    for (let i = 0; i < nGroups; i++) {
        const [start, end] = groups[i];
        const base = 16 + i * 12;
        buf.writeUInt32BE(start, base);
        buf.writeUInt32BE(end, base + 4);
        buf.writeUInt32BE(font.charToGid.get(start) ?? 0, base + 8);
    }
    return buf;
}
/** 组装 TTF：表目录 + 校验和 + checkSumAdjustment。 */
function assembleTtf(tables) {
    const sorted = [...tables].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const numTables = sorted.length;
    const entrySelector = Math.floor(Math.log2(numTables));
    const searchRange = 16 * 2 ** entrySelector;
    const rangeShift = numTables * 16 - searchRange;
    const header = Buffer.alloc(12);
    header.writeUInt32BE(0x00010000, 0); // sfnt version
    header.writeUInt16BE(numTables, 4);
    header.writeUInt16BE(searchRange, 6);
    header.writeUInt16BE(entrySelector, 8);
    header.writeUInt16BE(rangeShift, 10);
    const dir = Buffer.alloc(numTables * 16);
    const padded = [];
    let offset = 12 + numTables * 16;
    let total = tableChecksum(header);
    for (let i = 0; i < numTables; i++) {
        const [tag, data] = sorted[i];
        const p = pad4(data);
        padded.push(p);
        const sum = tableChecksum(p);
        dir.write(tag, i * 16, 4, 'latin1');
        dir.writeUInt32BE(sum, i * 16 + 4);
        dir.writeUInt32BE(offset, i * 16 + 8);
        dir.writeUInt32BE(p.length, i * 16 + 12);
        total = (total + sum) >>> 0;
        offset += p.length;
    }
    // checkSumAdjustment = 0xB1B0AFBA - 全文件校验和（head 中该字段按 0 计）
    const headIdx = sorted.findIndex(([t]) => t === 'head');
    if (headIdx >= 0) {
        const adj = (0xb1b0afba - total) >>> 0;
        sorted[headIdx][1].writeUInt32BE(adj, 8);
        dir.writeUInt32BE(tableChecksum(padded[headIdx]), headIdx * 16 + 4);
    }
    return Buffer.concat([header, dir, ...padded]);
}
// ============================================================
// 字体查找
// ============================================================
/** 系统 CJK 字体候选（TTF/TTC），按优先级排列。 */
function cjkFontCandidates() {
    const env = process.env.DSH_CJK_FONT;
    const envFonts = env ? env.split(/[;:]/).map((s) => s.trim()).filter(Boolean) : [];
    const win = (name) => `C:\\Windows\\Fonts\\${name}`;
    return [
        ...envFonts,
        win('simhei.ttf'),
        win('msyh.ttc'),
        win('simsun.ttc'),
        win('simkai.ttf'),
        win('simfang.ttf'),
        win('STSONG.TTF'),
        win('STXIHEI.TTF'),
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/Hiragino Sans GB.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/truetype/arphic/uming.ttc',
        '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    ];
}
// ============================================================
// 字体面（布局用）
// ============================================================
/** 标准 Helvetica 宽度（1/1000 em），下标 = code - 32 */
const HELVETICA_WIDTHS = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
function helveticaWidth1000(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c <= 126)
        return HELVETICA_WIDTHS[c - 32];
    return 556;
}
function makeHelveticaFace() {
    return {
        ref: 'F1',
        codeHex(text) {
            let hex = '';
            for (const ch of text)
                hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
            return hex;
        },
        width1000: helveticaWidth1000,
    };
}
function makeCidFace(emb) {
    const gids = new Map();
    for (const cp of emb.usedChars) {
        const g = emb.parsed.charToGid.get(cp);
        if (g !== undefined)
            gids.set(cp, g);
    }
    return {
        ref: 'F1',
        codeHex(text) {
            let hex = '';
            for (const ch of text) {
                const g = gids.get(ch.codePointAt(0) ?? 0) ?? 0;
                hex += g.toString(16).padStart(4, '0');
            }
            return hex;
        },
        width1000(ch) {
            const g = gids.get(ch.codePointAt(0) ?? 0) ?? 0;
            const adv = emb.parsed.advances[Math.min(g, emb.parsed.advances.length - 1)] ?? 1000;
            return Math.round((adv * 1000) / emb.parsed.unitsPerEm);
        },
    };
}
// ============================================================
// 布局引擎
// ============================================================
class DocLayout {
    pages = [];
    y = 0;
    face;
    boldRef;
    titleSize = 18;
    paraSize = 11;
    cellSize = 9.5;
    constructor(face, boldRef) {
        this.face = face;
        this.boldRef = boldRef;
        this.newPage();
    }
    newPage() {
        this.pages.push('');
        this.y = PAGE_H - MARGIN;
    }
    ensure(height) {
        if (this.y - height < MARGIN)
            this.newPage();
    }
    emit(op) {
        this.pages[this.pages.length - 1] += op;
    }
    lineHeight(fs) {
        return fs * LINE_SCALE;
    }
    textWidth(text, fs) {
        let w = 0;
        for (const ch of text)
            w += (this.face.width1000(ch) / 1000) * fs;
        return w;
    }
    /** 按字符宽度折行，保留显式换行。 */
    wrap(text, fs, maxWidth) {
        const lines = [];
        let cur = '';
        let curW = 0;
        for (const ch of text.replace(/\t/g, '    ')) {
            if (ch === '\n') {
                lines.push(cur);
                cur = '';
                curW = 0;
                continue;
            }
            const w = (this.face.width1000(ch) / 1000) * fs;
            if (curW + w > maxWidth && cur !== '') {
                lines.push(cur);
                cur = '';
                curW = 0;
            }
            cur += ch;
            curW += w;
        }
        lines.push(cur);
        return lines;
    }
    drawLine(text, fs, x, baselineY, bold) {
        this.emit(`BT /${bold ? this.boldRef : this.face.ref} ${fs} Tf 1 0 0 1 ${x.toFixed(2)} ${baselineY.toFixed(2)} Tm <${this.face.codeHex(text)}> Tj ET\n`);
    }
    title(text) {
        const fs = this.titleSize;
        const lh = this.lineHeight(fs);
        this.ensure(lh + 10);
        const w = this.textWidth(text, fs);
        const x = MARGIN + (USABLE_W - w) / 2;
        this.drawLine(text, fs, Math.max(MARGIN, x), this.y - fs * 0.85, true);
        this.y -= lh + 10;
    }
    paragraph(text) {
        const fs = this.paraSize;
        const lh = this.lineHeight(fs);
        const lines = this.wrap(text, fs, USABLE_W);
        const gap = fs * 0.5;
        this.ensure(lh * lines.length + gap);
        let baseline = this.y - fs * 0.85;
        for (const line of lines) {
            this.drawLine(line, fs, MARGIN, baseline, false);
            baseline -= lh;
        }
        this.y -= lh * lines.length + gap;
    }
    measureRow(row, widths, fs, lh, padX, padY) {
        let nLines = 1;
        for (let c = 0; c < widths.length; c++) {
            const lines = this.wrap(row[c] ?? '', fs, Math.max(10, widths[c] - padX * 2));
            if (lines.length > nLines)
                nLines = lines.length;
        }
        return nLines * lh + padY * 2;
    }
    /** 在 yTop（行顶）绘制一行，返回行高。 */
    renderRowAt(row, widths, yTop, isHeader, fs, lh, padX, padY) {
        const allLines = widths.map((w, c) => this.wrap(row[c] ?? '', fs, Math.max(10, w - padX * 2)));
        const nLines = Math.max(1, ...allLines.map((ls) => ls.length));
        const rowH = nLines * lh + padY * 2;
        const bottom = yTop - rowH;
        let x = MARGIN;
        for (let c = 0; c < widths.length; c++) {
            const w = widths[c];
            if (isHeader) {
                this.emit(`0.9 0.9 0.9 rg ${x.toFixed(2)} ${bottom.toFixed(2)} ${w.toFixed(2)} ${rowH.toFixed(2)} re f 0 g\n`);
            }
            this.emit(`0.7 0.7 0.7 RG ${x.toFixed(2)} ${bottom.toFixed(2)} ${w.toFixed(2)} ${rowH.toFixed(2)} re S\n`);
            let baseline = yTop - padY - fs * 0.85;
            for (const line of allLines[c]) {
                this.drawLine(line, fs, x + padX, baseline, isHeader);
                baseline -= lh;
            }
            x += w;
        }
        return rowH;
    }
    table(rows) {
        if (rows.length === 0)
            return;
        const fs = this.cellSize;
        const lh = this.lineHeight(fs);
        const padX = 4;
        const padY = 3;
        const colCount = Math.max(...rows.map((r) => r.length));
        // 自然列宽 = 该列最宽内容 + 2*padding，上限半页宽；总宽超出则等比压缩
        const widths = [];
        for (let c = 0; c < colCount; c++) {
            let maxW = 0;
            for (const row of rows) {
                let w = 0;
                for (const ch of (row[c] ?? '').replace(/\t/g, '    '))
                    w += (this.face.width1000(ch) / 1000) * fs;
                if (w > maxW)
                    maxW = w;
            }
            widths.push(Math.min(maxW + padX * 2, USABLE_W / 2));
        }
        const total = widths.reduce((a, b) => a + b, 0);
        if (total > USABLE_W) {
            const scale = USABLE_W / total;
            for (let c = 0; c < colCount; c++)
                widths[c] = Math.max(20, widths[c] * scale);
        }
        let first = true;
        for (const row of rows) {
            const rowH = this.measureRow(row, widths, fs, lh, padX, padY);
            if (this.y - rowH < MARGIN) {
                this.newPage();
                if (!first) {
                    // 跨页时在新页顶部重复表头
                    this.y -= this.renderRowAt(rows[0], widths, this.y, true, fs, lh, padX, padY);
                }
            }
            this.y -= this.renderRowAt(row, widths, this.y, first, fs, lh, padX, padY);
            first = false;
        }
        this.y -= fs * 0.5; // 表格后间隙
    }
}
// ============================================================
// PDF 组装
// ============================================================
class PdfBuilder {
    parts = [];
    size = 0;
    offsets = [];
    count = 0;
    constructor() {
        this.push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
    }
    push(data) {
        this.parts.push(data);
        this.size += data.length;
    }
    beginObj() {
        const id = ++this.count;
        this.offsets[id] = this.size;
        this.push(Buffer.from(`${id} 0 obj\n`, 'latin1'));
        return id;
    }
    writeLine(line) {
        this.push(Buffer.from(line + '\n', 'latin1'));
    }
    /** 写入一个 FlateDecode 压缩流对象，返回对象号。 */
    writeStreamObj(data) {
        const compressed = deflateSync(data);
        const id = this.beginObj();
        this.writeLine(`<< /Length ${compressed.length} /Filter /FlateDecode >>`);
        this.writeLine('stream');
        this.push(compressed);
        this.writeLine('endstream');
        this.endObj();
        return id;
    }
    endObj() {
        this.push(Buffer.from('endobj\n', 'latin1'));
    }
    build(root, info) {
        const xrefPos = this.size;
        const n = this.count;
        let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
        for (let i = 1; i <= n; i++) {
            xref += `${this.offsets[i].toString().padStart(10, '0')} 00000 n \n`;
        }
        xref += `trailer\n<< /Size ${n + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
        return Buffer.concat([...this.parts, Buffer.from(xref, 'latin1')]);
    }
}
function escapeInfoString(s) {
    if (/[^\x20-\x7e]/.test(s)) {
        // 非 ASCII → UTF-16BE 十六进制（带 BOM）
        const hex = Buffer.from('\ufeff' + s, 'utf16le').toString('hex').toUpperCase();
        return `<${hex}>`;
    }
    return `(${s.replace(/[\\()]/g, (m) => `\\${m}`)})`;
}
/** CIDFont 的 W 数组：连续 GID 区间。 */
function buildWidthsArray(emb) {
    const gids = [...new Set([0, ...emb.usedChars.map((c) => emb.parsed.charToGid.get(c) ?? 0)])].sort((a, b) => a - b);
    const parts = [];
    let i = 0;
    while (i < gids.length) {
        let j = i;
        while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1)
            j++;
        const ws = gids.slice(i, j + 1).map((g) => Math.round((emb.parsed.advances[Math.min(g, emb.parsed.advances.length - 1)] * 1000) / emb.parsed.unitsPerEm));
        parts.push(`${gids[i]} [${ws.join(' ')}]`);
        i = j + 1;
    }
    return `[${parts.join(' ')}]`;
}
/** ToUnicode CMap：CID(=GID) → Unicode。 */
function buildToUnicode(emb) {
    const entries = [];
    for (const c of emb.usedChars) {
        const gid = emb.parsed.charToGid.get(c);
        if (gid === undefined)
            continue;
        let uni;
        if (c <= 0xffff) {
            uni = c.toString(16).padStart(4, '0').toUpperCase();
        }
        else {
            const v = c - 0x10000;
            const hi = 0xd800 + (v >> 10);
            const lo = 0xdc00 + (v & 0x3ff);
            uni = (hi.toString(16) + lo.toString(16)).toUpperCase();
        }
        entries.push(`<${gid.toString(16).padStart(4, '0').toUpperCase()}> <${uni}>`);
    }
    const chunks = [];
    for (let i = 0; i < entries.length; i += 100) {
        const block = entries.slice(i, i + 100);
        chunks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
    }
    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
}
function assemblePdf(pages, emb, meta) {
    const b = new PdfBuilder();
    const n = pages.length;
    // 对象编号规划（按创建顺序）：
    // 1 Catalog, 2 Pages 树, 3..2+n 页面, 3+n..2+2n 内容流, 之后字体对象, 最后 Info
    const f1 = 3 + 2 * n; // 正文字体（嵌入时为 Type0；Helvetica 时为 F1）
    const f2 = f1 + 1; // Helvetica-Bold（仅 ASCII 路径）
    const cid = f1 + 1; // CIDFontType2（仅嵌入路径）
    const desc = f1 + 2; // FontDescriptor
    const fileId = f1 + 3; // FontFile2 流
    const tocId = f1 + 4; // ToUnicode 流
    const info = emb ? tocId + 1 : f2 + 1;
    // 1: Catalog
    const catalog = b.beginObj();
    b.writeLine('<< /Type /Catalog /Pages 2 0 R >>');
    b.endObj();
    // 2: Pages 树
    b.beginObj();
    b.writeLine(`<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${n} >>`);
    b.endObj();
    // 3..2+n: 页面
    const fontDict = emb
        ? `/Font << /F1 ${f1} 0 R >>`
        : `/Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>`;
    const pageIds = [];
    for (let i = 0; i < n; i++) {
        pageIds.push(b.beginObj());
        b.writeLine(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << ${fontDict} >> /Contents ${3 + n + i} 0 R >>`);
        b.endObj();
    }
    // 3+n..2+2n: 内容流
    for (let i = 0; i < n; i++) {
        b.writeStreamObj(Buffer.from(pages[i], 'latin1'));
        void pageIds;
    }
    // 字体对象
    if (emb) {
        b.beginObj();
        b.writeLine(`<< /Type /Font /Subtype /Type0 /BaseFont /${emb.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tocId} 0 R >>`);
        b.endObj();
        b.beginObj();
        b.writeLine(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${emb.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W ${buildWidthsArray(emb)} /CIDToGIDMap /Identity >>`);
        b.endObj();
        b.beginObj();
        const f = emb.parsed;
        b.writeLine(`<< /Type /FontDescriptor /FontName /${emb.name} /Flags 4 /FontBBox [${f.xMin} ${f.yMin} ${f.xMax} ${f.yMax}] /ItalicAngle 0 /Ascent ${f.ascent} /Descent ${f.descent} /CapHeight ${Math.round(f.ascent * 0.7)} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
        b.endObj();
        b.writeStreamObj(emb.subset);
        b.writeStreamObj(Buffer.from(buildToUnicode(emb), 'latin1'));
    }
    else {
        b.beginObj();
        b.writeLine('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        b.endObj();
        b.beginObj();
        b.writeLine('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        b.endObj();
    }
    // Info
    const now = new Date();
    const dateStr = `D:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}Z`;
    b.beginObj();
    b.writeLine(`<< /Producer (dsh-doc-toolkit) /Creator (dsh-doc-toolkit) /Title ${escapeInfoString(meta.title ?? '')} /CreationDate (${dateStr}) >>`);
    b.endObj();
    return b.build(catalog, info);
}
// ============================================================
// 主入口
// ============================================================
/**
 * 生成 PDF 文件。content 支持：
 * - title?: string        大标题（居中）
 * - paragraphs?: string[] 段落（也可用 content: string 按换行分段）
 * - rows?: unknown[][]    二维数组，渲染为表格（首行作表头）
 */
export async function writePDF(filePath, content, signal) {
    const title = typeof content.title === 'string' && content.title.length > 0 ? content.title : undefined;
    let paragraphs = [];
    let rows;
    if (Array.isArray(content.paragraphs)) {
        paragraphs = content.paragraphs.map((p) => String(p));
    }
    else if (typeof content.content === 'string') {
        paragraphs = content.content.split(/\r?\n/).filter((p) => p.trim().length > 0);
    }
    else if (!Array.isArray(content.rows)) {
        return `错误：content 必须包含 paragraphs（字符串数组）、content（纯文本）或 rows（二维数组，渲染为表格）字段，收到: ${JSON.stringify(content)}`;
    }
    if (Array.isArray(content.rows)) {
        rows = content.rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
    }
    if (!title && paragraphs.length === 0 && (!rows || rows.length === 0)) {
        return `错误：内容为空，无法生成 PDF。请在 content 中提供 title / paragraphs / content / rows 字段。`;
    }
    const allText = [title ?? '', ...paragraphs, ...(rows ? rows.flat() : [])].join('');
    const cps = [...new Set(allText)].map((ch) => ch.codePointAt(0)).filter((cp) => cp !== 0x0a && cp !== 0x0d && cp !== 0x09);
    const needCJK = cps.some((cp) => cp > 0x7f);
    let emb;
    let face;
    let boldRef = 'F2';
    if (needCJK) {
        let chosen;
        for (const candidate of cjkFontCandidates()) {
            if (!existsSync(candidate))
                continue;
            try {
                const buf = await readFile(candidate);
                const sel = selectBestFont(buf, cps);
                const used = cps.filter((cp) => sel.font.charToGid.has(cp));
                if (used.length === 0)
                    continue;
                const name = path.basename(candidate).replace(/\.(ttf|ttc)$/i, '').replace(/[^A-Za-z0-9_-]/g, '') || 'CJKFont';
                chosen = { parsed: sel.font, name, usedChars: used, missing: cps.length - used.length };
                const subset = buildSubset(sel.font, used);
                emb = { parsed: sel.font, subset, name, usedChars: used, missingChars: chosen.missing };
                break;
            }
            catch {
                continue; // 字体损坏或不可解析，尝试下一个候选
            }
        }
        if (!emb) {
            return `错误：内容包含非 ASCII 字符，但未找到可用的系统中文字体（TrueType）。可设置环境变量 DSH_CJK_FONT 指定 TTF/TTC 路径（分号分隔多个）。文件未生成: ${filePath}`;
        }
        face = makeCidFace(emb);
        boldRef = 'F1'; // 嵌入字体无粗体变体，标题/表头沿用同字体
    }
    else {
        face = makeHelveticaFace();
    }
    const layout = new DocLayout(face, boldRef);
    if (title)
        layout.title(title);
    for (const p of paragraphs)
        layout.paragraph(p);
    if (rows)
        layout.table(rows);
    const pdf = assemblePdf(layout.pages, emb, { title });
    await writeFile(filePath, pdf, { signal });
    const fontNote = emb
        ? `，内嵌字体 ${emb.name}（子集 ${emb.usedChars.length} 字符${emb.missingChars > 0 ? `，${emb.missingChars} 个字符缺失将无法渲染` : ''}）`
        : '，标准字体 Helvetica';
    return `成功写入 PDF 文件: ${filePath}（共 ${layout.pages.length} 页${title ? `，标题「${title}」` : ''}，${paragraphs.length} 个段落${rows ? `，表格 ${rows.length} 行` : ''}${fontNote}）`;
}
