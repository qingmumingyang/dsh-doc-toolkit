/**
 * Oracle / regression suite for `src/pdf/text-extract.ts`.
 *
 * Run with:
 *   node --test tests/oracle-pdf.test.mjs
 *
 * `pdf-parse` is used only as a test oracle; the module under test has no
 * runtime dependencies. Network fixtures are best-effort: when the download
 * fails the fixture assertions are skipped with `t.skip(...)` so the suite is
 * always green offline. The synthetic, round-trip and failure-path assertions
 * never touch the network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { extractPdfText, TJ_FORWARD_WORD_GAP, UNSUPPORTED } from '../lib/pdf/text-extract.js'
import { resolveDocumentTarget } from '../lib/utils/fs-channel.js'
import { writePDF } from '../lib/tools/pdf-write.js'
import { createHostFs } from './fs-stub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const TIMEOUT = { timeout: 30_000 }

/* ==========================================================================
 * Helpers
 * ======================================================================== */

const L1 = (s) => Buffer.from(s, 'latin1')

function concat(parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : L1(p))))
}

/** Build a PDF with a classic xref table from pre-rendered object bodies. */
function classicPdf(objects, { root = 1, extraTrailer = '', header = '%PDF-1.4\n%ASCII\n' } = {}) {
  const parts = [L1(header)]
  const offsets = [0]
  let size = parts[0].length
  for (let i = 0; i < objects.length; i++) {
    offsets.push(size)
    // 对象体可能是二进制流（Flate 压缩内容）：必须按字节拼接，
    // 走模板字符串会把 Buffer 按 UTF-8 转义从而破坏数据。
    const body = Buffer.isBuffer(objects[i]) ? objects[i] : L1(String(objects[i]))
    const chunk = concat([`${i + 1} 0 obj\n`, body, '\nendobj\n'])
    parts.push(chunk)
    size += chunk.length
  }
  const xref = size
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  table += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R${extraTrailer} >>\nstartxref\n${xref}\n%%EOF\n`
  parts.push(L1(table))
  return concat(parts)
}

function streamBody(content, dict = '') {
  const data = Buffer.isBuffer(content) ? content : L1(content)
  return { bytes: concat([`<< /Length ${data.length}${dict} >>\nstream\n`, data, '\nendstream']), data }
}

const PAGE = (resources, contents) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contents} 0 R >>`

const HELVETICA = (name = 'F1') =>
  `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${name} >>`

/** Extract text, failing loudly if the module throws. */
function textOf(buf, limits) {
  return extractPdfText(new Uint8Array(buf), limits)
}

function words(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/u)
      .filter((w) => w.length > 2),
  )
}

/** Run a function, converting a hang into a failure rather than a stuck suite. */
function withDeadline(fn, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (possible infinite loop)`)), ms)
    try {
      resolve(fn())
    } catch (err) {
      reject(err)
    } finally {
      clearTimeout(timer)
    }
  })
}

let oracle = null
/**
 * 加载 pdf-parse 作为对照实现。
 *
 * 必须走 `pdf-parse/lib/pdf-parse.js`（CJS require）而不是包入口：
 * 包入口有 `let isDebugMode = !module.parent` 调试钩子，在 ESM 下 `module.parent` 为 null
 * 会误触发内置测试分支并崩溃；其内置的 pdf.js v1.10 在 ESM import 下还会报
 * "bad XRef entry"。两者都是上游已知问题，与我们的产物无关。
 */
async function loadOracle() {
  if (oracle !== null) return oracle
  try {
    const require = createRequire(import.meta.url)
    oracle = require('pdf-parse/lib/pdf-parse.js')
  } catch {
    oracle = false
  }
  return oracle
}

async function oracleText(buf) {
  const parse = await loadOracle()
  if (parse === false) return null
  try {
    // 必须拷贝成独立 Uint8Array：readFileSync 返回的 Buffer 可能来自共享内存池
    // （byteOffset ≠ 0），pdf.js v1.10 会把池中垃圾当成 PDF 内容，间歇性报 "bad XRef entry"。
    const out = await parse(new Uint8Array(buf))
    return typeof out?.text === 'string' ? out.text : null
  } catch {
    return null
  }
}

/* ==========================================================================
 * 1. Mandatory offline round trips
 * ======================================================================== */

/** Byte-exact output of the repository's own PDF writer (no compression). */
const REPO_WRITER_PDF = `%PDF-1.4
%ASCII
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 68 >>
stream
BT /F1 11 Tf 1 0 0 1 56.70 775.84 Tm <68656c6c6f20776f726c64> Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>
endobj
6 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>
endobj
7 0 obj
<< /Producer (dsh-doc-toolkit) /Creator (dsh-doc-toolkit) /Title () /CreationDate (D:20260925T152342ZZ) >>
endobj
xref
0 8
0000000000 65535 f 
0000000016 00000 n 
0000000065 00000 n 
0000000122 00000 n 
0000000264 00000 n 
0000000381 00000 n 
0000000478 00000 n 
0000000580 00000 n 
trailer
<< /Size 8 /Root 1 0 R /Info 7 0 R >>
startxref
702
%%EOF
`

test('round trip: the repository writer byte layout extracts to "hello world"', TIMEOUT, () => {
  const out = textOf(L1(REPO_WRITER_PDF))
  assert.equal(out.pages, 1)
  assert.equal(out.truncated, false)
  assert.match(out.text, /hello world/)
})

test('round trip: writePDF output (ASCII + CJK) reads back', TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-extract-'))
  const asciiPath = join(dir, 'ascii.pdf')
  const paragraph = 'Round trip paragraph with distinctive zebra words'
  const ascii = await writeLocalPdf(asciiPath, { title: 'Round Trip Title', paragraphs: [paragraph] })

  const asciiOut = textOf(ascii)
  assert.match(asciiOut.text, /Round Trip Title/)
  assert.match(asciiOut.text, /distinctive zebra words/)
  assert.deepEqual([...words(paragraph)].filter((w) => !words(asciiOut.text).has(w)), [])

  // CJK 路径：Type0 / Identity-H + /ToUnicode，内嵌字体流是 ASCIIHex+Flate。
  const cjkPath = join(dir, 'cjk.pdf')
  const cjk = '中文测试：文档工具包可以读取中文。'
  const cjkOut = textOf(await writeLocalPdf(cjkPath, { title: '中文标题', paragraphs: [cjk] }))
  assert.match(cjkOut.text, /中文标题/, `CJK title missing from: ${JSON.stringify(cjkOut.text)}`)
  assert.match(cjkOut.text, /文档工具包/, `CJK body missing from: ${JSON.stringify(cjkOut.text)}`)
})

/**
 * 用仓库自己的生成器写一份 PDF。
 *
 * 生产代码不直接访问文件系统（全部经宿主 `ctx.fs`），所以这里用测试替身提供后端，
 * 并走与工具完全相同的调用路径：resolveDocumentTarget → writePDF。
 */
async function writeLocalPdf(filePath, content) {
  const cwd = dirname(filePath)
  const ctx = { fs: createHostFs({ baseCwd: cwd }) }
  const exec = { agent: { session: { header: { cwd } } } }
  const target = await resolveDocumentTarget(ctx, exec, filePath)
  await writePDF(ctx, exec, target, content)
  return readFileSync(filePath)
}

/* ==========================================================================
 * 2. Synthetic coverage
 * ======================================================================== */

test('classic xref table + Tj/Td/TL/T* line structure', TIMEOUT, () => {
  const content = `BT
/F1 24 Tf
72 700 Td
(Hello World) Tj
0 -30 Td
(second line) Tj
14 TL
T*
(third line) Tj
ET`
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const out = textOf(pdf)
  const lines = out.text.split('\n')
  assert.deepEqual(lines, ['Hello World', 'second line', 'third line'])
})

test('Flate-compressed content stream', TIMEOUT, () => {
  const content = 'BT /F1 18 Tf 50 700 Td (compressed content works) Tj ET'
  const compressed = deflateSync(L1(content))
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    { bytes: concat([`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, compressed, '\nendstream']) }.bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  assert.match(textOf(pdf).text, /compressed content works/)
})

test('TJ array, hex string and literal escapes', TIMEOUT, () => {
  const content = `BT /F1 12 Tf 72 700 Td [(First) -500 (part)] TJ ET
BT /F1 12 Tf 72 660 Td <48657820737472696E67> Tj ET
BT /F1 12 Tf 72 620 Td (esc \\(paren\\) \\\\ backslash \\101 octal) Tj ET
BT /F1 12 Tf 72 580 Td [(no) -10 (gap)] TJ ET`
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const text = textOf(pdf).text
  assert.match(text, /First part/, 'a large negative TJ adjustment must become a word gap')
  assert.match(text, /Hex string/)
  assert.match(text, /esc \(paren\) \\ backslash A octal/)
  assert.match(text, /nogap/, 'a small TJ adjustment must not insert a space')
})

test('WinAnsiEncoding maps 0x80..0x9F through cp1252', TIMEOUT, () => {
  // 八进制转义：\223 = 0x93、\224 = 0x94、\226 = 0x96（cp1252 的弯引号与短破折号）。
  const content = `BT /F1 12 Tf 72 700 Td (\\223quoted\\224 \\226) Tj ET`
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const text = textOf(pdf).text
  assert.match(text, /\u201cquoted\u201d/, '0x93/0x94 are curly quotes in cp1252')
  assert.match(text, /\u2013/, '0x96 is an en dash in cp1252')
})

test('/Encoding /Differences with glyph names', TIMEOUT, () => {
  // Differences 里每个字形名（含 /.notdef）按 PDF 规范各占一个码位：
  // 65=/Alpha、66=/Beta、67=/.notdef、68=/uni4E2D，另起一段 97=/eacute。
  // 内容用码位 65..68 与 97，覆盖"AGL 名 / uniXXXX / .notdef 回退 / 重设起始码"四种情形。
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /Alpha /Beta /.notdef /uni4E2D 97 /eacute] >> >>'
  const content = 'BT /F1 12 Tf 72 700 Td (ABCDa) Tj ET'
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    font,
  ])
  const text = textOf(pdf).text
  // Α Β 来自 AGL 名，中 来自 /uni4E2D，C 是 /.notdef 的按码位回退，é 来自 /eacute。
  assert.match(text, /\u0391\u0392C\u4e2d\u00e9/, 'glyph names must map through the AGL / uniXXXX rules')
  assert.doesNotMatch(text, /\uFFFD/)
})

test('cross-reference stream (/Type /XRef with /W and /Index) + /Prev-free', TIMEOUT, () => {
  const content = 'BT /F1 12 Tf 72 700 Td (xref stream page) Tj ET'
  const s = streamBody(content)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    s.bytes,
    HELVETICA('WinAnsiEncoding'),
  ]
  // Layout: objects 1..5, then the xref stream as object 6.
  const offsets = [0]
  let size = L1('%PDF-1.5\n').length
  const parts = [L1('%PDF-1.5\n')]
  for (const body of objects) {
    offsets.push(size)
    const chunk = concat([`${offsets.length - 1} 0 obj\n`, body, '\nendobj\n'])
    parts.push(chunk)
    size += chunk.length
  }
  const xrefOffset = size
  const rows = [0, ...offsets.slice(1)].map((off, num) =>
    num === 0 ? [0, 0, 65535] : [1, off, 0],
  )
  rows.push([1, xrefOffset, 0])
  const rowBytes = Buffer.alloc(rows.length * 7)
  rows.forEach((row, i) => {
    rowBytes.writeUInt8(row[0], i * 7)
    rowBytes.writeUInt32BE(row[1], i * 7 + 1)
    rowBytes.writeUInt16BE(row[2], i * 7 + 5)
  })
  const xrefChunk = concat([
    `6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Length ${rowBytes.length} >>\nstream\n`,
    rowBytes,
    '\nendstream\nendobj\n',
  ])
  parts.push(xrefChunk)
  parts.push(L1(`startxref\n${xrefOffset}\n%%EOF\n`))
  const pdf = concat(parts)

  const out = textOf(pdf)
  assert.match(out.text, /xref stream page/)
})

test('object stream (/Type /ObjStm) resolved through an xref stream type-2 entry', TIMEOUT, () => {
  // Objects 1..4 live inside object stream 5; the xref stream is object 6 and
  // the page content stream is object 7.
  const header = '%PDF-1.5\n'
  const inner = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 4 0 R >> >>', 7),
    HELVETICA('WinAnsiEncoding'),
  ]
  let first = ''
  const bodies = []
  let cursor = 0
  for (let i = 0; i < inner.length; i++) {
    first += `${i + 1} ${cursor}\n`
    bodies.push(inner[i])
    cursor += L1(inner[i]).length + 1
  }
  const objStmCompressed = deflateSync(L1(first + bodies.join('\n') + '\n'))
  const contentCompressed = deflateSync(L1('BT /F1 12 Tf 72 700 Td (inside object stream) Tj ET'))

  const objStmBody = concat([
    `<< /Type /ObjStm /N ${inner.length} /First ${L1(first).length} /Filter /FlateDecode /Length ${objStmCompressed.length} >>\nstream\n`,
    objStmCompressed,
    '\nendstream',
  ])
  const contentBody = concat([
    `<< /Length ${contentCompressed.length} /Filter /FlateDecode >>\nstream\n`,
    contentCompressed,
    '\nendstream',
  ])
  const headerBytes = (num, size) => L1(`${num} 0 obj\n`).length + size + L1('\nendobj\n').length

  const size5 = headerBytes(5, objStmBody.length)
  const size7 = headerBytes(7, contentBody.length)
  const off5 = L1(header).length
  const off7 = off5 + size5
  const off6 = off7 + size7

  const entries = [
    [0, 0, 65535],
    [2, 5, 0],
    [2, 5, 1],
    [2, 5, 2],
    [2, 5, 3],
    [1, off5, 0],
    [1, off6, 0],
    [1, off7, 0],
  ]
  const rowBytes = Buffer.alloc(entries.length * 7)
  entries.forEach((row, i) => {
    rowBytes.writeUInt8(row[0], i * 7)
    rowBytes.writeUInt32BE(row[1], i * 7 + 1)
    rowBytes.writeUInt16BE(row[2], i * 7 + 5)
  })
  const xrefBody = concat([
    `<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Length ${rowBytes.length} >>\nstream\n`,
    rowBytes,
    '\nendstream',
  ])
  // 自检：对象头 "5 0 obj\n" 是 8 字节（'5'、空格、'0'、空格、'o'、'b'、'j'、换行），
  // 下面的偏移计算依赖这个长度。
  assert.equal(L1('5 0 obj\n').length, 8)

  const pdf = concat([
    L1(header),
    L1('5 0 obj\n'), objStmBody, L1('\nendobj\n'),
    L1('7 0 obj\n'), contentBody, L1('\nendobj\n'),
    L1('6 0 obj\n'), xrefBody, L1('\nendobj\n'),
    L1(`startxref\n${off6}\n%%EOF\n`),
  ])

  const out = textOf(pdf)
  assert.equal(out.pages, 1)
  assert.match(out.text, /inside object stream/)
})

test('Type0 / Identity-H with a /ToUnicode CMap containing bfchar, bfrange and an array bfrange', TIMEOUT, () => {
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <4E2D>
<0004> <6587>
<0005> <6D4B>
endbfchar
1 beginbfrange
<0010> <0012> <0041>
endbfrange
1 beginbfrange
<0020> <0022> [<4E00> <4E8C> <4E09>]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /SimHei /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
  const descendant = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimHei /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>'
  // Codes: 0003 0004 0005 (中文测) then 0010 0011 (A B) then 0020 (一)
  const content = 'BT /F1 12 Tf 72 700 Td <000300040005001000110020> Tj ET'
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    font,
    descendant,
    { bytes: concat([`<< /Length ${L1(cmap).length} >>\nstream\n`, L1(cmap), '\nendstream']) }.bytes,
  ])
  const out = textOf(pdf)
  assert.match(out.text, /中文测/, `bfchar mapping failed: ${JSON.stringify(out.text)}`)
  assert.match(out.text, /AB/, 'bfrange sequential mapping failed')
  assert.match(out.text, /一/, 'bfrange array mapping failed')
})

test('FlateDecode with a PNG predictor (as used by xref streams)', TIMEOUT, () => {
  // Build the same object set twice: predictor-encoded xref rows and plain rows.
  const content = 'BT /F1 12 Tf 72 700 Td (predictor decoded page) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ]
  const offsets = [0]
  const parts = [L1('%PDF-1.5\n')]
  let size = L1('%PDF-1.5\n').length
  for (const body of objects) {
    offsets.push(size)
    const chunk = concat([`${offsets.length - 1} 0 obj\n`, body, '\nendobj\n'])
    parts.push(chunk)
    size += chunk.length
  }
  const xrefOffset = size
  const rows = [0, ...offsets.slice(1)].map((off, num) => (num === 0 ? [0, 0, 65535] : [1, off, 0]))
  rows.push([1, xrefOffset, 0])
  const raw = Buffer.alloc(rows.length * 7)
  rows.forEach((row, i) => {
    raw.writeUInt8(row[0], i * 7)
    raw.writeUInt32BE(row[1], i * 7 + 1)
    raw.writeUInt16BE(row[2], i * 7 + 5)
  })
  // PNG "Up" predictor (type 2) per row: byte[i] -= byte[i - rowLength].
  const stride = 7
  const encoded = Buffer.alloc(rows.length * (stride + 1))
  for (let r = 0; r < rows.length; r++) {
    encoded[r * (stride + 1)] = 2
    for (let i = 0; i < stride; i++) {
      const cur = raw[r * stride + i]
      const up = r === 0 ? 0 : raw[(r - 1) * stride + i]
      encoded[r * (stride + 1) + 1 + i] = (cur - up) & 0xff
    }
  }
  const compressed = deflateSync(encoded)
  parts.push(concat([
    `6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${compressed.length} >>\nstream\n`,
    compressed,
    '\nendstream\nendobj\n',
  ]))
  parts.push(L1(`startxref\n${xrefOffset}\n%%EOF\n`))
  assert.match(textOf(concat(parts)).text, /predictor decoded page/)
})

test('recovery: damaged cross-reference data still yields text', TIMEOUT, () => {
  const content = 'BT /F1 12 Tf 72 700 Td (recovered despite broken xref) Tj ET'
  const good = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const text = good.toString('latin1')

  // (a) startxref points at garbage.
  const badStart = L1(text.replace(/startxref\n\d+/, 'startxref\n999999'))
  assert.match(textOf(badStart).text, /recovered despite broken xref/)

  // (b) the whole xref table and trailer are gone.
  const truncated = L1(text.slice(0, text.indexOf('\nxref\n')))
  assert.match(textOf(truncated).text, /recovered despite broken xref/)

  // (c) one xref entry is corrupted (object 1 points into the middle of nowhere).
  const badEntry = L1(text.replace('0000000016 00000 n', '0000000999 00000 n'))
  assert.match(textOf(badEntry).text, /recovered despite broken xref/)
})

test('multi-page ordering and page separator', TIMEOUT, () => {
  const page = (label) => streamBody(`BT /F1 12 Tf 72 700 Td (${label}) Tj ET`).bytes
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    page('page one'),
    HELVETICA('WinAnsiEncoding'),
    PAGE('<< /Font << /F1 5 0 R >> >>', 7),
    page('page two'),
  ])
  const out = textOf(pdf)
  assert.equal(out.pages, 2)
  assert.ok(out.text.indexOf('page one') < out.text.indexOf('page two'))
})

test('no /Filter and chained filters (ASCIIHex + Flate) both work', TIMEOUT, () => {
  const plain = 'BT /F1 12 Tf 72 700 Td (plain passthrough) Tj ET'
  const chainedRaw = deflateSync(L1('BT /F1 12 Tf 72 660 Td (chained filters) Tj ET'))
  const asciiHex = Buffer.from(chainedRaw.toString('hex') + '>', 'latin1')
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(plain).bytes,
    HELVETICA('WinAnsiEncoding'),
    PAGE('<< /Font << /F1 5 0 R >> >>', 7),
    { bytes: concat([`<< /Length ${asciiHex.length} /Filter [/ASCIIHexDecode /FlateDecode] >>\nstream\n`, asciiHex, '\nendstream']) }.bytes,
  ])
  const text = textOf(pdf).text
  assert.match(text, /plain passthrough/)
  assert.match(text, /chained filters/)
})

test('unsupported filters degrade to "no text" instead of throwing', TIMEOUT, () => {
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    { bytes: concat(['<< /Length 8 /Filter /DCTDecode >>\nstream\n', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), '\nendstream']) }.bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const out = textOf(pdf)
  assert.equal(out.text, '')
  assert.equal(out.pages, 1)
})

/* ==========================================================================
 * 3. Failure paths
 * ======================================================================== */

test('empty input throws a clear Error', TIMEOUT, async () => {
  await assert.rejects(
    withDeadline(() => extractPdfText(new Uint8Array(0))),
    (err) => err instanceof Error && /empty/i.test(err.message),
  )
})

test('non-PDF input throws a clear Error', TIMEOUT, async () => {
  await assert.rejects(
    withDeadline(() => extractPdfText(new TextEncoder().encode('this is definitely not a pdf at all'))),
    (err) => err instanceof Error && /not a pdf/i.test(err.message),
  )
})

test('truncated file either extracts a prefix or throws, but never hangs', TIMEOUT, async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (truncated but structured) Tj ET'
  const full = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  for (const cut of [20, 60, 120, 200]) {
    const slice = full.subarray(0, Math.min(cut, full.length))
    await withDeadline(() => {
      try {
        const out = extractPdfText(new Uint8Array(slice))
        assert.equal(typeof out.text, 'string')
      } catch (err) {
        assert.ok(err instanceof Error, 'a thrown value must be an Error')
        assert.ok(err.message.length > 0, 'the Error must carry a message')
      }
      return true
    })
  }
})

test('encrypted PDF throws an explanatory Error', TIMEOUT, async () => {
  const encDict = '<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef) /U (0123456789abcdef) /P -44 >>'
  const pdf = classicPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      PAGE('<< /Font << /F1 5 0 R >> >>', 4),
      streamBody('BT /F1 12 Tf 72 700 Td (hidden) Tj ET').bytes,
      HELVETICA('WinAnsiEncoding'),
      encDict,
    ],
    { extraTrailer: ' /Encrypt 6 0 R /ID [<01> <02>]' },
  )
  await assert.rejects(
    withDeadline(() => extractPdfText(new Uint8Array(pdf))),
    (err) => err instanceof Error && /encrypt/i.test(err.message) && !/hidden/.test(err.message),
  )
})

test('maxBytes is enforced before any parsing', TIMEOUT, async () => {
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody('BT /F1 12 Tf 72 700 Td (limit) Tj ET').bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  await assert.rejects(
    withDeadline(() => extractPdfText(new Uint8Array(pdf), { maxBytes: 64 })),
    (err) => err instanceof Error && /maxBytes/.test(err.message),
  )
})

test('malformed content stream operators do not abort the page', TIMEOUT, () => {
  const content = 'BT /F1 12 Tf 72 700 Td (before) Tj ET\n<< /Broken >> Tj\nBT /F1 12 Tf 72 660 Td (after) Tj ET'
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(content).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const text = textOf(pdf).text
  assert.match(text, /before/)
  assert.match(text, /after/)
})

/* ==========================================================================
 * 4. Limits / truncated flag
 * ======================================================================== */

test('maxChars sets truncated and bounds the output', TIMEOUT, () => {
  const long = `BT /F1 12 Tf 72 700 Td (${'abcdefghij'.repeat(20)}) Tj ET`
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody(long).bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const out = textOf(pdf, { maxChars: 25 })
  assert.equal(out.truncated, true)
  assert.ok(out.text.length <= 25, `text must be bounded, got ${out.text.length}`)
})

test('maxPages sets truncated and stops page collection', TIMEOUT, () => {
  const page = (label) => streamBody(`BT /F1 12 Tf 72 700 Td (${label}) Tj ET`).bytes
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R 8 0 R] /Count 3 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    page('alpha page'),
    HELVETICA('WinAnsiEncoding'),
    PAGE('<< /Font << /F1 5 0 R >> >>', 7),
    page('beta page'),
    PAGE('<< /Font << /F1 5 0 R >> >>', 9),
    page('gamma page'),
  ])
  const out = textOf(pdf, { maxPages: 2 })
  assert.equal(out.truncated, true)
  assert.equal(out.pages, 2)
  assert.match(out.text, /alpha page/)
  assert.match(out.text, /beta page/)
  assert.doesNotMatch(out.text, /gamma page/)

  const all = textOf(pdf)
  assert.equal(all.truncated, false)
  assert.equal(all.pages, 3)
})

test('maxObjects is honoured without throwing for well-formed input', TIMEOUT, () => {
  const pdf = classicPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    PAGE('<< /Font << /F1 5 0 R >> >>', 4),
    streamBody('BT /F1 12 Tf 72 700 Td (bounded) Tj ET').bytes,
    HELVETICA('WinAnsiEncoding'),
  ])
  const out = textOf(pdf, { maxObjects: 1000 })
  assert.match(out.text, /bounded/)
})

/* ==========================================================================
 * 5. Fixture-based oracle comparisons (network, best effort)
 * ======================================================================== */

const FIXTURE_URLS = [
  {
    name: 'w3c-dummy.pdf',
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    expect: ['dummy'],
  },
  {
    name: 'pdfobject-sample.pdf',
    url: 'https://pdfobject.com/pdf/sample.pdf',
    expect: ['pdf'],
  },
  {
    // 该样例带 /Encrypt（只有所有者口令、用户口令为空）。pdf.js 会用空口令解密并读出来，
    // 本实现**不实现解密**，因此这里断言的是"明确报错"这一既有契约，而不是提取文本。
    name: 'orimi-pdf-test.pdf',
    url: 'https://www.orimi.com/pdf-test.pdf',
    expect: [],
    encrypted: true,
  },
]

/**
 * A stable, tiny, self-contained multilingual PDF used when the network is
 * unavailable: it is generated locally by the repository's own writer, so the
 * oracle comparison also runs offline.
 */
async function localOracleFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-extract-oracle-'))
  const path = join(dir, 'local.pdf')
  const buffer = await writeLocalPdf(path, {
    title: 'Local Oracle Document',
    paragraphs: ['The quick brown fox jumps over the lazy dog.', 'Pack my box with five dozen liquor jugs.'],
  })
  return { name: 'local-writer-output.pdf', buffer }
}

test('oracle: local writer output matches pdf-parse word sets', TIMEOUT, async (t) => {
  const parse = await loadOracle()
  if (parse === false) {
    t.skip('pdf-parse is not installed; oracle comparison skipped')
    return
  }
  const fixture = await localOracleFixture()
  const mine = textOf(fixture.buffer)
  const theirs = await oracleText(fixture.buffer)
  if (theirs === null) {
    t.skip('pdf-parse could not parse the local fixture')
    return
  }
  const mineWords = words(mine.text)
  const theirWords = words(theirs)
  const missing = [...theirWords].filter((w) => !mineWords.has(w))
  assert.ok(mineWords.has('quick'), `expected "quick" in ${JSON.stringify(mine.text)}`)
  assert.ok(mineWords.has('lazy'), `expected "lazy" in ${JSON.stringify(mine.text)}`)
  assert.equal(missing.length, 0, `words the oracle found but we missed: ${missing.join(', ')}`)
})

for (const fixture of FIXTURE_URLS) {
  test(`oracle: fixture ${fixture.name}`, TIMEOUT, async (t) => {
    mkdirSync(FIXTURES, { recursive: true })
    const path = join(FIXTURES, fixture.name)
    let buffer = null
    if (existsSync(path)) {
      buffer = readFileSync(path)
    } else {
      try {
        const response = await fetch(fixture.url, { redirect: 'follow' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new Error('response was not a PDF')
        }
        writeFileSync(path, bytes)
        buffer = bytes
      } catch (err) {
        t.skip(`fixture ${fixture.name} unavailable offline (${err.message}); fixture assertions skipped`)
        return
      }
    }

    if (fixture.encrypted === true) {
      assert.throws(
        () => textOf(buffer),
        (err) => err instanceof Error && /encrypt/i.test(err.message),
        `${fixture.name}: 加密文档必须明确报错（本实现不解密）`,
      )
      return
    }

    const mine = textOf(buffer)
    assert.ok(mine.text.length > 0, `${fixture.name}: extractor produced no text`)
    assert.ok(mine.pages >= 1, `${fixture.name}: no pages reported`)

    const theirs = await oracleText(buffer)
    if (theirs === null) {
      t.diagnostic(`${fixture.name}: pdf-parse produced nothing, comparing against known words only`)
    } else {
      const mineWords = words(mine.text)
      const theirWords = words(theirs)
      const missing = [...theirWords].filter((w) => !mineWords.has(w))
      const coverage = theirWords.size === 0 ? 1 : 1 - missing.length / theirWords.size
      assert.ok(
        coverage >= 0.95,
        `${fixture.name}: only ${(coverage * 100).toFixed(1)}% of the oracle's words were found; missing: ${missing.slice(0, 25).join(', ')}`,
      )
    }
    for (const expected of fixture.expect) {
      assert.match(mine.text.toLowerCase(), new RegExp(expected), `${fixture.name}: expected "${expected}"`)
    }
  })
}

/* ==========================================================================
 * 6. Module hygiene
 * ======================================================================== */

test('module surface and documented gaps', TIMEOUT, () => {
  assert.equal(typeof extractPdfText, 'function')
  assert.ok(Array.isArray(UNSUPPORTED) && UNSUPPORTED.length > 0)
  assert.ok(TJ_FORWARD_WORD_GAP < 0, 'the forward word-gap threshold is a negative TJ adjustment')
})
