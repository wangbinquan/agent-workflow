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
//   T3  tasks.status='done'              ⟹ ∀ output-kind nodes have done node_run
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

import { and, eq, gte, inArray, isNull, isNotNull, or } from 'drizzle-orm'
import { ulid } from 'ulid'

import type {
  LifecycleAlertRule as SharedLifecycleAlertRule,
  WorkflowDefinition,
  NodeKind,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  docVersions,
  lifecycleAlerts,
  nodeRuns,
  tasks,
} from '@/db/schema'
import { hasUndispatchedDesignerQuestions } from '@/services/taskQuestions'
import { createLogger } from '@/util/log'

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

/** Canonical list of the seven invariant rules — used as `ownedRules` so
 *  the invariants reconcile only touches their own open rows. */
export const INVARIANT_RULES: readonly InvariantRule[] = [
  'R1',
  'R2',
  'C1',
  'T1',
  'T2',
  'T3',
  'U1',
  'CR-1',
]

/** Canonical list of the five stuck-task rules. */
export const STUCK_RULES: readonly StuckRule[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']

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

export type InvariantScope = { taskId: string } | { since: number } | { all: true }

export interface RunLifecycleInvariantsArgs {
  db: DbClient
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
// scope resolution
// =============================================================================

async function resolveScopeToTaskIds(db: DbClient, scope: InvariantScope): Promise<string[]> {
  if ('taskId' in scope) {
    const row = (
      await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, scope.taskId)).limit(1)
    )[0]
    return row === undefined ? [] : [row.id]
  }
  if ('since' in scope) {
    const since = scope.since
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          isNull(tasks.deletedAt),
          // "active recently" = started since OR finished since OR still open
          or(gte(tasks.startedAt, since), gte(tasks.finishedAt, since), isNull(tasks.finishedAt)),
        ),
      )
    return rows.map((r) => r.id)
  }
  // { all: true }
  const rows = await db.select({ id: tasks.id }).from(tasks).where(isNull(tasks.deletedAt))
  return rows.map((r) => r.id)
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

interface TaskScanContext {
  taskId: string
  taskStatus: string
  workflowKinds: NodeKindMap
}

async function checkR1(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // R1: any approved doc_version ⟹ its review node_run is done.
  const out: LifecycleInvariantFinding[] = []
  const approved = await db
    .select({
      id: docVersions.id,
      reviewNodeRunId: docVersions.reviewNodeRunId,
      reviewNodeId: docVersions.reviewNodeId,
      versionIndex: docVersions.versionIndex,
    })
    .from(docVersions)
    .where(and(eq(docVersions.taskId, ctx.taskId), eq(docVersions.decision, 'approved')))
  if (approved.length === 0) return out
  const runIds = approved.map((d) => d.reviewNodeRunId)
  const runRows = await db
    .select({ id: nodeRuns.id, status: nodeRuns.status })
    .from(nodeRuns)
    .where(inArray(nodeRuns.id, runIds))
  const statusOf = new Map(runRows.map((r) => [r.id, r.status]))
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

async function checkR2(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // R2: review node_run.status='done' ⟹ ∃ approved doc_version for it.
  const out: LifecycleInvariantFinding[] = []
  const reviewNodeIds = ctx.workflowKinds.byKind.get('review') ?? []
  if (reviewNodeIds.length === 0) return out
  const doneReviewRuns = await db
    .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, ctx.taskId),
        eq(nodeRuns.status, 'done'),
        inArray(nodeRuns.nodeId, reviewNodeIds),
      ),
    )
  if (doneReviewRuns.length === 0) return out
  const runIds = doneReviewRuns.map((r) => r.id)
  const dvRows = await db
    .select({
      reviewNodeRunId: docVersions.reviewNodeRunId,
      decision: docVersions.decision,
    })
    .from(docVersions)
    .where(inArray(docVersions.reviewNodeRunId, runIds))
  const approvedRunIds = new Set(
    dvRows.filter((d) => d.decision === 'approved').map((d) => d.reviewNodeRunId),
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

async function checkC1(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // C1: closed clarify_session (answered/canceled) ⟹ clarify node_run not awaiting_human.
  const out: LifecycleInvariantFinding[] = []
  const closedSessions = await db
    .select({
      id: clarifySessions.id,
      status: clarifySessions.status,
      clarifyNodeRunId: clarifySessions.clarifyNodeRunId,
      clarifyNodeId: clarifySessions.clarifyNodeId,
    })
    .from(clarifySessions)
    .where(
      and(
        eq(clarifySessions.taskId, ctx.taskId),
        inArray(clarifySessions.status, ['answered', 'canceled']),
      ),
    )
  if (closedSessions.length === 0) return out
  const runIds = closedSessions.map((s) => s.clarifyNodeRunId)
  const runRows = await db
    .select({ id: nodeRuns.id, status: nodeRuns.status })
    .from(nodeRuns)
    .where(inArray(nodeRuns.id, runIds))
  const statusOf = new Map(runRows.map((r) => [r.id, r.status]))
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

async function checkT1(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // T1: task awaiting_review ⟹ ∃ node_run awaiting_review.
  if (ctx.taskStatus !== 'awaiting_review') return []
  const row = (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, ctx.taskId), eq(nodeRuns.status, 'awaiting_review')))
      .limit(1)
  )[0]
  if (row !== undefined) return []
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

async function checkT2(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  if (ctx.taskStatus !== 'awaiting_human') return []
  const row = (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, ctx.taskId), eq(nodeRuns.status, 'awaiting_human')))
      .limit(1)
  )[0]
  if (row !== undefined) return []
  // RFC-120 T9 (model A): a deferred-dispatch task legitimately parks awaiting_human
  // on undispatched designer task_questions — the designer's draft run is `done`
  // (NOT awaiting_human), so the scheduler bubbles the park from the frontier, not a
  // node_run. That is the deferred gate, not corruption. (Self-gated on the deferred
  // flag → always false for non-deferred tasks; T2 fires as before for them.)
  if (await hasUndispatchedDesignerQuestions(db, ctx.taskId)) return []
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

async function checkT3(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // T3: done task ⟹ every output-kind node has a done node_run.
  if (ctx.taskStatus !== 'done') return []
  const outputNodes = ctx.workflowKinds.byKind.get('output') ?? []
  if (outputNodes.length === 0) return [] // no output nodes ⇒ vacuously satisfied
  const doneOutputRuns = await db
    .select({ nodeId: nodeRuns.nodeId })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, ctx.taskId),
        eq(nodeRuns.status, 'done'),
        inArray(nodeRuns.nodeId, outputNodes),
      ),
    )
  const doneSet = new Set(doneOutputRuns.map((r) => r.nodeId))
  const missing = outputNodes.filter((n) => !doneSet.has(n))
  if (missing.length === 0) return []
  return [
    {
      taskId: ctx.taskId,
      rule: 'T3',
      detail: {
        rule: 'T3',
        message: 'task.status=done but not every output node has a done node_run',
        missingOutputNodeIds: missing,
      },
    },
  ]
}

async function checkU1(db: DbClient, ctx: TaskScanContext): Promise<LifecycleInvariantFinding[]> {
  // U1: per (task, nodeId, reviewIteration, shardKey) at most 1 row in
  //     {awaiting_review, awaiting_human}.
  // RFC-074 PR-C: the dedup key no longer carries the retired clarifyIteration
  // dimension. With speculative cci-bumped pre-mints gone (PR-B), a node has at
  // most one active row per (reviewIteration, shard) slot; two active rows there
  // is a genuine duplicate regardless of generation, so dropping the cci
  // dimension tightens the invariant to exactly the no-speculative-mint world.
  const rows = await db
    .select({
      id: nodeRuns.id,
      nodeId: nodeRuns.nodeId,
      reviewIteration: nodeRuns.reviewIteration,
      shardKey: nodeRuns.shardKey,
      status: nodeRuns.status,
    })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, ctx.taskId),
        inArray(nodeRuns.status, ['awaiting_review', 'awaiting_human']),
      ),
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

async function checkCR1(
  db: DbClient,
  ctx: TaskScanContext,
  now: number,
): Promise<LifecycleInvariantFinding[]> {
  // CR-1 (RFC-056 §10 + RFC-064): cross-clarify round answered+continue +
  // parent task failed + the cross-clarify round was never consumed by a
  // done-with-output designer run ⟹ upgrade to 'abandoned'. RFC-074 PR-C / D8:
  // "was this round consumed?" is answered directly by the RFC-070
  // `consumed_by_consumer_run_id` stamp (set by markRoundsConsumed when the
  // designer finishes done-with-output) — no more cross-scale clarifyIteration
  // comparison against the round's local iteration counter.
  //
  // Unlike R1/R2/C1/T*/U1, this rule is "auto-upgrade": the violation IS the
  // signal — we flip the row to abandoned in this pass so the next scan
  // sees nothing. The lifecycle_alerts breadcrumb is still emitted (with
  // detail.message = "...upgraded to abandoned") so operators see the
  // upgrade for audit / debug.
  //
  // RFC-058 T15: read path switched to `clarify_rounds WHERE kind='cross'`
  // (unified table). Column projection keeps the legacy field names so the
  // detail payload + downstream code path stays byte-identical for the
  // diagnose panel. UPDATE side still dual-writes to legacy
  // cross_clarify_sessions + clarify_rounds (kept until T14/T16 finish
  // reader migration); migration 0032 will drop the legacy table.
  if (ctx.taskStatus !== 'failed') return []
  const stuck = await db
    .select({
      id: clarifyRounds.id,
      crossClarifyNodeId: clarifyRounds.intermediaryNodeId,
      targetDesignerNodeId: clarifyRounds.targetConsumerNodeId,
      iteration: clarifyRounds.iteration,
      directive: clarifyRounds.directive,
      status: clarifyRounds.status,
    })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, ctx.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.status, 'answered'),
        eq(clarifyRounds.directive, 'continue'),
        isNotNull(clarifyRounds.targetConsumerNodeId),
        // RFC-074 PR-C / D8: only un-consumed rounds are abandonment candidates.
        // The consumed-by stamp is set when a done-with-output designer run bakes
        // this round in — its presence means the feedback WAS consumed.
        isNull(clarifyRounds.consumedByConsumerRunId),
      ),
    )
  if (stuck.length === 0) return []

  const out: LifecycleInvariantFinding[] = []
  for (const s of stuck) {
    if (s.targetDesignerNodeId === null) continue

    // Upgrade in place.
    await db
      .update(crossClarifySessions)
      .set({ status: 'abandoned', abandonedAt: now })
      .where(eq(crossClarifySessions.id, s.id))

    // RFC-058 T12 dual-write — mirror CR-1 abandoned upgrade to clarify_rounds.
    await db
      .update(clarifyRounds)
      .set({ status: 'abandoned', abandonedAt: now })
      .where(eq(clarifyRounds.id, s.id))

    out.push({
      taskId: ctx.taskId,
      rule: 'CR-1',
      detail: {
        rule: 'CR-1',
        message: 'cross_clarify_session answered+continue with task failed; upgraded to abandoned',
        crossClarifySessionId: s.id,
        crossClarifyNodeId: s.crossClarifyNodeId,
        targetDesignerNodeId: s.targetDesignerNodeId,
        iteration: s.iteration,
      },
    })
  }
  return out
}

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
  db: DbClient
  taskIds: string[]
  findings: LifecycleAlertFinding[]
  now: number
  ownedRules: readonly LifecycleAlertRule[]
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
}): Promise<ReconcileLifecycleAlertsResult> {
  const { db, taskIds, findings, now, ownedRules, onAlert } = args
  // Load currently-open alerts in scope whose rule is owned by this pass.
  const openRows =
    taskIds.length === 0 || ownedRules.length === 0
      ? []
      : await db
          .select()
          .from(lifecycleAlerts)
          .where(
            and(
              inArray(lifecycleAlerts.taskId, taskIds),
              inArray(lifecycleAlerts.rule, ownedRules as string[]),
              isNull(lifecycleAlerts.resolvedAt),
            ),
          )

  const openByKey = new Map<string, (typeof openRows)[number]>()
  for (const r of openRows) openByKey.set(keyOf(r.taskId, r.rule), r)

  const findingByKey = new Map<string, LifecycleAlertFinding>()
  for (const f of findings) findingByKey.set(keyOf(f.taskId, f.rule), f)

  let newCount = 0
  let promotedCount = 0
  let resolvedCount = 0
  const open: LifecycleAlertRow[] = []

  // 1. Resolve open rows no longer in findings.
  for (const r of openRows) {
    const k = keyOf(r.taskId, r.rule)
    if (!findingByKey.has(k)) {
      await db.update(lifecycleAlerts).set({ resolvedAt: now }).where(eq(lifecycleAlerts.id, r.id))
      resolvedCount++
    }
  }

  // 2. For each finding: either update existing open row (maybe promote
  // severity) or insert new row.
  for (const f of findings) {
    const k = keyOf(f.taskId, f.rule)
    const existing = openByKey.get(k)
    const detailJson = JSON.stringify(f.detail)
    if (existing === undefined) {
      const id = ulid()
      await db.insert(lifecycleAlerts).values({
        id,
        taskId: f.taskId,
        rule: f.rule,
        severity: 'warning',
        detail: detailJson,
        detectedAt: now,
        resolvedAt: null,
      })
      newCount++
      const row: LifecycleAlertRow = {
        id,
        taskId: f.taskId,
        rule: f.rule,
        severity: 'warning',
        detail: f.detail,
        detectedAt: now,
        resolvedAt: null,
      }
      open.push(row)
      onAlert?.(row, 'new')
    } else {
      const sev = (
        existing.severity === 'warning' && now - existing.detectedAt >= GRACE_MS
          ? 'error'
          : existing.severity
      ) as InvariantSeverity
      const promoted = sev !== existing.severity
      await db
        .update(lifecycleAlerts)
        .set({ severity: sev, detail: detailJson })
        .where(eq(lifecycleAlerts.id, existing.id))
      if (promoted) promotedCount++
      const row: LifecycleAlertRow = {
        id: existing.id,
        taskId: f.taskId,
        rule: f.rule,
        severity: sev,
        detail: f.detail,
        detectedAt: existing.detectedAt,
        resolvedAt: null,
      }
      open.push(row)
      if (promoted) onAlert?.(row, 'promoted')
    }
  }

  return {
    newAlerts: newCount,
    promotedAlerts: promotedCount,
    resolvedAlerts: resolvedCount,
    openAlerts: open,
  }
}

function keyOf(taskId: string, rule: string): string {
  return `${taskId}\x00${rule}`
}

// =============================================================================
// public entry
// =============================================================================

export async function runLifecycleInvariants(
  args: RunLifecycleInvariantsArgs,
): Promise<RunLifecycleInvariantsResult> {
  const now = (args.now ?? Date.now)()
  const taskIds = await resolveScopeToTaskIds(args.db, args.scope ?? { all: true })
  if (taskIds.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }

  // Pre-fetch each task's status + workflow snapshot in one go.
  const taskRows = await args.db
    .select({
      id: tasks.id,
      status: tasks.status,
      snapshot: tasks.workflowSnapshot,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskIds))

  const findings: LifecycleInvariantFinding[] = []
  for (const t of taskRows) {
    const ctx: TaskScanContext = {
      taskId: t.id,
      taskStatus: t.status,
      workflowKinds: parseWorkflowSnapshot(t.snapshot),
    }
    findings.push(...(await checkR1(args.db, ctx)))
    findings.push(...(await checkR2(args.db, ctx)))
    findings.push(...(await checkC1(args.db, ctx)))
    findings.push(...(await checkT1(args.db, ctx)))
    findings.push(...(await checkT2(args.db, ctx)))
    findings.push(...(await checkT3(args.db, ctx)))
    findings.push(...(await checkU1(args.db, ctx)))
    findings.push(...(await checkCR1(args.db, ctx, now)))
  }

  const reconciled = await reconcileLifecycleAlerts({
    db: args.db,
    taskIds,
    findings,
    now,
    ownedRules: INVARIANT_RULES,
    onAlert: args.onAlert,
  })

  log.info('scan complete', {
    scanned: taskIds.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  if (reconciled.promotedAlerts > 0 || reconciled.openAlerts.some((a) => a.severity === 'error')) {
    log.error('lifecycle invariants violated', {
      open: reconciled.openAlerts.length,
      errorCount: reconciled.openAlerts.filter((a) => a.severity === 'error').length,
    })
  }
  return { scanned: taskIds.length, ...reconciled }
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
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  bootDelayMs?: number
  intervalMs?: number
  /** Incremental window: how far back to look (default 2h). */
  incrementalWindowMs?: number
}): { stop: () => void } {
  const bootDelay = opts.bootDelayMs ?? 5_000
  const interval = opts.intervalMs ?? HOUR_MS
  const window = opts.incrementalWindowMs ?? 2 * HOUR_MS
  let running = false

  const safeRun = (scope: InvariantScope): void => {
    if (running) return
    running = true
    void runLifecycleInvariants({ db: opts.db, scope, onAlert: opts.onAlert })
      .catch((err: unknown) => {
        log.error('scan failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
      })
  }

  const bootTimer = setTimeout(() => safeRun({ all: true }), bootDelay)
  const periodicTimer = setInterval(() => safeRun({ since: Date.now() - window }), interval)
  return {
    stop: (): void => {
      clearTimeout(bootTimer)
      clearInterval(periodicTimer)
    },
  }
}
