// RFC-108 T3 (AR-11) — recovery_events audit + counters.
//
// 为什么这条测试存在：恢复动作此前全是 log.warn——daemon 每次重启静默回收 50 个孤儿
// 看起来和健康的一模一样。本测试锁定：① recordRecoveryEvent 落持久行 + bump 计数器 +
// 按 task 倒序可查；② 真实 actor（boot-reap）会记录事件（防接线漂移）。

import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'
import {
  __resetRecoveryCountersForTest,
  listRecoveryEventsForTask,
  recordRecoveryEvent,
  recoveryCountersSnapshot,
} from '../src/services/recovery'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedRunningTask(db: DbClient): Promise<string> {
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

describe('RFC-108 T3 — recordRecoveryEvent + counters', () => {
  // RFC-187: reset BEFORE as well as after. `recoveryCountersSnapshot()` is a
  // process-global, and several suites drive real recovery actions (autoResume /
  // dw-e2e / workgroup-e2e) without resetting — so an afterEach alone made the
  // exact-count assertions below depend on TEST FILE ORDER, and they went red on
  // ubuntu CI the moment new test files shifted that order. Resetting first makes
  // the counts mean "what THIS test did", independent of whatever ran before.
  beforeEach(() => __resetRecoveryCountersForTest())
  afterEach(() => __resetRecoveryCountersForTest())

  test('records a durable row, bumps the counter, lists newest-first', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await recordRecoveryEvent(db, {
      taskId,
      kind: 'auto-resume',
      reason: 'x',
      before: { status: 'interrupted' },
      after: { status: 'pending' },
    })
    const rows = await listRecoveryEventsForTask(db, taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('auto-resume')
    expect(rows[0]!.actor).toBe('system')
    expect(JSON.parse(rows[0]!.afterJson!)).toEqual({ status: 'pending' })
    expect(recoveryCountersSnapshot()['auto-resume']).toBe(1)
  })
})

describe('RFC-108 T3 — actors record recovery_events', () => {
  beforeEach(() => __resetRecoveryCountersForTest())
  afterEach(() => __resetRecoveryCountersForTest())

  test('reapOrphanRuns records a boot-reap event for each flipped task', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedRunningTask(db)
    await reapOrphanRuns(db)
    const rows = await listRecoveryEventsForTask(db, taskId)
    expect(rows.some((r) => r.kind === 'boot-reap')).toBe(true)
    expect(recoveryCountersSnapshot()['boot-reap']).toBeGreaterThanOrEqual(1)
    const t = await db.select().from(tasks).where(eq(tasks.id, taskId))
    expect(t[0]!.status).toBe('interrupted')
  })
})
