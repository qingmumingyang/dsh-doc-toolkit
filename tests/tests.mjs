/**
 * dsh-doc-toolkit 自包含测试套件（node:test，无外部夹具依赖）。
 *
 * 运行方式：
 *   npm run build
 *   node --test test-output/tests.mjs
 *
 * 覆盖：插件加载、CSV/XLSX/DOCX/PDF 读写往返、分页、引号转义、
 * GBK 解码、超长内容截断、错误路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const WORK = mkdtempSync(join(tmpdir(), 'dsh-doc-test-'))
const exec = { signal: new AbortController().signal }

// ---------- 工具夹具：用假 ctx 跑 apply() ----------
const registered = []
const skills = []
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  skills: { register: (s) => { skills.push(s); return () => {} } },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  inject: (services, cb) => cb(ctx),
}
apply(ctx)
const tools = Object.fromEntries(registered.map((d) => [d.name, d]))
const readDoc = async (args) => JSON.parse(await tools.read_document.execute(args, exec))
const writeDoc = async (args) => tools.write_document.execute(args, exec)

// ---------- 插件加载 ----------
test('插件加载：注册 read_document / write_document 工具', () => {
  assert.ok(tools.read_document, 'read_document 未注册')
  assert.ok(tools.write_document, 'write_document 未注册')
})

test('插件加载：注册 doc-toolkit-usage skill（含必填 source）', () => {
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'doc-toolkit-usage')
  assert.equal(typeof skills[0].source, 'string', 'source 必填，否则 dsh-skill 加载校验失败')
  assert.ok(skills[0].content.includes('read_document'), 'skill 内容应包含工具用法')
})

// ---------- CSV 读写 ----------
test('CSV 往返：引号字段转义后正确还原', async () => {
  const file = join(WORK, 'quoted.csv')
  const msg = await writeDoc({
    file_path: file,
    format: 'csv',
    content: { rows: [['姓名', '备注'], ['张三', '语文,数学 优秀'], ['李四', '他说"你好"']] },
  })
  assert.ok(msg.includes('成功写入 CSV'), msg)

  const r = await readDoc({ file_path: file, format: 'csv' })
  assert.equal(r.content, '姓名\t备注\n张三\t语文,数学 优秀\n李四\t他说"你好"')
  assert.equal(r.total_lines, 3)
})

test('CSV 分页：offset/limit 窗口 + truncated 标记', async () => {
  const file = join(WORK, 'page.csv')
  writeFileSync(file, ['h1,h2', ...Array.from({ length: 50 }, (_, i) => `${i},v${i}`)].join('\n'), 'utf8')

  const p1 = await readDoc({ file_path: file, format: 'csv', offset: 1, limit: 5 })
  assert.equal(p1.content.split('\n').length, 5)
  assert.equal(p1.truncated, true)
  assert.equal(p1.total_lines, 51)

  const p2 = await readDoc({ file_path: file, format: 'csv', offset: 50, limit: 5 })
  assert.equal(p2.content, '48\tv48\n49\tv49')
  assert.equal(p2.truncated, false)
})

test('GBK 编码 CSV：自动回退解码中文不乱码', async () => {
  const file = join(WORK, 'gbk.csv')
  // "张三,28\r\n" 的 GBK 字节：张=D5C5 三=C8FD
  writeFileSync(file, Buffer.from([0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0x32, 0x38, 0x0d, 0x0a]))
  const r = await readDoc({ file_path: file, format: 'csv' })
  assert.equal(r.content, '张三\t28', `GBK 应正确解码，实际: ${JSON.stringify(r.content)}`)
})

test('超长内容：超过 50000 字符自动截断并标记 truncated', async () => {
  const file = join(WORK, 'huge.csv')
  writeFileSync(file, 'a,' + 'x'.repeat(60000) + '\n', 'utf8')
  const r = await readDoc({ file_path: file, format: 'csv' })
  assert.equal(r.truncated, true)
  assert.ok(r.content.length < 60000, '内容应被截断')
  assert.ok(r.content.includes('内容过长'), '应包含截断提示')
  assert.equal(r.total_lines, 1, 'total_lines 保持真实值')
})

// ---------- XLSX 读写 ----------
test('XLSX 往返：rows + 中文表名，读回一致', async () => {
  const file = join(WORK, 'out.xlsx')
  await writeDoc({
    file_path: file,
    format: 'xlsx',
    content: { rows: [['姓名', '年龄'], ['张三', 28], ['李四', 32]], sheet_name: '数据表' },
  })
  const r = await readDoc({ file_path: file, format: 'xlsx' })
  assert.ok(r.content.startsWith('[Sheet: 数据表]'))
  assert.ok(r.content.includes('张三\t28'))
  assert.equal(r.total_lines, 4)

  const w = await readDoc({ file_path: file, format: 'xlsx', offset: 3, limit: 2 })
  assert.equal(w.content, '张三\t28\n李四\t32')
})

test('XLSX 写入：data 对象数组（键作为表头）', async () => {
  const file = join(WORK, 'out-data.xlsx')
  await writeDoc({
    file_path: file,
    format: 'xlsx',
    content: { data: [{ 姓名: '小明', 分数: 95 }, { 姓名: '小红', 分数: 88 }] },
  })
  const r = await readDoc({ file_path: file, format: 'xlsx' })
  assert.ok(r.content.includes('小明\t95'))
  assert.ok(r.content.includes('小红\t88'))
})

// ---------- DOCX 读写 ----------
test('DOCX 往返：标题 + 段落读回验证', async () => {
  const file = join(WORK, 'out.docx')
  const msg = await writeDoc({
    file_path: file,
    format: 'docx',
    content: { title: '测试报告', paragraphs: ['第一段', '第二段'] },
  })
  assert.ok(msg.includes('成功写入 DOCX'), msg)
  const r = await readDoc({ file_path: file, format: 'docx' })
  assert.ok(r.content.includes('测试报告'))
  assert.ok(r.content.includes('第一段'))
  assert.ok(r.content.includes('第二段'))
})

// ---------- PDF 读写 ----------
test('PDF 往返：write_document 生成后 read_document 提取文本', async () => {
  const file = join(WORK, 'out.pdf')
  const msg = await writeDoc({
    file_path: file,
    format: 'pdf',
    content: { title: '测试 PDF', paragraphs: ['Hello PDF World', '第二行内容'] },
  })
  assert.ok(msg.includes('成功写入 PDF'), msg)
  const r = await readDoc({ file_path: file, format: 'pdf' })
  assert.ok(r.content.includes('Hello PDF World'), `应提取出文本，实际: ${JSON.stringify(r.content)}`)
  assert.equal(typeof r.pages, 'number')
})

test('PDF：损坏文件应优雅报错且不挂起', async () => {
  const file = join(WORK, 'broken.pdf')
  writeFileSync(file, 'this is not a pdf at all %PDF-')
  const r = await readDoc({ file_path: file, format: 'pdf' })
  assert.ok('error' in r && typeof r.error === 'string', `应返回 error，实际: ${JSON.stringify(r)}`)
})

// ---------- 错误路径 ----------
test('未知扩展名：返回格式错误提示', async () => {
  const r = await readDoc({ file_path: join(WORK, 'nope.xyz'), format: 'auto' })
  assert.ok('error' in r && r.error.includes('无法识别文件格式'))
})

test('文件不存在：返回读取失败提示', async () => {
  const r = await readDoc({ file_path: join(WORK, 'missing.pdf'), format: 'pdf' })
  assert.ok('error' in r && r.error.includes('读取文件失败'))
})

test('写入：content 缺少必需字段时返回明确错误', async () => {
  const msg = await writeDoc({ file_path: join(WORK, 'bad.xlsx'), format: 'xlsx', content: {} })
  assert.ok(msg.includes('rows') && msg.includes('data'), msg)
})

test('写入：自动创建父目录', async () => {
  const file = join(WORK, 'nested', 'deep', 'out.csv')
  const msg = await writeDoc({ file_path: file, format: 'csv', content: { rows: [['a', 'b']] } })
  assert.ok(msg.includes('成功写入 CSV'), msg)
  const r = await readDoc({ file_path: file, format: 'csv' })
  assert.equal(r.content, 'a\tb')
})
