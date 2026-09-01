import {
  UPLOAD_INPUTS_DIR,
  StartTaskSchema,
  TaskSchema,
  WorkgroupRuntimeConfigSchema,
  applySpaceFields,
  buildClarifyEdges,
  initialDwState,
  migrateWorkflowDefinitionToLatest,
  redactGitUrl,
  resolveWorkgroupOutputContract,
  type Agent,
  type GitCommitIdentity,
  type PlannedDirectoryNode,
  type StartAgentTask,
  type StartTask,
  type StartWorkgroupTask,
  type Task,
  type TaskCatalogVisibility,
  type TaskLaunchOrigin,
  type TaskRepo,
  type TriggerContext,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type Workgroup,
  type WorkgroupRuntimeConfig,
  WORKFLOW_SCHEMA_VERSION,
  webhookTaskSourceLinkOf,
  workgroupLaunchReadiness,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import {
  taskCollaborators,
  taskExecutionIntents,
  taskRepos,
  taskSpaceNodes,
  tasks,
  users,
  workgroupTaskState,
} from '@/db/schema'
import type { AgentLaunchResourceIntegrityParticipant } from '@/modules/resource-catalog/public/participants'
import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/mrTerminalControl'
import type { SourceTerminationSnapshot } from '../public/types'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { acquireAgentLaunch, releaseAgentLaunch } from '@/services/agentLaunchReservation'
import {
  AGENT_HOST_INPUT_KEY,
  AGENT_HOST_WORKFLOW_ID,
  AGENT_HOST_WORKFLOW_NAME,
  buildAgentHostSnapshot,
  validateAgentLaunchShape,
} from '@/services/agentLaunch'
import {
  attachWorkspaceCleanupToMultipartError,
  bufferUploadParts,
  collectUploadInputDefs,
  resolveUploadLimits,
} from '@/services/launchMultipart'
import { buildDynamicWorkflowGenerateSnapshot } from '@/services/orchestratorAgent'
import {
  assertTriggerPreflight,
  triggerSourceFromContext,
} from '@/services/execution/triggerPreflight'
import { assertNotBuiltin } from '@/services/systemResources'
import type { WorkspaceCleanupReport } from '@/services/task'
import { applyUploadsToWorktree, validateUploadPlan } from '@/services/upload'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import type { AgentLaunchResourceOperations } from '../application/ports/agentLaunchResourceOperations'
import type { TaskDriveCoordinator } from '../application/drive/taskDriveTypes'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import { sha256Hex } from '../domain/digest'
import type { TaskExecutionIntentSource } from '../domain/executionIntent'
import {
  deriveTaskLaunchOrigin,
  taskLaunchAdmissionIssue,
  type TaskLaunchProvenance,
} from '../domain/taskLaunchOrigin'
import { directTaskInitiatorFromActorSource } from '../inbound/directTaskInitiator'
import type {
  AgentRouteTaskLaunchOperations,
  ExecutionInvoker,
  TaskRouteMultipartFilePart,
  WorkgroupRouteTaskLaunchOperations,
} from '../public/commands'
import { createPostgresqlTaskAuthorizationQueries } from './postgresqlTaskAuthorization'
import {
  appendPostgresqlTaskCreatedTx,
  type PostgresqlTaskExecutionTransaction,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

// These values are wire-frozen in task snapshots and node-run identities. They
// are repeated here deliberately: TaskExecution must not import Resource
// Catalog provider-private workgroup infrastructure merely to launch a task.
const WORKGROUP_HOST_WORKFLOW_ID = '00000000000000WORKGROUP00'
const WORKGROUP_HOST_WORKFLOW_NAME = '__workgroup_host__'
const WG_LEADER_NODE_ID = '__wg_leader__'
const WG_MEMBER_NODE_ID = '__wg_member__'
const WG_CLARIFY_NODE_ID = '__wg_clarify__'

interface RootLaunchMetadata {
  readonly provenance: TaskLaunchProvenance
  readonly launchOrigin: TaskLaunchOrigin
  readonly intentSource: TaskExecutionIntentSource
  readonly scheduledTaskId: string | null
  readonly webhookTriggerId: string | null
  readonly webhookFireId: string | null
  readonly eventSubscriptionId: string | null
  readonly eventDeliveryId: string | null
  readonly triggerContext: TriggerContext | null
  readonly sourceTerminationSnapshot: SourceTerminationSnapshot | null
}

function rootLaunchMetadata(actor: Actor, invoker: ExecutionInvoker): RootLaunchMetadata {
  if (invoker.type === 'node') {
    throw new ValidationError(
      'execution-invoker-unsupported',
      'root task launch does not accept a node invoker',
    )
  }
  const provenance: TaskLaunchProvenance =
    invoker.type === 'user'
      ? {
          kind: invoker.launchKind,
          initiator: directTaskInitiatorFromActorSource(actor.source),
        }
      : invoker.type === 'scheduled'
        ? { kind: 'schedule' }
        : invoker.type === 'event'
          ? { kind: 'event' }
          : { kind: 'webhook' }
  const triggerContext =
    invoker.type === 'event' || invoker.type === 'webhook' ? invoker.triggerContext : null
  const metadata: RootLaunchMetadata = {
    provenance,
    launchOrigin: deriveTaskLaunchOrigin(provenance),
    intentSource: invoker.type === 'user' ? 'rest' : 'scheduler',
    scheduledTaskId: invoker.type === 'scheduled' ? invoker.scheduledTaskId : null,
    webhookTriggerId: invoker.type === 'webhook' ? invoker.webhookTriggerId : null,
    webhookFireId: invoker.type === 'webhook' ? invoker.webhookFireId : null,
    eventSubscriptionId: invoker.type === 'event' ? invoker.eventSubscriptionId : null,
    eventDeliveryId: invoker.type === 'event' ? invoker.eventDeliveryId : null,
    triggerContext,
    sourceTerminationSnapshot:
      invoker.type === 'event' || invoker.type === 'webhook'
        ? (invoker.sourceTerminationSnapshot ?? null)
        : null,
  }
  const issue = taskLaunchAdmissionIssue(provenance, {
    ...(metadata.scheduledTaskId === null ? {} : { scheduledTaskId: metadata.scheduledTaskId }),
    ...(metadata.webhookTriggerId === null ? {} : { webhookTriggerId: metadata.webhookTriggerId }),
    ...(metadata.webhookFireId === null ? {} : { webhookFireId: metadata.webhookFireId }),
    ...(metadata.eventSubscriptionId === null
      ? {}
      : { eventSubscriptionId: metadata.eventSubscriptionId }),
    ...(metadata.eventDeliveryId === null ? {} : { eventDeliveryId: metadata.eventDeliveryId }),
    hasTriggerContext: metadata.triggerContext !== null,
  })
  if (issue !== null) throw new ValidationError(issue.code, issue.message)
  return metadata
}

function sameSourceTerminationSnapshot(
  left: SourceTerminationSnapshot,
  right: SourceTerminationSnapshot,
): boolean {
  return (
    left.binding === right.binding &&
    left.launchRevision === right.launchRevision &&
    left.fence === right.fence &&
    left.effectRevision === right.effectRevision
  )
}

function assertProtectedLaunchGuard(
  invoker: ExecutionInvoker,
  guard: ProtectedMrLaunchGuard | undefined,
): void {
  if (guard === undefined) return
  if (invoker.type !== 'event' && invoker.type !== 'webhook') {
    throw new ValidationError(
      'protected-launch-invoker-invalid',
      'an MR launch guard requires an event or webhook invoker',
    )
  }
  if (
    invoker.sourceTerminationSnapshot === undefined ||
    !sameSourceTerminationSnapshot(invoker.sourceTerminationSnapshot, guard.snapshot)
  ) {
    throw new ValidationError(
      'protected-launch-snapshot-mismatch',
      'the launch invoker must carry the exact protected MR snapshot',
    )
  }
}

export interface PostgresqlTaskRouteWorkspaceRepository {
  readonly repoIndex: number
  readonly repoPath: string
  /** Credential-free display URL. Workspace composition must redact before returning it. */
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly baseBranch: string
  readonly branch: string
  readonly workingBranch: string | null
  readonly baseCommit: string | null
  readonly worktreePath: string
  readonly worktreeDirName: string
  readonly mountPath: string
  readonly subdir: string
  readonly readonly: boolean
  readonly workspaceProfileVersion: number | null
  readonly workspaceProfileDigest: string | null
  readonly hasSubmodules: boolean | null
  readonly submoduleInitOk: boolean | null
  readonly submoduleInitError: string | null
}

/**
 * A real, caller-owned materialization lease. The participant must prepare the
 * repository/scratch/group workspace and may not return a synthetic no-op
 * workspace. TaskExecution consumes the lease exactly once: `commit` after its
 * PostgreSQL transaction, or `rollback` after any pre-commit failure.
 */
export interface PostgresqlTaskRoutePreparedWorkspace {
  /** Exact id from the prepare request; prevents cross-request lease reuse. */
  readonly taskId: string
  readonly kind: 'scratch' | 'single' | 'multi' | 'group'
  readonly spaceKind: 'local' | 'remote' | 'scratch'
  readonly repoPath: string
  /** Credential-free display URL. */
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly repoGroupId: string | null
  readonly repoGroupName: string | null
  readonly worktreePath: string
  readonly baseBranch: string
  readonly branch: string
  readonly baseCommit: string | null
  readonly earlyError: string | null
  readonly repositories: readonly PostgresqlTaskRouteWorkspaceRepository[]
  readonly nodePaths: readonly string[]
  /** Non-throwing lease promotion after the owning database commit. */
  commit(): void
  rollback(): Promise<WorkspaceCleanupReport>
}

export interface PostgresqlTaskRouteWorkspaceParticipant {
  prepare(
    input: Readonly<{
      actor: Actor
      taskId: string
      task: StartTask
      gitCommitIdentity: GitCommitIdentity
      sourceTerminationSignal?: AbortSignal
    }>,
  ): Promise<PostgresqlTaskRoutePreparedWorkspace>
}

/** Resource Catalog projection required by the Workgroup launch arm. */
export interface PostgresqlWorkgroupRouteLaunchResources {
  loadVisible(actor: Actor, workgroupId: string): Promise<Workgroup | null>
  loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]>
  ensureHostWorkflow(): Promise<void>
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}

export interface PostgresqlRootTaskLaunchDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly gitCommitIdentity: Readonly<{
    execute(userId: string): Promise<GitCommitIdentity>
  }>
  readonly workspace: PostgresqlTaskRouteWorkspaceParticipant
  readonly coordinator: TaskDriveCoordinator
  readonly id?: () => string
  readonly now?: () => number
}

export interface PostgresqlTaskRouteLaunchDependencies extends PostgresqlRootTaskLaunchDependencies {
  readonly configPath: string
  /** Bind the admitted actor to the exact provider Resource Catalog authority. */
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
  readonly agent: Readonly<{
    resources: AgentLaunchResourceOperations
    integrity: AgentLaunchResourceIntegrityParticipant
  }>
  readonly workgroup: PostgresqlWorkgroupRouteLaunchResources
}

export interface PostgresqlRootTaskLaunchSubject {
  readonly workflowId: string
  readonly workflowName: string
  readonly workflowVersion: number
  readonly workflowSnapshot: WorkflowDefinition
  readonly sourceAgent?: Readonly<{ id: string; name: string }>
  readonly workgroup?: Readonly<{
    id: string
    name: string
    goal: string
    config: WorkgroupRuntimeConfig
    dynamicState: ReturnType<typeof initialDwState> | null
  }>
}

export interface PostgresqlRootTaskLaunchRequest {
  readonly actor: Actor
  readonly resourceAuthority: TaskExecutionResourceAuthority
  readonly invoker: ExecutionInvoker
  readonly guard?: ProtectedMrLaunchGuard
  readonly task: StartTask
  readonly subject: PostgresqlRootTaskLaunchSubject
  readonly uploads?: Readonly<{
    parts: readonly TaskRouteMultipartFilePart[]
    definitions: ReturnType<typeof collectUploadInputDefs>
    limits: Parameters<typeof validateUploadPlan>[0]['limits']
  }>
  /**
   * Provider-private facts for non-HTTP launches that still use this exact
   * TaskExecution transaction. The alternate workspace is a real caller-owned
   * lease; TaskExecution remains the sole writer of task and launch-intent rows.
   */
  readonly internal?: Readonly<{
    readonly catalogVisibility?: TaskCatalogVisibility
    readonly digitalEmployeeLaunch?: Readonly<{
      readonly actionRunId: string
      readonly caseId?: string
    }>
    readonly platformInputPaths?: readonly string[]
    readonly workspace?: PostgresqlTaskRouteWorkspaceParticipant
  }>
}

export interface PostgresqlRootTaskLaunchKernel {
  launch(input: PostgresqlRootTaskLaunchRequest): Promise<Task>
}

export type PostgresqlTaskExecutionLaunchTarget =
  | { readonly kind: 'workflow'; readonly refId: string; readonly payload: StartTask }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly payload: StartAgentTask & { readonly agentId?: string }
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly payload: StartWorkgroupTask & { readonly workgroupId?: string }
    }

export interface PostgresqlTaskExecutionLaunchParticipant {
  launch(
    input: Readonly<{
      actor: Actor
      target: PostgresqlTaskExecutionLaunchTarget
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
    }>,
  ): Promise<Task>
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
  const leaderMember = config.members.find((member) => member.id === config.leaderMemberId)
  const firstAgent = config.members.find((member) => member.memberType === 'agent')
  const leaderAgentName = leaderMember?.agentName ?? firstAgent?.agentName ?? 'workgroup-member'
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

function resolveWorkgroupCollaborators(
  explicit: readonly string[] | undefined,
  group: Workgroup,
): readonly string[] {
  const humanUserIds = group.members.flatMap((member) =>
    member.memberType === 'human' && member.userId !== null ? [member.userId] : [],
  )
  return [...new Set([...(explicit ?? []), ...humanUserIds])]
}

function lineageSlotPath(taskId: string, workflowVersion: number): string {
  return JSON.stringify([
    {
      stableNodeKey: 'task-root',
      frozenOccurrenceKey: taskId,
      workflowRevision: workflowVersion,
    },
  ])
}

function taskRepoOf(repository: PostgresqlTaskRouteWorkspaceRepository): TaskRepo {
  return {
    repoIndex: repository.repoIndex,
    repoPath: repository.repoPath,
    repoUrl: repository.repoUrl === null ? null : redactGitUrl(repository.repoUrl),
    cachedRepoId: repository.cachedRepoId,
    baseBranch: repository.baseBranch,
    branch: repository.branch,
    workingBranch: repository.workingBranch,
    baseCommit: repository.baseCommit,
    worktreePath: repository.worktreePath,
    worktreeDirName: repository.worktreeDirName,
    mountPath: repository.mountPath,
    subdir: repository.subdir,
    readonly: repository.readonly,
    readonlyDirtyCount: null,
    hasSubmodules: repository.hasSubmodules,
    submoduleInitOk: repository.submoduleInitOk,
    submoduleInitError: repository.submoduleInitError,
  }
}

function fallbackTaskRepo(
  workspace: PostgresqlTaskRoutePreparedWorkspace,
  workingBranch: string | undefined,
): TaskRepo {
  return {
    repoIndex: 0,
    repoPath: workspace.repoPath,
    repoUrl: workspace.repoUrl === null ? null : redactGitUrl(workspace.repoUrl),
    cachedRepoId: workspace.cachedRepoId,
    baseBranch: workspace.baseBranch,
    branch:
      workspace.branch === ''
        ? (workingBranch ?? `agent-workflow/${workspace.taskId}`)
        : workspace.branch,
    workingBranch: workingBranch ?? null,
    baseCommit: workspace.baseCommit,
    worktreePath: workspace.worktreePath,
    worktreeDirName: '',
    mountPath: '',
    subdir: '',
    readonly: false,
    readonlyDirtyCount: null,
    hasSubmodules: null,
    submoduleInitOk: null,
    submoduleInitError: null,
  }
}

function taskProjection(input: {
  readonly taskId: string
  readonly task: StartTask
  readonly subject: PostgresqlRootTaskLaunchSubject
  readonly workspace: PostgresqlTaskRoutePreparedWorkspace
  readonly gitCommitIdentity: GitCommitIdentity
  readonly inputs: Readonly<Record<string, string>>
  readonly startedAt: number
  readonly metadata: RootLaunchMetadata
  readonly digitalEmployeeCaseId: string | null
}): Task {
  const repositories = input.workspace.repositories.map(taskRepoOf)
  const repos =
    repositories.length > 0
      ? repositories
      : [fallbackTaskRepo(input.workspace, input.task.workingBranch)]
  const failed = input.workspace.earlyError !== null
  const branch =
    input.workspace.branch === ''
      ? (input.task.workingBranch ?? `agent-workflow/${input.taskId}`)
      : input.workspace.branch
  const spaceNodes: PlannedDirectoryNode[] = input.workspace.nodePaths.map((path) => ({
    path,
    origins: [],
  }))
  return TaskSchema.parse({
    id: input.taskId,
    name: input.task.name,
    workflowId: input.subject.workflowId,
    workflowName: input.subject.workflowName,
    workflowSnapshot: input.subject.workflowSnapshot,
    workflowVersion: input.subject.workflowVersion,
    repoPath: input.workspace.repoPath,
    repoUrl: input.workspace.repoUrl === null ? null : redactGitUrl(input.workspace.repoUrl),
    cachedRepoId: input.workspace.cachedRepoId,
    worktreePath: input.workspace.worktreePath,
    workspaceState: failed && input.workspace.worktreePath === '' ? 'pruned' : 'available',
    baseBranch: input.workspace.baseBranch,
    branch,
    workingBranch: input.task.workingBranch ?? null,
    autoCommitPush: input.task.autoCommitPush ?? false,
    baseCommit: input.workspace.baseCommit,
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
    gitUserName: input.gitCommitIdentity.name,
    gitUserEmail: input.gitCommitIdentity.email,
    repoCount: Math.max(1, input.workspace.repositories.length),
    repos,
    spaceNodes,
    repoGroupId: input.workspace.repoGroupId,
    repoGroupName: input.workspace.repoGroupName,
    scheduledTaskId: input.metadata.scheduledTaskId,
    workgroupId: input.subject.workgroup?.id ?? null,
    workgroupName: input.subject.workgroup?.name ?? null,
    goal: input.subject.workgroup?.goal ?? null,
    sourceAgentId: input.subject.sourceAgent?.id ?? null,
    sourceAgentName: input.subject.sourceAgent?.name ?? null,
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
  db: PostgresqlTaskExecutionTransaction,
  input: Readonly<{
    ownerUserId: string
    collaboratorUserIds: readonly string[]
  }>,
): Promise<readonly string[]> {
  const userIds = [...new Set([input.ownerUserId, ...input.collaboratorUserIds])]
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

function repoInsertRows(
  taskId: string,
  repositories: readonly PostgresqlTaskRouteWorkspaceRepository[],
) {
  return repositories.map((repository) => ({
    taskId,
    repoIndex: repository.repoIndex,
    repoPath: repository.repoPath,
    repoUrl: repository.repoUrl === null ? null : redactGitUrl(repository.repoUrl),
    cachedRepoId: repository.cachedRepoId,
    baseBranch: repository.baseBranch,
    branch: repository.branch,
    workingBranch: repository.workingBranch,
    baseCommit: repository.baseCommit,
    worktreePath: repository.worktreePath,
    worktreeDirName: repository.worktreeDirName,
    mountPath: repository.mountPath,
    subdir: repository.subdir,
    readonly: repository.readonly,
    workspaceProfileVersion: repository.workspaceProfileVersion,
    workspaceProfileDigest: repository.workspaceProfileDigest,
    hasSubmodules: repository.hasSubmodules,
    submoduleInitOk: repository.submoduleInitOk,
    submoduleInitError: repository.submoduleInitError,
  }))
}

async function rollbackWorkspace(
  workspace: PostgresqlTaskRoutePreparedWorkspace,
): Promise<WorkspaceCleanupReport> {
  try {
    return await workspace.rollback()
  } catch (error) {
    return {
      taskId: workspace.taskId,
      complete: false,
      failures: [
        {
          stage: 'owned-root-remove',
          taskId: workspace.taskId,
          path: workspace.worktreePath,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}

function createRootLaunch(
  dependencies: PostgresqlRootTaskLaunchDependencies,
): (input: PostgresqlRootTaskLaunchRequest) => Promise<Task> {
  const nextId = dependencies.id ?? ulid
  const now = dependencies.now ?? Date.now
  return async (input: PostgresqlRootTaskLaunchRequest): Promise<Task> => {
    const guard = input.guard
    let workspace: PostgresqlTaskRoutePreparedWorkspace | undefined
    let databaseCommitted = false
    let rolledBack = false
    let guardSettled = false
    try {
      if (input.resourceAuthority.actor !== input.actor) {
        throw new ValidationError(
          'task-launch-authority-mismatch',
          'task launch must use the exact admitted actor and authority pair',
        )
      }
      const metadata = rootLaunchMetadata(input.actor, input.invoker)
      assertProtectedLaunchGuard(input.invoker, guard)
      guard?.assertCanCommit()
      await guard?.verifyCanCommit()

      const taskId = nextId()
      const intentId = nextId()
      const refClosureJson = await input.resourceAuthority.resources.freezeCallClosure(
        input.resourceAuthority,
        {
          id: input.subject.workflowId,
          definition: input.subject.workflowSnapshot,
        },
      )
      assertTriggerPreflight({
        root: input.subject.workflowSnapshot,
        closureJson: refClosureJson,
        source: triggerSourceFromContext(metadata.triggerContext ?? undefined),
      })
      const gitCommitIdentity = await dependencies.gitCommitIdentity.execute(input.actor.user.id)
      let bufferedUploads: Awaited<ReturnType<typeof bufferUploadParts>> | undefined
      if (input.uploads !== undefined) {
        bufferedUploads = await bufferUploadParts(input.uploads.parts, input.uploads.definitions)
        validateUploadPlan({
          defs: input.uploads.definitions,
          files: bufferedUploads,
          limits: input.uploads.limits,
        })
      }

      const preparedWorkspace = await (input.internal?.workspace ?? dependencies.workspace).prepare(
        {
          actor: input.actor,
          taskId,
          task: input.task,
          gitCommitIdentity,
          ...(guard === undefined ? {} : { sourceTerminationSignal: guard.signal }),
        },
      )
      workspace = preparedWorkspace
      if (preparedWorkspace.taskId !== taskId) {
        await rollbackWorkspace(preparedWorkspace)
        rolledBack = true
        throw new Error(
          `task-route-workspace-id-mismatch: expected '${taskId}', got '${preparedWorkspace.taskId}'`,
        )
      }

      const persistedInputs: Record<string, string> = { ...input.task.inputs }
      if (
        input.uploads !== undefined &&
        bufferedUploads !== undefined &&
        preparedWorkspace.earlyError === null
      ) {
        try {
          const landed = await applyUploadsToWorktree({
            worktreePath: preparedWorkspace.worktreePath,
            ...(preparedWorkspace.kind === 'group' ? { inputsSubdir: UPLOAD_INPUTS_DIR } : {}),
            defs: input.uploads.definitions,
            files: bufferedUploads,
            limits: input.uploads.limits,
          })
          for (const [key, paths] of landed.packedByKey.entries()) {
            persistedInputs[key] = paths.join('\n')
          }
        } catch (error) {
          const report = await rollbackWorkspace(preparedWorkspace)
          rolledBack = true
          throw attachWorkspaceCleanupToMultipartError(error, report)
        }
      }

      const startedAt = now()
      const projection = taskProjection({
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
      const slotPathJson = lineageSlotPath(taskId, input.subject.workflowVersion)
      const branch =
        preparedWorkspace.branch === ''
          ? (input.task.workingBranch ?? `agent-workflow/${taskId}`)
          : preparedWorkspace.branch
      const memberIds = [...new Set(input.task.collaboratorUserIds ?? [])]
      const eventRef = await withPostgresqlSerializableTaskExecution(
        dependencies.db,
        async (tx) => {
          await guard?.verifyCanCommit()
          guard?.assertCanCommit()
          const activeMembers = await activeTaskMembers(tx, {
            ownerUserId: input.actor.user.id,
            collaboratorUserIds: memberIds,
          })
          await tx.insert(tasks).values({
            id: taskId,
            name: input.task.name,
            workflowId: input.subject.workflowId,
            workflowSnapshot: JSON.stringify(input.subject.workflowSnapshot),
            workflowVersion: input.subject.workflowVersion,
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
            status: failed ? 'failed' : 'pending',
            inputs: JSON.stringify(persistedInputs),
            maxDurationMs: input.task.maxDurationMs ?? null,
            maxTotalTokens: input.task.maxTotalTokens ?? null,
            startedAt,
            finishedAt: failed ? startedAt : null,
            errorSummary,
            errorMessage: preparedWorkspace.earlyError,
            gitUserName: gitCommitIdentity.name,
            gitUserEmail: gitCommitIdentity.email,
            workingBranch: input.task.workingBranch ?? null,
            autoCommitPush: input.task.autoCommitPush ?? false,
            repoCount: Math.max(1, preparedWorkspace.repositories.length),
            ownerUserId: input.actor.user.id,
            launchOrigin: metadata.launchOrigin,
            catalogVisibility: input.internal?.catalogVisibility ?? 'public',
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
            workgroupId: input.subject.workgroup?.id ?? null,
            workgroupConfigJson:
              input.subject.workgroup === undefined
                ? null
                : JSON.stringify(input.subject.workgroup.config),
            sourceAgentId: input.subject.sourceAgent?.id ?? null,
            sourceAgentName: input.subject.sourceAgent?.name ?? null,
            digitalEmployeeRoundId: input.internal?.digitalEmployeeLaunch?.actionRunId ?? null,
            digitalEmployeeCaseId: input.internal?.digitalEmployeeLaunch?.caseId ?? null,
            spaceKind: preparedWorkspace.spaceKind,
            workspacePrunedAt: failed && preparedWorkspace.worktreePath === '' ? startedAt : null,
            branchStartedAt: startedAt,
            rootTaskId: taskId,
            executionLineageId: taskId,
            lineageSlotPathJson: slotPathJson,
            refClosureJson,
          })
          if (preparedWorkspace.repositories.length > 0) {
            await tx
              .insert(taskRepos)
              .values(repoInsertRows(taskId, preparedWorkspace.repositories))
          }
          if (preparedWorkspace.nodePaths.length > 0) {
            await tx.insert(taskSpaceNodes).values(
              preparedWorkspace.nodePaths.map((nodePath) => ({
                taskId,
                nodePath,
                schemaVersion: 1,
              })),
            )
          }
          await tx.insert(taskCollaborators).values(
            activeMembers.map((userId) => {
              const role: 'owner' | 'collaborator' =
                userId === input.actor.user.id ? 'owner' : 'collaborator'
              return { taskId, userId, role, addedBy: input.actor.user.id, addedAt: startedAt }
            }),
          )
          await tx.insert(taskExecutionIntents).values({
            id: intentId,
            taskId,
            kind: 'launch',
            state: failed ? 'failed' : 'pending',
            source: metadata.intentSource,
            requestHash: sha256Hex(
              JSON.stringify({
                kind: 'launch',
                taskId,
                workflowId: input.subject.workflowId,
                workflowVersion: input.subject.workflowVersion,
                continuationSlotKey: 'task-root',
                operationGeneration: 0,
              }),
            ),
            payloadJson: JSON.stringify({ v: 1, workflowId: input.subject.workflowId }),
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
            await tx.insert(workgroupTaskState).values({
              taskId,
              gateStatus: 'idle',
              dwStateJson:
                input.subject.workgroup.dynamicState === null
                  ? null
                  : JSON.stringify(input.subject.workgroup.dynamicState),
              updatedAt: startedAt,
            })
          }
          return await appendPostgresqlTaskCreatedTx(tx, {
            taskId,
            status: failed ? 'failed' : 'pending',
            errorSummary,
            occurredAt: startedAt,
          })
        },
      )
      databaseCommitted = true
      await guard?.taskCommitted(taskId)
      preparedWorkspace.commit()
      await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
      if (!failed) {
        await dependencies.coordinator.submit({
          taskId,
          intentId,
          completionMode: 'background',
        })
      }
      await guard?.launchSettled(taskId)
      guardSettled = true
      return projection
    } catch (error) {
      if (workspace !== undefined && !databaseCommitted && !rolledBack) {
        await rollbackWorkspace(workspace)
      }
      if (guard !== undefined && !guardSettled) {
        try {
          await guard.failed(error instanceof DomainError ? error.code : 'launch-failed')
        } catch {
          // Preserve the launch failure. Durable guard recovery owns a failed
          // failure-receipt write; callers must still observe the launch error.
        }
      }
      throw error
    } finally {
      guard?.release()
    }
  }
}

export function createPostgresqlRootTaskLaunchKernel(
  dependencies: PostgresqlRootTaskLaunchDependencies,
): PostgresqlRootTaskLaunchKernel {
  const launch = createRootLaunch(dependencies)
  return Object.freeze({ launch })
}

function frozenAgentSnapshot(agent: Agent, allowClarify: boolean): WorkflowDefinition {
  const snapshot = buildAgentHostSnapshot(agent, allowClarify)
  try {
    return migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(snapshot))
  } catch (error) {
    throw new ValidationError('workflow-invalid', 'synthesized agent host snapshot is invalid', {
      issues: error instanceof Error ? [{ message: error.message }] : [],
    })
  }
}

type AgentLaunchCommand = Parameters<AgentRouteTaskLaunchOperations['launch']>[1]
type WorkgroupLaunchCommand = Parameters<WorkgroupRouteTaskLaunchOperations['launch']>[1]

interface PostgresqlTaskLaunchArms {
  launchAgent(
    input: Readonly<{
      actor: Actor
      command: AgentLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
    }>,
  ): Promise<Task>
  launchWorkgroup(
    input: Readonly<{
      actor: Actor
      command: WorkgroupLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
    }>,
  ): Promise<Task>
}

function createPostgresqlTaskLaunchArms(
  dependencies: PostgresqlTaskRouteLaunchDependencies,
): PostgresqlTaskLaunchArms {
  const launchRoot = createPostgresqlRootTaskLaunchKernel(dependencies).launch
  return Object.freeze({
    async launchAgent(input: Parameters<PostgresqlTaskLaunchArms['launchAgent']>[0]) {
      const { actor, command } = input
      const agent = await dependencies.agent.resources.loadVisibleAgent(actor, command.agentId)
      if (agent === null) throw new NotFoundError('agent-not-found', 'agent not found')
      assertNotBuiltin('agent', agent)
      if (
        command.payload.expectedAgentId !== undefined &&
        agent.id !== command.payload.expectedAgentId
      ) {
        throw new ConflictError(
          'agent-id-mismatch',
          `agent '${agent.name}' is not the expected agent`,
        )
      }

      acquireAgentLaunch(agent.id)
      try {
        const recheck = await dependencies.agent.resources.loadVisibleAgent(actor, agent.id)
        if (recheck === null) {
          throw new ConflictError(
            'agent-id-mismatch',
            `agent '${agent.name}' was deleted during launch`,
          )
        }
        await dependencies.agent.integrity.assertUsable({ rootAgentIds: [recheck.id] })
        await dependencies.agent.resources.ensureHostWorkflow()
        const form = validateAgentLaunchShape(recheck.inputs, command.payload, {
          multipart: command.uploads !== undefined,
        })
        const snapshot = frozenAgentSnapshot(recheck, command.payload.allowClarify)
        const validation = await dependencies.agent.resources.validateHostWorkflow(snapshot)
        const errors = validation.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
        if (!validation.ok && errors.length > 0) {
          throw new ValidationError(
            'workflow-invalid',
            `agent '${recheck.name}' cannot launch (${errors.length} error${errors.length === 1 ? '' : 's'} in its host snapshot)`,
            { issues: validation.issues },
          )
        }

        const taskInputs: Record<string, string> = {}
        if (form === null) {
          taskInputs[AGENT_HOST_INPUT_KEY] = command.payload.description ?? ''
        } else {
          const definitions = new Map(form.inputs.map((definition) => [definition.key, definition]))
          for (const [key, value] of Object.entries(command.payload.inputs ?? {})) {
            const definition = definitions.get(key)
            if (
              definition !== undefined &&
              definition.kind !== 'upload' &&
              typeof value === 'string'
            ) {
              taskInputs[key] = value
            }
          }
        }
        const candidate = applySpaceFields(
          {
            workflowId: AGENT_HOST_WORKFLOW_ID,
            name: command.payload.name,
            inputs: taskInputs,
            ...(command.payload.collaboratorUserIds !== undefined &&
            command.payload.collaboratorUserIds.length > 0
              ? { collaboratorUserIds: command.payload.collaboratorUserIds }
              : {}),
            ...(command.payload.workingBranch === undefined
              ? {}
              : { workingBranch: command.payload.workingBranch }),
            ...(command.payload.autoCommitPush === undefined
              ? {}
              : { autoCommitPush: command.payload.autoCommitPush }),
            ...(command.payload.maxDurationMs === undefined
              ? {}
              : { maxDurationMs: command.payload.maxDurationMs }),
            ...(command.payload.maxTotalTokens === undefined
              ? {}
              : { maxTotalTokens: command.payload.maxTotalTokens }),
          },
          command.payload,
        )
        const parsed = StartTaskSchema.safeParse(candidate)
        if (!parsed.success) {
          throw new ValidationError('agent-launch-invalid', 'invalid agent launch payload', {
            issues: parsed.error.issues,
          })
        }
        return await launchRoot({
          actor,
          resourceAuthority: input.resources,
          invoker: input.invoker,
          ...(input.guard === undefined ? {} : { guard: input.guard }),
          task: parsed.data,
          subject: {
            workflowId: AGENT_HOST_WORKFLOW_ID,
            workflowName: AGENT_HOST_WORKFLOW_NAME,
            workflowVersion: 1,
            workflowSnapshot: snapshot,
            sourceAgent: { id: recheck.id, name: recheck.name },
          },
          ...(command.uploads === undefined
            ? {}
            : {
                uploads: {
                  parts: command.uploads.parts,
                  definitions: collectUploadInputDefs(form?.inputs ?? []),
                  limits: command.uploads.limits,
                },
              }),
        })
      } finally {
        releaseAgentLaunch(agent.id)
      }
    },
    async launchWorkgroup(input: Parameters<PostgresqlTaskLaunchArms['launchWorkgroup']>[0]) {
      const { actor, command } = input
      const group = await dependencies.workgroup.loadVisible(actor, command.workgroupId)
      if (group === null) throw new NotFoundError('workgroup-not-found', 'workgroup not found')
      if (
        command.payload.expectedWorkgroupId !== undefined &&
        group.id !== command.payload.expectedWorkgroupId
      ) {
        throw new ConflictError(
          'workgroup-id-mismatch',
          `workgroup '${group.name}' is not the expected resource`,
        )
      }
      if (
        command.payload.expectedWorkgroupVersion !== undefined &&
        group.version !== command.payload.expectedWorkgroupVersion
      ) {
        throw staleConflictError(
          'workgroup',
          `workgroup '${group.name}' changed during launch (expected v${command.payload.expectedWorkgroupVersion}, now v${group.version})`,
          {
            expectedVersion: command.payload.expectedWorkgroupVersion,
            currentVersion: group.version,
          },
        )
      }
      const readiness = workgroupLaunchReadiness(group)
      if (!readiness.ready) {
        throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
          reasons: readiness.reasons,
        })
      }
      const agentMembers = group.members.filter((member) => member.memberType === 'agent')
      const memberAgentIds = agentMembers.flatMap((member) =>
        typeof member.agentId === 'string' && member.agentId.length > 0 ? [member.agentId] : [],
      )
      const existingIds = new Set(
        await dependencies.workgroup.loadExistingAgentIds([...new Set(memberAgentIds)]),
      )
      const missingAgentNames = [
        ...new Set(
          agentMembers
            .filter(
              (member) => typeof member.agentId !== 'string' || !existingIds.has(member.agentId),
            )
            .map((member) => member.agentName ?? '(unnamed)'),
        ),
      ]
      if (missingAgentNames.length > 0) {
        throw new ValidationError('workgroup-not-ready', 'workgroup is not launch-ready', {
          reasons: ['agent-missing'],
          missingAgentNames,
        })
      }
      await dependencies.workgroup.integrity.assertUsable({ rootAgentIds: memberAgentIds })

      const config = buildWorkgroupRuntimeConfig(group, command.payload.goal)
      const dynamic = group.mode === 'dynamic_workflow'
      const snapshot = dynamic
        ? WorkflowDefinitionSchema.parse(buildDynamicWorkflowGenerateSnapshot())
        : buildWorkgroupHostSnapshot(config)
      const collaboratorUserIds = resolveWorkgroupCollaborators(
        command.payload.collaboratorUserIds,
        group,
      )
      const candidate = applySpaceFields(
        {
          workflowId: WORKGROUP_HOST_WORKFLOW_ID,
          name: command.payload.name,
          inputs: {},
          ...(collaboratorUserIds.length === 0 ? {} : { collaboratorUserIds }),
          ...(command.payload.workingBranch === undefined
            ? {}
            : { workingBranch: command.payload.workingBranch }),
          ...(command.payload.autoCommitPush === undefined
            ? {}
            : { autoCommitPush: command.payload.autoCommitPush }),
          ...(command.payload.maxDurationMs === undefined
            ? {}
            : { maxDurationMs: command.payload.maxDurationMs }),
          ...(command.payload.maxTotalTokens === undefined
            ? {}
            : { maxTotalTokens: command.payload.maxTotalTokens }),
        },
        command.payload,
      )
      const parsed = StartTaskSchema.safeParse(candidate)
      if (!parsed.success) {
        throw new ValidationError('workgroup-launch-invalid', 'invalid workgroup launch payload', {
          issues: parsed.error.issues,
        })
      }
      await dependencies.workgroup.ensureHostWorkflow()
      return await launchRoot({
        actor,
        resourceAuthority: input.resources,
        invoker: input.invoker,
        ...(input.guard === undefined ? {} : { guard: input.guard }),
        task: parsed.data,
        subject: {
          workflowId: WORKGROUP_HOST_WORKFLOW_ID,
          workflowName: WORKGROUP_HOST_WORKFLOW_NAME,
          workflowVersion: 1,
          workflowSnapshot: snapshot,
          workgroup: {
            id: group.id,
            name: group.name,
            goal: command.payload.goal,
            config,
            dynamicState: dynamic ? initialDwState() : null,
          },
        },
      })
    },
  })
}

export function createPostgresqlTaskRouteLaunchOperations(
  dependencies: PostgresqlTaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
  const arms = createPostgresqlTaskLaunchArms(dependencies)
  const authorization = createPostgresqlTaskAuthorizationQueries(dependencies.db)
  const assertReplayVisible = async (actor: Actor, sourceTaskId: string): Promise<void> => {
    const visible = await authorization.canViewTask({
      subject: {
        userId: actor.user.id,
        canReadAllTasks: actor.permissions.has('tasks:read:all'),
      },
      taskId: sourceTaskId,
    })
    if (!visible) throw new NotFoundError('task-not-found', `task ${sourceTaskId} not found`)
  }

  return Object.freeze({
    agent: Object.freeze({
      uploadLimits: () => resolveUploadLimits(dependencies.configPath),
      assertReplayVisible,
      async launch(actor: Actor, command: AgentLaunchCommand) {
        return await arms.launchAgent({
          actor,
          command,
          invoker: {
            type: 'user',
            launchKind: command.uploads === undefined ? 'direct-json' : 'direct-multipart',
          },
          resources: dependencies.resourceAuthorityFor(actor),
        })
      },
    }),
    workgroup: Object.freeze({
      assertReplayVisible,
      async launch(actor: Actor, command: WorkgroupLaunchCommand) {
        return await arms.launchWorkgroup({
          actor,
          command,
          invoker: { type: 'user', launchKind: 'direct-json' },
          resources: dependencies.resourceAuthorityFor(actor),
        })
      },
    }),
  })
}

export function createPostgresqlTaskExecutionLaunchParticipant(
  dependencies: PostgresqlTaskRouteLaunchDependencies,
): PostgresqlTaskExecutionLaunchParticipant {
  const launchRoot = createPostgresqlRootTaskLaunchKernel(dependencies).launch
  const arms = createPostgresqlTaskLaunchArms(dependencies)
  return Object.freeze({
    async launch(input: Parameters<PostgresqlTaskExecutionLaunchParticipant['launch']>[0]) {
      switch (input.target.kind) {
        case 'workflow': {
          if (input.target.payload.workflowId !== input.target.refId) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `workflow ref '${input.target.refId}' does not match payload '${input.target.payload.workflowId}'`,
            )
          }
          const snapshots = await input.resources.resources.loadAuthorized(input.resources, [
            { kind: 'workflow-launch', workflowId: input.target.refId },
          ])
          const snapshot = snapshots[0]
          if (snapshots.length !== 1 || snapshot?.kind !== 'workflow-launch') {
            throw new Error('task-execution-workflow-snapshot-invalid')
          }
          if (
            input.target.payload.expectedWorkflowVersion !== undefined &&
            snapshot.workflow.version !== input.target.payload.expectedWorkflowVersion
          ) {
            throw new ConflictError(
              'workflow-version-mismatch',
              `workflow '${input.target.refId}' changed during launch (expected v${input.target.payload.expectedWorkflowVersion}, now v${snapshot.workflow.version})`,
              {
                expectedVersion: input.target.payload.expectedWorkflowVersion,
                currentVersion: snapshot.workflow.version,
              },
            )
          }
          const validation = await dependencies.agent.resources.validateHostWorkflow(
            snapshot.workflow.definition,
          )
          const errors = validation.issues.filter(
            (issue) => (issue.severity ?? 'error') === 'error',
          )
          if (!validation.ok && errors.length > 0) {
            throw new ValidationError(
              'workflow-invalid',
              `workflow '${snapshot.workflow.id}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'})`,
              { issues: validation.issues },
            )
          }
          const parsed = StartTaskSchema.safeParse(input.target.payload)
          if (!parsed.success) {
            throw new ValidationError('task-invalid', 'invalid task payload', {
              issues: parsed.error.issues,
            })
          }
          return await launchRoot({
            actor: input.actor,
            resourceAuthority: input.resources,
            invoker: input.invoker,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
            task: parsed.data,
            subject: {
              workflowId: snapshot.workflow.id,
              workflowName: snapshot.workflow.name,
              workflowVersion: snapshot.workflow.version,
              workflowSnapshot: snapshot.workflow.definition,
            },
          })
        }
        case 'agent': {
          if (
            input.target.payload.agentId !== undefined &&
            input.target.payload.agentId !== input.target.refId
          ) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `agent ref '${input.target.refId}' does not match payload '${input.target.payload.agentId}'`,
            )
          }
          return await arms.launchAgent({
            actor: input.actor,
            command: { agentId: input.target.refId, payload: input.target.payload },
            invoker: input.invoker,
            resources: input.resources,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
          })
        }
        case 'workgroup': {
          const payloadWorkgroupId = input.target.payload.workgroupId
          if (typeof payloadWorkgroupId === 'string' && payloadWorkgroupId !== input.target.refId) {
            throw new ValidationError(
              'execution-ref-mismatch',
              `workgroup ref '${input.target.refId}' does not match payload '${payloadWorkgroupId}'`,
            )
          }
          return await arms.launchWorkgroup({
            actor: input.actor,
            command: { workgroupId: input.target.refId, payload: input.target.payload },
            invoker: input.invoker,
            resources: input.resources,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
          })
        }
        default: {
          const exhaustive: never = input.target
          throw new Error(`unsupported task launch target: ${String(exhaustive)}`)
        }
      }
    },
  })
}
