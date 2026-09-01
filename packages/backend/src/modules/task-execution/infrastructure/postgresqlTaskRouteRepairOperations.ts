import {
  CANCELABLE_TASK_STATUSES,
  REPAIR_OPTION_IDS,
  WorkflowDefinitionSchema,
  isLifecycleAlertRule,
  isTerminalTaskStatus,
  isTurnEngineWorkgroupTask,
  migrateWorkflowDefinitionToLatest,
  ruleForOptionId,
  type LifecycleAlertRule,
  type NodeRunStatus,
  type RepairOption,
  type RepairOptionId,
  type RepairOptionMeta,
  type RepairOptionsResponse,
  type RepairResponse,
  type TaskStatus,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { lifecycleAlerts, lifecycleRepairAudit, nodeRuns, tasks } from '@/db/schema'
import type {
  ClarifyRepairParticipant,
  CollaborationRuntimeMechanics,
  ReviewRepairParticipant,
} from '@/modules/collaboration/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { runLifecycleInvariants, type LifecycleAlertRow } from '@/services/lifecycleInvariants'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type {
  ActiveTaskExecutionParticipant,
  ChildTaskLifecycleParticipant,
} from '../application/ports/taskExecutionRuntimeParticipants'
import type { ChildResumeRuntime } from '../application/ports/taskExecutionTopology'
import type { SchedulerRuntimeTopology } from '../public/participants'
import type { TaskRouteLifecycleAlertNotice, TaskRouteOperations } from '../public/taskRoutes'

type RepairOperations = Pick<TaskRouteOperations, 'repairOptions' | 'applyRepair'>

interface ParsedAlert {
  readonly id: string
  readonly taskId: string
  readonly rule: LifecycleAlertRule
  readonly severity: 'warning' | 'error'
  readonly detail: Readonly<Record<string, unknown>>
  readonly detectedAt: number
  readonly resolvedAt: number | null
}

interface RepairTask {
  readonly id: string
  readonly status: TaskStatus
  readonly workflowSnapshot: string
  readonly worktreePath: string
  readonly workgroupId: string | null
  readonly workgroupConfigJson: string | null
}

interface RepairNodeRun {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: NodeRunStatus
  readonly iteration: number
  readonly reviewIteration: number
  readonly shardKey: string | null
}

interface RepairContext {
  readonly alert: ParsedAlert
  readonly task: RepairTask
  readonly actor: Actor
  readonly definition: WorkflowDefinition | null
}

type RepairAction =
  | Readonly<{ kind: 'acknowledge' }>
  | Readonly<{
      kind: 'task-transition'
      from: readonly TaskStatus[]
      to: TaskStatus
      allowTerminal?: boolean
      resume: boolean
      finishedAt: 'now' | 'clear'
    }>
  | Readonly<{
      kind: 'node-transition'
      nodeRunId: string
      from: readonly NodeRunStatus[]
      to: NodeRunStatus
      allowTerminal?: boolean
    }>
  | Readonly<{
      kind: 'node-and-task-resume'
      nodeRunId: string
      nodeFrom: readonly NodeRunStatus[]
      nodeTo: NodeRunStatus
      taskFrom: readonly TaskStatus[]
    }>
  | Readonly<{
      kind: 'review-complete'
      docVersionId: string
      nodeRunId: string
      nodeFrom: readonly NodeRunStatus[]
      resume: boolean
    }>
  | Readonly<{ kind: 'review-unapprove'; docVersionId: string; nodeRunId: string }>
  | Readonly<{
      kind: 'clarify-reopen'
      roundId: string
      nodeRunId: string
      expectedStatus: 'answered' | 'canceled' | 'abandoned'
    }>
  | Readonly<{
      kind: 'cancel-superseded-runs'
      keep: string
      cancel: readonly string[]
      reason: string
    }>
  | Readonly<{
      kind: 'review-dispatch'
      definition: WorkflowDefinition
      node: WorkflowNode
      iteration: number
      scopeRoot: string
    }>

type Preflight =
  | Readonly<{
      available: false
      unavailableReasonKey: string
      previewSteps: readonly string[]
    }>
  | Readonly<{
      available: true
      previewSteps: readonly string[]
      action: RepairAction
    }>

interface AppliedRepair {
  readonly before: Readonly<Record<string, unknown>>
  readonly after: Readonly<Record<string, unknown>>
  readonly resume: boolean
}

interface OptionDefinition extends RepairOptionMeta {
  readonly id: RepairOptionId
}

const OPTION_DEFINITIONS = {
  'R1.approve-run': option('R1.approve-run', 'R1', 'approveRun', 'low', false, true),
  'R1.unapprove-doc': option('R1.unapprove-doc', 'R1', 'unapproveDoc', 'medium', false),
  'R1.mark-task-failed': option('R1.mark-task-failed', 'R1', 'markTaskFailed', 'high', true),
  'R2.demote-run-to-awaiting': option(
    'R2.demote-run-to-awaiting',
    'R2',
    'demoteRunToAwaiting',
    'medium',
    false,
  ),
  'R2.mark-task-failed': option('R2.mark-task-failed', 'R2', 'markTaskFailed', 'high', true),
  'C1.resume-run': option('C1.resume-run', 'C1', 'resumeRun', 'low', false),
  'C1.reopen-session': option('C1.reopen-session', 'C1', 'reopenSession', 'medium', false),
  'T1.demote-task': option('T1.demote-task', 'T1', 'demoteTask', 'low', false, true),
  'T1.resurrect-review-run': option(
    'T1.resurrect-review-run',
    'T1',
    'resurrectReviewRun',
    'medium',
    false,
    true,
  ),
  'T2.demote-task': option('T2.demote-task', 'T2', 'demoteTask', 'low', false, true),
  'T2.resurrect-clarify-run': option(
    'T2.resurrect-clarify-run',
    'T2',
    'resurrectClarifyRun',
    'medium',
    false,
    true,
  ),
  'T3.demote-task': option('T3.demote-task', 'T3', 'demoteTask', 'medium', false, true),
  'T3.mark-task-failed': option('T3.mark-task-failed', 'T3', 'markTaskFailed', 'high', true),
  'U1.cancel-older-keep-newest': option(
    'U1.cancel-older-keep-newest',
    'U1',
    'cancelOlderKeepNewest',
    'low',
    false,
  ),
  'U1.cancel-newer-keep-oldest': option(
    'U1.cancel-newer-keep-oldest',
    'U1',
    'cancelNewerKeepOldest',
    'medium',
    false,
  ),
  'CR-1.acknowledge': option('CR-1.acknowledge', 'CR-1', 'acknowledge', 'low', false),
  'CR-1.retry-designer-rerun': option(
    'CR-1.retry-designer-rerun',
    'CR-1',
    'retryDesignerRerun',
    'medium',
    false,
    true,
  ),
  'S1.recreate-doc-version': option(
    'S1.recreate-doc-version',
    'S1',
    'recreateDocVersion',
    'low',
    false,
  ),
  'S1.demote-task': option('S1.demote-task', 'S1', 'demoteTask', 'medium', false, true),
  'S2.demote-task': option('S2.demote-task', 'S2', 'demoteTask', 'medium', false, true),
  'S2.reopen-session': option('S2.reopen-session', 'S2', 'reopenSession', 'medium', false),
  'S3.resurrect-review-run': option(
    'S3.resurrect-review-run',
    'S3',
    'resurrectReviewRun',
    'low',
    false,
    true,
  ),
  'S3.resurrect-clarify-run': option(
    'S3.resurrect-clarify-run',
    'S3',
    'resurrectClarifyRun',
    'low',
    false,
    true,
  ),
  'S3.demote-task': option('S3.demote-task', 'S3', 'demoteTask', 'medium', false, true),
  'S3.mark-task-failed': option('S3.mark-task-failed', 'S3', 'markTaskFailed', 'high', true),
  'S4.kick-task': {
    ...option('S4.kick-task', 'S4', 'kickTask', 'low', false, true),
    autoApplyEligible: true,
  },
  'S4.cancel-task': option('S4.cancel-task', 'S4', 'cancelTask', 'high', true),
  'S5.acknowledge': option('S5.acknowledge', 'S5', 'acknowledge', 'low', false),
  'S6.acknowledge': option('S6.acknowledge', 'S6', 'acknowledge', 'low', false),
} as const satisfies Record<RepairOptionId, OptionDefinition>

function option(
  id: RepairOptionId,
  rule: LifecycleAlertRule,
  key: string,
  risk: RepairOptionMeta['risk'],
  destructive: boolean,
  revivesExecution = false,
): OptionDefinition {
  const namespace = rule === 'CR-1' ? 'CR1' : rule
  return {
    id,
    rule,
    labelKey: `diagnose.repair.${namespace}.${key}.label`,
    descriptionKey: `diagnose.repair.${namespace}.${key}.desc`,
    risk,
    destructive,
    ...(revivesExecution ? { revivesExecution: true } : {}),
  }
}

const TERMINAL_NON_DONE = [
  'failed',
  'canceled',
  'interrupted',
  'exhausted',
] as const satisfies readonly NodeRunStatus[]
const TERMINAL_NON_DONE_SET: ReadonlySet<NodeRunStatus> = new Set(TERMINAL_NON_DONE)
const NON_TERMINAL_TASKS: readonly TaskStatus[] = CANCELABLE_TASK_STATUSES
const ACTIVITY_GATED_OPTIONS = new Set<RepairOptionId>([
  'R1.mark-task-failed',
  'R2.mark-task-failed',
  'T1.demote-task',
  'T2.demote-task',
  'T3.demote-task',
  'T3.mark-task-failed',
  'CR-1.retry-designer-rerun',
  'S1.demote-task',
  'S2.demote-task',
  'S3.resurrect-review-run',
  'S3.resurrect-clarify-run',
  'S3.demote-task',
  'S3.mark-task-failed',
  'S4.kick-task',
  'S4.cancel-task',
])

export interface PostgresqlTaskRouteRepairOperationsDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly persistence: TaskExecutionPersistence
  readonly children: ChildTaskLifecycleParticipant
  readonly activity: ActiveTaskExecutionParticipant
  readonly topology: SchedulerRuntimeTopology
  readonly resumeRuntimeFor: (actor: Actor, taskId: string) => ChildResumeRuntime
  readonly collaborationRuntime: CollaborationRuntimeMechanics
  readonly clarify: ClarifyRepairParticipant
  readonly review: ReviewRepairParticipant
  readonly appHome: string
  readonly now?: () => number
  readonly id?: () => string
}

function recordValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Reflect.get(value, key)
}

function detailString(detail: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = detail[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function detailStrings(
  detail: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | null {
  const value = detail[key]
  if (!Array.isArray(value)) return null
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : null
}

function repairHintNodeRunId(detail: Readonly<Record<string, unknown>>): string | null {
  const hint = detail['repairHint']
  const value = recordValue(hint, 'nodeRunId')
  return typeof value === 'string' && value.length > 0 ? value : null
}

function unavailable(reason: string): Preflight {
  return { available: false, unavailableReasonKey: reason, previewSteps: [] }
}

function available(action: RepairAction, ...previewSteps: readonly string[]): Preflight {
  return { available: true, action, previewSteps }
}

function parseDefinition(raw: string): WorkflowDefinition | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = WorkflowDefinitionSchema.safeParse(value)
  return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
}

function isReviewNode(node: WorkflowNode): boolean {
  return node.kind === 'review'
}

function isClarifyNode(node: WorkflowNode): boolean {
  return node.kind === 'clarify' || node.kind === 'clarify-cross-agent'
}

function latestCandidate(
  runs: readonly RepairNodeRun[],
  nodeIds: ReadonlySet<string>,
  grouping: 'review' | 'clarify',
): RepairNodeRun | null {
  const groups = new Map<string, RepairNodeRun[]>()
  for (const run of runs) {
    if (!nodeIds.has(run.nodeId)) continue
    const key =
      grouping === 'review'
        ? `${run.nodeId}|${run.iteration}|${run.reviewIteration}`
        : `${run.nodeId}|${run.iteration}`
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  let candidate: RepairNodeRun | null = null
  for (const group of groups.values()) {
    if (group.some((run) => run.status === 'done')) continue
    const latest = group.reduce((left, right) => (right.id > left.id ? right : left))
    if (!TERMINAL_NON_DONE_SET.has(latest.status)) continue
    if (candidate === null || latest.id > candidate.id) candidate = latest
  }
  return candidate
}

async function loadAlert(
  db: PostgresqlDatabaseClient,
  taskId: string,
  alertId: string,
): Promise<ParsedAlert> {
  const row = await db
    .select()
    .from(lifecycleAlerts)
    .where(eq(lifecycleAlerts.id, alertId))
    .limit(1)
    .get()
  if (row === undefined) {
    throw new NotFoundError('alert-not-found', `lifecycle_alerts row ${alertId} not found`)
  }
  if (row.taskId !== taskId) {
    throw new NotFoundError(
      'alert-not-on-task',
      `lifecycle_alerts row ${alertId} belongs to task ${row.taskId}, not ${taskId}`,
    )
  }
  if (!isLifecycleAlertRule(row.rule)) {
    throw new ValidationError('unknown-lifecycle-alert-rule', `unknown alert rule '${row.rule}'`)
  }
  let detail: unknown
  try {
    detail = JSON.parse(row.detail)
  } catch {
    detail = { raw: row.detail }
  }
  const normalizedDetail =
    detail !== null && typeof detail === 'object' && !Array.isArray(detail)
      ? Object.fromEntries(Object.entries(detail))
      : { raw: row.detail }
  return {
    id: row.id,
    taskId: row.taskId,
    rule: row.rule,
    severity: row.severity === 'error' ? 'error' : 'warning',
    detail: normalizedDetail,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
  }
}

async function loadTask(db: PostgresqlDatabaseClient, taskId: string): Promise<RepairTask> {
  const row = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      workflowSnapshot: tasks.workflowSnapshot,
      worktreePath: tasks.worktreePath,
      workgroupId: tasks.workgroupId,
      workgroupConfigJson: tasks.workgroupConfigJson,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .get()
  if (row === undefined) throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  return row
}

async function loadNodeRun(
  db: PostgresqlDatabaseClient,
  taskId: string,
  nodeRunId: string,
): Promise<RepairNodeRun | null> {
  const row = await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      iteration: nodeRuns.iteration,
      reviewIteration: nodeRuns.reviewIteration,
      shardKey: nodeRuns.shardKey,
    })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.id, nodeRunId), eq(nodeRuns.taskId, taskId)))
    .limit(1)
    .get()
  return row ?? null
}

async function loadNodeRuns(
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<readonly RepairNodeRun[]> {
  return await db
    .select({
      id: nodeRuns.id,
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      iteration: nodeRuns.iteration,
      reviewIteration: nodeRuns.reviewIteration,
      shardKey: nodeRuns.shardKey,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
}

function taskStatusPreflight(
  ctx: RepairContext,
  expected: TaskStatus,
  reason: string,
  action: RepairAction,
  ...steps: readonly string[]
): Preflight {
  return ctx.task.status === expected ? available(action, ...steps) : unavailable(reason)
}

async function reviewCandidate(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
): Promise<RepairNodeRun | null> {
  if (ctx.definition === null) return null
  const ids = new Set(ctx.definition.nodes.filter(isReviewNode).map((node) => node.id))
  return latestCandidate(await loadNodeRuns(dependencies.db, ctx.task.id), ids, 'review')
}

async function clarifyCandidate(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
): Promise<RepairNodeRun | null> {
  if (ctx.definition === null) return null
  const ids = new Set(ctx.definition.nodes.filter(isClarifyNode).map((node) => node.id))
  return latestCandidate(await loadNodeRuns(dependencies.db, ctx.task.id), ids, 'clarify')
}

async function preflight(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  optionId: RepairOptionId,
  ctx: RepairContext,
): Promise<Preflight> {
  if (ACTIVITY_GATED_OPTIONS.has(optionId) && dependencies.activity.isActive(ctx.task.id)) {
    return unavailable('diagnose.repair.common.schedulerActive')
  }

  switch (optionId) {
    case 'R1.approve-run':
    case 'R1.unapprove-doc': {
      if (ctx.task.status === 'done' || ctx.task.status === 'canceled') {
        return unavailable('diagnose.repair.R1.unavailable.taskTerminal')
      }
      const docVersionId = detailString(ctx.alert.detail, 'docVersionId')
      const nodeRunId = detailString(ctx.alert.detail, 'reviewNodeRunId')
      if (docVersionId === null || nodeRunId === null) {
        return unavailable('diagnose.repair.R1.unavailable.detailDrift')
      }
      const [inspection, run] = await Promise.all([
        dependencies.review.inspect({ taskId: ctx.task.id, docVersionId, nodeRunId }),
        loadNodeRun(dependencies.db, ctx.task.id, nodeRunId),
      ])
      if (inspection === null || run === null) {
        return unavailable('diagnose.repair.R1.unavailable.detailDrift')
      }
      if (inspection.decision !== 'approved') {
        return unavailable('diagnose.repair.R1.unavailable.docNotApproved')
      }
      if (run.status === 'done') {
        return unavailable('diagnose.repair.R1.unavailable.runAlreadyDone')
      }
      if (optionId === 'R1.unapprove-doc') {
        return available(
          { kind: 'review-unapprove', docVersionId, nodeRunId },
          `Restore document ${docVersionId} to pending review.`,
        )
      }
      return available(
        {
          kind: 'review-complete',
          docVersionId,
          nodeRunId,
          nodeFrom: [
            'awaiting_review',
            'pending',
            'running',
            'failed',
            'canceled',
            'interrupted',
            'exhausted',
          ],
          resume: ['awaiting_review', 'awaiting_human', 'failed', 'interrupted'].includes(
            ctx.task.status,
          ),
        },
        `Complete approved document outputs for ${docVersionId}.`,
        `Move review run ${nodeRunId} from ${run.status} to done.`,
      )
    }
    case 'R1.mark-task-failed':
    case 'R2.mark-task-failed': {
      if (isTerminalTaskStatus(ctx.task.status)) {
        return unavailable(`diagnose.repair.${optionId.slice(0, 2)}.unavailable.taskTerminal`)
      }
      return available(
        {
          kind: 'task-transition',
          from: NON_TERMINAL_TASKS,
          to: 'failed',
          resume: false,
          finishedAt: 'now',
        },
        `Move task ${ctx.task.id} from ${ctx.task.status} to failed.`,
      )
    }
    case 'R2.demote-run-to-awaiting': {
      const nodeRunId = detailString(ctx.alert.detail, 'reviewNodeRunId')
      if (nodeRunId === null) return unavailable('diagnose.repair.R2.unavailable.detailDrift')
      const run = await loadNodeRun(dependencies.db, ctx.task.id, nodeRunId)
      if (run === null) return unavailable('diagnose.repair.R2.unavailable.detailDrift')
      if (run.status !== 'done') return unavailable('diagnose.repair.R2.unavailable.runNotDone')
      return available(
        {
          kind: 'node-transition',
          nodeRunId,
          from: ['done'],
          to: 'awaiting_review',
          allowTerminal: true,
        },
        `Move review run ${nodeRunId} from done to awaiting_review.`,
      )
    }
    case 'C1.resume-run':
    case 'C1.reopen-session': {
      const roundId = detailString(ctx.alert.detail, 'clarifySessionId')
      const nodeRunId = detailString(ctx.alert.detail, 'clarifyNodeRunId')
      if (roundId === null || nodeRunId === null) {
        return unavailable('diagnose.repair.C1.unavailable.detailDrift')
      }
      const [run, round] = await Promise.all([
        loadNodeRun(dependencies.db, ctx.task.id, nodeRunId),
        dependencies.clarify.latestClosedForNodeRun({ taskId: ctx.task.id, nodeRunId }),
      ])
      if (run === null || round === null || round.roundId !== roundId) {
        return unavailable('diagnose.repair.C1.unavailable.detailDrift')
      }
      if (run.status !== 'awaiting_human') {
        return unavailable('diagnose.repair.C1.unavailable.runNotAwaitingHuman')
      }
      if (optionId === 'C1.resume-run') {
        return available(
          {
            kind: 'node-transition',
            nodeRunId,
            from: ['awaiting_human'],
            to: 'done',
          },
          `Complete clarify run ${nodeRunId}.`,
        )
      }
      return available(
        {
          kind: 'clarify-reopen',
          roundId,
          nodeRunId,
          expectedStatus: round.status,
        },
        `Reopen clarify round ${roundId}.`,
      )
    }
    case 'T1.demote-task':
      return taskStatusPreflight(
        ctx,
        'awaiting_review',
        'diagnose.repair.T1.unavailable.taskNotAwaitingReview',
        {
          kind: 'task-transition',
          from: ['awaiting_review'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Demote task ${ctx.task.id} to interrupted and resume it.`,
      )
    case 'T1.resurrect-review-run': {
      if (ctx.task.status !== 'awaiting_review') {
        return unavailable('diagnose.repair.T1.unavailable.taskNotAwaitingReview')
      }
      const candidate = await reviewCandidate(dependencies, ctx)
      if (candidate === null) {
        return unavailable('diagnose.repair.T1.resurrectReviewRun.unavailable.noCandidate')
      }
      return available(
        {
          kind: 'node-transition',
          nodeRunId: candidate.id,
          from: TERMINAL_NON_DONE,
          to: 'awaiting_review',
          allowTerminal: true,
        },
        `Resurrect review run ${candidate.id} as awaiting_review.`,
      )
    }
    case 'T2.demote-task':
      return taskStatusPreflight(
        ctx,
        'awaiting_human',
        'diagnose.repair.T2.unavailable.taskNotAwaitingHuman',
        {
          kind: 'task-transition',
          from: ['awaiting_human'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Demote task ${ctx.task.id} to interrupted and resume it.`,
      )
    case 'T2.resurrect-clarify-run': {
      if (ctx.task.status !== 'awaiting_human') {
        return unavailable('diagnose.repair.T2.unavailable.taskNotAwaitingHuman')
      }
      const candidate = await clarifyCandidate(dependencies, ctx)
      if (candidate === null) {
        return unavailable('diagnose.repair.T2.resurrectClarifyRun.unavailable.noCandidate')
      }
      if (
        !(await dependencies.clarify.hasOpenForNodeRun({
          taskId: ctx.task.id,
          nodeRunId: candidate.id,
        }))
      ) {
        return unavailable('diagnose.repair.T2.resurrectClarifyRun.unavailable.noOpenSession')
      }
      return available(
        {
          kind: 'node-transition',
          nodeRunId: candidate.id,
          from: TERMINAL_NON_DONE,
          to: 'awaiting_human',
          allowTerminal: true,
        },
        `Resurrect clarify run ${candidate.id} as awaiting_human.`,
      )
    }
    case 'T3.demote-task':
      return taskStatusPreflight(
        ctx,
        'done',
        'diagnose.repair.T3.unavailable.taskNotDone',
        {
          kind: 'task-transition',
          from: ['done'],
          to: 'interrupted',
          allowTerminal: true,
          resume: true,
          finishedAt: 'clear',
        },
        `Reopen done task ${ctx.task.id} as interrupted and resume it.`,
      )
    case 'T3.mark-task-failed':
      return taskStatusPreflight(
        ctx,
        'done',
        'diagnose.repair.T3.unavailable.taskNotDone',
        {
          kind: 'task-transition',
          from: ['done'],
          to: 'failed',
          allowTerminal: true,
          resume: false,
          finishedAt: 'now',
        },
        `Move done task ${ctx.task.id} to failed.`,
      )
    case 'U1.cancel-older-keep-newest':
    case 'U1.cancel-newer-keep-oldest': {
      const ids = detailStrings(ctx.alert.detail, 'nodeRunIds')
      if (ids === null || ids.length < 2) {
        return unavailable('diagnose.repair.U1.unavailable.detailMissingIds')
      }
      const rows = await dependencies.db
        .select({ id: nodeRuns.id, status: nodeRuns.status })
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, ctx.task.id), inArray(nodeRuns.id, [...ids])))
      const active = rows
        .filter((row) => row.status === 'awaiting_review' || row.status === 'awaiting_human')
        .sort((left, right) => left.id.localeCompare(right.id))
      if (active.length < 2) {
        return unavailable('diagnose.repair.U1.unavailable.notMultipleActive')
      }
      const keepNewest = optionId === 'U1.cancel-older-keep-newest'
      const keep = keepNewest ? active[active.length - 1]!.id : active[0]!.id
      const cancel = active.filter((row) => row.id !== keep).map((row) => row.id)
      return available(
        {
          kind: 'cancel-superseded-runs',
          keep,
          cancel,
          reason: keepNewest ? 'rfc057-u1-cancel-older' : 'rfc057-u1-cancel-newer',
        },
        `Keep node run ${keep}.`,
        ...cancel.map((id) => `Cancel superseded node run ${id}.`),
      )
    }
    case 'CR-1.acknowledge':
    case 'S5.acknowledge':
    case 'S6.acknowledge':
      return available({ kind: 'acknowledge' }, `Resolve alert ${ctx.alert.id}.`)
    case 'CR-1.retry-designer-rerun':
      return taskStatusPreflight(
        ctx,
        'failed',
        'diagnose.repair.CR1.unavailable.taskNotFailed',
        {
          kind: 'task-transition',
          from: ['failed'],
          to: 'interrupted',
          allowTerminal: true,
          resume: true,
          finishedAt: 'now',
        },
        `Reopen failed task ${ctx.task.id} as interrupted and resume it.`,
      )
    case 'S1.recreate-doc-version': {
      if (ctx.task.status !== 'awaiting_review') {
        return unavailable('diagnose.repair.S1.unavailable.taskNotAwaitingReview')
      }
      if (ctx.definition === null) {
        return unavailable('diagnose.repair.S1.unavailable.workflowSnapshotCorrupt')
      }
      const hinted = repairHintNodeRunId(ctx.alert.detail)
      const reviewIds = new Set(ctx.definition.nodes.filter(isReviewNode).map((node) => node.id))
      const candidates = (await loadNodeRuns(dependencies.db, ctx.task.id))
        .filter((run) => run.status === 'awaiting_review' && reviewIds.has(run.nodeId))
        .sort((left, right) => right.id.localeCompare(left.id))
      const run =
        (hinted === null ? undefined : candidates.find((candidate) => candidate.id === hinted)) ??
        candidates[0]
      if (run === undefined) {
        return unavailable('diagnose.repair.S1.unavailable.noAwaitingReviewRun')
      }
      const node = ctx.definition.nodes.find((candidate) => candidate.id === run.nodeId)
      if (node === undefined) return unavailable('diagnose.repair.S1.unavailable.noReviewNode')
      return available(
        {
          kind: 'review-dispatch',
          definition: ctx.definition,
          node,
          iteration: run.iteration,
          scopeRoot: ctx.task.worktreePath,
        },
        `Re-dispatch review node ${node.id} at iteration ${run.iteration}.`,
      )
    }
    case 'S1.demote-task':
      return taskStatusPreflight(
        ctx,
        'awaiting_review',
        'diagnose.repair.S1.unavailable.taskNotAwaitingReview',
        {
          kind: 'task-transition',
          from: ['awaiting_review'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Demote task ${ctx.task.id} and resume it.`,
      )
    case 'S2.demote-task':
      return taskStatusPreflight(
        ctx,
        'awaiting_human',
        'diagnose.repair.S2.unavailable.taskNotAwaitingHuman',
        {
          kind: 'task-transition',
          from: ['awaiting_human'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Demote task ${ctx.task.id} and resume it.`,
      )
    case 'S2.reopen-session': {
      if (ctx.task.status !== 'awaiting_human') {
        return unavailable('diagnose.repair.S2.unavailable.taskNotAwaitingHuman')
      }
      const hinted = repairHintNodeRunId(ctx.alert.detail)
      let run: RepairNodeRun | null =
        hinted === null ? null : await loadNodeRun(dependencies.db, ctx.task.id, hinted)
      if (run === null) {
        const rows = (await loadNodeRuns(dependencies.db, ctx.task.id))
          .filter((candidate) => candidate.status === 'awaiting_human')
          .sort((left, right) => right.id.localeCompare(left.id))
        run = rows[0] ?? null
      }
      if (run === null || run.status !== 'awaiting_human') {
        return unavailable('diagnose.repair.S2.reopenSession.unavailable.noAwaitingRun')
      }
      const round = await dependencies.clarify.latestClosedForNodeRun({
        taskId: ctx.task.id,
        nodeRunId: run.id,
      })
      if (round === null) {
        return unavailable('diagnose.repair.S2.reopenSession.unavailable.noClosedSession')
      }
      return available(
        {
          kind: 'clarify-reopen',
          roundId: round.roundId,
          nodeRunId: run.id,
          expectedStatus: round.status,
        },
        `Reopen clarify round ${round.roundId}.`,
      )
    }
    case 'S3.resurrect-review-run':
    case 'S3.resurrect-clarify-run': {
      if (ctx.task.status !== 'running') {
        return unavailable('diagnose.repair.S3.unavailable.taskNotRunning')
      }
      const review = optionId === 'S3.resurrect-review-run'
      const candidate = review
        ? await reviewCandidate(dependencies, ctx)
        : await clarifyCandidate(dependencies, ctx)
      if (candidate === null) {
        return unavailable(
          review
            ? 'diagnose.repair.S3.resurrectReviewRun.unavailable.noCandidate'
            : 'diagnose.repair.S3.resurrectClarifyRun.unavailable.noCandidate',
        )
      }
      return available(
        {
          kind: 'node-and-task-resume',
          nodeRunId: candidate.id,
          nodeFrom: TERMINAL_NON_DONE,
          nodeTo: 'pending',
          taskFrom: ['running'],
        },
        `Resurrect ${review ? 'review' : 'clarify'} run ${candidate.id} as pending.`,
        `Demote task ${ctx.task.id} and resume it.`,
      )
    }
    case 'S3.demote-task':
      return taskStatusPreflight(
        ctx,
        'running',
        'diagnose.repair.S3.unavailable.taskNotRunning',
        {
          kind: 'task-transition',
          from: ['running'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Demote task ${ctx.task.id} and resume it.`,
      )
    case 'S3.mark-task-failed':
      return taskStatusPreflight(
        ctx,
        'running',
        'diagnose.repair.S3.unavailable.taskNotRunning',
        {
          kind: 'task-transition',
          from: ['running'],
          to: 'failed',
          resume: false,
          finishedAt: 'now',
        },
        `Move task ${ctx.task.id} to failed.`,
      )
    case 'S4.kick-task':
      return taskStatusPreflight(
        ctx,
        'pending',
        'diagnose.repair.S4.unavailable.taskNotPending',
        {
          kind: 'task-transition',
          from: ['pending'],
          to: 'interrupted',
          resume: true,
          finishedAt: 'now',
        },
        `Kick pending task ${ctx.task.id} through interrupted and resume it.`,
      )
    case 'S4.cancel-task':
      return taskStatusPreflight(
        ctx,
        'pending',
        'diagnose.repair.S4.unavailable.taskNotPending',
        {
          kind: 'task-transition',
          from: ['pending'],
          to: 'canceled',
          resume: false,
          finishedAt: 'now',
        },
        `Cancel pending task ${ctx.task.id}.`,
      )
  }
}

async function setTask(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  input: Readonly<{
    taskId: string
    optionId: RepairOptionId
    from: readonly TaskStatus[]
    to: TaskStatus
    allowTerminal?: boolean
    finishedAt: number | null
  }>,
): Promise<void> {
  const won = await dependencies.persistence.runtimeLifecycle.trySet({
    taskId: input.taskId,
    to: input.to,
    allowedFrom: input.from,
    ...(input.allowTerminal === true ? { allowTerminal: true } : {}),
    extra: {
      finishedAt: input.finishedAt,
      errorSummary: `manual-repair-${ruleForOptionId(input.optionId) ?? 'unknown'}`,
      errorMessage: `RFC-057 repair ${input.optionId}`,
      failedNodeId: null,
    },
    now: dependencies.now?.() ?? Date.now(),
    reason: input.optionId,
  })
  if (!won) {
    throw new ConflictError(
      'repair-preflight-stale',
      `task ${input.taskId} changed before ${input.optionId} could apply`,
    )
  }
}

async function applyAction(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
  optionId: RepairOptionId,
  action: RepairAction,
): Promise<AppliedRepair> {
  const now = dependencies.now ?? Date.now
  switch (action.kind) {
    case 'acknowledge':
      return {
        before: { alert: { id: ctx.alert.id, rule: ctx.alert.rule } },
        after: { alert: { id: ctx.alert.id, action: 'acknowledged' } },
        resume: false,
      }
    case 'task-transition':
      await setTask(dependencies, {
        taskId: ctx.task.id,
        optionId,
        from: action.from,
        to: action.to,
        ...(action.allowTerminal === true ? { allowTerminal: true } : {}),
        finishedAt: action.finishedAt === 'clear' ? null : now(),
      })
      return {
        before: { task: { id: ctx.task.id, status: ctx.task.status } },
        after: { task: { id: ctx.task.id, status: action.to } },
        resume: action.resume,
      }
    case 'node-transition': {
      const result = await dependencies.persistence.nodeRuns.set({
        nodeRunId: action.nodeRunId,
        to: action.to,
        allowedFrom: action.from,
        ...(action.allowTerminal === true ? { allowTerminal: true } : {}),
        extra: {
          finishedAt: action.to === 'done' ? now() : null,
          errorMessage: null,
        },
        reason: optionId,
      })
      return {
        before: { nodeRun: { id: action.nodeRunId, status: result.from } },
        after: { nodeRun: { id: action.nodeRunId, status: action.to } },
        resume: false,
      }
    }
    case 'node-and-task-resume': {
      const result = await dependencies.persistence.nodeRuns.set({
        nodeRunId: action.nodeRunId,
        to: action.nodeTo,
        allowedFrom: action.nodeFrom,
        allowTerminal: true,
        extra: { finishedAt: null, errorMessage: null },
        reason: optionId,
      })
      await setTask(dependencies, {
        taskId: ctx.task.id,
        optionId,
        from: action.taskFrom,
        to: 'interrupted',
        finishedAt: now(),
      })
      return {
        before: {
          task: { id: ctx.task.id, status: ctx.task.status },
          nodeRun: { id: action.nodeRunId, status: result.from },
        },
        after: {
          task: { id: ctx.task.id, status: 'interrupted' },
          nodeRun: { id: action.nodeRunId, status: action.nodeTo },
        },
        resume: true,
      }
    }
    case 'review-complete': {
      const completed = await dependencies.review.completeApproved({
        taskId: ctx.task.id,
        docVersionId: action.docVersionId,
        nodeRunId: action.nodeRunId,
        occurredAt: now(),
      })
      if (!completed) {
        throw new ConflictError(
          'repair-preflight-stale',
          `review ${action.docVersionId} changed before ${optionId} could apply`,
        )
      }
      const result = await dependencies.persistence.nodeRuns.set({
        nodeRunId: action.nodeRunId,
        to: 'done',
        allowedFrom: action.nodeFrom,
        allowTerminal: true,
        extra: { finishedAt: now(), errorMessage: null },
        reason: optionId,
      })
      return {
        before: {
          review: { id: action.docVersionId, decision: 'approved' },
          nodeRun: { id: action.nodeRunId, status: result.from },
        },
        after: {
          review: { id: action.docVersionId, outputs: 'complete' },
          nodeRun: { id: action.nodeRunId, status: 'done' },
        },
        resume: action.resume,
      }
    }
    case 'review-unapprove': {
      const changed = await dependencies.review.unapprove({
        taskId: ctx.task.id,
        docVersionId: action.docVersionId,
        nodeRunId: action.nodeRunId,
      })
      if (!changed) {
        throw new ConflictError(
          'repair-preflight-stale',
          `review ${action.docVersionId} changed before ${optionId} could apply`,
        )
      }
      return {
        before: { review: { id: action.docVersionId, decision: 'approved' } },
        after: { review: { id: action.docVersionId, decision: 'pending' } },
        resume: false,
      }
    }
    case 'clarify-reopen': {
      const changed = await dependencies.clarify.reopen({
        taskId: ctx.task.id,
        roundId: action.roundId,
        expectedStatus: action.expectedStatus,
        occurredAt: now(),
      })
      if (!changed) {
        throw new ConflictError(
          'repair-preflight-stale',
          `clarify round ${action.roundId} changed before ${optionId} could apply`,
        )
      }
      return {
        before: {
          clarify: { id: action.roundId, status: action.expectedStatus },
          nodeRun: { id: action.nodeRunId },
        },
        after: { clarify: { id: action.roundId, status: 'awaiting_human' } },
        resume: false,
      }
    }
    case 'cancel-superseded-runs':
      for (const nodeRunId of action.cancel) {
        await dependencies.persistence.nodeRuns.transition({
          nodeRunId,
          event: { kind: 'cancel-by-supersede', reason: action.reason },
          extra: { finishedAt: now() },
        })
      }
      return {
        before: { keep: action.keep, active: [action.keep, ...action.cancel] },
        after: { keep: action.keep, canceled: action.cancel },
        resume: false,
      }
    case 'review-dispatch': {
      const result = await dependencies.collaborationRuntime.dispatchReviewNode({
        taskId: ctx.task.id,
        appHome: dependencies.appHome,
        definition: action.definition,
        node: action.node,
        iteration: action.iteration,
        scopeRoot: action.scopeRoot,
      })
      if (result.kind === 'failed') {
        throw new Error(`dispatchReviewNode failed: ${result.message} — ${result.summary}`)
      }
      if (result.kind === 'canceled') {
        throw new ConflictError(
          'repair-preflight-stale',
          `task ${ctx.task.id} was canceled before ${optionId} could dispatch review`,
        )
      }
      return {
        before: { reviewNode: action.node.id, iteration: action.iteration },
        after: { dispatchResult: result.kind, message: result.message },
        resume: false,
      }
    }
  }
}

async function writeAudit(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
  input: Readonly<{
    alert: ParsedAlert
    optionId: string
    actorUserId: string | null
    before: Readonly<Record<string, unknown>>
    after: Readonly<Record<string, unknown>>
    outcome: 'success' | 'preflight-stale' | 'apply-failed'
    outcomeMessage?: string
  }>,
): Promise<string> {
  const auditId = dependencies.id?.() ?? ulid()
  await dependencies.db
    .insert(lifecycleRepairAudit)
    .values({
      id: auditId,
      taskId: input.alert.taskId,
      alertId: input.alert.id,
      alertRule: input.alert.rule,
      alertDetailJson: JSON.stringify(input.alert.detail),
      optionId: input.optionId,
      actorUserId: input.actorUserId,
      beforeSnapshotJson: JSON.stringify(input.before),
      afterSnapshotJson: JSON.stringify(input.after),
      outcome: input.outcome,
      outcomeMessage: input.outcomeMessage ?? null,
      appliedAt: dependencies.now?.() ?? Date.now(),
    })
    .run()
  return auditId
}

async function openAlerts(
  db: PostgresqlDatabaseClient,
  taskId: string,
): Promise<readonly Readonly<{ id: string; rule: string }>[]> {
  return await db
    .select({ id: lifecycleAlerts.id, rule: lifecycleAlerts.rule })
    .from(lifecycleAlerts)
    .where(and(eq(lifecycleAlerts.taskId, taskId), isNull(lifecycleAlerts.resolvedAt)))
    .orderBy(asc(lifecycleAlerts.detectedAt))
}

function noticeCallback(
  callback:
    | ((row: TaskRouteLifecycleAlertNotice, transition: 'new' | 'promoted') => void)
    | undefined,
): ((row: LifecycleAlertRow, transition: 'new' | 'promoted') => void) | undefined {
  if (callback === undefined) return undefined
  return (row, transition) => {
    callback({ taskId: row.taskId, rule: row.rule, severity: row.severity }, transition)
  }
}

function optionForPreflight(definition: OptionDefinition, result: Preflight): RepairOption {
  return {
    ...definition,
    available: result.available,
    previewSteps: result.previewSteps,
    ...(!result.available ? { unavailableReasonKey: result.unavailableReasonKey } : {}),
  }
}

/**
 * Complete PostgreSQL Diagnose-panel adapter.  It owns TaskExecution task,
 * node-run, alert and audit rows while delegating review/clarify facts through
 * Collaboration's selected-provider participants.
 */
export function createPostgresqlTaskRouteRepairOperations(
  dependencies: PostgresqlTaskRouteRepairOperationsDependencies,
): RepairOperations {
  const now = dependencies.now ?? Date.now

  async function context(actor: Actor, taskId: string, alertId: string): Promise<RepairContext> {
    const [alert, task] = await Promise.all([
      loadAlert(dependencies.db, taskId, alertId),
      loadTask(dependencies.db, taskId),
    ])
    if (alert.resolvedAt !== null) {
      throw new ConflictError(
        'alert-already-resolved',
        `lifecycle alert ${alertId} is already resolved`,
      )
    }
    return { alert, task, actor, definition: parseDefinition(task.workflowSnapshot) }
  }

  return Object.freeze({
    async repairOptions(input): Promise<RepairOptionsResponse> {
      const ctx = await context(input.actor, input.taskId, input.alertId)
      const options: RepairOption[] = []
      for (const optionId of REPAIR_OPTION_IDS[ctx.alert.rule]) {
        const definition = OPTION_DEFINITIONS[optionId]
        if (isTurnEngineWorkgroupTask(ctx.task) && definition.revivesExecution === true) {
          options.push({
            ...definition,
            available: false,
            unavailableReasonKey: 'diagnose.repair.common.workgroupUnsupported',
            previewSteps: [],
          })
          continue
        }
        options.push(optionForPreflight(definition, await preflight(dependencies, optionId, ctx)))
      }
      return { alertId: ctx.alert.id, alertRule: ctx.alert.rule, options }
    },

    async applyRepair(input): Promise<RepairResponse> {
      const ctx = await context(input.actor, input.taskId, input.alertId)
      const expectedRule = ruleForOptionId(input.optionId)
      if (expectedRule === null) {
        throw new ValidationError(
          'unknown-repair-option',
          `optionId '${input.optionId}' is not a registered repair option`,
        )
      }
      if (expectedRule !== ctx.alert.rule) {
        throw new ValidationError(
          'repair-option-rule-mismatch',
          `optionId '${input.optionId}' belongs to '${expectedRule}', not '${ctx.alert.rule}'`,
        )
      }
      const optionId = REPAIR_OPTION_IDS[expectedRule].find(
        (candidate) => candidate === input.optionId,
      )
      if (optionId === undefined) {
        throw new ValidationError(
          'repair-option-not-implemented',
          `optionId '${input.optionId}' is not implemented`,
        )
      }
      const definition = OPTION_DEFINITIONS[optionId]
      if (isTurnEngineWorkgroupTask(ctx.task) && definition.revivesExecution === true) {
        throw new ValidationError(
          'workgroup-repair-unsupported',
          `repair option '${optionId}' cannot revive a turn-engine workgroup task`,
        )
      }
      const prepared = await preflight(dependencies, optionId, ctx)
      if (!prepared.available) {
        await writeAudit(dependencies, {
          alert: ctx.alert,
          optionId,
          actorUserId: ctx.actor.user.id,
          before: { reason: prepared.unavailableReasonKey },
          after: {},
          outcome: 'preflight-stale',
          outcomeMessage: prepared.unavailableReasonKey,
        })
        throw new ConflictError(
          'repair-preflight-stale',
          `preflight for '${optionId}' is no longer available (${prepared.unavailableReasonKey})`,
        )
      }

      let applied: AppliedRepair
      try {
        applied = await applyAction(dependencies, ctx, optionId, prepared.action)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await writeAudit(dependencies, {
          alert: ctx.alert,
          optionId,
          actorUserId: ctx.actor.user.id,
          before: { task: { id: ctx.task.id, status: ctx.task.status } },
          after: {},
          outcome: 'apply-failed',
          outcomeMessage: message,
        })
        if (error instanceof ConflictError) throw error
        throw error
      }

      const auditId = await writeAudit(dependencies, {
        alert: ctx.alert,
        optionId,
        actorUserId: ctx.actor.user.id,
        before: applied.before,
        after: applied.after,
        outcome: 'success',
      })

      if (applied.resume) {
        try {
          await dependencies.children.resume(
            {
              taskId: ctx.task.id,
              runtime: dependencies.resumeRuntimeFor(ctx.actor, ctx.task.id),
            },
            dependencies.topology,
          )
        } catch (error) {
          return {
            ok: false,
            auditId,
            outcome: 'apply-failed',
            outcomeMessage: `mutations applied but resume failed: ${error instanceof Error ? error.message : String(error)}`,
            resolvedAlertIds: [],
            newAlerts: [],
          }
        }
      }

      const before = await openAlerts(dependencies.db, ctx.task.id)
      await dependencies.db
        .update(lifecycleAlerts)
        .set({ resolvedAt: now() })
        .where(and(eq(lifecycleAlerts.id, ctx.alert.id), isNull(lifecycleAlerts.resolvedAt)))
        .run()
      input.onResolved(ctx.task.id)
      const onAlert = noticeCallback(input.onAlert)
      await runLifecycleInvariants({
        operations: dependencies.persistence.recoveryAdministration,
        scope: { taskId: ctx.task.id },
        now,
        ...(onAlert === undefined ? {} : { onAlert }),
        onResolved: input.onResolved,
      })
      await runStuckTaskDetector({
        operations: dependencies.persistence.recoveryAdministration,
        taskIdFilter: [ctx.task.id],
        now,
        ...(onAlert === undefined ? {} : { onAlert }),
        onResolved: input.onResolved,
      })
      const after = await openAlerts(dependencies.db, ctx.task.id)
      const afterIds = new Set(after.map((row) => row.id))
      const beforeIds = new Set(before.map((row) => row.id))
      const newAlerts: Array<{ id: string; rule: LifecycleAlertRule }> = []
      for (const row of after) {
        if (!beforeIds.has(row.id) && isLifecycleAlertRule(row.rule)) {
          newAlerts.push({ id: row.id, rule: row.rule })
        }
      }
      return {
        ok: true,
        auditId,
        outcome: 'success',
        resolvedAlertIds: before.filter((row) => !afterIds.has(row.id)).map((row) => row.id),
        newAlerts,
      }
    },
  })
}
