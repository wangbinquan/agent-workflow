// RFC-395 II-b V1: business rows, archives and migration records have distinct destinations.
import tableDecisions from './epoch1/tableDispositions.json'
import { digestSchemaContract } from '../schema/canonical'
import type { LogicalSchemaContract } from '../schema/contractTypes'
import type { SourceFingerprint, SourceTableDisposition, SourceDestination } from './sourceTypes'

export const sourceMetadataTables = [
  '__drizzle_migrations',
  'sqlite_sequence',
  'sqlite_stat1',
  'sqlite_stat4',
  'agent_workflow_meta.schema_migrations',
  'agent_workflow_meta.schema_contract',
  'agent_workflow_meta.logical_copy_operations',
  'agent_workflow_meta.logical_copy_chunks',
  'agent_workflow_meta.database_generations',
  'database_generations',
  'logical_copy_operations',
  'logical_copy_chunks',
] as const
export interface EmptyTableDecision {
  readonly table: string
  readonly catalogDigest: string
  readonly disposition: 'archived'
  readonly reason: string
}
export function sourceTableCatalog(source: SourceFingerprint, table: string) {
  const sequences = source.catalog
    .filter((entry) => entry.kind === 'sequence-owner' && entry.definition.startsWith(`${table}.`))
    .map((entry) => entry.relation)
  return source.catalog.filter(
    (entry) => entry.relation === table || sequences.includes(entry.relation),
  )
}
export function tableCatalogDigest(source: SourceFingerprint, table: string): string {
  return digestSchemaContract(sourceTableCatalog(source, table))
}
export function sourceTableDispositions(input: {
  readonly source: SourceFingerprint
  readonly contract: LogicalSchemaContract | null
  readonly knownTables?: readonly string[]
  readonly archivedTables?: readonly string[]
  readonly emptyTables?: readonly EmptyTableDecision[]
}): readonly SourceTableDisposition[] {
  const knownTables = new Set(input.knownTables)
  const declared = new Map(tableDecisions.map((table) => [table.table, table]))
  return Object.entries(input.source.tableRows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([physicalTable, rows]): SourceTableDisposition => {
      const table = physicalTable.replace(/^agent_workflow(?:_meta)?\./, '')
      const base = { table, physicalTable, rows }
      if ((sourceMetadataTables as readonly string[]).includes(physicalTable))
        return {
          ...base,
          disposition: 'metadata',
          destination: {
            kind: 'migration-records',
            records:
              table === 'sqlite_sequence'
                ? ['identity']
                : table === 'database_generations'
                  ? ['activation']
                  : ['migration'],
          },
          reason:
            'generalised into migration / activation records; never copied into a target provider journal',
        }
      const known =
        knownTables.has(physicalTable) || input.contract?.tables.some((item) => item.id === table)
      if (known) {
        const decision = declared.get(table)
        if (!decision || input.archivedTables?.includes(table))
          return {
            ...base,
            disposition: 'archived',
            destination: { kind: 'archive' },
            reason: 'frozen historical table: archive pre-upgrade rows before the chain removes it',
          }
        return {
          ...base,
          disposition: decision.disposition as SourceTableDisposition['disposition'],
          destination: decision.destination as SourceDestination,
          reason: decision.basis,
        }
      }
      const decision = input.emptyTables?.find(
        (item) =>
          (item.table === physicalTable || item.table === table) &&
          item.catalogDigest === tableCatalogDigest(input.source, physicalTable) &&
          item.disposition === 'archived' &&
          item.reason.trim(),
      )
      if (rows === 0 && decision)
        return {
          ...base,
          disposition: 'archived',
          destination: { kind: 'archive' },
          reason: decision.reason,
        }
      return {
        ...base,
        disposition: 'blocked',
        destination: { kind: 'blocked' },
        reason:
          rows > 0
            ? 'unknown non-empty table'
            : 'unknown empty table requires an explicit schema-bound archive decision',
      }
    })
}
