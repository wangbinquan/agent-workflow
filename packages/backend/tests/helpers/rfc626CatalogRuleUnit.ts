// RFC-626: drives one conversion rule over one unit through the real staging store, lookup
// builders and unit collector — the same pieces the engine uses — with either resolution and
// without a source database. Used by the rfc626 skill, agent, fusion and memory rule tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import {
  buildLookups,
  restrictLookups,
  type LookupBuilder,
} from '@/platform/persistence/migration/conversion/lookups'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import type {
  ConversionResolution,
  JsonValue,
  SourceRow,
  TargetRow,
  UnitOutput,
} from '@/platform/persistence/migration/conversion/types'
import type {
  DecodedSourceRow,
  SourcePreflight,
} from '@/platform/persistence/migration/sourceTypes'
import type { ReadOnlyProbeConnection } from '@/platform/persistence/migration/run/types'
import { emptyV2Content } from './rfc395V2Harness'

/** A decoded source row as staging holds it; `keyColumns` name the migration key. */
export function sourceRow(
  table: string,
  values: DecodedSourceRow,
  keyColumns: readonly string[] = ['id'],
  extra: Pick<SourceRow, 'codecFailure'> = {},
): SourceRow {
  const key = keyColumns.map((column) => canonicalValue(values[column] ?? null))
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical: {
      key,
      values: Object.keys(values)
        .sort()
        .map((column) => canonicalValue(values[column]!)),
    },
    values,
    ...extra,
  }
}

export interface RuleUnitResult {
  readonly output: UnitOutput
  rows(table: string): readonly TargetRow[]
  decisions(code: string): readonly { readonly [key: string]: JsonValue }[]
}

/**
 * Stages `rows`, builds `lookups`, hands the rows of the rule's claimed tables (as staging
 * returns them) to `rule.convert` as one unit and returns the collected unit output.
 */
export async function runRuleUnit(input: {
  readonly rule: ConversionRule
  readonly lookups: readonly LookupBuilder<unknown>[]
  readonly rows: readonly SourceRow[]
  readonly groupKeys?: readonly string[]
  readonly resolution?: ConversionResolution
}): Promise<RuleUnitResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'rfc626-rule-unit-'))
  const staged = createStagingStore(scratch)
  try {
    for (const row of input.rows) staged.put(row)
    const lookup = await buildLookups(input.lookups, staged)
    const target = targetRegistryView(persistenceSchema)
    const claimed = new Map<string, readonly SourceRow[]>(
      input.rule.claims.map((table) => [table, [...staged.rows(table)]]),
    )
    const collector = createUnitCollector({
      rule: input.rule,
      sourceRows: [...claimed.values()].flat(),
      sourceVersion: '0.19.2',
      sourceContract: 'rfc626-fixture-contract',
      target,
      topology: persistenceSchema.tables.map((table) => table.id),
      ...(input.resolution ? { resolution: input.resolution } : {}),
    })
    await input.rule.convert(
      { rows: claimed, ...(input.groupKeys ? { groupKeys: input.groupKeys } : {}) },
      {
        sourceVersion: '0.19.2',
        sourceProvider: 'sqlite',
        sourceGenerationId: 'rfc626-fixture-source',
        preflight: {} as SourcePreflight,
        planTime: 123,
        target,
        lookup: restrictLookups(lookup, input.rule.lookups),
        ids: { child: deterministicChildId },
        content: emptyV2Content,
        resolution: input.resolution ?? 'operator',
        out: collector.out,
      },
    )
    const output = collector.finish({
      unit: { kind: 'group', rule: input.rule.ref.id, index: 0, firstGroup: null, lastGroup: null },
      unitId: 'rfc626-fixture-unit',
      lookups: [],
    })
    return {
      output,
      rows: (table) =>
        output.rows.filter((group) => group.table === table).flatMap((group) => group.rows),
      decisions: (code) =>
        output.records.flatMap((record) =>
          record.kind === 'decision' &&
          record.code === code &&
          record.payload !== null &&
          typeof record.payload === 'object' &&
          !Array.isArray(record.payload)
            ? [record.payload as { readonly [key: string]: JsonValue }]
            : [],
        ),
    }
  } finally {
    staged.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * A read-only probe connection over converted rows. It answers a probe's `SELECT ... FROM
 * <table>` with that table's rows, ordered by `orderBy` when given — enough for the probes that
 * read whole tables, which is what the rfc626 tests run.
 */
export function probeConnection(
  tables: Readonly<Record<string, readonly TargetRow[]>>,
  orderBy: Readonly<Record<string, readonly string[]>> = {},
): ReadOnlyProbeConnection {
  return {
    provider: 'sqlite',
    async query(sql) {
      const table = Object.keys(tables)
        .sort((a, b) => b.length - a.length)
        .find((name) =>
          new RegExp(`(^|[^a-z_])${name}([^a-z_]|$)`).test(sql.split(/ FROM /i)[1] ?? ''),
        )
      if (table === undefined) throw new Error(`rfc626 probe fixture has no table for: ${sql}`)
      const columns = orderBy[table] ?? []
      const compare = (a: unknown, b: unknown): number =>
        typeof a === 'number' && typeof b === 'number'
          ? a - b
          : String(a) < String(b)
            ? -1
            : String(a) > String(b)
              ? 1
              : 0
      return [...tables[table]!]
        .sort((a, b) => {
          for (const column of columns) {
            const order = compare(a[column], b[column])
            if (order) return order
          }
          return 0
        })
        .map((row) => ({ ...row }))
    },
  }
}
