import { expect, test } from 'bun:test'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { V2Harness } from './helpers/rfc395V2Harness'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { conversion as generic } from '@/platform/persistence/migration/conversion/generic'
import { conversion as alignment } from '@/platform/persistence/migration/conversion/alignment'
import { memoriesRule } from '@/platform/persistence/migration/conversion/alignment/memories'

// All epoch-1 fixture inserts still pass through the canonical frozen raw row writer.
export async function writeFrozenFixture(
  h: V2Harness,
  table: string,
  values: DecodedSourceRow,
): Promise<void> {
  const definition = frozenEpoch1Registry.tables.find((entry) => entry.id === table)!
  const row = Object.fromEntries(
    Object.values(definition.columns).map((column) => {
      if (column.default.kind === 'literal') return [column.name, column.default.value]
      if (column.nullable) return [column.name, null]
      if (column.codec === 'enum') return [column.name, column.enumValues![0]!]
      if (column.codec === 'bool') return [column.name, false]
      if (['int', 'identity', 'seq', 'epochMs', 'durationMs', 'real'].includes(column.codec))
        return [column.name, 1]
      if (column.codec === 'jsonText') return [column.name, '{}']
      return [column.name, `${table}:${column.name}`]
    }),
  ) as DecodedSourceRow
  await h.write(table, [{ ...row, ...values }])
}

export function coreBFixture(
  tables: readonly string[],
  replacements: readonly LookupBuilder<unknown>[] = [],
): ConversionContribution {
  const overrides = new Map(replacements.map((lookup) => [lookup.key.id, lookup]))
  return {
    rules: [...generic.rules, ...alignment.rules, memoriesRule].filter((rule) =>
      rule.claims.some((table) => tables.includes(table)),
    ),
    lookups: [...generic.lookups, ...alignment.lookups].map(
      (lookup) => overrides.get(lookup.key.id) ?? lookup,
    ),
    validators: [...generic.validators, ...alignment.validators].filter((validator) =>
      tables.includes(validator.table),
    ),
  }
}

export async function writeTaskFixture(h: V2Harness): Promise<void> {
  await ensureIdentitySeeds(h)
  await writeFrozenFixture(h, 'workflows', {
    id: 'fixture-workflow',
    name: 'Fixture Workflow',
    definition: '{"inputs":[],"nodes":[],"edges":[]}',
  })
  await writeFrozenFixture(h, 'tasks', {
    id: 'fixture-task',
    workflow_id: 'fixture-workflow',
    workflow_snapshot: '{"inputs":[],"nodes":[],"edges":[]}',
    name: 'Fixture task',
    status: 'done',
  })
}

export async function ensureIdentitySeeds(h: V2Harness): Promise<void> {
  for (const [table, id] of [
    ['users', '__system__'],
    ['auth_login_policy', 'global'],
  ] as const) {
    const rows = await h.sourceHarness.native.execute(
      `SELECT id FROM ${h.sourceHarness.table(table)}`,
    )
    if (!rows.some((row) => row.id === id))
      await writeFrozenFixture(
        h,
        table,
        table === 'users' ? { id, username: id, display_name: 'System' } : { id },
      )
  }
}

test('V2 B fixture defaults are bound only to the frozen epoch-1 registry', () => {
  expect(frozenEpoch1Registry.tables).toHaveLength(222)
  expect(
    frozenEpoch1Registry.tables.find((table) => table.id === 'tasks')!.columns.workflowId!.name,
  ).toBe('workflow_id')
})
