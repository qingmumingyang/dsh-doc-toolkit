import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * 本插件实际用到的宿主 Context 最小结构。
 *
 * 说明：`@deepseek-ai/cordis` 的 npm 类型在当前 TS 版本下接口合并失效
 * （Context 接口成员不可见），而 `ctx.tools`/`ctx.skills`/`ctx.logger`/`ctx.inject`
 * 在运行时都真实存在（官方插件 `dsh-tool-fs` 等均直接使用）。
 * 因此这里按运行时事实声明一个结构类型，避免依赖宿主的 .d.ts。
 */
export interface RuntimeSkillInput {
  name: string
  description: string
  content: string
  whenToUse?: string
  /** 必填字符串：dsh-skill 的加载校验要求 source 存在 */
  source?: string
  path?: string
  invocation?: {
    modelInvocable?: boolean
    userInvocable?: boolean
  }
}

export interface PluginContext {
  /** 工具注册表（@deepseek-ai/dsh-tools 服务）。 */
  tools: {
    register(definition: ToolDefinition): () => void
  }
  /** skill 注册表（@deepseek-ai/dsh-skill 服务，可选）。 */
  skills: {
    register(skill: RuntimeSkillInput): () => void
  }
  /** 沙箱文件系统服务（@deepseek-ai/dsh-fs-sandbox 提供，可选；本插件仅用于路径解析）。 */
  fs?: {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string }>
  }
  /** 日志服务：直接可调用的 logger 对象（官方插件用法）。 */
  logger: {
    info(message?: unknown, ...args: unknown[]): void
    warn(message?: unknown, ...args: unknown[]): void
    error(message?: unknown, ...args: unknown[]): void
    debug(message?: unknown, ...args: unknown[]): void
  }
  /** 可选服务注入：services 就绪后调用 callback，否则静默跳过。 */
  inject(services: string[], callback: (ctx: PluginContext) => void): void
}
