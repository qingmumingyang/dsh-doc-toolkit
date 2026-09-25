/**
 * 纯 JS PDF 生成器（零第三方运行时依赖、零直接文件访问）。
 *
 * 特性：
 * - A4 页面、自动换行与分页；支持标题（居中）、段落、表格（rows，首行作表头）。
 * - 纯 ASCII 内容 → 标准 14 字体 Helvetica，文件极小。
 * - 含中文等内容 → 自动查找系统 CJK TrueType 字体（TTF/TTC），解析并子集化后嵌入，
 *   输出 Type0(CIDFontType2) + Identity-H + ToUnicode 结构，文本可复制、可搜索。
 * - 字体中缺失的字符（如 emoji）降级为 .notdef，并在返回消息中注明数量。
 *
 * 两个刻意的约束：
 * 1. **不读环境变量**：字体候选来自插件配置 `cjkFonts`。DSH STORE 的固定源自动策略会把
 *    任何环境变量读取记为 credentials 权限信号，见 PERMISSIONS.md。
 * 2. **产物是纯 ASCII**：全部文件读写经 `ctx.fs`（见 utils/fs-channel.ts），而它只有文本
 *    写入 API。因此含二进制的流（内嵌字体子集）改用 `/Filter [/ASCIIHexDecode /FlateDecode]`
 *    编码，其余流本就是 ASCII 文本——整个 PDF 文件保持纯 ASCII，经 UTF-8 文本通道写出后
 *    与原始字节完全一致。
 */
import { type DocumentTarget } from '../utils/fs-channel.js';
import type { PluginContext } from '../types/plugin-context.js';
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
 *
 * `bestScore` 从 0 起（而不是 -1）：**一个字符都覆盖不到的子字体视为不可用**，
 * 宁可让调用方继续试下一个候选，也不要选出一个"能解析但没有任何所需字形"的字体
 * ——那会写出中文全是 .notdef 的 PDF。
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
 *
 * 字体候选按 `cjkFonts`（插件配置）→ 内置系统路径的顺序经 `ctx.fs` 探测读取；
 * 产物经 `ctx.fs` 文本通道写出（因此必须是纯 ASCII，见文件头说明）。
 */
export declare function writePDF(ctx: PluginContext, exec: unknown, target: DocumentTarget, content: Record<string, unknown>, signal?: AbortSignal, extraFonts?: readonly string[]): Promise<string>;
