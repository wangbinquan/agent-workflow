// RFC-369 —— 「旧代被取代」改由读侧推导之后，原先锁「铸造同事务 abandon」的测试共用的两条断言面：
//   ① `derivedSupersededIds`：按生产 SQL 谓词列出该任务里**会被围栏 / 入口重放作用**的行
//      （结构性被取代 ∧ merge_state ∈ 可取代集）——等价于改前铸造那一刻会被翻成 abandoned 的集合；
//   ② `expectFencedToAbandoned`：对该行发一次在它当前状态下**本来合法**的迁移，断言被拦成非法迁移、
//      且 abandoned 确实落库（design §4.2：事务内收尾并提交，事务外才抛）。

import { expect } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { IllegalMergeStateTransition, type MergeStateTransitionEvent } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import { SUPERSEDABLE_MERGE_STATES } from '@/modules/task-execution/domain/nodeRunSupersession'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { structurallySupersededCondition } from '@/modules/task-execution/infrastructure/nodeRunSupersession'

export async function derivedSupersededIds(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        inArray(nodeRuns.mergeState, [...SUPERSEDABLE_MERGE_STATES]),
        structurallySupersededCondition(db),
      ),
    )
  return rows.map((row) => row.id).sort()
}

/** 每个可取代状态上一条本来合法的前进迁移——被拦下才说明是围栏在起作用、不是状态机本来就拒绝。 */
const LEGAL_FORWARD: Record<(typeof SUPERSEDABLE_MERGE_STATES)[number], MergeStateTransitionEvent> =
  {
    isolating: { kind: 'mark-pending-merge' },
    'pending-merge': { kind: 'mark-merged' },
    'conflict-human': { kind: 'complete-human-resolution' },
  }

export async function expectFencedToAbandoned(
  db: ProviderNeutralDatabase,
  nodeRunId: string,
): Promise<void> {
  const before = (
    await db
      .select({ mergeState: nodeRuns.mergeState })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
  )[0]!.mergeState as (typeof SUPERSEDABLE_MERGE_STATES)[number]
  const event = LEGAL_FORWARD[before]
  expect(event).toBeDefined()
  const failure = await new DrizzleMergeStateLifecyclePersistence(db)
    .transition({ nodeRunId, event })
    .then(
      () => null,
      (error: unknown) => error,
    )
  expect(failure).toBeInstanceOf(IllegalMergeStateTransition)
  expect(String((failure as Error).message)).toContain('RFC-369')
  const after = (
    await db
      .select({ mergeState: nodeRuns.mergeState })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
  )[0]!.mergeState
  expect(after).toBe('abandoned')
}
