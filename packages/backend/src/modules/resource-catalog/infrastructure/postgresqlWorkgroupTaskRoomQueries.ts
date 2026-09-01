import { and, asc, eq, inArray } from 'drizzle-orm'
import { workgroupAssignments, workgroupMessages, workgroupTaskState } from '@/db/schema'
import {
  deriveBudgetUsed,
  deriveMemberCurrentRuns,
  deriveWorkgroupRunHistory,
  parseStoredTemplateMetadata,
  roundedModeOf,
} from '../application/workgroups/workgroupRoomProjection'
import type { WorkgroupOperationContext } from '../public/participants'
import type { WorkgroupTaskRoomQueries } from '../public/queries'
import {
  document,
  loadVisibleTask,
  mentionIds,
  parseConfig,
  type WorkgroupTaskRoomTransactionRunner,
} from './postgresqlWorkgroupTaskRoom'

export function createPostgresqlWorkgroupTaskRoomQueries(
  withTransaction: WorkgroupTaskRoomTransactionRunner,
): WorkgroupTaskRoomQueries {
  async function pendingRows(authority: WorkgroupOperationContext) {
    return withTransaction(async (transaction, participant) => {
      const tasks = await participant.listVisibleActive(authority)
      const taskIds = tasks.map((task) => task.id)
      const states =
        taskIds.length === 0
          ? []
          : await transaction
              .select({
                taskId: workgroupTaskState.taskId,
                gateStatus: workgroupTaskState.gateStatus,
              })
              .from(workgroupTaskState)
              .where(inArray(workgroupTaskState.taskId, taskIds))
              .all()
      const cards =
        taskIds.length === 0
          ? []
          : await transaction
              .select({
                taskId: workgroupAssignments.taskId,
                assigneeMemberId: workgroupAssignments.assigneeMemberId,
              })
              .from(workgroupAssignments)
              .where(
                and(
                  inArray(workgroupAssignments.taskId, taskIds),
                  eq(workgroupAssignments.status, 'dispatched'),
                ),
              )
              .all()
      const gateByTask = new Map(states.map((state) => [state.taskId, state.gateStatus]))
      return tasks.flatMap((task) => {
        const parsed = parseConfig(task.workgroupConfigJson)
        if (task.workgroupId === null || parsed === null) return []
        const gateStatus = gateByTask.get(task.id) ?? null
        const awaitingConfirmation =
          gateStatus === 'awaiting_confirmation' && task.status === 'awaiting_review'
        const humanMemberIds = new Set(
          parsed.config.members
            .filter(
              (member) => member.memberType === 'human' && member.userId === authority.user.id,
            )
            .map((member) => member.id),
        )
        const pendingDeliveries = cards.filter(
          (card) =>
            card.taskId === task.id &&
            card.assigneeMemberId !== null &&
            humanMemberIds.has(card.assigneeMemberId),
        ).length
        return !awaitingConfirmation && pendingDeliveries === 0
          ? []
          : [
              {
                taskId: task.id,
                name: task.name,
                status: task.status,
                gateStatus,
                awaitingConfirmation,
                pendingDeliveries,
              },
            ]
      })
    })
  }

  const queries = Object.freeze<WorkgroupTaskRoomQueries>({
    async pendingCount(authority) {
      const rows = await pendingRows(authority)
      const gates = rows.filter((row) => row.awaitingConfirmation).length
      const deliveries = rows.reduce((sum, row) => sum + row.pendingDeliveries, 0)
      return document({ deliveries, gates, total: deliveries + gates })
    },
    async pending(authority) {
      return document({ items: await pendingRows(authority) })
    },
    async room(authority, input) {
      return withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const [messages, assignments, hostRuns, clarify] = await Promise.all([
          transaction
            .select()
            .from(workgroupMessages)
            .where(eq(workgroupMessages.taskId, input.taskId))
            .orderBy(asc(workgroupMessages.id))
            .all(),
          transaction
            .select()
            .from(workgroupAssignments)
            .where(eq(workgroupAssignments.taskId, input.taskId))
            .orderBy(asc(workgroupAssignments.id))
            .all(),
          participant.listHostRuns(input.taskId),
          participant.loadClarifyProjection(input.taskId),
        ])
        const assignmentLite = assignments.map((assignment) => ({
          id: assignment.id,
          assigneeMemberId: assignment.assigneeMemberId,
        }))
        const messageLite = messages.map((message) => ({
          id: message.id,
          mentionMemberIds: mentionIds(message.mentionsJson),
          authorMemberId: message.authorMemberId,
          round: message.round,
        }))
        const open = new Set(clarify.askingNodeRunIds)
        const runHistory = deriveWorkgroupRunHistory(
          loaded.config.members,
          loaded.config.leaderMemberId,
          hostRuns,
          assignmentLite,
          messageLite,
          { openClarifySourceRunIds: open },
        )
        const memberRuns = deriveMemberCurrentRuns(
          loaded.config.members,
          loaded.config.leaderMemberId,
          hostRuns,
          assignmentLite,
          messageLite,
          { openClarifySourceRunIds: open },
        )
        const rounded = roundedModeOf(loaded.config.mode)
        const gateStatus = loaded.state.gateStatus
        return document({
          taskId: input.taskId,
          taskStatus: loaded.task.status,
          config: loaded.config,
          clarifyStops: clarify.stopDirectives
            .filter((entry) => entry.directive === 'stop' && entry.shardKey !== '')
            .map((entry) => ({ nodeId: entry.nodeId, askerKey: entry.shardKey })),
          budgetUsed: rounded === null ? 0 : deriveBudgetUsed(rounded, hostRuns),
          pauseReason:
            loaded.task.status === 'awaiting_human' && loaded.state.pauseReason
              ? loaded.state.pauseReason
              : null,
          gate: {
            declaredDone:
              gateStatus === 'declared' ||
              gateStatus === 'awaiting_confirmation' ||
              gateStatus === 'approved',
            awaitingConfirmation: gateStatus === 'awaiting_confirmation',
            rejected: gateStatus === 'rejected',
            summary: loaded.state.gateSummary,
          },
          dw: loaded.state.dw,
          messages: messages.map((message) => {
            const template = parseStoredTemplateMetadata(
              message.templateKey,
              message.templateParamsJson,
            )
            return {
              id: message.id,
              round: rounded === 'free_collab' ? null : message.round,
              authorKind: message.authorKind,
              authorMemberId: message.authorMemberId,
              authorUserId: message.authorUserId,
              kind: message.kind,
              bodyMd: message.bodyMd,
              templateKey: template?.key ?? null,
              templateParams: template?.params ?? null,
              mentionMemberIds: mentionIds(message.mentionsJson),
              assignmentId: message.assignmentId,
              triggerMessageId: message.triggerMessageId,
              createdAt: message.createdAt,
            }
          }),
          assignments: assignments.map((assignment) => ({
            id: assignment.id,
            round: rounded === 'free_collab' ? null : assignment.round,
            source: assignment.source,
            createdByUserId: assignment.createdByUserId,
            assigneeMemberId: assignment.assigneeMemberId,
            title: assignment.title,
            briefMd: assignment.briefMd,
            status: assignment.status,
            nodeRunId: assignment.nodeRunId,
            resultMessageId: assignment.resultMessageId,
            createdAt: assignment.createdAt,
            updatedAt: assignment.updatedAt,
          })),
          memberRuns,
          runHistory,
        })
      })
    },
  })
  return queries
}
