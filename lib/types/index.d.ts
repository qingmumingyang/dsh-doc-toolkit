import Schema from '@deepseek-ai/schemastery';
import { type DocToolkitConfig } from './types/config.js';
import type { PluginContext } from './types/plugin-context.js';
/** Cordis 插件名（loader 诊断用）。 */
export declare const name = "dsh-doc-toolkit";
/**
 * 插件配置 Schema（Cordis 标准写法）：loader 会按它校验并填充
 * cordis.patch.yml 中该插件行的 `config:` 字段，未提供时使用默认值。
 */
export declare const Config: Schema<Schemastery.ObjectS<{
    cjkFonts: Schema<string[], string[]>;
}>, Schemastery.ObjectT<{
    cjkFonts: Schema<string[], string[]>;
}>>;
/**
 * 插件依赖的服务：`tools` 工具注册表与 `fs` 文件系统能力（都由宿主提供，必需）。
 * `skills` 是可选依赖，用 `ctx.inject` 动态等待，见 apply。
 */
export declare const inject: string[];
/**
 * 插件入口。
 *
 * 本插件**不读任何文件来完成自身加载**：随包 Skill 的正文内嵌在
 * `src/skills/embedded-skill.ts`（由 SKILL.md 生成），因此运行源码里没有文件访问，
 * 也就没有 DSH STORE 的 `files` 权限信号。工具运行时的文档读写全部经 `ctx.fs`。
 */
export declare function apply(ctx: PluginContext, config?: DocToolkitConfig): void;
