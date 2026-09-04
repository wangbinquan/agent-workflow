// RFC-359 W1-T1（P0-7）—— 延迟提问的自动派发在两个引擎上各跑一遍。
//
// 这是 dual-provider-parity-audit-2026-09-04 里第一条被真机实证的 P0：PostgreSQL 上每个调度 tick
// 抛 `deferred-question-dispatcher-not-bound`，任务的 node_runs 永远是 0 行。派发管线现在跑在
// `DatabaseSession` 上（`legacySqliteTaskQuestionDispatch.ts`），`createTaskDagCollaborationOperations`
// 两个 provider 共用。场景移植自 `rfc140-one-click-dispatch-all.test.ts`（SQLite 黄金锁，仍保留）。

import { beforeEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { nodeRuns, taskQuestions, tasks } from '@/db/schema'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { dispatchTaskQuestions } from '@/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'
import {
  DESIGNER,
  DISPATCH_ACTOR as actor,
  entryById,
  freshTaskId,
  insertEntry,
  mkQ,
  seedMixedBatch,
  seedRound,
  seedRun,
  seedTask,
} from './helpers/questionDispatchFixture'

describeEachProvider('RFC-359 T1 —— 延迟提问自动派发（P0-7）', (harness) => {
  beforeEach(() => resetBroadcastersForTests())

  test('混批 defer 盖列 → 承接 rerun done 后 autoDispatch 补发（__system__）并铸造 rerun', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)
    const ops = createTaskDagCollaborationOperations(db)

    const res = await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect(res.dispatchedEntryIds).toEqual(selfIds)
    expect(res.deferred.map((d) => d.entryId).sort()).toEqual([...designerIds].sort())
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).not.toBeNull()
      expect(row.dispatchedAt).toBeNull()
    }
    // self continuation 仍 pending → in-flight gate 挡住补发（retryable，登记保留）。
    await ops.autoDispatchDeferredQuestions(taskId)
    expect((await entryById(db, designerIds[0]!))!.dispatchedAt).toBeNull()
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()

    const pending = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
      (r) => r.status === 'pending',
    )!
    expect(pending, 'dispatch 必须铸出 self continuation').toBeDefined()
    await db
      .update(taskQuestions)
      .set({ triggerRunId: pending.id })
      .where(inArray(taskQuestions.id, selfIds))
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, pending.id))
    await ops.autoDispatchDeferredQuestions(taskId)
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.dispatchedAt).not.toBeNull()
      expect(row.dispatchedBy).toBe('__system__')
    }
    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'cross-clarify-answer',
    )
    expect(minted, 'designer home 上铸出一条 cross-clarify-answer rerun').toHaveLength(1)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set())
  })

  test('越权防护：staged 未点发（无登记）不被自动下发', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1')])
    const id = await insertEntry(db, taskId, {
      originNodeRunId: cross.origin,
      questionId: 'dq1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(),
    })
    await createTaskDagCollaborationOperations(db).autoDispatchDeferredQuestions(taskId)
    expect((await entryById(db, id))!.dispatchedAt).toBeNull()
  })

  test('不可恢复 Conflict（task-terminal）→ 清登记 + 不再重试（回手动轨道）', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    const { selfIds, designerIds } = await seedMixedBatch(db, taskId)
    await dispatchTaskQuestions(db, taskId, [...selfIds, ...designerIds], actor)
    expect((await entryById(db, designerIds[0]!))!.autoDispatchDeferredAt).not.toBeNull()
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, taskId))
    await createTaskDagCollaborationOperations(db).autoDispatchDeferredQuestions(taskId)
    for (const id of designerIds) {
      const row = (await entryById(db, id))!
      expect(row.autoDispatchDeferredAt).toBeNull()
      expect(row.dispatchedAt).toBeNull()
      expect(row.stagedAt).not.toBeNull()
    }
  })

  test('park 投影：未派发的 designer 条目让其 home 停车；派发后释放', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { status: 'done', hasOutput: true })
    const cross = await seedRound(db, taskId, 'cross', [mkQ('dq1')])
    const id = await insertEntry(db, taskId, {
      originNodeRunId: cross.origin,
      questionId: 'dq1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(),
    })
    const ops = createTaskDagCollaborationOperations(db)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set([DESIGNER]))
    await dispatchTaskQuestions(db, taskId, [id], actor)
    expect(await ops.loadUndispatchedParkTargets(taskId)).toEqual(new Set())
  })
})
