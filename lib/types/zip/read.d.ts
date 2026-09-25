/**
 * 极简 ZIP 读取器：解析中央目录，支持 STORED（0）与 DEFLATE（8）两种方法。
 *
 * 设计要点：
 * - 纯计算模块，不做任何输入输出；输入是字节，输出是「名字 -> 字节」的表。
 * - 从尾部反向扫描 EOCD（容忍尾部注释），再走中央目录；本地文件头只用于定位，
 *   大小/CRC 一律以中央目录为准（数据描述符位的条目也能正确读取）。
 * - 所有偏移在读取前都做边界检查，越界一律抛清晰的 Error，绝不越界读。
 * - 防御性上限（条目数 / 单条大小 / 总大小 / 解压输出）可配置，避免解压炸弹。
 */
/** 一个解出来的 ZIP 条目。 */
export interface ZipEntryData {
    /** 条目名（路径），原始字节按 ASCII/Latin-1 还原成字符串。 */
    readonly name: string;
    /** 条目内容（已解压）。 */
    readonly bytes: Uint8Array;
}
/** 读取时的防御性上限。 */
export interface ZipReadLimits {
    /** 最多接受多少个条目（默认 512）。 */
    readonly maxEntries?: number;
    /** 单个条目解压后最多多少字节（默认 64 MiB）。 */
    readonly maxEntryBytes?: number;
    /** 所有条目解压后合计最多多少字节（默认 256 MiB）。 */
    readonly maxTotalBytes?: number;
}
/**
 * 读取 ZIP，返回「条目名 -> 内容」的表（保持包内顺序）。
 *
 * 目录条目（名字以 `/` 结尾）会被跳过；加密条目、未知压缩方法、
 * 结构损坏、超出上限都会抛 Error。
 */
export declare function readZip(bytes: Uint8Array, limits?: ZipReadLimits): Map<string, ZipEntryData>;
