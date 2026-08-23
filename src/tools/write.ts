import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writePDF } from './pdf-write.js'
import type { PluginContext } from '../types/plugin-context.js'

/** docx 是 CJS 包，动态 import 时命名导出在类型层面不可靠，运行时统一取 default ?? 命名空间。 */
interface DocxModule {
  Document: new (options: object) => object
  Packer: { toBuffer(doc: object): Promise<Buffer> }
  Paragraph: new (options: object) => object
  TextRun: new (options: object) => object
  HeadingLevel: Record<string, unknown>
  AlignmentType: Record<string, unknown>
}

async function loadDocx(): Promise<DocxModule> {
  const mod = (await import('docx')) as unknown
  const docx = ((mod as { default?: object }).default ?? mod) as DocxModule
  return docx
}

/**
 * 把纯文本按行拆成段落（忽略空行）。
 */
function textToParagraphs(content: string): string[] {
  return content.split(/\r?\n/).filter((p) => p.trim().length > 0)
}

async function writeDOCX(filePath: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await loadDocx()

  let title: string | undefined
  if (typeof content.title === 'string') title = content.title

  let paragraphs: string[] = []
  if (Array.isArray(content.paragraphs)) {
    paragraphs = (content.paragraphs as unknown[]).map((p) => String(p))
  } else if (typeof content.content === 'string') {
    paragraphs = textToParagraphs(content.content)
  } else {
    return `错误：content 必须包含 paragraphs（字符串数组）、content（纯文本）或 title + paragraphs 字段，收到: ${JSON.stringify(content)}`
  }

  const children = []
  if (title) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: 36 })],
    }))
  }
  for (const text of paragraphs) {
    children.push(new Paragraph({ children: [new TextRun({ text, size: 24 })] }))
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  })

  const buffer = await Packer.toBuffer(doc)
  await fs.writeFile(filePath, buffer, { signal })
  return `成功写入 DOCX 文件: ${filePath}（${title ? `标题「${title}」+ ` : ''}${paragraphs.length} 个段落）`
}

async function writeXLSX(filePath: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  // xlsx 是 CJS 包：动态 import 时命名导出不可靠，统一取 default ?? 命名空间
  const mod = (await import('xlsx')) as unknown
  const XLSX = ((mod as { default?: unknown }).default ?? mod) as typeof import('xlsx')

  const sheetName = typeof content.sheet_name === 'string' && content.sheet_name.length > 0
    ? content.sheet_name.slice(0, 31) // Excel 工作表名上限 31 字符
    : 'Sheet1'

  let ws: ReturnType<typeof XLSX.utils.aoa_to_sheet>
  let rowCount = 0

  if (Array.isArray(content.rows)) {
    // 二维数组 → aoa_to_sheet（保留数组语义，避免 json_to_sheet 对数组的歧义）
    const rows = (content.rows as unknown[][]).map((row) => (row as unknown[]).map((cell) => (cell === null || cell === undefined ? '' : cell)))
    ws = XLSX.utils.aoa_to_sheet(rows)
    rowCount = rows.length
  } else if (Array.isArray(content.data)) {
    // 对象数组 → json_to_sheet（第一行对象键作为表头）
    const data = content.data as Record<string, unknown>[]
    ws = XLSX.utils.json_to_sheet(data)
    rowCount = data.length
  } else {
    return `错误：content 必须包含 rows（二维数组）或 data（对象数组）字段，收到: ${JSON.stringify(content)}`
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  await fs.writeFile(filePath, buffer, { signal })
  return `成功写入 XLSX 文件: ${filePath}（工作表「${sheetName}」，共 ${rowCount} 行数据）`
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

async function writeCSV(filePath: string, content: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  let csvContent = ''
  let rowCount = 0

  if (Array.isArray(content.rows)) {
    const rows = content.rows as unknown[][]
    csvContent = rows.map((row) => (row as unknown[]).map(escapeCSVField).join(',')).join('\r\n')
    rowCount = rows.length
  } else if (Array.isArray(content.data)) {
    const data = content.data as Record<string, unknown>[]
    const headers = [...new Set(data.flatMap((row) => Object.keys(row)))]
    const lines = [headers.map(escapeCSVField).join(',')]
    for (const row of data) {
      lines.push(headers.map((h) => escapeCSVField(row[h])).join(','))
    }
    csvContent = lines.join('\r\n')
    rowCount = data.length
  } else if (typeof content.content === 'string') {
    csvContent = content.content
    rowCount = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0).length
  } else {
    return `错误：content 必须包含 rows（二维数组）、data（对象数组）或 content（纯文本）字段，收到: ${JSON.stringify(content)}`
  }

  await fs.writeFile(filePath, csvContent, { encoding: 'utf8', signal })
  return `成功写入 CSV 文件: ${filePath}（共 ${rowCount} 行数据）`
}

export function registerWriteTools(ctx: PluginContext) {
  ctx.tools.register(
    defineTool({
      name: 'write_document',
      description: `创建 DOCX、XLSX、CSV、PDF 文件（会覆盖同路径已有文件，父目录自动创建）。

DOCX：content 包含 paragraphs（字符串数组）或 content（纯文本，按换行分段），可选 title（文档大标题）
XLSX：content 包含 rows（二维数组）或 data（对象数组，键作为表头），可选 sheet_name（工作表名）
CSV：content 包含 rows（二维数组）、data（对象数组）或 content（纯文本）
PDF：content 包含 paragraphs（字符串数组）或 content（纯文本，按换行分段），可选 title（文档大标题）与 rows（二维数组，渲染为表格）；中文内容自动嵌入系统中文字体子集，文本可复制搜索`,
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
      async execute(args, exec) {
        const dir = path.dirname(args.file_path)
        try {
          await fs.mkdir(dir, { recursive: true })
        } catch {
          // 目录可能已存在
        }

        try {
          switch (args.format) {
            case 'docx':
              return await writeDOCX(args.file_path, args.content, exec.signal)
            case 'xlsx':
              return await writeXLSX(args.file_path, args.content, exec.signal)
            case 'csv':
              return await writeCSV(args.file_path, args.content, exec.signal)
            case 'pdf':
              return await writePDF(args.file_path, args.content, exec.signal)
            default:
              return `不支持的格式: ${args.format}`
          }
        } catch (err) {
          return JSON.stringify({
            error: `写入文件失败: ${err instanceof Error ? err.message : String(err)}`,
            file_path: args.file_path,
            format: args.format
          }, null, 2)
        }
      }
    })
  )
}
