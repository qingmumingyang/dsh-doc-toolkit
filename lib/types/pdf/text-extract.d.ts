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
/** 提取边界；全部可选，缺省见 {@link PDF_EXTRACT_DEFAULTS}。 */
export interface PdfExtractLimits {
    /** 输入字节上限，超过直接报错（在任何解析之前检查）。 */
    readonly maxBytes?: number;
    /** 最多收集多少页，超过则置 `truncated`。 */
    readonly maxPages?: number;
    /** 最多收集多少字符，超过则置 `truncated` 并截断。 */
    readonly maxChars?: number;
    /** 最多解析多少个间接对象，超过则停止解析（不抛错）。 */
    readonly maxObjects?: number;
}
/** 提取结果。 */
export interface ExtractedPdfText {
    /** 提取到的文本；页与页之间以一个空行分隔。 */
    readonly text: string;
    /** 实际收集到的页数（包含没有文本的页）。 */
    readonly pages: number;
    /** 是否因为某个边界而提前停止。 */
    readonly truncated: boolean;
}
/** 缺省边界：足够大以覆盖正常文档，又能在恶意输入上兜住内存与时间。 */
export declare const PDF_EXTRACT_DEFAULTS: {
    readonly maxBytes: number;
    readonly maxPages: 2000;
    readonly maxChars: 4000000;
    readonly maxObjects: 200000;
};
/**
 * `TJ` 数组里小于等于该值的调整量视为词间空格（PDF 中负值表示把文字向右推）。
 * 取 -120/1000 em：常见字距调整远小于它，真正的词间空格远大于它。
 */
export declare const TJ_FORWARD_WORD_GAP = -120;
/** 本实现**明确不做**的事，供使用方与复核者判断适用性。 */
export declare const UNSUPPORTED: readonly string[];
/**
 * 提取 PDF 文本。
 *
 * @param bytes 完整文件字节
 * @param limits 边界（见 {@link PdfExtractLimits}）
 * @throws 输入为空、不是 PDF、超过 `maxBytes`、或文档加密时抛出带说明的 Error
 */
export declare function extractPdfText(bytes: Uint8Array, limits?: PdfExtractLimits): ExtractedPdfText;
