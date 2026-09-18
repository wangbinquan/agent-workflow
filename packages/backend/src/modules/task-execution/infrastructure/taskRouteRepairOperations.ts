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
import { existsSync } from 'node:fs'

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { lifecycleAlerts, lifecycleRepairAudit, nodeRuns, tasks } from '@/db/schema'
import type {
  ClarifyRepairParticipant,
  CollaborationRuntimeMechanics,
  ReviewRepairParticipant,
} from '@/modules/collaboration/public/participants'
import type { ProviderNeutralDatabase } from '@/db/query'
import { runLifecycleInvariants, type LifecycleAlertRow } from '@/services/lifecycleInvariants'
import { buildContainerMap } from '@/services/scheduler'
import { isoKeyOf, isoWorktreePathFor } from '@/services/nodeIsolation'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import { isGitWorkTree } from '@/util/git'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { TaskExecutionPersistence } from '../application/ports/taskExecutionPersistence'
import type { ActiveTaskExecutionParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type { TaskRouteLifecycleAlertNotice, TaskRouteOperations } from '../public/taskRoutes'
import type { TaskLifecycleAutoRepairBinding } from './taskLifecycleAutoRepairCommand'

type RepairOperations = Pick<TaskRouteOperations, 'repairOptions' | 'applyRepair'>

export interface AutomaticTaskRepairOptions {
  readonly resume: Readonly<{ resume(taskId: string): Promise<void> }>
  readonly onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  readonly onResolved?: (taskId: string) => void
  readonly now?: () => number
}

export type TaskRepairOperations = RepairOperations & {
  automaticRepair(options: AutomaticTaskRepairOptions): TaskLifecycleAutoRepairBinding
}

interface RepairExecutionInput {
  readonly taskId: string
  readonly alertId: string
  readonly optionId: string
  readonly actorUserId: string | null
  readonly resume: (taskId: string) => Promise<void>
  readonly onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  readonly onResolved?: (taskId: string) => void
  readonly now?: () => number
}

interface RepairExecutionResult {
  readonly response: RepairResponse
  /** Kept separately so each caller preserves its existing failure response. */
  readonly resumeError?: string
}

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

/**
 * RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀）：导出供注册表对拍使用。
 *
 * 这张表与 classic 侧 `taskLifecycleRepair.ts` 的 `REPAIR_OPTIONS`
 * 是**两份各自手写的元数据**（这边用模板工厂派生 i18n key，那边逐个写字面量）。选项 **id 集合**
 * 早就锚在 shared 的 `REPAIR_OPTION_IDS` 上，但 `labelKey` / `descriptionKey` / `risk` /
 * `destructive` / `revivesExecution` / `autoApplyEligible` 这几格**此前没有任何东西在比**
 * ——同一条告警在两个部署上可以给出风险等级不同、甚至按钮文案不同的修复选项。
 * `rfc359-w8b-repair-option-registry-parity` 逐格钉住它。
 */
export const OPTION_DEFINITIONS = {
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

export interface TaskRouteRepairOperationsDependencies {
  /**
   * RFC-359 AC-1（第 8 刀）：句柄是**中立**的。这份实现合并前就已经在两个引擎上被驱动
   *（`rfc359-w8-auto-repair-conformance` 的两条 lane），合并后更是两个部署共用的唯一一份，
   * 再标 `PostgresqlDatabaseClient` 只会逼调用方写 `as unknown as`，凭空长出一条跨上下文债边。
   * 文件名与符号名里的 `postgresql` 仍是历史（naming debt §5hj），与句柄类型无关。
   */
  readonly db: ProviderNeutralDatabase
  readonly persistence: TaskExecutionPersistence
  readonly activity: ActiveTaskExecutionParticipant
  /**
   * RFC-359 AC-1（第 8 刀）：复活类修复需要的**全部**就是这一句「以这个 actor 把这个任务拉起来」。
   * 此前这里要三样（`children` / `topology` / `resumeRuntimeFor`），而它们只在一处组合成这一句；
   * 收成一个端口之后，没有装配完整 runtime 的组合根（`server.ts` 那条）也能接上同一份实现。
   */
  readonly resumeTaskAs: (actor: Actor, taskId: string) => Promise<void>
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

/**
 * 「哪一行是卡住的、值得复活的那一行」。评审与澄清**判据不同**，不能共用一套分组：
 *
 * · **评审**（T1）按 `nodeId|iteration|reviewIteration` 分组，组内**任一行 done 就整组跳过**
 *   ——同一轮评审里只要有一行走到 done，这一轮就已经有结论了。
 * · **澄清**（T2）按 **`nodeId` 分组**，只看**最新那一行**（max id）：RFC-074 PR-C 写死的
 *   「世代按 id 序、不按 clarifyIteration 归组」。旧世代 done 是**正常历史**——它不该把
 *   新世代那个卡住的轮次一起吞掉。曾经就是「任一 done 即跳组」把这条吞了
 *   （`lifecycle-repair-T2` 的「newer generation is stuck → resurrect the NEWER (max id)」
 *   用例照出了这处：gen0=done / gen1=interrupted 同属 iteration 0，被判成无候选）。
 */
function latestCandidate(
  runs: readonly RepairNodeRun[],
  nodeIds: ReadonlySet<string>,
  grouping: 'review' | 'clarify',
): RepairNodeRun | null {
  const groups = new Map<string, RepairNodeRun[]>()
  for (const run of runs) {
    if (!nodeIds.has(run.nodeId)) continue
    const key =
      grouping === 'review' ? `${run.nodeId}|${run.iteration}|${run.reviewIteration}` : run.nodeId
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  let candidate: RepairNodeRun | null = null
  for (const group of groups.values()) {
    const latest = group.reduce((left, right) => (right.id > left.id ? right : left))
    // 评审看整组，澄清只看最新那一代。
    if (
      grouping === 'review' ? group.some((run) => run.status === 'done') : latest.status === 'done'
    )
      continue
    if (!TERMINAL_NON_DONE_SET.has(latest.status)) continue
    if (candidate === null || latest.id > candidate.id) candidate = latest
  }
  return candidate
}

async function loadAlert(
  db: ProviderNeutralDatabase,
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

async function loadTask(db: ProviderNeutralDatabase, taskId: string): Promise<RepairTask> {
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
  db: ProviderNeutralDatabase,
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
  db: ProviderNeutralDatabase,
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
  dependencies: TaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
): Promise<RepairNodeRun | null> {
  if (ctx.definition === null) return null
  const ids = new Set(ctx.definition.nodes.filter(isReviewNode).map((node) => node.id))
  return latestCandidate(await loadNodeRuns(dependencies.db, ctx.task.id), ids, 'review')
}

/**
 * RFC-193 §4.6 —— S1 是 scheduler 之外唯一的 `dispatchReviewNode` 生产调用方，
 * 传 `task.worktreePath` 会在 **wrapper 内的 review** 上复现该 RFC 的原始断链。
 * 按 wrapper run 谱系恢复：review 属某 git/loop wrapper（`containerOf`）且该 wrapper
 * 最新一次 run 的 iso 容器目录仍是**活的工作树** ⇒ 用它；否则退回 `task.worktreePath`
 * （顶层 / iso 已灭——不劣于现状）。
 *
 * RFC-356 T15：iso 键不一定等于行 id（RFC-210 的跨重试复用、RFC-356 的代际自愈），
 * 所以从持久化路径回读物理键，而不是按行 id 裸派生。兜底判据是「**是活的工作树**」
 * 而不是「目录存在」：legacy / passthrough 行没有持久化路径，会退回按行 id 派生，
 * 那恰好可能是代际自愈已经放弃的阻塞残留——它作为目录存在但不再是工作树，
 * 拿它当 scopeRoot 会让修复动作落在废墟上。
 *
 * RFC-359 AC-1（第 8 刀）：本函数随两份修复实现合一从退役那份移植过来。合并前留下的
 * 这一份直接传 `ctx.task.worktreePath`，正是 `rfc193-wrapper-review` case 8d 钉死禁止的写法。
 */
async function deriveScopeRoot(
  dependencies: TaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
  reviewNodeId: string,
): Promise<string> {
  const taskWorktreePath = ctx.task.worktreePath
  if (ctx.definition === null) return taskWorktreePath
  const wrapperId = buildContainerMap(ctx.definition).get(reviewNodeId)
  if (wrapperId === undefined) return taskWorktreePath
  const rows = await dependencies.db
    .select({ id: nodeRuns.id, isoWorktreePath: nodeRuns.isoWorktreePath })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, ctx.task.id), eq(nodeRuns.nodeId, wrapperId)))
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  const wrapperRun = rows[0]
  if (wrapperRun === undefined) return taskWorktreePath
  const isoRoot = isoWorktreePathFor(
    dependencies.appHome,
    ctx.task.id,
    isoKeyOf(wrapperRun.isoWorktreePath ?? null, wrapperRun.id),
    '',
  )
  return existsSync(isoRoot) && (await isGitWorkTree(isoRoot)) ? isoRoot : taskWorktreePath
}

async function clarifyCandidate(
  dependencies: TaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
): Promise<RepairNodeRun | null> {
  if (ctx.definition === null) return null
  const ids = new Set(ctx.definition.nodes.filter(isClarifyNode).map((node) => node.id))
  return latestCandidate(await loadNodeRuns(dependencies.db, ctx.task.id), ids, 'clarify')
}

async function preflight(
  dependencies: TaskRouteRepairOperationsDependencies,
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
    // RFC-359 AC-1（plan §5hn 之后的盘点，第 8 刀第 2 步）：**销掉一笔真账**。
    // 这三条以前共用一句 `Resolve alert <id>.`，而 classic 那份对每条规则各给**两步**：
    // 「做了什么」之后还有一句「这一步不改任何数据，你接下来该做什么」。丢掉第二句的后果是
    // 用户点完「确认告警」以为问题解决了——而 acknowledge 本身什么都没修。
    // 取 classic 那份逐字（它包含这边的信息还更多，取它谁也不丢东西），并按规则分开：
    // 三条规则的「接下来该做什么」本来就不一样，共用一个分支正是那句话丢失的原因。
    case 'CR-1.acknowledge':
      return available(
        { kind: 'acknowledge' },
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. cross_clarify_session was already upgraded to abandoned by the invariant scan.`,
      )
    case 'S5.acknowledge':
      return available(
        { kind: 'acknowledge' },
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. Inspect the active-run pids in the alert detail; cancel/resume the task to recover (RFC-098 group-kills live children before rollback).`,
      )
    case 'S6.acknowledge':
      return available(
        { kind: 'acknowledge' },
        `Resolve alert (audit + lifecycle_alerts.resolved_at).`,
        `No data mutations. Restore a member: re-activate a disabled user, invite a new collaborator, or transfer ownership so someone can answer.`,
      )
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
        `Reopen failed task ${ctx.task.id} as interrupted and resume it — the scheduler freshness invariant cascades downstream.`,
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
      // RFC-359 AC-1（第 8 刀）：**先问「这条工作流有没有评审节点」**，再问「有没有在等评审的
      // run」。这两句给运维的是不同的结论——「压根没有评审节点」说明这条告警本身就不该对这个
      // 任务提这个修复，「没有在等评审的 run」说明修复对，只是时机过了。合并前这里缺了第一问，
      // 于是零评审节点的工作流被报成 `noAwaitingReviewRun`（`lifecycle-repair-S1` 的
      // 「workflow has no review nodes」用例照出了这处）。
      if (reviewIds.size === 0) return unavailable('diagnose.repair.S1.unavailable.noReviewNode')
      const candidates = (await loadNodeRuns(dependencies.db, ctx.task.id))
        .filter((run) => run.status === 'awaiting_review' && reviewIds.has(run.nodeId))
        .sort((left, right) => right.id.localeCompare(left.id))
      const run =
        (hinted === null ? undefined : candidates.find((candidate) => candidate.id === hinted)) ??
        candidates[0]
      if (run === undefined) {
        return unavailable('diagnose.repair.S1.unavailable.noAwaitingReviewRun')
      }
      // run 指着的节点在快照里找不到 = 快照坏了，不是「没有评审节点」（上面那一问已经排除）。
      const node = ctx.definition.nodes.find((candidate) => candidate.id === run.nodeId)
      if (node === undefined) {
        return unavailable('diagnose.repair.S1.unavailable.workflowSnapshotCorrupt')
      }
      return available(
        {
          kind: 'review-dispatch',
          definition: ctx.definition,
          node,
          iteration: run.iteration,
          scopeRoot: await deriveScopeRoot(dependencies, ctx, node.id),
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
        // RFC-359 AC-1（第 8 刀）：**「已经开着」和「压根没有可重开的会话」是两个结论**，
        // 不能共用一句。会话还开着意味着 S2 这条告警本身就是陈旧的（重开无事可做）；
        // 没有已关闭的会话则意味着这个修复对这个节点就不适用。合并前这里只剩后一句，
        // 于是前一种情形被报成 `noClosedSession`（`lifecycle-repair-S2` 的
        // 「session already open (invariant should not have fired)」用例照出了这处）。
        if (
          await dependencies.clarify.hasOpenForNodeRun({ taskId: ctx.task.id, nodeRunId: run.id })
        )
          return unavailable('diagnose.repair.S2.reopenSession.unavailable.sessionAlreadyOpen')
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
        `Kick pending task ${ctx.task.id} through interrupted and resume it — forces a fresh scheduler kick.`,
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
  dependencies: TaskRouteRepairOperationsDependencies,
  input: Readonly<{
    taskId: string
    optionId: RepairOptionId
    from: readonly TaskStatus[]
    to: TaskStatus
    allowTerminal?: boolean
    finishedAt: number | null
    errorMessage: string
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
      errorMessage: input.errorMessage,
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
  dependencies: TaskRouteRepairOperationsDependencies,
  ctx: RepairContext,
  optionId: RepairOptionId,
  action: RepairAction,
  taskErrorMessage: string,
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
        errorMessage: taskErrorMessage,
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
        errorMessage: taskErrorMessage,
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
  dependencies: TaskRouteRepairOperationsDependencies,
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
  // Automatic S4 history predates the route's task-id snapshots. Preserve its
  // persisted JSON format while both callers use this same audit writer.
  const automaticKick = input.actorUserId === null && input.optionId === 'S4.kick-task'
  const staleAutomaticTask =
    automaticKick &&
    input.outcome === 'preflight-stale' &&
    (input.outcomeMessage === 'diagnose.repair.S4.unavailable.taskNotPending' ||
      input.outcomeMessage === 'task is no longer pending')
  const snapshot = (value: Readonly<Record<string, unknown>>) =>
    automaticKick && input.outcome === 'success'
      ? { task: { status: recordValue(value['task'], 'status') } }
      : value
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
      beforeSnapshotJson: JSON.stringify(
        staleAutomaticTask ? { task: { status: 'pending' } } : snapshot(input.before),
      ),
      afterSnapshotJson: JSON.stringify(staleAutomaticTask ? {} : snapshot(input.after)),
      outcome: input.outcome,
      outcomeMessage: staleAutomaticTask
        ? 'task is no longer pending'
        : (input.outcomeMessage ?? null),
      appliedAt: dependencies.now?.() ?? Date.now(),
    })
    .run()
  return auditId
}

async function openAlerts(
  db: ProviderNeutralDatabase,
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
export function createTaskRouteRepairOperations(
  dependencies: TaskRouteRepairOperationsDependencies,
): TaskRepairOperations {
  async function context(taskId: string, alertId: string): Promise<RepairContext> {
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
    return { alert, task, definition: parseDefinition(task.workflowSnapshot) }
  }

  async function repairOptions(input: {
    taskId: string
    alertId: string
  }): Promise<RepairOptionsResponse> {
    const ctx = await context(input.taskId, input.alertId)
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
  }

  async function applyRepair(input: RepairExecutionInput): Promise<RepairExecutionResult> {
    const engine = input.now === undefined ? dependencies : { ...dependencies, now: input.now }
    const now = engine.now ?? Date.now
    const ctx = await context(input.taskId, input.alertId)
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
    const prepared = await preflight(engine, optionId, ctx)
    if (!prepared.available) {
      await writeAudit(engine, {
        alert: ctx.alert,
        optionId,
        actorUserId: input.actorUserId,
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
    const automaticKick = input.actorUserId === null && optionId === 'S4.kick-task'
    const taskErrorMessage = automaticKick
      ? `RFC-057 repair ${optionId} via alert ${ctx.alert.id}`
      : `RFC-057 repair ${optionId}`
    try {
      applied = await applyAction(engine, ctx, optionId, prepared.action, taskErrorMessage)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const staleAutomaticTask =
        automaticKick && error instanceof ConflictError && error.code === 'repair-preflight-stale'
      await writeAudit(engine, {
        alert: ctx.alert,
        optionId,
        actorUserId: input.actorUserId,
        before: { task: { id: ctx.task.id, status: ctx.task.status } },
        after: {},
        outcome: staleAutomaticTask ? 'preflight-stale' : 'apply-failed',
        outcomeMessage: staleAutomaticTask ? 'task is no longer pending' : message,
      })
      if (error instanceof ConflictError) throw error
      throw error
    }

    const auditId = await writeAudit(engine, {
      alert: ctx.alert,
      optionId,
      actorUserId: input.actorUserId,
      before: applied.before,
      after: applied.after,
      outcome: 'success',
    })

    if (applied.resume) {
      try {
        await input.resume(ctx.task.id)
      } catch (error) {
        const resumeError = error instanceof Error ? error.message : String(error)
        return {
          response: {
            ok: false,
            auditId,
            outcome: 'apply-failed',
            outcomeMessage: `mutations applied but resume failed: ${resumeError}`,
            resolvedAlertIds: [],
            newAlerts: [],
          },
          resumeError,
        }
      }
    }

    const before = await openAlerts(dependencies.db, ctx.task.id)
    await dependencies.db
      .update(lifecycleAlerts)
      .set({ resolvedAt: now() })
      .where(and(eq(lifecycleAlerts.id, ctx.alert.id), isNull(lifecycleAlerts.resolvedAt)))
      .run()
    input.onResolved?.(ctx.task.id)
    const onAlert = input.onAlert
    await runLifecycleInvariants({
      operations: dependencies.persistence.recoveryAdministration,
      scope: { taskId: ctx.task.id },
      now,
      ...(onAlert === undefined ? {} : { onAlert }),
      ...(input.onResolved === undefined ? {} : { onResolved: input.onResolved }),
    })
    await runStuckTaskDetector({
      operations: dependencies.persistence.recoveryAdministration,
      taskIdFilter: [ctx.task.id],
      now,
      ...(onAlert === undefined ? {} : { onAlert }),
      ...(input.onResolved === undefined ? {} : { onResolved: input.onResolved }),
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
      response: {
        ok: true,
        auditId,
        outcome: 'success',
        resolvedAlertIds: before.filter((row) => !afterIds.has(row.id)).map((row) => row.id),
        newAlerts,
      },
    }
  }
  return Object.freeze({
    repairOptions,
    async applyRepair(input: Parameters<RepairOperations['applyRepair']>[0]) {
      const onAlert = noticeCallback(input.onAlert)
      const result = await applyRepair({
        taskId: input.taskId,
        alertId: input.alertId,
        optionId: input.optionId,
        actorUserId: input.actor.user.id,
        resume: async (taskId) => {
          await dependencies.resumeTaskAs(input.actor, taskId)
        },
        ...(onAlert === undefined ? {} : { onAlert }),
        onResolved: input.onResolved,
      })
      return result.response
    },
    automaticRepair(options: AutomaticTaskRepairOptions): TaskLifecycleAutoRepairBinding {
      return {
        resolveOptions: async (alert) =>
          (await repairOptions({ taskId: alert.taskId, alertId: alert.id })).options.slice(),
        applyOption: async (alert, optionId) => {
          const result = await applyRepair({
            ...options,
            taskId: alert.taskId,
            alertId: alert.id,
            optionId,
            actorUserId: null,
            resume: (taskId) => options.resume.resume(taskId),
          })
          return {
            outcome:
              result.resumeError === undefined
                ? result.response.outcome
                : `apply-failed: ${result.resumeError}`,
          }
        },
      }
    },
  })
}
