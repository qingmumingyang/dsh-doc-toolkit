import type { FsTarget, PluginContext } from '../types/plugin-context.js';
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
export declare const MAX_READ_BYTES: number;
/** 已解析的文档目标。 */
export interface DocumentTarget {
    /** 后端稳定目标，后续所有操作都用它。 */
    target: FsTarget;
    /** 后端执行世界里的绝对路径（本地后端即宿主路径）：用于扩展名判断与结果文本。 */
    absolute: string;
    /** 面向模型与结果文本的路径：在工作区内时相对化，否则用绝对路径。 */
    display: string;
    /** 当前会话工作区根（可能为空：无会话时由后端默认 cwd 兜底）。 */
    workspaceRoot?: string;
}
/**
 * 从工具执行上下文读取会话工作区。
 *
 * 结构是运行时事实（`agent.session.header.cwd`），这里按结构取而不是 import
 * `@deepseek-ai/dsh-agent` 的类型，避免把宿主包变成编译期依赖。
 */
export declare function sessionCwd(exec: unknown): string | undefined;
/**
 * 把一个模型给的路径解析为后端目标。
 *
 * 相对路径按会话工作区解析（与官方 fs 工具一致）；绝对路径原样交给后端，
 * 由后端决定读授权。无会话 cwd 时退回后端默认基准目录。
 */
export declare function resolveDocumentTarget(ctx: PluginContext, exec: unknown, rawPath: string, signal?: AbortSignal): Promise<DocumentTarget>;
/** 读取目标文件的原始字节，按上限截断前先拒绝超限文件。 */
export declare function readTargetBytes(ctx: PluginContext, target: DocumentTarget, signal: AbortSignal | undefined, maxBytes?: number): Promise<Uint8Array>;
/** 目标是否存在且为普通文件（用于读取前的友好报错）。 */
export declare function targetExists(ctx: PluginContext, target: DocumentTarget, signal?: AbortSignal): Promise<boolean>;
/**
 * 写出纯 ASCII 文本；父目录由后端按需创建。
 *
 * 调用方必须保证 `content` 只含 ASCII 字符——UTF-8 编码下 ASCII 与原始字节一一对应，
 * 这也是二进制产物能经文本通道字节保真落盘的前提。
 */
export declare function writeTargetText(ctx: PluginContext, exec: unknown, target: DocumentTarget, content: string, signal?: AbortSignal): Promise<void>;
/** 由原始字节构造纯 ASCII 文本（用于把生成物交给 writeText）。 */
export declare function bytesToAsciiText(bytes: Uint8Array): string;
/**
 * 把后端错误转成一句对模型有用的话。
 *
 * 沙箱拒绝是可恢复的：模型改到工作区内写、或让用户放宽会话模式即可。原始错误消息
 * 已带模式和升级提示，这里只补一句本插件的落点说明。
 */
export declare function describeWriteFailure(error: unknown, display: string): string;
