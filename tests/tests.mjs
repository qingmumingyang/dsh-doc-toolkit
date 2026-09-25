/**
 * dsh-doc-toolkit 自包含测试套件（node:test，无外部夹具依赖）。
 *
 * 运行方式：
 *   npm run build
 *   npm test
 *
 * 覆盖：插件加载、配置契约、卡片契约、CSV/XLSX/DOCX/PDF 读写往返、分页、
 * 引号转义、GBK 解码、超长内容截断、错误路径，以及内嵌 Skill 的同步性。
 *
 * 注意：生产代码不直接访问文件系统（全部经宿主 `ctx.fs`），因此这里用
 * `tests/fs-stub.mjs` 提供一个宿主后端替身来跑真实文件的往返用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../lib/index.js'
import { createHostFs } from './fs-stub.mjs'
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE
} from '../lib/skills/embedded-skill.js'

const WORK = mkdtempSync(join(tmpdir(), 'dsh-doc-test-'))
const exec = { signal: new AbortController().signal }

// ---------- 工具夹具：用假 ctx 跑 apply() ----------
const registered = []
const skills = []
const hostFs = createHostFs({ baseCwd: WORK })
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  skills: { register: (s) => { skills.push(s); return () => {} } },
  fs: hostFs,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  inject: (services, cb) => cb(ctx),
}
apply(ctx)
const tools = Object.fromEntries(registered.map((d) => [d.name, d]))
const readDoc = async (args) => JSON.parse(await tools.read_document.execute(args, exec))
const writeDoc = async (args) => tools.write_document.execute(args, exec)

/**
 * 扫描 src/ 与 lib/ 下的全部运行时源码，返回命中任一模式的相对路径。
 *
 * 这是对 DSH STORE 固定源策略的**回归保护**：任何一次重新引入直接文件访问、
 * 环境变量读取或凭据记号，都会在这里失败，而不是等 8 小时后被商城判为 blocked。
 */
async function scanRuntimeSources(patterns) {
  const { readFile, readdir } = await import('node:fs/promises')
  const roots = [
    fileURLToPath(new URL('../src', import.meta.url)),
    fileURLToPath(new URL('../lib', import.meta.url))
  ]
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(?:[cm]?[jt]s)$/.test(entry.name)) files.push(full)
    }
  }
  for (const dir of roots) await walk(dir)
  assert.ok(files.length > 0, '应扫描到源文件')
  const offenders = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    if (patterns.some((pattern) => pattern.test(source))) {
      offenders.push(file.slice(file.indexOf('doc-toolkit') + 'doc-toolkit'.length + 1).replace(/\\/g, '/'))
    }
  }
  return offenders
}

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
test('PDF 往返：write_document 生成后 read_document 提取文本（纯 ASCII，CI 无中文字体也能跑）', async () => {
  const file = join(WORK, 'out.pdf')
  const msg = await writeDoc({
    file_path: file,
    format: 'pdf',
    content: { title: 'Test PDF', paragraphs: ['Hello PDF World', 'Second line'] },
  })
  assert.ok(msg.includes('成功写入 PDF'), msg)
  const r = await readDoc({ file_path: file, format: 'pdf' })
  assert.ok(r.content.includes('Hello PDF World'), `应提取出文本，实际: ${JSON.stringify(r.content)}`)
  assert.equal(typeof r.pages, 'number')
})

test('PDF 中文导出：有系统中文字体时验证（无字体环境自动跳过）', async (t) => {
  const file = join(WORK, 'cn.pdf')
  const msg = await writeDoc({
    file_path: file,
    format: 'pdf',
    content: { title: '测试 PDF', paragraphs: ['第一行中文', '第二行中文'] },
  })
  if (msg.includes('未找到可用的系统中文字体')) {
    t.skip('当前环境无 CJK 字体，跳过中文 PDF 断言')
    return
  }
  assert.ok(msg.includes('成功写入 PDF'), msg)
  assert.ok(msg.includes('内嵌字体'), '应内嵌中文字体子集')
  const r = await readDoc({ file_path: file, format: 'pdf' })
  assert.ok(r.content.includes('测试 PDF'), `应提取出中文，实际: ${JSON.stringify(r.content)}`)
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

// ---------- Cordis 标准插件配置（替代已移除的环境变量） ----------
test('配置：导出 Config Schema，并为 cjkFonts 填充默认值', () => {
  assert.equal(typeof Config, 'function', 'Config 必须是可校验的 Schema')
  assert.deepEqual(Config({}), { cjkFonts: [] }, '缺省时应填充空数组')
  assert.deepEqual(Config({ cjkFonts: ['C:/Windows/Fonts/msyh.ttc'] }), { cjkFonts: ['C:/Windows/Fonts/msyh.ttc'] })
  assert.throws(() => Config({ cjkFonts: 'not-an-array' }), '非法类型必须被拒绝')
})

test('配置：带 cjkFonts 的 apply 仍注册全部工具', () => {
  const registered = []
  const fakeCtx = {
    tools: { register: (def) => { registered.push(def); return () => {} } },
    skills: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    inject: (services, cb) => cb(fakeCtx),
  }
  apply(fakeCtx, { cjkFonts: ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'] })
  assert.deepEqual(registered.map((d) => d.name).sort(), ['read_document', 'write_document'])
})

test('配置：运行时源码不含进程环境变量读取（DSH STORE credentials 信号）', async () => {
  const offenders = await scanRuntimeSources([/process\s*\.\s*env/])
  assert.deepEqual(offenders, [], `这些文件仍读取进程环境变量（会触发 STORE credentials 权限信号）: ${offenders.join(', ')}`)
})

test('合规：运行时源码不含任何直接文件系统访问（DSH STORE files 信号）', async () => {
  // 与 DSH-Store src/automation-source-policy.mjs 的 permissionSignals.files 同一套判定
  const offenders = await scanRuntimeSources([
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](?:node:)?(?:fs|fs\/promises)["']/i,
    /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i,
    /\$DSH_HOME|\.dsh\/profiles/i
  ])
  assert.deepEqual(offenders, [], `这些文件仍直接访问文件系统（会触发 STORE files 权限信号）: ${offenders.join(', ')}`)
})

test('合规：运行时源码不含被判定为凭据的敏感记号', async () => {
  const offenders = await scanRuntimeSources([
    /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i,
    /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i
  ])
  assert.deepEqual(offenders, [], `这些文件含被扫描器视为凭据的记号: ${offenders.join(', ')}`)
})

test('内嵌 Skill：与 skills/doc-toolkit-usage/SKILL.md 保持同步', () => {
  const skillPath = fileURLToPath(new URL('../skills/doc-toolkit-usage/SKILL.md', import.meta.url))
  const raw = readFileSync(skillPath, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  assert.ok(match, 'SKILL.md 必须有 YAML frontmatter')
  const get = (key) => {
    const kv = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])
    return kv ? kv[1].trim().replace(/^['"]|['"]$/g, '') : ''
  }
  assert.equal(SKILL_NAME, get('name'), 'SKILL.md 改名后必须重新生成 src/skills/embedded-skill.ts')
  assert.equal(SKILL_DESCRIPTION, get('description'), '描述已变化，请重新生成内嵌副本')
  assert.equal(SKILL_WHEN_TO_USE, get('whenToUse'), 'whenToUse 已变化，请重新生成内嵌副本')
  assert.equal(SKILL_CONTENT, `${(match[2] ?? '').trim()}\n`, '正文已变化，请重新生成内嵌副本')
})

test('加载：不读任何文件即可完成 apply（Skill 内容内嵌）', () => {
  // apply() 只应依赖注入的服务；工具夹具里的 ctx.fs 在注册期完全没被调用。
  const calls = []
  const spyFs = { ...createHostFs({ baseCwd: WORK }) }
  for (const key of ['resolve', 'stat', 'readBytes', 'writeText']) {
    spyFs[key] = (...args) => { calls.push(key); return hostFs[key](...args) }
  }
  const localRegistered = []
  const localCtx = {
    tools: { register: (def) => { localRegistered.push(def); return () => {} } },
    skills: { register: () => () => {} },
    fs: spyFs,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    inject: (services, cb) => cb(localCtx),
  }
  apply(localCtx, { cjkFonts: [] })
  assert.equal(localRegistered.length, 2, '应注册两个工具')
  assert.deepEqual(calls, [], `apply() 不应访问文件系统，实际调用了: ${calls.join(', ')}`)
})


// ---------- Tool 卡片契约（纯 presenter + 通用兜底） ----------
test('卡片：read_document 的 pending 卡片是 generic/read，并带 follow-along 位置', () => {
  const view = tools.read_document.presentCall({ file_path: 'D:/报告/年度.pdf', format: 'pdf', offset: 5 })
  assert.equal(view.card, 'generic')
  assert.equal(view.kind, 'read')
  assert.ok(view.title.includes('年度.pdf'), view.title)
  assert.deepEqual(view.locations, [{ path: 'D:/报告/年度.pdf', line: 5 }])
  // 无 offset 时不写 line，避免伪造行号
  assert.deepEqual(tools.read_document.presentCall({ file_path: 'a.pdf' }).locations, [{ path: 'a.pdf' }])
})

test('卡片：write_document 的 pending 卡片是 generic/edit，标题含格式与文件名', () => {
  const view = tools.write_document.presentCall({ file_path: 'D:/out/report.xlsx', format: 'xlsx', content: {} })
  assert.equal(view.card, 'generic')
  assert.equal(view.kind, 'edit')
  assert.ok(view.title.includes('XLSX') && view.title.includes('report.xlsx'), view.title)
  assert.deepEqual(view.locations, [{ path: 'D:/out/report.xlsx' }])
})

test('卡片：presenter 是确定性纯函数，且不把无界参数塞进卡片', () => {
  const args = { file_path: `D:/${'x'.repeat(500)}.pdf`, format: 'pdf' }
  const first = tools.read_document.presentCall(args)
  const second = tools.read_document.presentCall(args)
  assert.deepEqual(first, second, '同样的参数必须得到同样的卡片')
  assert.ok(first.title.length <= 80, `标题必须有界，实际 ${first.title.length} 字符`)
  assert.equal('rawInput' in first, false, '不暴露原始参数')
  assert.equal('content' in first, false, 'pending 卡片不带正文')
})

test('卡片：completed 成功走通用兜底（undefined），失败才替换标题', () => {
  const ok = { content: [{ type: 'text', text: 'ok' }], isError: false }
  const bad = { content: [{ type: 'text', text: 'boom' }], isError: true }
  assert.equal(tools.read_document.presentResult({ file_path: 'a.pdf' }, ok), undefined)
  assert.equal(tools.write_document.presentResult({ file_path: 'a.csv', format: 'csv', content: {} }, ok), undefined)
  assert.deepEqual(tools.read_document.presentResult({ file_path: 'a.pdf' }, bad), { card: 'generic', title: '读取文档失败' })
  assert.deepEqual(tools.write_document.presentResult({ file_path: 'a.csv', format: 'csv', content: {} }, bad), { card: 'generic', title: '生成文档失败' })
})


