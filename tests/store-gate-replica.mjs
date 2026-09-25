#!/usr/bin/env node
/**
 * DSH STORE 固定源自动策略的**本地只读副本**。
 *
 * 目的：在推送之前就知道 `AI-Scarlett/DSH-Store` 的八小时自动复检会给出哪些
 * 确定性原因，而不是等 8 小时后看 Catalog 状态。
 *
 * 复刻来源（逐条对齐，不是近似）：
 *   - DSH-Store/scripts/automate-catalog.mjs        → analyzeFixedSource()
 *   - DSH-Store/src/automation-source-policy.mjs    → permissionSignals() / missingRuntimeEntryReasons()
 *   - DSH-Store/src/catalog-update-review.mjs       → sourceDeclaredCompatibility()
 *   - DSH-Store/scripts/check-plugin-submission.mjs → inferredCompatibility()
 *   - DSH-Store/registry/automation-policy.json     → sourceBounds / automaticApproval
 *
 * 边界：本脚本只读仓库文件，**不执行**插件运行时代码、不访问网络上的插件源码、
 * 不修改任何东西。它证明的是“固定源自动策略”这一道门，不等于真实 Profile 安装
 * 验收，也不等于独立安全审计。
 *
 * 用法：
 *   node tests/store-gate-replica.mjs                 # 人类可读报告
 *   node tests/store-gate-replica.mjs --json          # 机器可读
 *   node tests/store-gate-replica.mjs --dsh-window a,b,c   # 手动指定官方最新三版窗口
 *
 * 退出码：0 = 自动策略通过（零原因）；1 = 存在确定性门禁原因。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 与 DSH-Store 一致的常量
// ---------------------------------------------------------------------------
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|rb|go|rs)$/i
const NATIVE_FILE = /\.(?:node|wasm|dll|dylib|so|exe|bin)$/i
const EXCLUDED_DIRECTORY = /(?:^|\/)(?:node_modules|vendor|test|tests|docs?|examples?|fixtures?|benchmarks?|coverage|\.github)(?:\/|$)/i
const EXCLUDED_METADATA_FILE = /(?:^|\/)(?:brief\.json|catalog-entry(?:\.draft)?\.json)$/i
const TEST_SOURCE_FILE = /^(?:test|spec)[-_.].*\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|rb|go|rs)$/i
const SUFFIXED_TEST_SOURCE_FILE = /^.+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** registry/automation-policy.json 的快照值（若上游调整，这里需要同步）。 */
const POLICY = {
  sourceBounds: { maxTreeEntries: 1200, maxRuntimeFiles: 240, maxFileBytes: 262144, maxTotalRuntimeBytes: 2097152 },
  automaticApproval: {
    requireManifestRepositoryMatch: true,
    requireRepositoryLicenseMatch: true,
    requireExplicitFiles: true,
    requireDshCompatibility: true,
    requireNodeCompatibility: true,
    allowLifecycleScripts: false,
    allowRuntimeDependencies: false,
    allowSymlinks: false,
    allowSubmodules: false,
    permissionSignals: {
      files: false, network: false, commands: false, credentials: false,
      protectedDsh: false, nativeOrExecutableArtifacts: false,
    },
  },
  compatibility: { requiredCompatibleReleases: 1, latestReleaseCount: 3 },
}

/** 官方 canonical 仓库地址（用于仓库一致性门禁）。 */
const CANONICAL_REPOSITORY = 'https://github.com/qingmumingyang/dsh-doc-toolkit'

// ---------------------------------------------------------------------------
// 权限信号：与 DSH-Store/src/automation-source-policy.mjs 逐字一致
// ---------------------------------------------------------------------------
const moduleImport = (names) => new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["'](?:node:)?(?:${names})["']`,
  'i',
)

const FILE_MODULE = moduleImport('fs|fs/promises')
const NETWORK_MODULE = moduleImport('http|https|net|tls|dgram|axios|got|undici')
const COMMAND_MODULE = moduleImport('child_process')
// 与上游一致：忽略 RegExp#exec() / parser.exec() 这类成员调用，只匹配真正的命令函数调用。
const COMMAND_CALL = /(?:^|[^\w$.'"`])(?:exec|execFile|spawn|fork)\s*\(/im

function permissionSignals(source) {
  return {
    files: FILE_MODULE.test(source)
      || /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i.test(source)
      || /\$DSH_HOME|\.dsh\/profiles/i.test(source),
    network: NETWORK_MODULE.test(source)
      || /\b(?:fetch|WebSocket|EventSource)\s*\(/i.test(source)
      || /\b(?:axios|got|undici)\s*(?:\.|\()/i.test(source),
    commands: COMMAND_MODULE.test(source)
      || COMMAND_CALL.test(source)
      || /shell\s*:\s*true|Bun\.spawn|new\s+Deno\.Command/i.test(source),
    credentials: /process\.env/i.test(source)
      || /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i.test(source)
      || /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i.test(source),
    protectedDsh: /(?:\b__ModuleLoader__\s*\.\s*(?:unload|remove)\s*\(|\b(?:ctx\s*\.\s*)?(?:loader|fiber|Loader|Fiber)\s*\.\s*(?:insert|remove|patch|enable|disable|write|mutate|replace)\s*\(|@deepseek-ai\/[^\n]{0,160}disabled\s*:\s*true|tool\.call\.toolview)/i.test(source),
  }
}

function isTestSourceFile(relativePath) {
  const name = String(relativePath ?? '').split('/').at(-1) ?? ''
  return TEST_SOURCE_FILE.test(name) || SUFFIXED_TEST_SOURCE_FILE.test(name)
}

/** 与上游一致的 exports/main/module 运行产物存在性检查。 */
function missingRuntimeEntryReasons(manifest, trackedPaths) {
  const files = new Set(trackedPaths)
  const targets = new Set()
  const collect = (value) => {
    if (typeof value === 'string') targets.add(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(manifest.main)
  collect(manifest.module)
  collect(manifest.exports)
  collect(manifest.dsh?.client?.entry)
  return [...targets].filter((target) => !target.includes('*')).flatMap((target) => {
    const normalized = target.replace(/^\.\//, '')
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return [`runtime artifact path is invalid: ${target}`]
    return files.has(normalized) ? [] : [`runtime artifact is missing from the fixed Git Commit: ${target}`]
  })
}

function canonicalGithubRepository(value) {
  return String(value ?? '')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git\/?$/i, '')
    .replace(/\/$/, '')
}

// ---------------------------------------------------------------------------
// 仓库快照：取“提交后会上树”的文件清单 + 模式位
// （GitHub 树里的 100755 = 可执行位信号；120000 = 符号链接门禁）
//
// 同时纳入**尚未提交但不会被忽略**的新文件：上游扫描的是推送后的完整树，
// 本地自检必须在推送前就看到新文件，否则新增的运行源码会被漏掉。
// ---------------------------------------------------------------------------
function repositorySnapshot() {
  const rows = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((line) => line.trim() !== '')
  const tracked = rows.map((row) => {
    const [meta, path] = row.split('\t')
    const [mode] = meta.split(/\s+/)
    return { path: path.replace(/\\/g, '/'), mode, executable: mode === '100755', symlink: mode === '120000' }
  })
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line.trim() !== '')
    .map((path) => ({ path: path.replace(/\\/g, '/'), mode: '100644', executable: false, symlink: false, untracked: true }))
  return [...tracked, ...untracked]
}

function readWorkingTree(path) {
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// 官方最新三版窗口（npm Registry），失败时回退到快照值
// ---------------------------------------------------------------------------
const FALLBACK_WINDOW = ['0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1']
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'

async function resolveDshWindow(override) {
  if (override) return { window: override.split(',').map((v) => v.trim()).filter(Boolean), authority: 'command-line-override' }
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const meta = await response.json()
    const latest = meta['dist-tags']?.latest
    if (typeof latest !== 'string') throw new Error('dist-tags.latest missing')
    const series = latest.split('.').slice(0, 2).join('.')
    const released = Object.keys(meta.versions ?? {})
      .filter((version) => version.startsWith(`${series}.`))
      .filter((version) => meta.versions[version]?.deprecated === undefined)
      .map((version) => ({ version, at: Date.parse(meta.time?.[version] ?? '') || 0 }))
      .sort((left, right) => left.at - right.at)
      .map((entry) => entry.version)
    const window = released.slice(-POLICY.compatibility.latestReleaseCount)
    if (window.length < POLICY.compatibility.latestReleaseCount) throw new Error('fewer than three releases in series')
    return { window, authority: REGISTRY_URL }
  } catch (error) {
    return { window: FALLBACK_WINDOW, authority: `fallback-snapshot (registry unreachable: ${error.message})` }
  }
}

// ---------------------------------------------------------------------------
// 主分析
// ---------------------------------------------------------------------------
async function analyze(options) {
  const reasons = []
  const signals = {
    files: false, network: false, commands: false, credentials: false,
    protectedDsh: false, nativeOrExecutableArtifacts: false,
  }
  const signalSources = {}
  const manifest = JSON.parse(readWorkingTree('package.json'))
  const snapshot = repositorySnapshot()
  const trackedPaths = snapshot.map((entry) => entry.path)

  // --- manifest 级门禁 ---
  const manifestRepository = canonicalGithubRepository(
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url,
  )
  if (POLICY.automaticApproval.requireManifestRepositoryMatch && manifestRepository !== CANONICAL_REPOSITORY) {
    reasons.push(`manifest repository does not match the canonical GitHub repository (found ${manifestRepository || 'none'})`)
  }
  if (POLICY.automaticApproval.requireExplicitFiles && (!Array.isArray(manifest.files) || manifest.files.length === 0)) {
    reasons.push('manifest does not declare an explicit distributable files list')
  }
  const declared = manifest?.dsh?.compatibility && typeof manifest.dsh.compatibility === 'object' ? manifest.dsh.compatibility : {}
  const peerRanges = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range)
  const compatibilityDsh = typeof declared.dsh === 'string'
    ? declared.dsh
    : [...new Set(peerRanges)].length === 1 ? peerRanges[0] : null
  if (POLICY.automaticApproval.requireDshCompatibility && !compatibilityDsh) {
    reasons.push('DSH compatibility is not explicitly declared')
  }
  const compatibilityNode = typeof manifest.engines?.node === 'string' ? manifest.engines.node : null
  if (POLICY.automaticApproval.requireNodeCompatibility && !compatibilityNode) {
    reasons.push('Node.js compatibility is not explicitly declared')
  }
  const installScripts = LIFECYCLE_SCRIPTS.filter((name) => typeof manifest.scripts?.[name] === 'string')
  if (!POLICY.automaticApproval.allowLifecycleScripts && installScripts.length > 0) {
    reasons.push(`install lifecycle scripts are present: ${installScripts.join(', ')}`)
  }
  const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) }
  if (!POLICY.automaticApproval.allowRuntimeDependencies && Object.keys(dependencies).length > 0) {
    reasons.push('runtime or optional dependencies require a separate supply-chain review')
  }
  if (Array.isArray(manifest.bundledDependencies) && manifest.bundledDependencies.length > 0) {
    reasons.push('bundled dependencies are not eligible for automatic approval')
  }
  reasons.push(...missingRuntimeEntryReasons(manifest, trackedPaths))

  // --- 树级门禁 ---
  if (snapshot.length === 0 || snapshot.length > POLICY.sourceBounds.maxTreeEntries) {
    reasons.push(`repository tree exceeds the automatic review bound: ${snapshot.length} entries (maximum ${POLICY.sourceBounds.maxTreeEntries})`)
  }
  if (!POLICY.automaticApproval.allowSymlinks && snapshot.some((entry) => entry.symlink)) reasons.push('package contains symbolic links')
  if (!POLICY.automaticApproval.allowSubmodules && snapshot.some((entry) => entry.mode === '160000')) reasons.push('package contains Git submodules')

  // --- 运行源码选择（与上游 runtimeFiles 过滤顺序一致：先排除目录/测试文件，再判原生制品） ---
  const runtimeFiles = snapshot.filter((entry) => {
    if (EXCLUDED_DIRECTORY.test(entry.path)) return false
    if (EXCLUDED_METADATA_FILE.test(entry.path)) return false
    if (isTestSourceFile(entry.path)) return false
    if (NATIVE_FILE.test(entry.path) || entry.executable) signals.nativeOrExecutableArtifacts = true
    return SOURCE_FILE.test(entry.path)
  })

  // 跟踪过但工作区已删除的文件：提交后就不在树里了，不参与体积计算，
  // 但要让作者看见（否则容易误以为本地状态与推送后的树一致）。
  const pendingDeletions = runtimeFiles
    .filter((entry) => !existsSync(entry.path))
    .map((entry) => entry.path)
  const scannableFiles = runtimeFiles.filter((entry) => !pendingDeletions.includes(entry.path))

  const countWithinBounds = scannableFiles.length > 0 && scannableFiles.length <= POLICY.sourceBounds.maxRuntimeFiles
  if (!countWithinBounds) {
    reasons.push(`runtime source file count is outside the automatic review bound: ${scannableFiles.length} files (maximum ${POLICY.sourceBounds.maxRuntimeFiles})`)
  }
  const sizes = scannableFiles.map((entry) => statSync(entry.path).size)
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0)
  const largest = Math.max(0, ...sizes)
  const bytesWithinBounds = sizes.every((size) => size <= POLICY.sourceBounds.maxFileBytes)
    && totalBytes <= POLICY.sourceBounds.maxTotalRuntimeBytes
  if (!bytesWithinBounds) {
    const worst = scannableFiles.map((entry) => ({ path: entry.path, size: statSync(entry.path).size }))
      .sort((left, right) => right.size - left.size).slice(0, 3)
      .map((item) => `${item.path} (${item.size})`).join(', ')
    reasons.push(`runtime source exceeds the automatic review byte bound: ${totalBytes} total bytes (maximum ${POLICY.sourceBounds.maxTotalRuntimeBytes}); largest file ${largest} bytes (maximum ${POLICY.sourceBounds.maxFileBytes}); largest: ${worst}`)
  }
  if (countWithinBounds && bytesWithinBounds) {
    for (const entry of scannableFiles) {
      const detected = permissionSignals(readWorkingTree(entry.path))
      for (const [signal, value] of Object.entries(detected)) {
        if (!value) continue
        signals[signal] = true
        ;(signalSources[signal] ??= []).push(entry.path)
      }
    }
  }
  for (const [signal, allowed] of Object.entries(POLICY.automaticApproval.permissionSignals)) {
    if (!allowed && signals[signal]) reasons.push(`runtime source contains the ${signal} permission signal`)
  }

  // --- 逐版本兼容声明 ---
  // 上游 dshReleaseVersion() 接受完整 SemVer，也接受 catalog.mjs 的历史别名 rc.7 / rc.8。
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  const supportedReleaseKey = (release) => SEMVER.test(release) || release === 'rc.7' || release === 'rc.8'
  const releaseStatuses = new Map()
  for (const [release, status] of Object.entries(declared.dshReleases ?? {})) {
    if (!supportedReleaseKey(release)) reasons.push(`dshReleases key ${release} is not a supported DSH release key`)
    if (!['compatible', 'incompatible', 'unknown'].includes(status)) reasons.push(`dshReleases.${release} has an invalid status`)
    releaseStatuses.set(release, status)
  }
  for (const [release, record] of Object.entries(declared.dshOperations ?? {})) {
    if (!supportedReleaseKey(release)) reasons.push(`dshOperations key ${release} is not a supported DSH release key`)
    const operations = ['install', 'start', 'uninstall', 'rollback']
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).some((operation) => !operations.includes(operation))) {
      reasons.push(`dshOperations.${release} must declare install, start, uninstall, and rollback`)
      continue
    }
    for (const operation of operations) {
      const status = record[operation] ?? 'unknown'
      if (!['passed', 'failed', 'unknown'].includes(status)) {
        reasons.push(`dshOperations.${release}.${operation} must be passed, failed, or unknown`)
      }
    }
  }
  const window = await resolveDshWindow(options.dshWindow)
  const compatibleInWindow = window.window.filter((release) => releaseStatuses.get(release) === 'compatible')
  const compatibilityHold = compatibleInWindow.length < POLICY.compatibility.requiredCompatibleReleases

  return {
    manifest: { name: manifest.name, version: manifest.version, license: manifest.license },
    canonicalRepository: CANONICAL_REPOSITORY,
    dshCompatibility: compatibilityDsh,
    nodeCompatibility: compatibilityNode,
    runtimeDependencies: Object.keys(dependencies).sort(),
    installScripts,
    treeEntries: snapshot.length,
    runtimeFiles: scannableFiles.length,
    pendingDeletions,
    runtimeBytes: totalBytes,
    largestRuntimeFile: largest,
    signals,
    signalSources,
    dshWindow: window.window,
    dshWindowAuthority: window.authority,
    compatibleInWindow,
    dshReleases: Object.fromEntries(releaseStatuses),
    // 自动策略通过 = 零原因。兼容性窗口属于“可上架”的独立门禁，单独报告。
    automaticPolicyReasons: [...new Set(reasons)].slice(0, 20),
    compatibilityHold,
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const json = argv.includes('--json')
const windowIndex = argv.indexOf('--dsh-window')
const report = await analyze({ dshWindow: windowIndex >= 0 ? argv[windowIndex + 1] : null })

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('DSH STORE 固定源自动策略 — 本地副本（只读）')
  console.log('='.repeat(72))
  console.log(`包                 ${report.manifest.name}@${report.manifest.version} (${report.manifest.license})`)
  console.log(`canonical 仓库      ${report.canonicalRepository}`)
  console.log(`DSH 兼容声明        ${report.dshCompatibility ?? '(未声明)'}`)
  console.log(`Node 兼容声明       ${report.nodeCompatibility ?? '(未声明)'}`)
  console.log(`运行依赖            ${report.runtimeDependencies.length > 0 ? report.runtimeDependencies.join(', ') : '(无)'}`)
  console.log(`生命周期脚本        ${report.installScripts.length > 0 ? report.installScripts.join(', ') : '(无)'}`)
  console.log(`官方最新三版窗口    ${report.dshWindow.join(', ')}`)
  console.log(`窗口来源            ${report.dshWindowAuthority}`)
  console.log(`窗口内 compatible   ${report.compatibleInWindow.length > 0 ? report.compatibleInWindow.join(', ') : '(无)'}`)
  console.log('')
  console.log(`树条目 ${report.treeEntries} / 运行源码文件 ${report.runtimeFiles} / 合计 ${report.runtimeBytes} 字节 / 最大 ${report.largestRuntimeFile} 字节`)
  console.log(`权限信号            ${JSON.stringify(report.signals)}`)
  for (const [signal, paths] of Object.entries(report.signalSources)) {
    console.log(`  ${signal}:`)
    for (const path of paths) console.log(`    - ${path}`)
  }
  console.log('')
  if (report.automaticPolicyReasons.length === 0) {
    console.log('自动策略：通过（零原因）→ 上游会生成 source-verified 条目')
  } else {
    console.log(`自动策略：未通过（${report.automaticPolicyReasons.length} 条确定性原因）`)
    for (const reason of report.automaticPolicyReasons) console.log(`  - ${reason}`)
    console.log('')
    console.log('说明：自动策略失败 ≠ 插件质量有问题。上游对“有文件/网络/命令/凭据能力”的合法插件')
    console.log('      保留 user-reviewed（受保护安装，逐次人工确认）通道；blocked 只是未进入该通道。')
  }
  if (report.compatibilityHold) {
    console.log('')
    console.log('兼容性窗口：未满足 —— 官方最新三版中没有任何精确 compatible 声明。')
    console.log('      只声明真正实测过的版本；范围声明不能替代精确记录。')
  }
}

process.exitCode = report.automaticPolicyReasons.length === 0 ? 0 : 1
