// RFC-371: actual absent/new/replaced native SQLite files bind in the original Task transaction.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  nativeUsagePreparations,
  nativeUsagePasses,
  nativeUsagePassPages,
  nativeUsageStoreBindings,
  taskExecutionObservationSources,
} from '@/db/schema'
import { opencodeNativeStoreGeneration } from '@/modules/runtime-management/infrastructure/opencodeNativeStoreGeneration'
import { createNativePageCapture } from '@/modules/runtime-management/application/nativePageCapture'
import { runWithTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { DrizzleNativeUsageCompletion } from '@/modules/task-execution/infrastructure/drizzleNativeUsageCompletion'
import { sha256Hex } from '@/util/hash'
import type { ObservationNativePassIdentity } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function absentStore() {
  const directory = mkdtempSync(join(tmpdir(), 'aw-first-store-owner-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'original.db') }
}
function createStore(path: string) {
  const db = new Database(path)
  db.exec('CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER)')
  db.close()
}

describeEachProvider('RFC-371 actual first-store Task owner', (harness) => {
  async function fresh() {
    const native = absentStore()
    expect(await opencodeNativeStoreGeneration(native.path)).toBeNull()
    const f = await originalNativeLedgerFixture(harness, 'fresh', true, {
      source: sha256Hex(JSON.stringify(['opencode-native-db', native.path])),
      generation: null,
      sourceAbsentAt: Date.now(),
      producer: true,
    })
    return { native, f }
  }
  const storeRows = (invocationId: string) =>
    harness.db
      .select()
      .from(nativeUsageStoreBindings)
      .where(eq(nativeUsageStoreBindings.invocationId, invocationId))
  const preparation = async (invocationId: string) =>
    (
      await harness.db
        .select()
        .from(nativeUsagePreparations)
        .where(eq(nativeUsagePreparations.invocationId, invocationId))
    )[0]!

  test('actual absence replay preserves the original document and rejects missing, future, resume or incompatible observations', async () => {
    const { f } = await fresh()
    const before = await preparation(f.binding.invocationId)
    expect(await storeRows(f.binding.invocationId)).toHaveLength(0)
    expect(await f.pages.prepare({ ...f.prepareInput, sourceAbsentAt: Date.now() })).toEqual(
      f.before,
    )
    expect(await preparation(f.binding.invocationId)).toEqual(before)
    for (const request of [
      { ...f.prepareInput, sourceAbsentAt: undefined },
      { ...f.prepareInput, sourceAbsentAt: -1 },
      { ...f.prepareInput, sourceAbsentAt: NaN },
      { ...f.prepareInput, sourceAbsentAt: Date.now() + 60000 },
      { ...f.prepareInput, resumeRootSessionId: 'root' },
      { ...f.prepareInput, sourceGeneration: 'present' },
    ]) {
      await expect(f.pages.prepare(request)).rejects.toThrow()
      expect(await preparation(f.binding.invocationId)).toEqual(before)
      expect(await storeRows(f.binding.invocationId)).toHaveLength(0)
    }
  })

  test('first admission pins the actual generation; rollback, replay and actual replacement cannot change the original receipt', async () => {
    const { native, f } = await fresh()
    createStore(native.path)
    const generation = await opencodeNativeStoreGeneration(native.path)
    expect(generation).not.toBeNull()
    if (generation === null) throw new Error('Actual store was not created')
    const identity: ObservationNativePassIdentity = {
      passId: randomUUID(),
      invocationId: f.binding.invocationId,
      nativeSource: f.before.nativeSource,
      sourceGeneration: generation,
      rootSessionId: 'root',
      lineage: f.before.lineage,
      epoch: f.before.epoch,
      phase: 'final',
    }
    const request = (pass: ObservationNativePassIdentity) => ({
      binding: f.binding,
      identity: pass,
      initialCursor: JSON.stringify([pass.passId, '0', sha256Hex(JSON.stringify(pass))]),
      beforeSpawnReceiptId: f.before.ownerReceiptId,
      rootCreatedAt: null,
    })
    const before = await preparation(f.binding.invocationId)
    await expect(
      f.pages.admit({ ...request(identity), supersedes: 'no-original-pass' }),
    ).rejects.toThrow('superseded pass is absent')
    expect(await storeRows(f.binding.invocationId)).toHaveLength(0)
    expect(await harness.db.select().from(nativeUsagePasses)).toHaveLength(0)
    const ack = await f.pages.admit(request(identity))
    expect(await f.pages.admit(request(identity))).toEqual(ack)
    const expected = [
      {
        invocationId: f.binding.invocationId,
        beforeOwnerReceiptId: f.before.ownerReceiptId,
        sourceGeneration: generation,
      },
    ]
    expect(await storeRows(f.binding.invocationId)).toEqual(expected)
    renameSync(native.path, native.path + '.original')
    createStore(native.path)
    const replacement = await opencodeNativeStoreGeneration(native.path)
    expect(replacement).not.toBe(generation)
    if (replacement === null) throw new Error('Actual replacement store was not created')
    await expect(
      f.pages.admit({
        ...request({ ...identity, passId: randomUUID(), sourceGeneration: replacement }),
        supersedes: identity.passId,
      }),
    ).rejects.toThrow('generation changed after admission')
    expect(await storeRows(f.binding.invocationId)).toEqual(expected)
    expect(await preparation(f.binding.invocationId)).toEqual(before)
    expect(await harness.db.select().from(nativeUsagePasses)).toHaveLength(1)
    expect(await harness.db.select().from(nativeUsagePassPages)).toHaveLength(0)
    expect(await harness.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
    // Even a stored pass cannot qualify complete without its actual root birth, EOF and process facts.
    expect(
      (
        await new DrizzleNativeUsageCompletion(harness.db).describeCompletion({
          binding: f.binding,
          observedAt: Date.now(),
        })
      ).state,
    ).toBe('partial')
  })

  test('a fresh file that never appears stays partial; directory and missing resume never return preparation ACKs', async () => {
    const { native, f } = await fresh()
    const owner = runWithTaskExecutionContext(f.binding.executionContext, () =>
      f.persistence.nativeUsage!.forInvocation(f.binding),
    )!
    const capture = createNativePageCapture({
      invocationId: f.binding.invocationId,
      taskId: f.binding.taskId,
      nodeRunId: f.binding.nodeRunId,
      agentId: null,
      nativeSource: f.before.nativeSource,
      durableOwner: owner,
      generation: () => opencodeNativeStoreGeneration(native.path),
      open: async () => {
        throw new Error('Absent file must not be opened')
      },
      passId: randomUUID,
      now: Date.now,
    })
    await capture.beginDurable!()
    expect(capture.includesRecord('stdout:known-input')).toBe(true)
    await expect(capture.finishDurable!('root')).rejects.toThrow('generation changed')
    expect(await storeRows(f.binding.invocationId)).toHaveLength(0)
    expect(await harness.db.select().from(nativeUsagePasses)).toHaveLength(0)
    const completion = await new DrizzleNativeUsageCompletion(harness.db).describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(completion.state).toBe('partial')
    expect(completion.final).toBeNull()
    expect(completion.issues).toContain('native-final-unavailable')
    let preparations = 0
    const rejectBefore = (generation: () => Promise<string | null>, resumeSessionId?: string) =>
      createNativePageCapture({
        invocationId: f.binding.invocationId,
        taskId: f.binding.taskId,
        nodeRunId: f.binding.nodeRunId,
        agentId: null,
        nativeSource: f.before.nativeSource,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        durableOwner: {
          ...owner,
          prepare: async (request) => {
            preparations++
            return owner.prepare(request)
          },
        },
        generation,
        open: async () => {
          throw new Error('Invalid source must not be opened')
        },
        passId: randomUUID,
        now: Date.now,
      })
    await expect(
      rejectBefore(() => opencodeNativeStoreGeneration(native.directory)).beginDurable!(),
    ).rejects.toThrow('not a regular file')
    await expect(
      rejectBefore(() => opencodeNativeStoreGeneration(native.path), 'root').beginDurable!(),
    ).rejects.toThrow('resume store is unavailable')
    expect(preparations).toBe(0)
  })
})
