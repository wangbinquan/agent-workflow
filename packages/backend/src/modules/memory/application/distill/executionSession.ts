import type {
  PreparedSystemAgentRunResult,
  SystemAgentExecutionReceipt,
  SystemAgentExecutionReceiptSink,
} from '@/modules/task-execution/public/participants'
import type { MemoryDistillExecutionJournal } from '../ports/distillExecutionJournal'
import type { MemoryDistillExecutionContext } from '../ports/distillExecutionJournal'
import type { MemoryDistillExecutionRecord } from '../ports/distillExecutionJournal'
import type { MemoryDistillJobRecord } from '../ports/distillReadStore'
import type { MemoryDistillReceiptCheckpoints } from './receiptCheckpoints'

/** One original bundle. Primary checkpoints own no runner or queue claim. */
export class MemoryDistillExecutionSession {
  private readonly records = new Map<
    string,
    { receipt: SystemAgentExecutionReceipt; preparedAt: number }
  >()
  private readonly prepare: MemoryDistillExecutionJournal['prepare']
  private readonly start: MemoryDistillExecutionJournal['started']
  private readonly terminal: MemoryDistillExecutionJournal['terminal']
  private readonly reaped: MemoryDistillExecutionJournal['reaped']
  private readonly settlement: MemoryDistillExecutionJournal['settlement']
  private readonly close: MemoryDistillExecutionJournal['close']
  private readonly current: () => boolean
  private readonly now: () => number
  readonly jobs: readonly string[]

  constructor(
    private readonly input: {
      readonly journal: MemoryDistillExecutionJournal
      readonly checkpoints: MemoryDistillReceiptCheckpoints
      readonly original: readonly MemoryDistillJobRecord[]
      readonly jobId: string
      readonly now: () => number
      readonly current: () => boolean
      readonly restore?: readonly MemoryDistillExecutionRecord[]
    },
  ) {
    this.jobs = Object.freeze(input.original.map((row) => row.id))
    const journal = input.journal
    this.current = input.current.bind(input)
    this.now = input.now.bind(input)
    this.prepare = journal.prepare.bind(journal)
    this.start = journal.started.bind(journal)
    this.terminal = journal.terminal.bind(journal)
    this.reaped = journal.reaped.bind(journal)
    this.settlement = journal.settlement.bind(journal)
    this.close = journal.close.bind(journal)
    for (const row of input.restore ?? [])
      this.records.set(row.receipt.executionRef, {
        receipt: row.receipt,
        preparedAt: row.preparedAt,
      })
  }

  round(
    input: Omit<MemoryDistillExecutionContext, 'jobId' | 'attemptIndex' | 'original'>,
  ): SystemAgentExecutionReceiptSink {
    const original = this.input.original
    const head = original.find((row) => row.id === this.input.jobId)
    if (!head) throw new Error('memory-distill-original-execution-head-missing')
    const context = Object.freeze({
      ...input,
      jobId: head.id,
      attemptIndex: head.attempts,
      original,
    })
    const { checkpoints } = this.input
    return Object.freeze({
      prepared: async (receipt) => {
        const captured = Object.freeze({ ...receipt })
        const preparedAt = this.now()
        await checkpoints.acknowledge(this.jobs, () =>
          this.prepare({ context, receipt: captured, preparedAt }),
        )
        this.records.set(captured.executionRef, { receipt: captured, preparedAt })
      },
      started: async (receipt) => {
        const captured = Object.freeze({ ...receipt })
        const original = this.records.get(captured.executionRef)
        if (!original || original.receipt.retainedRef !== captured.retainedRef)
          throw new Error('memory-distill-original-start-context-missing')
        await checkpoints.acknowledge(this.jobs, () => this.start(captured))
        original.receipt = captured
      },
    })
  }

  async observeTerminal(result: PreparedSystemAgentRunResult): Promise<void> {
    const receipt = result.executionReceipt
    if (!receipt) return // Explicit raw native fixtures hand off no receipt.
    const original = this.records.get(receipt.executionRef)
    if (!original) throw new Error('memory-distill-original-terminal-context-missing')
    const captured = { ...result }
    delete captured.executionRecovery
    await this.input.checkpoints.acknowledge(this.jobs, () =>
      this.terminal({ receipt: original.receipt, result: captured }),
    )
  }
  confirmReaped(receipt: SystemAgentExecutionReceipt): Promise<void> {
    return this.reaped(receipt)
  }
  recordSettlement(settlement: string): Promise<void> {
    return this.settlement({
      receipts: [...this.records.values()].map((row) => row.receipt),
      settlement,
    })
  }
  acknowledgeSettlement(settlement: string): Promise<void> {
    return this.close({
      receipts: [...this.records.values()].map((row) => row.receipt),
      settlement,
    })
  }
  originalPreparedAt(executionRef: string): number {
    const original = this.records.get(executionRef)
    if (!original) throw new Error('memory-distill-original-candidate-context-missing')
    return original.preparedAt
  }
  async persistCandidate<T>(write: () => Promise<T>): Promise<T> {
    let value!: T
    await this.input.checkpoints.acknowledge(this.jobs, async () => {
      value = await write()
    })
    return value
  }
  canIssue = (): boolean => this.current()
}
