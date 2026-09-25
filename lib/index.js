import Schema from '@deepseek-ai/schemastery';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { normalizeCjkFonts } from './types/config.js';
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_SOURCE, SKILL_WHEN_TO_USE, } from './skills/embedded-skill.js';
/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-doc-toolkit';
/**
 * 插件配置 Schema（Cordis 标准写法）：loader 会按它校验并填充
 * cordis.patch.yml 中该插件行的 `config:` 字段，未提供时使用默认值。
 */
export const Config = Schema.object({
    cjkFonts: Schema.array(Schema.string()).default([])
});
/**
 * 插件依赖的服务：`tools` 工具注册表与 `fs` 文件系统能力（都由宿主提供，必需）。
 * `skills` 是可选依赖，用 `ctx.inject` 动态等待，见 apply。
 */
export const inject = ['tools', 'fs'];
/**
 * 插件入口。
 *
 * 本插件**不读任何文件来完成自身加载**：随包 Skill 的正文内嵌在
 * `src/skills/embedded-skill.ts`（由 SKILL.md 生成），因此运行源码里没有文件访问，
 * 也就没有 DSH STORE 的 `files` 权限信号。工具运行时的文档读写全部经 `ctx.fs`。
 */
export function apply(ctx, config = {}) {
    ctx.logger.info('[dsh-doc-toolkit] 插件已加载！');
    // 字体候选来自插件配置（不读取环境变量）：见 src/types/config.ts 的说明。
    const cjkFonts = normalizeCjkFonts(config?.cjkFonts);
    // 注册读取工具（read_document）
    registerReadTools(ctx);
    // 注册写入工具（write_document）——PDF 导出需要配置中的字体候选
    registerWriteTools(ctx, { cjkFonts });
    // 把随包 Skill 注册为运行时 skill，让 AI 知道何时、如何调用这两个工具。
    // 使用 ctx.inject 而不是静态 inject：即使 skills 服务未挂载，插件也能正常加载。
    ctx.inject(['skills'], (skillCtx) => {
        try {
            skillCtx.skills.register({
                name: SKILL_NAME,
                description: SKILL_DESCRIPTION,
                ...(SKILL_WHEN_TO_USE.length > 0 ? { whenToUse: SKILL_WHEN_TO_USE } : {}),
                content: SKILL_CONTENT,
                // source 是"来源标签"而非文件路径：bundled = 随包提供。
                source: SKILL_SOURCE
            });
            ctx.logger.info(`[dsh-doc-toolkit] 已注册 skill: ${SKILL_NAME}`);
        }
        catch (err) {
            ctx.logger.warn(`[dsh-doc-toolkit] skill 注册失败（不影响工具功能）: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
