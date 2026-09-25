/**
 * SpreadsheetML（XLSX）最小实现：读取工作表网格、生成最小单表工作簿。
 *
 * 设计要点：
 * - 纯计算模块：只处理「名字 -> 字节」的表与字节，不做任何输入输出。
 * - 读：从 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` 解析工作表名字与顺序，
 *   再定位 `xl/worksheets/sheetN.xml`；单元格按 `r` 属性（如 C5）定位，
 *   因此稀疏行/稀疏列也能对齐；`dimension` 只当提示，缺了也能读。
 *   共享字符串里的 `_x000D_` 这类 Excel 转义与多 `<r><t>` 富文本都会还原。
 * - 写：单工作表 + 内联字符串（`t="inlineStr"`），因此不需要 sharedStrings 部件；
 *   所有 XML 过 ASCII 转义器，保证 ZIP 输出纯 ASCII。
 */
import type { ZipEntryData } from '../zip/read.js';
/** 一个工作表的稠密网格（行 -> 单元格文本）。 */
export interface SheetData {
    /** 工作表名。 */
    readonly name: string;
    /** 行数组；每行是等长的字符串数组，空单元格为 `''`。 */
    readonly rows: readonly (readonly string[])[];
}
/**
 * 读取工作簿里的所有工作表。
 *
 * @param zip `readZip` 的结果。
 * @throws 缺少 `xl/workbook.xml` 时抛出明确的 Error。
 */
export declare function readXlsxSheets(zip: Map<string, ZipEntryData>): SheetData[];
/**
 * 生成最小但合法的单工作表 XLSX（STORED ZIP，纯 ASCII 字节）。
 *
 * 单元格用内联字符串，因此不需要 `xl/sharedStrings.xml`；
 * `[Content_Types].xml` 与 `xl/_rels/workbook.xml.rels` 里的部件一致。
 */
export declare function buildXlsx(input: {
    readonly sheetName?: string;
    readonly rows: readonly (readonly unknown[])[];
}): Uint8Array;
