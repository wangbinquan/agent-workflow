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

import {
  TERMINAL_NODE_RUN_STATUSES as SHARED_TERMINAL_NODE_RUN_STATUSES,
  TERMINAL_TASK_STATUSES as SHARED_TERMINAL_TASK_STATUSES,
  nodeKindSettlesWithoutRow,
  taskWorkspacePhase,
  type TaskWorkspacePhase,
} from '@agent-workflow/shared'
import { isWorkgroupTask } from '@agent-workflow/shared'
import type {
  TaskRecoveryOperations,
  TaskRecoveryStuckRunSnapshot,
} from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { createLogger } from '@/util/log'

import { DAEMON_CADENCE } from '@/services/daemonCadence'

const log = createLogger('lifecycle.stuck')

const MIN_MS = 60_000
const ALERT_PROMOTION_MS = 24 * 60 * MIN_MS
const STUCK_RULES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const
type StuckRule = (typeof STUCK_RULES)[number]

interface LifecycleAlertFinding {
  taskId: string
  rule: StuckRule
  detail: Record<string, unknown>
}

export interface StuckTaskLifecycleAlertRow {
  id: string
  taskId: string
  rule: StuckRule
  severity: 'warning' | 'error'
  detail: Record<string, unknown>
  detectedAt: number
  resolvedAt: number | null
}

type LifecycleAlertRow = StuckTaskLifecycleAlertRow

function logOpenAlertSummary(
  openAlerts: readonly LifecycleAlertRow[],
  statusByTask: ReadonlyMap<string, string>,
  promotedThisScan: number,
  stateChanged: boolean,
): void {
  if (!stateChanged) return
  const byRule: Record<string, number> = {}
  let errorCount = 0
  let liveErrorCount = 0
  const terminal = new Set<string>(SHARED_TERMINAL_TASK_STATUSES)
  for (const alert of openAlerts) {
    byRule[alert.rule] = (byRule[alert.rule] ?? 0) + 1
    if (alert.severity !== 'error') continue
    errorCount += 1
    const status = statusByTask.get(alert.taskId)
    if (status === undefined || !terminal.has(status)) liveErrorCount += 1
  }
  if (liveErrorCount > 0) {
    log.error('stuck tasks detected', {
      open: openAlerts.length,
      errorCount,
      liveErrorCount,
      promotedThisScan,
      byRule,
    })
  } else if (errorCount > 0) {
    log.warn('stuck tasks: historic findings on terminal tasks (benign)', {
      open: openAlerts.length,
      errorCount,
      byRule,
      hint: 'all on terminal tasks (done/failed/canceled/interrupted) — delete or repair via the Diagnose panel to clear',
    })
  }
}

/** Default freshness threshold for S1/S2/S3 — 30 minutes. */
export const DEFAULT_STUCK_THRESHOLD_MS = 30 * MIN_MS
/** Default S4 threshold — 5 minutes; pending tasks should be picked up
 *  by the scheduler in ms, not minutes. */
export const DEFAULT_PENDING_THRESHOLD_MS = 5 * MIN_MS
/** RFC-284 T22（决策 D11）：子任务（parent_task_id 非空）pending 常因 childBudget
 *  预算排队属合法长等（>60s 已有日志），5min 阈值必然误报噪音 → 提高到 30min；
 *  顶层任务维持 5min 不变。 */
/** RFC-287 G7：仓库准备（冷克隆 + G6 窗口）可以合法跑很久，别当卡死。 */
const DEFAULT_REPO_PREP_PENDING_THRESHOLD_MS = 45 * 60_000
export const DEFAULT_CHILD_PENDING_THRESHOLD_MS = 30 * MIN_MS

export interface RunStuckTaskDetectorArgs {
  operations: TaskRecoveryOperations
  /** Override Date.now() — used by tests. */
  now?: () => number
  /** Default 30 minutes; overridable for tests. */
  stuckThresholdMs?: number
  /** Default 5 minutes; overridable for tests. */
  pendingThresholdMs?: number
  /** Receives newly-detected / promoted alerts; wired in cli/start.ts. */
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  onResolved?: (taskId: string) => void
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
  /** RFC-284 T22（D11）：非空 = call 子任务，S4 用更高阈值 + childBudget 提示。 */
  parentTaskId: string | null
  status: string
  startedAt: number
  /**
   * RFC-287 G7：判「是不是正卡在仓库准备第 0 步」用（见 S4 的豁免）。
   * RFC-317 T50（LC-05）—— 由携带两个原始列改为携带**判定结果**：判据是 shared 的
   * `taskWorkspacePhase`，三个调用点共用。带结果而不是带原料，杜绝了「拿到列却按
   * 自己那套判」的复发路径。
   */
  workspacePhase: TaskWorkspacePhase
  ownerUserId: string | null
  /** RFC-164: non-null = workgroup task (S1/S2 exempt — engine-owned parking). */
  workgroupId: string | null
  latestEventTs: number | null
  hasPendingDocVersion: boolean
  hasOpenClarifySession: boolean
  hasUndispatchedDesignerQuestions: boolean
  hasNoActiveHumanMember: boolean
  workflowSnapshot: string
  runs: readonly TaskRecoveryStuckRunSnapshot[]
}

async function loadCandidates(
  operations: TaskRecoveryOperations,
  filter?: readonly string[],
): Promise<StuckCandidate[]> {
  const rows = await operations.loadStuckTaskSnapshots(filter)
  return rows.map((row) => ({
    taskId: row.taskId,
    status: row.status,
    startedAt: row.startedAt,
    parentTaskId: row.parentTaskId,
    workspacePhase: taskWorkspacePhase({
      worktreePath: row.worktreePath,
      workspacePruningAt: row.workspacePruningAt,
      workspacePrunedAt: row.workspacePrunedAt,
      hasRepoPrepRow: row.hasRepoPrepRow,
    }),
    ownerUserId: row.ownerUserId,
    workgroupId: row.workgroupId,
    latestEventTs: row.latestEventTs,
    hasPendingDocVersion: row.hasPendingDocVersion,
    hasOpenClarifySession: row.hasOpenClarifySession,
    hasUndispatchedDesignerQuestions: row.hasUndispatchedDesignerQuestions,
    hasNoActiveHumanMember: row.hasNoActiveHumanMember,
    workflowSnapshot: row.workflowSnapshot,
    runs: row.runs,
  }))
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
  activeRows: TaskRecoveryStuckRunSnapshot[]
}

/** RFC-243 §4.1 — is a call row's child task legitimately quiet? True when the
 *  child sits on a human gate (awaiting_*) or its own events are fresh. A
 *  missing / terminal-but-unfinalized child is NOT healthy — the call row's
 *  silence is then a real signal. */
export function childDelegationIsHealthy(
  child: TaskRecoveryStuckRunSnapshot['child'],
  now: number,
  stuckThresholdMs: number,
): boolean {
  if (child === null) return false
  if (child.status === 'awaiting_review' || child.status === 'awaiting_human') return true
  const lastActivity = child.lastEventTs ?? child.startedAt
  return now - lastActivity <= stuckThresholdMs
}

function nodeRunCounts(rows: readonly TaskRecoveryStuckRunSnapshot[]): NodeRunCounts {
  let terminal = 0
  const activeRows: NodeRunCounts['activeRows'] = []
  for (const r of rows) {
    if (TERMINAL_NODE_RUN_SET.has(r.status)) terminal++
    else activeRows.push(r)
  }
  return { total: rows.length, terminal, active: activeRows.length, activeRows }
}

interface StuckTaskFinding extends LifecycleAlertFinding {
  rule: StuckRule
}

async function checkOne(
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
    // D11：子任务在 childBudget 预算下排队是合法长等 → 更高阈值 + 提示；
    // 顶层任务维持调用方传入的阈值。
    // RFC-287 G7：**仓库准备**期间任务合法地待在 pending —— 冷克隆一个大仓可以跑满
    // `gitCloneTimeoutMs`（默认 30min），G6 的窗口重试还叠在上面。默认 5 分钟阈值必然
    // 触发，且 S4 的文案「without scheduler pickup」与事实完全相反：调度器早就认领了，
    // 正在跑第 0 步。同一文件已为 RFC-284 的子任务排队开过同款豁免（D11），这里补上
    // 准备窗口这一类。RFC-317 T50（LC-05）—— 判据现在**真的**三处同源：共用 shared 的
    // `taskWorkspacePhase`。此前这句注释是错的：那时这里少判 `workspacePruningAt` 与
    // 「确有 __repo_prep__ 行」两条，对存量物化失败行会错误地静音 S4 告警 45 分钟。
    const preparingRepo = c.workspacePhase === 'preparing'
    const effectiveThresholdMs = preparingRepo
      ? Math.max(pendingThresholdMs, DEFAULT_REPO_PREP_PENDING_THRESHOLD_MS)
      : c.parentTaskId === null
        ? pendingThresholdMs
        : Math.max(pendingThresholdMs, DEFAULT_CHILD_PENDING_THRESHOLD_MS)
    if (pendingForMs > effectiveThresholdMs) {
      out.push({
        taskId: c.taskId,
        rule: 'S4',
        detail: {
          rule: 'S4',
          message: preparingRepo
            ? 'task pending too long while preparing its repository (clone/fetch may still be running)'
            : 'task pending too long without scheduler pickup',
          pendingForMs,
          thresholdMs: effectiveThresholdMs,
          ...(preparingRepo
            ? {
                repoPrepWaitHint:
                  'repository preparation (G7 step 0) is in progress — a large cold clone can legitimately run for many minutes',
              }
            : {}),
          ...(c.parentTaskId === null
            ? {}
            : {
                childBudgetWaitHint:
                  'child task of a call node — long pending may be legitimate childBudget queueing, not a stall',
              }),
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
    if (c.hasNoActiveHumanMember) {
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
  const lastActivityTs = c.latestEventTs ?? c.startedAt
  const inactiveForMs = now - lastActivityTs
  if (inactiveForMs <= stuckThresholdMs) return out // still active

  // RFC-164 (设计门 Finding-2): workgroup tasks park awaiting_review with a
  // gate holder run and NO doc_version, and park awaiting_human on
  // leader-idle / clarify / delivery — all by design, engine-owned. S1/S2's
  // review/clarify heuristics would permanently misfire; S3/S4/S5 still apply.
  if (isWorkgroupTask(c) && (c.status === 'awaiting_review' || c.status === 'awaiting_human')) {
    return out
  }

  if (c.status === 'awaiting_review') {
    if (!c.hasPendingDocVersion) {
      const hint = findRepairHint(c, 'review-awaiting')
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
    // RFC-120 T9 (model A): a deferred-dispatch task parks awaiting_human on
    // undispatched designer task_questions, NOT an open clarify_session (the cross
    // round is already `answered`). That park is legitimate — not stuck. (Self-gated
    // on the deferred flag → always false for non-deferred tasks, so S2 fires as
    // before for them.)
    if (!c.hasOpenClarifySession && !c.hasUndispatchedDesignerQuestions) {
      const hint = findRepairHint(c, 'clarify-awaiting')
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
    const counts = nodeRunCounts(c.runs)
    // "All node_runs terminal" = no active rows AND at least one row exists
    // (an empty node_runs table for a running task is also wedge-y but
    // belongs to a different layer — scheduler bootstrap — so we require
    // counts.total > 0 here to be conservative).
    if (counts.total > 0 && counts.active === 0) {
      const hint = findRepairHint(c, 'terminal-non-done')
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
      //
      // RFC-243 §4.1 — S5 freshness delegation: a call row's silence is by
      // design (its work happens in the CHILD task). The row is quiet-but-fine
      // when its child is currently awaiting_* (legitimate multi-day human
      // gate) OR the child's own event stream is fresh. Only rows with no such
      // delegation left in the list can constitute an S5.
      const activeRuns: Array<{
        nodeRunId: string
        nodeId: string
        pid: number | null
        lastEventTs: number | null
      }> = []
      for (const r of counts.activeRows) {
        if (r.childTaskId !== null && childDelegationIsHealthy(r.child, now, stuckThresholdMs)) {
          continue
        }
        activeRuns.push({
          nodeRunId: r.id,
          nodeId: r.nodeId,
          pid: r.pid,
          lastEventTs: r.lastEventTs,
        })
      }
      if (activeRuns.length === 0) return out
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
function findRepairHint(
  candidate: StuckCandidate,
  mode: 'review-awaiting' | 'clarify-awaiting' | 'terminal-non-done',
): { kind: 'review' | 'clarify'; nodeRunId: string } | null {
  let nodes: Array<{ id?: string; kind?: string }> = []
  try {
    const parsed = JSON.parse(candidate.workflowSnapshot) as { nodes?: unknown }
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
    const row = candidate.runs.find(
      (run) => run.status === 'awaiting_review' && reviewIds.has(run.nodeId),
    )
    if (row !== undefined) return { kind: 'review', nodeRunId: row.id }
  }
  if (mode === 'clarify-awaiting' && clarifyIds.size > 0) {
    const row = candidate.runs.find(
      (run) => run.status === 'awaiting_human' && clarifyIds.has(run.nodeId),
    )
    if (row !== undefined) return { kind: 'clarify', nodeRunId: row.id }
  }
  if (mode === 'terminal-non-done') {
    const targetSet = new Set<string>([...reviewIds, ...clarifyIds])
    if (targetSet.size === 0) return null
    const terminalNonDoneStatuses = new Set(['failed', 'canceled', 'interrupted', 'exhausted'])
    const rows = candidate.runs.filter(
      (run) => terminalNonDoneStatuses.has(run.status) && targetSet.has(run.nodeId),
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
  const candidates = await loadCandidates(args.operations, args.taskIdFilter)
  if (candidates.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }
  const findings: StuckTaskFinding[] = []
  for (const c of candidates) {
    findings.push(...(await checkOne(c, now, stuckMs, pendingMs)))
  }
  const reconciled = await args.operations.reconcileStuckAlerts({
    taskIds: candidates.map((c) => c.taskId),
    findings,
    now,
    ownedRules: STUCK_RULES,
    promotionAfterMs: ALERT_PROMOTION_MS,
  })
  const openAlerts: LifecycleAlertRow[] = reconciled.openAlerts.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    rule: row.rule as StuckRule,
    severity: row.severity,
    detail: { ...row.detail },
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
  }))
  for (const transition of reconciled.transitions) {
    args.onAlert?.(
      {
        id: transition.row.id,
        taskId: transition.row.taskId,
        rule: transition.row.rule as StuckRule,
        severity: transition.row.severity,
        detail: { ...transition.row.detail },
        detectedAt: transition.row.detectedAt,
        resolvedAt: transition.row.resolvedAt,
      },
      transition.kind,
    )
  }
  for (const taskId of reconciled.resolvedTaskIds) args.onResolved?.(taskId)
  log.info('scan complete', {
    scanned: candidates.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  const statusByTask = new Map(candidates.map((c) => [c.taskId, c.status]))
  const stateChanged =
    reconciled.newAlerts > 0 || reconciled.promotedAlerts > 0 || reconciled.resolvedAlerts > 0
  logOpenAlertSummary(openAlerts, statusByTask, reconciled.promotedAlerts, stateChanged)
  return {
    scanned: candidates.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
    openAlerts,
  }
}

/**
 * Run every `intervalMs` (default 5 min). No boot delay separate from
 * the lifecycle invariants ticker — stuck detection can wait the full
 * first interval since the freshness gate already requires
 * `> stuckThresholdMs` of inactivity, and any historic stuck task will
 * still show up on the second tick.
 */
export function startStuckTaskDetectorLoop(opts: {
  operations: TaskRecoveryOperations
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  onResolved?: (taskId: string) => void
  intervalMs?: number
}): { stop: () => void } {
  const interval = opts.intervalMs ?? DAEMON_CADENCE.stuckTaskScan
  let running = false
  const safeRun = (): void => {
    if (running) return
    running = true
    void runStuckTaskDetector({
      operations: opts.operations,
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
  const handle = setInterval(safeRun, interval)
  return { stop: () => clearInterval(handle) }
}
