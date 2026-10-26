// Runtime logical export contract, derived from the live declarations without frozen name heuristics.
import { CODECS, type CodecName } from './codecs'
import { digestSchemaContract } from './canonical'
import { renderSchemaExpression } from './expressions'
import { validateSchemaRegistry, type SchemaRegistry } from './registry'
import type {
  LogicalCodec,
  LogicalSchemaContract,
  LogicalTableContract,
  OwnerContext,
} from './contractTypes'

const logicalCodecs = {
  id: 'text-identity',
  text: 'text',
  enum: 'text',
  bool: 'boolean',
  int: 'integer',
  bigint: 'integer',
  epochMs: 'epoch-milliseconds',
  durationMs: 'integer',
  real: 'real',
  jsonText: 'json-text',
  jsonDoc: 'json-text',
  rawJson: 'text',
  bytes: 'opaque-bytes',
  seq: 'integer',
  identity: 'integer',
  slotKey: 'text-identity',
} as const satisfies Record<CodecName, LogicalCodec>

export function projectLogicalSchemaContract(registry: SchemaRegistry): LogicalSchemaContract {
  validateSchemaRegistry(registry)
  if (registry.schemaEpoch !== 2) throw new Error('live-logical-contract-requires-epoch-2')
  const tables: LogicalTableContract[] = registry.tables.map((table) => {
    const ownerContext = table.owner as OwnerContext
    return {
      id: table.id,
      schemaSymbol: table.schemaSymbol,
      ownerContext,
      disposition: table.migrationPolicy,
      sourceTable: table.id,
      providerTables: { sqlite: table.id, postgresql: table.id },
      migrationKey: table.migrationKey,
      primaryKey: table.primaryKey,
      columns: Object.values(table.columns).map((column) => {
        const value = column.default
        const expression =
          value.kind === 'literal'
            ? { kind: 'literal' as const, value: value.value }
            : value.kind === 'expression'
              ? value.expression
              : null
        return {
          name: column.name,
          logicalCodec: logicalCodecs[column.codec],
          nullable: column.nullable,
          primary: table.primaryKey.includes(column.name),
          hasDefault: value.kind !== 'none',
          defaultKind: value.kind === 'expression' ? ('database-expression' as const) : value.kind,
          defaultValue: expression === null ? null : renderSchemaExpression(expression, 'sqlite'),
          providerDefault: {
            sqlite: expression === null ? null : renderSchemaExpression(expression, 'sqlite'),
            postgresql:
              expression === null ? null : renderSchemaExpression(expression, 'postgresql'),
          },
          identity: column.codec === 'identity',
          uniqueName: column.unique ?? null,
          enumValues: column.enumValues ?? [],
          providerType: CODECS[column.codec],
        }
      }),
      unique: table.unique.map((entry) => ({ ...entry, expression: null })),
      foreignKeys: table.foreignKeys,
      checks: table.checks.map((entry) => ({
        name: entry.name,
        columns: [],
        expression: renderSchemaExpression(entry.expression, 'sqlite'),
      })),
      indexes: table.indexes.map((entry) => ({
        name: entry.name,
        unique: entry.unique,
        columns: entry.columns.map((column) => renderSchemaExpression(column, 'sqlite')),
        where: entry.where === null ? null : renderSchemaExpression(entry.where, 'sqlite'),
      })),
      retention: { ...table.retention, owner: ownerContext },
      consumers: {
        productionReader: 'owner-required',
        productionWriter: 'owner-required-or-immutable',
        backgroundRecoveryDiagnostic: 'owner-reviewed',
        evidence: 'Live epoch-2 schema contribution',
      },
      rationale: 'Live epoch-2 schema contribution',
    }
  })
  const payload = {
    contractVersion: 2,
    schemaEpoch: 2,
    sourceProjection: 'sqlite' as const,
    sourceTableCount: tables.length,
    activeTableCount: tables.length,
    archiveOnlyTableCount: 0,
    tables,
  }
  return Object.freeze({ ...payload, digest: digestSchemaContract(payload) })
}
