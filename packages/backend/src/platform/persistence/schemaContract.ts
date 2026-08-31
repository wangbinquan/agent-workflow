// RFC-349 — canonical logical schema contract.
//
// This is deliberately an exact roster instead of a prefix-only classifier:
// adding or removing a Drizzle table must update the contract in the same
// change. The SQLite declarations remain the source projection while the
// PostgreSQL projector and logical migration engine consume this provider-
// neutral manifest.

import { createHash } from 'node:crypto'
import { is, SQL } from 'drizzle-orm'
import {
  getTableConfig,
  SQLiteSyncDialect,
  SQLiteTable,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'
import * as sqliteSchema from '@/db/schema'
import { concreteDatabaseTable, renderPostgresqlDatabaseDefault } from '@/db/providerSchema'

export const RFC349_SCHEMA_CONTRACT_VERSION = 2

export const RFC349_SOURCE_TABLES = [
  'action_template_revisions',
  'action_templates',
  'agents',
  'auth_login_policy',
  'automation_policies',
  'automation_policy_revisions',
  'cached_repos',
  'capability_templates',
  'clarify_rounds',
  'code_ai_attempts',
  'code_artifacts',
  'code_findings',
  'code_fix_attempts',
  'code_host_connections',
  'code_mr_leases',
  'code_produced_mrs',
  'code_publish_intents',
  'code_round_stages',
  'code_trigger_deliveries',
  'code_work_items',
  'code_work_observations',
  'code_work_rounds',
  'collaboration_gate_artifacts',
  'collaboration_gate_operations',
  'committed_event_aggregate_heads',
  'committed_event_deliveries',
  'committed_event_family_cutovers',
  'committed_events',
  'custom_event_source_definitions',
  'custom_event_source_revisions',
  'development_action_runs',
  'development_adapter_definition_revisions',
  'development_adapter_definitions',
  'development_agent_attempts',
  'development_approval_sagas',
  'development_bundle_refs',
  'development_decisions',
  'development_deferred_wakes',
  'development_effects',
  'development_fact_snapshots',
  'development_feedback_ledger',
  'development_mission_links',
  'development_mission_sources',
  'development_missions',
  'development_mr_claims',
  'development_repository_upload_plan_entries',
  'development_repository_upload_plans',
  'development_repository_upload_receipts',
  'development_step_joins',
  'development_step_runs',
  'development_wake_hints',
  'digital_employee_revisions',
  'digital_employees',
  'doc_versions',
  'employee_approval_sagas',
  'employee_attention_bindings',
  'employee_case_event_origins',
  'employee_case_inbox',
  'employee_case_members',
  'employee_case_metering_receipts',
  'employee_case_workspaces',
  'employee_cases',
  'employee_change_candidates',
  'employee_channel_results',
  'employee_channels',
  'employee_context_links',
  'employee_context_records',
  'employee_context_revisions',
  'employee_definition_revisions',
  'employee_definitions',
  'employee_execution_policy_revisions',
  'employee_external_context_bindings',
  'employee_input_uploads',
  'employee_invocations',
  'employee_job_template_revisions',
  'employee_job_templates',
  'employee_os_outbox',
  'employee_os_settings',
  'employee_os_writer_state',
  'employee_reaction_rounds',
  'employee_round_workspace_states',
  'employee_tool_registration_revisions',
  'employee_tool_registrations',
  'employee_type_packages',
  'employee_work_scope_revisions',
  'event_deliveries',
  'event_observer_runs',
  'event_records',
  'event_response_rules',
  'event_sources',
  'event_subscriptions',
  'event_type_catalog',
  'fusions',
  'intent_apply_journal',
  'intent_draft_resolutions',
  'intent_drafts',
  'intent_provenance',
  'intent_sessions',
  'intent_turn_events',
  'intent_turns',
  'intent_working_set_changes',
  'legacy_code_work_item_links',
  'lifecycle_alerts',
  'lifecycle_repair_audit',
  'maintenance_runs',
  'maintenance_state',
  'mcp_probes',
  'mcp_runtime_test_create_receipts',
  'mcp_runtime_test_events',
  'mcp_runtime_test_session_leases',
  'mcp_runtime_test_sessions',
  'mcp_runtime_test_turns',
  'mcps',
  'memories',
  'memory_distill_events',
  'memory_distill_jobs',
  'memory_scope_move_events',
  'mission_input_uploads',
  'node_run_events',
  'node_run_outputs',
  'node_runs',
  'observer_activations',
  'oidc_providers',
  'plugins',
  'recovery_events',
  'repo_capability_config',
  'repo_group_nodes',
  'repo_groups',
  'repository_employee_assignments',
  'repository_transport_connections',
  'resource_bundle_applies',
  'resource_grants',
  'review_comments',
  'review_node_reviewers',
  'runtime_session_leases',
  'runtimes',
  'scheduled_tasks',
  'skill_operation_locks',
  'skill_operations',
  'skill_versions',
  'skills',
  'task_archive_audit',
  'task_collaborators',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_effects',
  'task_execution_intents',
  'task_execution_lineage_operation_records',
  'task_execution_maintenance_claims',
  'task_execution_maintenance_members',
  'task_execution_owners',
  'task_feedback',
  'task_node_clarify_directives',
  'task_questions',
  'task_repos',
  'task_space_nodes',
  'tasks',
  'token_audit',
  'token_delete_snapshot',
  'user_access_audit',
  'user_identities',
  'user_pats',
  'user_permission_grants',
  'user_repository_transport_credentials',
  'user_sessions',
  'users',
  'verification_profile_revisions',
  'verification_profiles',
  'webhook_deliveries',
  'webhook_endpoints',
  'webhook_mr_control_effects',
  'webhook_mr_control_targets',
  'webhook_mr_launch_guards',
  'webhook_mr_stream_states',
  'webhook_trigger_fires',
  'webhook_trigger_streams',
  'webhook_triggers',
  'workflows',
  'workgroup_assignments',
  'workgroup_member_cursors',
  'workgroup_members',
  'workgroup_messages',
  'workgroup_task_state',
  'workgroups',
] as const

export const RFC349_ARCHIVE_THEN_OMIT_TABLES = [
  'code_artifacts',
  'code_fix_attempts',
  'code_mr_leases',
  'code_produced_mrs',
  'code_publish_intents',
  'code_work_observations',
] as const

const RFC349_DEFER_TABLES = new Set<string>([
  'code_ai_attempts',
  'code_findings',
  'code_round_stages',
  'code_trigger_deliveries',
  'code_work_items',
  'code_work_rounds',
  'committed_event_family_cutovers',
  'employee_os_writer_state',
  'legacy_code_work_item_links',
])

const RFC349_ARCHIVE_TABLE_SET = new Set<string>(RFC349_ARCHIVE_THEN_OMIT_TABLES)

export type DatabaseProvider = 'sqlite' | 'postgresql'
export type TableDisposition = 'KEEP' | 'ARCHIVE_THEN_OMIT' | 'DEFER'
export type OwnerContext =
  | 'collaboration'
  | 'development-automation'
  | 'digital-employee'
  | 'event-center'
  | 'identity-access'
  | 'integration'
  | 'intent'
  | 'knowledge-evolution'
  | 'platform-events'
  | 'resource-catalog'
  | 'source-control'
  | 'system-operations'
  | 'task-execution'

export type LogicalCodec =
  | 'boolean'
  | 'epoch-milliseconds'
  | 'integer'
  | 'json-text'
  | 'opaque-bytes'
  | 'real'
  | 'text'
  | 'text-identity'

export interface LogicalColumnContract {
  readonly name: string
  readonly logicalCodec: LogicalCodec
  readonly nullable: boolean
  readonly primary: boolean
  readonly hasDefault: boolean
  readonly defaultKind:
    | 'none'
    | 'literal'
    | 'database-expression'
    | 'runtime'
    | 'identity'
    | 'implicit-primary'
  readonly defaultValue: string | null
  readonly providerDefault: { readonly sqlite: string | null; readonly postgresql: string | null }
  readonly identity: boolean
  readonly uniqueName: string | null
  readonly enumValues: readonly string[]
  readonly providerType: { readonly sqlite: string; readonly postgresql: string }
}

export interface LogicalForeignKeyContract {
  readonly name: string
  readonly columns: readonly string[]
  readonly foreignTable: string
  readonly foreignColumns: readonly string[]
  readonly onDelete: string
  readonly onUpdate: string
}

export interface LogicalIndexContract {
  readonly name: string
  readonly unique: boolean
  readonly columns: readonly string[]
  readonly where: string | null
}

export interface LogicalConstraintContract {
  readonly name: string
  readonly columns: readonly string[]
  readonly expression: string | null
}

export interface RetentionContract {
  readonly class: 'archive-only' | 'owner-managed-business' | 'owner-managed-operational'
  readonly owner: OwnerContext
  readonly rule: string
}

export interface ConsumerLedgerContract {
  readonly productionReader: 'zero-proved' | 'owner-required'
  readonly productionWriter: 'zero-proved' | 'owner-required-or-immutable'
  readonly backgroundRecoveryDiagnostic: 'zero-proved' | 'owner-reviewed'
  readonly evidence: string
}

export interface ArchiveContract {
  readonly format: 'agent-workflow-logical-table-v1'
  readonly stableOrder: readonly string[]
  readonly verifies: readonly ['row-count', 'key-bounds', 'chunk-digest', 'root-digest']
  readonly restoreIntoActiveSchema: false
  readonly approval: 'RFC-349-D9'
}

export interface LogicalTableContract {
  readonly id: string
  readonly schemaSymbol: string
  readonly ownerContext: OwnerContext
  readonly disposition: TableDisposition
  readonly sourceTable: string
  readonly providerTables: { readonly sqlite: string; readonly postgresql?: string }
  readonly migrationKey: readonly string[]
  readonly columns: readonly LogicalColumnContract[]
  readonly primaryKey: readonly string[]
  readonly unique: readonly LogicalConstraintContract[]
  readonly foreignKeys: readonly LogicalForeignKeyContract[]
  readonly checks: readonly LogicalConstraintContract[]
  readonly indexes: readonly LogicalIndexContract[]
  readonly retention: RetentionContract
  readonly consumers: ConsumerLedgerContract
  readonly archive?: ArchiveContract
  readonly rationale: string
}

export interface LogicalSchemaContract {
  readonly contractVersion: number
  readonly sourceProjection: 'sqlite'
  readonly sourceTableCount: number
  readonly activeTableCount: number
  readonly archiveOnlyTableCount: number
  readonly tables: readonly LogicalTableContract[]
  readonly digest: string
}

let cachedLogicalSchemaContract: LogicalSchemaContract | undefined

function ownerFor(table: string): OwnerContext {
  if (table.startsWith('development_') || table === 'mission_input_uploads') {
    return 'development-automation'
  }
  if (
    table.startsWith('employee_') ||
    table.startsWith('digital_employee_') ||
    table === 'digital_employees' ||
    table === 'digital_employee_revisions' ||
    table === 'repository_employee_assignments'
  ) {
    return 'digital-employee'
  }
  if (table.startsWith('intent_')) return 'intent'
  if (table === 'memories' || table.startsWith('memory_')) return 'knowledge-evolution'
  if (
    table.startsWith('event_') ||
    table.startsWith('custom_event_') ||
    table === 'observer_activations'
  ) {
    return 'event-center'
  }
  if (table.startsWith('committed_event_') || table === 'committed_events') {
    return 'platform-events'
  }
  if (
    table.startsWith('user_') ||
    table === 'users' ||
    table.startsWith('oidc_') ||
    table === 'auth_login_policy' ||
    table === 'resource_grants' ||
    table.startsWith('token_')
  ) {
    return 'identity-access'
  }
  if (
    table.startsWith('code_') ||
    table.startsWith('webhook_') ||
    table === 'legacy_code_work_item_links'
  ) {
    return 'integration'
  }
  if (
    table === 'cached_repos' ||
    table.startsWith('repo_') ||
    table.startsWith('repository_transport_')
  ) {
    return 'source-control'
  }
  if (
    table.startsWith('maintenance_') ||
    table.startsWith('lifecycle_') ||
    table === 'recovery_events'
  ) {
    return 'system-operations'
  }
  if (
    table.startsWith('collaboration_') ||
    table.startsWith('review_') ||
    table === 'clarify_rounds' ||
    table === 'task_collaborators' ||
    table === 'task_feedback' ||
    table === 'task_questions'
  ) {
    return 'collaboration'
  }
  if (
    table === 'tasks' ||
    table.startsWith('task_') ||
    table.startsWith('node_run') ||
    table.startsWith('workgroup_') ||
    table === 'workgroups' ||
    table === 'runtime_session_leases'
  ) {
    return 'task-execution'
  }
  return 'resource-catalog'
}

function dispositionFor(table: string): TableDisposition {
  if (RFC349_ARCHIVE_TABLE_SET.has(table)) return 'ARCHIVE_THEN_OMIT'
  if (RFC349_DEFER_TABLES.has(table)) return 'DEFER'
  return 'KEEP'
}

function codecFor(column: AnySQLiteColumn): LogicalCodec {
  if (column.dataType === 'boolean') return 'boolean'
  if (column.dataType === 'number') {
    if (column.columnType === 'SQLiteReal') return 'real'
    if (
      /(?:^|_)(?:at|until|after|before|deadline|expires|heartbeat|timestamp)(?:_|$)/.test(
        column.name,
      )
    ) {
      return 'epoch-milliseconds'
    }
    return 'integer'
  }
  if (column.dataType === 'buffer') return 'opaque-bytes'
  if (column.enumValues?.length) return 'text'
  if (
    column.name.endsWith('_json') ||
    /^(?:definition|inputs|outputs|permission|skills|depends_on|mcp|plugins|frontmatter_extra)$/.test(
      column.name,
    )
  ) {
    return 'json-text'
  }
  if (column.primary || /(?:^id$|_id$|_ref$|_key$|_digest$)/.test(column.name)) {
    return 'text-identity'
  }
  return 'text'
}

function postgresqlType(codec: LogicalCodec): string {
  switch (codec) {
    case 'boolean':
      return 'boolean'
    case 'epoch-milliseconds':
    case 'integer':
      return 'bigint'
    case 'real':
      return 'double precision'
    case 'opaque-bytes':
      return 'bytea'
    case 'json-text':
    case 'text':
    case 'text-identity':
      return 'text'
  }
}

function defaultKind(column: AnySQLiteColumn): LogicalColumnContract['defaultKind'] {
  if (!column.hasDefault) return 'none'
  if ((column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement) {
    return 'identity'
  }
  if (column.default === undefined && column.primary) return 'implicit-primary'
  if (column.defaultFn !== undefined) return 'runtime'
  if (is(column.default, SQL)) return 'database-expression'
  return 'literal'
}

function literalSql(value: unknown, provider: DatabaseProvider): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') {
    if (provider === 'postgresql') return value ? 'TRUE' : 'FALSE'
    return value ? '1' : '0'
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error(`RFC-349 unsupported database default value type: ${typeof value}`)
}

function defaultProjection(
  column: AnySQLiteColumn,
): Pick<LogicalColumnContract, 'defaultValue' | 'providerDefault'> {
  if (!column.hasDefault) {
    return { defaultValue: null, providerDefault: { sqlite: null, postgresql: null } }
  }
  if ((column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement) {
    return { defaultValue: 'identity', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (column.default === undefined && column.primary) {
    return { defaultValue: 'implicit-primary', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (column.defaultFn !== undefined) {
    return { defaultValue: 'runtime', providerDefault: { sqlite: null, postgresql: null } }
  }
  if (is(column.default, SQL)) {
    const sqlite = renderExpression(column.default)
    return {
      defaultValue: sqlite,
      providerDefault: {
        sqlite,
        postgresql: renderPostgresqlDatabaseDefault(column.default),
      },
    }
  }
  return {
    defaultValue: JSON.stringify(column.default),
    providerDefault: {
      sqlite: literalSql(column.default, 'sqlite'),
      postgresql: literalSql(column.default, 'postgresql'),
    },
  }
}

const sqliteDialect = new SQLiteSyncDialect()

function renderExpression(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (is(value, SQL)) return sqliteDialect.sqlToQuery(value).sql.replaceAll(/\s+/g, ' ').trim()
  if (typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return value.name
  }
  return String(value)
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function retentionFor(
  table: string,
  owner: OwnerContext,
  disposition: TableDisposition,
): RetentionContract {
  if (disposition === 'ARCHIVE_THEN_OMIT') {
    return {
      class: 'archive-only',
      owner,
      rule: 'Preserve the RFC-349 logical archive and source generation; never restore into the active PostgreSQL schema.',
    }
  }
  if (/(?:event|audit|attempt|delivery|lease|outbox|operation|maintenance|journal)/.test(table)) {
    return {
      class: 'owner-managed-operational',
      owner,
      rule: 'The owning bounded context defines retention and archive jobs through its application port.',
    }
  }
  return {
    class: 'owner-managed-business',
    owner,
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  }
}

function consumerLedgerFor(table: string, disposition: TableDisposition): ConsumerLedgerContract {
  if (disposition === 'ARCHIVE_THEN_OMIT') {
    return {
      productionReader: 'zero-proved',
      productionWriter: 'zero-proved',
      backgroundRecoveryDiagnostic: 'zero-proved',
      evidence: `RFC-310 T108 and RFC-349 exact source census: ${table} has no production symbol or physical-name consumer outside db/schema.ts.`,
    }
  }
  return {
    productionReader: 'owner-required',
    productionWriter: 'owner-required-or-immutable',
    backgroundRecoveryDiagnostic: 'owner-reviewed',
    evidence:
      'RFC-349 keeps this table in the active parity set; removal requires a new exact consumer ledger and approval.',
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export function canonicalSchemaJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

export function digestSchemaContract(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalSchemaJson(value)).digest('hex')}`
}

export function assertExactSchemaRoster(
  actualInput: readonly string[],
  expectedInput: readonly string[] = RFC349_SOURCE_TABLES,
): void {
  const actual = [...actualInput].sort()
  const expected = [...expectedInput].sort()
  const duplicate = actual.find((name, index) => name === actual[index - 1])
  if (duplicate !== undefined) {
    throw new Error(`RFC-349 schema roster has duplicate table ${duplicate}`)
  }
  if (JSON.stringify(actual) === JSON.stringify(expected)) return
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((name) => !actualSet.has(name))
  const extra = actual.filter((name) => !expectedSet.has(name))
  throw new Error(
    `RFC-349 schema roster drift (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`,
  )
}

export function buildLogicalSchemaContract(): LogicalSchemaContract {
  if (cachedLogicalSchemaContract !== undefined) return cachedLogicalSchemaContract
  const entries = Object.entries(sqliteSchema as Record<string, unknown>)
    .filter((entry): entry is [string, object] => typeof entry[1] === 'object' && entry[1] !== null)
    .map(([symbol, table]) => ({ symbol, table: concreteDatabaseTable(table, 'sqlite') }))
    .filter((entry): entry is { symbol: string; table: SQLiteTable } =>
      is(entry.table, SQLiteTable),
    )
    .map(({ symbol, table }) => ({ symbol, table, config: getTableConfig(table) }))

  const byName = new Map(entries.map((entry) => [entry.config.name, entry]))
  if (byName.size !== entries.length)
    throw new Error('RFC-349 schema contract: duplicate physical table name')

  assertExactSchemaRoster([...byName.keys()])

  const tables: LogicalTableContract[] = RFC349_SOURCE_TABLES.map((name) => {
    const entry = byName.get(name)
    if (!entry) throw new Error(`RFC-349 schema contract missing ${name}`)
    const { config } = entry
    const ownerContext = ownerFor(name)
    const disposition = dispositionFor(name)
    const columnPrimary = config.columns
      .filter((column) => column.primary)
      .map((column) => column.name)
    const compositePrimary = config.primaryKeys.flatMap((primary) =>
      primary.columns.map((column) => column.name),
    )
    const primaryKey = uniqueStrings([...columnPrimary, ...compositePrimary])
    if (primaryKey.length === 0) {
      throw new Error(`RFC-349 active table ${name} has no stable primary migration key`)
    }

    const indexes = config.indexes.map(
      (index): LogicalIndexContract => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: index.config.columns.map(renderExpression),
        where: index.config.where === undefined ? null : renderExpression(index.config.where),
      }),
    )
    const unique: LogicalConstraintContract[] = [
      ...config.uniqueConstraints.map((constraint) => ({
        name:
          constraint.getName() ??
          `${name}_${constraint.columns.map((column) => column.name).join('_')}_unique`,
        columns: constraint.columns.map((column) => column.name),
        expression: null,
      })),
      ...indexes
        .filter((index) => index.unique)
        .map((index) => ({ name: index.name, columns: index.columns, expression: index.where })),
    ]

    const result: LogicalTableContract = {
      id: name,
      schemaSymbol: entry.symbol,
      ownerContext,
      disposition,
      sourceTable: name,
      providerTables:
        disposition === 'ARCHIVE_THEN_OMIT' ? { sqlite: name } : { sqlite: name, postgresql: name },
      migrationKey: primaryKey,
      columns: config.columns.map((column) => {
        const logicalCodec = codecFor(column)
        const defaults = defaultProjection(column)
        return {
          name: column.name,
          logicalCodec,
          nullable: !column.notNull,
          primary: primaryKey.includes(column.name),
          hasDefault: column.hasDefault,
          defaultKind: defaultKind(column),
          ...defaults,
          identity: Boolean(
            (column as AnySQLiteColumn & { readonly autoIncrement?: boolean }).autoIncrement,
          ),
          uniqueName: column.isUnique
            ? (column.uniqueName ?? `${name}_${column.name}_unique`)
            : null,
          enumValues: column.enumValues ?? [],
          providerType: {
            sqlite: column.getSQLType(),
            postgresql: postgresqlType(logicalCodec),
          },
        }
      }),
      primaryKey,
      unique,
      foreignKeys: config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference()
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: getTableConfig(concreteDatabaseTable(reference.foreignTable, 'sqlite'))
            .name,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
          onDelete: foreignKey.onDelete ?? 'no action',
          onUpdate: foreignKey.onUpdate ?? 'no action',
        }
      }),
      checks: config.checks.map((constraint) => ({
        name: constraint.name,
        columns: [],
        expression: renderExpression(constraint.value),
      })),
      indexes,
      retention: retentionFor(name, ownerContext, disposition),
      consumers: consumerLedgerFor(name, disposition),
      rationale:
        disposition === 'ARCHIVE_THEN_OMIT'
          ? 'RFC-310 proved the legacy writer-private table has no production consumer; RFC-349 D9 preserves a verified logical archive and omits it from the PostgreSQL active schema.'
          : disposition === 'DEFER'
            ? 'The table appears historical or transitional, but RFC-349 lacks the complete drop-proof evidence required to omit it; migrate it unchanged.'
            : 'The owning bounded context currently requires this table for live, audit, or recovery semantics.',
      ...(disposition === 'ARCHIVE_THEN_OMIT'
        ? {
            archive: {
              format: 'agent-workflow-logical-table-v1' as const,
              stableOrder: primaryKey,
              verifies: ['row-count', 'key-bounds', 'chunk-digest', 'root-digest'] as const,
              restoreIntoActiveSchema: false as const,
              approval: 'RFC-349-D9' as const,
            },
          }
        : {}),
    }
    return result
  })

  const withoutDigest = {
    contractVersion: RFC349_SCHEMA_CONTRACT_VERSION,
    sourceProjection: 'sqlite' as const,
    sourceTableCount: tables.length,
    activeTableCount: tables.filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT').length,
    archiveOnlyTableCount: tables.filter((table) => table.disposition === 'ARCHIVE_THEN_OMIT')
      .length,
    tables,
  }
  cachedLogicalSchemaContract = Object.freeze({
    ...withoutDigest,
    digest: digestSchemaContract(withoutDigest),
  })
  return cachedLogicalSchemaContract
}

export function renderLogicalSchemaReport(contract: LogicalSchemaContract): string {
  const ownerCounts = new Map<OwnerContext, number>()
  for (const table of contract.tables) {
    ownerCounts.set(table.ownerContext, (ownerCounts.get(table.ownerContext) ?? 0) + 1)
  }
  const ownerRows = [...ownerCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, count]) => `| \`${owner}\` | ${count} |`)
    .join('\n')
  const tableRows = contract.tables
    .map(
      (table) =>
        `| \`${table.id}\` | \`${table.schemaSymbol}\` | \`${table.ownerContext}\` | \`${table.disposition}\` | \`${table.migrationKey.join(', ')}\` | ${table.columns.length} | ${table.foreignKeys.length} | ${table.indexes.length} |`,
    )
    .join('\n')

  return `# RFC-349 Canonical Schema Contract Report

> Generated by \`packages/backend/scripts/rfc349-schema-contract.ts\`. Do not edit by hand.

- Contract version: \`${contract.contractVersion}\`
- Digest: \`${contract.digest}\`
- SQLite source tables: **${contract.sourceTableCount}**
- PostgreSQL logical active parity tables: **${contract.activeTableCount}**
- Archive-only legacy tables: **${contract.archiveOnlyTableCount}**
- Provider/ORM metadata tables: reported separately by the runtime; not included in the logical counts above.

## Owner census

| Owner context | Tables |
| ------------- | -----: |
${ownerRows}

## Exact table ledger

| Logical table | Schema symbol | Owner | Disposition | Migration key | Columns | FKs | Indexes |
| ------------- | ------------- | ----- | ----------- | ------------- | ------: | --: | ------: |
${tableRows}
`
}
