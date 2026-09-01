// RFC-108 T11 (AR-09) — auto-recovery circuit-breaker / quarantine.
//
// 为什么这条测试存在：auto-resume / auto-repair 一旦开启，一个确定性崩溃的任务会被
// 无限自动重跑烧 LLM 成本。本测试锁定：① 滚动窗口内尝试超过 maxPerWindow → 隔离
// (auto_recovery_suspended=1)，并记 quarantine recovery_event；② 已隔离再调不二次累加；
// ③ 人工 clear 重置；④ 窗口滚过后计数重置为 1。

import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { listRecoveryEventsForTask } from '../src/services/recovery'
import {
  clearAutoRecoverySuspension,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '../src/services/recoveryBreaker'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<string> {
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
    status: 'interrupted',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-108 T11 — circuit-breaker / quarantine', () => {
  test('quarantines after maxPerWindow attempts + records event; clear resets', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const operations = taskRecoveryOperations(db)
    const cfg = { maxPerWindow: 3, windowMs: 60 * 60 * 1000 }

    let r = { suspended: false, attempts: 0 }
    for (let i = 1; i <= 3; i++) {
      r = await recordAutoRecoveryAttempt(operations, taskId, cfg, 1000)
    }
    expect(r.attempts).toBe(3)
    expect(r.suspended).toBe(false) // 3 ≤ 3, not over yet

    r = await recordAutoRecoveryAttempt(operations, taskId, cfg, 1000)
    expect(r.suspended).toBe(true) // 4 > 3 → quarantine
    expect(await isAutoRecoverySuspended(operations, taskId)).toBe(true)
    expect(
      (await listRecoveryEventsForTask(operations, taskId)).some((e) => e.kind === 'quarantine'),
    ).toBe(true)

    // Already suspended → returns suspended without re-incrementing.
    const again = await recordAutoRecoveryAttempt(operations, taskId, cfg, 1000)
    expect(again.suspended).toBe(true)
    expect(again.attempts).toBe(4)

    await clearAutoRecoverySuspension(operations, taskId)
    expect(await isAutoRecoverySuspended(operations, taskId)).toBe(false)
  })

  test('window rolls over: an attempt outside the window resets the count to 1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const operations = taskRecoveryOperations(db)
    const cfg = { maxPerWindow: 3, windowMs: 1000 }
    await recordAutoRecoveryAttempt(operations, taskId, cfg, 0)
    await recordAutoRecoveryAttempt(operations, taskId, cfg, 500)
    const r = await recordAutoRecoveryAttempt(operations, taskId, cfg, 5000) // 5000-0 ≥ 1000 → reset
    expect(r.attempts).toBe(1)
    expect(r.suspended).toBe(false)
  })
})
