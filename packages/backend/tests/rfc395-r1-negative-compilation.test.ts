// RFC-395 II-b R1: malformed target contracts must be rejected by both native compilers before DDL exists.
import { expect, test } from 'bun:test'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { type SchemaRegistry, createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { compileContract } from '@/platform/persistence/schema/contract'
import { compileSqlitePlan } from '@/platform/persistence/schema/sqlitePlan'
import { compilePostgresqlPlan } from '@/platform/persistence/schema/postgresqlPlan'
import {
  column as c,
  defineContribution,
  retention,
  index,
} from '@/platform/persistence/schema/dsl'

type Mutable = Record<string, unknown> & { columns: Record<string, Record<string, unknown>> }
function changed(change: (table: Mutable) => void): SchemaRegistry {
  const copy = structuredClone(persistenceSchema)
  const table = copy.tables.find((table) => table.id === 'users')! as unknown as Mutable
  change(table)
  return copy
}
const cases: readonly [string, (table: Mutable) => void, string][] = [
  [
    'missing owner',
    (table) => {
      table.owner = ''
    },
    'owner',
  ],
  [
    'missing codec',
    (table) => {
      delete table.columns.id!.codec
    },
    'codec',
  ],
  [
    'untyped trigger',
    (table) => {
      table.triggers = ['CREATE TRIGGER arbitrary']
    },
    'untyped triggers',
  ],
  [
    'untyped row rule',
    (table) => {
      table.rowRules = [{ kind: 'sql', errorCode: 'bad' }]
    },
    'untyped row rule',
  ],
  [
    'raw row predicate',
    (table) => {
      table.rowRules = [
        {
          kind: 'immutableOnceSet',
          columns: ['id'],
          errorCode: 'bad',
          when: { kind: 'raw', reason: 'not a typed rule', sqlite: '1', postgresql: 'TRUE' },
        },
      ]
    },
    'untyped row rule',
  ],
  [
    'nullable column unique without NULL semantics',
    (table) => {
      delete table.columns.email!.uniqueNulls
    },
    'NULL semantics',
  ],
  [
    'unique constraint without NULL semantics',
    (table) => {
      table.unique = [{ name: 'bad', columns: ['email'] }]
    },
    'NULL semantics',
  ],
  [
    'unique index without NULL semantics',
    (table) => {
      table.indexes = [
        { name: 'bad', unique: true, columns: [{ kind: 'column', name: 'email' }], where: null },
      ]
    },
    'NULL semantics',
  ],
  [
    'jsonDoc destroys digest-preserving bytes',
    (table) => {
      table.columns.email!.codec = 'jsonDoc'
      table.columns.email!.originalTextDigest = true
    },
    'original-text digest',
  ],
  [
    'identity without high-water policy',
    (table) => {
      table.columns.id!.codec = 'identity'
    },
    'high-water policy',
  ],
  [
    'seq without high-water policy',
    (table) => {
      table.columns.id!.codec = 'seq'
    },
    'high-water policy',
  ],
  [
    'missing FK target',
    (table) => {
      table.foreignKeys = [
        {
          name: 'bad',
          columns: ['id'],
          foreignTable: 'missing',
          foreignColumns: ['id'],
          onDelete: 'no action',
          onUpdate: 'no action',
          lifecycle: 'retained reference',
        },
      ]
    },
    'missing logical FK target',
  ],
]
for (const [name, change, message] of cases)
  test(name, () => {
    for (const compile of [compileContract, compileSqlitePlan, compilePostgresqlPlan])
      expect(() => compile(changed(change)), name).toThrow(message)
  })
test('NULLS NOT DISTINCT and partial indexes compile natively; epoch contributes to identity', () => {
  const owner = defineContribution('example')
  const table = owner.table({
    id: 'examples',
    schemaSymbol: 'examples',
    retention: retention.business,
    columns: { id: c.id('id', { primary: true }), value: c.text('value', { nullable: true }) },
    unique: [{ name: 'unique_null_value', columns: ['value'], nulls: 'not-distinct' }],
    indexes: [
      index('partial', ['value'], {
        unique: true,
        nulls: 'distinct',
        where: { kind: 'unary', op: 'IS NOT NULL', value: { kind: 'column', name: 'value' } },
      }),
    ],
  })
  const target = createSchemaRegistry([owner.contribution([table])], { schemaEpoch: 2 })
  expect(
    compilePostgresqlPlan(target).statements.some((statement) =>
      statement.sql.includes('UNIQUE NULLS NOT DISTINCT'),
    ),
  ).toBe(true)
  expect(
    compileSqlitePlan(target).statements.some((statement) =>
      statement.sql.includes(`("value" IS NULL), COALESCE("value", '')`),
    ),
  ).toBe(true)
  expect(compileContract(target).digest).not.toBe(
    compileContract(createSchemaRegistry(target.contributions)).digest,
  )
})

test('owner NULL declarations preserve retained definitions and reject missing or duplicate columns', () => {
  const owner = defineContribution('retained-example')
  const table = owner.table({
    id: 'retained',
    schemaSymbol: 'retained',
    retention: retention.business,
    columns: {
      id: c.id('id', { primary: true }),
      optional: c.text('optional', { nullable: true, unique: 'retained_optional' }),
    },
  })
  const source = owner.contribution([table])
  const rule = { table: 'retained', column: 'optional', nulls: 'distinct' as const }
  const registry = createSchemaRegistry([{ ...source, columnUniqueNulls: [rule] }], {
    schemaEpoch: 2,
  })
  expect(registry.tables[0]).toBe(table)
  expect(compileContract(registry).tables[0]?.columns.optional?.uniqueNulls).toBe('distinct')
  for (const rules of [
    [{ ...rule, table: 'missing' }],
    [{ ...rule, column: 'missing' }],
    [rule, rule],
  ])
    expect(() =>
      createSchemaRegistry([{ ...source, columnUniqueNulls: rules }], { schemaEpoch: 2 }),
    ).toThrow('column unique NULL semantics')
})

test('an explicit invalid epoch cannot silently become epoch 1', () => {
  for (const schemaEpoch of [0, -1, 1.5, Number.NaN])
    expect(() => createSchemaRegistry([], { schemaEpoch })).toThrow('invalid schema epoch')
})

test('DSL unique indexes over nullable columns require an explicit NULL policy in epoch 2', () => {
  const owner = defineContribution('fixture')
  const table = owner.table({
    id: 'indexed_nulls',
    schemaSymbol: 'indexedNulls',
    retention: retention.business,
    columns: { id: c.id('id', { primary: true }), value: c.text('value', { nullable: true }) },
    indexes: [index('indexed_nulls_value', ['value'], { unique: true })],
  })
  expect(() => createSchemaRegistry([owner.contribution([table])], { schemaEpoch: 2 })).toThrow(
    'explicit NULL semantics',
  )
  expect(() => createSchemaRegistry([owner.contribution([table])])).not.toThrow()
  const declared = {
    ...table,
    indexes: [index('indexed_nulls_value', ['value'], { unique: true, nulls: 'distinct' })],
  }
  expect(() =>
    createSchemaRegistry([owner.contribution([declared])], { schemaEpoch: 2 }),
  ).not.toThrow()
})
