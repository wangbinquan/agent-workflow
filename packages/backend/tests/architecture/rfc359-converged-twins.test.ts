// RFC-359 —— 「已合一的 provider 孪生体」棘轮账本。
//
// # 这条守卫锁的是什么
//
// RFC-359 的命题是「一份实现，两个 provider 共用」。它的反面不是某个 bug，而是一种**形状**：
// 同一段语义在 SQLite 路径与 PostgreSQL 路径各写一份逐字相同的私有副本。这种形状不会立刻
// 出错——它只是把「改一份、漂另一份」变成必然，而漂了之后**没有任何测试会变红**，因为两条
// 路径各自的用例都还绿着。W7/W8 的双引擎对拍就是这么照出两处真实分叉的。
//
// 所以每收掉一对孪生体，就在 `CONVERGED_TWINS` 里追加一行：正典定义点 + 允许消费它的
// 文件白名单。这把守卫做**双向棘轮**：
//
//   · 冒出第二个定义点 = 有人又把它 fork 回两份（哪怕是私有函数、哪怕名字一样只是巧合）→ 红；
//   · 白名单里的条目不再消费它 = 账本陈旧，必须剪掉 → 红。
//
// 后一半和前一半同样重要：一张只增不减的白名单几年后就退化成「谁都能调」，
// 那时它挡不住任何东西（见 `rfc282-single-implementation-lock.test.ts` 的同款设计）。
//
// # 为什么判 AST 而不是文本
//
// 本文件头（以及被合一的那些文件里的历史注释）写满了这些函数名。文本匹配会把**讲述历史的
// 注释**算成定义点或消费点——那不只是噪声，它会让守卫在真出问题时依然是绿的（注释顶掉了
// 本该唯一的那次命中）。本轮已经栽过两次同款（`rfc311-perf-guards` 与
// `rfc349-resource-catalog-provider-contributions` 都被我自己新写的注释喂饱过）。
//
// 判据：任何**函数形状的声明**——`function f`、`const f = () => {}`、`const f = function`、
// 类方法 `f() {}`——都算一个定义点，不要求 `export`：被合一的两份原本都是文件私有的，
// 一次 fork 回去大概率也是私有的。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import ts from 'typescript'

import { packageSrcUnits, sourceUnit, type SourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const UNITS = packageSrcUnits(REPO_ROOT, 'backend')

interface ConvergedTwin {
  /** 这对孪生体承担的语义，一句话。 */
  readonly what: string
  readonly fn: string
  /** 合一后唯一的定义点（相对仓库根）。 */
  readonly definedIn: string
  /** 允许消费它的文件（定义点自身隐含允许），相对仓库根。 */
  readonly consumers: readonly string[]
  /** 合一前它在哪两处各有一份——留给以后翻账的人，不参与判定。 */
  readonly forkedFrom: readonly [string, string]
  /**
   * **同名异物**：仓里另有同名函数，但那是另一个实现，不属于这一对。
   *
   * 这一格是必需的：守卫判的是「这个名字在仓里只有一个定义点」，而同名异物会让它恒红。
   * 但也不能因此把判据放宽成「至少有一个定义点」——那样真的 fork 回两份就抓不到了。
   * 折中是把已知的同名异物**逐条登记**：多出一个没登记的同名定义仍然红，逼人来这里说明
   * 「它是另一个东西」还是「它是又一份副本」。每条都要写清为什么不合。
   */
  readonly homonyms?: readonly { readonly path: string; readonly why: string }[]
}

const B = 'packages/backend/src/'

const CONVERGED_TWINS: readonly ConvergedTwin[] = [
  {
    what: 'RFC-292 冻结任务溯源预检：resume / retry / syncWorkflow 在准入 CAS 之前重读 durable 任务行',
    fn: 'assertFrozenTaskTriggerPreflight',
    definedIn: `${B}modules/task-execution/infrastructure/frozenTaskTriggerPreflight.ts`,
    consumers: [
      `${B}services/task.ts`,
      `${B}modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`,
    ],
    forkedFrom: [
      `${B}services/task.ts`,
      `${B}modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`,
    ],
  },
  {
    what: '人工门节点投影的 18 字段裁剪：决定 / 评审 / 反问三条链路取同一份节点行投影',
    fn: 'humanGateNodeProjectionMember',
    definedIn: `${B}modules/task-execution/domain/humanGateContinuation.ts`,
    consumers: [
      `${B}modules/task-execution/public/participants.ts`,
      `${B}modules/task-execution/infrastructure/taskDecisionParticipant.ts`,
      `${B}modules/collaboration/infrastructure/review.ts`,
      `${B}modules/collaboration/infrastructure/clarifyDecision.ts`,
      `${B}modules/collaboration/infrastructure/taskQuestionDispatch.ts`,
    ],
    forkedFrom: [
      `${B}modules/task-execution/infrastructure/taskDecisionParticipant.ts`,
      `${B}modules/collaboration/infrastructure/review.ts`,
    ],
  },
  {
    what: '保留期清扫的一个切片：后台维护 worker 两个 provider 分支共用',
    fn: 'runRetentionSweepSlice',
    definedIn: `${B}platform/persistence/sqlite/systemMaintenanceRetention.ts`,
    consumers: [`${B}platform/background/maintenanceWorker.ts`],
    forkedFrom: [
      `${B}platform/persistence/sqlite/systemMaintenanceRetention.ts`,
      `${B}platform/persistence/postgresqlMaintenanceRetention.ts`,
    ],
  },
  {
    what: '/api/overview 的系统总览查询装配',
    fn: 'composeSystemOverviewQuery',
    definedIn: `${B}modules/system-operations/application/overview.ts`,
    consumers: [
      `${B}modules/system-operations/composition/overview.ts`,
      `${B}server.ts`,
      `${B}cli/postgresqlDaemonApplication.ts`,
    ],
    forkedFrom: [
      `${B}modules/system-operations/application/overview.ts`,
      `${B}platform/persistence/sqlite/systemOverviewReadModel.ts`,
    ],
  },
  {
    what: '/api/overview 的资源目录计数装配',
    fn: 'composeResourceCatalogOverviewQuery',
    definedIn: `${B}modules/resource-catalog/composition/resourceCatalogOverview.ts`,
    consumers: [`${B}server.ts`, `${B}cli/postgresqlDaemonApplication.ts`],
    forkedFrom: [
      `${B}modules/resource-catalog/composition/resourceCatalogOverview.ts`,
      `${B}services/overview.ts`,
    ],
  },
  {
    what: 'Intent apply 会话的归属预检：占用名集合 + 只能复制的目标（两个适配器曾各一份，纯命名分叉）',
    fn: 'resolveIntentApplyResourcePreflight',
    definedIn: `${B}modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePreflight.ts`,
    consumers: [
      `${B}modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts`,
      `${B}modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants.ts`,
    ],
    forkedFrom: [
      `${B}modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts`,
      `${B}modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants.ts`,
    ],
  },
  {
    what: '「这个任务同步不了」的预览投影：理由是唯一变量，其余字段是该形态的常量',
    fn: 'notSyncableWorkflowPreview',
    definedIn: `${B}modules/task-execution/domain/workflowSyncPreview.ts`,
    consumers: [
      `${B}modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts`,
      `${B}modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`,
    ],
    forkedFrom: [
      `${B}modules/task-execution/infrastructure/sqliteTaskRouteOperations.ts`,
      `${B}modules/task-execution/infrastructure/postgresqlTaskRouteOperations.ts`,
    ],
  },
  {
    what: '资源包维护的托管根路径判据（两个 provider 维护适配器曾各一份，纯路径判断、零方言）',
    fn: 'assertManagedPath',
    definedIn: `${B}modules/resource-catalog/infrastructure/resourcePackageMaintenancePaths.ts`,
    consumers: [
      `${B}modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts`,
      `${B}modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts`,
    ],
    forkedFrom: [
      `${B}modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts`,
      `${B}modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts`,
    ],
    homonyms: [
      {
        path: `${B}modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle.ts`,
        why: '同名异物：走 `pathInside` 判定、抛 `intent-apply-maintenance-path-outside-managed-root`，属于 intent 上下文自己的托管根合同。合它要新开一条 intent → resource-catalog 的内部边，而两个上下文的「托管根」本来就不是同一个根。',
      },
    ],
  },
  {
    what: '「这条已准备好的包变更属于哪类资源」的七个类型谓词（两个应用引擎曾各揣整族一份）',
    fn: 'preparedPackageMutation',
    definedIn: `${B}modules/resource-catalog/public/types.ts`,
    consumers: [
      `${B}platform/persistence/sqlite/legacyResourcePackageBundleApply.ts`,
      `${B}platform/persistence/postgresqlResourcePackageAtomicApply.ts`,
    ],
    forkedFrom: [
      `${B}platform/persistence/sqlite/legacyResourcePackageBundleApply.ts`,
      `${B}platform/persistence/postgresqlResourcePackageAtomicApply.ts`,
    ],
  },
  {
    what: 'attempt 围栏的释放：attempt + 未释放 + 同 epoch 三条判据必须一起改',
    fn: 'releaseAttemptFencesTx',
    definedIn: `${B}modules/task-execution/infrastructure/effectQuiescence.ts`,
    consumers: [`${B}modules/task-execution/infrastructure/taskExecutionEffectPersistence.ts`],
    forkedFrom: [
      `${B}modules/task-execution/infrastructure/effectQuiescence.ts`,
      `${B}modules/task-execution/infrastructure/taskExecutionEffectPersistence.ts`,
    ],
  },
  {
    what: '用户记录的三张索引表（users / usernames / emails）必须一起改，换名换邮箱要先摘旧键',
    fn: 'storeUserAccessRecord',
    definedIn: `${B}modules/identity-access/infrastructure/userAccessRecordIndex.ts`,
    consumers: [
      `${B}modules/identity-access/infrastructure/oidcIdentityCrossContext.ts`,
      `${B}modules/identity-access/infrastructure/userAccessPersistence.ts`,
    ],
    forkedFrom: [
      `${B}modules/identity-access/infrastructure/oidcIdentityCrossContext.ts`,
      `${B}modules/identity-access/infrastructure/userAccessPersistence.ts`,
    ],
  },
]

/**
 * 一个名字的**定义点**：函数声明、类声明、任何带初始化器的变量绑定、类方法 / 对象属性。
 *
 * 判据刻意不限于「函数形状」。被盯着的这些名字里，
 * `preparedPackageMutation` 是 `const X = Object.freeze({ …七个类型谓词… })`——初始化器是一次
 * **调用**，不是箭头函数。只认函数形状的初版对它恒红（一个定义点都数不出来）。
 * 账本要问的是「这个名字全仓只有一个定义点吗」，那就该把任何模块级绑定都算进去；
 * 局部变量若与被盯的名字重名也会被算上——那不是误报，是「有人在函数里又实现了一份」，
 * 正是要人来账本里回答的那个问题。
 *
 * **唯一的例外是纯别名**：`const A = B` / `const A = ns.B`（初始化器就是一个标识符或属性访问）
 * 绑定的是**同一个值**，不可能是第二份实现。`public/participants.ts` 里
 * `export const humanGateNodeProjectionMember = humanGateNodeProjectionMemberInternal` 就是这个
 * 形状——公共面把 domain 的实现原样转出去。把它算成定义点等于禁止一切再导出。
 */
function declaredFunctionNames(unit: SourceUnit): ReadonlySet<string> {
  const names = new Set<string>()
  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.add(node.name.text)
    else if (ts.isClassDeclaration(node) && node.name !== undefined) names.add(node.name.text)
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      !ts.isIdentifier(node.initializer) &&
      !ts.isPropertyAccessExpression(node.initializer)
    ) {
      names.add(node.name.text)
    } else if (
      (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
      ts.isIdentifier(node.name)
    ) {
      if (ts.isMethodDeclaration(node) || isFunctionLike(node.initializer))
        names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(unit.source, visit)
  return names
}

/** 标识符层面的引用（含 import 子句），注释与字符串天然不算。 */
function referencesIdentifier(unit: SourceUnit, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === name) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(unit.source, visit)
  return found
}

describe('RFC-359 —— 已合一孪生体的定义点唯一', () => {
  test('语料是真的后端源码树', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(1500)
  })

  for (const twin of CONVERGED_TWINS) {
    test(`${twin.fn}：唯一定义 + 白名单消费（${twin.what}）`, () => {
      const definitions = UNITS.filter((u) => declaredFunctionNames(u).has(twin.fn)).map(
        (u) => u.path,
      )
      const expected = [twin.definedIn, ...(twin.homonyms ?? []).map((entry) => entry.path)].sort()
      expect(
        definitions.sort(),
        `${twin.fn} 的定义点。多出来的那个是**又一份副本**（合掉它）还是**同名异物**` +
          '（登记进 homonyms 并写清为什么不合）？两者都不许沉默。',
      ).toEqual(expected)

      const homonymPaths = new Set((twin.homonyms ?? []).map((entry) => entry.path))
      const referring = UNITS.filter(
        (u) =>
          u.path !== twin.definedIn &&
          !homonymPaths.has(u.path) &&
          referencesIdentifier(u, twin.fn),
      ).map((u) => u.path)
      const allowed = new Set(twin.consumers)
      expect(
        referring.filter((p) => !allowed.has(p)),
        `${twin.fn} 被白名单外的文件消费了`,
      ).toEqual([])
      expect(
        twin.consumers.filter((p) => !referring.includes(p)),
        `${twin.fn} 的白名单有陈旧条目，剪掉`,
      ).toEqual([])
    })
  }

  test('账本里的每条 forkedFrom 都指向真实路径形状（两处、且至少一处仍存在）', () => {
    const present = new Set(UNITS.map((u) => u.path))
    for (const twin of CONVERGED_TWINS) {
      expect(twin.forkedFrom).toHaveLength(2)
      expect(
        twin.forkedFrom.some((p) => present.has(p)),
        `${twin.fn} 的 forkedFrom 两处都已不存在，账本条目该重写`,
      ).toBe(true)
    }
  })
})

describe('RFC-359 —— 孪生体守卫自证有牙', () => {
  const fixture = (text: string): SourceUnit => sourceUnit('packages/backend/src/fixture.ts', text)

  test('重新 fork 出一份私有副本会被抓到', () => {
    const forked = fixture(`async function assertFrozenTaskTriggerPreflight(db: unknown) {
      return db
    }`)
    expect(declaredFunctionNames(forked).has('assertFrozenTaskTriggerPreflight')).toBe(true)
  })

  test('箭头函数形态的 fork 同样被抓到', () => {
    const forked = fixture(`const runRetentionSweepSlice = async () => 0`)
    expect(declaredFunctionNames(forked).has('runRetentionSweepSlice')).toBe(true)
  })

  test('`const X = Object.freeze({…})` 也算一个定义点（初始化器是调用，不是函数）', () => {
    const forked = fixture(`const preparedPackageMutation = Object.freeze({ isAgent: () => true })`)
    expect(declaredFunctionNames(forked).has('preparedPackageMutation')).toBe(true)
  })

  test('纯别名再导出**不算**定义点——否则等于禁止一切 re-export', () => {
    const reexport = fixture(
      `import { a as inner } from './x'\nexport const humanGateNodeProjectionMember = inner\nexport const b = ns.member`,
    )
    expect(declaredFunctionNames(reexport).has('humanGateNodeProjectionMember')).toBe(false)
    expect(declaredFunctionNames(reexport).has('b')).toBe(false)
  })

  test('只在注释里提到函数名不算定义点，也不算消费点', () => {
    const prose = fixture(`// 历史：composeSystemOverviewQuery 曾经有两份。
    /** 见 assertFrozenTaskTriggerPreflight。 */
    export const x = 1`)
    expect([...declaredFunctionNames(prose)]).toEqual(['x'])
    expect(referencesIdentifier(prose, 'assertFrozenTaskTriggerPreflight')).toBe(false)
  })

  test('字符串里的同名 token 不算消费点', () => {
    const stringy = fixture(`export const label = 'humanGateNodeProjectionMember'`)
    expect(referencesIdentifier(stringy, 'humanGateNodeProjectionMember')).toBe(false)
  })

  test('import 子句里的别名引入算消费点（绕过裸调用匹配的那条路）', () => {
    const aliased = fixture(
      `import { runRetentionSweepSlice as sweep } from '@/x'\nexport const y = sweep`,
    )
    expect(referencesIdentifier(aliased, 'runRetentionSweepSlice')).toBe(true)
  })
})
