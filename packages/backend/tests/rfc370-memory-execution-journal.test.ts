import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { DrizzleMemoryDistillExecutionJournal } from '../src/modules/memory/infrastructure/memoryDistillExecutionJournal'
import { memoryDistillExecutionReceipts } from '../src/db/schema'
import type { MemoryDistillExecutionContext } from '../src/modules/memory/application/ports/distillExecutionJournal'
import type {
  PreparedSystemAgentRunResult,
  SystemAgentExecutionReceipt,
} from '../src/modules/task-execution/public/participants'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'

function context(jobId = 'original-job'): MemoryDistillExecutionContext {
  return {
    jobId,
    attemptIndex: 0,
    roundIndex: 0,
    protocol: 'opencode',
    envelopeNonce: 'original-nonce',
    prompt: '原 prompt\0',
    scope: { namespace: 'shared', name: 'original-scratch' },
    original: [
      {
        id: jobId,
        debounceKey: 'original-key',
        sourceKind: 'clarify',
        sourceEventId: 'original-source',
        taskId: null,
        scopeResolvedJson: '{}',
        status: 'running',
        attempts: 0,
        nextRunAt: 11,
        lastError: null,
        createdAt: 12,
        startedAt: 13,
        finishedAt: null,
        opencodeSessionId: null,
        userPromptMd: null,
        exitCode: null,
        stderrExcerpt: null,
        dedupSnapshotIdsJson: null,
        outputLang: null,
      },
    ],
  }
}
function prepared(executionRef = 'original-execution'): SystemAgentExecutionReceipt {
  return { executionRef, retainedRef: 'original-retained', startedAt: null, recoveryRef: null }
}
function started(executionRef = 'original-execution'): SystemAgentExecutionReceipt {
  return { ...prepared(executionRef), startedAt: 19, recoveryRef: 'original-recovery-reference' }
}
function terminal(
  receipt: SystemAgentExecutionReceipt,
  status: PreparedSystemAgentRunResult['status'] = 'unreaped',
): PreparedSystemAgentRunResult {
  return {
    status,
    retainedRef: receipt.retainedRef,
    executionReceipt: receipt,
    exitCode: status === 'ok' ? 0 : null,
    eventText: '原结果\0\n',
    stderrTail: '原 stderr',
    durationMs: 29,
    scratchRetained: true,
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

describeEachProvider('RFC-370 primary Memory execution journal', (scope) => {
  test('a reconstructed store reads the original durable context/receipt without a job cascade or replacement execution', async () => {
    const db = scope.db,
      first = new DrizzleMemoryDistillExecutionJournal(db)
    await first.prepare({ context: context(), receipt: prepared(), preparedAt: 17 })
    await first.started(started())
    await first.terminal({ receipt: started(), result: terminal(started()) })
    const rebuilt = new DrizzleMemoryDistillExecutionJournal(db)
    const open = await rebuilt.listOpen()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      jobId: 'original-job',
      preparedAt: 17,
      state: 'terminal',
      receipt: started(),
      terminal: terminal(started()),
    })
    expect(open[0]?.original).toEqual(context().original)
    expect((await rebuilt.findByJob('original-job'))[0]?.prompt).toBe('原 prompt\0')
    await expect(
      rebuilt.close({ receipts: [started()], settlement: 'original failed receipt' }),
    ).rejects.toThrow('memory-distill-original-close-unproven')
    await rebuilt.reaped(started())
    await rebuilt.close({ receipts: [started()], settlement: 'original failed receipt' })
    expect(await rebuilt.listOpen()).toEqual([])
    expect((await rebuilt.findByJob('original-job'))[0]).toMatchObject({
      state: 'closed',
      settlement: 'original failed receipt',
    })
  })

  test('idempotent preparation/start/terminal/close ACKs preserve original time and bytes', async () => {
    const journal = new DrizzleMemoryDistillExecutionJournal(scope.db)
    const input = { context: context(), receipt: prepared(), preparedAt: 17 }
    await journal.prepare(input)
    await journal.prepare(input)
    await journal.started(started())
    await journal.started(started())
    await journal.terminal({ receipt: started(), result: terminal(started(), 'ok') })
    const reconstructed = JSON.parse(
      JSON.stringify(terminal(started(), 'ok')),
    ) as PreparedSystemAgentRunResult
    await journal.terminal({
      receipt: started(),
      result: { ...reconstructed, stderrTail: reconstructed.stderrTail },
    })
    await journal.close({ receipts: [started()], settlement: 'original done receipt' })
    await journal.close({ receipts: [started()], settlement: 'original done receipt' })
    expect((await journal.findByJob('original-job'))[0]).toMatchObject({
      preparedAt: 17,
      receipt: started(),
      state: 'closed',
      terminal: { eventText: '原结果\0\n' },
    })
    await expect(journal.prepare({ ...input, preparedAt: 18 })).rejects.toThrow(
      'memory-distill-original-execution-preparation-mismatch',
    )
    await expect(
      journal.started({ ...started(), recoveryRef: 'replacement-reference' }),
    ).rejects.toThrow('memory-distill-original-start-mismatch')
    await expect(
      journal.close({ receipts: [started()], settlement: 'replacement done receipt' }),
    ).rejects.toThrow('memory-distill-original-close-unproven')
  })

  test('an all-or-nothing close leaves every original receipt open when one physical result is still unknown', async () => {
    const journal = new DrizzleMemoryDistillExecutionJournal(scope.db)
    for (const ref of ['known', 'unknown']) {
      await journal.prepare({ context: context(ref), receipt: prepared(ref), preparedAt: 17 })
      await journal.started(started(ref))
      await journal.terminal({
        receipt: started(ref),
        result: terminal(started(ref), ref === 'known' ? 'ok' : 'unreaped'),
      })
    }
    await expect(
      journal.close({
        receipts: [started('known'), started('unknown')],
        settlement: 'original bundle outcome',
      }),
    ).rejects.toThrow('memory-distill-original-close-unproven')
    expect((await journal.listOpen()).map((row) => row.state)).toEqual(['terminal', 'terminal'])
    await journal.reaped(started('unknown'))
    await journal.close({
      receipts: [started('known'), started('unknown')],
      settlement: 'original bundle outcome',
    })
    expect(await journal.listOpen()).toEqual([])
  })

  test('malformed or mismatched durable context cannot authorize recovery or close', async () => {
    const db = scope.db,
      journal = new DrizzleMemoryDistillExecutionJournal(db)
    await journal.prepare({ context: context(), receipt: prepared(), preparedAt: 17 })
    await db
      .update(memoryDistillExecutionReceipts)
      .set({ contextJson: JSON.stringify({ ...context(), jobId: 'replacement-job' }) })
      .where(eq(memoryDistillExecutionReceipts.executionRef, prepared().executionRef))
    await expect(journal.started(started())).rejects.toThrow(
      'memory-distill-execution-context-mismatch',
    )
    await expect(journal.listOpen()).rejects.toThrow('memory-distill-execution-context-mismatch')
    expect((await db.select().from(memoryDistillExecutionReceipts))[0]?.state).toBe('prepared')
  })

  test('a terminal payload from another execution cannot replace the original primary facts', async () => {
    const db = scope.db,
      journal = new DrizzleMemoryDistillExecutionJournal(db)
    await journal.prepare({ context: context(), receipt: prepared(), preparedAt: 17 })
    await journal.started(started())
    const before = (await db.select().from(memoryDistillExecutionReceipts))[0]
    await expect(
      journal.terminal({ receipt: started(), result: terminal(started('replacement'), 'ok') }),
    ).rejects.toThrow('memory-distill-original-terminal-receipt-mismatch')
    expect((await db.select().from(memoryDistillExecutionReceipts))[0]).toEqual(before)
  })

  test('a durable proposed failure is not a physical retirement or a closed business ACK', async () => {
    const journal = new DrizzleMemoryDistillExecutionJournal(scope.db)
    await journal.prepare({ context: context(), receipt: prepared(), preparedAt: 17 })
    await journal.started(started())
    await journal.terminal({ receipt: started(), result: terminal(started()) })
    await journal.settlement({ receipts: [started()], settlement: 'original proposed failure' })
    const rebuilt = new DrizzleMemoryDistillExecutionJournal(scope.db)
    expect(await rebuilt.listOpen()).toHaveLength(1)
    expect((await rebuilt.listOpen())[0]).toMatchObject({
      state: 'terminal',
      settlement: 'original proposed failure',
      terminal: { status: 'unreaped' },
    })
    await expect(
      rebuilt.close({ receipts: [started()], settlement: 'original proposed failure' }),
    ).rejects.toThrow('original-close-unproven')
    await expect(
      rebuilt.settlement({ receipts: [started()], settlement: 'replacement failure' }),
    ).rejects.toThrow('original-close-unproven')
    await rebuilt.reaped(started())
    await rebuilt.close({ receipts: [started()], settlement: 'original proposed failure' })
    expect(await rebuilt.listOpen()).toEqual([])
  })

  test('the original prepared recovery reference survives reconstruction until a real physical ACK', async () => {
    const journal = new DrizzleMemoryDistillExecutionJournal(scope.db)
    const receipt = { ...prepared(), recoveryRef: 'original-gated-preparation-reference' }
    await journal.prepare({ context: context(), receipt, preparedAt: 17 })
    const rebuilt = new DrizzleMemoryDistillExecutionJournal(scope.db)
    expect((await rebuilt.listOpen())[0]?.receipt).toEqual(receipt)
    await expect(
      rebuilt.close({ receipts: [receipt], settlement: 'original deferred receipt' }),
    ).rejects.toThrow('original-close-unproven')
    await expect(
      rebuilt.prepare({
        context: context(),
        receipt: { ...receipt, recoveryRef: 'replacement' },
        preparedAt: 17,
      }),
    ).rejects.toThrow('original-execution-preparation-mismatch')
    await rebuilt.reaped(receipt)
    await rebuilt.close({ receipts: [receipt], settlement: 'original deferred receipt' })
    expect(await rebuilt.listOpen()).toEqual([])
  })

  test('a legacy prepared record without a recovery identity cannot be relabeled physically reaped', async () => {
    const journal = new DrizzleMemoryDistillExecutionJournal(scope.db)
    await journal.prepare({ context: context(), receipt: prepared(), preparedAt: 17 })
    await expect(journal.reaped(prepared())).rejects.toThrow('original-recovery-unproven')
    expect((await journal.listOpen())[0]?.state).toBe('prepared')
  })
})
