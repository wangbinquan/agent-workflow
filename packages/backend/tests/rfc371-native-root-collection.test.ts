// RFC-371: real child pages and original lease transitions must retain every root,
// even without span collection. A return to the original root must not double usage.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import {
  ObservationNativeCompletionSchema,
  ObservationNativeRootCompletionSchema,
  type ObservationNativeProcessFact,
} from '@agent-workflow/shared'
import type { NativeUsageDurableOwner } from '@/modules/runtime-management/application/ports/nativeUsageCapture'
import {
  nodeRuns,
  nativeUsagePreparations,
  nativeUsageRootHeads,
  nativeUsageRootTransitions,
  nativeUsageRootSets,
  nativeUsageRootResults,
  nativeUsageEmissions,
  taskExecutionObservationSources,
} from '@/db/schema'
import { createOpencodeNativeUsageCapture } from '@/modules/runtime-management/composition/nativeUsageCapture'
import { opencodeNativeStoreGeneration } from '@/modules/runtime-management/infrastructure/opencodeNativeStoreGeneration'
import { runWithTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { finalizeNativeUsageInvocation } from '@/modules/task-execution/application/finalizeNativeUsageInvocation'
import { bindLocalAgentExecutionEffect } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import type { RuntimeSessionLeaseToken } from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createObservationPricing } from '@/modules/run-observability/application/pricing'
import { createObservationPriceStore } from '@/modules/run-observability/infrastructure/pricingPersistence'
import { createInvocationValuation } from '@/modules/run-observability/application/invocationValuation'
import { createObservationNativeScopes } from '@/modules/task-execution/infrastructure/observationNativeScopes'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import { originalNativeObservationParticipant } from './helpers/rfc371NativeObservationParticipant'
import { NATIVE_USAGE_ARCHIVE } from '@/modules/task-execution/infrastructure/nativeUsageArchive'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
const child = `import { Database } from 'bun:sqlite';import { copyFileSync,renameSync } from 'node:fs';
const db=new Database(process.argv[2]), replace=process.argv[3]==='generation-reset', mode=replace?'resume':process.argv[3], roots=Number(process.argv[4]), steps=Number(process.argv[5]);
db.exec('PRAGMA journal_mode=WAL');
db.transaction(()=>{
 for(let r=0;r<roots;r++){
  const root=r===0?'root':(mode==='resume'?'resume-':'reset-')+String(r).padStart(3,'0');
  if(mode!=='resume'||r!==0)db.run('INSERT INTO session VALUES (?,?,?)',[root,null,mode==='wrong-birth'&&r===0?1:Date.now()]);
  const message=root+'-'+mode+'-message';
  db.run('INSERT INTO message VALUES (?,?,?)',[message,root,JSON.stringify({role:'assistant',providerID:'actual-provider',modelID:'actual-model'})]);
  if(mode==='resume'&&r===0)for(const row of db.query('SELECT id FROM part WHERE session_id=?').all(root))db.run('UPDATE part SET data=? WHERE id=?',[JSON.stringify({type:'step-finish',tokens:{input:2,output:7,reasoning:11,cache:{read:3,write:5}}}),row.id]);
  for(let s=0;s<steps;s++)db.run('INSERT INTO part VALUES (?,?,?,?,?)',[root+'-'+mode+'-step-'+String(s).padStart(5,'0'),root,message,Date.now(),JSON.stringify({type:'step-finish',tokens:{input:1,...(mode==='unknown'?{}:{output:7,reasoning:11}),cache:{read:3,write:5}}})]);
 }
})();db.close();if(replace){copyFileSync(process.argv[2],process.argv[2]+'.replacement');renameSync(process.argv[2]+'.replacement',process.argv[2]);}process.stdout.write('actual roots retained\\n');`

function nativeStore() {
  const directory = mkdtempSync(join(tmpdir(), 'aw-native-roots-')),
    path = join(directory, 'original.db'),
    script = join(directory, 'child.ts')
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const db = new Database(path)
  db.exec(
    'PRAGMA journal_mode=WAL;CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);CREATE INDEX session_parent ON session(parent_id,id);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);CREATE INDEX part_session ON part(session_id,id);',
  )
  db.close()
  writeFileSync(script, child)
  return {
    directory,
    path,
    script,
    source: sha256Hex(JSON.stringify(['opencode-native-db', path])),
  }
}

describeEachProvider('RFC-371 original multi-root Task native collection', (harness) => {
  const invocations = () => createObservationInvocationStore(harness.db)
  const ledger = () => createUsageLedgerStore(harness.db)
  const participant = () => originalNativeObservationParticipant(harness)
  async function records(taskId: string) {
    const found = []
    let after: string | undefined
    for (;;) {
      const page = await ledger().records(taskId, { limit: 37, ...(after ? { after } : {}) })
      found.push(...page.items)
      if (!page.nextCursor) return found
      after = page.nextCursor
    }
  }
  async function pricedRuntime() {
    const registrationId = 'acceptance-only-' + randomUUID(),
      clock = Date.now() - 1000
    const runtime = {
      registrationId,
      configurationRevision: 1,
      protocol: 'opencode' as const,
      acceptedName: 'ACCEPTANCE-ONLY-CNY-NOT-SUPPLIER-BILL',
    }
    await createObservationPricing({
      store: createObservationPriceStore(harness.db),
      runtimes: {
        directory: async () => ({
          runtimes: [
            { ...runtime, name: runtime.acceptedName, model: 'actual-model', enabled: true },
          ],
        }),
      },
      now: () => clock,
      newId: () => randomUUID(),
    }).commands.save(
      registrationId,
      {
        expectedRevision: 0,
        requestKey: 'acceptance-rate',
        configurationRevision: 1,
        protocol: 'opencode',
        provider: 'actual-provider',
        model: 'actual-model',
        condition: null,
        currency: 'CNY',
        rates: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
        effectiveFrom: new Date(clock + 1).toISOString(),
        sourceNote: 'ACCEPTANCE-ONLY-CNY-NOT-SUPPLIER-BILL',
      },
      'validation',
    )
    return runtime
  }
  type Fixture = Awaited<ReturnType<typeof originalNativeLedgerFixture>>
  async function execute(
    native: ReturnType<typeof nativeStore>,
    options: {
      roots?: number
      steps?: number
      mode?: 'fresh' | 'resume' | 'unknown' | 'wrong-birth' | 'generation-reset'
      first?: { f: Fixture; lease: RuntimeSessionLeaseToken }
      missingEarlierPage?: boolean
      missingSettled?: boolean
      lateSettled?: boolean
      loseCompletionAck?: boolean
      returnToFirst?: boolean
    } = {},
  ) {
    const mode = options.mode ?? 'fresh',
      roots = options.roots ?? 2,
      steps = options.steps ?? 405
    const resume = mode === 'resume' || mode === 'generation-reset'
    let f: Fixture
    const leases = createRuntimeSessionLeaseOperations(harness.db)
    let lease: RuntimeSessionLeaseToken | undefined
    if (options.first) {
      f = {
        ...options.first.f,
        binding: {
          ...options.first.f.binding,
          nodeRunId: options.first.f.binding.nodeRunId + '-resume',
          invocationId: options.first.f.binding.invocationId + '-resume',
        },
      }
      await harness.db.insert(nodeRuns).values({
        id: f.binding.nodeRunId,
        taskId: f.binding.taskId,
        nodeId: 'agent',
        status: 'running',
      })
      const previous = await invocations().get(options.first.f.binding.invocationId)
      if (!previous || previous.authority.kind !== 'local')
        throw new Error('Original accepted invocation unavailable')
      await invocations().accept({
        invocationId: f.binding.invocationId,
        taskId: f.binding.taskId,
        nodeRunId: f.binding.nodeRunId,
        agentId: null,
        agentRevision: null,
        purpose: 'task',
        authority: previous.authority,
        nativeCaptureContract: 'opencode-child-root-pages-v3',
        nativeCaptureSource: native.source,
      })
      lease = await runWithTaskExecutionContext(f.binding.executionContext, async () => {
        expect(await leases.release(options.first!.lease)).toBe(true)
        const token = await leases.preclaimResume({
          protocol: 'opencode',
          sessionId: 'root',
          taskId: f.binding.taskId,
          nodeId: 'agent',
          currentNodeRunId: f.binding.nodeRunId,
          leaseNonceDigest: randomUUID(),
          leasedAt: Date.now(),
          nativeInvocationId: f.binding.invocationId,
        })
        expect(await leases.confirmResume(token)).toBe(true)
        return token
      })
    } else
      f = await originalNativeLedgerFixture(harness, 'fresh', true, {
        source: native.source,
        generation: await opencodeNativeStoreGeneration(native.path),
        producer: true,
        rootSets: true,
        runtime: await pricedRuntime(),
      })
    const original = runWithTaskExecutionContext(f.binding.executionContext, () =>
      f.persistence.nativeUsage!.forInvocation(f.binding),
    )
    if (!original?.rootCollection) throw new Error('Original root owner unavailable')
    const missingFinalPage = (real: ReturnType<NativeUsageDurableOwner['passOwner']>) => ({
      ...real,
      persist(page: Parameters<typeof real.persist>[0]) {
        if (
          page.identity.phase === 'final' &&
          page.identity.rootSessionId === 'root' &&
          page.ordinal === '1'
        )
          throw new Error('actual earlier final page unavailable')
        return real.persist(page)
      },
    })
    let owner: NativeUsageDurableOwner = options.missingEarlierPage
      ? {
          ...original,
          passOwner(before) {
            return missingFinalPage(original.passOwner(before))
          },
          withFinalOwner(before, read) {
            return original.withFinalOwner
              ? original.withFinalOwner(before, (real) => read(missingFinalPage(real)))
              : read(missingFinalPage(original.passOwner(before)))
          },
        }
      : original
    if (options.loseCompletionAck) {
      const actual = owner
      let lost = false
      owner = {
        ...actual,
        async seal(at) {
          const ack = await actual.seal(at)
          if (!lost) {
            lost = true
            throw new Error('actual committed completion ACK lost')
          }
          return ack
        },
      }
    }
    const capture = createOpencodeNativeUsageCapture({
      path: native.path,
      invocationId: f.binding.invocationId,
      taskId: f.binding.taskId,
      nodeRunId: f.binding.nodeRunId,
      agentId: null,
      ...(resume ? { resumeSessionId: 'root' } : {}),
      durableOwner: owner,
    })
    let deferredSettled: ObservationNativeProcessFact | undefined
    const local = bindLocalAgentExecutionEffect({
      materialRef: 'actual-root-child',
      command: () => [
        process.execPath,
        native.script,
        native.path,
        mode,
        String(roots),
        String(steps),
      ],
      workingDirectory: () => native.directory,
      environment: () => ({ ...process.env }) as Record<string, string>,
      stdin: () => undefined,
      requireSpawnReceipt: true,
      taskEffect: {
        persistence: f.persistence.effects,
        nodeExecution: () => f.persistence.nodeExecution,
        argv: [process.execPath, native.script, native.path, mode, String(roots), String(steps)],
        cwd: native.directory,
        resourceKeys: [],
        observeNativeProcess: async (fact) => {
          if (fact.phase === 'settled' && options.lateSettled) deferredSettled = fact
          else if (!options.missingSettled || fact.phase !== 'settled')
            await capture.recordProcess!(fact)
        },
      },
    })
    const result = await local.effect.submit({
      executionRef: local.executionRef,
      materialRef: local.materialRef,
      workspaceRef: local.workspaceRef,
      beforeStart: () => capture.beginDurable!(),
      capture: { rawStdout: true },
    })
    expect(result.outcome).toBe('ok')
    expect(result.exitCode).toBe(0)
    lease = await runWithTaskExecutionContext(f.binding.executionContext, async () => {
      let token =
        lease ??
        (await leases.claimNew({
          protocol: 'opencode',
          sessionId: 'root',
          taskId: f.binding.taskId,
          nodeId: 'agent',
          currentNodeRunId: f.binding.nodeRunId,
          leaseNonceDigest: randomUUID(),
          leasedAt: Date.now(),
          nativeInvocationId: f.binding.invocationId,
        }))
      for (let r = 1; r < roots; r++) {
        expect(await leases.markResetPending(token)).toBe(true)
        token = await leases.rotate(
          token,
          (resume ? 'resume-' : 'reset-') + String(r).padStart(3, '0'),
        )
      }
      if (options.returnToFirst) {
        expect(await leases.markResetPending(token)).toBe(true)
        token = await leases.rotate(token, 'root')
      }
      return token
    })
    if (options.lateSettled) {
      await original.rootCollection.freeze()
      if (!deferredSettled) throw new Error('Actual deferred child settlement unavailable')
      await capture.recordProcess!(deferredSettled)
    }
    const observations = participant()
    const finish = finalizeNativeUsageInvocation({
      capture,
      observations,
      invocationId: f.binding.invocationId,
      nodeRunId: f.binding.nodeRunId,
      rootSessionId: lease.sessionId,
    })
    if (options.missingEarlierPage)
      await expect(finish).rejects.toThrow('earlier final page unavailable')
    else if (options.loseCompletionAck)
      await expect(finish).rejects.toThrow('actual committed completion ACK lost')
    else if (mode === 'generation-reset')
      await expect(finish).rejects.toThrow('Original native store generation changed')
    else await finish
    const receipt = (await ledger().captures([f.binding.invocationId]))[0]!
    if (receipt.capture.contract !== 'opencode-child-root-pages-v3')
      throw new Error('Original root contract changed')
    const value = ObservationNativeRootCompletionSchema.parse(receipt.capture)
    return { f, capture, lease, receipt, value, rows: await records(f.binding.taskId) }
  }
  const sum = (rows: Awaited<ReturnType<typeof records>>) =>
    rows.reduce(
      (v, row) => {
        for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
          v[bucket] += BigInt(row.measurement.usage[bucket] ?? '0')
        return v
      },
      { input: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n },
    )
  async function value(rows: Awaited<ReturnType<typeof records>>) {
    const price = createInvocationValuation(invocations(), createObservationPriceStore(harness.db))
    let millionths = 0n
    for (const row of rows) {
      const result = await price({
        invocationId: row.measurement.invocationId,
        model: row.measurement.model,
        condition: null,
        usage: row.measurement.usage,
      })
      expect(result.currency).toBe('CNY')
      expect(result.availability).toBe('priced')
      if (result.amountDecimal === null) throw new Error('Original acceptance price unavailable')
      const [whole, part = ''] = result.amountDecimal.split('.')
      millionths += BigInt(whole!) * 1000000n + BigInt(part.padEnd(6, '0'))
    }
    return millionths
  }
  test('two actual roots exceed native page packets, retain one invocation and all four buckets/CNY without span collection', async () => {
    const result = await execute(nativeStore())
    expect(result.value.state).toBe('complete')
    expect(result.value.roots.count).toBe('2')
    expect(result.value.roots.transitions).toBe('2')
    expect(result.rows).toHaveLength(810)
    expect(new Set(result.rows.map((row) => row.measurement.recordId)).size).toBe(810)
    expect(
      result.rows.every((row) => row.measurement.invocationId === result.f.binding.invocationId),
    ).toBe(true)
    expect(sum(result.rows)).toEqual({
      input: 810n,
      cacheRead: 2430n,
      cacheWrite: 4050n,
      output: 14580n,
    })
    expect(await value(result.rows)).toBe(76140n)
    expect(
      (await invocations().get(result.f.binding.invocationId))!.spanCaptureContract,
    ).toBeUndefined()
    expect(await createObservationNativeScopes(harness.db).qualify(result.receipt)).toEqual({
      records: '810',
      complete: true,
    })
    expect(ObservationNativeCompletionSchema.safeParse(result.value).success).toBe(false)
  }, 120000)
  test('resume A to new B to A repairs the original A usage and reads A only once', async () => {
    const native = nativeStore(),
      first = await execute(native, { returnToFirst: true }),
      second = await execute(native, { mode: 'resume', steps: 1, first, returnToFirst: true })
    expect(second.value.state).toBe('complete')
    expect(second.value.roots.transitions).toBe('3')
    expect(second.value.roots.count).toBe('2')
    expect(second.rows).toHaveLength(812)
    expect(sum(second.rows)).toEqual({
      input: 1217n,
      cacheRead: 2436n,
      cacheWrite: 4060n,
      output: 14616n,
    })
    expect(await value(second.rows)).toBe(76733n)
    const current = second.rows.filter(
      (row) => row.measurement.invocationId === second.f.binding.invocationId,
    )
    expect(current).toHaveLength(2)
    expect(await createObservationNativeScopes(harness.db).qualify(second.receipt)).toEqual({
      records: '2',
      complete: true,
    })
    const before = sum(second.rows)
    await finalizeNativeUsageInvocation({
      capture: second.capture,
      observations: participant(),
      invocationId: second.f.binding.invocationId,
      nodeRunId: second.f.binding.nodeRunId,
      rootSessionId: 'root',
    })
    expect(sum(await records(second.f.binding.taskId))).toEqual(before)
  }, 120000)
  test('41 actual original root transitions reach distinct root EOF beyond one root packet', async () => {
    const result = await execute(nativeStore(), { roots: 41, steps: 1 })
    expect(result.value.state).toBe('complete')
    expect(result.value.roots.count).toBe('41')
    expect(result.value.roots.transitions).toBe('41')
    expect(result.rows).toHaveLength(41)
    const rebuilt = runWithTaskExecutionContext(result.f.binding.executionContext, () =>
      result.f.persistence.nativeUsage!.forInvocation(result.f.binding),
    )!
    const first = await rebuilt.rootCollection!.page(null),
      last = await rebuilt.rootCollection!.page(first.at(-1)!)
    expect(first).toHaveLength(40)
    expect(last).toHaveLength(1)
    expect(await rebuilt.rootCollection!.page(last.at(-1)!)).toEqual([])
    expect(await createObservationNativeScopes(harness.db).qualify(result.receipt)).toEqual({
      records: '41',
      complete: true,
    })
    const exported: Record<string, unknown[]> = {}
    for (const table of NATIVE_USAGE_ARCHIVE.filter((value) =>
      value.name.startsWith('task_execution_native_usage_root_'),
    )) {
      const rows: unknown[] = []
      for await (const page of table.batches(harness.db, [result.f.binding.taskId]))
        rows.push(...page)
      exported[table.name] = rows
    }
    const heads =
      exported.task_execution_native_usage_root_heads as (typeof nativeUsageRootHeads.$inferInsert)[]
    const transitions =
      exported.task_execution_native_usage_root_transitions as (typeof nativeUsageRootTransitions.$inferInsert)[]
    const frozen =
      exported.task_execution_native_usage_root_sets as (typeof nativeUsageRootSets.$inferInsert)[]
    const results =
      exported.task_execution_native_usage_root_results as (typeof nativeUsageRootResults.$inferInsert)[]
    expect(heads).toHaveLength(1)
    expect(transitions).toHaveLength(41)
    expect(frozen).toHaveLength(1)
    expect(results).toHaveLength(41)
    await harness.db.transaction(async (tx) => {
      await tx
        .delete(nativeUsageRootHeads)
        .where(eq(nativeUsageRootHeads.invocationId, result.f.binding.invocationId))
      await tx
        .delete(nativeUsageRootSets)
        .where(eq(nativeUsageRootSets.invocationId, result.f.binding.invocationId))
      await tx
        .delete(nativeUsageRootResults)
        .where(eq(nativeUsageRootResults.invocationId, result.f.binding.invocationId))
      await tx.insert(nativeUsageRootHeads).values(heads)
      await tx.insert(nativeUsageRootTransitions).values(transitions)
      await tx.insert(nativeUsageRootSets).values(frozen)
      await tx.insert(nativeUsageRootResults).values(results)
    })
    expect(await createObservationNativeScopes(harness.db).qualify(result.receipt)).toEqual({
      records: '41',
      complete: true,
    })
  }, 120000)
  test('a missing earlier final page keeps its committed numbers and the complete later root visible', async () => {
    const result = await execute(nativeStore(), { missingEarlierPage: true })
    expect(result.value.state).toBe('partial')
    expect(result.value.roots.count).toBe('2')
    expect(result.rows.length).toBeGreaterThan(405)
    expect(result.rows.length).toBeLessThan(810)
    expect(sum(result.rows).input).toBe(BigInt(result.rows.length))
    expect(await value(result.rows)).toBe(BigInt(result.rows.length) * 94n)
    expect((await createObservationNativeScopes(harness.db).qualify(result.receipt)).complete).toBe(
      false,
    )
  }, 120000)
  test('unknown output retains known input and both caches with partial CNY', async () => {
    const result = await execute(nativeStore(), { mode: 'unknown' })
    expect(result.value.state).toBe('partial')
    expect(result.rows).toHaveLength(810)
    expect(result.rows.every((row) => row.measurement.usage.output === null)).toBe(true)
    expect(sum(result.rows)).toEqual({
      input: 810n,
      cacheRead: 2430n,
      cacheWrite: 4050n,
      output: 0n,
    })
    expect(await value(result.rows)).toBe(17820n)
  }, 120000)
  test('missing original settle/drain retains every known bucket and CNY but never complete', async () => {
    const result = await execute(nativeStore(), { missingSettled: true })
    expect(result.value.state).toBe('partial')
    expect(result.rows).toHaveLength(810)
    expect(await value(result.rows)).toBe(76140n)
    expect((await createObservationNativeScopes(harness.db).qualify(result.receipt)).complete).toBe(
      false,
    )
  }, 120000)
  test('an old root cannot acquire fresh numbers while the valid reset root remains visible', async () => {
    const result = await execute(nativeStore(), { mode: 'wrong-birth' })
    expect(result.value.state).toBe('partial')
    expect(result.value.issues).toContain('native-root-birth-outside-original-process')
    expect(result.rows).toHaveLength(405)
    expect(sum(result.rows).input).toBe(405n)
    expect(await value(result.rows)).toBe(38070n)
  }, 120000)
  test('late original settlement keeps known numbers but cannot retroactively complete the frozen process', async () => {
    const result = await execute(nativeStore(), { lateSettled: true })
    expect(result.value.state).toBe('partial')
    expect(result.value.issues).toContain('native-root-process-incomplete-at-freeze')
    expect(result.rows).toHaveLength(810)
    expect(await value(result.rows)).toBe(76140n)
    expect((await createObservationNativeScopes(harness.db).qualify(result.receipt)).complete).toBe(
      false,
    )
  }, 120000)
  test('a replaced actual native generation cannot overwrite earlier complete usage', async () => {
    const native = nativeStore(),
      first = await execute(native, { returnToFirst: true })
    const originalGeneration = await opencodeNativeStoreGeneration(native.path)
    const second = await execute(native, { mode: 'generation-reset', roots: 1, steps: 1, first })
    expect(await opencodeNativeStoreGeneration(native.path)).not.toBe(originalGeneration)
    expect(second.value.state).toBe('partial')
    expect(second.rows).toHaveLength(810)
    expect(sum(second.rows)).toEqual(sum(first.rows))
    expect(await value(second.rows)).toBe(76140n)
  }, 120000)
  test('a lost actual committed completion ACK replays after rebuilding the owner without repeating numbers', async () => {
    const result = await execute(nativeStore(), { loseCompletionAck: true })
    expect(result.value.state).toBe('complete')
    const before = sum(result.rows)
    // A newer unrelated marker that differs only in case must never replace the original seal.
    const unrelatedEventId = 'Native-completion:diagnostic-only'
    const unrelatedEvidence = JSON.stringify({
      invocationId: result.f.binding.invocationId,
      measurements: [],
      diagnostics: ['diagnostic-only'],
    })
    const unrelatedSource = (
      await harness.db
        .insert(taskExecutionObservationSources)
        .values({
          taskId: result.f.binding.taskId,
          nodeRunId: result.f.binding.nodeRunId,
          evidenceJson: unrelatedEvidence,
        })
        .returning({ id: taskExecutionObservationSources.id })
    )[0]!
    await harness.db.insert(nativeUsageEmissions).values({
      invocationId: result.f.binding.invocationId,
      eventId: unrelatedEventId,
      fingerprint: sha256Hex(unrelatedEvidence),
      sourceRowId: unrelatedSource.id,
      document: JSON.stringify({ request: unrelatedEvidence, evidence: unrelatedEvidence }),
      ack: JSON.stringify({
        contract: 'native-usage-source-ack-v2',
        invocationId: result.f.binding.invocationId,
        eventId: unrelatedEventId,
        fingerprint: sha256Hex(unrelatedEvidence),
        sourceWatermark: String(unrelatedSource.id),
        measurements: [],
      }),
    })
    const rebuilt = runWithTaskExecutionContext(result.f.binding.executionContext, () =>
      result.f.persistence.nativeUsage!.forInvocation(result.f.binding),
    )!
    const ack = await rebuilt.seal(Date.now())
    expect(ack.invocationId).toBe(result.f.binding.invocationId)
    expect(ack.measurements).toEqual([])
    expect(sum(await records(result.f.binding.taskId))).toEqual(before)
    expect(await value(await records(result.f.binding.taskId))).toBe(76140n)
    expect(await createObservationNativeScopes(harness.db).qualify(result.receipt)).toEqual({
      records: '810',
      complete: true,
    })
  }, 120000)
  test('an uncommitted rotation does not alter the original root watermark or lease', async () => {
    const result = await execute(nativeStore(), { roots: 1, steps: 1 })
    const head = (
      await harness.db
        .select()
        .from(nativeUsageRootHeads)
        .where(eq(nativeUsageRootHeads.invocationId, result.f.binding.invocationId))
    )[0]!
    // The original sealed result is immutable. A post-process transition must roll back.
    const leases = createRuntimeSessionLeaseOperations(harness.db)
    await runWithTaskExecutionContext(result.f.binding.executionContext, async () => {
      expect(await leases.markResetPending(result.lease)).toBe(true)
      await expect(leases.rotate(result.lease, 'unaccepted-root')).rejects.toThrow()
    })
    expect(
      (
        await harness.db
          .select()
          .from(nativeUsageRootHeads)
          .where(eq(nativeUsageRootHeads.invocationId, result.f.binding.invocationId))
      )[0],
    ).toEqual(head)
    expect(
      await harness.db
        .select()
        .from(nativeUsageRootTransitions)
        .where(eq(nativeUsageRootTransitions.invocationId, result.f.binding.invocationId)),
    ).toHaveLength(1)
    expect(
      (
        await harness.db
          .select()
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, result.f.binding.invocationId))
      )[0]!.state,
    ).toBe('sealed')
  }, 120000)
})
