/**
 * WordprocessingML（DOCX）最小实现：读取可见文本、生成最小可用文档。
 *
 * 设计要点：
 * - 纯计算模块：只处理「名字 -> 字节」的表与字节，不做任何输入输出。
 * - 读：只依赖 `word/document.xml`，按 `<w:t>` 取文本、`</w:p>` 断段、
 *   `<w:tab/>` 与 `<w:br/>` 转义成制表/换行；忽略 `<w:instrText>`（域代码）。
 *   用「扫描下一个标签」而不是大正则，因此对属性顺序、命名空间前缀、
 *   嵌套结构（如 `mc:AlternateContent`）都稳定。
 * - 写：生成 [Content_Types].xml + _rels/.rels + word/document.xml 三件套，
 *   所有 XML 都过 ASCII 转义器，保证 ZIP 输出纯 ASCII。
 */
import { buildStoredZip } from '../zip/write.js';
import { decodeXmlText, escapeXmlAttr, escapeXmlText } from './xml.js';
/** DOCX 主文档部件路径。 */
const DOCUMENT_PART = 'word/document.xml';
const TEXT_DECODER = new TextDecoder('utf-8');
/** 把条目字节按 UTF-8 解码成字符串。 */
function entryText(entry) {
    return TEXT_DECODER.decode(entry.bytes);
}
/** 找第一个 `<tag ...>` 的内容区间（不处理同名嵌套，够用且可预期）。 */
function findElement(xml, tag) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let from = 0;
    for (;;) {
        const start = xml.indexOf(open, from);
        if (start < 0)
            return undefined;
        const nameEnd = start + open.length;
        const following = xml.charAt(nameEnd);
        // 必须正好是标签名（避免 <w:tbl> 命中 <w:t）。
        if (following !== '>' && following !== ' ' && following !== '\t' && following !== '\r' && following !== '\n' && following !== '/') {
            from = nameEnd;
            continue;
        }
        const gt = xml.indexOf('>', nameEnd);
        if (gt < 0)
            return undefined;
        if (xml.charAt(gt - 1) === '/') {
            // 自闭合的空元素。
            return { inner: '', raw: xml.slice(start, gt + 1) };
        }
        const end = xml.indexOf(close, gt + 1);
        if (end < 0)
            return undefined;
        return { inner: xml.slice(gt + 1, end), raw: xml.slice(start, end + close.length) };
    }
}
/** 去掉每行行尾空白，并丢掉末尾的空白行（Word 常在段末留空 `<w:p>`）。 */
function trimTrailingWhitespace(text) {
    const lines = text.split('\n').map((line) => line.replace(/[ \t\r]+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines.join('\n');
}
/**
 * 提取 DOCX 的可见文本。
 *
 * @param zip `readZip` 的结果。
 * @throws 缺少 `word/document.xml` 时抛出明确的 Error。
 */
export function readDocxText(zip) {
    const entry = zip.get(DOCUMENT_PART);
    if (!entry)
        throw new Error(`DOCX 缺少主文档部件 ${DOCUMENT_PART}`);
    const xml = entryText(entry);
    const body = findElement(xml, 'w:body');
    const scan = body ? body.inner : xml;
    let out = '';
    let cursor = 0;
    for (;;) {
        const lt = scan.indexOf('<', cursor);
        if (lt < 0)
            break;
        const gt = scan.indexOf('>', lt + 1);
        if (gt < 0)
            break;
        const tag = scan.slice(lt, gt + 1);
        const selfClosing = tag.endsWith('/>');
        // 取标签名（去掉属性/闭合斜杠）。
        const name = /^<\/?\s*([^\s/>]+)/.exec(tag)?.[1] ?? '';
        if (name === 'w:t') {
            if (selfClosing) {
                cursor = gt + 1;
                continue;
            }
            const close = scan.indexOf('</w:t>', gt + 1);
            if (close < 0)
                break;
            out += decodeXmlText(scan.slice(gt + 1, close));
            cursor = close + '</w:t>'.length;
            continue;
        }
        if (name === 'w:tab' || name === 'w:ptab') {
            out += '\t';
        }
        else if (name === 'w:br' || name === 'w:cr') {
            out += '\n';
        }
        else if (name === 'w:p' && tag.startsWith('</')) {
            out += '\n';
        }
        else if (name === 'w:instrText') {
            // 域代码不是可见文本：整段跳过。
            if (!selfClosing) {
                const close = scan.indexOf('</w:instrText>', gt + 1);
                if (close >= 0) {
                    cursor = close + '</w:instrText>'.length;
                    continue;
                }
            }
        }
        cursor = gt + 1;
    }
    return trimTrailingWhitespace(out);
}
/** 生成一个文本 run；文本为空时输出空 run（保持段落结构合法）。 */
function runXml(text, bold, halfPoints, centered) {
    const props = [];
    if (centered)
        props.push('<w:jc w:val="center"/>');
    if (bold)
        props.push('<w:b/>');
    if (halfPoints !== undefined)
        props.push(`<w:sz w:val="${halfPoints}"/>`);
    const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    const value = escapeXmlText(text);
    // xml:space="preserve" 保留首尾空格，避免 Word 折叠空白。
    return `<w:r>${rPr}<w:t xml:space="preserve">${value}</w:t></w:r>`;
}
/** 生成一个段落；`style` 用于让标题引用 styles.xml 里的样式（可选）。 */
function paragraphXml(text, options) {
    const bold = options?.bold ?? false;
    const centered = options?.centered ?? false;
    const style = options?.style;
    const pPr = style ? `<w:pPr><w:pStyle w:val="${escapeXmlAttr(style)}"/></w:pPr>` : '';
    return `<w:p>${pPr}${runXml(text, bold, options?.halfPoints, centered)}</w:p>`;
}
const DOCUMENT_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CONTENT_TYPES_XML = `${DOCUMENT_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const ROOT_RELS_XML = `${DOCUMENT_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const STYLES_XML = `${DOCUMENT_HEAD}
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`;
/**
 * 生成最小但合法的 DOCX 包（STORED ZIP，纯 ASCII 字节）。
 *
 * 包含 `[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、
 * `word/_rels/document.xml.rels`、`word/styles.xml`；后者已在
 * `[Content_Types].xml` 里登记、并在文档关系里引用，因此不会「注册不全」。
 */
export function buildDocx(input) {
    const paragraphs = input.paragraphs ?? [];
    const body = [];
    const title = input.title;
    if (title !== undefined && title.length > 0) {
        // 标题：加粗、字号放大（半磅值 36 = 18pt）、居中。
        body.push(paragraphXml(title, { bold: true, halfPoints: 36, centered: true, style: 'Title' }));
    }
    for (const paragraph of paragraphs)
        body.push(paragraphXml(paragraph ?? ''));
    const documentXml = `${DOCUMENT_HEAD}
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const documentRelsXml = `${DOCUMENT_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    const entries = [
        { name: '[Content_Types].xml', data: encodeAscii(CONTENT_TYPES_XML) },
        { name: '_rels/.rels', data: encodeAscii(ROOT_RELS_XML) },
        { name: DOCUMENT_PART, data: encodeAscii(documentXml) },
        { name: 'word/_rels/document.xml.rels', data: encodeAscii(documentRelsXml) },
        { name: 'word/styles.xml', data: encodeAscii(STYLES_XML) }
    ];
    return buildStoredZip(entries);
}
/**
 * 把已经 ASCII 安全的 XML 字符串编码成字节。
 *
 * 模板本身是纯 ASCII；万一有人往模板里塞了非 ASCII，这里立刻报错，
 * 而不是让 buildStoredZip 在别处失败。
 */
function encodeAscii(xml) {
    const bytes = new Uint8Array(xml.length);
    for (let index = 0; index < xml.length; index++) {
        const code = xml.charCodeAt(index);
        if (code > 0x7f)
            throw new Error(`DOCX 模板出现非 ASCII 字符（位置 ${index}），请改用 escapeXmlText 转义`);
        bytes[index] = code;
    }
    return bytes;
}
