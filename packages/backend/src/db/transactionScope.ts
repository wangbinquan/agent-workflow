// RFC-359 W2 —— 显式事务作用域：新旧两套事务机制在同一条 SQLite 连接上的共存判据。
//
// 过渡期里两套机制并存：`dbTxSync`（同步，走 bun:sqlite 的包装器）与
// `platform/persistence/databaseTransaction.ts` 的统一原语（显式 BEGIN IMMEDIATE，体内可 await）。
// 它们跑在**同一条连接**上，于是有一个静默的危险形态（2026-09-04 实测）：
//
//   新原语 BEGIN 之后进入 await 让渡窗口 → **另一个 async 上下文**调 dbTxSync 写入 →
//   该写入落进别人开着的事务 → 外层回滚时把它一起带走。**不报错，数据凭空消失。**
//
// 同一 async 上下文里的嵌套则是合法的：bun:sqlite 对已开事务用 SAVEPOINT，语义正确
//（实测：内层随外层一起回滚）。所以判据不是「有没有事务开着」，而是
// **「有事务开着，且我不在它的 async 上下文里」**——那才是旁观者被卷入。
//
// 本模块放在 `db/` 而不是 `platform/persistence/`：`db/` 只以类型方式引 platform，
// 反向才是 runtime 常态；把注册表放低一层，两边都能正常 import。

import { AsyncLocalStorage } from 'node:async_hooks'

/** 当前 async 上下文里已打开的显式事务帧。 */
const frames = new AsyncLocalStorage<readonly object[]>()

/** 每个客户端上打开着的显式事务层数（顶层只会是 0 或 1，重入不再叠加）。 */
const openDepth = new WeakMap<object, number>()

export class CrossContextTransactionError extends Error {
  constructor() {
    super(
      'dbTxSync was called while an explicit transaction is open on this client from another ' +
        'async context. The write would join that transaction and be rolled back with it. ' +
        'Use the unified primitive (platform/persistence/databaseTransaction.ts) instead. [RFC-359]',
    )
    this.name = 'CrossContextTransactionError'
  }
}

/** 本 async 上下文是否持有该客户端的显式事务。 */
export function holdsExplicitTransaction(client: object): boolean {
  return frames.getStore()?.includes(client) === true
}

/**
 * 该客户端上是否有**别人**开着的显式事务。这正是会静默吞掉写入的形态。
 */
export function foreignExplicitTransactionOpen(client: object): boolean {
  return (openDepth.get(client) ?? 0) > 0 && !holdsExplicitTransaction(client)
}

/** 在本 async 上下文里标记「该客户端的显式事务已打开」，并在 run 结束后回退。 */
export async function runInExplicitTransactionScope<T>(
  client: object,
  run: () => Promise<T>,
): Promise<T> {
  const next: readonly object[] = [...(frames.getStore() ?? []), client]
  openDepth.set(client, (openDepth.get(client) ?? 0) + 1)
  try {
    return await frames.run(next, run)
  } finally {
    const depth = (openDepth.get(client) ?? 1) - 1
    if (depth <= 0) openDepth.delete(client)
    else openDepth.set(client, depth)
  }
}
