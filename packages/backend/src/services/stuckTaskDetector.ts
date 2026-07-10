// RFC-053 P-6 — stuck-task detector.
//
// Five rules (S1/S2/S3/S4/S5); each looks at whether a task has been parked
// in a status for longer than its threshold AND the *evidence* matching
// that status is missing. Together: "stuck without explanation."
//
//   S1  task.status='awaiting_review' > 30 min, no pending doc_version
//   S2  task.status='awaiting_human'  > 30 min, no open clarify_session
//   S3  task.status='running'         > 30 min, no node_run still active
//   S4  task.status='pending'         > 5 min
//   S5  task.status='running'         > 30 min quiet, active node_run(s)
//       exist but events stopped landing (RFC-098 WP-8 / audit S-15: the
//       opencode child is wedged — e.g. trapped SIGTERM, hung MCP — or died
//       without the runner settling the row)
//
// "30 min" for S1/S2/S3/S5 is from the latest node_run_events for the task —
// if events are still landing we don't flag (the task is actively talking
// to opencode, not stuck). Falls back to tasks.startedAt when no events.
// S4 uses tasks.startedAt directly because pending tasks never emit events.
//
// Findings land in the same lifecycle_alerts table as PR-D's invariants
// (rule='S1'|'S2'|'S3'|'S4'|'S5'); the shared reconcileLifecycleAlerts pass
// scoped to STUCK_RULES keeps the two writers from stepping on each
// other.
//
// Non-goal: this module does not "fix" stuck tasks. The UI surfaces them
// for an operator; remediation stays on the per-incident fixup script
// pattern that RFC-052 established (see scripts/fixup-rfc052-*).

import { and, eq, inArray, isNull, max } from 'drizzle-orm'

import {
  TERMINAL_NODE_RUN_STATUSES as SHARED_TERMINAL_NODE_RUN_STATUSES,
  nodeKindSettlesWithoutRow,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  docVersions,
  nodeRunEvents,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
} from '@/db/schema'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { createLogger } from '@/util/log'

import {
  reconcileLifecycleAlerts,
  STUCK_RULES,
  type LifecycleAlertFinding,
  type LifecycleAlertRow,
  type StuckRule,
} from './lifecycleInvariants'
import { hasUndispatchedDesignerQuestions } from '@/services/taskQuestions'

const log = createLogger('lifecycle.stuck')

const MIN_MS = 60_000

/** Default freshness threshold for S1/S2/S3 — 30 minutes. */
export const DEFAULT_STUCK_THRESHOLD_MS = 30 * MIN_MS
/** Default S4 threshold — 5 minutes; pending tasks should be picked up
 *  by the scheduler in ms, not minutes. */
export const DEFAULT_PENDING_THRESHOLD_MS = 5 * MIN_MS

export interface RunStuckTaskDetectorArgs {
  db: DbClient
  /** Override Date.now() — used by tests. */
  now?: () => number
  /** Default 30 minutes; overridable for tests. */
  stuckThresholdMs?: number
  /** Default 5 minutes; overridable for tests. */
  pendingThresholdMs?: number
  /** Receives newly-detected / promoted alerts; wired in cli/start.ts. */
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  /**
   * RFC-057: narrow the candidate set to a specific task subset. Used by the
   * repair engine to re-scan only the just-modified task after an apply().
   * Omitted ⟹ scan every non-terminal task (existing behavior).
   */
  taskIdFilter?: readonly string[]
}

export interface RunStuckTaskDetectorResult {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

interface StuckCandidate {
  taskId: string
  status: string
  startedAt: number
  ownerUserId: string | null
  /** RFC-164: non-null = workgroup task (S1/S2 exempt — engine-owned parking). */
  workgroupId: string | null
}

async function loadCandidates(db: DbClient, filter?: readonly string[]): Promise<StuckCandidate[]> {
  // Only non-terminal task statuses are candidates. Terminal tasks
  // (done/failed/canceled/interrupted) never "stick" in the operational
  // sense — they're a final state.
  const baseWhere = and(
    isNull(tasks.deletedAt),
    inArray(tasks.status, ['pending', 'running', 'awaiting_review', 'awaiting_human']),
  )
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      startedAt: tasks.startedAt,
      ownerUserId: tasks.ownerUserId,
      workgroupId: tasks.workgroupId,
    })
    .from(tasks)
    .where(
      filter === undefined || filter.length === 0
        ? baseWhere
        : and(baseWhere, inArray(tasks.id, filter as string[])),
    )
  return rows.map((r) => ({
    taskId: r.id,
    status: r.status,
    startedAt: r.startedAt,
    ownerUserId: r.ownerUserId,
    workgroupId: r.workgroupId,
  }))
}

/**
 * Returns the timestamp of the latest node_run_events row across any
 * node_run of `taskId`. Returns `null` when the task has none — e.g.
 * pending tasks that haven't spawned a runner yet.
 */
async function latestEventTsForTask(db: DbClient, taskId: string): Promise<number | null> {
  const row = (
    await db
      .select({ ts: max(nodeRunEvents.ts) })
      .from(nodeRunEvents)
      .innerJoin(nodeRuns, eq(nodeRuns.id, nodeRunEvents.nodeRunId))
      .where(eq(nodeRuns.taskId, taskId))
  )[0]
  if (row === undefined || row.ts === null) return null
  return row.ts
}

/**
 * RFC-098 WP-8: per-run flavor of `latestEventTsForTask` — the S5 detail
 * reports each wedged run's own last event so the operator can tell which
 * pid went quiet when.
 */
async function latestEventTsForRun(db: DbClient, nodeRunId: string): Promise<number | null> {
  const row = (
    await db
      .select({ ts: max(nodeRunEvents.ts) })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
  )[0]
  if (row === undefined || row.ts === null) return null
  return row.ts
}

async function hasPendingDocVersion(db: DbClient, taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(and(eq(docVersions.taskId, taskId), eq(docVersions.decision, 'pending')))
      .limit(1)
  )[0]
  return row !== undefined
}

async function hasOpenClarifySession(db: DbClient, taskId: string): Promise<boolean> {
  // RFC-108 T8 (AR-16): read the UNIFIED clarify_rounds table, not the legacy
  // clarify_sessions. RFC-058 dual-writes BOTH self-clarify (clarify.ts) and
  // cross-clarify (crossClarify.ts) as an 'awaiting_human' round here, but
  // cross-clarify NEVER writes clarify_sessions — so the old query made S2
  // false-fire on a genuinely-answerable cross-clarify task, and the only repair
  // (S2.demote-task) then demoted it, destroying an in-flight cross round.
  const row = (
    await db
      .select({ id: clarifyRounds.id })
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.status, 'awaiting_human')))
      .limit(1)
  )[0]
  return row !== undefined
}

// flag-audit W0：终态集合改引 shared 单源（原为手抄副本；NODE_RUN_STATUS 扩
// 枚举时由 shared 的 satisfies 守卫接管）。
const TERMINAL_NODE_RUN_SET: ReadonlySet<string> = new Set(SHARED_TERMINAL_NODE_RUN_STATUSES)

interface NodeRunCounts {
  total: number
  terminal: number
  active: number
  /** RFC-098 WP-8 (S5): the non-terminal rows with the fields the alert
   *  detail surfaces ({nodeRunId,nodeId,pid} + per-run lastEventTs later). */
  activeRows: Array<{ id: string; nodeId: string; status: string; pid: number | null }>
}

async function nodeRunCounts(db: DbClient, taskId: string): Promise<NodeRunCounts> {
  const rows = await db
    .select({
      id: nodeRuns.id,
      nodeId: nodeRuns.nodeId,
      status: nodeRuns.status,
      pid: nodeRuns.pid,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  let terminal = 0
  const activeRows: NodeRunCounts['activeRows'] = []
  for (const r of rows) {
    if (TERMINAL_NODE_RUN_SET.has(r.status)) terminal++
    else activeRows.push(r)
  }
  return { total: rows.length, terminal, active: rows.length - terminal, activeRows }
}

/**
 * RFC-108 T14 (AR-06): does this task have NO active member who could answer a
 * review/clarify? True only when the task HAS a human membership boundary (owner
 * and/or collaborators, excluding the __system__ sentinel) and EVERY such member
 * is non-active — disabled, or a dangling id with no users row. A system-owned /
 * no-auth task (no human members) returns false: there's no membership boundary
 * to deadlock.
 */
async function taskHasNoActiveMember(db: DbClient, c: StuckCandidate): Promise<boolean> {
  const collabRows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, c.taskId))
  const collaboratorIds = collabRows.filter((r) => r.role === 'collaborator').map((r) => r.userId)
  const memberIds = [
    ...new Set([
      ...(c.ownerUserId !== null && c.ownerUserId !== SYSTEM_USER_ID ? [c.ownerUserId] : []),
      ...collaboratorIds,
    ]),
  ]
  if (memberIds.length === 0) return false // no human membership boundary
  const userRows = await db
    .select({ status: users.status })
    .from(users)
    .where(inArray(users.id, memberIds))
  // A member id with no users row (deleted) counts as non-active.
  return !userRows.some((u) => u.status === 'active')
}

interface StuckTaskFinding extends LifecycleAlertFinding {
  rule: StuckRule
}

async function checkOne(
  db: DbClient,
  c: StuckCandidate,
  now: number,
  stuckThresholdMs: number,
  pendingThresholdMs: number,
): Promise<StuckTaskFinding[]> {
  const out: StuckTaskFinding[] = []

  if (c.status === 'pending') {
    // S4: pending too long. No freshness gate (pending tasks emit no
    // events; the gate would never trigger).
    const pendingForMs = now - c.startedAt
    if (pendingForMs > pendingThresholdMs) {
      out.push({
        taskId: c.taskId,
        rule: 'S4',
        detail: {
          rule: 'S4',
          message: 'task pending too long without scheduler pickup',
          pendingForMs,
          thresholdMs: pendingThresholdMs,
        },
      })
    }
    return out
  }

  // RFC-108 T14 (AR-06) — S6 member-deadlock. Independent of the freshness gate:
  // an awaiting_* task with no active member to answer is deadlocked the moment
  // it parks, regardless of recent activity. Emitted alongside any S1/S2 finding
  // (different concern). reconcileLifecycleAlerts dedups to one open S6 per task.
  if (c.status === 'awaiting_review' || c.status === 'awaiting_human') {
    if (await taskHasNoActiveMember(db, c)) {
      out.push({
        taskId: c.taskId,
        rule: 'S6',
        detail: {
          rule: 'S6',
          message: 'awaiting task has no active member to answer the review/clarify',
          status: c.status,
        },
      })
    }
  }

  // S1/S2/S3 share the freshness gate: only flag tasks that have gone
  // quiet for `stuckThresholdMs`.
  const latestEventTs = await latestEventTsForTask(db, c.taskId)
  const lastActivityTs = latestEventTs ?? c.startedAt
  const inactiveForMs = now - lastActivityTs
  if (inactiveForMs <= stuckThresholdMs) return out // still active

  // RFC-164 (设计门 Finding-2): workgroup tasks park awaiting_review with a
  // gate holder run and NO doc_version, and park awaiting_human on
  // leader-idle / clarify / delivery — all by design, engine-owned. S1/S2's
  // review/clarify heuristics would permanently misfire; S3/S4/S5 still apply.
  if (c.workgroupId !== null && (c.status === 'awaiting_review' || c.status === 'awaiting_human')) {
    return out
  }

  if (c.status === 'awaiting_review') {
    const hasPending = await hasPendingDocVersion(db, c.taskId)
    if (!hasPending) {
      const hint = await findRepairHint(db, c.taskId, 'review-awaiting')
      out.push({
        taskId: c.taskId,
        rule: 'S1',
        detail: {
          rule: 'S1',
          message: 'task awaiting_review with no pending doc_version',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
          ...(hint ? { repairHint: hint } : {}),
        },
      })
    }
  } else if (c.status === 'awaiting_human') {
    const hasOpen = await hasOpenClarifySession(db, c.taskId)
    // RFC-120 T9 (model A): a deferred-dispatch task parks awaiting_human on
    // undispatched designer task_questions, NOT an open clarify_session (the cross
    // round is already `answered`). That park is legitimate — not stuck. (Self-gated
    // on the deferred flag → always false for non-deferred tasks, so S2 fires as
    // before for them.)
    const hasUndispatchedDesigner = await hasUndispatchedDesignerQuestions(db, c.taskId)
    if (!hasOpen && !hasUndispatchedDesigner) {
      const hint = await findRepairHint(db, c.taskId, 'clarify-awaiting')
      out.push({
        taskId: c.taskId,
        rule: 'S2',
        detail: {
          rule: 'S2',
          message: 'task awaiting_human with no open clarify_session',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
          ...(hint ? { repairHint: hint } : {}),
        },
      })
    }
  } else if (c.status === 'running') {
    const counts = await nodeRunCounts(db, c.taskId)
    // "All node_runs terminal" = no active rows AND at least one row exists
    // (an empty node_runs table for a running task is also wedge-y but
    // belongs to a different layer — scheduler bootstrap — so we require
    // counts.total > 0 here to be conservative).
    if (counts.total > 0 && counts.active === 0) {
      const hint = await findRepairHint(db, c.taskId, 'terminal-non-done')
      out.push({
        taskId: c.taskId,
        rule: 'S3',
        detail: {
          rule: 'S3',
          message: 'task running but every node_run is terminal',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
          totalRuns: counts.total,
          terminalRuns: counts.terminal,
          ...(hint ? { repairHint: hint } : {}),
        },
      })
    } else if (counts.active > 0) {
      // S5 (RFC-098 WP-8, audit S-15): the else half of S3 that used to be a
      // blind spot — active run(s) exist but events stopped landing past the
      // threshold (the freshness gate above already established that). The
      // opencode child is wedged (e.g. ignoring SIGTERM, hung MCP) or died
      // without the runner settling the row. detail carries per-run
      // {nodeRunId,nodeId,pid,lastEventTs} so the operator can inspect /
      // kill the pid; cancel/resume run the RFC-098 kill-then-proceed path.
      const activeRuns: Array<{
        nodeRunId: string
        nodeId: string
        pid: number | null
        lastEventTs: number | null
      }> = []
      for (const r of counts.activeRows) {
        activeRuns.push({
          nodeRunId: r.id,
          nodeId: r.nodeId,
          pid: r.pid,
          lastEventTs: await latestEventTsForRun(db, r.id),
        })
      }
      out.push({
        taskId: c.taskId,
        rule: 'S5',
        detail: {
          rule: 'S5',
          message: 'task running with active node_run(s) but events stopped landing',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
          activeRuns,
        },
      })
    }
  }
  return out
}

// RFC-057: pick the most-recent review or clarify node_run that fits the
// requested shape so the Diagnose Panel can prepopulate the repair option
// preview. Best-effort: returns `null` when no candidate is found.
async function findRepairHint(
  db: DbClient,
  taskId: string,
  mode: 'review-awaiting' | 'clarify-awaiting' | 'terminal-non-done',
): Promise<{ kind: 'review' | 'clarify'; nodeRunId: string } | null> {
  const snapRows = await db
    .select({ snap: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  if (snapRows.length === 0) return null
  let nodes: Array<{ id?: string; kind?: string }> = []
  try {
    const parsed = JSON.parse(snapRows[0]!.snap) as { nodes?: unknown }
    if (Array.isArray(parsed?.nodes)) nodes = parsed.nodes as typeof nodes
  } catch {
    return null
  }
  const reviewIds = new Set<string>()
  const clarifyIds = new Set<string>()
  for (const n of nodes) {
    if (typeof n?.id !== 'string' || typeof n?.kind !== 'string') continue
    if (n.kind === 'review') reviewIds.add(n.id)
    // RFC-146 (design D7): the awaiting-human clarify family here is exactly
    // the settles-without-row family — both mean "parks on a human session,
    // no per-attempt row of its own". Derive from the behavior table.
    if (nodeKindSettlesWithoutRow(n.kind)) clarifyIds.add(n.id)
  }
  if (reviewIds.size === 0 && clarifyIds.size === 0) return null

  if (mode === 'review-awaiting' && reviewIds.size > 0) {
    const rows = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.status, 'awaiting_review'),
          inArray(nodeRuns.nodeId, [...reviewIds]),
        ),
      )
      .limit(1)
    if (rows.length > 0) return { kind: 'review', nodeRunId: rows[0]!.id }
  }
  if (mode === 'clarify-awaiting' && clarifyIds.size > 0) {
    const rows = await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.status, 'awaiting_human'),
          inArray(nodeRuns.nodeId, [...clarifyIds]),
        ),
      )
      .limit(1)
    if (rows.length > 0) return { kind: 'clarify', nodeRunId: rows[0]!.id }
  }
  if (mode === 'terminal-non-done') {
    const targetSet = new Set<string>([...reviewIds, ...clarifyIds])
    if (targetSet.size === 0) return null
    const rows = await db
      .select({ id: nodeRuns.id, nodeId: nodeRuns.nodeId, status: nodeRuns.status })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          inArray(nodeRuns.status, ['failed', 'canceled', 'interrupted', 'exhausted']),
          inArray(nodeRuns.nodeId, [...targetSet]),
        ),
      )
    if (rows.length === 0) return null
    const row = rows.find((r) => reviewIds.has(r.nodeId)) ?? rows[0]!
    return {
      kind: reviewIds.has(row.nodeId) ? 'review' : 'clarify',
      nodeRunId: row.id,
    }
  }
  return null
}

export async function runStuckTaskDetector(
  args: RunStuckTaskDetectorArgs,
): Promise<RunStuckTaskDetectorResult> {
  const now = (args.now ?? Date.now)()
  const stuckMs = args.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
  const pendingMs = args.pendingThresholdMs ?? DEFAULT_PENDING_THRESHOLD_MS
  const candidates = await loadCandidates(args.db, args.taskIdFilter)
  if (candidates.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }
  const findings: StuckTaskFinding[] = []
  for (const c of candidates) {
    findings.push(...(await checkOne(args.db, c, now, stuckMs, pendingMs)))
  }
  const reconciled = await reconcileLifecycleAlerts({
    db: args.db,
    taskIds: candidates.map((c) => c.taskId),
    findings,
    now,
    ownedRules: STUCK_RULES,
    onAlert: args.onAlert,
  })
  log.info('scan complete', {
    scanned: candidates.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  if (reconciled.promotedAlerts > 0 || reconciled.openAlerts.some((a) => a.severity === 'error')) {
    log.error('stuck tasks detected', {
      open: reconciled.openAlerts.length,
      errorCount: reconciled.openAlerts.filter((a) => a.severity === 'error').length,
    })
  }
  return { scanned: candidates.length, ...reconciled }
}

/**
 * Run every `intervalMs` (default 5 min). No boot delay separate from
 * the lifecycle invariants ticker — stuck detection can wait the full
 * first interval since the freshness gate already requires
 * `> stuckThresholdMs` of inactivity, and any historic stuck task will
 * still show up on the second tick.
 */
export function startStuckTaskDetectorLoop(opts: {
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  intervalMs?: number
}): { stop: () => void } {
  const interval = opts.intervalMs ?? 5 * MIN_MS
  let running = false
  const safeRun = (): void => {
    if (running) return
    running = true
    void runStuckTaskDetector({ db: opts.db, onAlert: opts.onAlert })
      .catch((err: unknown) => {
        log.error('scan failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
      })
  }
  const handle = setInterval(safeRun, interval)
  return { stop: () => clearInterval(handle) }
}
