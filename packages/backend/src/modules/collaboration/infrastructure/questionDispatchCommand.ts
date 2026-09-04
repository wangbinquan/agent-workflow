// RFC-359 W1-T2a（F-H2-1 之一）—— collaboration 的问题派发命令端口：一份实现，两个引擎。
//
// 此前只有 `createSqliteQuestionDispatchCommand`，且 PostgreSQL daemon 从未注入该端口，
// 路由一到 `requireQuestionDispatchCommand` 就 500。派发管线（`legacySqliteTaskQuestionDispatch.ts`）
// 已跑在 `DatabaseSession` 上，这里对两个 provider 都是同一段代码。
//
// 保留动态 import：命令端口由 bootstrap 一次性组合，静态 import 派发管线会经
// `services/humanGateComposition` 绕回 collaboration 的 composition barrel，形成值环。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  CollaborationCommandContext,
  QuestionDispatchCommandPort,
} from '@/modules/collaboration/public/types'
import type { TaskActorRole } from '@agent-workflow/shared'
import { createCollaborationCommandContext } from '../composition/commandContext'

export function createQuestionDispatchCommand(
  db: ProviderNeutralDatabase,
): QuestionDispatchCommandPort {
  return {
    async dispatch(command) {
      const { dispatchTaskQuestionsWithDecision } =
        await import('./legacySqliteTaskQuestionDispatch')
      const dispatched = await dispatchTaskQuestionsWithDecision(
        db,
        command.taskId,
        [...command.entryIds],
        { userId: command.actor.user.id, role: command.actorRole },
        {
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
      )
      return {
        taskId: dispatched.taskId,
        receipt: dispatched.receipt,
        reruns: dispatched.reruns,
        dispatchedEntryIds: dispatched.dispatchedEntryIds,
        deferred: dispatched.deferred,
      }
    },
  }
}

/** Legacy test bridge; production routes use the bootstrap-owned context. */
export function createQuestionDispatchCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
}): CollaborationCommandContext {
  return createCollaborationCommandContext({
    db: input.db,
    questionDispatches: createQuestionDispatchCommand(input.db),
  })
}
