/** 进程内排队只减少重复工作；journal 的持久唯一键决定 claim 归属。 */
export function createAtomicApplyLock() {
  const locks = new Map<string, Promise<unknown>>()
  return {
    async run<T>(key: string, run: () => Promise<T>): Promise<T> {
      const prior = locks.get(key) ?? Promise.resolve()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const chain = prior.then(() => gate)
      locks.set(key, chain)
      await prior.catch(() => {})
      try {
        return await run()
      } finally {
        release()
        if (locks.get(key) === chain) locks.delete(key)
      }
    },
    size: () => locks.size,
  }
}
