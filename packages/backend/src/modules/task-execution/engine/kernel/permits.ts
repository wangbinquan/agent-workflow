import { Semaphore } from '@/platform/contracts/semaphore'
import type {
  NodePoolKind,
  TaskExecutionPermitRegistry,
} from '../../application/ports/taskExecutionPermits'

/** One registry per daemon scope; no process-global mutable permit state. */
export function createExecutionPermitRegistry(): TaskExecutionPermitRegistry {
  // RFC-098 B1 (audit S-9 / WP-5) — the per-task WORKTREE WRITE LOCK registry.
  //
  // Before this module the scheduler's writer serialization lived in a
  // per-runTask local `new Semaphore(1)` (the task driver's writeSem) that HTTP
  // entry points could never reach — submitClarifyAnswers / review iterate /
  // cross-clarify answers all ran `rollbackToSnapshot` (reset --hard + clean
  // -fd) straight against the worktree while an in-flight writer node might be
  // mid-write (S-9: three ready-made backdoors through the "writers serialize"
  // guarantee). The registry gives every code path that mutates a task's
  // worktree THE SAME lock instance.
  //
  // Lifecycle (adversarial-review revision #1 — do NOT add other delete paths):
  // `gcTaskWriteSem` may be called ONLY from runTask's finally. An HTTP-side gc
  // would race the scheduler's cached reference (the task driver's writeSem holds
  // the instance for the whole run): delete + recreate while the scheduler
  // still holds the old instance silently splits the mutex back into two — the
  // exact S-9 pathology this module removes. A task that parked, got rolled
  // back over HTTP and never resumes leaks at most one idle Semaphore object;
  // accepted and documented.

  const locks = new Map<string, Semaphore>()

  /** The one write lock for a task's worktree(s). getOrCreate — never replaced
   *  while anyone may hold a reference (see module doc). */
  function getTaskWriteSem(taskId: string): Semaphore {
    let sem = locks.get(taskId)
    if (sem === undefined) {
      sem = new Semaphore(1)
      locks.set(taskId, sem)
    }
    return sem
  }

  // RFC-128 P5-BC §5.2.14 (final-gate, user-authorized) — the per-task QUESTION-WRITE lock.
  //
  // A SECOND, SHORT-LIVED per-task mutex, DISTINCT from getTaskWriteSem above. It serializes the
  // task's clarify-answer / cross-clarify-answer SUBMIT critical sections against dispatchTaskQuestions
  // so a deferred dispatch can never commit (stamp + mint a pending rerun) in the window between a
  // submit's stale dispatch-mode precheck and its destructive worktree rollback (which would clobber
  // the dispatched rerun) — nor double-mint a same-home rerun. EVERY holder does only fast DB ops (+ a
  // bounded git reset for the self rollback) and NEVER runs an opencode agent, so the lock is held
  // briefly and never blocks behind a multi-minute agent run.
  //
  // Why NOT reuse getTaskWriteSem: that lock is held by scheduler writer nodes for the ENTIRE agent
  // run (scheduler.ts:1962 → :2872). Making dispatch acquire it would hang the "下发" HTTP request
  // behind a running writer. The question-write lock is its own registry so dispatch never waits on an
  // agent run.
  //
  // LOCK ORDER (deadlock-free): the ONLY nesting is in submitClarifyAnswers, which holds the long
  // worktree sem (A = getTaskWriteSem, for the rollback's writer-protection, RFC-098 B1) OUTER and the
  // question-write lock (B = this) INNER → order A ≻ B. Every other holder takes exactly ONE: dispatch
  // + submitCrossClarifyAnswers take B only; scheduler writer nodes take A only. No path acquires A
  // while holding B, so there is no A→B / B→A cycle. A is acquired BEFORE B in the submit, so B is
  // never held while waiting for A → a B-waiter (dispatch) never blocks behind A's (agent-run) wait.
  const questionWriteLocks = new Map<string, Semaphore>()

  /** RFC-128 §5.2.14 — the per-task short-lived question-write lock (see module doc; lock order A ≻ B,
   *  separate registry from getTaskWriteSem). */
  function getTaskQuestionWriteSem(taskId: string): Semaphore {
    let sem = questionWriteLocks.get(taskId)
    if (sem === undefined) {
      sem = new Semaphore(1)
      questionWriteLocks.set(taskId, sem)
    }
    return sem
  }

  /**
   * Drop the registry entry when idle. ONLY runTask's finally may call this
   * (adversarial-review revision #1): if an HTTP rollback still holds/queues
   * the lock at that moment the entry survives and is reused by the next
   * getOrCreate — self-healing, never split-brain.
   */
  function gcTaskWriteSem(taskId: string): void {
    const sem = locks.get(taskId)
    if (sem !== undefined && sem.available === sem.capacity && sem.queueLength === 0) {
      locks.delete(taskId)
    }
    // RFC-128 §5.2.14 (3rd-gate finding P3): reclaim the question-write lock too, same idle guard +
    // self-healing semantics (if an HTTP submit/dispatch still holds/queues it, the entry survives and
    // is reused by the next getOrCreate — never split-brain). Without this the questionWriteLocks map
    // would grow without bound in a long-lived daemon (one idle Semaphore per distinct task id).
    const qSem = questionWriteLocks.get(taskId)
    if (qSem !== undefined && qSem.available === qSem.capacity && qSem.queueLength === 0) {
      questionWriteLocks.delete(taskId)
    }
  }

  /** Test-only visibility. */
  function taskWriteLockCount(): number {
    return locks.size
  }

  // Daemon-wide process-node concurrency budgets (RFC-266 起两池，RFC-269 起**三池**).
  //
  // A "process node" is any node kind that spawns a real child process and so
  // needs a slot. They are split across THREE pools that never queue behind each
  // other:
  //
  //   'agent'     — agent nodes, workgroup host nodes, fan-out shards + aggregators
  //   'script'    — RFC-253 script nodes
  //   'code-host' — RFC-269 code-host call nodes
  //
  // （RFC-287 五轮门修正：本段头注一直停在 RFC-266 的「two / TWO pools」且只列两项，
  //  而第三个池自 RFC-269 起就在了——`routes/config.ts` 的保存处三项一起热应用。
  //  过期头注会让接手者按两池推理并发上界。）
  //
  // Why split: a script node is usually a second-scale compute/format step, and
  // before RFC-266 it queued behind the same budget as multi-minute agent runs
  // (scheduler.ts — the script branch acquired the very same semaphore as the
  // agent branch), so 4 slow auditors stalled every script in the daemon. The
  // pools are FULLY independent, which is the deliberate trade the user chose:
  // peak child processes = maxConcurrentNodes + maxConcurrentScriptNodes.
  //
  // Nodes that take NO slot, by design: call-workflow / call-workgroup (the child
  // task's own nodes compete instead) and the RFC-130 merge agent (bypasses the
  // pool to avoid a writeSem↔pool cycle).
  //
  // One processConcurrencyScope belongs to one daemon. Keying by that object gives every task in
  // the daemon the same limiters while WeakMap keeps isolated test/embedded DBs
  // independent and collectible. Re-reading a changed setting RESIZES the same
  // object rather than replacing it — replacing would split the budget in two,
  // which is the whole reason this module exists. PUT /api/config resizes here on
  // save (routes/config.ts), so a settings change applies to running tasks and to
  // nodes already queued for a slot — not only to the next task launch.

  /** Which independent daemon pool a process node competes in. */

  const limiters = new WeakMap<object, Partial<Record<NodePoolKind, Semaphore>>>()

  /**
   * The daemon's limiter for one pool kind. get-or-create + resize-on-read: an
   * existing limiter is resized in place (never replaced) so active and newly
   * launched tasks can never split into separate budgets.
   */
  function getNodePoolSemaphore(
    daemonScope: object,
    kind: NodePoolKind,
    capacity: number,
    /**
     * RFC-287 T10（G4-C9）——「取」还是「取并改」。
     *
     * 默认 'set' 保留原语义（PUT /api/config 的热应用路径要它）。**任务启动必须传
     * 'seed-only'**：`runTask` 拿的是自己启动时捕获的 `opts`，而子任务会继承父任务
     * 的 opts；于是「配置改成 9 → 父任务在跑 → 它派生一个子任务」这条日常路径上，
     * 子任务的 runTask 会拿着旧值 4 把 daemon 级池**改回去**，用户在设置页做的调整
     * 被一个后台派生动作静默撤销，且没有任何日志。
     *
     * 'seed-only' = 池不存在时按该值创建（冷启动的合理种子），已存在则原样返回。
     * daemon 级配额的实时值只由配置写入点决定——这是本次修复的原则。
     */
    mode: 'set' | 'seed-only' = 'set',
  ): Semaphore {
    let byKind = limiters.get(daemonScope)
    if (byKind === undefined) {
      byKind = {}
      limiters.set(daemonScope, byKind)
    }
    const existing = byKind[kind]
    if (existing !== undefined) {
      if (mode === 'set' && existing.capacity !== capacity) existing.resize(capacity)
      return existing
    }
    const created = new Semaphore(capacity)
    byKind[kind] = created
    return created
  }

  /**
   * RFC-266 hot-apply: push both saved capacities into the live limiters. Growing
   * drains the FIFO immediately (queued nodes start without waiting for a
   * holder), shrinking never preempts an in-flight holder. Called from
   * PUT /api/config right after the config file is written.
   */
  function resizeAllNodePools(daemonScope: object, capacities: Record<NodePoolKind, number>): void {
    getNodePoolSemaphore(daemonScope, 'agent', capacities.agent)
    getNodePoolSemaphore(daemonScope, 'script', capacities.script)
    // RFC-269: the third pool. `Record<NodePoolKind, number>` makes forgetting it
    // a compile error rather than a silently un-resizable pool.
    getNodePoolSemaphore(daemonScope, 'code-host', capacities['code-host'])
  }

  // RFC-266 — the per-task FAN-OUT SUB-POOL registry.
  //
  // `config.multiProcessSubprocessConcurrency` caps how many shards of one task's
  // fan-out run at once, INSIDE the daemon-wide agent pool (a shard takes an
  // agent-pool slot first, then one of these). Before RFC-266 the semaphore was a
  // per-runTask local `new Semaphore(...)` that nothing outside the scheduler
  // could reach, so a settings change could not apply to a task already running —
  // and, because the value was never threaded off the config at all, every
  // fan-out silently ran at the hard-coded default of 4.
  //
  // The registry gives PUT /api/config a handle on every live task's pool so a
  // saved value takes effect immediately (resizeAllTaskFanoutSems), matching the
  // daemon-wide pools in processNodeConcurrency.ts.
  //
  // Why a plain Map (not the WeakMap<daemonScope> the daemon pools use): the key is
  // a task id string, and hot-apply must ENUMERATE every entry — a WeakMap can do
  // neither. Entries are bounded by gcTaskFanoutSem below.
  //
  // LIFECYCLE (inherited verbatim from taskWriteLocks.ts, which paid for this
  // rule): `gcTaskFanoutSem` may be called ONLY from runTask's finally. Deleting
  // from an HTTP path would race the scheduler's cached reference
  // (the task driver holds the instance for the whole run): delete + recreate
  // while the scheduler still holds the old instance silently splits one pool
  // into two, so a task would run at double its configured shard concurrency. A
  // task that dies without reaching the finally leaks at most one idle Semaphore
  // object, which the next run of the same task id reuses — accepted, documented,
  // and self-healing.

  const pools = new Map<string, Semaphore>()

  /**
   * The one fan-out sub-pool for a task. get-or-create + resize-on-read (a
   * relaunch/resume re-reads the current config value), never replaced while
   * anyone may hold a reference — see the module doc.
   */
  function getTaskFanoutSem(taskId: string, capacity: number): Semaphore {
    const existing = pools.get(taskId)
    if (existing !== undefined) {
      if (existing.capacity !== capacity) existing.resize(capacity)
      return existing
    }
    const created = new Semaphore(capacity)
    pools.set(taskId, created)
    return created
  }

  /**
   * RFC-266 hot-apply: push a newly saved capacity into every RUNNING task's
   * pool. Growing drains each FIFO immediately; shrinking never preempts an
   * in-flight shard.
   */
  function resizeAllTaskFanoutSems(capacity: number): void {
    for (const sem of pools.values()) {
      if (sem.capacity !== capacity) sem.resize(capacity)
    }
  }

  /**
   * Drop the registry entry when idle. ONLY runTask's finally may call this (see
   * module doc). If anything still holds or queues on the pool at that moment the
   * entry survives and is reused by the next get-or-create — self-healing, never
   * split-brain.
   */
  function gcTaskFanoutSem(taskId: string): void {
    const sem = pools.get(taskId)
    if (sem !== undefined && sem.available === sem.capacity && sem.queueLength === 0) {
      pools.delete(taskId)
    }
  }

  /** Test-only visibility. */
  function taskFanoutPoolCount(): number {
    return pools.size
  }

  return {
    getTaskWriteSem,
    getTaskQuestionWriteSem,
    gcTaskWriteSem,
    taskWriteLockCount,
    getNodePoolSemaphore,
    resizeAllNodePools,
    getTaskFanoutSem,
    resizeAllTaskFanoutSems,
    gcTaskFanoutSem,
    taskFanoutPoolCount,
  }
}
