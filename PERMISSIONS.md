# PERMISSIONS — dsh-doc-toolkit 权限与失败边界声明

本文件供 **DSH STORE 自动审查与人工复核**使用，如实描述插件在运行时**做什么**、
**不做什么**、**依赖什么**，以及**失败边界**。所有描述对应仓库中提交的固定源码，
可逐条核对。

- 声明版本：`0.2.0`
- 适用仓库：<https://github.com/qingmumingyang/dsh-doc-toolkit>
- 包名：`dsh-doc-toolkit`（未使用 `@deepseek-ai/*` 命名空间）

---

## 一、运行时行为

| 维度 | 事实 |
|------|------|
| **目的** | 向 DSH 模型暴露两个文档工具：`read_document`（读取 PDF/DOCX/XLSX/CSV 文本）与 `write_document`（生成 DOCX/XLSX/CSV/PDF），并在插件加载时注册一个随包 Skill（`doc-toolkit-usage`）说明何时、如何调用。 |
| **文件读取** | 全部经宿主 **`ctx.fs`** 服务（`resolve` + `stat` + `readBytes`）：(1) 工具参数指定的文档文件；(2) 生成含中文 PDF 时按候选列表探测系统中文字体。读取不改变文件。 |
| **文件写入** | 全部经宿主 **`ctx.fs.writeText`**：原子写、父目录按需创建、**受调用会话的沙箱模式约束**（`workspace-write` 下只放行工作区与临时目录，`read-only` 拒绝，`danger-full-access` 不限制）。会覆盖同路径已存在文件。 |
| **命令执行** | **无。** 不 import `child_process`，不调用 `exec/spawn/fork`，不调用 shell，不依赖任何外部二进制。 |
| **网络** | **无。** 不 import `http/https/net/tls/dgram`，不调用 `fetch`，不在运行时下载任何资源。 |
| **凭据 / 密钥** | **不读取、不写入、不转发。** 运行源码中**不存在任何进程环境变量读取**，不访问 keychain、OAuth、`.npmrc`、`.netrc`、SSH 私钥或任何凭据存储。字体路径由插件配置提供。 |
| **外部服务** | **无。** 无遥测、无回传、无 Webhook、无第三方 API。 |
| **全局资源** | **不修改** DSH 源码或任何 `@deepseek-ai/*` 包；不写 Profile 配置；不安装全局包；不注册 Loader/Fiber 变更；不遮蔽官方插件清单。 |
| **生命周期脚本** | **无。** `preinstall`/`install`/`postinstall`/`prepare` 均未定义（`prepublishOnly` 仅供作者本地发布前编译，不参与安装）。 |
| **插件自身加载** | **不读文件。** 随包 Skill 的正文内嵌在 `src/skills/embedded-skill.ts`（由 `SKILL.md` 生成，有同步性测试），因此 `apply()` 期间零文件访问。 |

### 配置入口（替代环境变量）

CJK 字体候选由 **Cordis 标准插件配置**提供：

```yaml
# 使用者 Profile 的 patch 层（或在 profile 中覆盖该插件行的 config）
- insert:
  - id: dsh-doc-toolkit
    name: dsh-doc-toolkit
    config:
      cjkFonts:
        - 'C:\Windows\Fonts\msyh.ttc'
        - '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
```

插件导出 `Config`（Schemastery Schema）声明该字段；`cjkFonts` 中的路径优先于内置
系统字体候选，缺省为空数组（只用内置候选）。

---

## 二、依赖

### 运行时依赖：**无**

`dependencies` 与 `optionalDependencies` 均为空；`bundledDependencies` 未使用。
DOCX/XLSX 的 ZIP + OOXML 读写、PDF 文本提取、PDF 生成全部为本仓库自研实现，
不引入任何第三方运行时代码。

### 宿主依赖（`peerDependencies`，由 DSH 运行时提供，不随包安装）

| 包 | 用途 |
|----|------|
| `@deepseek-ai/cordis` | 插件生命周期与配置校验 |
| `@deepseek-ai/dsh-tools` | 工具注册表（`ctx.tools`）与 `defineTool` |
| `@deepseek-ai/schemastery` | 导出 `Config` Schema |

三者均标记 `peerDependenciesMeta.optional = true`，表示由宿主提供、不由本插件安装。
运行时还要求宿主已挂载文件系统服务 `ctx.fs`（`@deepseek-ai/dsh-fs` 由 `fs-local` 或
`fs-sandbox` 后端提供），插件在 `inject` 中静态声明 `['tools', 'fs']`。

### 开发依赖（`devDependencies`，**仅测试使用，不随包发布、不参与运行**）

`pdf-parse`、`mammoth`、`xlsx`、`docx` 保留为**测试对照（oracle）**：自研解析器的
用例拿它们当参考实现比对，从而证明自研实现没有跑偏。它们不在 `dependencies` 中，
安装插件时不会被安装，运行时也不会被加载。

---

## 三、权限矩阵

| 权限 | 声明值 | 依据 |
|------|--------|------|
| 汇总等级 `level` | **medium**（保守） | 可读任意路径文件；写入受会话沙箱约束，且不触及 Profile/会话状态 |
| `files` | **读：任意路径；写：会话可写根**（工作区 + 临时目录，随会话沙箱模式变化） | 全部经 `ctx.fs`；官方 `fs-sandbox` 明确"读不受限，变更按会话模式围栏" |
| `network` | **none** | 无网络模块 import，无 `fetch`/`WebSocket`/`EventSource` |
| `commands` | **none** | 无 `child_process`，无 `exec`/`spawn`/`fork`，无 `shell: true` |
| `credentials` | **none** | 无进程环境变量读取；无 keychain/OAuth/凭据文件访问 |
| 原生制品 | **none** | 无 `.node`/`.wasm`/`.dll`/`.dylib`/`.so`/`.exe`/`.bin` |
| 风险等级 | **R1** | 注册宿主 Tool 操作用户文档；不写 Profile、不改 DSH 源码、不重启宿主 |

> 说明：DSH STORE 的固定源自动策略在零信号时会记为 `low`。这里申报 `medium` 是**更保守**
> 的口径——因为经 `ctx.fs` 的读取确实可以触达工作区之外的路径，写入则受会话沙箱围栏。

### 文件权限信号说明

- 运行时**不**执行 `chmod`/`chown`，不设置 setuid/setgid/sticky；生成文件使用宿主默认权限。
- 仓库所有文件以 `100644` 提交，**无可执行位**。
- 无子进程 → 不依赖可执行位。

### 产物为什么是纯 ASCII（可复核的设计约束）

`ctx.fs` 只有文本写入 API（`writeText`），没有写字节的接口。因此生成物被设计为**纯 ASCII**，
UTF-8 编码对 ASCII 逐字节保真：

- **DOCX / XLSX**：自研 ZIP 写入器只使用 STORED（不压缩）条目，路径与 XML 内容全部 ASCII
  （非 ASCII 字符以数字字符引用 `&#xNNNN;` 表示）。ZIP 自身的结构字段（CRC-32、大小、偏移）
  本来是二进制，写入器用两个自由度把它们也收敛进 ASCII：**逐条补白换行**（同时改变大小与
  CRC）直到两个字段都安全，必要时再补一个**合法的本地扩展字段**把下一条目的偏移推进安全区；
  中央目录大小用中央扩展字段（极端情况下用中央目录数字签名记录）收敛。条目之间保持紧邻，
  因为 Office 的 OPC 读取器拒绝不连续的本地条目。
- **PDF**：含二进制的流（内嵌字体子集）编码为 `/Filter [/ASCIIHexDecode /FlateDecode]`；
  页面内容流与 ToUnicode CMap 本就是 ASCII 文本，原样写入。文件头也不再使用二进制标记。

`bytesToAsciiText()` 会在出现任何非 ASCII 字节时**直接报错**，而不是静默写出损坏文件；
ZIP 写入器与 PDF 组装器各自还有一层"输出必须全 ASCII"的断言，任何一条路径失守都会在写出前失败。

---

## 四、失败边界（结构化，不静默）

| 场景 | 行为 |
|------|------|
| PDF 为扫描件（无文本层） | 返回空内容并说明不支持 OCR，**不**伪造结果 |
| PDF 带 `/Encrypt` | 明确报错并提示另存为未加密副本，**不**输出乱码。注意：**只设了所有者口令、用户口令为空的 PDF** 也会走到这里——pdf.js 能用空口令解密，本实现不实现解密，因此这类文件读不了（已知差距） |
| PDF 交叉引用损坏 | 先按 `startxref` 解析经典表/交叉引用流；失败则回退到全文件扫描 `N G obj` 重建索引；仍拿不到 `/Root` 才报错，且绝不挂起（有 `maxBytes`/`maxPages`/`maxChars`/`maxObjects` 边界） |
| PDF 内容流用了不支持的过滤器（DCT/JPX/JBIG2/CCITT/LZW） | 该页按"无文本"处理，不抛错、不输出乱码 |
| 单次读取 > 50,000 字符 | 截断并标记 `truncated: true`；XLSX/CSV 可用 `offset`/`limit` 翻页 |
| 单文件 > 64 MiB | 读取前按 `stat` 结果拒绝，不整块读入内存 |
| 写入被会话沙箱拒绝 | 返回带模式说明的结构化错误（`FS_SANDBOX_DENIED`），提示改用工作区内路径 |
| 文件不存在 / 扩展名不支持 | 返回结构化错误文本，不抛未捕获异常 |
| 含非 ASCII 内容但找不到 TTF/TTC 字体 | 返回明确错误并**不生成**文件；提示用 `cjkFonts` 配置指定字体 |
| 字体缺少部分字形 | 缺字降级为不渲染，并在返回消息中注明缺失数量 |
| 写入路径已存在 | **直接覆盖**（已在工具描述与 README 中明示） |
| 与其它插件注册同名工具 | 注册期抛错（工具名冲突），不静默覆盖 |
| CSV 非 UTF-8 | 回退 GBK/GB18030 解码，兼容 Excel 导出的中文 CSV |
| XLSX 数字写法 | 按 Excel 口径：`'007'`→`7`、`'2.50'`→`2.5`、`'1e3'`→`1000`（**会规范化**）；`'1,000'`、`'abc'`、`''` 保持文本。需要原样保留前导零（邮编/工号）时请改用 CSV |
| XLSX 稀疏单元格 | `null`/`undefined`（含稀疏数组空洞）**不写单元格**，保留真正的稀疏表示 |
| 缺失 `skills` 服务 | 跳过 Skill 注册并记录 warning，工具功能不受影响 |

### 自研解析器的已知不覆盖范围（诚实申报）

与 `src/pdf/text-extract.ts` 导出的 `UNSUPPORTED` 列表一致（可代码核对）：

- **PDF 文本提取**：**不解密**（带 `/Encrypt` 一律报错，含"仅所有者口令、用户口令为空"这类
  pdf.js 能读的文件）；不解析 CFF/Type1 字形名表（Unicode 只来自 `/ToUnicode`、
  `/Encoding /Differences` 或码位本身）；不建模竖排（`/Identity-V`、`/WMode 1`）的列序与旋转；
  Type3 按默认 500/1000 宽度处理；图像滤镜（DCT/JPX/JBIG2/CCITT）不产生文本；
  不解析 `/UseCMap` 间接引用；不处理标签化 PDF（`/StructTreeRoot`、`/ActualText`），
  因此阅读顺序即内容流顺序；不处理表单 XObject、注释、页标签与文档元数据；
  不做 Unicode 规范化、跨行断词还原与分栏检测。
- **ZIP / OOXML**：不支持加密条目、ZIP64 与非标准 OOXML 扩展；写入只生成单工作表/单文档体；
  XLSX 读取把每行补齐到工作表最大列宽（矩形），`t="b"` 单元格返回 `'TRUE'`/`'FALSE'` 文本。
- **PDF 生成**：只支持 TrueType 轮廓（TTF/TTC），不支持 CFF/OTF 字体；产物为纯 ASCII
  （内嵌字体流走 ASCIIHexDecode，体积约为二进制版的 2 倍）。

---

## 五、DSH STORE 门禁状态

`0.2.0` 的目标是**通过固定源自动策略**（从而自动进入 `approved` 可安装状态）：

| 自动策略门禁 | 状态 |
|--------------|------|
| manifest 仓库与 canonical 一致 | ✅ |
| 显式 `files` 清单 | ✅ |
| DSH / Node 兼容性显式声明 | ✅ |
| 无安装期生命周期脚本 | ✅ |
| **无运行时/可选依赖** | ✅ 已清零（四个库移入 `devDependencies` 仅作测试对照） |
| **无 `files` 权限信号** | ✅ 已清零（全部改走 `ctx.fs`） |
| **无 `credentials` 权限信号** | ✅ 已清零（移除全部环境变量读取，并避免扫描器判定为凭据的记号） |
| 无 network / commands / protectedDsh 信号 | ✅ |
| 无原生制品与可执行位 | ✅ |
| 运行源码数量与体积边界 | ✅ |
| 官方最新三版窗口内有精确 `compatible` 声明 | ✅（`0.1.7-rc.2` 实测） |

复核方式：`npm run verify:publish-policy`（`tests/store-gate-replica.mjs`，只读复刻上游
`automate-catalog.mjs` / `automation-source-policy.mjs` / `automation-policy.json` 的判定，
并动态从 npm Registry 解析官方最新三版窗口）。

---

## 六、已执行的验收记录（可复核）

按 `build-dsh-plugin` 的证据阶梯记录，**不把低层证据写成高层结论**。

| 版本 | 安装 | 启动 | 卸载 | 回滚 | 本次直接观察到的证据 |
|------|------|------|------|------|----------------------|
| `0.1.7-rc.2` | **passed** | unknown | unknown | unknown | 一次性 `DSH_HOME` 下 `dsh plugin --profile compat add link:…` 成功；`--dump-config` 合成出 `id: dsh-doc-toolkit` / `config.cjkFonts: []`；用该版本真实的 `@deepseek-ai/dsh-tools` 0.1.7-rc.2 加载 **0.2.0 构建产物**，`Config({})` → `{cjkFonts: []}`，两个工具（含卡片 presenter）与 skill（`source: bundled`）均注册成功 |
| `0.1.7-rc.1` | **passed** | unknown | unknown | unknown | 同上三项（安装 / `--dump-config` / 用该版本真实 `dsh-tools` 0.1.7-rc.1 加载并注册），全部通过 |
| `0.1.7-alpha.2` | **passed** | unknown | unknown | unknown | 同上三项，全部通过（该版本也是商店当前窗口的一员） |
| `0.1.5-rc.3` | **passed** | unknown | unknown | unknown | 同上三项，全部通过（官方 npm `latest`） |
| `0.1.5-rc.1` | **passed** | **passed** | unknown | unknown | 在运行中的 web Profile 里以 `link:` 安装并处于 bundles 列表；两个工具与 skill 在会话中可用（当时构建的是 0.2.0 之前的中间态，0.2.0 的工具契约未变） |

一次性验收的具体做法（可复现）：临时 `DSH_HOME` → `npx @deepseek-ai/dsh@<版本> plugin --profile compat add link:<插件目录>`
→ 同版本 `--dump-config` → 在沙箱里用**该版本的** `@deepseek-ai/dsh-tools` / `schemastery` / `cordis`
加载 `lib/index.js`，断言导出 `Config/apply/inject/name`、`Config({})` 结果、两个工具与一个 Skill
（`source === 'bundled'`）注册成功。

未完成的部分：**没有**执行完整应用启动（headless 启动在无凭据环境下会停在模型调用前），
因此 `start` 不写成 `passed`；卸载/回滚需要在真实 Profile 上单独立项，故保持 `unknown`。
这些值与 `package.json` 的 `dsh.compatibility.dshOperations` 逐项一致。

---

## 七、给复核者的核对入口

| 想确认的事 | 看哪里 |
|------------|--------|
| 是否直接访问文件系统 | `src/utils/fs-channel.ts`（唯一 I/O 通道）；`npm run verify:publish-policy` 会报 `files` 信号 |
| 是否有环境变量/凭据访问 | 同上（`credentials` 信号）；另有 `tests/tests.mjs` 的回归用例 |
| 是否有网络 / 命令执行 | 同上（`network` / `commands` 信号） |
| 运行依赖清单 | `package.json` 的 `dependencies`（应为空） |
| 安装期脚本 | `package.json` 的 `scripts`（无 `preinstall`/`install`/`postinstall`/`prepare`） |
| 权限位与原生制品 | `git ls-files -s`（全部 `100644`） |
| 逐版本兼容声明 | `package.json` 的 `dsh.compatibility` |
| 自研解析器的正确性 | `tests/oracle-zip-ooxml.test.mjs`、`tests/oracle-pdf.test.mjs`（以成熟库为对照） |
