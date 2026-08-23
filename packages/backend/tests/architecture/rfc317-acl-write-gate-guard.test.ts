// RFC-317 T6 / findings.md ACL-01 —— ACL 资源的**写门**不得退化成读门。
//
// 事故形态（2026-08-23 实撞）
// --------------------------
// `routes/developmentConfig.ts` 给 RFC-310 的五类配置资源挂了 `/acl` 端点（说明它
// 自认是 ACL 资源族），却用一个自写的 `requireVisible`（= `canViewResource`）当
// revise / publish / archive 的门。于是「看得见」就等于「写得动」，而 `user` 预设
// 本就持有这五类的 `:update` / `:archive` 点 ⇒ 任何登录用户都能改写别人的 public
// 资源。整套门禁全绿，因为**没有任何规则要求一个 ACL 资源族必须使用 owner 判据**。
//
// 本文件把那条缺失的规则补上，两条断言：
//   ① 凡**消费** `mountAclEndpoints` 的路由文件，必须同时用到 `requireResourceOwner`；
//   ② 凡在 `routes/**` 里用到 `canViewResource` 的文件，也必须用到
//      `requireResourceOwner`——除非它在显式 allowlist 里并写清为什么它只读。
//
// 两条都配 stale 检查：allowlist 条目一旦不再成立（文件没了 / 它其实已经用上了
// owner 判据）也要红，免得豁免变成永久免死金牌（findings.md RT-02 就是这么烂掉的）。
//
// 变异实证：把 `developmentConfig.ts` 的 `requireResourceOwner` 导入删掉（回到事故
// 前的形状），本文件必须立刻红。

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import ts from 'typescript'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const ROUTES_ROOT = resolve(REPO_ROOT, 'packages', 'backend', 'src', 'routes')

/** `mountAclEndpoints` 的**定义**所在处；它自然不需要 owner 判据。 */
const ACL_MOUNTER_DEFINITION = 'packages/backend/src/routes/resourceAcl.ts'

/**
 * 只读地使用 `canViewResource` 的路由文件。每条必须写清「读什么、为什么不是写门」。
 * 新增条目 = 新增一次「这里可以只判可见性」的例外，必须是有意识的决定。
 */
const READ_ONLY_VISIBILITY_ALLOWLIST: Readonly<Record<string, string>> = {
  [ACL_MOUNTER_DEFINITION]:
    '它就是 mountAclEndpoints 的定义处。模板化处理器自己只调 canViewResource 做「不可见 ⇒ 404 同形」；PUT /acl 的写权由它委托的 updateResourceAcl 在服务层判（services/resourceAcl.ts:588 的 requireResourceOwner），所以路由文件本身没有 owner 调用是设计，不是缺口。',
  'packages/backend/src/routes/tasks.ts':
    '跨域只读：判「这个 actor 看不看得见本任务引用的那个 workflow」来决定 sync 预览是否可用（tasks.ts:822），不是任何资源的写门。',
}

function routeFiles(): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) out.push(path)
    }
  }
  visit(ROUTES_ROOT)
  return out.sort()
}

interface RouteSource {
  readonly rel: string
  /** 该文件里被**调用**过的顶层标识符名（AST 提取）。 */
  readonly calledNames: ReadonlySet<string>
}

/**
 * 用 TS AST 提取「被调用过的名字」，而不是拿正则扫文本。
 *
 * 两次踩坑换来的：
 *   ① 第一版直接 `text.includes('requireResourceOwner')` —— 而
 *      `developmentConfig.ts` 的文档注释里**提到了**这个名字，于是把导入和调用一起
 *      拿掉（正是事故前的形状）之后本文件依然全绿。**正向检查被一句注释满足了**。
 *   ② 第二版改成「先用正则剥注释、再匹配调用形态」—— 非贪婪的块注释正则会从字符串
 *      里的 `/*` 一路吃到下一个 `*` + `/`，把 `tasks.ts` 中间几百行连同真正的
 *      `canViewResource(` 调用一起吞掉，于是 allowlist 的 stale 检查误报。
 *
 * AST 对注释与字符串天然免疫，且「被调用」正是我们真正想问的问题。
 */
function calledIdentifierNames(path: string, text: string): Set<string> {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) names.add(callee.text)
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

const SOURCES: readonly RouteSource[] = routeFiles().map((path) => {
  const rel = relative(REPO_ROOT, path).split('\\').join('/')
  return { rel, calledNames: calledIdentifierNames(rel, readFileSync(path, 'utf8')) }
})

const usesMountAclEndpoints = (source: RouteSource): boolean =>
  source.rel !== ACL_MOUNTER_DEFINITION && source.calledNames.has('mountAclEndpoints')
const usesOwnerGate = (source: RouteSource): boolean =>
  source.calledNames.has('requireResourceOwner')
const usesVisibilityOracle = (source: RouteSource): boolean =>
  source.calledNames.has('canViewResource')

describe('RFC-317 T6 —— ACL 资源族必须用 owner 判据当写门', () => {
  test('语料非空：确实扫到了路由文件（扫到 0 个说明目录变了，本文件此刻零预言力）', () => {
    expect(SOURCES.length).toBeGreaterThan(30)
    expect(SOURCES.some((source) => source.rel === ACL_MOUNTER_DEFINITION)).toBe(true)
  })

  test('前提复核：确实存在挂载 /acl 的消费方，否则规则①无处可施', () => {
    expect(SOURCES.filter(usesMountAclEndpoints).length).toBeGreaterThan(5)
  })

  test('①凡挂载 /acl 端点的路由文件，都必须用到 requireResourceOwner', () => {
    const offenders = SOURCES.filter(
      (source) => usesMountAclEndpoints(source) && !usesOwnerGate(source),
    ).map((source) => source.rel)
    expect(
      offenders,
      '这些文件把资源挂成了 ACL 族（有 /acl 端点），写路径却没有 owner 判据——' +
        '「看得见 = 写得动」正是 RFC-317 C1 修掉的越权形态',
    ).toEqual([])
  })

  test('②routes/ 里用 canViewResource 的文件，要么也用 owner 判据，要么进只读 allowlist', () => {
    const offenders = SOURCES.filter(
      (source) =>
        usesVisibilityOracle(source) &&
        !usesOwnerGate(source) &&
        READ_ONLY_VISIBILITY_ALLOWLIST[source.rel] === undefined,
    ).map((source) => source.rel)
    expect(
      offenders,
      '只判可见性、又不在只读 allowlist 里：如果它其实是写门，那就是一次越权；' +
        '如果确实只读，请进 allowlist 并写清读的是什么',
    ).toEqual([])
  })

  test('allowlist 无过期条目（文件没了 / 它已经用上 owner 判据 ⇒ 必须删掉这一行）', () => {
    const byRel = new Map(SOURCES.map((source) => [source.rel, source]))
    const stale: string[] = []
    for (const rel of Object.keys(READ_ONLY_VISIBILITY_ALLOWLIST)) {
      const source = byRel.get(rel)
      if (source === undefined) {
        stale.push(`${rel}（文件不存在）`)
        continue
      }
      if (!usesVisibilityOracle(source)) stale.push(`${rel}（已不再使用 canViewResource）`)
      else if (usesOwnerGate(source) && rel !== ACL_MOUNTER_DEFINITION) {
        stale.push(`${rel}（已用上 requireResourceOwner，不再需要豁免）`)
      }
    }
    expect(stale, '豁免只能缩、不能涨；过期条目必须删，否则它会变成永久免死金牌').toEqual([])
  })

  test('每条 allowlist 都写清了理由（不接受空 why）', () => {
    const empty = Object.entries(READ_ONLY_VISIBILITY_ALLOWLIST)
      .filter(([, why]) => why.trim().length < 20)
      .map(([rel]) => rel)
    expect(empty).toEqual([])
  })
})
