/**
 * 纯 ASCII 的 STORED ZIP 写入器。
 *
 * ## 为什么必须纯 ASCII
 *
 * 插件的全部写入都经宿主的 `ctx.fs.writeText`——它**只有文本写入 API**，没有写字节的
 * 接口。UTF-8 编码对 ASCII 是恒等映射，所以只要产物每个字节都 <= 0x7F，经文本通道落盘
 * 就与原始字节完全一致。ZIP 的结构字段（长度、CRC-32、偏移）是二进制，默认会产生
 * >= 0x80 的字节，因此需要下面的"字段安全"排布。
 *
 * ## 算法
 *
 * 条目全部 STORED（方法 0，不压缩）且**连续排布**（本地条目之间不留空隙——OPC 的严格
 * 读取器，如 Microsoft Word/Excel，要求连续）。对每个条目按顺序搜索一个补白长度 `pad`
 * （在部件内容后追加换行；XML 根元素之后的空白合法且语义无害），使其同时满足：
 *
 * 1. 长度字段（压缩大小 = 原始大小）字段安全；
 * 2. CRC-32 字段安全；
 * 3. 下一个条目的本地头偏移能用**合法的本地扩展字段**推到安全区（偏移与长度低字节在
 *    0x80 处耦合，单纯补白可能无法同时满足，所以需要第二个自由度）。
 *
 * 字段安全 = 该 32 位小端字段的四个字节都 <= 0x7F。CRC 搜索用滚动状态（每步只折叠一个
 * 换行字节），所以每个条目的搜索是 O(补白步数) 而不是 O(补白步数 × 内容长度)。
 * 命中率约 (128/256)^4 = 1/16，实际几十步内命中。
 *
 * 中央目录大小同样是 32 位字段，用最后一条的**中央扩展字段**微调（不影响任何本地偏移），
 * 使整个文件保持纯 ASCII。
 *
 * 纯计算模块：不读文件、不读环境变量、不依赖时钟；相同输入产生完全相同的字节。
 */

import { crcFinish, crcFold, crcState } from './crc32.js'

/** 一个待写入的 ZIP 条目。 */
export interface ZipEntryInput {
  /** 条目名（包内路径），必须是纯 ASCII。 */
  readonly name: string
  /** 条目内容，原样存储（不压缩），必须是纯 ASCII 字节。 */
  readonly data: Uint8Array
}

/** 经典 ZIP 的条目数上限（未实现 ZIP64）。 */
const MAX_ENTRIES = 0xffff
/** 32 位字段上限。 */
const MAX_UINT32 = 0xffffffff
/** 单个条目的补白搜索上限。命中率约 1/16，这个上限远大于实际需要。 */
const MAX_PAD = 0x10000
/** 本地扩展字段的允许总长（0 = 不写；否则必须是合法记录，即 >= 4 字节）。 */
const MIN_EXTRA = 4
const MAX_LOCAL_EXTRA = 127

/** 结构常量。 */
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_OF_CENTRAL_BYTES = 22

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const METHOD_STORED = 0
const VERSION = 20

/**
 * 固定的 DOS 时间/日期：两个小端字节都必须 <= 0x7F。
 * 日期 2026-01-01 → `((2026 - 1980) << 9) | (1 << 5) | 1` = 0x5C21（字节 0x21 0x5C）。
 */
const DOS_TIME = 0x0000
const DOS_DATE = 0x5c21

/** 补白字节：换行。 */
const PAD_BYTE = 0x0a

/** 一个 32 位字段是否"字段安全"：四个小端字节都 <= 0x7F。 */
function safeField(value: number): boolean {
  return value >= 0 && value <= 0x7f7f7f7f
    && (value & 0xff) <= 0x7f
    && ((value >>> 8) & 0xff) <= 0x7f
    && ((value >>> 16) & 0xff) <= 0x7f
    && ((value >>> 24) & 0xff) <= 0x7f
}

/** 一个 16 位字段是否字段安全（两个小端字节都 <= 0x7F）。 */
function safeWord(value: number): boolean {
  return value >= 0 && value <= 0x7f7f && (value & 0xff) <= 0x7f && ((value >>> 8) & 0xff) <= 0x7f
}

/** 小端 16 位 → 两个 ASCII 码元。 */
function word(value: number): string {
  return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff)
}

/** 小端 32 位 → 四个 ASCII 码元。 */
function dword(value: number): string {
  return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

/** 一个合法扩展字段的字节：header id + data size + NUL 填充。`total` 必须为 0 或 >= 4。 */
function extraField(total: number): string {
  if (total === 0) return ''
  return word(0) + word(total - MIN_EXTRA) + '\u0000'.repeat(total - MIN_EXTRA)
}

/**
 * 让某个偏移落进安全区所需的最小**合法**本地扩展字段长度：已经是安全偏移时返回 0，
 * 否则返回第一个使 `end + total` 安全的 `total`（4..127）。找不到时返回 undefined。
 *
 * 注意这里必须写入合法的扩展记录而不是裸填充——严格读取器会拒绝结构非法的扩展字段。
 */
function feasibleLocalExtra(end: number): number | undefined {
  if (safeField(end)) return 0
  for (let total = MIN_EXTRA; total <= MAX_LOCAL_EXTRA; total += 1) {
    if (safeField(end + total)) return total
  }
  return undefined
}

/**
 * 让中央目录大小落进安全区所需的最小合法中央扩展字段长度。
 *
 * 与本地扩展字段同理，但多一个约束：**扩展字段自己的两个长度字段**（总长与数据长度）
 * 也必须是字段安全的 u16，否则它们自己就会写出 >= 0x80 的字节。
 *
 * 单个扩展字段并不总能解决问题：当中央目录大小的**低字节恰好是 0x80** 时，把它抬进安全区
 * 需要加上 0x80..0xFF，而这个区间的长度字段本身就不安全（低字节 >= 0x80）。因此还需要
 * 第二个可调项——见 {@link tuneCentralDirectory}。
 */
function feasibleCentralExtra(base: number): number | undefined {
  if (safeField(base)) return 0
  for (const candidate of centralExtraCandidates()) {
    if (candidate !== 0 && safeField(base + candidate)) return candidate
  }
  return undefined
}

/**
 * 用于收敛中央目录大小的候选长度：0、4..127，以及 0xNN04 家族。
 *
 * 0xNN04（NN = 1..0x7F）是能同时满足「总长字段安全」与「数据长度字段（总长 - 4）安全」的
 * 大长度：字节形如 `04 NN`，而总长 - 4 形如 `00 NN`。两个这样的长度相加可以跨过 0x80
 * 边界，从而覆盖单值无法到达的安全区间。
 */
function centralExtraCandidates(): number[] {
  const list: number[] = [0]
  for (let value = MIN_EXTRA; value <= MAX_LOCAL_EXTRA; value += 1) list.push(value)
  for (let high = 1; high <= 0x7f; high += 1) {
    const value = (high << 8) | MIN_EXTRA
    if (safeWord(value) && safeWord(value - MIN_EXTRA)) list.push(value)
  }
  return list
}

/** 中央目录末尾的可选数字签名记录：签名(4) + 数据长度(2) + 数据。 */
const SIGNATURE_RECORD = 0x05054b50
const SIGNATURE_RECORD_BYTES = 6

/** 中央目录大小的调整方案。 */
interface CentralTuning {
  /** 最后一条的中央扩展字段长度。 */
  readonly lastExtra: number
  /** 倒数第二条的中央扩展字段长度（单条目归档时为 0）。 */
  readonly secondLastExtra: number
  /** 数字签名记录的数据长度（0 = 不写该记录）。 */
  readonly signatureData: number
}

/**
 * 把中央目录大小收敛到字段安全区间。
 *
 * 依次尝试三种方案（都保持 ZIP 结构合法）：
 * 1. 只给最后一条加中央扩展字段；
 * 2. 最后两条各加一个中央扩展字段——两个字段安全长度之和可以跨过 0x80 边界，
 *    覆盖方案 1 到不了的区间；
 * 3. 仅当归档只有一条时：再用中央目录末尾的**数字签名记录**作为第二个可调项
 *    （它合法且被读取器忽略，但会计入中央目录大小）。真实归档都有 5 个以上条目，
 *    因此方案 3 只在极端情况下生效。
 */
function tuneCentralDirectory(planned: readonly PlannedEntry[]): CentralTuning {
  const base = centralDirectorySize(planned)
  if (safeField(base)) return { lastExtra: 0, secondLastExtra: 0, signatureData: 0 }

  const candidates = centralExtraCandidates()
  for (const first of candidates) {
    if (safeField(base + first)) return { lastExtra: first, secondLastExtra: 0, signatureData: 0 }
  }

  if (planned.length >= 2) {
    for (const first of candidates) {
      for (const second of candidates) {
        if (safeField(base + first + second)) {
          return { lastExtra: first, secondLastExtra: second, signatureData: 0 }
        }
      }
    }
  }

  for (const first of candidates) {
    for (const dataSize of candidates) {
      if (safeField(base + first + SIGNATURE_RECORD_BYTES + dataSize)) {
        return { lastExtra: first, secondLastExtra: 0, signatureData: dataSize }
      }
    }
  }

  throw new Error(`无法把 ZIP 中央目录大小（${base} = 0x${base.toString(16)}）调整到 ASCII 安全区`)
}

/** 判断字节是否全为 ASCII。 */
function assertAsciiBytes(data: Uint8Array, what: string): void {
  for (let index = 0; index < data.length; index += 1) {
    if (data[index]! > 0x7f) {
      throw new Error(`${what} 的第 ${index} 字节为 0x${data[index]!.toString(16)}，不是 ASCII；调用方必须先编码为 ASCII（例如 XML 数字字符引用）`)
    }
  }
}

/** 已排布好的条目。 */
interface PlannedEntry {
  readonly name: string
  readonly data: Uint8Array
  readonly crc: number
  /** 写入长度字段的值（= 内容 + 补白）。 */
  readonly length: number
  /** 补白字节数。 */
  readonly pad: number
  /** 本地头偏移（该值会写进中央目录，必须字段安全）。 */
  readonly localOffset: number
  /** 本地扩展字段长度。 */
  readonly localExtra: number
  /** 中央扩展字段长度（仅用于收敛中央目录大小）。 */
  centralExtra: number
}

/** 排布结果：条目 + 中央目录末尾数字签名记录的数据长度（0 = 不写该记录）。 */
interface PlannedArchive {
  readonly entries: PlannedEntry[]
  readonly signatureData: number
}

/** 逐条排布：确定补白与本地扩展字段，使长度/CRC/下一个偏移都字段安全。 */
function planEntries(entries: readonly ZipEntryInput[]): PlannedArchive {
  const planned: PlannedEntry[] = []
  let offset = 0
  let signatureData = 0

  for (const entry of entries) {
    if (entry.name.length === 0) throw new Error('ZIP 条目名不能为空')
    assertAsciiBytes(Uint8Array.from(entry.name, (ch) => ch.charCodeAt(0)), `ZIP 条目名 ${JSON.stringify(entry.name)}`)
    if (!safeWord(entry.name.length)) throw new Error(`ZIP 条目名过长：${entry.name.length}`)
    assertAsciiBytes(entry.data, `ZIP 条目 ${JSON.stringify(entry.name)} 的内容`)

    const nameLength = entry.name.length
    const baseLength = entry.data.length
    // 不写扩展字段时该条目之后的最小偏移（含本地头与名字）。
    const minEnd = offset + LOCAL_HEADER_BYTES + nameLength + baseLength

    let state = crcState(entry.data)
    let chosen: { pad: number; crc: number; extra: number } | undefined
    for (let pad = 0; pad <= MAX_PAD; pad += 1) {
      if (pad > 0) state = crcFold(state, PAD_BYTE)
      const length = baseLength + pad
      if (!safeField(length)) continue
      const crc = crcFinish(state)
      if (!safeField(crc)) continue
      const extra = feasibleLocalExtra(minEnd + pad)
      if (extra === undefined) continue
      chosen = { pad, crc, extra }
      break
    }
    if (chosen === undefined) {
      throw new Error(`ZIP 条目 ${JSON.stringify(entry.name)}：在 ${MAX_PAD} 次补白内找不到 ASCII 安全排布`)
    }

    planned.push({
      name: entry.name,
      data: entry.data,
      crc: chosen.crc,
      length: baseLength + chosen.pad,
      pad: chosen.pad,
      localOffset: offset,
      localExtra: chosen.extra,
      centralExtra: 0
    })
    offset = minEnd + chosen.pad + chosen.extra
  }

  // 中央目录大小本身也是 32 位字段：用中央扩展字段（必要时加数字签名记录）把它收敛到
  // 安全区。中央目录在所有本地条目之后，加长它不会移动任何已确定的本地偏移。
  if (planned.length > 0) {
    const tuning = tuneCentralDirectory(planned)
    if (tuning.lastExtra > 0) planned[planned.length - 1]!.centralExtra = tuning.lastExtra
    if (tuning.secondLastExtra > 0 && planned.length >= 2) {
      planned[planned.length - 2]!.centralExtra = tuning.secondLastExtra
    }
    signatureData = tuning.signatureData
  }

  return { entries: planned, signatureData }
}

/** 中央目录的总字节数（含各条目的扩展字段与可选的数字签名记录）。 */
function centralDirectorySize(entries: readonly PlannedEntry[], signatureData = 0): number {
  let total = 0
  for (const entry of entries) {
    total += CENTRAL_HEADER_BYTES + entry.name.length + entry.centralExtra
  }
  if (signatureData > 0) total += SIGNATURE_RECORD_BYTES + signatureData
  return total
}

/**
 * 生成一个**整包纯 ASCII** 的 STORED ZIP。
 *
 * @param entries 条目（名字与内容都必须是 ASCII；非 ASCII 直接抛错而不是静默写坏文件）
 * @returns 归档字节，每个字节都 <= 0x7F，可安全经 UTF-8 文本通道写出
 */
export function buildStoredZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length === 0) throw new Error('ZIP 至少需要一个条目')
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP 条目数 ${entries.length} 超过上限 ${MAX_ENTRIES}（未实现 ZIP64）`)

  const { entries: planned, signatureData } = planEntries(entries)
  const names = new Set<string>()
  for (const entry of planned) {
    if (names.has(entry.name)) throw new Error(`ZIP 条目名重复：${entry.name}`)
    names.add(entry.name)
  }

  const chunks: Uint8Array[] = []
  // 小段 ASCII 文本（头部字段、名字、扩展字段）转字节；大块内容直接用原字节，
  // 绝不把大数组展开成参数（`String.fromCharCode(...bytes)` 会在几十万字节时爆栈）。
  const ascii = (text: string): Uint8Array => {
    const bytes = new Uint8Array(text.length)
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff
    return bytes
  }
  const newlines = (count: number): Uint8Array => {
    const bytes = new Uint8Array(count)
    bytes.fill(PAD_BYTE)
    return bytes
  }

  // 本地文件头 + 名字 + 本地扩展字段 + 内容 + 补白
  for (const entry of planned) {
    chunks.push(ascii(
      dword(LOCAL_SIGNATURE)
      + word(VERSION)
      + word(0) // 通用位标记：无数据描述符、无 UTF-8 名字标记
      + word(METHOD_STORED)
      + word(DOS_TIME)
      + word(DOS_DATE)
      + dword(entry.crc)
      + dword(entry.length)
      + dword(entry.length)
      + word(entry.name.length)
      + word(entry.localExtra)
      + entry.name
      + extraField(entry.localExtra)
    ))
    chunks.push(entry.data)
    if (entry.pad > 0) chunks.push(newlines(entry.pad))
  }

  // 中央目录
  const directoryOffset = planned.reduce((sum, entry) => {
    return sum + LOCAL_HEADER_BYTES + entry.name.length + entry.localExtra + entry.length
  }, 0)

  for (const entry of planned) {
    chunks.push(ascii(
      dword(CENTRAL_SIGNATURE)
      + word(VERSION) // version made by
      + word(VERSION) // version needed
      + word(0) // 通用位标记
      + word(METHOD_STORED)
      + word(DOS_TIME)
      + word(DOS_DATE)
      + dword(entry.crc)
      + dword(entry.length)
      + dword(entry.length)
      + word(entry.name.length)
      + word(entry.centralExtra)
      + word(0) // 注释长度
      + word(0) // 起始磁盘号
      + word(0) // 内部属性
      + dword(0) // 外部属性
      + dword(entry.localOffset)
      + entry.name
      + extraField(entry.centralExtra)
    ))
  }

  // 可选的中央目录数字签名记录（仅当归档条目太少、单靠扩展字段无法收敛大小时才写）。
  if (signatureData > 0) {
    chunks.push(ascii(dword(SIGNATURE_RECORD) + word(signatureData)))
    chunks.push(new Uint8Array(signatureData))
  }

  // 中央目录结束记录
  const directorySize = centralDirectorySize(planned, signatureData)
  chunks.push(ascii(
    dword(END_SIGNATURE)
    + word(0) // 本磁盘号
    + word(0) // 中央目录起始磁盘号
    + word(planned.length) // 本磁盘条目数
    + word(planned.length) // 条目总数
    + dword(directorySize)
    + dword(directoryOffset)
    + word(0) // 注释长度
  ))

  if (!safeField(directoryOffset)) throw new Error('ZIP 中央目录偏移不是 ASCII 安全值')
  if (!safeField(directorySize)) throw new Error('ZIP 中央目录大小不是 ASCII 安全值')

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  for (let index = 0; index < out.length; index += 1) {
    if (out[index]! > 0x7f) throw new Error(`ZIP 输出第 ${index} 字节不是 ASCII（0x${out[index]!.toString(16)}）`)
  }
  return out
}
