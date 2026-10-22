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

const owner = defineContribution('integration')

const codeHostConnectionsDefinition = owner.table({
  id: 'code_host_connections',
  schemaSymbol: 'codeHostConnections',
  columns: {
    provider: c.enum('provider', ['gitlab', 'github'], { primary: true }),
    baseUrl: c.text('base_url'),
    repositoryUrlPrefixesJson: c.jsonText('repository_url_prefixes_json', { default: '[]' }),
    transportMappingsJson: c.jsonText('transport_mappings_json', { default: '[]' }),
    connectionGeneration: c.text('connection_generation', {
      default: raw(
        '(lower(hex(randomblob(16))))',
        'md5(random()::text || clock_timestamp()::text)',
      ),
    }),
    rejectUnauthorized: c.bool('reject_unauthorized', { default: true }),
    tokenEnc: c.text('token_enc'),
    tokenHint: c.text('token_hint'),
    lastTestJson: c.jsonText('last_test_json', { nullable: true }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedBy: c.text('updated_by', { nullable: true }),
  },
  checks: [
    {
      name: 'code_host_connections_provider_enum',
      expression: raw(
        '"code_host_connections"."provider" IN (\'gitlab\', \'github\')',
        "\"provider\" IN ('gitlab', 'github')",
      ),
    },
    {
      name: 'code_host_connections_repository_url_prefixes_json_json_valid',
      expression: raw(
        'json_valid("code_host_connections"."repository_url_prefixes_json")',
        'json_valid("repository_url_prefixes_json")',
      ),
    },
    {
      name: 'code_host_connections_transport_mappings_json_json_valid',
      expression: raw(
        'json_valid("code_host_connections"."transport_mappings_json")',
        'json_valid("transport_mappings_json")',
      ),
    },
    {
      name: 'code_host_connections_connection_generation_length',
      expression: raw(
        'length("code_host_connections"."connection_generation") BETWEEN 1 AND 128',
        'length("connection_generation") BETWEEN 1 AND 128',
      ),
    },
    {
      name: 'code_host_connections_reject_unauthorized_boolean',
      expression: raw(
        '"code_host_connections"."reject_unauthorized" IN (0, 1)',
        '"reject_unauthorized" IN (FALSE, TRUE)',
      ),
    },
  ],
  retention: retention.business,
})

export const codeHostConnections = materializeDrizzle(codeHostConnectionsDefinition).table

const csEventInboxDefinition = owner.table({
  id: 'cs_event_inbox',
  schemaSymbol: 'csEventInbox',
  columns: {
    installationId: c.id('installation_id'),
    deliveryId: c.id('delivery_id'),
    logicalId: c.id('logical_id'),
    eventId: c.id('event_id'),
    producerId: c.id('producer_id'),
    eventTypeId: c.id('event_type_id'),
    payloadDigest: c.id('payload_digest'),
    payloadJson: c.jsonText('payload_json'),
    receivedAt: c.epochMs('received_at'),
    lastAttempt: c.int('last_attempt'),
    conflicts: c.int('conflicts', { default: 0 }),
  },
  primaryKey: ['installation_id', 'delivery_id'],
  retention: retention.operational,
})

export const csEventInbox = materializeDrizzle(csEventInboxDefinition).table

const csEventRoutesDefinition = owner.table({
  id: 'cs_event_routes',
  schemaSymbol: 'csEventRoutes',
  columns: {
    id: c.id('id', { primary: true }),
    installationId: c.id('installation_id'),
    producerId: c.id('producer_id'),
    eventId: c.id('event_id'),
    payloadDigest: c.id('payload_digest'),
    envelopeJson: c.jsonText('envelope_json'),
    sourceJson: c.jsonText('source_json'),
    sourceRevision: c.int('source_revision'),
    result: c.enum('result', ['routed', 'ignored']),
    createdAt: c.epochMs('created_at'),
    conflicts: c.int('conflicts', { default: 0 }),
  },
  indexes: [
    index('idx_cs_event_routes_identity', ['installation_id', 'producer_id', 'event_id'], {
      unique: true,
    }),
  ],
  retention: retention.operational,
})

export const csEventRoutes = materializeDrizzle(csEventRoutesDefinition).table

const csEventTargetsDefinition = owner.table({
  id: 'cs_event_targets',
  schemaSymbol: 'csEventTargets',
  columns: {
    id: c.id('id', { primary: true }),
    logicalId: c.id('logical_id'),
    endpointId: c.id('endpoint_id'),
    bindingRevision: c.int('binding_revision'),
    mode: c.enum('mode', ['shadow', 'crewstation']),
    stage: c.enum('stage', [
      'pending',
      'admitted',
      'completed',
      'ignored',
      'rejected',
      'source-deleted',
      'shadow',
    ]),
    deliveryId: c.id('delivery_id', { nullable: true }),
    effectId: c.id('effect_id', { nullable: true }),
    observationsJson: c.jsonText('observations_json', { nullable: true }),
    publishedJson: c.jsonText('published_json', { default: '{}' }),
    lastError: c.text('last_error', { nullable: true }),
    nextAttemptAt: c.epochMs('next_attempt_at'),
    attempts: c.int('attempts', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index('idx_cs_event_targets_identity', ['logical_id', 'endpoint_id'], { unique: true }),
    index('idx_cs_event_targets_pending', ['stage', 'next_attempt_at']),
  ],
  retention: retention.operational,
})

export const csEventTargets = materializeDrizzle(csEventTargetsDefinition).table

const csWebhookVerificationsDefinition = owner.table({
  id: 'cs_webhook_verifications',
  schemaSymbol: 'csWebhookVerifications',
  columns: {
    deliveryId: c.id('delivery_id', { primary: true }),
    transportReceiptRef: c.id('transport_receipt_ref'),
  },
  retention: retention.business,
})

export const csWebhookVerifications = materializeDrizzle(csWebhookVerificationsDefinition).table

const scheduledTasksDefinition = owner.table({
  id: 'scheduled_tasks',
  schemaSymbol: 'scheduledTasks',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    ownerUserId: c.id('owner_user_id'),
    launchKind: c.enum('launch_kind', ['workflow', 'agent', 'workgroup', 'code-round'], {
      default: 'workflow',
    }),
    launchPayload: c.text('launch_payload'),
    scheduleSpec: c.text('schedule_spec'),
    enabled: c.bool('enabled', { default: true }),
    nextRunAt: c.epochMs('next_run_at', { nullable: true }),
    lastRunAt: c.epochMs('last_run_at', { nullable: true }),
    lastStatus: c.enum('last_status', ['launched', 'failed'], { nullable: true }),
    lastError: c.text('last_error', { nullable: true }),
    lastTaskId: c.id('last_task_id', { nullable: true }),
    consecutiveFailures: c.int('consecutive_failures', { default: 0 }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  indexes: [
    index('idx_scheduled_tasks_due', ['enabled', 'next_run_at']),
    index('idx_scheduled_tasks_owner', ['owner_user_id']),
  ],
  retention: retention.business,
})

export const scheduledTasks = materializeDrizzle(scheduledTasksDefinition).table

const webhookDeliveriesDefinition = owner.table({
  id: 'webhook_deliveries',
  schemaSymbol: 'webhookDeliveries',
  columns: {
    id: c.id('id', { primary: true }),
    endpointId: c.id('endpoint_id'),
    eventUuid: c.text('event_uuid', { nullable: true }),
    attemptCount: c.int('attempt_count', { default: 1 }),
    gitlabEventHeader: c.text('gitlab_event_header', { nullable: true }),
    objectKind: c.text('object_kind', { nullable: true }),
    eventType: c.text('event_type', { nullable: true }),
    repoPath: c.text('repo_path', { nullable: true }),
    streamHint: c.text('stream_hint', { nullable: true }),
    mrFactKey: c.id('mr_fact_key', { nullable: true }),
    mrStreamKey: c.id('mr_stream_key', { nullable: true }),
    mrStreamRevision: c.int('mr_stream_revision', { nullable: true }),
    mrStateAfter: c.enum('mr_state_after', ['open', 'closed', 'merged'], { nullable: true }),
    status: c.enum('status', [
      'received',
      'processing',
      'rejected',
      'ignored',
      'matched',
      'failed',
    ]),
    statusReason: c.text('status_reason', { nullable: true }),
    replayedFromDeliveryId: c.id('replayed_from_delivery_id', { nullable: true }),
    receivedAt: c.epochMs('received_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    bodyJson: c.jsonText('body_json', { nullable: true }),
  },
  checks: [
    {
      name: 'webhook_deliveries_mr_stream_revision_positive',
      expression: raw(
        '"webhook_deliveries"."mr_stream_revision" IS NULL OR "webhook_deliveries"."mr_stream_revision" >= 1',
        '"mr_stream_revision" IS NULL OR "mr_stream_revision" >= 1',
      ),
    },
    {
      name: 'webhook_deliveries_mr_state_after_enum',
      expression: raw(
        '"webhook_deliveries"."mr_state_after" IS NULL OR "webhook_deliveries"."mr_state_after" IN (\'open\',\'closed\',\'merged\')',
        "\"mr_state_after\" IS NULL OR \"mr_state_after\" IN ('open','closed','merged')",
      ),
    },
  ],
  indexes: [
    index('idx_webhook_deliveries_dedupe', ['endpoint_id', 'event_uuid'], {
      unique: true,
      where: raw(
        '"webhook_deliveries"."event_uuid" IS NOT NULL AND "webhook_deliveries"."status" NOT IN (\'rejected\',\'failed\')',
        '"event_uuid" IS NOT NULL AND "status" NOT IN (\'rejected\',\'failed\')',
      ),
    }),
    index('idx_webhook_deliveries_mr_fact', ['endpoint_id', 'mr_fact_key'], {
      unique: true,
      where: raw(
        '"webhook_deliveries"."mr_fact_key" IS NOT NULL AND "webhook_deliveries"."replayed_from_delivery_id" IS NULL AND "webhook_deliveries"."status" NOT IN (\'rejected\',\'failed\')',
        '"mr_fact_key" IS NOT NULL AND "replayed_from_delivery_id" IS NULL AND "status" NOT IN (\'rejected\',\'failed\')',
      ),
    }),
    index('idx_webhook_deliveries_endpoint_time', ['endpoint_id', 'received_at']),
    index('idx_webhook_deliveries_received_at', ['received_at']),
    index('idx_webhook_deliveries_status_time', ['status', 'received_at']),
    index('idx_webhook_deliveries_event_time', ['event_type', 'received_at']),
    index('idx_webhook_deliveries_repo_time', ['repo_path', 'received_at']),
    index('idx_webhook_deliveries_body_retention', ['received_at'], {
      where: raw('"webhook_deliveries"."body_json" IS NOT NULL', '"body_json" IS NOT NULL'),
    }),
  ],
  retention: retention.business,
})

export const webhookDeliveries = materializeDrizzle(webhookDeliveriesDefinition).table

const webhookEndpointsDefinition = owner.table({
  id: 'webhook_endpoints',
  schemaSymbol: 'webhookEndpoints',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    provider: c.enum('provider', ['gitlab', 'github']),
    urlToken: c.text('url_token'),
    secretEnc: c.text('secret_enc'),
    enabled: c.bool('enabled', { default: true }),
    preferredCloneProtocol: c.enum('preferred_clone_protocol', ['http', 'ssh'], {
      default: 'http',
    }),
    lastDeliveryAt: c.epochMs('last_delivery_at', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  indexes: [index('idx_webhook_endpoints_url_token', ['url_token'], { unique: true })],
  retention: retention.business,
})

export const webhookEndpoints = materializeDrizzle(webhookEndpointsDefinition).table

const webhookMrControlEffectsDefinition = owner.table({
  id: 'webhook_mr_control_effects',
  schemaSymbol: 'webhookMrControlEffects',
  columns: {
    id: c.id('id', { primary: true }),
    deliveryId: c.id('delivery_id'),
    endpointId: c.id('endpoint_id'),
    streamKey: c.id('stream_key'),
    binding: c.text('binding'),
    revision: c.int('revision'),
    observedEventType: c.enum('observed_event_type', ['mr_opened', 'mr_closed', 'mr_merged']),
    kind: c.enum('kind', ['fence-closed', 'fence-merged', 'clear-closed']),
    status: c.enum('status', ['pending', 'leased', 'waiting-launches', 'retryable', 'succeeded']),
    leaseOwner: c.text('lease_owner', { nullable: true }),
    leaseExpiresAt: c.epochMs('lease_expires_at', { nullable: true }),
    attemptCount: c.int('attempt_count', { default: 0 }),
    nextAttemptAt: c.epochMs('next_attempt_at'),
    lastError: c.text('last_error', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'webhook_mr_control_effects_revision_positive',
      expression: raw('"webhook_mr_control_effects"."revision" >= 1', '"revision" >= 1'),
    },
    {
      name: 'webhook_mr_control_effects_observed_event_type_enum',
      expression: raw(
        "\"webhook_mr_control_effects\".\"observed_event_type\" IN ('mr_opened','mr_closed','mr_merged')",
        "\"observed_event_type\" IN ('mr_opened','mr_closed','mr_merged')",
      ),
    },
    {
      name: 'webhook_mr_control_effects_kind_enum',
      expression: raw(
        "\"webhook_mr_control_effects\".\"kind\" IN ('fence-closed','fence-merged','clear-closed')",
        "\"kind\" IN ('fence-closed','fence-merged','clear-closed')",
      ),
    },
    {
      name: 'webhook_mr_control_effects_status_enum',
      expression: raw(
        "\"webhook_mr_control_effects\".\"status\" IN ('pending','leased','waiting-launches','retryable','succeeded')",
        "\"status\" IN ('pending','leased','waiting-launches','retryable','succeeded')",
      ),
    },
    {
      name: 'webhook_mr_control_effects_attempt_count_nonnegative',
      expression: raw('"webhook_mr_control_effects"."attempt_count" >= 0', '"attempt_count" >= 0'),
    },
  ],
  indexes: [
    index('idx_webhook_mr_effect_delivery', ['delivery_id'], { unique: true }),
    index('idx_webhook_mr_effect_stream_revision', ['endpoint_id', 'stream_key', 'revision'], {
      unique: true,
    }),
    index('idx_webhook_mr_effect_due', ['status', 'next_attempt_at']),
  ],
  retention: retention.business,
})

export const webhookMrControlEffects = materializeDrizzle(webhookMrControlEffectsDefinition).table

const webhookMrControlTargetsDefinition = owner.table({
  id: 'webhook_mr_control_targets',
  schemaSymbol: 'webhookMrControlTargets',
  columns: {
    effectId: c.id('effect_id'),
    taskId: c.id('task_id'),
    priorStatus: c.text('prior_status', { nullable: true }),
    fenceOutcome: c.enum('fence_outcome', [
      'fenced-closed',
      'fenced-merged',
      'cleared-closed',
      'unchanged',
    ]),
    cancelOutcome: c.enum('cancel_outcome', ['canceled', 'already-terminal', 'not-applicable']),
    releaseOutcome: c.enum('release_outcome', [
      'pending',
      'no-active-owner',
      'released',
      'unreaped',
    ]),
    error: c.text('error', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['effect_id', 'task_id'],
  checks: [
    {
      name: 'webhook_mr_control_targets_fence_outcome_enum',
      expression: raw(
        "\"webhook_mr_control_targets\".\"fence_outcome\" IN ('fenced-closed','fenced-merged','cleared-closed','unchanged')",
        "\"fence_outcome\" IN ('fenced-closed','fenced-merged','cleared-closed','unchanged')",
      ),
    },
    {
      name: 'webhook_mr_control_targets_cancel_outcome_enum',
      expression: raw(
        "\"webhook_mr_control_targets\".\"cancel_outcome\" IN ('canceled','already-terminal','not-applicable')",
        "\"cancel_outcome\" IN ('canceled','already-terminal','not-applicable')",
      ),
    },
    {
      name: 'webhook_mr_control_targets_release_outcome_enum',
      expression: raw(
        "\"webhook_mr_control_targets\".\"release_outcome\" IN ('pending','no-active-owner','released','unreaped')",
        "\"release_outcome\" IN ('pending','no-active-owner','released','unreaped')",
      ),
    },
  ],
  indexes: [index('idx_webhook_mr_target_task', ['task_id'])],
  retention: retention.business,
})

export const webhookMrControlTargets = materializeDrizzle(webhookMrControlTargetsDefinition).table

const webhookMrLaunchGuardsDefinition = owner.table({
  id: 'webhook_mr_launch_guards',
  schemaSymbol: 'webhookMrLaunchGuards',
  columns: {
    id: c.id('id', { primary: true }),
    endpointId: c.id('endpoint_id'),
    streamKey: c.id('stream_key'),
    binding: c.text('binding'),
    launchRevision: c.int('launch_revision'),
    deliveryId: c.id('delivery_id'),
    fireId: c.id('fire_id', { unique: 'webhook_mr_launch_guards_fire_id_unique' }),
    triggerId: c.id('trigger_id', { nullable: true }),
    triggerNameSnapshot: c.text('trigger_name_snapshot'),
    taskId: c.id('task_id', { nullable: true }),
    launchOwnerKey: c.id('launch_owner_key', { nullable: true }),
    status: c.enum('status', [
      'reserved',
      'launching',
      'revoking-terminal',
      'task-committed',
      'launch-settled',
      'aborted-terminal',
      'failed',
    ]),
    error: c.text('error', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'webhook_mr_launch_guards_launch_revision_nonnegative',
      expression: raw(
        '"webhook_mr_launch_guards"."launch_revision" >= 0',
        '"launch_revision" >= 0',
      ),
    },
    {
      name: 'webhook_mr_launch_guards_status_enum',
      expression: raw(
        "\"webhook_mr_launch_guards\".\"status\" IN ( 'reserved','launching','revoking-terminal','task-committed', 'launch-settled','aborted-terminal','failed' )",
        "\"status\" IN ( 'reserved','launching','revoking-terminal','task-committed', 'launch-settled','aborted-terminal','failed' )",
      ),
    },
  ],
  indexes: [
    index('idx_webhook_mr_guard_stream_revision', ['endpoint_id', 'stream_key', 'launch_revision']),
    index('idx_webhook_mr_guard_task', ['task_id']),
    index('idx_webhook_mr_guard_status', ['status', 'updated_at']),
  ],
  retention: retention.business,
})

export const webhookMrLaunchGuards = materializeDrizzle(webhookMrLaunchGuardsDefinition).table

const webhookMrStreamStatesDefinition = owner.table({
  id: 'webhook_mr_stream_states',
  schemaSymbol: 'webhookMrStreamStates',
  columns: {
    endpointId: c.id('endpoint_id'),
    streamKey: c.id('stream_key'),
    projectId: c.id('project_id'),
    mrIid: c.text('mr_iid'),
    state: c.enum('state', ['open', 'closed', 'merged']),
    revision: c.int('revision'),
    lastTerminalRevision: c.int('last_terminal_revision', { nullable: true }),
    lastDeliveryId: c.id('last_delivery_id'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['endpoint_id', 'stream_key'],
  checks: [
    {
      name: 'webhook_mr_stream_states_state_enum',
      expression: raw(
        "\"webhook_mr_stream_states\".\"state\" IN ('open','closed','merged')",
        "\"state\" IN ('open','closed','merged')",
      ),
    },
    {
      name: 'webhook_mr_stream_states_revision_positive',
      expression: raw('"webhook_mr_stream_states"."revision" >= 1', '"revision" >= 1'),
    },
    {
      name: 'webhook_mr_stream_states_last_terminal_revision_positive',
      expression: raw(
        '"webhook_mr_stream_states"."last_terminal_revision" IS NULL OR "webhook_mr_stream_states"."last_terminal_revision" >= 1',
        '"last_terminal_revision" IS NULL OR "last_terminal_revision" >= 1',
      ),
    },
  ],
  indexes: [index('idx_webhook_mr_stream_endpoint_state', ['endpoint_id', 'state'])],
  retention: retention.business,
})

export const webhookMrStreamStates = materializeDrizzle(webhookMrStreamStatesDefinition).table

const webhookTriggerFiresDefinition = owner.table({
  id: 'webhook_trigger_fires',
  schemaSymbol: 'webhookTriggerFires',
  columns: {
    id: c.id('id', { primary: true }),
    deliveryId: c.id('delivery_id'),
    triggerId: c.id('trigger_id'),
    streamKey: c.id('stream_key'),
    outcome: c.enum('outcome', [
      'launched',
      'launch-failed',
      'skipped-circuit-open',
      'skipped-repo-unregistered',
      'skipped-owner-invalid',
      'skipped-trigger-disabled',
      'skipped-mr-stream-closed',
      'skipped-mr-stream-merged',
      'skipped-mr-stream-terminal',
      'skipped-mr-stream-identity-missing',
      'skipped-trigger-invalid',
      'skipped-legacy-admission-frozen',
    ]),
    supersededTaskId: c.id('superseded_task_id', { nullable: true }),
    taskId: c.id('task_id', { nullable: true }),
    employeeCaseId: c.id('employee_case_id', { nullable: true }),
    error: c.text('error', { nullable: true }),
    firedAt: c.epochMs('fired_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey(
      'webhook_trigger_fires_trigger_id_webhook_triggers_id_fk',
      ['trigger_id'],
      'webhook_triggers',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_webhook_fires_trigger_time', ['trigger_id', 'fired_at']),
    index('idx_webhook_fires_delivery', ['delivery_id']),
    index('idx_webhook_fires_stream', ['trigger_id', 'stream_key', 'fired_at']),
  ],
  retention: retention.business,
})

export const webhookTriggerFires = materializeDrizzle(webhookTriggerFiresDefinition).table

const webhookTriggerStreamsDefinition = owner.table({
  id: 'webhook_trigger_streams',
  schemaSymbol: 'webhookTriggerStreams',
  columns: {
    triggerId: c.id('trigger_id'),
    streamKey: c.id('stream_key'),
    consecutiveFires: c.int('consecutive_fires', { default: 0 }),
    lastFireAt: c.epochMs('last_fire_at', { nullable: true }),
    resetAt: c.epochMs('reset_at', { nullable: true }),
    resetBy: c.text('reset_by', { nullable: true }),
  },
  primaryKey: ['trigger_id', 'stream_key'],
  foreignKeys: [
    foreignKey(
      'webhook_trigger_streams_trigger_id_webhook_triggers_id_fk',
      ['trigger_id'],
      'webhook_triggers',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  retention: retention.business,
})

export const webhookTriggerStreams = materializeDrizzle(webhookTriggerStreamsDefinition).table

const webhookTriggersDefinition = owner.table({
  id: 'webhook_triggers',
  schemaSymbol: 'webhookTriggers',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    endpointId: c.id('endpoint_id'),
    ownerUserId: c.id('owner_user_id'),
    enabled: c.bool('enabled', { default: true }),
    repoScope: c.text('repo_scope'),
    eventTypes: c.text('event_types'),
    branchFilter: c.text('branch_filter', { nullable: true }),
    commandPrefix: c.text('command_prefix', { nullable: true }),
    ignoreUsernames: c.text('ignore_usernames', { default: '[]' }),
    launchKind: c.enum('launch_kind', [
      'workflow',
      'agent',
      'workgroup',
      'digital-employee',
      'code-round',
    ]),
    launchRefId: c.id('launch_ref_id'),
    launchPayload: c.text('launch_payload'),
    templateSyntaxVersion: c.int('template_syntax_version', { default: 1 }),
    maxConsecutiveFires: c.int('max_consecutive_fires', { default: 3 }),
    autoRegisterRepos: c.bool('auto_register_repos', { default: true }),
    cancelOnMrTerminal: c.bool('cancel_on_mr_terminal', { default: false }),
    lastFiredAt: c.epochMs('last_fired_at', { nullable: true }),
    lastStatus: c.enum('last_status', ['launched', 'failed'], { nullable: true }),
    lastError: c.text('last_error', { nullable: true }),
    lastTaskId: c.id('last_task_id', { nullable: true }),
    consecutiveFailures: c.int('consecutive_failures', { default: 0 }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey(
      'webhook_triggers_endpoint_id_webhook_endpoints_id_fk',
      ['endpoint_id'],
      'webhook_endpoints',
      ['id'],
    ),
  ],
  checks: [
    {
      name: 'webhook_triggers_cancel_on_mr_terminal_boolean',
      expression: raw(
        '"webhook_triggers"."cancel_on_mr_terminal" IN (0, 1)',
        '"cancel_on_mr_terminal" IN (FALSE, TRUE)',
      ),
    },
  ],
  indexes: [
    index('idx_webhook_triggers_endpoint_enabled', ['endpoint_id', 'enabled']),
    index('idx_webhook_triggers_owner', ['owner_user_id']),
  ],
  retention: retention.business,
})

export const webhookTriggers = materializeDrizzle(webhookTriggersDefinition).table

export const schemaContribution = owner.contribution([
  codeHostConnectionsDefinition,
  csEventInboxDefinition,
  csEventRoutesDefinition,
  csEventTargetsDefinition,
  csWebhookVerificationsDefinition,
  scheduledTasksDefinition,
  webhookDeliveriesDefinition,
  webhookEndpointsDefinition,
  webhookMrControlEffectsDefinition,
  webhookMrControlTargetsDefinition,
  webhookMrLaunchGuardsDefinition,
  webhookMrStreamStatesDefinition,
  webhookTriggerFiresDefinition,
  webhookTriggerStreamsDefinition,
  webhookTriggersDefinition,
])
