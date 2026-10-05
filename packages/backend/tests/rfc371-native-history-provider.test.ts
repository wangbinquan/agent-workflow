// RFC-371: original before/final pages repair their unique historical ledger owner.
// A 400-row transfer is not a population limit. Continuations and corrections share
// the actual transaction; lost replies and late captures must never double usage.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { nativeUsagePassPages, nativeUsageStepMembers } from '@/db/schema'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import type { OriginalReportDatabaseBinding } from '@/platform/persistence/reportSnapshot'
import { nativeHistoryRead } from '@/platform/persistence/nativeHistoryRead'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageIngestion } from '@/modules/run-observability/application/usageIngestion'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { nativeHistorySeed } from '@/modules/run-observability/domain/nativeUsageHistory'
import {
  createObservationNativeHistory,
  prepareOriginalNativeHistory,
} from '@/modules/task-execution/infrastructure/observationNativeHistory'
import { createObservationNativeScopes } from '@/modules/task-execution/infrastructure/observationNativeScopes'
import { createObservationUsageSource } from '@/modules/task-execution/infrastructure/observationUsageSource'
import { DrizzleNativeUsageEmission } from '@/modules/task-execution/infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '@/modules/task-execution/infrastructure/drizzleNativeUsageCompletion'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import type { ObservationNativeProcessFact } from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '@/modules/run-observability/domain/usageLedger'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import { originalWorkerFixture } from './helpers/rfc371OriginalWorkerFixture'
import { describeEachProvider } from './helpers/eachProvider'

type Fixture = Awaited<ReturnType<typeof originalNativeLedgerFixture>>
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function originalNativeStore(steps: number) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-history-'))
  const path = join(directory, 'original.db')
  const db = new Database(path)
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => db.close(),
  )
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER); CREATE INDEX session_parent ON session(parent_id,id); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); CREATE INDEX part_session ON part(session_id,id);',
  )
  const bornAt = Date.now(),
    leaf = 'child-80'
  db.transaction(() => {
    db.run('INSERT INTO session VALUES (?,?,?)', ['root', null, bornAt])
    for (let n = 1; n <= 80; n++)
      db.run('INSERT INTO session VALUES (?,?,?)', [
        'child-' + n,
        n === 1 ? 'root' : 'child-' + (n - 1),
        bornAt,
      ])
    db.run('INSERT INTO message VALUES (?,?,?)', [
      'message',
      leaf,
      JSON.stringify({ role: 'assistant', providerID: 'actual-provider', modelID: 'actual-model' }),
    ])
    for (let n = 0; n < steps; n++)
      db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'step-' + String(n).padStart(6, '0'),
        leaf,
        'message',
        bornAt,
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: String(n + 1), cache: { read: 3, write: 5 }, output: 7, reasoning: 11 },
        }),
      ])
  })()
  const revise = (options: { unknownOutput?: boolean; modelConflict?: boolean } = {}) =>
    db.transaction(() => {
      for (let n = 0; n < steps; n++)
        db.run('UPDATE part SET data=? WHERE id=?', [
          JSON.stringify({
            type: 'step-finish',
            tokens: {
              input: String(n + 101),
              cache: { read: 3, write: 5 },
              ...(options.unknownOutput ? {} : { output: 7, reasoning: 11 }),
            },
          }),
          'step-' + String(n).padStart(6, '0'),
        ])
      if (options.modelConflict)
        db.run('UPDATE message SET data=? WHERE id=?', [
          JSON.stringify({
            role: 'assistant',
            providerID: 'actual-provider',
            modelID: 'changed-model',
          }),
          'message',
        ])
    })()
  return { path, bornAt, revise }
}
async function processFacts(f: Fixture, spawned?: ObservationNativeProcessFact) {
  const fact: ObservationNativeProcessFact = spawned
    ? {
        ...spawned,
        phase: 'settled',
        reapedAt: Date.now(),
        drainedAt: Date.now(),
        outcome: 'success',
      }
    : {
        contract: 'native-process-facts-v2',
        phase: 'spawned',
        pid: process.pid,
        launchNonce: randomUUID(),
        spawnedAt: Date.now(),
        reapedAt: null,
        drainedAt: null,
        outcome: null,
        drainTimedOut: false,
        pumpError: false,
      }
  await new DrizzleNativeUsageEmission(f.db).emit({
    binding: f.binding,
    eventId: fact.phase,
    evidence: {
      invocationId: f.binding.invocationId,
      measurements: [],
      diagnostics: [],
      nativeProcess: fact,
    },
  })
  return fact
}
async function seal(f: Fixture) {
  const owner = new DrizzleNativeUsageCompletion(f.db)
  const completion = await owner.describeCompletion({ binding: f.binding, observedAt: Date.now() })
  await owner.seal({ binding: f.binding, completion })
  return completion
}
async function drain(f: Fixture) {
  const project = createUsageSourceProjection({
    source: createObservationUsageSource(f.db),
    store: createUsageLedgerStore(f.db),
    invocations: createObservationInvocationStore(f.db),
  })
  for (;;) if ((await project(f.binding.nodeRunId)) === 0) return
}
async function records(f: Fixture) {
  const store = createUsageLedgerStore(f.db),
    result: UsageLedgerRecord[] = []
  let after: string | undefined
  for (;;) {
    const page = await store.records(f.binding.taskId, { limit: 67, ...(after ? { after } : {}) })
    result.push(...page.items)
    if (!page.nextCursor) return result
    after = page.nextCursor
  }
}
const inputSum = (rows: readonly UsageLedgerRecord[]) =>
  rows.reduce((sum, row) => sum + BigInt(row.measurement.usage.input ?? '0'), 0n)

describeEachProvider('RFC-371 durable original native history writer', (harness) => {
  async function preparePair(
    steps: number,
    delayedOriginalCapture = false,
    finalOptions: { unknownOutput?: boolean; modelConflict?: boolean } = {},
    originalHarness = harness,
  ) {
    const old = await originalNativeLedgerFixture(originalHarness),
      spawn = await processFacts(old),
      native = originalNativeStore(steps)
    await persistNativeUsagePass(old.open(native.path, old.identity('final'), 89), old.owner())
    await processFacts(old, spawn)
    if (!delayedOriginalCapture) expect((await seal(old)).state).toBe('complete')
    await drain(old)
    const original = await records(old)
    expect(original).toHaveLength(steps)
    const resumed = await originalNativeLedgerFixture(originalHarness, 'resume')
    const beforeIdentity = resumed.identity('baseline')
    await persistNativeUsagePass(resumed.open(native.path, beforeIdentity, 89), resumed.owner())
    const resumedSpawn = await processFacts(resumed)
    native.revise(finalOptions)
    const finalIdentity = resumed.identity('final')
    await persistNativeUsagePass(resumed.open(native.path, finalIdentity, 89), resumed.owner())
    await processFacts(resumed, resumedSpawn)
    expect((await seal(resumed)).state).toBe('partial')
    await drain(resumed)
    return { old, resumed, beforeIdentity, finalIdentity, original }
  }
  async function writer(
    resumed: Fixture,
    singleConnection = false,
    original?: OriginalReportDatabaseBinding,
  ) {
    const binding = harness.applicationBinding
    const runtime =
      binding.provider === 'postgresql' && singleConnection
        ? createPostgresqlDatabaseRuntime({
            config: { ...binding.databaseConfig, poolMax: 1 },
            generationId: binding.runtime.generationId,
          })
        : undefined
    const actual: OriginalReportDatabaseBinding =
      original ??
      (runtime
        ? { provider: 'postgresql', runtime }
        : binding.provider === 'sqlite'
          ? { ...binding, generationId: 'original-native-history-harness' }
          : { provider: 'postgresql', runtime: binding.runtime })
    const db = runtime ? createPostgresqlDatabaseClient(runtime) : resumed.db
    const prepare =
      actual.provider === 'postgresql' ||
      (actual.db.$client.filename && actual.db.$client.filename !== ':memory:')
        ? nativeHistoryRead(actual)
        : (value: Parameters<typeof prepareOriginalNativeHistory>[1], signal?: AbortSignal) =>
            originalReportSnapshotSession(actual).run(
              (snapshot) => prepareOriginalNativeHistory(snapshot.executor, value, snapshot),
              signal,
            )
    const history = createObservationNativeHistory(db, prepare),
      store = createUsageLedgerStore(db)
    const ingest = createUsageIngestion(store, createObservationNativeScopes(db), history)
    const receipt = async () => {
      const value = (await store.captures([resumed.binding.invocationId]))[0]
      if (!value) throw new Error('Actual resumed capture is missing')
      return value
    }
    return {
      db,
      store,
      history,
      receipt,
      next: async () => ingest.repairCapture(await receipt()),
      close: async () => {
        if (runtime) await runtime.close()
      },
    }
  }
  async function seedPreparation(w: Awaited<ReturnType<typeof writer>>) {
    const receipt = await w.receipt()
    const preparation = await w.history.prepare({
      invocationId: receipt.invocationId,
      taskId: receipt.taskId,
      capture: receipt.capture,
      sourceId: receipt.sourceId,
      sourceCursor: receipt.sourceCursor,
    })
    if (!preparation) throw new Error('The original full verification did not prepare history')
    await w.store.change(receipt.sourceId, (scope) =>
      scope.commitCapture(
        { invocationId: receipt.invocationId, taskId: receipt.taskId, capture: receipt.capture },
        receipt.sourceCursor,
        receipt.resolutions,
        {
          preparation,
          scanCycle: '0',
          after: null,
          examined: '0',
          resolved: '0',
          unresolved: '0',
          digest: nativeHistorySeed(preparation),
          state: 'walking',
          lastCompleted: null,
        },
      ),
    )
    return preparation
  }

  test('405 original meters and 80 ancestors repair in committed packets, including actual PostgreSQL poolMax1', async () => {
    const pair = await preparePair(405),
      w = await writer(pair.resumed, true)
    try {
      const frozen = (await w.receipt()).capture
      expect(await w.next()).toMatchObject({
        scanCycle: '0',
        examined: '400',
        resolved: '400',
        unresolved: '0',
        state: 'walking',
      })
      // A caller losing the first reply reloads its durable cursor instead of replaying increments.
      expect((await w.receipt()).history?.after).toBe('step-000399')
      expect(await w.next()).toMatchObject({
        examined: '405',
        resolved: '405',
        unresolved: '0',
        state: 'walking',
      })
      expect(await w.next()).toMatchObject({
        examined: '405',
        resolved: '405',
        unresolved: '0',
        state: 'resolved',
      })
      const repaired = await records(pair.old)
      expect(repaired).toHaveLength(405)
      expect(inputSum(repaired)).toBe(122715n)
      for (const row of repaired) {
        const original = pair.original.find(
          (value) => value.measurement.recordId === row.measurement.recordId,
        )!
        expect(row.measurement).toMatchObject({
          invocationId: original.measurement.invocationId,
          taskId: original.measurement.taskId,
          agentId: original.measurement.agentId,
          nodeRunId: original.measurement.nodeRunId,
          occurredAt: original.measurement.occurredAt,
          scope: original.measurement.scope,
          basis: original.measurement.basis,
          usage: { cacheRead: '3', cacheWrite: '5', output: '18' },
        })
        expect(row.observedRevision).toBe(original.observedRevision + 1)
        expect(row.nativeScopeFacts?.depth).toBe('80')
      }
      expect(await records(pair.resumed)).toEqual([])
      expect((await w.receipt()).capture).toEqual(frozen)
      expect(await w.next()).toMatchObject({ state: 'resolved', examined: '405' })
      expect(await records(pair.old)).toEqual(repaired)
      // Only the still-valid original producer may recheck the ledger and seal completion.
      expect((await seal(pair.resumed)).state).toBe('complete')
    } finally {
      await w.close()
    }
  }, 180_000)

  test('the real file/channel Worker releases its original reader before the ledger writer starts', async () => {
    const original = await originalWorkerFixture(harness, { attempts: 0, records: 0 })
    try {
      const pair = await preparePair(2, false, {}, { ...harness, db: original.db })
      const w = await writer(pair.resumed, false, original.binding)
      const start = original.events.length
      const participant = composeLocalInvocationObservations(
        original.db,
        createObservationUsageSource(original.db, w.history.prepare),
      )
      expect(participant.reconcileNativeHistory).toBeDefined()
      await expect(
        participant.reconcileNativeHistory!('missing-native-invocation'),
      ).rejects.toThrow()
      expect(
        await participant.reconcileNativeHistory!(pair.resumed.binding.invocationId),
      ).toMatchObject({ examined: '2', resolved: '2', state: 'walking' })
      if (original.binding.provider === 'postgresql') {
        const actual = original.events.slice(start)
        const released = actual.indexOf('reader-released')
        expect(released).toBeGreaterThanOrEqual(0)
        expect(actual.indexOf('reserved', released + 1)).toBeGreaterThan(released)
      }
      expect(await w.next()).toMatchObject({ state: 'resolved' })
      expect(inputSum(await records(pair.old))).toBe(203n)
      expect(await records(pair.resumed)).toEqual([])
    } finally {
      await original.close()
    }
  }, 90_000)

  test('a late original capture starts another complete scan and never counts previously committed meters twice', async () => {
    const pair = await preparePair(3, true),
      first = await writer(pair.resumed)
    expect(await first.next()).toMatchObject({
      examined: '3',
      resolved: '0',
      unresolved: '3',
      state: 'walking',
    })
    expect(await first.next()).toMatchObject({
      scanCycle: '0',
      state: 'pending',
      lastCompleted: { examined: '3', unresolved: '3' },
    })
    expect(inputSum(await records(pair.old))).toBe(6n)
    expect((await seal(pair.old)).state).toBe('complete')
    await drain(pair.old)
    const restarted = await writer(pair.resumed)
    expect(await restarted.next()).toMatchObject({
      scanCycle: '1',
      examined: '3',
      resolved: '3',
      unresolved: '0',
      state: 'walking',
    })
    expect(await restarted.next()).toMatchObject({ scanCycle: '1', state: 'resolved' })
    const actual = await records(pair.old)
    expect(inputSum(actual)).toBe(306n)
    expect(await restarted.next()).toMatchObject({ state: 'resolved' })
    expect(await records(pair.old)).toEqual(actual)
    expect(await records(pair.resumed)).toEqual([])
  }, 90_000)

  test('a missing middle member cannot close EOF; restoring the original row re-verifies and rescans all members', async () => {
    const pair = await preparePair(3),
      w = await writer(pair.resumed)
    await seedPreparation(w)
    const where = and(
      eq(nativeUsageStepMembers.passId, pair.beforeIdentity.passId),
      eq(nativeUsageStepMembers.stepId, 'step-000001'),
    )
    const saved = (
      await pair.resumed.db.select().from(nativeUsageStepMembers).where(where).limit(1)
    )[0]!
    await pair.resumed.db.delete(nativeUsageStepMembers).where(where).run()
    expect(await w.next()).toMatchObject({ examined: '2', resolved: '2', state: 'walking' })
    expect(await w.next()).toMatchObject({ examined: '2', state: 'pending' })
    await expect(w.next()).rejects.toThrow()
    expect((await w.receipt()).history?.state).toBe('pending')
    expect(inputSum(await records(pair.old))).toBe(206n)
    await pair.resumed.db.insert(nativeUsageStepMembers).values(saved).run()
    expect(await w.next()).toMatchObject({
      scanCycle: '1',
      examined: '3',
      resolved: '3',
      state: 'walking',
    })
    expect(await w.next()).toMatchObject({ state: 'resolved', examined: '3' })
    expect(inputSum(await records(pair.old))).toBe(306n)
    expect(await records(pair.resumed)).toEqual([])
  }, 90_000)

  test('a changed original page rolls back every correction and continuation in the actual writer transaction', async () => {
    const pair = await preparePair(3),
      w = await writer(pair.resumed)
    await seedPreparation(w)
    const before = await w.receipt()
    const where = eq(nativeUsagePassPages.passId, pair.finalIdentity.passId)
    const page = (
      await pair.resumed.db.select().from(nativeUsagePassPages).where(where).limit(1)
    )[0]!
    const document = JSON.parse(page.document)
    document.payloadDigest = '0'.repeat(64)
    await pair.resumed.db
      .update(nativeUsagePassPages)
      .set({ document: JSON.stringify(document) })
      .where(and(where, eq(nativeUsagePassPages.ordinal, page.ordinal)))
      .run()
    await expect(w.next()).rejects.toThrow()
    expect(await w.receipt()).toEqual(before)
    expect(await records(pair.old)).toEqual(pair.original)
    expect(await records(pair.resumed)).toEqual([])
  }, 90_000)

  test('actual model conflict stays unresolved and preserves all original known numbers and attribution', async () => {
    const pair = await preparePair(2, false, { modelConflict: true }),
      w = await writer(pair.resumed)
    expect(await w.next()).toMatchObject({
      examined: '2',
      resolved: '0',
      unresolved: '2',
      state: 'walking',
    })
    expect(await w.next()).toMatchObject({ state: 'pending' })
    expect(await records(pair.old)).toEqual(pair.original)
    expect(await records(pair.resumed)).toEqual([])
    expect((await w.receipt()).capture.state).toBe('partial')
  }, 90_000)

  test('an unknown final output retains received input revisions and previous output without resolving the missing bucket', async () => {
    const pair = await preparePair(2, false, { unknownOutput: true }),
      w = await writer(pair.resumed)
    expect(await w.next()).toMatchObject({
      examined: '2',
      resolved: '0',
      unresolved: '2',
      state: 'walking',
    })
    expect(await w.next()).toMatchObject({ state: 'pending' })
    const revised = await records(pair.old)
    expect(inputSum(revised)).toBe(203n)
    for (const row of revised) {
      const original = pair.original.find(
        (value) => value.measurement.recordId === row.measurement.recordId,
      )!
      expect(row.measurement.usage.output).toBe('18')
      expect(row.contribution.output).toBe('18')
      expect(row.coveredThrough?.output).toBe(original.coveredThrough?.output)
      expect(row.coveredThrough?.input).toBe(
        row.measurement.coveredThroughTurn ?? row.measurement.scope!.turnIndex,
      )
      expect(row.observedRevision).toBe(original.observedRevision + 1)
      expect(row.complete).toBe(false)
    }
    expect(await w.next()).toMatchObject({ scanCycle: '1', state: 'walking', unresolved: '2' })
    expect(await w.next()).toMatchObject({ state: 'pending' })
    expect(await records(pair.old)).toEqual(revised)
    expect(await records(pair.resumed)).toEqual([])
    expect((await w.receipt()).capture.state).toBe('partial')
  }, 90_000)
})
