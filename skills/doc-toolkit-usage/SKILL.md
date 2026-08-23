---
name: doc-toolkit-usage
description: 当用户要求读取 PDF、Word (.docx)、Excel (.xlsx/.xls)、CSV 文档内容，或要求生成、导出、创建 DOCX/XLSX/CSV/PDF 文件时使用。覆盖大文件分页、表格转文档、中文 PDF 导出等常见办公场景。
whenToUse: 用户提到 pdf/docx/xlsx/xls/csv、Word/Excel/表格/文档读取或生成时。
---

# 文档工具包使用指南

本插件提供两个工具：`read_document`（读取）和 `write_document`（写入）。

## 读取文档（read_document）

| 文件类型 | format 参数 | 返回内容 |
|---------|------------|---------|
| PDF | `pdf` | 文本层全文（扫描件无文本层，无法提取） |
| Word (.docx) | `docx` | 原始文本 |
| Excel (.xlsx/.xls) | `xlsx` | 每个工作表一行 `[Sheet: 名称]` 开头，行内以 Tab 分隔 |
| CSV / TXT | `csv` | TSV 文本（支持引号包裹字段） |

**基本调用：**
```json
{ "file_path": "D:/报告.pdf", "format": "auto" }
```

**大文件分页（务必使用，防止撑爆上下文）：**
```json
{ "file_path": "D:/数据.xlsx", "format": "xlsx", "offset": 1, "limit": 100 }
```
- `offset`：起始行号（从 1 开始），默认 1
- `limit`：最大返回行数
- 返回结果含 `total_lines` 总行数与 `truncated` 是否被截断标记；截断时继续用更大的 offset 翻页

## 写入文档（write_document）

| 格式 | content 结构 |
|------|-------------|
| DOCX | `{ "paragraphs": ["段落1", "段落2"] }` 或 `{ "content": "纯文本，按换行分段" }`，可选 `"title": "文档标题"` |
| XLSX | `{ "rows": [["姓名","年龄"],["张三",28]] }` 或 `{ "data": [{"姓名":"张三","年龄":28}] }`，可选 `"sheet_name": "工作表名"` |
| CSV | `{ "rows": [...] }`、`{ "data": [...] }` 或 `{ "content": "纯文本" }` |
| PDF | `{ "paragraphs": [...] }` 或 `{ "content": "纯文本" }`，可选 `"title"`（居中大标题）与 `"rows"`（二维数组，渲染为表格，首行作表头） |

**PDF 导出说明：**
- 纯英文内容使用标准 Helvetica 字体，文件极小；含中文等内容自动查找系统 CJK 字体（Windows 用 SimHei 等，TTC/TTF 均可），子集化嵌入，**文本可复制、可搜索**。
- 可用环境变量 `DSH_CJK_FONT` 指定字体路径（TTF/TTC，分号分隔多个）来覆盖自动查找。
- 自动换行、分页（A4）；表格跨页时自动重复表头。
- 字体缺失的字符（如 emoji）不会渲染，返回消息会注明缺失数量。

**示例：生成一份 Word 报告：**
```json
{
  "file_path": "D:/销售报告.docx",
  "format": "docx",
  "content": {
    "title": "2025 年度销售报告",
    "paragraphs": ["本年度业绩增长 20%。", "展望明年，目标增长 30%。"]
  }
}
```

**示例：导出 Excel：**
```json
{
  "file_path": "D:/成绩单.xlsx",
  "format": "xlsx",
  "content": { "rows": [["姓名", "分数"], ["小明", 95], ["小红", 88]] }
}
```

**示例：导出 PDF（中文 + 表格）：**
```json
{
  "file_path": "D:/销售报告.pdf",
  "format": "pdf",
  "content": {
    "title": "2025 年度销售报告",
    "paragraphs": ["本年度业绩增长 20%。", "展望明年，目标增长 30%。"],
    "rows": [["产品", "销量"], ["A 系列", 1200], ["B 系列", 860]]
  }
}
```

**示例：导出 CSV（字段含逗号时会自动加引号转义）：**
```json
{
  "file_path": "D:/成绩单.csv",
  "format": "csv",
  "content": { "rows": [["姓名", "备注"], ["小明", "语文,数学 优秀"]] }
}
```

## 注意事项

1. **扫描版 PDF 无法提取文字**（无文本层），不要承诺 OCR，可建议用户提供文本型 PDF。
2. **大文件务必分页**：Excel/CSV 先用 `limit: 100` 试探，再按需翻页。
3. **写入会覆盖已有文件**，执行前确认路径无误。
4. **路径建议用正斜杠**：`D:/报告.pdf`，避免反斜杠转义问题。
5. Excel 读取时工作表之间以 `[Sheet: 名称]` 标记分隔，跨工作表翻页时行号连续累计。
