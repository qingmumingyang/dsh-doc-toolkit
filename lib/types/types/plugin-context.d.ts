import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/**
 * 本插件实际用到的宿主 Context 最小结构。
 *
 * 说明：`@deepseek-ai/cordis` 的 npm 类型在当前 TS 版本下接口合并失效
 * （Context 接口成员不可见），而 `ctx.tools`/`ctx.skills`/`ctx.fs`/`ctx.logger`/`ctx.inject`
 * 在运行时都真实存在（官方插件 `dsh-tool-fs` 等均直接使用）。
 * 因此这里按运行时事实声明一个结构类型，避免依赖宿主的 .d.ts。
 */
export interface RuntimeSkillInput {
    name: string;
    description: string;
    content: string;
    whenToUse?: string;
    /** 必填字符串：dsh-skill 的加载校验要求 source 存在 */
    source?: string;
    path?: string;
    invocation?: {
        modelInvocable?: boolean;
        userInvocable?: boolean;
    };
}
/** `ctx.fs.resolve()` 产出的稳定目标：不透明 key + 面向模型/UI 的展示路径。 */
export interface FsTarget {
    targetKey: string;
    displayPath: string;
}
/** `ctx.fs.stat()` 的元数据（本插件只用到类型与字节数）。 */
export interface FsInfo {
    version: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
}
/**
 * 写意图：`createIfAbsent` 拒绝覆盖已存在目标，`replaceIfVersion` 拒绝版本不符。
 * 省略即无条件创建或覆盖（本插件的工具明确声明会覆盖）。
 */
export type FsWriteIntent = {
    kind: 'createIfAbsent';
} | {
    kind: 'replaceIfVersion';
    version: string;
};
/**
 * 官方文件系统服务（`@deepseek-ai/dsh-fs`）中本插件用到的最小结构。
 *
 * 为什么全部走这里而不是 `node:fs`：DSH STORE 的固定源自动策略把运行源码里任何
 * `node:fs` 使用记为 `files` 权限信号，任何这类信号都会让条目无法进入可安装状态；
 * 更重要的是，`ctx.fs` 是宿主的能力边界——读写都要经过会话沙箱策略。
 */
export interface FsService {
    /** 后端的默认沙箱模式；`undefined` 表示该后端不限制变更。 */
    sandboxMode?: string;
    resolve(path: string, opts?: {
        cwd?: string;
        signal?: AbortSignal;
    }): Promise<FsTarget>;
    /** 后端执行世界里的绝对路径（本地后端即宿主路径）。 */
    processPath(target: FsTarget): string;
    /** 规范化包含性判断（不解析 targetKey）。 */
    contains(parent: FsTarget, child: FsTarget): boolean;
    stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
    /** 读取原始字节（PDF/DOCX/XLSX 都是二进制，文本 API 不适用）。 */
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
    /** 原子写文本；父目录按需创建。生成物必须是纯 ASCII 才能字节保真落盘。 */
    writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<unknown>;
}
/** 会话沙箱策略服务（`@deepseek-ai/dsh-sandbox-policy`）的最小结构。 */
export interface SandboxPolicyService {
    resolve(request?: {
        session?: unknown;
    }): unknown;
}
export interface PluginContext {
    /** 工具注册表（@deepseek-ai/dsh-tools 服务）。 */
    tools: {
        register(definition: ToolDefinition): () => void;
    };
    /** 文件系统服务（@deepseek-ai/dsh-fs，由 fs-local 或 fs-sandbox 后端提供）。 */
    fs: FsService;
    /** skill 注册表（@deepseek-ai/dsh-skill 服务，可选）。 */
    skills: {
        register(skill: RuntimeSkillInput): () => void;
    };
    /** 日志服务：直接可调用的 logger 对象（官方插件用法）。 */
    logger: {
        info(message?: unknown, ...args: unknown[]): void;
        warn(message?: unknown, ...args: unknown[]): void;
        error(message?: unknown, ...args: unknown[]): void;
        debug(message?: unknown, ...args: unknown[]): void;
    };
    /** 可选服务注入：services 就绪后调用 callback，否则静默跳过。 */
    inject(services: string[], callback: (ctx: PluginContext) => void): void;
    /** 按名取服务（Cordis Context.get）。沙箱策略等服务用它按需获取。 */
    get?(name: string): unknown;
}
