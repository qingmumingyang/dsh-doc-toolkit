/**
 * ZIP + OOXML 自研层（src/zip、src/ooxml）的验收测试。
 *
 * 测试策略：用成熟库当「神谕」。
 *  - 我们写 → 它们读：buildDocx 交给 mammoth，buildXlsx 交给 SheetJS 的 xlsx。
 *  - 它们写 → 我们读：docx 的 Packer、xlsx 的 write 产出真包，喂给 readZip/readDocxText/readXlsxSheets。
 *  - 自制包的结构性质（纯 ASCII、字段安全、本地条目连续）则直接按字节重新解析校验。
 *
 * 运行方式（Node 24）：
 *   node --test tests/oracle-zip-ooxml.test.mjs
 *
 * 为什么需要「临时编译」这一步：被测模块是 .ts，且相对导入按 NodeNext 写成
 * `./crc32.js`；Node 的类型擦除不做 `.js` -> `.ts` 的重映射（实测报
 * ERR_MODULE_NOT_FOUND）。所以这里优先用已有的编译产物 lib/，没有的话就用
 * TypeScript 编译器 API 把 src 编到 os.tmpdir() 下再导入。
 * 这样既不依赖 `npm run build`（父代理拥有该脚本），也不碰仓库里的任何文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { Document, Packer, Paragraph, TextRun } from 'docx'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

/** 被测源文件清单（按目录）。 */
const SOURCE_FILES = [
  ['zip', 'crc32.ts'],
  ['zip', 'write.ts'],
  ['zip', 'read.ts'],
  ['ooxml', 'xml.ts'],
  ['ooxml', 'docx.ts'],
  ['ooxml', 'xlsx.ts']
]

/**
 * 已有的编译产物是否「够新」。
 *
 * 这一点很重要：本测试必须测**当前源码**。如果 lib/ 是旧版本编译出来的
 * （例如父代理在源码更新前跑过一次 build），直接用它就会测到过时实现、
 * 报出已经不存在的错误。这里按修改时间判断，过期就改用临时编译。
 */
function builtIsFresh() {
  const built = path.join(pluginRoot, 'lib')
  try {
    let newestSource = 0
    for (const [dir, file] of SOURCE_FILES) {
      const info = statSync(path.join(pluginRoot, 'src', dir, file))
      if (info.mtimeMs > newestSource) newestSource = info.mtimeMs
    }
    let oldestBuilt = Number.POSITIVE_INFINITY
    for (const [dir, file] of SOURCE_FILES) {
      const info = statSync(path.join(built, dir, file.replace(/\.ts$/, '.js')))
      if (info.mtimeMs < oldestBuilt) oldestBuilt = info.mtimeMs
    }
    return oldestBuilt >= newestSource
  } catch {
    return false
  }
}

/** 把 src 临时编译到 os.tmpdir() 并返回入口 URL；lib/ 够新就直接用。 */
function resolveModules() {
  const built = path.join(pluginRoot, 'lib')
  if (existsSync(path.join(built, 'zip', 'read.js')) && existsSync(path.join(built, 'ooxml', 'xlsx.js')) && builtIsFresh()) {
    return { base: pathToFileURL(built + path.sep).href, mode: 'lib' }
  }
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  const outDir = mkdtempSync(path.join(tmpdir(), 'doc-toolkit-ooxml-'))
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmitOnError: true,
    rootDir: path.join(pluginRoot, 'src'),
    outDir,
    types: ['node']
  }
  // 只把被测的 zip / ooxml 模块拉进程序：测试不依赖插件其余部分
  // （tools/ 下的文件由父代理负责，正在改动，不该拖累本测试）。
  const entryPoints = SOURCE_FILES.map(([dir, file]) => path.join(pluginRoot, 'src', dir, file))
  const program = ts.createProgram(entryPoints, options)
  const emitted = program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics)
  if (emitted.emitSkipped || diagnostics.length > 0) {
    const text = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => pluginRoot,
      getNewLine: () => '\n'
    })
    throw new Error(`临时编译被测源码失败：\n${text}`)
  }
  return { base: pathToFileURL(outDir + path.sep).href, mode: 'tmp-compile', outDir }
}

const modules = resolveModules()
const { crc32 } = await import(modules.base + 'zip/crc32.js')
const { buildStoredZip } = await import(modules.base + 'zip/write.js')
const { readZip } = await import(modules.base + 'zip/read.js')
const { escapeXmlText, escapeXmlAttr, decodeXmlText, readAttr } = await import(modules.base + 'ooxml/xml.js')
const { readDocxText, buildDocx } = await import(modules.base + 'ooxml/docx.js')
const { readXlsxSheets, buildXlsx } = await import(modules.base + 'ooxml/xlsx.js')

test.after(() => {
  if (modules.mode === 'tmp-compile' && modules.outDir) rmSync(modules.outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/** 找出首个 >= 0x80 的字节位置，找不到返回 -1。 */
function firstNonAscii(bytes) {
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] > 0x7f) return index
  }
  return -1
}

/** 断言一段字节是纯 ASCII（自研 ZIP 层的硬要求）。 */
function assertPureAscii(bytes, label) {
  const bad = firstNonAscii(bytes)
  assert.equal(bad, -1, `${label} 出现非 ASCII 字节（偏移 ${bad}，值 0x${bad >= 0 ? bytes[bad].toString(16) : '??'}）`)
}

/** 拷贝一份字节（测试里要就地改，避免污染原数组）。 */
function cloneBytes(bytes) {
  return Uint8Array.from(bytes)
}

/** 字节 -> latin1 字符串，便于比对手写包的原始内容。 */
function bytesToBinary(bytes) {
  let out = ''
  for (let index = 0; index < bytes.length; index++) out += String.fromCharCode(bytes[index])
  return out
}

/** 在字节流里找第一个出现的签名（小端），找不到返回 -1。 */
function findSignature(bytes, signature) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.indexOf(Buffer.from([signature & 0xff, (signature >>> 8) & 0xff, (signature >>> 16) & 0xff, (signature >>> 24) & 0xff]))
}

/**
 * 把夹具 XML 里的非 ASCII 字符统一转成数字字符引用。
 *
 * ZIP 写入器只接受纯 ASCII 内容（这是"经 UTF-8 文本通道字节保真落盘"的前提），
 * 所以手写夹具里的中文必须显式转义——真实调用方由 `escapeXmlText` 负责同一件事。
 * 用 `for...of` 按码点迭代，避免把代理对拆成半个码元。
 */
function asciiXml(xml) {
  let out = ''
  for (const ch of xml) {
    const code = ch.codePointAt(0)
    out += code > 0x7f ? `&#x${code.toString(16).toUpperCase()};` : ch
  }
  return out
}

/**
 * 按字节重新解析自研 ZIP，返回每个条目的结构信息。
 *
 * 这里刻意不复用 readZip：测试要独立验证「字节布局」本身是否正确
 * （连续排布、字段安全、合法扩展字段），而不是复用被测代码的判断。
 */
function inspectZip(bytes) {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findSignature(bytes, 0x06054b50)
  assert.ok(eocd >= 0, '找不到 EOCD')
  const entryCount = view.readUInt16LE(eocd + 10)
  const centralSize = view.readUInt32LE(eocd + 12)
  const centralOffset = view.readUInt32LE(eocd + 16)

  /** 四字节全部 <= 0x7F 才算字段安全。 */
  const fieldSafe = (value) => value >= 0 && value <= 0x7f7f7f7f && (value & 0x80808080) === 0
  const fieldSafe16 = (value) => value >= 0 && value <= 0x7f7f

  // 中央目录：逐条按**记录自己**的名字/扩展长度前进。中央扩展字段长度与本地扩展字段
  // 可以不同（本地那条用于把下一条目偏移推进安全区，中央那条用于收敛中央目录大小），
  // 所以不能靠本地条目预测中央目录的记录位置。
  const central = []
  let centralCursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    assert.equal(view.readUInt32LE(centralCursor), 0x02014b50, `第 ${index} 个中央目录记录签名不对`)
    const nameLength = view.readUInt16LE(centralCursor + 28)
    const extraLength = view.readUInt16LE(centralCursor + 30)
    central.push({
      crc: view.readUInt32LE(centralCursor + 16),
      compressedSize: view.readUInt32LE(centralCursor + 20),
      uncompressedSize: view.readUInt32LE(centralCursor + 24),
      nameLength,
      extraLength,
      name: view.toString('latin1', centralCursor + 46, centralCursor + 46 + nameLength),
      localOffset: view.readUInt32LE(centralCursor + 42),
    })
    centralCursor += 46 + nameLength + extraLength
  }

  // 本地条目：布局是 [30 字节头][名字][扩展字段][数据]，条目之间必须紧邻。
  const locals = []
  let cursor = 0
  for (let index = 0; index < entryCount; index++) {
    assert.equal(view.readUInt32LE(cursor), 0x04034b50, `第 ${index} 个本地头签名不对`)
    const crc = view.readUInt32LE(cursor + 14)
    const compressedSize = view.readUInt32LE(cursor + 18)
    const uncompressedSize = view.readUInt32LE(cursor + 22)
    const nameLength = view.readUInt16LE(cursor + 26)
    const extraLength = view.readUInt16LE(cursor + 28)
    const name = view.toString('latin1', cursor + 30, cursor + 30 + nameLength)
    const extraStart = cursor + 30 + nameLength
    const dataStart = extraStart + extraLength
    const dataEnd = dataStart + compressedSize

    // 扩展字段（若有）必须是合法结构：u16 id + u16 size + size 个字节。
    let extraValid = true
    if (extraLength > 0) {
      const id = view.readUInt16LE(extraStart)
      const dataSize = view.readUInt16LE(extraStart + 2)
      extraValid = id === 0 && dataSize === extraLength - 4 && extraLength >= 4
    }

    const record = central[index]
    locals.push({
      index,
      name,
      start: cursor,
      end: dataEnd,
      extraStart,
      dataStart,
      dataEnd,
      compressedSize,
      uncompressedSize,
      crc,
      nameLength,
      extraLength,
      extraValid,
      data: bytes.subarray(dataStart, dataEnd),
      centralCrc: record?.crc,
      centralCompressed: record?.compressedSize,
      centralName: record?.name,
      centralLocalOffset: record?.localOffset,
      fieldSafe: fieldSafe(crc) && fieldSafe(compressedSize) && fieldSafe(uncompressedSize) && fieldSafe(cursor) && fieldSafe16(nameLength),
    })
    cursor = dataEnd
  }

  return {
    view,
    entryCount,
    centralOffset,
    centralSize,
    centralCursor,
    central,
    locals,
    /** 所有本地条目紧邻排布，且最后一条正好接上中央目录。 */
    contiguous: locals.every((entry, index) => (index === 0 ? entry.start === 0 : entry.start === locals[index - 1].end))
      && (locals.length === 0 ? centralOffset === 0 : locals[locals.length - 1].end === centralOffset),
    fieldsSafe:
      locals.every((entry) => entry.fieldSafe
        && entry.extraValid
        && entry.crc === entry.centralCrc
        && entry.compressedSize === entry.centralCompressed
        && entry.name === entry.centralName
        && entry.start === entry.centralLocalOffset)
      && fieldSafe(centralOffset)
      && fieldSafe(centralSize)
      && centralCursor <= centralOffset + centralSize,
    fieldSafe
  }
}

const CHINESE_TITLE = '季度经营分析报告'
const PARAGRAPHS = [
  '第一段：中文 + emoji \u{1F600} 与符号 & < > " \' 都要能正确往返。',
  '第二段：带\t制表符 和 结尾空格   ',
  '第三段：ASCII only ASCII 12345',
  ''
]

/** 规模测试用的大输入：几百段中文，部件达到几十 KB。 */
function largeParagraphs(count) {
  return Array.from({ length: count }, (_value, index) => `第 ${index + 1} 段：这是用于压力测试的中文内容，包含标点、数字 ${index * 7} 与符号 & < > " '。`)
}

/** 规模测试用的大表格：几百行。 */
function largeRows(count) {
  return Array.from({ length: count }, (_value, index) => [`第${index + 1}行`, `中文单元格 ${index}`, index * 3.5, index % 2 === 0, `备注 & <${index}>`])
}

// ---------------------------------------------------------------------------
// 1. 我们写 DOCX -> mammoth 读
// ---------------------------------------------------------------------------

test('buildDocx 产出的文档能被 mammoth 读出标题与全部段落', async () => {
  const bytes = buildDocx({ title: CHINESE_TITLE, paragraphs: PARAGRAPHS })
  assertPureAscii(bytes, 'buildDocx 输出')

  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  const text = result.value
  assert.ok(text.includes(CHINESE_TITLE), `缺少标题：${JSON.stringify(text)}`)
  for (const paragraph of PARAGRAPHS) {
    const needle = paragraph.replace(/\s+$/, '')
    if (needle.length === 0) continue
    // mammoth 会把制表符折叠成空格，这里按空白归一化后比对。
    const normalizedText = text.replace(/[ \t]+/g, ' ')
    const normalizedNeedle = needle.replace(/[ \t]+/g, ' ')
    assert.ok(normalizedText.includes(normalizedNeedle), `缺少段落：${JSON.stringify(needle)}`)
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  assert.ok(lines.length >= PARAGRAPHS.filter((p) => p.trim().length > 0).length + 1, `行数不足：${JSON.stringify(lines)}`)
})

test('buildDocx 结构自洽：[Content_Types].xml 声明的部件都存在', () => {
  const bytes = buildDocx({ title: 'T', paragraphs: ['p'] })
  const zip = readZip(bytes)
  const contentTypes = decoder.decode(zip.get('[Content_Types].xml').bytes)
  for (const part of ['word/document.xml', 'word/styles.xml']) {
    assert.ok(contentTypes.includes(`/word/${part.split('/')[1]}`), `Content_Types 未登记 ${part}`)
    assert.ok(zip.has(part), `包内缺少 ${part}`)
  }
  assert.ok(zip.has('_rels/.rels'), '包内缺少 _rels/.rels')
  const documentRels = decoder.decode(zip.get('word/_rels/document.xml.rels').bytes)
  assert.ok(documentRels.includes('styles.xml'), 'styles.xml 没有被文档关系引用')
})

test('buildDocx 的空输入也能生成可解析的文档', async () => {
  const bytes = buildDocx({ paragraphs: [] })
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  assert.equal(result.value.trim(), '')
})

// ---------------------------------------------------------------------------
// 2. docx 库写 -> 我们读
// ---------------------------------------------------------------------------

test('readDocxText 能读回 docx 库生成的文档（中文/制表符/emoji）', async () => {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: '标题：中文标题 \u{1F680}', bold: true })] }),
          new Paragraph({ children: [new TextRun('正文一'), new TextRun({ text: '\t制表符后' })] }),
          new Paragraph({ children: [new TextRun({ text: '带 <标签> & "引号" 的行' })] })
        ]
      }
    ]
  })
  const oracleBytes = new Uint8Array(await Packer.toBuffer(doc))

  const zip = readZip(oracleBytes)
  assert.ok(zip.has('word/document.xml'), 'docx 神谕产物缺少 word/document.xml')
  const text = readDocxText(zip)

  assert.ok(text.includes('标题：中文标题 \u{1F680}'), `缺少标题行：${JSON.stringify(text)}`)
  assert.ok(text.includes('正文一'), `缺少正文：${JSON.stringify(text)}`)
  assert.ok(text.includes('\t制表符后'), `制表符没有还原：${JSON.stringify(text)}`)
  assert.ok(text.includes('带 <标签> & "引号" 的行'), `实体反转义不正确：${JSON.stringify(text)}`)
  assert.ok(!text.endsWith('\n'), '末尾空白行应被裁掉')
})

test('readDocxText 对属性顺序/命名空间不敏感，能跳过域代码并还原 tab/br', () => {
  // docx 库不会生成 <w:instrText> / <w:br/>，这两条路径用手写 OOXML 覆盖。
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t xml:space="preserve"> 前 </w:t></w:r><w:r><w:t>后 &#x4E2D;文 &amp; 尾巴</w:t><w:tab/><w:t>tab 后</w:t></w:r></w:p>
<w:p><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:t>域之后的文字</w:t></w:r></w:p>
<w:p/><w:p><w:r><w:br/><w:t>换行后</w:t></w:r></w:p>
</w:body></w:document>`
  const zip = readZip(buildStoredZip([{ name: 'word/document.xml', data: encoder.encode(asciiXml(documentXml)) }]))
  const text = readDocxText(zip)
  assert.equal(text, ' 前 后 中文 & 尾巴\ttab 后\n域之后的文字\n\n换行后')
  assert.ok(!text.includes('PAGE'), `域代码不应作为可见文本输出：${JSON.stringify(text)}`)

  assert.throws(() => readDocxText(new Map()), /word\/document\.xml/)
})

// ---------------------------------------------------------------------------
// 3. 我们写 XLSX -> SheetJS 读
// ---------------------------------------------------------------------------

test('buildXlsx 产出的工作簿能被 SheetJS 正确读出（中文/数字/布尔/稀疏行）', () => {
  const rows = [
    ['姓名', '分数', '备注'],
    ['张三', 92.5, '-1e3'],
    ['李四', '007', true],
    [, , '只有第三列'],
    ['王五', 0, false]
  ]
  const bytes = buildXlsx({ sheetName: '成绩 & 统计<表>', rows })
  assertPureAscii(bytes, 'buildXlsx 输出')

  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' })
  assert.deepEqual(workbook.SheetNames, ['成绩 & 统计<表>'])
  const sheet = workbook.Sheets[workbook.SheetNames[0]]

  assert.equal(sheet.A1.v, '姓名')
  assert.equal(sheet.A2.v, '张三')
  assert.equal(sheet.B2.v, 92.5)
  // Excel 口径：'1e3' / '-1e3' 这类写法在 Excel 里键入就是数字，因此写成数字单元格。
  assert.equal(sheet.C2.v, -1000)
  assert.equal(sheet.A3.v, '李四')
  // '007' 去掉前导零后仍是数字，按需求写成数字单元格。
  assert.equal(sheet.B3.v, 7)
  assert.equal(sheet.C3.v, true)
  assert.equal(sheet.C4.v, '只有第三列')
  assert.equal(sheet.A5.v, '王五')
  assert.equal(sheet.B5.v, 0)
  assert.equal(sheet.C5.v, false)
  // 稀疏行里 null/undefined 的格子**不写单元格**（保留真正的稀疏表示）。
  assert.equal(sheet.A4, undefined)
  assert.equal(sheet.B4, undefined)
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
  assert.deepEqual(grid[3], ['', '', '只有第三列'])
  assert.deepEqual(grid[1].slice(0, 3), ['张三', 92.5, -1000])
})

test('buildXlsx 数字/字符串判定：数字与非数字各就各位', () => {
  const bytes = buildXlsx({ sheetName: 'n', rows: [[1, '2', '2.50', '1e3', '1,000', 'abc', '', null, undefined, NaN, Infinity, -0.5]] })
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' })
  const sheet = workbook.Sheets.n
  assert.equal(sheet.A1.v, 1)
  assert.equal(sheet.B1.v, 2)
  assert.equal(sheet.C1.v, 2.5)
  assert.equal(sheet.D1.v, 1000)
  assert.equal(sheet.E1.v, '1,000')
  assert.equal(sheet.F1.v, 'abc')
  assert.equal(sheet.G1.v, '')
  // null / undefined 表示"该格不存在"，写入时**跳过**而不是写空字符串（与稀疏行一致）。
  assert.equal(sheet.H1, undefined)
  assert.equal(sheet.I1, undefined)
  assert.equal(sheet.J1.v, 'NaN')
  assert.equal(sheet.K1.v, 'Infinity')
  assert.equal(sheet.L1.v, -0.5)
})

test('buildXlsx 的表名会清理非法字符并截断到 31 字符', () => {
  const long = 'A'.repeat(40)
  const bytes = buildXlsx({ sheetName: `非法/名:字?*[]${long}`, rows: [['x']] })
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' })
  const name = workbook.SheetNames[0]
  assert.ok(name.length <= 31, `表名过长：${name.length}`)
  for (const bad of ['/', '?', '*', '[', ']', ':']) assert.ok(!name.includes(bad), `表名仍含非法字符 ${bad}：${name}`)

  const fallback = XLSX.read(Buffer.from(buildXlsx({ sheetName: '   ', rows: [] })), { type: 'buffer' })
  assert.deepEqual(fallback.SheetNames, ['Sheet1'])
})

// ---------------------------------------------------------------------------
// 4. SheetJS 写 -> 我们读
// ---------------------------------------------------------------------------

test('readXlsxSheets 能读回 SheetJS 生成的多工作表（共享字符串 + 稀疏行）', () => {
  const shared = [
    ['城市', '人口', '标签'],
    ['北京', 21893095, '首都'],
    [, , '缺少前两列'],
    ['上海', 24874500, '直辖市'],
    ['\u{1F600} emoji & <标签>', 0, true]
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(shared), '共享字符串')
  const inlineSheet = XLSX.utils.aoa_to_sheet([['内联', 1.5], ['第二行', 'TRUE']])
  inlineSheet.A2 = { t: 'inlineStr', v: '内联改写', is: { t: '内联改写' } }
  XLSX.utils.book_append_sheet(workbook, inlineSheet, 'Inline')
  const out = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true })

  const sheets = readXlsxSheets(readZip(new Uint8Array(out)))
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ['共享字符串', 'Inline']
  )

  const first = sheets[0]
  assert.equal(first.rows.length, 5)
  assert.equal(first.rows[0][0], '城市')
  assert.equal(first.rows[1][0], '北京')
  assert.equal(first.rows[1][1], '21893095')
  assert.equal(first.rows[1][2], '首都')
  assert.equal(first.rows[2][0], '')
  assert.equal(first.rows[2][2], '缺少前两列')
  assert.deepEqual(first.rows[3], ['上海', '24874500', '直辖市'])
  assert.equal(first.rows[4][0], '\u{1F600} emoji & <标签>')
  assert.equal(first.rows[4][1], '0')
  assert.equal(first.rows[4][2], 'TRUE')

  const second = sheets[1]
  assert.equal(second.rows[0][0], '内联')
  assert.equal(second.rows[0][1], '1.5')
  assert.equal(second.rows[1][0], '内联改写')
  assert.equal(second.rows[1][1], 'TRUE')
})

test('readXlsxSheets 处理多 <r><t> 富文本、preserve 空格与稀疏列', () => {
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><r><t>前</t></r><r><t xml:space="preserve"> 中 </t></r><r><t>后</t></r></si><si><t xml:space="preserve">  两端空格  </t></si><si><t>_x000D_回车</t></si></sst>`
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D3"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c></row><row r="3"><c r="B3" t="s"><v>2</v></c><c r="C3" t="inlineStr"><is><t>内联</t></is></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="str"><v>公式结果</v></c></row></sheetData></worksheet>`
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId7"/></sheets></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

  const zip = readZip(
    buildStoredZip([
      { name: 'xl/workbook.xml', data: encoder.encode(asciiXml(workbook)) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(asciiXml(rels)) },
      { name: 'xl/sharedStrings.xml', data: encoder.encode(asciiXml(sharedStrings)) },
      { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(asciiXml(sheet)) }
    ])
  )
  const sheets = readXlsxSheets(zip)
  assert.equal(sheets.length, 1)
  assert.equal(sheets[0].name, '数据')
  const rows = sheets[0].rows
  assert.equal(rows.length, 3)
  // 读取器把每行补齐到工作表的最大列宽（矩形），这样 TSV 输出与分页行号都稳定。
  assert.deepEqual(rows[0], ['前 中 后', '', '', '  两端空格  ', ''])
  assert.deepEqual(rows[1], ['', '', '', '', ''])
  assert.deepEqual(rows[2], ['', '\r回车', '内联', 'TRUE', '公式结果'])

  assert.throws(() => readXlsxSheets(new Map()), /xl\/workbook\.xml/)
})

// ---------------------------------------------------------------------------
// 5. 规模测试：几十 KB 的部件 + 纯 ASCII + 结构性质
// ---------------------------------------------------------------------------

test('中文 DOCX（几百段，部件几十 KB）依然纯 ASCII 且能被 mammoth 读回', async () => {
  const paragraphs = largeParagraphs(300)
  const bytes = buildDocx({ title: '压力测试报告', paragraphs })
  assert.ok(bytes.length > 40000, `DOCX 太小，没到规模：${bytes.length}`)
  assertPureAscii(bytes, '大 DOCX 输出')

  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  for (const index of [0, 1, 150, 299]) {
    assert.ok(result.value.includes(`第 ${index + 1} 段`), `缺少第 ${index + 1} 段`)
  }
  assert.ok(result.value.includes('压力测试报告'), '缺少标题')
})

test('中文 XLSX（几百行）依然纯 ASCII 且能被 SheetJS 读回', () => {
  const rows = largeRows(400)
  const bytes = buildXlsx({ sheetName: '规模测试', rows })
  assert.ok(bytes.length > 80000, `XLSX 太小，没到规模：${bytes.length}`)
  assertPureAscii(bytes, '大 XLSX 输出')

  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' })
  const sheet = workbook.Sheets['规模测试']
  assert.equal(sheet.A1.v, '第1行')
  assert.equal(sheet.B1.v, '中文单元格 0')
  assert.equal(sheet.C2.v, 3.5)
  assert.equal(sheet.D2.v, false)
  assert.equal(sheet.E400.v, '备注 & <399>')
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })
  assert.equal(grid.length, 400)
})

test('自研 ZIP 的本地条目连续排布（Office 依赖这个性质）', () => {
  for (const [label, bytes] of [
    ['小 DOCX', buildDocx({ title: 'T', paragraphs: ['x'] })],
    ['大 DOCX', buildDocx({ title: '标题', paragraphs: largeParagraphs(300) })],
    ['大 XLSX', buildXlsx({ sheetName: '表', rows: largeRows(300) })],
    ['纯 ZIP', buildStoredZip([{ name: 'a.txt', data: encoder.encode('hi') }, { name: 'dir/b.xml', data: encoder.encode('<x/>') }])]
  ]) {
    const info = inspectZip(bytes)
    assert.ok(info.contiguous, `${label} 的本地条目不连续`)
    assert.equal(info.view.readUInt32LE(info.centralOffset), 0x02014b50, `${label} 中央目录起点不对`)
    // 最后一条本地条目正好接上中央目录（中间不能有空隙）。
    const last = info.locals[info.locals.length - 1]
    assert.equal(last.end, info.centralOffset, `${label} 的本地区与中央目录之间有间隙`)
  }
})

test('自研 ZIP 的每个 CRC/大小/偏移字段都「字段安全」（四字节皆 <= 0x7F）', () => {
  for (const [label, bytes] of [
    ['小 DOCX', buildDocx({ title: 'T', paragraphs: ['x'] })],
    ['大 DOCX', buildDocx({ title: '中文标题', paragraphs: largeParagraphs(300) })],
    ['小 XLSX', buildXlsx({ sheetName: 's', rows: [['a', 1]] })],
    ['大 XLSX', buildXlsx({ sheetName: '规模', rows: largeRows(400) })]
  ]) {
    const info = inspectZip(bytes)
    assert.ok(info.fieldsSafe, `${label} 存在非字段安全的字段`)
    for (const entry of info.locals) {
      assert.ok(entry.fieldSafe, `${label} 条目 ${entry.name} 字段不安全`)
      assert.ok(entry.extraValid, `${label} 条目 ${entry.name} 的扩展字段结构非法`)
      assert.ok(entry.extraLength === 0 || (entry.extraLength >= 4 && entry.extraLength <= 127), `${label} 扩展字段长度越界：${entry.extraLength}`)
      // CRC 覆盖的是条目数据本身（含补白），不含名字。
      const raw = bytesToBinary(entry.data)
      assert.equal(crc32(encoder.encode(raw)), entry.crc, `${label} 条目 ${entry.name} 的 CRC 与数据不符`)
      const content = raw.replace(/\n+$/, '')
      assert.equal(raw, content + '\n'.repeat(raw.length - content.length), `${label} 条目 ${entry.name} 的补白不是换行`)
    }
    assert.ok(info.fieldSafe(info.centralOffset), `${label} 中央目录偏移不安全`)
    assert.ok(info.fieldSafe(info.centralSize), `${label} 中央目录大小不安全`)
  }
})

test('readZip 能把自己写的包逐字节还原（含补白与扩展字段）', () => {
  const paragraphs = largeParagraphs(200)
  const docxBytes = buildDocx({ title: '往返', paragraphs })
  const info = inspectZip(docxBytes)
  const zip = readZip(docxBytes)

  assert.equal(zip.size, info.locals.length)
  for (const entry of info.locals) {
    const got = zip.get(entry.name)
    assert.ok(got, `缺少条目 ${entry.name}`)
    // readZip 返回的是「条目内容」（已含补白换行），必须与本地头声明的字节逐一相同。
    assert.deepEqual(Array.from(got.bytes), Array.from(entry.data), `条目 ${entry.name} 字节不一致`)
  }
  // 文本内容仍能被 DOCX 读取器正确解析（补白换行不影响 XML）。
  const text = readDocxText(zip)
  assert.ok(text.includes('第 1 段'), '大文档读回的文本缺少首段')
  assert.ok(text.includes('第 200 段'), '大文档读回的文本缺少末段')
})

// ---------------------------------------------------------------------------
// 6. 纯 ASCII 保证（小输入 + 转义器）
// ---------------------------------------------------------------------------

test('ASCII 与中文输入下，ZIP/DOCX/XLSX 输出都没有 >= 0x80 的字节', () => {
  assertPureAscii(buildStoredZip([{ name: 'a.txt', data: encoder.encode('hello') }]), 'ASCII buildStoredZip')
  const chineseEntries = Array.from({ length: 64 }, (_value, index) => ({
    name: `dir/part-${index}.xml`,
    // 文本节点必须经转义器变成数字字符引用——ZIP 写入器只接受纯 ASCII 内容，
    // 直接把中文 XML 交给它会（正确地）抛错。
    data: encoder.encode(asciiXml(`<x>中文内容 ${index} &amp; 更多</x>`))
  }))
  assertPureAscii(buildStoredZip(chineseEntries), '中文 buildStoredZip')
  assertPureAscii(buildDocx({ title: '中文标题', paragraphs: ['中文段落 \u{1F600}'] }), '中文 buildDocx')
  assertPureAscii(buildDocx({ paragraphs: ['plain ascii'] }), 'ASCII buildDocx')
  assertPureAscii(buildXlsx({ sheetName: '中文表', rows: [['中文', 1, true], ['emoji', '\u{1F600}', null]] }), '中文 buildXlsx')
  assertPureAscii(buildXlsx({ sheetName: 'ascii', rows: [['a', 1]] }), 'ASCII buildXlsx')

  // 转义器本身：非 ASCII 必须变成数字字符引用，而不是原字符。
  assert.equal(escapeXmlText('中'), '&#x4E2D;')
  assert.equal(escapeXmlText('\u{1F600}'), '&#x1F600;')
  assert.equal(escapeXmlAttr('a"b\'c<d>&'), 'a&quot;b&apos;c&lt;d&gt;&amp;')
  assert.equal(firstNonAscii(encoder.encode(escapeXmlText('中文\u{1F600}&<>"'))), -1)
  assert.equal(decodeXmlText(escapeXmlText('中文\u{1F600} & <x> "q" \'a\'')), '中文\u{1F600} & <x> "q" \'a\'')
  assert.equal(decodeXmlText('&#65;&#x42;&amp;&unknown;&#xZZ;'), 'AB&&unknown;&#xZZ;')
  assert.equal(readAttr('<w:t xml:space="preserve" w:val=\'x &amp; y\'>', 'w:val'), 'x & y')
  assert.equal(readAttr("<w:t w:val='单引号'/>", 'w:val'), '单引号')
  assert.equal(readAttr('<w:t w:val="a"/>', 'val'), undefined)
})

test('写入器拒绝非 ASCII 的名字与内容（调用方必须自己保证 ASCII 安全）', () => {
  assert.throws(() => buildStoredZip([{ name: '中文.xml', data: encoder.encode('x') }]), /ASCII/)
  assert.throws(() => buildStoredZip([{ name: 'a.xml', data: encoder.encode('中文') }]), /ASCII/)
  assert.throws(() => buildStoredZip([{ name: '', data: new Uint8Array(0) }]), /不能为空/)
  assertPureAscii(buildStoredZip([{ name: 'a.xml', data: encoder.encode(escapeXmlText('中文')) }]), '转义后的条目')
})

// ---------------------------------------------------------------------------
// 7. 畸形输入必须抛错
// ---------------------------------------------------------------------------

test('readZip 对截断/损坏/加密/未知方法/超限输入一律抛错', () => {
  const good = buildStoredZip([
    { name: 'word/document.xml', data: encoder.encode('<x>hello</x>') },
    { name: 'word/media/blob.bin', data: encoder.encode('b'.repeat(4096)) }
  ])

  assert.throws(() => readZip(good.slice(0, Math.floor(good.length / 2))), /ZIP/)
  assert.throws(() => readZip(new Uint8Array([1, 2, 3])), /EOCD/)
  assert.throws(() => readZip(new Uint8Array(64).fill(0x41)), /EOCD/)

  const centralOffset = findSignature(good, 0x02014b50)
  assert.ok(centralOffset > 0, '找不到中央目录签名')

  const brokenCentral = cloneBytes(good)
  brokenCentral[centralOffset] = 0x00
  assert.throws(() => readZip(brokenCentral), /签名/)

  const brokenOffset = cloneBytes(good)
  brokenOffset[centralOffset + 42] = 0x02
  brokenOffset[centralOffset + 43] = 0x00
  brokenOffset[centralOffset + 44] = 0x00
  brokenOffset[centralOffset + 45] = 0x00
  assert.throws(() => readZip(brokenOffset), /ZIP/)

  const encrypted = cloneBytes(good)
  encrypted[centralOffset + 8] = 0x01
  assert.throws(() => readZip(encrypted), /加密/)

  const unsupported = cloneBytes(good)
  unsupported[centralOffset + 10] = 12
  assert.throws(() => readZip(unsupported), /压缩方法 12/)

  assert.throws(() => readZip(good, { maxEntries: 1 }), /超过上限/)
  assert.throws(() => readZip(good, { maxEntryBytes: 16 }), /单条上限/)
  assert.throws(() => readZip(good, { maxTotalBytes: 32 }), /总大小超过上限/)
  assert.ok(readZip(good, { maxEntries: 2, maxEntryBytes: 1 << 20 }).has('word/document.xml'))
})

test('readZip 校验 DEFLATE 声明大小，并对解压炸弹抛错', () => {
  const payload = deflateRawSync(Buffer.from('x'.repeat(2048)))
  const build = (declaredSize, compressed) => {
    const name = Buffer.from('bomb.xml', 'latin1')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc32(encoder.encode('x'.repeat(2048))), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc32(encoder.encode('x'.repeat(2048))), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(0, 42)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(46 + name.length, 12)
    eocd.writeUInt32LE(30 + name.length + compressed.length, 16)
    return new Uint8Array(Buffer.concat([local, name, compressed, central, name, eocd]))
  }

  const ok = readZip(build(2048, payload))
  assert.equal(ok.get('bomb.xml').bytes.length, 2048)

  assert.throws(() => readZip(build(10, payload)), /解压/)
  assert.throws(() => readZip(build(2048, payload), { maxEntryBytes: 100 }), /单条上限/)
})

test('readZip 跳过目录条目、保留零字节条目、支持尾部注释', () => {
  const bytes = buildStoredZip([
    { name: 'dir/', data: new Uint8Array(0) },
    { name: 'dir/empty.xml', data: new Uint8Array(0) },
    { name: 'dir/a.xml', data: encoder.encode('a') }
  ])
  const zip = readZip(bytes)
  assert.deepEqual([...zip.keys()], ['dir/empty.xml', 'dir/a.xml'])
  assert.equal(zip.get('dir/empty.xml').bytes.length, 0)

  const comment = encoder.encode('x'.repeat(300))
  const withComment = new Uint8Array(bytes.length + comment.length)
  withComment.set(bytes, 0)
  withComment.set(comment, bytes.length)
  withComment[bytes.length - 2] = comment.length & 0xff
  withComment[bytes.length - 1] = (comment.length >>> 8) & 0xff
  assert.deepEqual([...readZip(withComment).keys()], ['dir/empty.xml', 'dir/a.xml'])
})

// ---------------------------------------------------------------------------
// 8. 其他：确定性、CRC
// ---------------------------------------------------------------------------

test('buildStoredZip 输出确定，CRC-32 与标准实现一致', () => {
  const entries = [
    { name: 'a.txt', data: encoder.encode('hello world') },
    { name: 'b/c.txt', data: encoder.encode(escapeXmlText('中文已被转义')) }
  ]
  assert.deepEqual(Array.from(buildStoredZip(entries)), Array.from(buildStoredZip(entries)), '相同输入必须产生相同字节')

  // 与 Node 版本无关的标准校验值（CRC-32/ISO-HDLC）：
  // "123456789" = 0xCBF43926、"The quick brown fox…" = 0x414FA339、空输入 = 0。
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926)
  assert.equal(crc32(encoder.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339)
  assert.equal(crc32(new Uint8Array(0)), 0)

  // Node 的 zlib.crc32 是 v20.15 / v22.2 才有的，CI 的 18 号矩阵没有它——
  // 因此只在可用时做交叉验证，标准向量才是常驻断言。
  const zlib = createRequire(import.meta.url)('node:zlib')
  if (typeof zlib.crc32 === 'function') {
    const sample = encoder.encode('The quick brown fox jumps over the lazy dog')
    assert.equal(crc32(sample), zlib.crc32(sample))
    assert.equal(crc32(encoder.encode('中文')), zlib.crc32(Buffer.from('中文')))
  }
})
