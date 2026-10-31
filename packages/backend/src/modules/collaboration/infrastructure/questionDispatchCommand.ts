import type { CollaborationTaskRolePolicy } from '../application/ports/collaborationTaskRolePolicy'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { HumanGateTaskLockPort } from '../composition/required-ports'
// RFC-359 W1-T2a（F-H2-1 之一）—— collaboration 的问题派发命令端口：一份实现，两个引擎。
//
// 此前只有 `createSqliteQuestionDispatchCommand`，且 PostgreSQL daemon 从未注入该端口，
// 路由一到 `requireQuestionDispatchCommand` 就 500。派发管线（`taskQuestionDispatch.ts`）
// 已跑在 `DatabaseSession` 上，这里对两个 provider 都是同一段代码。
//
// 保留动态 import：命令端口由 bootstrap 一次性组合，静态 import 派发管线会经
// `services/humanGateComposition` 绕回 collaboration 的 composition barrel，形成值环。

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { QuestionDispatchCommandPort } from '@/modules/collaboration/application/ports/questionDispatchCommand'
import type { TaskActorRole } from '@agent-workflow/shared'
import { createCollaborationCommandContext } from '../composition/commandContext'

export function createQuestionDispatchCommand(
  db: PersistenceDb,
  taskLock: HumanGateTaskLockPort,
  options: { readonly historyRestrictions: HistoryRestrictionPort },
): QuestionDispatchCommandPort {
  return {
    async dispatch(command) {
      const { dispatchTaskQuestionsWithDecision } = await import('./taskQuestionDispatch')
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
        taskLock,
        { historyRestrictions: options?.historyRestrictions },
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
  readonly taskRolePolicy: CollaborationTaskRolePolicy
  readonly taskLock: HumanGateTaskLockPort
  readonly historyRestrictions: HistoryRestrictionPort
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
}): CollaborationCommandContext<'questionDispatches'> {
  return createCollaborationCommandContext({
    taskRolePolicy: input.taskRolePolicy,
    taskLock: input.taskLock,
    historyRestrictions: input.historyRestrictions,
    db: input.db,
    questionDispatches: createQuestionDispatchCommand(input.db, input.taskLock, {
      historyRestrictions: input.historyRestrictions,
    }),
  })
}
