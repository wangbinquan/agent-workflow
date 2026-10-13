import { asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { canonicalJson } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { memoryDistillExecutionReceipts } from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  MemoryDistillExecutionJournal,
  MemoryDistillExecutionRecord,
} from '../application/ports/distillExecutionJournal'
import type {
  SystemAgentExecutionReceipt,
  PreparedSystemAgentRunResult,
} from '@/modules/task-execution/public/participants'

const nullableText = z.string().nullable()
const nullableTime = z.number().finite().nullable()
const subject = z
  .object({
    id: z.string().min(1),
    debounceKey: z.string(),
    sourceKind: z.enum(['clarify', 'review', 'feedback', 'agent-run', 'task-run']),
    sourceEventId: z.string(),
    taskId: nullableText,
    scopeResolvedJson: z.string(),
    status: z.enum(['pending', 'running', 'done', 'failed', 'canceled']),
    attempts: z.number().int().nonnegative(),
    nextRunAt: z.number().finite(),
    lastError: nullableText,
    createdAt: z.number().finite(),
    startedAt: nullableTime,
    finishedAt: nullableTime,
    opencodeSessionId: nullableText,
    userPromptMd: nullableText,
    exitCode: nullableTime,
    stderrExcerpt: nullableText,
    dedupSnapshotIdsJson: nullableText,
    outputLang: nullableText,
  })
  .strict()
const context = z
  .object({
    jobId: z.string().min(1),
    attemptIndex: z.number().int().nonnegative(),
    roundIndex: z.number().int().nonnegative(),
    original: z.array(subject).min(1),
    scope: z
      .object({ namespace: z.enum(['intent', 'shared']), name: z.string().optional() })
      .strict(),
    protocol: z.string().min(1),
    envelopeNonce: z.string().min(1),
    prompt: z.string(),
    runtimeBinding: z
      .object({
        owner: z.enum(['source-control', 'resource-catalog', 'runtime-management']),
        reference: z.string(),
        version: z.union([z.string(), z.number()]).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    model: z.string().nullable().optional(),
    isSandbox: z.boolean().optional(),
    timeoutMs: z.number().finite().positive().optional(),
    systemPrompt: z.string().optional(),
    deadlineAt: z.number().finite().optional(),
  })
  .strict()
const result = z
  .object({
    executionReceipt: z
      .object({
        executionRef: z.string().min(1),
        retainedRef: z.string().min(1),
        startedAt: nullableTime,
        recoveryRef: nullableText,
      })
      .strict()
      .optional(),
    status: z.enum([
      'ok',
      'spawn-failed',
      'timeout',
      'aborted',
      'exit-nonzero',
      'result-error',
      'unreaped',
    ]),
    exitCode: z.number().int().nullable(),
    retainedRef: z.string().min(1),
    eventText: z.string(),
    stderrTail: z.string(),
    durationMs: z.number().finite().nonnegative(),
    scratchRetained: z.boolean(),
    outputEvidence: z
      .object({
        assistantTextSeen: z.boolean(),
        observedAssistantTextBytes: z.number().nonnegative(),
        retainedAssistantTextBytes: z.number().nonnegative(),
        eventTextCapHit: z.boolean(),
        unparsedStdoutSeen: z.boolean(),
        lastNormalizedEventKind: nullableText,
        lastRuntimeEventType: nullableText,
        terminalResult: z.enum(['not-observed', 'success', 'error']),
      })
      .passthrough(),
  })
  .passthrough()

// PostgreSQL jsonb validation cannot represent escaped NUL or unpaired
// surrogates. Persist the original canonical JSON bytes in a versioned JSON
// envelope on both providers; legacy plain JSON remains readable.
function encodeJournalJson(value: unknown): string {
  return canonicalJson({
    encoding: 'canonical-json-base64-v1',
    value: Buffer.from(canonicalJson(value), 'utf8').toString('base64'),
  })
}
function decodeJournalJson(text: string): unknown {
  const value: unknown = JSON.parse(text)
  if (
    value !== null &&
    typeof value === 'object' &&
    'encoding' in value &&
    value.encoding === 'canonical-json-base64-v1'
  ) {
    if (!('value' in value) || typeof value.value !== 'string')
      throw new Error('memory-distill-execution-json-invalid')
    return JSON.parse(Buffer.from(value.value, 'base64').toString('utf8'))
  }
  return value
}

type Stored = typeof memoryDistillExecutionReceipts.$inferSelect
function parse(row: Stored): MemoryDistillExecutionRecord {
  const parsed = context.parse(decodeJournalJson(row.contextJson))
  if (
    parsed.jobId !== row.jobId ||
    parsed.attemptIndex !== row.attemptIndex ||
    parsed.roundIndex !== row.roundIndex ||
    !parsed.original.some((original) => original.id === row.jobId) ||
    new Set(parsed.original.map((original) => original.id)).size !== parsed.original.length
  )
    throw new Error('memory-distill-execution-context-mismatch')
  const terminal =
    row.terminalJson === null ? null : result.parse(decodeJournalJson(row.terminalJson))
  if (terminal !== null && terminal.retainedRef !== row.retainedRef)
    throw new Error('memory-distill-execution-terminal-mismatch')
  if (terminal !== null) checkTerminalReceipt(receipt(row), terminal)
  return {
    ...parsed,
    receipt: receipt(row),
    state: row.state,
    preparedAt: row.preparedAt,
    terminal: terminal as Omit<PreparedSystemAgentRunResult, 'executionRecovery'> | null,
    settlement: row.settlement,
  }
}
function receipt(row: Stored): SystemAgentExecutionReceipt {
  return {
    executionRef: row.executionRef,
    retainedRef: row.retainedRef,
    startedAt: row.startedAt,
    recoveryRef: row.recoveryRef,
  }
}
function checkTerminalReceipt(
  expected: SystemAgentExecutionReceipt,
  terminal: { readonly executionReceipt?: unknown },
): void {
  const reported = terminal.executionReceipt
  if (reported === undefined) return
  if (
    reported === null ||
    typeof reported !== 'object' ||
    !('executionRef' in reported) ||
    reported.executionRef !== expected.executionRef ||
    !('retainedRef' in reported) ||
    reported.retainedRef !== expected.retainedRef ||
    !('startedAt' in reported) ||
    reported.startedAt !== expected.startedAt ||
    !('recoveryRef' in reported) ||
    reported.recoveryRef !== expected.recoveryRef
  )
    throw new Error('memory-distill-original-terminal-receipt-mismatch')
}
function matches(
  actual: Stored,
  expected: SystemAgentExecutionReceipt,
  requireStart = true,
): boolean {
  return (
    actual.executionRef === expected.executionRef &&
    actual.retainedRef === expected.retainedRef &&
    (!requireStart ||
      (actual.startedAt === expected.startedAt && actual.recoveryRef === expected.recoveryRef))
  )
}

/** One implementation over the root's actual DB session. Mutations lock and
 * compare original facts; ACK loss can be retried without replacing an attempt. */
export class DrizzleMemoryDistillExecutionJournal implements MemoryDistillExecutionJournal {
  constructor(private readonly db: ProviderNeutralDatabase) {}
  private async original(tx: DatabaseTransaction, ref: string): Promise<Stored> {
    await engineOf(tx).lockAggregateRoot(
      tx,
      memoryDistillExecutionReceipts,
      memoryDistillExecutionReceipts.executionRef,
      ref,
    )
    const row = (
      await tx
        .select()
        .from(memoryDistillExecutionReceipts)
        .where(eq(memoryDistillExecutionReceipts.executionRef, ref))
        .limit(1)
    )[0]
    if (!row) throw new Error('memory-distill-original-execution-receipt-missing')
    parse(row)
    return row
  }

  async prepare(input: Parameters<MemoryDistillExecutionJournal['prepare']>[0]): Promise<void> {
    const parsed = context.parse(input.context)
    if (
      input.receipt.startedAt !== null ||
      (input.receipt.recoveryRef !== null && !input.receipt.recoveryRef) ||
      !Number.isFinite(input.preparedAt) ||
      !parsed.original.some((row) => row.id === parsed.jobId)
    )
      throw new Error('memory-distill-execution-preparation-invalid')
    const contextJson = encodeJournalJson(parsed)
    await databaseSessionFor(this.db).transaction(async (tx) => {
      await tx
        .insert(memoryDistillExecutionReceipts)
        .values({
          executionRef: input.receipt.executionRef,
          retainedRef: input.receipt.retainedRef,
          recoveryRef: input.receipt.recoveryRef,
          jobId: parsed.jobId,
          attemptIndex: parsed.attemptIndex,
          roundIndex: parsed.roundIndex,
          contextJson,
          preparedAt: input.preparedAt,
          state: 'prepared',
        })
        .onConflictDoNothing()
      const row = await this.original(tx, input.receipt.executionRef)
      if (
        !matches(row, input.receipt, false) ||
        canonicalJson(decodeJournalJson(row.contextJson)) !== canonicalJson(parsed) ||
        (row.state === 'prepared' && row.recoveryRef !== input.receipt.recoveryRef) ||
        row.preparedAt !== input.preparedAt
      )
        throw new Error('memory-distill-original-execution-preparation-mismatch')
    })
  }

  async started(expected: SystemAgentExecutionReceipt): Promise<void> {
    if (expected.startedAt === null || !Number.isFinite(expected.startedAt))
      throw new Error('memory-distill-start-receipt-invalid')
    await databaseSessionFor(this.db).transaction(async (tx) => {
      const row = await this.original(tx, expected.executionRef)
      if (!matches(row, expected, false)) throw new Error('memory-distill-original-start-mismatch')
      if (row.state !== 'prepared') {
        if (!matches(row, expected)) throw new Error('memory-distill-original-start-mismatch')
        return
      }
      await tx
        .update(memoryDistillExecutionReceipts)
        .set({ state: 'started', startedAt: expected.startedAt, recoveryRef: expected.recoveryRef })
        .where(eq(memoryDistillExecutionReceipts.executionRef, expected.executionRef))
    })
  }

  async terminal(input: Parameters<MemoryDistillExecutionJournal['terminal']>[0]): Promise<void> {
    const terminal = { ...input.result } as PreparedSystemAgentRunResult
    delete terminal.executionRecovery
    result.parse(terminal)
    checkTerminalReceipt(input.receipt, terminal)
    if (terminal.retainedRef !== input.receipt.retainedRef)
      throw new Error('memory-distill-original-terminal-mismatch')
    const terminalJson = encodeJournalJson(terminal)
    await databaseSessionFor(this.db).transaction(async (tx) => {
      const row = await this.original(tx, input.receipt.executionRef)
      if (
        !matches(row, input.receipt) ||
        (row.terminalJson !== null &&
          canonicalJson(decodeJournalJson(row.terminalJson)) !== canonicalJson(terminal))
      )
        throw new Error('memory-distill-original-terminal-mismatch')
      if (row.terminalJson !== null) return
      if (row.state !== 'started' && row.state !== 'prepared')
        throw new Error('memory-distill-original-terminal-state-mismatch')
      await tx
        .update(memoryDistillExecutionReceipts)
        .set({ state: 'terminal', terminalJson })
        .where(eq(memoryDistillExecutionReceipts.executionRef, input.receipt.executionRef))
    })
  }

  async reaped(expected: SystemAgentExecutionReceipt): Promise<void> {
    await databaseSessionFor(this.db).transaction(async (tx) => {
      const row = await this.original(tx, expected.executionRef)
      if (!matches(row, expected)) throw new Error('memory-distill-original-recovery-mismatch')
      if (row.state === 'closed' || row.state === 'reaped') return
      if (row.state === 'prepared' && row.recoveryRef === null)
        throw new Error('memory-distill-original-recovery-unproven')
      if (row.state !== 'prepared' && row.state !== 'started' && row.state !== 'terminal')
        throw new Error('memory-distill-original-recovery-unproven')
      await tx
        .update(memoryDistillExecutionReceipts)
        .set({ state: 'reaped' })
        .where(eq(memoryDistillExecutionReceipts.executionRef, expected.executionRef))
    })
  }

  private async settle(
    input: Parameters<MemoryDistillExecutionJournal['close']>[0],
    close: boolean,
  ): Promise<void> {
    if (!input.settlement) throw new Error('memory-distill-original-settlement-missing')
    const ordered = [...input.receipts].sort((a, b) => a.executionRef.localeCompare(b.executionRef))
    if (new Set(ordered.map((row) => row.executionRef)).size !== ordered.length)
      throw new Error('memory-distill-original-close-duplicate')
    await databaseSessionFor(this.db).transaction(async (tx) => {
      const rows: Stored[] = []
      for (const expected of ordered) {
        const row = await this.original(tx, expected.executionRef)
        const terminal = parse(row).terminal
        if (
          !matches(row, expected) ||
          (row.settlement !== null && row.settlement !== input.settlement) ||
          (close &&
            row.state !== 'closed' &&
            row.state !== 'reaped' &&
            (row.state !== 'terminal' || terminal === null || terminal.status === 'unreaped'))
        )
          throw new Error('memory-distill-original-close-unproven')
        rows.push(row)
      }
      if (rows.length > 0)
        await tx
          .update(memoryDistillExecutionReceipts)
          .set({ ...(close ? { state: 'closed' as const } : {}), settlement: input.settlement })
          .where(
            inArray(
              memoryDistillExecutionReceipts.executionRef,
              rows.map((row) => row.executionRef),
            ),
          )
    })
  }

  settlement(input: Parameters<MemoryDistillExecutionJournal['settlement']>[0]): Promise<void> {
    return this.settle(input, false)
  }
  close(input: Parameters<MemoryDistillExecutionJournal['close']>[0]): Promise<void> {
    return this.settle(input, true)
  }

  async listOpen(): Promise<readonly MemoryDistillExecutionRecord[]> {
    return (
      await this.db
        .select()
        .from(memoryDistillExecutionReceipts)
        .where(
          inArray(memoryDistillExecutionReceipts.state, [
            'prepared',
            'started',
            'terminal',
            'reaped',
          ]),
        )
        .orderBy(asc(memoryDistillExecutionReceipts.preparedAt))
    ).map(parse)
  }
  async findByJob(jobId: string): Promise<readonly MemoryDistillExecutionRecord[]> {
    return (
      await this.db
        .select()
        .from(memoryDistillExecutionReceipts)
        .where(eq(memoryDistillExecutionReceipts.jobId, jobId))
        .orderBy(
          desc(memoryDistillExecutionReceipts.attemptIndex),
          asc(memoryDistillExecutionReceipts.roundIndex),
        )
    ).map(parse)
  }
}
