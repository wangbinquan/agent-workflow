// RFC-626 §3.3 "悬空行" (the paragraph on required seed rows) and §3.6
// (design/RFC-626-upgrade-no-refusal-minimal-time/design.md). "The rows every release depends
// on" are the seeds the target schema declares — the list target validation checks. The
// conversion used to look for two of them in the source (the system user, the global login
// policy) and never for the cutover row of each committed-event family, so a source without
// one of those passed the conversion and failed validation. The list is now derived from the
// target schema: the target view gives the seed keys of a table, the presence lookup registers
// every row of the seeded tables, and the rule of the family cutovers checks like the others.
// A missing seed row is a table-level block, and stays one under automatic resolution: there
// is no row to set aside and no release works without it.
import { describe, expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { familyCutoversRule } from '@/platform/persistence/migration/archives/familyCutovers'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import {
  requiredSeedTables,
  seedPresence,
} from '@/platform/persistence/migration/conversion/generic/seedPresence'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import {
  requiredSeedKeys,
  requiredSeedKeysByTable,
  requiredSeedRows,
} from '@/platform/persistence/migration/conversion/requiredSeeds'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import type {
  ConversionBlock,
  EncodedKey,
  SourceRow,
} from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { SchemaContribution } from '@/platform/persistence/schema/contribution'
import {
  RecordingSink,
  engineInput,
  frozenRow,
  memorySource,
  noteRule,
  scratchRoots,
} from './rfc626-engine-fixtures.test'

const scratch = scratchRoots()

const CUTOVERS = 'committed_event_family_cutovers'
/** The seeds the target schema declares, read off the schema: table, and the literal key of each row. */
const declared: readonly { readonly table: string; readonly key: EncodedKey }[] =
  // Widened to the declared contribution shape: not every contribution literal carries `seeds`.
  (persistenceSchema.contributions as readonly SchemaContribution[]).flatMap((contribution) =>
    (contribution.seeds ?? []).flatMap((seed) => {
      const table = persistenceSchema.tables.find((entry) => entry.id === seed.table)
      if (!table) throw new Error(`seed of an unknown table: ${seed.table}`)
      return seed.rows.map((row) => ({
        table: seed.table,
        key: encodeMigrationKey(
          seed.table,
          table.primaryKey.map((name) => {
            const cell = row[name]
            if (typeof cell !== 'string')
              throw new Error(`${seed.table}.${name} is not literal text`)
            return canonicalValue(cell)
          }),
        ),
      }))
    }),
  )
const seededTables = [...new Set(declared.map((entry) => entry.table))].sort()
const keysOf = (table: string): EncodedKey[] =>
  declared
    .filter((entry) => entry.table === table)
    .map((entry) => entry.key)
    .sort()
const keyOf = (table: string, ...cells: readonly string[]): EncodedKey =>
  encodeMigrationKey(
    table,
    cells.map((cell) => canonicalValue(cell)),
  )

describe('RFC-626 the required seed rows are the seeds of the target schema', () => {
  test('the source tables checked for seeds are exactly the tables the target schema seeds', () => {
    expect(seededTables.length).toBeGreaterThan(0)
    expect([...requiredSeedTables].sort()).toEqual(seededTables)
    expect(new Set(requiredSeedTables).size).toBe(requiredSeedTables.length)
    // The lookup declares its sources up front: it has to read every one of them.
    expect([...seedPresence.sources].sort()).toEqual(seededTables)
  })

  test('the target view gives the key of every declared seed row, and none for any other table', () => {
    const view = targetRegistryView(persistenceSchema)
    for (const table of seededTables)
      expect([...view.seedKeys(table)].sort()).toEqual(keysOf(table))
    for (const table of persistenceSchema.tables)
      if (!seededTables.includes(table.id)) expect(view.seedKeys(table.id)).toEqual([])
    expect(seededTables.flatMap((table) => view.seedKeys(table))).toHaveLength(declared.length)
    // The ones validation has always named, and the family routes it also requires.
    expect(view.seedKeys('users')).toEqual([keyOf('users', '__system__')])
    expect(view.seedKeys('auth_login_policy')).toEqual([keyOf('auth_login_policy', 'global')])
    expect([...view.seedKeys(CUTOVERS)].sort()).toEqual(
      [
        keyOf(CUTOVERS, 'task-execution', 'task-lifecycle'),
        keyOf(CUTOVERS, 'collaboration', 'review'),
        keyOf(CUTOVERS, 'collaboration', 'clarify'),
        keyOf(CUTOVERS, 'collaboration', 'questions'),
      ].sort(),
    )
  })

  test('a source row is a required seed by its table and key, nothing else', () => {
    expect(requiredSeedKeys(persistenceSchema)).toEqual(new Set(declared.map((entry) => entry.key)))
    expect(
      [...requiredSeedKeysByTable(persistenceSchema)].map(([table, keys]) => [
        table,
        [...keys].sort(),
      ]),
    ).toEqual(expect.arrayContaining(seededTables.map((table) => [table, keysOf(table)])))
    const row = (table: string, id: string): SourceRow => {
      const key = [canonicalValue(id)]
      return {
        table,
        phase: 'current',
        key,
        encodedKey: encodeMigrationKey(table, key),
        canonical: { key, values: [canonicalValue(id)] },
        values: { id },
      }
    }
    const required = requiredSeedRows(persistenceSchema)
    expect(required(row('users', '__system__'))).toBe(true)
    expect(required(row('auth_login_policy', 'global'))).toBe(true)
    expect(required(row('users', 'someone'))).toBe(false)
    // The same key cells in another table are another row.
    expect(required(row('tasks', '__system__'))).toBe(false)
  })
})

describe('RFC-626 a seed row the source does not have', () => {
  const routes = [
    ['task-execution', 'task-lifecycle'],
    ['collaboration', 'review'],
    ['collaboration', 'clarify'],
    ['collaboration', 'questions'],
  ] as const
  const route = ([producer, family]: readonly [string, string]): DecodedSourceRow =>
    frozenRow(CUTOVERS, {
      producer,
      family,
      mode: 'dispatchable',
      epoch: 2,
      changed_at: 456,
      change_ref: 'rfc341:cutover',
    })
  const missing = (table: string, detail: Readonly<Record<string, string>>): ConversionBlock => ({
    code: 'v2-required-seed-missing',
    scope: 'table',
    sourceTable: table,
    sourceKey: null,
    taskId: null,
    runId: null,
    missingFields: Object.keys(detail),
    detail,
  })
  /** A block is reported by every unit that meets it; what was reported is what matters here. */
  const distinct = (blocks: readonly ConversionBlock[]): ConversionBlock[] =>
    [...new Map(blocks.map((block) => [valueDigest(block), block])).values()].sort((a, b) =>
      String(a.sourceTable).localeCompare(String(b.sourceTable)),
    )
  async function convert(
    rules: readonly ConversionRule[],
    cutovers: readonly DecodedSourceRow[],
    resolution?: 'automatic',
  ) {
    const sink = new RecordingSink()
    const summary = await runConversion(
      engineInput(
        memorySource({ users: [], auth_login_policy: [], [CUTOVERS]: cutovers }),
        [{ rules, lookups: [seedPresence], validators: [] }],
        {
          scratchRoot: scratch(),
          target: persistenceSchema,
          ...(resolution ? { resolution } : {}),
        },
      ),
      sink,
    )
    return { sink, summary }
  }
  /** Only the family routes are looked for. */
  const routesOnly = [noteRule('users'), noteRule('auth_login_policy'), familyCutoversRule]
  const modes = [undefined, 'automatic'] as const

  test('a family whose cutover row is missing blocks the table, under automatic resolution as well', async () => {
    for (const resolution of modes) {
      const { sink, summary } = await convert(routesOnly, routes.slice(0, 3).map(route), resolution)
      expect(summary.status).toBe('blocked')
      expect(distinct(summary.blocks)).toEqual([
        missing(CUTOVERS, { producer: 'collaboration', family: 'questions' }),
      ])
      // Nothing was set aside for it: there is no row to set aside.
      expect([...sink.units.values()].flatMap((unit) => unit.archives)).toEqual([])
      if (resolution) expect(summary.resolutions!.setAside).toEqual({ total: 0, rows: [] })
    }
  })

  test('every missing family is named', async () => {
    const { summary } = await convert(routesOnly, [route(routes[1])], 'automatic')
    expect(
      distinct(summary.blocks)
        .map((block) => block.detail)
        .sort((a, b) => valueDigest(a).localeCompare(valueDigest(b))),
    ).toEqual<unknown>(
      [
        { producer: 'task-execution', family: 'task-lifecycle' },
        { producer: 'collaboration', family: 'clarify' },
        { producer: 'collaboration', family: 'questions' },
      ].sort((a, b) => valueDigest(a).localeCompare(valueDigest(b))),
    )
  })

  test('with every family present the routes convert and nothing is missing', async () => {
    for (const resolution of modes) {
      const { sink, summary } = await convert(routesOnly, routes.map(route), resolution)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(sink.rows(CUTOVERS)).toHaveLength(4)
    }
  })

  test('the system user and the login policy are reported as they always were', async () => {
    for (const resolution of modes) {
      const { summary } = await convert(
        [preservedRule('users'), preservedRule('auth_login_policy'), familyCutoversRule],
        routes.map(route),
        resolution,
      )
      expect(summary.status).toBe('blocked')
      expect(distinct(summary.blocks)).toEqual([
        missing('auth_login_policy', { id: 'global' }),
        missing('users', { id: '__system__' }),
      ])
    }
  })
})
