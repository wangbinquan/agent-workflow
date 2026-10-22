// RFC-395 I-a: the concise DSL preserves literal types and expands every structural and codec default.
import { describe, expect, test } from 'bun:test'
import { CODECS } from '@/platform/persistence/schema/codecs'
import {
  column as c,
  defineContribution,
  foreignKey,
  index,
  raw,
  retention,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import { renderSchemaExpression } from '@/platform/persistence/schema/expressions'

const owner = defineContribution('example')
const definition = owner.table({
  id: 'examples',
  schemaSymbol: 'examples',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    status: c.enum('status', ['ready', 'done'], { default: 'ready' }),
    note: c.text('note', { nullable: true }),
  },
})
const table = materializeDrizzle(definition).table
// These assignments exercise the same inferred select/insert types used by application importers.
const insert: typeof table.$inferInsert = { id: 'one' }
const selected: typeof table.$inferSelect = { id: 'one', status: 'done', note: null }
const status: 'ready' | 'done' = selected.status

describe('RFC-395 I-a contribution DSL', () => {
  test('one builder per codec retains explicit semantics in the expanded column', () => {
    expect(Object.keys(c).sort()).toEqual(Object.keys(CODECS).sort())
    expect(c.id('id')).toEqual({
      name: 'id',
      codec: 'id',
      nullable: false,
      primary: false,
      default: { kind: 'none' },
    })
    expect(c.jsonText('document').originalTextDigest).toBe(true)
    expect(c.identity('sequence', { primary: true })).toEqual({
      name: 'sequence',
      codec: 'identity',
      nullable: false,
      primary: true,
      default: { kind: 'identity' },
      highWater: 'preserve-source-high-water',
    })
    expect(c.seq('sequence').highWater).toBe('preserve-source-high-water')
    expect(c.int('id', { primary: true }).default).toEqual({ kind: 'implicit-primary' })
    expect(c.bool('enabled', { default: false }).default).toEqual({ kind: 'literal', value: false })
    expect(c.text('label', { default: null }).default).toEqual({ kind: 'literal', value: null })
    expect(c.enum('state', ['ready', 'done']).enumValues).toEqual(['ready', 'done'])
    expect(c.jsonText('digest_input', { originalTextDigest: false }).originalTextDigest).toBe(false)
    expect(c.text('value', { unique: 'uq_value', sqliteUniqueName: 'legacy_uq' })).toMatchObject({
      unique: 'uq_value',
      sqliteUniqueName: 'legacy_uq',
    })
    expect([insert.id, status]).toEqual(['one', 'done'])
    expect(table.status.enumValues).toEqual(['ready', 'done'])
  })
  test('table defaults are explicit, and composite keys and migration policy can override them', () => {
    expect(definition).toMatchObject({
      owner: 'example',
      version: 1,
      primaryKey: ['id'],
      migrationKey: ['id'],
      migrationPolicy: 'KEEP',
      unique: [],
      foreignKeys: [],
      checks: [],
      indexes: [],
    })
    const composite = owner.table({
      ...definition,
      primaryKey: ['id', 'status'],
      migrationKey: ['id'],
      migrationPolicy: 'DEFER',
    })
    expect(composite.primaryKey).toEqual(['id', 'status'])
    expect(composite.migrationKey).toEqual(['id'])
    expect(composite.migrationPolicy).toBe('DEFER')
    expect(owner.contribution([definition])).toEqual({
      owner: 'example',
      version: 1,
      tables: [definition],
    })
  })
  test('indexes, references and raw defaults expand shared epoch-1 metadata without spelling changes', () => {
    const expression = raw('  lower("Name")  ')
    expect(renderSchemaExpression(expression, 'sqlite')).toBe('  lower("Name")  ')
    expect(renderSchemaExpression(expression, 'postgresql')).toBe('  lower("Name")  ')
    expect(c.text('name', { default: expression }).default).toEqual({
      kind: 'expression',
      expression,
    })
    expect(index('by_name', ['name', expression], { unique: true })).toEqual({
      name: 'by_name',
      unique: true,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'name' }, expression],
      where: null,
    })
    expect(index('by_name', ['name'], { where: expression }).where).toBe(expression)
    expect(foreignKey('owner_fk', ['owner_id'], 'owners', ['id'], { onDelete: 'cascade' })).toEqual(
      {
        name: 'owner_fk',
        columns: ['owner_id'],
        foreignTable: 'owners',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
        lifecycle:
          'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
      },
    )
    expect(
      foreignKey('owner_fk', ['owner_id'], 'owners', ['id'], {
        lifecycle: 'Retain owner reference.',
      }).lifecycle,
    ).toBe('Retain owner reference.')
    expect(renderSchemaExpression(raw('1', 'TRUE'), 'postgresql')).toBe('TRUE')
  })
})
