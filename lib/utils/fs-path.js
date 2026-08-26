import path from 'node:path';
/**
 * 把工具参数中的文件路径解析为可用于 node:fs 的绝对路径。
 *
 * 为什么需要这一步：插件用 node:fs 直接读写文件（PDF/DOCX/XLSX 是二进制，
 * ctx.fs 只有文本 API），但 node:fs 的"相对路径"是相对于宿主进程 cwd 的，
 * 而 DSH 的会话工作区可能不同。ctx.fs.resolve 会按 DSH 后端语义解析
 * （相对路径以会话工作区为基准，绝对路径直接规范化），所以：
 * - 绝对路径：原样返回（行为与之前完全一致，零风险）
 * - 相对路径：优先用 ctx.fs.resolve 解析（继承工作区/沙箱路径语义），
 *   后端不可用时回退原路径
 */
export async function resolveFilePath(ctx, filePath, signal) {
    if (filePath.trim().length === 0)
        return filePath;
    if (!path.isAbsolute(filePath) && ctx.fs) {
        try {
            const target = await ctx.fs.resolve(filePath, { signal });
            if (target && typeof target.displayPath === 'string' && target.displayPath.length > 0) {
                return target.displayPath;
            }
        }
        catch {
            // fs 后端不可用/解析失败：回退原路径
        }
    }
    return filePath;
}
