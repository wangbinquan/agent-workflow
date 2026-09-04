// RFC-359 W1-T2b（F-H2-1 之二）—— collaboration 的快速澄清决定命令端口：一份实现，两个引擎。
//
// 此前只有 `createSqliteClarifyDecisionCommand`（`legacySqliteClarifyDecisionComposition.ts`），
// PostgreSQL daemon 从未注入该端口，路由一到 `clarifyDecisions` 就 500。决定链路
// （seal → clarify decision participant → autoDispatch）现在跑在 `DatabaseSession` 上，
// 这里对两个 provider 是同一段代码。
//
// 保留动态 import：命令端口由 bootstrap 一次性组合，静态 import autoDispatch 会经
// `services/humanGateComposition` 绕回 collaboration 的 composition barrel，形成值环。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  ClarifyDecisionCommandPort,
  CollaborationCommandContext,
} from '@/modules/collaboration/public/types'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type { TaskActorRole } from '@agent-workflow/shared'
import { createCollaborationCommandContext } from '../composition/commandContext'

export function createClarifyDecisionCommand(
  db: ProviderNeutralDatabase,
  memoryDistillEnqueuer: MemoryDistillEnqueuer,
): ClarifyDecisionCommandPort {
  return {
    async submit(command) {
      const { autoDispatchClarifyRoundWithDecision } =
        await import('./legacySqliteClarify/autoDispatch')
      const decided = await autoDispatchClarifyRoundWithDecision({
        db,
        originNodeRunId: command.nodeRunId,
        answers: [...command.answers],
        directive: command.directive,
        actor: { userId: command.actor.user.id, role: command.actorRole },
        memoryDistillEnqueuer,
        ...(command.ifMatchIteration === undefined
          ? {}
          : { ifMatchIteration: command.ifMatchIteration }),
        decision: {
          ...(command.expectedTaskRevision === undefined
            ? {}
            : { expectedTaskRevision: command.expectedTaskRevision }),
          ...(command.expectedGateRevision === undefined
            ? {}
            : { expectedGateRevision: command.expectedGateRevision }),
          ...(command.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: command.idempotencyKey }),
        },
      })
      return {
        taskId: decided.taskId,
        roundKind: decided.kind,
        sealedQuestionIds: decided.sealedQuestionIds,
        roundFullySealed: decided.roundFullySealed,
        receipt: decided.receipt,
        reruns: decided.dispatch.reruns,
        dispatchedEntryIds: decided.dispatch.dispatchedEntryIds,
        deferred: decided.dispatch.deferred,
        ...(decided.dispatchDeferredReason === undefined
          ? {}
          : { dispatchDeferredReason: decided.dispatchDeferredReason }),
      }
    },
  }
}

/** Legacy test bridge; production routes use the bootstrap-owned context. */
export function createClarifyDecisionCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}): CollaborationCommandContext {
  return createCollaborationCommandContext({
    db: input.db,
    clarifyDecisions: createClarifyDecisionCommand(input.db, input.memoryDistillEnqueuer),
  })
}
