// RFC-395 II-b R2: platform mechanism, system-operations ownership; V3 adds declarations here.
import { unhandledDatabaseProvider, type DatabaseProvider } from '../../databaseProviders'
import type { ColumnDefinition } from '../contribution'
import { column } from '../dsl'
import { CODECS } from '../codecs'
import { quoteSchemaIdentifier as quote, renderSchemaExpression as render } from '../expressions'

export interface MetaTableDeclaration {
  readonly name: string
  readonly owner: 'system-operations'
  readonly implementation: 'platform'
  readonly columns: Readonly<Record<string, ColumnDefinition>>
  readonly primaryKey: readonly string[]
}
export function defineMetaTable(
  input: Omit<MetaTableDeclaration, 'owner' | 'implementation'>,
): MetaTableDeclaration {
  return Object.freeze({ ...input, owner: 'system-operations', implementation: 'platform' })
}
export const schemaHistoryMeta = defineMetaTable({
  name: 'schema_history',
  columns: {
    version: column.int('version'),
    contractDigest: column.text('contract_digest'),
    sqlitePlanDigest: column.text('sqlite_plan_digest'),
    postgresqlPlanDigest: column.text('postgresql_plan_digest'),
    appliedAt: column.epochMs('applied_at'),
    artifactJson: column.jsonText('artifact_json'),
  },
  primaryKey: ['version'],
})
export const firstWriteMeta = defineMetaTable({
  name: 'first_write',
  columns: {
    generationId: column.id('generation_id'),
    firstLiveWriteAt: column.epochMs('first_live_write_at', { nullable: true }),
  },
  primaryKey: ['generation_id'],
})
export const transformReceiptMeta = defineMetaTable({
  name: 'schema_transform_receipts',
  columns: {
    receiptId: column.id('receipt_id'),
    edgeDigest: column.text('edge_digest'),
    appliedAt: column.epochMs('applied_at'),
  },
  primaryKey: ['receipt_id'],
})
export const HISTORY_META_TABLES = [
  schemaHistoryMeta,
  firstWriteMeta,
  transformReceiptMeta,
] as const

export function metaTableName(provider: DatabaseProvider, name: string): string {
  switch (provider) {
    case 'sqlite':
      return quote(`aw_meta_${name}`)
    case 'postgresql':
      return `${quote('agent_workflow_meta')}.${quote(name)}`
    default:
      return unhandledDatabaseProvider(provider)
  }
}
/** Explicit list, not a prefix exemption: unknown meta tables remain catalog drift. */
export function compileMetaTables(
  provider: DatabaseProvider,
  declarations: readonly MetaTableDeclaration[] = HISTORY_META_TABLES,
): readonly string[] {
  let namespace: readonly string[]
  switch (provider) {
    case 'sqlite':
      namespace = []
      break
    case 'postgresql':
      namespace = ['CREATE SCHEMA IF NOT EXISTS "agent_workflow_meta"']
      break
    default:
      return unhandledDatabaseProvider(provider)
  }
  return [
    ...namespace,
    ...declarations.map((table) => {
      const columns = Object.values(table.columns).map((c) => {
        const parts = [quote(c.name), CODECS[c.codec][provider].toUpperCase()]
        if (!c.nullable) parts.push('NOT NULL')
        if (c.default.kind === 'literal')
          parts.push(`DEFAULT ${render({ kind: 'literal', value: c.default.value }, provider)}`)
        if (c.default.kind === 'expression')
          parts.push(`DEFAULT (${render(c.default.expression, provider)})`)
        return parts.join(' ')
      })
      columns.push(`PRIMARY KEY (${table.primaryKey.map(quote).join(', ')})`)
      return `CREATE TABLE IF NOT EXISTS ${metaTableName(provider, table.name)} (${columns.join(', ')})`
    }),
  ]
}
