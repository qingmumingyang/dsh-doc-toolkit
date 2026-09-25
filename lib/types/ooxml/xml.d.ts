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
export declare function escapeXmlText(value: string): string;
/** 属性值转义：文本转义的基础上再加 `"` 与 `'`。 */
export declare function escapeXmlAttr(value: string): string;
/**
 * 反转义 XML 文本：解析 5 个预定义实体与十进制/十六进制字符引用。
 *
 * 未知实体、越界码点、残缺写法都原样保留；孤立的代理码元也会保留。
 */
export declare function decodeXmlText(value: string): string;
/**
 * 从一个原始标签字符串里读出 `name="..."`（单双引号都支持）并反转义。
 *
 * 属性名按「非名字字符边界」匹配，因此 `w:val` 不会被 `val` 误命中。
 */
export declare function readAttr(tag: string, name: string): string | undefined;
