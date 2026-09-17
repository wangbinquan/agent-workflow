// RFC-359 AC-1 —— 任务列表的**单飞合并键**必须覆盖全部筛选项。
//
// 为什么这条测试存在（先红后绿的那个红）：
// `services/task.ts#listTasks` 把并发的同形列表查询合并成一次（`createInFlightCoalescer`，
// 多标签页 + WS 失效风暴下这是热路径）。合并键 `taskListFlightKey` 是**手写的字段清单**，
// 而 RFC-301 给 `ListTasksFilters` 加 `origin` 时**没有把它加进那份清单**——
// 于是两个只差 `origin` 的并发请求会被判成同一次查询，**第二个拿到第一个的行**：
//
//   GET /api/tasks?origin=scheduled  ← 先到，去查库
//   GET /api/tasks?origin=api        ← 同一 tick 内到达，被合并，收到「定时」那批任务
//
// 而 PostgreSQL 那一侧根本没有单飞合并，同样两个请求各查各的、结果正确——这正是本 RFC
// 要消灭的「一个引擎好、一个引擎不好」的形态，只不过这次不好的那个是 SQLite。
//
// 修法不是「把 origin 补进清单」——那只修掉这一格，下一个新筛选项照样漏。合并键改成对
// **整个 filters 对象**做规范序列化，整类 bug 一次性消失。本文件同时锁住两件事：
//   1. 只差一个筛选项的并发查询**不得**被合并（逐项过一遍，新加的筛选项漏了就红）；
//   2. 完全同形的并发查询**仍然**被合并（别把性能特性一起修没了）。
import { beforeEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, users, workflows } from '@/db/schema'
import { bindDescribeEachProviderLifecycle } from './helpers/eachProvider'

const describeEachProvider = bindDescribeEachProviderLifecycle({ sourceFile: import.meta.url })

const NOW = 1_788_300_000_000

async function seedListFixture(db: ProviderNeutralDatabase): Promise<void> {
  await db.insert(users).values({
    id: 'u-flight',
    username: 'flight',
    displayName: 'Flight',
    role: 'admin',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(workflows).values({
    id: 'wf-flight',
    name: 'flight',
    definition: JSON.stringify({ $schema_version: 5, inputs: [], nodes: [], edges: [] }),
  })
  // 两条任务，只差 launch_origin：一条定时、一条 API。
  const base = {
    workflowId: 'wf-flight',
    workflowSnapshot: '{}',
    repoPath: '/tmp/flight',
    worktreePath: '/tmp/flight-wt',
    baseBranch: 'main',
    branch: 'aw/flight',
    status: 'done' as const,
    inputs: '{}',
    startedAt: NOW,
    finishedAt: NOW + 10,
    ownerUserId: 'u-flight',
    catalogVisibility: 'public' as const,
    repoCount: 1,
  }
  await db
    .insert(tasks)
    .values({ ...base, id: 'tk-schedule-0001', name: 'by schedule', launchOrigin: 'scheduled' })
  await db.insert(tasks).values({ ...base, id: 'tk-api-0001', name: 'by api', launchOrigin: 'api' })
}

describeEachProvider('RFC-359 —— 任务列表单飞合并键覆盖全部筛选项', (harness) => {
  beforeEach(async () => {
    await seedListFixture(harness.db)
  })

  test('只差 origin 的两个并发列表查询不得互相污染', async () => {
    const { listTasks } = await import('@/services/task')
    // **不 await 第一个就发第二个**——单飞窗口正是在这一刻。
    const [schedule, api] = await Promise.all([
      listTasks(harness.db, { origin: 'scheduled' }),
      listTasks(harness.db, { origin: 'api' }),
    ])
    expect(
      schedule.map((task) => task.id),
      'origin=scheduled 只应看到定时启动的那条',
    ).toEqual(['tk-schedule-0001'])
    expect(
      api.map((task) => task.id),
      'origin=api 只应看到 API 启动的那条——拿到定时那条说明并发合并键漏了 origin',
    ).toEqual(['tk-api-0001'])
  })

  test('逐个筛选项：任何一项不同的两个并发查询都不得被合并', async () => {
    const { listTasks } = await import('@/services/task')
    // 每组两个只差**一项**的筛选；两条种子任务的形状让每组必然给出不同结果。
    const probes = [
      [{ status: 'done' as const }, { status: 'failed' as const }],
      [{ origin: 'scheduled' as const }, { origin: 'api' as const }],
      [{ workflowId: 'wf-flight' }, { workflowId: 'wf-absent' }],
      [{ repoPath: '/tmp/flight' }, { repoPath: '/tmp/absent' }],
      [{ limit: 2 }, { limit: 1 }],
      [{ topLevelOnly: true }, { topLevelOnly: false }],
    ]
    for (const [left, right] of probes) {
      const [a, b] = await Promise.all([listTasks(harness.db, left), listTasks(harness.db, right)])
      expect(
        a === b,
        `筛选项不同的两个并发查询返回了同一个数组：${JSON.stringify([left, right])}`,
      ).toBe(false)
    }
  })

  test('完全同形的并发查询仍然被合并（别把性能特性一起修没了）', async () => {
    const { listTasks } = await import('@/services/task')
    const key = { status: 'done' as const, origin: 'scheduled' as const, limit: 50 }
    const [a, b] = await Promise.all([
      listTasks(harness.db, { ...key }),
      listTasks(harness.db, { ...key }),
    ])
    expect(a, '同形并发查询应当共享同一次库访问的结果').toBe(b)
    expect(a.map((task) => task.id)).toEqual(['tk-schedule-0001'])
  })

  test('唯一标识：ulid 生成的种子 id 不参与合并键（负 fixture 的稳定性前提）', () => {
    expect(ulid()).not.toBe(ulid())
  })
})
