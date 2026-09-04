// RFC-359 W2 —— SQLite 的进程内单写者租约。
//
// 为什么需要它：统一事务原语在 SQLite 上用**显式** `BEGIN IMMEDIATE` / `COMMIT` 划边界
// （而不是 bun:sqlite 那个「回调一返回就提交」的同步包装器，见 `db/txSync.ts` 的头注释），
// 于是事务体里可以 `await`。代价是 `BEGIN` 与 `COMMIT` 之间出现了真实的事件循环让渡窗口：
// 同一个连接上如果这时有第二个写者发语句，它会**落进别人的事务**。
//
// 这把租约把那个窗口关上：同一客户端上的写事务串行化。它不是新增的并发约束——RFC-351 之后
// 每一笔 SQLite 写事务本来就 `BEGIN IMMEDIATE` 预占 writer（`db/txSync.ts:57`），SQLite 自己
// 在连接层也只允许一个写事务；这里只是把那份隐式串行**显式化**，好让等待发生在应用层的队列里
// 而不是驱动层的 busy-wait。
//
// PostgreSQL 不需要它：每笔事务占一条独立连接，没有共享连接被串写的问题。

/** 每个客户端一条等待链。键是客户端对象本身，所以测试里的每个内存库互不影响。 */
const chains = new WeakMap<object, Promise<void>>()

/** 等待写者租约超过上限。**故障信号**：正常事务是毫秒级的，等到这里说明有人没释放。 */
export class WriterLeaseTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`writer lease not acquired within ${waitedMs}ms; a transaction is holding it open`)
    this.name = 'WriterLeaseTimeoutError'
  }
}

/**
 * 等待上限。正常写事务是毫秒级；这个值只是「系统已经坏了」的兜底，不是性能旋钮。
 * 2026-09-04 变异验证实测：重入检出一旦回归，内层会等外层持有的租约——无界等待下 daemon
 * **静默挂死**，CI 上表现为整个分片挂住而不是一条可归因的红。有界等待把它变成可诊断的错误。
 */
export const WRITER_LEASE_TIMEOUT_MS = 30_000

/**
 * 取得写者租约。返回的 release **幂等**——重复调用只有第一次生效，避免 finally 里重复释放
 * 把链条提前放行。
 *
 * 超时的处置是**放行并抛错**，不是「继续等」：等待者已经在链上挂了自己的 `held`，若抛错时不
 * 释放它，它后面的每一个等待者都会永久停住——把一处故障放大成全进程停摆。放行意味着极端情况下
 * 可能与那个卡住的持有者并发，但走到这一步系统已经坏了，可诊断优先于形式上的互斥。
 */
export async function acquireWriterLease(
  client: object,
  timeoutMs: number = WRITER_LEASE_TIMEOUT_MS,
): Promise<() => void> {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const previous = chains.get(client) ?? Promise.resolve()
  // 链上挂的是「本持有者释放」这个 promise：下一个等待者要等到它 resolve。
  chains.set(
    client,
    previous.then(() => held),
  )
  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new WriterLeaseTimeoutError(timeoutMs)), timeoutMs)
      previous.then(resolve, reject)
    })
  } catch (error) {
    releaseOnce()
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return releaseOnce
}

/** 诊断用：该客户端上当前是否有人排队（含持有者）。 */
export function hasPendingWriterLease(client: object): boolean {
  return chains.has(client)
}
