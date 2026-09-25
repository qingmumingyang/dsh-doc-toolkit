/**
 * 与**真实**宿主文件系统服务的契约测试。
 *
 * 为什么需要它：`tests/fs-stub.mjs` 是我方替身，只能证明"调用顺序自洽"，
 * 不能证明与官方 `ctx.fs` 的调用约定一致（参数顺序、FsTarget 形状、cwd 语义、
 * 相对路径解析、父目录创建）。这里挂载真实的 `@deepseek-ai/dsh-fs-local`，
 * 用真实 cordis Context 跑一遍写入/读取，任何签名漂移都会立刻暴露。
 *
 * 找不到本机 DSH 安装时整组跳过（CI 上没有 DSH 安装，属于预期跳过而不是失败）。
 * 可用 `DSH_HOME` 指定安装位置；缺省回退到 `%USERPROFILE%\.dsh` / `~/.dsh`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

/** 在候选位置里找出一个含 @deepseek-ai 依赖的 profile node_modules。 */
function findProfileModules() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const candidates = [
    join(home, 'profiles', 'node_modules'),
    join(home, 'profiles', 'web', 'node_modules'),
  ]
  return candidates.find((dir) =>
    existsSync(join(dir, '@deepseek-ai', 'cordis')) &&
    existsSync(join(dir, '@deepseek-ai', 'dsh-fs-local'))) ?? null
}

const profileModules = findProfileModules()
const skip = profileModules === null
  ? '本机未找到 DSH 安装（设置 DSH_HOME 可启用该契约测试）'
  : false

test('真实后端：经 ctx.fs 写入并读回，含中文与自动创建父目录', { skip }, async () => {
  const base = pathToFileURL(join(profileModules, '@deepseek-ai') + '/').href
  const { Context } = await import(`${base}cordis/lib/index.js`)
  const { LocalFileSystem } = await import(`${base}dsh-fs-local/lib/index.js`)

  const work = mkdtempSync(join(tmpdir(), 'dsh-real-fs-'))
  const root = new Context()
  const registered = []
  const ctx = root
  ctx.tools = { register: (def) => { registered.push(def); return () => {} } }
  ctx.skills = { register: () => () => {} }
  ctx.plugin(LocalFileSystem, { cwd: work })
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(typeof root.fs, 'object', 'ctx.fs 未挂载')
  assert.equal(typeof root.fs.readBytes, 'function')
  assert.equal(typeof root.fs.writeText, 'function')
  assert.equal(typeof root.fs.resolve, 'function')

  apply(root, { cjkFonts: [] })
  const tools = Object.fromEntries(registered.map((def) => [def.name, def]))
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: work } } } }

  // 1) 写入：相对路径 + 不存在的多级父目录（后端负责按需创建）
  const writeResult = await tools.write_document.execute({
    file_path: join('nested', 'deep', 'round-trip.csv'),
    format: 'csv',
    content: { rows: [['姓名', '分数'], ['张三', 95], ['李四', '语文,数学 优秀']] },
  }, exec)
  assert.ok(writeResult.includes('成功写入 CSV'), writeResult)

  // 2) 读取：工作区相对路径 + 中文 + 引号转义还原
  const readResult = JSON.parse(await tools.read_document.execute({
    file_path: 'nested/deep/round-trip.csv',
    format: 'csv',
  }, exec))
  assert.equal(readResult.total_lines, 3)
  assert.equal(readResult.content, '姓名\t分数\n张三\t95\n李四\t语文,数学 优秀')

  // 3) 不存在的文件 → 结构化错误，且显示路径被相对化
  const missing = JSON.parse(await tools.read_document.execute({ file_path: 'nope.pdf', format: 'pdf' }, exec))
  assert.match(missing.error, /文件不存在/)
  assert.equal(missing.file_path, 'nope.pdf')

  // 4) 绝不越权：绝对路径落在工作区外时由后端/沙箱策略裁决，插件本身不拼接路径
  const outside = await tools.write_document.execute({
    file_path: join(tmpdir(), 'dsh-outside-write.csv'),
    format: 'csv',
    content: { rows: [['a']] },
  }, exec)
  assert.equal(typeof outside, 'string', '写工作区外必须得到一个结果字符串（成功或结构化错误）')
})
