// RFC-242 §3.2 — the daemon-wide active-child-task budget.
//
// Counting口径: child tasks (parent_task_id non-null) in {pending, running}
// hold one unit each. awaiting_review / awaiting_human / interrupted hold
// NOTHING (human gates and crashes must not starve other trees); a resume back
// to running re-counts WITHOUT re-queuing (burst over the cap is the accepted
// trade-off, documented in design §3.2).
//
// Grant rule (design-gate P0-1 fix — the original FIFO queue head-blocked):
// a request is grantable when `held + |counted ∖ ancestors(requester)| < cap`.
// Every bookkeeping change SCANS THE WHOLE WAIT SET and grants EVERY request
// that is grantable at that moment (FIFO order only breaks ties between
// simultaneously-grantable waiters — it never blocks a grantable request
// behind an ungrantable head). Ancestor exemption makes this deadlock-free: a
// waiter only ever waits on units held by non-ancestors, and a non-ancestor
// unit can always terminate independently. Known residual: deep trees can
// starve shallow waiters (>60s waits are logged; priority aging is a
// registered follow-up, not v1).
//
// Bookkeeping is driven from the lifecycle write path (notifyChildBudgetTaskStatus,
// wired next to the RFC-242 executionWatch emission) plus explicit pre-insert
// holds around the launch window. Boot/lazy init rebuilds the counted set from
// the DB so restarts cannot leak or double-count units.
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { createLogger } from '@/util/log'
import type { TaskStatus } from '@agent-workflow/shared'

const log = createLogger('child-budget')

const COUNTED_STATUSES: readonly TaskStatus[] = ['pending', 'running']
const LONG_WAIT_WARN_MS = 60_000

export type ChildSlotHold = {
  /** Transfer the pre-insert hold onto the inserted child task id. */
  bind(taskId: string): void
  /** Drop the hold without a task row (launch failed before insert). */
  release(): void
}

type Waiter = {
  ancestors: ReadonlySet<string>
  resolve: (hold: ChildSlotHold) => void
  reject: (err: Error) => void
  enqueuedAt: number
  warned: boolean
  signal?: AbortSignal
  onAbort?: () => void
}

export class ChildTaskBudget {
  /** taskIds currently holding a unit (child tasks in pending/running). */
  private counted = new Set<string>()
  /** Pre-insert reservations (no task id yet). Never ancestor-exempt. */
  private held = new Set<symbol>()
  private waiters: Waiter[] = []
  private warnTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly db: DbClient,
    private readonly capacity: () => number,
  ) {}

  /** Rebuild the counted set from the DB (boot / lazy init after restart). */
  async rebuildFromDb(): Promise<void> {
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(isNotNull(tasks.parentTaskId), inArray(tasks.status, COUNTED_STATUSES as TaskStatus[])),
      )
    this.counted = new Set(rows.map((r) => r.id))
    this.scan()
  }

  activeCount(): number {
    return this.counted.size + this.held.size
  }

  private effectiveFor(ancestors: ReadonlySet<string>): number {
    let n = this.held.size
    for (const id of this.counted) if (!ancestors.has(id)) n += 1
    return n
  }

  /**
   * Reserve one unit for a child launch by a call node whose task's ancestor
   * chain (task ids, requester's own task included) is `ancestors`. Resolves
   * immediately when grantable, otherwise waits for a bookkeeping change.
   */
  acquire(
    ancestors: readonly string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<ChildSlotHold> {
    const ancestorSet = new Set(ancestors)
    if (this.effectiveFor(ancestorSet) < this.capacity()) {
      return Promise.resolve(this.mintHold())
    }
    if (opts.signal?.aborted === true) {
      return Promise.reject(abortError())
    }
    return new Promise<ChildSlotHold>((resolve, reject) => {
      const waiter: Waiter = {
        ancestors: ancestorSet,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        warned: false,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      }
      if (opts.signal !== undefined) {
        const onAbort = (): void => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) this.waiters.splice(i, 1)
          this.stopWarnTimerIfIdle()
          reject(abortError())
        }
        waiter.onAbort = onAbort
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.ensureWarnTimer()
    })
  }

  private mintHold(): ChildSlotHold {
    const token = Symbol('child-slot')
    this.held.add(token)
    let settled = false
    return {
      bind: (taskId: string): void => {
        if (settled) return
        settled = true
        this.held.delete(token)
        // The status-transition observer will add the same id idempotently.
        this.counted.add(taskId)
        // binding never frees capacity (1 unit → 1 unit); no scan needed.
      },
      release: (): void => {
        if (settled) return
        settled = true
        this.held.delete(token)
        this.scan()
      },
    }
  }

  /**
   * Lifecycle observation — `taskId` (a KNOWN child task) moved to `to`.
   * Idempotent: set semantics absorb duplicate notifications.
   */
  onChildTaskStatus(taskId: string, to: TaskStatus): void {
    if ((COUNTED_STATUSES as readonly string[]).includes(to)) {
      this.counted.add(taskId)
      return // capacity shrank or held steady — nothing to grant
    }
    if (this.counted.delete(taskId)) this.scan()
  }

  /** Grant every currently-grantable waiter (FIFO among grantable only). */
  private scan(): void {
    if (this.waiters.length === 0) {
      this.stopWarnTimerIfIdle()
      return
    }
    let i = 0
    while (i < this.waiters.length) {
      const w = this.waiters[i]!
      if (this.effectiveFor(w.ancestors) < this.capacity()) {
        this.waiters.splice(i, 1)
        if (w.signal !== undefined && w.onAbort !== undefined) {
          w.signal.removeEventListener('abort', w.onAbort)
        }
        w.resolve(this.mintHold())
        // restart from the head: the mint changed `held`, re-evaluate everyone.
        i = 0
        continue
      }
      i += 1
    }
    this.stopWarnTimerIfIdle()
  }

  private ensureWarnTimer(): void {
    if (this.warnTimer !== null) return
    this.warnTimer = setInterval(() => {
      const now = Date.now()
      for (const w of this.waiters) {
        if (!w.warned && now - w.enqueuedAt >= LONG_WAIT_WARN_MS) {
          w.warned = true
          log.warn('child-task slot wait exceeded 60s', {
            waiters: this.waiters.length,
            active: this.activeCount(),
            capacity: this.capacity(),
          })
        }
      }
    }, LONG_WAIT_WARN_MS / 4)
  }

  private stopWarnTimerIfIdle(): void {
    if (this.waiters.length === 0 && this.warnTimer !== null) {
      clearInterval(this.warnTimer)
      this.warnTimer = null
    }
  }
}

function abortError(): Error {
  return new Error('child-slot acquisition aborted')
}

// ---------------------------------------------------------------------------
// Daemon singleton — lazily initialized by the first consumer (PR-3 call
// nodes); the lifecycle emission below no-ops until then, so tasks that never
// use call nodes pay zero bookkeeping cost.
// ---------------------------------------------------------------------------

let singleton: ChildTaskBudget | null = null
/** Cache: taskId → is a child task (avoids a DB read per status transition). */
const childness = new Map<string, boolean>()

export async function ensureChildTaskBudget(
  db: DbClient,
  capacity: () => number,
): Promise<ChildTaskBudget> {
  if (singleton === null) {
    singleton = new ChildTaskBudget(db, capacity)
    await singleton.rebuildFromDb()
  }
  return singleton
}

/** Register a freshly-inserted child task so transitions need no DB read. */
export function registerKnownChildTask(taskId: string): void {
  childness.set(taskId, true)
}

/** Test-only: drop the singleton + childness cache. */
export function resetChildTaskBudgetForTests(): void {
  singleton = null
  childness.clear()
}

/**
 * Lifecycle emission hook (called next to notifyTaskTerminal). Cheap no-op
 * until the budget singleton exists; unknown tasks are resolved through the
 * childness cache and, when unknown, a single lazy DB read.
 */
export function notifyChildBudgetTaskStatus(db: DbClient, taskId: string, to: TaskStatus): void {
  const budget = singleton
  if (budget === null) return
  const known = childness.get(taskId)
  if (known === false) return
  if (known === true) {
    budget.onChildTaskStatus(taskId, to)
    return
  }
  void db
    .select({ parentTaskId: tasks.parentTaskId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
    .then((rows) => {
      const isChild = rows[0]?.parentTaskId != null
      childness.set(taskId, isChild)
      if (isChild) budget.onChildTaskStatus(taskId, to)
    })
    .catch(() => {
      // transient read failure — the next transition (or poll) re-resolves
    })
}
