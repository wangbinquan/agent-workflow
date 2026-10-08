// RFC-371: original System calls must use the full native producer and the unique ledger,
// with no synthetic Task rows/claims. Real child processes write the original native file.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ObservationNativeRootCompletionSchema } from '@agent-workflow/shared'
import {
  tasks,
  taskExecutionOwners,
  systemAgentObservationOwners,
  systemAgentObservationSources,
} from '@/db/schema'
import { systemAgentNativeUsage } from '@/db/observationSystem'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/composition/nativeUsageInvocation'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { createOpencodeNativeUsageCapture } from '@/modules/runtime-management/composition/nativeUsageCapture'
import { bindLocalAgentExecutionEffect } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createObservationPriceStore } from '@/modules/run-observability/infrastructure/pricingPersistence'
import { createObservationPricing } from '@/modules/run-observability/application/pricing'
import { createInvocationValuation } from '@/modules/run-observability/application/invocationValuation'
import { sumCnyAmounts } from '@/modules/run-observability/domain/cnyPricing'
import { createCombinedObservationNativeHistory } from '@/modules/task-execution/infrastructure/observationNativeSources'
import { prepareOriginalNativeHistory } from '@/modules/task-execution/infrastructure/observationNativeHistory'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { describeEachProvider } from './helpers/eachProvider'

const child = `import {Database} from 'bun:sqlite';const db=new Database(process.argv[2]);
const append=process.argv[3]==='append',missing=process.argv[3]==='missing';
db.transaction(()=>{for(const root of (append?['root']:['root','reset'])){
if(!append){db.run('INSERT INTO session VALUES (?,?,?)',[root,null,Date.now()]);
for(let n=1;n<=151;n++)db.run('INSERT INTO session VALUES (?,?,?)',[root+'-child-'+n,n<43&&n>1?root+'-child-'+(n-1):root,Date.now()]);
db.run('INSERT INTO message VALUES (?,?,?)',[root+'-message',root+'-child-42',JSON.stringify({role:'assistant',providerID:'actual-provider',modelID:'actual-model'})]);}
for(let n=append?211:0;n<(append?214:211);n++)db.run('INSERT INTO part VALUES (?,?,?,?,?)',[root+'-step-'+String(n).padStart(6,'0'),root+'-child-42',root+'-message',Date.now(),JSON.stringify({type:'step-finish',tokens:{input:1,...(missing&&n===210?{}:{output:7,reasoning:11}),cache:{read:3,write:5}}})]);}})();db.close();
for(const root of (append?['root']:['root','reset']))process.stdout.write(JSON.stringify({sessionId:root})+'\\n');`

describeEachProvider('RFC-371 original independent System native execution', (harness) => {
  async function execute(mode: 'fresh' | 'missing' | 'resume') {
    const folder = mkdtempSync(join(tmpdir(), 'aw-system-original-native-'))
    const path = join(folder, 'original.db'),
      script = join(folder, 'child.ts')
    const file = new Database(path)
    file.exec(
      'PRAGMA journal_mode=WAL;CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);CREATE INDEX session_parent ON session(parent_id,id);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);CREATE INDEX part_session ON part(session_id,id);',
    )
    file.close()
    writeFileSync(script, child)
    const db = harness.db
    const beforeTasks = await db.select().from(tasks),
      beforeClaims = await db.select().from(taskExecutionOwners)
    const actual = harness.applicationBinding
    const source =
      actual.provider === 'sqlite'
        ? { ...actual, generationId: 'original-system-native-test' }
        : { provider: 'postgresql' as const, runtime: actual.runtime }
    const prepare = (
      value: Parameters<typeof prepareOriginalNativeHistory>[1],
      signal?: AbortSignal,
    ) =>
      originalReportSnapshotSession(source).run(
        (snapshot) => prepareOriginalNativeHistory(snapshot.executor, value, snapshot),
        signal,
      )
    const observations = composeLocalInvocationObservations(db, {
      ...composeObservationUsageSource(db),
      nativeHistory: createCombinedObservationNativeHistory(db, prepare),
    })
    const runtime = {
      registrationId: 'system-native-runtime',
      configurationRevision: 1,
      acceptedName: 'Acceptance runtime',
    }
    const priceStore = createObservationPriceStore(db),
      baseTime = Date.now() - 1000
    let priceSerial = 0
    const pricing = createObservationPricing({
      store: priceStore,
      runtimes: {
        directory: async () => ({
          runtimes: [
            {
              ...runtime,
              name: 'Acceptance runtime',
              protocol: 'opencode' as const,
              model: 'actual-model',
              enabled: true,
            },
          ],
        }),
      },
      now: () => baseTime - 1000,
      newId: () => 'system-acceptance-price-' + ++priceSerial,
    })
    const price = {
      expectedRevision: 0,
      requestKey: 'system-acceptance-rates',
      configurationRevision: 1,
      protocol: 'opencode' as const,
      provider: 'actual-provider',
      model: 'actual-model',
      condition: null,
      currency: 'CNY' as const,
      rates: { input: '2', cacheRead: '0.5', cacheWrite: '3', output: '8' },
      effectiveFrom: new Date(baseTime).toISOString(),
      sourceNote: 'Acceptance fixture only; not a supplier bill',
    }
    const firstPrice = await pricing.commands.save(
      runtime.registrationId,
      price,
      'acceptance-reader',
    )
    const factory = composeSystemAgentObservations({
      db,
      observations,
      nativeUsage: createNativeUsageInvocationPersistence(db, { rootSets: true }),
    })
    const runs = []
    try {
      for (const round of mode === 'resume' ? [0, 1] : [0]) {
        const run = await factory.open({
          feature: 'memory-distiller',
          agentName: 'aw-memory-distiller',
          protocol: 'opencode',
          runtimeObservationIdentity: runtime,
          startedAt: Date.now(),
          demand: {
            kind: 'memory-distill',
            originalId: folder,
            originalAttempt: `1:${round}`,
            name: 'Original memory job',
            purpose: 'memory',
          },
          ...(round ? { resumeSessionId: 'root' } : {}),
        })
        const capture = createOpencodeNativeUsageCapture({
          path,
          invocationId: run.invocationId,
          taskId: run.taskId,
          nodeRunId: run.nodeRunId,
          agentId: run.agentId,
          durableOwner: run.durableOwner,
          ...(round ? { resumeSessionId: 'root' } : {}),
        })
        const local = bindLocalAgentExecutionEffect({
          materialRef: 'original-system-child',
          command: () => [process.execPath, script, path, round ? 'append' : mode],
          workingDirectory: () => folder,
          environment: () => ({ ...process.env }) as Record<string, string>,
          stdin: () => undefined,
          requireSpawnReceipt: true,
          observeNativeProcess: async (fact) => {
            await run.process(fact)
            await capture.recordProcess!(fact)
          },
        })
        let previous: string | undefined
        const result = await local.effect.submit({
          executionRef: local.executionRef,
          materialRef: local.materialRef,
          workspaceRef: local.workspaceRef,
          beforeStart: async () => {
            await run.accept({
              nativeCaptureContract: capture.contract,
              nativeCaptureSource: capture.nativeSource,
            })
            await capture.beginDurable!()
          },
          capture: {
            onStdoutLine: async (line) => {
              const sessionId = (JSON.parse(line) as { sessionId: string }).sessionId
              await run.root(sessionId, previous)
              previous = sessionId
            },
          },
        })
        expect(result.outcome).toBe('ok')
        await run.finalize(capture, previous ?? null)
        await run.settle('ok', Date.now())
        const ledger = createUsageLedgerStore(db),
          rows = []
        let after: string | undefined
        for (;;) {
          const page = await ledger.records(run.taskId, { limit: 97, ...(after ? { after } : {}) })
          rows.push(
            ...page.items.filter((row) => row.measurement.invocationId === run.invocationId),
          )
          if (!page.nextCursor) break
          after = page.nextCursor
        }
        const receipt = (await ledger.captures([run.invocationId]))[0]!
        const originalRoot = await db
          .select()
          .from(systemAgentNativeUsage.nativeUsageRootHeads)
          .where(eq(systemAgentNativeUsage.nativeUsageRootHeads.invocationId, run.invocationId))
          .get()
        expect(originalRoot?.protocol).toBe('opencode')
        runs.push({
          run,
          rows,
          proof: ObservationNativeRootCompletionSchema.parse(receipt.capture),
          receipt,
        })
        expect(
          await db
            .select()
            .from(systemAgentObservationSources)
            .where(eq(systemAgentObservationSources.pending, true)),
        ).toEqual([])
      }
      expect(await db.select().from(tasks)).toEqual(beforeTasks)
      expect(await db.select().from(taskExecutionOwners)).toEqual(beforeClaims)
      await pricing.commands.save(
        runtime.registrationId,
        {
          ...price,
          expectedRevision: 1,
          requestKey: 'later-system-acceptance-rates',
          effectiveFrom: new Date(baseTime + 1).toISOString(),
          rates: { input: '200', cacheRead: '50', cacheWrite: '300', output: '800' },
        },
        'acceptance-reader',
      )
      const value = createInvocationValuation(createObservationInvocationStore(db), priceStore)
      for (const actualRun of runs)
        for (const row of actualRun.rows) {
          const cost = await value({
            invocationId: actualRun.run.invocationId,
            model: row.measurement.model,
            condition: null,
            usage: row.contribution,
          })
          expect(cost.availability).toBe('priced')
          if (cost.availability === 'priced') expect(cost.priceVersionId).toBe(firstPrice.id)
        }
      return runs
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }

  test('every child beyond128 sessions and depth32, both actual roots and all422 steps reach the original numeric EOF', async () => {
    const [actual] = await execute('fresh')
    expect(actual!.rows).toHaveLength(422)
    expect(new Set(actual!.rows.map((row) => row.measurement.recordId)).size).toBe(422)
    expect(actual!.proof.state).toBe('complete')
    expect(actual!.proof.roots.transitions).toBe('2')
    expect(actual!.receipt.sourceId).toBe('system-agent:' + actual!.run.nodeRunId)
    const totals = { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n }
    for (const row of actual!.rows)
      for (const bucket of Object.keys(totals) as (keyof typeof totals)[])
        totals[bucket] += BigInt(row.contribution[bucket] ?? '0')
    expect(totals).toEqual({ input: 422n, cacheRead: 1266n, cacheWrite: 2110n, output: 7596n })
    const value = createInvocationValuation(
      createObservationInvocationStore(harness.db),
      createObservationPriceStore(harness.db),
    )
    const amounts = []
    for (const row of actual!.rows) {
      const cost = await value({
        invocationId: actual!.run.invocationId,
        model: row.measurement.model,
        condition: null,
        usage: row.contribution,
      })
      if (cost.availability !== 'priced' || cost.amountDecimal === null)
        throw new Error('Original System cost was not priced')
      amounts.push(cost.amountDecimal)
    }
    expect(sumCnyAmounts(amounts)).toBe('0.068575')
  }, 120000)

  test('a new original System attempt resumes the same native root, charges only three new steps and retains both attempts', async () => {
    const actual = await execute('resume')
    expect(actual).toHaveLength(2)
    expect(actual[0]!.run.taskId).toBe(actual[1]!.run.taskId)
    expect(actual[0]!.run.invocationId).not.toBe(actual[1]!.run.invocationId)
    expect(actual[0]!.rows).toHaveLength(422)
    expect(actual[1]!.rows).toHaveLength(3)
    expect(actual[1]!.proof.state).toBe('complete')
    expect(actual[1]!.proof.reconciliation).toMatchObject({
      examined: '211',
      resolved: '211',
      unresolved: '0',
    })
    expect(await harness.db.select().from(systemAgentObservationOwners)).toHaveLength(2)
  }, 120000)

  test('a missing original output bucket retains all422 actual records and a partial proof', async () => {
    const [actual] = await execute('missing')
    expect(actual!.rows).toHaveLength(422)
    expect(actual!.proof.state).toBe('partial')
    expect(actual!.rows.filter((row) => row.measurement.usage.output === null)).toHaveLength(2)
    expect(actual!.rows.filter((row) => row.measurement.usage.input === '1')).toHaveLength(422)
  }, 120000)
})
