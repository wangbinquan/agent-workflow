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
  isHumanReviewConclusion,
  isTerminalNodeRunStatus,
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
import { and, asc, count, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { TaskExecutionResourceAuthority } from '../application/ports/taskExecutionResourceSnapshots'
import {
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskRepos,
  taskSpaceNodes,
  tasks,
  workflows,
} from '@/db/schema'
import { replaceReviewNodeReviewers } from '@/modules/collaboration/public/commands'
// RFC-328：跨 context 走 facade，不直接 import 别人的 infrastructure
//（`@/services/taskCollab` 就是 collaboration 那套成员 / 可见性判据的既有 facade，
// SQLite 那一侧一直走的也是它）。
import {
  assertCanReplaySourceTask,
  canViewTask,
  getTaskMembers,
  requireTaskOperator,
  updateTaskMembers,
} from '@/services/taskCollab'
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
import {
  defaultTaskListRowRef,
  taskListOwnershipScopeCondition,
} from './taskListPage/authorization'
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
  createPostgresqlTaskExecutionLaunchParticipant,
  type PostgresqlTaskExecutionLaunchParticipant,
  type PostgresqlTaskRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import {
  createPostgresqlTaskRouteRepairOperations,
  type PostgresqlTaskRepairOperations,
} from './postgresqlTaskRouteRepairOperations'
import { withSerializableTaskExecution } from './postgresqlTaskLifecycleTransaction'
import {
  appendTaskLifecycleTransitionCommittedEvent,
  appendTaskNodeStatusesCommittedEvent,
} from './taskLifecycleCommittedEvents'
import { readArchivedEvents } from '@/platform/background/eventsArchiveReader'

function lacksMaterializedWorkspace(path: string): boolean {
  return path.length === 0
}
import { parsePortValidationFailuresJson } from '@/services/envelope'
import { parseMultipartLaunch } from '@/services/launchMultipart'
import { deleteTask } from '@/services/taskDelete'
import { parseInjectedSnapshotJson } from '@/modules/memory/public/types'
import { loadTaskFailureCodes, projectWorkflowSnapshotForRead } from '@/services/task'
import { readNodeRunPrompt } from '@/services/nodeRunPrompt'
import { assertNotBuiltin } from '@/services/systemResources'
import { compareNodeRunsForTimeline, deriveReviewRoundTiming } from '@/services/reviewRoundStart'
import { canonicalRepoKeysWire } from '@/services/repoLabels'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import { assertFrozenTaskTriggerPreflight } from './frozenTaskTriggerPreflight'
import {
  loadRollbackTargetFrom,
  rollbackNodeRunWorktrees,
  snapshotMissingDetail,
} from '@/services/nodeRollback'
import { selectSyncRollbackTargets } from '@/services/task'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { killStaleRunProcessTree } from '@/util/process'
import { gitDiffSnapshot, isGitWorkTree, worktreeDiff } from '@/util/git'
import { Paths } from '@/util/paths'
import { createInFlightCoalescer, type InFlightCoalescer } from '@/util/inFlight'
import {
  builtinWorkflowSyncPreview,
  notSyncableWorkflowPreview,
  workflowSyncGateReason,
} from '../domain/workflowSyncPreview'

const log = createLogger('task-execution.postgresql-task-routes')

const TASK_DIFF_MAX_BYTES = 1024 * 1024
/**
 * RFC-311 T13 —— stdout 尾巴的两道闸。字节预算保持一个用户能记住的数字（1 MiB）；
 * 行数上限是内存侧的第二道闸（单行也可能很大）。
 */
export const STDOUT_TAIL_BUDGET_BYTES = 1024 * 1024
export const STDOUT_TAIL_ROW_CAP = 50_000
/** 截断必须**说出来**——静默丢日志会让人以为节点没输出过那段。 */
export const STDOUT_OMITTED_MARKER =
  '[… earlier output omitted: this view shows the most recent 1 MiB …]'
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

export interface PostgresqlTaskRouteOperationsDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly collaboration: CollaborationCommandContext<'taskExecutionReadModels'>
  readonly launch: Omit<PostgresqlTaskRouteLaunchDependencies, 'db'>
  /**
   * RFC-359 AC-1（plan §5hn 批次二 ⑥）：**启动参与者**（两个引擎共用的那一个）。
   * multipart 路由从此只解析表单 + 跑路由级门，「冻结快照 → 版本围栏 → 静态校验 →
   * 启动输入契约 → 根内核」那一串交给参与者——SQLite 的 JSON 路由（批次二 ④）
   * 已经是这个形状，这里让 multipart 也接上去，两条路由因此共用同一份编排。
   */
  readonly launches: PostgresqlTaskExecutionLaunchParticipant
  readonly persistence: TaskExecutionPersistence
  readonly children: ChildTaskLifecycleParticipant
  readonly activity: ActiveTaskExecutionParticipant
  readonly topology: SchedulerRuntimeTopology
  readonly resumeRuntimeFor: (actor: Actor, taskId: string) => ChildResumeRuntime
  readonly repositoryPreparationRetry: RepositoryPreparationRetryCommand
  readonly users: TaskRouteUserDirectory
  readonly owners: OwnerIdentityQueries
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
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
  workflowIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{ name: string; builtin: boolean; version: number }>>> {
  const wanted = [...new Set(workflowIds)]
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      builtin: workflows.builtin,
      version: workflows.version,
    })
    .from(workflows)
    .where(inArray(workflows.id, wanted))
  return new Map(
    rows.map((row) => [
      row.id,
      { name: row.name, builtin: row.builtin === true, version: row.version },
    ]),
  )
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
): Promise<Readonly<{ builtin: boolean; version: number }> | null> {
  return (await workflowIdentities(db, [workflowId])).get(workflowId) ?? null
}

async function taskProjection(db: ProviderNeutralDatabase, row: TaskRow): Promise<Task> {
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

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 3 刀）—— `GET /api/tasks/:id` 的行投影，
 * 两个引擎共用一份。等价性由 `rfc359-w7-task-route-conformance` 的 A1 / A2 作证。
 */
export async function loadTaskProjection(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<Task | null> {
  return await loadTask(db, taskId)
}

async function loadTask(db: ProviderNeutralDatabase, taskId: string): Promise<Task | null> {
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

/**
 * RFC-359 W57：归属范围判据走 `taskListPage/authorization.ts` 的**唯一一份**（同一个 bounded
 * context 内，直接用）。此前这里是仓里第七份手写副本，而且是 **provider 专属**的那一份——
 * 正是本 RFC 要消灭的形状：同一条授权判据，PostgreSQL 上一份、别处一份，谁漂了都表现为
 * 「用户看见不该看见的任务」或「丢掉本该看见的」。
 *
 * `shared` 那一支两边写法不同但等价：这里原本写 `IS DISTINCT FROM`，共享那份写
 * `or(isNull(owner), ne(owner, me))`——SQL 三值逻辑下同义（`owner IS NULL` 时 `ne` 是 NULL
 * 而不是真，所以必须并上 `isNull`）。三态由 `rfc357-task-list-authorization` 钉住。
 */
function visibilityCondition(
  db: ProviderNeutralDatabase,
  visibility: NonNullable<TaskRouteListFilters['visibility']>,
): SQL<unknown> {
  return taskListOwnershipScopeCondition(
    db,
    defaultTaskListRowRef(),
    visibility.actorUserId,
    visibility.scope,
  )
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
} & { workflowName: string | null }

async function listRows(
  db: ProviderNeutralDatabase,
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
  // 工作流名与行**同一次查询**取回（此前 PostgreSQL 侧是行一次、名字再一次批量）。
  // 列表上界 10k、首页每 10s 轮一次，少一次往返在 PG 上是实打实的；SQLite 侧本来就是这么写的。
  return await db
    .select({ ...TASK_LIST_COLUMNS, workflowName: workflows.name })
    .from(tasks)
    .leftJoin(workflows, eq(workflows.id, tasks.workflowId))
    .where(predicates.length === 0 ? undefined : and(...predicates))
    .orderBy(desc(tasks.startedAt))
    .limit(filters.limit ?? 100)
}

async function listSummaries(
  db: ProviderNeutralDatabase,
  filters: TaskRouteListFilters,
): Promise<readonly Readonly<{ summary: TaskSummary; ownerUserId: string | null }>[]> {
  const rows = await listRows(db, filters)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  // RFC-108 T22：整页告警数一次分组查询，列表才能不按行探测就渲染「卡住」徽标。
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
  return rows.map((row) => ({
    summary: summaryProjection(
      row,
      alerts.get(row.id) ?? 0,
      failureCodes.has(row.id) ? (failureCodes.get(row.id) ?? null) : undefined,
      row.workflowName,
    ),
    ownerUserId: row.ownerUserId ?? null,
  }))
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 3 刀）—— 任务列表的**并发单飞合并**，两个引擎共用一份。
 *
 * 为什么列表要单飞：首页每 10s 轮一次 `GET /api/tasks`，多标签页 + WS 失效风暴下同一形状的
 * 查询会同时到达好几份。它们查的是同一批行，合并成一次库访问即可。
 *
 * **合并键对整个 filters 对象做规范序列化**，不是手写字段清单——手写清单漏过一次
 *（RFC-301 加 `origin` 时没同步加进来，于是 `?origin=scheduled` 与 `?origin=api` 并发到达时
 * 后者收到前者的行），而漏的症状是「列表偶尔少几条 / 串了」，没人会当成 bug 报。
 * 回归防护见 `tests/rfc359-task-list-inflight-key.test.ts`。
 *
 * 合并表按**库句柄**分桶（`WeakMap`），所以两个引擎、两套测试夹具互不串台。
 */
const taskListFlights = new WeakMap<object, InFlightCoalescer<string, readonly TaskSummary[]>>()

function taskListFlight(
  db: ProviderNeutralDatabase,
): InFlightCoalescer<string, readonly TaskSummary[]> {
  const owner = db as unknown as object
  const existing = taskListFlights.get(owner)
  if (existing !== undefined) return existing
  const created = createInFlightCoalescer<string, readonly TaskSummary[]>()
  taskListFlights.set(owner, created)
  return created
}

function taskListFlightKey(filters: TaskRouteListFilters): string {
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonical)
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue
      out[key] = canonical(record[key])
    }
    return out
  }
  return JSON.stringify(canonical(filters))
}

/**
 * RFC-359 AC-1（同上，第 3 刀）—— `GET /api/tasks` 的行投影，两个引擎共用一份。
 *
 * 行、工作流名一次查询取回；未解决告警数与失败码各一次批量（都不是按行探测）。
 * 等价性由 `rfc359-w7-task-route-conformance` 的 A3 / A4 作证。
 */
export async function taskListSummariesProjection(
  db: ProviderNeutralDatabase,
  filters: TaskRouteListFilters,
): Promise<readonly TaskSummary[]> {
  return await taskListFlight(db)(taskListFlightKey(filters), async () =>
    (await listSummaries(db, filters)).map((row) => row.summary),
  )
}

/** RFC-359 AC-1（同上）—— `GET /api/tasks?include_owner=true` 的行投影，两个引擎共用一份。 */
export async function taskListItemsProjection(
  dependencies: Readonly<{ db: ProviderNeutralDatabase; owners: OwnerIdentityQueries }>,
  filters: TaskRouteListFilters,
): Promise<readonly TaskListItem[]> {
  return await listItems(dependencies, filters)
}

async function listItems(
  dependencies: Readonly<{ db: ProviderNeutralDatabase; owners: OwnerIdentityQueries }>,
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

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 4 刀）—— 任务的**访问门 + 成员四件**，两个引擎共用一份。
 *
 * 合并前这一族在两侧是两套：SQLite 转给 `modules/collaboration/infrastructure/taskCollab.ts`
 * 的中立实现，PostgreSQL 在本文件里另写了一份内联的。对读之后取 `taskCollab` 那一份——
 * 它**严格更全**：RFC-324 的观察者只读文案（PG 那份统一回泛化的 `not-task-member`）、
 * 与评审写同一把任务 FIFO 锁（`withTaskReviewMutationLock`，PG 那份只锁聚合根事务，
 * 成员变更与评审写可以交错）、锁内重读任务行（路由读到的行可能已过期）、
 * 以及提交后的 WS 重校验 + 列表广播。聚合根锁本身两份都有（RFC-359 W9 实测的
 * 32 并发 22.9% 冲突那条），所以取它不丢 PostgreSQL 的并发性质。
 *
 * **存在性口径统一成「不存在即 404」**（原 PG 那一档）。合并前 SQLite 取不到行就**不判**、
 * 静默放行，靠路由随后自己 404——两侧最终 HTTP 状态相同，但方法层面的契约不同：
 * 一道对不存在的 id 说「行」的门，在别的调用方手里就是个谎。
 */
async function taskAccessRow(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<Readonly<{ id: string; ownerUserId: string | null }>> {
  const rows = await db
    .select({ id: tasks.id, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  return row
}

/** 可见性门：全读权限直接放行；否则不存在与不可见同形（都 404）。 */
export async function assertTaskVisibleProjection(
  db: ProviderNeutralDatabase,
  actor: Actor,
  taskId: string,
): Promise<void> {
  if (actor.permissions.has('tasks:read:all')) return
  const task = await taskAccessRow(db, taskId)
  if (!(await canViewTask(db, actor, task))) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
}

/** 操作权门：owner / collaborator / bypass 放行，observer 拿 RFC-324 的只读文案。 */
export async function requireTaskOperatorProjection(
  db: ProviderNeutralDatabase,
  actor: Actor,
  taskId: string,
): Promise<void> {
  await requireTaskOperator(db, actor, await taskAccessRow(db, taskId))
}

/** 成员面板的读投影。 */
export async function taskMembersProjection(
  db: ProviderNeutralDatabase,
  actor: Actor,
  taskId: string,
): Promise<TaskMembers> {
  return await getTaskMembers(db, actor, await taskAccessRow(db, taskId))
}

/** 成员面板的全量替换。 */
export async function replaceTaskMembersProjection(
  db: ProviderNeutralDatabase,
  actor: Actor,
  taskId: string,
  body: Parameters<TaskRouteOperations['replaceMembers']>[2],
): Promise<TaskMembers> {
  return await updateTaskMembers(db, actor, await taskAccessRow(db, taskId), body)
}

function workflowLaunchSnapshot(snapshots: readonly FrozenTaskExecutionResourceSnapshot[]) {
  const snapshot = snapshots[0]
  if (snapshot?.kind !== 'workflow-launch') {
    throw new Error('task-execution-resource-kind-mismatch:workflow-launch')
  }
  return snapshot.workflow
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ⑥）—— multipart `POST /api/tasks` 的**唯一编排**，两个引擎共用。
 *
 * 形参刻意收窄到它真正用的三格（库句柄、启动参与者、鉴权句柄工厂），而不是整个路由依赖束：
 * SQLite 的路由依赖是另一个类型，收窄之后两侧都交得起，不必为了共用而把类型硬凑成一个。
 */
export interface TaskRouteMultipartLaunchDependencies {
  readonly db: ProviderNeutralDatabase
  readonly launches: PostgresqlTaskExecutionLaunchParticipant
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
}

export async function launchMultipartTask(
  dependencies: TaskRouteMultipartLaunchDependencies,
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
  // RFC-359 AC-1（plan §5hn 批次二 ⑥）：**两个引擎共用这一条 multipart 路**。
  //
  // 此前这里手拼了一遍「冻结快照 → 版本围栏 → 静态校验 → 启动输入契约 → 根内核」，
  // 而那正是启动参与者工作流臂**逐字在做**的事——同一件事的第二份写法，
  // 于是每补一道门就要记得补两处（批次二 ④ 的启动输入契约、批次二 ⑥ 的候选上下文，
  // 两次都是只补了一处才被基线照出来）。现在这条路只负责**解析 multipart 与路由级门**
  //（`assignments` / 退役键 / `sourceTaskId` 可见性），其余交给参与者。
  //
  // 上传分片只交 `parts`：上传声明与体积上限由参与者从**冻结快照** + `configPath` 派生。
  return await dependencies.launches.launch({
    actor,
    target: { kind: 'workflow', refId: task.data.workflowId, payload: task.data },
    invoker: { type: 'user', launchKind: 'direct-multipart' },
    resources: dependencies.resourceAuthorityFor(actor),
    uploads: { parts: parsedMultipart.parts },
  })
}

function commitPush(raw: string | null) {
  const value = parseJson(raw, null)
  const parsed = CommitPushMetaSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 1 刀）—— **任务 node-runs 投影的唯一实现**，两个引擎共用。
 *
 * 形参收窄到它真正用的那一格（库句柄），而不是整个路由依赖束：SQLite 的路由依赖是另一个类型，
 * 收窄之后两侧都交得起，不必为了共用而把类型硬凑成一个（与 `launchMultipartTask` 同一条判据）。
 *
 * 合并前的等价性由 `rfc359-w5hn-task-read-route-provider-parity` 作证：同一批
 * `node_runs` / `doc_versions` / `clarify_rounds` 播种下，两个引擎投影出的响应体逐字相同
 * （变异实证：把 PG 侧 `reviewNavKind = 'awaiting'` 改成 `null`，当场红）。
 */
export async function taskNodeRunsProjection(
  dependencies: Readonly<{ db: ProviderNeutralDatabase }>,
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
  db: ProviderNeutralDatabase,
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

/**
 * 任务纯读投影的共同依赖。
 *
 * `logsDir` 是归档事件的落盘根目录，缺省 `Paths.logsDir`；用例要一个可控目录时从这里给。
 * 这个旋钮此前只存在于 SQLite 那一份上（`services/task.ts` 的 `opts.logsDir`），
 * PostgreSQL 那份写死 `Paths.logsDir`——合并成一份后两个引擎同样可测。
 */
export interface TaskReadProjectionDependencies {
  readonly db: ProviderNeutralDatabase
  readonly logsDir?: string
}

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 2 刀）—— node-run 事件分页，两个引擎共用同一份。
 *
 * 归档（更旧）在前、库内活行在后，一路按 id 升序；`limit` 缺省 500、上限 1000（W7 把
 * PostgreSQL 从 1000 / 5000 拉齐到这份契约，前端的游标推进按条数判还有没有下一页，
 * 两侧不能各说各话）。等价性由 `rfc359-w5hn-task-read-route-provider-parity` 作证。
 */
export async function nodeRunEventsProjection(
  dependencies: TaskReadProjectionDependencies,
  taskId: string,
  nodeRunId: string,
  options: Readonly<{ since?: number; limit?: number }>,
) {
  await assertNodeRunOwner(dependencies.db, taskId, nodeRunId)
  const since = options.since ?? 0
  const limit = Math.min(options.limit ?? 500, 1000)
  const logsDir = dependencies.logsDir ?? Paths.logsDir
  const archived = await readArchivedEvents(logsDir, taskId, nodeRunId, since, limit)
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

/**
 * RFC-359 AC-1（同上，第 2 刀）—— node-run 的 stdout **尾巴**，两个引擎共用同一份。
 *
 * RFC-311 T13 的保尾 + 有界读原样保留：库内倒序取到预算即停（那就是尾巴）；尾巴被库内
 * 填满则归档严格更旧、根本不读；没填满才读归档并给行数上限，上限命中时整段标为省略——
 * 归档读取器只能从头顺读、取不到它的尾巴，拿最旧的一段来充数比明说省略更误导。
 * `stderr` 不进这个视图（那个频道在 Events 页）。
 */
export async function nodeRunStdoutProjection(
  dependencies: TaskReadProjectionDependencies,
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
      dependencies.logsDir ?? Paths.logsDir,
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

/**
 * RFC-359 AC-1（同上，第 2 刀）—— 任务工作树的累计 diff，两个引擎共用同一份。
 *
 * 单仓（`repoCount === 1`，前 RFC-066 的字节基线）：先查 base commit（缺 → 409），
 * 再查工作树（不是 git 工作树 → 410），然后回 `worktreeDiff` 的 1 MiB 封顶结果。
 * **检查次序不能调**：两门同时失败时必须先报 409——「任务在准备阶段就没成」是主因，
 * 工作树在不在是次要信息（`rfc359-w5hn-task-read-route-provider-parity` 专门钉了这一格）。
 *
 * 410 的文案**分两句说**：目录根本不存在 / 目录还在但已不是有效的 git 仓库（源仓被移动或
 * 删除，链接工作树的 gitdir 指针悬空）。这是两种完全不同的现场，用户要据此决定是重建工作树
 * 还是去找源仓。合并前 PostgreSQL 那一份把两种压成一句泛化的 `is unavailable`，SQLite 分得清
 * ——取 SQLite 这份，因为信息严格更多。
 *
 * 多仓（RFC-066 PR-B T12）：按 `repoIndex` 顺序逐仓对各自的 `base_commit` 出 diff，
 * 每段冠一行 `# === Repo: <挂载路径> ===`（RFC-248 D15 的规范 key，与结构化 diff 同源），
 * 空 diff 的仓不出头。只读成员不进任务 diff（RFC-248 D11）。坏分片（缺 base / 目录没了 /
 * 已不是 git 仓）逐个跳过，不为一个坏分片短掉整次调用；但**一个可用的都没有时报 409**，
 * 而不是回一个空 diff——「没东西可比」与「比过了没有改动」在用户面前是两件事。
 * 总预算同为 1 MiB，与单仓分支共用的 `worktreeDiff` 一样按字符串长度记账。
 */
export async function taskDiffProjection(
  dependencies: Readonly<{ db: ProviderNeutralDatabase }>,
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
    // `existsSync` 不够：工作树目录可以比它的源仓活得久（源仓被移动 / 删除），留下一个
    // git 解析不了的目录。在这里探一次，把 `git diff` 那份 600 行的 `--no-index` 用法转储
    // 换成一个干净的 410。
    if (!(await isGitWorkTree(task.worktreePath))) {
      throw new DomainError(
        'task-worktree-missing',
        existsSync(task.worktreePath)
          ? `worktree '${task.worktreePath}' is no longer a valid git repository (its source repo was moved or deleted); cannot compute diff`
          : `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
        410,
      )
    }
    const result = await worktreeDiff(task.worktreePath, task.baseCommit)
    return { ...result, baseCommit: task.baseCommit }
  }

  // 多仓：父工作树目录必须在（它是 runtime 子进程的 cwd）。
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
      410,
    )
  }
  const candidates = task.repos.filter(
    (repo) => repo.baseCommit !== null && repo.baseCommit !== '' && existsSync(repo.worktreePath),
  )
  const valid = await Promise.all(candidates.map((repo) => isGitWorkTree(repo.worktreePath)))
  const usable = candidates.filter((_, index) => valid[index] === true)
  if (usable.length === 0) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute diff`,
      409,
    )
  }
  const labels = canonicalRepoKeysWire(task.repos)
  const labelOf = new Map(task.repos.map((repo, index) => [repo, labels[index] ?? '.']))
  let diff = ''
  let truncated = false
  for (const repo of usable) {
    if (repo.readonly === true) continue
    const value = await gitDiffSnapshot(repo.worktreePath, repo.baseCommit as string)
    if (value === '') continue
    const header = `# === Repo: ${labelOf.get(repo) ?? '.'} ===\n`
    const remaining = TASK_DIFF_MAX_BYTES - diff.length
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (header.length >= remaining) {
      // 连表头都放不下——能写多少写多少然后收手。
      diff += header.slice(0, remaining)
      truncated = true
      break
    }
    diff += header
    const bodyBudget = TASK_DIFF_MAX_BYTES - diff.length
    if (value.length > bodyBudget) {
      diff += value.slice(0, bodyBudget)
      truncated = true
      break
    }
    diff += value
    if (!diff.endsWith('\n')) diff += '\n'
  }
  return { diff, baseCommit: null, truncated }
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
    return notSyncableWorkflowPreview(task, 'workflow-deleted')
  }
  // 判据缺口 —— 内置工作流的预览必须是 `builtin-workflow`（RFC-104：它永远不可被手动 sync）。
  // 这一步要在可见性装载**之前**：`loadVisibleWorkflow` 走的是可启动性授权，内置工作流在那里
  // 就被挡住，异常被下面的 catch 兜成 `workflow-deleted` —— 横幅内容直接是错的。
  const builtinCandidate = await builtinCandidateWorkflow(dependencies.db, task.workflowId)
  if (builtinCandidate?.builtin === true) {
    return builtinWorkflowSyncPreview(task, builtinCandidate.version)
  }
  await dependencies.activity.awaitReleasedSettled(taskId)
  if (dependencies.activity.isActive(taskId)) return notSyncableWorkflowPreview(task, 'task-active')
  let loaded: Awaited<ReturnType<typeof loadVisibleWorkflow>>
  try {
    loaded = await loadVisibleWorkflow(dependencies, actor, task.workflowId)
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? Reflect.get(error, 'code')
        : null
    return notSyncableWorkflowPreview(
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
  // 判据缺口 —— 可同步与否此前在 PG 侧只看**进程内**活跃表，于是一个持久化状态就是 `running`
  // 的任务（守护进程刚重启、或由别的进程在跑）预览成 `syncable: true`，而 `syncWorkflow` 用的是
  // 状态 + 工作树判据，点下去稳定 409。两边现在共用 `workflowSyncGateReason`。
  const reason = workflowSyncGateReason({
    status: task.status,
    // 工作树判据与 SQLite 侧**逐字相同**（空路径即没有工作树）。PG 的 `syncWorkflow` 另有一条
    // `workspacePrunedAt !== null`，SQLite 的 `syncTaskWorkflow` 没有——那条差异是既有的，
    // 不在本次收敛范围内（见 RFC-359 plan §5u）；这里不擅自把它带进预览，否则预览与 SQLite
    // 又分叉一次。
    worktreeMissing: task.worktreePath === '',
  })
  return {
    syncable: reason === 'ok',
    reason,
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
// 被取消写节点的工作树回滚。其中**冻结溯源预检已经合一**：两个 provider 都调
// `services/execution/triggerPreflight.ts` 的 `assertFrozenTaskTriggerPreflight`
// （RFC-359 W8 收掉了那对逐字相同的私有副本）。另外两件（`escalateSnapshotLost` /
// `escalateLiveChildSurvived` / `selectSyncRollbackTargets`）的权威实现仍在
// `services/task.ts`；下面是同口径的 PG 侧实现，判据与错误码逐条对齐，行为差异只在
// 每处注释显式写明的地方。
// ─────────────────────────────────────────────────────────────────────────────

/** RFC-359 W8 —— MR/PR 终结栅栏的透传（SQLite 侧由准入 CAS 抛出同名码）。 */
function assertNotSourceTerminated(task: Pick<TaskRow, 'id' | 'sourceTerminationFence'>): void {
  const code = sourceTerminationRevivalError(task.sourceTerminationFence)
  if (code === null) return
  throw new ConflictError(
    code,
    `task '${task.id}' is fenced by an MR/PR ${task.sourceTerminationFence} event`,
  )
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
    const detail = snapshotMissingDetail(outcome)
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
    const detail = snapshotMissingDetail(outcome)
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
  const eventRef = await withSerializableTaskExecution(dependencies.db, async (tx) => {
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
  const committed = await withSerializableTaskExecution(dependencies.db, async (tx) => {
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

// 两个调用点：一个传客户端本身，一个传事务句柄。RFC-359 W5-T18 之后事务句柄是中立的
// `DatabaseTransaction`，客户端仍是 PG 客户端——取二者共同的读面（`ProviderNeutralDatabase`
// 是两个 provider 客户端的公共基类型，见 `db/query.ts`）。

/** Complete PostgreSQL binding for the classic `/api/tasks` surface. */
export function createPostgresqlTaskRouteOperations(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
): TaskRouteOperations & Pick<PostgresqlTaskRepairOperations, 'automaticRepair'> {
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
    list: (filters) => taskListSummariesProjection(dependencies.db, filters),
    listItems: (filters) => listItems(dependencies, filters),
    get: (taskId) => loadTask(dependencies.db, taskId),
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 4 刀）：访问门 + 成员四件与 SQLite 共用**同一份**。
    // 取的是 `taskCollab` 那一份（原 SQLite 侧转发的目标）——它严格更全：RFC-324 观察者只读
    // 文案、与评审写同一把任务 FIFO 锁、锁内重读任务行。存在性口径统一成「不存在即 404」。
    assertVisible: (actor, taskId) => assertTaskVisibleProjection(dependencies.db, actor, taskId),
    requireOperator: (actor, taskId) =>
      requireTaskOperatorProjection(dependencies.db, actor, taskId),
    assertReplayVisible: (actor, sourceTaskId) =>
      assertCanReplaySourceTask(dependencies.db, actor, sourceTaskId),
    getMembers: (actor, taskId) => taskMembersProjection(dependencies.db, actor, taskId),
    replaceMembers: (actor, taskId, body) =>
      replaceTaskMembersProjection(dependencies.db, actor, taskId, body),
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
        // RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）：**JSON body 启动延后仓库准备**。
        // 这一格只有路由自己知道——隔壁 `launchMultipart` 走的是同一台内核，但它必须
        // 保持预物化（上传物要写进真工作树），所以判据不能放在内核里按 invoker 猜。
        deferRepoPreparation: true,
      })
    },
    launchMultipart: (request, actor) =>
      launchMultipartTask(
        {
          db: dependencies.db,
          launches: dependencies.launches,
          resourceAuthorityFor: dependencies.launch.resourceAuthorityFor,
        },
        request,
        actor,
      ),
    async cancel(taskId) {
      await dependencies.children.cancel({ taskId, cause: { kind: 'user' } })
      const task = await loadTask(dependencies.db, taskId)
      if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
      return task
    },
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 5 刀）：`delete` 与 SQLite 共用**同一份**
    //（`services/taskDelete.ts`，上一提刚把它从 bun:sqlite 专有句柄中立化）。本文件里那份
    // 184 行的内联实现随之退役；提交后的 WS 广播由共用实现自己做，`deletionEvents`
    // 这个转发端口与它在组合根里的绑定一并删除（与第 4 刀的 `membershipEvents` 同形）。
    delete: (taskId) => deleteTask(dependencies.db, taskId, { activity: dependencies.activity }),
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
    nodeRuns: (taskId) => taskNodeRunsProjection(dependencies, taskId),
    diff: (taskId) => taskDiffProjection(dependencies, taskId),
    stdout: (taskId, nodeRunId) => nodeRunStdoutProjection(dependencies, taskId, nodeRunId),
    events: (taskId, nodeRunId, options) =>
      nodeRunEventsProjection(dependencies, taskId, nodeRunId, options),
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
