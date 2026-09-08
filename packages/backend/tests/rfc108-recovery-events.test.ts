// RFC-108 T3 (AR-11) — recovery_events audit + counters.
//
// 为什么这条测试存在：恢复动作此前全是 log.warn——daemon 每次重启静默回收 50 个孤儿
// 看起来和健康的一模一样。本测试锁定：① recordRecoveryEvent 落持久行 + bump 计数器 +
// 按 task 倒序可查；② 真实 actor（boot-reap）会记录事件（防接线漂移）。

import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'
import {
  __resetRecoveryCountersForTest,
  listRecoveryEventsForTask,
  recordRecoveryEvent,
  recoveryCountersSnapshot,
} from '../src/services/recovery'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'

async function seedRunningTask(db: ProviderNeutralDatabase): Promise<string> {
  const wfId = ulid()
  const taskId = ulid()
  const def = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
  await db.insert(workflows).values({ id: wfId, name: 'w', definition: JSON.stringify(def) })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describeEachProvider('RFC-108 T3 — recordRecoveryEvent + counters', (harness) => {
  // RFC-187: reset BEFORE as well as after. `recoveryCountersSnapshot()` is a
  // process-global, and several suites drive real recovery actions (autoResume /
  // dw-e2e / workgroup-e2e) without resetting — so an afterEach alone made the
  // exact-count assertions below depend on TEST FILE ORDER, and they went red on
  // ubuntu CI the moment new test files shifted that order. Resetting first makes
  // the counts mean "what THIS test did", independent of whatever ran before.
  beforeEach(() => __resetRecoveryCountersForTest())
  afterEach(() => __resetRecoveryCountersForTest())

  test('records a durable row, bumps the counter, lists newest-first', async () => {
    const db = harness.db
    const taskId = await seedRunningTask(db)
    const operations = createTaskExecutionPersistence(db).recoveryAdministration
    await recordRecoveryEvent(operations, {
      taskId,
      kind: 'auto-resume',
      reason: 'x',
      before: { status: 'interrupted' },
      after: { status: 'pending' },
    })
    const rows = await listRecoveryEventsForTask(operations, taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('auto-resume')
    expect(rows[0]!.actor).toBe('system')
    expect(JSON.parse(rows[0]!.afterJson!)).toEqual({ status: 'pending' })
    expect(recoveryCountersSnapshot()['auto-resume']).toBe(1)
  })
})

describeEachProvider('RFC-108 T3 — actors record recovery_events', (harness) => {
  beforeEach(() => __resetRecoveryCountersForTest())
  afterEach(() => __resetRecoveryCountersForTest())

  test('reapOrphanRuns records a boot-reap event for each flipped task', async () => {
    const db = harness.db
    const taskId = await seedRunningTask(db)
    const operations = createTaskExecutionPersistence(db).recoveryAdministration
    await reapOrphanRuns(operations)
    const rows = await listRecoveryEventsForTask(operations, taskId)
    expect(rows.some((r) => r.kind === 'boot-reap')).toBe(true)
    expect(recoveryCountersSnapshot()['boot-reap']).toBeGreaterThanOrEqual(1)
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('interrupted')
  })
})
