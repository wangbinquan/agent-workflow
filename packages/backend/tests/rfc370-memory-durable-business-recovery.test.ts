// RFC-370: cold recovery reconciles the same issued work; no model replay or
// overwrite of an operator's later candidate/job decision.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { memoryJournalOperations, memoryEnvelope } from './helpers/memoryExecutionJournal'
import { DrizzleMemoryDistillWorkStore } from '../src/modules/memory/infrastructure/memoryDistillWorkStore'
import { DrizzleMemoryDistillExecutionJournal } from '../src/modules/memory/infrastructure/memoryDistillExecutionJournal'
import { MemoryDistillSettlementPendingError } from '../src/modules/memory/application/distill/settlement'
import { IndeterminateRuntimeProcessError } from '../src/modules/memory/application/distill/memoryDistiller'
import { memories, memoryDistillJobs, memoryDistillExecutionReceipts } from '../src/db/schema'
import { deferred } from './helpers/taskHostExecution'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function home() {
  const root = mkdtempSync(join(tmpdir(), 'aw-memory-durable-'))
  roots.push(root)
  return root
}
const candidate = {
  scopeType: 'global',
  scopeId: null,
  title: 'original candidate',
  bodyMd: 'Original durable model output',
  action: 'new',
}

describeEachProvider('RFC-370 reconstructed Memory business recovery', (scope) => {
  test('a normally active original tick cannot be stolen by cold execution recovery', async () => {
    const db = scope.db,
      root = home(),
      entered = deferred(),
      release = deferred()
    const f = memoryJournalOperations(db, root, {
      respond: async (request) => {
        entered.resolve()
        await release.promise
        return { text: memoryEnvelope(request) }
      },
    })
    const queued = await f.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'active-original',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const ticking = f.operations.distillWorker.tick({ execution: { current: () => true } })
    try {
      await entered.promise
      const before = (await db.select().from(memoryDistillJobs))[0]!
      expect(await f.operations.distillCommands.recoverIssued(queued.jobId)).toBe(false)
      expect(f.state.recoveries).toBe(0)
      expect((await db.select().from(memoryDistillJobs))[0]).toEqual(before)
      release.resolve()
      expect(await ticking).toMatchObject({ succeeded: 1 })
      expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
        status: 'done',
        attempts: 0,
      })
      expect(f.state.calls).toBe(1)
    } finally {
      release.resolve()
      await ticking
    }
  })

  test('explicit recovery of an unactivated prepared execution returns the original claim without spending retry budget', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root, { preparedRecovery: true })
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-prepared',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const held = spyOn(
      DrizzleMemoryDistillExecutionJournal.prototype,
      'started',
    ).mockImplementation(async () => {
      throw new Error('daemon stopped before started receipt')
    })
    try {
      await expect(
        first.operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBeInstanceOf(MemoryDistillSettlementPendingError)
    } finally {
      held.mockRestore()
    }
    expect(first.state.calls).toBe(0)
    const before = (await db.select().from(memoryDistillJobs))[0]!
    const restored = memoryJournalOperations(db, root)
    await expect(restored.operations.distillWorker.recoverRunning()).rejects.toBeInstanceOf(
      IndeterminateRuntimeProcessError,
    )
    expect(restored.state.recoveries).toBe(0)
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    const after = (await db.select().from(memoryDistillJobs))[0]!
    expect(after).toEqual({ ...before, status: 'pending', startedAt: null })
    expect((await db.select().from(memoryDistillExecutionReceipts))[0]).toMatchObject({
      state: 'closed',
    })
    expect(restored.state.calls).toBe(0)
  })

  test('a completed-model done ACK lost before journal close is reconciled from original time and does not rerun the model', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root)
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-done',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const write = DrizzleMemoryDistillWorkStore.prototype.markDone
    const lost = spyOn(DrizzleMemoryDistillWorkStore.prototype, 'markDone').mockImplementation(
      async function (this: DrizzleMemoryDistillWorkStore, ids, at, original) {
        await write.call(this, ids, at, original)
        throw new Error('original done ACK lost')
      },
    )
    try {
      const error = await first.operations.distillWorker
        .tick({ execution: { current: () => true } })
        .catch((error) => error as unknown)
      expect(error).toBeInstanceOf(MemoryDistillSettlementPendingError)
      expect(first.state.calls).toBe(1)
    } finally {
      lost.mockRestore()
    }
    const before = (await db.select().from(memoryDistillJobs))[0]!
    const restored = memoryJournalOperations(db, root)
    expect(await restored.operations.distillWorker.recoverRunning()).toEqual({ recovered: 0 })
    expect((await db.select().from(memoryDistillJobs))[0]).toEqual(before)
    expect((await db.select().from(memoryDistillExecutionReceipts))[0]?.state).toBe('closed')
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    expect(restored.state.calls).toBe(0)
  })

  test('a recovered known output reuses a candidate already inserted and preserves human edits', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root, {
        respond: async (request) => ({ text: memoryEnvelope(request, [candidate]) }),
      })
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-candidate',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const lost = spyOn(
      DrizzleMemoryDistillExecutionJournal.prototype,
      'settlement',
    ).mockImplementation(async () => {
      throw new Error('original outcome not yet durable')
    })
    try {
      await expect(
        first.operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBeInstanceOf(MemoryDistillSettlementPendingError)
    } finally {
      lost.mockRestore()
    }
    const old = (await db.select().from(memories))[0]!
    await db
      .update(memories)
      .set({ bodyMd: 'Human approved durable text', status: 'approved', version: 2 })
      .where(eq(memories.id, old.id))
    const restored = memoryJournalOperations(db, root)
    expect(await restored.operations.distillWorker.recoverRunning()).toEqual({ recovered: 0 })
    expect(await db.select().from(memories)).toHaveLength(1)
    expect((await db.select().from(memories))[0]).toMatchObject({
      id: old.id,
      bodyMd: 'Human approved durable text',
      status: 'approved',
      version: 2,
    })
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'done',
      attempts: 0,
    })
    expect(restored.state.calls).toBe(0)
  })

  test('reconstruction cannot blanket-requeue an unknown physical result, and only explicit original recovery closes it', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root, {
        respond: async () => ({ text: '', status: 'unreaped' }),
      })
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-unreaped',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    first.state.reaped = false
    await expect(
      first.operations.distillWorker.tick({ execution: { current: () => true } }),
    ).rejects.toBeInstanceOf(IndeterminateRuntimeProcessError)
    const before = (await db.select().from(memoryDistillJobs))[0]!
    const restored = memoryJournalOperations(db, root)
    restored.state.reaped = false
    await expect(restored.operations.distillWorker.recoverRunning()).rejects.toBeInstanceOf(
      IndeterminateRuntimeProcessError,
    )
    expect(restored.state.recoveries).toBe(0)
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(false)
    expect((await db.select().from(memoryDistillJobs))[0]).toEqual(before)
    restored.state.reaped = true
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
    })
    expect(await restored.operations.distillWorker.recoverRunning()).toEqual({ recovered: 0 })
    expect(restored.state.calls).toBe(0)
  })

  test('original protocol continuation is handed to a fresh active owner without replaying the completed round', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root, {
        preparedRecovery: true,
        respond: async () => ({ text: 'Original non-envelope answer' }),
      })
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-continuation',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const prepare = DrizzleMemoryDistillExecutionJournal.prototype.prepare
    let prepared = 0
    const interrupted = spyOn(
      DrizzleMemoryDistillExecutionJournal.prototype,
      'prepare',
    ).mockImplementation(async function (this: DrizzleMemoryDistillExecutionJournal, input) {
      await prepare.call(this, input)
      if (++prepared === 2) throw new Error('daemon stopped before next round')
    })
    try {
      await expect(
        first.operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBeInstanceOf(MemoryDistillSettlementPendingError)
    } finally {
      interrupted.mockRestore()
    }
    expect(first.state.calls).toBe(1)
    const originalRequest = first.state.requests[0]!
    const restored = memoryJournalOperations(db, root)
    await expect(restored.operations.distillWorker.recoverRunning()).rejects.toBeInstanceOf(
      IndeterminateRuntimeProcessError,
    )
    expect(restored.state.calls).toBe(0)
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    expect(await restored.operations.distillWorker.recoverRunning()).toEqual({ recovered: 0 })
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'running',
      attempts: 0,
    })
    await expect(restored.operations.distillWorker.tick()).rejects.toThrow(
      'requires-execution-authority',
    )
    expect(
      await restored.operations.distillWorker.tick({ execution: { current: () => true } }),
    ).toMatchObject({ succeeded: 1 })
    expect(restored.state.calls).toBe(1)
    expect(restored.state.requests[0]).toMatchObject({
      resumeSessionId: 'original-memory-native-session',
      workspaceScope: originalRequest.workspaceScope,
      protocol: originalRequest.protocol,
    })
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      id: queued.jobId,
      status: 'done',
      attempts: 0,
    })
  })

  test('an unactivated prepared follow-up is physically retired, then continued once by a new active owner', async () => {
    const db = scope.db,
      root = home()
    const first = memoryJournalOperations(db, root, {
      preparedRecovery: true,
      respond: async () => ({ text: 'Original non-envelope answer' }),
    })
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original-held-followup',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const started = DrizzleMemoryDistillExecutionJournal.prototype.started
    let starts = 0
    const held = spyOn(
      DrizzleMemoryDistillExecutionJournal.prototype,
      'started',
    ).mockImplementation(async function (this: DrizzleMemoryDistillExecutionJournal, receipt) {
      if (++starts === 2) throw new Error('daemon stopped before follow-up activation')
      await started.call(this, receipt)
    })
    try {
      await expect(
        first.operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBeInstanceOf(MemoryDistillSettlementPendingError)
    } finally {
      held.mockRestore()
    }
    expect(first.state.calls).toBe(1)
    expect(await db.select().from(memoryDistillExecutionReceipts)).toHaveLength(2)
    const restored = memoryJournalOperations(db, root)
    await expect(restored.operations.distillWorker.recoverRunning()).rejects.toBeInstanceOf(
      IndeterminateRuntimeProcessError,
    )
    expect(restored.state.recoveries).toBe(0)
    expect(await restored.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'running',
      attempts: 0,
    })
    expect(restored.state.calls).toBe(0)
    expect(
      await restored.operations.distillWorker.tick({ execution: { current: () => true } }),
    ).toMatchObject({ succeeded: 1 })
    expect(restored.state.calls).toBe(1)
    expect(restored.state.requests[0]).toMatchObject({
      resumeSessionId: 'original-memory-native-session',
      workspaceScope: first.state.requests[0]!.workspaceScope,
    })
    const receipts = await db.select().from(memoryDistillExecutionReceipts)
    expect(receipts).toHaveLength(3)
    expect(receipts.every((row) => row.state === 'closed')).toBe(true)
    expect((await db.select().from(memoryDistillJobs))[0]).toMatchObject({
      status: 'done',
      attempts: 0,
    })
    const again = memoryJournalOperations(db, root)
    expect(await again.operations.distillCommands.recoverIssued(queued.jobId)).toBe(true)
    expect(again.state.calls).toBe(0)
  })

  test('a replacement job cannot be overwritten by recovery of a prior execution', async () => {
    const db = scope.db,
      root = home(),
      first = memoryJournalOperations(db, root)
    const queued = await first.operations.distillCommands.enqueue({
      sourceKind: 'clarify',
      sourceEventId: 'original',
      taskId: null,
      debounceMs: 0,
    })
    if (!queued) throw new Error('original job missing')
    const lost = spyOn(
      DrizzleMemoryDistillExecutionJournal.prototype,
      'settlement',
    ).mockImplementation(async () => {
      throw new Error('original outcome not yet durable')
    })
    try {
      await expect(
        first.operations.distillWorker.tick({ execution: { current: () => true } }),
      ).rejects.toBeInstanceOf(MemoryDistillSettlementPendingError)
    } finally {
      lost.mockRestore()
    }
    await db
      .update(memoryDistillJobs)
      .set({ sourceEventId: 'replacement' })
      .where(eq(memoryDistillJobs.id, queued.jobId))
    const before = (await db.select().from(memoryDistillJobs))[0]
    const restored = memoryJournalOperations(db, root)
    await expect(restored.operations.distillWorker.recoverRunning()).rejects.toThrow(
      'original-recovery-job-mismatch',
    )
    expect((await db.select().from(memoryDistillJobs))[0]).toEqual(before)
    expect(restored.state.calls).toBe(0)
  })
})
