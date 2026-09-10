/** Each caller creates one queue domain for its resource-package apply operations. */
export function createResourcePackageApplyLock() {
  const applyLocks = new Map<string, Promise<unknown>>()

  return async function withApplyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prior = applyLocks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Store and compare the derived chain; comparing the gate would retain every key.
    const chain = prior.then(() => gate)
    applyLocks.set(key, chain)
    await prior.catch(() => {})
    try {
      return await run()
    } finally {
      release()
      // An earlier waiter must not remove the chain registered by a later waiter.
      if (applyLocks.get(key) === chain) applyLocks.delete(key)
    }
  }
}
