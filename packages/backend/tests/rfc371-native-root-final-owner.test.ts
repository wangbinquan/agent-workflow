// Real Task owner, local child process and native SQLite files. This fixture does not run a model.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ObservationNativeRootCompletionSchema } from '@agent-workflow/shared'
import { createOpencodeNativeUsageCapture } from '@/modules/runtime-management/composition/nativeUsageCapture'
import { opencodeNativeStoreGeneration } from '@/modules/runtime-management/infrastructure/opencodeNativeStoreGeneration'
import { runWithTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { bindLocalAgentExecutionEffect } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { finalizeNativeUsageInvocation } from '@/modules/task-execution/application/finalizeNativeUsageInvocation'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import type { NativeUsageDurableOwner } from '@/modules/runtime-management/application/ports/nativeUsageCapture'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import { originalNativeObservationParticipant } from './helpers/rfc371NativeObservationParticipant'

const child = `import {Database} from 'bun:sqlite';const db=new Database(process.argv[2]);
db.transaction(()=>{for(const root of ['root','reset-001']){db.run('INSERT INTO session VALUES (?,?,?)',[root,null,Date.now()]);db.run('INSERT INTO message VALUES (?,?,?)',[root+'-message',root,JSON.stringify({role:'assistant',providerID:'actual-provider',modelID:'actual-model'})]);for(let n=0;n<7;n++)db.run('INSERT INTO part VALUES (?,?,?,?,?)',[root+'-step-'+n,root,root+'-message',Date.now(),JSON.stringify({type:'step-finish',tokens:{input:1,output:7,reasoning:11,cache:{read:3,write:5}}})]);}})();db.close();`
function files() {
  const directory = mkdtempSync(join(tmpdir(), 'aw-all-root-before-')),
    path = join(directory, 'actual-native.db'),
    script = join(directory, 'actual-child.ts')
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
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

describeEachProvider('one retained final owner across every genuine root pass', (harness) => {
  async function execute(missingRoot: boolean) {
    const native = files()
    try {
      const f = await originalNativeLedgerFixture(harness, 'fresh', true, {
        source: sha256Hex(JSON.stringify(['opencode-native-db', native.path])),
        generation: await opencodeNativeStoreGeneration(native.path),
        producer: true,
        rootSets: true,
      })
      const original = runWithTaskExecutionContext(f.binding.executionContext, () =>
        f.persistence.nativeUsage!.forInvocation(f.binding),
      )!
      let callbacks = 0
      const finalRoots: string[] = []
      const owner: NativeUsageDurableOwner = {
        ...original,
        withFinalOwner(before, read) {
          callbacks++
          return original.withFinalOwner!(before, (real) =>
            read({
              ...real,
              persist(page) {
                if (!finalRoots.includes(page.identity.rootSessionId))
                  finalRoots.push(page.identity.rootSessionId)
                if (missingRoot && page.identity.rootSessionId === 'root' && page.ordinal === '0')
                  throw Error('actual root final packet unavailable')
                return real.persist(page)
              },
            }),
          )
        },
      }
      const capture = createOpencodeNativeUsageCapture({
        path: native.path,
        ...f.binding,
        agentId: null,
        durableOwner: owner,
      })
      const argv = [process.execPath, native.script, native.path]
      const local = bindLocalAgentExecutionEffect({
        materialRef: 'actual-all-root-child',
        command: () => argv,
        workingDirectory: () => native.directory,
        environment: () => ({ ...process.env }) as Record<string, string>,
        stdin: () => undefined,
        requireSpawnReceipt: true,
        taskEffect: {
          persistence: f.persistence.effects,
          nodeExecution: () => f.persistence.nodeExecution,
          argv,
          cwd: native.directory,
          resourceKeys: [],
          observeNativeProcess: (fact) => capture.recordProcess!(fact),
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
      const leases = createRuntimeSessionLeaseOperations(harness.db)
      const lease = await runWithTaskExecutionContext(f.binding.executionContext, async () => {
        let token = await leases.claimNew({
          protocol: 'opencode',
          sessionId: 'root',
          taskId: f.binding.taskId,
          nodeId: 'agent',
          currentNodeRunId: f.binding.nodeRunId,
          leaseNonceDigest: randomUUID(),
          leasedAt: Date.now(),
          nativeInvocationId: f.binding.invocationId,
        })
        expect(await leases.markResetPending(token)).toBe(true)
        token = await leases.rotate(token, 'reset-001')
        expect(await leases.markResetPending(token)).toBe(true)
        return leases.rotate(token, 'root')
      })
      const finish = finalizeNativeUsageInvocation({
        capture,
        observations: originalNativeObservationParticipant(harness),
        invocationId: f.binding.invocationId,
        nodeRunId: f.binding.nodeRunId,
        rootSessionId: lease.sessionId,
      })
      if (missingRoot) await expect(finish).rejects.toThrow('actual root final packet unavailable')
      else await finish
      const ledger = createUsageLedgerStore(harness.db),
        rows = [],
        receipt = (await ledger.captures([f.binding.invocationId]))[0]!
      let after: string | undefined
      for (;;) {
        const page = await ledger.records(f.binding.taskId, {
          limit: 3,
          ...(after ? { after } : {}),
        })
        rows.push(...page.items)
        if (!page.nextCursor) break
        after = page.nextCursor
      }
      return {
        callbacks,
        finalRoots,
        rows,
        value: ObservationNativeRootCompletionSchema.parse(receipt.capture),
      }
    } finally {
      native.close()
    }
  }
  test('two complete actual roots after A to B to A use one callback and retain every four-bin step exactly once', async () => {
    const result = await execute(false)
    expect(result.callbacks).toBe(1)
    expect([...result.finalRoots].sort()).toEqual(['reset-001', 'root'])
    expect(result.value.state).toBe('complete')
    expect(result.value.roots.count).toBe('2')
    expect(result.value.roots.transitions).toBe('3')
    expect(result.rows).toHaveLength(14)
    expect(new Set(result.rows.map((r) => r.measurement.recordId)).size).toBe(14)
    expect(
      result.rows.every(
        (r) =>
          r.measurement.usage.input === '1' &&
          r.measurement.usage.cacheRead === '3' &&
          r.measurement.usage.cacheWrite === '5' &&
          r.measurement.usage.output === '18',
      ),
    ).toBe(true)
  }, 120_000)
  test('one actual root failure retains the other root and known rows while the entire source remains partial', async () => {
    const result = await execute(true)
    expect(result.callbacks).toBe(1)
    expect([...result.finalRoots].sort()).toEqual(['reset-001', 'root'])
    expect(result.value.state).toBe('partial')
    expect(result.value.roots.count).toBe('2')
    expect(
      result.rows.filter((r) => r.measurement.recordId.includes('reset-001-step-')),
    ).toHaveLength(7)
    expect(
      result.rows.every(
        (r) => r.measurement.usage.input === '1' && r.measurement.usage.output === '18',
      ),
    ).toBe(true)
  }, 120_000)
})
