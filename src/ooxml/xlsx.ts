/**
 * SpreadsheetML（XLSX）最小实现：读取工作表网格、生成最小单表工作簿。
 *
 * 设计要点：
 * - 纯计算模块：只处理「名字 -> 字节」的表与字节，不做任何输入输出。
 * - 读：从 `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` 解析工作表名字与顺序，
 *   再定位 `xl/worksheets/sheetN.xml`；单元格按 `r` 属性（如 C5）定位，
 *   因此稀疏行/稀疏列也能对齐；`dimension` 只当提示，缺了也能读。
 *   共享字符串里的 `_x000D_` 这类 Excel 转义与多 `<r><t>` 富文本都会还原。
 * - 写：单工作表 + 内联字符串（`t="inlineStr"`），因此不需要 sharedStrings 部件；
 *   所有 XML 过 ASCII 转义器，保证 ZIP 输出纯 ASCII。
 */

import type { ZipEntryData } from '../zip/read.js'
import { buildStoredZip, type ZipEntryInput } from '../zip/write.js'
import { decodeXmlText, escapeXmlAttr, escapeXmlText, readAttr } from './xml.js'

/** 一个工作表的稠密网格（行 -> 单元格文本）。 */
export interface SheetData {
  /** 工作表名。 */
  readonly name: string
  /** 行数组；每行是等长的字符串数组，空单元格为 `''`。 */
  readonly rows: readonly (readonly string[])[]
}

const TEXT_DECODER = new TextDecoder('utf-8')
const DOCUMENT_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** 表名/网格的防御性上限，避免畸形文件把内存吃光。 */
const MAX_COLUMNS = 16384 // Excel 的 XFD 列
const MAX_ROWS = 1048576 // Excel 的行上限

/** 把条目字节按 UTF-8 解码成字符串。 */
function entryText(entry: ZipEntryData): string {
  return TEXT_DECODER.decode(entry.bytes)
}

/** 读一个部件（可选）。 */
function partText(zip: Map<string, ZipEntryData>, name: string): string | undefined {
  const entry = zip.get(name)
  return entry ? entryText(entry) : undefined
}

/** 遍历所有 `<name ...>` 起始标签，回调收到完整标签串与内容区间。 */
function forEachElement(xml: string, name: string, visit: (tag: string, inner: string) => void): void {
  const open = `<${name}`
  let from = 0
  for (;;) {
    const start = xml.indexOf(open, from)
    if (start < 0) return
    const nameEnd = start + open.length
    const following = xml.charAt(nameEnd)
    if (following !== '>' && following !== ' ' && following !== '\t' && following !== '\r' && following !== '\n' && following !== '/') {
      from = nameEnd
      continue
    }
    const gt = xml.indexOf('>', nameEnd)
    if (gt < 0) return
    const tag = xml.slice(start, gt + 1)
    from = gt + 1
    if (tag.endsWith('/>')) {
      visit(tag, '')
      continue
    }
    const close = xml.indexOf(`</${name}>`, gt + 1)
    if (close < 0) {
      visit(tag, '')
      return
    }
    visit(tag, xml.slice(gt + 1, close))
    from = close + name.length + 3
  }
}

/** 找第一个 `<tag ...>inner</tag>` 的内容（含自闭合返回空串）。 */
function innerOf(xml: string, tag: string): string | undefined {
  let inner: string | undefined
  forEachElement(xml, tag, (raw, content) => {
    if (inner === undefined) inner = raw.endsWith('/>') ? '' : content
  })
  return inner
}

/**
 * 还原 Excel 在共享字符串里使用的 `_xNNNN_` 转义（控制字符等）。
 *
 * 只处理 BJ 文档里定义的 `_xHHHH_` 形式；其余下划线原样保留。
 */
function decodeExcelEscapes(value: string): string {
  if (value.indexOf('_x') < 0) return value
  return value.replace(/_x([0-9A-Fa-f]{4})_/g, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16)
    if (!Number.isFinite(code) || code === 0) return whole
    return String.fromCharCode(code)
  })
}

/** `<si>` / `<is>` 的文本：拼接所有 `<t>`（覆盖 `<r><t>` 富文本与 preserve 空格）。 */
function richText(value: string): string {
  let out = ''
  forEachElement(value, 't', (_tag, content) => {
    out += decodeExcelEscapes(decodeXmlText(content))
  })
  return out
}

/** 列字母转 0 基列号：A -> 0，Z -> 25，AA -> 26。 */
function columnIndexFromLetters(letters: string): number {
  let value = 0
  for (let index = 0; index < letters.length; index++) {
    value = value * 26 + (letters.charCodeAt(index) - 64)
  }
  return value - 1
}

/** 0 基列号转列字母。 */
function columnLetters(index: number): string {
  let value = index + 1
  let out = ''
  while (value > 0) {
    const rest = (value - 1) % 26
    out = String.fromCharCode(65 + rest) + out
    value = Math.floor((value - 1) / 26)
  }
  return out
}

/** 解析单元格引用（如 `C5`），失败返回 undefined。 */
function parseCellRef(ref: string): { readonly column: number; readonly row: number } | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref)
  if (!match) return undefined
  const column = columnIndexFromLetters(match[1]!.toUpperCase())
  const row = Number.parseInt(match[2]!, 10) - 1
  if (!Number.isFinite(column) || !Number.isFinite(row) || column < 0 || row < 0) return undefined
  return { column, row }
}

/** 从 A1:B7 之类的 dimension 里取最大列数/行数（只当提示）。 */
function dimensionSize(xml: string): { readonly columns: number; readonly rows: number } | undefined {
  const dimension = innerOf(xml, 'dimension')
  if (dimension === undefined) return undefined
  const ref = readAttr(`<dimension ref="${dimension}"/>`, 'ref') ?? dimension
  const match = /^\$?([A-Za-z]{1,3})\$?[0-9]{1,7}(?::\$?([A-Za-z]{1,3})\$?([0-9]{1,7}))?$/.exec(ref.trim())
  if (!match) return undefined
  const lastColumn = match[2] ? columnIndexFromLetters(match[2].toUpperCase()) : columnIndexFromLetters(match[1]!.toUpperCase())
  const lastRow = match[3] ? Number.parseInt(match[3], 10) - 1 : undefined
  return {
    columns: Math.min(Math.max(lastColumn + 1, 1), MAX_COLUMNS),
    rows: lastRow === undefined ? 0 : Math.min(Math.max(lastRow + 1, 1), MAX_ROWS)
  }
}

/** 解析共享字符串表：每个 `<si>` 一项。 */
function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return []
  const items: string[] = []
  forEachElement(xml, 'si', (_tag, inner) => {
    items.push(richText(inner))
  })
  return items
}

/** 解析工作表关系表：rId -> 目标部件路径（相对 `/xl` 解析）。 */
function parseWorkbookRels(xml: string | undefined): Map<string, string> {
  const targets = new Map<string, string>()
  if (xml === undefined) return targets
  forEachElement(xml, 'Relationship', (tag) => {
    const id = readAttr(tag, 'Id')
    const target = readAttr(tag, 'Target')
    if (!id || !target) return
    targets.set(id, normalizeWorkbookTarget(target))
  })
  return targets
}

/** 关系目标可能是绝对路径（/xl/...）、相对路径（worksheets/sheet1.xml）或外部链接。 */
function normalizeWorkbookTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  if (target.startsWith('xl/')) return target
  return `xl/${target}`
}

/** 解析 workbook.xml，得到按顺序排列的 (表名, 部件路径)。 */
function parseWorkbookSheets(xml: string, rels: Map<string, string>): { readonly name: string; readonly path: string }[] {
  const sheets: { name: string; path: string }[] = []
  forEachElement(xml, 'sheet', (tag) => {
    const name = readAttr(tag, 'name') ?? `Sheet${sheets.length + 1}`
    const id = readAttr(tag, 'r:id') ?? readAttr(tag, 'id')
    const target = id ? rels.get(id) : undefined
    sheets.push({ name, path: target ?? `xl/worksheets/sheet${sheets.length + 1}.xml` })
  })
  return sheets
}

/** 按 `t` 属性把单元格原始内容变成字符串。 */
function cellValue(cellXml: string, type: string | undefined, shared: readonly string[]): string {
  if (type === 's') {
    const raw = innerOf(cellXml, 'v')
    if (raw === undefined) return ''
    const index = Number.parseInt(decodeXmlText(raw).trim(), 10)
    if (!Number.isFinite(index) || index < 0 || index >= shared.length) return ''
    return shared[index]!
  }
  if (type === 'inlineStr') {
    const inline = innerOf(cellXml, 'is')
    return inline === undefined ? '' : richText(inline)
  }
  if (type === 'b') {
    const raw = innerOf(cellXml, 'v')
    if (raw === undefined) return ''
    return decodeXmlText(raw).trim() === '1' ? 'TRUE' : 'FALSE'
  }
  // `str`（公式字符串）与默认的数字都直接取 <v>。
  const raw = innerOf(cellXml, 'v')
  return raw === undefined ? '' : decodeXmlText(raw)
}

/** 解析一张工作表为稠密网格。 */
function parseSheetRows(xml: string, shared: readonly string[]): string[][] {
  const hints = dimensionSize(xml)
  const rows: string[][] = []
  let maxColumns = hints?.columns ?? 0
  let currentRow = -1
  let current: string[] = []
  let rowStarted = false

  const ensureWidth = (width: number): void => {
    if (width <= current.length) return
    const capped = Math.min(width, MAX_COLUMNS)
    while (current.length < capped) current.push('')
  }

  const flush = (): void => {
    if (!rowStarted) return
    const rowIndex = currentRow < 0 ? rows.length : currentRow
    if (rowIndex > MAX_ROWS) {
      rowStarted = false
      current = []
      return
    }
    while (rows.length < rowIndex) rows.push([])
    rows[rowIndex] = current
    maxColumns = Math.max(maxColumns, current.length)
    rowStarted = false
    current = []
  }

  forEachElement(xml, 'row', (rowTag, rowInner) => {
    flush()
    const rowRef = readAttr(rowTag, 'r')
    const parsedRow = rowRef === undefined ? undefined : Number.parseInt(rowRef, 10)
    currentRow = parsedRow !== undefined && Number.isFinite(parsedRow) ? parsedRow - 1 : -1
    rowStarted = true
    let column = -1
    forEachElement(rowInner, 'c', (cellTag, cellInner) => {
      const ref = readAttr(cellTag, 'r')
      const parsed = ref === undefined ? undefined : parseCellRef(ref)
      column = parsed ? parsed.column : column + 1
      if (column < 0 || column >= MAX_COLUMNS) return
      const value = cellValue(cellInner, readAttr(cellTag, 't'), shared)
      ensureWidth(column + 1)
      current[column] = value
    })
  })
  flush()

  // 补齐成矩形，并把中间的空行也补成等宽空行。
  const width = Math.min(Math.max(maxColumns, 1), MAX_COLUMNS)
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row === undefined) {
      rows[index] = new Array<string>(width).fill('')
      continue
    }
    while (row.length < width) row.push('')
    if (row.length > width) row.length = width
  }
  return rows
}

/**
 * 读取工作簿里的所有工作表。
 *
 * @param zip `readZip` 的结果。
 * @throws 缺少 `xl/workbook.xml` 时抛出明确的 Error。
 */
export function readXlsxSheets(zip: Map<string, ZipEntryData>): SheetData[] {
  const workbookXml = partText(zip, 'xl/workbook.xml')
  if (workbookXml === undefined) throw new Error('XLSX 缺少工作簿部件 xl/workbook.xml')
  const rels = parseWorkbookRels(partText(zip, 'xl/_rels/workbook.xml.rels'))
  const shared = parseSharedStrings(partText(zip, 'xl/sharedStrings.xml'))
  const sheets = parseWorkbookSheets(workbookXml, rels)

  const result: SheetData[] = []
  for (const sheet of sheets) {
    const xml = partText(zip, sheet.path)
    result.push({ name: sheet.name, rows: xml === undefined ? [] : parseSheetRows(xml, shared) })
  }
  return result
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

const XLSX_HEAD = DOCUMENT_HEAD

const CONTENT_TYPES_XML = `${XLSX_HEAD}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

const ROOT_RELS_XML = `${XLSX_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

const WORKBOOK_RELS_XML = `${XLSX_HEAD}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

/** 最小样式表：只声明默认字体/填充/边框与 Normal 单元格样式（无 s= 引用）。 */
const STYLES_XML = `${XLSX_HEAD}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/**
 * 判定一个值是否写成 Excel 数字单元格。
 *
 * - JS `number`：有限值才算数字（NaN / Infinity 会退化成字符串）。
 * - 字符串：**Excel 口径**的数字写法（`[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?`）写成数字，
 *   因此 `'2'`、`'2.50'`、`'1e3'`、`'007'` 都是数字单元格——与在 Excel 里直接键入这些
 *   字符串的结果一致。带千分位、货币符号或非数字的（`'1,000'`、`'abc'`、`''`）保持文本。
 *   **注意规范化**：`'007'` → `7`、`'2.50'` → `2.5`、`'1e3'` → `1000`。需要原样保留
 *   （邮编、工号、版本号）时请改用 CSV，或传真正的文本单元格（见 README 的说明）。
 */
function numericLiteral(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0 || text.length > 64) return undefined
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return undefined
    return Number.isFinite(Number(text)) ? text : undefined
  }
  return undefined
}

/**
 * 一个单元格：布尔走 `t="b"`、数字走 `<v>`，其余走内联字符串。
 *
 * 布尔必须写成真正的布尔单元格（`t="b"` + `1`/`0`），否则 Excel/SheetJS 只会看到
 * 文本 `TRUE`/`FALSE`，丢失类型。
 */
function cellXml(column: number, row: number, value: unknown): string {
  const ref = `${columnLetters(column)}${row + 1}`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  const numeric = numericLiteral(value)
  if (numeric !== undefined) return `<c r="${ref}"><v>${numeric}</v></c>`
  const text = value === null || value === undefined ? '' : String(value)
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`
}

/** 工作表名合法性：Excel 禁止这些字符，且长度上限 31。 */
function sanitizeSheetName(name: string | undefined): string {
  const fallback = 'Sheet1'
  if (name === undefined) return fallback
  // 去掉 Excel 不允许出现在表名里的字符，再去掉首尾空白与首尾单引号。
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').replace(/^[\s']+|[\s']+$/g, '')
  if (cleaned.length === 0) return fallback
  return cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned
}

/**
 * 生成最小但合法的单工作表 XLSX（STORED ZIP，纯 ASCII 字节）。
 *
 * 单元格用内联字符串，因此不需要 `xl/sharedStrings.xml`；
 * `[Content_Types].xml` 与 `xl/_rels/workbook.xml.rels` 里的部件一致。
 */
export function buildXlsx(input: { readonly sheetName?: string; readonly rows: readonly (readonly unknown[])[] }): Uint8Array {
  const sheetName = sanitizeSheetName(input.sheetName)
  const sourceRows = (input.rows ?? []).filter((row): row is readonly unknown[] => Array.isArray(row))

  let maxColumns = 0
  for (const row of sourceRows) {
    const width = Math.min(row.length, MAX_COLUMNS)
    if (width > maxColumns) maxColumns = width
  }

  const sheetXml = sourceRows
    .map((row, rowIndex) => {
      const cells: string[] = []
      for (let column = 0; column < Math.min(row.length, maxColumns); column++) {
        const value = row[column]
        // null / undefined（含稀疏数组的空洞）**不写单元格**：保留真正的稀疏表示，
        // 文件更小，读回时也仍是"该格不存在"而不是"空字符串"。
        if (value === null || value === undefined) continue
        cells.push(cellXml(column, rowIndex, value))
      }
      return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
    })
    .join('')

  const dimension = `A1:${columnLetters(Math.max(maxColumns - 1, 0))}${Math.max(sourceRows.length, 1)}`
  const worksheetXml = `${XLSX_HEAD}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${sheetXml}</sheetData></worksheet>`

  const workbookXml = `${XLSX_HEAD}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXmlAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', data: encodeAscii(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encodeAscii(ROOT_RELS_XML) },
    { name: 'xl/workbook.xml', data: encodeAscii(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: encodeAscii(WORKBOOK_RELS_XML) },
    { name: 'xl/styles.xml', data: encodeAscii(STYLES_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: encodeAscii(worksheetXml) }
  ]
  return buildStoredZip(entries)
}

/** 把已经 ASCII 安全的 XML 字符串编码成字节（模板里出现非 ASCII 立即报错）。 */
function encodeAscii(xml: string): Uint8Array {
  const bytes = new Uint8Array(xml.length)
  for (let index = 0; index < xml.length; index++) {
    const code = xml.charCodeAt(index)
    if (code > 0x7f) throw new Error(`XLSX 模板出现非 ASCII 字符（位置 ${index}），请改用 escapeXmlText 转义`)
    bytes[index] = code
  }
  return bytes
}
