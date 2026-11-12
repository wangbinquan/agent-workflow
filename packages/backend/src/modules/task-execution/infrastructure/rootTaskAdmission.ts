// RFC-486 (RFC-294 W4-E1 remainder): the root task admission adapter. It projects the launched task the way a stored read
// would (`projectLaunchedTask`), then writes the task, member, intent and workgroup rows and the created event in one
// serializable transaction — statements and order unchanged from the former `taskRouteLaunchOperations.ts`.

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  TaskSchema,
  isTaskWorkspaceUnbound,
  redactGitUrl,
  webhookTaskSourceLinkOf,
  type GitCommitIdentity,
  type Task,
  type TaskStartOptions,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { definitionAnchorId, projectTaskSubject } from '../domain/taskSubject'
import { createTaskCreationParticipantInTx } from './taskCreationParticipant'
import { decodeTaskRepositoryMount } from './taskRepositoryCodec'
import { projectStoredTaskRepositorySurface } from './taskRepositorySurface'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { ValidationError } from '@/util/errors'
import { sha256Hex } from '../domain/digest'
import { appendTaskCreatedCommittedEvent } from './taskLifecycleCommittedEvents'
import {
  withSerializableTaskExecution,
  type TaskExecutionTransaction,
} from './taskLifecycleTransaction'

import type { CommittedEventRef } from '@/platform/events/committed/types'
import type {
  RootLaunchMetadata,
  RootTaskAdmission,
  RootTaskAdmissionRequest,
  RootTaskLaunchSubject,
} from '../application/ports/rootTaskAdmission'
import type { TaskRoutePreparedWorkspace } from '../application/ports/taskRouteLaunch'

export function projectLaunchedTask(input: {
  readonly taskId: string
  readonly task: TaskStartOptions
  readonly subject: RootTaskLaunchSubject
  readonly workspace: TaskRoutePreparedWorkspace
  readonly gitCommitIdentity: GitCommitIdentity | null
  readonly inputs: Readonly<Record<string, string>>
  readonly startedAt: number
  readonly metadata: RootLaunchMetadata
  readonly digitalEmployeeCaseId: string | null
}): Task {
  const failed = input.workspace.earlyError !== null
  const branch =
    input.workspace.branch === ''
      ? (input.task.workingBranch ?? `agent-workflow/${input.taskId}`)
      : input.workspace.branch
  const repository = projectStoredTaskRepositorySurface(
    {
      ...input.workspace,
      id: input.taskId,
      branch,
      workingBranch: input.task.workingBranch ?? null,
    },
    input.workspace.repositories.map((repo) =>
      decodeTaskRepositoryMount({ ...repo, readonlyDirtyCount: null }),
    ),
    input.workspace.nodePaths,
    'redacted',
    'supplied',
  )
  return TaskSchema.parse({
    id: input.taskId,
    name: input.task.name,
    ...projectTaskSubject(input.subject.subject, input.subject.workflowName ?? null),
    workflowSnapshot: input.subject.workflowSnapshot,
    workflowVersion: input.subject.workflowVersion,
    repoPath: repository.repoPath,
    repoUrl: repository.repoUrl,
    cachedRepoId: repository.cachedRepoId,
    worktreePath: repository.worktreePath,
    workspaceState:
      failed && isTaskWorkspaceUnbound(input.workspace.worktreePath) ? 'pruned' : 'available',
    baseBranch: repository.baseBranch,
    branch: repository.branch,
    workingBranch: repository.workingBranch,
    autoCommitPush: input.task.autoCommitPush ?? false,
    baseCommit: repository.baseCommit,
    status: failed ? 'failed' : 'pending',
    inputs: { ...input.inputs },
    maxDurationMs: input.task.maxDurationMs ?? null,
    maxTotalTokens: input.task.maxTotalTokens ?? null,
    startedAt: input.startedAt,
    finishedAt: failed ? input.startedAt : null,
    errorSummary: failed
      ? `worktree creation failed: ${input.workspace.earlyError ?? 'unknown error'}`
      : null,
    errorMessage: input.workspace.earlyError,
    failedNodeId: null,
    expiresAt: null,
    deletedAt: null,
    schemaVersion: 1,
    gitUserName: input.gitCommitIdentity?.name ?? null,
    gitUserEmail: input.gitCommitIdentity?.email ?? null,
    repoCount: repository.repoCount,
    repos: repository.repos,
    spaceNodes: repository.spaceNodes,
    repoGroupId: repository.repoGroupId,
    repoGroupName: repository.repoGroupName,
    scheduledTaskId: input.metadata.scheduledTaskId,
    workgroupId: input.subject.workgroup?.id ?? null,
    workgroupName: input.subject.workgroup?.name ?? null,
    goal: input.subject.workgroup?.goal ?? null,
    sourceAgentId: input.subject.subject.kind === 'agent' ? input.subject.subject.sourceId : null,
    sourceAgentName:
      input.subject.subject.kind === 'agent' ? input.subject.subject.sourceName : null,
    spaceKind: input.workspace.spaceKind,
    parentTaskId: null,
    parentNodeRunId: null,
    invocationDepth: 0,
    codeRoundId: null,
    digitalEmployeeCaseId: input.digitalEmployeeCaseId,
    webhookSourceLink:
      input.metadata.triggerContext === null
        ? null
        : webhookTaskSourceLinkOf(input.metadata.triggerContext),
  })
}

async function activeTaskMembers(
  db: TaskExecutionTransaction,
  input: Readonly<{
    ownerUserId: string
    collaboratorUserIds: readonly string[]
  }>,
): Promise<readonly string[]> {
  const userIds = [...new Set([input.ownerUserId, ...input.collaboratorUserIds])]
  const { users } = tablesOf(db)
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
  const activeIds = new Set(rows.map((row) => row.id))
  const invalid = userIds.filter((userId) => !activeIds.has(userId))
  if (invalid.length > 0) {
    throw new ValidationError(
      'invalid-collaborator',
      `referenced user '${invalid[0] ?? ''}' is not active`,
    )
  }
  return userIds
}

export function createRootTaskAdmission(
  dependencies: Readonly<{ db: PersistenceDb }>,
): RootTaskAdmission {
  return Object.freeze({
    async admit(input: RootTaskAdmissionRequest) {
      const {
        taskId,
        intentId,
        refClosureJson,
        metadata,
        gitCommitIdentity,
        startedAt,
        preparedWorkspace,
        persistedInputs,
        guard,
      } = input
      const projection = projectLaunchedTask({
        taskId,
        task: input.task,
        subject: input.subject,
        workspace: preparedWorkspace,
        gitCommitIdentity,
        inputs: persistedInputs,
        startedAt,
        metadata,
        digitalEmployeeCaseId: input.internal?.digitalEmployeeLaunch?.caseId ?? null,
      })
      const failed = preparedWorkspace.earlyError !== null
      const errorSummary = failed
        ? `worktree creation failed: ${preparedWorkspace.earlyError ?? 'unknown error'}`
        : null
      const branch =
        preparedWorkspace.branch === ''
          ? (input.task.workingBranch ?? `agent-workflow/${taskId}`)
          : preparedWorkspace.branch
      const memberIds = [...new Set(input.task.collaboratorUserIds ?? [])]
      const eventRef = await withSerializableTaskExecution(dependencies.db, async (tx) => {
        await guard?.verifyCanCommit()
        guard?.assertCanCommit()
        const activeMembers = await activeTaskMembers(tx, {
          ownerUserId: input.actor.user.id,
          collaboratorUserIds: memberIds,
        })
        const workspaceLane = await preparedWorkspace.admit(tx)
        if (
          workspaceLane.kind === 'repository-preparation' &&
          !isTaskWorkspaceUnbound(preparedWorkspace.worktreePath)
        )
          throw new Error('repository-preparation-lane-already-materialized')
        const { taskCollaborators, taskExecutionIntents } = tablesOf(tx)
        const { workgroupTaskState } = tablesOf(tx)
        const { lineageSlotPathJson: slotPathJson } = await createTaskCreationParticipantInTx(
          tx,
        ).create({
          subject: input.subject.subject,
          core: {
            id: taskId,
            name: input.task.name,
            status: failed ? 'failed' : 'pending',
            startedAt,
            finishedAt: failed ? startedAt : null,
            errorSummary,
            errorMessage: preparedWorkspace.earlyError,
            ownerUserId: input.actor.user.id,
            catalogVisibility: input.internal?.catalogVisibility ?? 'public',
            workspacePrunedAt:
              failed && isTaskWorkspaceUnbound(preparedWorkspace.worktreePath) ? startedAt : null,
            branchStartedAt: startedAt,
          },
          definition: {
            // 入口已按 `subject.builtin` 规范化过排版，这里落的就是返回投影用的同一份。
            definitionOrigin: input.subject.builtin ? 'platform' : 'authored',
            workflowSnapshot: JSON.stringify(input.subject.workflowSnapshot),
            workflowVersion: input.subject.workflowVersion,
            inputs: JSON.stringify(persistedInputs),
            maxDurationMs: input.task.maxDurationMs ?? null,
            maxTotalTokens: input.task.maxTotalTokens ?? null,
            workgroupConfigJson:
              input.subject.workgroup === undefined
                ? null
                : JSON.stringify(input.subject.workgroup.config),
            refClosureJson,
          },
          launchContext: {
            scheduledTaskId: metadata.scheduledTaskId,
            webhookTriggerId: metadata.webhookTriggerId,
            webhookFireId: metadata.webhookFireId,
            eventSubscriptionId: metadata.eventSubscriptionId,
            eventDeliveryId: metadata.eventDeliveryId,
            triggerContextJson:
              metadata.triggerContext === null ? null : JSON.stringify(metadata.triggerContext),
            platformInputPathsJson:
              input.internal?.platformInputPaths === undefined ||
              input.internal.platformInputPaths.length === 0
                ? null
                : JSON.stringify(input.internal.platformInputPaths),
            sourceTerminationBinding: metadata.sourceTerminationSnapshot?.binding ?? null,
            sourceTerminationLaunchRev: metadata.sourceTerminationSnapshot?.launchRevision ?? null,
            sourceTerminationFence: metadata.sourceTerminationSnapshot?.fence ?? null,
            sourceTerminationEffectRev: metadata.sourceTerminationSnapshot?.effectRevision ?? null,
            digitalEmployeeRoundId: input.internal?.digitalEmployeeLaunch?.actionRunId ?? null,
            digitalEmployeeCaseId: input.internal?.digitalEmployeeLaunch?.caseId ?? null,
          },
          workspace: {
            repoPath: preparedWorkspace.repoPath,
            repoUrl:
              preparedWorkspace.repoUrl === null ? null : redactGitUrl(preparedWorkspace.repoUrl),
            cachedRepoId: preparedWorkspace.cachedRepoId,
            repoGroupId: preparedWorkspace.repoGroupId,
            repoGroupName: preparedWorkspace.repoGroupName,
            worktreePath: preparedWorkspace.worktreePath,
            baseBranch: preparedWorkspace.baseBranch,
            branch,
            baseCommit: preparedWorkspace.baseCommit,
            gitUserName: gitCommitIdentity?.name ?? null,
            gitUserEmail: gitCommitIdentity?.email ?? null,
            workingBranch: input.task.workingBranch ?? null,
            autoCommitPush: input.task.autoCommitPush ?? false,
            spaceKind: preparedWorkspace.spaceKind,
          },
          launch: { kind: 'root', launchOrigin: metadata.launchOrigin },
          repos: preparedWorkspace.repositories.map((repo) =>
            decodeTaskRepositoryMount({ ...repo, readonlyDirtyCount: null }),
          ),
          nodePaths: preparedWorkspace.nodePaths,
        })
        await tx.insert(taskCollaborators).values(
          activeMembers.map((userId) => {
            const role: 'owner' | 'collaborator' =
              userId === input.actor.user.id ? 'owner' : 'collaborator'
            return { taskId, userId, role, addedBy: input.actor.user.id, addedAt: startedAt }
          }),
        )
        await insertOne(tx, taskExecutionIntents, {
          id: intentId,
          taskId,
          kind: 'launch',
          state: failed ? 'failed' : 'pending',
          source: metadata.intentSource,
          requestHash: sha256Hex(
            JSON.stringify({
              kind: 'launch',
              taskId,
              workflowId: definitionAnchorId(input.subject.subject),
              workflowVersion: input.subject.workflowVersion,
              continuationSlotKey: 'task-root',
              operationGeneration: 0,
            }),
          ),
          payloadJson: JSON.stringify({
            v: 1,
            workflowId: definitionAnchorId(input.subject.subject),
          }),
          executionLineageId: taskId,
          continuationSlotKey: 'task-root',
          slotPathJson,
          operationGeneration: 0,
          expectedTaskRevision: 1,
          failureCode: failed ? 'launch-materialization-failed' : null,
          createdAt: startedAt,
          completedAt: failed ? startedAt : null,
          updatedAt: startedAt,
        })
        if (input.subject.workgroup !== undefined) {
          await tx
            .update(workgroupTaskState)
            .set({
              gateStatus: 'idle',
              dwStateJson:
                input.subject.workgroup.dynamicState === null
                  ? null
                  : JSON.stringify(input.subject.workgroup.dynamicState),
              updatedAt: startedAt,
            })
            .where(eq(workgroupTaskState.taskId, taskId))
        }
        return await appendTaskCreatedCommittedEvent(tx, {
          taskId,
          status: failed ? 'failed' : 'pending',
          errorSummary,
          occurredAt: startedAt,
        })
      })
      return { eventRef, projection }
    },
    async publishAfterCommit(eventRef: CommittedEventRef | null) {
      return await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
    },
  })
}
