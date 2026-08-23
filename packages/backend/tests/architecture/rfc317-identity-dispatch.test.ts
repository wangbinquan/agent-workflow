// RFC-317 T27（R4）—— 公共内核里的业务身份分派必须是编译器能证明穷尽的。
//
// 事故形态（**本仓真的发生过**）
// -----------------------------
// `services/execution/outcome.ts` 里留着一段前人写的注释：code-round 任务曾经掉进
// workgroup 分支，`workgroupModeOf(null)` 返回 null，于是结果是
// `status: 'done'` + `outputs: {}` + 一条 `workgroup-config-unparsable` 警告——
// **一个看起来成功、实则空输出、还赖在它根本没有的 workgroup 配置头上的结果**。
// 原话：「the failure was in the arm NOBODY would think to check」。
//
// 这就是「通用内核里夹带业务身份分派」的代价。危险的不是代码里出现了
// `=== 'workgroup'` 这个字面量，而是**分派链的兜底会把新种类静默当成某个旧种类**。
//
// 判据（三条，缺一条就会误伤或漏网）
// --------------------------------
// 1. 字面量集合从**注册表派生**，不手抄——手抄的集合会随注册表增长而过期，
//    而过期的表现是「扫不出违规」，与合规同形。
// 2. 按**判别表达式**分组，不是数字面量总数。`node.kind !== 'agent-single'` 加
//    `agent.role === 'aggregator'` 是跨两个注册表的**合取守卫**（先判是不是这种节点、
//    再判它的角色），不是分派；把它算成分派会逼着作者给一个根本没有分支的函数加
//    `: never`。初版就是数总数，实测把它误报了。
// 3. 兜底**失败关闭**（返回 null / 抛错）与兜底**静默走另一种业务行为**，危害不是
//    一个量级。前者入册留痕即可，后者必须归零。
//
// 合法形态（本仓既有写法，不是本 RFC 新发明）：
//   - `const _exhaustive: never = kind`（`shared/src/lifecycle.ts` 用了 5 处）
//   - `satisfies Record<KindUnion, …>` 穷尽表（全仓 25 处）
// 两者都让「漏掉一个种类」变成**编译错误**，而不是运行期的静默错路。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

import { sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

const unitOf = (rel: string): SourceUnit =>
  sourceUnit(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8'))

// ---------------------------------------------------------------------------
// 1) 字面量集合：从注册表派生
// ---------------------------------------------------------------------------

/**
 * 业务身份注册表。**加一条是一次有记录的决定**——它决定了哪些字面量算「业务身份」。
 * 值本身**不在这里手抄**，由下面的 AST 从注册表定义处读出来。
 */
const IDENTITY_REGISTRIES: ReadonlyArray<{ file: string; symbol: string; why: string }> = [
  {
    file: 'packages/shared/src/schemas/workflow.ts',
    symbol: 'NODE_KIND',
    why: '工作流节点种类——调度 / 端口派生的核心身份。',
  },
  {
    file: 'packages/shared/src/taskCreation.ts',
    symbol: 'TASK_SOURCE_IDS',
    why: '任务来源种类（agent / workflow / workgroup / digital-employee）——启动与结果投影按它分派。',
  },
  {
    file: 'packages/shared/src/schemas/resourceAcl.ts',
    symbol: 'ACL_RESOURCE_TYPES',
    why: '受 ACL 管辖的资源种类——权限判据按它分派。',
  },
  {
    file: 'packages/shared/src/schemas/agent.ts',
    symbol: 'AGENT_ROLE',
    why: '代理角色（normal / aggregator）——fanout 聚合按它判定。',
  },
  {
    file: 'packages/backend/src/services/runtime/index.ts',
    symbol: 'DRIVERS',
    why: 'runtime 驱动注册表，键即 runtime kind（opencode / claude-code）——G-08 点名的形态。',
  },
]

function registryLiterals(file: string, symbol: string): string[] {
  const unit = unitOf(file)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol &&
      node.initializer !== undefined
    ) {
      let init: ts.Node = node.initializer
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isArrayLiteralExpression(init)) {
        for (const element of init.elements) {
          if (ts.isStringLiteralLike(element)) out.push(element.text)
        }
      }
      if (ts.isObjectLiteralExpression(init)) {
        for (const property of init.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          if (ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name)) {
            out.push(property.name.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return out
}

const IDENTITY_LITERALS: ReadonlySet<string> = new Set(
  IDENTITY_REGISTRIES.flatMap((registry) => registryLiterals(registry.file, registry.symbol)),
)

// ---------------------------------------------------------------------------
// 2) 分派探测：按判别表达式分组
// ---------------------------------------------------------------------------

interface DispatchSite {
  readonly file: string
  readonly fn: string
  readonly discriminant: string
  readonly literals: readonly string[]
  readonly exhaustive: boolean
}

/** 该表达式文本是不是把 `x.kind` 之类的判别式与身份字面量比较。 */
function comparedLiteral(node: ts.Node): { discriminant: string; literal: string } | null {
  const source = node.getSourceFile()
  if (ts.isBinaryExpression(node)) {
    const equality =
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    if (!equality) return null
    const pairs: ReadonlyArray<[ts.Node, ts.Node]> = [
      [node.left, node.right],
      [node.right, node.left],
    ]
    for (const [maybeDiscriminant, maybeLiteral] of pairs) {
      if (ts.isStringLiteralLike(maybeLiteral) && IDENTITY_LITERALS.has(maybeLiteral.text)) {
        return {
          discriminant: maybeDiscriminant.getText(source).replace(/\s+/g, ''),
          literal: maybeLiteral.text,
        }
      }
    }
    return null
  }
  if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) {
    if (!IDENTITY_LITERALS.has(node.expression.text)) return null
    const parent = node.parent.parent
    const discriminant = ts.isSwitchStatement(parent)
      ? parent.expression.getText(source).replace(/\s+/g, '')
      : '(switch)'
    return { discriminant, literal: node.expression.text }
  }
  return null
}

function enclosingFunctions(unit: SourceUnit): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      out.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return out
}

/** 编译期穷尽的两种形态：`: never` 绑定，或 `satisfies Record<…>` / `as Record<…>` 表。 */
function hasCompileTimeExhaustiveness(fn: ts.Node, unit: SourceUnit): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isVariableDeclaration(node) && node.type?.kind === ts.SyntaxKind.NeverKeyword) {
      found = true
      return
    }
    if (ts.isSatisfiesExpression(node) && /\bRecord</.test(node.type.getText(unit.source))) {
      found = true
      return
    }
    if (ts.isAsExpression(node) && /\bRecord</.test(node.type.getText(unit.source))) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return found
}

function dispatchSites(unit: SourceUnit): DispatchSite[] {
  const sites: DispatchSite[] = []
  for (const fn of enclosingFunctions(unit)) {
    const byDiscriminant = new Map<string, Set<string>>()
    const scan = (node: ts.Node): void => {
      const hit = comparedLiteral(node)
      if (hit !== null) {
        const bucket = byDiscriminant.get(hit.discriminant) ?? new Set<string>()
        bucket.add(hit.literal)
        byDiscriminant.set(hit.discriminant, bucket)
      }
      ts.forEachChild(node, scan)
    }
    scan(fn)
    const exhaustive = hasCompileTimeExhaustiveness(fn, unit)
    for (const [discriminant, literals] of byDiscriminant) {
      // 一个判别式上只有一个字面量 = 窄化守卫，不是分派。
      if (literals.size < 2) continue
      sites.push({
        file: unit.path,
        fn: (fn as { name?: ts.Identifier }).name?.text ?? '(anonymous)',
        discriminant,
        literals: [...literals].sort(),
        exhaustive,
      })
    }
  }
  return sites
}

// ---------------------------------------------------------------------------
// 3) subject：core: true 的公共内核
// ---------------------------------------------------------------------------

const MANIFEST = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'architecture', 'commons-manifest.json'), 'utf8'),
) as { readonly kernels: ReadonlyArray<{ core?: boolean; files?: readonly string[] }> }

const CORE_FILES: readonly string[] = [
  ...new Set(MANIFEST.kernels.filter((k) => k.core === true).flatMap((k) => k.files ?? [])),
].sort()

const CORE_DISPATCHES: readonly DispatchSite[] = CORE_FILES.flatMap((rel) => {
  try {
    return dispatchSites(unitOf(rel))
  } catch {
    return []
  }
})

/**
 * 兜底**失败关闭**的分派：新种类落到兜底时得到的是「不做」（null / 抛错），
 * 而不是「被当成另一种业务种类处理」。这类留痕即可，不要求编译期穷尽。
 *
 * **每条必须写清兜底行为**——说不出兜底做什么，就说明作者没想过新种类会走到哪。
 */
const FAIL_CLOSED_DISPATCHES: Readonly<Record<string, { fallthrough: string; why: string }>> = {
}

const siteKey = (site: DispatchSite): string => `${site.file}#${site.fn}@${site.discriminant}`

describe('RFC-317 T27（R4）—— core 内核的身份分派必须编译期穷尽', () => {
  test('语料非空：注册表派生出了字面量、core 内核扫得到', () => {
    expect(IDENTITY_LITERALS.size).toBeGreaterThanOrEqual(20)
    expect(CORE_FILES.length).toBeGreaterThanOrEqual(20)
  })

  test('每个注册表都真的派生出了值（改名 / 换形态 ⇒ 这里先红，而不是悄悄扫不出违规）', () => {
    const empty = IDENTITY_REGISTRIES.filter(
      (registry) => registryLiterals(registry.file, registry.symbol).length === 0,
    ).map((registry) => `${registry.symbol} @ ${registry.file}`)
    expect(
      empty,
      '注册表派生不出字面量了。**这比漏报更坏**：字面量集合变空之后，' +
        '所有身份分派都扫不出来，而扫不出来与「没有违规」完全同形',
    ).toEqual([])
  })

  test('每个注册表都写清了为什么它算业务身份', () => {
    const bad = IDENTITY_REGISTRIES.filter((registry) => registry.why.trim().length < 15).map(
      (registry) => registry.symbol,
    )
    expect(bad).toEqual([])
  })

  test('没有一个 core 内核的身份分派缺少编译期穷尽（失败关闭的除外，且须入册）', () => {
    const offenders = CORE_DISPATCHES.filter((site) => !site.exhaustive)
      .filter((site) => FAIL_CLOSED_DISPATCHES[siteKey(site)] === undefined)
      .map((site) => `${siteKey(site)} [${site.literals.join(',')}]`)
    expect(
      offenders,
      '公共内核里的业务身份分派没有编译期穷尽收尾。**危险的不是字面量本身，是兜底**——' +
        '新增一个业务种类时，它会被静默当成兜底那一种处理（本仓 RFC-304 真出过这个事故：' +
        'code-round 掉进 workgroup 分支，结果是「成功、空输出、赖在它根本没有的配置头上」）。' +
        '收法：switch + `const _exhaustive: never = kind`，或 `satisfies Record<KindUnion, …>` 穷尽表',
    ).toEqual([])
  })

  test('失败关闭豁免无过期条目（分派没了 / 已补穷尽 ⇒ 删掉这一行）', () => {
    const live = new Set(CORE_DISPATCHES.map(siteKey))
    const stale = Object.keys(FAIL_CLOSED_DISPATCHES).filter((key) => {
      if (!live.has(key)) return true
      const site = CORE_DISPATCHES.find((candidate) => siteKey(candidate) === key)
      return site !== undefined && site.exhaustive
    })
    expect(stale, '豁免只能缩、不能涨；分派消失或已补上穷尽后必须删除对应条目').toEqual([])
  })

  test('每条失败关闭豁免都写清了兜底行为（说不出兜底做什么 = 没想过新种类走到哪）', () => {
    const bad = Object.entries(FAIL_CLOSED_DISPATCHES)
      .filter(([, entry]) => entry.fallthrough.trim().length < 4 || entry.why.trim().length < 30)
      .map(([key]) => key)
    expect(bad).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T27 自变异：判据的三条边界各配正反 fixture
// ---------------------------------------------------------------------------
//
// 这三条 fixture 分别对应判据**实际犯过或差点犯的**错：
//   - 数字面量总数而不按判别式分组 ⇒ 把合取守卫误报成分派（初版实测误报了
//     `isAggregatorAgentNode`：`node.kind !== 'agent-single'` 加 `agent.role === 'aggregator'`
//     是先判种类再判角色，根本没有分支）；
//   - 认不出 `: never` ⇒ 把已合规的 `outcome.ts` 判成违规；
//   - 认不出 `satisfies Record<…>` ⇒ 把穷尽表判成违规。

describe('RFC-317 T27 自变异 —— 分派判据的三条边界', () => {
  const probe = (body: string): DispatchSite[] =>
    dispatchSites(sourceUnit('packages/backend/src/probe.ts', body))

  test('同一判别式上的多分支 = 分派（这是要抓的）', () => {
    const sites = probe(
      'function f(req: { kind: string }) {\n' +
        "  if (req.kind === 'agent') return 1\n" +
        "  if (req.kind === 'workgroup') return 2\n" +
        '  return 3\n' +
        '}\n',
    )
    expect(sites.length).toBe(1)
    expect(sites[0]!.exhaustive).toBe(false)
    expect(sites[0]!.literals).toEqual(['agent', 'workgroup'])
  })

  test('跨不同判别式的合取守卫 **不是**分派（初版实测误报过这一形态）', () => {
    const sites = probe(
      'function f(node: { kind: string }, agent: { role: string }) {\n' +
        "  if (node.kind !== 'agent-single') return null\n" +
        "  return agent.role === 'aggregator' ? agent : null\n" +
        '}\n',
    )
    expect(
      sites,
      '先判种类、再判角色是**合取**，不是分派；把它算成分派会逼着作者给一个根本没有分支的函数加 : never',
    ).toEqual([])
  })

  test('`: never` 收尾算编译期穷尽', () => {
    const sites = probe(
      'function f(kind: string) {\n' +
        "  if (kind === 'agent') return 1\n" +
        "  if (kind === 'workgroup') return 2\n" +
        '  const _exhaustive: never = kind as never\n' +
        '  return _exhaustive\n' +
        '}\n',
    )
    expect(sites.length).toBe(1)
    expect(sites[0]!.exhaustive, '认不出 : never 会把已合规的 outcome.ts 判成违规').toBe(true)
  })

  test('`satisfies Record<…>` 穷尽表算编译期穷尽', () => {
    const sites = probe(
      'function f(kind: string) {\n' +
        "  const table = { agent: 1, workgroup: 2 } satisfies Record<'agent' | 'workgroup', number>\n" +
        "  if (kind === 'agent') return table.agent\n" +
        "  if (kind === 'workgroup') return table.workgroup\n" +
        '  return 0\n' +
        '}\n',
    )
    expect(sites.length).toBe(1)
    expect(sites[0]!.exhaustive).toBe(true)
  })

  test('非注册表字面量不进判据（否则任何字符串比较都会被当成身份分派）', () => {
    const sites = probe(
      'function f(mode: string) {\n' +
        "  if (mode === 'zzz-not-a-registry-value') return 1\n" +
        "  if (mode === 'also-not-one') return 2\n" +
        '  return 3\n' +
        '}\n',
    )
    expect(sites).toEqual([])
  })
})
