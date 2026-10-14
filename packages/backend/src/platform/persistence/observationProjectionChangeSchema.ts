// FROZEN HISTORY — RFC-371 v1 schema projection, retired by RFC-371 v2
// (design/RFC-371-run-observability/redesign-v2-20261014.md §7). The immutable
// PostgreSQL migration chain (steps 0017–0031) replays plans built from this
// code, so it must stay byte-stable; no live table carries these projections and
// no new caller may use it.
import { sha256Hex } from '@/util/hash'
import { OBSERVATION_SOURCE_REVISION } from './observationSourceRevisionSchema'
import type { LogicalSchemaContract, LogicalTableContract } from './schemaContract'
import type { PostgresqlSchemaStatement } from './postgresqlSchema'
import { observationDocumentRouteSQL } from './observationProjectionRoutes'
import { unhandledDatabaseProvider, type DatabaseProvider } from './databaseProviders'

const OUTBOX = 'observation_projection_changes'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const objectName = (source: string) =>
  `obs_delta_${source.slice(0, 28)}_${sha256Hex(source).slice(0, 12)}`

function routeColumns(table: LogicalTableContract) {
  const ids = new Set([...table.primaryKey, ...table.foreignKeys.flatMap((key) => key.columns)])
  return table.columns.filter(
    (column) =>
      ids.has(column.name) ||
      /(^|_)(source|root|session|task|invocation|node_run|record|owner|pass|group|agent|runtime|user)(_|$)/.test(
        column.name,
      ),
  )
}
function jsonObject(
  table: LogicalTableContract,
  row: 'OLD' | 'NEW',
  provider: DatabaseProvider,
  primary = false,
) {
  const columns = primary ? table.primaryKey : routeColumns(table).map((column) => column.name)
  const fields = [
    ...columns.flatMap((column) => [literal(column), `CAST(${row}.${quote(column)} AS TEXT)`]),
    ...(primary
      ? []
      : observationDocumentRouteSQL(table.id, row, provider).flatMap(({ name, expression }) => [
          literal(name),
          expression,
        ])),
  ].join(',')
  if (provider === 'sqlite') return `json_object(${fields})`
  if (provider === 'postgresql') return `json_build_object(${fields})::text`
  return unhandledDatabaseProvider(provider)
}

/** Capture routing identities, not another copy of numeric authority. Existing
 * original source revision SQL is unchanged; the derived relations never have
 * these triggers and cannot create an observation feedback loop. */
export function observationProjectionChangeStatements(contract: LogicalSchemaContract): {
  readonly sqlite: readonly string[]
  readonly postgresql: readonly PostgresqlSchemaStatement[]
} {
  if (!contract.tables.some((table) => table.id === OUTBOX)) return { sqlite: [], postgresql: [] }
  const relation = (id: string) => {
    const table = contract.tables.find((table) => table.id === id)
    if (
      !table ||
      table.disposition !== 'KEEP' ||
      !table.providerTables.sqlite ||
      !table.providerTables.postgresql
    )
      throw new Error('Observation change capture requires its complete original relation: ' + id)
    return table
  }
  const target = relation(OUTBOX)
  const sqliteTarget = quote(target.providerTables.sqlite!),
    postgresTarget = '"agent_workflow".' + quote(target.providerTables.postgresql!)
  const sqlite: string[] = [],
    postgresql: PostgresqlSchemaStatement[] = []
  for (const id of OBSERVATION_SOURCE_REVISION.sources) {
    const table = relation(id),
      name = objectName(id)
    for (const event of ['insert', 'update', 'delete'] as const) {
      const row = event === 'delete' ? 'OLD' : 'NEW'
      const previous = event === 'insert' ? 'NULL' : jsonObject(table, 'OLD', 'sqlite')
      const next = event === 'delete' ? 'NULL' : jsonObject(table, 'NEW', 'sqlite')
      sqlite.push(`CREATE TRIGGER ${quote(name + '_' + event)} AFTER ${event.toUpperCase()} ON ${quote(table.providerTables.sqlite!)} BEGIN
INSERT INTO ${sqliteTarget} ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (lower(hex(randomblob(16))),${literal(id)},${jsonObject(table, row, 'sqlite', true)},${literal(event)},${previous},${next},CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),0);
END`)
    }
    const oldKey = jsonObject(table, 'OLD', 'postgresql', true),
      newKey = jsonObject(table, 'NEW', 'postgresql', true)
    postgresql.push(
      {
        kind: 'function',
        logicalId: OUTBOX + ':' + id,
        sql: `CREATE FUNCTION "agent_workflow".${quote(name)}() RETURNS trigger LANGUAGE plpgsql AS $aw_observation_delta$
BEGIN
INSERT INTO ${postgresTarget} ("id","source","entity_key","operation","previous_route","next_route","created_at","completed") VALUES (gen_random_uuid()::text,${literal(id)},CASE WHEN TG_OP='DELETE' THEN ${oldKey} ELSE ${newKey} END,lower(TG_OP),CASE WHEN TG_OP='INSERT' THEN NULL ELSE ${jsonObject(table, 'OLD', 'postgresql')} END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE ${jsonObject(table, 'NEW', 'postgresql')} END,floor(extract(epoch from clock_timestamp())*1000)::bigint,false);
RETURN NULL;
END;
$aw_observation_delta$`,
      },
      {
        kind: 'trigger',
        logicalId: id + ':observation-change',
        sql: `CREATE TRIGGER ${quote(name)} AFTER INSERT OR UPDATE OR DELETE ON "agent_workflow".${quote(table.providerTables.postgresql!)} FOR EACH ROW EXECUTE FUNCTION "agent_workflow".${quote(name)}()`,
      },
    )
  }
  return { sqlite, postgresql }
}
