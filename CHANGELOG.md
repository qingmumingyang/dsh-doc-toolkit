# 更新日志（Changelog）

本文件记录 `dsh-doc-toolkit` 的每个发布版本：改了什么、**破坏性变更**是什么、
以及该版本实测通过的 DSH 版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 兼容性口径：`实测` 指在一次性 `DSH_HOME` 下用官方 CLI 完成安装、`--dump-config`
> 配置合成，并用该版本真实的 `@deepseek-ai/dsh-tools` 加载插件、确认两个工具与一个 Skill
> 注册成功。未实测的版本一律记 `unknown`，不用版本范围冒充证据。

---

## [0.2.0] — 未发布

**目标：让插件满足 DSH STORE 的固定源自动策略（零运行依赖 + 零权限信号），
从而自动进入 `approved` 可安装状态；同时按准入规则与 `build-dsh-plugin` 的 bundle 契约补齐声明。**

> `0.1.1` 之后没有发布过任何版本，因此「架构重写」与「声明修复」合并为同一个 `0.2.0`。

### 破坏性变更

- **移除环境变量 `DSH_CJK_FONT`**，字体候选改由 Cordis 插件配置提供：
  ```yaml
  - insert:
    - id: dsh-doc-toolkit
      name: dsh-doc-toolkit
      config:
        cjkFonts: ['C:\Windows\Fonts\msyh.ttc']
  ```
  原因是 DSH STORE 的固定源自动策略把运行源码里**任何进程环境变量读取**记为
  `credentials` 权限信号，即使读到的只是字体路径。
- **写入受会话沙箱约束**：全部文件读写改为经宿主 `ctx.fs`（不再直接使用 Node fs）。
  **读取不受限制**（工作区外的文档照常可读），但写入在 `workspace-write`（默认）下只能落到
  会话工作区内或临时目录，`read-only` 直接拒绝，`danger-full-access` 不限制。
  需要写工作区外时请把会话切到完全访问模式，或先写工作区内再自行移动。
- **运行时依赖清零**：`pdf-parse` / `mammoth` / `xlsx` / `docx` 全部移入 `devDependencies`，
  只作为测试对照（oracle），安装插件时不再安装、运行时不再加载。
  DOCX/XLSX/PDF 的解析与生成改由本仓库自研实现，覆盖面因此收窄——见「已知边界」。
- **加密 PDF 一律报错**：包含「只设所有者口令、用户口令为空」这类 pdf.js 能读的文件。
  本实现不做解密，会返回明确错误并提示另存为未加密副本（不再可能读出乱码）。
- **XLSX 单元格语义明确化**：`null`/`undefined`（含稀疏数组空洞）**不写单元格**；
  布尔写成真正的布尔单元格；数字按 Excel 口径转换（`'007'`→`7`、`'2.50'`→`2.5`、
  `'1e3'`→`1000`，会**规范化**），`'1,000'`、`'abc'`、`''` 保持文本。
  需要原样保留前导零（邮编/工号）时请改用 CSV。

### 变更（架构重写：零运行依赖）

- 新增 `src/utils/fs-channel.ts`：唯一 I/O 通道，读走 `ctx.fs.readBytes`、
  写走 `ctx.fs.writeText`（原子写、按需建父目录、按会话沙箱策略传 `sandboxPolicy`）。
- 新增 `src/zip/`（自研 ZIP）：写入器只产出 STORED 条目，并用「补白换行 + 合法本地扩展字段」
  两个自由度把 CRC-32/大小/偏移这些二进制结构字段也收敛进 ASCII，条目保持紧邻
  （Office 的 OPC 读取器要求本地条目连续）；读取器支持 central directory、stored/deflate
  （`node:zlib`）、条目数/单条/总量上限，并对截断、加密、未知方法、解压炸弹明确抛错。
- 新增 `src/ooxml/`（自研 OOXML）：DOCX 读文本/生成、XLSX 逐表读/生成；
  非 ASCII 一律写数字字符引用，保证 ZIP 整体纯 ASCII。
- 新增 `src/pdf/text-extract.ts`（自研 PDF 文本提取，替换 `pdf-parse`）：
  经典 xref 表、交叉引用流（`/W` + `/Index`）、对象流（`/ObjStm`）、`/Prev` 链，
  xref 损坏时回退全文件扫描；`/FlateDecode`（含 PNG/TIFF 预测器）、`/ASCIIHexDecode`、
  `/ASCII85Decode`；`BT/ET`、`Tf`、`Td/TD/Tm/T*/TL`、`Tj/TJ/'/"` 文本算子；
  `/ToUnicode` CMap（`bfchar`/`bfrange`，含数组形式）、`/Encoding`（WinAnsi→cp1252、
  Standard/MacRoman）与 `/Differences` 字形名（含 AGL 希腊字母与 `uniXXXX`）。
  按 y 变化判断换行，避免逐词定位的 PDF 被拆行。
- `src/tools/pdf-write.ts`：产物改为**纯 ASCII**——二进制流（内嵌字体子集）编码为
  `/Filter [/ASCIIHexDecode /FlateDecode]`，页面内容流与 ToUnicode CMap 原样写出，
  文件头不再使用二进制标记；字体候选经 `ctx.fs` 探测读取（不再 `existsSync`/`readFile`）。

### 变更（按 STORE 准入规则补齐声明）

- `package.json`：导出 Cordis `Config`（Schemastery Schema）；补齐 `dsh.pluginType`、
  `dsh.compatibility`（`dsh` / `dshReleases` / `dshOperations` / `profiles`）、
  `engines.node`、`homepage` / `bugs` / `author`、`peerDependenciesMeta`（宿主包可选）；
  `keywords` 加入分类键（`files`、`tools`）与中文用途词；规范化 `repository.url`。
- Tool 卡片契约：`read_document` / `write_document` 实现 `presentCall` / `presentResult`
  （`generic` 卡片 + `kind` + `locations`；生成物是二进制，不伪造 `diff`），
  presenter 为纯函数，成功时返回 `undefined` 走通用兜底。
- 随包 Skill 正文内嵌到 `src/skills/embedded-skill.ts`：插件**加载期不再读文件**，
  `source` 改为语义正确的 `'bundled'`（原先传的是文件路径）。改 `SKILL.md` 后必须重新生成。
- 新增 `PERMISSIONS.md`（依赖/权限/外部服务/失败边界声明，供 STORE 复核）、
  `SECURITY.md`（风险分级 R1、能力摘要、边界自检、漏洞报告）与本文件 `CHANGELOG.md`。

### 测试与 CI

- 新增 `tests/store-gate-replica.mjs`：DSH STORE 固定源自动策略的本地只读副本
  （逐条对齐上游 `automate-catalog.mjs` / `automation-source-policy.mjs` /
  `automation-policy.json`），动态从 npm Registry 解析官方最新三版窗口。
- 新增 `tests/oracle-zip-ooxml.test.mjs`（21 例）与 `tests/oracle-pdf.test.mjs`（29 例）：
  以 `mammoth` / `xlsx` / `docx` / `pdf-parse` 为对照验证自研实现，另含畸形输入、
  边界（`maxBytes` / `maxPages` / `maxChars` / `maxObjects`）与失败路径。
- 新增 `tests/real-backend.test.mjs`：挂载**真实**的 `@deepseek-ai/dsh-fs-local` 与真实
  cordis Context，验证 `fs-channel` 的调用约定（本机无 DSH 安装时整组跳过）。
- 新增 `tests/fs-stub.mjs`：测试用的宿主 `ctx.fs` 后端替身（生产代码零文件访问）。
- 主套件 `tests/tests.mjs` 增加三类**合规回归**：源码不得出现直接文件访问、进程环境变量读取、
  被扫描器判定为凭据的记号；以及内嵌 Skill 与 `SKILL.md` 的同步性、`apply()` 不读文件。
- CI：`verify:publish-policy` 改为**阻断性**检查——任何一次重新引入运行依赖、直接文件访问、
  环境变量读取或凭据记号都会让 CI 失败，而不是等八小时后被商城判为 `blocked`。
- 测试规模：主套件 + 真实后端契约 + 两个对照套件，**共 78 例全绿（0 跳过）**。

### 已知边界（与 `src/pdf/text-extract.ts` 导出的 `UNSUPPORTED` 一致）

| 能力 | 不覆盖 |
|------|--------|
| PDF 文本提取 | 不解密；不解析 CFF/Type1 字形名表；不建模竖排与 Type3 字形矩阵；图像滤镜（DCT/JPX/JBIG2/CCITT）无文本；不处理标签化 PDF 的阅读顺序、表单 XObject、注释与元数据；不做 Unicode 规范化、跨行断词与分栏检测 |
| PDF 生成 | 仅 TrueType 轮廓（TTF/TTC），不支持 CFF/OTF；纯 ASCII 产物体积约为二进制版 2 倍 |
| DOCX | 不解析批注/修订/文本框 |
| XLSX | 不计算公式（返回缓存值）；读取时每行补齐到最大列宽；布尔以 `'TRUE'`/`'FALSE'` 文本返回 |
| ZIP / OOXML | 不支持加密条目、ZIP64 与非标准扩展；写入只生成单工作表/单文档体 |

### 实测兼容的 DSH 版本

| DSH 版本 | 安装 | 配置合成 | 加载并注册 | 备注 |
|----------|------|----------|------------|------|
| `0.1.7-rc.2` | passed | passed | passed | 商店当前窗口 |
| `0.1.7-rc.1` | passed | passed | passed | 商店当前窗口 |
| `0.1.7-alpha.2` | passed | passed | passed | 商店当前窗口 |
| `0.1.5-rc.3` | passed | passed | passed | 官方 npm `latest` |
| `0.1.5-rc.1` | passed | passed | passed | 另在运行中的 web profile 里加载过 |

`start`（完整应用启动）与 `uninstall` / `rollback` 一律保持 `unknown`：
未执行完整启动（无凭据环境下 headless 会停在模型调用前），卸载/回滚需在真实 Profile 上单独立项。
逐版本声明在 `package.json` 的 `dsh.compatibility.dshReleases` / `dshOperations`，与本表逐项一致。

---

## [0.1.1] — 2026-09-05

- 在 `v0.1.0-rc.12` 基础上适配 **DSH 0.1.2-alpha.5**（`@deepseek-ai/dsh`、
  `@deepseek-ai/dsh-tools` 均为 0.1.2-alpha.5，cordis 4.0.2）。
- 保持对 `v0.1.0-rc.12` 的向后兼容；`peerDependencies` 覆盖
  `@deepseek-ai/cordis` 4.x 与 `@deepseek-ai/dsh-tools` `>=0.1.0-rc.12 <0.2.0`。
- CI：测试在无 CJK 字体的环境不再失败（Linux 安装 `fonts-wqy-zenhei`）。

## [0.1.0] — 2026-08-24

- 初代版：`read_document` / `write_document` 两个工具，支持 PDF/DOCX/XLSX/CSV 读取与
  DOCX/XLSX/CSV/PDF 生成；PDF 生成自带 TrueType 解析、字形子集化与 A4 排版。
- 健壮性：超长内容截断（50,000 字符）、CSV 的 GBK/GB18030 回退解码、
  相对路径按会话工作区解析；随仓库附带 `lib/` 预编译产物与测试套件。

---

[0.2.0]: https://github.com/qingmumingyang/dsh-doc-toolkit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/qingmumingyang/dsh-doc-toolkit/releases/tag/v0.1.1
[0.1.0]: https://github.com/qingmumingyang/dsh-doc-toolkit/releases/tag/v0.1.0
