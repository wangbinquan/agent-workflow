// RFC-370: a lost primary ACK suspends the original continuation, including
// its next admission check, rather than submitting a replacement runtime.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { memoryJournalOperations, memoryEnvelope } from './helpers/memoryExecutionJournal'
import { DrizzleMemoryDistillExecutionJournal } from '../src/modules/memory/infrastructure/memoryDistillExecutionJournal'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { MemoryDistillSettlementPendingError } from '../src/modules/memory/application/distill/settlement'
import { memories, memoryDistillJobs } from '../src/db/schema'
import { eq } from 'drizzle-orm'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home() {
  const root = mkdtempSync(join(tmpdir(), 'aw-memory-primary-'))
  roots.push(root)
  return root
}
const candidate = {
  scopeType: 'global',
  scopeId: null,
  title: 'original candidate',
  bodyMd: 'Original model output',
  action: 'new',
}

describeEachProvider('RFC-370 primary ACK retains original Memory continuation', (scope) => {
  for (const stage of ['prepare', 'started', 'terminal'] as const)
    test(`lost ${stage} ACK resumes the original position and never reissues a model`, async () => {
      const db = scope.db,
        root = home(),
        f = memoryJournalOperations(db, root)
      const queued = await f.operations.distillCommands.enqueue({
        sourceKind: 'clarify',
        sourceEventId: 'original-source',
        taskId: null,
        debounceMs: 0,
      })
      if (!queued) throw new Error('original job missing')
      let writes = 0,
        current = true
      const prototype = DrizzleMemoryDistillExecutionJournal.prototype
      const failOnce = () => {
        if (++writes === 1) throw new Error('original primary ACK lost')
      }
      const prepare = prototype.prepare,
        started = prototype.started,
        terminal = prototype.terminal
      const failed =
        stage === 'prepare'
          ? spyOn(prototype, 'prepare').mockImplementation(async function (input) {
              await prepare.call(this, input)
              failOnce()
            })
          : stage === 'started'
            ? spyOn(prototype, 'started').mockImplementation(async function (input) {
                await started.call(this, input)
                failOnce()
              })
            : spyOn(prototype, 'terminal').mockImplementation(async function (input) {
                await terminal.call(this, input)
                failOnce()
              })
      try {
        const error = await f.operations.distillWorker
          .tick({ execution: { current: () => current } })
          .catch((error) => error as unknown)
        expect(error).toBeInstanceOf(MemoryDistillSettlementPendingError)
        const expectedCalls = stage === 'terminal' ? 1 : 0
        expect(f.state.calls).toBe(expectedCalls)
        expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
          status: 'running',
          attempts: 0,
        })
        current = false
        expect(await f.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
        expect(f.state.calls).toBe(expectedCalls)
        expect(writes).toBe(2)
        expect(await f.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
        const row = (await db.select().from(memoryDistillJobs))[0]!
        expect(row.status).toBe(stage === 'terminal' ? 'done' : 'pending')
        expect(
          (error as MemoryDistillSettlementPendingError).originalSettlementAcknowledged(),
        ).toBe(true)
      } finally {
        failed.mockRestore()
      }
    })

  test('lost candidate insert ACK preserves its original ID and human-approved state', async () => {
    const db = scope.db,
      root = home(),
      f = memoryJournalOperations(db, root, {
        respond: async (request) => ({ text: memoryEnvelope(request, [candidate]) }),
      })
    const queued = await f.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-candidate',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    let writes = 0
    const original = DrizzleMemoryDistillWorkStore.prototype.insertCandidate
    const failed = spyOn(
      DrizzleMemoryDistillWorkStore.prototype,
      'insertCandidate',
    ).mockImplementation(async function (input) {
      const inserted = await original.call(this, input)
      if (++writes === 1) throw new Error('candidate insert ACK lost')
      return inserted
    })
    try {
      const error = await f.operations.distillWorker
        .tick({ execution: { current: () => true } })
        .catch((error) => error as unknown)
      expect(error).toBeInstanceOf(MemoryDistillSettlementPendingError)
      const initial = (await db.select().from(memories))[0]!
      expect(f.state.calls).toBe(1)
      await db
        .update(memories)
        .set({ bodyMd: 'Human-approved text', status: 'approved', version: 2 })
        .where(eq(memories.id, initial.id))
      expect(await f.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
      expect(await db.select().from(memories)).toHaveLength(1)
      expect((await db.select().from(memories))[0]).toMatchObject({
        id: initial.id,
        bodyMd: 'Human-approved text',
        status: 'approved',
        version: 2,
      })
      expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
        status: 'done',
        attempts: 0,
      })
      expect(f.state.calls).toBe(1)
    } finally {
      failed.mockRestore()
    }
  })
})
