import type { PluginContext } from './types/plugin-context.js';
/** Cordis 插件名（loader 诊断用）。 */
export declare const name = "dsh-doc-toolkit";
/** 插件依赖的服务：tools 注册表（必需）。skills 为可选依赖，见 apply。 */
export declare const inject: string[];
export declare function apply(ctx: PluginContext): void;
