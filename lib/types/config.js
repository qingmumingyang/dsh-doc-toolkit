/**
 * 插件配置（Cordis 标准配置入口）。
 *
 * 为什么用插件配置而不是环境变量：
 * DSH STORE 的固定源自动策略会把运行时源码里任何“进程环境变量读取”记为
 * credentials 权限信号（见 DSH-Store 的 src/automation-source-policy.mjs，
 * permissionSignals.credentials 的第一条规则），即便读到的只是字体路径这类
 * 非敏感值，条目也会被判为 blocked。Cordis 的标准配置入口是
 * `apply(ctx, config)` 配合导出的 Config Schema，由 Bundle Patch 中该插件行的
 * `config:` 字段传入，因此本插件不再读取任何进程环境变量。
 */
/** 把任意配置输入规范化为字符串数组：忽略非字符串、空白项与首尾空格。 */
export function normalizeCjkFonts(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
