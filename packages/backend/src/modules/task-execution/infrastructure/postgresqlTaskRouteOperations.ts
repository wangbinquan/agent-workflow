import {
  CommitPushMetaSchema,
  NodeRunSchema,
  NodeRunEventsResponseSchema,
  StartTaskSchema,
  TaskListItemSchema,
  TaskSchema,
  TaskSummarySchema,
  WorkflowDefinitionSchema,
  allowedFromForTaskEvent,
  clarifyNavKindForRoundStatus,
  diffWorkflowForSync,
  emptyWorkflowSyncDiff,
  isHumanReviewConclusion,
  isTerminalNodeRunStatus,
  isTerminalTaskStatus,
  isTurnEngineWorkgroupTask,
  isWrapperKind,
  isWorkgroupTask,
  migrateWorkflowDefinitionToLatest,
  mountDepth,
  nodeKindParticipatesInRetryCascade,
  parseTriggerContextJson,
  redactGitUrl,
  rejectRetiredStartTaskKeys,
  selectCurrentReviewRound,
  taskExecutionKind,
  taskListOriginMatches,
  webhookTaskSourceLinkOf,
  type AssignableTaskMemberRole,
  type NodeRun,
  type NodeRunStatus,
  type Task,
  type TaskDiff,
  type TaskListItem,
  type TaskMembers,
  type TaskRepo,
  type TaskStatus,
  type TaskSummary,
  type UserPublic,
  type WorkflowDefinition,
  type WorkflowSyncPreview,
} from '@agent-workflow/shared'
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import {
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskFeedback,
  taskExecutionMaintenanceMembers,
  taskRepos,
  taskSpaceNodes,
  tasks,
  workflows,
} from '@/db/schema'
import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'
import type {
  ClarifyRepairParticipant,
  CollaborationRuntimeMechanics,
  ReviewRepairParticipant,
} from '@/modules/collaboration/public/participants'
import { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { OwnerIdentityQueries } from '@/modules/identity-access/public/operations'
import type { FrozenTaskExecutionResourceSnapshot } from '@/modules/resource-catalog/public/types'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { branchTraceForTask } from '../application/branchTrace'
import { sourceTerminationRevivalError } from '../domain/sourceTermination'
import { DrizzleTaskRollbackQueries } from './taskRollbackQueries'
import { nextRetryIndex } from '../application/nextRetryIndex'
import type { RepositoryPreparationRetryCommand } from '../application/ports/taskAutoResumeCommand'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type {
  ActiveTaskExecutionParticipant,
  ChildTaskLifecycleParticipant,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { ChildResumeRuntime } from '../application/ports/taskExecutionTopology'
import type { SchedulerRuntimeTopology } from '../public/participants'
import type { TaskRouteListFilters, TaskRouteOperations } from '../public/taskRoutes'
import { DrizzleBranchTraceSnapshotReader } from './branchTraceSnapshotReader'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'
import { createTaskAuthorizationQueries } from './taskAuthorization'
import {
  createPostgresqlRootTaskLaunchKernel,
  createPostgresqlTaskExecutionLaunchParticipant,
  type PostgresqlTaskRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteRepairOperations,
  type PostgresqlTaskRepairOperations,
} from './postgresqlTaskRouteRepairOperations'
import {
  withPostgresqlSerializableTaskExecution,
  withPostgresqlTaskAggregateTransaction,
  type PostgresqlTaskExecutionTransaction,
} from './postgresqlTaskLifecycleTransaction'
import {
  appendTaskLifecycleTransitionCommittedEvent,
  appendTaskNodeStatusesCommittedEvent,
} from './taskLifecycleCommittedEvents'
import { readArchivedEvents } from '@/platform/background/eventsArchiveReader'

function lacksMaterializedWorkspace(path: string): boolean {
  return path.length === 0
}
import { parsePortValidationFailuresJson } from '@/services/envelope'
import {
  collectUploadInputDefs,
  parseMultipartLaunch,
  resolveUploadLimits,
} from '@/services/launchMultipart'
import { parseInjectedSnapshotJson } from '@/modules/memory/public/types'
import { loadTaskFailureCodes, projectWorkflowSnapshotForRead } from '@/services/task'
import { readNodeRunPrompt } from '@/services/nodeRunPrompt'
import { assertNotBuiltin } from '@/services/systemResources'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { compareNodeRunsForTimeline, deriveReviewRoundTiming } from '@/services/reviewRoundStart'
import { canonicalRepoKeysWire } from '@/services/repoLabels'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import {
  loadRollbackTargetFrom,
  rollbackNodeRunWorktrees,
  type RollbackOutcome,
} from '@/services/nodeRollback'
import { selectSyncRollbackTargets } from '@/services/task'
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/util/errors'
import { createLogger } from '@/util/log'
import { killStaleRunProcessTree } from '@/util/process'
import {
  deleteSnapshotRefs,
  gitDiffSnapshot,
  isGitWorkTree,
  removeWorktree,
  worktreeDiff,
} from '@/util/git'
import { Paths } from '@/util/paths'

const log = createLogger('task-execution.postgresql-task-routes')

const TASK_DIFF_MAX_BYTES = 1024 * 1024
const STDOUT_TAIL_BUDGET_BYTES = 1024 * 1024
const STDOUT_TAIL_ROW_CAP = 50_000
const STDOUT_OMITTED_MARKER = '[… earlier output omitted: this view shows the most recent 1 MiB …]'
const RETRYABLE_TASK_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
  'awaiting_review',
  'awaiting_human',
] as const satisfies readonly TaskStatus[]

export interface TaskRouteUserDirectory {
  lookup(ids: readonly string[]): Promise<readonly UserPublic[]>
}

export interface TaskRouteMembershipEvents {
  committed(
    input: Readonly<{
      taskId: string
      previousOwnerUserId: string | null
      ownerUserId: string | null
      previousMemberUserIds: readonly string[]
      memberUserIds: readonly string[]
    }>,
  ): Promise<void>
}

export interface TaskRouteDeletionEvents {
  committed(
    input: Readonly<{
      taskIds: readonly string[]
      visibleUserIdsByTask: ReadonlyMap<string, ReadonlySet<string>>
    }>,
  ): Promise<void>
}

export interface PostgresqlTaskRouteOperationsDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly collaboration: CollaborationCommandContext
  readonly launch: Omit<PostgresqlTaskRouteLaunchDependencies, 'db'>
  readonly persistence: TaskExecutionPersistence
  readonly children: ChildTaskLifecycleParticipant
  readonly activity: ActiveTaskExecutionParticipant
  readonly topology: SchedulerRuntimeTopology
  readonly resumeRuntimeFor: (actor: Actor, taskId: string) => ChildResumeRuntime
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
  readonly users: TaskRouteUserDirectory
  readonly owners: OwnerIdentityQueries
  readonly membershipEvents: TaskRouteMembershipEvents
  readonly deletionEvents: TaskRouteDeletionEvents
  /** Closed Collaboration facts used by the TaskExecution-owned repair engine. */
  readonly repair: Readonly<{
    readonly collaborationRuntime: CollaborationRuntimeMechanics
    readonly clarify: ClarifyRepairParticipant
    readonly review: ReviewRepairParticipant
  }>
  readonly appHome?: string
  readonly now?: () => number
  readonly id?: () => string
}

type TaskRow = typeof tasks.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

function parseJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function parseStringRecord(raw: string): Record<string, string> {
  const parsed = parseJson(raw, {})
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function frozenWorkgroupField(raw: string | null, key: 'workgroupName' | 'goal'): string | null {
  const value = parseJson(raw, null)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const selected = Reflect.get(value, key)
  return typeof selected === 'string' && selected.length > 0 ? selected : null
}

function minimalNodePaths(mountPaths: readonly string[]): readonly string[] {
  const paths = new Map<string, string>([['', '']])
  for (const mountPath of mountPaths) {
    let current = ''
    for (const segment of mountPath.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      paths.set(current.toLowerCase(), current)
    }
  }
  return [...paths.values()].sort(
    (left, right) => mountDepth(left) - mountDepth(right) || left.localeCompare(right),
  )
}

function repoProjection(row: typeof taskRepos.$inferSelect): TaskRepo {
  return {
    repoIndex: row.repoIndex,
    repoPath: row.repoPath,
    repoUrl: row.repoUrl === null ? null : redactGitUrl(row.repoUrl),
    cachedRepoId: row.cachedRepoId ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
    worktreeDirName: row.worktreeDirName,
    mountPath: row.mountPath,
    subdir: row.subdir,
    readonly: row.readonly,
    readonlyDirtyCount: row.readonlyDirtyCount ?? null,
    hasSubmodules: row.hasSubmodules ?? null,
    submoduleInitOk: row.submoduleInitOk ?? null,
    submoduleInitError: row.submoduleInitError ?? null,
  }
}

function fallbackRepo(row: TaskRow): TaskRepo {
  return {
    repoIndex: 0,
    repoPath: row.repoPath,
    repoUrl: row.repoUrl === null ? null : redactGitUrl(row.repoUrl),
    cachedRepoId: row.cachedRepoId ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
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

async function failedCode(
  db: PostgresqlDatabaseClient,
  task: Pick<TaskRow, 'id' | 'status' | 'failedNodeId'>,
): Promise<string | null | undefined> {
  if (task.status !== 'failed' || task.failedNodeId === null) return undefined
  const rows = await db
    .select({
      id: nodeRuns.id,
      parentNodeRunId: nodeRuns.parentNodeRunId,
      failureCode: nodeRuns.failureCode,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, task.failedNodeId)))
    .orderBy(desc(nodeRuns.id))
  return rows.find((row) => row.parentNodeRunId === null)?.failureCode ?? null
}

/**
 * RFC-359 W7 —— 任务引用的工作流行（`name` / `builtin`）。
 *
 * 这两列**不是**装饰：`Task.workflowName` 是详情页、任务列表、sync 预览横幅显示的工作流名，
 * `builtin` 决定 `projectWorkflowSnapshotForRead` 要不要给框架内置宿主快照重新排版。此前这里
 * 恒写 `null` / 不排版，于是 PostgreSQL 部署上工作流名**永远空白**、agent / 工作组宿主任务的
 * 画布拿到的是未排版快照——而 SQLite 侧 `services/task.ts` 的 `getTask` 一直是
 * `leftJoin(workflows)` 取这两列的。`leftJoin` 语义保留：工作流已删（RFC-285 软链）时回 null，
 * 详情页照常渲染悬空引用。
 */
async function workflowIdentities(
  db: PostgresqlDatabaseClient,
  workflowIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{ name: string; builtin: boolean }>>> {
  const wanted = [...new Set(workflowIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, builtin: workflows.builtin })
    .from(workflows)
    .where(inArray(workflows.id, wanted))
  return new Map(rows.map((row) => [row.id, { name: row.name, builtin: row.builtin === true }]))
}

/**
 * RFC-359 W7（判据缺口账本 01a / 01b）—— 内置工作流只读锁要判的那一行。
 *
 * SQLite 侧 `assertManualExecutionAllowed` / `assertTaskSyncable` 都会
 * `assertNotBuiltin('workflow', workflow)`，PostgreSQL 侧两处都没有：同一个内置工作流在 PG
 * 部署上可被手动执行、可被 sync，在 SQLite 上是 403 `builtin-readonly`。判据只需要
 * `workflows.builtin`，而 `TaskExecutionWorkflowSnapshot` 不带这一列，所以按 SQLite 的
 * `getWorkflow` 同款直接读行；行不存在（工作流已删，RFC-285 软链）时回 null，调用方与
 * SQLite 一致地不拦。
 */
async function builtinCandidateWorkflow(
  db: PostgresqlDatabaseClient,
  workflowId: string,
): Promise<Readonly<{ builtin: boolean }> | null> {
  return (await workflowIdentities(db, [workflowId])).get(workflowId) ?? null
}

async function taskProjection(db: PostgresqlDatabaseClient, row: TaskRow): Promise<Task> {
  const [repoRows, nodeRows, failureCode, identities] = await Promise.all([
    db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.taskId, row.id))
      .orderBy(asc(taskRepos.repoIndex)),
    db
      .select({ path: taskSpaceNodes.nodePath })
      .from(taskSpaceNodes)
      .where(eq(taskSpaceNodes.taskId, row.id)),
    failedCode(db, row),
    workflowIdentities(db, [row.workflowId]),
  ])
  const identity = identities.get(row.workflowId)
  const repos = repoRows.length > 0 ? repoRows.map(repoProjection) : [fallbackRepo(row)]
  const nodePaths =
    nodeRows.length > 0
      ? nodeRows
          .map((node) => node.path)
          .sort((left, right) => mountDepth(left) - mountDepth(right) || left.localeCompare(right))
      : minimalNodePaths(repos.map((repo) => repo.mountPath))
  const trigger = parseTriggerContextJson(row.triggerContextJson)
  const sourceLink = trigger.kind === 'ok' ? webhookTaskSourceLinkOf(trigger.value) : null
  return TaskSchema.parse({
    id: row.id,
    name: row.name,
    workflowId: row.workflowId,
    workflowName: identity?.name ?? null,
    workflowSnapshot: projectWorkflowSnapshotForRead(
      parseJson(row.workflowSnapshot, null),
      identity?.builtin === true,
    ),
    workflowVersion: row.workflowVersion ?? null,
    repoPath: row.repoPath,
    repoUrl: row.repoUrl === null ? null : redactGitUrl(row.repoUrl),
    cachedRepoId: row.cachedRepoId ?? null,
    worktreePath: row.worktreePath,
    workspaceState:
      row.workspacePrunedAt !== null
        ? 'pruned'
        : row.workspacePruningAt !== null
          ? 'pruning'
          : 'available',
    baseBranch: row.baseBranch,
    branch: row.branch,
    workingBranch: row.workingBranch ?? null,
    autoCommitPush: row.autoCommitPush,
    baseCommit: row.baseCommit,
    status: row.status,
    inputs: parseStringRecord(row.inputs),
    maxDurationMs: row.maxDurationMs,
    maxTotalTokens: row.maxTotalTokens,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    errorMessage: row.errorMessage,
    ...(failureCode === undefined ? {} : { failureCode }),
    failedNodeId: row.failedNodeId,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    schemaVersion: row.schemaVersion,
    gitUserName: row.gitUserName ?? null,
    gitUserEmail: row.gitUserEmail ?? null,
    repoCount: row.repoCount,
    repos,
    spaceNodes: nodePaths.map((path) => ({ path, origins: [] })),
    repoGroupId: row.repoGroupId ?? null,
    repoGroupName: row.repoGroupName ?? null,
    scheduledTaskId: row.scheduledTaskId ?? null,
    workgroupId: row.workgroupId ?? null,
    workgroupName: frozenWorkgroupField(row.workgroupConfigJson, 'workgroupName'),
    goal: frozenWorkgroupField(row.workgroupConfigJson, 'goal'),
    sourceAgentId: row.sourceAgentId ?? null,
    spaceKind: row.spaceKind,
    parentTaskId: row.parentTaskId ?? null,
    parentNodeRunId: row.parentNodeRunId ?? null,
    invocationDepth: row.invocationDepth ?? 0,
    sourceAgentName: row.sourceAgentName ?? null,
    codeRoundId: row.codeRoundId ?? null,
    digitalEmployeeCaseId: row.digitalEmployeeCaseId ?? null,
    webhookSourceLink: sourceLink,
  })
}

async function loadTask(db: PostgresqlDatabaseClient, taskId: string): Promise<Task | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  return rows[0] === undefined ? null : await taskProjection(db, rows[0])
}

async function requireTaskRow(db: PostgresqlDatabaseClient, taskId: string): Promise<TaskRow> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const row = rows[0]
  if (row === undefined) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  return row
}

function summaryProjection(
  row: TaskListRow,
  openAlertCount: number,
  failureCode: string | null | undefined,
  workflowName: string | null,
): TaskSummary {
  return TaskSummarySchema.parse({
    id: row.id,
    name: row.name,
    workflowId: row.workflowId,
    workflowName,
    repoPath: row.repoPath,
    repoUrl: row.repoUrl === null ? null : redactGitUrl(row.repoUrl),
    cachedRepoId: row.cachedRepoId ?? null,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    ...(failureCode === undefined ? {} : { failureCode }),
    repoCount: row.repoCount,
    openAlertCount,
    scheduledTaskId: row.scheduledTaskId ?? null,
    workgroupId: row.workgroupId ?? null,
    workgroupName: frozenWorkgroupField(row.workgroupConfigJson, 'workgroupName'),
    spaceKind: row.spaceKind,
    parentTaskId: row.parentTaskId ?? null,
    invocationDepth: row.invocationDepth ?? 0,
    sourceAgentName: row.sourceAgentName ?? null,
    sourceAgentId: row.sourceAgentId ?? null,
    codeRoundId: row.codeRoundId ?? null,
  })
}

function visibilityCondition(
  db: PostgresqlDatabaseClient,
  visibility: NonNullable<TaskRouteListFilters['visibility']>,
): SQL<unknown> {
  const memberIds = db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, visibility.actorUserId))
  if (visibility.scope === 'shared') {
    return and(
      inArray(tasks.id, memberIds),
      sql`${tasks.ownerUserId} IS DISTINCT FROM ${visibility.actorUserId}`,
    )!
  }
  return or(eq(tasks.ownerUserId, visibility.actorUserId), inArray(tasks.id, memberIds))!
}

/**
 * RFC-357 —— `/api/tasks` 列表只投这些列。
 *
 * 之前是裸 `db.select()`（全列），于是每次列表请求都把 `workflow_snapshot`（整份工作流
 * 定义 JSON）、`inputs`、`error_message`、`trigger_context_json` 一起搬过来，而
 * `summaryProjection` 一个都不读。RFC-311 audit L1-8 在 SQLite 侧修掉的是同一个形状，
 * 注释里记着「每行上百 KB」（`services/task.ts` 的 `listTaskSummaryRows`）；PostgreSQL
 * 适配器把它原样重新引入了一遍。列清单 = `summaryProjection` 消费的那些，加上函数体自己
 * 要用的 `failedNodeId` / `ownerUserId`。
 */
const TASK_LIST_COLUMNS = {
  id: tasks.id,
  name: tasks.name,
  workflowId: tasks.workflowId,
  repoPath: tasks.repoPath,
  repoUrl: tasks.repoUrl,
  cachedRepoId: tasks.cachedRepoId,
  status: tasks.status,
  startedAt: tasks.startedAt,
  finishedAt: tasks.finishedAt,
  errorSummary: tasks.errorSummary,
  repoCount: tasks.repoCount,
  scheduledTaskId: tasks.scheduledTaskId,
  workgroupId: tasks.workgroupId,
  workgroupConfigJson: tasks.workgroupConfigJson,
  spaceKind: tasks.spaceKind,
  parentTaskId: tasks.parentTaskId,
  invocationDepth: tasks.invocationDepth,
  sourceAgentName: tasks.sourceAgentName,
  sourceAgentId: tasks.sourceAgentId,
  codeRoundId: tasks.codeRoundId,
  failedNodeId: tasks.failedNodeId,
  ownerUserId: tasks.ownerUserId,
} as const

type TaskListRow = {
  [K in keyof typeof TASK_LIST_COLUMNS]: (typeof tasks.$inferSelect)[K]
}

async function listRows(
  db: PostgresqlDatabaseClient,
  filters: TaskRouteListFilters,
): Promise<readonly TaskListRow[]> {
  const predicates: SQL<unknown>[] = []
  if (filters.status !== undefined) predicates.push(eq(tasks.status, filters.status))
  if (filters.workflowId !== undefined) predicates.push(eq(tasks.workflowId, filters.workflowId))
  if (filters.repoPath !== undefined) predicates.push(eq(tasks.repoPath, filters.repoPath))
  if (filters.catalogVisibility !== undefined) {
    predicates.push(eq(tasks.catalogVisibility, filters.catalogVisibility))
  }
  if (filters.scheduledTaskId !== undefined) {
    predicates.push(eq(tasks.scheduledTaskId, filters.scheduledTaskId))
  }
  if (filters.origin !== undefined) {
    const origins = taskListOriginMatches(filters.origin)
    if (origins !== null) predicates.push(inArray(tasks.launchOrigin, origins))
  }
  if (filters.topLevelOnly === true) predicates.push(isNull(tasks.parentTaskId))
  if (filters.parentTaskId !== undefined)
    predicates.push(eq(tasks.parentTaskId, filters.parentTaskId))
  if (filters.visibility !== undefined) predicates.push(visibilityCondition(db, filters.visibility))
  return await db
    .select(TASK_LIST_COLUMNS)
    .from(tasks)
    .where(predicates.length === 0 ? undefined : and(...predicates))
    .orderBy(desc(tasks.startedAt))
    .limit(filters.limit ?? 100)
}

async function listSummaries(
  db: PostgresqlDatabaseClient,
  filters: TaskRouteListFilters,
): Promise<readonly Readonly<{ summary: TaskSummary; ownerUserId: string | null }>[]> {
  const rows = await listRows(db, filters)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const alertRows = await db
    .select({ taskId: lifecycleAlerts.taskId, value: count() })
    .from(lifecycleAlerts)
    .where(and(inArray(lifecycleAlerts.taskId, ids), isNull(lifecycleAlerts.resolvedAt)))
    .groupBy(lifecycleAlerts.taskId)
  const alerts = new Map(alertRows.map((row) => [row.taskId, Number(row.value)]))
  // RFC-357：一次批量，不是每个失败任务一次。`failedCode` 逐行发 `SELECT … FROM node_runs`
  // 的形状在 10k 上界的列表上就是 N+1；`loadTaskFailureCodes` 的函数体只有一次批量查询加
  // 一个纯函数挑选，两个 provider 共用。
  const failureCodes = await loadTaskFailureCodes(db, rows)
  // RFC-359 W7：列表行的工作流名与详情页同源（SQLite 侧是 `leftJoin(workflows)`）。
  // 一次批量，不是每行一次——列表上界 10k。
  const identities = await workflowIdentities(
    db,
    rows.map((row) => row.workflowId),
  )
  return rows.map((row) => ({
    summary: summaryProjection(
      row,
      alerts.get(row.id) ?? 0,
      failureCodes.has(row.id) ? (failureCodes.get(row.id) ?? null) : undefined,
      identities.get(row.workflowId)?.name ?? null,
    ),
    ownerUserId: row.ownerUserId ?? null,
  }))
}

async function listItems(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  filters: TaskRouteListFilters,
): Promise<readonly TaskListItem[]> {
  const rows = await listSummaries(dependencies.db, filters)
  if (rows.length === 0) return []
  const ownerIds = rows.map((row) => row.ownerUserId)
  const owners = await dependencies.owners.loadOwnerIdentities(ownerIds)
  const parentIds = rows.map((row) => row.summary.id)
  const childPredicates: SQL<unknown>[] = [inArray(tasks.parentTaskId, parentIds)]
  if (filters.visibility !== undefined) {
    childPredicates.push(visibilityCondition(dependencies.db, filters.visibility))
  }
  if (filters.catalogVisibility !== undefined) {
    childPredicates.push(eq(tasks.catalogVisibility, filters.catalogVisibility))
  }
  const childRows = await dependencies.db
    .select({ parentTaskId: tasks.parentTaskId, value: count() })
    .from(tasks)
    .where(and(...childPredicates))
    .groupBy(tasks.parentTaskId)
  const children = new Map(
    childRows.flatMap((row) =>
      row.parentTaskId === null ? [] : [[row.parentTaskId, Number(row.value)] as const],
    ),
  )
  return rows.map((row) =>
    TaskListItemSchema.parse({
      ...row.summary,
      ownerUserId: row.ownerUserId,
      owner: row.ownerUserId === null ? null : (owners.get(row.ownerUserId) ?? null),
      childCount: children.get(row.summary.id) ?? 0,
    }),
  )
}

function canManageMembers(actor: Actor, ownerUserId: string | null): boolean {
  return actor.permissions.has('resource-acl:bypass') || ownerUserId === actor.user.id
}

async function actingMember(
  db: PostgresqlDatabaseClient,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
  return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
}

async function taskMembers(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  actor: Actor,
  taskId: string,
): Promise<TaskMembers> {
  const task = await requireTaskRow(dependencies.db, taskId)
  const memberships = await dependencies.db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const memberRows = memberships.filter(
    (row): row is { userId: string; role: AssignableTaskMemberRole } =>
      row.role === 'collaborator' || row.role === 'observer',
  )
  const userIds = [
    ...(task.ownerUserId === null || task.ownerUserId === SYSTEM_USER_ID ? [] : [task.ownerUserId]),
    ...memberRows.map((row) => row.userId),
  ]
  const users = await dependencies.users.lookup([...new Set(userIds)])
  const byId = new Map(users.map((user) => [user.id, user]))
  const canManage = canManageMembers(actor, task.ownerUserId)
  return {
    taskId,
    ownerUserId: task.ownerUserId,
    owner: task.ownerUserId === null ? null : (byId.get(task.ownerUserId) ?? null),
    members: memberRows.flatMap((row) => {
      const user = byId.get(row.userId)
      return user === undefined ? [] : [{ user, role: row.role }]
    }),
    canManage,
    canOperate:
      canManage ||
      memberRows.some((row) => row.userId === actor.user.id && row.role === 'collaborator'),
  }
}

function planMembers(input: {
  readonly previousOwnerUserId: string | null
  readonly ownerUserId: string | undefined
  readonly requested:
    | readonly Readonly<{ readonly userId: string; readonly role: AssignableTaskMemberRole }>[]
    | undefined
  readonly current: readonly Readonly<{
    readonly userId: string
    readonly role: AssignableTaskMemberRole
  }>[]
}): Readonly<{
  ownerUserId: string | null
  members: ReadonlyMap<string, AssignableTaskMemberRole>
}> {
  const ownerUserId = input.ownerUserId ?? input.previousOwnerUserId
  const members = new Map(
    (input.requested ?? input.current).map((member) => [member.userId, member.role] as const),
  )
  if (
    ownerUserId !== input.previousOwnerUserId &&
    input.previousOwnerUserId !== null &&
    input.previousOwnerUserId !== SYSTEM_USER_ID &&
    !members.has(input.previousOwnerUserId)
  ) {
    members.set(input.previousOwnerUserId, 'collaborator')
  }
  if (ownerUserId !== null) members.delete(ownerUserId)
  return { ownerUserId, members }
}

async function replaceTaskMembers(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  actor: Actor,
  taskId: string,
  body: Parameters<TaskRouteOperations['replaceMembers']>[2],
): Promise<TaskMembers> {
  const referenced = new Set(body.members?.map((member) => member.userId) ?? [])
  if (body.ownerUserId !== undefined) referenced.add(body.ownerUserId)
  const referencedUsers = await dependencies.users.lookup([...referenced])
  const activeIds = new Set(
    referencedUsers.filter((user) => user.status === 'active').map((user) => user.id),
  )
  const invalid = [...referenced].filter((id) => id === SYSTEM_USER_ID || !activeIds.has(id))
  if (invalid.length > 0) {
    throw new ValidationError('members-user-invalid', 'referenced user(s) not active', {
      userIds: invalid,
    })
  }

  // RFC-349 —— 成员替换的不变量是**每任务**的：读的 owner 与 collaborators 都属于同一个
  // 任务。SERIALIZABLE 在这种「读一批 → delete 同一批 → insert 回去」的形状上会因为
  // predicate lock 落在索引**页**而不是行，把改不同任务的事务也判成读写依赖（实测 32 并发
  // 下 22.9% 冲突率，逃逸成 500）。锁住聚合根即可，判据见
  // `withPostgresqlTaskAggregateTransaction` 的适用条件。
  const committed = await withPostgresqlTaskAggregateTransaction(
    dependencies.db,
    taskId,
    async (tx) => {
      const taskRows = await tx
        .select({ ownerUserId: tasks.ownerUserId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
      if (!canManageMembers(actor, task.ownerUserId)) {
        throw new ForbiddenError(
          'forbidden',
          'only the task owner or an actor with resource-acl:bypass can manage members',
        )
      }
      const previousRows = await tx
        .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
        .from(taskCollaborators)
        .where(eq(taskCollaborators.taskId, taskId))
      const current = previousRows.flatMap((row) =>
        row.role === 'collaborator' || row.role === 'observer'
          ? [{ userId: row.userId, role: row.role }]
          : [],
      )
      const planned = planMembers({
        previousOwnerUserId: task.ownerUserId,
        ownerUserId: body.ownerUserId,
        requested: body.members,
        current,
      })
      if (planned.ownerUserId !== task.ownerUserId) {
        await tx
          .update(tasks)
          .set({ ownerUserId: planned.ownerUserId })
          .where(eq(tasks.id, taskId))
          .run()
      }
      await tx.delete(taskCollaborators).where(eq(taskCollaborators.taskId, taskId)).run()
      const values: (typeof taskCollaborators.$inferInsert)[] = []
      if (planned.ownerUserId !== null) {
        values.push({
          taskId,
          userId: planned.ownerUserId,
          role: 'owner',
          addedBy: actor.user.id,
          addedAt: dependencies.now?.() ?? Date.now(),
        })
      }
      for (const [userId, role] of planned.members) {
        values.push({
          taskId,
          userId,
          role,
          addedBy: actor.user.id,
          addedAt: dependencies.now?.() ?? Date.now(),
        })
      }
      if (values.length > 0) await tx.insert(taskCollaborators).values(values).run()
      return {
        previousOwnerUserId: task.ownerUserId,
        ownerUserId: planned.ownerUserId,
        previousMemberUserIds: previousRows.map((row) => row.userId),
        memberUserIds: [...planned.members.keys()],
      }
    },
  )
  await dependencies.membershipEvents.committed({ taskId, ...committed })
  return await taskMembers(dependencies, actor, taskId)
}

function workflowLaunchSnapshot(snapshots: readonly FrozenTaskExecutionResourceSnapshot[]) {
  const snapshot = snapshots[0]
  if (snapshot?.kind !== 'workflow-launch') {
    throw new Error('task-execution-resource-kind-mismatch:workflow-launch')
  }
  return snapshot.workflow
}

async function launchMultipart(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  request: Request,
  actor: Actor,
): Promise<Task> {
  const parsedMultipart = await parseMultipartLaunch(request)
  const payload = parsedMultipart.payloadJson
  if (
    typeof payload === 'object' &&
    payload !== null &&
    Object.prototype.hasOwnProperty.call(payload, 'assignments')
  ) {
    throw new ValidationError(
      'assignments-removed',
      'RFC-099 removed per-node assignments; task members answer reviews/clarifications now',
    )
  }
  const retired = rejectRetiredStartTaskKeys(payload)
  if (retired !== null) {
    const clientOwnedGitIdentity = retired === 'gitUserName' || retired === 'gitUserEmail'
    throw new ValidationError(
      clientOwnedGitIdentity ? 'task-git-identity-client-owned' : 'start-task-path-retired',
      clientOwnedGitIdentity
        ? `RFC-320 derives Git commit identity from the task creator; remove '${retired}'`
        : `RFC-165 retired path-mode launches; remove '${retired}'`,
    )
  }
  const task = StartTaskSchema.safeParse(payload)
  if (!task.success) {
    throw new ValidationError('task-invalid', 'invalid task payload', {
      issues: task.error.issues,
    })
  }
  const authority = dependencies.launch.resourceAuthorityFor(actor)
  if (task.data.sourceTaskId !== undefined) {
    const visible = await createTaskAuthorizationQueries(dependencies.db).canViewTask({
      subject: {
        userId: actor.user.id,
        canReadAllTasks: actor.permissions.has('tasks:read:all'),
      },
      taskId: task.data.sourceTaskId,
    })
    if (!visible) {
      throw new NotFoundError('task-not-found', `task ${task.data.sourceTaskId} not found`)
    }
  }
  const workflow = workflowLaunchSnapshot(
    await authority.resources.loadAuthorized(authority, [
      { kind: 'workflow-launch', workflowId: task.data.workflowId },
    ]),
  )
  if (
    task.data.expectedWorkflowVersion !== undefined &&
    workflow.version !== task.data.expectedWorkflowVersion
  ) {
    throw new ConflictError(
      'workflow-version-mismatch',
      `workflow '${workflow.id}' changed during launch`,
      {
        expectedVersion: task.data.expectedWorkflowVersion,
        currentVersion: workflow.version,
      },
    )
  }
  const validation = await dependencies.launch.agent.resources.validateHostWorkflow(
    workflow.definition,
  )
  const errors = validation.issues.filter((issue) => (issue.severity ?? 'error') === 'error')
  if (!validation.ok && errors.length > 0) {
    throw new ValidationError(
      'workflow-invalid',
      `workflow '${workflow.id}' failed static validation`,
      { issues: validation.issues },
    )
  }
  assertWorkflowLaunchInputs(workflow.definition.inputs, task.data.inputs, {
    ignoreUploadInputs: true,
  })
  return await createPostgresqlRootTaskLaunchKernel({
    db: dependencies.db,
    ...dependencies.launch,
  }).launch({
    actor,
    resourceAuthority: authority,
    invoker: { type: 'user', launchKind: 'direct-multipart' },
    task: task.data,
    subject: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      workflowSnapshot: workflow.definition,
    },
    uploads: {
      parts: parsedMultipart.parts,
      definitions: collectUploadInputDefs(workflow.definition.inputs),
      limits: resolveUploadLimits(dependencies.launch.configPath),
    },
  })
}

function commitPush(raw: string | null) {
  const value = parseJson(raw, null)
  const parsed = CommitPushMetaSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

async function taskNodeRuns(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  taskId: string,
) {
  const task = await loadTask(dependencies.db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  const [runRows, versions, rounds] = await Promise.all([
    dependencies.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      // 还没开始的 run（started_at IS NULL）要排在最前：两个引擎的默认落位正好相反，
      // NULL 掉到队尾会让时间线把「还没开始」排在「已完成」后面。渲染权在能力矩阵。
      .orderBy(engineOf(dependencies.db).ascNullsFirst(nodeRuns.startedAt), asc(nodeRuns.id)),
    dependencies.db
      .select({
        reviewNodeRunId: docVersions.reviewNodeRunId,
        createdAt: docVersions.createdAt,
        versionIndex: docVersions.versionIndex,
        decision: docVersions.decision,
        decidedAt: docVersions.decidedAt,
        decidedBy: docVersions.decidedBy,
        itemIndex: docVersions.itemIndex,
        roundGeneration: docVersions.roundGeneration,
        reviewIteration: docVersions.reviewIteration,
      })
      .from(docVersions)
      .where(eq(docVersions.taskId, taskId)),
    dependencies.db
      .select({
        intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
        status: clarifyRounds.status,
        createdAt: clarifyRounds.createdAt,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.taskId, taskId)),
  ])
  const versionsByRun = new Map<string, typeof versions>()
  for (const version of versions) {
    const existing = versionsByRun.get(version.reviewNodeRunId)
    if (existing === undefined) versionsByRun.set(version.reviewNodeRunId, [version])
    else existing.push(version)
  }
  const latestRoundByRun = new Map<string, (typeof rounds)[number]>()
  for (const round of rounds) {
    const previous = latestRoundByRun.get(round.intermediaryNodeRunId)
    if (previous === undefined || previous.createdAt < round.createdAt) {
      latestRoundByRun.set(round.intermediaryNodeRunId, round)
    }
  }
  const runs: NodeRun[] = runRows.map((row) => {
    const runVersions = versionsByRun.get(row.id) ?? []
    const timing = deriveReviewRoundTiming(row, runVersions)
    const currentRound = selectCurrentReviewRound(runVersions)
    let reviewNavKind: 'awaiting' | 'decided' | null = null
    if (currentRound !== null) {
      if (row.status === 'awaiting_review' && currentRound.representative.decision === 'pending') {
        reviewNavKind = 'awaiting'
      } else if (isHumanReviewConclusion(currentRound.representative)) {
        reviewNavKind = 'decided'
      }
    }
    let clarifyNavKind = clarifyNavKindForRoundStatus(latestRoundByRun.get(row.id)?.status)
    if (clarifyNavKind === 'awaiting' && (task.status === 'canceled' || task.status === 'failed')) {
      clarifyNavKind = null
    }
    return NodeRunSchema.parse({
      id: row.id,
      taskId: row.taskId,
      nodeId: row.nodeId,
      parentNodeRunId: row.parentNodeRunId,
      iteration: row.iteration,
      shardKey: row.shardKey,
      retryIndex: row.retryIndex,
      wgRound: row.wgRound ?? null,
      rerunCause: row.rerunCause ?? null,
      reviewIteration: row.reviewIteration,
      // RFC-354 — the frame (generation row + breadcrumb) for grouping / labels.
      containerRunId: row.containerRunId ?? null,
      scopePath: row.scopePath ?? '',
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      pid: row.pid,
      exitCode: row.exitCode,
      errorMessage: row.errorMessage,
      failureCode: row.failureCode ?? null,
      childTaskId: row.childTaskId ?? null,
      supersededByReview: row.supersededByReview ?? null,
      rolledBack: row.rolledBack ?? null,
      promptText: readNodeRunPrompt(row),
      tokInput: row.tokInput,
      tokOutput: row.tokOutput,
      tokTotal: row.tokTotal,
      tokCacheCreate: row.tokCacheCreate,
      tokCacheRead: row.tokCacheRead,
      opencodeSessionId: row.opencodeSessionId,
      injectedMemories: parseInjectedSnapshotJson(row.injectedMemoriesJson),
      portValidationFailures: parsePortValidationFailuresJson(row.portValidationFailuresJson),
      commitPush: commitPush(row.commitPushJson),
      reviewRoundStartedAt: timing?.roundStartedAt ?? null,
      reviewDecidedAt: timing?.decidedAt ?? null,
      reviewNavKind,
      clarifyNavKind,
    })
  })
  // RFC-078 —— 评审行的时间线锚是它这一轮**内容**的时间，不是槽位首次打开时钉住的
  // `started_at`；没有这次重排，评审行会排在它所评审的产物**之前**。SQLite 侧
  // `services/task.ts:getTaskNodeRuns` 一直做这一步（`runs.sort(compareNodeRunsForTimeline)`）。
  runs.sort(compareNodeRunsForTimeline)
  const outputRows =
    runs.length === 0
      ? []
      : await dependencies.db
          .select()
          .from(nodeRunOutputs)
          .where(
            inArray(
              nodeRunOutputs.nodeRunId,
              runs.map((run) => run.id),
            ),
          )
  const branchTrace = await branchTraceForTask(
    new DrizzleBranchTraceSnapshotReader(dependencies.db),
    taskId,
  )
  return {
    runs,
    outputs: outputRows.map((row) => ({
      nodeRunId: row.nodeRunId,
      port: row.portName,
      value: row.content,
      kind: row.kind,
      ...(row.active === false ? { active: false } : {}),
    })),
    ...(branchTrace === undefined ? {} : { branchTrace }),
  }
}

async function assertNodeRunOwner(
  db: PostgresqlDatabaseClient,
  taskId: string,
  nodeRunId: string,
): Promise<void> {
  const rows = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  if (rows[0]?.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
}

async function nodeRunEventsPage(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  taskId: string,
  nodeRunId: string,
  options: Readonly<{ since?: number; limit?: number }>,
) {
  await assertNodeRunOwner(dependencies.db, taskId, nodeRunId)
  const since = options.since ?? 0
  // RFC-359 W7：分页口径与 SQLite 同一份契约（缺省 500 / 上限 1000）。此前 PG 是
  // 1000 / 5000，于是同一个 `GET /api/tasks/:id/runs/:runId/events` 在两种部署上回不同
  // 条数——前端的游标推进逻辑按条数判「还有没有下一页」，两侧不能各说各话。
  const limit = Math.min(options.limit ?? 500, 1000)
  const archived = await readArchivedEvents(Paths.logsDir, taskId, nodeRunId, since, limit)
  const events = archived.map((event) => ({
    id: event.id,
    nodeRunId,
    ts: event.ts,
    kind: event.kind,
    payload: parseJson(event.payload, event.payload),
  }))
  const remaining = limit - events.length
  if (remaining > 0) {
    const lowerBound = events.at(-1)?.id ?? since
    const rows = await dependencies.db
      .select()
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), gt(nodeRunEvents.id, lowerBound)))
      .orderBy(asc(nodeRunEvents.id))
      .limit(remaining)
    events.push(
      ...rows.map((row) => ({
        id: row.id,
        nodeRunId: row.nodeRunId,
        ts: row.ts,
        kind: row.kind,
        payload: parseJson(row.payload, row.payload),
      })),
    )
  }
  return NodeRunEventsResponseSchema.parse({ events, cursor: events.at(-1)?.id ?? null })
}

async function nodeRunStdout(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  taskId: string,
  nodeRunId: string,
): Promise<string> {
  await assertNodeRunOwner(dependencies.db, taskId, nodeRunId)
  const tail: string[] = []
  let bytes = 0
  let omitted = false
  const push = (value: string): boolean => {
    const size = Buffer.byteLength(value, 'utf8') + 1
    if (bytes + size > STDOUT_TAIL_BUDGET_BYTES) return false
    tail.push(value)
    bytes += size
    return true
  }
  const rows = await dependencies.db
    .select({ payload: nodeRunEvents.payload, kind: nodeRunEvents.kind })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(desc(nodeRunEvents.id))
    .limit(STDOUT_TAIL_ROW_CAP + 1)
  const capped = rows.length > STDOUT_TAIL_ROW_CAP
  for (const row of capped ? rows.slice(0, STDOUT_TAIL_ROW_CAP) : rows) {
    if (row.kind === 'stderr') continue
    if (!push(row.payload)) {
      omitted = true
      break
    }
  }
  if (capped) omitted = true
  if (!omitted) {
    const archived = await readArchivedEvents(
      Paths.logsDir,
      taskId,
      nodeRunId,
      0,
      STDOUT_TAIL_ROW_CAP + 1,
    )
    if (archived.length > STDOUT_TAIL_ROW_CAP) {
      omitted = true
    } else {
      for (let index = archived.length - 1; index >= 0; index -= 1) {
        const row = archived[index]!
        if (row.kind === 'stderr') continue
        if (!push(row.payload)) {
          omitted = true
          break
        }
      }
    }
  }
  tail.reverse()
  const body = tail.join('\n')
  return omitted ? `${STDOUT_OMITTED_MARKER}\n${body}` : body
}

async function taskDiff(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  taskId: string,
): Promise<TaskDiff> {
  const task = await loadTask(dependencies.db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  if (task.repoCount === 1) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute diff`,
        409,
      )
    }
    if (!(await isGitWorkTree(task.worktreePath))) {
      throw new DomainError(
        'task-worktree-missing',
        `worktree '${task.worktreePath}' is unavailable; cannot compute diff`,
        410,
      )
    }
    const result = await worktreeDiff(task.worktreePath, task.baseCommit)
    return { ...result, baseCommit: task.baseCommit }
  }
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
      410,
    )
  }
  // RFC-359 W7 —— 多仓任务一个可用 base commit 都没有时必须 409，而不是回一个空 diff。
  // SQLite 侧 `services/task.ts:getTaskDiff` 一直有这道门（`usable.length === 0`）：
  // 「没东西可比」与「比过了，没有改动」在用户面前是两件事，前者是准备阶段就失败的任务，
  // 静默回空 diff 会让人以为 agent 什么都没改。
  const usable: boolean[] = []
  for (const repo of task.repos) {
    usable.push(
      repo.baseCommit !== null &&
        repo.baseCommit !== '' &&
        existsSync(repo.worktreePath) &&
        (await isGitWorkTree(repo.worktreePath)),
    )
  }
  if (!usable.some(Boolean)) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute diff`,
      409,
    )
  }
  const labels = canonicalRepoKeysWire(task.repos)
  let diff = ''
  let truncated = false
  for (let index = 0; index < task.repos.length; index += 1) {
    const repo = task.repos[index]!
    // RFC-248 D11：只读成员不进任务 diff（可用性判据在上面，与 SQLite 同序）。
    if (repo.readonly || usable[index] !== true || repo.baseCommit === null) continue
    const value = await gitDiffSnapshot(repo.worktreePath, repo.baseCommit)
    if (value === '') continue
    const section = `# === Repo: ${labels[index] ?? '.'} ===\n${value}${value.endsWith('\n') ? '' : '\n'}`
    const remaining = TASK_DIFF_MAX_BYTES - Buffer.byteLength(diff, 'utf8')
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (Buffer.byteLength(section, 'utf8') > remaining) {
      diff += Buffer.from(section).subarray(0, remaining).toString('utf8')
      truncated = true
      break
    }
    diff += section
  }
  return { diff, baseCommit: null, truncated }
}

function notSyncable(task: Task, reason: WorkflowSyncPreview['reason']): WorkflowSyncPreview {
  return {
    syncable: false,
    reason,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    currentVersion: task.workflowVersion,
    latestVersion: null,
    differs: false,
    invalid: false,
    invalidIssues: [],
    diff: emptyWorkflowSyncDiff(),
  }
}

function definitionOf(value: unknown): WorkflowDefinition {
  return migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(value))
}

async function syncRunSummary(db: PostgresqlDatabaseClient, taskId: string) {
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const byNode = new Map<string, NodeRunRow[]>()
  for (const run of runs) {
    const existing = byNode.get(run.nodeId)
    if (existing === undefined) byNode.set(run.nodeId, [run])
    else existing.push(run)
  }
  const freshestDone = new Map<string, NodeRunRow>()
  for (const [nodeId, rows] of byNode) {
    const row = rows
      .filter((run) => run.parentNodeRunId === null && run.status === 'done')
      .sort((left, right) => right.id.localeCompare(left.id))[0]
    if (row !== undefined) freshestDone.set(nodeId, row)
  }
  const outputRows =
    freshestDone.size === 0
      ? []
      : await db
          .select({ nodeRunId: nodeRunOutputs.nodeRunId, portName: nodeRunOutputs.portName })
          .from(nodeRunOutputs)
          .where(
            inArray(
              nodeRunOutputs.nodeRunId,
              [...freshestDone.values()].map((row) => row.id),
            ),
          )
  const ports = new Map<string, Set<string>>()
  for (const output of outputRows) {
    const existing = ports.get(output.nodeRunId)
    if (existing === undefined) ports.set(output.nodeRunId, new Set([output.portName]))
    else existing.add(output.portName)
  }
  const summary = new Map<
    string,
    {
      hasCompletedRun: boolean
      producedPorts: ReadonlySet<string>
      hasLiveWrapperState: boolean
    }
  >()
  for (const [nodeId, rows] of byNode) {
    const done = freshestDone.get(nodeId)
    const ids = new Set(rows.map((row) => row.id))
    summary.set(nodeId, {
      hasCompletedRun: done !== undefined,
      producedPorts: done === undefined ? new Set() : (ports.get(done.id) ?? new Set()),
      hasLiveWrapperState: rows.some(
        (row) =>
          (row.parentNodeRunId === null &&
            row.wrapperProgressJson !== null &&
            !['done', 'failed', 'exhausted'].includes(row.status)) ||
          (row.parentNodeRunId !== null &&
            ids.has(row.parentNodeRunId) &&
            !['done', 'failed', 'canceled', 'interrupted', 'skipped', 'exhausted'].includes(
              row.status,
            )),
      ),
    })
  }
  return summary
}

async function loadVisibleWorkflow(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  actor: Actor,
  workflowId: string,
) {
  const authority = dependencies.launch.resourceAuthorityFor(actor)
  return {
    authority,
    workflow: workflowLaunchSnapshot(
      await authority.resources.loadAuthorized(authority, [
        { kind: 'workflow-launch', workflowId },
      ]),
    ),
  }
}

async function workflowSyncPreview(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  actor: Actor,
  taskId: string,
): Promise<WorkflowSyncPreview> {
  const task = await loadTask(dependencies.db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  if (taskExecutionKind(task) !== 'workflow') {
    return notSyncable(task, 'workflow-deleted')
  }
  await dependencies.activity.awaitReleasedSettled(taskId)
  if (dependencies.activity.isActive(taskId)) return notSyncable(task, 'task-active')
  let loaded: Awaited<ReturnType<typeof loadVisibleWorkflow>>
  try {
    loaded = await loadVisibleWorkflow(dependencies, actor, task.workflowId)
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? Reflect.get(error, 'code')
        : null
    return notSyncable(
      task,
      typeof code === 'string' && code.includes('forbidden')
        ? 'workflow-not-visible'
        : 'workflow-deleted',
    )
  }
  const closureIssues: { code: string; message: string }[] = []
  try {
    await loaded.authority.resources.freezeCallClosure(loaded.authority, {
      id: loaded.workflow.id,
      definition: loaded.workflow.definition,
    })
  } catch (error) {
    closureIssues.push({
      code:
        error !== null && typeof error === 'object' && 'code' in error
          ? String(Reflect.get(error, 'code'))
          : 'workflow-call-ref-missing',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const [runSummary, validation] = await Promise.all([
    syncRunSummary(dependencies.db, taskId),
    dependencies.launch.agent.resources.validateHostWorkflow(loaded.workflow.definition),
  ])
  const invalidIssues = [
    ...validation.issues
      .filter((issue) => (issue.severity ?? 'error') === 'error')
      .map((issue) => ({
        code: typeof issue['code'] === 'string' ? issue['code'] : 'workflow-invalid',
        message: issue.message,
      })),
    ...closureIssues,
  ]
  const diff = diffWorkflowForSync(
    definitionOf(task.workflowSnapshot),
    loaded.workflow.definition,
    runSummary,
  )
  return {
    syncable: true,
    reason: 'ok',
    workflowId: task.workflowId,
    workflowName: loaded.workflow.name,
    currentVersion: task.workflowVersion,
    latestVersion: loaded.workflow.version,
    differs: diff.differs,
    invalid: !validation.ok || closureIssues.length > 0,
    invalidIssues,
    diff,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-359 W8 —— retry / syncWorkflow 共用的三件事：冻结溯源预检、快照基线判据、
// 被取消写节点的工作树回滚。SQLite 的权威实现在 `services/task.ts`
// （`assertFrozenTaskTriggerPreflight` / `escalateSnapshotLost` /
// `escalateLiveChildSurvived` / `selectSyncRollbackTargets`）；这里是同口径的 PG 侧实现，
// 判据与错误码逐条对齐，行为差异只在下面每处注释显式写明的地方。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC-292 —— 冻结任务的溯源预检。webhook 上下文永远从**durable 任务行**重读；调用方可以
 * 给一份候选 root+closure（sync 换定义时用），但绝不能替换 trigger 源。
 *
 * 与 SQLite 的 `assertFrozenTaskTriggerPreflight` 同位同序：它必须落在准入 CAS **之前**，
 * 否则一个必然被拒的重试/同步会先把任务状态推走、铸出占位行，再拒绝。
 */
async function assertFrozenTaskTriggerPreflight(
  db: PostgresqlDatabaseClient,
  taskId: string,
  candidate?: Readonly<{ workflowSnapshot: string; refClosureJson: string | null }>,
): Promise<void> {
  const frozen = (
    await db
      .select({
        workflowSnapshot: tasks.workflowSnapshot,
        refClosureJson: tasks.refClosureJson,
        triggerContextJson: tasks.triggerContextJson,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (frozen === undefined) return

  const source = parseTriggerContextJson(frozen.triggerContextJson)
  if (source.kind === 'invalid') {
    throw new ValidationError(
      'trigger-context-invalid',
      'the frozen task trigger context is invalid',
    )
  }
  const selected = candidate ?? frozen
  try {
    const root = migrateWorkflowDefinitionToLatest(
      WorkflowDefinitionSchema.parse(JSON.parse(selected.workflowSnapshot)),
    )
    assertTriggerPreflight({ root, closureJson: selected.refClosureJson, source })
  } catch (error) {
    // 历史上损坏的工作流快照保留既有的恢复姿势；来自**合法**快照的 trigger 失败是权威的，
    // 必须先于任何生命周期 / 调度副作用发生。
    if (error instanceof ValidationError && error.code.startsWith('trigger-')) throw error
  }
}

/** RFC-359 W8 —— MR/PR 终结栅栏的透传（SQLite 侧由准入 CAS 抛出同名码）。 */
function assertNotSourceTerminated(task: Pick<TaskRow, 'id' | 'sourceTerminationFence'>): void {
  const code = sourceTerminationRevivalError(task.sourceTerminationFence)
  if (code === null) return
  throw new ConflictError(
    code,
    `task '${task.id}' is fenced by an MR/PR ${task.sourceTerminationFence} event`,
  )
}

/** `snapshot-missing` 的合并说明；没有这类失败时返回 null。 */
function snapshotLostDetail(outcome: RollbackOutcome): string | null {
  const failures = outcome.failures.filter((failure) => failure.code === 'snapshot-missing')
  if (failures.length === 0) return null
  return failures
    .map((failure) =>
      failure.worktreeDirName === undefined
        ? failure.message
        : `${failure.worktreeDirName}: ${failure.message}`,
    )
    .join('; ')
}

/**
 * RFC-098 WP-9 —— 承诺要恢复的基线已被 gc prune：失败关闭。任务落 `failed`
 * （`errorSummary='snapshot-lost'` / `'live-child-survived'`），调用方拿 409。返回 `never`。
 */
async function escalateUnsafeContinuation(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Readonly<{
    taskId: string
    run: Pick<NodeRunRow, 'id' | 'nodeId'>
    allowedFrom: readonly TaskStatus[]
    code: 'snapshot-lost' | 'live-child-survived'
    detail: string
    reason: string
  }>,
): Promise<never> {
  const now = dependencies.now?.() ?? Date.now()
  await dependencies.persistence.runtimeLifecycle.trySet({
    taskId: input.taskId,
    to: 'failed',
    allowedFrom: [...input.allowedFrom],
    // 来源可能已经是终态（retry 的准入门放行 done/failed/canceled/… 六档），所以这条
    // 「终态→failed」的升级必须显式允许覆写终态，否则升级会被生命周期内核静默丢掉。
    allowTerminal: true,
    extra: {
      finishedAt: now,
      errorSummary: input.code,
      errorMessage: input.detail,
      failedNodeId: input.run.nodeId,
    },
    now,
    reason: `${input.reason}:${input.code}`,
  })
  await dependencies.persistence.recoveryAdministration.recordEvent({
    id: dependencies.id?.() ?? ulid(),
    taskId: input.taskId,
    nodeRunId: input.run.id,
    actor: 'system',
    kind: input.code,
    reason: input.detail,
    beforeJson: JSON.stringify({ status: 'pending' }),
    afterJson: JSON.stringify({ status: 'failed' }),
    createdAt: now,
  })
  throw new ConflictError(input.code, input.detail)
}

/**
 * 副作用为零的**跨行**快照存在性预检（RFC-108 T7 AR-17 的同口径实现）：每一条要回滚的行的
 * `pre_snapshot` 都必须还能解析成一个 commit，否则失败关闭。`checkOnly` 只跑
 * `git cat-file`，不碰任何工作树，所以它可以安全地放在准入 CAS **之前**。
 */
async function assertRollbackBaselinesPresent(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Readonly<{
    taskId: string
    runs: readonly NodeRunRow[]
    allowedFrom: readonly TaskStatus[]
    reason: string
  }>,
): Promise<void> {
  // 没记过任何快照的行在 resume 口径下本来就是「什么都不动」，连 git 都不会跑到——
  // 提前滤掉，别为最常见的那条路径多发一次 rollback-target 查询。
  const candidates = input.runs.filter(
    (run) => (run.preSnapshot ?? '') !== '' || run.preSnapshotReposJson !== null,
  )
  if (candidates.length === 0) return
  const target = await loadRollbackTargetFrom(
    new DrizzleTaskRollbackQueries(dependencies.db),
    input.taskId,
  )
  if (target === null) return
  for (const run of candidates) {
    const outcome = await rollbackNodeRunWorktrees(
      target,
      run,
      { resetOnEmptySnapshot: false, checkOnly: true },
      log,
    )
    const detail = snapshotLostDetail(outcome)
    if (detail !== null) {
      await escalateUnsafeContinuation(dependencies, {
        taskId: input.taskId,
        run,
        allowedFrom: input.allowedFrom,
        code: 'snapshot-lost',
        detail: `node_run ${run.id} (node ${run.nodeId}) pre-snapshot is missing from the object database (pruned by gc?): ${detail}`,
        reason: input.reason,
      })
    }
  }
}

/**
 * 真回滚：先把该行可能还活着的运行时子进程组杀掉，再把工作树重置回它开跑前的快照。
 *
 * 与 SQLite 的 `reapRunBeforeWorktreeReset` 的差别只有一处，且是**刻意**的：held native
 * session 租约的围栏与修复留在紧随其后的 `children.resume`
 * （`postgresqlChildTaskLifecycleParticipant.rollbackForResume` 对整棵任务做同一件事，
 * 且它持有 `RuntimeSessionLeaseOperations`）。本处只做 SQLite 在**没有**租约那一支的判据：
 * 杀不掉就失败关闭。
 */
async function rollbackRunsForContinuation(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Readonly<{
    taskId: string
    runs: readonly NodeRunRow[]
    allowedFrom: readonly TaskStatus[]
    reason: string
  }>,
): Promise<void> {
  if (input.runs.length === 0) return
  const target = await loadRollbackTargetFrom(
    new DrizzleTaskRollbackQueries(dependencies.db),
    input.taskId,
  )
  if (target === null) return
  for (const run of input.runs) {
    const killed = await killStaleRunProcessTree(run)
    if (killed === 'killed') {
      log.warn('stale runtime child group-killed before workspace rollback', {
        taskId: input.taskId,
        nodeRunId: run.id,
        pid: run.pid,
      })
    }
    if (killed === 'kill-failed') {
      await escalateUnsafeContinuation(dependencies, {
        taskId: input.taskId,
        run,
        allowedFrom: input.allowedFrom,
        code: 'live-child-survived',
        detail: `node_run ${run.id} child reap could not be proven (kill-failed, pid ${run.pid ?? '?'}); refusing to reset the worktree while a writer may still be alive`,
        reason: input.reason,
      })
    }
  }
  for (const run of input.runs) {
    const outcome = await rollbackNodeRunWorktrees(
      target,
      run,
      { resetOnEmptySnapshot: false },
      log,
    )
    const detail = snapshotLostDetail(outcome)
    if (detail !== null) {
      await escalateUnsafeContinuation(dependencies, {
        taskId: input.taskId,
        run,
        allowedFrom: input.allowedFrom,
        code: 'snapshot-lost',
        detail: `node_run ${run.id} (node ${run.nodeId}) pre-snapshot is missing from the object database (pruned by gc?): ${detail}`,
        reason: input.reason,
      })
    }
  }
}

async function syncWorkflow(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Parameters<TaskRouteOperations['syncWorkflow']>[0],
): Promise<Task> {
  const row = await requireTaskRow(dependencies.db, input.taskId)
  if (taskExecutionKind(row) !== 'workflow') {
    throw new ValidationError(
      'task-host-sync-unsupported',
      'agent/workgroup host tasks run a synthesized snapshot and cannot be synced',
    )
  }
  // 判据缺口账本 01b —— 与 SQLite 的 `assertTaskSyncable` 同位同序：内置身份先于
  // 活跃 / 状态 / 工作树各门，一个内置工作流无论任务处于什么状态都不可被 sync。
  const syncCandidate = await builtinCandidateWorkflow(dependencies.db, row.workflowId)
  if (syncCandidate !== null) assertNotBuiltin('workflow', syncCandidate)
  await dependencies.activity.awaitReleasedSettled(input.taskId)
  if (dependencies.activity.isActive(input.taskId)) {
    throw new ConflictError('task-not-syncable', `task '${input.taskId}' is actively running`)
  }
  const allowedFrom = allowedFromForTaskEvent({ kind: 'sync-workflow' })
  if (!allowedFrom.includes(row.status as TaskStatus)) {
    throw new ConflictError(
      'task-not-syncable',
      `task '${input.taskId}' is ${row.status}; cannot sync`,
    )
  }
  if (lacksMaterializedWorkspace(row.worktreePath) || row.workspacePrunedAt !== null) {
    throw new ConflictError('worktree-missing', `task '${input.taskId}' has no live worktree`)
  }
  const { authority, workflow } = await loadVisibleWorkflow(
    dependencies,
    input.actor,
    row.workflowId,
  )
  if (workflow.version !== input.expectedVersion) {
    throw new ConflictError(
      'workflow-sync-preview-stale',
      `workflow advanced to v${workflow.version} since the preview (v${input.expectedVersion})`,
    )
  }
  const closureJson = await authority.resources.freezeCallClosure(authority, {
    id: workflow.id,
    definition: workflow.definition,
  })
  assertTriggerPreflight({
    root: workflow.definition,
    closureJson,
    source: parseTriggerContextJson(row.triggerContextJson),
  })
  const validation = await dependencies.launch.agent.resources.validateHostWorkflow(
    workflow.definition,
  )
  const validationErrors = validation.issues.filter(
    (issue) => (issue.severity ?? 'error') === 'error',
  )
  if (!validation.ok && validationErrors.length > 0) {
    throw new ValidationError('workflow-invalid', `workflow '${workflow.id}' is invalid`, {
      issues: validation.issues,
    })
  }
  const frozenDefinition = definitionOf(parseJson(row.workflowSnapshot, null))
  const diff = diffWorkflowForSync(
    frozenDefinition,
    workflow.definition,
    await syncRunSummary(dependencies.db, input.taskId),
  )
  if (!diff.differs) {
    throw new ConflictError(
      'workflow-sync-noop',
      `task '${input.taskId}' already uses that workflow definition`,
    )
  }
  if (diff.blockers.length > 0) {
    throw new ConflictError(
      'wrapper-structure-changed-with-live-state',
      diff.blockers.map((blocker) => blocker.detail).join('; '),
    )
  }

  // RFC-359 W8（判据缺口账本 —— ② sync 回滚）:被取消的**写**节点在 RFC-095 下是可再派发的,
  // 新定义会在同一棵工作树上从它继续跑,所以它上次被取消时写了一半的东西必须先回滚到
  // `pre_snapshot`。这一档 `children.resume` 永远够不着——`rollbackForResume` 用的是 **resume**
  // 选择器(只收 failed / interrupted),canceled 从不进它的集合。failed / interrupted 两档
  // 反过来由紧随其后的 `children.resume` 连同 native-session 租约围栏一并处理,本处不重复,
  // 免得在租约围栏之前就动工作树。判据本身复用 SQLite 的权威选择器
  // `selectSyncRollbackTargets`(每个节点最新的顶层行 + 状态过滤 + wrapper 豁免)。
  //
  // wrapper 豁免按 **旧** 定义判(RFC-109 impl-gate F2):一条 canceled 行要不要回滚取决于它
  // 跑的时候**是什么**——旧图里是 agent 写节点就回滚,是 wrapper 就放过(RFC-095 原地复活,
  // 回滚会把已完成的内层工作抹掉)。
  const frozenWrapperNodeIds = new Set(
    frozenDefinition.nodes.filter((node) => isWrapperKind(node.kind)).map((node) => node.id),
  )
  const syncRuns = await dependencies.db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, input.taskId))
  const syncRollbackRuns = selectSyncRollbackTargets(syncRuns, ['canceled'], (nodeId) =>
    frozenWrapperNodeIds.has(nodeId),
  )
  // 跨行 all-or-nothing 预检(零副作用)先于准入 CAS:任一行的基线已被 gc prune 时,任务
  // 失败关闭而不是被推进 interrupted 之后才在半截回滚里发现。
  await assertRollbackBaselinesPresent(dependencies, {
    taskId: input.taskId,
    runs: syncRollbackRuns,
    allowedFrom: allowedFrom,
    reason: 'syncTaskWorkflow',
  })

  // RFC-109 F5 TOCTOU 复检:上面的校验 / diff 全是本地读,并发的 workflow PUT 可能在这个
  // 窗口里把版本推走。紧挨着准入 CAS 再断言一次,保证写进任务的永远是用户确认过的那一版。
  const liveVersion = (
    await dependencies.db
      .select({ version: workflows.version })
      .from(workflows)
      .where(eq(workflows.id, row.workflowId))
      .limit(1)
  )[0]
  if (liveVersion?.version !== input.expectedVersion) {
    throw new ConflictError(
      'workflow-sync-preview-stale',
      `workflow advanced since validation; refresh and re-confirm`,
    )
  }

  const now = dependencies.now?.() ?? Date.now()
  const eventRef = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const changed = await tx
      .update(tasks)
      .set({
        status: 'interrupted',
        workflowSnapshot: JSON.stringify(workflow.definition),
        workflowVersion: workflow.version,
        refClosureJson: closureJson,
        finishedAt: now,
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.status, row.status),
          eq(tasks.lifecycleEventRevision, row.lifecycleEventRevision),
          isNull(tasks.workspacePrunedAt),
        ),
      )
      .returning({ revision: tasks.lifecycleEventRevision })
    const changedRow = changed[0]
    if (changedRow === undefined) {
      throw new ConflictError(
        'task-not-syncable',
        `task '${input.taskId}' changed during workflow sync`,
      )
    }
    return await appendTaskLifecycleTransitionCommittedEvent(tx, {
      taskId: input.taskId,
      lifecycleRevision: changedRow.revision,
      previousStatus: row.status as TaskStatus,
      status: 'interrupted',
      errorSummary: row.errorSummary,
      occurredAt: now,
      // RFC-359 W8：这是两段式准入的**内部交棒**，不是任务真的中断了——第二段
      // `children.resume` 的 `admitResume` 马上把它 CAS 回 pending。不打这个标记，
      // 三个只看「状态值是不是终态」的消费者会在 PG 上把「同步进行中」谎报成
      // 「任务已结束」（唤醒 watchTaskTerminal / 放掉子任务预算名额 / 发 task.done），
      // 而 SQLite 的一段式直接落 pending，一条都不会发生。
      continuationHandoff: true,
    })
  })
  await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
  // 准入拿下之后才动工作树(与 SQLite 的 `resumeKick` 同序:CAS 是命令准入的胜者,
  // 输的一方零副作用)。此时任务已在 `interrupted`,升级的 allowedFrom 随之收敛到它。
  await rollbackRunsForContinuation(dependencies, {
    taskId: input.taskId,
    runs: syncRollbackRuns,
    allowedFrom: ['interrupted'],
    reason: 'syncTaskWorkflow',
  })
  await dependencies.children.resume(
    {
      taskId: input.taskId,
      runtime: dependencies.resumeRuntimeFor(input.actor, input.taskId),
    },
    dependencies.topology,
  )
  const updated = await loadTask(dependencies.db, input.taskId)
  if (updated === null)
    throw new NotFoundError('task-not-found', `task '${input.taskId}' not found`)
  return updated
}

function retryNodeIds(
  definition: WorkflowDefinition,
  targetNodeId: string,
  cascade: boolean,
): ReadonlySet<string> {
  const affected = new Set([targetNodeId])
  if (!cascade) return affected
  const adjacency = new Map<string, string[]>()
  for (const edge of definition.edges) {
    const existing = adjacency.get(edge.source.nodeId)
    if (existing === undefined) adjacency.set(edge.source.nodeId, [edge.target.nodeId])
    else if (!existing.includes(edge.target.nodeId)) existing.push(edge.target.nodeId)
  }
  const pending = [targetNodeId]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const next of adjacency.get(current) ?? []) {
      if (affected.has(next)) continue
      affected.add(next)
      pending.push(next)
    }
  }
  return affected
}

function freshestTopLevel(rows: readonly NodeRunRow[]): NodeRunRow | undefined {
  return rows
    .filter((row) => row.parentNodeRunId === null)
    .sort((left, right) => right.id.localeCompare(left.id))[0]
}

/**
 * RFC-354 —— 级联占位行的继承源：**被点行所在帧**里该节点最新的顶层行。
 *
 * 帧 = `(container_run_id, iteration)`：wrapper 的那一代行 + 代内的轮次。级联要重新武装的
 * 是「用户正在重试的那一代」，所以先按帧过滤，再在帧内取 id 序最新的顶层行。
 *
 * 为什么不能只按纯 id 序取（这是 RFC-359 W8 修掉的实测缺口）：嵌套 wrapper 下同一个节点在
 * **不同代**里各有一条顶层行，而 id 序只反映铸造先后。loop 套 loop 时重试外层第 0 轮里的
 * 节点，纯 id 序会选中第 1 轮那一代的行，占位行于是继承了**别的 generation** 的
 * `container_run_id` —— 调度器在用户正在重试的那一帧里根本看不到这条新行，级联对当前帧
 * 静默失效，反倒把另一代无端重开。
 *
 * 帧内无行时回落到全行集（与 SQLite 的 `retryNode` 逐字同形）：下游节点可能住在外层作用域、
 * 或住在某个嵌套 wrapper 里由该 wrapper 自己的占位行重开，那时按老口径取最新顶层行即可。
 */
function inheritanceSourceInFrame(
  rows: readonly NodeRunRow[],
  nodeId: string,
  frame: Readonly<{ containerRunId: string | null; iteration: number }>,
): NodeRunRow | undefined {
  const existing = rows.filter((row) => row.nodeId === nodeId)
  const sameFrame = existing.filter(
    (row) => row.containerRunId === frame.containerRunId && row.iteration === frame.iteration,
  )
  return freshestTopLevel(sameFrame.length > 0 ? sameFrame : existing)
}

/**
 * RFC-243 §4.2 —— 子任务的父调用行**已经收场**时它的状态；否则 null。判据与 SQLite 的
 * `assertChildTaskDrivable` 逐字相同：不是子任务、没有父调用行、父调用行已不存在
 * （被删 / 老数据）都算可驱动。
 */
async function finalizedParentCallRowStatus(
  db: PostgresqlDatabaseClient,
  task: Pick<TaskRow, 'parentTaskId' | 'parentNodeRunId'>,
): Promise<string | null> {
  const callRowId = task.parentNodeRunId ?? null
  if ((task.parentTaskId ?? null) === null || callRowId === null) return null
  const rows = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, callRowId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return isTerminalNodeRunStatus(row.status as NodeRunStatus) ? row.status : null
}

async function retryNode(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Parameters<TaskRouteOperations['retry']>[0],
): Promise<Task> {
  const task = await requireTaskRow(dependencies.db, input.taskId)
  await dependencies.activity.awaitReleasedSettled(input.taskId)
  if (dependencies.activity.isActive(input.taskId)) {
    throw new ConflictError(
      'task-still-running',
      `task '${input.taskId}' has an active scheduler attached`,
    )
  }
  if (!RETRYABLE_TASK_STATUSES.includes(task.status as (typeof RETRYABLE_TASK_STATUSES)[number])) {
    throw new ConflictError(
      'task-still-running',
      `task '${input.taskId}' is ${task.status}; cancel it before retrying`,
    )
  }
  // 判据缺口账本 02（RFC-243 §4.2 子侧门）—— 父任务的调用行已经收场时，重跑这个子任务
  // 的产物没有任何人会去消费（父的 outputs / merge 源已经结算完）。SQLite 侧 `retryNode`
  // 走 `assertChildTaskDrivable`，PG 侧的 **resume** 有这道门（`assertResumeAdmission`）而
  // retry 没有——同一个子任务在 PG 上 resume 被拒、retry 却放行。
  const finalizedCallRow = await finalizedParentCallRowStatus(dependencies.db, task)
  if (finalizedCallRow !== null) {
    throw new ConflictError(
      'call-row-finalized',
      `task '${input.taskId}' is a child execution whose call node run already settled ` +
        `('${finalizedCallRow}'); retry the parent's call node instead`,
    )
  }
  const runs = await dependencies.db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, input.taskId))
  const target = runs.find((row) => row.id === input.nodeRunId)
  if (target === undefined) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${input.nodeRunId}' not found under task '${input.taskId}'`,
    )
  }
  if (target.nodeId === '__repo_prep__') {
    await dependencies.repositoryPreparationRetry.retry(input.taskId)
    const prepared = await loadTask(dependencies.db, input.taskId)
    if (prepared === null) {
      throw new NotFoundError('task-not-found', `task '${input.taskId}' not found`)
    }
    return prepared
  }
  // RFC-359 W8（判据缺口账本 —— ① retry 的三道前置门）。三条都必须落在准入 CAS **之前**：
  // 一个注定要被拒绝的重试不得先把任务状态推走、铸出「queued for retry」的假尝试、再拒绝。
  // SQLite 的同位实现在 `services/task.ts` 的 `retryNode`（RFC-292 预检 → CAS → 回滚）。
  //
  // ① RFC-292：重试复用任务不可变的 webhook 溯源。
  await assertFrozenTaskTriggerPreflight(dependencies.db, input.taskId)
  // ② MR/PR 终结栅栏透传：SQLite 侧由准入 CAS（`setTaskStatus`）抛出这两个码并原样上抛；
  //    PG 的 CAS 是裸条件 UPDATE，栅栏既不在谓词里也没人判，于是被栅栏的任务照样被推进
  //    `interrupted`，直到 `children.resume` 才发现——那时任务已经改坏了。
  assertNotSourceTerminated(task)

  // 快照要在 ③ 之前解出来：③ 是否适用取决于被点行是不是「被取消的 wrapper」，而那要查
  // 节点 kind。解不出快照同样是「什么都还没动」的拒绝，提前发生不改变任何已落库的状态。
  const definition = definitionOf(parseJson(task.workflowSnapshot, null))
  const kinds = new Map(definition.nodes.map((node) => [node.id, node.kind]))

  // RFC-095 design.md:43-48 —— 被点的行是**被取消的 wrapper** 时，它自己就是复活信号：
  // wrapper ledger 原地复用这一行（`createWrapperRunLedger.openGeneration` 的 allowedFrom
  // 含 'canceled'），按持久化 progress **续跑**，git baseline 保持 pre-inner。它的
  // `pre_snapshot` 因此永远不会被恢复——`selectSyncRollbackTargets` 早已为 sync 那一侧写死
  // 同一条豁免（services/task.ts：「rolling it back would undo completed inner work」）。
  // 基线既然不会被用，它在不在就与本次重试的安全性无关；拿它去拒绝只会让一条早被 gc 掉的
  // 存量快照把一次合法的复活永久封死。
  const canceledWrapperRevival =
    isWrapperKind(kinds.get(target.nodeId)) && target.status === 'canceled'

  // ③ RFC-098 WP-9：被点行承诺要恢复的基线还在不在。`checkOnly` 只跑 `git cat-file`、
  //    不碰工作树，所以可以放在 CAS 之前——基线没了就失败关闭，一条占位行都不铸。
  //    真正的（破坏性）回滚仍由紧随其后的 `children.resume` 执行：被点行的 `pre_snapshot`
  //    随占位行继承下去，`rollbackForResume` 会连同 native-session 租约围栏一并处理它。
  if (!canceledWrapperRevival) {
    await assertRollbackBaselinesPresent(dependencies, {
      taskId: input.taskId,
      runs: [target],
      allowedFrom: RETRYABLE_TASK_STATUSES,
      reason: 'retryNode',
    })
  }

  const affected = retryNodeIds(definition, target.nodeId, input.cascade)
  const childTaskIds = [
    ...new Set(
      runs.flatMap((row) =>
        affected.has(row.nodeId) && row.childTaskId !== null ? [row.childTaskId] : [],
      ),
    ),
  ]
  const now = dependencies.now?.() ?? Date.now()
  const operationRef = `task-retry:${input.taskId}:${dependencies.id?.() ?? ulid()}`
  const committed = await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const changed = await tx
      .update(tasks)
      .set({
        status: 'interrupted',
        finishedAt: now,
        lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
      })
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.status, task.status),
          eq(tasks.lifecycleEventRevision, task.lifecycleEventRevision),
          // 上面的 `assertNotSourceTerminated` 是快失败门（给得出对的错误码）；栅栏进谓词
          // 才是真判据——否则栅栏在读到写之间落下时重试仍会得手。
          isNull(tasks.sourceTerminationFence),
        ),
      )
      .returning({ revision: tasks.lifecycleEventRevision })
    const changedTask = changed[0]
    if (changedTask === undefined) {
      throw new ConflictError(
        'task-still-running',
        `task '${input.taskId}' changed while retry was admitted`,
      )
    }
    const mint = createNodeRunMintParticipantInTx(tx)
    const nodeChanges: Array<{
      nodeRunId: string
      nodeId: string
      status: NodeRunStatus
      cause: string
    }> = []
    for (const nodeId of affected) {
      const kind = kinds.get(nodeId)
      const selected =
        nodeId === target.nodeId
          ? target
          : inheritanceSourceInFrame(runs, nodeId, {
              containerRunId: target.containerRunId,
              iteration: target.iteration,
            })
      const wrapperRevival =
        nodeId === target.nodeId &&
        isWrapperKind(kind) &&
        (target.status === 'canceled' || target.status === 'interrupted')
      if (
        wrapperRevival ||
        (nodeId !== target.nodeId &&
          kind !== undefined &&
          !nodeKindParticipatesInRetryCascade(kind))
      ) {
        continue
      }
      const nodeRows = runs.filter((row) => row.nodeId === nodeId)
      const nodeRunId = await mint.mint({
        taskId: input.taskId,
        nodeId,
        status: 'failed',
        cause: nodeId === target.nodeId ? 'retry-node' : 'retry-node-cascade',
        retryIndex: nextRetryIndex(nodeRows),
        iteration: selected?.iteration ?? 0,
        inheritFrom:
          selected === undefined
            ? null
            : {
                reviewIteration: selected.reviewIteration,
                shardKey: selected.shardKey,
                parentNodeRunId: selected.parentNodeRunId,
                containerRunId: selected.containerRunId,
                preSnapshot: selected.preSnapshot,
                continuationSlotKey: selected.continuationSlotKey,
                lineageSlotPathJson: selected.lineageSlotPathJson,
                operationGeneration: selected.operationGeneration,
              },
        overrides: {
          finishedAt: now,
          errorMessage: 'queued for retry',
          ...(nodeId === target.nodeId && target.status === 'skipped'
            ? { forceActivated: true }
            : {}),
        },
      })
      nodeChanges.push({
        nodeRunId,
        nodeId,
        status: 'failed',
        cause: nodeId === target.nodeId ? 'retry-node' : 'retry-node-cascade',
      })
    }
    const lifecycle = await appendTaskLifecycleTransitionCommittedEvent(tx, {
      taskId: input.taskId,
      lifecycleRevision: changedTask.revision,
      previousStatus: task.status as TaskStatus,
      status: 'interrupted',
      errorSummary: task.errorSummary,
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 0 },
      // RFC-359 W8：同上——重试的第一段只是把任务推到一个**可 resume 的终态**交给
      // `children.resume`，任务并没有结束。`pending` 不能当这个中转态（不在
      // `RESUMABLE_TASK_STATUSES` 里，会被 `assertResumeAdmission` 当场拒掉），所以
      // 分家只能落在事件的语义上，而不是状态值上。
      continuationHandoff: true,
    })
    const nodeStatuses =
      nodeChanges.length === 0
        ? null
        : await appendTaskNodeStatusesCommittedEvent(tx, {
            taskId: input.taskId,
            reason: 'scheduler',
            nodeChanges,
            occurredAt: now,
            identity: {
              operationRef: `${operationRef}:nodes`,
              eventGroupId: operationRef,
              eventGroupOrdinal: 1,
              correlationRef: null,
            },
          })
    return [lifecycle, nodeStatuses].filter((ref) => ref !== null)
  })
  await publishCommittedEventsAfterCommit(committed)
  for (const childTaskId of childTaskIds) {
    try {
      await dependencies.children.cancel({
        taskId: childTaskId,
        cause: { kind: 'parent-cascade', parentTaskId: input.taskId },
      })
    } catch (error) {
      if (error instanceof NotFoundError) continue
      await dependencies.persistence.runtimeLifecycle.trySet({
        taskId: input.taskId,
        to: 'failed',
        allowedFrom: ['interrupted'],
        now: dependencies.now?.() ?? Date.now(),
        extra: {
          finishedAt: dependencies.now?.() ?? Date.now(),
          errorSummary: 'retry-child-cancel-failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          failedNodeId: target.nodeId,
        },
        reason: 'retry-child-cancel-failed',
      })
      throw new ConflictError(
        'retry-child-cancel-failed',
        `superseded child task '${childTaskId}' could not be canceled`,
      )
    }
  }
  await dependencies.children.resume(
    {
      taskId: input.taskId,
      runtime: dependencies.resumeRuntimeFor(input.actor, input.taskId),
    },
    dependencies.topology,
  )
  const updated = await loadTask(dependencies.db, input.taskId)
  if (updated === null)
    throw new NotFoundError('task-not-found', `task '${input.taskId}' not found`)
  return updated
}

interface DeleteWorktreeTarget {
  readonly taskId: string
  readonly repoPath: string
  readonly worktreePath: string
}

// 两个调用点：一个传客户端本身，一个传事务句柄。RFC-359 W5-T18 之后事务句柄是中立的
// `DatabaseTransaction`，客户端仍是 PG 客户端——取二者共同的读面（`ProviderNeutralDatabase`
// 是两个 provider 客户端的公共基类型，见 `db/query.ts`）。
async function taskTreeIds(
  db: Pick<PostgresqlTaskExecutionTransaction, 'select'>,
  rootTaskId: string,
): Promise<readonly string[]> {
  const seen = new Set([rootTaskId])
  let frontier = [rootTaskId]
  while (frontier.length > 0) {
    const children = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.parentTaskId, frontier))
    frontier = []
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      frontier.push(child.id)
    }
  }
  return [...seen]
}

async function cleanupDeletedTask(
  taskIds: readonly string[],
  worktrees: readonly DeleteWorktreeTarget[],
  appHome: string,
): Promise<'done' | 'pending'> {
  let complete = true
  for (const worktree of worktrees) {
    try {
      await removeWorktree({ ...worktree, force: true })
    } catch {
      complete = false
      try {
        await rm(worktree.worktreePath, { recursive: true, force: true })
      } catch {
        complete = false
      }
    }
    try {
      await deleteSnapshotRefs(worktree.repoPath, worktree.taskId)
    } catch {
      complete = false
    }
  }
  for (const taskId of taskIds) {
    for (const directory of [
      join(appHome, 'runs', taskId),
      join(appHome, 'logs', taskId),
      join(appHome, 'scratch', taskId),
    ]) {
      try {
        await rm(directory, { recursive: true, force: true })
      } catch {
        complete = false
      }
    }
  }
  return complete ? 'done' : 'pending'
}

async function deleteTask(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  taskId: string,
): Promise<{ taskId: string; cleanup: 'done' | 'pending' }> {
  const root = await requireTaskRow(dependencies.db, taskId)
  if (!isTerminalTaskStatus(root.status as TaskStatus)) {
    throw new ConflictError('task-not-terminal', `task '${taskId}' is ${root.status}`)
  }
  if (root.spaceKind === 'internal') {
    throw new ConflictError(
      'task-internal',
      `task '${taskId}' is framework-internal and cannot be deleted directly`,
    )
  }
  const taskIds = await taskTreeIds(dependencies.db, taskId)
  const treeRows = await dependencies.db
    .select({
      id: tasks.id,
      status: tasks.status,
      spaceKind: tasks.spaceKind,
      repoPath: tasks.repoPath,
      worktreePath: tasks.worktreePath,
      ownerUserId: tasks.ownerUserId,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds))
  for (const row of treeRows) {
    if (!isTerminalTaskStatus(row.status as TaskStatus)) {
      throw new ConflictError(
        'task-has-active-children',
        `task '${taskId}' has non-terminal child '${row.id}'`,
      )
    }
    if (dependencies.activity.isActive(row.id)) {
      throw new ConflictError('task-active', `task '${row.id}' still has an active process`)
    }
  }
  if (root.parentTaskId !== null) {
    const parentRows = await dependencies.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, root.parentTaskId))
      .limit(1)
    if (parentRows[0] !== undefined && !isTerminalTaskStatus(parentRows[0].status as TaskStatus)) {
      throw new ConflictError(
        'task-parent-active',
        `parent task '${root.parentTaskId}' must settle before deleting '${taskId}'`,
      )
    }
  }
  const [repoRows, memberRows, maintenanceMembers] = await Promise.all([
    dependencies.db
      .select({
        taskId: taskRepos.taskId,
        repoPath: taskRepos.repoPath,
        worktreePath: taskRepos.worktreePath,
      })
      .from(taskRepos)
      .where(inArray(taskRepos.taskId, taskIds)),
    dependencies.db
      .select({ taskId: taskCollaborators.taskId, userId: taskCollaborators.userId })
      .from(taskCollaborators)
      .where(inArray(taskCollaborators.taskId, taskIds)),
    dependencies.persistence.terminalMaintenance.snapshotTree(taskId),
  ])
  const worktrees = [
    ...new Map(
      treeRows
        .filter((row) => row.spaceKind !== 'inherited')
        .flatMap((row) => {
          const owned = repoRows.filter((repo) => repo.taskId === row.id)
          return owned.length > 0
            ? owned.map((repo) => ({
                taskId: row.id,
                repoPath: repo.repoPath,
                worktreePath: repo.worktreePath,
              }))
            : [{ taskId: row.id, repoPath: row.repoPath, worktreePath: row.worktreePath }]
        })
        .filter((row) => row.repoPath !== '' && row.worktreePath !== '')
        .map((row) => [`${row.repoPath}\u0000${row.worktreePath}`, row] as const),
    ).values(),
  ]
  const visibleUserIdsByTask = new Map<string, ReadonlySet<string>>()
  for (const row of treeRows) {
    const visible = new Set<string>()
    if (row.ownerUserId !== null) visible.add(row.ownerUserId)
    for (const member of memberRows) {
      if (member.taskId === row.id) visible.add(member.userId)
    }
    visibleUserIdsByTask.set(row.id, visible)
  }
  let claim = await dependencies.persistence.terminalMaintenance.claim({
    rootTaskId: taskId,
    operation: 'delete',
    members: maintenanceMembers,
    cleanupPlanJson: JSON.stringify({ v: 1, taskId, taskIds, worktrees }),
  })
  claim = await dependencies.persistence.terminalMaintenance.transition({
    claim,
    to: 'io-complete',
  })
  await withPostgresqlSerializableTaskExecution(dependencies.db, async (tx) => {
    const claimedRows = await tx
      .select({ taskId: taskExecutionMaintenanceMembers.taskId })
      .from(taskExecutionMaintenanceMembers)
      .where(
        and(
          eq(taskExecutionMaintenanceMembers.claimId, claim.claimId),
          isNull(taskExecutionMaintenanceMembers.releasedAt),
        ),
      )
    const currentIds = await taskTreeIds(tx, taskId)
    const expected = maintenanceMembers.map((member) => member.taskId).sort()
    if (
      JSON.stringify(claimedRows.map((row) => row.taskId).sort()) !== JSON.stringify(expected) ||
      JSON.stringify([...currentIds].sort()) !== JSON.stringify(expected)
    ) {
      throw new ConflictError(
        'task-terminal-maintenance-conflict',
        `task tree '${taskId}' changed after delete claim`,
      )
    }
    const fresh = await tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    if (fresh[0] === undefined || !isTerminalTaskStatus(fresh[0].status as TaskStatus)) {
      throw new ConflictError(
        'task-terminal-maintenance-conflict',
        `task '${taskId}' changed after delete claim`,
      )
    }
    await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, expected)).run()
    await tx.delete(tasks).where(eq(tasks.id, taskId)).run()

    // RFC-311 实现门 P1-6 / P2-3（RFC-359 W8 抬齐到 PG）：`branch_started_at` 是「子树
    // max(started_at)」的**物化**值，只有铸行点向上单调 MAX 推进过它。删掉一棵子树之后没人
    // 把它拉回来，父行就**永久**停在被删子树的时间戳上——同一份数据在默认视图（快路径按
    // 物化列排序）与任一过滤视图（旧管线现算）之间行序不同且永不收敛。
    // 删除是低频操作，在同一事务里沿父链重算即可闭合（链长同 MAX_TREE_DEPTH）。
    // 与 SQLite 的 `services/taskDelete.ts` 同形；`coalesce(max(...), 0)` 是聚合，两个方言
    // 同名同义（两参数的 `MAX(a,b)` 是 SQLite 独有的，这里没有用到）。
    let cursor: string | null = root.parentTaskId
    for (let depth = 0; cursor !== null && depth < 64; depth += 1) {
      const parent = (
        await tx
          .select({ id: tasks.id, parentTaskId: tasks.parentTaskId, startedAt: tasks.startedAt })
          .from(tasks)
          .where(eq(tasks.id, cursor))
          .limit(1)
      )[0]
      if (parent === undefined) break
      const childMax = (
        await tx
          .select({ v: sql<number>`coalesce(max(${tasks.branchStartedAt}), 0)`.mapWith(Number) })
          .from(tasks)
          .where(eq(tasks.parentTaskId, parent.id))
      )[0]
      await tx
        .update(tasks)
        .set({ branchStartedAt: Math.max(parent.startedAt ?? 0, childMax?.v ?? 0) })
        .where(eq(tasks.id, parent.id))
        .run()
      cursor = parent.parentTaskId
    }
  })
  claim = await dependencies.persistence.terminalMaintenance.transition({
    claim,
    to: 'db-finalized',
  })
  await dependencies.deletionEvents.committed({ taskIds, visibleUserIdsByTask })
  const cleanup = await cleanupDeletedTask(taskIds, worktrees, dependencies.appHome ?? Paths.root)
  if (cleanup === 'done') {
    await dependencies.persistence.terminalMaintenance.complete({ claim })
  } else {
    await dependencies.persistence.terminalMaintenance.transition({
      claim,
      to: 'cleanup-pending',
    })
  }
  return { taskId, cleanup }
}

/** Complete PostgreSQL binding for the classic `/api/tasks` surface. */
export function createPostgresqlTaskRouteOperations(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
): TaskRouteOperations & Pick<PostgresqlTaskRepairOperations, 'automaticRepair'> {
  const authorization = createTaskAuthorizationQueries(dependencies.db)
  const launches = createPostgresqlTaskExecutionLaunchParticipant({
    db: dependencies.db,
    ...dependencies.launch,
  })
  const repairs = createPostgresqlTaskRouteRepairOperations({
    db: dependencies.db,
    persistence: dependencies.persistence,
    children: dependencies.children,
    activity: dependencies.activity,
    topology: dependencies.topology,
    resumeRuntimeFor: dependencies.resumeRuntimeFor,
    collaborationRuntime: dependencies.repair.collaborationRuntime,
    clarify: dependencies.repair.clarify,
    review: dependencies.repair.review,
    appHome: dependencies.appHome ?? Paths.root,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
  })

  const operations: TaskRouteOperations = {
    list: async (filters) =>
      (await listSummaries(dependencies.db, filters)).map((row) => row.summary),
    listItems: (filters) => listItems(dependencies, filters),
    get: (taskId) => loadTask(dependencies.db, taskId),
    async assertVisible(actor, taskId) {
      if (actor.permissions.has('tasks:read:all')) return
      const visible = await authorization.canViewTask({
        subject: {
          userId: actor.user.id,
          canReadAllTasks: false,
        },
        taskId,
      })
      if (!visible) {
        throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      }
    },
    async requireOperator(actor, taskId) {
      const task = await requireTaskRow(dependencies.db, taskId)
      if (
        actor.permissions.has('resource-acl:bypass') ||
        task.ownerUserId === actor.user.id ||
        (await actingMember(dependencies.db, taskId, actor.user.id))
      ) {
        return
      }
      throw new ForbiddenError(
        'not-task-member',
        'only the task owner, a collaborator, or an authorized operator may mutate this task',
      )
    },
    async assertReplayVisible(actor, sourceTaskId) {
      await operations.assertVisible(actor, sourceTaskId)
      if ((await loadTask(dependencies.db, sourceTaskId)) === null) {
        throw new NotFoundError('task-not-found', `task '${sourceTaskId}' not found`)
      }
    },
    getMembers: (actor, taskId) => taskMembers(dependencies, actor, taskId),
    replaceMembers: (actor, taskId, body) => replaceTaskMembers(dependencies, actor, taskId, body),
    getReviewers: (actor, taskId) =>
      getReviewNodeReviewerConfig(dependencies.collaboration, { actor, taskId }),
    replaceReviewers: (actor, taskId, body) =>
      replaceReviewNodeReviewers(dependencies.collaboration, { actor, taskId, body }),
    async launchWorkflow(actor, task) {
      const authority = dependencies.launch.resourceAuthorityFor(actor)
      return await launches.launch({
        actor,
        target: { kind: 'workflow', refId: task.workflowId, payload: task },
        invoker: { type: 'user', launchKind: 'direct-json' },
        resources: authority,
      })
    },
    launchMultipart: (request, actor) => launchMultipart(dependencies, request, actor),
    async cancel(taskId) {
      await dependencies.children.cancel({ taskId, cause: { kind: 'user' } })
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    delete: (taskId) => deleteTask(dependencies, taskId),
    async resume({ actor, taskId }) {
      await dependencies.children.resume(
        { taskId, runtime: dependencies.resumeRuntimeFor(actor, taskId) },
        dependencies.topology,
      )
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    retry: (input) => retryNode(dependencies, input),
    nodeRuns: (taskId) => taskNodeRuns(dependencies, taskId),
    diff: (taskId) => taskDiff(dependencies, taskId),
    stdout: (taskId, nodeRunId) => nodeRunStdout(dependencies, taskId, nodeRunId),
    events: (taskId, nodeRunId, options) =>
      nodeRunEventsPage(dependencies, taskId, nodeRunId, options),
    async assertManualExecutionAllowed(actor, taskId) {
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) return
      const kind = taskExecutionKind(task)
      if (kind === 'agent' || kind === 'code-round') return
      if (
        isWorkgroupTask(task) &&
        !isTurnEngineWorkgroupTask({
          workgroupId: task.workgroupId,
          workgroupConfigJson: (await requireTaskRow(dependencies.db, taskId)).workgroupConfigJson,
        })
      ) {
        return
      }
      // 判据缺口账本 01a —— 与 SQLite 的 `assertManualExecutionAllowed` 同判据：
      // 内置工作流不可被手动执行（403 `builtin-readonly`）。可见性那一步是 PG 侧既有的
      // 额外判据，保留在其后。
      const candidate = await builtinCandidateWorkflow(dependencies.db, task.workflowId)
      if (candidate !== null) assertNotBuiltin('workflow', candidate)
      await loadVisibleWorkflow(dependencies, actor, task.workflowId)
    },
    workflowSyncPreview: (actor, taskId) => workflowSyncPreview(dependencies, actor, taskId),
    syncWorkflow: (input) => syncWorkflow(dependencies, input),
    repairOptions: (input) => repairs.repairOptions(input),
    applyRepair: (input) => repairs.applyRepair(input),
  }
  return Object.freeze({ ...operations, automaticRepair: repairs.automaticRepair })
}
