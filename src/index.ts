import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerReadTools } from './tools/read.js'
import { registerWriteTools } from './tools/write.js'
import type { PluginContext } from './types/plugin-context.js'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-doc-toolkit'

/** 插件依赖的服务：tools 注册表（必需）。skills 为可选依赖，见 apply。 */
export const inject = ['tools']

/** 随包发布的 SKILL.md：从 lib/ 出发是 ../skills/...，源码目录 src/ 下同样成立。 */
const SKILL_FILE = new URL('../skills/doc-toolkit-usage/SKILL.md', import.meta.url)

const FALLBACK_NAME = 'doc-toolkit-usage'
const FALLBACK_DESCRIPTION = '当用户要求读取 PDF、Word、Excel、CSV 文档，或要求生成/编辑 DOCX、XLSX、CSV 文件时使用。'

interface ParsedSkill {
  name: string
  description: string
  content: string
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（手工解析 name/description，不引入 yaml 依赖），
 * 正文作为 skill 指令内容。
 */
function parseSkillFile(raw: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) {
    return { name: FALLBACK_NAME, description: FALLBACK_DESCRIPTION, content: raw.trim() + '\n' }
  }
  const front = match[1]
  const body = match[2] ?? ''
  const get = (key: string): string | undefined => {
    const kv = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)
    return kv ? kv[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  }
  return {
    name: get('name') ?? FALLBACK_NAME,
    description: get('description') ?? FALLBACK_DESCRIPTION,
    content: body.trim() + '\n'
  }
}

export function apply(ctx: PluginContext) {
  ctx.logger.info('[dsh-doc-toolkit] 插件已加载！')

  // 注册读取工具（read_document）
  registerReadTools(ctx)
  // 注册写入工具（write_document）
  registerWriteTools(ctx)

  // 把随包发布的 SKILL.md 注册为运行时 skill，让 AI 知道何时、如何调用这两个工具。
  // 使用 ctx.inject 而不是静态 inject：即使 skills 服务未挂载，插件也能正常加载。
  ctx.inject(['skills'], (skillCtx) => {
    try {
      const raw = readFileSync(SKILL_FILE, 'utf8')
      const skill = parseSkillFile(raw)
      skillCtx.skills.register({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        // source 为必填字符串：dsh-skill 加载校验要求 source 存在，
        // 否则模型侧加载该 skill 时抛 "source must be a string"。
        source: fileURLToPath(SKILL_FILE)
      })
      ctx.logger.info(`[dsh-doc-toolkit] 已注册 skill: ${skill.name}`)
    } catch (err) {
      ctx.logger.warn(`[dsh-doc-toolkit] skill 注册失败（不影响工具功能）: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
