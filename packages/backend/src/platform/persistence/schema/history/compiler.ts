// RFC-395: typed history orchestration; provider compilers own head and per-table DDL.
import { compileContract } from '../contract'
import { compileSqlitePlan, compileSqliteHistoryRebuild } from '../sqlitePlan'
import {
  compilePostgresqlPlan,
  compilePostgresqlHistoryAlter,
  dropPostgresqlSchemaStatement,
} from '../postgresqlPlan'
import type { SchemaRegistry } from '../registry'
import type { TableDefinition } from '../contribution'
import { quoteSchemaIdentifier as quote, renderSchemaExpression as render } from '../expressions'
import { digestSchemaContract } from '../canonical'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../../databaseProviders'
import { deriveSchemaEdge, sameSchemaValue } from './edgeDiff'
import {
  SchemaHistoryError,
  type CompiledContract,
  type HistoryStatement,
  type HistoryVersion,
  type HistoryPlanArtifact,
  type SchemaEdge,
} from './types'

function headStatements(
  registry: SchemaRegistry,
  provider: DatabaseProvider,
): readonly HistoryStatement[] {
  let plan
  switch (provider) {
    case 'sqlite':
      plan = compileSqlitePlan(registry)
      break
    case 'postgresql':
      plan = compilePostgresqlPlan(registry)
      break
    default:
      return unhandledDatabaseProvider(provider)
  }
  // Epoch-1 PG compiler still emits its old journals. R2 owns epoch-2 meta declarations.
  return plan.statements.filter((statement) => !['metadata', 'seed'].includes(statement.kind))
}
function tableName(provider: DatabaseProvider, name: string): string {
  switch (provider) {
    case 'sqlite':
      return quote(name)
    case 'postgresql':
      return `"agent_workflow".${quote(name)}`
    default:
      return unhandledDatabaseProvider(provider)
  }
}
function findTable(contract: CompiledContract, tableId: string): TableDefinition {
  const table = contract.tables.find((entry) => entry.id === tableId)
  if (!table) throw new SchemaHistoryError('table-missing', tableId)
  return table
}
function belongs(statement: HistoryStatement, tableId: string): boolean {
  return statement.logicalId === tableId || statement.logicalId.startsWith(`${tableId}:`)
}
function seedStatements(
  edge: Extract<SchemaEdge, { kind: 'seed-delta' }>,
  table: TableDefinition,
  provider: DatabaseProvider,
): string[] {
  const target = tableName(provider, table.id)
  const names = new Set(Object.values(table.columns).map((c) => c.name))
  const literal = (value: string | number | boolean | null) =>
    render({ kind: 'literal', value }, provider)
  const check = (
    row: Readonly<Record<string, string | number | boolean | null>>,
    keyOnly: boolean,
  ) => {
    if (
      table.primaryKey.some((name) => row[name] === undefined || row[name] === null) ||
      Object.keys(row).some(
        (name) => !names.has(name) || (keyOnly && !table.primaryKey.includes(name)),
      )
    )
      throw new SchemaHistoryError('seed-key', table.id)
  }
  return [
    ...edge.remove.map((row) => {
      check(row, true)
      return `DELETE FROM ${target} WHERE ${table.primaryKey.map((name) => `${quote(name)} = ${literal(row[name]!)}`).join(' AND ')}`
    }),
    ...edge.upsert.map((row) => {
      check(row, false)
      // An omitted declared seed cell resolves just like head installation, including UPDATE.
      const values = Object.fromEntries(
        Object.values(table.columns).map((column) => {
          const value = Object.hasOwn(row, column.name)
            ? row[column.name]
            : column.default.kind === 'literal'
              ? column.default.value
              : column.nullable
                ? null
                : undefined
          if (value === undefined)
            throw new SchemaHistoryError('seed-value', `${table.id}.${column.name}`)
          return [column.name, value]
        }),
      )
      const columns = Object.keys(values)
      const updates = columns.filter((name) => !table.primaryKey.includes(name))
      return `INSERT INTO ${target} (${columns.map(quote).join(', ')}) VALUES (${columns.map((name) => literal(values[name]!)).join(', ')}) ON CONFLICT (${table.primaryKey.map(quote).join(', ')}) ${updates.length ? `DO UPDATE SET ${updates.map((name) => `${quote(name)} = excluded.${quote(name)}`).join(', ')}` : 'DO NOTHING'}`
    }),
  ]
}
function edgeStatements(
  provider: DatabaseProvider,
  edge: SchemaEdge,
  before: CompiledContract,
  after: CompiledContract,
  previousHead: readonly HistoryStatement[],
  head: readonly HistoryStatement[],
): string[] {
  if (edge.kind === 'data-transform') return [...edge[provider]]
  if (edge.kind === 'owner-metadata') {
    if (!sameSchemaValue(previousHead, head))
      throw new SchemaHistoryError('owner-ddl', 'metadata edge changes physical DDL')
    return []
  }
  if (edge.kind === 'retire-table') {
    const drop = `DROP TABLE ${tableName(provider, edge.tableId)}`
    switch (provider) {
      case 'sqlite':
        return [drop]
      case 'postgresql':
        return [
          drop,
          ...previousHead
            .filter((s) => belongs(s, edge.tableId) && s.kind === 'function')
            .map(dropPostgresqlSchemaStatement),
        ]
      default:
        return unhandledDatabaseProvider(provider)
    }
  }
  const table = findTable(after, edge.tableId)
  if (edge.kind === 'seed-delta') return seedStatements(edge, table, provider)
  if (edge.kind === 'add-table') return head.filter((s) => belongs(s, table.id)).map((s) => s.sql)
  if (edge.kind === 'add-index') {
    const statement = head.find(
      (s) => s.kind === 'index' && s.logicalId === `${table.id}:index:${edge.name}`,
    )
    if (!statement) throw new SchemaHistoryError('index-plan-missing', edge.name)
    return [statement.sql]
  }
  const previous = findTable(before, table.id)
  switch (provider) {
    case 'sqlite':
      return compileSqliteHistoryRebuild(previous, table, head, edge)
    case 'postgresql':
      return compilePostgresqlHistoryAlter(previous, table, previousHead, head, edge)
    default:
      return unhandledDatabaseProvider(provider)
  }
}

export function createHistoryVersion(input: {
  readonly registry: SchemaRegistry
  readonly slug: string
  readonly previous?: HistoryVersion
  readonly edge?: SchemaEdge
}): HistoryVersion {
  if (input.registry.schemaEpoch !== 2)
    throw new SchemaHistoryError('schema-epoch', 'history requires an explicit epoch-2 registry')
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(input.slug))
    throw new SchemaHistoryError('slug', input.slug)
  const contract = compileContract(input.registry)
  const previous = input.previous
  if ((previous === undefined) !== (input.edge === undefined))
    throw new SchemaHistoryError('edge-required', 'baseline has no edge; successors require one')
  const edge =
    previous && input.edge
      ? deriveSchemaEdge(input.edge.kind, previous.contract.contract, contract, input.edge)
      : null
  if (input.edge && !sameSchemaValue(input.edge, edge))
    throw new SchemaHistoryError('edge-diff-mismatch', input.edge.kind)
  const version = previous ? previous.contract.version + 1 : 0
  const payload = {
    formatVersion: 1 as const,
    schemaEpoch: 2 as const,
    version,
    slug: input.slug,
    previousDigest: previous?.contract.digest ?? null,
    edge,
    contract,
  }
  const document = { ...payload, digest: digestSchemaContract(payload) }
  const plan = (provider: DatabaseProvider): HistoryPlanArtifact => {
    const head = headStatements(input.registry, provider)
    const statements =
      previous && edge
        ? edgeStatements(
            provider,
            edge,
            previous.contract.contract,
            contract,
            previous[provider].head,
            head,
          )
        : head.map((s) => s.sql)
    const value = {
      formatVersion: 1 as const,
      schemaEpoch: 2 as const,
      version,
      provider,
      contractDigest: contract.digest,
      head,
      statements,
    }
    return { ...value, digest: digestSchemaContract(value) }
  }
  // Snapshot input values: later registry edits cannot mutate an existing artifact.
  const snapshot = JSON.parse(
    JSON.stringify({ contract: document, sqlite: plan('sqlite'), postgresql: plan('postgresql') }),
  ) as HistoryVersion
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(snapshot)
  return snapshot
}
