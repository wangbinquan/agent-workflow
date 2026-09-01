// RFC-349 D11 / design §11.5 — fail-closed business-invariant and identity
// verification for the logical PostgreSQL target. The caller owns the one
// reserved migration connection and transaction; this module never reserves a
// connection or opens a nested transaction.

import type { LogicalSchemaContract, LogicalTableContract } from './schemaContract'
import type { PostgresqlReservedConnection } from './postgresqlRuntime'
import { POSTGRESQL_APPLICATION_SCHEMA } from './postgresqlSchema'

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`
const applicationTable = (table: string): string =>
  `${quote(POSTGRESQL_APPLICATION_SCHEMA)}.${quote(table)}`

export class PostgresqlLogicalTargetInvariantError extends Error {
  constructor(
    public readonly invariant: string,
    public readonly table: string,
    public readonly key: string,
  ) {
    super(`PostgreSQL target invariant ${invariant} failed at ${table}:${key}`)
    this.name = 'PostgresqlLogicalTargetInvariantError'
  }
}

interface BoundTables {
  readonly name: (logicalId: string) => string
  readonly sql: (logicalId: string) => string
}

interface BusinessInvariantDefinition {
  readonly id: string
  readonly tables: readonly string[]
  readonly query: (tables: BoundTables) => string
}

function mappedTable(table: LogicalTableContract): string {
  const physical = table.providerTables.postgresql
  if (physical === undefined) {
    throw new PostgresqlLogicalTargetInvariantError(
      'contract-physical-table-mapping',
      table.id,
      'postgresql',
    )
  }
  return physical
}

function firstViolationQuery(parts: readonly string[]): string {
  return `${parts.join('\nUNION ALL\n')}\nLIMIT 1`
}

function pointerViolation(input: {
  readonly tables: BoundTables
  readonly identity: string
  readonly revision: string
  readonly pointer: string
  readonly revisionOwner: string
}): string {
  const identity = input.tables.sql(input.identity)
  const revision = input.tables.sql(input.revision)
  return `SELECT '${input.identity}' AS invariant_table, identity."id"::text AS invariant_key
FROM ${identity} AS identity
LEFT JOIN ${revision} AS revision
  ON revision.${quote(input.revisionOwner)} = identity."id"
 AND revision."revision" = identity.${quote(input.pointer)}
WHERE identity.${quote(input.pointer)} IS NOT NULL AND revision.${quote(input.revisionOwner)} IS NULL`
}

const RESOURCE_POINTER_TABLES = [
  'action_templates',
  'action_template_revisions',
  'verification_profiles',
  'verification_profile_revisions',
  'digital_employees',
  'digital_employee_revisions',
  'automation_policies',
  'automation_policy_revisions',
  'development_adapter_definitions',
  'development_adapter_definition_revisions',
  'custom_event_source_definitions',
  'custom_event_source_revisions',
  'employee_tool_registrations',
  'employee_tool_registration_revisions',
  'employee_job_templates',
  'employee_job_template_revisions',
  'employee_definitions',
  'employee_definition_revisions',
] as const

const AUTH_RESOURCE_TABLES = [
  'resource_grants',
  'users',
  'agents',
  'skills',
  'mcps',
  'plugins',
  'workflows',
  'workgroups',
  'capability_templates',
  'action_templates',
  'verification_profiles',
  'digital_employees',
  'automation_policies',
  'development_adapter_definitions',
  'employee_definitions',
  'employee_tool_registrations',
  'employee_job_templates',
  'scheduled_tasks',
] as const

const BUSINESS_INVARIANTS: readonly BusinessInvariantDefinition[] = [
  // task ownership/fence/effect/maintenance
  {
    id: 'task-ownership-epoch',
    tables: [
      'task_execution_owners',
      'task_execution_intents',
      'task_execution_effects',
      'task_execution_effect_attempts',
    ],
    query: (tables) => `/* rfc349-invariant:task-ownership-epoch */
${firstViolationQuery([
  `SELECT 'task_execution_intents' AS invariant_table, intent."id"::text AS invariant_key
FROM ${tables.sql('task_execution_intents')} AS intent
LEFT JOIN ${tables.sql('task_execution_owners')} AS owner ON owner."task_id" = intent."task_id"
WHERE intent."state" = 'claimed'
  AND (owner."task_id" IS NULL
    OR owner."state" <> 'claimed'
    OR owner."epoch" IS DISTINCT FROM intent."claimed_epoch")`,
  `SELECT 'task_execution_effect_attempts' AS invariant_table, attempt."id"::text AS invariant_key
FROM ${tables.sql('task_execution_effect_attempts')} AS attempt
JOIN ${tables.sql('task_execution_effects')} AS effect ON effect."id" = attempt."effect_id"
LEFT JOIN ${tables.sql('task_execution_owners')} AS owner ON owner."task_id" = effect."task_id"
WHERE attempt."state" IN ('prepared', 'acting', 'recovery-required')
  AND (owner."task_id" IS NULL
    OR owner."state" NOT IN ('claimed', 'recovery-required')
    OR owner."epoch" IS DISTINCT FROM attempt."epoch")`,
])}`,
  },
  {
    id: 'task-effect-attempt-chain',
    tables: ['task_execution_effects', 'task_execution_effect_attempts', 'task_execution_intents'],
    query: (tables) => `/* rfc349-invariant:task-effect-attempt-chain */
SELECT 'task_execution_effects' AS invariant_table, effect."id"::text AS invariant_key
FROM ${tables.sql('task_execution_effects')} AS effect
LEFT JOIN ${tables.sql('task_execution_intents')} AS origin_intent
  ON origin_intent."id" = effect."origin_intent_id"
LEFT JOIN ${tables.sql('task_execution_intents')} AS current_intent
  ON current_intent."id" = effect."current_intent_id"
LEFT JOIN (
  SELECT "effect_id", MAX("attempt_no") AS max_attempt_no, COUNT(*) AS attempt_count
  FROM ${tables.sql('task_execution_effect_attempts')}
  GROUP BY "effect_id"
) AS attempts ON attempts."effect_id" = effect."id"
WHERE origin_intent."task_id" IS DISTINCT FROM effect."task_id"
   OR current_intent."task_id" IS DISTINCT FROM effect."task_id"
   OR effect."last_attempt_no" IS DISTINCT FROM COALESCE(attempts.max_attempt_no, 0)
   OR effect."last_attempt_no" IS DISTINCT FROM COALESCE(attempts.attempt_count, 0)
   OR (effect."state" = 'open') IS DISTINCT FROM (effect."settled_at" IS NULL)
   OR EXISTS (
     SELECT 1
     FROM ${tables.sql('task_execution_effect_attempts')} AS attempt
     JOIN ${tables.sql('task_execution_intents')} AS attempt_intent
       ON attempt_intent."id" = attempt."intent_id"
     WHERE attempt."effect_id" = effect."id"
       AND attempt_intent."task_id" IS DISTINCT FROM effect."task_id"
   )
ORDER BY effect."id"
LIMIT 1`,
  },
  {
    id: 'task-effect-fence-epoch',
    tables: ['task_execution_effect_fences', 'task_execution_effect_attempts'],
    query: (tables) => `/* rfc349-invariant:task-effect-fence-epoch */
SELECT 'task_execution_effect_fences' AS invariant_table,
       (fence."effect_attempt_id" || '/' || fence."fence_key")::text AS invariant_key
FROM ${tables.sql('task_execution_effect_fences')} AS fence
JOIN ${tables.sql('task_execution_effect_attempts')} AS attempt
  ON attempt."id" = fence."effect_attempt_id"
WHERE fence."acquired_epoch" IS DISTINCT FROM attempt."epoch"
   OR (fence."released_at" IS NULL AND attempt."state" NOT IN ('prepared', 'acting', 'recovery-required'))
ORDER BY fence."effect_attempt_id", fence."fence_key"
LIMIT 1`,
  },
  {
    id: 'task-maintenance-completion',
    tables: ['task_execution_maintenance_claims', 'task_execution_maintenance_members'],
    query: (tables) => `/* rfc349-invariant:task-maintenance-completion */
SELECT 'task_execution_maintenance_claims' AS invariant_table, claim."id"::text AS invariant_key
FROM ${tables.sql('task_execution_maintenance_claims')} AS claim
WHERE (claim."state" = 'completed') IS DISTINCT FROM (claim."completed_at" IS NOT NULL)
   OR (
     claim."state" = 'completed'
     AND EXISTS (
       SELECT 1 FROM ${tables.sql('task_execution_maintenance_members')} AS member
       WHERE member."claim_id" = claim."id" AND member."released_at" IS NULL
     )
   )
ORDER BY claim."id"
LIMIT 1`,
  },

  // committed event and every persisted consumer delivery
  {
    id: 'committed-event-head',
    tables: ['committed_event_aggregate_heads', 'committed_events'],
    query: (tables) => `/* rfc349-invariant:committed-event-head */
WITH event_chain AS (
  SELECT "producer", "family", "aggregate_kind", "aggregate_id",
         MAX("aggregate_seq") AS max_seq, COUNT(*) AS event_count
  FROM ${tables.sql('committed_events')}
  GROUP BY "producer", "family", "aggregate_kind", "aggregate_id"
)
SELECT 'committed_event_aggregate_heads' AS invariant_table,
       COALESCE(head."aggregate_id", event_chain."aggregate_id")::text AS invariant_key
FROM ${tables.sql('committed_event_aggregate_heads')} AS head
FULL OUTER JOIN event_chain
  ON event_chain."producer" = head."producer"
 AND event_chain."family" = head."family"
 AND event_chain."aggregate_kind" = head."aggregate_kind"
 AND event_chain."aggregate_id" = head."aggregate_id"
WHERE head."last_seq" IS DISTINCT FROM event_chain.max_seq
   OR event_chain.event_count IS DISTINCT FROM event_chain.max_seq
ORDER BY invariant_key
LIMIT 1`,
  },
  {
    id: 'committed-event-delivery',
    tables: ['committed_events', 'committed_event_deliveries'],
    query: (tables) => `/* rfc349-invariant:committed-event-delivery */
SELECT 'committed_event_deliveries' AS invariant_table,
       (delivery."event_id" || '/' || delivery."consumer_id")::text AS invariant_key
FROM ${tables.sql('committed_event_deliveries')} AS delivery
JOIN ${tables.sql('committed_events')} AS event ON event."id" = delivery."event_id"
WHERE event."delivery_mode" <> 'dispatchable'
   OR (delivery."state" = 'claimed') IS DISTINCT FROM
      (delivery."claimed_by" IS NOT NULL AND delivery."claim_expires_at" IS NOT NULL)
   OR (delivery."state" = 'accepted') IS DISTINCT FROM (delivery."accepted_at" IS NOT NULL)
   OR (delivery."state" = 'dead-letter') IS DISTINCT FROM (delivery."dead_letter_at" IS NOT NULL)
ORDER BY delivery."event_id", delivery."consumer_id"
LIMIT 1`,
  },

  // apply-journal prepared/committed convergence and provenance
  {
    id: 'intent-apply-convergence',
    tables: ['intent_apply_journal'],
    query: (tables) => `/* rfc349-invariant:intent-apply-convergence */
SELECT 'intent_apply_journal' AS invariant_table, journal."id"::text AS invariant_key
FROM ${tables.sql('intent_apply_journal')} AS journal
WHERE (journal."state" = 'committed') IS DISTINCT FROM (journal."receipt_json" IS NOT NULL)
   OR (journal."state" = 'failed' AND journal."error" IS NULL)
   OR EXISTS (
     SELECT 1 FROM ${tables.sql('intent_apply_journal')} AS duplicate
     WHERE duplicate."session_id" = journal."session_id"
       AND duplicate."client_mutation_id" = journal."client_mutation_id"
       AND duplicate."id" <> journal."id"
   )
ORDER BY journal."id"
LIMIT 1`,
  },
  {
    id: 'resource-package-apply-convergence',
    tables: ['resource_bundle_applies'],
    query: (tables) => `/* rfc349-invariant:resource-package-apply-convergence */
SELECT 'resource_bundle_applies' AS invariant_table, bundle_apply."id"::text AS invariant_key
FROM ${tables.sql('resource_bundle_applies')} AS bundle_apply
WHERE (bundle_apply."state" = 'committed') IS DISTINCT FROM (bundle_apply."receipt_json" IS NOT NULL)
   OR (bundle_apply."state" = 'failed' AND bundle_apply."error" IS NULL)
   OR EXISTS (
     SELECT 1 FROM ${tables.sql('resource_bundle_applies')} AS duplicate
     WHERE duplicate."scope" = bundle_apply."scope"
       AND duplicate."key" = bundle_apply."key"
       AND duplicate."id" <> bundle_apply."id"
   )
ORDER BY bundle_apply."id"
LIMIT 1`,
  },
  {
    id: 'canonical-intent-provenance',
    tables: ['intent_provenance', 'intent_apply_journal'],
    query: (tables) => `/* rfc349-invariant:canonical-intent-provenance */
SELECT 'intent_provenance' AS invariant_table,
       (provenance."resource_type" || '/' || provenance."resource_id" || '/' || provenance."commit_id")::text AS invariant_key
FROM ${tables.sql('intent_provenance')} AS provenance
LEFT JOIN ${tables.sql('intent_apply_journal')} AS journal
  ON journal."id" = provenance."commit_id"
WHERE journal."id" IS NULL
   OR journal."session_id" IS DISTINCT FROM provenance."session_id"
   OR journal."state" <> 'committed'
   OR journal."receipt_json" IS NULL
ORDER BY invariant_key
LIMIT 1`,
  },

  // lease/outbox/idempotency/CAS revision
  {
    id: 'digital-employee-outbox-lease',
    tables: ['employee_os_outbox'],
    query: (tables) => `/* rfc349-invariant:digital-employee-outbox-lease */
SELECT 'employee_os_outbox' AS invariant_table, outbox."id"::text AS invariant_key
FROM ${tables.sql('employee_os_outbox')} AS outbox
WHERE (outbox."state" = 'claimed') IS DISTINCT FROM
      (outbox."claimed_by" IS NOT NULL AND outbox."claim_expires_at" IS NOT NULL)
   OR outbox."attempt_count" < 0
   OR EXISTS (
     SELECT 1 FROM ${tables.sql('employee_os_outbox')} AS duplicate
     WHERE duplicate."dedupe_key" = outbox."dedupe_key" AND duplicate."id" <> outbox."id"
   )
ORDER BY outbox."id"
LIMIT 1`,
  },
  {
    id: 'digital-employee-context-revision',
    tables: ['employee_context_records', 'employee_context_revisions'],
    query: (tables) => `/* rfc349-invariant:digital-employee-context-revision */
SELECT 'employee_context_records' AS invariant_table, context."id"::text AS invariant_key
FROM ${tables.sql('employee_context_records')} AS context
LEFT JOIN ${tables.sql('employee_context_revisions')} AS revision
  ON revision."context_id" = context."id" AND revision."revision" = context."current_revision"
WHERE revision."context_id" IS NULL
ORDER BY context."id"
LIMIT 1`,
  },

  // resource revision/current pointer
  {
    id: 'resource-current-revision-pointers',
    tables: RESOURCE_POINTER_TABLES,
    query: (tables) =>
      `/* rfc349-invariant:resource-current-revision-pointers */\n${firstViolationQuery([
        pointerViolation({
          tables,
          identity: 'action_templates',
          revision: 'action_template_revisions',
          pointer: 'published_revision',
          revisionOwner: 'template_id',
        }),
        pointerViolation({
          tables,
          identity: 'verification_profiles',
          revision: 'verification_profile_revisions',
          pointer: 'published_revision',
          revisionOwner: 'profile_id',
        }),
        pointerViolation({
          tables,
          identity: 'digital_employees',
          revision: 'digital_employee_revisions',
          pointer: 'published_revision',
          revisionOwner: 'employee_id',
        }),
        pointerViolation({
          tables,
          identity: 'automation_policies',
          revision: 'automation_policy_revisions',
          pointer: 'published_revision',
          revisionOwner: 'policy_id',
        }),
        pointerViolation({
          tables,
          identity: 'development_adapter_definitions',
          revision: 'development_adapter_definition_revisions',
          pointer: 'published_revision',
          revisionOwner: 'adapter_id',
        }),
        pointerViolation({
          tables,
          identity: 'custom_event_source_definitions',
          revision: 'custom_event_source_revisions',
          pointer: 'published_revision',
          revisionOwner: 'source_id',
        }),
        pointerViolation({
          tables,
          identity: 'employee_tool_registrations',
          revision: 'employee_tool_registration_revisions',
          pointer: 'published_revision',
          revisionOwner: 'tool_id',
        }),
        pointerViolation({
          tables,
          identity: 'employee_job_templates',
          revision: 'employee_job_template_revisions',
          pointer: 'published_revision',
          revisionOwner: 'template_id',
        }),
        pointerViolation({
          tables,
          identity: 'employee_definitions',
          revision: 'employee_definition_revisions',
          pointer: 'published_revision',
          revisionOwner: 'employee_id',
        }),
      ])}`,
  },

  // digital-employee/development saga/attempt/effect
  {
    id: 'digital-development-saga-attempt-effect',
    tables: [
      'employee_approval_sagas',
      'employee_reaction_rounds',
      'development_missions',
      'development_decisions',
      'development_action_runs',
      'development_agent_attempts',
      'development_effects',
      'development_step_runs',
      'development_approval_sagas',
    ],
    query: (tables) => `/* rfc349-invariant:digital-development-saga-attempt-effect */
${firstViolationQuery([
  `SELECT 'employee_approval_sagas' AS invariant_table, saga."id"::text AS invariant_key
FROM ${tables.sql('employee_approval_sagas')} AS saga
LEFT JOIN ${tables.sql('employee_reaction_rounds')} AS round ON round."id" = saga."submit_round_id"
WHERE round."id" IS NULL OR round."case_id" IS DISTINCT FROM saga."case_id"`,
  `SELECT 'development_action_runs' AS invariant_table, action."id"::text AS invariant_key
FROM ${tables.sql('development_action_runs')} AS action
LEFT JOIN ${tables.sql('development_decisions')} AS decision ON decision."id" = action."decision_id"
WHERE decision."id" IS NULL OR decision."mission_id" IS DISTINCT FROM action."mission_id"`,
  `SELECT 'development_agent_attempts' AS invariant_table, attempt."id"::text AS invariant_key
FROM ${tables.sql('development_agent_attempts')} AS attempt
LEFT JOIN ${tables.sql('development_action_runs')} AS action ON action."id" = attempt."action_run_id"
WHERE action."id" IS NULL`,
  `SELECT 'development_effects' AS invariant_table, effect."id"::text AS invariant_key
FROM ${tables.sql('development_effects')} AS effect
LEFT JOIN ${tables.sql('development_action_runs')} AS action ON action."id" = effect."action_run_id"
WHERE effect."action_run_id" IS NOT NULL
  AND (action."id" IS NULL OR action."mission_id" IS DISTINCT FROM effect."mission_id")`,
  `SELECT 'development_approval_sagas' AS invariant_table, saga."id"::text AS invariant_key
FROM ${tables.sql('development_approval_sagas')} AS saga
LEFT JOIN ${tables.sql('development_step_runs')} AS step ON step."id" = saga."step_run_id"
WHERE step."id" IS NULL OR step."mission_id" IS DISTINCT FROM saga."mission_id"`,
  `SELECT 'development_missions' AS invariant_table, mission."id"::text AS invariant_key
FROM ${tables.sql('development_missions')} AS mission
LEFT JOIN ${tables.sql('development_action_runs')} AS action
  ON action."id" = mission."current_action_run_id"
WHERE mission."current_action_run_id" IS NOT NULL
  AND (action."id" IS NULL OR action."mission_id" IS DISTINCT FROM mission."id")`,
])}`,
  },

  // auth/session/config references, including the dynamic ACL resource key
  {
    id: 'auth-resource-grant-reference',
    tables: AUTH_RESOURCE_TABLES,
    query: (tables) => {
      const resourceBranches: readonly [string, string][] = [
        ['agent', 'agents'],
        ['skill', 'skills'],
        ['mcp', 'mcps'],
        ['plugin', 'plugins'],
        ['workflow', 'workflows'],
        ['workgroup', 'workgroups'],
        ['capability_template', 'capability_templates'],
        ['action_template', 'action_templates'],
        ['verification_profile', 'verification_profiles'],
        ['digital_employee', 'digital_employees'],
        ['automation_policy', 'automation_policies'],
        ['development_adapter', 'development_adapter_definitions'],
        ['employee_definition', 'employee_definitions'],
        ['employee_tool', 'employee_tool_registrations'],
        ['employee_job_template', 'employee_job_templates'],
        ['scheduled_task', 'scheduled_tasks'],
      ]
      const validResource = resourceBranches
        .map(
          ([type, table]) =>
            `(resource_grant."resource_type" = '${type}' AND EXISTS (SELECT 1 FROM ${tables.sql(table)} AS resource WHERE resource."id" = resource_grant."resource_id"))`,
        )
        .join('\n      OR ')
      return `/* rfc349-invariant:auth-resource-grant-reference */
SELECT 'resource_grants' AS invariant_table,
       (resource_grant."resource_type" || '/' || resource_grant."resource_id" || '/' || resource_grant."user_id")::text AS invariant_key
FROM ${tables.sql('resource_grants')} AS resource_grant
LEFT JOIN ${tables.sql('users')} AS principal ON principal."id" = resource_grant."user_id"
WHERE principal."id" IS NULL
   OR NOT (
      ${validResource}
   )
ORDER BY invariant_key
LIMIT 1`
    },
  },
  {
    id: 'intent-session-reference',
    tables: ['intent_sessions', 'intent_drafts', 'intent_turns'],
    query: (tables) => `/* rfc349-invariant:intent-session-reference */
SELECT 'intent_sessions' AS invariant_table, session."id"::text AS invariant_key
FROM ${tables.sql('intent_sessions')} AS session
LEFT JOIN ${tables.sql('intent_drafts')} AS draft ON draft."id" = session."current_draft_id"
LEFT JOIN ${tables.sql('intent_turns')} AS turn ON turn."id" = session."in_flight_turn_id"
WHERE (session."current_draft_id" IS NOT NULL AND
      (draft."id" IS NULL OR draft."session_id" IS DISTINCT FROM session."id"))
   OR (session."in_flight_turn_id" IS NOT NULL AND
      (turn."id" IS NULL OR turn."session_id" IS DISTINCT FROM session."id"))
ORDER BY session."id"
LIMIT 1`,
  },
] as const

export const POSTGRESQL_LOGICAL_TARGET_INVARIANT_IDS = Object.freeze(
  BUSINESS_INVARIANTS.map((invariant) => invariant.id),
)

function bindTables(
  definition: BusinessInvariantDefinition,
  contract: LogicalSchemaContract,
): BoundTables | null {
  const active = new Map(
    contract.tables
      .filter((table) => table.disposition !== 'ARCHIVE_THEN_OMIT')
      .map((table) => [table.id, mappedTable(table)] as const),
  )
  const present = definition.tables.filter((table) => active.has(table))
  if (present.length === 0) return null
  const missing = definition.tables.find((table) => !active.has(table))
  if (missing !== undefined) {
    throw new PostgresqlLogicalTargetInvariantError(definition.id, missing, 'contract-missing')
  }
  const name = (logicalId: string): string => {
    const physical = active.get(logicalId)
    if (physical === undefined) {
      throw new PostgresqlLogicalTargetInvariantError(definition.id, logicalId, 'contract-missing')
    }
    return physical
  }
  return Object.freeze({
    name,
    sql(logicalId: string): string {
      return applicationTable(name(logicalId))
    },
  })
}

export async function verifyPostgresqlLogicalTargetBusinessInvariants(input: {
  readonly connection: PostgresqlReservedConnection
  readonly contract: LogicalSchemaContract
}): Promise<void> {
  for (const invariant of BUSINESS_INVARIANTS) {
    const tables = bindTables(invariant, input.contract)
    if (tables === null) continue
    let rows: readonly Record<string, unknown>[]
    try {
      rows = await input.connection.unsafe(invariant.query(tables))
    } catch (error) {
      if (error instanceof PostgresqlLogicalTargetInvariantError) throw error
      throw new PostgresqlLogicalTargetInvariantError(
        invariant.id,
        invariant.tables[0] ?? 'unknown',
        'query-error',
      )
    }
    const violation = rows[0]
    if (violation === undefined) continue
    const table =
      typeof violation.invariant_table === 'string'
        ? violation.invariant_table
        : (invariant.tables[0] ?? 'unknown')
    const key =
      typeof violation.invariant_key === 'string'
        ? violation.invariant_key
        : String(violation.invariant_key ?? 'invalid-result')
    throw new PostgresqlLogicalTargetInvariantError(invariant.id, table, key)
  }
}

function databaseInteger(value: unknown, invariant: string, table: string, key: string): bigint {
  try {
    return BigInt(String(value))
  } catch {
    throw new PostgresqlLogicalTargetInvariantError(invariant, table, key)
  }
}

function sequenceRelation(value: string, invariant: string, table: string, key: string): string {
  const identifiers = value.split('.')
  if (
    identifiers.length !== 2 ||
    identifiers.some((identifier) => !/^[a-z_][a-z0-9_$]*$/.test(identifier))
  ) {
    throw new PostgresqlLogicalTargetInvariantError(invariant, table, `${key}:sequence-name`)
  }
  return identifiers.map(quote).join('.')
}

export async function verifyPostgresqlLogicalTargetIdentitySequences(input: {
  readonly connection: PostgresqlReservedConnection
  readonly contract: LogicalSchemaContract
}): Promise<void> {
  for (const table of input.contract.tables.filter(
    (candidate) => candidate.disposition !== 'ARCHIVE_THEN_OMIT',
  )) {
    const physical = mappedTable(table)
    for (const column of table.columns.filter((candidate) => candidate.identity)) {
      const invariant = 'identity-sequence-next-value'
      try {
        const sequenceRows = await input.connection.unsafe(
          'SELECT pg_get_serial_sequence($1, $2) AS sequence_name',
          [`${POSTGRESQL_APPLICATION_SCHEMA}.${physical}`, column.name],
        )
        const sequenceName = sequenceRows[0]?.sequence_name
        if (typeof sequenceName !== 'string' || sequenceName.length === 0) {
          throw new PostgresqlLogicalTargetInvariantError(invariant, table.id, column.name)
        }
        const originalRows = await input.connection.unsafe(
          `SELECT last_value, is_called FROM ${sequenceRelation(
            sequenceName,
            invariant,
            table.id,
            column.name,
          )}`,
        )
        const originalLastValue = databaseInteger(
          originalRows[0]?.last_value,
          invariant,
          table.id,
          `${column.name}:sequence-state`,
        )
        const originalIsCalled = originalRows[0]?.is_called
        if (typeof originalIsCalled !== 'boolean') {
          throw new PostgresqlLogicalTargetInvariantError(
            invariant,
            table.id,
            `${column.name}:sequence-state`,
          )
        }
        const maxRows = await input.connection.unsafe(
          `SELECT MAX(${quote(column.name)}) AS max_value FROM ${applicationTable(physical)}`,
        )
        const maxValue =
          maxRows[0]?.max_value === null || maxRows[0]?.max_value === undefined
            ? null
            : databaseInteger(maxRows[0]?.max_value, invariant, table.id, column.name)

        // nextval is intentionally probed inside the reserved finalize transaction.
        // PostgreSQL sequences are non-transactional, so restore the exact setval
        // state immediately after observing the candidate; no probe row commits.
        let nextValueRaw: unknown
        try {
          const nextRows = await input.connection.unsafe(
            'SELECT nextval($1::regclass) AS next_value',
            [sequenceName],
          )
          nextValueRaw = nextRows[0]?.next_value
        } finally {
          await input.connection.unsafe('SELECT setval($1::regclass, $2, $3)', [
            sequenceName,
            originalLastValue,
            originalIsCalled,
          ])
        }
        const nextValue = databaseInteger(nextValueRaw, invariant, table.id, column.name)
        if (maxValue !== null ? nextValue <= maxValue : nextValue < 1n) {
          throw new PostgresqlLogicalTargetInvariantError(
            invariant,
            table.id,
            `${column.name}:${nextValue.toString()}`,
          )
        }
      } catch (error) {
        if (error instanceof PostgresqlLogicalTargetInvariantError) throw error
        throw new PostgresqlLogicalTargetInvariantError(
          invariant,
          table.id,
          `${column.name}:query-error`,
        )
      }
    }
  }
}
