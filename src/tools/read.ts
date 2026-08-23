import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReadResult } from '../types/index.js'
import type { PluginContext } from '../types/plugin-context.js'

/**
 * 解析 PDF 文本层。
 *
 * 两个关键点（都是 pdf-parse 的已知坑）：
 * 1. 不引入包入口 `index.js`：它有 `let isDebugMode = !module.parent` 调试钩子，
 *    模块被 ESM 加载时 module.parent 为 null 会误触发内置测试分支而崩溃，因此
 *    直接引入 `lib/pdf-parse.js`。
 * 2. 必须用 CJS require 加载：其内置 pdf.js v1.10.x 在 ESM import 方式下
 *    XRef 解析会报 "bad XRef entry"（对任何合法 PDF），CJS require 则正常。
 *    `createRequire` 是 Node 在 ESM 中调用 CJS 的标准方式。
 */
const require = createRequire(import.meta.url)
interface PDFParseResult {
  text: string
  numpages: number
}
const pdfParse: (buf: Uint8Array) => Promise<PDFParseResult> = require('pdf-parse/lib/pdf-parse.js')

async function parseDOCX(filePath: string): Promise<{ text: string; messages: string[] }> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return { text: result.value, messages: result.messages.map((m) => m.message) }
}

/**
 * 把工作簿的每个工作表读取为一行行的 TSV 文本（`[Sheet: 名称]` 开头），
 * 再按 offset/limit 在"行"级别做窗口切片（跨表连续计数）。
 */
async function parseXLSX(filePath: string, offset?: number, limit?: number): Promise<{ text: string; total: number; truncated: boolean }> {
  // xlsx 是 CJS 包：动态 import 时命名导出不可靠，统一取 default ?? 命名空间
  const mod = (await import('xlsx')) as unknown
  const XLSX = ((mod as { default?: unknown }).default ?? mod) as typeof import('xlsx')
  const workbook = XLSX.readFile(filePath)
  const lines: string[] = []
  const sheetNames = workbook.SheetNames

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const jsonData = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
    lines.push(`[Sheet: ${sheetName}]`)
    for (const row of jsonData) {
      lines.push((row as unknown[]).map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join('\t'))
    }
  }

  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length
  return {
    text: lines.slice(start, end).join('\n'),
    total: lines.length,
    truncated: end < lines.length
  }
}

/**
 * RFC 4180 风格的 CSV 解析：支持双引号包裹字段、字段内逗号/换行/转义双引号。
 */
function parseCSVRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function parseCSV(filePath: string, offset?: number, limit?: number, signal?: AbortSignal): Promise<{ text: string; total: number; truncated: boolean }> {
  let content = await fs.readFile(filePath, 'utf-8')
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1) // 去掉 UTF-8 BOM
  const rows = parseCSVRows(content)
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit !== undefined ? Math.min(rows.length, start + limit) : rows.length
  const window = rows.slice(start, end).map((row) => row.join('\t'))
  return {
    text: window.join('\n'),
    total: rows.length,
    truncated: end < rows.length
  }
}

function detectFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.xlsx': 'xlsx',
    '.xls': 'xlsx',
    '.csv': 'csv',
    '.txt': 'csv'
  }
  return map[ext] || 'unknown'
}

export function registerReadTools(ctx: PluginContext) {
  ctx.tools.register(
    defineTool({
      name: 'read_document',
      description: `读取 PDF、DOCX、XLSX、CSV 等文档文件的内容并返回纯文本/TSV。
支持格式：PDF（提取文本层）、DOCX（提取原始文本）、XLSX（逐工作表读取为 TSV 行）、CSV（UTF-8，支持引号包裹字段）。
大文件请用 offset/limit 参数分页，防止返回内容超出上下文窗口。
注意：扫描版 PDF（无文本层）无法提取文字。`,
      parameters: {
        file_path: {
          type: 'string',
          required: true,
          description: '文件路径（绝对路径，或相对于工作区的路径）'
        },
        format: {
          type: 'string',
          enum: ['pdf', 'docx', 'xlsx', 'csv', 'auto'],
          description: '文件格式，设为 auto（默认）时根据扩展名自动识别'
        },
        offset: {
          type: 'number',
          description: '起始行号（从 1 开始，仅对 CSV/XLSX 有效）'
        },
        limit: {
          type: 'number',
          description: '最大返回行数（仅对 CSV/XLSX 有效，防止大文件撑爆上下文）'
        }
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const format = args.format === 'auto' || !args.format ? detectFormat(args.file_path) : args.format

        if (format === 'unknown') {
          return JSON.stringify({
            error: `无法识别文件格式: ${args.file_path}`,
            supported: ['pdf', 'docx', 'xlsx', 'csv', 'txt']
          }, null, 2)
        }

        const result: ReadResult = { content: '', format, total_lines: 0 }
        try {
          switch (format) {
            case 'pdf': {
              const dataBuffer = await fs.readFile(args.file_path, { signal: exec.signal })
              // 关键：必须把 Node Buffer 拷贝为独立 Uint8Array 再交给 pdf.js。
              // 小文件 readFile 返回的 Buffer 来自共享内存池（byteOffset ≠ 0），
              // pdf.js v1.10 会把池中垃圾数据当成 PDF 内容解析，导致
              // "bad XRef entry" 间歇性失败（文件越大越不易复现）。
              const parsed = await pdfParse(new Uint8Array(dataBuffer))
              result.content = parsed.text
              result.total_lines = parsed.text.split('\n').length
              result.pages = parsed.numpages
              break
            }
            case 'docx': {
              const parsed = await parseDOCX(args.file_path)
              result.content = parsed.text
              result.total_lines = parsed.text.split('\n').length
              if (parsed.messages.length > 0) result.warnings = parsed.messages
              break
            }
            case 'xlsx': {
              const parsed = await parseXLSX(args.file_path, args.offset, args.limit)
              result.content = parsed.text
              result.total_lines = parsed.total
              result.truncated = parsed.truncated
              break
            }
            case 'csv': {
              const parsed = await parseCSV(args.file_path, args.offset, args.limit, exec.signal)
              result.content = parsed.text
              result.total_lines = parsed.total
              result.truncated = parsed.truncated
              break
            }
            default:
              return JSON.stringify({ error: `不支持的格式: ${format}` }, null, 2)
          }
        } catch (err) {
          return JSON.stringify({
            error: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
            file_path: args.file_path,
            format
          }, null, 2)
        }

        if (args.offset) result.offset = args.offset
        if (args.limit) result.limit = args.limit
        return JSON.stringify(result, null, 2)
      }
    })
  )
}
