import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildDocx } from '../ooxml/docx.js'
import { buildXlsx } from '../ooxml/xlsx.js'
import { writePDF } from './pdf-write.js'
import {
  bytesToAsciiText,
  describeWriteFailure,
  resolveDocumentTarget,
  writeTargetText
} from '../utils/fs-channel.js'
import { shortName } from '../utils/present.js'
import type { DocToolkitConfig } from '../types/config.js'
import type { PluginContext } from '../types/plugin-context.js'

/**
 * 把纯文本按行拆成段落（忽略空行）。
 */
function textToParagraphs(content: string): string[] {
  return content.split(/\r?\n/).filter((p) => p.trim().length > 0)
}

/**
 * RFC 4180 风格转义：字段含逗号、双引号或换行时用双引号包裹，内部双引号翻倍。
 */
function escapeCSVField(field: unknown): string {
  const text = field === null || field === undefined ? '' : String(field)
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** 生成 DOCX 字节；内容非法时返回中文错误说明。 */
export function buildDocxPackage(content: Record<string, unknown>): { bytes: Uint8Array } | { error: string } {
  const title = typeof content.title === 'string' && content.title.length > 0 ? content.title : undefined

  let paragraphs: string[] = []
  if (Array.isArray(content.paragraphs)) {
    paragraphs = (content.paragraphs as unknown[]).map((p) => String(p))
  } else if (typeof content.content === 'string') {
    paragraphs = textToParagraphs(content.content)
  } else {
    return { error: `错误：content 必须包含 paragraphs（字符串数组）、content（纯文本）或 title + paragraphs 字段，收到: ${JSON.stringify(content)}` }
  }

  return { bytes: buildDocx(title === undefined ? { paragraphs } : { title, paragraphs }) }
}

/** 生成 XLSX 字节；内容非法时返回中文错误说明。 */
export function buildXlsxPackage(content: Record<string, unknown>): { bytes: Uint8Array; sheetName: string; rowCount: number } | { error: string } {
  const sheetName = typeof content.sheet_name === 'string' && content.sheet_name.length > 0
    ? content.sheet_name.slice(0, 31) // Excel 工作表名上限 31 字符
    : 'Sheet1'

  if (Array.isArray(content.rows)) {
    // 保留 null/undefined（含稀疏数组的空洞）：它们表示"该格不存在"，不写成空字符串。
    const rows = (content.rows as unknown[][]).map((row) => (row as unknown[]).slice())
    return { bytes: buildXlsx({ sheetName, rows }), sheetName, rowCount: rows.length }
  }
  if (Array.isArray(content.data)) {
    // 对象数组：键的并集作为表头，缺失键补空
    const data = content.data as Record<string, unknown>[]
    const headers = [...new Set(data.flatMap((row) => Object.keys(row ?? {})))]
    const rows: unknown[][] = [headers, ...data.map((row) => headers.map((h) => (row?.[h] === null || row?.[h] === undefined ? '' : row[h])))]
    return { bytes: buildXlsx({ sheetName, rows }), sheetName, rowCount: data.length }
  }
  return { error: `错误：content 必须包含 rows（二维数组）或 data（对象数组）字段，收到: ${JSON.stringify(content)}` }
}

/** 生成 CSV 文本；内容非法时返回中文错误说明。 */
export function buildCsvText(content: Record<string, unknown>): { text: string; rowCount: number } | { error: string } {
  if (Array.isArray(content.rows)) {
    const rows = content.rows as unknown[][]
    return { text: rows.map((row) => (row as unknown[]).map(escapeCSVField).join(',')).join('\r\n'), rowCount: rows.length }
  }
  if (Array.isArray(content.data)) {
    const data = content.data as Record<string, unknown>[]
    const headers = [...new Set(data.flatMap((row) => Object.keys(row)))]
    const lines = [headers.map(escapeCSVField).join(',')]
    for (const row of data) {
      lines.push(headers.map((h) => escapeCSVField(row[h])).join(','))
    }
    return { text: lines.join('\r\n'), rowCount: data.length }
  }
  if (typeof content.content === 'string') {
    return { text: content.content, rowCount: content.content.split(/\r?\n/).filter((l) => l.trim().length > 0).length }
  }
  return { error: `错误：content 必须包含 rows（二维数组）、data（对象数组）或 content（纯文本）字段，收到: ${JSON.stringify(content)}` }
}

export function registerWriteTools(ctx: PluginContext, config: DocToolkitConfig = {}) {
  const cjkFonts = config.cjkFonts ?? []
  ctx.tools.register(
    defineTool({
      name: 'write_document',
      description: `创建 DOCX、XLSX、CSV、PDF 文件（会覆盖同路径已有文件，父目录自动创建）。

DOCX：content 包含 paragraphs（字符串数组）或 content（纯文本，按换行分段），可选 title（文档大标题）
XLSX：content 包含 rows（二维数组）或 data（对象数组，键作为表头），可选 sheet_name（工作表名）
CSV：content 包含 rows（二维数组）、data（对象数组）或 content（纯文本）
PDF：content 包含 paragraphs（字符串数组）或 content（纯文本，按换行分段），可选 title（文档大标题）与 rows（二维数组，渲染为表格）；中文内容自动嵌入系统中文字体子集，文本可复制搜索

写入路径受会话沙箱约束：workspace-write 模式下只能写工作区内或临时目录。`,
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: '文件保存路径（绝对路径或相对路径）'
        },
        format: {
          type: 'string',
          enum: ['docx', 'xlsx', 'csv', 'pdf'],
          required: true,
          description: '文件格式'
        },
        content: {
          type: 'object',
          additionalProperties: true,
          required: true,
          description: '要写入的内容，格式因文件类型而异，见工具描述'
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      // 卡片契约：生成物是二进制（DOCX/XLSX/PDF），内置的 diff 词表无法表达，
      // 因此 pending 用 generic + kind:'edit'，completed 只在失败时替换标题。
      presentCall: (args) => ({
        card: 'generic',
        title: `生成 ${String(args.format).toUpperCase()} 文档 ${shortName(args.file_path)}`,
        kind: 'edit',
        locations: [{ path: args.file_path }]
      }),
      presentResult: (_args, result) => (result.isError ? { card: 'generic', title: '生成文档失败' } : undefined),
      async execute(args, exec) {
        const target = await resolveDocumentTarget(ctx, exec, args.file_path, exec.signal)

        try {
          switch (args.format) {
            case 'docx': {
              const built = buildDocxPackage(args.content)
              if ('error' in built) return built.error
              await writeTargetText(ctx, exec, target, bytesToAsciiText(built.bytes), exec.signal)
              const title = typeof args.content.title === 'string' && args.content.title.length > 0 ? args.content.title : undefined
              const count = Array.isArray(args.content.paragraphs)
                ? args.content.paragraphs.length
                : typeof args.content.content === 'string' ? textToParagraphs(args.content.content).length : 0
              return `成功写入 DOCX 文件: ${target.display}（${title ? `标题「${title}」+ ` : ''}${count} 个段落）`
            }
            case 'xlsx': {
              const built = buildXlsxPackage(args.content)
              if ('error' in built) return built.error
              await writeTargetText(ctx, exec, target, bytesToAsciiText(built.bytes), exec.signal)
              return `成功写入 XLSX 文件: ${target.display}（工作表「${built.sheetName}」，共 ${built.rowCount} 行数据）`
            }
            case 'csv': {
              const built = buildCsvText(args.content)
              if ('error' in built) return built.error
              await writeTargetText(ctx, exec, target, built.text, exec.signal)
              return `成功写入 CSV 文件: ${target.display}（共 ${built.rowCount} 行数据）`
            }
            case 'pdf':
              return await writePDF(ctx, exec, target, args.content, exec.signal, cjkFonts)
            default:
              return `不支持的格式: ${args.format}`
          }
        } catch (err) {
          return JSON.stringify({
            error: `写入文件失败: ${describeWriteFailure(err, target.display)}`,
            file_path: target.display,
            format: args.format
          }, null, 2)
        }
      }
    })
  )
}
