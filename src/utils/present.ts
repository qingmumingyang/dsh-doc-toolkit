/**
 * 卡片契约（DSH Tool card boundary）的共用纯函数。
 *
 * 规则（见 build-dsh-plugin 的 references/boundaries.md 第 5 节）：
 * presenter 必须是对「已校验参数 + 持久结果字段」的**确定性纯函数**——
 * 不做 I/O、不读当前会话/Profile、不取时钟/随机数、不依赖可变全局。
 * 因此这里只做字符串处理，并把长度收在界内。
 */

/** presenter 标题里显示的文件名长度上限（防止超长路径撑爆卡片标题）。 */
const MAX_NAME_CHARS = 60

/**
 * 从模型给的路径取出用于卡片标题的短名字。
 *
 * 纯函数：只依赖入参字符串。取最后一段路径分量（兼容 `/` 与 `\`），
 * 超长时按 `MAX_NAME_CHARS` 截断并加省略号。
 */
export function shortName(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  const parts = raw.split(/[\\/]/).filter((part) => part.length > 0)
  const base = parts.length > 0 ? parts[parts.length - 1] : raw
  return base.length > MAX_NAME_CHARS ? `${base.slice(0, MAX_NAME_CHARS - 1)}…` : base
}
