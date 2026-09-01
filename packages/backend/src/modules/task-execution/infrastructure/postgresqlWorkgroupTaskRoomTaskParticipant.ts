// RFC-349 — TaskExecution-owned half of Resource Catalog task-room atoms.

import {
  CANCELABLE_TASK_STATUSES,
  type FailureCode,
  type NodeRunStatus,
  type TaskStatus,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import { nodeRuns, taskCollaborators, tasks } from '@/db/schema'
import type {
  WorkgroupTaskRoomClarifyParticipantInTx,
  WorkgroupTaskRoomHolderClose,
  WorkgroupTaskRoomHostRunSnapshot,
  WorkgroupTaskRoomTaskParticipantInTx,
  WorkgroupTaskRoomTaskSnapshot,
} from '../public/commands'
import { createPostgresqlTaskAuthorizationParticipantInTx } from './postgresqlTaskAuthorization'
import { createPostgresqlNodeRunLifecycleParticipantInTx } from './postgresqlNodeRunLifecyclePersistence'
import { submitPostgresqlTaskContinuationTx } from './postgresqlTaskExecutionIntentPersistence'
import { terminalizePostgresqlTaskExecutionIntentsTx } from './postgresqlTaskExecutionIntentTerminalPersistence'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  assertPostgresqlTaskOwnerlessTx,
  type PostgresqlTaskExecutionTransaction,
} from './postgresqlTaskLifecycleTransaction'

const HOST_NODE_IDS = ['__wg_leader__', '__wg_member__'] as const

function taskSnapshot(
  row: Omit<WorkgroupTaskRoomTaskSnapshot, 'status'> & { readonly status: string },
): WorkgroupTaskRoomTaskSnapshot {
  return Object.freeze({ ...row, status: row.status as TaskStatus })
}

function hostRunSnapshot(
  row: Omit<WorkgroupTaskRoomHostRunSnapshot, 'status' | 'failureCode'> & {
    readonly status: string
    readonly failureCode: string | null
  },
): WorkgroupTaskRoomHostRunSnapshot {
  return Object.freeze({
    ...row,
    status: row.status as NodeRunStatus,
    failureCode: row.failureCode as FailureCode | null,
  })
}

const taskProjection = {
  id: tasks.id,
  name: tasks.name,
  ownerUserId: tasks.ownerUserId,
  status: tasks.status,
  workgroupId: tasks.workgroupId,
  workgroupConfigJson: tasks.workgroupConfigJson,
  workflowSnapshot: tasks.workflowSnapshot,
  triggerContextJson: tasks.triggerContextJson,
}

async function closeHolders(
  tx: PostgresqlTaskExecutionTransaction,
  taskId: string,
  close: WorkgroupTaskRoomHolderClose | undefined,
  occurredAt: number,
): Promise<readonly { readonly id: string; readonly nodeId: string }[]> {
  if (close === undefined) return []
  return await tx
    .update(nodeRuns)
    .set({ status: 'done', finishedAt: occurredAt, errorMessage: null })
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.rerunCause, close.rerunCause),
        eq(nodeRuns.status, 'awaiting_review'),
      ),
    )
    .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
}

export function createPostgresqlWorkgroupTaskRoomTaskParticipantInTx(
  tx: PostgresqlTaskExecutionTransaction,
  clarify: WorkgroupTaskRoomClarifyParticipantInTx,
): WorkgroupTaskRoomTaskParticipantInTx {
  const authorization = createPostgresqlTaskAuthorizationParticipantInTx(tx)

  function authorizationSubject(
    authority: Parameters<WorkgroupTaskRoomTaskParticipantInTx['loadVisible']>[0],
  ) {
    return Object.freeze({
      userId: authority.userId,
      canReadAllTasks: authority.permissions.has('tasks:read:all'),
    })
  }

  async function listActive(): Promise<readonly WorkgroupTaskRoomTaskSnapshot[]> {
    const rows = await tx
      .select(taskProjection)
      .from(tasks)
      .where(
        and(isNotNull(tasks.workgroupId), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES])),
      )
    return Object.freeze(rows.map(taskSnapshot))
  }

  return Object.freeze({
    async load(taskId: string) {
      const row = (
        await tx.select(taskProjection).from(tasks).where(eq(tasks.id, taskId)).limit(1)
      )[0]
      return row === undefined ? null : taskSnapshot(row)
    },
    async loadVisible(
      authority: Parameters<WorkgroupTaskRoomTaskParticipantInTx['loadVisible']>[0],
      taskId: string,
    ) {
      const visible = await authorization.canViewTask({
        subject: authorizationSubject(authority),
        taskId,
      })
      if (!visible) return null
      const row = (
        await tx.select(taskProjection).from(tasks).where(eq(tasks.id, taskId)).limit(1)
      )[0]
      return row === undefined ? null : taskSnapshot(row)
    },
    listActive,
    async listVisibleActive(
      authority: Parameters<WorkgroupTaskRoomTaskParticipantInTx['listVisibleActive']>[0],
    ) {
      const active = await listActive()
      const visible = await authorization.visibleTaskIds({
        subject: authorizationSubject(authority),
        taskIds: active.map((task) => task.id),
      })
      return Object.freeze(active.filter((task) => visible.has(task.id)))
    },
    async loadClarifyProjection(taskId: string) {
      return await clarify.loadProjection(taskId)
    },
    async listHostRuns(taskId: string) {
      const rows = await tx
        .select({
          id: nodeRuns.id,
          nodeId: nodeRuns.nodeId,
          shardKey: nodeRuns.shardKey,
          status: nodeRuns.status,
          rerunCause: nodeRuns.rerunCause,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
          failureCode: nodeRuns.failureCode,
          agentOverrideName: nodeRuns.agentOverrideName,
          agentOverrideId: nodeRuns.agentOverrideId,
          wgRound: nodeRuns.wgRound,
        })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), inArray(nodeRuns.nodeId, [...HOST_NODE_IDS])))
      return Object.freeze(rows.map(hostRunSnapshot))
    },
    async replaceConfig(
      input: Parameters<WorkgroupTaskRoomTaskParticipantInTx['replaceConfig']>[0],
    ) {
      const changed = await tx
        .update(tasks)
        .set({ workgroupConfigJson: input.nextConfigJson })
        .where(
          and(eq(tasks.id, input.taskId), eq(tasks.workgroupConfigJson, input.expectedConfigJson)),
        )
        .returning({ id: tasks.id })
      if (changed[0] === undefined) return false
      if (input.newCollaborators.length > 0) {
        await tx
          .insert(taskCollaborators)
          .values(
            input.newCollaborators.map((collaborator) => ({
              taskId: input.taskId,
              userId: collaborator.userId,
              role: 'collaborator' as const,
              addedBy: collaborator.addedBy,
              addedAt: collaborator.addedAt,
            })),
          )
          .onConflictDoNothing()
      }
      return true
    },
    async dismissOpenClarifyParksForAutonomous(
      input: Parameters<
        WorkgroupTaskRoomTaskParticipantInTx['dismissOpenClarifyParksForAutonomous']
      >[0],
    ) {
      const dismissed = await clarify.dismissOpenSelfClarifies(input)
      const canceledParkRuns: Array<{ nodeRunId: string; nodeId: string }> = []
      const assignmentShardKeys = new Set<string>()
      for (const park of dismissed.parks) {
        const parked = (
          await tx
            .select({ status: nodeRuns.status })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.id, park.nodeRunId), eq(nodeRuns.taskId, input.taskId)))
            .limit(1)
        )[0]
        if (parked?.status === 'awaiting_human') {
          await createPostgresqlNodeRunLifecycleParticipantInTx(tx).set({
            nodeRunId: park.nodeRunId,
            to: 'canceled',
            allowedFrom: ['awaiting_human'],
            extra: {
              finishedAt: input.occurredAt,
              errorMessage: 'wg-clarify-disabled',
            },
            reason: 'wg-clarify-disabled',
          })
          canceledParkRuns.push({ nodeRunId: park.nodeRunId, nodeId: park.nodeId })
        }
        if (park.assignmentShardKey !== null) assignmentShardKeys.add(park.assignmentShardKey)
      }
      return Object.freeze({
        dismissedSessions: dismissed.dismissedSessions,
        canceledParkRuns: Object.freeze(canceledParkRuns),
        assignmentShardKeys: Object.freeze([...assignmentShardKeys]),
      })
    },
    async continueTask(input: Parameters<WorkgroupTaskRoomTaskParticipantInTx['continueTask']>[0]) {
      await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
      const task = (
        await tx
          .select({ status: tasks.status, lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
      )[0]
      if (task === undefined || task.status !== input.expectedStatus) return null
      const closed = await closeHolders(tx, input.taskId, input.closeHolder, input.occurredAt)
      const nextRevision = task.lifecycleEventRevision + 1
      const changed = await tx
        .update(tasks)
        .set({
          status: 'pending',
          finishedAt: null,
          errorSummary: null,
          errorMessage: null,
          failedNodeId: null,
          lifecycleEventRevision: nextRevision,
          ...(input.workflowSnapshot === undefined
            ? {}
            : { workflowSnapshot: input.workflowSnapshot }),
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, input.expectedStatus),
            eq(tasks.lifecycleEventRevision, task.lifecycleEventRevision),
          ),
        )
        .returning({ id: tasks.id })
      if (changed[0] === undefined) return null
      const intentId = ulid()
      await submitPostgresqlTaskContinuationTx(tx, {
        taskId: input.taskId,
        intentId,
        kind: 'resume',
        source: 'rest',
        actorUserId: input.actorUserId,
        payload: { v: 1, event: 'resume', source: 'workgroup-task-room' },
        now: input.occurredAt,
        advanceOperationGeneration: true,
      })
      const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
        taskId: input.taskId,
        lifecycleRevision: nextRevision,
        previousStatus: input.expectedStatus,
        status: 'pending',
        errorSummary: null,
        nodeChanges: closed.map((holder) => ({
          nodeRunId: holder.id,
          nodeId: holder.nodeId,
          status: 'done',
          cause: input.closeHolder?.reason ?? 'workgroup-task-room-continued',
        })),
        occurredAt: input.occurredAt,
        identity: input.identity,
      })
      return Object.freeze({
        intentId,
        closedHolderIds: Object.freeze(closed.map((holder) => holder.id)),
        eventRef,
      })
    },
    async failTask(input: Parameters<WorkgroupTaskRoomTaskParticipantInTx['failTask']>[0]) {
      await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
      const task = (
        await tx
          .select({ status: tasks.status, lifecycleEventRevision: tasks.lifecycleEventRevision })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
      )[0]
      if (task === undefined || task.status !== input.expectedStatus) return null
      const closed = await closeHolders(tx, input.taskId, input.closeHolder, input.occurredAt)
      const nextRevision = task.lifecycleEventRevision + 1
      const changed = await tx
        .update(tasks)
        .set({
          status: 'failed',
          finishedAt: input.occurredAt,
          errorSummary: input.errorSummary,
          errorMessage: input.errorMessage,
          lifecycleEventRevision: nextRevision,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, input.expectedStatus),
            eq(tasks.lifecycleEventRevision, task.lifecycleEventRevision),
          ),
        )
        .returning({ id: tasks.id })
      if (changed[0] === undefined) return null
      await terminalizePostgresqlTaskExecutionIntentsTx(tx, {
        taskId: input.taskId,
        state: 'failed',
        failureCode: input.errorSummary,
        now: input.occurredAt,
      })
      const eventRef = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
        taskId: input.taskId,
        lifecycleRevision: nextRevision,
        previousStatus: input.expectedStatus,
        status: 'failed',
        errorSummary: input.errorSummary,
        nodeChanges: closed.map((holder) => ({
          nodeRunId: holder.id,
          nodeId: holder.nodeId,
          status: 'done',
          cause: input.closeHolder?.reason ?? 'workgroup-task-room-failed',
        })),
        occurredAt: input.occurredAt,
        identity: input.identity,
      })
      return Object.freeze({
        closedHolderIds: Object.freeze(closed.map((holder) => holder.id)),
        eventRef,
      })
    },
  })
}
