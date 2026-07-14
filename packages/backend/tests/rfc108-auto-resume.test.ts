// RFC-108 T18 (AR-03) — boot auto-resume (default OFF).
//
// 为什么这条测试存在：boot auto-resume 一旦开启，必须只重跑「daemon-restart 致
// interrupted」的任务、且穿过全部护栏。本测试锁定：① 只选 interrupted+daemon-restart
// （放过其它状态/其它 errorSummary）；② 每条成功 resume 记 auto-resume recovery_event；
// ③ 已隔离任务跳过；④ resume 抛错不中断循环、计入熔断；⑤ 熔断触顶后续跳过。

import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { ulid } from 'ulid'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { autoResumeInterruptedTasks } from '../src/services/autoResume'
import { __clearDriverLeasesForTest } from '../src/services/driverLease'
import { listRecoveryEventsForTask, __resetRecoveryCountersForTest } from '../src/services/recovery'
import {
  clearAutoRecoverySuspension,
  recordAutoRecoveryAttempt,
} from '../src/services/recoveryBreaker'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BREAKER = { maxPerWindow: 3, windowMs: 60 * 60 * 1000 }

afterEach(() => {
  __clearDriverLeasesForTest()
  __resetRecoveryCountersForTest()
})

async function seedTask(
  db: DbClient,
  status: string,
  errorSummary: string | null,
  workgroup?: { workgroupId: string; mode: string },
): Promise<string> {
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
    status: status as 'interrupted',
    errorSummary,
    inputs: '{}',
    startedAt: Date.now(),
    ...(workgroup !== undefined
      ? {
          workgroupId: workgroup.workgroupId,
          workgroupConfigJson: JSON.stringify({ mode: workgroup.mode }),
        }
      : {}),
  })
  return taskId
}

describe('RFC-108 T18 — boot auto-resume', () => {
  test('resumes only interrupted+daemon-restart; records an auto-resume event each', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const a = await seedTask(db, 'interrupted', 'daemon-restart')
    const b = await seedTask(db, 'interrupted', 'daemon-restart')
    await seedTask(db, 'interrupted', 'node-timeout') // other errorSummary → skipped
    await seedTask(db, 'failed', 'daemon-restart') // other status → skipped
    const resumedCalls: string[] = []
    const res = await autoResumeInterruptedTasks({
      db,
      breaker: BREAKER,
      resume: async (id) => {
        resumedCalls.push(id)
      },
    })
    expect(res.resumed.sort()).toEqual([a, b].sort())
    expect(resumedCalls.sort()).toEqual([a, b].sort())
    expect((await listRecoveryEventsForTask(db, a)).some((e) => e.kind === 'auto-resume')).toBe(
      true,
    )
  })

  test('RFC-186 PR-2: turn-engine workgroup tasks ALSO auto-resume (were previously excluded)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const lw = await seedTask(db, 'interrupted', 'daemon-restart', {
      workgroupId: 'wg-lw',
      mode: 'leader_worker',
    })
    const fc = await seedTask(db, 'interrupted', 'daemon-restart', {
      workgroupId: 'wg-fc',
      mode: 'free_collab',
    })
    const dyn = await seedTask(db, 'interrupted', 'daemon-restart', {
      workgroupId: 'wg-dyn',
      mode: 'dynamic_workflow',
    })
    const res = await autoResumeInterruptedTasks({
      db,
      breaker: BREAKER,
      resume: async () => {},
    })
    // RFC-186 PR-2 (audit §5 F1): leader_worker / free_collab are no longer left
    // `interrupted` forever — resumeTask → runWorkgroupEngine re-enters. All three
    // turn/DAG modes now resume. (The prior lock asserted ONLY dynamic_workflow;
    // that exclusion was the direct cause of permanently-wedged production tasks.)
    expect(res.resumed.sort()).toEqual([lw, fc, dyn].sort())
  })

  test('skips a quarantined task', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const a = await seedTask(db, 'interrupted', 'daemon-restart')
    // Trip the breaker for `a` (4 attempts > maxPerWindow 3 → suspended).
    for (let i = 0; i < 4; i++) await recordAutoRecoveryAttempt(db, a, BREAKER, 1000)
    const res = await autoResumeInterruptedTasks({ db, breaker: BREAKER, resume: async () => {} })
    expect(res.resumed).not.toContain(a)
    expect(res.skipped).toContain(a)
    // clearing the quarantine makes it eligible again
    await clearAutoRecoverySuspension(db, a)
    const res2 = await autoResumeInterruptedTasks({ db, breaker: BREAKER, resume: async () => {} })
    expect(res2.resumed).toContain(a)
  })

  test('a throwing resume does not abort the loop and is not counted as resumed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const a = await seedTask(db, 'interrupted', 'daemon-restart')
    const b = await seedTask(db, 'interrupted', 'daemon-restart')
    const res = await autoResumeInterruptedTasks({
      db,
      breaker: BREAKER,
      resume: async (id) => {
        if (id === a) throw new Error('snapshot-lost')
      },
    })
    expect(res.resumed).toEqual([b])
    expect(res.skipped).toContain(a)
  })
})
