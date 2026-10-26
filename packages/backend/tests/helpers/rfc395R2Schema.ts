// RFC-395 II-b R2: synthetic registries keep history tests independent of R1's target roster.
import {
  column,
  defineContribution,
  foreignKey,
  index,
  retention,
} from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import type { InstallSeed } from '@/platform/persistence/schema/seeds'
import type { TableDefinition } from '@/platform/persistence/schema/contribution'
import type { SchemaExpression } from '@/platform/persistence/schema/expressions'

export const r2Owner = defineContribution('system-operations')
export const positive: SchemaExpression = {
  kind: 'binary',
  op: '>=',
  left: { kind: 'column', name: 'amount' },
  right: { kind: 'literal', value: 0 },
}
export const parentTable = r2Owner.table({
  id: 'r2_parents',
  schemaSymbol: 'r2Parents',
  retention: retention.business,
  columns: { id: column.id('id', { primary: true }), name: column.text('name') },
})
export const itemTable = r2Owner.table({
  id: 'r2_items',
  schemaSymbol: 'r2Items',
  retention: retention.business,
  columns: {
    id: column.id('id', { primary: true }),
    parentId: column.id('parent_id', { nullable: true }),
    amount: column.int('amount', { default: 0 }),
    label: column.text('label', { default: 'Ready' }),
  },
  checks: [{ name: 'r2_amount_check', expression: positive }],
  foreignKeys: [
    foreignKey('r2_parent_fk', ['parent_id'], 'r2_parents', ['id'], { onDelete: 'cascade' }),
  ],
  indexes: [index('r2_label_idx', ['label'])],
})
export function r2Registry(
  tables: readonly TableDefinition[] = [parentTable, itemTable],
  seeds?: readonly InstallSeed[],
) {
  const owners = [...new Set(tables.map((table) => table.owner))]
  return createSchemaRegistry(
    owners.map((owner) => ({
      owner,
      version: 1,
      tables: tables.filter((table) => table.owner === owner),
      ...(seeds
        ? {
            seeds: seeds.filter((seed) =>
              tables.some((table) => table.owner === owner && table.id === seed.table),
            ),
          }
        : {}),
    })),
    { schemaEpoch: 2 },
  )
}
