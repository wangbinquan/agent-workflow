// RFC-053 P-3 — double-layer invariant scan.
//
// Seven invariants span the doc_versions / clarify_sessions / node_runs /
// tasks tables. Each scan compares the *current* DB state to the expected
// shape and produces a list of findings; findings are upserted into
// `lifecycle_alerts` so the UI Diagnose panel + WS stream can surface
// them. Findings that the scan no longer sees flip `resolved_at` so the
// open-alerts feed stays accurate.
//
// Rules (per design.md §P-3):
//
//   R1  doc_versions.decision='approved' ⟹ review node_run.status='done'
//   R2  review node_run.status='done'    ⟹ ∃ doc_versions.decision='approved'
//   C1  clarify_session.status ∈ {answered, canceled} ⟹ clarify node_run.status ∉ {awaiting_human}
//   T1  tasks.status='awaiting_review'   ⟹ ∃ node_run.status='awaiting_review'
//   T2  tasks.status='awaiting_human'    ⟹ ∃ node_run.status='awaiting_human'
//   T3  tasks.status='done'              ⟹ ∀ output-kind nodes have a done or
//                                            skipped node_run (RFC-306: a closed
//                                            branch settles as skipped)
//   U1  per (task,nodeId,iter,shard) ≤ 1 row in {awaiting_review|awaiting_human}
//
// 24h grace: a newly-detected finding starts at severity='warning'.
// The next scan past detected_at + 24h promotes it to 'error' (and only
// then logs at error level + broadcasts a `lifecycle.alert` WS event).
// This gives operators a window to clean historic stuck tasks before
// they show as red.
//
// Scope selectors:
//   { taskId }     — single task (used by /diagnose route)
//   { since }      — tasks with activity since this epoch ms (incremental)
//   { all: true }  — every non-deleted task (startup full scan)
//
// All seven invariants are read-only against the source tables; only
// `lifecycle_alerts` is written.

import type {
  LifecycleAlertRule as SharedLifecycleAlertRule,
  WorkflowDefinition,
  NodeKind,
} from '@agent-workflow/shared'
import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'

import type {
  TaskLifecycleInvariantScope,
  TaskLifecycleInvariantSnapshot,
  TaskRecoveryOperations,
} from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { createLogger, type Logger } from '@/util/log'
import { DAEMON_CADENCE, MAINTENANCE_PHASE } from './daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'

const log = createLogger('lifecycle.invariants')

const HOUR_MS = 3_600_000
const GRACE_MS = 24 * HOUR_MS

export type InvariantRule = 'R1' | 'R2' | 'C1' | 'T1' | 'T2' | 'T3' | 'U1' | 'CR-1'

/** RFC-053 P-6 stuck-task detector emits these. Shares lifecycle_alerts table.
 *  S5 added by RFC-098 WP-8 (running task, active runs, events stalled). */
export type StuckRule = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

/** Union of every rule kind that can appear in lifecycle_alerts.rule.
 *
 * RFC-057: canonical list lives in `@agent-workflow/shared/lifecycle-alerts`
 * so the diagnose-repair option taxonomy can `satisfies Record<...>` it.
 * `InvariantRule | StuckRule` here is structurally identical; a compile-time
 * assignability check below catches drift if either list is edited in
 * isolation. */
export type LifecycleAlertRule = SharedLifecycleAlertRule

// Compile-time guard: backend's local union must equal shared's union.
type _AssertBackendSubsetOfShared = InvariantRule | StuckRule extends SharedLifecycleAlertRule
  ? true
  : never
type _AssertSharedSubsetOfBackend = SharedLifecycleAlertRule extends InvariantRule | StuckRule
  ? true
  : never
const _LIFECYCLE_RULE_UNION_GUARD: [_AssertBackendSubsetOfShared, _AssertSharedSubsetOfBackend] = [
  true,
  true,
]

export type InvariantSeverity = 'warning' | 'error'

/** Canonical list of the invariant rules — used as `ownedRules` so
 *  the invariants reconcile only touches their own open rows. */
export const INVARIANT_RULES = [
  'R1',
  'R2',
  'C1',
  'T1',
  'T2',
  'T3',
  'U1',
  'CR-1',
] as const satisfies readonly InvariantRule[]

/** Canonical list of the stuck-task rules. */
export const STUCK_RULES = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
] as const satisfies readonly StuckRule[]

// RFC-317 T43 —— 编译期守卫：**两张表都必须对各自的 union 穷尽**。
//
// 这两个常量此前标注的是 `readonly InvariantRule[]`。那个标注只保证「里面装的都是
// 合法规则」，**完全不保证装全了**——往 union 里加一条规则、忘了往数组里加，
// 一行都不会红。代价是静默的：这两个数组是作为 `ownedRules` 传给
// `reconcileLifecycleAlerts` 的，而 `ownedRules` 正是「这次对账只碰自己的行」的
// 那道闸。漏掉一条规则 = 该规则的 alert 行永远不被对账触碰：既不会被解决、也不会
// 被升级，只会一直挂在 lifecycle_alerts 里，而且没有任何报错指向原因。
//
// `as const satisfies` 换掉宽标注后，下面两条把反方向也钉死：union 里有、数组里没有
// 的成员会让 `Exclude<...>` 非空，于是 `extends never` 落到 `never`，赋值 `true`
// 变成编译错误。（写法与本文件上方的 `_LIFECYCLE_RULE_UNION_GUARD` 一致。）
type _AssertInvariantRulesExhaustive =
  Exclude<InvariantRule, (typeof INVARIANT_RULES)[number]> extends never ? true : never
type _AssertStuckRulesExhaustive =
  Exclude<StuckRule, (typeof STUCK_RULES)[number]> extends never ? true : never
const _RULE_LIST_EXHAUSTIVE_GUARD: [_AssertInvariantRulesExhaustive, _AssertStuckRulesExhaustive] =
  [true, true]

export interface LifecycleInvariantFinding {
  taskId: string
  rule: InvariantRule
  /** JSON-serializable; rendered into lifecycle_alerts.detail. */
  detail: Record<string, unknown>
}

/** Generic finding used by `reconcileLifecycleAlerts`; PR-D / PR-E both
 *  pass their own narrowed flavors (`LifecycleInvariantFinding` /
 *  `StuckTaskFinding`). */
export interface LifecycleAlertFinding {
  taskId: string
  rule: LifecycleAlertRule
  detail: Record<string, unknown>
}

export interface LifecycleAlertRow {
  id: string
  taskId: string
  rule: LifecycleAlertRule
  severity: InvariantSeverity
  detail: Record<string, unknown>
  detectedAt: number
  resolvedAt: number | null
}

export type InvariantScope = TaskLifecycleInvariantScope

export interface RunLifecycleInvariantsArgs {
  operations: TaskRecoveryOperations
  scope?: InvariantScope
  /** Injectable clock for tests / property checks. */
  now?: () => number
  /**
   * Called when a new alert row is inserted OR an existing row is promoted
   * from 'warning' to 'error'. Production wires this to the
   * `tasksListBroadcaster.broadcast('lifecycle.alert', ...)` adapter (T4);
   * tests assert on the calls.
   */
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  /** Called once per task whose open alert set shrank in this pass. */
  onResolved?: (taskId: string) => void
}

export interface RunLifecycleInvariantsResult {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  /** All currently-open alerts for the scanned scope (post-reconciliation). */
  openAlerts: LifecycleAlertRow[]
}

// =============================================================================
// workflow snapshot parsing (per-task)
// =============================================================================

interface NodeKindMap {
  /** nodeId → kind */
  byId: Map<string, NodeKind>
  /** kind → nodeIds */
  byKind: Map<NodeKind, string[]>
}

function parseWorkflowSnapshot(snapshot: string): NodeKindMap {
  const map: NodeKindMap = { byId: new Map(), byKind: new Map() }
  try {
    const parsed = JSON.parse(snapshot) as Partial<WorkflowDefinition>
    const ns = parsed?.nodes
    if (!Array.isArray(ns)) return map
    for (const n of ns) {
      if (typeof n?.id !== 'string' || typeof n?.kind !== 'string') continue
      const k = n.kind as NodeKind
      map.byId.set(n.id, k)
      const arr = map.byKind.get(k) ?? []
      arr.push(n.id)
      map.byKind.set(k, arr)
    }
  } catch {
    // corrupt snapshot — treat as empty; the task will simply not get
    // workflow-shape-aware invariants (R2/T3) checked.
  }
  return map
}

// =============================================================================
// per-invariant checks
// =============================================================================

interface TaskScanContext extends TaskLifecycleInvariantSnapshot {
  workflowKinds: NodeKindMap
}

function checkR1(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // R1: any approved doc_version ⟹ its review node_run is done.
  const out: LifecycleInvariantFinding[] = []
  const approved = ctx.documentVersions.filter((version) => version.decision === 'approved')
  if (approved.length === 0) return out
  const statusOf = new Map(ctx.nodeRuns.map((run) => [run.id, run.status]))
  for (const d of approved) {
    const s = statusOf.get(d.reviewNodeRunId)
    if (s !== 'done') {
      out.push({
        taskId: ctx.taskId,
        rule: 'R1',
        detail: {
          rule: 'R1',
          message: 'doc_version approved but review node_run is not done',
          docVersionId: d.id,
          reviewNodeRunId: d.reviewNodeRunId,
          reviewNodeId: d.reviewNodeId,
          actualStatus: s ?? '<not-found>',
        },
      })
    }
  }
  return out
}

function checkR2(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // R2: review node_run.status='done' ⟹ ∃ approved doc_version for it.
  const out: LifecycleInvariantFinding[] = []
  const reviewNodeIds = ctx.workflowKinds.byKind.get('review') ?? []
  if (reviewNodeIds.length === 0) return out
  const reviewNodeIdSet = new Set(reviewNodeIds)
  const doneReviewRuns = ctx.nodeRuns.filter(
    (run) => run.status === 'done' && reviewNodeIdSet.has(run.nodeId),
  )
  if (doneReviewRuns.length === 0) return out
  const approvedRunIds = new Set(
    ctx.documentVersions
      .filter((version) => version.decision === 'approved')
      .map((version) => version.reviewNodeRunId),
  )
  for (const r of doneReviewRuns) {
    if (!approvedRunIds.has(r.id)) {
      out.push({
        taskId: ctx.taskId,
        rule: 'R2',
        detail: {
          rule: 'R2',
          message: 'review node_run is done but no approved doc_version exists',
          reviewNodeRunId: r.id,
          reviewNodeId: r.nodeId,
        },
      })
    }
  }
  return out
}

function checkC1(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // C1: closed clarify_session (answered/canceled) ⟹ clarify node_run not awaiting_human.
  const out: LifecycleInvariantFinding[] = []
  const closedSessions = ctx.clarifyRounds.filter(
    (round) =>
      round.kind === 'self' && (round.status === 'answered' || round.status === 'canceled'),
  )
  if (closedSessions.length === 0) return out
  const statusOf = new Map(ctx.nodeRuns.map((run) => [run.id, run.status]))
  for (const s of closedSessions) {
    const ns = statusOf.get(s.clarifyNodeRunId)
    if (ns === 'awaiting_human') {
      out.push({
        taskId: ctx.taskId,
        rule: 'C1',
        detail: {
          rule: 'C1',
          message: 'clarify_session closed but clarify node_run still awaiting_human',
          clarifySessionId: s.id,
          clarifySessionStatus: s.status,
          clarifyNodeRunId: s.clarifyNodeRunId,
          clarifyNodeId: s.clarifyNodeId,
          actualStatus: ns,
        },
      })
    }
  }
  return out
}

function checkT1(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // T1: task awaiting_review ⟹ ∃ node_run awaiting_review.
  if (ctx.taskStatus !== 'awaiting_review') return []
  if (ctx.nodeRuns.some((run) => run.status === 'awaiting_review')) return []
  return [
    {
      taskId: ctx.taskId,
      rule: 'T1',
      detail: {
        rule: 'T1',
        message: 'task.status=awaiting_review but no node_run is awaiting_review',
        taskId: ctx.taskId,
      },
    },
  ]
}

function checkT2(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  if (ctx.taskStatus !== 'awaiting_human') return []
  if (ctx.nodeRuns.some((run) => run.status === 'awaiting_human')) return []
  // RFC-120 T9 (model A): a deferred-dispatch task legitimately parks awaiting_human
  // on undispatched designer task_questions — the designer's draft run is `done`
  // (NOT awaiting_human), so the scheduler bubbles the park from the frontier, not a
  // node_run. That is the deferred gate, not corruption. (Self-gated on the deferred
  // flag → always false for non-deferred tasks; T2 fires as before for them.)
  if (ctx.hasUndispatchedDesignerQuestions) return []
  return [
    {
      taskId: ctx.taskId,
      rule: 'T2',
      detail: {
        rule: 'T2',
        message: 'task.status=awaiting_human but no node_run is awaiting_human',
        taskId: ctx.taskId,
      },
    },
  ]
}

function checkT3(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // T3: done task ⟹ every output-kind node has a SETTLED node_run.
  //
  // RFC-306 widened "settled" from `done` to `done ∪ skipped`. A conditional
  // workflow legitimately finishes with some output nodes never produced —
  // that is the entire point of a branch — and those nodes carry a `skipped`
  // row rather than a `done` one. Keeping the rule done-only would make every
  // successful branching task report an invariant violation.
  //
  // The rule's TEETH are unchanged, and that is the part worth guarding: an
  // output node with NO row at all, or whose latest row is `failed` /
  // `interrupted` / still pending, is still a finding. "Done task, output node
  // that nobody ever settled" remains exactly as loud as before.
  if (ctx.taskStatus !== 'done') return []
  const outputNodes = ctx.workflowKinds.byKind.get('output') ?? []
  if (outputNodes.length === 0) return [] // no output nodes ⇒ vacuously satisfied
  // Design-gate P2#10 — judge the FRESHEST top-level row per output node, not
  // "does a settled row exist anywhere in history".
  //
  // The old shape ("any done row") had a hole that RFC-306 would have widened:
  // an output node with an old `done` row and a newer `failed` row passed the
  // check, because the old row still satisfied the existence test. Widening the
  // status set to `done ∪ skipped` without also pinning "freshest" would have
  // made that hole bigger, and design.md promises the opposite — that a latest
  // `failed` output node still reports.
  const outputNodeIdSet = new Set(outputNodes)
  const outputRuns = ctx.nodeRuns.filter((run) => outputNodeIdSet.has(run.nodeId))
  const freshestByNode = new Map<string, { id: string; status: string }>()
  for (const r of outputRuns) {
    if (r.parentNodeRunId !== null) continue // shard/child rows never settle a node
    const cur = freshestByNode.get(r.nodeId)
    if (cur === undefined || r.id > cur.id) freshestByNode.set(r.nodeId, r)
  }
  const missing = outputNodes.filter((n) => {
    const latest = freshestByNode.get(n)
    return latest === undefined || (latest.status !== 'done' && latest.status !== 'skipped')
  })
  if (missing.length === 0) return []
  return [
    {
      taskId: ctx.taskId,
      rule: 'T3',
      detail: {
        rule: 'T3',
        message: 'task.status=done but not every output node has a done or skipped node_run',
        missingOutputNodeIds: missing,
      },
    },
  ]
}

function checkU1(ctx: TaskScanContext): LifecycleInvariantFinding[] {
  // U1: per (task, nodeId, reviewIteration, shardKey) at most 1 row in
  //     {awaiting_review, awaiting_human}.
  // RFC-074 PR-C: the dedup key no longer carries the retired clarifyIteration
  // dimension. With speculative cci-bumped pre-mints gone (PR-B), a node has at
  // most one active row per (reviewIteration, shard) slot; two active rows there
  // is a genuine duplicate regardless of generation, so dropping the cci
  // dimension tightens the invariant to exactly the no-speculative-mint world.
  const rows = ctx.nodeRuns.filter(
    (run) => run.status === 'awaiting_review' || run.status === 'awaiting_human',
  )
  if (rows.length < 2) return []
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.nodeId}|${r.reviewIteration}|${r.shardKey ?? ''}`
    const existing = groups.get(key) ?? []
    existing.push(r)
    groups.set(key, existing)
  }
  const out: LifecycleInvariantFinding[] = []
  for (const [key, grp] of groups) {
    if (grp.length < 2) continue
    out.push({
      taskId: ctx.taskId,
      rule: 'U1',
      detail: {
        rule: 'U1',
        message: 'multiple active node_runs share (nodeId, iter, shard)',
        key,
        nodeRunIds: grp.map((r) => r.id),
        statuses: grp.map((r) => r.status),
      },
    })
  }
  return out
}

// RFC-126: CR-1 (cross-clarify "answered+continue but parent task failed → upgrade
// to 'abandoned'") was RETIRED. Abandoning assumed the failed task would never run
// again, but `resumeTask` re-runs the designer — and `buildExternalFeedbackContext`
// skips 'abandoned' rounds, so abandoning SILENTLY DROPPED the human's answer on
// resume (confirmed data loss). Rounds now stay 'answered' so resume re-consumes
// them. The 'CR-1' rule name stays registered in INVARIANT_RULES so any legacy
// open CR-1 alerts auto-resolve via reconcile (no new CR-1 findings are produced).
// Migration 0066 un-abandons pre-RFC-126 'abandoned' rows back to 'answered'.

// =============================================================================
// reconciliation: diff findings against currently-open alerts
// =============================================================================

export interface ReconcileLifecycleAlertsResult {
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

/**
 * Diff `findings` against the currently-open `lifecycle_alerts` rows in
 * scope, then upsert: existing rows whose finding still appears are
 * touched (detail refresh + 24h-grace severity promotion warning→error);
 * existing rows whose finding has gone are flipped to `resolved_at=now`;
 * new findings are inserted at severity='warning'.
 *
 * `ownedRules` is the key correctness gate when multiple sources write to
 * the same `lifecycle_alerts` table (PR-D invariants + PR-E stuck
 * detector). Reconcile only "owns" rows whose `rule` is in this set; rows
 * outside the set are left alone (their owner does its own reconcile
 * pass). Without this guard the second module's scan would mark the
 * first's findings as resolved.
 */
export async function reconcileLifecycleAlerts(args: {
  operations: TaskRecoveryOperations
  taskIds: string[]
  findings: LifecycleAlertFinding[]
  now: number
  ownedRules: readonly LifecycleAlertRule[]
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  onResolved?: (taskId: string) => void
}): Promise<ReconcileLifecycleAlertsResult> {
  const reconciled = await args.operations.reconcileStuckAlerts({
    taskIds: args.taskIds,
    findings: args.findings,
    ownedRules: args.ownedRules,
    now: args.now,
    promotionAfterMs: GRACE_MS,
  })
  const openAlerts = reconciled.openAlerts.map(
    (row): LifecycleAlertRow => ({
      id: row.id,
      taskId: row.taskId,
      rule: row.rule as LifecycleAlertRule,
      severity: row.severity,
      detail: { ...row.detail },
      detectedAt: row.detectedAt,
      resolvedAt: null,
    }),
  )
  for (const transition of reconciled.transitions) {
    const row = openAlerts.find((candidate) => candidate.id === transition.row.id)
    if (row !== undefined) args.onAlert?.(row, transition.kind)
  }
  for (const taskId of reconciled.resolvedTaskIds) args.onResolved?.(taskId)
  return {
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
    openAlerts,
  }
}

// =============================================================================
// open-alert summary + tiered boot/periodic logging (shared by both scans)
// =============================================================================

/** Task statuses past which a task will not self-progress. A finding on a
 *  terminal task is permanent + benign (the task is over — only resume/retry or
 *  delete moves it), so those are logged at warn, not error, keeping daemon-boot
 *  logs from going red every restart over historic bookkeeping gaps on
 *  long-finished tasks. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES)

export interface OpenAlertSummary {
  /** Total open alerts in scope (all severities). */
  open: number
  /** How many are error-severity (i.e. past the 24h grace window). */
  errorCount: number
  /** Error-severity alerts on still-live tasks (pending / running /
   *  awaiting_review / awaiting_human) — the actionable subset a human can
   *  still clear via resume / answer / cancel. Error alerts on terminal tasks
   *  are excluded: they are benign historic inconsistencies. */
  liveErrorCount: number
  /** Open-alert tally keyed by rule, for an at-a-glance shape of the backlog. */
  byRule: Record<string, number>
}

/**
 * Classify the open alerts a reconcile pass returned. Pure, so it is trivially
 * unit-testable; both scan entry points (invariants scan + stuck-task detector)
 * share it so their log lines stay consistent and self-explanatory.
 *
 * `statusByTask` maps each *scanned* taskId → its lifecycle status. A taskId
 * absent from the map is treated as live (conservative — never downgrade a
 * finding we cannot classify).
 */
export function summarizeOpenAlerts(
  openAlerts: readonly LifecycleAlertRow[],
  statusByTask: ReadonlyMap<string, string>,
): OpenAlertSummary {
  const byRule: Record<string, number> = {}
  let errorCount = 0
  let liveErrorCount = 0
  for (const a of openAlerts) {
    byRule[a.rule] = (byRule[a.rule] ?? 0) + 1
    if (a.severity !== 'error') continue
    errorCount++
    const status = statusByTask.get(a.taskId)
    if (status === undefined || !TERMINAL_STATUSES.has(status)) liveErrorCount++
  }
  return { open: openAlerts.length, errorCount, liveErrorCount, byRule }
}

/**
 * Emit the tiered aggregate log line for a scan:
 *   - error  — at least one error-severity finding sits on a live/parked task
 *              (actionable now).
 *   - warn   — there are error-severity findings but every one is on a terminal
 *              task (benign historic backlog; delete or repair to clear).
 *   - (none) — no error-severity findings; the INFO 'scan complete' line already
 *              carries the new/promoted/resolved deltas.
 *
 * Fresh warning-severity findings intentionally do NOT raise the tier: the 24h
 * grace is by design, and the per-alert `onAlert` WS broadcast already surfaces
 * them in the UI immediately.
 *
 * **Suppression**: when `stateChanged` is false (no new, promoted, or resolved
 * alerts in this scan), the aggregate log is skipped entirely. The INFO 'scan
 * complete' line already carries `findings` / `newAlerts` / `promotedAlerts` /
 * `resolvedAlerts` — anyone tailing the log can see the scan ran and the current
 * finding count. This prevents the same ERROR line from repeating every scan
 * interval for a steady-state backlog (observed: 21k+ identical ERROR lines
 * over 3 months for 7 unchanged stuck-task alerts). Defaults to `true` so
 * one-off direct callers (diagnose route, repair flows) always log.
 */
export function logAlertSummary(
  logger: Logger,
  messages: { actionable: string; benign: string },
  summary: OpenAlertSummary,
  promotedThisScan: number,
  stateChanged: boolean = true,
): void {
  if (!stateChanged) return
  if (summary.liveErrorCount > 0) {
    logger.error(messages.actionable, {
      open: summary.open,
      errorCount: summary.errorCount,
      liveErrorCount: summary.liveErrorCount,
      promotedThisScan,
      byRule: summary.byRule,
    })
  } else if (summary.errorCount > 0) {
    logger.warn(messages.benign, {
      open: summary.open,
      errorCount: summary.errorCount,
      byRule: summary.byRule,
      hint: 'all on terminal tasks (done/failed/canceled/interrupted) — delete or repair via the Diagnose panel to clear',
    })
  }
}

// =============================================================================
// public entry
// =============================================================================

export async function runLifecycleInvariants(
  args: RunLifecycleInvariantsArgs,
): Promise<RunLifecycleInvariantsResult> {
  const now = (args.now ?? Date.now)()
  const snapshots = await args.operations.loadLifecycleInvariantSnapshots(
    args.scope ?? { all: true },
  )
  if (snapshots.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }

  const findings: LifecycleInvariantFinding[] = []
  let processed = 0
  for (const snapshot of snapshots) {
    // RFC-311: the boot-time full scan used to run its ~7 checks × N tasks as
    // one uninterrupted synchronous stretch (seconds of frozen HTTP/WS right
    // when users first open the UI). Yield the event loop between batches so
    // requests interleave; total work is unchanged.
    processed += 1
    if (processed % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0))
    const ctx: TaskScanContext = {
      ...snapshot,
      workflowKinds: parseWorkflowSnapshot(snapshot.workflowSnapshot),
    }
    findings.push(...checkR1(ctx))
    findings.push(...checkR2(ctx))
    findings.push(...checkC1(ctx))
    findings.push(...checkT1(ctx))
    findings.push(...checkT2(ctx))
    findings.push(...checkT3(ctx))
    findings.push(...checkU1(ctx))
    // RFC-126: CR-1 retired (no longer abandons cross rounds — see note above).
  }

  const reconciled = await reconcileLifecycleAlerts({
    operations: args.operations,
    taskIds: snapshots.map((snapshot) => snapshot.taskId),
    findings,
    now,
    ownedRules: INVARIANT_RULES,
    onAlert: args.onAlert,
    onResolved: args.onResolved,
  })

  log.info('scan complete', {
    scanned: snapshots.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  const statusByTask = new Map(snapshots.map((snapshot) => [snapshot.taskId, snapshot.taskStatus]))
  const stateChanged =
    reconciled.newAlerts > 0 || reconciled.promotedAlerts > 0 || reconciled.resolvedAlerts > 0
  logAlertSummary(
    log,
    {
      actionable: 'lifecycle invariants violated',
      benign: 'lifecycle invariants: historic findings on terminal tasks (benign)',
    },
    summarizeOpenAlerts(reconciled.openAlerts, statusByTask),
    reconciled.promotedAlerts,
    stateChanged,
  )
  return { scanned: snapshots.length, ...reconciled }
}

// =============================================================================
// startup + periodic scan adapter
// =============================================================================

/**
 * Drives the invariant scan on two cadences:
 *   - boot: run once after `bootDelayMs` (~5s default) with `{ all: true }`
 *     so historic stuck tasks surface in lifecycle_alerts on first daemon
 *     start after rollout (severity='warning' for 24h grace then promoted).
 *   - periodic: every `intervalMs` (default 1h) with `{ since: now - 2h }`
 *     incremental.
 *
 * Returns a handle whose `.stop()` clears both timers; integration with
 * graceful shutdown lives in cli/start.ts.
 *
 * `onAlert` is passed straight through to `runLifecycleInvariants` so the
 * caller can broadcast `tasksListBroadcaster` events without this module
 * importing the WS layer (keeps the service unit-testable in isolation).
 */
export function startLifecycleInvariantsLoop(opts: {
  operations: TaskRecoveryOperations
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  onResolved?: (taskId: string) => void
  bootDelayMs?: number
  intervalMs?: number
  /** Incremental window: how far back to look (default 2h). */
  incrementalWindowMs?: number
  /** RFC-322：周期拍的错峰相位。 */
  phaseOffsetMs?: number
}): { stop: () => void } {
  const bootDelay = opts.bootDelayMs ?? 5_000
  const interval = opts.intervalMs ?? DAEMON_CADENCE.lifecycleInvariants
  const window = opts.incrementalWindowMs ?? 2 * HOUR_MS
  let running = false

  const safeRun = (scope: InvariantScope): void => {
    if (running) return
    running = true
    void runLifecycleInvariants({
      operations: opts.operations,
      scope,
      onAlert: opts.onAlert,
      onResolved: opts.onResolved,
    })
      .catch((err: unknown) => {
        log.error('scan failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
      })
  }

  // RFC-322：boot 拍与周期拍跑的是**不同 scope**（全量 vs 增量窗口），所以不能把 boot
  // 交给 startMaintenanceTicker 的 bootDelayMs（那是同一个 onTick）；只把周期拍纳入
  // 错峰。`safeRun` 自带的 running 闸仍是两者共享的那一个，语义逐字不变。
  const bootTimer = setTimeout(() => safeRun({ all: true }), bootDelay)
  const periodicTicker = startMaintenanceTicker({
    job: 'lifecycleInvariants',
    intervalMs: interval,
    phaseOffsetMs: opts.phaseOffsetMs ?? MAINTENANCE_PHASE.lifecycleInvariants,
    onTick: () => safeRun({ since: Date.now() - window }),
  })
  return {
    stop: (): void => {
      clearTimeout(bootTimer)
      periodicTicker.stop()
    },
  }
}
