/** Retains the original async work or its completed-result tail. Receipt
 * retries never re-enter a submitted runtime; its held continuation keeps facts. */
export class MemoryDistillSettlementPendingError extends Error {
  private completed = false
  private pending: Promise<void> | undefined

  constructor(
    private readonly original: () => Promise<void>,
    cause: unknown,
    readonly originalJobIds: readonly string[] = [],
  ) {
    super('The original memory distillation settlement has not been acknowledged', { cause })
    this.name = 'MemoryDistillSettlementPendingError'
  }

  retryOriginalSettlement(): Promise<void> {
    if (this.completed) return Promise.resolve()
    if (this.pending) return this.pending
    // Reserve before invoking the original callback, including synchronous
    // callback reentry into the same owner's drain.
    const retry = Promise.resolve()
      .then(this.original)
      .then(() => {
        this.completed = true
      })
      .finally(() => {
        if (this.pending === retry) this.pending = undefined
      })
    this.pending = retry
    return retry
  }
  originalSettlementAcknowledged(): boolean {
    return this.completed
  }
}

export async function settleOriginalMemoryDistillation(
  work: () => Promise<void>,
  jobs: readonly string[] = [],
): Promise<void> {
  try {
    await work()
  } catch (error) {
    throw new MemoryDistillSettlementPendingError(work, error, Object.freeze([...jobs]))
  }
}
