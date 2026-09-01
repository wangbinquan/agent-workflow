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
import type { ChildTaskBudgetQueries } from '@/modules/task-execution/application/ports/childTaskBudgetQueries'
import { SqliteChildTaskBudgetQueries } from '@/modules/task-execution/infrastructure/sqliteChildTaskBudgetQueries'
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

type LegacySqliteChildBudgetSource = ConstructorParameters<typeof SqliteChildTaskBudgetQueries>[0]

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
  return 'listCountedChildTaskIds' in source ? source : new SqliteChildTaskBudgetQueries(source)
}

export class ChildTaskBudget {
  /** taskIds currently holding a unit (child tasks in pending/running). */
  private counted = new Set<string>()
  /** Pre-insert reservations (no task id yet). Never ancestor-exempt. */
  private held = new Set<symbol>()
  private waiters: Waiter[] = []
  private warnTimer: ReturnType<typeof setInterval> | null = null

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

/**
 * daemon 级的实时容量。RFC-287 T10（G4-C9）修复：**不能让容量凝固在第一个调用者
 * 的闭包里**。原实现只在 singleton 为 null 时用调用方传来的 `capacity()`，之后
 * 无论配置怎么改、后续任务传什么，读到的永远是**首个**启动任务捕获的 opts；于是
 * 「设置页把同时活跃子任务数从 8 调到 2」在 daemon 重启前根本不生效。
 *
 * 现在容量是一个模块级的 live 值：`setChildTaskBudgetCapacity` 由 PUT /api/config
 * 推入（与三个节点池的热应用同一个线性化点），任务启动只在**尚未有值时**播种。
 */
let liveCapacity: number | null = null

/** PUT /api/config 的热应用入口（与 resizeAllNodePools 同处调用）。 */
export function setChildTaskBudgetCapacity(capacity: number): void {
  liveCapacity = capacity
  // 改完必须立刻重扫等待队列——只改变量的话，调大上限对**已排队**的 waiter 无效，
  // 它们要等某个子任务恰好发生生命周期变化才被顺带放行，而这期间新来的调用反而
  // 能直接抢走空出来的名额（T14 实现门）。调小时 scan 不会放行任何人，无副作用，
  // 所以不必区分方向。
  singleton?.onCapacityChanged()
}

/** 单例当前绑定的 provider query identity——换 provider 时必须重建。 */
let singletonSource: object | null = null

export async function ensureChildTaskBudget(
  source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
  capacity: () => number,
): Promise<ChildTaskBudget> {
  // 冷启动播种：daemon 起来后第一个走到这里的任务用自己的 opts 定初值；之后一律
  // 以 live 值为准（配置改动经 setChildTaskBudgetCapacity 落进来）。
  if (liveCapacity === null) liveCapacity = capacity()
  // 换了 DbClient 就必须重建：单例的 `counted` 集合是从**某一个库**重建出来的，
  // 拿着它去服务另一个库等于用甲的在跑数去限乙的并发。生产里 daemon 只有一个库，
  // 但并行用不同库的测试会静默串扰——那种串扰表现为「另一个用例的配额莫名其妙
  // 变了」，极难定位。（T14 实现门 P2。）
  if (singleton !== null && singletonSource !== source) singleton = null
  if (singleton === null) {
    singleton = new ChildTaskBudget(childBudgetQueries(source), () => liveCapacity ?? capacity())
    singletonSource = source
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
  singletonSource = null
  liveCapacity = null
  childness.clear()
}

/**
 * Lifecycle emission hook (called next to notifyTaskTerminal). Cheap no-op
 * until the budget singleton exists; unknown tasks are resolved through the
 * childness cache and, when unknown, a single lazy DB read.
 */
export function notifyChildBudgetTaskStatus(
  source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
  taskId: string,
  to: TaskStatus,
): void {
  const budget = singleton
  if (budget === null) return
  const known = childness.get(taskId)
  if (known === false) return
  if (known === true) {
    budget.onChildTaskStatus(taskId, to)
    return
  }
  void childBudgetQueries(source)
    .isChildTask(taskId)
    .then((isChild) => {
      childness.set(taskId, isChild)
      if (isChild) budget.onChildTaskStatus(taskId, to)
    })
    .catch(() => {
      // transient read failure — the next transition (or poll) re-resolves
    })
}

/**
 * RFC-287 G4 / C9 —— **调用链最大深度**的即时生效值。
 *
 * 为什么不能读 `opts.maxInvocationDepth`（五轮门终局对账实测）：`opts` 在 `runTask`
 * 一次性冻结，且该键在 `INHERITABLE_RUN_CONFIG_KEYS` 里 ⇒ 子任务继承根任务启动那一刻
 * 的旧值。实效是「下次**根任务**启动才生效」——而这恰恰是 design §10.9 明文作废的那条
 * 退路，UI 文案还写着「保存后立即生效」，属于「改了不生效的设置项比没有更误导」。
 * 与旁边三个池 + 子任务配额同一个线性化点（`routes/config.ts` 的保存处）热应用。
 */
let liveMaxInvocationDepth: number | null = null

/** 保存设置时热应用（`routes/config.ts` 与三个池、子任务配额同一处调用）。 */
export function setMaxInvocationDepth(v: number): void {
  liveMaxInvocationDepth = v
}

/**
 * 深度判据的**唯一**读点。`frozen` 是调用方冻结的那份（保留它只为让未注入热值的
 * 测试/内联路径逐字保持旧行为）；一旦保存过设置，热值优先。
 */
export function currentMaxInvocationDepth(frozen: number | undefined): number {
  return liveMaxInvocationDepth ?? frozen ?? 3
}
