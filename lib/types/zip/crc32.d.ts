/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320)。
 *
 * 纯计算模块：只接收/返回字节与数字，不做任何输入输出。
 * 这里是 ZIP 里每个条目 required 的校验值：本地文件头与中央目录都要填。
 */
/**
 * 计算字节序列的 CRC-32，返回无符号 32 位整数。
 *
 * 空输入返回 0（标准 CRC-32 的初始值取反结果）。
 */
export declare function crc32(bytes: Uint8Array): number;
/**
 * 折叠一个字节到**未取反**的中间状态。
 *
 * 为什么暴露中间状态：ASCII 安全 ZIP 写入器要在补白搜索里每步只折叠一个字节
 * （补白字节是换行），这样每次试探是常数时间，而不是重算整段内容。搜索结束后
 * 用 {@link crcFinish} 得到最终校验值。
 */
export declare function crcFold(state: number, byte: number): number;
/** 计算整段字节的**未取反**中间状态（搜索起点）。 */
export declare function crcState(bytes: Uint8Array): number;
/** 把中间状态收尾成最终 CRC-32 值。 */
export declare function crcFinish(state: number): number;
