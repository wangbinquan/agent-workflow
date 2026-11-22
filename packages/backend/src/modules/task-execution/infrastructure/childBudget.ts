// RFC-243 §3.2 — the daemon-wide active-child-task budget.
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
// Bookkeeping is driven by the committed task-lifecycle consumer plus explicit
// pre-insert holds around the launch window. Boot/lazy init rebuilds the counted
// set from the DB so restarts cannot leak or double-count units.
import type { ChildTaskBudgetQueries } from '../application/ports/childTaskBudgetQueries'
import { DrizzleChildTaskBudgetQueries } from './childTaskBudgetQueries'
import { createLogger } from '@/util/log'
import { startInterval, type IntervalTimer } from '@/platform/background/intervalTimer'
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

type LegacySqliteChildBudgetSource = ConstructorParameters<typeof DrizzleChildTaskBudgetQueries>[0]

function childBudgetQueries(
  source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
): ChildTaskBudgetQueries {
  if (source === null) {
    return {
      async listCountedChildTaskIds() {
        throw new Error('child-budget-query-source-not-composed')
      },
      async isChildTask() {
        throw new Error('child-budget-query-source-not-composed')
      },
      async parentTaskId() {
        throw new Error('child-budget-query-source-not-composed')
      },
    }
  }
  return 'listCountedChildTaskIds' in source ? source : new DrizzleChildTaskBudgetQueries(source)
}

export class ChildTaskBudget {
  /** taskIds currently holding a unit (child tasks in pending/running). */
  private counted = new Set<string>()
  /** Pre-insert reservations (no task id yet). Never ancestor-exempt. */
  private held = new Set<symbol>()
  private waiters: Waiter[] = []
  private warnTimer: IntervalTimer | null = null

  private readonly queries: ChildTaskBudgetQueries

  constructor(
    source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
    private readonly capacity: () => number,
  ) {
    this.queries = childBudgetQueries(source)
  }

  /** Rebuild the counted set from the DB (boot / lazy init after restart). */
  async rebuildFromDb(): Promise<void> {
    this.counted = new Set(await this.queries.listCountedChildTaskIds())
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

  /**
   * 容量被外部改动后重扫等待队列。`scan` 是私有的，这是它唯一的对外触发口。
   *
   * 为什么必须有（T14 实现门）：`setChildTaskBudgetCapacity` 原先只改变量不重扫，
   * 于是「设置页把上限从 1 调到 2」对**已经排队**的 waiter 毫无作用——它得等某个
   * 子任务恰好发生生命周期变化才被顺带放行；而这期间**新来**的调用反而能直接拿到
   * 那个空出来的名额。等待者饿死、插队者得利，正好反了。
   */
  onCapacityChanged(): void {
    this.scan()
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
    this.warnTimer = startInterval({
      owner: 'task-execution.child-budget-wait-warning',
      everyMs: LONG_WAIT_WARN_MS / 4,
      tick: () => {
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
      },
    })
  }

  private stopWarnTimerIfIdle(): void {
    if (this.waiters.length === 0 && this.warnTimer !== null) {
      this.warnTimer.stop()
      this.warnTimer = null
    }
  }
}

function abortError(): Error {
  return new Error('child-slot acquisition aborted')
}

// ---------------------------------------------------------------------------
// RFC-533: the session's budget runtime. Each daemon session builds one when it composes Task Execution (next to its
// execution permit registry) and hands it to the child-call nodes through the run options; the session's lifecycle
// consumer and the settings hot apply call the same one. The budget itself is still built lazily by the first consumer
// (PR-3 call nodes) — status emission no-ops until then, so tasks that never use call nodes pay zero bookkeeping cost.
// ---------------------------------------------------------------------------

export interface ChildTaskBudgetLimits {
  readonly maxActiveChildTasks: number
  readonly maxInvocationDepth: number
}

export interface ChildTaskBudgetRuntime {
  /** The session's budget: seeded with the caller's capacity and rebuilt from the database on first use. */
  ensure(seedCapacity: () => number): Promise<ChildTaskBudget>
  /** Lifecycle emission (next to the execution watch); a no-op until the budget exists. */
  notifyStatus(taskId: string, to: TaskStatus): void
  /** Register a freshly-inserted child task so its transitions need no database read. */
  registerKnownChild(taskId: string): void
  /** Settings saved: the live capacity (re-scanning queued waiters) and the live call depth. */
  applyLimits(limits: ChildTaskBudgetLimits): void
  /**
   * RFC-287 G4 / C9 — the only read point of the call-depth judgment: once settings were saved the live value wins,
   * else the caller's frozen value, else 3.
   */
  maxInvocationDepth(frozen: number | undefined): number
}

export function createChildTaskBudgetRuntime(
  source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
): ChildTaskBudgetRuntime {
  const queries = childBudgetQueries(source)
  let budget: ChildTaskBudget | null = null
  /** Cache: taskId → is a child task (avoids a DB read per status transition). */
  const childness = new Map<string, boolean>()
  /**
   * The session's live capacity. RFC-287 T10 (G4-C9): the capacity must not freeze in the first caller's closure —
   * the settings hot apply pushes it (the same linearization point as the node pools); a task's start only seeds it
   * while it is still unset.
   */
  let liveCapacity: number | null = null
  /**
   * RFC-287 G4 / C9 — the live call depth. A task's `opts` freeze at `runTask` and children inherit the root's value,
   * so without a live value a saved depth would only apply from the next root task (which design §10.9 rules out and the
   * settings page says it does not). RFC-533: the hot apply pushes it again (lost since 2026-09-01).
   */
  let liveMaxInvocationDepth: number | null = null
  return Object.freeze({
    async ensure(seedCapacity: () => number): Promise<ChildTaskBudget> {
      // Cold-start seeding: the first task to get here sets the initial value; from then on the live value rules.
      if (liveCapacity === null) liveCapacity = seedCapacity()
      if (budget !== null) return budget
      // As before: the budget is visible to concurrent callers and to status emission while it rebuilds.
      const created = new ChildTaskBudget(queries, () => liveCapacity ?? seedCapacity())
      budget = created
      await created.rebuildFromDb()
      return created
    },
    notifyStatus(taskId: string, to: TaskStatus): void {
      const current = budget
      if (current === null) return
      const known = childness.get(taskId)
      if (known === false) return
      if (known === true) {
        current.onChildTaskStatus(taskId, to)
        return
      }
      void queries
        .isChildTask(taskId)
        .then((isChild) => {
          childness.set(taskId, isChild)
          if (isChild) current.onChildTaskStatus(taskId, to)
        })
        .catch(() => {
          // transient read failure — the next transition (or poll) re-resolves
        })
    },
    registerKnownChild(taskId: string): void {
      childness.set(taskId, true)
    },
    applyLimits(limits: ChildTaskBudgetLimits): void {
      liveCapacity = limits.maxActiveChildTasks
      liveMaxInvocationDepth = limits.maxInvocationDepth
      // Re-scan the wait set at once: changing only the value would leave already-queued waiters behind a raised cap
      // until some child happened to change state, while new callers could take the freed units (T14 gate). Lowering
      // grants nobody, so the direction does not matter.
      budget?.onCapacityChanged()
    },
    maxInvocationDepth(frozen: number | undefined): number {
      return liveMaxInvocationDepth ?? frozen ?? 3
    },
  })
}
