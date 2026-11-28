// RFC-626 §3.3 "悬空行" and "收尾处置" (design/RFC-626-upgrade-no-refusal-minimal-time/design.md),
// on a real target database. Setting a row aside can leave rows in other tables pointing at
// nothing. With automatic resolution the target finalize does not fail on them: a reference
// that has a way to be kept is cleared or re-pointed and its row stays — foreign keys the
// schema declares `set null`, and the policies modules declare — and any other referring row
// is moved to the archive, round after round until nothing dangles. Every change of one
// reference of one target row is recorded in the transaction that makes it, so the work can
// be interrupted and repeated, and the report lists what was done from those records. A seed
// row of the target schema is never moved away. Without the option finalize reports dangling
// rows as violations, exactly as before.
//
// The target is the small synthetic schema of rfc626-engine-fixtures, installed by the real
// installer; rows get into it through the real engine and the real sink
// (rfc626-target-fixtures), so the run and its records are the ones a conversion leaves behind.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import type { HistoryConnection } from '@/platform/persistence/schema/history/connection'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { requiredSeedKeys } from '@/platform/persistence/migration/conversion/requiredSeeds'
import type { ArchiveRef, EncodedKey } from '@/platform/persistence/migration/conversion/types'
import type {
  ConversionTargetConnection,
  FinalizeDisposition,
  TargetFinalizeReport,
} from '@/platform/persistence/migration/run/types'
import {
  FINALIZE_REFERENCE_UNIT,
  resolveDanglingReferences,
} from '@/platform/persistence/migration/target/dangling'
import {
  SEED_MISSION,
  SYSTEM_USER,
  fixtureTarget,
  fxRun,
  targetKey,
  type Emission,
} from './rfc626-engine-fixtures.test'
import {
  convertedTarget,
  fixtureHandle,
  keepPolicies,
  member,
  mission,
  run,
  runInput,
  seedRows,
  targetIds,
  targetRow,
  targetRows,
  task,
  user,
  type ConvertedTarget,
} from './rfc626-target-fixtures.test'

// Installing the fixture schema, converting into it and finalizing takes a few seconds per case
// on a CI-scaled PostgreSQL; 60 s leaves the margin the other target tests use.
setDefaultTimeout(60_000)

const dangling = { policies: keepPolicies }

/** The finalize records of a run, as persisted. */
async function referenceRecords(f: ConvertedTarget) {
  return (await f.meta.select('migration_records', { runId: f.runId, kind: 'decision' }))
    .filter((row) => String(row.unitId).startsWith(FINALIZE_REFERENCE_UNIT))
    .map((row) => ({
      unitId: String(row.unitId),
      ordinal: Number(row.ordinal),
      json: JSON.stringify(row.recordJson),
      payload: (row.recordJson as { payload: FinalizeDisposition }).payload,
    }))
}
/** Whether a value read back from an archive holds an object with these cells. */
function holdsRow(value: unknown, cells: Readonly<Record<string, unknown>>): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((entry) => holdsRow(entry, cells))
  const record = value as Record<string, unknown>
  if (Object.entries(cells).every(([name, cell]) => name in record && record[name] === cell))
    return true
  return Object.values(record).some((entry) => holdsRow(entry, cells))
}
/** The archived row a disposition names: one row, in the format of a single logical row. */
async function archivedRow(f: ConvertedTarget, ref: ArchiveRef | null): Promise<unknown> {
  if (ref === null) throw new Error('the disposition names no archive')
  const archive = await f.meta.archive({ runId: f.runId, ref })
  if (!archive) throw new Error(`no archive ${ref}`)
  expect(String(archive.format)).toBe('logical-row@1')
  expect(Number(archive.rows)).toBe(1)
  expect(String(ref)).toBe(`archive:${bytesDigest(archive.bytes)}`)
  return JSON.parse(Buffer.from(archive.bytes).toString('utf8'))
}
type Expected = Omit<FinalizeDisposition, 'archive'> & { readonly archive: unknown }
const kept = (
  table: string,
  key: EncodedKey,
  foreignKey: string,
  references: string,
  action: 'detached' | 'substituted',
): Expected => ({
  targetTable: table,
  targetKey: key,
  foreignKey,
  references,
  action,
  archive: null,
})
const moved = (
  table: string,
  key: EncodedKey,
  foreignKey: string,
  references: string,
): Expected => ({
  targetTable: table,
  targetKey: key,
  foreignKey,
  references,
  action: 'set-aside',
  archive: expect.stringMatching(/^archive:sha256:[a-f0-9]{64}$/),
})
/** The list is in target table, target key, foreign key order. */
function expectOrdered(report: TargetFinalizeReport): void {
  const listed = (report.dispositions ?? []).map((entry): string[] => [
    entry.targetTable,
    entry.targetKey,
    entry.foreignKey,
  ])
  const ordered = [...listed].sort((a, b) => {
    for (const [index, cell] of a.entries()) {
      const other = b[index]!
      if (cell !== other) return cell < other ? -1 : 1
    }
    return 0
  })
  expect(listed).toEqual(ordered)
}
function find(
  report: TargetFinalizeReport,
  table: string,
  key: EncodedKey,
  foreignKey: string,
): FinalizeDisposition {
  const found = report.dispositions?.find(
    (entry) =>
      entry.targetTable === table && entry.targetKey === key && entry.foreignKey === foreignKey,
  )
  if (!found) throw new Error(`no disposition ${table}/${foreignKey}`)
  return found
}

/** A chain: each level only starts to dangle once the level above it has been moved away. */
const cascade: readonly (readonly Emission[])[] = [
  ...seedRows,
  [task('t1', { parent_id: 'ghost-parent' })],
  [task('t2', { parent_id: 't1', owner_id: 'ghost-user' })],
  [task('t3', { parent_id: 't2' })],
  [run('r3', 't3'), runInput('r3', 'in', null)],
  [task('t-stays'), run('r-stays', 't-stays')],
]
const cascadeDispositions: readonly Expected[] = [
  moved('fx_run_inputs', targetKey('fx_run_inputs', 'r3', 'in'), 'fx_run_inputs_run_fk', 'fx_runs'),
  moved('fx_runs', targetKey('fx_runs', 'r3'), 'fx_runs_task_fk', 'fx_tasks'),
  moved('fx_tasks', targetKey('fx_tasks', 't1'), 'fx_tasks_parent_fk', 'fx_tasks'),
  kept('fx_tasks', targetKey('fx_tasks', 't2'), 'fx_tasks_owner_fk', 'fx_users', 'detached'),
  moved('fx_tasks', targetKey('fx_tasks', 't2'), 'fx_tasks_parent_fk', 'fx_tasks'),
  moved('fx_tasks', targetKey('fx_tasks', 't3'), 'fx_tasks_parent_fk', 'fx_tasks'),
]
async function expectCascadeResolved(
  h: V3Harness,
  f: ConvertedTarget,
  report: TargetFinalizeReport,
): Promise<void> {
  expect(report.violations).toEqual([])
  expect(report.deferredConstraintsApplied).toBe(true)
  expect(report.dispositions).toEqual<unknown>(cascadeDispositions)
  expectOrdered(report)
  expect(await targetIds(h, 'fx_tasks')).toEqual(['t-stays'])
  expect(await targetIds(h, 'fx_runs')).toEqual(['r-stays'])
  expect(await targetRows(h, 'fx_run_inputs')).toEqual([])
  expect(await targetIds(h, 'fx_users')).toEqual([SYSTEM_USER])
  const records = await referenceRecords(f)
  expect(records).toHaveLength(cascadeDispositions.length)
  expect(new Set(records.map((record) => record.unitId)).size).toBe(records.length)
  expect(records.every((record) => record.ordinal === 0)).toBe(true)
}

describeV3Providers('RFC-626 finalize resolves dangling references', (h) => {
  test('a reference with a way to be kept is cleared or re-pointed; any other referring row is moved to the archive', async () => {
    const f = await convertedTarget(h, [
      ...seedRows,
      [user('alice')],
      [task('t-owned', { owner_id: 'alice' })],
      // The schema says `set null`: the task stays without its owner.
      [task('t-orphaned-owner', { owner_id: 'ghost-user' })],
      // A module says so: the mission stays without its origin.
      [mission('m-reopened', 'ghost-mission')],
      // A module says so, and the column cannot be null: the member stays under the system user.
      [member('t-owned', 'alice', 'ghost-user')],
      // Nothing says a run can do without its task.
      [run('r-orphan', 'ghost-task')],
      [run('r-fine', 't-owned')],
    ])
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(report.violations).toEqual([])
    expect(report.deferredConstraintsApplied).toBe(true)
    expect(report.dispositions).toEqual<unknown>([
      kept(
        'fx_members',
        targetKey('fx_members', 't-owned', 'alice'),
        'fx_members_added_by_fk',
        'fx_users',
        'substituted',
      ),
      kept(
        'fx_missions',
        targetKey('fx_missions', 'm-reopened'),
        'fx_missions_reopened_fk',
        'fx_missions',
        'detached',
      ),
      moved('fx_runs', targetKey('fx_runs', 'r-orphan'), 'fx_runs_task_fk', 'fx_tasks'),
      kept(
        'fx_tasks',
        targetKey('fx_tasks', 't-orphaned-owner'),
        'fx_tasks_owner_fk',
        'fx_users',
        'detached',
      ),
    ])
    expectOrdered(report)

    expect(await targetRow(h, 'fx_tasks', 't-orphaned-owner')).toMatchObject({ owner_id: null })
    expect(await targetRow(h, 'fx_tasks', 't-owned')).toMatchObject({ owner_id: 'alice' })
    expect(await targetRow(h, 'fx_missions', 'm-reopened')).toMatchObject({ reopened_from: null })
    expect(await targetRows(h, 'fx_members')).toMatchObject([
      { task_id: 't-owned', user_id: 'alice', added_by: SYSTEM_USER },
    ])
    expect(await targetIds(h, 'fx_runs')).toEqual(['r-fine'])
    expect(await targetIds(h, 'fx_users')).toEqual([SYSTEM_USER, 'alice'].sort())

    // Each record carries what was there before: the value of a cleared or re-pointed
    // column, the whole row of one that was moved away.
    const records = await referenceRecords(f)
    expect(records).toHaveLength(4)
    const recordOf = (table: string, foreignKey: string) =>
      records.find(
        (record) =>
          record.payload.targetTable === table && record.payload.foreignKey === foreignKey,
      )!
    expect(recordOf('fx_tasks', 'fx_tasks_owner_fk').json).toContain('ghost-user')
    expect(recordOf('fx_missions', 'fx_missions_reopened_fk').json).toContain('ghost-mission')
    expect(recordOf('fx_members', 'fx_members_added_by_fk').json).toContain('ghost-user')
    const archived = await archivedRow(
      f,
      find(report, 'fx_runs', targetKey('fx_runs', 'r-orphan'), 'fx_runs_task_fk').archive,
    )
    expect(holdsRow(archived, fxRun('r-orphan', 'ghost-task'))).toBe(true)
  })

  test('two references of one row are cleared one after the other, and the row stays', async () => {
    const f = await convertedTarget(h, [
      ...seedRows,
      [task('t-two', { owner_id: 'ghost-a', reviewer_id: 'ghost-b', note: 'kept' })],
    ])
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    const key = targetKey('fx_tasks', 't-two')
    expect(report.dispositions).toEqual<unknown>([
      kept('fx_tasks', key, 'fx_tasks_owner_fk', 'fx_users', 'detached'),
      kept('fx_tasks', key, 'fx_tasks_reviewer_fk', 'fx_users', 'detached'),
    ])
    expect(report.violations).toEqual([])
    expect(await targetRow(h, 'fx_tasks', 't-two')).toMatchObject({
      owner_id: null,
      reviewer_id: null,
      note: 'kept',
    })
    const recorded = (await referenceRecords(f)).map((record) => record.json).join('\n')
    expect(recorded).toContain('ghost-a')
    expect(recorded).toContain('ghost-b')
  })

  test('a row whose reference was cleared is moved away in a later round, level after level', async () => {
    const f = await convertedTarget(h, cascade)
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    await expectCascadeResolved(h, f, report)
    // The archive of t2 is the row as it was when it was moved: its owner already cleared.
    const archived = await archivedRow(
      f,
      find(report, 'fx_tasks', targetKey('fx_tasks', 't2'), 'fx_tasks_parent_fk').archive,
    )
    expect(holdsRow(archived, { id: 't2', parent_id: 't1', owner_id: null })).toBe(true)
    expect(holdsRow(archived, { id: 't2', owner_id: 'ghost-user' })).toBe(false)
  })

  test('one of the rows a source row became is moved away while the row itself stays', async () => {
    const f = await convertedTarget(h, [
      ...seedRows,
      [task('t-ok')],
      // The run and its input come from one source row; the input has a key of its own.
      [run('r-body', 't-ok'), runInput('r-body', 'in', 'r-upstream')],
      [run('r-upstream', 'ghost-task')],
    ])
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(report.violations).toEqual([])
    expect(report.dispositions).toEqual<unknown>([
      moved(
        'fx_run_inputs',
        targetKey('fx_run_inputs', 'r-body', 'in'),
        'fx_run_inputs_upstream_fk',
        'fx_runs',
      ),
      moved('fx_runs', targetKey('fx_runs', 'r-upstream'), 'fx_runs_task_fk', 'fx_tasks'),
    ])
    expect(await targetIds(h, 'fx_runs')).toEqual(['r-body'])
    expect(await targetRows(h, 'fx_run_inputs')).toEqual([])
  })

  test('a finalize that is repeated reports the same dispositions and the same digest', async () => {
    const f = await convertedTarget(h, cascade)
    const handle = fixtureHandle(h)
    const first = await handle.finalize({ runId: f.runId, dangling })
    await expectCascadeResolved(h, f, first)
    const second = await handle.finalize({ runId: f.runId, dangling })
    expect(second).toEqual(first)
    expect(second.digest).toBe(first.digest)
    await expectCascadeResolved(h, f, second)
  })

  // The n-th write of the resolution fails, which rolls back the round it belongs to; rounds
  // before it are committed with their records.
  for (const crashAt of [2, 5, 8, 12])
    test(`interrupted at write ${crashAt} and finalized again: the result is that of one uninterrupted finalize`, async () => {
      const f = await convertedTarget(h, cascade)
      let writes = 0
      const crashing = (connection: HistoryConnection): HistoryConnection => ({
        provider: connection.provider,
        async execute(sql, values) {
          if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql) && ++writes === crashAt)
            throw new Error('rfc626-crash')
          return connection.execute(sql, values)
        },
      })
      const interrupted: ConversionTargetConnection = {
        provider: h.target.provider,
        execute: (sql, values) => h.target.execute(sql, values),
        transaction: (body) => h.target.transaction((tx) => body(crashing(tx))),
        close: async () => {},
      }
      const outcome = await fixtureHandle(h, interrupted)
        .finalize({ runId: f.runId, dangling })
        .then(
          (report) => ({ report, error: null }),
          (error: unknown) => ({ report: null, error }),
        )
      // However the interruption surfaces, the target is not declared finalized.
      if (outcome.report) expect(outcome.report.deferredConstraintsApplied).toBe(false)
      else expect(String(outcome.error)).toContain('rfc626-crash')
      expect((await referenceRecords(f)).length).toBeLessThan(cascadeDispositions.length)

      const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
      await expectCascadeResolved(h, f, report)
    })

  test('a seed row of the target schema is never moved away', async () => {
    // The seed mission points at a mission that is not there, and nothing says it may be kept.
    const f = await convertedTarget(h, [
      [user(SYSTEM_USER)],
      [mission(SEED_MISSION, 'ghost-mission')],
    ])
    const seedKey = targetKey('fx_missions', SEED_MISSION)
    await expect(
      resolveDanglingReferences(h.target, {
        registry: fixtureTarget,
        policies: [],
        requiredSeedKeys: requiredSeedKeys(fixtureTarget),
        journal: {
          recorded: async () => false,
          record: async () => {
            throw new Error('nothing may be recorded for a seed row')
          },
        },
      }),
    ).rejects.toThrow('v2-required-seed-set-aside')
    const outcome = await fixtureHandle(h)
      .finalize({ runId: f.runId, dangling: { policies: [] } })
      .then(
        (report) => JSON.stringify(report.violations),
        (error: unknown) => String(error),
      )
    // The upgrade ends on it, and says which row.
    expect(outcome).toContain('v2-required-seed-set-aside')
    expect(outcome).toContain('fx_missions')
    expect(outcome).toContain(SEED_MISSION)
    expect(await targetIds(h, 'fx_missions')).toEqual([SEED_MISSION])
    expect(await referenceRecords(f)).toEqual([])

    // With a way to keep the reference the seed row simply loses it.
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(report.violations).toEqual([])
    expect(report.dispositions).toEqual<unknown>([
      kept('fx_missions', seedKey, 'fx_missions_reopened_fk', 'fx_missions', 'detached'),
    ])
    expect(await targetRow(h, 'fx_missions', SEED_MISSION)).toMatchObject({ reopened_from: null })
  })

  test('nothing dangling: an empty list of dispositions, and the constraints go on', async () => {
    const f = await convertedTarget(h, [...seedRows, [task('t1')], [run('r1', 't1')]])
    const report = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(report.dispositions).toEqual([])
    expect(report.violations).toEqual([])
    expect(report.deferredConstraintsApplied).toBe(true)
    expect(await referenceRecords(f)).toEqual([])
  })

  test('without the option dangling rows are violations, nothing is changed and no list is reported', async () => {
    const f = await convertedTarget(h, [
      ...seedRows,
      [task('t-orphaned-owner', { owner_id: 'ghost-user' })],
      [run('r-orphan', 'ghost-task')],
    ])
    const report = await fixtureHandle(h).finalize({ runId: f.runId })
    expect(report).not.toHaveProperty('dispositions')
    expect(report.deferredConstraintsApplied).toBe(false)
    expect(
      report.violations
        .map((violation) => `${violation.kind} ${violation.table} ${violation.constraint}`)
        .sort(),
    ).toEqual(['foreign-key fx_runs fx_runs_task_fk', 'foreign-key fx_tasks fx_tasks_owner_fk'])
    expect(await targetRow(h, 'fx_tasks', 't-orphaned-owner')).toMatchObject({
      owner_id: 'ghost-user',
    })
    expect(await targetIds(h, 'fx_runs')).toEqual(['r-orphan'])
    expect(await referenceRecords(f)).toEqual([])
  })
})
