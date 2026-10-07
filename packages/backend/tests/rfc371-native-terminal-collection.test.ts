// RFC-371: canceled native final evidence must use the original prepared/reaped invocation.
// The real child/root/four-bucket/CNY path is covered in rfc371-native-root-collection.test.ts.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import type { ObservationNativeProcessFact } from '@agent-workflow/shared'
import {
  nativeUsageEmissions,
  taskExecutionObservationSources,
  taskExecutionOwners,
} from '@/db/schema'
import {
  fenceTaskWrite,
  withTaskExecutionWrite,
} from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { createNativeUsageFinalizationAuthority } from '@/modules/task-execution/infrastructure/nativeUsageFinalizationAuthority'
import { DrizzleNativeUsageEmission } from '@/modules/task-execution/infrastructure/drizzleNativeUsageEmission'
import { openOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

describeEachProvider('RFC-371 terminal native evidence original binding', (harness) => {
  async function fixture() {
    const f = await originalNativeLedgerFixture(harness, 'resume', true, { rootSets: true })
    const authority = createNativeUsageFinalizationAuthority(f.binding)
    const binding = { ...f.binding, finalization: authority.reference }
    const spawned: ObservationNativeProcessFact = {
      contract: 'native-process-facts-v2',
      phase: 'spawned',
      pid: 123,
      launchNonce: 'original-child',
      spawnedAt: f.before.preparedAt,
      reapedAt: null,
      drainedAt: null,
      outcome: null,
      drainTimedOut: false,
      pumpError: false,
    }
    const settled: ObservationNativeProcessFact = {
      ...spawned,
      phase: 'settled',
      reapedAt: f.before.preparedAt + 1,
      drainedAt: f.before.preparedAt + 2,
      outcome: 'cancel',
    }
    async function revoke(
      state: 'revoked' | 'released' | 'claimed' | 'recovery-required' = 'revoked',
    ) {
      await harness.db
        .update(taskExecutionOwners)
        .set({ state })
        .where(eq(taskExecutionOwners.taskId, binding.taskId))
    }
    const emit = () =>
      new DrizzleNativeUsageEmission(harness.db).emit({
        binding,
        eventId: 'original-settled',
        evidence: {
          invocationId: binding.invocationId,
          measurements: [],
          diagnostics: [],
          nativeProcess: settled,
        },
      })
    return { ...f, authority, binding, spawned, settled, revoke, emit }
  }

  // CI a443cba8: actual EOF may precede actual reap. Preserve the original clocks,
  // and the canceled Task fence, instead of discarding this complete settlement.
  for (const order of ['drain-first', 'reap-first'] as const)
    test(`${order} preserves original canceled native evidence without a new Task claim`, async () => {
      const f = await fixture()
      f.settled.reapedAt = f.before.preparedAt + (order === 'drain-first' ? 2 : 1)
      f.settled.drainedAt = f.before.preparedAt + (order === 'drain-first' ? 1 : 2)
      f.authority.prepared(f.before)
      f.authority.observe(f.spawned)
      f.authority.observe(f.settled)
      await f.revoke()
      const ack = await f.emit()
      expect(ack.invocationId).toBe(f.binding.invocationId)
      const sources = await harness.db
        .select()
        .from(taskExecutionObservationSources)
        .where(eq(taskExecutionObservationSources.nodeRunId, f.binding.nodeRunId))
      expect(sources).toHaveLength(1)
      expect(JSON.parse(sources[0]!.evidenceJson).nativeProcess).toEqual(f.settled)
      expect(
        (
          await harness.db
            .select()
            .from(taskExecutionOwners)
            .where(eq(taskExecutionOwners.taskId, f.binding.taskId))
        )[0]?.state,
      ).toBe('revoked')
      await expect(
        withTaskExecutionWrite(harness.db, (tx) =>
          fenceTaskWrite(tx, {
            taskId: f.binding.taskId,
            context: f.binding.executionContext,
          }),
        ),
      ).rejects.toThrow('mutation was fenced')
      expect(await f.emit()).toEqual(ack)
      expect(
        await harness.db
          .select()
          .from(taskExecutionObservationSources)
          .where(eq(taskExecutionObservationSources.nodeRunId, f.binding.nodeRunId)),
      ).toEqual(sources)
    })

  type Fixture = Awaited<ReturnType<typeof fixture>>
  const invalid: ReadonlyArray<readonly [string, (f: Fixture) => void]> = [
    [
      'missing prepare',
      (f) => {
        f.authority.observe(f.spawned)
        f.authority.observe(f.settled)
      },
    ],
    [
      'missing spawn',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.settled)
      },
    ],
    [
      'missing settlement',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
      },
    ],
    [
      'unknown PID',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, pid: null })
      },
    ],
    [
      'different PID',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, pid: 124 })
      },
    ],
    [
      'different launch nonce',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, launchNonce: 'another-child' })
      },
    ],
    [
      'different spawn time',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, spawnedAt: f.before.preparedAt + 1 })
      },
    ],
    [
      'unreaped child',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, outcome: 'unreaped' })
      },
    ],
    [
      'missing reap',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, reapedAt: null })
      },
    ],
    [
      'missing drain',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, drainedAt: null })
      },
    ],
    [
      'drain timeout',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, drainedAt: null, drainTimedOut: true })
      },
    ],
    [
      'pump failure',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, drainedAt: null, pumpError: true })
      },
    ],
    [
      'drain before spawn',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe(f.spawned)
        f.authority.observe({ ...f.settled, drainedAt: f.before.preparedAt - 1 })
      },
    ],
    [
      'spawn before prepare',
      (f) => {
        f.authority.prepared(f.before)
        f.authority.observe({ ...f.spawned, spawnedAt: f.before.preparedAt - 1 })
        f.authority.observe(f.settled)
      },
    ],
    [
      'different source',
      (f) => {
        f.authority.prepared({ ...f.before, nativeSource: 'changed-source' })
        f.authority.observe(f.spawned)
        f.authority.observe(f.settled)
      },
    ],
    [
      'different lineage',
      (f) => {
        f.authority.prepared({ ...f.before, lineage: 'changed-lineage' })
        f.authority.observe(f.spawned)
        f.authority.observe(f.settled)
      },
    ],
    [
      'different generation',
      (f) => {
        f.authority.prepared({ ...f.before, sourceGeneration: 'changed-generation' })
        f.authority.observe(f.spawned)
        f.authority.observe(f.settled)
      },
    ],
    [
      'different receipt',
      (f) => {
        f.authority.prepared({ ...f.before, ownerReceiptId: 'changed-receipt' })
        f.authority.observe(f.spawned)
        f.authority.observe(f.settled)
      },
    ],
  ]
  for (const [name, arrange] of invalid)
    test(`${name} cannot commit canceled native evidence`, async () => {
      const f = await fixture()
      arrange(f)
      await f.revoke()
      await expect(f.emit()).rejects.toThrow('mutation was fenced')
      expect(
        await harness.db
          .select()
          .from(nativeUsageEmissions)
          .where(eq(nativeUsageEmissions.invocationId, f.binding.invocationId)),
      ).toHaveLength(0)
      expect(
        await harness.db
          .select()
          .from(taskExecutionObservationSources)
          .where(eq(taskExecutionObservationSources.nodeRunId, f.binding.nodeRunId)),
      ).toHaveLength(0)
    })
  for (const field of ['epoch', 'ownerId', 'daemonGeneration'] as const)
    test(`a new ${field} rejects even a real original settlement`, async () => {
      const f = await fixture()
      f.authority.prepared(f.before)
      f.authority.observe(f.spawned)
      f.authority.observe(f.settled)
      await f.revoke()
      const token = f.binding.executionContext.token
      const changed =
        field === 'epoch'
          ? { epoch: token.epoch + 1 }
          : field === 'ownerId'
            ? { ownerId: token.ownerId + '-new' }
            : { daemonGeneration: token.daemonGeneration + '-new' }
      await harness.db
        .update(taskExecutionOwners)
        .set(changed)
        .where(eq(taskExecutionOwners.taskId, f.binding.taskId))
      await expect(f.emit()).rejects.toThrow('mutation was fenced')
      expect(
        await harness.db
          .select()
          .from(nativeUsageEmissions)
          .where(eq(nativeUsageEmissions.invocationId, f.binding.invocationId)),
      ).toHaveLength(0)
    })
  test('recovery-required does not infer original child reap', async () => {
    const f = await fixture()
    f.authority.prepared(f.before)
    f.authority.observe(f.spawned)
    f.authority.observe(f.settled)
    await f.revoke('recovery-required')
    await expect(f.emit()).rejects.toThrow('mutation was fenced')
  })
  test('the final reference does not permit another prepare or baseline write', async () => {
    const f = await fixture()
    const directory = mkdtempSync(join(tmpdir(), 'aw-native-terminal-baseline-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'native.db'),
      native = new Database(path)
    try {
      native.exec(
        'CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);',
      )
      native.run('INSERT INTO session VALUES (?,?,?)', ['root', null, f.before.preparedAt])
    } finally {
      native.close()
    }
    const identity = f.identity('baseline'),
      reader = openOpencodeUsagePass(path, identity)
    cleanup.push(() => reader.close())
    const admission = await f.pages.admit({
      binding: f.binding,
      identity,
      initialCursor: reader.initialCursor,
      rootCreatedAt: reader.rootCreatedAt,
      beforeSpawnReceiptId: f.before.ownerReceiptId,
    })
    expect(admission.identity).toEqual(identity)
    const page = reader.next(reader.initialCursor)
    f.authority.prepared(f.before)
    f.authority.observe(f.spawned)
    f.authority.observe(f.settled)
    await f.revoke()
    await expect(f.pages.prepare({ ...f.prepareInput, binding: f.binding })).rejects.toThrow(
      'mutation was fenced',
    )
    await expect(
      f.pages.admit({
        binding: f.binding,
        identity,
        initialCursor: reader.initialCursor,
        rootCreatedAt: reader.rootCreatedAt,
        beforeSpawnReceiptId: f.before.ownerReceiptId,
      }),
    ).rejects.toThrow('mutation was fenced')
    await expect(
      f.pages.persist({
        binding: f.binding,
        page: {
          ...page,
          sessions: [...page.sessions],
          steps: [...page.steps],
          issues: [...page.issues],
        },
      }),
    ).rejects.toThrow('mutation was fenced')
    await expect(
      f.pages.interrupt({ binding: f.binding, identity, reason: 'canceled' }),
    ).rejects.toThrow('mutation was fenced')
    const original = await f.emit()
    expect(await f.emit()).toEqual(original)
    expect(
      await harness.db
        .select()
        .from(nativeUsageEmissions)
        .where(eq(nativeUsageEmissions.invocationId, f.binding.invocationId)),
    ).toHaveLength(1)
  })
  test('a serialized or another invocation reference cannot borrow final writes', async () => {
    const f = await fixture()
    f.authority.prepared(f.before)
    f.authority.observe(f.spawned)
    f.authority.observe(f.settled)
    await f.revoke()
    for (const binding of [
      { ...f.binding, finalization: JSON.parse(JSON.stringify(f.binding.finalization)) as object },
      { ...f.binding, invocationId: f.binding.invocationId + '-other' },
      { ...f.binding, finalization: undefined },
    ]) {
      await expect(
        new DrizzleNativeUsageEmission(harness.db).emit({
          binding,
          eventId: 'copied-settlement',
          evidence: {
            invocationId: binding.invocationId,
            measurements: [],
            diagnostics: [],
            nativeProcess: f.settled,
          },
        }),
      ).rejects.toThrow('mutation was fenced')
    }
    expect(
      await harness.db
        .select()
        .from(nativeUsageEmissions)
        .where(eq(nativeUsageEmissions.invocationId, f.binding.invocationId)),
    ).toHaveLength(0)
  })
})
