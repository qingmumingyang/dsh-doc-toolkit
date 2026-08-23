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
export interface ParsedFont {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    numGlyphs: number;
    /** 每个字形的 advance（字体单位，共 numGlyphs 项） */
    advances: number[];
    /** loca 表展开后的字节偏移（numGlyphs + 1 项） */
    loca: number[];
    glyf: Buffer;
    charToGid: Map<number, number>;
    head: Buffer;
    hhea: Buffer;
    maxp: Buffer;
    os2?: Buffer;
    post?: Buffer;
    name?: Buffer;
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
}
/**
 * 解析 TrueType 字体（或 TTC 集合中的第 fontIndex 个字体）。
 * 仅支持 TrueType 轮廓（glyf）；CFF/OTF 抛错。
 */
export declare function parseFont(buf: Buffer, fontIndex?: number): ParsedFont;
/**
 * 在 TTF/TTC 中选择对给定字符集覆盖最好的字体。
 */
export declare function selectBestFont(buf: Buffer, cps: number[]): {
    font: ParsedFont;
    index: number;
};
/**
 * 从已解析字体构建子集字体：
 * - 只保留用到的字形（递归包含复合字形的组件），未用槽位写空轮廓；
 * - 重建 cmap（format 4，必要时加 format 12）、hmtx、loca、glyf；
 * - 修正 head/hhea/maxp 字段并重算所有表校验和与 checkSumAdjustment。
 */
export declare function buildSubset(font: ParsedFont, usedChars: number[]): Buffer;
export interface FontFace {
    /** PDF 资源名，如 F1 */
    ref: string;
    /** 文本十六进制串（Identity-H 为每字符 4 位 GID；Helvetica 为每字符 2 位字节） */
    codeHex(text: string): string;
    /** 字符宽度（1/1000 em） */
    width1000(ch: string): number;
}
/**
 * 生成 PDF 文件。content 支持：
 * - title?: string        大标题（居中）
 * - paragraphs?: string[] 段落（也可用 content: string 按换行分段）
 * - rows?: unknown[][]    二维数组，渲染为表格（首行作表头）
 */
export declare function writePDF(filePath: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
