// FROZEN HISTORY — RFC-371 v1 schema projection, retired by RFC-371 v2
// (design/RFC-371-run-observability/redesign-v2-20261014.md §7). The immutable
// PostgreSQL migration chain (steps 0017–0031) replays plans built from this
// code, so it must stay byte-stable; no live table carries these projections and
// no new caller may use it.
// RFC-371: exact application source revisions; derived report/cache writes are excluded.
import { isDeepStrictEqual } from 'node:util'
import type { PostgresqlSchemaStatement } from './postgresqlSchema'
import type { LogicalSchemaContract } from './schemaContract'
import { sha256Hex } from '@/util/hash'
import { unhandledDatabaseProvider, type DatabaseProvider } from './databaseProviders'

export const OBSERVATION_SOURCE_REVISION = {
  kind: 'observation-source-revision',
  sourceColumn: 'source_id',
  revisionColumn: 'revision',
  sources: [
    'agents',
    'intent_sessions',
    'intent_turn_events',
    'intent_turns',
    'mcp_runtime_test_events',
    'mcp_runtime_test_sessions',
    'mcp_runtime_test_turns',
    'memory_distill_events',
    'memory_distill_jobs',
    'node_run_events',
    'node_runs',
    'observation_invocations',
    'observation_platform_records',
    'observation_platform_sources',
    'observation_price_heads',
    'observation_price_versions',
    'observation_usage_captures',
    'observation_usage_current',
    'observation_usage_events',
    'observation_usage_native_records',
    'observation_usage_sources',
    'system_agent_native_usage_emissions',
    'system_agent_native_usage_pass_heads',
    'system_agent_native_usage_pass_pages',
    'system_agent_native_usage_passes',
    'system_agent_native_usage_preparations',
    'system_agent_native_usage_revision_heads',
    'system_agent_native_usage_root_heads',
    'system_agent_native_usage_root_results',
    'system_agent_native_usage_root_sets',
    'system_agent_native_usage_root_transitions',
    'system_agent_native_usage_session_parents',
    'system_agent_native_usage_step_members',
    'system_agent_native_usage_store_bindings',
    'system_agent_observation_groups',
    'system_agent_observation_owners',
    'system_agent_observation_sources',
    'task_collaborators',
    'task_execution_native_usage_emissions',
    'task_execution_native_usage_pass_heads',
    'task_execution_native_usage_pass_pages',
    'task_execution_native_usage_passes',
    'task_execution_native_usage_preparations',
    'task_execution_native_usage_revision_heads',
    'task_execution_native_usage_root_heads',
    'task_execution_native_usage_root_results',
    'task_execution_native_usage_root_sets',
    'task_execution_native_usage_root_transitions',
    'task_execution_native_usage_session_parents',
    'task_execution_native_usage_step_members',
    'task_execution_native_usage_store_bindings',
    'task_execution_observation_sources',
    'task_repos',
    'tasks',
    'users',
  ],
} as const
/** V2 uses the committed row journal for cache invalidation. Producers append
 * independent rows; only the background acknowledgement moves the base clock. */
export const OBSERVATION_SOURCE_REVISION_JOURNAL = {
  ...OBSERVATION_SOURCE_REVISION,
  changeJournal: 'observation_projection_changes',
} as const
export type ObservationSourceRevisionContract = Omit<
  typeof OBSERVATION_SOURCE_REVISION,
  'sources'
> & {
  readonly sources: readonly string[]
  readonly changeJournal?: 'observation_projection_changes'
}
const TABLE = 'observation_source_revisions'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const events = ['insert', 'update', 'delete'] as const
const objectName = (source: string, event: (typeof events)[number]) =>
  `obs_src_${source.slice(0, 28)}_${sha256Hex(source).slice(0, 12)}_${event}`

/** Both providers project from the same logical descriptor, never from another provider's SQL. */
export function observationSourceRevisionStatements(contract: LogicalSchemaContract): {
  readonly sqlite: readonly string[]
  readonly postgresql: readonly PostgresqlSchemaStatement[]
} {
  const revisions = contract.tables.filter((table) => table.sourceRevisionProjection !== undefined)
  if (revisions.length === 0) return { sqlite: [], postgresql: [] }
  if (
    revisions.length !== 1 ||
    revisions[0]!.id !== TABLE ||
    (!isDeepStrictEqual(revisions[0]!.sourceRevisionProjection, OBSERVATION_SOURCE_REVISION) &&
      !isDeepStrictEqual(
        revisions[0]!.sourceRevisionProjection,
        OBSERVATION_SOURCE_REVISION_JOURNAL,
      ))
  )
    throw new Error('Unsupported observation-source-revision schema projection')
  const journal = revisions[0]!.sourceRevisionProjection!.changeJournal !== undefined
  if (
    journal &&
    !contract.tables.some(
      (table) =>
        table.id === 'observation_projection_changes' &&
        table.disposition === 'KEEP' &&
        table.providerTables.sqlite &&
        table.providerTables.postgresql,
    )
  )
    throw new Error('Journal source revision requires its complete original change relation')
  const physical = (id: string, provider: DatabaseProvider) => {
    const table = contract.tables.find((table) => table.id === id)
    const name = table?.providerTables[provider]
    if (!table || table.disposition !== 'KEEP' || !name)
      throw new Error('Observation source revision requires its complete KEEP relation: ' + id)
    if (provider === 'sqlite') return quote(name)
    if (provider === 'postgresql') return '"agent_workflow".' + quote(name)
    return unhandledDatabaseProvider(provider)
  }
  const sqliteTarget = physical(TABLE, 'sqlite'),
    postgresTarget = physical(TABLE, 'postgresql')
  const sqlite: string[] = [
    `INSERT INTO ${sqliteTarget} ("source_id","revision") VALUES ${OBSERVATION_SOURCE_REVISION.sources.map((source) => `('${source}',lower(hex(randomblob(16))))`).join(',')}`,
  ]
  const postgresql: PostgresqlSchemaStatement[] = [
    {
      kind: 'metadata',
      logicalId: TABLE + ':initial-revisions',
      sql: `INSERT INTO ${postgresTarget} ("source_id","revision") VALUES ${OBSERVATION_SOURCE_REVISION.sources.map((source) => `('${source}',gen_random_uuid()::text)`).join(',')}`,
    },
  ]
  for (const source of OBSERVATION_SOURCE_REVISION.sources) {
    const sqliteSource = physical(source, 'sqlite'),
      postgresSource = physical(source, 'postgresql')
    for (const event of events) {
      sqlite.push(`CREATE TRIGGER ${quote(objectName(source, event))} AFTER ${event.toUpperCase()} ON ${sqliteSource} BEGIN
INSERT INTO ${sqliteTarget} ("source_id","revision") VALUES ('${source}',lower(hex(randomblob(16)))) ON CONFLICT ("source_id") DO UPDATE SET "revision"=excluded."revision";
END`)
      const transition = event === 'delete' ? 'aw_old_rows' : 'aw_new_rows',
        functionName = objectName(source, event)
      postgresql.push(
        {
          kind: 'function',
          logicalId: TABLE + ':' + source + ':' + event,
          sql: journal
            ? `CREATE FUNCTION "agent_workflow".${quote(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  -- Original changes are appended by the independent row journal in this transaction.
  -- Updating a shared source clock here would serialize otherwise independent producers.
  RETURN NULL;
END;
$aw_source$`
            : `CREATE FUNCTION "agent_workflow".${quote(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $aw_source$
BEGIN
  IF EXISTS (SELECT 1 FROM ${transition}) THEN
    INSERT INTO ${postgresTarget} ("source_id","revision") VALUES ('${source}',gen_random_uuid()::text) ON CONFLICT ("source_id") DO UPDATE SET "revision"=EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$aw_source$`,
        },
        {
          kind: 'trigger',
          logicalId: source + ':observation-source:' + event,
          sql: `CREATE TRIGGER ${quote(objectName(source, event))} AFTER ${event.toUpperCase()} ON ${postgresSource} REFERENCING ${event === 'delete' ? 'OLD TABLE AS aw_old_rows' : 'NEW TABLE AS aw_new_rows'} FOR EACH STATEMENT EXECUTE FUNCTION "agent_workflow".${quote(functionName)}()`,
        },
      )
    }
  }
  return { sqlite, postgresql }
}
