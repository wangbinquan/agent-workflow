// 依赖分层门禁（CI `Static scans` job 调用；本地 `bun run depcheck`）。
//
// 为什么不再直接跑 `depcruise --config .dependency-cruiser.cjs <三个 src>`：
// **那条命令看不见依赖图的大半。** 原配置写死 `tsConfig.fileName =
// 'tsconfig.base.json'`，而 base 里 `paths` 出现 0 次——`@/*` 只定义在各
// package 自己的 tsconfig。于是每一条 `@/...` import 都 couldNotResolve 被
// 静默丢出图。实测（2026-08-03 架构审视 A1）：
//
//   旧命令：1678 modules / 5384 deps / **3365 条 couldNotResolve（62.5%）** / 0 violations
//   换对 tsconfig：527+597+99 modules / **11+3+0 条未解析（全是外部 npm 子路径导出与 bun 内建）**
//                  / **19 条真实违规**（18 个 runtime 环 + 1 条 services→routes）
//
// 也就是说门禁两年来一直绿，不是因为分层干净，而是因为它没看见。最讽刺的是
// 绕环最常用的写法 `await import('@/services/…')` 恰好 100% 落在这个盲区里。
//
// 为什么要拆成三次 per-package 跑：backend 与 frontend 的 `@/*` 指向各自的
// `src/`，一份 tsconfig 无法同时服务两者。`options.enhancedResolveOptions.
// alias` 又不被 dependency-cruiser 的 schema 接受（`must NOT have additional
// properties`）。depcruise 解析 tsconfig 的 `extends` 时基准目录也不对（拿
// `packages/backend/tsconfig.json` 会去找 `packages/backend/tsconfig.base.json`
// 而报 TS5083），所以这里生成**扁平化、绝对 baseUrl** 的临时 tsconfig。
//
// 本脚本的三条判据（任一不满足即 exit 1）：
//   ① 第一方边零未解析 —— 门禁必须**看得见**图。这条是棘轮：它保证上面那种
//      「静默失明」不会以任何形式重来（换 tsconfig、改 alias、加新 package
//      都会立刻红）。外部 npm 包解析不了不算（子路径 exports / bun 内建）。
//   ② 没有 KNOWN_VIOLATIONS 之外的违规。
//   ③ KNOWN_VIOLATIONS 里没有**过期**条目 —— 某条不再触发说明环已被拆掉，
//      必须同步删除。
//
// RFC-317 T66 —— ③ 原本还跟着一句「这让允许列表只能缩、不能涨」，那是**只做了
// 一半的判据**：stale 检测只管「缩」的方向（不再触发的条目必须删），对「涨」
// 完全无话可说——在同一个 PR 里新加一处违规、同时在这里加一行豁免，本脚本全绿。
// 「不能涨」这一半今天由**另一处**兑现：`architecture/ledger-baselines.json` 给
// KNOWN_VIOLATIONS 钉了条目数，`rfc317-ledger-highwater.test.ts` 要求它与源码逐字
// 相等且相对上一个 commit 只降不升（要升必须显式写 `allowGrowth` 并点名 RFC，
// 且在下一笔不涨的提交上被判过期、强制清理）。
// 留下原来那句的坏处不是措辞不准，而是**它让人以为这里已经防住了**，于是没人
// 会去建真正防住它的那道门——这个洞就是这么活了很久的。
//
// 每条 known 违规都要写明 why + removeWhen（测试强制非空），removeWhen 指向
// `design/task-execution-architecture-audit-2026-08-03.md` 的工作包编号。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

export const PACKAGES = ['backend', 'frontend', 'shared'] as const
export type PackageName = (typeof PACKAGES)[number]

// ---------------------------------------------------------------------------
// 已知违规（允许列表）
// ---------------------------------------------------------------------------

export type KnownViolation = {
  /** dependency-cruiser 规则名。 */
  rule: string
  /** 违规起点（仓库相对路径）。环的话是被报告的那个参与者。 */
  from: string
  /** 违规终点。环的话是环上的下一跳——(rule, from, to) 唯一标识一条违规。 */
  to: string
  /** 为什么现在可以接受。 */
  why: string
  /** 什么时候会消失——必须指向具体工作包 / RFC，不允许写「以后再说」。 */
  removeWhen: string
  /** RFC-294 N1: high-risk boundary debt has an explicit target owner. */
  owner?: string
  /** RFC-294 N1: canonical removal wave, separate from explanatory prose. */
  removeWave?: string
}

const B = 'packages/backend/src'
const F = 'packages/frontend/src'
const S = 'packages/shared/src'

/**
 * 门禁复明（WP-0）当天的真实存量：19 条。其中 16 条是此前被 tsconfig 盲区
 * 藏住的，3 条原本写在 `.dependency-cruiser.cjs` 的 `from.pathNot` 里（那种
 * 按文件排除的写法会连带放过未来经过同一文件的新环，故迁到这里逐条精确匹配）。
 */
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
  // ── util/git ↔ services/git*（分层倒置：util 应是叶子，架构审视 RC-4）──
  {
    rule: 'no-circular',
    from: `${B}/services/gitRepoCache.ts`,
    to: `${B}/util/git.ts`,
    why: 'util/git.ts 用 11 处 `await import("@/services/git*")` 反向取子模块参数解析与 gitignore 块生成——util 层反过来依赖 services 层。惰性 import 使其没有 RFC-079 的「顶层 const 初始化顺序」风险，但方向是错的。',
    removeWhen:
      '把 resolveSubmoduleParams / syncSubmodules / buildGitignoreBlock 需要的纯数据下沉成参数（由 services 侧注入），util/git.ts 恢复成零 services 依赖的叶子。属独立切片（未编号）。',
  },
  {
    rule: 'no-circular',
    from: `${B}/services/gitRepoCache.ts`,
    to: `${B}/services/gitSubmodule.ts`,
    why: '同一环族的另一支（gitSubmodule → util/git → gitRepoCache）。',
    removeWhen:
      '与上一条同批：util/git.ts 恢复成零 services 依赖的叶子后整族消失。属独立切片（未编号）。',
  },
  {
    rule: 'no-circular',
    from: `${B}/services/gitRepoCache.ts`,
    to: `${B}/services/gitVersion.ts`,
    why: '同一环族（gitVersion → util/git → gitRepoCache）。',
    removeWhen: '与 util/git 叶子化同批消失。属独立切片（未编号）。',
  },
  {
    rule: 'no-circular',
    from: `${B}/services/gitSubmodule.ts`,
    to: `${B}/util/git.ts`,
    why: '同一环族，从 gitSubmodule 侧被报告的那条。',
    removeWhen: '与 util/git 叶子化同批消失。属独立切片（未编号）。',
  },

  // ── 其余存量环 ────────────────────────────────────────────────────────
  {
    rule: 'no-circular',
    from: `${S}/outputKinds/list.ts`,
    to: `${S}/outputKinds/registry.ts`,
    why: '递归 list-kind handler 查找。原本写在 .dependency-cruiser.cjs 的 pathNot 里。',
    removeWhen: '把 handler 查找 DI 进 list-handler 工厂。属独立切片（未编号）。',
  },
  {
    rule: 'no-circular',
    from: `${F}/components/node-session/ConversationFlow.tsx`,
    to: `${F}/components/node-session/SubagentBlock.tsx`,
    why: '子代理递归渲染。原本写在 .dependency-cruiser.cjs 的 pathNot 里。',
    removeWhen: 'RFC-217 F 线（递归渲染改为 children 传递）。',
  },

  // ── 分层违规 ──────────────────────────────────────────────────────────
  // no-util-to-upper：util/git.ts 的三条反向值边（惰性 import 民俗）。与上面
  // no-circular 的 git 环族同一批边、同一个 removeWhen——规则维度不同故各记一次。
  ...(['gitRepoCache', 'gitSubmodule'] as const).map((svc) => ({
    rule: 'no-util-to-upper' as const,
    from: `${B}/util/git.ts`,
    to: `${B}/services/${svc}.ts`,
    why: `util 叶子层经 await import 反向依赖 services/${svc}（util/git.ts 内注释自认成环，还催生过「复制代码避 import」的二阶腐化）。`,
    removeWhen:
      '把 resolveSubmoduleParams/syncSubmodules/buildGitignoreBlock 以参数注入下沉（no-circular git 环族账目的同一方案）；RFC-284 后续批次或独立切片执行。',
  })),
]

// ---------------------------------------------------------------------------
// 纯判定（可测，不碰 IO）
// ---------------------------------------------------------------------------

export type CruiseDependency = {
  module: string
  resolved?: string
  couldNotResolve?: boolean
}

export type CruiseModule = {
  source: string
  dependencies?: CruiseDependency[]
}

export type CruiseViolation = {
  rule: { name: string; severity?: string }
  from: string
  to: string
}

export type CruiseResult = {
  modules: CruiseModule[]
  summary: { violations: CruiseViolation[]; totalCruised?: number }
}

/** 违规身份：规则名 + 起点 + 终点。环由「被报告的参与者 + 环上下一跳」唯一确定。 */
export function violationKey(v: { rule: { name: string }; from: string; to: string }): string {
  return `${v.rule.name}|${v.from}|${v.to}`
}

/**
 * 这条 import 说明符是不是第一方代码。
 *
 * 只有第一方边才纳入「零未解析」棘轮：外部 npm 包解析不了是正常的
 * （`@modelcontextprotocol/sdk/client/stdio.js` 这类子路径 exports、
 * `bun` / `vite/client` 这类环境内建），把它们算进来会让门禁在每次
 * 依赖升级时随机变红，反而逼人调低判据。
 */
export function isFirstPartySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('@/') ||
    specifier.startsWith('@agent-workflow/')
  )
}

export type UnresolvedEdge = { from: string; specifier: string }

export type DepVerdict = {
  /** KNOWN_VIOLATIONS 之外的违规 —— 必须修。 */
  unknown: CruiseViolation[]
  /** 命中允许列表的违规。 */
  accepted: CruiseViolation[]
  /** 允许列表里没有再触发的条目 —— 环已拆掉，条目该删了。 */
  stale: KnownViolation[]
  /** 解析不了的第一方边 —— 门禁失明的信号。 */
  unresolvedFirstParty: UnresolvedEdge[]
  /** 统计用：解析不了的外部包边数。 */
  unresolvedExternal: number
  totalModules: number
}

/** 合并多个 per-package cruise 结果后做一次整体判定。 */
export function evaluateCruises(
  results: readonly CruiseResult[],
  known: readonly KnownViolation[] = KNOWN_VIOLATIONS,
): DepVerdict {
  const knownByKey = new Map(known.map((k) => [violationKey({ ...k, rule: { name: k.rule } }), k]))
  const seen = new Set<string>()
  const verdict: DepVerdict = {
    unknown: [],
    accepted: [],
    stale: [],
    unresolvedFirstParty: [],
    unresolvedExternal: 0,
    totalModules: 0,
  }
  const dedupe = new Set<string>()

  for (const result of results) {
    verdict.totalModules += result.summary.totalCruised ?? result.modules.length
    for (const v of result.summary.violations) {
      const key = violationKey(v)
      if (knownByKey.has(key)) {
        seen.add(key)
        if (!dedupe.has(key)) {
          dedupe.add(key)
          verdict.accepted.push(v)
        }
        continue
      }
      if (dedupe.has(key)) continue
      dedupe.add(key)
      verdict.unknown.push(v)
    }
    for (const m of result.modules) {
      for (const dep of m.dependencies ?? []) {
        if (dep.couldNotResolve !== true) continue
        if (isFirstPartySpecifier(dep.module)) {
          verdict.unresolvedFirstParty.push({ from: m.source, specifier: dep.module })
        } else {
          verdict.unresolvedExternal++
        }
      }
    }
  }

  verdict.stale = known.filter((k) => !seen.has(violationKey({ ...k, rule: { name: k.rule } })))
  return verdict
}

export function isBlocking(verdict: DepVerdict): boolean {
  return (
    verdict.unknown.length > 0 ||
    verdict.stale.length > 0 ||
    verdict.unresolvedFirstParty.length > 0
  )
}

/** 门禁的人类可读输出。返回行数组便于测试，不直接 console。 */
export function formatVerdict(verdict: DepVerdict): string[] {
  const lines: string[] = []

  if (verdict.unresolvedFirstParty.length > 0) {
    lines.push(
      `✖ ${verdict.unresolvedFirstParty.length} 条第一方 import 解析不了 —— 门禁看不见这部分图：`,
    )
    for (const e of verdict.unresolvedFirstParty.slice(0, 20)) {
      lines.push(`    ${e.from}  →  ${e.specifier}`)
    }
    if (verdict.unresolvedFirstParty.length > 20) {
      lines.push(`    …… 另有 ${verdict.unresolvedFirstParty.length - 20} 条`)
    }
    lines.push('')
    lines.push('  这正是 2026-08-03 架构审视 A1 记录的失明形态（当时 62.5% 的边被静默丢弃）。')
    lines.push('  多半是新 package 没接进 scripts/depcheck.ts 的 PACKAGES，或 tsconfig 的')
    lines.push('  `paths` 变了。**不要**通过放宽这条判据来「修」它。')
  }

  if (verdict.unknown.length > 0) {
    lines.push(`✖ ${verdict.unknown.length} 条违规不在允许列表里：`)
    for (const v of verdict.unknown) {
      lines.push(`    [${v.rule.name}]  ${v.from}  →  ${v.to}`)
    }
    lines.push('')
    lines.push('  处置方式：拆掉这条边（首选），或在 scripts/depcheck.ts 的')
    lines.push('  KNOWN_VIOLATIONS 里写明 why + removeWhen 后接受。')
    lines.push('  注意 removeWhen 必须指向具体工作包 / RFC —— 允许列表只能缩。')
  }

  if (verdict.stale.length > 0) {
    lines.push(`✖ ${verdict.stale.length} 条允许列表条目已不再触发 —— 请删除：`)
    for (const k of verdict.stale) {
      lines.push(`    [${k.rule}]  ${k.from}  →  ${k.to}`)
    }
    lines.push('')
    lines.push('  环被拆掉是好事，但条目留着会重新给它开口子。')
  }

  if (!isBlocking(verdict)) {
    lines.push('✔ 依赖分层门禁通过。')
  }
  lines.push(
    `  ${verdict.totalModules} 个模块；已接受 ${verdict.accepted.length} / ${KNOWN_VIOLATIONS.length} 条存量违规；` +
      `外部包未解析 ${verdict.unresolvedExternal} 条（不计入判据）。`,
  )
  return lines
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/**
 * 生成扁平化的 per-package tsconfig。
 *
 * 刻意不写 `extends` —— depcruise 解析 extends 的基准目录不对（传
 * `packages/backend/tsconfig.json` 会去找 `packages/backend/tsconfig.base.json`
 * 并报 TS5083）。`baseUrl` 用绝对路径，这样临时文件放在哪都不影响解析。
 */
function writeFlatTsConfig(dir: string, pkg: PackageName): string {
  const file = join(dir, `tsconfig.${pkg}.json`)
  writeFileSync(
    file,
    JSON.stringify({
      compilerOptions: {
        baseUrl: join(REPO_ROOT, 'packages', pkg),
        paths: { '@/*': ['src/*'] },
      },
      // 绝对 include：临时文件不在包目录下，相对 glob 会匹配到零个文件并让
      // tsc 报 TS18003。
      include: [join(REPO_ROOT, 'packages', pkg, 'src', '**', '*')],
    }),
  )
  return file
}

async function cruise(pkg: PackageName, tsConfigPath: string): Promise<CruiseResult> {
  const proc = Bun.spawn(
    [
      join(REPO_ROOT, 'node_modules', '.bin', 'depcruise'),
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      `packages/${pkg}/src`,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DEPCRUISE_TSCONFIG: tsConfigPath },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // depcruise 有违规时 exit 非 0，那是预期的——判定由本脚本做，所以这里
  // 只在**拿不到可解析报告**时才当作工具失败。
  try {
    return JSON.parse(stdout) as CruiseResult
  } catch {
    throw new Error(
      `depcruise 未返回可解析的 JSON（package=${pkg}）。stderr:\n${stderr.trim() || '(空)'}`,
    )
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-workflow-depcheck-'))
  try {
    const results: CruiseResult[] = []
    for (const pkg of PACKAGES) {
      results.push(await cruise(pkg, writeFlatTsConfig(tmp, pkg)))
    }
    const verdict = evaluateCruises(results)
    for (const line of formatVerdict(verdict)) console.log(line)
    if (isBlocking(verdict)) process.exit(1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
