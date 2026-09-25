/**
 * OOXML 共用的 XML 文本工具：转义、反转义、读属性。
 *
 * 设计要点：
 * - 纯函数、全定义（任何输入都不抛异常），不做任何输入输出。
 * - 转义是「ASCII 安全」的：所有非 ASCII 码点一律写成数字字符引用
 *   （`&#xNNNN;`）。这样生成的 XML 全是 ASCII，经 UTF-8 文本通道写盘
 *   或塞进 ZIP 都不会被损坏。星平面码点用 `u` 标志按码点整体匹配，
 *   因此代理对会输出成一个完整码点（如 `&#x1F600;`）而不是两个半个。
 * - 反转义只认 5 个预定义实体 + 十进制/十六进制数字字符引用，
 *   不认识的写法原样保留（绝不吞字符）。
 */

/** 文本节点转义：`&` `<` `>` 加全部非 ASCII。 */
export function escapeXmlText(value: string): string {
  let out = ''
  let start = 0
  // 一次扫描同时处理需要转义的 ASCII 与所有非 ASCII 码点。
  const pattern = /[&<>\u0080-\u{10FFFF}]/gu
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    const index = match.index
    out += value.slice(start, index) + escapeCodePoint(match[0])
    start = index + match[0].length
  }
  return out + value.slice(start)
}

/** 属性值转义：文本转义的基础上再加 `"` 与 `'`。 */
export function escapeXmlAttr(value: string): string {
  let out = ''
  let start = 0
  const pattern = /["'&<>\u0080-\u{10FFFF}]/gu
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    const index = match.index
    out += value.slice(start, index) + escapeCodePoint(match[0])
    start = index + match[0].length
  }
  return out + value.slice(start)
}

/** 单个字符/码点的转义结果；已是 ASCII 且不需转义的字符原样返回。 */
function escapeCodePoint(char: string): string {
  switch (char) {
    case '&':
      return '&amp;'
    case '<':
      return '&lt;'
    case '>':
      return '&gt;'
    case '"':
      return '&quot;'
    case "'":
      return '&apos;'
    default:
      break
  }
  const code = char.codePointAt(0)
  if (code === undefined || code < 0x80) return char
  return `&#x${code.toString(16).toUpperCase()};`
}

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/**
 * 反转义 XML 文本：解析 5 个预定义实体与十进制/十六进制字符引用。
 *
 * 未知实体、越界码点、残缺写法都原样保留；孤立的代理码元也会保留。
 */
export function decodeXmlText(value: string): string {
  if (value.indexOf('&') < 0) return value
  let out = ''
  let index = 0
  while (index < value.length) {
    const amp = value.indexOf('&', index)
    if (amp < 0) {
      out += value.slice(index)
      break
    }
    out += value.slice(index, amp)
    const semi = value.indexOf(';', amp + 1)
    // 实体最长也就 `&#x10FFFF;` 这种长度，超出范围就不用再找了。
    if (semi < 0 || semi - amp > 12) {
      out += '&'
      index = amp + 1
      continue
    }
    const body = value.slice(amp + 1, semi)
    const decoded = decodeEntityBody(body)
    if (decoded === undefined) {
      out += value.slice(amp, semi + 1)
    } else {
      out += decoded
    }
    index = semi + 1
  }
  return out
}

/** 解析实体名/数字体，失败返回 undefined（调用方决定保留原文）。 */
function decodeEntityBody(body: string): string | undefined {
  if (body.length === 0) return undefined
  if (body.charCodeAt(0) !== 0x23 /* # */) {
    // 命名实体：只认 5 个预定义实体。
    const known = PREDEFINED[body]
    return known
  }
  const digits = body.slice(1)
  const hex = digits.length > 1 && (digits[0] === 'x' || digits[0] === 'X')
  const text = hex ? digits.slice(1) : digits
  if (text.length === 0) return undefined
  const valid = hex ? /^[0-9a-fA-F]+$/.test(text) : /^[0-9]+$/.test(text)
  if (!valid) return undefined
  const code = Number.parseInt(text, hex ? 16 : 10)
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined
  // 代理区码点单独出现不是合法字符，按原样保留更安全。
  if (code >= 0xd800 && code <= 0xdfff) return undefined
  return String.fromCodePoint(code)
}

/**
 * 从一个原始标签字符串里读出 `name="..."`（单双引号都支持）并反转义。
 *
 * 属性名按「非名字字符边界」匹配，因此 `w:val` 不会被 `val` 误命中。
 */
export function readAttr(tag: string, name: string): string | undefined {
  if (name.length === 0) return undefined
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|[^\\w:.-])${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`)
  const match = pattern.exec(tag)
  if (!match) return undefined
  const raw = match[2] !== undefined ? match[2] : match[3]
  if (raw === undefined) return undefined
  return decodeXmlText(raw)
}
