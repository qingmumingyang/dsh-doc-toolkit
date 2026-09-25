# SECURITY — dsh-doc-toolkit

本文件是插件的安全与权限声明入口，遵循 `build-dsh-plugin` 的标准 bundle 契约
（`references/boundaries.md`）：**当插件涉及权限或外部依赖时，包内应提供 `SECURITY.md`**。
完整的权限/依赖/失败边界矩阵见 [`PERMISSIONS.md`](PERMISSIONS.md)。

- 包名：`dsh-doc-toolkit`　版本：`0.2.0`　许可证：MIT
- 仓库：<https://github.com/qingmumingyang/dsh-doc-toolkit>

## 风险分级

按 `build-dsh-plugin` 的风险评分卡：

| 项 | 结论 |
|----|------|
| **风险等级** | **R1** —— 注册宿主 Tool，操作用户自己指定的文档文件；**不写** Profile、不改 DSH 源码、不重启宿主、不做远程控制 |
| 证据等级 | **E3（部分）**：一次性 `DSH_HOME` 下官方 CLI 安装 + `--dump-config` 配置合成 + 在 DSH 0.1.7-rc.2 宿主 API 上的模块加载与工具注册；自研解析器另有以成熟库为对照的自动化用例（E2）。**未**完成完整应用启动（`start` 保持 `unknown`） |
| 变更边界 | 读取不改变文件；写入只发生在模型显式调用的 `write_document`，且**受调用会话的沙箱模式约束** |

## 能力摘要（保守申报）

| 能力 | 状态 | 说明 |
|------|------|------|
| 文件读取 | **有**（任意路径） | 经宿主 `ctx.fs`（`resolve` + `stat` + `readBytes`）；`fs-sandbox` 明确读不受限 |
| 文件写入 | **有**（受会话沙箱围栏） | 经宿主 `ctx.fs.writeText`；`workspace-write` 下只能写工作区或临时目录，`read-only` 拒绝，`danger-full-access` 不限制 |
| 网络 | **无** | 无网络模块 import、无 `fetch`/`WebSocket`/`EventSource` |
| 命令执行 | **无** | 无 `child_process`、无 shell、无外部二进制 |
| 凭据访问 | **无** | 无进程环境变量读取、无 keychain/OAuth/凭据文件访问 |
| 安装期脚本 | **无** | 未定义 `preinstall`/`install`/`postinstall`/`prepare` |
| 外部服务 | **无** | 无遥测、无回传、无第三方 API |
| 官方组件改动 | **无** | 不修改、不遮蔽、不替换任何 `@deepseek-ai/*` 包或官方插件清单 |

## 依赖

**运行时依赖为零。** `dependencies` 与 `optionalDependencies` 均为空：ZIP/OOXML 的 DOCX、
XLSX 读写与 PDF 文本提取都是本仓库自研实现，避免把第三方运行时代码带进用户进程。
`devDependencies` 中的 `pdf-parse`、`mammoth`、`xlsx`、`docx` **只在测试中作为对照实现**
（oracle），不随包发布、不参与运行。

宿主依赖（`peerDependencies`，标记 optional，由 DSH 提供）：`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`；运行时另需宿主已挂载 `ctx.fs`
（`inject` 中静态声明 `['tools', 'fs']`）。

## 产物完整性与注入面

- 解析输入（PDF/DOCX/XLSX/CSV）来自**不可信文件**，因此所有解析器都按边界实现：
  入口有 `maxBytes`/`maxPages`/`maxChars`/`maxObjects` 上限，ZIP 读取校验中央目录与条目大小，
  XML 处理只做词法解析、不执行实体展开（不解析 DTD/外部实体），因此不存在 XXE 面。
- 生成物是**纯 ASCII**：DOCX/XLSX 用 STORED 条目 + 数字字符引用的 ASCII ZIP；PDF 把二进制流
  编码为 ASCIIHexDecode。`bytesToAsciiText()` 遇到任何非 ASCII 字节直接报错，绝不静默写出坏文件。
- 写入路径经 `ctx.fs.resolve` 规范化，由后端的包含性检查与沙箱策略决定能否落盘，插件不自行拼接
  或绕过路径校验。

## 边界自检（对应 boundaries.md 第 10 节的硬性阻断项）

- ✅ 不修改 DSH 源码或 `@deepseek-ai/*` 包；不调用 Loader/Fiber 变更 API
- ✅ 不遮蔽或替换官方插件清单；不使用 `@deepseek-ai/*` 命名空间
- ✅ 无 Browser Client 代码，因此不存在"客户端导入 Host/Node 模块"的问题
- ✅ Tool presenter 是纯函数：不 I/O、不读会话/Profile、不取时钟/随机数；`rawInput` 为空，
  卡片只含模型可见路径与短标题，无密钥、无完整私有文件、无界参数
- ✅ 不注册 `tool.call.toolview` 键，不替换官方 Tool 卡片
- ✅ 测试使用临时目录与临时 `DSH_HOME`，从不写入真实 `~/.dsh`
- ✅ 无 Profile 生命周期操作（安装/卸载一律交给官方 `dsh plugin` CLI）
- ✅ 运行期不写日志中的密钥、不返回完整私有文件

## 漏洞与安全问题报告

请通过 GitHub Issues 报告：<https://github.com/qingmumingyang/dsh-doc-toolkit/issues>

报告时请附上 DSH 版本、操作系统、复现步骤与错误信息。**请勿**在 Issue 中粘贴
API key、完整 Profile 文件或任何凭据；也不要提交真实业务文档，改用最小复现样例。
