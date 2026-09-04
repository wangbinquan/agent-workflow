// RFC-359 W1-T2a（F-H2-1 之一）—— 问题派发命令端口在两个引擎上各跑一遍。
//
// 此前 PostgreSQL daemon 从未注入 `questionDispatches`，路由一到 `requireQuestionDispatchCommand`
// 就 500（dual-provider-parity-audit F-H2-1）。现在 `createQuestionDispatchCommand` 对两个 provider
// 是同一段代码：决定 + 派发 + rerun 铸造 + receipt 同一事务，同 idempotencyKey 重放返回同一 receipt。

import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { collaborationGateOperations, nodeRuns } from '@/db/schema'
import { createQuestionDispatchCommand } from '@/modules/collaboration/infrastructure/questionDispatchCommand'
import { resetBroadcastersForTests } from '@/ws/broadcaster'
import { describeEachProvider } from './helpers/eachProvider'
import {
  DESIGNER,
  entryById,
  freshTaskId,
  insertEntry,
  mkQ,
  seedRound,
  seedRun,
  seedTask,
} from './helpers/questionDispatchFixture'

const actor = { user: { id: 'u1' } } as Parameters<
  ReturnType<typeof createQuestionDispatchCommand>['dispatch']
>[0]['actor']

describeEachProvider('RFC-359 T2a —— 问题派发命令端口', (harness) => {
  beforeEach(() => resetBroadcastersForTests())

  test('决定 + 派发 + rerun 铸造 + receipt 一起落地；同 key 重放返回同一 receipt', async () => {
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
    const command = createQuestionDispatchCommand(db)
    const first = await command.dispatch({
      actor,
      actorRole: 'owner',
      taskId,
      entryIds: [id],
      idempotencyKey: 'rfc359-t2a',
    })
    expect(first.taskId).toBe(taskId)
    expect(first.dispatchedEntryIds).toEqual([id])
    expect(first.reruns).toHaveLength(1)
    expect(first.receipt.replayed).toBe(false)
    expect((await entryById(db, id))!.dispatchedBy).toBe('u1')
    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (run) => run.rerunCause === 'cross-clarify-answer',
    )
    expect(minted).toHaveLength(1)
    const operations = await db
      .select({ state: collaborationGateOperations.state })
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.taskId, taskId))
    expect(operations.map((op) => op.state)).toContain('completed')

    const replay = await command.dispatch({
      actor,
      actorRole: 'owner',
      taskId,
      entryIds: [id],
      idempotencyKey: 'rfc359-t2a',
    })
    expect(replay.receipt.replayed).toBe(true)
    expect(replay.receipt.operationId).toBe(first.receipt.operationId)
    expect(replay.reruns.map((r) => r.nodeRunId)).toEqual(first.reruns.map((r) => r.nodeRunId))
    expect(
      (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (run) => run.rerunCause === 'cross-clarify-answer',
      ),
      '重放不得二次铸造',
    ).toHaveLength(1)
  })
})
