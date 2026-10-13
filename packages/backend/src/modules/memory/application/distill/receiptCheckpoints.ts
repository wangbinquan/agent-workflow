import { MemoryDistillSettlementPendingError } from './settlement'
import { IndeterminateRuntimeProcessError } from './memoryDistiller'

interface PendingReceipt {
  readonly revision: number
  readonly jobs: readonly string[]
  readonly cause: unknown
  readonly write: () => Promise<void>
  readonly release: () => void
  retry?: Promise<void>
}

/** A primary receipt ACK is a checkpoint in the original async work. The
 * suspended continuation keeps its actual model result and never re-enters run. */
export class MemoryDistillReceiptCheckpoints {
  private revision = 0
  private pending: PendingReceipt | undefined
  private readonly watchers = new Set<{ after: number; deliver: (value: PendingReceipt) => void }>()

  watch(after: number) {
    let deliver!: (value: PendingReceipt) => void
    const next = new Promise<PendingReceipt>((resolve) => {
      deliver = resolve
    })
    const watcher = { after, deliver }
    if (this.pending && this.pending.revision > after) deliver(this.pending)
    else this.watchers.add(watcher)
    return {
      next,
      close: () => {
        this.watchers.delete(watcher)
      },
    }
  }

  async acknowledge(jobs: readonly string[], write: () => Promise<void>): Promise<void> {
    try {
      await write()
      return
    } catch (cause) {
      if (this.pending) throw new Error('memory-distill-primary-receipts-overlapped')
      let release!: () => void
      const resumed = new Promise<void>((resolve) => {
        release = resolve
      })
      const pending: PendingReceipt = {
        revision: ++this.revision,
        jobs: Object.freeze([...jobs]),
        cause,
        write,
        release,
      }
      this.pending = pending
      for (const watcher of [...this.watchers]) {
        if (pending.revision > watcher.after) {
          this.watchers.delete(watcher)
          watcher.deliver(pending)
        }
      }
      await resumed
    }
  }

  private retryPending(): Promise<void> {
    const pending = this.pending
    if (!pending) return Promise.resolve()
    if (pending.retry) return pending.retry
    const retry = Promise.resolve()
      .then(pending.write)
      .then(() => {
        if (this.pending === pending) this.pending = undefined
        pending.release()
      })
      .finally(() => {
        if (pending.retry === retry) pending.retry = undefined
      })
    pending.retry = retry
    return retry
  }

  /** This error's ACK covers the entire original business continuation,
   * including a subsequent primary checkpoint and the original final outcome. */
  retainOriginalWork<T>(work: Promise<T>): Promise<T> {
    const first = this.watch(0)
    const interrupted = first.next.then((receipt) => {
      const error: MemoryDistillSettlementPendingError = new MemoryDistillSettlementPendingError(
        async () => {
          const after = this.watch(this.revision)
          try {
            await this.retryPending()
            const outcome = await Promise.race([
              work.then(() => 'completed' as const),
              after.next.then(() => 'next-receipt' as const),
            ]).catch(async (nested) => {
              if (
                nested instanceof IndeterminateRuntimeProcessError &&
                nested.originalRecoveryAcknowledged()
              )
                return 'completed' as const
              if (nested instanceof MemoryDistillSettlementPendingError && nested !== error) {
                await nested.retryOriginalSettlement()
                return 'completed' as const
              }
              throw nested
            })
            if (outcome !== 'completed') throw error
          } finally {
            after.close()
          }
        },
        receipt.cause,
        receipt.jobs,
      )
      throw error
    })
    return Promise.race([work, interrupted]).finally(() => {
      first.close()
    })
  }
}
