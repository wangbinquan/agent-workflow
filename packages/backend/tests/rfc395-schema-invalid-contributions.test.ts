// RFC-395 I-a: malformed ownership, codecs, digest semantics, identity policies and logical references must fail all compilers.
import { describe, expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import type {
  SchemaContribution,
  TableDefinition,
} from '@/platform/persistence/schema/contribution'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { compileContract } from '@/platform/persistence/schema/contract'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'

type MutableTable = {
  -readonly [K in Exclude<keyof TableDefinition, 'columns'>]: TableDefinition[K]
} & { columns: Record<string, Record<string, unknown>> }
function mutated(mutate: (table: MutableTable) => void): SchemaRegistry {
  const contributions = structuredClone(persistenceSchema.contributions) as SchemaContribution[]
  const table = contributions
    .flatMap((c) => c.tables)
    .find((t) => t.id === 'agents')! as unknown as MutableTable
  mutate(table)
  return { contributions, tables: contributions.flatMap((c) => c.tables) }
}
const cases: readonly [string, (table: MutableTable) => void, string][] = [
  [
    'missing owner',
    (t) => {
      t.owner = ''
    },
    'owner',
  ],
  [
    'missing codec',
    (t) => {
      delete t.columns.id!.codec
    },
    'missing codec',
  ],
  [
    'jsonDoc destroys original-text digest',
    (t) => {
      t.columns.inputs!.codec = 'jsonDoc'
    },
    'original-text digest',
  ],
  [
    'identity without a high-water policy',
    (t) => {
      t.columns.id!.codec = 'identity'
    },
    'high-water policy',
  ],
  [
    'cross-context foreign key points at an absent logical table',
    (t) => {
      t.foreignKeys = [
        {
          name: 'missing_fk',
          columns: ['id'],
          foreignTable: 'absent_context_table',
          foreignColumns: ['id'],
          onDelete: 'no action',
          onUpdate: 'no action',
          lifecycle: 'Cross-context retained reference.',
        },
      ]
    },
    'missing logical FK target',
  ],
  [
    'raw expression without a reason',
    (t) => {
      t.checks = [
        {
          name: 'empty_reason',
          expression: { kind: 'raw', sqlite: '1', postgresql: 'TRUE', reason: '' },
        },
      ]
    },
    'reason',
  ],
]
describe('RFC-395 I-a negative compilation', () => {
  for (const [label, mutate, message] of cases)
    test(label, () => {
      const registry = mutated(mutate)
      expect(() => createSchemaRegistry(registry.contributions)).toThrow(message)
      for (const compile of [compileContract, compileSqlitePlan, compilePostgresqlPlan])
        expect(() => compile(registry)).toThrow(message)
    })
  test('duplicate physical table/owner declarations cannot enter the registry', () => {
    expect(() =>
      createSchemaRegistry([
        ...persistenceSchema.contributions,
        persistenceSchema.contributions[0]!,
      ]),
    ).toThrow('duplicate table')
  })
})
