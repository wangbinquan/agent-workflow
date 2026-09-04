// RFC-355 T3（RFC-294 W4-E4a）—— 「同一 session 的 apply 串行化」的**唯一**实现。
//
// 在它之前这段 15 行的算法在仓里有两份：`sqliteIntentApplyOperations.ts` 的
// `withSessionApplyLock`（模块级 `applyLocks` Map）与 `postgresqlIntentApplyOperations.ts` 的
// `withSessionLock`（工厂闭包里的 `locks` Map）。**同一个算法、两个名字**，与 provider 无关：
// 它排的是本进程内对同一个 session 的并发 apply，不涉及数据库、事务或任何 provider 机制。
//
// ⚠️ 本刀只做「两份合成一份」的去重，**不改并发语义**（RFC-355 proposal §4 非目标）：
// 锁的粒度（按 sessionId）、等待方式（链式 Promise）、异常时的释放时机、以及 `prior` 失败
// 不影响后继（`await prior.catch(() => {})`）全部保持原样。

/**
 * 一个按 key 串行化的闸门。SQLite 与 PostgreSQL 各建一个实例——
 * **它们本来就是两个独立的 Map**，合并的是算法不是状态。
 */
export interface SessionApplyLock {
  run<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
  /** 仅供测试观察未释放的闸门数（既有用例依赖，随实现一起迁来）。 */
  size(): number
}

export function createSessionApplyLock(): SessionApplyLock {
  const locks = new Map<string, Promise<unknown>>()
  return {
    async run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
      const prior = locks.get(sessionId) ?? Promise.resolve()
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      const chain = prior.then(() => gate)
      locks.set(sessionId, chain)
      // 前一个失败不能卡住后一个：等它落地即可，不关心结果。
      await prior.catch(() => {})
      try {
        return await fn()
      } finally {
        release()
        if (locks.get(sessionId) === chain) locks.delete(sessionId)
      }
    },
    size(): number {
      return locks.size
    },
  }
}
