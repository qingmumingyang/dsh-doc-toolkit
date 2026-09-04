# DSH Doc Toolkit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![CI](https://img.shields.io/badge/CI-GitHub%20Actions-green)](.github/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)](package.json)

**DSH Doc Toolkit** 是一个为 DeepSeek Harness (DSH) 设计的文档读写插件，让 AI 助手能够直接读取和生成 **PDF、Word (.docx)、Excel (.xlsx)、CSV** 等常用办公文档。

---

## ✨ 功能特性

| 功能 | 支持格式 | 说明 |
|------|----------|------|
| 📖 **读取文档** | PDF、DOCX、XLSX、CSV | 提取文本内容（PDF 需含文本层，扫描件不支持 OCR） |
| ✏️ **写入文档** | DOCX、XLSX、CSV、PDF | 从结构化数据生成文档；PDF 支持标题/段落/表格，中文自动嵌入字体 |
| 📄 **大文件分页** | XLSX、CSV | 通过 `limit` 和 `offset` 参数控制返回行数，防止撑爆上下文 |
| 🈶 **中文 PDF 导出** | PDF | 自动查找系统 CJK 字体（TTF/TTC）并子集化嵌入，文本可复制、可搜索 |
| 🧠 **AI 友好** | 所有格式 | 解析结果直接返回纯文本/TSV，方便大模型理解 |
| 🧩 **内置 Skill** | 所有格式 | 插件加载时自动注册 `doc-toolkit-usage` 技能，教 AI 何时及如何调用工具 |

---

## 🚀 快速安装

### 前置条件

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面版 / Web 运行时，兼容 **DSH v0.1.0-rc.12 → v0.1.2-alpha.5** 版本谱系（含 v0.1.0-rc 系列、v0.1.1-rc 系列、v0.1.2-alpha 系列）。本插件的 v0.1.1 在保持对 v0.1.0-rc.12 向后兼容的基础上，新增对 **v0.1.2-alpha.5** 的适配，并已在 DSH 0.1.2-alpha.5 上实测通过（`@deepseek-ai/dsh`、`@deepseek-ai/dsh-tools` 均为 0.1.2-alpha.5，cordis 4.0.2）
- Node.js v18+ 与 npm（仅安装/开发时需要，运行时由 DSH 提供）

> 💡 **还没有 DSH 0.1.2-alpha.5？两种方式装一个**
>
> **方式 A：官方源码运行时（推荐开发者）**
> 到官方仓库的 [dsh-v0.1.2-alpha.5 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5) 按文档安装 `@deepseek-ai/dsh@0.1.2-alpha.5` 并启动 `dsh web`。
>
> **方式 B：桌面版安装包（推荐普通用户，Windows/macOS/Linux）**
> 从社区桌面发行版 [open-deepseek-harness-desktop](https://github.com/flaqai/open-deepseek-harness-desktop) 的 [odsh-v0.1.2-alpha.5 Release](https://github.com/flaqai/open-deepseek-harness-desktop/releases/tag/odsh-v0.1.2-alpha.5) 下载对应安装包（Windows 为 `DeepSeek-Harness-windows-x64.exe`），安装后首次启动完成初始化即可。
>
> 也可使用基于官方 DSH 的其他社区桌面发行版（如 [sdkwork-ai/deepseek-harness-desktop](https://github.com/sdkwork-ai/deepseek-harness-desktop/releases)，建议 v0.1.0-rc.12 及以上）。

### 方式一：从 GitHub 安装（推荐给普通用户）

仓库已提交编译产物（`lib/`），克隆或直接安装即可使用，无需本机编译：

```powershell
dsh plugin --profile web add https://github.com/qingmumingyang/dsh-doc-toolkit
```

> 如果当前环境没有 `dsh` 命令行（纯桌面版安装），请使用方式三。

### 方式二：本地开发安装

```powershell
# 1. 进入项目目录
cd dsh-doc-toolkit

# 2. 安装依赖
npm install

# 3. 编译 TypeScript（生成 lib/ 目录）
npm run build

# 4. 加载到 DSH web profile（推荐用 link: 软链方式，改代码后只重启不重装）
dsh plugin --profile web add link:.
# 或指定路径：
# dsh plugin --profile web add link:D:\path\to\dsh-doc-toolkit
```

> `link:` 方式会在 `%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dependencies` 写入绝对路径软链。**目录移动/删除会导致 DSH 启动失败**，升级插件用 `git pull` 即可，无需重装。

### 方式三：桌面版手动安装（没有 dsh 命令行时）

桌面版安装目录下没有独立的 `dsh` 命令，可手动完成等价操作：

```powershell
# 1. 先完成上面的 npm install + npm run build

# 2. 在 profile 的 node_modules 中建立插件链接（与 DSH 自带的 junction 机制一致）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-doc-toolkit" -Target "D:\path\to\dsh-doc-toolkit"

# 3. 把插件加入 profile 的 bundles 列表
#    编辑 %USERPROFILE%\.dsh\profiles\web\package.json，在 dsh.profile.bundles 中追加：
#    "dsh-doc-toolkit"

# 4. 完全退出并重启 DSH 桌面版
```

加载成功后，插件日志会输出：

```
[dsh-doc-toolkit] 插件已加载！
[dsh-doc-toolkit] 已注册 skill: doc-toolkit-usage
```

> **注意**：DSH 的插件清单（Plugin Inventory）界面是只读的，安装/卸载需通过命令或手动方式完成。修改 `src/` 后重新执行 `npm run build` 并**重启 DSH** 即可生效。

---

## 📖 使用指南

安装完成后，AI 助手会自动获得两个新工具（Tools）：

### 1. `read_document` —— 读取文档

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 文件绝对路径或相对工作区的路径 |
| `format` | string | ❌ | `pdf` / `docx` / `xlsx` / `csv` / `auto`（默认 auto，根据扩展名识别） |
| `offset` | number | ❌ | 起始行号，从 1 开始（仅对 XLSX/CSV 有效） |
| `limit` | number | ❌ | 最大返回行数（仅对 XLSX/CSV 有效） |

**对话示例（自然语言）：**

> “帮我读取 D:\report.pdf 的内容”
> “读取 D:\data.xlsx 的前 50 行”

**底层调用 JSON：**

```json
{
  "file_path": "D:/data.xlsx",
  "format": "xlsx",
  "limit": 50
}
```

**返回示例：**

```json
{
  "content": "[Sheet: Sheet1]\n姓名\t年龄\t城市\n张三\t28\t北京\n李四\t32\t上海",
  "format": "xlsx",
  "total_lines": 3,
  "limit": 50,
  "truncated": false
}
```

> PDF 还会返回 `pages`（页数）；DOCX 有转换警告时返回 `warnings`。`total_lines` 为文件总行数，`truncated` 为是否因 `limit` 截断——截断时继续增大 `offset` 翻页。

### 2. `write_document` —— 写入/生成文档

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | ✅ | 文件保存路径（自动创建父目录） |
| `format` | string | ✅ | `docx` / `xlsx` / `csv` / **`pdf`** |
| `content` | object | ✅ | 结构化内容（格式见下方） |

**各格式的 `content` 写法：**

| 格式 | content 结构 | 示例 |
|------|--------------|------|
| **DOCX** | `{ "title"?, "paragraphs": [...] }` 或 `{ "content": "纯文本" }` | `{ "title": "年度总结", "paragraphs": ["业绩增长 20%"] }` |
| **XLSX** | `{ "rows": [[...]] }` 或 `{ "data": [{...}] }`，可选 `"sheet_name"` | `{ "rows": [["姓名","年龄"],["张三",28]] }` |
| **CSV** | `{ "rows": [[...]] }`、`{ "data": [{...}] }` 或 `{ "content": "纯文本" }` | `{ "rows": [["姓名","年龄"],["张三",28]] }` |
| **PDF** | `{ "title"?, "paragraphs": [...] }` 或 `{ "content": "纯文本" }`，可选 `"rows": [[...]]`（渲染为表格） | 见下方示例 |

> CSV 字段含逗号、引号或换行时自动按 RFC 4180 转义；XLSX 二维数组走 `aoa_to_sheet`，对象数组走 `json_to_sheet`（键作为表头）。

**对话示例（自然语言）：**

> “帮我生成一份销售报告 DOCX，包含标题和三个段落，保存到 D:\sales.docx”
> “把这张表格导出为 CSV：[[姓名, 分数], [小明, 95], [小红, 88]]，保存到 D:\scores.csv”
> “生成一份 PDF 报告，标题『2025 年度销售报告』，三段正文，最后带一张销量表格”

**底层调用 JSON（生成 PDF）：**

```json
{
  "file_path": "D:/report.pdf",
  "format": "pdf",
  "content": {
    "title": "2025 年度销售报告",
    "paragraphs": ["本年度业绩增长 20%。", "展望明年，目标增长 30%。"],
    "rows": [["产品", "销量"], ["A 系列", 1200], ["B 系列", 860]]
  }
}
```

**返回示例：**

```
成功写入 PDF 文件: D:/report.pdf（共 1 页，标题「2025 年度销售报告」，2 个段落，表格 3 行，内嵌字体 simhei（子集 45 字符））
```

### PDF 导出说明

- **字体策略**：纯 ASCII 内容使用标准 Helvetica 字体（文件极小，无字体嵌入）；含中文等内容时自动查找系统 CJK 字体并**子集化嵌入**（只嵌入用到的字形，示例报告仅几十 KB），输出 Type0 + Identity-H + ToUnicode 结构，**文本可复制、可搜索**。
- **字体查找顺序**：环境变量 `DSH_CJK_FONT`（TTF/TTC，分号分隔多个）→ Windows（`simhei.ttf`、`msyh.ttc`、`simsun.ttc` 等）→ macOS（PingFang、Hiragino 等）→ Linux（Noto CJK、文泉驿等）。TTC 字体集合会自动挑选覆盖最好的子字体。
- **排版**：A4 页面、自动换行与分页；表格首行作表头（浅灰底），跨页时自动重复表头。
- **限制**：字体中缺失的字符（如 emoji）降级为 .notdef 不渲染，返回消息会注明缺失数量；仅支持 TrueType 轮廓（TTF/TTC），不支持 CFF/OTF 字体。

---

## 🧩 内置 Skill

插件加载时会自动把 `skills/doc-toolkit-usage/SKILL.md` 注册为运行时 Skill（无需手动复制文件），AI 助手将据此判断**何时**以及**如何**调用这两个工具。

如果你希望该 Skill 对所有 profile 生效，也可以手动把它复制到用户级技能目录：

```powershell
Copy-Item -Recurse skills\doc-toolkit-usage "$env:USERPROFILE\.dsh\skills\"
```

---

## 📂 项目结构

```
dsh-doc-toolkit/
├── src/
│   ├── index.ts                  # 插件入口：注册工具 + 运行时注册 Skill
│   ├── tools/
│   │   ├── read.ts               # 读取 PDF/DOCX/XLSX/CSV 的实现
│   │   ├── write.ts              # 写入 DOCX/XLSX/CSV 的实现
│   │   └── pdf-write.ts          # 纯 JS PDF 生成器（零依赖：字体解析/子集化/排版/组装）
│   └── types/
│       ├── index.ts              # 工具参数与返回类型定义
│       └── plugin-context.ts     # 宿主 Context 最小结构声明
├── skills/
│   └── doc-toolkit-usage/
│       └── SKILL.md              # 内置技能，教 AI 如何使用工具
├── lib/                          # 编译产物（已提交，GitHub 安装免编译）
├── tests/
│   └── tests.mjs                 # 自包含 node:test 测试套件（15 个用例，夹具运行时生成）
├── package.json                  # npm 配置，含 dsh.bundle 声明
├── tsconfig.json                 # TypeScript 编译配置
├── cordis.patch.yml              # DSH 插件补丁文件（bundle 插入行）
└── README.md                     # 项目介绍文档（本文件）
```

---

## ⚠️ 注意事项

1. **PDF 扫描件不支持 OCR**
   本插件通过 `pdf-parse` 提取 PDF 的**文本层**。如果 PDF 是扫描图片（无文字层），读取结果为空。如需 OCR 支持，请结合其他 OCR 插件使用。

2. **大文件处理**
   XLSX 和 CSV 文件较大时，请使用 `limit`/`offset` 参数分页读取，避免返回内容超出上下文窗口大小。

3. **写入会覆盖已有文件**
   `write_document` 会直接覆盖同路径的已存在文件，请确认路径无误。

4. **Windows 路径格式**
   支持正斜杠（`D:/temp/file.pdf`）和反斜杠（`D:\temp\file.pdf`），建议在 JSON 调用中使用正斜杠避免转义问题。

5. **PDF 导出需要系统中文字体**
   生成含中文的 PDF 时依赖系统字体（Windows 通常自带 SimHei/微软雅黑，开箱即用）。无中文字体的精简环境可用 `DSH_CJK_FONT` 指定字体路径。

6. **版本兼容**
   插件的 `peerDependencies` 覆盖 DSH 运行时的内置版本（`@deepseek-ai/cordis` 4.x、`@deepseek-ai/dsh-tools` ≥0.1.0-rc.12 且 <0.2.0），因此 **v0.1.0-rc.12 起的整个 v0.1.x 谱系（含 v0.1.1-rc 系列、v0.1.2-alpha 系列，直至 v0.1.2-alpha.5）** 均可安装。v0.1.1 起在 DSH 0.1.2-alpha.5 上实测；若桌面版后续升级导致工具注册报错，请同步调整这两个版本范围。

7. **超长内容自动截断**
   单次读取超过 50,000 字符时自动截断并标记 `truncated: true`（防止撑爆上下文）。PDF/DOCX 无法翻页，可缩小文档范围后分段处理。

8. **CSV 编码自动识别**
   优先按 UTF-8 解码，失败时自动回退 GBK/GB18030（兼容 Excel 导出的中文 CSV），无需手动指定编码。

9. **文件访问不经过沙箱策略**
   本插件直接用 Node fs 读写文件（PDF/DOCX/XLSX 为二进制，DSH 的 `ctx.fs` 只有文本 API），因此 `write_document` **不受** DSH 的 workspace-write 沙箱围栏约束，可以写工作区外路径。请仅在信任的环境中使用。

10. **工具名冲突**
    `read_document` / `write_document` 是通用工具名。若同时安装其他注册同名工具的文档插件（如 dsh-cowork 类插件），注册会因重名抛错。卸载其一即可。

---

## 🛠️ 开发与调试

### 修改代码后重新编译

```powershell
npm run build
# 完全退出并重启 DSH 桌面版即可生效（无需重新 add）
```

### 运行测试

项目自带自包含测试套件（node:test，15 个用例，夹具运行时生成，无需外部样例文件；覆盖 CSV/XLSX/DOCX/PDF 读写往返、分页、引号转义、GBK 解码、超长截断与错误路径）：

```powershell
npm install   # 首次
npm run build # 先编译
npm test
```

### 卸载插件

```powershell
dsh plugin --profile web remove dsh-doc-toolkit
```

手动安装的卸载：删除 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-doc-toolkit` 链接，并从 `%USERPROFILE%\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 中移除 `"dsh-doc-toolkit"`。

### 常见问题

**Q：工具注册失败 / 插件加载报错？**
A：先确认 `npm run build` 成功（`lib/` 目录存在）；再确认 `cordis.patch.yml` 中 `name` 与 `package.json` 的 `name` 一致；最后检查桌面版版本与 `peerDependencies` 范围是否匹配。

**Q：读取 PDF 报错 "bad XRef entry"？**
A：这是 pdf.js v1.10 与 Node Buffer 共享内存池的兼容问题（小文件更容易触发）。本插件已在读取时把 Buffer 拷贝为独立 `Uint8Array` 修复，无需处理。

**Q：生成中文 PDF 时提示找不到字体？**
A：设置环境变量 `DSH_CJK_FONT` 指向一个 TTF/TTC 文件（可用分号指定多个候选），例如：
```powershell
$env:DSH_CJK_FONT = "C:\Windows\Fonts\msyh.ttc"
```

**Q：Windows 路径中的反斜杠问题？**
A：代码中使用了 `node:path` 处理路径，正斜杠/反斜杠均可，但 JSON 参数中建议使用正斜杠。

---

## 🤝 贡献与反馈

欢迎提交 Issue 和 Pull Request！

- 报告 Bug：请附上 DSH 版本、操作系统、错误日志
- 功能建议：请清晰描述使用场景和期望行为
- 代码贡献：请保持 TypeScript 严格模式，并通过 `npm run build` 与 `npm test`

---

## 📄 许可证

本项目采用 [MIT License](LICENSE)，可自由使用、修改和商用。

---

**Happy Coding! 🚀**
