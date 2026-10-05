// RFC-371: committed v2 source pages must reach the original ledger, full ancestry and report.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { taskExecutionObservationSources, nativeUsageSessionParents } from '@/db/schema'
import { buildActor } from '@/auth/actor'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { DrizzleNativeUsageEmission } from '@/modules/task-execution/infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '@/modules/task-execution/infrastructure/drizzleNativeUsageCompletion'
import { createObservationUsageSource } from '@/modules/task-execution/infrastructure/observationUsageSource'
import { createObservationNativeScopes } from '@/modules/task-execution/infrastructure/observationNativeScopes'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageIngestion } from '@/modules/run-observability/application/usageIngestion'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { buildCompleteObservationTask } from '@/modules/run-observability/application/completeObservationTask'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import {
  parseObservationCapturedUsage,
  ObservationNativeEmissionSchema,
} from '@agent-workflow/shared'
import type {
  ObservationNativeProcessFact,
  ObservationNativeMeasurement,
} from '@agent-workflow/shared'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import { describeEachProvider } from './helpers/eachProvider'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function nativeStore(steps: number, unknownOutput = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-ledger-')),
    path = join(directory, 'original.db')
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
          tokens: {
            input: String(n + 1),
            cache: { read: 3, write: 5 },
            ...(unknownOutput ? {} : { output: 7, reasoning: 11 }),
          },
        }),
      ])
  })()
  return { path, bornAt, db }
}
const actor = buildActor({
  source: 'session',
  user: {
    id: 'native-reader',
    username: 'native-reader',
    displayName: 'Native reader',
    role: 'admin',
    status: 'active',
  },
})

describeEachProvider('RFC-371 original native ledger projection and complete report', (harness) => {
  const projectFor = (f: Awaited<ReturnType<typeof originalNativeLedgerFixture>>) =>
    createUsageSourceProjection({
      source: createObservationUsageSource(f.db),
      store: createUsageLedgerStore(f.db),
      invocations: createObservationInvocationStore(f.db),
    })
  async function drain(f: Awaited<ReturnType<typeof originalNativeLedgerFixture>>) {
    const project = projectFor(f)
    let count = 0
    for (;;) {
      const next = await project(f.binding.nodeRunId)
      count += next
      if (next === 0) return count
    }
  }
  async function processFacts(
    f: Awaited<ReturnType<typeof originalNativeLedgerFixture>>,
    settled = false,
    spawn?: ObservationNativeProcessFact,
  ) {
    const original: ObservationNativeProcessFact = spawn ?? {
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
    const fact: ObservationNativeProcessFact = settled
      ? {
          ...original,
          phase: 'settled',
          reapedAt: Date.now(),
          drainedAt: Date.now(),
          outcome: 'success',
        }
      : original
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
  async function report(f: Awaited<ReturnType<typeof originalNativeLedgerFixture>>) {
    const binding = harness.applicationBinding
    const snapshot = originalReportSnapshotSession(
      binding.provider === 'sqlite'
        ? { ...binding, generationId: 'native-ledger-report' }
        : { provider: 'postgresql', runtime: binding.runtime },
    )
    return snapshot.run(async ({ executor, workspace, snapshotId }) => {
      const owner = createTaskObservationFacts(executor),
        task = await owner.get(actor, f.binding.taskId)
      if (!task) throw Error('Original Task missing')
      const value = completeObservationValuation({
        db: executor,
        rows: workspace,
        namespace: 'native-value',
      })
      const result = await buildCompleteObservationTask({
        task,
        sources: createCompleteObservationSources({
          db: executor,
          tasks: owner,
          snapshotId,
          pageSize: 61,
        }),
        asOf: Date.now(),
        rows: workspace,
        namespace: 'native-task',
        keyOf: sha256Hex,
        usageWorkspace: completeUsageWorkspace,
        value: value.value,
      })
      await value.flush()
      return result
    })
  }
  async function seal(f: Awaited<ReturnType<typeof originalNativeLedgerFixture>>) {
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    await completion.seal({ binding: f.binding, completion: proof })
    return proof
  }

  test('original native ledger transaction completes with PostgreSQL poolMax1 and no second reader connection', async () => {
    const f = await originalNativeLedgerFixture(harness),
      spawn = await processFacts(f),
      native = nativeStore(1)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    await processFacts(f, true, spawn)
    expect((await seal(f)).state).toBe('complete')
    const binding = harness.applicationBinding
    const runtime =
      binding.provider === 'postgresql'
        ? createPostgresqlDatabaseRuntime({
            config: { ...binding.databaseConfig, poolMax: 1 },
            generationId: binding.runtime.generationId,
          })
        : undefined
    try {
      const db = runtime ? createPostgresqlDatabaseClient(runtime) : f.db
      const source = createObservationUsageSource(db),
        store = createUsageLedgerStore(db),
        project = createUsageSourceProjection({
          source,
          store,
          invocations: createObservationInvocationStore(db),
        })
      let projected = 0
      for (;;) {
        const count = await project(f.binding.nodeRunId)
        projected += count
        if (count === 0) break
      }
      expect(projected).toBeGreaterThan(0)
      expect(await source.pending({ limit: 10, nodeRunId: f.binding.nodeRunId })).toEqual([])
      const records = (await store.records(f.binding.taskId, { limit: 10 })).items
      expect(records).toHaveLength(1)
      expect(records[0]?.nativeScopeFacts?.depth).toBe('80')
      const metrics = (await report(f)).summary.metrics
      expect(metrics.state).toBe('ready')
      if (metrics.state !== 'ready') throw Error('Single-connection native projection lost EOF')
      expect(metrics.tokens).toEqual({
        input: '1',
        cacheRead: '3',
        cacheWrite: '5',
        output: '18',
        total: '27',
      })
      expect(metrics.cost).toEqual({ currency: 'CNY', state: 'unpriced', amount: null })
      if (runtime) expect(runtime.telemetry().poolWait.failedCount).toBe(0)
    } finally {
      await runtime?.close()
    }
  }, 30000)

  test('all1001 steps at depth80 survive source ACK, projection, full report and original classification', async () => {
    const f = await originalNativeLedgerFixture(harness),
      spawn = await processFacts(f),
      native = nativeStore(1001)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    await processFacts(f, true, spawn)
    const proof = await seal(f)
    expect(proof.state).toBe('complete')
    const projection = await drain(f)
    expect(projection).toBeGreaterThan(0)
    const store = createUsageLedgerStore(f.db),
      records: Awaited<ReturnType<typeof store.records>>['items'][number][] = []
    let after: string | undefined
    for (;;) {
      const page = await store.records(f.binding.taskId, {
        limit: 200,
        ...(after === undefined ? {} : { after }),
      })
      records.push(...page.items)
      if (page.nextCursor === undefined) break
      after = page.nextCursor
    }
    expect(records).toHaveLength(1001)
    expect(records.every((row) => row.complete && row.nativeScopeFacts?.depth === '80')).toBe(true)
    const summary = (await report(f)).summary.metrics
    expect(summary.state).toBe('ready')
    if (summary.state !== 'ready') throw Error('Original complete numeric report unavailable')
    expect(summary.records).toBe('1001')
    expect(summary.tokens).toEqual({
      input: String((1001n * 1002n) / 2n),
      cacheRead: '3003',
      cacheWrite: '5005',
      output: '18018',
      total: String((1001n * 1002n) / 2n + 26026n),
    })
    expect(summary.cost).toEqual({ currency: 'CNY', state: 'unpriced', amount: null })
    const pending = await createObservationUsageSource(f.db).pending({
      limit: 10,
      nodeRunId: f.binding.nodeRunId,
    })
    expect(pending).toEqual([])
  }, 120000)

  test('real process-only source pages and an empty final EOF retain known zero', async () => {
    const f = await originalNativeLedgerFixture(harness),
      spawn = await processFacts(f),
      native = nativeStore(0)
    const first = await drain(f)
    expect(first).toBe(1)
    expect(await createUsageLedgerStore(f.db).cursor('local-node:' + f.binding.nodeRunId)).toMatch(
      /^node-event:/,
    )
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    await processFacts(f, true, spawn)
    expect((await seal(f)).state).toBe('complete')
    await drain(f)
    const summary = (await report(f)).summary.metrics
    expect(summary.state).toBe('ready')
    if (summary.state !== 'ready') throw Error('Original empty EOF lost')
    expect(summary.tokens).toEqual({
      input: '0',
      cacheRead: '0',
      cacheWrite: '0',
      output: '0',
      total: '0',
    })
  }, 30000)

  test('partial completion and an unknown output bucket retain every received input and cache number', async () => {
    const f = await originalNativeLedgerFixture(harness),
      spawn = await processFacts(f),
      native = nativeStore(2, true)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    const proof = await seal(f)
    expect(proof.state).toBe('partial')
    expect(proof.issues).toContain('native-token-bucket-unknown')
    await drain(f)
    const first = (await report(f)).summary.metrics
    expect(first.state).toBe('not-ready')
    if (first.state !== 'not-ready') throw Error('Partial source was marked complete')
    expect(first.recordedUsage?.tokens).toEqual({
      input: '3',
      cacheRead: '6',
      cacheWrite: '10',
      output: null,
      total: null,
    })
    await processFacts(f, true, spawn)
    const next = await seal(f)
    expect(next.state).toBe('partial')
    await drain(f)
    const later = (await report(f)).summary.metrics
    expect(later.state).toBe('not-ready')
    if (later.state !== 'not-ready') throw Error('Missing output was filled in')
    expect(later.recordedUsage?.tokens).toEqual(first.recordedUsage?.tokens)
  }, 30000)

  test('later original page references advance revisions without changing semantic identity', async () => {
    const f = await originalNativeLedgerFixture(harness),
      spawn = await processFacts(f),
      native = nativeStore(2)
    const final = await persistNativeUsagePass(
      f.open(native.path, f.identity('final'), 1),
      f.owner(),
    )
    const source = (
      await f.db
        .select()
        .from(taskExecutionObservationSources)
        .where(eq(taskExecutionObservationSources.taskId, f.binding.taskId))
    ).find(
      (row) =>
        ObservationNativeEmissionSchema.safeParse(JSON.parse(row.evidenceJson)).data?.measurements
          .length,
    )
    if (!source) throw Error('Original native numeric frame missing')
    const raw = ObservationNativeEmissionSchema.parse(JSON.parse(source.evidenceJson)),
      m = raw.measurements[0] as ObservationNativeMeasurement
    const emitter = new DrizzleNativeUsageEmission(f.db)
    const later = {
      ...m,
      scope: {
        ...m.scope,
        ancestry: {
          ...m.scope.ancestry,
          pageOrdinal: final.ordinal,
          cumulativeDigest: final.cumulativeDigest,
        },
      },
    }
    await emitter.emit({
      binding: f.binding,
      eventId: 'original-partial',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [{ ...later, coverage: 'partial' }],
        diagnostics: [],
      },
    })
    await emitter.emit({
      binding: f.binding,
      eventId: 'original-complete',
      evidence: { invocationId: f.binding.invocationId, measurements: [later], diagnostics: [] },
    })
    await processFacts(f, true, spawn)
    expect((await seal(f)).state).toBe('complete')
    await drain(f)
    const rows = await createUsageLedgerStore(f.db).records(f.binding.taskId, { limit: 100 })
    const retained = rows.items.find((row) => row.measurement.recordId === m.recordId)
    expect(retained?.observedRevision).toBeGreaterThan(m.revision)
    expect(retained?.issues).toEqual([])
    expect(retained?.complete).toBe(true)
    expect(retained?.contribution).toEqual(m.usage)
    expect((await report(f)).summary.metrics.state).toBe('ready')
  }, 30000)

  test('a changed original numeric frame cannot advance any ledger cursor or receive delivery ACK', async () => {
    const f = await originalNativeLedgerFixture(harness),
      native = nativeStore(1)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    const source = (
      await f.db
        .select()
        .from(taskExecutionObservationSources)
        .where(eq(taskExecutionObservationSources.taskId, f.binding.taskId))
    )[0]!
    const evidence = parseObservationCapturedUsage(JSON.parse(source.evidenceJson)),
      measurement = evidence.measurements[0]!
    const sourceId = 'local-node:' + f.binding.nodeRunId,
      store = createUsageLedgerStore(f.db),
      ingest = createUsageIngestion(store, createObservationNativeScopes(f.db))
    await expect(
      ingest.ingest({
        sourceId,
        expectedCursor: 'node-event:' + (source.id + 1),
        nextCursor: 'node-event:' + source.id,
        nativeWatermark: source.id,
        nativeSource: 'actual-native-store',
        events: [{ eventId: source.id + ':0', measurement }],
      }),
    ).rejects.toThrow('did not advance its original source watermark')
    await expect(
      ingest.ingest({
        sourceId,
        expectedCursor: null,
        nextCursor: 'node-event:' + source.id,
        nativeWatermark: source.id,
        nativeSource: 'actual-native-store',
        events: [
          {
            eventId: source.id + ':0',
            measurement: { ...measurement, usage: { ...measurement.usage, input: '999' } },
          },
        ],
      }),
    ).rejects.toThrow('frozen original source')
    expect(await store.cursor(sourceId)).toBeNull()
    expect((await store.records(f.binding.taskId, { limit: 100 })).items).toEqual([])
    expect(
      (
        await createObservationUsageSource(f.db).pending({
          limit: 100,
          nodeRunId: f.binding.nodeRunId,
        })
      ).length,
    ).toBeGreaterThan(0)
  }, 30000)

  test('a removed actual parent link is detected before report completeness', async () => {
    const f = await originalNativeLedgerFixture(harness),
      native = nativeStore(1)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 81), f.owner())
    await drain(f)
    await f.db
      .delete(nativeUsageSessionParents)
      .where(eq(nativeUsageSessionParents.sessionId, 'child-40'))
    await expect(report(f)).rejects.toThrow('unpersisted parent')
  }, 30000)
})
