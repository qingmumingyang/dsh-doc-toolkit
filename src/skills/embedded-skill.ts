/**
 * 随包 Skill 的**内嵌副本**——由 skills/doc-toolkit-usage/SKILL.md 生成，请勿手改。
 *
 * 为什么内嵌而不是运行时读文件：DSH STORE 的固定源自动策略把运行源码里任何文件读取
 * 记为 `files` 权限信号，插件一旦读盘就无法进入可安装状态。内嵌让插件零文件访问。
 * `tests/tests.mjs` 有一条同步性测试：改 SKILL.md 后必须重新生成本文件，否则测试失败。
 *
 * 生成方式（开发期一次性执行，生成器本身不进仓库运行源码）：
 *   读取 skills/doc-toolkit-usage/SKILL.md → 解析 frontmatter → 写入本文件
 */

/** Skill 名称（frontmatter name）。 */
export const SKILL_NAME = "doc-toolkit-usage"

/** Skill 描述（frontmatter description，模型据此判断何时加载）。 */
export const SKILL_DESCRIPTION = "当用户要求读取 PDF、Word (.docx)、Excel (.xlsx/.xls)、CSV 文档内容，或要求生成、导出、创建 DOCX/XLSX/CSV/PDF 文件时使用。覆盖大文件分页、表格转文档、中文 PDF 导出等常见办公场景。"

/** 何时使用（frontmatter whenToUse）。 */
export const SKILL_WHEN_TO_USE = "用户提到 pdf/docx/xlsx/xls/csv、Word/Excel/表格/文档读取或生成时。"

/**
 * 注册来源标签。`source` 是"这个 skill 由哪类来源产出"的标签（`bundled` = 随包提供），
 * 不是文件路径——本插件不再有对应的磁盘文件。
 */
export const SKILL_SOURCE = 'bundled'

/** Skill 正文（frontmatter 之后的 Markdown）。 */
export const SKILL_CONTENT = "# 文档工具包使用指南\n\n本插件提供两个工具：`read_document`（读取）和 `write_document`（写入）。\n\n## 读取文档（read_document）\n\n| 文件类型 | format 参数 | 返回内容 |\n|---------|------------|---------|\n| PDF | `pdf` | 文本层全文（扫描件无文本层，无法提取） |\n| Word (.docx) | `docx` | 原始文本 |\n| Excel (.xlsx/.xls) | `xlsx` | 每个工作表一行 `[Sheet: 名称]` 开头，行内以 Tab 分隔 |\n| CSV / TXT | `csv` | TSV 文本（支持引号包裹字段） |\n\n**基本调用：**\n```json\n{ \"file_path\": \"D:/报告.pdf\", \"format\": \"auto\" }\n```\n\n**大文件分页（务必使用，防止撑爆上下文）：**\n```json\n{ \"file_path\": \"D:/数据.xlsx\", \"format\": \"xlsx\", \"offset\": 1, \"limit\": 100 }\n```\n- `offset`：起始行号（从 1 开始），默认 1\n- `limit`：最大返回行数\n- 返回结果含 `total_lines` 总行数与 `truncated` 是否被截断标记；截断时继续用更大的 offset 翻页\n\n## 写入文档（write_document）\n\n| 格式 | content 结构 |\n|------|-------------|\n| DOCX | `{ \"paragraphs\": [\"段落1\", \"段落2\"] }` 或 `{ \"content\": \"纯文本，按换行分段\" }`，可选 `\"title\": \"文档标题\"` |\n| XLSX | `{ \"rows\": [[\"姓名\",\"年龄\"],[\"张三\",28]] }` 或 `{ \"data\": [{\"姓名\":\"张三\",\"年龄\":28}] }`，可选 `\"sheet_name\": \"工作表名\"` |\n| CSV | `{ \"rows\": [...] }`、`{ \"data\": [...] }` 或 `{ \"content\": \"纯文本\" }` |\n| PDF | `{ \"paragraphs\": [...] }` 或 `{ \"content\": \"纯文本\" }`，可选 `\"title\"`（居中大标题）与 `\"rows\"`（二维数组，渲染为表格，首行作表头） |\n\n**PDF 导出说明：**\n- 纯英文内容使用标准 Helvetica 字体，文件极小；含中文等内容自动查找系统 CJK 字体（Windows 用 SimHei 等，TTC/TTF 均可），子集化嵌入，**文本可复制、可搜索**。\n- 可用插件配置 `cjkFonts`（TTF/TTC 绝对路径数组）指定字体路径来覆盖自动查找。\n- 自动换行、分页（A4）；表格跨页时自动重复表头。\n- 字体缺失的字符（如 emoji）不会渲染，返回消息会注明缺失数量。\n\n**示例：生成一份 Word 报告：**\n```json\n{\n  \"file_path\": \"D:/销售报告.docx\",\n  \"format\": \"docx\",\n  \"content\": {\n    \"title\": \"2025 年度销售报告\",\n    \"paragraphs\": [\"本年度业绩增长 20%。\", \"展望明年，目标增长 30%。\"]\n  }\n}\n```\n\n**示例：导出 Excel：**\n```json\n{\n  \"file_path\": \"D:/成绩单.xlsx\",\n  \"format\": \"xlsx\",\n  \"content\": { \"rows\": [[\"姓名\", \"分数\"], [\"小明\", 95], [\"小红\", 88]] }\n}\n```\n\n**示例：导出 PDF（中文 + 表格）：**\n```json\n{\n  \"file_path\": \"D:/销售报告.pdf\",\n  \"format\": \"pdf\",\n  \"content\": {\n    \"title\": \"2025 年度销售报告\",\n    \"paragraphs\": [\"本年度业绩增长 20%。\", \"展望明年，目标增长 30%。\"],\n    \"rows\": [[\"产品\", \"销量\"], [\"A 系列\", 1200], [\"B 系列\", 860]]\n  }\n}\n```\n\n**示例：导出 CSV（字段含逗号时会自动加引号转义）：**\n```json\n{\n  \"file_path\": \"D:/成绩单.csv\",\n  \"format\": \"csv\",\n  \"content\": { \"rows\": [[\"姓名\", \"备注\"], [\"小明\", \"语文,数学 优秀\"]] }\n}\n```\n\n## 注意事项\n\n1. **扫描版 PDF 无法提取文字**（无文本层），不要承诺 OCR，可建议用户提供文本型 PDF。\n2. **加密 PDF 无法读取**：会返回明确错误，提示用户另存为未加密副本后重试。\n3. **大文件务必分页**：Excel/CSV 先用 `limit: 100` 试探，再按需翻页。\n4. **写入会覆盖已有文件**，执行前确认路径无误。\n5. **写入路径受会话沙箱约束**：`workspace-write`（默认）下只能写会话工作区内或临时目录；\n   写到工作区外会被拒绝并返回带模式的错误。需要写外部路径时，请让用户把会话切到完全访问模式。\n6. **路径建议用正斜杠**：`D:/报告.pdf`，避免反斜杠转义问题。\n7. Excel 读取时工作表之间以 `[Sheet: 名称]` 标记分隔，跨工作表翻页时行号连续累计。\n8. 单次读取超过 50,000 字符会截断并标记 `truncated: true`；PDF/DOCX 无法翻页，可缩小范围分段处理。\n"
