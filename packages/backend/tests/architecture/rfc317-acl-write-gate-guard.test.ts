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
//   ① 凡**消费** `mountAclEndpoints` 的路由文件，必须同时用到一道真写门；
//   ② 凡在 `routes/**` 里用到 `canViewResource` 的文件，也必须用到真写门
//      ——除非它在显式 allowlist 里并写清为什么它只读。
//
// RFC-324 起「真写门」有两个：`requireResourceGovern`（删除 / 改名 / 转移 / 改授权，
// 即改名前的 `requireResourceOwner`）与 `requireResourceEdit`（改内容，owner 或
// `write` 授权）。**两者都满足本守卫的意图**——它防的是「看得见 ⇒ 写得动」，而
// edit 门要求的是授权档位，不是可见性。只认 govern 会把本 RFC 全部合规的内容写
// 路由报成违规；只认 edit 则会放过把删除降级成内容写的改动，所以两者都列、且
// 各自的语义由 §4 的分类表与矩阵测试保证，不由本文件区分。
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
    '它就是 mountAclEndpoints 的定义处。模板化处理器自己只调 canViewResource 做「不可见 ⇒ 404 同形」；PUT /acl 的写权由它委托的 updateResourceAcl 在服务层判（services/resourceAcl.ts 的 requireResourceGovern——RFC-324 起授权面是治理档，编辑授权不含改授权），所以路由文件本身没有写门调用是设计，不是缺口。',
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

const CONFIG_OPERATION_SOURCE = 'packages/backend/src/modules/development-automation/composition/configOperations.ts'
const MCP_OPERATION_SOURCE =
  'packages/backend/src/modules/resource-catalog/application/mcps/mcpApplication.ts'
const PLUGIN_OPERATION_SOURCE =
  'packages/backend/src/modules/resource-catalog/application/plugins/pluginApplication.ts'
const WORKGROUP_OPERATION_SOURCE =
  'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupApplication.ts'
const OPERATION_GATE_DELEGATES: Readonly<Record<string, ReadonlySet<string>>> = {
  'packages/backend/src/routes/developmentConfig.ts': calledIdentifierNames(
    CONFIG_OPERATION_SOURCE,
    readFileSync(resolve(REPO_ROOT, CONFIG_OPERATION_SOURCE), 'utf8'),
  ),
  'packages/backend/src/routes/mcps.ts': calledIdentifierNames(
    MCP_OPERATION_SOURCE,
    readFileSync(resolve(REPO_ROOT, MCP_OPERATION_SOURCE), 'utf8'),
  ),
  'packages/backend/src/routes/plugins.ts': calledIdentifierNames(
    PLUGIN_OPERATION_SOURCE,
    readFileSync(resolve(REPO_ROOT, PLUGIN_OPERATION_SOURCE), 'utf8'),
  ),
  'packages/backend/src/routes/workgroups.ts': calledIdentifierNames(
    WORKGROUP_OPERATION_SOURCE,
    readFileSync(resolve(REPO_ROOT, WORKGROUP_OPERATION_SOURCE), 'utf8'),
  ),
}

const calledNamesFor = (source: RouteSource): ReadonlySet<string> => {
  const delegated = OPERATION_GATE_DELEGATES[source.rel]
  if (delegated === undefined) return source.calledNames
  return new Set([...source.calledNames, ...delegated])
}

const usesMountAclEndpoints = (source: RouteSource): boolean =>
  source.rel !== ACL_MOUNTER_DEFINITION && source.calledNames.has('mountAclEndpoints')
/** RFC-324 —— 真写门：治理档或内容档，两者都不是「看得见就写得动」。 */
const WRITE_GATES = ['requireResourceGovern', 'requireResourceEdit'] as const
const usesOwnerGate = (source: RouteSource): boolean =>
  WRITE_GATES.some((gate) => calledNamesFor(source).has(gate))
const usesVisibilityOracle = (source: RouteSource): boolean =>
  source.calledNames.has('canViewResource')
const usesEditGate = (source: RouteSource): boolean =>
  calledNamesFor(source).has('requireResourceEdit')

/**
 * RFC-324 —— 挂了 `/acl` 却一个 `requireResourceEdit` 都没有的路由文件，意味着这
 * 类资源的**内容写仍然全部锁在 owner 判据上**：面板上可以把它授权成「可编辑」，
 * 而那个档位对它没有任何效果。这种失败不报错、不变红，只留下一个不生效的开关。
 *
 * 每条豁免必须写清「那这类资源的内容写门在哪」。
 */
const EDIT_GATE_ELSEWHERE_ALLOWLIST: Readonly<Record<string, string>> = {
  [ACL_MOUNTER_DEFINITION]:
    '它是 /acl 端点的模板定义处，本身不承载任何资源的内容写；写门在各资源自己的路由或服务里。',
  'packages/backend/src/routes/workflows.ts':
    '工作流的保存不在路由层判档：PUT 把 body 交给 services/workflow.ts，写门是那里的 assertPrincipalCanEditInTx——它必须拿事务内的当前名字做改名围栏，路由层做不到。本文件里的 requireResourceGovern 是 DELETE 的治理门。',
}

describe('RFC-317 T6 —— ACL 资源族必须用 owner 判据当写门', () => {
  test('语料非空：确实扫到了路由文件（扫到 0 个说明目录变了，本文件此刻零预言力）', () => {
    expect(SOURCES.length).toBeGreaterThan(30)
    expect(SOURCES.some((source) => source.rel === ACL_MOUNTER_DEFINITION)).toBe(true)
  })

  test('前提复核：确实存在挂载 /acl 的消费方，否则规则①无处可施', () => {
    expect(SOURCES.filter(usesMountAclEndpoints).length).toBeGreaterThan(5)
  })

  test('①凡挂载 /acl 端点的路由文件，都必须用到一道真写门（govern 或 edit）', () => {
    const offenders = SOURCES.filter(
      (source) => usesMountAclEndpoints(source) && !usesOwnerGate(source),
    ).map((source) => source.rel)
    expect(
      offenders,
      '这些文件把资源挂成了 ACL 族（有 /acl 端点），写路径却没有 owner 判据——' +
        '「看得见 = 写得动」正是 RFC-317 C1 修掉的越权形态',
    ).toEqual([])
  })

  test('②routes/ 里用 canViewResource 的文件，要么也用真写门，要么进只读 allowlist', () => {
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

  test('③挂 /acl 的路由文件必须有内容写门，否则「可编辑」档对该资源形同虚设', () => {
    const offenders = SOURCES.filter(
      (source) =>
        usesMountAclEndpoints(source) &&
        !usesEditGate(source) &&
        EDIT_GATE_ELSEWHERE_ALLOWLIST[source.rel] === undefined,
    ).map((source) => source.rel)
    expect(
      offenders,
      '这些文件把资源挂成了 ACL 族，却没有任何 requireResourceEdit：' +
        'RFC-324 的 write 档在它们身上不产生任何效果，而权限面板照样让 owner 选',
    ).toEqual([])
  })

  test('内容写门 allowlist 无过期条目（它已经用上 requireResourceEdit ⇒ 删掉这一行）', () => {
    const byRel = new Map(SOURCES.map((source) => [source.rel, source]))
    const stale: string[] = []
    for (const rel of Object.keys(EDIT_GATE_ELSEWHERE_ALLOWLIST)) {
      const source = byRel.get(rel)
      if (source === undefined) {
        stale.push(`${rel}（文件不存在）`)
        continue
      }
      if (usesEditGate(source) && rel !== ACL_MOUNTER_DEFINITION) {
        stale.push(`${rel}（已用上 requireResourceEdit，不再需要豁免）`)
      }
    }
    expect(stale, '豁免只能缩、不能涨').toEqual([])
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
        stale.push(`${rel}（已用上写门判据，不再需要豁免）`)
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

// RFC-317 T14 —— 负 fixture：把伪造的路由源码喂给**扫描用的同一份判据**。
//
// 本守卫的全部结论都建立在 `calledIdentifierNames` 之上：它认不出的调用形态，等于
// 「这个文件没调用过写门」——而结论恰恰是「调用了才算合规」。判据一旦漏掉一种写法
// （`await` 包裹、成员调用、链式调用里的中间环节），守卫会把**合规**的文件报成违规；
// 反过来若它把注释 / 字符串里的名字也算进去，就会把**违规**的文件放行。后者更危险：
// 本 RFC 的 B1 阶段就实撞过一次——正向检查 `text.includes('requireResourceOwner')`
// 被一句文档注释满足，事故形态的变异照绿（见本文件头注释与 dev-gotchas）。
describe('RFC-317 T14 —— matcher 自证：调用名提取的边界', () => {
  test('裸调用 / 成员调用 / await / 链式中间环节都提取得到', () => {
    const fabricated =
      "app.get('/api/x/:id', async (c) => {\n" +
      '  const row = loadVisibleThing(deps, id)\n' +
      '  await requireResourceGovern(deps.db, actor, "thing", row)\n' +
      '  return c.json(await deps.store.listThings())\n' +
      '})\n'
    const names = calledIdentifierNames('probe.ts', fabricated)
    for (const expected of ['get', 'loadVisibleThing', 'requireResourceGovern', 'json', 'listThings'])
      expect(names.has(expected), `没提取到 ${expected}`).toBe(true)
  })

  test('注释里出现的名字不算调用（正向检查被注释满足是本 RFC 实撞过的事故形态）', () => {
    const fabricated =
      '// 这里以前调用 requireResourceGovern，RFC-XXX 之后改走别的门\n' +
      "const doc = 'requireResourceGovern 的说明'\n" +
      'const x = 1\n'
    expect(calledIdentifierNames('probe.ts', fabricated).has('requireResourceGovern')).toBe(false)
  })

  test('只是引用而不调用也不算（`const f = requireResourceGovern` 不构成一道门）', () => {
    const fabricated = 'const gate = requireResourceGovern\nexport { gate }\n'
    expect(calledIdentifierNames('probe.ts', fabricated).has('requireResourceGovern')).toBe(false)
  })
})
