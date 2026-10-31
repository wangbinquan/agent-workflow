// Minimal FIFO counting semaphore used by the scheduler (P-3-05).
//
// Construction with `capacity = N` allows at most N concurrent holders.
// `acquire()` resolves immediately when a slot is free, otherwise queues
// the caller in FIFO order. The returned function releases the slot —
// callers should call it exactly once (use try/finally).
//
// Not designed for cross-process use; one daemon = one event loop.

export class Semaphore {
  private inUse = 0
  private readonly waiters: Array<(release: () => void) => void> = []
  private currentCapacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}`)
    }
    this.currentCapacity = capacity
  }

  get capacity(): number {
    return this.currentCapacity
  }

  /** Currently-free slots (capacity - inFlight). */
  get available(): number {
    return Math.max(0, this.currentCapacity - this.inUse)
  }

  /** Number of callers blocked waiting for a slot. */
  get queueLength(): number {
    return this.waiters.length
  }

  /**
   * Acquire one slot. Returns a `release` function that frees the slot.
   * Always wrap in try/finally so a thrown exception doesn't permanently
   * leak a slot.
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      if (this.inUse < this.currentCapacity) {
        this.inUse += 1
        resolve(this.releaseOnce())
        return
      }
      this.waiters.push(resolve)
    })
  }

  /**
   * Change the live capacity. Shrinking never preempts current holders; queued
   * callers remain blocked until inUse drops below the new cap. Growing drains
   * the FIFO immediately. One daemon can therefore apply a new global setting
   * without replacing the shared limiter and splitting the budget.
   */
  resize(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer, got ${capacity}`)
    }
    this.currentCapacity = capacity
    this.drain()
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.inUse -= 1
      this.drain()
    }
  }

  private drain(): void {
    while (this.inUse < this.currentCapacity) {
      const next = this.waiters.shift()
      if (next === undefined) return
      this.inUse += 1
      next(this.releaseOnce())
    }
  }

  /**
   * Convenience helper. `await sem.run(fn)` acquires, calls fn, releases.
   * Releases the slot even when fn throws.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
