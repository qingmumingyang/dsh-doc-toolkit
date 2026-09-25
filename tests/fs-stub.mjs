/**
 * 测试用的 `ctx.fs` 宿主后端替身。
 *
 * 生产代码里**没有任何** `node:fs` 使用——插件的全部读写都走宿主的 `ctx.fs` 服务
 * （见 `src/utils/fs-channel.ts`）。因此测试必须自己提供一个等价后端，才能跑真实
 * 文件的往返用例。这个替身刻意对齐 `@deepseek-ai/dsh-fs-local` 的可观察行为：
 * 相对路径按 cwd 解析、`writeText` 原子写并**按需创建父目录**、`readBytes` 带字节上限、
 * `stat` 对不存在的目标返回 `undefined`。
 *
 * 它只存在于 `tests/`（不随包发布，也不进入 DSH STORE 的运行源码扫描面）。
 */
import { readFile, writeFile, stat, realpath, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 单次读取上限，与生产侧 `MAX_READ_BYTES` 保持一致。 */
const MAX_READ_BYTES = 64 * 1024 * 1024

/**
 * 建一个宿主文件系统替身。
 *
 * @param {{ baseCwd?: string }} [options] 无会话 cwd 时相对路径的解析基准。
 */
export function createHostFs(options = {}) {
  const baseCwd = options.baseCwd ?? process.cwd()

  return {
    /** 宿主本地后端不限制变更（与 dsh-fs-local 一致）。 */
    sandboxMode: undefined,

    async resolve(path, opts = {}) {
      if (typeof path !== 'string' || path.trim() === '') throw new Error('resolve: path 不能为空')
      const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : baseCwd
      const absolute = isAbsolute(path) ? path : resolve(cwd, path)
      // 已存在的目标取 realpath（与后端一致），尚不存在的目标用词法绝对路径。
      let key = absolute
      try {
        key = await realpath(absolute)
      } catch {
        key = absolute
      }
      return { targetKey: key, displayPath: key }
    },

    processPath(target) {
      return target.targetKey
    },

    contains(parent, child) {
      const rel = relative(parent.targetKey, child.targetKey)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    },

    async stat(target) {
      try {
        const info = await stat(target.targetKey)
        return {
          version: `${info.mtimeMs}`,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },

    async readBytes(target, _signal, maxBytes = MAX_READ_BYTES) {
      const buffer = await readFile(target.targetKey)
      if (buffer.byteLength > maxBytes) {
        throw new Error(`文件为 ${buffer.byteLength} 字节，超过上限 ${maxBytes} 字节`)
      }
      return new Uint8Array(buffer)
    },

    async writeText(target, content, _expected, _signal, _policy) {
      await mkdir(dirname(target.targetKey), { recursive: true })
      await writeFile(target.targetKey, content, 'utf8')
      return { operation: 'update', version: '1' }
    },
  }
}

/** 便于用例断言路径是否落在工作区内。 */
export function withinWorkspace(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export { sep }
