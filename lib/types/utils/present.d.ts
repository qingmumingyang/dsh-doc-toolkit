/**
 * 卡片契约（DSH Tool card boundary）的共用纯函数。
 *
 * 规则（见 build-dsh-plugin 的 references/boundaries.md 第 5 节）：
 * presenter 必须是对「已校验参数 + 持久结果字段」的**确定性纯函数**——
 * 不做 I/O、不读当前会话/Profile、不取时钟/随机数、不依赖可变全局。
 * 因此这里只做字符串处理，并把长度收在界内。
 */
/**
 * 从模型给的路径取出用于卡片标题的短名字。
 *
 * 纯函数：只依赖入参字符串。取最后一段路径分量（兼容 `/` 与 `\`），
 * 超长时按 `MAX_NAME_CHARS` 截断并加省略号。
 */
export declare function shortName(value: unknown): string;
