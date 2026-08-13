// Daemon-wide process-node concurrency budgets (RFC-266: two independent pools).
//
// A "process node" is any node kind that spawns a real child process and so
// needs a slot. They are split across TWO pools that never queue behind each
// other:
//
//   'agent'  — agent nodes, workgroup host nodes, fan-out shards + aggregators
//   'script' — RFC-253 script nodes
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
// One DbClient belongs to one daemon. Keying by that object gives every task in
// the daemon the same limiters while WeakMap keeps isolated test/embedded DBs
// independent and collectible. Re-reading a changed setting RESIZES the same
// object rather than replacing it — replacing would split the budget in two,
// which is the whole reason this module exists. PUT /api/config resizes here on
// save (routes/config.ts), so a settings change applies to running tasks and to
// nodes already queued for a slot — not only to the next task launch.

import { Semaphore } from '@/util/semaphore'

/** Which independent daemon pool a process node competes in. */
export type NodePoolKind = 'agent' | 'script' | 'code-host'

const limiters = new WeakMap<object, Partial<Record<NodePoolKind, Semaphore>>>()

/**
 * The daemon's limiter for one pool kind. get-or-create + resize-on-read: an
 * existing limiter is resized in place (never replaced) so active and newly
 * launched tasks can never split into separate budgets.
 */
export function getNodePoolSemaphore(
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
export function resizeAllNodePools(
  daemonScope: object,
  capacities: Record<NodePoolKind, number>,
): void {
  getNodePoolSemaphore(daemonScope, 'agent', capacities.agent)
  getNodePoolSemaphore(daemonScope, 'script', capacities.script)
  // RFC-269: the third pool. `Record<NodePoolKind, number>` makes forgetting it
  // a compile error rather than a silently un-resizable pool.
  getNodePoolSemaphore(daemonScope, 'code-host', capacities['code-host'])
}
