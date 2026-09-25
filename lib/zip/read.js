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
import { inflateRawSync } from 'node:zlib';
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
/** EOCD 注释长度是 16 位，所以 EOCD 起点最多往回找这么多字节。 */
const MAX_COMMENT_LENGTH = 0xffff;
/** 小端读取 16 位无符号整数；调用方保证偏移已做边界检查。 */
function getUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}
/** 小端读取 32 位无符号整数（无符号右移保证结果非负）。 */
function getUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
/** 把条目名原始字节还原成字符串（ZIP 名字按 ASCII/Latin-1 处理）。 */
function nameFromBytes(bytes, start, length) {
    let out = '';
    for (let index = 0; index < length; index++)
        out += String.fromCharCode(bytes[start + index]);
    return out;
}
/** 校验区间 [start, start+length) 落在缓冲区内。 */
function assertRange(bytes, start, length, what) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > bytes.length) {
        throw new Error(`ZIP 结构损坏：${what} 超出数据范围（起始 ${start}，长度 ${length}，总长 ${bytes.length}）`);
    }
}
/** 从尾部反向定位 EOCD：返回其偏移，找不到抛错。 */
function findEndRecord(bytes) {
    if (bytes.length < END_RECORD_SIZE) {
        throw new Error(`ZIP 结构损坏：数据只有 ${bytes.length} 字节，不足以容纳 EOCD 记录`);
    }
    const lowest = Math.max(0, bytes.length - END_RECORD_SIZE - MAX_COMMENT_LENGTH);
    for (let offset = bytes.length - END_RECORD_SIZE; offset >= lowest; offset--) {
        if (getUint32(bytes, offset) !== END_SIGNATURE)
            continue;
        const commentLength = getUint16(bytes, offset + 20);
        // 注释长度必须正好铺满剩余字节，否则只是数据里碰巧出现的同名字节串。
        if (offset + END_RECORD_SIZE + commentLength === bytes.length)
            return offset;
    }
    throw new Error('ZIP 结构损坏：找不到中央目录结束记录（EOCD）');
}
/**
 * 读取 ZIP，返回「条目名 -> 内容」的表（保持包内顺序）。
 *
 * 目录条目（名字以 `/` 结尾）会被跳过；加密条目、未知压缩方法、
 * 结构损坏、超出上限都会抛 Error。
 */
export function readZip(bytes, limits) {
    if (!(bytes instanceof Uint8Array))
        throw new Error('readZip 需要 Uint8Array 输入');
    const maxEntries = limits?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxEntryBytes = limits?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const end = findEndRecord(bytes);
    const diskNumber = getUint16(bytes, end + 4);
    const centralDisk = getUint16(bytes, end + 6);
    const entriesOnDisk = getUint16(bytes, end + 8);
    const entriesTotal = getUint16(bytes, end + 10);
    const centralSize = getUint32(bytes, end + 12);
    const centralOffset = getUint32(bytes, end + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal) {
        throw new Error('ZIP 不支持分卷（多磁盘）包');
    }
    if (entriesTotal === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
        throw new Error('ZIP 看起来是 ZIP64 格式，本实现不支持 ZIP64');
    }
    if (entriesTotal > maxEntries) {
        throw new Error(`ZIP 条目数 ${entriesTotal} 超过上限 ${maxEntries}`);
    }
    assertRange(bytes, centralOffset, centralSize, '中央目录');
    // 中央目录必须完全落在 EOCD 之前。
    if (centralOffset + centralSize > end) {
        throw new Error('ZIP 结构损坏：中央目录与 EOCD 记录重叠');
    }
    const result = new Map();
    let cursor = centralOffset;
    let totalBytes = 0;
    for (let index = 0; index < entriesTotal; index++) {
        assertRange(bytes, cursor, CENTRAL_HEADER_SIZE, `第 ${index} 个中央目录条目头`);
        if (getUint32(bytes, cursor) !== CENTRAL_SIGNATURE) {
            throw new Error(`ZIP 结构损坏：第 ${index} 个中央目录条目的签名不对`);
        }
        const flags = getUint16(bytes, cursor + 8);
        const method = getUint16(bytes, cursor + 10);
        const compressedSize = getUint32(bytes, cursor + 20);
        const uncompressedSize = getUint32(bytes, cursor + 24);
        const nameLength = getUint16(bytes, cursor + 28);
        const extraLength = getUint16(bytes, cursor + 30);
        const commentLength = getUint16(bytes, cursor + 32);
        const localOffset = getUint32(bytes, cursor + 42);
        const variableLength = nameLength + extraLength + commentLength;
        assertRange(bytes, cursor + CENTRAL_HEADER_SIZE, variableLength, `第 ${index} 个中央目录条目变长字段`);
        const name = nameFromBytes(bytes, cursor + CENTRAL_HEADER_SIZE, nameLength);
        cursor += CENTRAL_HEADER_SIZE + variableLength;
        if ((flags & 0x0001) !== 0)
            throw new Error(`ZIP 条目 ${JSON.stringify(name)} 已加密，不支持读取`);
        if (uncompressedSize > maxEntryBytes) {
            throw new Error(`ZIP 条目 ${JSON.stringify(name)} 解压后 ${uncompressedSize} 字节，超过单条上限 ${maxEntryBytes}`);
        }
        if (totalBytes + uncompressedSize > maxTotalBytes) {
            throw new Error(`ZIP 条目 ${JSON.stringify(name)} 会使总大小超过上限 ${maxTotalBytes}`);
        }
        // 本地文件头：定位数据起点（大小/CRC 以中央目录为准）。
        assertRange(bytes, localOffset, LOCAL_HEADER_SIZE, `条目 ${JSON.stringify(name)} 的本地文件头`);
        if (getUint32(bytes, localOffset) !== LOCAL_SIGNATURE) {
            throw new Error(`ZIP 结构损坏：条目 ${JSON.stringify(name)} 的本地文件头签名不对`);
        }
        const localNameLength = getUint16(bytes, localOffset + 26);
        const localExtraLength = getUint16(bytes, localOffset + 28);
        const dataStart = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
        assertRange(bytes, dataStart, compressedSize, `条目 ${JSON.stringify(name)} 的数据`);
        // 目录条目没有内容，跳过（但仍要走到这里以推进 cursor）。
        if (!name.endsWith('/')) {
            const raw = bytes.subarray(dataStart, dataStart + compressedSize);
            let data;
            if (method === METHOD_STORED) {
                if (compressedSize !== uncompressedSize) {
                    // 少数工具会把 STORED 的大小写成不一致；以中央目录的原始大小为准做校验。
                    throw new Error(`ZIP 条目 ${JSON.stringify(name)} 声明为 STORED 但压缩前后大小不一致`);
                }
                data = raw.slice();
            }
            else if (method === METHOD_DEFLATE) {
                // 声明长度为 0 的条目：zlib 不接受 maxOutputLength=0，直接给出空结果。
                data = uncompressedSize === 0 ? new Uint8Array(0) : inflateEntry(name, raw, uncompressedSize, maxEntryBytes);
            }
            else {
                throw new Error(`ZIP 条目 ${JSON.stringify(name)} 使用了不支持的压缩方法 ${method}（仅支持 0=STORED、8=DEFLATE）`);
            }
            result.set(name, { name, bytes: data });
            totalBytes += uncompressedSize;
        }
        else {
            totalBytes += uncompressedSize;
        }
    }
    return result;
}
/**
 * 解压一个 DEFLATE 条目。
 *
 * 传入 maxOutputLength 把解压输出卡在「中央目录声明的大小」上，
 * 这样即使遇到解压炸弹也只会抛错，不会把内存吃光。
 */
function inflateEntry(name, raw, uncompressedSize, maxEntryBytes) {
    const cap = Math.min(uncompressedSize, maxEntryBytes);
    let output;
    try {
        output = inflateRawSync(raw, { maxOutputLength: cap });
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`ZIP 条目 ${JSON.stringify(name)} 解压失败：${detail}`);
    }
    if (uncompressedSize > 0 && output.length !== uncompressedSize) {
        throw new Error(`ZIP 条目 ${JSON.stringify(name)} 解压后大小 ${output.length} 与声明的 ${uncompressedSize} 不一致`);
    }
    if (output.length > maxEntryBytes) {
        throw new Error(`ZIP 条目 ${JSON.stringify(name)} 解压后 ${output.length} 字节，超过单条上限 ${maxEntryBytes}`);
    }
    return new Uint8Array(output.buffer.slice(output.byteOffset, output.byteOffset + output.length));
}
