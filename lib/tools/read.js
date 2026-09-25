import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { extractPdfText } from '../pdf/text-extract.js';
import { readZip } from '../zip/read.js';
import { readDocxText } from '../ooxml/docx.js';
import { readXlsxSheets } from '../ooxml/xlsx.js';
import { readTargetBytes, resolveDocumentTarget, MAX_READ_BYTES } from '../utils/fs-channel.js';
import { shortName } from '../utils/present.js';
/** 单次返回的最大字符数（PDF/DOCX 全文可能很长，超出后截断并标记，防止撑爆上下文）。 */
const MAX_TEXT_CHARS = 50000;
/** 单次解析的最大页数/字符数上限（解析器内部的硬边界，防止恶意文件拖垮进程）。 */
const PDF_LIMITS = { maxBytes: MAX_READ_BYTES, maxPages: 2000, maxChars: 4000000 };
/**
 * RFC 4180 风格的 CSV 解析：支持双引号包裹字段、字段内逗号/换行/转义双引号。
 */
function parseCSVRows(content) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (inQuotes) {
            if (ch === '"') {
                if (content[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                field += ch;
            }
        }
        else if (ch === '"') {
            inQuotes = true;
        }
        else if (ch === ',') {
            row.push(field);
            field = '';
        }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && content[i + 1] === '\n')
                i++;
            row.push(field);
            field = '';
            rows.push(row);
            row = [];
        }
        else {
            field += ch;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
/**
 * 解码文件字节为文本：优先严格 UTF-8，失败（含非法序列）时回退 GBK——
 * 中国用户常见的 Excel 导出 CSV 是 GBK/GB18030 编码，零依赖自动兼容。
 */
function decodeText(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return new TextDecoder('gbk').decode(bytes);
    }
}
/** 在"行"级别做 offset/limit 窗口切片，并回报总行数与是否被截断。 */
function windowLines(lines, offset, limit) {
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
    return {
        text: lines.slice(start, end).join('\n'),
        total: lines.length,
        truncated: end < lines.length
    };
}
/** CSV/TXT → TSV 行（超长行按 MAX_TEXT_CHARS 截断，避免单行撑爆上下文）。 */
function readCsvLines(bytes) {
    let content = decodeText(bytes);
    if (content.charCodeAt(0) === 0xfeff)
        content = content.slice(1); // 去掉 UTF-8 BOM
    return parseCSVRows(content).map((row) => row.join('\t'));
}
/** 工作簿 → `[Sheet: 名称]` + 每行 TSV，跨表连续计数以便分页。 */
function readXlsxLines(bytes) {
    const lines = [];
    for (const sheet of readXlsxSheets(readZip(bytes))) {
        lines.push(`[Sheet: ${sheet.name}]`);
        for (const row of sheet.rows) {
            lines.push(row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join('\t'));
        }
    }
    return lines;
}
function detectFormat(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.pdf': 'pdf',
        '.docx': 'docx',
        '.xlsx': 'xlsx',
        '.xls': 'xlsx',
        '.csv': 'csv',
        '.txt': 'csv'
    };
    return map[ext] || 'unknown';
}
export function registerReadTools(ctx) {
    ctx.tools.register(defineTool({
        name: 'read_document',
        description: `读取 PDF、DOCX、XLSX、CSV 等文档文件的内容并返回纯文本/TSV。
支持格式：PDF（提取文本层）、DOCX（提取原始文本）、XLSX（逐工作表读取为 TSV 行）、CSV（UTF-8，支持引号包裹字段）。
大文件请用 offset/limit 参数分页，防止返回内容超出上下文窗口。
注意：扫描版 PDF（无文本层）无法提取文字。`,
        parameters: {
            file_path: {
                type: 'string',
                required: true,
                description: '文件路径（绝对路径，或相对于工作区的路径）'
            },
            format: {
                type: 'string',
                enum: ['pdf', 'docx', 'xlsx', 'csv', 'auto'],
                description: '文件格式，设为 auto（默认）时根据扩展名自动识别'
            },
            offset: {
                type: 'number',
                description: '起始行号（从 1 开始，仅对 CSV/XLSX 有效）'
            },
            limit: {
                type: 'number',
                description: '最大返回行数（仅对 CSV/XLSX 有效，防止大文件撑爆上下文）'
            }
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }]
        },
        // 卡片契约：pending 卡片只读已校验参数；completed 卡片只在失败时替换标题，
        // 成功时返回 undefined，交给 UI 的通用兜底渲染模型可见正文（不重复编码）。
        presentCall: (args) => ({
            card: 'generic',
            title: `读取文档 ${shortName(args.file_path)}`,
            kind: 'read',
            locations: [
                {
                    path: args.file_path,
                    ...(typeof args.offset === 'number' && args.offset > 0 ? { line: args.offset } : {})
                }
            ]
        }),
        presentResult: (_args, result) => (result.isError ? { card: 'generic', title: '读取文档失败' } : undefined),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            // 相对路径按会话工作区解析；绝对路径交给后端（读不受沙箱围栏限制）
            const target = await resolveDocumentTarget(ctx, exec, args.file_path, exec.signal);
            const format = args.format === 'auto' || !args.format ? detectFormat(target.absolute) : args.format;
            if (format === 'unknown') {
                return JSON.stringify({
                    error: `无法识别文件格式: ${target.display}`,
                    supported: ['pdf', 'docx', 'xlsx', 'csv', 'txt']
                }, null, 2);
            }
            const result = { content: '', format, total_lines: 0 };
            try {
                switch (format) {
                    case 'pdf': {
                        const bytes = await readTargetBytes(ctx, target, exec.signal);
                        const parsed = extractPdfText(bytes, PDF_LIMITS);
                        result.content = parsed.text;
                        result.total_lines = parsed.text.split('\n').length;
                        result.pages = parsed.pages;
                        if (parsed.truncated)
                            result.warnings = ['PDF 内容超过解析上限，仅提取了前面部分'];
                        break;
                    }
                    case 'docx': {
                        const bytes = await readTargetBytes(ctx, target, exec.signal);
                        result.content = readDocxText(readZip(bytes));
                        result.total_lines = result.content.split('\n').length;
                        break;
                    }
                    case 'xlsx': {
                        const bytes = await readTargetBytes(ctx, target, exec.signal);
                        const win = windowLines(readXlsxLines(bytes), args.offset, args.limit);
                        result.content = win.text;
                        result.total_lines = win.total;
                        result.truncated = win.truncated;
                        break;
                    }
                    case 'csv': {
                        const bytes = await readTargetBytes(ctx, target, exec.signal);
                        const win = windowLines(readCsvLines(bytes), args.offset, args.limit);
                        result.content = win.text;
                        result.total_lines = win.total;
                        result.truncated = win.truncated;
                        break;
                    }
                    default:
                        return JSON.stringify({ error: `不支持的格式: ${format}` }, null, 2);
                }
            }
            catch (err) {
                return JSON.stringify({
                    error: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
                    file_path: target.display,
                    format
                }, null, 2);
            }
            // 字符级兜底截断：PDF/DOCX 全文或超长行可能远超上下文窗口
            if (result.content.length > MAX_TEXT_CHARS) {
                result.content = result.content.slice(0, MAX_TEXT_CHARS) +
                    `\n... (内容过长，已截取前 ${MAX_TEXT_CHARS} 字符；PDF/DOCX 无法翻页，可分段处理或缩小文档范围)`;
                result.truncated = true;
            }
            if (args.offset)
                result.offset = args.offset;
            if (args.limit)
                result.limit = args.limit;
            return JSON.stringify(result, null, 2);
        }
    }));
}
