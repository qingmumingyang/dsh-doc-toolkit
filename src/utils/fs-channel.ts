import path from 'node:path'
import type { FsTarget, PluginContext, SandboxPolicyService } from '../types/plugin-context.js'

/**
 * 文件访问通道：本插件所有读写都必须经过宿主的 `ctx.fs` 服务。
 *
 * 为什么不用 `node:fs`（两个理由，缺一不可）：
 * 1. **能力边界** —— `ctx.fs` 是宿主的能力入口，写会经过会话沙箱策略
 *    （`fs-sandbox` 在 `workspace-write` 下只放行工作区与临时目录），读保持不设限；
 *    直接用 `node:fs` 会绕过这道围栏，等于插件自带一条越权路径。
 * 2. **可安装性** —— DSH STORE 的固定源自动策略把运行源码里任何 `node:fs` 使用记为
 *    `files` 权限信号，带该信号的条目无法进入可安装（`approved`）状态。
 *
 * 一个必须记住的约束：`ctx.fs` 只提供 `readText`/`writeText` 文本 API（二进制只能读
 * `readBytes`，没有写字节的接口）。因此**生成物必须是纯 ASCII**：DOCX/XLSX 用纯 ASCII 的
 * 存储式 ZIP，PDF 把内嵌字体流编码为 ASCIIHexDecode。这样 UTF-8 文本写入与原始字节
 * 完全一致。
 */

/** 单次读取的字节上限，避免把超大文件整块读进内存。 */
export const MAX_READ_BYTES = 64 * 1024 * 1024

/** 已解析的文档目标。 */
export interface DocumentTarget {
  /** 后端稳定目标，后续所有操作都用它。 */
  target: FsTarget
  /** 后端执行世界里的绝对路径（本地后端即宿主路径）：用于扩展名判断与结果文本。 */
  absolute: string
  /** 面向模型与结果文本的路径：在工作区内时相对化，否则用绝对路径。 */
  display: string
  /** 当前会话工作区根（可能为空：无会话时由后端默认 cwd 兜底）。 */
  workspaceRoot?: string
}

/**
 * 从工具执行上下文读取会话工作区。
 *
 * 结构是运行时事实（`agent.session.header.cwd`），这里按结构取而不是 import
 * `@deepseek-ai/dsh-agent` 的类型，避免把宿主包变成编译期依赖。
 */
export function sessionCwd(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 取当前调用该使用的会话对象（沙箱策略按会话解析模式）。 */
function sessionOf(exec: unknown): unknown {
  return (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session
}

/**
 * 解析本次写入应使用的沙箱策略，与官方 fs 工具的做法一致：
 * 后端不限制（`sandboxMode` 为 undefined）时不传；否则向共享的 `sandboxPolicy`
 * 服务询问调用会话的有效模式，让围栏按会话而不是按部属默认值生效。
 */
function resolveWritePolicy(ctx: PluginContext, exec: unknown): unknown {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const service = typeof ctx.get === 'function' ? (ctx.get('sandboxPolicy') as SandboxPolicyService | undefined) : undefined
  if (service === undefined || service === null) return undefined
  if (typeof service.resolve !== 'function') return undefined
  const session = sessionOf(exec)
  return service.resolve(session === undefined ? {} : { session })
}

/** 把执行世界里的绝对路径渲染成对模型更友好的显示路径。 */
function displayPathOf(root: string | undefined, absolute: string): string {
  if (root === undefined) return absolute
  const rel = path.relative(root, absolute)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absolute
}

/**
 * 把一个模型给的路径解析为后端目标。
 *
 * 相对路径按会话工作区解析（与官方 fs 工具一致）；绝对路径原样交给后端，
 * 由后端决定读授权。无会话 cwd 时退回后端默认基准目录。
 */
export async function resolveDocumentTarget(
  ctx: PluginContext,
  exec: unknown,
  rawPath: string,
  signal?: AbortSignal
): Promise<DocumentTarget> {
  const input = typeof rawPath === 'string' ? rawPath : String(rawPath ?? '')
  if (input.trim().length === 0) throw new Error('file_path 不能为空')
  const workspaceRoot = sessionCwd(exec)
  const target = await ctx.fs.resolve(input, workspaceRoot === undefined ? { signal } : { cwd: workspaceRoot, signal })
  const absolute = ctx.fs.processPath(target)
  return { target, absolute, display: displayPathOf(workspaceRoot, absolute), workspaceRoot }
}

/** 读取目标文件的原始字节，按上限截断前先拒绝超限文件。 */
export async function readTargetBytes(
  ctx: PluginContext,
  target: DocumentTarget,
  signal: AbortSignal | undefined,
  maxBytes: number = MAX_READ_BYTES
): Promise<Uint8Array> {
  const info = await ctx.fs.stat(target.target, signal)
  if (info === undefined) throw new Error('文件不存在')
  if (info.type !== 'file') throw new Error('目标不是普通文件')
  if (typeof info.size === 'number' && info.size > maxBytes) {
    throw new Error(`文件为 ${info.size} 字节，超过单次读取上限 ${maxBytes} 字节`)
  }
  const bytes = await ctx.fs.readBytes(target.target, signal, maxBytes)
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBufferLike)
}

/** 目标是否存在且为普通文件（用于读取前的友好报错）。 */
export async function targetExists(
  ctx: PluginContext,
  target: DocumentTarget,
  signal?: AbortSignal
): Promise<boolean> {
  const info = await ctx.fs.stat(target.target, signal)
  return info !== undefined && info.type === 'file'
}

/**
 * 写出纯 ASCII 文本；父目录由后端按需创建。
 *
 * 调用方必须保证 `content` 只含 ASCII 字符——UTF-8 编码下 ASCII 与原始字节一一对应，
 * 这也是二进制产物能经文本通道字节保真落盘的前提。
 */
export async function writeTargetText(
  ctx: PluginContext,
  exec: unknown,
  target: DocumentTarget,
  content: string,
  signal?: AbortSignal
): Promise<void> {
  const policy = resolveWritePolicy(ctx, exec)
  await ctx.fs.writeText(target.target, content, undefined, signal, policy)
}

/** 由原始字节构造纯 ASCII 文本（用于把生成物交给 writeText）。 */
export function bytesToAsciiText(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]
    if (byte > 0x7f) throw new Error(`生成物第 ${i} 字节为 0x${byte.toString(16)}，不是纯 ASCII，无法经文本通道写出`)
    out += String.fromCharCode(byte)
  }
  return out
}

/**
 * 把后端错误转成一句对模型有用的话。
 *
 * 沙箱拒绝是可恢复的：模型改到工作区内写、或让用户放宽会话模式即可。原始错误消息
 * 已带模式和升级提示，这里只补一句本插件的落点说明。
 */
export function describeWriteFailure(error: unknown, display: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/FS_SANDBOX_DENIED|sandbox/i.test(message)) {
    return `写入被会话沙箱拒绝：${message}。目标: ${display}（workspace-write 模式下只能写工作区内或临时目录）`
  }
  return message
}
