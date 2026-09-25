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

- 已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面版 / **Web 运行时**
  （插件注册的是 `read_document` / `write_document` 两个宿主工具，声明支持 `web` profile）。
  兼容范围 `>=0.1.0-rc.12 <0.2.0`，其中**实测通过**的版本：

  | DSH 版本 | 安装 | 配置合成 | 加载插件 | 说明 |
  |----------|------|----------|----------|------|
  | `0.1.7-rc.2` | ✅ | ✅ | ✅ | 商店当前窗口内 |
  | `0.1.7-rc.1` | ✅ | ✅ | ✅ | 商店当前窗口内 |
  | `0.1.7-alpha.2` | ✅ | ✅ | ✅ | 商店当前窗口内 |
  | `0.1.5-rc.3` | ✅ | ✅ | ✅ | 官方 npm `latest` |
  | `0.1.5-rc.1` | ✅ | ✅ | ✅ | 在运行中的 web profile 里加载过（工具与 Skill 可用） |

  “安装 / 配置合成 / 加载插件”分别指：一次性 `DSH_HOME` 下官方 CLI `plugin add`、`--dump-config`
  合成出 `dsh-doc-toolkit` 行、用该版本真实的 `@deepseek-ai/dsh-tools` 加载构建产物并确认
  两个工具与 Skill 注册成功。逐版本声明见 `package.json` 的 `dsh.compatibility`——
  **只登记实测过的版本**，未实测的版本保持 `unknown`，不用版本范围冒充证据。
  完整变更历史见 [`CHANGELOG.md`](CHANGELOG.md)。
- Node.js v18+ 与 npm（仅安装/开发时需要，运行时由 DSH 提供）

> 💡 **还没有 DSH？两种方式装一个**
>
> **方式 A：官方源码运行时（推荐开发者）**
> 到官方仓库的 [Releases](https://github.com/deepseek-ai/deepseek-harness/releases) 取当前版本的
> `@deepseek-ai/dsh`（`npm view @deepseek-ai/dsh dist-tags` 可看 `latest` / `next`），
> 按文档安装并启动 `dsh web`。
>
> **方式 B：桌面版安装包（推荐普通用户，Windows/macOS/Linux）**
> 从社区桌面发行版 [open-deepseek-harness-desktop](https://github.com/flaqai/open-deepseek-harness-desktop)
> 的 Releases 下载对应安装包（Windows 为 `DeepSeek-Harness-windows-x64.exe`），安装后首次启动完成初始化即可。
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
- **字体查找顺序**：插件配置 `cjkFonts`（TTF/TTC 绝对路径数组，优先）→ Windows（`simhei.ttf`、`msyh.ttc`、`simsun.ttc` 等）→ macOS（PingFang、Hiragino 等）→ Linux（Noto CJK、文泉驿等）。TTC 字体集合会自动挑选覆盖最好的子字体。
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
│   ├── index.ts                  # 插件入口：导出 Config、注册工具 + 注册内嵌 Skill
│   ├── tools/
│   │   ├── read.ts               # read_document：格式识别 + 读取（含卡片 presenter）
│   │   ├── write.ts              # write_document：四种格式生成（含卡片 presenter）
│   │   └── pdf-write.ts          # PDF 生成器（字体解析/子集化/排版/组装，纯 ASCII 产物）
│   ├── zip/                      # 自研 ZIP（零运行依赖）
│   │   ├── crc32.ts              # CRC-32
│   │   ├── read.ts               # 中央目录解析 + stored/deflate 解压
│   │   └── write.ts              # STORED 条目 ASCII ZIP 写入器
│   ├── ooxml/                    # 自研 OOXML（零运行依赖）
│   │   ├── xml.ts                # XML 转义/反转义（非 ASCII → 数字字符引用）
│   │   ├── docx.ts               # DOCX 读文本 / 生成
│   │   └── xlsx.ts               # XLSX 逐表读取 / 生成
│   ├── pdf/
│   │   └── text-extract.ts       # 自研 PDF 文本提取（xref/对象流/Flate/ToUnicode）
│   ├── skills/
│   │   └── embedded-skill.ts     # 由 SKILL.md 生成的内嵌副本（插件加载不读文件）
│   ├── types/
│   │   ├── index.ts              # 工具参数与返回类型定义
│   │   ├── config.ts             # 插件配置类型（cjkFonts）
│   │   └── plugin-context.ts     # 宿主 Context 与服务的最小结构声明
│   └── utils/
│       ├── fs-channel.ts         # 唯一 I/O 通道：全部读写经 ctx.fs
│       └── present.ts            # 卡片 presenter 的共用纯函数
├── skills/
│   └── doc-toolkit-usage/
│       └── SKILL.md              # 内置技能源文件（正文内嵌进 src/skills/embedded-skill.ts）
├── lib/                          # 编译产物（已提交，GitHub 安装免编译）
├── tests/
│   ├── tests.mjs                 # 主套件：加载/配置/卡片/往返/分页/编码/错误路径/合规回归
│   ├── fs-stub.mjs               # 测试用 ctx.fs 宿主后端替身（生产代码零文件访问）
│   ├── oracle-zip-ooxml.test.mjs # 以 mammoth/xlsx/docx 为对照验证自研 ZIP/OOXML
│   ├── oracle-pdf.test.mjs       # 以 pdf-parse 为对照验证自研 PDF 文本提取
│   └── store-gate-replica.mjs    # DSH STORE 固定源自动策略的本地只读副本
├── package.json                  # npm 配置，含 dsh.bundle / dsh.pluginType / dsh.compatibility
├── PERMISSIONS.md                # 权限/依赖/外部服务/失败边界声明（供 STORE 审查）
├── SECURITY.md                   # 安全入口：风险分级、能力摘要、边界自检、漏洞报告
├── CHANGELOG.md                  # 更新日志：每个版本的变更、破坏性变更与实测兼容的 DSH 版本
├── tsconfig.json                 # TypeScript 编译配置
├── cordis.patch.yml              # DSH 插件补丁文件（bundle 插入行 + 插件配置行）
└── README.md                     # 项目介绍文档（本文件）
```

---

## 🧱 解析器实现与边界

插件不引入任何第三方运行时依赖，四种格式的处理都在本仓库内实现——这是能进入
DSH STORE 自动通道（零运行依赖 + 零权限信号）的前提：

| 能力 | 实现 | 已知不覆盖 |
|------|------|------------|
| DOCX 读取 | 自研 ZIP（中央目录 + deflate）→ `word/document.xml` 词法提取 | 不解析批注/修订/文本框 |
| XLSX 读取 | 自研 ZIP → `workbook.xml`/`sharedStrings.xml`/`sheetN.xml`，支持稀疏单元格、内联字符串与多段富文本 | 不计算公式（返回缓存值）；每行补齐到最大列宽；布尔返回 `'TRUE'`/`'FALSE'` 文本 |
| DOCX/XLSX 生成 | 自研 STORED 条目 **ASCII ZIP**（补白 + 合法扩展字段把 CRC/大小/偏移也收进 ASCII）+ 数字字符引用的 OOXML | 单工作表/单文档体；不支持加密条目与 ZIP64 |
| CSV 读写 | RFC 4180 转义；UTF-8 优先、GBK/GB18030 回退解码 | 不支持自定义分隔符 |
| PDF 生成 | 自研：TrueType 解析、字形子集化、A4 排版、Type0/Identity-H + ToUnicode；二进制字体流走 `ASCIIHexDecode` 保持产物纯 ASCII | 仅 TrueType 轮廓（不支持 CFF/OTF 字体） |
| PDF 文本提取 | 自研：经典 xref 表 / 交叉引用流 / 对象流、`/Prev` 链、Flate（含 PNG/TIFF 预测器）、ASCIIHex/ASCII85、内容流文本算子、`/ToUnicode`（bfchar/bfrange 含数组形式）、`/Differences` 字形名；xref 损坏时回退全文件扫描 | **不解密**（带 `/Encrypt` 一律报错，含 pdf.js 能读的"仅所有者口令"文件）；不建模竖排与 Type3 字形矩阵；不处理标签化 PDF 的阅读顺序；图像型 PDF 无文本 |

> 为什么产物必须是纯 ASCII：`ctx.fs` 只有文本写入 API。DOCX/XLSX 用 STORED 条目 +
> 数字字符引用的 ASCII ZIP；PDF 把二进制字体流编码为 `ASCIIHexDecode`。写出前由
> `bytesToAsciiText()` 校验，出现非 ASCII 字节直接报错而不是静默写坏文件。
> 兼容性由对照测试守住：生成物能被 **mammoth / SheetJS / pdf.js** 正确读回
> （`tests/oracle-*.test.mjs`，三个成熟库只作为测试对照，不参与运行、不随包发布）。

自研实现的正确性由**对照测试**保证：`pdf-parse`、`mammoth`、`xlsx`、`docx` 保留在
`devDependencies`，只在测试里作为参考实现与自己互读互验（不随包发布、不参与运行）。

---

## 🔐 权限与合规

本插件会以 DSH 进程权限运行，因此把**能做什么、依赖什么、失败时怎样**写在
[`PERMISSIONS.md`](PERMISSIONS.md) 里，供 DSH STORE 自动审查与人工复核逐条核对；
[`SECURITY.md`](SECURITY.md) 是安全入口（风险分级、能力摘要、边界自检、漏洞报告）。
要点：

| 维度 | 事实 |
|------|------|
| 文件读取 | 经宿主 `ctx.fs`（`resolve` + `stat` + `readBytes`），**任意路径**可读，读不改变文件 |
| 文件写入 | 经宿主 `ctx.fs.writeText`，原子写 + 按需建父目录 + **受会话沙箱围栏**（`workspace-write` 只能写工作区/临时目录） |
| 网络 / 命令 / 凭据 | **全部无**：无网络模块与 `fetch`，无 `child_process` 与 shell，无进程环境变量读取，无 keychain/OAuth/凭据文件访问 |
| 运行依赖 | **零**（`dependencies` 为空；DOCX/XLSX/PDF 解析与生成全部自研） |
| 生命周期脚本 | 无（未定义 `preinstall`/`install`/`postinstall`/`prepare`） |
| 外部服务 | 无（无遥测、无回传、无第三方 API） |
| 风险等级 | **R1** —— 注册宿主 Tool；不写 Profile、不改 DSH 源码、不重启宿主 |

### 商店元数据（DSH STORE 从 manifest 读取）

| 字段 | 值 | 作用 |
|------|----|------|
| `dsh.bundle.patch` | `./cordis.patch.yml` | Bundle 层入口 |
| `dsh.pluginType` | `feature` | Catalog `details.pluginType`（缺省会记为 `unknown`） |
| `dsh.compatibility.dsh` | `>=0.1.0-rc.12 <0.2.0` | 来源兼容声明 |
| `dsh.compatibility.dshReleases` | 逐版本 `compatible` | **只登记实测过的版本**；官方最新三版窗口内至少需要一条精确 `compatible`，否则条目会被判 `unlisted` |
| `dsh.compatibility.dshOperations` | 每版本的 install/start/uninstall/rollback | 与 `dshReleases` **逐版本对齐**；未观察到的一律 `unknown`，不猜 |
| `keywords` | 含 `files`、`tools` + 中文用途词 | 商店按 keywords 匹配分类；未命中分类键时会退回 `experimental` |

### Tool 卡片契约

两个工具都实现了宿主的标准卡片契约，四层契约彼此独立（见 `build-dsh-plugin` 的
`references/boundaries.md` 第 5 节）：

1. **canonical 输出** —— `output.schema: string`（JSON 或人类可读消息）；
2. **模型可见渲染** —— `output.render`；
3. **provider-neutral 卡片意图** —— `presentCall` 返回 `card: 'generic'`
   （`read_document` 用 `kind: 'read'` + `locations` 支持编辑器跟随；`write_document`
   用 `kind: 'edit'`）。生成物是二进制，内置的 `diff` 词表无法表达，因此不伪造 diff；
4. **completed 卡片** —— `presentResult` 仅在 `isError` 时替换标题，成功时返回
   `undefined` 交给 UI 的通用兜底渲染模型可见正文（不重复编码）。

> Presenter 是**纯函数**：只读已校验参数与持久结果字段，不做 I/O、不读会话/Profile、
> 不取时钟/随机数；卡片里不放密钥、完整私有文件或无界参数——`rawInput`/`content` 一律不设置。

### 插件配置（Cordis 标准写法）

配置字段由插件导出的 `Config`（Schemastery Schema）声明，经 Bundle Patch 的
`config:` 行传入，**不读环境变量**：

```yaml
- insert:
  - id: dsh-doc-toolkit
    name: dsh-doc-toolkit
    config:
      cjkFonts: []   # 追加的 CJK 字体候选（TTF/TTC 绝对路径），优先于内置候选
```

> ⚠️ **破坏性变更（v0.1.1 → v0.2.0）**：本次发布把 0.1.1 之后的所有改动合并为一个版本，
> 完整清单一律见 [`CHANGELOG.md`](CHANGELOG.md)。四条要点：
> 1. **环境变量 `DSH_CJK_FONT` 已移除**，改用上面的 `cjkFonts` 配置。原因是 DSH STORE 的
>    固定源自动策略把运行时源码中的**任何进程环境变量读取**记为 `credentials` 权限信号。
> 2. **写入受会话沙箱约束**（原先可写任意路径）——见下方注意事项第 9 条。
> 3. **运行时依赖清零**：`pdf-parse`/`mammoth`/`xlsx`/`docx` 改为自研实现，四个库移入
>    `devDependencies` 仅作测试对照。DOCX/XLSX/PDF 的解析面因此收窄（见「解析器实现与边界」表）。
> 4. **加密 PDF 明确报错**（原先可能读出乱码），且不再可能静默产出损坏文件。

### 推送前自检 DSH STORE 门禁

```powershell
npm run verify:publish-policy     # = node tests/store-gate-replica.mjs
```

该脚本是 `AI-Scarlett/DSH-Store` 固定源自动策略的**本地只读副本**（逐条对齐
`automate-catalog.mjs` / `automation-source-policy.mjs` / `automation-policy.json`），
只读仓库文件、不执行插件代码，会在推送前给出与上游同一套措辞的确定性原因，
并动态从 npm Registry 解析“官方最新三版”兼容窗口。

**`0.2.0` 的目标是通过自动策略**（零确定性原因 → 上游自动生成 `source-verified` 条目，
条目进入 `approved` 可安装状态）：

| 门禁 | 状态 |
|------|------|
| 无运行时/可选依赖 | ✅ `dependencies` 为空，四个库移入 `devDependencies` 仅作测试对照 |
| 无 `files` 权限信号 | ✅ 全部读写改走 `ctx.fs` |
| 无 `credentials` 权限信号 | ✅ 无环境变量读取，并避免扫描器判定为凭据的记号 |
| 无 network / commands / protectedDsh / 原生制品信号 | ✅ |
| 兼容性窗口内有精确 `compatible` | ✅ 窗口内三个版本（`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2`）全部实测通过（详见 `PERMISSIONS.md` 第六节与 [`CHANGELOG.md`](CHANGELOG.md)） |

`tests/tests.mjs` 另有三条**回归用例**直接对 `src/` 与 `lib/` 做同样的源码扫描：
任何一次重新引入文件访问、环境变量读取或凭据记号都会让 `npm test` 失败，
而不是等八小时后被商城判为 `blocked`。

---

## ⚠️ 注意事项

1. **PDF 扫描件不支持 OCR**
   插件提取 PDF 的**文本层**（自研解析器，支持 xref 表/流、对象流、Flate 与 `/ToUnicode`）。如果 PDF 是扫描图片（无文字层），读取结果为空；加密 PDF 会明确报错。如需 OCR 支持，请结合其他 OCR 插件使用。

2. **大文件处理**
   XLSX 和 CSV 文件较大时，请使用 `limit`/`offset` 参数分页读取，避免返回内容超出上下文窗口大小。

3. **写入会覆盖已有文件**
   `write_document` 会直接覆盖同路径的已存在文件，请确认路径无误。

4. **Windows 路径格式**
   支持正斜杠（`D:/temp/file.pdf`）和反斜杠（`D:\temp\file.pdf`），建议在 JSON 调用中使用正斜杠避免转义问题。

5. **PDF 导出需要系统中文字体**
   生成含中文的 PDF 时依赖系统字体（Windows 通常自带 SimHei/微软雅黑，开箱即用）。无中文字体的精简环境可用插件配置 `cjkFonts` 指定字体路径。

6. **版本兼容**
   插件的 `peerDependencies` 覆盖 DSH 运行时的内置版本（`@deepseek-ai/cordis` 4.x、`@deepseek-ai/dsh-tools` ≥0.1.0-rc.12 且 <0.2.0），因此 **v0.1.0-rc.12 起的整个 v0.1.x 谱系** 均可安装。**实测通过**的是 `0.1.7-rc.2`、`0.1.7-rc.1`、`0.1.7-alpha.2`、`0.1.5-rc.3`、`0.1.5-rc.1`（见上方前置条件表），逐版本声明在 `package.json` 的 `dsh.compatibility.dshReleases`——未实测的版本保持 `unknown`，不用范围声明冒充证据。若桌面版后续升级导致工具注册报错，请同步调整这两个版本范围。

7. **超长内容自动截断**
   单次读取超过 50,000 字符时自动截断并标记 `truncated: true`（防止撑爆上下文）。PDF/DOCX 无法翻页，可缩小文档范围后分段处理。

8. **CSV 编码自动识别**
   优先按 UTF-8 解码，失败时自动回退 GBK/GB18030（兼容 Excel 导出的中文 CSV），无需手动指定编码。

9. **文件访问经过宿主能力边界（v0.1.1 → v0.2.0 的行为变更）**
   插件全部读写都经宿主的 `ctx.fs` 服务，不再直接用 Node fs。因此：
   - **读取**不受围栏限制，工作区外的文档照常可读；
   - **写入受调用会话的沙箱模式约束**——`workspace-write`（默认）下 `write_document` 只能写
     会话工作区内或临时目录，`read-only` 直接拒绝，`danger-full-access` 不限制。
   需要写到工作区外时，请把会话切到完全访问模式，或先写到工作区再自行移动。
   这样做的两个理由：写入必须经过宿主的沙箱策略（安全边界），且直接用 Node fs 会被
   DSH STORE 判定为 `files` 权限信号，使插件无法进入可安装状态。

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

```powershell
npm install   # 首次
npm run build # 必须先编译（测试导入 lib/）
npm test
```

三个套件各管一件事：

| 套件 | 覆盖 |
|------|------|
| `tests/tests.mjs` | 插件加载、`Config` 契约、Tool 卡片契约、四种格式往返、分页、引号转义、GBK 解码、超长截断、错误路径、内嵌 Skill 同步性，以及**合规回归**（源码不得出现文件访问 / 环境变量读取 / 凭据记号） |
| `tests/real-backend.test.mjs` | 挂载**真实**的 `@deepseek-ai/dsh-fs-local` + 真实 cordis Context，验证 `fs-channel` 的调用约定（参数顺序、cwd 语义、相对路径、父目录创建、显示路径）。本机没有 DSH 安装时整组跳过 |
| `tests/oracle-zip-ooxml.test.mjs` | 自研 ZIP 与 OOXML：与 `mammoth`/`xlsx`/`docx` 互读互验（含中文、稀疏行、共享字符串、ASCII 断言、畸形输入） |
| `tests/oracle-pdf.test.mjs` | 自研 PDF 文本提取：与 `pdf-parse` 对照（fixture 需要网络，离线时自动跳过 fixture 断言，合成用例始终运行） |

> 生产代码不访问文件系统，测试用 `tests/fs-stub.mjs` 提供宿主 `ctx.fs` 后端替身。
> 修改 `skills/doc-toolkit-usage/SKILL.md` 后必须重新生成 `src/skills/embedded-skill.ts`
> （同步性测试会失败并提示），否则插件注册的 Skill 会与文档不一致。

### 推送前自检 DSH STORE 门禁

```powershell
npm run verify:publish-policy     # = node tests/store-gate-replica.mjs
node tests/store-gate-replica.mjs --json          # 机器可读
node tests/store-gate-replica.mjs --dsh-window 0.1.7-alpha.2,0.1.7-rc.1,0.1.7-rc.2
```

只读仓库文件、**不执行插件代码**，输出与 DSH STORE 八小时自动复检同一套措辞的
确定性原因、权限信号命中文件、运行源码体积边界，以及从 npm Registry 动态解析的
“官方最新三版”兼容窗口。合并前应保证 `npm run build` 后 `git diff --exit-code -- lib/`
为空（CI 也检查这一点）。

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
A：在插件配置里指定字体（替代 v0.1.x 的环境变量写法）：

```yaml
# Profile 的 patch 层（或 profile 中该插件行的 config）
- insert:
  - id: dsh-doc-toolkit
    name: dsh-doc-toolkit
    config:
      cjkFonts:
        - 'C:\Windows\Fonts\msyh.ttc'
```

`cjkFonts` 为 TTF/TTC 绝对路径数组，可写多个候选，优先于内置系统字体候选。

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
