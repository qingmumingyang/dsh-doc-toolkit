/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320)。
 *
 * 纯计算模块：只接收/返回字节与数字，不做任何输入输出。
 * 这里是 ZIP 里每个条目 required 的校验值：本地文件头与中央目录都要填。
 */
/** 反射多项式 0xEDB88320 对应的查表（按需构建，构建一次后缓存）。 */
let table;
/** 构建 256 项 CRC-32 查表。 */
function buildTable() {
    const next = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            // 最低位为 1 时右移一位再异或多项式，否则只右移。
            value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
        next[index] = value >>> 0;
    }
    return next;
}
/**
 * 计算字节序列的 CRC-32，返回无符号 32 位整数。
 *
 * 空输入返回 0（标准 CRC-32 的初始值取反结果）。
 */
export function crc32(bytes) {
    return crcFinish(crcState(bytes));
}
/**
 * 折叠一个字节到**未取反**的中间状态。
 *
 * 为什么暴露中间状态：ASCII 安全 ZIP 写入器要在补白搜索里每步只折叠一个字节
 * （补白字节是换行），这样每次试探是常数时间，而不是重算整段内容。搜索结束后
 * 用 {@link crcFinish} 得到最终校验值。
 */
export function crcFold(state, byte) {
    if (table === undefined)
        table = buildTable();
    return ((state >>> 8) ^ table[(state ^ byte) & 0xff]) >>> 0;
}
/** 计算整段字节的**未取反**中间状态（搜索起点）。 */
export function crcState(bytes) {
    let state = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) {
        state = crcFold(state, bytes[index]);
    }
    return state;
}
/** 把中间状态收尾成最终 CRC-32 值。 */
export function crcFinish(state) {
    return (state ^ 0xffffffff) >>> 0;
}
