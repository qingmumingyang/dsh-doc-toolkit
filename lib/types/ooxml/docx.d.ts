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
import type { ZipEntryData } from '../zip/read.js';
/**
 * 提取 DOCX 的可见文本。
 *
 * @param zip `readZip` 的结果。
 * @throws 缺少 `word/document.xml` 时抛出明确的 Error。
 */
export declare function readDocxText(zip: Map<string, ZipEntryData>): string;
/**
 * 生成最小但合法的 DOCX 包（STORED ZIP，纯 ASCII 字节）。
 *
 * 包含 `[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、
 * `word/_rels/document.xml.rels`、`word/styles.xml`；后者已在
 * `[Content_Types].xml` 里登记、并在文档关系里引用，因此不会「注册不全」。
 */
export declare function buildDocx(input: {
    readonly title?: string;
    readonly paragraphs: readonly string[];
}): Uint8Array;
