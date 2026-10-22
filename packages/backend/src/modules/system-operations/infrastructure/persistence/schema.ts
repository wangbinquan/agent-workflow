// RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('system-operations')

const applicationConfigurationDefinition = owner.table({
  id: 'application_configuration',
  schemaSymbol: 'applicationConfiguration',
  columns: {
    id: c.id('id', { primary: true }),
    document: c.text('document'),
    revision: c.int('revision'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'application_configuration_id_fixed',
      expression: raw('"application_configuration"."id" = \'global\'', '"id" = \'global\''),
    },
  ],
  retention: retention.business,
})

export const applicationConfiguration = materializeDrizzle(applicationConfigurationDefinition).table

const hostedDatabaseBackupsDefinition = owner.table({
  id: 'hosted_database_backups',
  schemaSymbol: 'hostedDatabaseBackups',
  columns: {
    id: c.id('id', { primary: true }),
    epoch: c.int('epoch'),
    kind: c.enum('kind', ['manual', 'scheduled'], { default: 'manual' }),
    state: c.enum('state', ['building', 'ready', 'failed', 'released']),
    activeSlot: c.text('active_slot', {
      nullable: true,
      unique: 'hosted_database_backups_active_slot_unique',
    }),
    objectId: c.id('object_id', { nullable: true }),
    sha256: c.text('sha256', { nullable: true }),
    sizeBytes: c.int('size_bytes', { nullable: true }),
    schemaDigest: c.id('schema_digest', { nullable: true }),
    sourceGenerationId: c.id('source_generation_id', { nullable: true }),
    contentsJson: c.jsonText('contents_json', { nullable: true }),
    snapshotAt: c.epochMs('snapshot_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_database_backups_kind_known',
      expression: raw(
        '"hosted_database_backups"."kind" IN (\'manual\',\'scheduled\')',
        "\"kind\" IN ('manual','scheduled')",
      ),
    },
    {
      name: 'hosted_database_backups_state_known',
      expression: raw(
        "\"hosted_database_backups\".\"state\" IN ('building','ready','failed','released')",
        "\"state\" IN ('building','ready','failed','released')",
      ),
    },
    {
      name: 'hosted_database_backups_slot_shape',
      expression: raw(
        '("hosted_database_backups"."state" = \'building\' AND "hosted_database_backups"."active_slot" IS NOT NULL AND "hosted_database_backups"."active_slot" = \'global\') OR ("hosted_database_backups"."state" != \'building\' AND "hosted_database_backups"."active_slot" IS NULL)',
        '("state" = \'building\' AND "active_slot" IS NOT NULL AND "active_slot" = \'global\') OR ("state" != \'building\' AND "active_slot" IS NULL)',
      ),
    },
    {
      name: 'hosted_database_backups_ready_shape',
      expression: raw(
        '"hosted_database_backups"."state" != \'ready\' OR ("hosted_database_backups"."object_id" IS NOT NULL AND "hosted_database_backups"."sha256" IS NOT NULL AND "hosted_database_backups"."size_bytes" IS NOT NULL AND "hosted_database_backups"."schema_digest" IS NOT NULL AND "hosted_database_backups"."source_generation_id" IS NOT NULL AND "hosted_database_backups"."contents_json" IS NOT NULL AND "hosted_database_backups"."snapshot_at" IS NOT NULL)',
        '"state" != \'ready\' OR ("object_id" IS NOT NULL AND "sha256" IS NOT NULL AND "size_bytes" IS NOT NULL AND "schema_digest" IS NOT NULL AND "source_generation_id" IS NOT NULL AND "contents_json" IS NOT NULL AND "snapshot_at" IS NOT NULL)',
      ),
    },
  ],
  indexes: [index('hosted_database_backups_state_idx', ['state', 'created_at'])],
  retention: retention.business,
})

export const hostedDatabaseBackups = materializeDrizzle(hostedDatabaseBackupsDefinition).table

const hostedExecutionControlDefinition = owner.table({
  id: 'hosted_execution_control',
  schemaSymbol: 'hostedExecutionControl',
  columns: {
    id: c.id('id', { primary: true }),
    epoch: c.int('epoch'),
    owner: c.text('owner', { nullable: true }),
    phase: c.enum('phase', ['frozen', 'preparing', 'active']),
    leaseId: c.id('lease_id', { nullable: true }),
    expiresAt: c.epochMs('expires_at', { nullable: true }),
    migrationOperationId: c.id('migration_operation_id', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_execution_control_id_fixed',
      expression: raw('"hosted_execution_control"."id" = \'global\'', '"id" = \'global\''),
    },
    {
      name: 'hosted_execution_control_phase_known',
      expression: raw(
        "\"hosted_execution_control\".\"phase\" IN ('frozen', 'preparing', 'active')",
        "\"phase\" IN ('frozen', 'preparing', 'active')",
      ),
    },
    {
      name: 'hosted_execution_control_window_frozen',
      expression: raw(
        '"hosted_execution_control"."migration_operation_id" IS NULL OR "hosted_execution_control"."phase" = \'frozen\'',
        '"migration_operation_id" IS NULL OR "phase" = \'frozen\'',
      ),
    },
  ],
  retention: retention.business,
})

export const hostedExecutionControl = materializeDrizzle(hostedExecutionControlDefinition).table

const lifecycleAlertsDefinition = owner.table({
  id: 'lifecycle_alerts',
  schemaSymbol: 'lifecycleAlerts',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    rule: c.text('rule'),
    severity: c.text('severity'),
    detail: c.text('detail'),
    detectedAt: c.epochMs('detected_at'),
    resolvedAt: c.epochMs('resolved_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('lifecycle_alerts_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index('idx_lifecycle_alerts_task', ['task_id', 'detected_at']),
    index('idx_lifecycle_alerts_open', ['resolved_at', 'severity']),
  ],
  retention: retention.business,
})

export const lifecycleAlerts = materializeDrizzle(lifecycleAlertsDefinition).table

const lifecycleRepairAuditDefinition = owner.table({
  id: 'lifecycle_repair_audit',
  schemaSymbol: 'lifecycleRepairAudit',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    alertId: c.id('alert_id', { nullable: true }),
    alertRule: c.text('alert_rule'),
    alertDetailJson: c.jsonText('alert_detail_json'),
    optionId: c.id('option_id'),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    beforeSnapshotJson: c.jsonText('before_snapshot_json'),
    afterSnapshotJson: c.jsonText('after_snapshot_json'),
    outcome: c.text('outcome'),
    outcomeMessage: c.text('outcome_message', { nullable: true }),
    appliedAt: c.epochMs('applied_at'),
  },
  indexes: [
    index('idx_lifecycle_repair_audit_task', ['task_id', 'applied_at']),
    index('idx_lifecycle_repair_audit_rule', ['alert_rule', 'applied_at']),
  ],
  retention: retention.operational,
})

export const lifecycleRepairAudit = materializeDrizzle(lifecycleRepairAuditDefinition).table

const maintenanceRunsDefinition = owner.table({
  id: 'maintenance_runs',
  schemaSymbol: 'maintenanceRuns',
  columns: {
    id: c.id('id', { primary: true }),
    jobKey: c.id('job_key'),
    jobClass: c.enum('job_class', ['cleanup', 'recovery', 'checkpoint']),
    slotKey: c.id('slot_key'),
    cycleKey: c.id('cycle_key', { nullable: true }),
    state: c.enum('state', ['pending', 'running', 'deferred', 'succeeded', 'failed']),
    payloadJson: c.jsonText('payload_json', { default: '{}' }),
    cursorVersion: c.int('cursor_version', { default: 1 }),
    cursorJson: c.jsonText('cursor_json', { nullable: true }),
    leaseToken: c.text('lease_token', { nullable: true }),
    leaseExpiresAt: c.epochMs('lease_expires_at', { nullable: true }),
    heartbeatAt: c.epochMs('heartbeat_at', { nullable: true }),
    attempt: c.int('attempt', { default: 0 }),
    sliceNo: c.int('slice_no', { default: 0 }),
    countersJson: c.jsonText('counters_json', { default: '{}' }),
    errorCode: c.text('error_code', { nullable: true }),
    errorMessage: c.text('error_message', { nullable: true }),
    scheduledAt: c.epochMs('scheduled_at'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    startedAt: c.epochMs('started_at', { nullable: true }),
    finishedAt: c.epochMs('finished_at', { nullable: true }),
  },
  checks: [
    {
      name: 'maintenance_runs_job_class_enum',
      expression: raw(
        "\"maintenance_runs\".\"job_class\" IN ('cleanup','recovery','checkpoint')",
        "\"job_class\" IN ('cleanup','recovery','checkpoint')",
      ),
    },
    {
      name: 'maintenance_runs_state_enum',
      expression: raw(
        "\"maintenance_runs\".\"state\" IN ('pending','running','deferred','succeeded','failed')",
        "\"state\" IN ('pending','running','deferred','succeeded','failed')",
      ),
    },
    {
      name: 'maintenance_runs_payload_json_json_valid',
      expression: raw(
        'json_valid("maintenance_runs"."payload_json")',
        'json_valid("payload_json")',
      ),
    },
    {
      name: 'maintenance_runs_cursor_version_positive',
      expression: raw('"maintenance_runs"."cursor_version" > 0', '"cursor_version" > 0'),
    },
    {
      name: 'maintenance_runs_cursor_json_json_valid',
      expression: raw(
        '"maintenance_runs"."cursor_json" IS NULL OR json_valid("maintenance_runs"."cursor_json")',
        '"cursor_json" IS NULL OR json_valid("cursor_json")',
      ),
    },
    {
      name: 'maintenance_runs_attempt_nonnegative',
      expression: raw('"maintenance_runs"."attempt" >= 0', '"attempt" >= 0'),
    },
    {
      name: 'maintenance_runs_slice_no_nonnegative',
      expression: raw('"maintenance_runs"."slice_no" >= 0', '"slice_no" >= 0'),
    },
    {
      name: 'maintenance_runs_counters_json_json_valid',
      expression: raw(
        'json_valid("maintenance_runs"."counters_json")',
        'json_valid("counters_json")',
      ),
    },
    {
      name: 'maintenance_runs_state_shape',
      expression: raw(
        '("maintenance_runs"."state" = \'running\' AND "maintenance_runs"."lease_token" IS NOT NULL AND "maintenance_runs"."lease_expires_at" IS NOT NULL) OR ("maintenance_runs"."state" <> \'running\')',
        '("state" = \'running\' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR ("state" <> \'running\')',
      ),
    },
  ],
  indexes: [
    index('idx_maintenance_runs_job_slot', ['job_key', 'slot_key'], { unique: true }),
    index('idx_maintenance_runs_one_running', ['job_key'], {
      unique: true,
      where: raw('"maintenance_runs"."state" = \'running\'', '"state" = \'running\''),
    }),
    index('idx_maintenance_runs_one_queued', ['job_key'], {
      unique: true,
      where: raw(
        '"maintenance_runs"."state" in (\'pending\',\'deferred\')',
        "\"state\" in ('pending','deferred')",
      ),
    }),
    index('idx_maintenance_runs_admission', ['state', 'job_class', 'scheduled_at']),
    index('idx_maintenance_runs_lease', ['state', 'lease_expires_at']),
    index('idx_maintenance_runs_last', ['finished_at', 'job_key']),
  ],
  retention: retention.operational,
})

export const maintenanceRuns = materializeDrizzle(maintenanceRunsDefinition).table

const maintenanceStateDefinition = owner.table({
  id: 'maintenance_state',
  schemaSymbol: 'maintenanceState',
  columns: {
    key: c.id('key', { primary: true }),
    value: c.text('value'),
    updatedAt: c.epochMs('updated_at'),
  },
  retention: retention.operational,
})

export const maintenanceState = materializeDrizzle(maintenanceStateDefinition).table

const recoveryEventsDefinition = owner.table({
  id: 'recovery_events',
  schemaSymbol: 'recoveryEvents',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id', { nullable: true }),
    nodeRunId: c.id('node_run_id', { nullable: true }),
    actor: c.text('actor'),
    kind: c.text('kind'),
    reason: c.text('reason', { nullable: true }),
    beforeJson: c.jsonText('before_json', { nullable: true }),
    afterJson: c.jsonText('after_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('idx_recovery_events_task', ['task_id', 'created_at']),
    index('idx_recovery_events_kind', ['kind', 'created_at']),
  ],
  retention: retention.operational,
})

export const recoveryEvents = materializeDrizzle(recoveryEventsDefinition).table

export const schemaContribution = owner.contribution([
  applicationConfigurationDefinition,
  hostedDatabaseBackupsDefinition,
  hostedExecutionControlDefinition,
  lifecycleAlertsDefinition,
  lifecycleRepairAuditDefinition,
  maintenanceRunsDefinition,
  maintenanceStateDefinition,
  recoveryEventsDefinition,
])
