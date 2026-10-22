// RFC-368 T6 —— Reaction admission 日志的持久化实现（TaskExecution 拥有）。
//
// 只实现同模块 `application/ports/reactionAdmissionStore.ts` 那个端口，**不引数字员工的任何
// 类型**。两条守卫决定了这个形状：`rfc294-review-module-layer-rules` 禁止应用层直接依赖
// infrastructure（所以是端口 + 组合根注入，不是 application 直接 import 这里），
// `rfc359-w5-t19f` 禁止模块顶层捕获 schema 表列（所以列选择写在函数体内）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  ReactionAdmissionInsert,
  ReactionAdmissionRow,
  ReactionAdmissionStore,
} from '../application/ports/reactionAdmissionStore'

function rowColumns(db: object): {
  operationRef: PersistenceTables['reactionExecutionAdmissions']['operationRef']
  roundRef: PersistenceTables['reactionExecutionAdmissions']['roundRef']
  claimEpoch: PersistenceTables['reactionExecutionAdmissions']['claimEpoch']
  fenceRevision: PersistenceTables['reactionExecutionAdmissions']['fenceRevision']
  executionRef: PersistenceTables['reactionExecutionAdmissions']['executionRef']
  requestHash: PersistenceTables['reactionExecutionAdmissions']['requestHash']
  state: PersistenceTables['reactionExecutionAdmissions']['state']
} {
  const { reactionExecutionAdmissions } = tablesOf(db)
  return {
    operationRef: reactionExecutionAdmissions.operationRef,
    roundRef: reactionExecutionAdmissions.roundRef,
    claimEpoch: reactionExecutionAdmissions.claimEpoch,
    fenceRevision: reactionExecutionAdmissions.fenceRevision,
    executionRef: reactionExecutionAdmissions.executionRef,
    requestHash: reactionExecutionAdmissions.requestHash,
    state: reactionExecutionAdmissions.state,
  }
}

export function createReactionAdmissionStore(db: PersistenceDb): ReactionAdmissionStore {
  return Object.freeze({
    async find(operationRef: string): Promise<ReactionAdmissionRow | null> {
      const { reactionExecutionAdmissions } = tablesOf(db)
      const row = await first(
        db
          .select(rowColumns(db))
          .from(reactionExecutionAdmissions)
          .where(eq(reactionExecutionAdmissions.operationRef, operationRef)),
      )
      return row ?? null
    },

    async listByRound(roundRef: string): Promise<readonly ReactionAdmissionRow[]> {
      const { reactionExecutionAdmissions } = tablesOf(db)
      return await db
        .select(rowColumns(db))
        .from(reactionExecutionAdmissions)
        .where(eq(reactionExecutionAdmissions.roundRef, roundRef))
        .orderBy(reactionExecutionAdmissions.claimEpoch)
    },

    async insert(input: ReactionAdmissionInsert) {
      const { reactionExecutionAdmissions } = tablesOf(db)
      await insertOne(db, reactionExecutionAdmissions, {
        operationRef: input.operationRef,
        caseId: input.caseId,
        roundRef: input.roundRef,
        claimEpoch: input.claimEpoch,
        fenceRevision: input.fenceRevision,
        requestHash: input.requestHash,
        authoritySubject: input.authoritySubject,
        authorityRevision: input.authorityRevision,
        executionRef: input.executionRef,
        state: 'admitted',
        createdAt: input.now,
        updatedAt: input.now,
      })
    },

    async advanceFence(input: {
      readonly operationRef: string
      readonly claimEpoch: number
      readonly fenceRevision: number
      readonly now: number
    }) {
      const { reactionExecutionAdmissions } = tablesOf(db)
      await db
        .update(reactionExecutionAdmissions)
        .set({
          claimEpoch: input.claimEpoch,
          fenceRevision: input.fenceRevision,
          updatedAt: input.now,
        })
        .where(eq(reactionExecutionAdmissions.operationRef, input.operationRef))
    },

    async close(operationRef: string, now: number) {
      const { reactionExecutionAdmissions } = tablesOf(db)
      await db
        .update(reactionExecutionAdmissions)
        .set({ state: 'closed', updatedAt: now })
        .where(eq(reactionExecutionAdmissions.operationRef, operationRef))
    },

    async markLaunched(operationRef: string, now: number) {
      const { reactionExecutionAdmissions } = tablesOf(db)
      await db
        .update(reactionExecutionAdmissions)
        .set({ state: 'launched', updatedAt: now })
        .where(
          and(
            eq(reactionExecutionAdmissions.operationRef, operationRef),
            eq(reactionExecutionAdmissions.state, 'admitted'),
          ),
        )
    },
  })
}
