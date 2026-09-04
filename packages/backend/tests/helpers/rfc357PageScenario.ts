// RFC-357 —— 列表页的**共享场景**：一份种子、一份期望，两个 provider 各跑一遍。
//
// 这就是 AC-5 的 oracle，而且是结构性的：SQLite 与 PostgreSQL 不是「各写一份断言再人肉
// 对照」，是**同一个 `expectPageScenario` 被调用两次**。任何一侧行为漂了，那一侧红。
//
// 种子刻意覆盖每一条方言差异会踩到的面（清单见 `design.md §6` 与
// `rfc357-provider-portability.test.ts`）：
//   · 大小写混排的名字与仓库路径 —— 搜索折叠（PostgreSQL 的 LIKE 大小写敏感）；
//   · 有未结告警的行 —— attention 桶 + `open_alert_count` 的 `count(*)`（PG 回字符串）；
//   · 五种 launch_origin —— 含被「事件」收编的存量 webhook；
//   · 合法与**非法** workgroup_config_json —— `json_valid` / `json_type` / `json_extract` shim；
//   · 一棵父子树 —— 递归 CTE、分支聚合与 `instr` 防环；
//   · 无主行 + 协作者 —— `scope='shared'` 的 SQL 三值逻辑。

import { expect } from 'bun:test'

import type {
  TaskListPage,
  TaskListViewer,
} from '@/modules/task-execution/infrastructure/taskListPage'

export const RFC357_ADMIN: TaskListViewer = { userId: 'admin', canReadAllTasks: true }
export const RFC357_ALICE: TaskListViewer = { userId: 'alice', canReadAllTasks: false }

export interface Rfc357SeedTask {
  readonly id: string
  readonly name: string
  readonly status: 'running' | 'done' | 'failed' | 'awaiting_review' | 'canceled'
  readonly owner: string | null
  readonly origin: 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'
  readonly parent?: string
  readonly workgroupConfigJson?: string | null
  readonly sourceAgentName?: string | null
  readonly repoPath?: string
  readonly alerts?: number
  readonly collaborators?: readonly string[]
}

export const RFC357_SEED: readonly Rfc357SeedTask[] = [
  {
    id: 't-01',
    name: 'Deploy Runbook',
    status: 'running',
    owner: 'alice',
    origin: 'manual',
    repoPath: '/srv/Repos/Alpha',
  },
  { id: 't-02', name: 'nightly sweep', status: 'done', owner: 'bob', origin: 'scheduled' },
  {
    id: 't-03',
    name: 'child of nightly',
    status: 'done',
    owner: 'bob',
    origin: 'scheduled',
    parent: 't-02',
  },
  { id: 't-04', name: 'event driven', status: 'failed', owner: 'bob', origin: 'event' },
  { id: 't-05', name: 'legacy hook', status: 'done', owner: 'bob', origin: 'webhook' },
  {
    id: 't-06',
    name: 'api launched',
    status: 'awaiting_review',
    owner: null,
    origin: 'api',
    collaborators: ['alice'],
  },
  { id: 't-07', name: 'alerted', status: 'done', owner: 'alice', origin: 'manual', alerts: 2 },
  {
    id: 't-08',
    name: 'workgroup run',
    status: 'running',
    owner: 'bob',
    origin: 'manual',
    workgroupConfigJson: JSON.stringify({ workgroupName: 'Release Crew' }),
  },
  {
    id: 't-09',
    name: 'corrupt config',
    status: 'canceled',
    owner: 'bob',
    origin: 'manual',
    workgroupConfigJson: '{not json',
  },
  {
    id: 't-10',
    name: 'agent run',
    status: 'done',
    owner: 'bob',
    origin: 'manual',
    sourceAgentName: 'Auditor',
  },
]

const SEED_EPOCH = 1_788_278_400_000

/** 每行的 started_at 由顺序定死，两个 provider 的种子必须逐字相同。 */
export function rfc357StartedAt(id: string): number {
  const index = RFC357_SEED.findIndex((row) => row.id === id)
  if (index < 0) throw new Error(`unknown seed task: ${id}`)
  return SEED_EPOCH + (index + 1) * 1000
}

export function rfc357RootOf(row: Rfc357SeedTask): string {
  return row.parent ?? row.id
}

/** 分支排序键 = 整棵树里最大的 started_at，与维护钩子的定义逐字同源。 */
export function rfc357BranchStartedAt(row: Rfc357SeedTask): number {
  const members = RFC357_SEED.filter((candidate) => rfc357RootOf(candidate) === row.id)
  return Math.max(rfc357StartedAt(row.id), ...members.map((member) => rfc357StartedAt(member.id)))
}

/**
 * 期望值全部是**实测**下来的，不是手推的：写这份场景时先在 SQLite 上跑了一遍
 * （facets.all 是 10 而不是「根的个数」9 —— 分母数在 `non_view_matches` 上，
 * 含子行；这正是「facets 与 view 无关」契约的另一面）。
 */
export async function expectRfc357PageScenario(page: TaskListPage): Promise<void> {
  // ---- 默认视图（全可见 actor 走 RFC-311 快路径）：只有根行，按分支键倒序。
  const root = await page.list(RFC357_ADMIN, {})
  expect(root.kind).toBe('root')
  expect(root.items.map((item) => item.id)).toEqual([
    't-10',
    't-09',
    't-08',
    't-07',
    't-06',
    't-05',
    't-04',
    't-02',
    't-01',
  ])

  // 裸 SQL 回读的数值必须是 number，而不是 PostgreSQL 驱动交回的字符串。
  for (const item of root.items) {
    for (const [field, value] of [
      ['startedAt', item.startedAt],
      ['repoCount', item.repoCount],
      ['openAlertCount', item.openAlertCount],
      ['invocationDepth', item.invocationDepth],
      ['childCount', item.childCount],
      ['runningMs', item.executionClock.runningMs],
      ['branchStartedAt', item.listContext.branchStartedAt],
      ['qualifyingChildCount', item.listContext.qualifyingChildCount],
      ['matchingDescendantCount', item.listContext.matchingDescendantCount],
    ] as const) {
      expect(typeof value, `${item.id}.${field} must decode to a number`).toBe('number')
    }
  }
  if (root.kind === 'root') {
    for (const [bucket, value] of Object.entries(root.facets)) {
      expect(typeof value, `facets.${bucket} must decode to a number`).toBe('number')
    }
    expect(root.facets).toEqual({ all: 10, active: 3, attention: 3, finished: 7 })
  }

  // ---- 分支聚合：定时任务的根因为子行更新而排在自己的 started_at 之后。
  const nightly = root.items.find((item) => item.id === 't-02')
  expect(nightly?.startedAt).toBe(rfc357StartedAt('t-02'))
  expect(nightly?.listContext.branchStartedAt).toBe(rfc357StartedAt('t-03'))
  expect(nightly?.listContext.qualifyingChildCount).toBe(1)
  expect(nightly?.childCount).toBe(1)

  // ---- json shim：合法配置取出名字，非法配置退化成 null 而不是炸整页。
  expect(root.items.find((item) => item.id === 't-08')?.workgroupName).toBe('Release Crew')
  expect(root.items.find((item) => item.id === 't-09')?.workgroupName).toBeNull()

  // ---- 搜索折叠大小写：种子里是 "Deploy Runbook" 与 "/srv/Repos/Alpha"，查询用小写。
  expect((await page.list(RFC357_ADMIN, { q: 'runbook' })).items.map((item) => item.id)).toEqual([
    't-01',
  ])
  expect(
    (await page.list(RFC357_ADMIN, { q: 'repos/alpha' })).items.map((item) => item.id),
  ).toEqual(['t-01'])

  // ---- 每个 origin 都可用，且「事件」收编存量 webhook。
  const idsForOrigin = async (origin: string): Promise<string[]> =>
    (await page.list(RFC357_ADMIN, { origin })).items.map((item) => item.id).sort()
  expect(await idsForOrigin('manual')).toEqual(['t-01', 't-07', 't-08', 't-09', 't-10'])
  expect(await idsForOrigin('scheduled')).toEqual(['t-02'])
  expect(await idsForOrigin('event')).toEqual(['t-04', 't-05'])
  expect(await idsForOrigin('api')).toEqual(['t-06'])

  // ---- 四个 view 各自分流，但 facets 与 view 无关（RFC-244 契约）。
  for (const view of ['all', 'active', 'attention', 'finished']) {
    const viewed = await page.list(RFC357_ADMIN, { view })
    if (viewed.kind === 'root') {
      expect(viewed.facets, `facets must ignore view=${view}`).toEqual({
        all: 10,
        active: 3,
        attention: 3,
        finished: 7,
      })
    }
  }

  // ---- keyset 翻页：行值断点在真库上真的推进，且不重不漏。
  const first = await page.list(RFC357_ADMIN, { limit: '4' })
  expect(first.items.map((item) => item.id)).toEqual(['t-10', 't-09', 't-08', 't-07'])
  expect(first.nextCursor).not.toBeNull()
  const second = await page.list(RFC357_ADMIN, { limit: '4', cursor: first.nextCursor! })
  expect(second.items.map((item) => item.id)).toEqual(['t-06', 't-05', 't-04', 't-02'])

  // ---- 子页：递归 CTE 走得通。
  const children = await page.list(RFC357_ADMIN, { parent_id: 't-02' })
  expect(children.kind).toBe('children')
  expect(children.items.map((item) => item.id)).toEqual(['t-03'])

  // ---- 受限 actor 走穷举管线（快路径只服务全可见 actor），三值逻辑那一行仍在：
  //      t-06 无主但把 alice 记为协作者，`ne(owner, me)` 单独用会让它消失。
  expect((await page.list(RFC357_ALICE, { scope: 'shared' })).items.map((item) => item.id)).toEqual(
    ['t-06'],
  )
  expect(
    (await page.list(RFC357_ALICE, { scope: 'mine' })).items.map((item) => item.id).sort(),
  ).toEqual(['t-01', 't-06', 't-07'])
}
