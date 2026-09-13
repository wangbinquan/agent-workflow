// 把「读到写之间被人插队」变成**确定性**的构造，两个引擎同一条路径。
//
// 为什么这个助手存在：CAS 判据（`WHERE col = <刚读到的值>`）要证明的是「谓词 miss 会变成一个抛出的
// 冲突，而不是静默双写」。要可靠地制造 miss，就得在 helper 读完、正要发 UPDATE 的那一刻插一条
// 竞争写。两件事让它不能随手写：
//
//   ① **竞争写必须走同一笔事务的句柄**。另开一个连接在 PostgreSQL 上会撞行锁把自己锁死
//      （SQLite 单连接看不出来，于是这类写法会「本地绿、PG 挂」）。
//   ② **代理要同时挂 `update` 与 `transaction`**。两个引擎的事务句柄来路不同：SQLite 的
//      `DatabaseSession` 直接把**客户端句柄本身**当事务用（显式 BEGIN IMMEDIATE），PostgreSQL 走
//      驱动的 `db.transaction(cb)`。只挂一个，会在另一个引擎上静默不触发——测试全绿，其实没插进去。
//
// 插入点用被代理 builder 的 `then`：drizzle 的 builder 是 PromiseLike，`await` 的那一刻才发语句，
// 所以在 `then` 里先跑竞争写、再放行本来的语句，正好是「读到写之间」。这也让**竞争写可以是异步的**
// （PG 上它必须是）。
//
// 注意：`db.run(...)` 那条路**不能**用来插队——SQLite 会话开事务发的 `BEGIN IMMEDIATE` 是
// `db.run(sql.raw(...))` 且**没有 await**，把它包成 promise 会让 BEGIN 落到事务体之后。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

/** 链式转发代理：drizzle 的 builder 每一步可能返回新对象，所以逐层包。 */
function fireBeforeAwait<T extends object>(node: T, hook: () => Promise<void>): T {
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (prop === 'then' && typeof value === 'function') {
        const thenable = value as (
          onOk?: (v: unknown) => unknown,
          onErr?: (e: unknown) => unknown,
        ) => unknown
        return (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          hook().then(
            () => thenable.call(target, onOk, onErr),
            (error: unknown) => {
              if (onErr !== undefined) return onErr(error)
              throw error
            },
          )
      }
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args)
          return typeof out === 'object' && out !== null
            ? fireBeforeAwait(out as object, hook)
            : out
        }
      }
      return value
    },
  }) as T
}

/**
 * 代理一个中立客户端：**第一条 UPDATE 被 await 的瞬间**先跑一次 `sabotage`，再放行那条 UPDATE。
 * `sabotage` 收到的是发出这条 UPDATE 的那个句柄（SQLite 上就是客户端本身，PostgreSQL 上是驱动
 * 交出的事务句柄），所以竞争写与被插队的语句在**同一笔事务**里。
 */
export function dbWithCompetingWriter(
  real: ProviderNeutralDatabase,
  sabotage: (tx: DatabaseTransaction) => Promise<void>,
): ProviderNeutralDatabase {
  let fired = false
  const wrap = <T extends object>(node: T): T =>
    new Proxy(node, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown
        if (prop === 'update' && typeof value === 'function') {
          return (...args: unknown[]) => {
            const builder = (value as (...a: unknown[]) => unknown).apply(target, args)
            if (fired || typeof builder !== 'object' || builder === null) return builder
            fired = true
            return fireBeforeAwait(builder as object, () =>
              sabotage(target as unknown as DatabaseTransaction),
            )
          }
        }
        if (prop === 'transaction' && typeof value === 'function') {
          return (body: (tx: object) => unknown, ...rest: unknown[]) =>
            (value as (...a: unknown[]) => unknown).call(
              target,
              (innerTx: object) => body(wrap(innerTx)),
              ...rest,
            )
        }
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    }) as T
  return wrap(real as object) as ProviderNeutralDatabase
}
