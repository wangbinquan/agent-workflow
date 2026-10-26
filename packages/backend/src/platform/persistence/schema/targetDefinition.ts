// Shared schema expressions and NULL-semantics metadata; migration lookup stays explicit.
import type { SchemaContribution, TableDefinition } from './contribution'
import type { SchemaExpression } from './expressions'
import type { SchemaRegistry } from './registry'

export function definitionOf<
  const C extends SchemaContribution,
  const I extends C['tables'][number]['id'],
>(contribution: C, id: I): Extract<C['tables'][number], { readonly id: I }> {
  const table = contribution.tables.find((table) => table.id === id)
  if (!table) throw new Error(`RFC-395 missing source definition: ${id}`)
  return table as Extract<C['tables'][number], { readonly id: I }>
}
/** Explicit expression constructors for new constraints and indexes. */
export const expr = {
  column: (name: string): SchemaExpression => ({ kind: 'column', name }),
  value: (value: string | number | boolean | null): SchemaExpression => ({
    kind: 'literal',
    value,
  }),
  binary: (
    op: Extract<SchemaExpression, { kind: 'binary' }>['op'],
    left: SchemaExpression,
    right: SchemaExpression,
  ): SchemaExpression => ({ kind: 'binary', op, left, right }),
  isNull: (name: string): SchemaExpression => ({
    kind: 'unary',
    op: 'IS NULL',
    value: { kind: 'column', name },
  }),
  isNotNull: (name: string): SchemaExpression => ({
    kind: 'unary',
    op: 'IS NOT NULL',
    value: { kind: 'column', name },
  }),
}

/** Compile owner-declared NULL semantics; the contribution retains the original table identity. */
export function resolveColumnUniqueNulls<D extends TableDefinition>(
  registry: SchemaRegistry,
  table: D,
): D {
  const rules = registry.contributions
    .flatMap((contribution) =>
      contribution.owner === table.owner ? (contribution.columnUniqueNulls ?? []) : [],
    )
    .filter((rule) => rule.table === table.id)
  const indexRules = registry.contributions
    .flatMap((contribution) =>
      contribution.owner === table.owner ? (contribution.indexUniqueNulls ?? []) : [],
    )
    .filter((rule) => rule.table === table.id)
  if (!rules.length && !indexRules.length) return table
  return {
    ...table,
    indexes: table.indexes.map((index) => {
      const rule = indexRules.find((rule) => rule.index === index.name)
      return rule ? { ...index, nulls: rule.nulls } : index
    }),
    columns: Object.fromEntries(
      Object.entries(table.columns).map(([property, column]) => {
        const rule = rules.find((rule) => rule.column === column.name)
        return [property, rule ? { ...column, uniqueNulls: rule.nulls } : column]
      }),
    ),
  } as D
}
