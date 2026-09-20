import { launchTask } from '../application/launch/launchTask'
import type { TaskWorkspaceLaunchLane } from '../application/ports/workspaceLaunch'
import {
  UPLOAD_INPUTS_DIR,
  StartTaskSchema,
  TaskSchema,
  applySpaceFields,
  buildClarifyEdges,
  initialDwState,
  migrateWorkflowDefinitionToLatest,
  redactGitUrl,
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
import type { ProviderNeutralDatabase } from '@/db/query'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
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
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { layoutBuiltinWorkflowSnapshot } from '@/services/task'
import type { WorkspaceCleanupReport } from '@/services/task'
import { validateUploadPlan } from '@/services/upload'
import { applyTaskWorkspaceUploads } from './taskWorkspaceUploads'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
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
import { createTaskAuthorizationQueries } from './taskAuthorization'
import {
  type TaskExecutionTransaction,
  withSerializableTaskExecution,
} from './taskLifecycleTransaction'
import { appendTaskCreatedCommittedEvent } from './taskLifecycleCommittedEvents'
import { buildWorkgroupRuntimeConfig } from './workgroupRuntimeConfig'

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

export interface TaskRouteWorkspaceRepository {
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
export interface TaskRoutePreparedWorkspace {
  /** Exact id from the prepare request; prevents cross-request lease reuse. */
  readonly taskId: string
  readonly kind: 'scratch' | 'single' | 'multi' | 'group'
  readonly spaceKind: 'local' | 'remote' | 'scratch' | 'internal'
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
  readonly repositories: readonly TaskRouteWorkspaceRepository[]
  readonly nodePaths: readonly string[]
  /** Private adapter joins source/plan admission to the existing Task transaction. */
  admit(transaction: ProviderNeutralDatabase): Promise<TaskWorkspaceLaunchLane>
  /** Non-throwing lease promotion after the owning database commit. */
  commit(): void
  rollback(): Promise<WorkspaceCleanupReport>
}

export interface TaskRouteWorkspaceParticipant {
  prepare(
    input: Readonly<{
      actor: Actor
      authority: TaskExecutionResourceAuthority['authority']
      taskId: string
      task: StartTask
      gitCommitIdentity: GitCommitIdentity | null
      sourceTerminationSignal?: AbortSignal
      /**
       * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：只交占位工作区，真正的物化
       * 留给驱动的第 0 步。由启动请求带进来（见 `RootTaskLaunchRequest`）。
       */
      defer?: boolean
    }>,
  ): Promise<TaskRoutePreparedWorkspace>
}

/** Resource Catalog projection required by the Workgroup launch arm. */
export interface WorkgroupRouteLaunchResources {
  loadVisible(actor: Actor, workgroupId: string): Promise<Workgroup | null>
  loadExistingAgentIds(agentIds: readonly string[]): Promise<readonly string[]>
  ensureHostWorkflow(): Promise<void>
  readonly integrity: AgentLaunchResourceIntegrityParticipant
}

export interface RootTaskLaunchDependencies {
  readonly db: ProviderNeutralDatabase
  readonly gitCommitIdentity: Readonly<{
    execute(userId: string): Promise<GitCommitIdentity>
  }>
  readonly workspace: TaskRouteWorkspaceParticipant
  readonly coordinator: TaskDriveCoordinator
  readonly id?: () => string
  readonly now?: () => number
}

/**
 * RFC-359 AC-1（plan §5hn 批次一）—— **单代理**启动臂真正需要的那些依赖。
 *
 * 从 `TaskRouteLaunchDependencies` 里拆出来，是为了让 SQLite 那一侧能接同一份
 * 实现而**不必编造一份用不到的 workgroup 资源面**：agent 臂的函数体只碰
 * `agent.resources` / `agent.integrity` 与根内核，工作组那格它一次都没读过。
 * 让类型说真话，比让调用方塞个占位对象好。
 *
 * RFC-359 AC-1（plan §5hn 批次二 ①②，同一条判据的第二次应用）：`resourceAuthorityFor`
 * 也从这里挪走了——它只被**路由包装**读（`createTaskRouteLaunchOperations` 的
 * 两个 `launch(actor, command)`），臂与启动参与者收的都是请求上带来的 `resources`。
 * 留着它的代价不是多一行：定时 / webhook 拿到的是**委派** actor，而典型实现是
 * `authorityForLegacyProjection(actor)`——非直连 actor 会当场抛。让一个用不到的必填项
 * 逼调用方去编一个「反正不会被调用」的实现，正是这一轮在消灭的形状。
 */
export interface AgentRouteLaunchDependencies extends RootTaskLaunchDependencies {
  readonly configPath: string
  readonly agent: Readonly<{
    resources: AgentLaunchResourceOperations
    integrity: AgentLaunchResourceIntegrityParticipant
  }>
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ③）—— **工作组**启动臂真正需要的那些依赖。
 * 同 `AgentRouteLaunchDependencies` 的理由：让 SQLite 那一侧能接同一份实现，
 * 而不必编造一份用不到的 agent 资源面。
 */
export interface WorkgroupRouteLaunchDependencies extends RootTaskLaunchDependencies {
  readonly configPath: string
  readonly workgroup: WorkgroupRouteLaunchResources
}

/**
 * 启动参与者（定时 / webhook / 子任务那条路）真正需要的：两条臂的并集，**不含**
 * `resourceAuthorityFor`——它收的是请求上带来的 `resources`。
 */
export interface TaskExecutionLaunchParticipantDependencies
  extends AgentRouteLaunchDependencies, WorkgroupRouteLaunchDependencies {}

/** 路由面额外要一格：把 admitted actor 绑成 provider 的资源目录鉴权句柄。 */
export interface TaskRouteLaunchDependencies extends TaskExecutionLaunchParticipantDependencies {
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
}

export interface RootTaskLaunchSubject {
  readonly workflowId: string
  readonly workflowName: string
  readonly workflowVersion: number
  readonly workflowSnapshot: WorkflowDefinition
  /**
   * RFC-359 AC-1（plan §5hn 批次一）：这份快照是不是**平台自有的合成宿主**。
   *
   * 它决定要不要在**写时**冻结规范排版——`services/task.ts` 的 `startTask` 对
   * `workflow.builtin === true` 一直是这么做的，而启动内核此前直接
   * `JSON.stringify(subject.workflowSnapshot)` 落库、只靠**读时**投影补，
   * 于是启动响应体与库里那一行在两个引擎上不同
   * （`rfc359-w5hn-agent-launch-provider-parity` 照出来的）。
   *
   * **故意声明成必填**：可选会让「装配漏了一步」编译通过，而漏掉的后果是那条任务
   * 从此存着一份没有几何的快照——读时投影补得了页面，补不了导出与直接读库的下游。
   * 必填之后，任何新的启动路都要在类型层先回答这个问题。
   */
  readonly builtin: boolean
  readonly sourceAgent?: Readonly<{ id: string; name: string }>
  readonly workgroup?: Readonly<{
    id: string
    name: string
    goal: string
    config: WorkgroupRuntimeConfig
    dynamicState: ReturnType<typeof initialDwState> | null
  }>
}

export interface RootTaskLaunchRequest {
  readonly actor: Actor
  readonly resourceAuthority: TaskExecutionResourceAuthority
  readonly invoker: ExecutionInvoker
  readonly guard?: ProtectedMrLaunchGuard
  readonly task: StartTask
  readonly subject: RootTaskLaunchSubject
  readonly uploads?: Readonly<{
    parts: readonly TaskRouteMultipartFilePart[]
    definitions: ReturnType<typeof collectUploadInputDefs>
    limits: Parameters<typeof validateUploadPlan>[0]['limits']
  }>
  /**
   * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— **延后仓库准备**。
   *
   * 由启动路各自决定：JSON body 启动与定时 / webhook 触发开（失败要留下一行可重试的
   * 任务），multipart 与代理 / 工作组直启不开（前者要把上传物写进工作树，后者按 G7
   * 保持同步语义）。带上传时本标志**一律忽略**——上传物必须落进真工作树。
   *
   * 关掉时逐字维持既有行为：物化在落行之前，失败抛给调用方。
   */
  readonly deferRepoPreparation?: boolean
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
    readonly workspace?: TaskRouteWorkspaceParticipant
  }>
}

export interface RootTaskLaunchKernel {
  launch(input: RootTaskLaunchRequest): Promise<Task>
}

export type TaskExecutionLaunchTarget =
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

export interface TaskExecutionLaunchParticipant {
  launch(
    input: Readonly<{
      actor: Actor
      target: TaskExecutionLaunchTarget
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
      /**
       * RFC-359 AC-1（plan §5hn 批次二 ⑥）—— multipart 启动交进来的**已解析文件分片**。
       *
       * 只交 `parts`：上传声明与体积上限都从参与者手上**已经有的**东西派生
       * （`collectUploadInputDefs(冻结快照.inputs)` 与 `resolveUploadLimits(configPath)`）。
       * 路由不必为了算这两样而把工作流再读一遍——那正是合并前两条 multipart 路各自
       * 重复做过的事。
       */
      uploads?: Readonly<{ parts: readonly TaskRouteMultipartFilePart[] }>
      /**
       * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：调用方**显式**要求延后仓库准备。
       * 定时 / webhook 由参与者按 invoker 自己判定（`triggerDefersRepositoryPreparation`），
       * 这一格留给知道自己不是 multipart 的那条 JSON 路由。
       */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
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

function taskRepoOf(repository: TaskRouteWorkspaceRepository): TaskRepo {
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
  workspace: TaskRoutePreparedWorkspace,
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
  readonly subject: RootTaskLaunchSubject
  readonly workspace: TaskRoutePreparedWorkspace
  readonly gitCommitIdentity: GitCommitIdentity | null
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
    gitUserName: input.gitCommitIdentity?.name ?? null,
    gitUserEmail: input.gitCommitIdentity?.email ?? null,
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
  db: TaskExecutionTransaction,
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

function repoInsertRows(taskId: string, repositories: readonly TaskRouteWorkspaceRepository[]) {
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
  workspace: TaskRoutePreparedWorkspace,
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
  dependencies: RootTaskLaunchDependencies,
): (input: RootTaskLaunchRequest) => Promise<Task> {
  const nextId = dependencies.id ?? ulid
  const now = dependencies.now ?? Date.now
  return async (request: RootTaskLaunchRequest): Promise<Task> => {
    // RFC-359 AC-1（plan §5hn 批次一）：平台自有的合成宿主快照**在入口规范化一次**，
    // 之后落库与返回投影用的是**同一份**。
    //
    // 分两处各排一次是错的：库里那行与启动响应体会不一致（我第一版就是那么写的，
    // 只改了 insert，响应体照旧是没几何的那份——把「两个引擎不一致」换成了
    // 「同一个引擎里行与响应不一致」，更糟）。
    const input: RootTaskLaunchRequest = request.subject.builtin
      ? {
          ...request,
          subject: {
            ...request.subject,
            workflowSnapshot: layoutBuiltinWorkflowSnapshot(request.subject.workflowSnapshot),
          },
        }
      : request
    const guard = input.guard
    const preflight = async () => {
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
      // System tasks retain the same empty Git metadata snapshot as SQLite root launches.
      const gitCommitIdentity =
        input.actor.user.id === SYSTEM_USER_ID
          ? null
          : await dependencies.gitCommitIdentity.execute(input.actor.user.id)
      let bufferedUploads: Awaited<ReturnType<typeof bufferUploadParts>> | undefined
      if (input.uploads !== undefined) {
        bufferedUploads = await bufferUploadParts(input.uploads.parts, input.uploads.definitions)
        validateUploadPlan({
          defs: input.uploads.definitions,
          files: bufferedUploads,
          limits: input.uploads.limits,
        })
      }

      // 带上传时**绝不**延后：上传物要写进真工作树（RFC-287 G7 原文把 multipart 与
      // preCreated 两条一起排除在外）。这一格由内核自己兜住，调用方不必各自记得。
      const deferPreparation = input.deferRepoPreparation === true && input.uploads === undefined
      return {
        taskId,
        intentId,
        refClosureJson,
        metadata,
        gitCommitIdentity,
        bufferedUploads,
        deferPreparation,
      }
    }
    type LaunchContext = Awaited<ReturnType<typeof preflight>>
    const prepare = async ({ taskId, gitCommitIdentity, deferPreparation }: LaunchContext) => {
      return await (input.internal?.workspace ?? dependencies.workspace).prepare({
        actor: input.actor,
        authority: input.resourceAuthority.authority,
        taskId,
        task: input.task,
        gitCommitIdentity,
        ...(deferPreparation ? { defer: true } : {}),
        ...(guard === undefined ? {} : { sourceTerminationSignal: guard.signal }),
      })
    }
    const applyUploads = async (
      { taskId, bufferedUploads }: LaunchContext,
      preparedWorkspace: TaskRoutePreparedWorkspace,
      persistedInputs: Record<string, string>,
    ) => {
      if (
        input.uploads !== undefined &&
        bufferedUploads !== undefined &&
        preparedWorkspace.earlyError === null
      ) {
        const landed = await applyTaskWorkspaceUploads({
          db: dependencies.db,
          taskId,
          plan: {
            worktreePath: preparedWorkspace.worktreePath,
            ...(preparedWorkspace.kind === 'group' ? { inputsSubdir: UPLOAD_INPUTS_DIR } : {}),
            defs: input.uploads.definitions,
            files: bufferedUploads,
            limits: input.uploads.limits,
          },
        })
        for (const [key, paths] of landed.packedByKey.entries()) {
          persistedInputs[key] = paths.join('\n')
        }
      }
    }
    const admit = async (
      { taskId, intentId, refClosureJson, metadata, gitCommitIdentity }: LaunchContext,
      preparedWorkspace: TaskRoutePreparedWorkspace,
      persistedInputs: Record<string, string>,
    ) => {
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
          preparedWorkspace.worktreePath !== ''
        )
          throw new Error('repository-preparation-lane-already-materialized')
        await tx.insert(tasks).values({
          id: taskId,
          name: input.task.name,
          workflowId: input.subject.workflowId,
          // 入口已按 `subject.builtin` 规范化过排版，这里落的就是返回投影用的同一份。
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
          gitUserName: gitCommitIdentity?.name ?? null,
          gitUserEmail: gitCommitIdentity?.email ?? null,
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
          await tx.insert(taskRepos).values(repoInsertRows(taskId, preparedWorkspace.repositories))
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
        return await appendTaskCreatedCommittedEvent(tx, {
          taskId,
          status: failed ? 'failed' : 'pending',
          errorSummary,
          occurredAt: startedAt,
        })
      })
      return { taskId, intentId, failed, eventRef, projection }
    }
    return await launchTask({
      preflight,
      prepare,
      initialInputs: () => ({ ...input.task.inputs }),
      applyUploads,
      admit,
      rollback: rollbackWorkspace,
      uploadFailure: attachWorkspaceCleanupToMultipartError,
      publish: ({ eventRef }) =>
        publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef]),
      submit: ({ taskId, intentId }) =>
        dependencies.coordinator.submit({ taskId, intentId, completionMode: 'background' }),
      guard,
    })
  }
}

export function createRootTaskLaunchKernel(
  dependencies: RootTaskLaunchDependencies,
): RootTaskLaunchKernel {
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

interface TaskLaunchArms {
  launchAgent(
    input: Readonly<{
      actor: Actor
      command: AgentLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
      /** RFC-287 G7：定时 / webhook 触发与手动启动同一套语义，直启路由不开。 */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
  launchWorkgroup(
    input: Readonly<{
      actor: Actor
      command: WorkgroupLaunchCommand
      invoker: ExecutionInvoker
      resources: TaskExecutionResourceAuthority
      guard?: ProtectedMrLaunchGuard
      /** RFC-287 G7：同上。 */
      deferRepoPreparation?: boolean
    }>,
  ): Promise<Task>
}

/**
 * RFC-359 AC-1（plan §5hn 批次一）—— 单代理启动的**唯一**编排。
 *
 * 两个引擎共用这一份：路由层本来就打同一个 `AgentRouteTaskLaunchOperations` 端口，
 * 差别整个在端口背后（SQLite 曾转 `startExecution` → `startAgentTask` → `startTask`）。
 * 现在两侧都转到这里，终端统一为根启动内核。
 */
export function createAgentRouteLaunch(
  dependencies: AgentRouteLaunchDependencies,
): (input: Parameters<TaskLaunchArms['launchAgent']>[0]) => Promise<Task> {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  return async function launchAgent(
    input: Parameters<TaskLaunchArms['launchAgent']>[0],
  ): Promise<Task> {
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
        ...(input.deferRepoPreparation === true ? { deferRepoPreparation: true } : {}),
        task: parsed.data,
        subject: {
          workflowId: AGENT_HOST_WORKFLOW_ID,
          workflowName: AGENT_HOST_WORKFLOW_NAME,
          // 合成的单代理宿主：写时冻结规范排版（plan §5hn）。
          builtin: true,
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
  }
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ③）—— 工作组启动的**唯一**编排。
 *
 * 与 agent 臂同形：路由层本来就打同一个 `WorkgroupRouteTaskLaunchOperations` 端口，
 * 差别整个在端口背后（SQLite 曾转 `startWorkgroupTask`——470 行、直接读库）。
 * 现在两侧都转到这里，终端统一为根启动内核。
 */
export function createWorkgroupRouteLaunch(
  dependencies: WorkgroupRouteLaunchDependencies,
): (input: Parameters<TaskLaunchArms['launchWorkgroup']>[0]) => Promise<Task> {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  return async function launchWorkgroup(
    input: Parameters<TaskLaunchArms['launchWorkgroup']>[0],
  ): Promise<Task> {
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
      ...(input.deferRepoPreparation === true ? { deferRepoPreparation: true } : {}),
      task: parsed.data,
      subject: {
        workflowId: WORKGROUP_HOST_WORKFLOW_ID,
        workflowName: WORKGROUP_HOST_WORKFLOW_NAME,
        // 合成的工作组宿主：写时冻结规范排版（plan §5hn）。
        builtin: true,
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
  }
}

function createTaskLaunchArms(dependencies: TaskRouteLaunchDependencies): TaskLaunchArms {
  // 两个臂都已各自提成独立工厂（plan §5hn 批次一 / 批次二 ③），这里只剩转发。
  return Object.freeze({
    launchAgent: createAgentRouteLaunch(dependencies),
    launchWorkgroup: createWorkgroupRouteLaunch(dependencies),
  })
}

export function createTaskRouteLaunchOperations(
  dependencies: TaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
  const arms = createTaskLaunchArms(dependencies)
  const authorization = createTaskAuthorizationQueries(dependencies.db)
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

/**
 * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— 哪些入口要**延后仓库准备**。
 *
 * G7 原话是「定时任务与 webhook 触发同一套语义」：这两条背后没有等 HTTP 响应的用户，
 * 而 G7 的另一半收益（**准备失败要留下记录**）恰恰是它们最需要的——不开的话，一次拉不动
 * 远端的定时触发压根不铸任务行，用户在任务列表里什么都看不到，也没有可重试的对象
 *（`services/scheduleLaunch.ts` 原文，AC-11 的重试作用面为空）。
 *
 * 直启路由（`type:'user'`）不在此列：G7 明列「代理 / 工作组启动保持同步语义」，
 * 而 JSON `POST /api/tasks` 那条由**路由自己**声明（它知道自己是不是 multipart）。
 */
function triggerDefersRepositoryPreparation(invoker: ExecutionInvoker): boolean {
  return invoker.type === 'scheduled' || invoker.type === 'webhook' || invoker.type === 'event'
}

export function createTaskExecutionLaunchParticipant(
  dependencies: TaskExecutionLaunchParticipantDependencies,
): TaskExecutionLaunchParticipant {
  const launchRoot = createRootTaskLaunchKernel(dependencies).launch
  const arms = Object.freeze({
    launchAgent: createAgentRouteLaunch(dependencies),
    launchWorkgroup: createWorkgroupRouteLaunch(dependencies),
  })
  return Object.freeze({
    async launch(input: Parameters<TaskExecutionLaunchParticipant['launch']>[0]) {
      const deferRepoPreparation =
        input.deferRepoPreparation === true || triggerDefersRepositoryPreparation(input.invoker)
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
          // RFC-359 AC-1（plan §5hn 批次二 ④）：**带上候选上下文**——不带它，
          // `loadWorkflowValidationContext` 不填 `callWorkflows` / `currentWorkflow`，
          // call-node 规则就不在这道门上判，引用悬空要等到冻结调用闭包时才被另一个组件
          // 以 `workflow-call-ref-missing` 拒掉（而且不带 `issues[]`，编辑器指不到出错节点）。
          const validation = await dependencies.agent.resources.validateHostWorkflow(
            snapshot.workflow.definition,
            {
              definition: snapshot.workflow.definition,
              currentWorkflow: { id: snapshot.workflow.id, name: snapshot.workflow.name },
            },
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
          // RFC-359 AC-1（plan §5hn 批次二 ④，**修 627290a94 推的红**）：启动输入契约
          //（缺必填 / 未声明键 / picker 类型不匹配 → 422）。此前只有 `startTask` 那一侧做
          // （`services/task.ts` 的同名调用，条件是「非 agent/workgroup/code-round/数字员工
          // 合成宿主」——那几类各有自己的宿主契约，在各自的启动服务里验）。
          // 内核这一侧一直没有，于是 **PostgreSQL 从来没执行过这条契约**；
          // SQLite 的 JSON 路由改走内核之后当场照出来（e2e `workflow-matrix` 的
          // 「missing required」期望 422，实际放行）。
          // 这一格放在**工作流臂**而不是内核：内核也服务合成宿主，那几类不适用本契约。
          //
          // RFC-359 AC-1（plan §5hn 批次二 ⑥）：带上传时**忽略 upload 键**——那几个键的值
          // 是服务端写完文件后才回填的仓内路径，此刻本来就还是空串。SQLite 的 multipart 路
          // （`services/multipartTaskStart.ts`）一直是这个口径。
          assertWorkflowLaunchInputs(
            snapshot.workflow.definition.inputs,
            parsed.data.inputs,
            input.uploads === undefined ? {} : { ignoreUploadInputs: true },
          )
          return await launchRoot({
            actor: input.actor,
            resourceAuthority: input.resources,
            invoker: input.invoker,
            ...(input.guard === undefined ? {} : { guard: input.guard }),
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
            ...(input.uploads === undefined
              ? {}
              : {
                  uploads: {
                    parts: input.uploads.parts,
                    // 上传声明取自**冻结快照**——与落库的那一份同源，路由读到的另一份不算数。
                    definitions: collectUploadInputDefs(snapshot.workflow.definition.inputs),
                    limits: resolveUploadLimits(dependencies.configPath),
                  },
                }),
            task: parsed.data,
            subject: {
              workflowId: snapshot.workflow.id,
              workflowName: snapshot.workflow.name,
              workflowVersion: snapshot.workflow.version,
              workflowSnapshot: snapshot.workflow.definition,
              // 工作流启动面按定义拿不到内置工作流——冻结资源快照那一步就
              // `assertNotBuiltin` 挡住了（`taskExecutionResourceSnapshots.ts:142`）。
              builtin: false,
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
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
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
            ...(deferRepoPreparation ? { deferRepoPreparation: true } : {}),
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
