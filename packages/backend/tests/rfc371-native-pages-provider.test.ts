// RFC-371: actual original Task transactions must persist every native page before durable ACK.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { and, count, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  nodeRuns,
  tasks,
  taskExecutionObservationSources,
  nativeUsagePasses,
  nativeUsagePassPages,
  nativeUsagePreparations,
  nativeUsageStepMembers,
  nativeUsageSessionParents,
  nativeUsageEmissions,
  nativeUsageRevisionHeads,
  taskExecutionOwners,
  observationUsageCurrent,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { DrizzleNativeUsagePages } from '@/modules/task-execution/infrastructure/drizzleNativeUsagePages'
import { DrizzleNativeUsageEmission } from '@/modules/task-execution/infrastructure/drizzleNativeUsageEmission'
import { DrizzleNativeUsageCompletion } from '@/modules/task-execution/infrastructure/drizzleNativeUsageCompletion'
import { verifyNativeUsagePass } from '@/modules/task-execution/infrastructure/nativeUsagePassVerification'
import { withNativeUsageOwner } from '@/modules/task-execution/infrastructure/nativeUsageOwnerTransaction'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageIngestion } from '@/modules/run-observability/application/usageIngestion'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import { createObservationUsageSource } from '@/modules/task-execution/infrastructure/observationUsageSource'
import { createNativeUsageCapture } from '@/modules/runtime-management/application/nativeUsageCapture'
import { readOpencodeUsageSnapshot } from '@/modules/runtime-management/infrastructure/opencodeUsageSnapshot'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { insertInBatches } from '@/platform/persistence/batchInsert'
import type { ObservationMeasurement } from '@agent-workflow/shared'
import { openOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import type { NativeUsagePassOwner } from '@/modules/runtime-management/application/ports/nativeUsageOwner'
import type { NativeUsageOwnerBinding } from '@/modules/task-execution/application/ports/nativeUsagePersistence'
import type { ObservationNativePassIdentity } from '@agent-workflow/shared'
import type { ObservationNativeScopeReference } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function nativeFixture(steps = 3, sessions = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-native-durable-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'native.sqlite')
  const db = new Database(path)
  cleanup.push(() => db.close())
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER);
    CREATE INDEX session_parent ON session(parent_id,id);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,id);`)
  const id = (n: number) => 'child-' + String(n).padStart(6, '0')
  const bornAt = Date.now()
  db.transaction(() => {
    db.run('INSERT INTO session VALUES (?,?,?)', ['root', null, bornAt])
    for (let n = 1; n < sessions; n++)
      db.run('INSERT INTO session VALUES (?,?,?)', [
        id(n),
        n === 1 || n > 80 ? 'root' : id(n - 1),
        bornAt,
      ])
    db.run('INSERT INTO message VALUES (?,?,?)', [
      'message',
      'root',
      JSON.stringify({
        role: 'assistant',
        providerID: 'original-provider',
        modelID: 'original-model',
      }),
    ])
    for (let n = 0; n < steps; n++)
      db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'step-' + String(n).padStart(6, '0'),
        'root',
        'message',
        bornAt,
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: String(n + 1), output: 5, reasoning: 2, cache: { read: 11, write: 13 } },
        }),
      ])
  })()
  return { path, bornAt, mutate: (run: (db: Database) => void) => run(db) }
}

describeEachProvider('RFC-371 original native pages and membership', (harness) => {
  async function fixture(mode: 'fresh' | 'resume' = 'resume', numericPages = false) {
    const db = harness.db
    const taskId = 'native-owner-' + randomUUID()
    const nodeRunId = taskId + '-node'
    const invocationId = taskId + '-call'
    const slotPath = [
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
    ]
    await db.insert(tasks).values({
      id: taskId,
      name: 'Original native pages',
      workflowId: 'fixture',
      workflowSnapshot: '{}',
      repoPath: '/native-fixture',
      worktreePath: '/native-fixture',
      baseBranch: 'main',
      branch: 'native-fixture',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify(slotPath),
    })
    await db.insert(nodeRuns).values({ id: nodeRunId, taskId, nodeId: 'agent', status: 'running' })
    const persistence = createTaskExecutionPersistence(db)
    const execution = createProviderTaskExecutionModule({
      daemonGeneration: 'native-generation',
      persistence,
    })
    const intentId = taskId + '-intent'
    await persistence.intents.submit({
      intentId,
      request: {
        taskId,
        kind: 'launch',
        source: 'rest',
        actorUserId: 'fixture',
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: taskId + ':root',
          slotPath,
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
    })
    const claimed = await execution.claimPersisted({ intentId })
    execution.claimGate.leave(claimed.permit)
    const binding: NativeUsageOwnerBinding = {
      taskId,
      nodeRunId,
      invocationId,
      executionContext: createTaskExecutionContext({ intentId, token: claimed.token, persistence }),
    }
    await createObservationInvocationStore(db).accept({
      invocationId,
      taskId,
      nodeRunId,
      agentId: null,
      agentRevision: null,
      purpose: 'task',
      authority: { kind: 'local', runtime: null },
      nativeCaptureContract: 'opencode-child-pages-v2',
      nativeCaptureSource: 'actual-native-store',
    })
    const pages = new DrizzleNativeUsagePages(db, numericPages)
    const prepareInput = {
      binding,
      nativeSource: 'actual-native-store',
      sourceGeneration: 'original-sqlite-generation',
      resumeRootSessionId: mode === 'resume' ? 'root' : null,
    }
    const before = await pages.prepare(prepareInput)
    const identity = (phase: 'baseline' | 'final' = 'baseline'): ObservationNativePassIdentity => ({
      passId: randomUUID(),
      invocationId,
      nativeSource: before.nativeSource,
      sourceGeneration: before.sourceGeneration,
      rootSessionId: 'root',
      lineage: before.lineage,
      epoch: before.epoch,
      phase,
    })
    const owner = (supersedes?: string): NativeUsagePassOwner => ({
      admit: (identity, initialCursor, rootCreatedAt) =>
        pages.admit({
          binding,
          identity,
          initialCursor,
          rootCreatedAt,
          beforeSpawnReceiptId: before.ownerReceiptId,
          ...(supersedes ? { supersedes } : {}),
        }),
      persist: (page) =>
        pages.persist({
          binding,
          page: {
            ...page,
            sessions: [...page.sessions],
            steps: [...page.steps],
            issues: [...page.issues],
          },
        }),
      interrupt: (identity, reason) => pages.interrupt({ binding, identity, reason }),
    })
    const open = (path: string, pass: ObservationNativePassIdentity, rows = 200) => {
      const reader = openOpencodeUsagePass(path, pass, { pageRows: rows })
      cleanup.push(() => reader.close())
      return {
        identity: reader.identity,
        initialCursor: reader.initialCursor,
        rootCreatedAt: reader.rootCreatedAt,
        next: async (cursor: string) => reader.next(cursor),
        acknowledge: async (ordinal: string, digest: string) => reader.acknowledge(ordinal, digest),
        close: async () => reader.close(),
      }
    }
    return { db, binding, pages, before, prepareInput, identity, owner, open }
  }

  test('before-spawn and frozen page receipts survive lost replies and owner reconstruction', async () => {
    const f = await fixture()
    expect(await f.pages.prepare(f.prepareInput)).toEqual(f.before)
    await expect(
      f.pages.prepare({ ...f.prepareInput, sourceGeneration: 'changed' }),
    ).rejects.toThrow('changed on replay')
    const native = nativeFixture()
    const reader = f.open(native.path, f.identity(), 1)
    const admitted = await f
      .owner()
      .admit(reader.identity, reader.initialCursor, reader.rootCreatedAt)
    const page = await reader.next(reader.initialCursor)
    const input = {
      binding: f.binding,
      page: {
        ...page,
        sessions: [...page.sessions],
        steps: [...page.steps],
        issues: [...page.issues],
      },
    }
    const ack = await f.pages.persist(input)
    expect(ack.ownerReceiptId).toBe(admitted.ownerReceiptId)
    expect(await new DrizzleNativeUsagePages(f.db).persist(input)).toEqual(ack)
    expect((await f.db.select().from(nativeUsagePassPages)).length).toBe(1)
    expect((await f.db.select().from(nativeUsagePreparations)).length).toBe(1)
    expect((await f.db.select().from(nativeUsagePasses))[0]?.rootCreatedAt).toBe(native.bornAt)
    await expect(
      f.pages.baselineMember({
        binding: f.binding,
        passId: reader.identity.passId,
        stepId: 'step-000000',
      }),
    ).rejects.toThrow('complete EOF')
  })

  test('the original transaction owns ACK durability; an uncommitted outer transaction cannot ACK', async () => {
    const f = await fixture()
    await harness.session.transaction(async () => {
      await expect(f.pages.prepare(f.prepareInput)).rejects.toThrow('original transaction commit')
    })
    expect(await f.pages.prepare(f.prepareInput)).toEqual(f.before)
  })

  test('all 10001 members, 1025 sessions and depth 80 persist and page to actual EOF', async () => {
    const f = await fixture()
    const native = nativeFixture(10001, 1025)
    const pass = f.identity()
    const final = await persistNativeUsagePass(f.open(native.path, pass), f.owner())
    expect(final.eof?.counts).toEqual({ sessions: '1025', parts: '10001', steps: '10001' })
    expect(
      await withNativeUsageOwner(f.db, f.binding, (tx) =>
        verifyNativeUsagePass(
          tx,
          f.binding,
          { ack: final, pageCount: String(BigInt(final.ordinal) + 1n) },
          true,
        ),
      ),
    ).toEqual({
      counts: final.counts,
      rootCreatedAt: native.bornAt,
      hasIssues: false,
      hasPopulationIssues: false,
    })
    expect((await f.db.select({ n: count() }).from(nativeUsageStepMembers))[0]?.n).toBe(10001)
    expect((await f.db.select({ n: count() }).from(nativeUsageSessionParents))[0]?.n).toBe(1025)
    const deep = (
      await f.db
        .select()
        .from(nativeUsageSessionParents)
        .where(
          and(
            eq(nativeUsageSessionParents.passId, pass.passId),
            eq(nativeUsageSessionParents.sessionId, 'child-000080'),
          ),
        )
    )[0]
    expect(deep?.depth).toBe('80')
    expect(
      await f.pages.baselineMember({
        binding: f.binding,
        passId: pass.passId,
        stepId: 'step-010000',
      }),
    ).toBe(true)
    expect(
      await f.pages.baselineMember({ binding: f.binding, passId: pass.passId, stepId: 'unknown' }),
    ).toBe(false)
    let after: string | null = null,
      records = 0n,
      input = 0n
    const ids = new Set<string>()
    do {
      const page = await f.pages.steps({
        binding: f.binding,
        passId: pass.passId,
        after,
        limit: 37,
      })
      for (const step of page.items) {
        expect(ids.has(step.stepId)).toBe(false)
        ids.add(step.stepId)
        records++
        input += BigInt(step.usage.input!)
        expect(step.usage.output).toBe('7')
        expect(step.usage.cacheRead).toBe('11')
        expect(step.usage.cacheWrite).toBe('13')
      }
      expect(page.nextCursor === null || page.nextCursor !== after).toBe(true)
      after = page.nextCursor
    } while (after !== null)
    expect(records).toBe(10001n)
    expect(input).toBe((10001n * 10002n) / 2n)
  }, 60000)

  test('interrupted progress verifies every received page without claiming original EOF', async () => {
    const f = await fixture('fresh')
    const native = nativeFixture()
    const reader = f.open(native.path, f.identity('final'), 1)
    await f.owner().admit(reader.identity, reader.initialCursor, reader.rootCreatedAt)
    const page = await reader.next(reader.initialCursor)
    const ack = await f.owner().persist(page)
    await f.owner().interrupt(reader.identity, 'actual reader interruption')
    const reference = { ack, pageCount: '1' }
    expect(
      await withNativeUsageOwner(f.db, f.binding, (tx) =>
        verifyNativeUsagePass(tx, f.binding, reference, false),
      ),
    ).toEqual({
      counts: ack.counts,
      rootCreatedAt: native.bornAt,
      hasIssues: false,
      hasPopulationIssues: false,
    })
    await expect(
      withNativeUsageOwner(f.db, f.binding, (tx) =>
        verifyNativeUsagePass(tx, f.binding, reference, true),
      ),
    ).rejects.toThrow('original progress')
  })

  test('all 1001 native steps are original numeric sources before the last page ACK', async () => {
    const f = await fixture('fresh', true)
    const native = nativeFixture(1001, 81)
    const identity = f.identity('final')
    const ack = await persistNativeUsagePass(f.open(native.path, identity, 1000), f.owner())
    const sources = await f.db.select().from(taskExecutionObservationSources)
    const records = sources.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    expect(records).toHaveLength(1001)
    expect(new Set(records.map((record) => record.recordId)).size).toBe(1001)
    expect(sources.every((row) => JSON.parse(row.evidenceJson).measurements.length <= 500)).toBe(
      true,
    )
    expect(ack.sourceWatermark).toBe(String(Math.max(...sources.map((row) => row.id))))
    expect(records.reduce((sum, record) => sum + BigInt(record.usage.input), 0n)).toBe(
      (1001n * 1002n) / 2n,
    )
    expect(
      records.every(
        (record) =>
          record.usage.cacheRead === '11' &&
          record.usage.cacheWrite === '13' &&
          record.usage.output === '7',
      ),
    ).toBe(true)
    const last = (
      await f.db
        .select()
        .from(nativeUsagePassPages)
        .where(
          and(
            eq(nativeUsagePassPages.passId, identity.passId),
            eq(nativeUsagePassPages.ordinal, ack.ordinal),
          ),
        )
    )[0]!
    expect(await f.pages.persist({ binding: f.binding, page: JSON.parse(last.document) })).toEqual(
      ack,
    )
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(sources.length)
  }, 30_000)

  test('an incomplete resume baseline never attributes pre-existing steps as new usage', async () => {
    const f = await fixture('resume', true)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final')), f.owner())
    expect(await f.db.select().from(nativeUsageStepMembers)).toHaveLength(3)
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
  })

  test('a baseline header with missing original membership cannot misattribute old steps', async () => {
    for (const missing of ['step', 'page'] as const) {
      const f = await fixture('resume', true)
      const native = nativeFixture()
      const baseline = f.identity('baseline')
      await persistNativeUsagePass(f.open(native.path, baseline, 1), f.owner())
      if (missing === 'step')
        await f.db
          .delete(nativeUsageStepMembers)
          .where(
            and(
              eq(nativeUsageStepMembers.passId, baseline.passId),
              eq(nativeUsageStepMembers.stepId, 'step-000000'),
            ),
          )
      else
        await f.db
          .delete(nativeUsagePassPages)
          .where(
            and(
              eq(nativeUsagePassPages.passId, baseline.passId),
              eq(nativeUsagePassPages.ordinal, '1'),
            ),
          )
      const final = f.identity('final')
      await expect(persistNativeUsagePass(f.open(native.path, final), f.owner())).rejects.toThrow(
        'Native pass verification',
      )
      expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
      expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(0)
      expect(
        await f.db
          .select()
          .from(nativeUsagePassPages)
          .where(eq(nativeUsagePassPages.passId, final.passId)),
      ).toHaveLength(0)
      expect(
        await f.db
          .select()
          .from(nativeUsageStepMembers)
          .where(eq(nativeUsageStepMembers.passId, final.passId)),
      ).toHaveLength(0)
    }
  })

  test('the final persisted page ACK must exactly equal the original frozen pass ACK', async () => {
    const f = await fixture('fresh')
    const native = nativeFixture()
    const identity = f.identity('final')
    const original = await persistNativeUsagePass(f.open(native.path, identity, 1), f.owner())
    const ack = { ...original, sourceWatermark: '1' }
    await f.db
      .update(nativeUsagePasses)
      .set({ lastAck: JSON.stringify(ack) })
      .where(eq(nativeUsagePasses.passId, identity.passId))
    await expect(
      withNativeUsageOwner(f.db, f.binding, (tx) =>
        verifyNativeUsagePass(
          tx,
          f.binding,
          { ack, pageCount: String(BigInt(ack.ordinal) + 1n) },
          true,
        ),
      ),
    ).rejects.toThrow('original final ACK')
  })

  test('a complete resume baseline excludes every prior step while retaining new original numbers', async () => {
    const f = await fixture('resume', true)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('baseline'), 1), f.owner())
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
    native.mutate((external) => {
      external.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'step-new',
        'root',
        'message',
        native.bornAt + 1,
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: 8, output: 3, reasoning: 0, cache: { read: 5, write: 7 } },
        }),
      ])
    })
    const ack = await persistNativeUsagePass(f.open(native.path, f.identity('final'), 2), f.owner())
    const sources = await f.db.select().from(taskExecutionObservationSources)
    const records = sources.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    expect(records.map((record) => record.recordId)).toEqual(['opencode:step:step-new'])
    expect(records[0]?.usage).toEqual({ input: '8', cacheRead: '5', cacheWrite: '7', output: '3' })
    expect(ack.sourceWatermark).toBe(String(sources[0]!.id))
  })

  test('a numeric source failure rolls the entire received page back before any positive ACK', async () => {
    const f = await fixture('fresh', true)
    const native = nativeFixture(1, 1)
    native.mutate((external) => external.run('UPDATE part SET id = ?', ['x'.repeat(512)]))
    const reader = f.open(native.path, f.identity('final'), 1)
    await f.owner().admit(reader.identity, reader.initialCursor, reader.rootCreatedAt)
    const root = await reader.next(reader.initialCursor)
    await f.owner().persist(root)
    await reader.acknowledge(root.ordinal, root.payloadDigest)
    const page = await reader.next(root.nextCursor!)
    expect(page.steps).toHaveLength(1)
    await expect(f.owner().persist(page)).rejects.toThrow()
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
    expect(await f.db.select().from(nativeUsageStepMembers)).toHaveLength(0)
    expect(await f.db.select().from(nativeUsagePassPages)).toHaveLength(1)
    expect((await f.db.select().from(nativeUsagePasses))[0]?.nextOrdinal).toBe('1')
    expect(await f.db.select().from(nativeUsageRevisionHeads)).toHaveLength(0)
  })

  test('missing native model or time never discards the four known Token buckets', async () => {
    const f = await fixture('fresh', true)
    const native = nativeFixture(1, 1)
    native.mutate((external) => {
      external.run('UPDATE message SET data = ?', [JSON.stringify({ role: 'assistant' })])
      external.run('UPDATE part SET time_created = NULL')
    })
    const ack = await persistNativeUsagePass(f.open(native.path, f.identity('final'), 1), f.owner())
    const sources = await f.db.select().from(taskExecutionObservationSources)
    const records = sources.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    expect(records).toHaveLength(1)
    expect(records[0]?.occurredAt).toBeNull()
    expect(records[0]?.model).toBeNull()
    expect(records[0]?.usage).toEqual({
      input: '1',
      cacheRead: '11',
      cacheWrite: '13',
      output: '7',
    })
    expect(ack.sourceWatermark).toBe(String(sources[0]!.id))
  })

  test('an unchanged last ACK never hides a missing earlier page or original member', async () => {
    for (const changed of [
      'page',
      'parent',
      'step',
      'step-document',
      'extra-step',
      'header',
    ] as const) {
      const f = await fixture('fresh')
      const native = nativeFixture()
      const identity = f.identity('final')
      const ack = await persistNativeUsagePass(f.open(native.path, identity, 1), f.owner())
      expect(BigInt(ack.ordinal)).toBeGreaterThan(1n)
      const reference = { ack, pageCount: String(BigInt(ack.ordinal) + 1n) }
      expect(
        (
          await withNativeUsageOwner(f.db, f.binding, (tx) =>
            verifyNativeUsagePass(tx, f.binding, reference, true),
          )
        ).counts,
      ).toEqual(ack.counts)
      if (changed === 'page')
        await f.db
          .delete(nativeUsagePassPages)
          .where(
            and(
              eq(nativeUsagePassPages.passId, identity.passId),
              eq(nativeUsagePassPages.ordinal, '1'),
            ),
          )
      else if (changed === 'parent')
        await f.db
          .delete(nativeUsageSessionParents)
          .where(
            and(
              eq(nativeUsageSessionParents.passId, identity.passId),
              eq(nativeUsageSessionParents.sessionId, 'root'),
            ),
          )
      else if (changed === 'step')
        await f.db
          .delete(nativeUsageStepMembers)
          .where(
            and(
              eq(nativeUsageStepMembers.passId, identity.passId),
              eq(nativeUsageStepMembers.stepId, 'step-000000'),
            ),
          )
      else if (changed === 'step-document')
        await f.db
          .update(nativeUsageStepMembers)
          .set({ document: '{}' })
          .where(
            and(
              eq(nativeUsageStepMembers.passId, identity.passId),
              eq(nativeUsageStepMembers.stepId, 'step-000000'),
            ),
          )
      else if (changed === 'extra-step')
        await f.db.insert(nativeUsageStepMembers).values({
          passId: identity.passId,
          stepId: 'unreceived-step',
          sessionId: 'root',
          ordinal: '0',
          document: '{}',
        })
      else
        await f.db
          .update(nativeUsagePasses)
          .set({ position: '0' })
          .where(eq(nativeUsagePasses.passId, identity.passId))
      await expect(
        withNativeUsageOwner(f.db, f.binding, (tx) =>
          verifyNativeUsagePass(tx, f.binding, reference, true),
        ),
      ).rejects.toThrow('Native pass verification')
    }
  })

  test('a lost snapshot preserves its pages and requires explicit replacement, never old-pass continuation', async () => {
    const f = await fixture()
    const native = nativeFixture()
    const first = f.open(native.path, f.identity(), 1)
    await f.owner().admit(first.identity, first.initialCursor, first.rootCreatedAt)
    const page = await first.next(first.initialCursor)
    await f.owner().persist(page)
    await f.owner().interrupt(first.identity, 'original snapshot closed')
    await first.close()
    await expect(
      f.owner().admit(first.identity, first.initialCursor, first.rootCreatedAt),
    ).rejects.toThrow('lost snapshot')
    const next = f.open(native.path, f.identity(), 1)
    await expect(
      f.owner().admit(next.identity, next.initialCursor, next.rootCreatedAt),
    ).rejects.toThrow('explicit new-pass')
    const final = await persistNativeUsagePass(next, f.owner(first.identity.passId))
    expect(final.eof?.counts.steps).toBe('3')
    expect(
      (
        await f.db
          .select()
          .from(nativeUsagePasses)
          .where(eq(nativeUsagePasses.passId, first.identity.passId))
      )[0]?.state,
    ).toBe('superseded')
    expect(
      (
        await f.db
          .select()
          .from(nativeUsagePassPages)
          .where(eq(nativeUsagePassPages.passId, first.identity.passId))
      ).length,
    ).toBe(1)
  })

  test('scope references retain the real deep parent chain and reject an altered page identity', async () => {
    const f = await fixture('fresh')
    const native = nativeFixture(1, 82)
    const pass = f.identity('final')
    const ack = await persistNativeUsagePass(f.open(native.path, pass), f.owner())
    const reference: ObservationNativeScopeReference = {
      root: 'root',
      session: 'child-000080',
      parentSession: 'child-000079',
      ancestry: {
        kind: 'native-pass-v2',
        identity: pass,
        ownerReceiptId: ack.ownerReceiptId,
        pageOrdinal: ack.ordinal,
        cumulativeDigest: ack.cumulativeDigest,
      },
      turn: f.binding.invocationId,
      turnIndex: 0,
      level: 'request',
    }
    expect(
      await f.pages.parent({ binding: f.binding, reference, sessionId: reference.session }),
    ).toBe('child-000079')
    await expect(
      f.pages.parent({
        binding: f.binding,
        reference: {
          ...reference,
          ancestry: { ...reference.ancestry, cumulativeDigest: 'f'.repeat(64) },
        },
        sessionId: reference.session,
      }),
    ).rejects.toThrow('outside its persisted page')
    expect(await f.pages.parent({ binding: f.binding, reference, sessionId: 'root' })).toBeNull()
  })

  test('page acknowledgements retain the actual original source row ID, including projected rows', async () => {
    const f = await fixture()
    const inserted = await f.db
      .insert(taskExecutionObservationSources)
      .values({
        taskId: f.binding.taskId,
        nodeRunId: f.binding.nodeRunId,
        evidenceJson: JSON.stringify({
          invocationId: f.binding.invocationId,
          measurements: [],
          diagnostics: [],
        }),
        pending: false,
      })
      .returning({ id: taskExecutionObservationSources.id })
    const native = nativeFixture(0, 1)
    const final = await persistNativeUsagePass(f.open(native.path, f.identity(), 1), f.owner())
    expect(final.sourceWatermark).toBe(String(inserted[0]!.id))
    expect(final.eof?.counts.steps).toBe('0')
  })

  test('native relations are assembled with the original Task table and retain its deletion cascade', async () => {
    const f = await fixture()
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity()), f.owner())
    expect((await f.db.select().from(nativeUsagePreparations)).length).toBe(1)
    expect((await f.db.select().from(nativeUsageStepMembers)).length).toBe(3)
    await f.db.delete(tasks).where(eq(tasks.id, f.binding.taskId))
    for (const table of [
      nativeUsagePreparations,
      nativeUsagePasses,
      nativeUsagePassPages,
      nativeUsageSessionParents,
      nativeUsageStepMembers,
    ]) {
      expect((await f.db.select().from(table)).length).toBe(0)
    }
  })

  function numeric(
    binding: NativeUsageOwnerBinding,
    recordId = 'opencode:step:original',
  ): ObservationMeasurement {
    return {
      schemaVersion: 1,
      invocationId: binding.invocationId,
      recordId,
      revision: 1,
      taskId: binding.taskId,
      nodeRunId: binding.nodeRunId,
      agentId: null,
      occurredAt: 100,
      observedAt: 200,
      model: { provider: 'original-provider', id: 'original-model' },
      adapterVersion: 'opencode-native-pages-v2',
      reporting: 'cumulative',
      inclusion: 'self',
      coverage: 'complete',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage: { input: '11', cacheRead: '13', cacheWrite: '17', output: '19' },
    }
  }

  test('numeric ACK retains the exact original source and replay after projection', async () => {
    const f = await fixture('fresh')
    const input = {
      binding: f.binding,
      eventId: 'actual-frame',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [numeric(f.binding)],
        diagnostics: [],
      },
    }
    const emission = new DrizzleNativeUsageEmission(f.db)
    const ack = await emission.emit(input)
    expect(ack.measurements[0]?.revision).toBe(1)
    const originals = await f.db.select().from(taskExecutionObservationSources)
    expect(originals).toHaveLength(1)
    expect(ack.sourceWatermark).toBe(String(originals[0]!.id))
    expect(JSON.parse(originals[0]!.evidenceJson).measurements).toEqual(ack.measurements)
    await f.db.update(taskExecutionObservationSources).set({ pending: false })
    expect(await new DrizzleNativeUsageEmission(f.db).emit(input)).toEqual(ack)
    const changed = { ...input, evidence: { ...input.evidence, diagnostics: ['changed'] } }
    await expect(emission.emit(changed)).rejects.toThrow('changed its frozen payload')
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(1)
    expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(1)
    const next = await emission.emit({ ...input, eventId: 'actual-next-frame' })
    expect(next.measurements[0]?.revision).toBe(2)
    expect(BigInt(next.sourceWatermark)).toBeGreaterThan(BigInt(ack.sourceWatermark))
    expect(await emission.emit(input)).toEqual(ack)
  })

  test('allocation covers all original pending, projected and observed revisions through EOF', async () => {
    const f = await fixture('fresh')
    const pending = numeric(f.binding, 'opencode:step:pending')
    const observed = numeric(f.binding, 'opencode:step:observed')
    const originals = Array.from({ length: 501 }, (_, n) => ({
      taskId: f.binding.taskId,
      nodeRunId: f.binding.nodeRunId,
      evidenceJson: JSON.stringify({
        invocationId: f.binding.invocationId,
        measurements: [{ ...pending, revision: n + 1 }],
        diagnostics: [],
      }),
      pending: n % 2 === 0,
    }))
    originals.push({
      ...originals[0]!,
      pending: false,
      evidenceJson: JSON.stringify({
        invocationId: f.binding.invocationId,
        measurements: [{ ...pending, revision: 777 }],
        diagnostics: [],
      }),
    })
    await databaseSessionFor(f.db).transaction((tx) =>
      insertInBatches(tx, taskExecutionObservationSources, originals, (batch) =>
        tx
          .insert(taskExecutionObservationSources)
          .values([...batch])
          .run(),
      ),
    )
    const sourceId = 'local-node:' + f.binding.nodeRunId
    await createUsageIngestion(createUsageLedgerStore(f.db)).ingest({
      sourceId,
      expectedCursor: null,
      nextCursor: 'original-observed',
      events: [{ eventId: 'observed-event', measurement: { ...observed, revision: 1000 } }],
    })
    const ack = await new DrizzleNativeUsageEmission(f.db).emit({
      binding: f.binding,
      eventId: 'original-high-water-frame',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [pending, observed],
        diagnostics: [],
      },
    })
    expect(ack.measurements.map((measurement) => measurement.revision)).toEqual([778, 1001])
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(503)
  }, 30_000)

  test('failed binding rolls allocation and original source back before the next ACK', async () => {
    const f = await fixture('fresh')
    const measurement = numeric(f.binding)
    const emission = new DrizzleNativeUsageEmission(f.db)
    const input = {
      binding: f.binding,
      eventId: 'rollback-frame',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [measurement, { ...measurement, taskId: 'different-original-task' }],
        diagnostics: [],
      },
    }
    await expect(emission.emit(input)).rejects.toThrow('changed its binding')
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
    expect(await f.db.select().from(nativeUsageRevisionHeads)).toHaveLength(0)
    expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(0)
    const ack = await emission.emit({
      ...input,
      evidence: { ...input.evidence, measurements: [measurement] },
    })
    expect(ack.measurements[0]?.revision).toBe(1)
  })

  test('original Task owner change cannot produce a numeric ACK', async () => {
    const f = await fixture('fresh')
    await f.db
      .update(taskExecutionOwners)
      .set({ epoch: f.binding.executionContext.token.epoch + 1 })
      .where(eq(taskExecutionOwners.taskId, f.binding.taskId))
    await expect(
      new DrizzleNativeUsageEmission(f.db).emit({
        binding: f.binding,
        eventId: 'stale-frame',
        evidence: {
          invocationId: f.binding.invocationId,
          measurements: [numeric(f.binding)],
          diagnostics: [],
        },
      }),
    ).rejects.toThrow('mutation was fenced')
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
    expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(0)
  })

  test('numeric ACK cannot escape a caller transaction that has not committed', async () => {
    const f = await fixture('fresh')
    await expect(
      databaseSessionFor(f.db).transaction(() =>
        new DrizzleNativeUsageEmission(f.db).emit({
          binding: f.binding,
          eventId: 'outer-uncommitted-frame',
          evidence: {
            invocationId: f.binding.invocationId,
            measurements: [numeric(f.binding)],
            diagnostics: [],
          },
        }),
      ),
    ).rejects.toThrow('original transaction commit')
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(0)
  })

  test('numeric native scopes reference the actual persisted parent chain', async () => {
    const f = await fixture('fresh')
    const native = nativeFixture(3, 82)
    const writer = new Database(native.path)
    try {
      writer.run('INSERT INTO message VALUES (?,?,?)', [
        'deep-message',
        'child-000080',
        JSON.stringify({
          role: 'assistant',
          providerID: 'original-provider',
          modelID: 'original-model',
        }),
      ])
      writer.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'deep-original-step',
        'child-000080',
        'deep-message',
        native.bornAt,
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: 5, output: 6, reasoning: 0, cache: { read: 7, write: 8 } },
        }),
      ])
    } finally {
      writer.close()
    }
    const final = await persistNativeUsagePass(
      f.open(native.path, f.identity('final'), 7),
      f.owner(),
    )
    const reference: ObservationNativeScopeReference = {
      root: 'root',
      session: 'child-000080',
      parentSession: 'child-000079',
      turn: f.binding.invocationId,
      turnIndex: 0,
      level: 'request',
      ancestry: {
        kind: 'native-pass-v2',
        identity: final.identity,
        ownerReceiptId: final.ownerReceiptId,
        pageOrdinal: final.ordinal,
        cumulativeDigest: final.cumulativeDigest,
      },
    }
    const emission = new DrizzleNativeUsageEmission(f.db)
    const measurement = {
      ...numeric(f.binding, 'opencode:step:deep-original-step'),
      scope: reference,
      reporting: 'delta' as const,
      occurredAt: native.bornAt,
      usage: { input: '5', cacheRead: '7', cacheWrite: '8', output: '6' },
    }
    const evidence = {
      invocationId: f.binding.invocationId,
      measurements: [measurement],
      diagnostics: [],
    }
    const ack = await emission.emit({ binding: f.binding, eventId: 'actual-deep-scope', evidence })
    expect(ack.measurements[0]?.scope).toEqual(reference)
    expect(ack.measurements[0]?.usage).toEqual(measurement.usage)
    expect(final.eof?.counts.steps).toBe('4')
    for (const [name, changed, message] of [
      ['absent-step', { ...measurement, recordId: 'opencode:step:original' }, 'step is absent'],
      [
        'other-session',
        { ...measurement, recordId: 'opencode:step:step-000000' },
        'step is absent',
      ],
      [
        'changed-input',
        { ...measurement, usage: { ...measurement.usage, input: '6' } },
        'original step numbers',
      ],
      [
        'changed-model',
        { ...measurement, model: { ...measurement.model!, id: 'other-model' } },
        'original step numbers',
      ],
      ['changed-time', { ...measurement, occurredAt: native.bornAt + 1 }, 'original step numbers'],
      [
        'summary-scope',
        { ...measurement, scope: { ...reference, level: 'self-total' as const } },
        'original step numbers',
      ],
      [
        'cumulative-step',
        { ...measurement, reporting: 'cumulative' as const },
        'original step numbers',
      ],
    ] as const) {
      await expect(
        emission.emit({
          binding: f.binding,
          eventId: name,
          evidence: { ...evidence, measurements: [changed] },
        }),
      ).rejects.toThrow(message)
    }
    const wrong = {
      ...reference,
      ancestry: {
        ...reference.ancestry,
        cumulativeDigest:
          (reference.ancestry.cumulativeDigest[0] === '0' ? '1' : '0') +
          reference.ancestry.cumulativeDigest.slice(1),
      },
    }
    await expect(
      emission.emit({
        binding: f.binding,
        eventId: 'changed-scope',
        evidence: { ...evidence, measurements: [{ ...measurement, scope: wrong }] },
      }),
    ).rejects.toThrow('changed its persisted page')
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(1)
  }, 30_000)

  test('concurrent original frames get distinct increasing revisions', async () => {
    const f = await fixture('fresh')
    const emission = new DrizzleNativeUsageEmission(f.db)
    const evidence = {
      invocationId: f.binding.invocationId,
      measurements: [numeric(f.binding)],
      diagnostics: [],
    }
    const replies = await Promise.all(
      ['first-original', 'second-original'].map((eventId) =>
        emission.emit({ binding: f.binding, eventId, evidence }),
      ),
    )
    expect(replies.map((ack) => ack.measurements[0]!.revision).sort((a, b) => a - b)).toEqual([
      1, 2,
    ])
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(2)
    expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(2)
  })

  async function originalSpawn(f: Awaited<ReturnType<typeof fixture>>) {
    const nativeProcess = {
      contract: 'native-process-facts-v2' as const,
      phase: 'spawned' as const,
      pid: process.pid,
      launchNonce: randomUUID(),
      spawnedAt: Date.now(),
      reapedAt: null,
      drainedAt: null,
      outcome: null,
      drainTimedOut: false,
      pumpError: false,
    }
    const emission = new DrizzleNativeUsageEmission(f.db)
    await emission.emit({
      binding: f.binding,
      eventId: 'original-spawn',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [],
        diagnostics: [],
        nativeProcess,
      },
    })
    return nativeProcess
  }
  async function originalSettle(
    f: Awaited<ReturnType<typeof fixture>>,
    spawn: Awaited<ReturnType<typeof originalSpawn>>,
  ) {
    await new DrizzleNativeUsageEmission(f.db).emit({
      binding: f.binding,
      eventId: 'original-settled',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [],
        diagnostics: [],
        nativeProcess: {
          ...spawn,
          phase: 'settled',
          reapedAt: Date.now(),
          drainedAt: Date.now(),
          outcome: 'success',
        },
      },
    })
  }

  test('complete original seal verifies every one of1001 numbers and frozen source ACK', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture(1001, 81)
    const ack = await persistNativeUsagePass(
      f.open(native.path, f.identity('final'), 81),
      f.owner(),
    )
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('complete')
    expect(proof.issues).toEqual([])
    expect(proof.final?.ack).toEqual(ack)
    expect(proof.final?.ack.counts).toEqual({ sessions: '81', parts: '1001', steps: '1001' })
    expect(proof.emissions.records).toBe('1001')
    expect(proof.reconciliation.examined).toBe('0')
    expect(proof.process).toEqual({
      spawnedAt: spawn.spawnedAt,
      reapedAt: expect.any(Number),
      drainedAt: expect.any(Number),
    })
    const sourceCount = (await f.db.select().from(taskExecutionObservationSources)).length
    const seal = await completion.seal({ binding: f.binding, completion: proof })
    expect(seal.measurements).toEqual([])
    expect(BigInt(seal.sourceWatermark)).toBeGreaterThan(BigInt(proof.emissions.sourceWatermark))
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(sourceCount + 1)
    expect(
      await new DrizzleNativeUsageCompletion(f.db).seal({ binding: f.binding, completion: proof }),
    ).toEqual(seal)
    expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(sourceCount + 1)
    expect((await f.db.select().from(nativeUsagePreparations))[0]?.state).toBe('sealed')
  }, 60_000)

  test('complete empty native tree is verified from original EOF and process, never a missing scan', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture(0, 1)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('complete')
    expect(proof.emissions.records).toBe('0')
    expect(proof.final?.ack.counts.steps).toBe('0')
    expect(proof.final?.ack.eof).not.toBeNull()
    expect(proof.emissions.frames).toBe('2')
    expect((await completion.seal({ binding: f.binding, completion: proof })).measurements).toEqual(
      [],
    )
  })

  test('unknown model and step time retain complete actual Token proof without a CNY quote', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    native.mutate((db) => {
      db.run('UPDATE message SET data=?', [JSON.stringify({ role: 'assistant' })])
      db.run('UPDATE part SET time_created=NULL')
    })
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('complete')
    expect(proof.issues).toEqual([])
    expect(proof.emissions.records).toBe('3')
    const sources = await f.db.select().from(taskExecutionObservationSources)
    const numbers = sources.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    expect(numbers).toHaveLength(3)
    expect(numbers.every((row) => row.model === null && row.occurredAt === null)).toBe(true)
    expect(numbers[0]?.usage).toEqual({
      input: '1',
      cacheRead: '11',
      cacheWrite: '13',
      output: '7',
    })
    await completion.seal({ binding: f.binding, completion: proof })
  })

  test('missing final and process remain partial and preserve the actual empty emission population', async () => {
    const f = await fixture('fresh', true)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('partial')
    expect(proof.final).toBeNull()
    expect(proof.rootSessionId).toBeNull()
    expect(proof.baseline.kind === 'fresh' && proof.baseline.rootCreatedAt).toBeNull()
    expect(proof.emissions.records).toBe('0')
    expect(proof.emissions.frames).toBe('0')
    expect(proof.emissions.sourceWatermark).toBe('0')
    expect(proof.issues).toContain('native-final-unavailable')
    expect(proof.issues).toContain('native-process-incomplete')
    const ack = await completion.seal({ binding: f.binding, completion: proof })
    expect(ack.measurements).toEqual([])
    expect((await f.db.select().from(nativeUsagePreparations))[0]?.state).toBe('open')
  })

  test('partial completion retries verify earlier original seals before a later complete seal', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const first = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(first.state).toBe('partial')
    const firstAck = await completion.seal({ binding: f.binding, completion: first })
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const final = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(final.state).toBe('complete')
    expect(final.emissions.records).toBe('3')
    const finalAck = await completion.seal({ binding: f.binding, completion: final })
    expect(BigInt(finalAck.sourceWatermark)).toBeGreaterThan(BigInt(firstAck.sourceWatermark))
    expect(await completion.seal({ binding: f.binding, completion: first })).toEqual(firstAck)
    expect(await completion.seal({ binding: f.binding, completion: final })).toEqual(finalAck)
  })

  test('completion rejects invented numeric counts and preserves every actual source row', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    const before = await f.db.select().from(taskExecutionObservationSources)
    await expect(
      completion.seal({
        binding: f.binding,
        completion: { ...proof, emissions: { ...proof.emissions, records: '4' } },
      }),
    ).rejects.toThrow('complete original evidence')
    expect(await f.db.select().from(taskExecutionObservationSources)).toEqual(before)
    expect((await f.db.select().from(nativeUsagePreparations))[0]?.state).toBe('open')
  })

  test('completion rejects missing original numeric source even when the frozen frame survives', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const frame = (await f.db.select().from(nativeUsageEmissions)).find((row) =>
      JSON.parse(row.document).request.includes('opencode:step:'),
    )!
    await f.db
      .delete(taskExecutionObservationSources)
      .where(eq(taskExecutionObservationSources.id, frame.sourceRowId))
    const completion = new DrizzleNativeUsageCompletion(f.db)
    await expect(
      completion.describeCompletion({ binding: f.binding, observedAt: Date.now() }),
    ).rejects.toThrow('original source or frozen ACK')
    expect((await f.db.select().from(nativeUsagePreparations))[0]?.state).toBe('open')
  })

  test('completion cannot be observed before its real source measurement watermark', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    await expect(
      completion.describeCompletion({ binding: f.binding, observedAt: f.before.preparedAt - 1 }),
    ).rejects.toThrow('precedes its actual original evidence')
    expect((await f.db.select().from(nativeUsagePreparations))[0]?.state).toBe('open')
  })

  async function originalLegacyHistory(native: ReturnType<typeof nativeFixture>) {
    const original = await fixture('fresh')
    const invocationId = original.binding.invocationId + '-legacy'
    const binding = { ...original.binding, invocationId }
    await createObservationInvocationStore(original.db).accept({
      invocationId,
      taskId: binding.taskId,
      nodeRunId: binding.nodeRunId,
      agentId: null,
      agentRevision: null,
      purpose: 'task',
      authority: { kind: 'local', runtime: null },
      nativeCaptureContract: 'opencode-child-steps-v1',
      nativeCaptureSource: 'actual-native-store',
    })
    const capture = createNativeUsageCapture({
      ...binding,
      agentId: null,
      nativeSource: 'actual-native-store',
      read: (root) => readOpencodeUsageSnapshot(native.path, root),
    })
    capture.begin()
    const frames = capture.finish('root', Date.now())
    expect(frames.at(-1)?.capture?.state).toBe('complete')
    for (const frame of frames)
      await original.db.insert(taskExecutionObservationSources).values({
        taskId: binding.taskId,
        nodeRunId: binding.nodeRunId,
        evidenceJson: JSON.stringify(frame),
      })
    const store = createUsageLedgerStore(original.db)
    const project = createUsageSourceProjection({
      source: createObservationUsageSource(original.db),
      store,
      invocations: createObservationInvocationStore(original.db),
    })
    while (await project(binding.nodeRunId)) {
      // Consume the actual original source until its persisted cursor reaches EOF.
    }
    return { binding, sourceId: 'local-node:' + binding.nodeRunId, store }
  }

  test('resume verifies every actual historical baseline and emits only new invocation usage', async () => {
    const native = nativeFixture()
    const history = await originalLegacyHistory(native)
    const f = await fixture('resume', true)
    const before = await persistNativeUsagePass(f.open(native.path, f.identity(), 37), f.owner())
    const spawn = await originalSpawn(f)
    native.mutate((db) =>
      db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
        'step-000003',
        'root',
        'message',
        Date.now(),
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: 19, output: 5, reasoning: 2, cache: { read: 11, write: 13 } },
        }),
      ]),
    )
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('complete')
    expect(proof.baseline.kind === 'resume' && proof.baseline.pass?.ack).toEqual(before)
    expect(proof.reconciliation).toEqual({
      examined: '3',
      resolved: '3',
      unresolved: '0',
      digest: expect.any(String),
    })
    expect(proof.emissions.records).toBe('1')
    expect(proof.final?.ack.counts.steps).toBe('4')
    const originals = await f.db.select().from(observationUsageCurrent)
    expect(originals).toHaveLength(3)
    expect(
      originals.every(
        (row) => JSON.parse(row.document).measurement.invocationId === history.binding.invocationId,
      ),
    ).toBe(true)
    const sourceRows = await f.db
      .select()
      .from(taskExecutionObservationSources)
      .where(eq(taskExecutionObservationSources.nodeRunId, f.binding.nodeRunId))
    const records = sourceRows.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    expect(records.map((row) => row.recordId)).toEqual(['opencode:step:step-000003'])
    await completion.seal({ binding: f.binding, completion: proof })
  }, 30_000)

  test('unresolved original historical change blocks completeness until its real ledger correction', async () => {
    const native = nativeFixture()
    const history = await originalLegacyHistory(native)
    const f = await fixture('resume', true)
    await persistNativeUsagePass(f.open(native.path, f.identity(), 37), f.owner())
    const spawn = await originalSpawn(f)
    native.mutate((db) =>
      db.run('UPDATE part SET data=? WHERE id=?', [
        JSON.stringify({
          type: 'step-finish',
          tokens: { input: 42, output: 5, reasoning: 2, cache: { read: 11, write: 13 } },
        }),
        'step-000000',
      ]),
    )
    const final = await persistNativeUsagePass(
      f.open(native.path, f.identity('final'), 37),
      f.owner(),
    )
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const before = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(before.state).toBe('partial')
    expect(before.emissions.records).toBe('0')
    expect(before.reconciliation).toEqual({
      examined: '3',
      resolved: '2',
      unresolved: '1',
      digest: expect.any(String),
    })
    expect(before.issues).toContain('native-prior-revision-unresolved')
    await completion.seal({ binding: f.binding, completion: before })
    const current = (await f.db.select().from(observationUsageCurrent))
      .map((row) => JSON.parse(row.document))
      .find((row) => row.measurement.recordId === 'opencode:step:step-000000')!
    const ingest = createUsageIngestion(history.store)
    const outcome = await ingest.ingest({
      sourceId: history.sourceId,
      expectedCursor: await ingest.cursor(history.sourceId),
      nextCursor: 'node-event:' + final.sourceWatermark,
      nativeSource: 'actual-native-store',
      nativeWatermark: Number(final.sourceWatermark),
      events: [
        {
          eventId: 'original-historical-correction',
          measurement: {
            ...current.measurement,
            revision: current.observedRevision + 1,
            observedAt: Date.now(),
            usage: { ...current.measurement.usage, input: '42' },
            validity: 'correction',
          },
        },
      ],
    })
    expect(outcome.applied).toBe(1)
    const closed = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(closed.state).toBe('complete')
    expect(closed.reconciliation.resolved).toBe('3')
    expect(closed.reconciliation.unresolved).toBe('0')
    expect(closed.reconciliation.digest).not.toBe(before.reconciliation.digest)
    expect(closed.emissions.records).toBe('0')
    await completion.seal({ binding: f.binding, completion: closed })
  }, 30_000)

  test('missing resume before never turns old native parts into new Task numbers', async () => {
    const native = nativeFixture()
    const f = await fixture('resume', true)
    const spawn = await originalSpawn(f)
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('partial')
    expect(proof.baseline).toEqual({ kind: 'resume', pass: null })
    expect(proof.issues).toContain('native-baseline-unavailable')
    expect(proof.emissions.records).toBe('0')
    expect(proof.final?.ack.counts.steps).toBe('3')
    const records = (await f.db.select().from(taskExecutionObservationSources)).flatMap(
      (row) => JSON.parse(row.evidenceJson).measurements,
    )
    expect(records).toEqual([])
    await completion.seal({ binding: f.binding, completion: proof })
  })

  test('known buckets with a partial original coverage receipt remain partial without losing numbers', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
    await originalSettle(f, spawn)
    const source = (await f.db.select().from(taskExecutionObservationSources)).find(
      (row) => JSON.parse(row.evidenceJson).measurements.length > 0,
    )!
    const measured = JSON.parse(source.evidenceJson).measurements[0]
    const ack = await new DrizzleNativeUsageEmission(f.db).emit({
      binding: f.binding,
      eventId: 'original-partial-coverage',
      evidence: {
        invocationId: f.binding.invocationId,
        measurements: [{ ...measured, coverage: 'partial' }],
        diagnostics: [],
      },
    })
    expect(ack.measurements[0]?.usage).toEqual(measured.usage)
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('partial')
    expect(proof.issues).toContain('native-numeric-coverage-incomplete')
    expect(proof.issues).not.toContain('native-token-bucket-unknown')
    expect(proof.emissions.records).toBe('4')
    await completion.seal({ binding: f.binding, completion: proof })
  })

  test('completion uses the latest allocated revision when one actual frame revises a record twice', async () => {
    for (const coverage of ['partial', 'complete'] as const) {
      const f = await fixture('fresh', true)
      const spawn = await originalSpawn(f)
      const native = nativeFixture()
      await persistNativeUsagePass(f.open(native.path, f.identity('final'), 37), f.owner())
      await originalSettle(f, spawn)
      const source = (await f.db.select().from(taskExecutionObservationSources)).find(
        (row) =>
          row.taskId === f.binding.taskId && JSON.parse(row.evidenceJson).measurements.length > 0,
      )!
      const measured = JSON.parse(source.evidenceJson).measurements[0]
      const ack = await new DrizzleNativeUsageEmission(f.db).emit({
        binding: f.binding,
        eventId: 'actual-two-revisions-' + coverage,
        evidence: {
          invocationId: f.binding.invocationId,
          measurements: [
            { ...measured, coverage: coverage === 'partial' ? 'complete' : 'partial' },
            { ...measured, coverage },
          ],
          diagnostics: [],
        },
      })
      expect(ack.measurements.map((row) => row.revision)).toEqual([
        measured.revision + 1,
        measured.revision + 2,
      ])
      expect(
        ack.measurements.every(
          (row) => JSON.stringify(row.usage) === JSON.stringify(measured.usage),
        ),
      ).toBe(true)
      const completion = new DrizzleNativeUsageCompletion(f.db)
      const proof = await completion.describeCompletion({
        binding: f.binding,
        observedAt: Date.now(),
      })
      expect(proof.state).toBe(coverage)
      expect(proof.issues.includes('native-numeric-coverage-incomplete')).toBe(
        coverage === 'partial',
      )
      expect(proof.issues).not.toContain('native-token-bucket-unknown')
      expect(proof.emissions.records).toBe('5')
      await completion.seal({ binding: f.binding, completion: proof })
      expect(
        (
          await f.db
            .select()
            .from(nativeUsagePreparations)
            .where(eq(nativeUsagePreparations.invocationId, f.binding.invocationId))
        )[0]?.state,
      ).toBe(coverage === 'complete' ? 'sealed' : 'open')
    }
  })

  test('completion accepts an early original step at a later actual ACK and rejects missing or earlier pages', async () => {
    const f = await fixture('fresh', true)
    const spawn = await originalSpawn(f)
    const native = nativeFixture()
    const final = await persistNativeUsagePass(
      f.open(native.path, f.identity('final'), 1),
      f.owner(),
    )
    await originalSettle(f, spawn)
    const sources = await f.db.select().from(taskExecutionObservationSources)
    const numbers = sources.flatMap((row) => JSON.parse(row.evidenceJson).measurements)
    const first = numbers.find((row) => row.recordId === 'opencode:step:step-000000')!
    const last = numbers.find((row) => row.recordId === 'opencode:step:step-000002')!
    expect(BigInt(first.scope.ancestry.pageOrdinal)).toBeLessThan(BigInt(final.ordinal))
    expect(BigInt(last.scope.ancestry.pageOrdinal)).toBeGreaterThan(
      BigInt(first.scope.ancestry.pageOrdinal),
    )
    const measured = {
      ...first,
      scope: {
        ...first.scope,
        ancestry: {
          ...first.scope.ancestry,
          identity: final.identity,
          ownerReceiptId: final.ownerReceiptId,
          pageOrdinal: final.ordinal,
          cumulativeDigest: final.cumulativeDigest,
        },
      },
    }
    const emission = new DrizzleNativeUsageEmission(f.db)
    const ack = await emission.emit({
      binding: f.binding,
      eventId: 'actual-later-page-reference',
      evidence: { invocationId: f.binding.invocationId, measurements: [measured], diagnostics: [] },
    })
    expect(ack.measurements[0]?.scope).toEqual(measured.scope)
    expect(ack.measurements[0]?.usage).toEqual(first.usage)
    const countSources = (await f.db.select().from(taskExecutionObservationSources)).length
    const countMappings = (await f.db.select().from(nativeUsageEmissions)).length
    for (const [eventId, changed, message] of [
      [
        'missing-page-reference',
        {
          ...measured,
          scope: {
            ...measured.scope,
            ancestry: {
              ...measured.scope.ancestry,
              pageOrdinal: String(BigInt(final.ordinal) + 1n),
            },
          },
        },
        'changed its persisted page',
      ],
      ['step-outside-earlier-page', { ...last, scope: first.scope }, 'step is absent or outside'],
    ] as const) {
      await expect(
        emission.emit({
          binding: f.binding,
          eventId,
          evidence: {
            invocationId: f.binding.invocationId,
            measurements: [changed],
            diagnostics: [],
          },
        }),
      ).rejects.toThrow(message)
      expect(await f.db.select().from(taskExecutionObservationSources)).toHaveLength(countSources)
      expect(await f.db.select().from(nativeUsageEmissions)).toHaveLength(countMappings)
    }
    const completion = new DrizzleNativeUsageCompletion(f.db)
    const proof = await completion.describeCompletion({
      binding: f.binding,
      observedAt: Date.now(),
    })
    expect(proof.state).toBe('complete')
    expect(proof.issues).toEqual([])
    expect(proof.final?.ack).toEqual(final)
    await completion.seal({ binding: f.binding, completion: proof })
  })
})
