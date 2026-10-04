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
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { DrizzleNativeUsagePages } from '@/modules/task-execution/infrastructure/drizzleNativeUsagePages'
import { openOpencodeUsagePass } from '@/modules/runtime-management/infrastructure/opencodeUsagePass'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import type { NativeUsagePassOwner } from '@/modules/runtime-management/application/ports/nativeUsageOwner'
import type { NativeUsageOwnerBinding } from '@/modules/task-execution/application/ports/nativeUsagePersistence'
import type { ObservationNativePassIdentity } from '@agent-workflow/shared/schemas/observationNativePages'
import type { ObservationNativeScopeReference } from '@agent-workflow/shared/schemas/observationNativeCompletion'
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
  return { path, bornAt }
}

describeEachProvider('RFC-371 original native pages and membership', (harness) => {
  async function fixture(mode: 'fresh' | 'resume' = 'resume') {
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
    const pages = new DrizzleNativeUsagePages(db)
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
})
