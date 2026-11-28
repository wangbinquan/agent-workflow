// RFC-626 §3.3 "收尾处置 · 对账" and "自动处置之后校验必须通过"
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md), on a real target database.
// Receipt conservation used to compare source counts only; it could not see whether a target
// row was still there. Finalizing an automatic upgrade moves rows out of the target after
// their units committed, so validation now also reconciles every business table: what it
// holds has to equal what the committed units wrote to it minus the rows finalize moved to
// the archive (each row once; clearing or re-pointing a reference removes nothing). A row too
// few or too many fails the check and names the table. The same section makes validation use
// the finalize report its caller already has instead of finalizing — and scanning every
// foreign key — a second time.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV3Providers, type V3Harness } from './helpers/rfc395V3Harness'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import {
  parameters,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionTargetConnection,
  TargetFinalizeReport,
  ValidationCheck,
  ValidationReport,
  VerifiableContentInventory,
} from '@/platform/persistence/migration/run/types'
import { createTargetLoader, targetTableName } from '@/platform/persistence/migration/target/loader'
import {
  emissionRule,
  fixtureTarget,
  fxThing,
  targetKey,
  type Emission,
} from './rfc626-engine-fixtures.test'
import {
  convertedTarget,
  fixtureHandle,
  keepPolicies,
  member,
  run,
  runInput,
  seedRows,
  targetIds,
  targetRows,
  task,
  user,
  type ConvertedTarget,
} from './rfc626-target-fixtures.test'

// Installing the fixture schema, converting into it, finalizing and validating takes a few
// seconds per case on a CI-scaled PostgreSQL; 60 s leaves the margin the other target tests use.
setDefaultTimeout(60_000)

const dangling = { policies: keepPolicies }
/** No content in these runs: nothing can have drifted. */
const inventory: VerifiableContentInventory = {
  ...emptyV2Content,
  verifyUnchanged: async () => [],
}
/**
 * One row whose reference is cleared and stays, one that is re-pointed and stays, one that is
 * cleared first and moved away a round later, and a run with an input that follow it out.
 */
const resolved: readonly (readonly Emission[])[] = [
  ...seedRows,
  [user('alice')],
  [task('t-kept', { owner_id: 'ghost-user' })],
  [member('t-kept', 'alice', 'ghost-user')],
  [task('t1', { parent_id: 'ghost-parent' })],
  [task('t2', { parent_id: 't1', owner_id: 'ghost-user' })],
  [run('r2', 't2'), runInput('r2', 'in', null)],
  [task('t-stays'), run('r-stays', 't-stays')],
]
function validate(
  h: V3Harness,
  f: ConvertedTarget,
  finalized?: TargetFinalizeReport,
  target?: ConversionTargetConnection,
): Promise<ValidationReport> {
  return fixtureHandle(h, target).validate({
    runId: f.runId,
    preflight: f.preflight,
    preUpgrade: null,
    inventory,
    probes: [],
    ...(finalized ? { finalized } : {}),
  })
}
function checkOf(report: ValidationReport, check: ValidationCheck) {
  const found = report.checks.filter((entry) => entry.check === check)
  expect(found).toHaveLength(1)
  return found[0]!
}
/**
 * The checks that did not pass. Catalog admission is left out: the synthetic schema has no
 * compiled PostgreSQL catalog to be admitted against, and admission is not what is tested.
 */
function failing(report: ValidationReport): ValidationCheck[] {
  return report.checks
    .filter((entry) => !entry.passed && entry.check !== 'catalog')
    .map((entry) => entry.check)
}
function mismatches(report: ValidationReport): string[] {
  const detail = checkOf(report, 'receipt-conservation').detail as {
    readonly mismatches: readonly string[]
  }
  return [...detail.mismatches]
}
async function deleteRow(h: V3Harness, table: string, id: string): Promise<void> {
  await h.target.execute(
    `DELETE FROM ${targetTableName(h.targetProvider, table)} WHERE id = ${parameters(h.target, 1)}`,
    [id],
  )
}
async function insertThing(h: V3Harness, id: string): Promise<void> {
  const loader = createTargetLoader({ registry: fixtureTarget, provider: h.targetProvider })
  await h.target.transaction((tx) =>
    loader.insert(tx, [{ table: 'fx_things', rows: [fxThing(id)] }]),
  )
}

describeV3Providers('RFC-626 validation reconciles the target with the committed units', (h) => {
  test('what each table holds is what the units wrote minus the rows finalize moved to the archive', async () => {
    const f = await convertedTarget(h, resolved)
    const finalized = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(finalized.violations).toEqual([])
    // t2 has two records — its owner cleared, then the row moved away — and is one row.
    expect(
      finalized
        .dispositions!.filter((entry) => entry.targetKey === targetKey('fx_tasks', 't2'))
        .map((entry) => entry.action)
        .sort(),
    ).toEqual(['detached', 'set-aside'])
    expect(await targetIds(h, 'fx_tasks')).toEqual(['t-kept', 't-stays'])
    expect(await targetIds(h, 'fx_runs')).toEqual(['r-stays'])
    expect(await targetRows(h, 'fx_run_inputs')).toEqual([])
    expect(await targetRows(h, 'fx_members')).toHaveLength(1)

    const report = await validate(h, f, finalized)
    expect(checkOf(report, 'receipt-conservation')).toEqual({
      check: 'receipt-conservation',
      passed: true,
      detail: { mismatches: [] },
    })
    expect(failing(report)).toEqual([])
  })

  test('a row too few or too many fails receipt conservation and names the table', async () => {
    const f = await convertedTarget(h, resolved)
    const finalized = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(mismatches(await validate(h, f, finalized))).toEqual([])

    // A row the units wrote and finalize did not move away is gone.
    await deleteRow(h, 'fx_runs', 'r-stays')
    const missing = await validate(h, f, finalized)
    expect(checkOf(missing, 'receipt-conservation').passed).toBe(false)
    expect(mismatches(missing)).toHaveLength(1)
    expect(mismatches(missing)[0]).toContain('fx_runs')
    expect(missing.passed).toBe(false)
    expect(missing.blocks.map((block) => block.code)).toContain(
      'v3-validation-receipt-conservation',
    )

    // A row no unit wrote is there.
    await insertThing(h, 'nobody-converted-this')
    const extra = await validate(h, f, finalized)
    expect(mismatches(extra)).toHaveLength(2)
    expect(mismatches(extra).some((entry) => entry.includes('fx_things'))).toBe(true)
    expect(mismatches(extra).some((entry) => entry.includes('fx_runs'))).toBe(true)
    // No other table is accused.
    for (const table of ['fx_tasks', 'fx_users', 'fx_members', 'fx_missions', 'fx_run_inputs'])
      expect(mismatches(extra).some((entry) => entry.includes(table))).toBe(false)
  })

  test('a row the conversion set aside was never written: the counts reconcile and validation passes', async () => {
    // Sets the source row aside after its target rows were produced.
    const withDefects: ConversionRule = {
      ...emissionRule,
      ref: { id: 'fixture/emissions-with-defects', version: 1 },
      convert(unit, ctx) {
        for (const row of unit.rows.get('maintenance_state')!) {
          const emissions = JSON.parse(String(row.values.value)) as readonly Emission[]
          for (const emission of emissions) ctx.out.row(emission.table, emission.values, row)
          if (emissions.some((emission) => emission.values.label === 'inconsistent'))
            ctx.out.block(rowBlock('fixture-inconsistent', row, null))
        }
      },
    }
    const f = await convertedTarget(
      h,
      [
        ...seedRows,
        [task('t1')],
        [
          { table: 'fx_things', values: fxThing('defect', { label: 'inconsistent' }) },
          user('from-the-same-row'),
        ],
        [{ table: 'fx_things', values: fxThing('sound') }],
        [run('r1', 't1')],
      ],
      { resolution: 'automatic', rule: withDefects },
    )
    expect(f.summary.status).toBe('converted')
    expect(f.summary.resolutions!.setAside.total).toBe(1)
    expect(await targetIds(h, 'fx_things')).toEqual(['sound'])

    const finalized = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    expect(finalized.dispositions).toEqual([])
    const report = await validate(h, f, finalized)
    expect(mismatches(report)).toEqual([])
    expect(failing(report)).toEqual([])
  })

  test('a manual run keeps the check it had: no list of dispositions, no mismatches', async () => {
    const f = await convertedTarget(h, [...seedRows, [task('t1')], [run('r1', 't1')]])
    const finalized = await fixtureHandle(h).finalize({ runId: f.runId })
    expect(finalized).not.toHaveProperty('dispositions')
    const report = await validate(h, f, finalized)
    expect(checkOf(report, 'receipt-conservation')).toEqual({
      check: 'receipt-conservation',
      passed: true,
      detail: { mismatches: [] },
    })
    expect(failing(report)).toEqual([])
  })

  test('validation that is handed the finalize report does not scan the foreign keys again', async () => {
    const f = await convertedTarget(h, resolved)
    const finalized = await fixtureHandle(h).finalize({ runId: f.runId, dangling })
    const statements: string[] = []
    const recording = (connection: HistoryConnection): HistoryConnection => ({
      provider: connection.provider,
      execute(sql, values) {
        statements.push(sql)
        return connection.execute(sql, values)
      },
    })
    const observed: ConversionTargetConnection = {
      ...recording(h.target),
      transaction: (body) => h.target.transaction((tx) => body(recording(tx))),
      close: async () => {},
    }
    // Finalizing looks for a row without its referenced row once per declared foreign key.
    const scans = (): number =>
      statements.filter((sql) => /NOT EXISTS\s*\(\s*SELECT 1 FROM/i.test(sql)).length

    const report = await validate(h, f, finalized, observed)
    expect(mismatches(report)).toEqual([])
    expect(statements.length).toBeGreaterThan(0)
    expect(scans()).toBe(0)

    // Without the report validation finalizes first, as it always did.
    statements.length = 0
    await validate(h, f, undefined, observed)
    expect(scans()).toBeGreaterThan(0)
  })
})
