/**
 * FIFO serialization by arbitrary key with deterministic idle-key cleanup.
 * Tasks on different keys do not block each other. A task rejection is returned
 * to its caller but never poisons the queue tail, and the final waiter removes
 * the state by identity so a successor can never be evicted accidentally.
 */
export class KeyedSerialQueue<K> {
  private readonly states = new Map<K, { tail: Promise<void>; pending: number }>()

  get size(): number {
    return this.states.size
  }

  async run<T>(key: K, task: () => Promise<T> | T): Promise<T> {
    let state = this.states.get(key)
    if (state === undefined) {
      state = { tail: Promise.resolve(), pending: 0 }
      this.states.set(key, state)
    }

    const previous = state.tail
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    state.tail = previous.then(() => turn)
    state.pending += 1

    await previous
    try {
      return await task()
    } finally {
      state.pending -= 1
      release()
      if (state.pending === 0 && this.states.get(key) === state) {
        this.states.delete(key)
      }
    }
  }
}
