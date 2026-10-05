// RFC-371: a resume must check its entire original before index once and retain
// that actual snapshot while final pages commit. Losing a live old member must
// never charge an old native step to the resumed invocation.
// Keep the original COUNT(*) proof separate from full-page reads; see
// design/RFC-371-run-observability/native-baseline-ci-repair.md.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { openDb } from '@/db/client'
import { nativeUsageStepMembers } from '@/db/schema'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { originalSqliteFileReportSnapshot } from '@/platform/persistence/reportSqliteSnapshot'
import {
  originalNativeUsageBaseline,
  withNativeUsageBaselineSnapshot,
} from '@/modules/task-execution/infrastructure/nativeUsageBaselineSnapshot'
import type { NativeUsageBaselineReadView } from '@/modules/task-execution/application/ports/nativeUsageBaseline'
import { DrizzleNativeUsagePages } from '@/modules/task-execution/infrastructure/drizzleNativeUsagePages'
import { persistNativeUsagePass } from '@/modules/runtime-management/application/persistNativeUsagePass'
import { createObservationUsageSource } from '@/modules/task-execution/infrastructure/observationUsageSource'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { originalNativeLedgerFixture } from './helpers/rfc371NativeLedgerFixture'
import { MIGRATIONS } from './migration-freeze'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
function nativeStore(steps: number) {
  const directory = mkdtempSync(join(tmpdir(), 'aw-before-index-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'native.db'),
    db = new Database(path)
  cleanups.push(() => db.close())
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER); CREATE INDEX session_parent ON session(parent_id,id); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); CREATE INDEX part_session ON part(session_id,id);',
  )
  db.run('INSERT INTO session VALUES (?,?,?)', ['root', null, Date.now()])
  db.run('INSERT INTO message VALUES (?,?,?)', [
    'message',
    'root',
    JSON.stringify({ role: 'assistant', providerID: 'actual-provider', modelID: 'actual-model' }),
  ])
  const add = (from: number, through: number) =>
    db.transaction(() => {
      for (let n = from; n < through; n++)
        db.run('INSERT INTO part VALUES (?,?,?,?,?)', [
          'step-' + String(n).padStart(8, '0'),
          'root',
          'message',
          Date.now(),
          JSON.stringify({
            type: 'step-finish',
            tokens: { input: n + 1, output: 5, reasoning: 0, cache: { read: 7, write: 11 } },
          }),
        ])
    })()
  add(0, steps)
  return { path, directory, add }
}
const step = (n: number) => 'step-' + String(n).padStart(8, '0')

describeEachProvider('RFC-371 verified original native before snapshot', (harness) => {
  const snapshots = () => {
    const original = harness.applicationBinding
    return originalReportSnapshotSession(
      original.provider === 'sqlite'
        ? { ...original, generationId: 'original-before-read' }
        : { provider: 'postgresql', runtime: original.runtime },
    )
  }
  test('2501 original members remain exact through every lookup without rescanning original pages', async () => {
    const native = nativeStore(2501),
      f = await originalNativeLedgerFixture(harness, 'resume', false)
    await persistNativeUsagePass(f.open(native.path, f.identity('baseline'), 31), f.owner())
    const original = await originalNativeUsageBaseline({
      db: f.db,
      binding: f.binding,
      before: f.before,
    })
    expect(original).not.toBeNull()
    const recording = harness.recordStatements()
    let retained: NativeUsageBaselineReadView | undefined
    const originalPageQueries = () =>
      recording.selects().filter((r) => r.sql.includes('native_usage_pass_pages'))
    const isPopulationCount = (sql: string) => /\bcount\s*\(\s*\*\s*\)/i.test(sql)
    const originalPagesRead = () =>
      originalPageQueries()
        .filter((r) => !isPopulationCount(r.sql))
        .reduce((sum, r) => sum + r.rows, 0)
    try {
      await withNativeUsageBaselineSnapshot({
        snapshots: snapshots(),
        binding: f.binding,
        original: original!,
        run: async (view) => {
          expect(view).not.toBeNull()
          retained = view!
          const beforeLookup = originalPagesRead()
          expect(beforeLookup).toBe(Number(original!.pageCount))
          expect(originalPageQueries().filter((r) => isPopulationCount(r.sql))).toHaveLength(1)
          const beforeQueryCount = originalPageQueries().length
          let verified = 0
          for (let from = 0; from < 2501; from += 97) {
            const ids = Array.from({ length: Math.min(97, 2501 - from) }, (_, n) => step(from + n))
            const members = await view!.members([...ids, 'not-an-original-member'])
            expect([...members].sort()).toEqual(ids)
            verified += members.size
          }
          expect(verified).toBe(2501)
          expect(originalPagesRead()).toBe(beforeLookup)
          expect(originalPageQueries()).toHaveLength(beforeQueryCount)
        },
      })
    } finally {
      recording.stop()
    }
    await expect(retained!.members([step(0)])).rejects.toThrow('already closed')
  }, 120_000)

  test('a changed original member is rejected before any cached membership can be used', async () => {
    const native = nativeStore(17),
      f = await originalNativeLedgerFixture(harness, 'resume', false)
    await persistNativeUsagePass(f.open(native.path, f.identity('baseline'), 7), f.owner())
    const original = await originalNativeUsageBaseline({
      db: f.db,
      binding: f.binding,
      before: f.before,
    })
    await f.db
      .delete(nativeUsageStepMembers)
      .where(
        and(
          eq(nativeUsageStepMembers.passId, original!.ack.identity.passId),
          eq(nativeUsageStepMembers.stepId, step(0)),
        ),
      )
    let entered = false
    await expect(
      withNativeUsageBaselineSnapshot({
        snapshots: snapshots(),
        binding: f.binding,
        original: original!,
        run: async () => {
          entered = true
        },
      }),
    ).rejects.toThrow('original step member')
    expect(entered).toBe(false)
  }, 30_000)
})

test('actual separate SQLite WAL before view preserves old membership across final commits and live index loss', async () => {
  const native = nativeStore(1001)
  const db = openDb({
    path: join(native.directory, 'original-task-ledger.db'),
    migrationsFolder: MIGRATIONS,
  })
  cleanups.push(() => db.$client.close())
  const f = await originalNativeLedgerFixture({ db }, 'resume', false)
  await persistNativeUsagePass(f.open(native.path, f.identity('baseline'), 41), f.owner())
  const original = await originalNativeUsageBaseline({ db, binding: f.binding, before: f.before })
  expect(original).not.toBeNull()
  native.add(1001, 1003)
  await withNativeUsageBaselineSnapshot({
    snapshots: originalSqliteFileReportSnapshot({
      filename: db.$client.filename,
      generationId: 'actual-task-wal-before',
    }),
    binding: f.binding,
    original: original!,
    run: async (view) => {
      expect(view).not.toBeNull()
      await db
        .delete(nativeUsageStepMembers)
        .where(
          and(
            eq(nativeUsageStepMembers.passId, original!.ack.identity.passId),
            eq(nativeUsageStepMembers.stepId, step(0)),
          ),
        )
      expect(await view!.members([step(0)])).toEqual(new Set([step(0)]))
      const pages = new DrizzleNativeUsagePages(db, true, view)
      await persistNativeUsagePass(f.open(native.path, f.identity('final'), 47), {
        admit: (identity, initialCursor, rootCreatedAt) =>
          pages.admit({
            binding: f.binding,
            identity,
            initialCursor,
            rootCreatedAt,
            beforeSpawnReceiptId: f.before.ownerReceiptId,
          }),
        persist: (page) =>
          pages.persist({
            binding: f.binding,
            page: {
              ...page,
              sessions: [...page.sessions],
              steps: [...page.steps],
              issues: [...page.issues],
            },
          }),
        interrupt: (identity, reason) => pages.interrupt({ binding: f.binding, identity, reason }),
      })
      expect(await view!.members([step(0), step(1000), step(1001)])).toEqual(
        new Set([step(0), step(1000)]),
      )
    },
  })
  const ledger = createUsageLedgerStore(db)
  const project = createUsageSourceProjection({
    source: createObservationUsageSource(db),
    store: ledger,
    invocations: createObservationInvocationStore(db),
  })
  while (await project(f.binding.nodeRunId)) {
    /* Drain this exact original source to EOF. */
  }
  const records = await ledger.records(f.binding.taskId, { limit: 10 })
  const received = [...records.items].sort((a, b) =>
    a.measurement.recordId.localeCompare(b.measurement.recordId),
  )
  expect(received.map((r) => r.measurement.recordId)).toEqual([
    'opencode:step:' + step(1001),
    'opencode:step:' + step(1002),
  ])
  expect(records.nextCursor).toBeUndefined()
  expect(received.map((r) => r.contribution)).toEqual([
    { input: '1002', output: '5', cacheRead: '7', cacheWrite: '11' },
    { input: '1003', output: '5', cacheRead: '7', cacheWrite: '11' },
  ])
}, 120_000)
