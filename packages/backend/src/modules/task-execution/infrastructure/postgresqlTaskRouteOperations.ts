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
import { ascNullsFirst } from '@/platform/persistence/postgresqlNullOrdering'
import { branchTraceForTask } from '../application/branchTrace'
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
import { PostgresqlBranchTraceSnapshotReader } from './postgresqlBranchTraceSnapshotReader'
import { createPostgresqlNodeRunMintParticipantInTx } from './postgresqlNodeRunMintParticipant'
import { createPostgresqlTaskAuthorizationQueries } from './postgresqlTaskAuthorization'
import {
  createPostgresqlRootTaskLaunchKernel,
  createPostgresqlTaskExecutionLaunchParticipant,
  type PostgresqlTaskRouteLaunchDependencies,
} from './postgresqlTaskRouteLaunchOperations'
import { createPostgresqlTaskRouteRepairOperations } from './postgresqlTaskRouteRepairOperations'
import {
  appendPostgresqlTaskLifecycleTransitionTx,
  appendPostgresqlTaskNodeStatusesTx,
  withPostgresqlSerializableTaskExecution,
  withPostgresqlTaskAggregateTransaction,
} from './postgresqlTaskLifecycleTransaction'
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
import { readNodeRunPrompt } from '@/services/nodeRunPrompt'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { deriveReviewRoundTiming } from '@/services/reviewRoundStart'
import { canonicalRepoKeysWire } from '@/services/repoLabels'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/util/errors'
import {
  deleteSnapshotRefs,
  gitDiffSnapshot,
  isGitWorkTree,
  removeWorktree,
  worktreeDiff,
} from '@/util/git'
import { Paths } from '@/util/paths'

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

async function taskProjection(db: PostgresqlDatabaseClient, row: TaskRow): Promise<Task> {
  const [repoRows, nodeRows, failureCode] = await Promise.all([
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
  ])
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
    workflowName: null,
    workflowSnapshot: parseJson(row.workflowSnapshot, null),
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
  row: TaskRow,
  openAlertCount: number,
  failureCode: string | null | undefined,
): TaskSummary {
  return TaskSummarySchema.parse({
    id: row.id,
    name: row.name,
    workflowId: row.workflowId,
    workflowName: null,
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

async function listRows(
  db: PostgresqlDatabaseClient,
  filters: TaskRouteListFilters,
): Promise<readonly TaskRow[]> {
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
  if (filters.topLevelOnly === true) predicates.push(isNull(tasks.parentTaskId))
  if (filters.parentTaskId !== undefined)
    predicates.push(eq(tasks.parentTaskId, filters.parentTaskId))
  if (filters.visibility !== undefined) predicates.push(visibilityCondition(db, filters.visibility))
  return await db
    .select()
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
  return await Promise.all(
    rows.map(async (row) => ({
      summary: summaryProjection(row, alerts.get(row.id) ?? 0, await failedCode(db, row)),
      ownerUserId: row.ownerUserId ?? null,
    })),
  )
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
    const visible = await createPostgresqlTaskAuthorizationQueries(dependencies.db).canViewTask({
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
      .orderBy(ascNullsFirst(nodeRuns.startedAt), asc(nodeRuns.id)),
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
    new PostgresqlBranchTraceSnapshotReader(dependencies.db),
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
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 5000))
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
  const labels = canonicalRepoKeysWire(task.repos)
  let diff = ''
  let truncated = false
  for (let index = 0; index < task.repos.length; index += 1) {
    const repo = task.repos[index]!
    if (
      repo.readonly ||
      repo.baseCommit === null ||
      repo.baseCommit === '' ||
      !(await isGitWorkTree(repo.worktreePath))
    ) {
      continue
    }
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
  const diff = diffWorkflowForSync(
    definitionOf(parseJson(row.workflowSnapshot, null)),
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
    return await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: input.taskId,
      lifecycleRevision: changedRow.revision,
      previousStatus: row.status as TaskStatus,
      status: 'interrupted',
      errorSummary: row.errorSummary,
      occurredAt: now,
    })
  })
  await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
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

function freshestTopLevel(rows: readonly NodeRunRow[], nodeId: string): NodeRunRow | undefined {
  return rows
    .filter((row) => row.nodeId === nodeId && row.parentNodeRunId === null)
    .sort((left, right) => right.id.localeCompare(left.id))[0]
}

async function retryNode(
  dependencies: PostgresqlTaskRouteOperationsDependencies,
  input: Parameters<TaskRouteOperations['retry']>[0],
): Promise<Task> {
  const task = await requireTaskRow(dependencies.db, input.taskId)
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
  const definition = definitionOf(parseJson(task.workflowSnapshot, null))
  const affected = retryNodeIds(definition, target.nodeId, input.cascade)
  const kinds = new Map(definition.nodes.map((node) => [node.id, node.kind]))
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
    const mint = createPostgresqlNodeRunMintParticipantInTx(tx)
    const nodeChanges: Array<{
      nodeRunId: string
      nodeId: string
      status: NodeRunStatus
      cause: string
    }> = []
    for (const nodeId of affected) {
      const kind = kinds.get(nodeId)
      const selected = nodeId === target.nodeId ? target : freshestTopLevel(runs, nodeId)
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
    const lifecycle = await appendPostgresqlTaskLifecycleTransitionTx(tx, {
      taskId: input.taskId,
      lifecycleRevision: changedTask.revision,
      previousStatus: task.status as TaskStatus,
      status: 'interrupted',
      errorSummary: task.errorSummary,
      occurredAt: now,
      identity: { operationRef, eventGroupId: operationRef, eventGroupOrdinal: 0 },
    })
    const nodeStatuses =
      nodeChanges.length === 0
        ? null
        : await appendPostgresqlTaskNodeStatusesTx(tx, {
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

async function taskTreeIds(
  db: Pick<PostgresqlDatabaseClient, 'select'>,
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
): TaskRouteOperations {
  const authorization = createPostgresqlTaskAuthorizationQueries(dependencies.db)
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
      await loadVisibleWorkflow(dependencies, actor, task.workflowId)
    },
    workflowSyncPreview: (actor, taskId) => workflowSyncPreview(dependencies, actor, taskId),
    syncWorkflow: (input) => syncWorkflow(dependencies, input),
    repairOptions: (input) => repairs.repairOptions(input),
    applyRepair: (input) => repairs.applyRepair(input),
  }
  return Object.freeze(operations)
}
