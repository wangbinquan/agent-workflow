// RFC-626 §3.1 and §3.3 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md): with
// automatic resolution a row-level block no longer stops the upgrade. The row is set aside:
// classed `archived`, its original content (`canonical` and `raw`) written to an archive, a
// disposition recording the block's code and detail as the decision, a `v2-row-set-aside`
// record for the report, and whatever target rows it had already produced dropped. A target
// row the target contract refuses is the same case when it has a source row. What stays an
// error: blocks that are not about one row, a target row without a source row, an engine
// fault a rule swallowed, and a seed row of the target schema — no release works without it.
//
// The first half drives the unit collector directly; the second half goes through the engine,
// which is where rows are blocked before a rule runs (undecodable rows, whole groups) and
// where the conversion summary is put together. Operator resolution is checked beside each
// case: it must stay the block it was.
import { describe, expect, test } from 'bun:test'
import { column as c, retention } from '@/platform/persistence/schema/dsl'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import {
  prepareConversion,
  runConversion,
} from '@/platform/persistence/migration/conversion/engine'
import {
  ConversionContractError,
  rowBlock,
} from '@/platform/persistence/migration/conversion/blockCodes'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { readSourceTable } from '@/platform/persistence/migration/conversion/readSource'
import {
  createUnitCollector,
  type UnitCollector,
} from '@/platform/persistence/migration/conversion/receipts'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { targetTopology } from '@/platform/persistence/migration/conversion/topology'
import { operatorDecisionRowDigest } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { ConversionRule, RowValidator } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionBlock,
  MigrationRecord,
  OperatorDecision,
  RowDisposition,
  SourceRow,
  TargetRow,
  TargetValue,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import { r2Owner, r2Registry } from './helpers/rfc395R2Schema'
import {
  PLAN_TIME,
  RecordingSink,
  engineInput,
  fixtureTarget,
  frozenRow,
  fxThing,
  memorySource,
  noteRule,
  scratchRoots,
  sourceKey,
} from './rfc626-engine-fixtures.test'

const scratch = scratchRoots()

const SET_ASIDE = 'v2-row-set-aside'
const SETTLED = 'v2-task-settled-at-upgrade'

/** A source row of a table that exists only in these unit cases. */
function fixtureRow(
  id: string,
  cells: Readonly<Record<string, TargetValue>> = {},
  extra: Partial<SourceRow> = {},
): SourceRow {
  const key = [canonicalValue(id)]
  const values: Record<string, TargetValue> = { id, ...cells }
  return {
    table: 'fixture',
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey('fixture', key),
    canonical: {
      key,
      values: Object.keys(values)
        .sort()
        .map((name) => canonicalValue(values[name]!)),
    },
    values,
    ...extra,
  }
}
const unitRule: ConversionRule = {
  ref: { id: 'fixture/things', version: 1 },
  owner: 'fixture',
  claims: ['fixture'],
  produces: [{ table: 'fx_things' }, { table: 'fx_users' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'fixture' },
  convert() {},
}
function collect(
  rows: readonly SourceRow[],
  options: Partial<Parameters<typeof createUnitCollector>[0]> = {},
): UnitCollector {
  return createUnitCollector({
    rule: unitRule,
    sourceRows: rows,
    sourceVersion: 'fixture/v1',
    sourceContract: 'fixture-contract',
    target: targetRegistryView(fixtureTarget),
    topology: targetTopology(fixtureTarget).order,
    resolution: 'automatic',
    ...options,
  })
}
function finish(collector: UnitCollector): UnitOutput {
  return collector.finish({
    unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 10 },
    unitId: 'unit-under-test',
    lookups: [],
  })
}
function decisions(output: UnitOutput, code: string) {
  return output.records.filter((record) => record.kind === 'decision' && record.code === code)
}
function archiveText(output: UnitOutput, ref: string | null): string {
  const archive = output.archives.find((entry) => entry.ref === ref)
  if (!archive) throw new Error(`no archive ${ref}`)
  return Buffer.from(archive.bytes).toString('utf8')
}

// Found by the release-upgrade matrix (v0.14.0 … v0.19.2): a skill operation the upgrade had to
// stop (`active` 1 -> 0) was counted as preserved in the table receipt while its row disposition
// said converted. `skill_operations` keeps its "preserved" class through `preservedClaims`; the
// boot rules write the row, then the exception that says it was changed, then a record about
// it — and that record put the table's default class back.
describe('RFC-626 preservedClaims: a row the rule changed counts as converted', () => {
  const preservingRule: ConversionRule = { ...unitRule, preservedClaims: ['fixture'] }
  const classes = (output: UnitOutput) => output.receipt.sources[0]!.counts

  test('an untouched row of the table stays preserved', () => {
    const row = fixtureRow('kept')
    const collector = collect([row], { rule: preservingRule })
    collector.out.row('fx_things', fxThing('kept'), row)
    collector.out.record({ kind: 'decision', code: 'fixture-effect', payload: {} }, row)
    expect(classes(finish(collector))).toMatchObject({ preserved: 1, converted: 0 })
  })

  test('a row with a converted exception stays converted after a later row or record', () => {
    const row = fixtureRow('changed')
    const collector = collect([row], { rule: preservingRule })
    collector.out.row('fx_things', fxThing('changed'), row)
    collector.out.exception({
      sourceTable: 'fixture',
      sourceKey: row.encodedKey,
      sourcePhase: 'current',
      class: 'converted',
      kind: 'conflict-resolved',
      targets: [
        {
          table: 'fx_things',
          key: targetRegistryView(fixtureTarget).key('fx_things', fxThing('changed')),
        },
      ],
      archive: null,
      decision: { code: 'fixture-stopped', detail: null },
    })
    // What the boot rules do next: a record about the same row, and possibly another target row.
    collector.out.record({ kind: 'decision', code: 'fixture-effect', payload: {} }, row)
    collector.out.row('fx_users', { id: 'changed-user', name: 'from the same row' }, row)
    const output = finish(collector)
    expect(classes(output)).toMatchObject({ preserved: 0, converted: 1 })
    expect(output.dispositions.map((entry) => entry.class)).toEqual(['converted'])
  })

  test('a rule without preservedClaims keeps taking its own class from row and record', () => {
    const row = fixtureRow('plain')
    const collector = collect([row], { rule: { ...unitRule, disposition: 'preserved' } })
    collector.out.row('fx_things', fxThing('plain'), row)
    collector.out.exception({
      sourceTable: 'fixture',
      sourceKey: row.encodedKey,
      sourcePhase: 'current',
      class: 'converted',
      kind: 'conflict-resolved',
      targets: [
        {
          table: 'fx_things',
          key: targetRegistryView(fixtureTarget).key('fx_things', fxThing('plain')),
        },
      ],
      archive: null,
      decision: { code: 'fixture-stopped', detail: null },
    })
    collector.out.record({ kind: 'decision', code: 'fixture-effect', payload: {} }, row)
    // Unchanged behaviour of rules that existed before RFC-626.
    expect(classes(finish(collector))).toMatchObject({ preserved: 1, converted: 0 })
  })
})

describe('RFC-626 a row-level block sets the row aside', () => {
  test('the row is archived as it was read, with the block as the decision, and its target rows are dropped', () => {
    const kept = fixtureRow('kept')
    const broken = fixtureRow('broken', { note: 'dangling', amount: 9007199254740993n })
    const collector = collect([kept, broken])
    collector.out.row('fx_things', fxThing('kept'), kept)
    // Already produced when the rule finds out the row cannot be carried over.
    collector.out.row('fx_things', fxThing('broken'), broken)
    collector.out.row('fx_users', { id: 'broken-user', name: 'from the same row' }, broken)
    collector.out.block(rowBlock('fixture-inconsistent', broken, { why: 'dangling' }, ['note']))
    expect(collector.blocked(broken)).toBe(true)
    expect(collector.blocked(kept)).toBe(false)
    const output = finish(collector)

    expect(output.blocks).toEqual([])
    expect(output.rows).toEqual([{ table: 'fx_things', rows: [fxThing('kept')] }])
    expect(output.dispositions).toEqual([
      {
        sourceTable: 'fixture',
        sourceKey: broken.encodedKey,
        sourcePhase: 'current',
        class: 'archived',
        kind: 'archived',
        targets: [],
        archive: expect.stringMatching(/^archive:sha256:[a-f0-9]{64}$/),
        rule: { id: 'fixture/things', version: 1 },
        decision: { code: 'fixture-inconsistent', detail: { why: 'dangling' } },
      },
    ])
    const text = canonicalSchemaJson({ canonical: broken.canonical, raw: null })
    expect(output.archives).toHaveLength(1)
    expect(output.archives[0]).toMatchObject({
      kind: 'source-journal',
      format: 'logical-row@1',
      sourceTable: 'fixture',
      rows: 1,
      ref: `archive:${bytesDigest(text)}`,
    })
    expect(archiveText(output, output.dispositions[0]!.archive)).toBe(text)
    expect(decisions(output, SET_ASIDE)).toEqual([
      {
        kind: 'decision',
        code: SET_ASIDE,
        payload: expect.objectContaining({
          sourcePhase: 'current',
          sourceTable: 'fixture',
          sourceKey: broken.encodedKey,
          code: 'fixture-inconsistent',
        }),
      },
    ])
    expect(output.receipt.sources).toEqual([
      expect.objectContaining({
        table: 'fixture',
        rows: 2,
        counts: { converted: 1, preserved: 0, archived: 1, blocked: 0 },
        exceptions: 1,
      }),
    ])
    expect(output.receipt.targets.map((target) => [target.table, target.rows])).toEqual([
      ['fx_things', 1],
    ])
    expect(collector.links(broken)).toEqual([])
  })

  test('raw cells are part of the archive when the row carries them', () => {
    const raw = {
      key: [{ type: 'integer' as const, value: '7' }],
      cells: { id: { storageClass: 'text', value: canonicalValue('with-raw') } },
    }
    const row = fixtureRow('with-raw', {}, { raw })
    const collector = collect([row])
    collector.out.block(rowBlock('fixture-inconsistent', row, null))
    const output = finish(collector)
    expect(archiveText(output, output.dispositions[0]!.archive)).toBe(
      canonicalSchemaJson({ canonical: row.canonical, raw }),
    )
  })

  test('operator resolution keeps the block exactly as it was', () => {
    const row = fixtureRow('broken')
    const block = rowBlock('fixture-inconsistent', row, { why: 'dangling' })
    for (const resolution of [undefined, 'operator'] as const) {
      const collector = collect([row], { resolution })
      collector.out.row('fx_things', fxThing('broken'), row)
      collector.out.block(block)
      const output = finish(collector)
      expect(output.blocks).toEqual([block])
      expect(output.archives).toEqual([])
      expect(output.records).toEqual([])
      expect(output.rows).toEqual([])
      expect(output.dispositions).toEqual([
        expect.objectContaining({
          class: 'blocked',
          kind: 'blocked',
          archive: null,
          decision: { code: 'fixture-inconsistent', detail: { why: 'dangling' } },
        }),
      ])
      expect(output.receipt.sources[0]!.counts.blocked).toBe(1)
    }
  })

  test('a row is set aside once however many blocks name it', () => {
    const row = fixtureRow('twice')
    const collector = collect([row])
    collector.out.block(rowBlock('fixture-first', row, null))
    collector.out.block(rowBlock('fixture-second', row, null))
    const output = finish(collector)
    expect(output.dispositions).toHaveLength(1)
    expect(output.archives).toHaveLength(1)
    expect(decisions(output, SET_ASIDE)).toHaveLength(1)
    expect(['fixture-first', 'fixture-second']).toContain(output.dispositions[0]!.decision!.code)
    expect(output.receipt.sources[0]!.counts.archived).toBe(1)
  })

  test('blocks that are not about one row stay blocks', () => {
    const row = fixtureRow('row')
    const tableBlock: ConversionBlock = {
      code: 'fixture-table-missing-seed',
      scope: 'table',
      sourceTable: 'fixture',
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: null,
    }
    const globalBlock: ConversionBlock = {
      ...tableBlock,
      code: 'fixture-global',
      scope: 'global',
      sourceTable: null,
    }
    const collector = collect([row])
    collector.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
    collector.out.block(globalBlock)
    collector.out.block(tableBlock)
    const output = finish(collector)
    expect([...output.blocks].sort((a, b) => a.code.localeCompare(b.code))).toEqual([
      globalBlock,
      tableBlock,
    ])
    expect(output.archives).toEqual([])
    expect(decisions(output, SET_ASIDE)).toEqual([])
    expect(output.dispositions.map((entry) => entry.class)).toEqual(['blocked'])
  })

  test('a row the rule never accounted for is a rule fault, not something to set aside', () => {
    const row = fixtureRow('forgotten')
    const output = finish(collect([row]))
    expect(output.blocks.map((block) => block.code)).toEqual(['v2-unclassified-row'])
    expect(output.archives).toEqual([])
    expect(decisions(output, SET_ASIDE)).toEqual([])
  })
})

// Implementation gate G1-1 / G1-2 (RFC-626): a row the unit sets aside after the rule had already
// accounted for it kept that account. A "kept with a marker" decision and an active claim of the
// row stayed in the unit, so the report listed the row as kept and as set aside, and the table
// receipt claimed an archived row; the receipt also counted the dispositions the unit dropped.
describe('RFC-626 a row set aside keeps no other account of itself', () => {
  const kept = (row: SourceRow): MigrationRecord => ({
    kind: 'decision',
    code: 'fixture-kept-with-marker',
    payload: { automatic: 'kept', sourceTable: row.table, sourceKey: row.encodedKey },
  })
  const claim = (row: SourceRow): MigrationRecord => ({
    kind: 'source-metadata',
    table: row.table,
    payload: {
      kind: 'active-claim',
      sourceKey: row.encodedKey,
      sourcePhase: row.phase,
      values: { id: canonicalValue(String(row.values.id)) },
    },
  })
  /** A marker the rule wrote for the row without naming the row in its payload. */
  const unnamed: MigrationRecord = {
    kind: 'decision',
    code: 'fixture-kept-unnamed',
    payload: { automatic: 'kept' },
  }
  const plain: MigrationRecord = { kind: 'decision', code: 'fixture-noted', payload: null }
  const codes = (records: readonly MigrationRecord[]) =>
    records
      .map((record) => {
        if (record.kind !== 'decision' && record.kind !== 'source-metadata') return record.kind
        const key = (record.payload as { readonly sourceKey?: string } | null)?.sourceKey ?? '-'
        return `${record.kind === 'decision' ? record.code : record.kind} ${key}`
      })
      .sort()
  const account = (collector: UnitCollector, aside: SourceRow, other: SourceRow) => {
    collector.out.record(kept(aside), aside)
    collector.out.record(kept(other), other)
    collector.out.record(claim(aside))
    collector.out.record(claim(other))
    collector.out.record(unnamed, aside)
    collector.out.record(plain, aside)
    collector.out.row('fx_things', fxThing('other'), other)
    // Refused by the target contract (amount must not be negative): the row is set aside.
    collector.out.row('fx_things', fxThing('aside', { amount: -1 }), aside)
  }

  test('its kept decision and its active claim leave the unit; those of other rows and plain records stay', () => {
    const aside = fixtureRow('aside')
    const other = fixtureRow('other')
    const collector = collect([aside, other])
    account(collector, aside, other)
    const output = finish(collector)
    expect(codes(output.records)).toEqual(
      [
        `fixture-kept-with-marker ${other.encodedKey}`,
        `source-metadata ${other.encodedKey}`,
        'fixture-noted -',
        `${SET_ASIDE} ${aside.encodedKey}`,
      ].sort(),
    )
    expect(output.dispositions.map((entry) => [entry.sourceKey, entry.class])).toEqual([
      [aside.encodedKey, 'archived'],
    ])
  })

  test('operator resolution keeps every record of a blocked row, as before', () => {
    const aside = fixtureRow('aside')
    const other = fixtureRow('other')
    const collector = collect([aside, other], { resolution: 'operator' })
    account(collector, aside, other)
    const output = finish(collector)
    expect(output.blocks.map((block) => block.code)).toEqual(['v2-target-check'])
    expect(codes(output.records)).toEqual(
      [
        `fixture-kept-with-marker ${aside.encodedKey}`,
        `fixture-kept-with-marker ${other.encodedKey}`,
        `source-metadata ${aside.encodedKey}`,
        `source-metadata ${other.encodedKey}`,
        'fixture-kept-unnamed -',
        'fixture-noted -',
      ].sort(),
    )
  })

  test('the receipt counts only the dispositions the unit hands over', () => {
    const history = (row: SourceRow): Omit<RowDisposition, 'rule'> => ({
      sourceTable: 'fixture',
      sourceKey: row.encodedKey,
      sourcePhase: 'current',
      class: 'converted',
      kind: 'history-only',
      targets: [],
      archive: null,
      history: { taskId: 'task', runId: null, missingFields: [], execution: 'terminal-history' },
      decision: { code: 'fixture-history', detail: null },
    })
    const aside = fixtureRow('aside')
    const other = fixtureRow('other')
    const collector = collect([aside, other])
    collector.out.row('fx_things', fxThing('aside'), aside)
    collector.out.exception(history(aside))
    collector.out.row('fx_things', fxThing('other'), other)
    collector.out.exception(history(other))
    collector.out.block(rowBlock('fixture-inconsistent', aside, null))
    const output = finish(collector)
    expect(
      output.dispositions.map((entry): string[] => [entry.sourceKey, entry.kind]).sort(),
    ).toEqual(
      [
        [aside.encodedKey, 'archived'],
        [other.encodedKey, 'history-only'],
      ].sort(),
    )
    // Two dispositions handed over, one of them history-only — not the three written.
    expect(output.receipt.sources[0]).toMatchObject({ exceptions: 2, historyOnly: 1 })
    expect(output.receipt.counts).toMatchObject({ exceptions: 2, historyOnly: 1 })
  })
})

describe('RFC-626 a target row the target contract refuses', () => {
  const refusals: readonly (readonly [string, TargetRow])[] = [
    ['v2-target-column', { ...fxThing('refused'), not_a_column: 'x' }],
    ['v2-target-null', fxThing('refused', { amount: null })],
    ['v2-target-codec', fxThing('refused', { kind: 'outside-the-enum' })],
    ['v2-target-check', fxThing('refused', { amount: -1 })],
  ]
  for (const [code, values] of refusals)
    test(`${code} with a source row sets that source row aside`, () => {
      const row = fixtureRow('source')
      const other = fixtureRow('other')
      const collector = collect([row, other])
      collector.out.row('fx_users', { id: 'earlier', name: 'produced before the refusal' }, row)
      collector.out.row('fx_things', values, row)
      collector.out.row('fx_things', fxThing('other'), other)
      const output = finish(collector)
      expect(output.blocks).toEqual([])
      expect(output.rows).toEqual([{ table: 'fx_things', rows: [fxThing('other')] }])
      expect(output.dispositions).toEqual([
        expect.objectContaining({
          sourceKey: row.encodedKey,
          class: 'archived',
          kind: 'archived',
          targets: [],
          decision: expect.objectContaining({ code }),
        }),
      ])
      expect(archiveText(output, output.dispositions[0]!.archive)).toBe(
        canonicalSchemaJson({ canonical: row.canonical, raw: null }),
      )
      expect(decisions(output, SET_ASIDE)).toHaveLength(1)

      const manual = collect([row, other], { resolution: 'operator' })
      manual.out.row('fx_things', values, row)
      manual.out.row('fx_things', fxThing('other'), other)
      const blocked = finish(manual)
      expect(blocked.blocks.map((block) => block.code)).toEqual([code])
      expect(blocked.archives).toEqual([])
    })

  test('a second row with a key the unit already produced is set aside, the first one stays', () => {
    const first = fixtureRow('first')
    const second = fixtureRow('second')
    const collector = collect([first, second])
    collector.out.row('fx_things', fxThing('same-key', { label: 'first' }), first)
    collector.out.row('fx_things', fxThing('same-key', { label: 'second' }), second)
    const output = finish(collector)
    expect(output.blocks).toEqual([])
    expect(output.rows).toEqual([
      { table: 'fx_things', rows: [fxThing('same-key', { label: 'first' })] },
    ])
    expect(output.dispositions).toEqual([
      expect.objectContaining({
        sourceKey: second.encodedKey,
        class: 'archived',
        decision: expect.objectContaining({ code: 'v2-target-unique' }),
      }),
    ])
  })

  // Design §3.3 and §3.6: a refused target row that no source row answers for is an engine
  // fault. However it surfaces — a contract error, or a block that is not about a row — it
  // is never an archive, and the unit never passes for converted.
  test('without a source row there is nothing to set aside: the unit does not pass', () => {
    for (const [code, values] of refusals) {
      const collector = collect([])
      const outcome = ((): UnitOutput | Error => {
        try {
          collector.out.row('fx_things', values, null)
          return finish(collector)
        } catch (error) {
          return error as Error
        }
      })()
      if (outcome instanceof Error) {
        expect(outcome).toBeInstanceOf(ConversionContractError)
        continue
      }
      expect(outcome.blocks).toEqual([
        expect.objectContaining({ code, scope: 'global', sourceTable: null, sourceKey: null }),
      ])
      expect(outcome.rows).toEqual([])
      expect(outcome.archives).toEqual([])
      expect(outcome.dispositions).toEqual([])
      expect(decisions(outcome, SET_ASIDE)).toEqual([])
    }
  })
})

describe('RFC-626 what the collector never sets aside', () => {
  test('a seed row of the target schema ends the conversion with v2-required-seed-set-aside', () => {
    const seed = fixtureRow('seed')
    const plain = fixtureRow('plain')
    const collector = collect([seed, plain], {
      requiredSeed: (row) => row.encodedKey === seed.encodedKey,
    })
    collector.out.block(rowBlock('fixture-inconsistent', plain, null))
    let thrown: unknown
    try {
      collector.out.block(rowBlock('fixture-inconsistent', seed, null))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConversionContractError)
    expect((thrown as ConversionContractError).code).toBe('v2-required-seed-set-aside')
    // The error names the row.
    expect((thrown as Error).message).toContain('fixture')
    expect((thrown as Error).message).toContain(seed.encodedKey)
    // Operator resolution: an ordinary block, as before.
    const manual = collect([seed], {
      resolution: 'operator',
      requiredSeed: (row) => row.encodedKey === seed.encodedKey,
    })
    manual.out.block(rowBlock('fixture-inconsistent', seed, null))
    expect(finish(manual).blocks.map((block) => block.code)).toEqual(['fixture-inconsistent'])
  })

  test('an engine fault a rule swallowed still ends the unit', () => {
    const row = fixtureRow('row')
    const stranger = fixtureRow('not-in-this-unit')
    const swallow = (collector: UnitCollector): void => {
      try {
        // A rule bug: a target row attributed to a source row of another unit.
        collector.out.row('fx_things', fxThing('thing'), stranger)
      } catch (error) {
        collector.out.block(rowBlock('fixture-caught', row, { message: String(error) }))
      }
    }
    const automatic = collect([row])
    swallow(automatic)
    expect(() => finish(automatic)).toThrow('v2-foreign-disposition')
    // Operator resolution reports the block the rule made of it, as it always did.
    const manual = collect([row], { resolution: 'operator' })
    swallow(manual)
    expect(finish(manual).blocks.map((block) => block.code)).toEqual(['fixture-caught'])
  })
})

describe('RFC-626 a rewritten row says so in the unit that consumed it', () => {
  test('one v2-task-settled-at-upgrade record per rewritten row, naming the row, the task and the columns', () => {
    const columns = {
      status: { before: canonicalValue('running'), after: canonicalValue('canceled') },
      finished_at: { before: canonicalValue(null), after: canonicalValue(PLAN_TIME) },
    }
    const rewritten = fixtureRow(
      'rewritten',
      { status: 'canceled', finished_at: PLAN_TIME },
      { settlement: { taskId: 'task-1', cause: 'parent-cascade', columns } },
    )
    const untouched = fixtureRow('untouched', { status: 'done', finished_at: 1 })
    const collector = collect([rewritten, untouched])
    for (const row of [rewritten, untouched])
      collector.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
    const output = finish(collector)
    expect(decisions(output, SETTLED)).toEqual([
      {
        kind: 'decision',
        code: SETTLED,
        payload: expect.objectContaining({
          sourcePhase: 'current',
          sourceTable: 'fixture',
          sourceKey: rewritten.encodedKey,
          taskId: 'task-1',
          cause: 'parent-cascade',
          columns,
        }),
      },
    ])
    // The disposition of the row is still the rule's: the note takes no disposition slot.
    expect(output.dispositions).toEqual([])
    expect(output.receipt.sources[0]!.counts.converted).toBe(2)
  })
})

// ---- through the engine --------------------------------------------------------------------

function event(id: string, values: DecodedSourceRow = {}): DecodedSourceRow {
  return frozenRow('recovery_events', { id, kind: 'fine', ...values })
}
/** One thing per event; an event of kind `inconsistent` blocks after its thing was produced. */
function thingsRule(
  seen: SourceRow[] = [],
  overrides: Partial<ConversionRule> = {},
): ConversionRule {
  return {
    ref: { id: 'fixture/event-things', version: 1 },
    owner: 'fixture',
    claims: ['recovery_events'],
    produces: [{ table: 'fx_things' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'recovery_events' },
    convert(unit, ctx) {
      for (const row of unit.rows.get('recovery_events')!) {
        seen.push(row)
        ctx.out.row(
          'fx_things',
          fxThing(String(row.values.id), { label: row.values.reason ?? null }),
          row,
        )
        if (row.values.kind === 'inconsistent')
          ctx.out.block(rowBlock('fixture-inconsistent', row, { reason: 'dangling' }, ['kind']))
      }
    },
    ...overrides,
  }
}
const eventKey = (id: string) => sourceKey('recovery_events', id)

describe('RFC-626 set-aside through the engine', () => {
  const events = () => [
    event('a', { reason: 'one' }),
    event('b', { kind: 'inconsistent' }),
    event('c', { before_json: '{ not json' }),
    event('d'),
  ]

  test('undecodable and blocked rows are archived byte for byte and listed in the summary; the rest converts', async () => {
    const memory = memorySource({ recovery_events: events() })
    const seen: SourceRow[] = []
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(memory, [{ rules: [thingsRule(seen)], lookups: [], validators: [] }], {
        scratchRoot: scratch(),
        resolution: 'automatic',
      }),
      sink,
    )
    expect(summary.blocks).toEqual([])
    expect(summary.status).toBe('converted')
    expect(
      sink
        .rows('fx_things')
        .map((row) => row.id)
        .sort(),
    ).toEqual(['a', 'd'])
    // The undecodable row never reached the rule.
    expect(seen.map((row) => row.values.id).sort()).toEqual(['a', 'b', 'd'])

    // The staged rows, read the way the conversion reads them.
    const staged = await readSourceTable({
      source: memory.source,
      preflight: memory.preflight,
      table: 'recovery_events',
    })
    const expectArchived = (id: string, code: string): string => {
      const row = staged.find((entry) => entry.values.id === id)!
      const unit = sink.unitOf('recovery_events', eventKey(id))
      const disposition = unit.dispositions.find((entry) => entry.sourceKey === eventKey(id))!
      expect(disposition).toMatchObject({
        sourceTable: 'recovery_events',
        sourcePhase: 'current',
        class: 'archived',
        kind: 'archived',
        targets: [],
        decision: { code },
      })
      const text = archiveText(unit, disposition.archive)
      expect(row.raw).toBeDefined()
      expect(text).toBe(canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null }))
      expect(String(disposition.archive)).toBe(`archive:${bytesDigest(text)}`)
      return text
    }
    expectArchived('b', 'fixture-inconsistent')
    expect(
      sink.dispositions().find((entry) => entry.sourceKey === eventKey('b'))!.decision,
    ).toEqual({ code: 'fixture-inconsistent', detail: { reason: 'dangling' } })
    // What the old database stored is in the archive, not a normalised form of it.
    expect(expectArchived('c', 'v2-source-codec')).toContain('{ not json')
    expect(sink.dispositions()).toHaveLength(2)

    expect(summary.resolutions).toEqual({
      settledTasks: [],
      setAside: {
        total: 2,
        rows: expect.arrayContaining([
          {
            sourcePhase: 'current',
            sourceTable: 'recovery_events',
            sourceKey: eventKey('b'),
            code: 'fixture-inconsistent',
          },
          {
            sourcePhase: 'current',
            sourceTable: 'recovery_events',
            sourceKey: eventKey('c'),
            code: 'v2-source-codec',
          },
        ]),
      },
      missingContent: { total: 0, rows: [] },
      kept: { total: 0, byCode: {}, rows: [] },
      acknowledged: { total: 0, byCode: {} },
    })
    expect(summary.resolutions!.setAside.rows).toHaveLength(2)
    expect(summary.tableReceipts).toEqual([
      expect.objectContaining({
        sourceTable: 'recovery_events',
        rowsRead: 4,
        counts: { converted: 2, preserved: 0, archived: 2, blocked: 0 },
        exceptions: 2,
        targets: [{ table: 'fx_things', rows: 2 }],
      }),
    ])
  })

  test('the same source under operator resolution is blocked on both rows and archives nothing', async () => {
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(
        memorySource({ recovery_events: events() }),
        [{ rules: [thingsRule()], lookups: [], validators: [] }],
        { scratchRoot: scratch() },
      ),
      sink,
    )
    expect(summary.status).toBe('blocked')
    expect(summary.blocks.map((block) => block.code).sort()).toEqual([
      'fixture-inconsistent',
      'v2-source-codec',
    ])
    expect(summary).not.toHaveProperty('resolutions')
    expect([...sink.units.values()].flatMap((unit) => unit.archives)).toEqual([])
    expect(sink.dispositions().map((entry) => entry.class)).toEqual(['blocked', 'blocked'])
    expect(summary.tableReceipts[0]!.counts).toEqual({
      converted: 2,
      preserved: 0,
      archived: 0,
      blocked: 2,
    })
  })

  test('a table-level and a global block stay blocks under automatic resolution', async () => {
    const tableBlock: ConversionBlock = {
      code: 'fixture-table-block',
      scope: 'table',
      sourceTable: 'recovery_events',
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [],
      detail: null,
    }
    const globalBlock: ConversionBlock = {
      ...tableBlock,
      code: 'fixture-global-block',
      scope: 'global',
      sourceTable: null,
    }
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(
        memorySource({ recovery_events: [event('a')], maintenance_state: [] }),
        [
          {
            rules: [
              noteRule('recovery_events', {
                convert(_unit, ctx) {
                  ctx.out.block(tableBlock)
                },
              }),
              noteRule('maintenance_state', {
                convert(_unit, ctx) {
                  ctx.out.block(globalBlock)
                },
              }),
            ],
            lookups: [],
            validators: [],
          },
        ],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      sink,
    )
    expect(summary.status).toBe('blocked')
    expect([...summary.blocks].sort((a, b) => a.code.localeCompare(b.code))).toEqual([
      globalBlock,
      tableBlock,
    ])
    expect(summary.resolutions!.setAside).toEqual({ total: 0, rows: [] })
    expect([...sink.units.values()].flatMap((unit) => unit.archives)).toEqual([])
    expect(sink.dispositions().map((entry) => entry.class)).toEqual(['blocked'])
  })

  test('a refused target row that came from no source row ends the conversion instead of being set aside', async () => {
    const fromNothing = noteRule('recovery_events', {
      ref: { id: 'fixture/from-nothing', version: 1 },
      produces: [{ table: 'fx_things' }],
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!)
          ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
        ctx.out.row('fx_things', fxThing('from-nothing', { amount: -1 }), null)
      },
    })
    const sink = new RecordingSink()
    const outcome = await runConversion(
      engineInput(
        memorySource({ recovery_events: [event('a')] }),
        [{ rules: [fromNothing], lookups: [], validators: [] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      sink,
    ).catch((error: unknown) => error as Error)
    // An engine fault (design §3.6): a contract error, or a block nobody can turn into a decision.
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(ConversionContractError)
    else {
      expect(outcome.status).toBe('blocked')
      expect(outcome.blocks.map((block) => block.code)).toEqual(['v2-target-check'])
      expect(outcome.resolutions!.setAside.total).toBe(0)
    }
    expect(sink.rows('fx_things')).toEqual([])
    expect([...sink.units.values()].flatMap((unit) => unit.archives)).toEqual([])
  })

  test('a group with a row that cannot be decoded is set aside whole; other groups convert', async () => {
    const groups: string[] = []
    const groupRule: ConversionRule = {
      ref: { id: 'fixture/task-groups', version: 1 },
      owner: 'fixture',
      claims: ['tasks', 'node_runs'],
      produces: [{ table: 'fx_things' }],
      lookups: [],
      unit: {
        kind: 'group',
        driver: 'tasks',
        groupColumn: 'id',
        members: [{ table: 'node_runs', column: 'task_id' }],
      },
      convert(unit, ctx) {
        groups.push(...(unit.groupKeys ?? []))
        for (const row of [...unit.rows.values()].flat())
          ctx.out.row('fx_things', fxThing(`${row.table}:${String(row.values.id)}`), row)
      },
    }
    const task = (id: string) => frozenRow('tasks', { id, status: 'done' })
    const run = (id: string, taskId: string, values: DecodedSourceRow = {}) =>
      frozenRow('node_runs', { id, task_id: taskId, status: 'done', ...values })
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(
        memorySource({
          tasks: [task('g1'), task('g2')],
          node_runs: [
            run('g1-bad', 'g1', { runtime_params_json: '{ not json' }),
            run('g1-good', 'g1'),
            run('g2-good', 'g2'),
          ],
        }),
        [{ rules: [groupRule], lookups: [], validators: [] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      sink,
    )
    expect(summary.blocks).toEqual([])
    expect(summary.status).toBe('converted')
    // The rule never saw the group it could not be given whole.
    expect(groups).toEqual(['g2'])
    expect(
      sink
        .rows('fx_things')
        .map((row) => row.id)
        .sort(),
    ).toEqual(['node_runs:g2-good', 'tasks:g2'])
    expect(
      sink
        .dispositions()
        .map((entry) => `${entry.sourceTable}/${entry.class}/${entry.decision?.code}`)
        .sort(),
    ).toEqual([
      'node_runs/archived/v2-group-member-blocked',
      'node_runs/archived/v2-source-codec',
      'tasks/archived/v2-group-member-blocked',
    ])
    expect(summary.resolutions!.setAside.total).toBe(3)
    const counts = Object.fromEntries(
      summary.tableReceipts.map((receipt) => [receipt.sourceTable, receipt.counts]),
    )
    expect(counts).toEqual({
      node_runs: { converted: 1, preserved: 0, archived: 2, blocked: 0 },
      tasks: { converted: 1, preserved: 0, archived: 1, blocked: 0 },
    })
  })

  // Gate G1-1 through the engine: the report and the table receipt see the set-aside row once.
  test('a row set aside after its marker was written is only set aside in the report; the table receipt claims nothing for it', async () => {
    const marked = thingsRule([], {
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          ctx.out.record(
            {
              kind: 'decision',
              code: 'fixture-kept-with-marker',
              payload: { automatic: 'kept', sourceTable: row.table, sourceKey: row.encodedKey },
            },
            row,
          )
          ctx.out.row(
            'fx_things',
            fxThing(String(row.values.id), {
              amount: row.values.kind === 'inconsistent' ? -1 : 1,
            }),
            row,
          )
        }
      },
    })
    const claims: RowValidator = {
      ref: { id: 'fixture/active-claims', version: 1 },
      table: 'recovery_events',
      validate(row, ctx) {
        ctx.out.record({
          kind: 'source-metadata',
          table: row.table,
          payload: {
            kind: 'active-claim',
            sourceKey: row.encodedKey,
            sourcePhase: row.phase,
            values: { id: canonicalValue(String(row.values.id)) },
          },
        })
        return []
      },
    }
    const summary = await runConversion(
      engineInput(
        memorySource({ recovery_events: [event('a'), event('b', { kind: 'inconsistent' })] }),
        [{ rules: [marked], lookups: [], validators: [claims] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      new RecordingSink(),
    )
    expect(summary.status).toBe('converted')
    expect(summary.resolutions!.kept).toEqual({
      total: 1,
      byCode: { 'fixture-kept-with-marker': 1 },
      rows: [
        {
          sourceTable: 'recovery_events',
          sourceKey: eventKey('a'),
          code: 'fixture-kept-with-marker',
        },
      ],
    })
    expect(summary.resolutions!.setAside).toEqual({
      total: 1,
      rows: [
        {
          sourcePhase: 'current',
          sourceTable: 'recovery_events',
          sourceKey: eventKey('b'),
          code: 'v2-target-check',
        },
      ],
    })
    expect(summary.tableReceipts).toEqual([
      expect.objectContaining({
        sourceTable: 'recovery_events',
        counts: { converted: 1, preserved: 0, archived: 1, blocked: 0 },
        exceptions: 1,
        historyOnly: 0,
        activeClaims: [{ sourceKey: eventKey('a'), values: { id: canonicalValue('a') } }],
      }),
    ])
  })

  // Gate G4-3 (design §3.7): the report says whose content is missing. The task is the one the
  // rule's `settles` names for the row, else the row's own `task_id`; content of no task, or of
  // several, has none.
  test('missing content names the one task its row belongs to', async () => {
    const tasksOf = (row: SourceRow): readonly string[] | undefined =>
      typeof row.values.reason === 'string' ? row.values.reason.split(',') : undefined
    const content = thingsRule([], {
      settles: { tasksOf },
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          const values = fxThing(String(row.values.id))
          ctx.out.row('fx_things', values, row)
          ctx.out.artifact({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            sourceColumn: 'reason',
            originalReference: `runs/${String(row.values.id)}.md`,
            target: {
              table: 'fx_things',
              key: ctx.target.key('fx_things', values),
              contentId: null,
              backend: 'local-file',
            },
            bytes: null,
            publication: 'not-required',
            missing: { state: 'missing-at-freeze', evidence: 'fixture inventory' },
          })
        }
      },
    })
    const summary = await runConversion(
      engineInput(
        memorySource({
          recovery_events: [
            // Its own task, which its declaration does not name.
            event('own', { task_id: 'task-own' }),
            // Named by the declaration, with no task of its own.
            event('named', { reason: 'task-named' }),
            // The declaration names it and the row has its own: the declaration wins.
            event('both', { reason: 'task-declared', task_id: 'task-column' }),
            // Shared by two tasks: none of them is the owner.
            event('shared', { reason: 'task-x,task-y' }),
            event('none'),
          ],
        }),
        [{ rules: [content], lookups: [], validators: [] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      new RecordingSink(),
    )
    expect(summary.status).toBe('converted')
    expect(summary.resolutions!.missingContent.total).toBe(5)
    expect(
      Object.fromEntries(
        summary.resolutions!.missingContent.rows.map((row) => [row.reference, row.taskId]),
      ),
    ).toEqual({
      'runs/own.md': 'task-own',
      'runs/named.md': 'task-named',
      'runs/both.md': 'task-declared',
      'runs/shared.md': null,
      'runs/none.md': null,
    })
  })

  test('rows kept with a marker and content registered as missing are counted for the report', async () => {
    const acknowledged: (OperatorDecision | null)[] = []
    const staged: SourceRow[] = []
    const rule = thingsRule([], {
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          const values = fxThing(String(row.values.id))
          ctx.out.row('fx_things', values, row)
          if (row.values.kind === 'kept')
            ctx.out.record({
              kind: 'decision',
              code: 'fixture-kept-with-marker',
              payload: { automatic: 'kept', sourceTable: row.table, sourceKey: row.encodedKey },
            })
          if (row.values.kind === 'unfinished') {
            staged.push(row)
            acknowledged.push(ctx.operatorDecisions!.consume(row, 'v2-code-history-unfinished'))
          }
          if (row.values.kind === 'missing')
            ctx.out.artifact({
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              sourceColumn: 'reason',
              originalReference: 'runs/fixture/v1.md',
              target: {
                table: 'fx_things',
                key: ctx.target.key('fx_things', values),
                contentId: null,
                backend: 'local-file',
              },
              bytes: null,
              publication: 'not-required',
              missing: { state: 'originally-absent', evidence: 'fixture inventory' },
            })
        }
      },
    })
    const rows = () => [
      event('k1', { kind: 'kept' }),
      event('k2', { kind: 'kept' }),
      event('m1', { kind: 'missing' }),
      event('u1', { kind: 'unfinished' }),
      event('z', {}),
    ]
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(
        memorySource({ recovery_events: rows() }),
        [{ rules: [rule], lookups: [], validators: [] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      sink,
    )
    expect(summary.status).toBe('converted')
    expect(summary.resolutions).toEqual({
      settledTasks: [],
      setAside: { total: 0, rows: [] },
      missingContent: {
        total: 1,
        rows: [
          {
            sourceTable: 'recovery_events',
            sourceKey: eventKey('m1'),
            sourceColumn: 'reason',
            reference: 'runs/fixture/v1.md',
            state: 'originally-absent',
            // The row belongs to no task.
            taskId: null,
          },
        ],
      },
      // Rows kept with a marker are listed when the rule named them in its decision.
      kept: {
        total: 2,
        byCode: { 'fixture-kept-with-marker': 2 },
        rows: expect.arrayContaining(
          ['k1', 'k2'].map((id) => ({
            sourceTable: 'recovery_events',
            sourceKey: eventKey(id),
            code: 'fixture-kept-with-marker',
          })),
        ),
      },
      // An acknowledgement given in place of a person is counted by the code acknowledged.
      acknowledged: { total: 1, byCode: { 'v2-code-history-unfinished': 1 } },
    })
    expect(summary.resolutions!.kept.rows).toHaveLength(2)
    // The acknowledgement the engine gives for the row as it is now (design §3.4 row 8).
    expect(acknowledged).toEqual([
      {
        kind: 'acknowledge-unfinished-legacy-work',
        sourceTable: 'recovery_events',
        sourceKey: eventKey('u1'),
        sourcePhase: 'current',
        rowDigest: operatorDecisionRowDigest(staged[0]!),
        blockCode: 'v2-code-history-unfinished',
        acknowledgedBy: 'automatic-upgrade',
        acknowledgedAt: PLAN_TIME,
        reason: expect.any(String),
      },
    ])
    // It is derived from the row, not stored in the plan — that list holds what people decided —
    // and the unit that used it says who acknowledged what, when, and on which row.
    expect(summary.plan.operatorDecisions).toEqual([])
    expect(
      sink
        .records()
        .filter(
          (record) => record.kind === 'decision' && record.code === 'v2-code-history-unfinished',
        ),
    ).toEqual([
      {
        kind: 'decision',
        code: 'v2-code-history-unfinished',
        payload: expect.objectContaining({
          sourcePhase: 'current',
          sourceTable: 'recovery_events',
          sourceKey: eventKey('u1'),
          acknowledgedBy: 'automatic-upgrade',
          acknowledgedAt: PLAN_TIME,
          rowDigest: operatorDecisionRowDigest(staged[0]!),
        }),
      },
    ])

    // Operator resolution has no decision to give: nobody acknowledged this row.
    acknowledged.length = 0
    const manual = await runConversion(
      engineInput(
        memorySource({ recovery_events: rows() }),
        [{ rules: [rule], lookups: [], validators: [] }],
        { scratchRoot: scratch() },
      ),
      new RecordingSink(),
    )
    expect(acknowledged).toEqual([null])
    expect(manual).not.toHaveProperty('resolutions')
  })
})

describe('RFC-626 seed rows of the target schema through the engine', () => {
  // A target whose seeded table has the name and key of a source table: the source row with
  // that key is the row the new database cannot do without.
  const seededState = r2Owner.table({
    id: 'maintenance_state',
    schemaSymbol: 'rfc626SeededMaintenanceState',
    retention: retention.operational,
    columns: {
      key: c.id('key', { primary: true }),
      value: c.text('value'),
      updatedAt: c.epochMs('updated_at'),
    },
  })
  const seeded = r2Registry(
    [seededState],
    [
      {
        table: 'maintenance_state',
        mode: 'install-only',
        rows: [{ key: 'seed-row', value: 'seed', updated_at: 0 }],
      },
    ],
  )
  const copyRule: ConversionRule = {
    ref: { id: 'fixture/state', version: 1 },
    owner: 'fixture',
    claims: ['maintenance_state'],
    produces: [{ table: 'maintenance_state' }],
    lookups: [],
    unit: { kind: 'source-chunk', table: 'maintenance_state' },
    convert(unit, ctx) {
      for (const row of unit.rows.get('maintenance_state')!) {
        if (row.values.value === 'inconsistent')
          ctx.out.block(rowBlock('fixture-inconsistent', row, null))
        else ctx.out.row('maintenance_state', row.values, row)
      }
    },
  }
  const state = (key: string, value: string | null) =>
    frozenRow('maintenance_state', { key, value, updated_at: 5 })
  const convert = (rows: readonly DecodedSourceRow[], resolution?: 'automatic') =>
    runConversion(
      engineInput(
        memorySource({ maintenance_state: rows }),
        [{ rules: [copyRule], lookups: [], validators: [] }],
        { scratchRoot: scratch(), target: seeded, ...(resolution ? { resolution } : {}) },
      ),
      new RecordingSink(),
    )

  test('a seed row the rule cannot carry over ends the conversion and names the row', async () => {
    let thrown: unknown
    await convert([state('other', 'fine'), state('seed-row', 'inconsistent')], 'automatic').catch(
      (error: unknown) => {
        thrown = error
      },
    )
    expect(thrown).toBeInstanceOf(ConversionContractError)
    expect((thrown as ConversionContractError).code).toBe('v2-required-seed-set-aside')
    expect((thrown as Error).message).toContain('maintenance_state')
    expect((thrown as Error).message).toContain('seed-row')
  })

  test('a seed row with a column the frozen codec rejects ends the conversion the same way', async () => {
    // The key decodes, another column does not: the row exists and still cannot be taken.
    await expect(convert([state('seed-row', null)], 'automatic')).rejects.toThrow(
      'v2-required-seed-set-aside',
    )
  })

  test('any other row with the same defect is simply set aside, and operator resolution blocks as before', async () => {
    const aside = await convert(
      [state('seed-row', 'fine'), state('other', 'inconsistent')],
      'automatic',
    )
    expect(aside.status).toBe('converted')
    expect(aside.resolutions!.setAside.rows).toEqual([
      {
        sourcePhase: 'current',
        sourceTable: 'maintenance_state',
        sourceKey: sourceKey('maintenance_state', 'other'),
        code: 'fixture-inconsistent',
      },
    ])
    const manual = await convert([state('seed-row', 'inconsistent')])
    expect(manual.status).toBe('blocked')
    expect(manual.blocks.map((block) => block.code)).toEqual(['fixture-inconsistent'])
  })

  test('the real target schema protects its seeds: the system user cannot be set aside', async () => {
    const usersRule = noteRule('users', {
      convert(unit, ctx) {
        for (const row of unit.rows.get('users')!)
          ctx.out.block(rowBlock('fixture-inconsistent', row, null))
      },
    })
    const input = (rows: readonly DecodedSourceRow[]) =>
      engineInput(
        memorySource({ users: rows }),
        [{ rules: [usersRule], lookups: [], validators: [] }],
        { scratchRoot: scratch(), target: persistenceSchema, resolution: 'automatic' },
      )
    await expect(
      runConversion(
        input([frozenRow('users', { id: '__system__', username: '__system__' })]),
        new RecordingSink(),
      ),
    ).rejects.toThrow('v2-required-seed-set-aside')
    const ordinary = await runConversion(
      input([frozenRow('users', { id: 'someone', username: 'someone' })]),
      new RecordingSink(),
    )
    expect(ordinary.status).toBe('converted')
    expect(ordinary.resolutions!.setAside.total).toBe(1)
  })
})

describe('RFC-626 rules that take undecodable rows themselves', () => {
  // The contract of `ConversionRule.takesUndecodedRows` (conversion/rule.ts): a rule that has
  // to account for every row of its table in one output is handed the rows the frozen codec
  // rejected, instead of having them set aside before it runs. Automatic resolution only.
  const archiveWhole = (seen: SourceRow[], flag: boolean): ConversionRule =>
    noteRule('recovery_events', {
      ref: { id: 'fixture/whole-table', version: 1 },
      ...(flag ? { takesUndecodedRows: true } : {}),
      convert(unit, ctx) {
        for (const row of unit.rows.get('recovery_events')!) {
          seen.push(row)
          ctx.out.record({ kind: 'decision', code: 'fixture-noted', payload: null }, row)
        }
      },
    })
  const source = () =>
    memorySource({
      recovery_events: [event('good'), event('undecodable', { before_json: '{ not json' })],
    })
  const convert = async (flag: boolean, resolution?: 'automatic') => {
    const seen: SourceRow[] = []
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(source(), [{ rules: [archiveWhole(seen, flag)], lookups: [], validators: [] }], {
        scratchRoot: scratch(),
        ...(resolution ? { resolution } : {}),
      }),
      sink,
    )
    return { seen, sink, summary }
  }

  test('with the declaration the rule receives the row as it was read; without it the row is set aside first', async () => {
    const taken = await convert(true, 'automatic')
    expect(taken.summary.status).toBe('converted')
    const row = taken.seen.find((entry) => entry.values.id === 'undecodable')!
    expect(row.codecFailure?.columns).toEqual(['before_json'])
    expect(row.raw).toBeDefined()
    expect(taken.sink.dispositions()).toEqual([])
    expect(taken.summary.resolutions!.setAside.total).toBe(0)

    const aside = await convert(false, 'automatic')
    expect(aside.seen.map((entry) => entry.values.id)).toEqual(['good'])
    expect(aside.summary.resolutions!.setAside.rows.map((entry) => entry.code)).toEqual([
      'v2-source-codec',
    ])
  })

  test('operator resolution blocks the undecodable row whatever the rule declares', async () => {
    for (const flag of [true, false]) {
      const blocked = await convert(flag)
      expect(blocked.summary.status).toBe('blocked')
      expect(blocked.summary.blocks.map((block) => block.code)).toEqual(['v2-source-codec'])
      expect(blocked.seen.map((entry) => entry.values.id)).toEqual(['good'])
    }
  })
})

describe('RFC-626 preparing and running are two steps', () => {
  test('the plan is final before a sink exists, and the staging store lives until close', async () => {
    const closed: number[] = []
    const prepared = await prepareConversion({
      ...engineInput(
        memorySource({ recovery_events: [event('a'), event('b', { kind: 'inconsistent' })] }),
        [{ rules: [thingsRule()], lookups: [], validators: [] }],
        { scratchRoot: scratch(), resolution: 'automatic' },
      ),
      onStagingPeak: (bytes) => closed.push(bytes),
    })
    expect(prepared.plan).toMatchObject({ resolution: 'automatic', settlements: [] })
    expect(closed).toEqual([])
    const sink = new RecordingSink()
    const summary = await prepared.run(sink)
    expect(sink.binding?.planDigest).toBe(prepared.plan.digest)
    expect(summary.plan.digest).toBe(prepared.plan.digest)
    expect(closed).toEqual([])
    prepared.close()
    prepared.close()
    expect(closed).toHaveLength(1)
  })
})
