import {
  WorkgroupRuntimeConfigSchema,
  WorkgroupSchema,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  buildClarifyEdges,
  initialDwState,
  redactGitUrl,
  resolveWorkgroupOutputContract,
  type StartTask,
  type TaskCatalogVisibility,
  type TaskLaunchOrigin,
  type Workgroup,
  type WorkgroupRuntimeConfig,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  nodeRuns,
  taskCollaborators,
  taskExecutionIntents,
  taskRepos,
  taskSpaceNodes,
  tasks,
  users,
  workflows,
  workgroupTaskState,
} from '@/db/schema'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  assertTriggerPreflight,
  triggerSourceFromContext,
} from '@/services/execution/triggerPreflight'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  DefaultTaskDriveCoordinator,
  skipRepositoryPreparation,
} from '../application/drive/taskDriveCoordinator'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type {
  ChildExecutionLaunchOperations,
  ChildWorkflowLaunchRequest,
  ChildWorkgroupLaunchRequest,
} from '../application/ports/childExecutionLaunchOperations'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { TaskExecutionTopologyLogger } from '../application/ports/taskExecutionTopology'
import type { TaskExecutionModule } from '../composition'
import { sha256Hex } from '../domain/digest'
import { sourceTerminationRevivalError } from '../domain/sourceTermination'
import { createPostgresqlTaskDriverLifecyclePort } from './postgresqlTaskDriverLifecycle'
import {
  appendPostgresqlTaskCreatedTx,
  type PostgresqlTaskExecutionTransaction,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

// Wire-frozen task/workflow identities. TaskExecution repeats them here rather
// than importing Resource Catalog provider-private infrastructure.
const WORKGROUP_HOST_WORKFLOW_ID = '00000000000000WORKGROUP00'
const WG_LEADER_NODE_ID = '__wg_leader__'
const WG_MEMBER_NODE_ID = '__wg_member__'
const WG_CLARIFY_NODE_ID = '__wg_clarify__'

export interface PostgresqlChildWorkgroupLaunchResources {
  loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]>
  ensureHostWorkflow(): Promise<void>
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}

export interface PostgresqlChildExecutionLaunchDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly persistence: TaskExecutionPersistence
  readonly executionModule: TaskExecutionModule
  readonly finalizeWorkspace: (taskId: string) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
  readonly workgroup: PostgresqlChildWorkgroupLaunchResources
  readonly id?: () => string
  readonly now?: () => number
}

interface ChildLaunchSubject {
  readonly workflowId: string
  readonly workflowVersion: number
  readonly workflowSnapshotJson: string
  readonly workgroup: null | Readonly<{
    id: string
    config: WorkgroupRuntimeConfig
    dynamic: boolean
  }>
}

type ChildLaunchRequest = ChildWorkflowLaunchRequest | ChildWorkgroupLaunchRequest

interface ParentLaunchSnapshot {
  readonly id: string
  readonly status: string
  readonly ownerUserId: string | null
  readonly launchOrigin: TaskLaunchOrigin
  readonly catalogVisibility: TaskCatalogVisibility
  readonly rootTaskId: string | null
  readonly executionLineageId: string | null
  readonly lineageSlotPathJson: string | null
  readonly invocationDepth: number
  readonly triggerContextJson: string | null
  readonly sourceTerminationBinding: string | null
  readonly sourceTerminationLaunchRev: number | null
  readonly sourceTerminationFence: 'closed' | 'merged' | null
  readonly sourceTerminationEffectRev: number | null
  readonly gitUserName: string | null
  readonly gitUserEmail: string | null
  readonly repoGroupId: string | null
  readonly repoGroupName: string | null
}

interface ParentRunSnapshot {
  readonly taskId: string
  readonly status: string
  readonly childTaskId: string | null
  readonly continuationSlotKey: string | null
  readonly lineageSlotPathJson: string | null
  readonly operationGeneration: number
}

type LineageEntry = Readonly<{
  stableNodeKey: string
  frozenOccurrenceKey: string
  workflowRevision: number | null
}>

function parseLineage(raw: string | null, executionLineageId: string): readonly LineageEntry[] {
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw)
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof Reflect.get(entry, 'stableNodeKey') === 'string' &&
            typeof Reflect.get(entry, 'frozenOccurrenceKey') === 'string' &&
            (Reflect.get(entry, 'workflowRevision') === null ||
              typeof Reflect.get(entry, 'workflowRevision') === 'number'),
        )
      ) {
        return value.map((entry) => {
          const workflowRevision = Reflect.get(entry, 'workflowRevision')
          return {
            stableNodeKey: String(Reflect.get(entry, 'stableNodeKey')),
            frozenOccurrenceKey: String(Reflect.get(entry, 'frozenOccurrenceKey')),
            workflowRevision: typeof workflowRevision === 'number' ? workflowRevision : null,
          }
        })
      }
    } catch {
      // Historical malformed paths fall back to the lineage root, matching the
      // SQLite behavior while keeping the new child suffix deterministic.
    }
  }
  return [
    {
      stableNodeKey: 'task-root',
      frozenOccurrenceKey: executionLineageId,
      workflowRevision: null,
    },
  ]
}

function buildWorkgroupRuntimeConfig(group: Workgroup, goal: string): WorkgroupRuntimeConfig {
  return WorkgroupRuntimeConfigSchema.parse({
    workgroupId: group.id,
    workgroupName: group.name,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    leaderMemberId: group.leaderMemberId,
    switches: group.switches,
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget,
    fanOut: group.fanOut,
    instructions: group.instructions,
    goal,
    members: group.members.map((member) => ({
      id: member.id,
      memberType: member.memberType,
      agentName: member.agentName,
      agentId: member.agentId ?? null,
      userId: member.userId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })),
  })
}

function buildWorkgroupHostSnapshot(config: WorkgroupRuntimeConfig): WorkflowDefinition {
  const leader = config.members.find((member) => member.id === config.leaderMemberId)
  const firstAgent = config.members.find((member) => member.memberType === 'agent')
  const leaderAgentName = leader?.agentName ?? firstAgent?.agentName ?? 'workgroup-member'
  const memberAgentName = firstAgent?.agentName ?? 'workgroup-member'
  return WorkflowDefinitionSchema.parse({
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [
      { id: WG_LEADER_NODE_ID, kind: 'agent-single', agentName: leaderAgentName },
      { id: WG_MEMBER_NODE_ID, kind: 'agent-single', agentName: memberAgentName },
      { id: WG_CLARIFY_NODE_ID, kind: 'clarify', sessionMode: 'isolated' },
    ],
    edges: [
      ...buildClarifyEdges(WG_LEADER_NODE_ID, WG_CLARIFY_NODE_ID),
      ...buildClarifyEdges(WG_MEMBER_NODE_ID, WG_CLARIFY_NODE_ID),
    ],
  })
}

function prepareWorkflowSubject(
  request: ChildWorkflowLaunchRequest,
): Readonly<{ task: StartTask; subject: ChildLaunchSubject; collaborators: readonly string[] }> {
  const task = request.payload
  if (task.workflowId !== request.workflowId) {
    throw new ValidationError(
      'child-workflow-id-mismatch',
      `child payload workflow '${task.workflowId}' does not match frozen workflow '${request.workflowId}'`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(request.frozenSnapshotJson)
  } catch {
    throw new ValidationError('workflow-invalid', 'frozen child workflow is not valid JSON')
  }
  const definition = WorkflowDefinitionSchema.parse(raw)
  assertTriggerPreflight({
    root: definition,
    closureJson: request.refClosureJson,
    source: triggerSourceFromContext(request.runtime.triggerContext),
  })
  return {
    task,
    subject: {
      workflowId: request.workflowId,
      workflowVersion: request.frozenWorkflowVersion,
      workflowSnapshotJson: request.frozenSnapshotJson,
      workgroup: null,
    },
    collaborators: task.collaboratorUserIds ?? [],
  }
}

async function prepareWorkgroupSubject(
  dependencies: PostgresqlChildExecutionLaunchDependencies,
  request: ChildWorkgroupLaunchRequest,
): Promise<
  Readonly<{ task: StartTask; subject: ChildLaunchSubject; collaborators: readonly string[] }>
> {
  const group = WorkgroupSchema.parse(request.frozenGroup.group)
  if (group.id !== request.frozenGroup.id || group.version !== request.frozenGroup.version) {
    throw new ValidationError(
      'workgroup-frozen-identity-mismatch',
      'frozen workgroup identity does not match its closure envelope',
    )
  }
  const config = buildWorkgroupRuntimeConfig(group, request.goal)
  const agents = config.members.filter((member) => member.memberType === 'agent')
  const reasons: string[] = []
  if (agents.length === 0) reasons.push('no-agent-member')
  if (
    config.mode === 'leader_worker' &&
    !config.members.some((member) => member.id === config.leaderMemberId)
  ) {
    reasons.push('leader-missing')
  }
  if (reasons.length > 0) {
    throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', { reasons })
  }
  const agentIds = agents.flatMap((member) =>
    typeof member.agentId === 'string' && member.agentId.length > 0 ? [member.agentId] : [],
  )
  const existing = new Set(
    await dependencies.workgroup.loadExistingAgentIds([...new Set(agentIds)]),
  )
  const missing = agents.filter(
    (member) => typeof member.agentId !== 'string' || !existing.has(member.agentId),
  )
  if (missing.length > 0 || agentIds.length !== agents.length) {
    throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
      reasons: ['agent-missing'],
      missingAgentNames: [...new Set(missing.map((member) => member.displayName))],
    })
  }
  await dependencies.workgroup.integrity.assertUsable({ rootAgentIds: agentIds })
  await dependencies.workgroup.ensureHostWorkflow()

  const humanIds = config.members.flatMap((member) =>
    member.memberType === 'human' && typeof member.userId === 'string' && member.userId.length > 0
      ? [member.userId]
      : [],
  )
  const collaborators = [...new Set([...request.collaboratorUserIds, ...humanIds])]
  const dynamic = config.mode === 'dynamic_workflow'
  const snapshot = dynamic
    ? WorkflowDefinitionSchema.parse(buildDynamicWorkflowGenerateSnapshot())
    : buildWorkgroupHostSnapshot(config)
  const task: StartTask = {
    workflowId: WORKGROUP_HOST_WORKFLOW_ID,
    name: request.name,
    inputs: {},
    ...(collaborators.length === 0 ? {} : { collaboratorUserIds: collaborators }),
    ...(request.maxDurationMs === undefined ? {} : { maxDurationMs: request.maxDurationMs }),
    ...(request.maxTotalTokens === undefined ? {} : { maxTotalTokens: request.maxTotalTokens }),
    autoCommitPush: false,
  }
  return {
    task,
    subject: {
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workflowVersion: 1,
      workflowSnapshotJson: JSON.stringify(snapshot),
      workgroup: { id: group.id, config, dynamic },
    },
    collaborators,
  }
}

async function activeCollaborators(
  tx: PostgresqlTaskExecutionTransaction,
  ownerUserId: string | null,
  collaboratorUserIds: readonly string[],
): Promise<readonly string[]> {
  // Legacy/system-owned parents do not acquire user membership by launching a
  // child. This is the same ownership rule as the provider-neutral root mint.
  if (ownerUserId === null) return []
  const requested = [
    ...new Set([ownerUserId, ...collaboratorUserIds.filter((userId) => userId !== ownerUserId)]),
  ]
  if (requested.length === 0) return []
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, requested), eq(users.status, 'active')))
  const active = new Set(rows.map((row) => row.id))
  const missing = requested.find((userId) => !active.has(userId))
  if (missing !== undefined) {
    throw new ValidationError('invalid-collaborator', `referenced user '${missing}' is not active`)
  }
  return requested
}

function assertParentAdmission(
  request: ChildLaunchRequest,
  parent: ParentLaunchSnapshot,
  parentRun: ParentRunSnapshot,
): void {
  if (parent.status !== 'running') {
    throw new ConflictError(
      'parent-task-not-running',
      `parent task '${parent.id}' is '${parent.status}'; refusing to mint child`,
    )
  }
  const fence = sourceTerminationRevivalError(parent.sourceTerminationFence)
  if (fence !== null) throw new ConflictError(fence, fence)
  if (parentRun.taskId !== parent.id) {
    throw new ConflictError(
      'parent-node-run-task-mismatch',
      `node_run '${request.parentNodeRunId}' does not belong to parent task '${parent.id}'`,
    )
  }
  if (parentRun.status !== 'running') {
    throw new ConflictError(
      'parent-node-run-not-running',
      `parent node_run '${request.parentNodeRunId}' is '${parentRun.status}'`,
    )
  }
  if (parentRun.childTaskId !== request.materializedSpace.taskId) {
    throw new ConflictError(
      'child-task-reservation-mismatch',
      `parent node_run '${request.parentNodeRunId}' reserved a different child task`,
    )
  }
  if (request.invocationDepth !== parent.invocationDepth + 1) {
    throw new ConflictError(
      'child-invocation-depth-mismatch',
      `child depth ${request.invocationDepth} does not follow parent depth ${parent.invocationDepth}`,
    )
  }
  if (parent.ownerUserId !== null && request.actor.user.id !== parent.ownerUserId) {
    throw new ConflictError(
      'child-launch-actor-mismatch',
      `child launch actor does not match parent task '${parent.id}' owner`,
    )
  }
}

function createCoordinator(
  dependencies: PostgresqlChildExecutionLaunchDependencies,
  request: ChildLaunchRequest,
) {
  const lifecycle = createPostgresqlTaskDriverLifecyclePort({
    db: dependencies.db,
    module: dependencies.executionModule,
    persistence: dependencies.persistence,
    log: dependencies.log,
    finalizeWorkspace: dependencies.finalizeWorkspace,
  })
  return new DefaultTaskDriveCoordinator({
    runtime: resolveTaskDriveConfig(request.runtime.runConfig),
    lifecycle,
    repositoryPreparation: skipRepositoryPreparation,
    engineOrchestrator: {
      async drive(context) {
        await request.schedulerDriver.drive({
          taskId: context.taskId,
          appHome: context.runtime.appHome,
          ...context.runtime.runtime,
          signal: context.signal,
          executionContext: context.execution,
        })
      },
    },
    failureReporter: {
      async report({ taskId, execution, error }) {
        const occurredAt = (dependencies.now ?? Date.now)()
        await dependencies.persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'failed',
          allowedFrom: ['pending', 'running'],
          extra: {
            finishedAt: occurredAt,
            errorSummary: 'child task launch failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          executionContext: execution,
          now: occurredAt,
          reason: 'postgresql-child-launch',
        })
        await dependencies.persistence.intentTerminalization.terminalize({
          taskId,
          state: 'failed',
          failureCode: 'child-task-launch-failed',
          now: occurredAt,
          claimedOwnerEpoch: execution.token.epoch,
        })
      },
    },
  })
}

async function launchPreparedChild(
  dependencies: PostgresqlChildExecutionLaunchDependencies,
  request: ChildLaunchRequest,
  prepared: Readonly<{
    task: StartTask
    subject: ChildLaunchSubject
    collaborators: readonly string[]
  }>,
): Promise<void> {
  const space = request.materializedSpace
  if (
    space.spaceKind !== 'inherited' ||
    space.earlyError !== null ||
    space.repos.length === 0 ||
    space.cleanup.taskId !== space.taskId
  ) {
    throw new ValidationError(
      'child-materialized-space-invalid',
      'child execution requires an exact inherited workspace lease',
    )
  }
  const taskId = space.taskId
  const intentId = (dependencies.id ?? ulid)()
  const occurredAt = (dependencies.now ?? Date.now)()
  const primary = space.repos[0]
  if (primary === undefined) throw new Error('child-materialized-space-missing-primary-repo')

  const eventRef = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const parent = (
      await tx
        .select({
          id: tasks.id,
          status: tasks.status,
          ownerUserId: tasks.ownerUserId,
          launchOrigin: tasks.launchOrigin,
          catalogVisibility: tasks.catalogVisibility,
          rootTaskId: tasks.rootTaskId,
          executionLineageId: tasks.executionLineageId,
          lineageSlotPathJson: tasks.lineageSlotPathJson,
          invocationDepth: tasks.invocationDepth,
          triggerContextJson: tasks.triggerContextJson,
          sourceTerminationBinding: tasks.sourceTerminationBinding,
          sourceTerminationLaunchRev: tasks.sourceTerminationLaunchRev,
          sourceTerminationFence: tasks.sourceTerminationFence,
          sourceTerminationEffectRev: tasks.sourceTerminationEffectRev,
          gitUserName: tasks.gitUserName,
          gitUserEmail: tasks.gitUserEmail,
          repoGroupId: tasks.repoGroupId,
          repoGroupName: tasks.repoGroupName,
        })
        .from(tasks)
        .where(eq(tasks.id, request.parentTaskId))
        .limit(1)
    )[0]
    if (parent === undefined) {
      throw new NotFoundError(
        'parent-task-not-found',
        `parent task '${request.parentTaskId}' was not found`,
      )
    }
    const parentRun = (
      await tx
        .select({
          taskId: nodeRuns.taskId,
          status: nodeRuns.status,
          childTaskId: nodeRuns.childTaskId,
          continuationSlotKey: nodeRuns.continuationSlotKey,
          lineageSlotPathJson: nodeRuns.lineageSlotPathJson,
          operationGeneration: nodeRuns.operationGeneration,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, request.parentNodeRunId))
        .limit(1)
    )[0]
    if (parentRun === undefined) {
      throw new NotFoundError(
        'parent-node-run-not-found',
        `parent node_run '${request.parentNodeRunId}' was not found`,
      )
    }
    assertParentAdmission(request, parent, parentRun)
    if ((parent.gitUserName === null) !== (parent.gitUserEmail === null)) {
      throw new ConflictError(
        'git-identity-snapshot-invalid',
        `parent task '${parent.id}' has an incomplete Git identity snapshot`,
      )
    }
    const anchor = (
      await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.id, prepared.subject.workflowId))
        .limit(1)
    )[0]
    if (anchor === undefined) {
      throw new NotFoundError(
        'workflow-not-found',
        `workflow anchor '${prepared.subject.workflowId}' was not found`,
      )
    }

    const members = await activeCollaborators(tx, parent.ownerUserId, prepared.collaborators)
    const sourceTermination =
      parent.sourceTerminationBinding === null || parent.sourceTerminationLaunchRev === null
        ? null
        : {
            binding: parent.sourceTerminationBinding,
            launchRevision: parent.sourceTerminationLaunchRev,
            fence: parent.sourceTerminationFence,
            effectRevision: parent.sourceTerminationEffectRev,
          }
    const executionLineageId = parent.executionLineageId ?? parent.id
    const continuationSlotKey =
      parentRun.continuationSlotKey ?? `legacy-call:${request.parentNodeRunId}`
    const lineage = [
      ...parseLineage(
        parentRun.lineageSlotPathJson ?? parent.lineageSlotPathJson,
        executionLineageId,
      ),
      {
        stableNodeKey: 'child-task',
        frozenOccurrenceKey: continuationSlotKey,
        workflowRevision: prepared.subject.workflowVersion,
      },
    ] satisfies readonly LineageEntry[]
    const branch = space.branch === '' ? `agent-workflow/${taskId}` : space.branch

    await tx.insert(tasks).values({
      id: taskId,
      name: prepared.task.name,
      workflowId: prepared.subject.workflowId,
      workflowSnapshot: prepared.subject.workflowSnapshotJson,
      workflowVersion: prepared.subject.workflowVersion,
      repoPath: primary.repoPath,
      repoUrl: primary.repoUrl === null ? null : redactGitUrl(primary.repoUrl),
      cachedRepoId: primary.cachedRepoId,
      repoGroupId: parent.repoGroupId,
      repoGroupName: parent.repoGroupName,
      worktreePath: space.worktreePath,
      baseBranch: primary.baseBranch,
      branch,
      baseCommit: primary.baseCommit,
      status: 'pending',
      inputs: JSON.stringify(prepared.task.inputs),
      maxDurationMs: prepared.task.maxDurationMs ?? null,
      maxTotalTokens: prepared.task.maxTotalTokens ?? null,
      startedAt: occurredAt,
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      gitUserName: parent.gitUserName,
      gitUserEmail: parent.gitUserEmail,
      workingBranch: null,
      autoCommitPush: false,
      repoCount: Math.max(1, space.repos.length),
      ownerUserId: parent.ownerUserId,
      launchOrigin: parent.launchOrigin,
      catalogVisibility: parent.catalogVisibility,
      triggerContextJson: parent.triggerContextJson,
      sourceTerminationBinding: sourceTermination?.binding ?? null,
      sourceTerminationLaunchRev: sourceTermination?.launchRevision ?? null,
      sourceTerminationFence: sourceTermination?.fence ?? null,
      sourceTerminationEffectRev: sourceTermination?.effectRevision ?? null,
      workgroupId: prepared.subject.workgroup?.id ?? null,
      workgroupConfigJson:
        prepared.subject.workgroup === null
          ? null
          : JSON.stringify(prepared.subject.workgroup.config),
      spaceKind: 'inherited',
      parentTaskId: request.parentTaskId,
      parentNodeRunId: request.parentNodeRunId,
      invocationDepth: request.invocationDepth,
      refClosureJson: 'refClosureJson' in request ? request.refClosureJson : null,
      branchStartedAt: occurredAt,
      rootTaskId: parent.rootTaskId ?? parent.id,
      executionLineageId,
      lineageSlotPathJson: JSON.stringify(lineage),
    })
    await tx.insert(taskRepos).values(
      space.repos.map((repo) => ({
        taskId,
        repoIndex: repo.repoIndex,
        repoPath: repo.repoPath,
        repoUrl: repo.repoUrl === null ? null : redactGitUrl(repo.repoUrl),
        cachedRepoId: repo.cachedRepoId,
        baseBranch: repo.baseBranch,
        branch: repo.branch,
        workingBranch: null,
        baseCommit: repo.baseCommit,
        worktreePath: repo.worktreePath,
        worktreeDirName: repo.worktreeDirName,
        mountPath: repo.mountPath,
        subdir: repo.subdir,
        readonly: repo.readonly,
        workspaceProfileVersion: repo.workspaceProfileVersion ?? null,
        workspaceProfileDigest: repo.workspaceProfileDigest ?? null,
        hasSubmodules: repo.hasSubmodules,
        submoduleInitOk: repo.submoduleInitOk,
        submoduleInitError: repo.submoduleInitError,
      })),
    )
    if (space.nodePaths.length > 0) {
      await tx
        .insert(taskSpaceNodes)
        .values(space.nodePaths.map((nodePath) => ({ taskId, nodePath, schemaVersion: 1 })))
    }
    if (members.length > 0) {
      if (parent.ownerUserId === null) {
        throw new ConflictError(
          'child-collaborator-owner-missing',
          `parent task '${parent.id}' cannot stamp child collaborators without an owner`,
        )
      }
      const ownerUserId = parent.ownerUserId
      await tx.insert(taskCollaborators).values(
        members.map((userId) => {
          const role: 'owner' | 'collaborator' = userId === ownerUserId ? 'owner' : 'collaborator'
          return {
            taskId,
            userId,
            role,
            addedBy: ownerUserId,
            addedAt: occurredAt,
          }
        }),
      )
    }
    await tx.insert(taskExecutionIntents).values({
      id: intentId,
      taskId,
      kind: 'launch',
      state: 'pending',
      source: 'internal',
      requestHash: sha256Hex(
        JSON.stringify({
          kind: 'launch',
          taskId,
          workflowId: prepared.subject.workflowId,
          workflowVersion: prepared.subject.workflowVersion,
          continuationSlotKey,
          operationGeneration: parentRun.operationGeneration,
        }),
      ),
      payloadJson: JSON.stringify({ v: 1, workflowId: prepared.subject.workflowId }),
      executionLineageId,
      continuationSlotKey,
      slotPathJson: JSON.stringify(lineage),
      operationGeneration: parentRun.operationGeneration,
      expectedTaskRevision: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    if (prepared.subject.workgroup !== null) {
      await tx.insert(workgroupTaskState).values({
        taskId,
        gateStatus: 'idle',
        dwStateJson: prepared.subject.workgroup.dynamic ? JSON.stringify(initialDwState()) : null,
        updatedAt: occurredAt,
      })
    }

    let cursor: string | null = request.parentTaskId
    for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
      const row: Readonly<{ id: string; parentTaskId: string | null }> | undefined = (
        await tx
          .select({ id: tasks.id, parentTaskId: tasks.parentTaskId })
          .from(tasks)
          .where(eq(tasks.id, cursor))
          .limit(1)
      )[0]
      if (row === undefined) break
      await tx
        .update(tasks)
        .set({
          branchStartedAt: sql`GREATEST(COALESCE(${tasks.branchStartedAt}, 0), ${occurredAt})`,
        })
        .where(eq(tasks.id, row.id))
      cursor = row.parentTaskId
    }
    return await appendPostgresqlTaskCreatedTx(tx, {
      taskId,
      status: 'pending',
      errorSummary: null,
      occurredAt,
    })
  })

  space.cleanup.state = 'committed'
  await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
  await createCoordinator(dependencies, request).submit({
    taskId,
    intentId,
    completionMode: 'background',
  })
}

/** PostgreSQL-native child task mint and drive boundary. */
export function createPostgresqlChildExecutionLaunchOperations(
  dependencies: PostgresqlChildExecutionLaunchDependencies,
): ChildExecutionLaunchOperations {
  return Object.freeze({
    async launchWorkflow(request: ChildWorkflowLaunchRequest) {
      await launchPreparedChild(dependencies, request, prepareWorkflowSubject(request))
    },
    async launchWorkgroup(request: ChildWorkgroupLaunchRequest) {
      await launchPreparedChild(
        dependencies,
        request,
        await prepareWorkgroupSubject(dependencies, request),
      )
    },
  })
}
