// RFC-317 T41 · R5（findings DE-01 / DE-02）—— **表归属**。
//
// RFC-294 明令：bounded context 之间「不得以共享表、内部 import 或
// `bootstrap if type === development` 重新耦合」。前两种此前只有一种被守住——
// `rfc294-architecture-preflight` 的 `crossContextViolations` 逐条钉死了
// `@/modules/<ctx>/...` 形态的内部 import 边。**共享表完全没有防线**：
// 表是从全局 `@/db/schema` 命名空间取的，它不是一条 module import 边，
// 于是所有基于 import 的守卫都对它失明。
//
// 实测代价（两条互为镜像）：
//   · DE-01 —— 通用 OS 的 `writerCutover.ts` 直接查 development-automation 的四张
//     Mission 表，还抄了一份「已了结审批状态」词表。通用 OS 因此离开 development 的
//     schema 就装配不起来；development 改一列会静默改坏它。
//   · DE-02 —— 反过来，development-automation 直接查 OS 的私表 `employeeReactionRounds`，
//     读它冻结的 planJson，并按 `state === 'completed'` 过滤——把 OS 的内部状态机枚举
//     变成了一条没有声明、没有 schema、没有主人的事实合同。
// 两条都已在 T41 收口成 public 端口；本文件是让它们不会再长回来的机制。
//
// ---------------------------------------------------------------------------
// 判据为什么按**前缀声明**归属，而不是按引用推断
// ---------------------------------------------------------------------------
//
// 按引用推断（「只有一个 context 引用它 ⇒ 它归那个 context」）在真实语料上会把最严重
// 的一类越界判成合法：`employeeRoundWorkspaceStates` 明明是 Digital Employee OS 的表
// （与其余 13 张 employee* 表同批建、同一个 store 写），却**只**被
// development-automation 引用过。按引用推断会得出「它归 development-automation」，
// 于是「另一个 context 独占了你的表」这种最坏情况反而一条都不报。
// 所以归属必须是**声明**出来的，下面那张前缀表就是那份声明。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  drizzleTableSymbols,
  packageSrcUnits,
  sourceUnit,
  tableOwnershipCrossings,
} from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/**
 * 表名前缀 → 拥有它的 bounded context。
 *
 * 这里**只登记已经模块化、且表名带专属前缀的 context**。没有专属前缀的域
 * （tasks / workflows / memories …）目前散落在 `services/` 横向层，还不是 module，
 * 强行给它们编前缀会让这条规则报出几百条与本 RFC 无关的噪音。RFC-294 的方向是那些
 * 域逐步迁入 module，届时在这里加一行即可把它们纳入同一条判据。
 */
const TABLE_OWNER_PREFIXES: Readonly<Record<string, string>> = {
  employee: 'digital-employee',
  development: 'development-automation',
}

interface OwnershipDebt {
  readonly table: string
  readonly owner: string
  readonly file: string
  /** 为什么现在还能接受。 */
  readonly why: string
  /** 什么时候消失——必须指向具体任务 / RFC，不允许写「以后再说」。 */
  readonly removeWhen: string
}

/**
 * T41 开账当天的真实存量：8 条。
 *
 * 同批**已清掉**的是 finding 逐条点名的三处：
 *   · `writerCutover.ts` 对四张 development Mission 表的查询 → `LegacyMissionDrainPort`；
 *   · `digitalEmployeeWorkspace.ts` 读 `employeeReactionRounds.planJson`
 *     → `EmployeeReactionRoundQueryPort.frozenPlan`；
 *   · `digitalEmployeePlatformWorkItems.ts` 按 `state === 'completed'` 找修复轮次
 *     → `EmployeeReactionRoundQueryPort.lastSettledRound`。
 * 剩下这 8 条是同一片耦合里**更深的一层**（含写侧），不是同一个动作能收口的，
 * 逐条记在这里并写清出路——棘轮只减不增。
 */
const OWNERSHIP_DEBT: readonly OwnershipDebt[] = [
  {
    table: 'developmentAdapterDefinitionRevisions',
    owner: 'development-automation',
    file: 'integration/infrastructure/sqliteDevelopmentAdapterStore.ts',
    why: 'integration 侧的适配器定义存储直接读写 development 的适配器定义与其修订表。适配器定义「归谁」本身尚未裁决：它既是 development 的执行配置，也是 integration 的对外协议映射。',
    removeWhen:
      'RFC-317 B10（传输/平台批次）先裁决适配器定义的归属 context，再据此把这张表连同 store 整体划归一侧，另一侧改走 public 端口。',
  },
  {
    table: 'developmentAdapterDefinitions',
    owner: 'development-automation',
    file: 'integration/infrastructure/sqliteDevelopmentAdapterStore.ts',
    why: '同上——与 revisions 表是同一个 store 的两半，必须同去同留。',
    removeWhen: '同 developmentAdapterDefinitionRevisions。',
  },
  {
    table: 'employeeApprovalSagas',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeePlatformWorkItems.ts',
    why: '平台工作项在发布环节读 OS 的审批 saga 行判断人审是否已放行。这是**读**侧耦合，与 DE-02 已收口的两处同形，但它牵到审批状态机的多个态，收口需要先把「审批已放行」定义成 OS 的一条 public 判据。',
    removeWhen:
      'RFC-317 B7 生命周期批次：在 digital-employee/public/queries 上补 `approvalSettled(caseId, workItemRef)`，与 lastSettledRound 同形。',
  },
  {
    table: 'employeeCaseWorkspaces',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeePlatformWorkItems.ts',
    why: '读工作区基线（cachedRepoId / baselineSha）以定位仓库副本。',
    removeWhen: '与下面 digitalEmployeeWorkspace.ts 的同表条目一起收口（同一个工作区持久化端口）。',
  },
  {
    table: 'employeeCaseWorkspaces',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeeWorkspace.ts',
    why: '**写**侧：development-automation 在这里 insert 工作区行。这已不是「借读一张表」，而是两个 context 共同写同一张表——收口意味着把整套工作区持久化搬进 OS 或搬出 OS，是一次独立的设计裁决，不该塞进 T41。',
    removeWhen:
      'RFC-317 B7 生命周期批次：裁决工作区持久化的归属，落 `EmployeeWorkspaceStorePort`（prepare / checkpoint / restore / validate 四组），两侧各自只经端口。',
  },
  {
    table: 'employeeChangeCandidates',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeePlatformWorkItems.ts',
    why: '发布环节读 OS 的变更候选行（候选文件集与其判定结果）以组装真正要提交的内容。与 approvalSagas 是同一次发布判定的两半，读的都是 OS 内部的中间产物。',
    removeWhen: '同 employeeApprovalSagas —— 一并在 B7 补 public 查询面。',
  },
  {
    table: 'employeeRoundWorkspaceStates',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeePlatformWorkItems.ts',
    why: '读某轮次最后一次尝试的 validationJson。DE-02 收口 lastSettledRound 之后，这里拿到的是端口给的 roundRef，但取 validation 仍直查表。',
    removeWhen: '同 employeeCaseWorkspaces —— 归入 B7 的 EmployeeWorkspaceStorePort。',
  },
  {
    table: 'employeeRoundWorkspaceStates',
    owner: 'digital-employee',
    file: 'development-automation/composition/digitalEmployeeWorkspace.ts',
    why: '**写**侧：insert / update 轮次工作区状态行（含 onConflictDoNothing 的并发路径）。同 employeeCaseWorkspaces，属共同写，收口需独立裁决。',
    removeWhen: '同 employeeCaseWorkspaces。',
  },
]

const units = packageSrcUnits(REPO_ROOT, 'backend')
const schemaUnit = units.find((unit) => unit.path === 'packages/backend/src/db/schema.ts')
if (schemaUnit === undefined) throw new Error('db/schema.ts 不在语料里——路径判据坏了')
const TABLES = drizzleTableSymbols(schemaUnit)

const key = (entry: { readonly table: string; readonly file: string }): string =>
  `${entry.table}|${entry.file}`

describe('RFC-317 T41 · R5 —— 一张表只属于一个 bounded context', () => {
  test('语料下限：真的扫到了 backend 的生产源码与 schema', () => {
    // 没有这条，下面「跨界集合等于账本」在语料为空时会以「两边都是空」的形式假绿。
    expect(units.length).toBeGreaterThan(700)
    expect(TABLES.length).toBeGreaterThan(120)
  })

  test('跨 context 的表引用与账本**逐条相等**（新增一条 ⇒ 红；修掉一条也 ⇒ 红）', () => {
    const actual = tableOwnershipCrossings({
      units,
      tables: TABLES,
      ownerPrefixes: TABLE_OWNER_PREFIXES,
    }).map(key)
    expect(
      actual,
      '要么这次新长出了跨 context 的表引用（去补 public 端口），要么某条债已还清（把账本里对应那条删掉）——两种都不该静默通过',
    ).toEqual([...OWNERSHIP_DEBT].map(key).sort())
  })

  test('每条债都写了 why 与 removeWhen（写不出出路的债不该记）', () => {
    for (const debt of OWNERSHIP_DEBT) {
      expect(debt.why.length, `${key(debt)}.why`).toBeGreaterThan(20)
      expect(debt.removeWhen.length, `${key(debt)}.removeWhen`).toBeGreaterThan(10)
    }
  })

  test('账本里没有重复条目（同一 (表,文件) 记两次会让「只减不增」失效）', () => {
    const keys = OWNERSHIP_DEBT.map(key)
    expect([...new Set(keys)].sort()).toEqual([...keys].sort())
  })
})

// ---------------------------------------------------------------------------
// 负向 fixture —— 证明判据真的会咬，且咬的是**声明的**归属而不是推断的归属。
// ---------------------------------------------------------------------------

const OWNER_UNIT = sourceUnit(
  'packages/backend/src/modules/alpha-context/infrastructure/store.ts',
  `import { alphaThings } from '@/db/schema'
   export const read = () => alphaThings`,
)
const FOREIGN_UNIT = sourceUnit(
  'packages/backend/src/modules/beta-context/composition/uses.ts',
  `import { alphaThings, betaThings } from '@/db/schema'
   export const peek = () => [alphaThings, betaThings]`,
)
const ORPHAN_FOREIGN_UNIT = sourceUnit(
  'packages/backend/src/modules/beta-context/composition/orphan.ts',
  `import { alphaOrphan } from '@/db/schema'
   export const only = () => alphaOrphan`,
)

describe('RFC-317 T41 · R5 负向 fixture', () => {
  const prefixes = { alpha: 'alpha-context', beta: 'beta-context' }

  test('外来 context 引用别人的表 ⇒ 报出来', () => {
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT, FOREIGN_UNIT],
        tables: ['alphaThings', 'betaThings'],
        ownerPrefixes: prefixes,
      }).map(key),
    ).toEqual(['alphaThings|beta-context/composition/uses.ts'])
  })

  test('**只被外来 context 引用**的表照样报出来（这正是按引用推断会漏掉的那类）', () => {
    // alphaOrphan 归 alpha-context（前缀声明），但 alpha 自己一次都没引用它。
    // 按引用推断会说「它归 beta-context，合法」；按声明归属，它是越界。
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT, ORPHAN_FOREIGN_UNIT],
        tables: ['alphaThings', 'alphaOrphan'],
        ownerPrefixes: prefixes,
      }).map(key),
    ).toEqual(['alphaOrphan|beta-context/composition/orphan.ts'])
  })

  test('自己 context 引用自己的表不算越界', () => {
    expect(
      tableOwnershipCrossings({
        units: [OWNER_UNIT],
        tables: ['alphaThings'],
        ownerPrefixes: prefixes,
      }),
    ).toEqual([])
  })

  test('没有前缀归属的表完全不在判据内（避免把未模块化的域灌进来）', () => {
    expect(
      tableOwnershipCrossings({
        units: [FOREIGN_UNIT],
        tables: ['tasks', 'workflows'],
        ownerPrefixes: prefixes,
      }),
    ).toEqual([])
  })
})
