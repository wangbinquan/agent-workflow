// RFC-371: the production Task participant consumes actual child process facts and
// full before/final native pages. A second Task repairs the first Task's original ledger.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { nativeUsagePreparations, nativeUsageStoreBindings } from '@/db/schema'
import { createOpencodeNativeUsageCapture } from '@/modules/runtime-management/composition/nativeUsageCapture'
import { opencodeNativeStoreGeneration } from '@/modules/runtime-management/infrastructure/opencodeNativeStoreGeneration'
import { runWithTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { finalizeNativeUsageInvocation } from '@/modules/task-execution/application/finalizeNativeUsageInvocation'
import { bindLocalAgentExecutionEffect } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import {
  createObservationNativeHistory,
  prepareOriginalNativeHistory,
} from '@/modules/task-execution/infrastructure/observationNativeHistory'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { nativeHistoryRead } from '@/platform/persistence/nativeHistoryRead'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderHarness } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import type { UsageLedgerRecord } from '@/modules/run-observability/domain/usageLedger'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
const child = `import { Database } from 'bun:sqlite';
const db = new Database(process.argv[2]);
const resume = process.argv[3] === 'resume', unknown = process.argv[3] === 'unknown';
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER); CREATE INDEX IF NOT EXISTS session_parent ON session(parent_id,id); CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE IF NOT EXISTS part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); CREATE INDEX IF NOT EXISTS part_session ON part(session_id,id);');
db.transaction(() => {
 if (!resume) {
  db.run('INSERT INTO session VALUES (?,?,?)', ['root', null, Date.now()]);
  db.run('INSERT INTO message VALUES (?,?,?)', ['message', 'root', JSON.stringify({role:'assistant',providerID:'actual-provider',modelID:'actual-model'})]);
 }
 if (resume) for (let n=1;n<=1001;n++) db.run('UPDATE part SET data=? WHERE id=?', [
  JSON.stringify({type:'step-finish',tokens:{input:n+100,output:3,reasoning:2,cache:{read:7,write:13}}}),
  'step-'+String(n).padStart(6,'0')]);
 for (let n=resume?1002:1;n<=(resume?1005:1001);n++) db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
  'step-'+String(n).padStart(6,'0'),'root','message',Date.now(),
  JSON.stringify({type:'step-finish',tokens:{input:n,...(unknown?{}:{output:3,reasoning:2}),cache:{read:7,write:13}}})]);
})();
db.close();process.stdout.write('original root: root\\n');`

function store(precreate = true) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-producer-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'original.db'),
    script = join(directory, 'agent.ts')
  if (precreate) {
    const db = new Database(path)
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER); CREATE INDEX session_parent ON session(parent_id,id); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); CREATE INDEX part_session ON part(session_id,id);',
    )
    db.close()
  }
  writeFileSync(script, child)
  return {
    directory,
    path,
    script,
    source: sha256Hex(JSON.stringify(['opencode-native-db', path])),
  }
}
async function allRecords(ledger: ReturnType<typeof createUsageLedgerStore>, taskId: string) {
  const result: UsageLedgerRecord[] = []
  let after: string | undefined
  for (;;) {
    const page = await ledger.records(taskId, { limit: 97, ...(after ? { after } : {}) })
    result.push(...page.items)
    if (!page.nextCursor) return result
    after = page.nextCursor
  }
}

async function observations(harness: ProviderHarness) {
  const actual = harness.applicationBinding
  const original =
    actual.provider === 'sqlite'
      ? { ...actual, generationId: 'original-producer-harness' }
      : { provider: 'postgresql' as const, runtime: actual.runtime }
  const prepare =
    actual.provider === 'postgresql' || actual.db.$client.filename !== ':memory:'
      ? nativeHistoryRead(original)
      : (value: Parameters<typeof prepareOriginalNativeHistory>[1], signal?: AbortSignal) =>
          originalReportSnapshotSession(original).run(
            (snapshot) => prepareOriginalNativeHistory(snapshot.executor, value, snapshot),
            signal,
          )
  const source = composeObservationUsageSource(harness.db)
  return composeLocalInvocationObservations(harness.db, {
    ...source,
    nativeHistory: createObservationNativeHistory(harness.db, prepare),
  })
}

describeEachProvider('RFC-371 original Task native page producer', (harness) => {
  async function execution(native: ReturnType<typeof store>, mode: 'fresh' | 'resume' | 'unknown') {
    const generation = await opencodeNativeStoreGeneration(native.path)
    const f = await originalNativeLedgerFixture(
      harness,
      mode === 'resume' ? 'resume' : 'fresh',
      true,
      {
        source: native.source,
        generation,
        ...(generation === null ? { sourceAbsentAt: Date.now() } : {}),
        producer: true,
      },
    )
    const capture = runWithTaskExecutionContext(f.binding.executionContext, () => {
      const owner = f.persistence.nativeUsage!.forInvocation(f.binding)
      expect(owner).toBeDefined()
      return createOpencodeNativeUsageCapture({
        path: native.path,
        invocationId: f.binding.invocationId,
        taskId: f.binding.taskId,
        nodeRunId: f.binding.nodeRunId,
        agentId: null,
        ...(mode === 'resume' ? { resumeSessionId: 'root' } : {}),
        durableOwner: owner,
      })
    })
    const facts: unknown[] = []
    const nativeExecution = bindLocalAgentExecutionEffect({
      materialRef: 'actual-native-material',
      command: () => [process.execPath, native.script, native.path, mode],
      workingDirectory: () => native.directory,
      environment: () => ({ ...process.env, OPENCODE_DB: native.path }) as Record<string, string>,
      stdin: () => undefined,
      requireSpawnReceipt: true,
      taskEffect: {
        persistence: f.persistence.effects,
        nodeExecution: () => f.persistence.nodeExecution,
        argv: [process.execPath, native.script, native.path, mode],
        cwd: native.directory,
        resourceKeys: [],
        observeNativeProcess: async (fact) => {
          facts.push(fact)
          await capture.recordProcess!(fact)
        },
      },
    })
    const result = await nativeExecution.effect.submit({
      executionRef: nativeExecution.executionRef,
      materialRef: nativeExecution.materialRef,
      workspaceRef: nativeExecution.workspaceRef,
      beforeStart: async () => {
        expect(capture.includesRecord('opencode:step:step-000001')).toBe(true)
        await capture.beginDurable!()
        expect(capture.includesRecord('opencode:step:step-000001')).toBe(false)
      },
      capture: { rawStdout: true },
    })
    expect(result.outcome).toBe('ok')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toContain('original root: root')
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({
      phase: 'spawned',
      pid: expect.any(Number),
      launchNonce: expect.any(String),
      reapedAt: null,
      drainedAt: null,
    })
    expect(facts[1]).toMatchObject({
      phase: 'settled',
      launchNonce: expect.any(String),
      reapedAt: expect.any(Number),
      drainedAt: expect.any(Number),
      outcome: 'ok',
    })
    expect(result).not.toHaveProperty('pid')
    const participant = await observations(harness)
    await finalizeNativeUsageInvocation({
      capture,
      observations: participant,
      invocationId: f.binding.invocationId,
      nodeRunId: f.binding.nodeRunId,
      rootSessionId: 'root',
    })
    return { f, capture, participant, ledger: createUsageLedgerStore(harness.db) }
  }

  test('first actual child creates its previously absent store and all 1001 steps retain an immutable before and actual generation', async () => {
    const native = store(false)
    expect(await opencodeNativeStoreGeneration(native.path)).toBeNull()
    const first = await execution(native, 'fresh')
    expect(first.f.before.sourceGeneration).toBeNull()
    expect(first.f.before.sourceAbsentAt).toEqual(expect.any(Number))
    expect(first.f.before.sourceAbsentAt!).toBeLessThanOrEqual(first.f.before.preparedAt)
    const [prepared] = await harness.db
      .select()
      .from(nativeUsagePreparations)
      .where(eq(nativeUsagePreparations.invocationId, first.f.binding.invocationId))
    expect(prepared!.document).toBe(JSON.stringify(first.f.before))
    expect(prepared!.state).toBe('sealed')
    const generation = await opencodeNativeStoreGeneration(native.path)
    expect(generation).toEqual(expect.any(String))
    const [binding] = await harness.db
      .select()
      .from(nativeUsageStoreBindings)
      .where(eq(nativeUsageStoreBindings.invocationId, first.f.binding.invocationId))
    expect(binding).toEqual({
      invocationId: first.f.binding.invocationId,
      beforeOwnerReceiptId: first.f.before.ownerReceiptId,
      sourceGeneration: generation,
    })
    const rows = await allRecords(first.ledger, first.f.binding.taskId)
    expect(rows).toHaveLength(1001)
    expect(rows.reduce((v, r) => v + BigInt(r.measurement.usage.input!), 0n)).toBe(501501n)
    expect(rows.reduce((v, r) => v + BigInt(r.measurement.usage.output!), 0n)).toBe(5005n)
    expect(rows.reduce((v, r) => v + BigInt(r.measurement.usage.cacheRead!), 0n)).toBe(7007n)
    expect(rows.reduce((v, r) => v + BigInt(r.measurement.usage.cacheWrite!), 0n)).toBe(13013n)
    expect(rows.every((r) => r.measurement.invocationId === first.f.binding.invocationId)).toBe(
      true,
    )
    const proof = (await first.ledger.captures([first.f.binding.invocationId]))[0]!.capture
    expect(proof.contract).toBe('opencode-child-pages-v2')
    if (proof.contract !== 'opencode-child-pages-v2') throw new Error('Wrong native contract')
    expect(proof.state).toBe('complete')
    expect(proof.final!.ack.identity.sourceGeneration).toBe(generation)
    expect(proof.final!.ack.counts.steps).toBe('1001')
    expect(proof.process.spawnedAt!).toBeGreaterThanOrEqual(first.f.before.preparedAt)
    expect(proof.baseline.kind).toBe('fresh')
    if (proof.baseline.kind !== 'fresh') throw new Error('Wrong actual first-store baseline')
    expect(proof.baseline.rootCreatedAt!).toBeGreaterThanOrEqual(proof.process.spawnedAt!)
    await finalizeNativeUsageInvocation({
      capture: first.capture,
      observations: first.participant,
      invocationId: first.f.binding.invocationId,
      nodeRunId: first.f.binding.nodeRunId,
      rootSessionId: 'root',
    })
    expect(await allRecords(first.ledger, first.f.binding.taskId)).toEqual(rows)
  }, 120000)

  test('1001 actual child steps reach the unique four-bucket ledger; resume revises their original Task and emits only four new steps', async () => {
    const native = store(),
      first = await execution(native, 'fresh')
    let records = await allRecords(first.ledger, first.f.binding.taskId)
    expect(records).toHaveLength(1001)
    const sum = (rows: typeof records) =>
      rows.reduce(
        (v, r) => {
          for (const bucket of Object.keys(v) as Array<keyof typeof v>)
            v[bucket] += BigInt(r.measurement.usage[bucket]!)
          return v
        },
        { input: 0n, output: 0n, cacheRead: 0n, cacheWrite: 0n },
      )
    expect(sum(records)).toEqual({
      input: 501501n,
      output: 5005n,
      cacheRead: 7007n,
      cacheWrite: 13013n,
    })
    expect((await first.ledger.captures([first.f.binding.invocationId]))[0]?.capture.state).toBe(
      'complete',
    )
    const resumed = await execution(native, 'resume')
    records = await allRecords(resumed.ledger, resumed.f.binding.taskId)
    expect(records).toHaveLength(4)
    expect(sum(records)).toEqual({ input: 4014n, output: 20n, cacheRead: 28n, cacheWrite: 52n })
    const old = await allRecords(resumed.ledger, first.f.binding.taskId)
    expect(old).toHaveLength(1001)
    expect(sum(old)).toEqual({
      input: 601601n,
      output: 5005n,
      cacheRead: 7007n,
      cacheWrite: 13013n,
    })
    expect(old.every((r) => r.measurement.invocationId === first.f.binding.invocationId)).toBe(true)
    expect(
      (await resumed.ledger.captures([resumed.f.binding.invocationId]))[0]?.capture.state,
    ).toBe('complete')
    await finalizeNativeUsageInvocation({
      capture: resumed.capture,
      observations: resumed.participant,
      invocationId: resumed.f.binding.invocationId,
      nodeRunId: resumed.f.binding.nodeRunId,
      rootSessionId: 'root',
    })
    expect(sum(await allRecords(resumed.ledger, first.f.binding.taskId))).toEqual(sum(old))
    expect(sum(await allRecords(resumed.ledger, resumed.f.binding.taskId))).toEqual(sum(records))
  }, 120000)

  test('unknown output keeps every known input/cache bucket and an explicit partial proof', async () => {
    const native = store(),
      result = await execution(native, 'unknown')
    const rows = await allRecords(result.ledger, result.f.binding.taskId)
    expect(rows).toHaveLength(1001)
    expect(rows.every((r) => r.measurement.usage.output === null)).toBe(true)
    expect(rows.reduce((v, r) => v + BigInt(r.measurement.usage.input!), 0n)).toBe(501501n)
    expect(
      rows.every(
        (r) => r.measurement.usage.cacheRead === '7' && r.measurement.usage.cacheWrite === '13',
      ),
    ).toBe(true)
    expect((await result.ledger.captures([result.f.binding.invocationId]))[0]?.capture.state).toBe(
      'partial',
    )
  }, 120000)
})

test('native generation is stable across WAL writes and changes when the original file is replaced', async () => {
  const native = store(),
    original = await opencodeNativeStoreGeneration(native.path)
  const db = new Database(native.path)
  db.run('INSERT INTO session VALUES (?,?,?)', ['root', null, Date.now()])
  db.close()
  expect(await opencodeNativeStoreGeneration(native.path)).toBe(original)
  renameSync(native.path, native.path + '.original')
  const replacement = new Database(native.path)
  replacement.close()
  expect(await opencodeNativeStoreGeneration(native.path)).not.toBe(original)
  expect(await opencodeNativeStoreGeneration(native.path + '.absent')).toBeNull()
})
