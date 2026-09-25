import type { DocToolkitConfig } from '../types/config.js';
import type { PluginContext } from '../types/plugin-context.js';
/** 生成 DOCX 字节；内容非法时返回中文错误说明。 */
export declare function buildDocxPackage(content: Record<string, unknown>): {
    bytes: Uint8Array;
} | {
    error: string;
};
/** 生成 XLSX 字节；内容非法时返回中文错误说明。 */
export declare function buildXlsxPackage(content: Record<string, unknown>): {
    bytes: Uint8Array;
    sheetName: string;
    rowCount: number;
} | {
    error: string;
};
/** 生成 CSV 文本；内容非法时返回中文错误说明。 */
export declare function buildCsvText(content: Record<string, unknown>): {
    text: string;
    rowCount: number;
} | {
    error: string;
};
export declare function registerWriteTools(ctx: PluginContext, config?: DocToolkitConfig): void;
