// RFC-395 activation: this context declares the live epoch-2 schema directly.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'

const owner = defineContribution('task-execution')

const hostedExecutionBindingsDefinition = owner.table({
  id: 'hosted_execution_bindings',
  schemaSymbol: 'hostedExecutionBindings',
  columns: {
    executionId: c.id('execution_id', { primary: true }),
    taskId: c.id('task_id'),
    nodeRunId: c.id('node_run_id', { nullable: true }),
    kind: c.enum('kind', ['agent', 'command']),
    businessTaskId: c.id('business_task_id'),
    requestKey: c.id('request_key'),
    requestJson: c.jsonText('request_json'),
    subtaskId: c.id('subtask_id', { nullable: true }),
    attempt: c.int('attempt', { nullable: true }),
    materialDigest: c.id('material_digest', { nullable: true }),
    lastCursor: c.text('last_cursor', { nullable: true }),
    resultJson: c.jsonText('result_json', { nullable: true }),
    cancelRequested: c.bool('cancel_requested', { default: false }),
    cancelReason: c.enum('cancel_reason', ['user', 'timeout', 'restored'], { nullable: true }),
    state: c.enum('state', ['submitting', 'running', 'settled']),
    epoch: c.int('epoch'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_execution_bindings_kind_known',
      expression: raw(
        '"hosted_execution_bindings"."kind" IN (\'agent\', \'command\')',
        "\"kind\" IN ('agent', 'command')",
      ),
    },
    {
      name: 'hosted_execution_bindings_state_known',
      expression: raw(
        "\"hosted_execution_bindings\".\"state\" IN ('submitting', 'running', 'settled')",
        "\"state\" IN ('submitting', 'running', 'settled')",
      ),
    },
  ],
  indexes: [
    index('idx_hosted_execution_bindings_state', ['state']),
    index('idx_hosted_execution_bindings_task', ['task_id']),
  ],
  retention: retention.business,
})

export const hostedExecutionBindings = materializeDrizzle(hostedExecutionBindingsDefinition).table

const hostedExecutionEventsDefinition = owner.table({
  id: 'hosted_execution_events',
  schemaSymbol: 'hostedExecutionEvents',
  columns: {
    id: c.identity('id', { primary: true }),
    executionId: c.id('execution_id'),
    cursor: c.text('cursor'),
    eventJson: c.jsonText('event_json'),
  },
  foreignKeys: [
    foreignKey(
      'hosted_execution_events_execution_id_hosted_execution_bindings_execution_id_fk',
      ['execution_id'],
      'hosted_execution_bindings',
      ['execution_id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_hosted_execution_event_cursor', ['execution_id', 'cursor'], { unique: true }),
    index('idx_hosted_execution_event_replay', ['execution_id', 'id']),
  ],
  retention: retention.operational,
})

export const hostedExecutionEvents = materializeDrizzle(hostedExecutionEventsDefinition).table

const nodeExecutionEventSourcesDefinition = owner.table({
  id: 'node_execution_event_sources',
  schemaSymbol: 'nodeExecutionEventSources',
  columns: {
    sourceKey: c.id('source_key', { primary: true }),
    nodeRunId: c.id('node_run_id'),
  },
  foreignKeys: [
    foreignKey(
      'node_execution_event_sources_node_run_id_node_runs_id_fk',
      ['node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  retention: retention.operational,
})

export const nodeExecutionEventSources = materializeDrizzle(
  nodeExecutionEventSourcesDefinition,
).table

const nodeRunEventsDefinition = owner.table({
  id: 'node_run_events',
  schemaSymbol: 'nodeRunEvents',
  columns: {
    id: c.identity('id', { primary: true }),
    nodeRunId: c.id('node_run_id'),
    ts: c.int('ts'),
    kind: c.enum('kind', [
      'tool_use',
      'text',
      'reasoning',
      'permission_asked',
      'error',
      'step_start',
      'step_finish',
      'stderr',
      'subagent_capture_failed',
    ]),
    payload: c.text('payload'),
    sessionId: c.id('session_id', { nullable: true }),
    parentSessionId: c.id('parent_session_id', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'node_run_events_node_run_id_node_runs_id_fk',
      ['node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_events_node', ['node_run_id', 'id']),
    index('idx_events_session', ['node_run_id', 'session_id', 'id']),
  ],
  retention: retention.operational,
})

export const nodeRunEvents = materializeDrizzle(nodeRunEventsDefinition).table

const nodeRunSeqAllocationsDefinition = owner.table({
  id: 'node_run_seq_allocations',
  schemaSymbol: 'nodeRunSeqAllocations',
  columns: {
    seq: c.identity('seq', { primary: true }),
    taskId: c.id('task_id'),
    nodeRunId: c.id('node_run_id'),
    allocatedAt: c.epochMs('allocated_at'),
  },
  retention: retention.business,
})

export const nodeRunSeqAllocations = materializeDrizzle(nodeRunSeqAllocationsDefinition).table

const hostedRecoveryRequestsDefinition = owner.table({
  id: 'hosted_recovery_requests',
  schemaSymbol: 'hostedRecoveryRequests',
  columns: {
    requestId: c.id('request_id', { primary: true }),
    requestJson: c.jsonText('request_json'),
    businessTaskId: c.id('business_task_id'),
    taskId: c.id('task_id', { nullable: true }),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    state: c.enum('state', ['admitted', 'executing', 'succeeded', 'failed', 'rejected']),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    reason: c.text('reason', { nullable: true }),
    epoch: c.int('epoch'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_recovery_requests_state_known',
      expression: raw(
        "\"hosted_recovery_requests\".\"state\" IN ('admitted', 'executing', 'succeeded', 'failed', 'rejected')",
        "\"state\" IN ('admitted', 'executing', 'succeeded', 'failed', 'rejected')",
      ),
    },
  ],
  indexes: [
    index('hosted_recovery_requests_state', ['state', 'created_at']),
    index('hosted_recovery_requests_task', ['task_id', 'created_at']),
  ],
  retention: retention.business,
})

export const hostedRecoveryRequests = materializeDrizzle(hostedRecoveryRequestsDefinition).table

const reactionExecutionAdmissionsDefinition = owner.table({
  id: 'reaction_execution_admissions',
  schemaSymbol: 'reactionExecutionAdmissions',
  columns: {
    operationRef: c.id('operation_ref', { primary: true }),
    caseId: c.id('case_id'),
    roundRef: c.id('round_ref'),
    claimEpoch: c.int('claim_epoch'),
    fenceRevision: c.int('fence_revision'),
    requestHash: c.text('request_hash'),
    authoritySubject: c.text('authority_subject'),
    authorityRevision: c.int('authority_revision'),
    executionRef: c.id('execution_ref'),
    state: c.enum('state', ['admitted', 'launched', 'closed'], { default: 'admitted' }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index('idx_reaction_execution_admissions_round', ['round_ref', 'claim_epoch']),
    index('idx_reaction_execution_admissions_execution', ['execution_ref']),
  ],
  retention: retention.business,
})

export const reactionExecutionAdmissions = materializeDrizzle(
  reactionExecutionAdmissionsDefinition,
).table

const taskArchiveAuditDefinition = owner.table({
  id: 'task_archive_audit',
  schemaSymbol: 'taskArchiveAudit',
  columns: {
    id: c.id('id', { primary: true }),
    source: c.text('source'),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    retentionDays: c.int('retention_days'),
    treeCount: c.int('tree_count'),
    taskCount: c.int('task_count'),
    skippedCount: c.int('skipped_count'),
    rootTaskIdsJson: c.jsonText('root_task_ids_json'),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [index('idx_task_archive_audit_created', ['created_at'])],
  retention: retention.operational,
})

export const taskArchiveAudit = materializeDrizzle(taskArchiveAuditDefinition).table

const taskExecutionEffectAttemptsDefinition = owner.table({
  id: 'task_execution_effect_attempts',
  schemaSymbol: 'taskExecutionEffectAttempts',
  columns: {
    id: c.id('id', { primary: true }),
    effectId: c.id('effect_id'),
    attemptNo: c.int('attempt_no'),
    intentId: c.id('intent_id'),
    epoch: c.int('epoch'),
    state: c.enum('state', [
      'prepared',
      'acting',
      'succeeded',
      'failed-not-applied',
      'retry-authorized',
      'recovery-required',
      'outcome-unknown',
    ]),
    candidateId: c.id('candidate_id'),
    requestHash: c.text('request_hash'),
    recoveryClass: c.text('recovery_class'),
    recoveryDescriptorJson: c.jsonText('recovery_descriptor_json', { nullable: true }),
    classifierVersion: c.text('classifier_version'),
    transportPolicyVersion: c.text('transport_policy_version'),
    applicationEvidence: c.enum(
      'application_evidence',
      ['applied', 'definitely-not-applied', 'ambiguous'],
      { nullable: true },
    ),
    retryAuthority: c.enum('retry_authority', ['none', 'probe', 'convergent', 'transport-policy'], {
      default: 'none',
    }),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    preparedAt: c.epochMs('prepared_at'),
    actingAt: c.epochMs('acting_at', { nullable: true }),
    settledAt: c.epochMs('settled_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'task_execution_effect_attempts_effect_id_task_execution_effects_id_fk',
      ['effect_id'],
      'task_execution_effects',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey(
      'task_execution_effect_attempts_intent_id_task_execution_intents_id_fk',
      ['intent_id'],
      'task_execution_intents',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'task_execution_attempts_no_positive',
      expression: raw('"task_execution_effect_attempts"."attempt_no" > 0', '"attempt_no" > 0'),
    },
    {
      name: 'task_execution_attempts_epoch_positive',
      expression: raw('"task_execution_effect_attempts"."epoch" > 0', '"epoch" > 0'),
    },
    {
      name: 'task_execution_effect_attempts_state_enum',
      expression: raw(
        "\"task_execution_effect_attempts\".\"state\" IN ('prepared','acting','succeeded','failed-not-applied','retry-authorized','recovery-required','outcome-unknown')",
        "\"state\" IN ('prepared','acting','succeeded','failed-not-applied','retry-authorized','recovery-required','outcome-unknown')",
      ),
    },
    {
      name: 'task_execution_effect_attempts_recovery_descriptor_json_json_valid',
      expression: raw(
        '"task_execution_effect_attempts"."recovery_descriptor_json" IS NULL OR json_valid("task_execution_effect_attempts"."recovery_descriptor_json")',
        '"recovery_descriptor_json" IS NULL OR json_valid("recovery_descriptor_json")',
      ),
    },
    {
      name: 'task_execution_effect_attempts_application_evidence_enum',
      expression: raw(
        '"task_execution_effect_attempts"."application_evidence" IS NULL OR "task_execution_effect_attempts"."application_evidence" IN (\'applied\',\'definitely-not-applied\',\'ambiguous\')',
        "\"application_evidence\" IS NULL OR \"application_evidence\" IN ('applied','definitely-not-applied','ambiguous')",
      ),
    },
    {
      name: 'task_execution_effect_attempts_retry_authority_enum',
      expression: raw(
        "\"task_execution_effect_attempts\".\"retry_authority\" IN ('none','probe','convergent','transport-policy')",
        "\"retry_authority\" IN ('none','probe','convergent','transport-policy')",
      ),
    },
    {
      name: 'task_execution_effect_attempts_receipt_json_json_valid',
      expression: raw(
        '"task_execution_effect_attempts"."receipt_json" IS NULL OR json_valid("task_execution_effect_attempts"."receipt_json")',
        '"receipt_json" IS NULL OR json_valid("receipt_json")',
      ),
    },
  ],
  indexes: [
    index('idx_task_execution_attempts_effect_no', ['effect_id', 'attempt_no'], { unique: true }),
    index('idx_task_execution_attempts_one_active', ['effect_id'], {
      unique: true,
      where: raw(
        "\"task_execution_effect_attempts\".\"state\" IN ('prepared', 'acting', 'recovery-required')",
        "\"state\" IN ('prepared', 'acting', 'recovery-required')",
      ),
    }),
  ],
  retention: retention.operational,
})

export const taskExecutionEffectAttempts = materializeDrizzle(
  taskExecutionEffectAttemptsDefinition,
).table

const taskExecutionEffectFencesDefinition = owner.table({
  id: 'task_execution_effect_fences',
  schemaSymbol: 'taskExecutionEffectFences',
  columns: {
    effectAttemptId: c.id('effect_attempt_id'),
    fenceKey: c.id('fence_key'),
    acquiredEpoch: c.int('acquired_epoch'),
    acquiredAt: c.epochMs('acquired_at'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
  },
  primaryKey: ['effect_attempt_id', 'fence_key'],
  foreignKeys: [
    foreignKey(
      'task_execution_effect_fences_effect_attempt_id_task_execution_effect_attempts_id_fk',
      ['effect_attempt_id'],
      'task_execution_effect_attempts',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'task_execution_effect_fences_epoch_positive',
      expression: raw(
        '"task_execution_effect_fences"."acquired_epoch" > 0',
        '"acquired_epoch" > 0',
      ),
    },
  ],
  indexes: [
    index('idx_task_execution_effect_fences_active_key', ['fence_key'], {
      unique: true,
      where: raw('"task_execution_effect_fences"."released_at" IS NULL', '"released_at" IS NULL'),
    }),
  ],
  retention: retention.business,
})

export const taskExecutionEffectFences = materializeDrizzle(
  taskExecutionEffectFencesDefinition,
).table

const taskExecutionEffectsDefinition = owner.table({
  id: 'task_execution_effects',
  schemaSymbol: 'taskExecutionEffects',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    originIntentId: c.id('origin_intent_id'),
    currentIntentId: c.id('current_intent_id'),
    operationKey: c.id('operation_key'),
    executionLineageId: c.id('execution_lineage_id'),
    operationFamilyKey: c.id('operation_family_key'),
    operationGeneration: c.int('operation_generation'),
    kind: c.enum('kind', [
      'workspace-prepare',
      'workspace-rollback',
      'isolation-create',
      'isolation-merge',
      'repository',
      'process',
      'workspace-cleanup',
      'code-host-mutation',
      'outbound-mutation',
    ]),
    requestHash: c.text('request_hash'),
    slotPathJson: c.jsonText('slot_path_json'),
    slotPathDigest: c.id('slot_path_digest'),
    state: c.enum('state', ['open', 'succeeded', 'failed', 'outcome-unknown']),
    lastAttemptNo: c.int('last_attempt_no', { default: 0 }),
    receiptJson: c.jsonText('receipt_json', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    preparedAt: c.epochMs('prepared_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey('task_execution_effects_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'task_execution_effects_origin_intent_id_task_execution_intents_id_fk',
      ['origin_intent_id'],
      'task_execution_intents',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey(
      'task_execution_effects_current_intent_id_task_execution_intents_id_fk',
      ['current_intent_id'],
      'task_execution_intents',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  checks: [
    {
      name: 'task_execution_effects_generation_nonnegative',
      expression: raw(
        '"task_execution_effects"."operation_generation" >= 0',
        '"operation_generation" >= 0',
      ),
    },
    {
      name: 'task_execution_effects_kind_enum',
      expression: raw(
        "\"task_execution_effects\".\"kind\" IN ('workspace-prepare','workspace-rollback','isolation-create','isolation-merge','repository','process','workspace-cleanup','code-host-mutation','outbound-mutation')",
        "\"kind\" IN ('workspace-prepare','workspace-rollback','isolation-create','isolation-merge','repository','process','workspace-cleanup','code-host-mutation','outbound-mutation')",
      ),
    },
    {
      name: 'task_execution_effects_slot_path_json_json_valid',
      expression: raw(
        'json_valid("task_execution_effects"."slot_path_json")',
        'json_valid("slot_path_json")',
      ),
    },
    {
      name: 'task_execution_effects_state_enum',
      expression: raw(
        "\"task_execution_effects\".\"state\" IN ('open','succeeded','failed','outcome-unknown')",
        "\"state\" IN ('open','succeeded','failed','outcome-unknown')",
      ),
    },
    {
      name: 'task_execution_effects_last_attempt_no_nonnegative',
      expression: raw('"task_execution_effects"."last_attempt_no" >= 0', '"last_attempt_no" >= 0'),
    },
    {
      name: 'task_execution_effects_receipt_json_json_valid',
      expression: raw(
        '"task_execution_effects"."receipt_json" IS NULL OR json_valid("task_execution_effects"."receipt_json")',
        '"receipt_json" IS NULL OR json_valid("receipt_json")',
      ),
    },
  ],
  indexes: [
    index(
      'idx_task_execution_effects_task_operation_generation',
      ['task_id', 'operation_key', 'operation_generation'],
      { unique: true },
    ),
    index(
      'idx_task_execution_effects_lineage_family_generation',
      ['execution_lineage_id', 'operation_family_key', 'operation_generation'],
      { unique: true },
    ),
    index('idx_task_execution_effects_task_state', ['task_id', 'state']),
  ],
  retention: retention.business,
})

export const taskExecutionEffects = materializeDrizzle(taskExecutionEffectsDefinition).table

const taskExecutionIntentsDefinition = owner.table({
  id: 'task_execution_intents',
  schemaSymbol: 'taskExecutionIntents',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    kind: c.enum('kind', [
      'launch',
      'resume',
      'retry-repository-preparation',
      'retry-node',
      'sync-workflow',
      'gate-continuation',
      'recovery',
    ]),
    state: c.enum('state', ['pending', 'claimed', 'completed', 'canceled', 'failed']),
    source: c.enum('source', ['rest', 'mcp', 'scheduler', 'auto', 'boot', 'internal']),
    requestHash: c.text('request_hash'),
    payloadJson: c.jsonText('payload_json', { default: '{}' }),
    executionLineageId: c.id('execution_lineage_id'),
    continuationSlotKey: c.id('continuation_slot_key'),
    slotPathJson: c.jsonText('slot_path_json'),
    operationGeneration: c.int('operation_generation', { default: 0 }),
    replayAuthorizationId: c.id('replay_authorization_id', { nullable: true }),
    authorizationScopeJson: c.jsonText('authorization_scope_json', { nullable: true }),
    expectedTaskRevision: c.int('expected_task_revision'),
    claimedEpoch: c.int('claimed_epoch', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    claimedAt: c.epochMs('claimed_at', { nullable: true }),
    completedAt: c.epochMs('completed_at', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey('task_execution_intents_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'task_execution_intents_generation_nonnegative',
      expression: raw(
        '"task_execution_intents"."operation_generation" >= 0',
        '"operation_generation" >= 0',
      ),
    },
    {
      name: 'task_execution_intents_kind_enum',
      expression: raw(
        "\"task_execution_intents\".\"kind\" IN ('launch','resume','retry-repository-preparation','retry-node','sync-workflow','gate-continuation','recovery')",
        "\"kind\" IN ('launch','resume','retry-repository-preparation','retry-node','sync-workflow','gate-continuation','recovery')",
      ),
    },
    {
      name: 'task_execution_intents_state_enum',
      expression: raw(
        "\"task_execution_intents\".\"state\" IN ('pending','claimed','completed','canceled','failed')",
        "\"state\" IN ('pending','claimed','completed','canceled','failed')",
      ),
    },
    {
      name: 'task_execution_intents_source_enum',
      expression: raw(
        "\"task_execution_intents\".\"source\" IN ('rest','mcp','scheduler','auto','boot','internal')",
        "\"source\" IN ('rest','mcp','scheduler','auto','boot','internal')",
      ),
    },
    {
      name: 'task_execution_intents_payload_json_json_valid',
      expression: raw(
        'json_valid("task_execution_intents"."payload_json")',
        'json_valid("payload_json")',
      ),
    },
    {
      name: 'task_execution_intents_slot_path_json_json_valid',
      expression: raw(
        'json_valid("task_execution_intents"."slot_path_json")',
        'json_valid("slot_path_json")',
      ),
    },
    {
      name: 'task_execution_intents_authorization_scope_json_json_valid',
      expression: raw(
        '"task_execution_intents"."authorization_scope_json" IS NULL OR json_valid("task_execution_intents"."authorization_scope_json")',
        '"authorization_scope_json" IS NULL OR json_valid("authorization_scope_json")',
      ),
    },
    {
      name: 'task_execution_intents_claimed_epoch_positive',
      expression: raw(
        '"task_execution_intents"."claimed_epoch" IS NULL OR "task_execution_intents"."claimed_epoch" > 0',
        '"claimed_epoch" IS NULL OR "claimed_epoch" > 0',
      ),
    },
  ],
  indexes: [
    index('idx_task_execution_intents_task_state', ['task_id', 'state']),
    index('idx_task_execution_intents_pending_task', ['task_id'], {
      unique: true,
      where: raw('"task_execution_intents"."state" = \'pending\'', '"state" = \'pending\''),
    }),
    index('idx_task_execution_intents_claimed_task', ['task_id'], {
      unique: true,
      where: raw('"task_execution_intents"."state" = \'claimed\'', '"state" = \'claimed\''),
    }),
  ],
  retention: retention.business,
})

export const taskExecutionIntents = materializeDrizzle(taskExecutionIntentsDefinition).table

const taskExecutionLineageOperationRecordsDefinition = owner.table({
  id: 'task_execution_lineage_operation_records',
  schemaSymbol: 'taskExecutionLineageOperationRecords',
  columns: {
    id: c.id('id', { primary: true }),
    recordKind: c.enum('record_kind', ['generation-watermark', 'replay-decision']),
    executionLineageId: c.id('execution_lineage_id'),
    operationFamilyKey: c.id('operation_family_key'),
    operationGeneration: c.int('operation_generation', { nullable: true }),
    highestSettledGeneration: c.int('highest_settled_generation', { nullable: true }),
    lastOutcome: c.text('last_outcome', { nullable: true }),
    requestHash: c.text('request_hash'),
    slotPathJson: c.jsonText('slot_path_json'),
    slotPathDigest: c.id('slot_path_digest'),
    rootAnchorTaskId: c.id('root_anchor_task_id', { nullable: true }),
    ancestorAnchorTaskId: c.id('ancestor_anchor_task_id', { nullable: true }),
    currentAnchorTaskId: c.id('current_anchor_task_id', { nullable: true }),
    sourceTaskId: c.id('source_task_id', { nullable: true }),
    sourceEffectId: c.id('source_effect_id', { nullable: true }),
    sourceAttemptId: c.id('source_attempt_id', { nullable: true }),
    providerCoordinateJson: c.jsonText('provider_coordinate_json', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    decisionState: c.enum(
      'decision_state',
      [
        'requires-actor',
        'actor-replay-authorized',
        'actor-replay-authorized-suspended',
        'consumed',
      ],
      { nullable: true },
    ),
    replayAuthorizationId: c.id('replay_authorization_id', { nullable: true }),
    authorizationScopeJson: c.jsonText('authorization_scope_json', { nullable: true }),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    authorizationSource: c.text('authorization_source', { nullable: true }),
    boundIntentId: c.id('bound_intent_id', { nullable: true }),
    newEffectId: c.id('new_effect_id', { nullable: true }),
    recordRevision: c.int('record_revision'),
    compacted: c.bool('compacted', { default: false }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'task_execution_lineage_revision_positive',
      expression: raw(
        '"task_execution_lineage_operation_records"."record_revision" > 0',
        '"record_revision" > 0',
      ),
    },
    {
      name: 'task_execution_lineage_record_shape',
      expression: raw(
        '(\n        ("task_execution_lineage_operation_records"."record_kind" = \'generation-watermark\'\n          AND "task_execution_lineage_operation_records"."highest_settled_generation" IS NOT NULL\n          AND "task_execution_lineage_operation_records"."highest_settled_generation" >= 0\n          AND "task_execution_lineage_operation_records"."operation_generation" IS NULL\n          AND "task_execution_lineage_operation_records"."decision_state" IS NULL)\n        OR\n        ("task_execution_lineage_operation_records"."record_kind" = \'replay-decision\'\n          AND "task_execution_lineage_operation_records"."operation_generation" IS NOT NULL\n          AND "task_execution_lineage_operation_records"."operation_generation" >= 0\n          AND "task_execution_lineage_operation_records"."highest_settled_generation" IS NULL\n          AND "task_execution_lineage_operation_records"."decision_state" IS NOT NULL)\n      )',
        '( ("record_kind" = \'generation-watermark\' AND "highest_settled_generation" IS NOT NULL AND "highest_settled_generation" >= 0 AND "operation_generation" IS NULL AND "decision_state" IS NULL) OR ("record_kind" = \'replay-decision\' AND "operation_generation" IS NOT NULL AND "operation_generation" >= 0 AND "highest_settled_generation" IS NULL AND "decision_state" IS NOT NULL) )',
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_record_kind_enum',
      expression: raw(
        '"task_execution_lineage_operation_records"."record_kind" IN (\'generation-watermark\',\'replay-decision\')',
        "\"record_kind\" IN ('generation-watermark','replay-decision')",
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_slot_path_json_json_valid',
      expression: raw(
        'json_valid("task_execution_lineage_operation_records"."slot_path_json")',
        'json_valid("slot_path_json")',
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_provider_coordinate_json_json_valid',
      expression: raw(
        '"task_execution_lineage_operation_records"."provider_coordinate_json" IS NULL OR json_valid("task_execution_lineage_operation_records"."provider_coordinate_json")',
        '"provider_coordinate_json" IS NULL OR json_valid("provider_coordinate_json")',
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_decision_state_enum',
      expression: raw(
        '"task_execution_lineage_operation_records"."decision_state" IS NULL OR "task_execution_lineage_operation_records"."decision_state" IN (\'requires-actor\',\'actor-replay-authorized\',\'actor-replay-authorized-suspended\',\'consumed\')',
        "\"decision_state\" IS NULL OR \"decision_state\" IN ('requires-actor','actor-replay-authorized','actor-replay-authorized-suspended','consumed')",
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_authorization_scope_json_json_valid',
      expression: raw(
        '"task_execution_lineage_operation_records"."authorization_scope_json" IS NULL OR json_valid("task_execution_lineage_operation_records"."authorization_scope_json")',
        '"authorization_scope_json" IS NULL OR json_valid("authorization_scope_json")',
      ),
    },
    {
      name: 'task_execution_lineage_operation_records_compacted_boolean',
      expression: raw(
        '"task_execution_lineage_operation_records"."compacted" IN (0,1)',
        '"compacted" IN (FALSE, TRUE)',
      ),
    },
  ],
  indexes: [
    index(
      'idx_task_execution_lineage_watermark',
      ['execution_lineage_id', 'operation_family_key'],
      {
        unique: true,
        where: raw(
          '"task_execution_lineage_operation_records"."record_kind" = \'generation-watermark\'',
          '"record_kind" = \'generation-watermark\'',
        ),
      },
    ),
    index(
      'idx_task_execution_lineage_decision',
      ['execution_lineage_id', 'operation_family_key', 'operation_generation'],
      {
        unique: true,
        where: raw(
          '"task_execution_lineage_operation_records"."record_kind" = \'replay-decision\'',
          '"record_kind" = \'replay-decision\'',
        ),
      },
    ),
    index('idx_task_execution_lineage_decision_state', [
      'record_kind',
      'decision_state',
      'updated_at',
    ]),
  ],
  retention: retention.operational,
})

export const taskExecutionLineageOperationRecords = materializeDrizzle(
  taskExecutionLineageOperationRecordsDefinition,
).table

const taskExecutionMaintenanceClaimsDefinition = owner.table({
  id: 'task_execution_maintenance_claims',
  schemaSymbol: 'taskExecutionMaintenanceClaims',
  columns: {
    id: c.id('id', { primary: true }),
    rootTaskId: c.id('root_task_id'),
    operation: c.enum('operation', [
      'archive',
      'delete',
      'retention',
      'workspace-gc',
      'repair-metadata',
    ]),
    state: c.enum('state', [
      'claimed',
      'io-complete',
      'db-finalized',
      'cleanup-pending',
      'completed',
      'recovery-required',
    ]),
    memberSetDigest: c.id('member_set_digest'),
    expectedTreeDigest: c.id('expected_tree_digest'),
    revision: c.int('revision'),
    cleanupPlanJson: c.jsonText('cleanup_plan_json'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    completedAt: c.epochMs('completed_at', { nullable: true }),
  },
  checks: [
    {
      name: 'task_execution_maintenance_revision_positive',
      expression: raw('"task_execution_maintenance_claims"."revision" > 0', '"revision" > 0'),
    },
    {
      name: 'task_execution_maintenance_claims_operation_enum',
      expression: raw(
        "\"task_execution_maintenance_claims\".\"operation\" IN ('archive','delete','retention','workspace-gc','repair-metadata')",
        "\"operation\" IN ('archive','delete','retention','workspace-gc','repair-metadata')",
      ),
    },
    {
      name: 'task_execution_maintenance_claims_state_enum',
      expression: raw(
        "\"task_execution_maintenance_claims\".\"state\" IN ('claimed','io-complete','db-finalized','cleanup-pending','completed','recovery-required')",
        "\"state\" IN ('claimed','io-complete','db-finalized','cleanup-pending','completed','recovery-required')",
      ),
    },
    {
      name: 'task_execution_maintenance_claims_cleanup_plan_json_json_valid',
      expression: raw(
        'json_valid("task_execution_maintenance_claims"."cleanup_plan_json")',
        'json_valid("cleanup_plan_json")',
      ),
    },
  ],
  indexes: [index('idx_task_execution_maintenance_state_updated', ['state', 'updated_at'])],
  retention: retention.operational,
})

export const taskExecutionMaintenanceClaims = materializeDrizzle(
  taskExecutionMaintenanceClaimsDefinition,
).table

const taskExecutionMaintenanceMembersDefinition = owner.table({
  id: 'task_execution_maintenance_members',
  schemaSymbol: 'taskExecutionMaintenanceMembers',
  columns: {
    claimId: c.id('claim_id'),
    taskId: c.id('task_id'),
    expectedTaskRevision: c.int('expected_task_revision'),
    expectedOwnerRevision: c.int('expected_owner_revision', { nullable: true }),
    expectedTopologyRevision: c.int('expected_topology_revision'),
    expectedLedgerDigest: c.id('expected_ledger_digest'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
  },
  primaryKey: ['claim_id', 'task_id'],
  foreignKeys: [
    foreignKey(
      'task_execution_maintenance_members_claim_id_task_execution_maintenance_claims_id_fk',
      ['claim_id'],
      'task_execution_maintenance_claims',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [
    index('idx_task_execution_maintenance_members_active_task', ['task_id'], {
      unique: true,
      where: raw(
        '"task_execution_maintenance_members"."released_at" IS NULL',
        '"released_at" IS NULL',
      ),
    }),
  ],
  retention: retention.operational,
})

export const taskExecutionMaintenanceMembers = materializeDrizzle(
  taskExecutionMaintenanceMembersDefinition,
).table

const taskExecutionOwnersDefinition = owner.table({
  id: 'task_execution_owners',
  schemaSymbol: 'taskExecutionOwners',
  columns: {
    taskId: c.id('task_id', { primary: true }),
    ownerId: c.id('owner_id'),
    daemonGeneration: c.text('daemon_generation'),
    epoch: c.int('epoch'),
    state: c.enum('state', ['claimed', 'revoked', 'released', 'recovery-required']),
    leaseUntil: c.epochMs('lease_until'),
    revision: c.int('revision'),
    lastHeartbeatAt: c.epochMs('last_heartbeat_at'),
    recoveryCode: c.text('recovery_code', { nullable: true }),
    recoveryProofDigest: c.id('recovery_proof_digest', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey('task_execution_owners_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'task_execution_owners_epoch_positive',
      expression: raw('"task_execution_owners"."epoch" > 0', '"epoch" > 0'),
    },
    {
      name: 'task_execution_owners_revision_positive',
      expression: raw('"task_execution_owners"."revision" > 0', '"revision" > 0'),
    },
    {
      name: 'task_execution_owners_state_enum',
      expression: raw(
        "\"task_execution_owners\".\"state\" IN ('claimed','revoked','released','recovery-required')",
        "\"state\" IN ('claimed','revoked','released','recovery-required')",
      ),
    },
  ],
  indexes: [index('idx_task_execution_owners_state_lease', ['state', 'lease_until'])],
  retention: retention.business,
})

export const taskExecutionOwners = materializeDrizzle(taskExecutionOwnersDefinition).table

const taskNodeClarifyDirectivesDefinition = owner.table({
  id: 'task_node_clarify_directives',
  schemaSymbol: 'taskNodeClarifyDirectives',
  columns: {
    taskId: c.id('task_id'),
    nodeId: c.id('node_id'),
    shardKey: c.id('shard_key', { default: '' }),
    directive: c.enum('directive', ['continue', 'stop']),
    setBy: c.text('set_by', { nullable: true }),
    updatedAt: c.epochMs('updated_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  primaryKey: ['task_id', 'node_id', 'shard_key'],
  foreignKeys: [
    foreignKey('task_node_clarify_directives_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [index('idx_task_node_clarify_directives_task', ['task_id'])],
  retention: retention.business,
})

export const taskNodeClarifyDirectives = materializeDrizzle(
  taskNodeClarifyDirectivesDefinition,
).table

const taskWorkspacePreparationsDefinition = owner.table({
  id: 'task_workspace_preparations',
  schemaSymbol: 'taskWorkspacePreparations',
  columns: {
    id: c.id('id', { primary: true }),
    admissionKey: c.id('admission_key', {
      unique: 'task_workspace_preparations_admission_key_unique',
    }),
    requestDigest: c.id('request_digest'),
    lane: c.enum('lane', ['repository-preparation', 'pre-materialized']),
    operationRef: c.id('operation_ref', { nullable: true }),
    artifactJson: c.jsonText('artifact_json', { nullable: true }),
    admittedTaskId: c.id('admitted_task_id', {
      nullable: true,
      unique: 'task_workspace_preparations_admitted_task_id_unique',
    }),
    state: c.enum(
      'state',
      ['preparing', 'prepared', 'admitted', 'compensating', 'cleaned', 'failed'],
      { default: 'preparing' },
    ),
    ownerFence: c.int('owner_fence', { default: 0 }),
    version: c.int('version', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  retention: retention.business,
})

export const taskWorkspacePreparations = materializeDrizzle(
  taskWorkspacePreparationsDefinition,
).table

const taskSpaceNodesDefinition = owner.table({
  id: 'task_space_nodes',
  schemaSymbol: 'taskSpaceNodes',
  columns: {
    taskId: c.id('task_id'),
    nodePath: c.text('node_path'),
    schemaVersion: c.int('schema_version', { default: 1 }),
  },
  primaryKey: ['task_id', 'node_path'],
  foreignKeys: [
    foreignKey('task_space_nodes_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index(
      'idx_task_space_nodes_path_ci',
      ['task_id', raw('lower("task_space_nodes"."node_path")', 'lower("node_path")')],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const taskSpaceNodes = materializeDrizzle(taskSpaceNodesDefinition).table

const workgroupAssignmentsDefinition = owner.table({
  id: 'workgroup_assignments',
  schemaSymbol: 'workgroupAssignments',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    round: c.int('round', { default: 0 }),
    source: c.enum('source', ['leader', 'human', 'self_claim', 'system']),
    createdByRunId: c.id('created_by_run_id', { nullable: true }),
    createdByUserId: c.id('created_by_user_id', { nullable: true }),
    assigneeMemberId: c.id('assignee_member_id', { nullable: true }),
    title: c.text('title'),
    briefMd: c.text('brief_md', { default: '' }),
    status: c.enum('status', [
      'open',
      'dispatched',
      'running',
      'awaiting_human',
      'delivered',
      'done',
      'failed',
      'canceled',
    ]),
    nodeRunId: c.id('node_run_id', { nullable: true }),
    resultMessageId: c.id('result_message_id', { nullable: true }),
    dedupKey: c.id('dedup_key', { nullable: true }),
    attemptCount: c.int('attempt_count', { default: 0 }),
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
    foreignKey('workgroup_assignments_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [index('idx_wg_assign_task', ['task_id', 'status'])],
  retention: retention.business,
})

export const workgroupAssignments = materializeDrizzle(workgroupAssignmentsDefinition).table

const workgroupMemberCursorsDefinition = owner.table({
  id: 'workgroup_member_cursors',
  schemaSymbol: 'workgroupMemberCursors',
  columns: {
    taskId: c.id('task_id'),
    memberId: c.id('member_id'),
    lastConsumedMessageId: c.id('last_consumed_message_id', { default: '' }),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['task_id', 'member_id'],
  foreignKeys: [
    foreignKey('workgroup_member_cursors_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  retention: retention.business,
})

export const workgroupMemberCursors = materializeDrizzle(workgroupMemberCursorsDefinition).table

const workgroupMessagesDefinition = owner.table({
  id: 'workgroup_messages',
  schemaSymbol: 'workgroupMessages',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    round: c.int('round', { default: 0 }),
    authorKind: c.enum('author_kind', ['member', 'human', 'system']),
    authorMemberId: c.id('author_member_id', { nullable: true }),
    authorUserId: c.id('author_user_id', { nullable: true }),
    kind: c.enum('kind', ['chat', 'dispatch', 'result', 'delivery', 'decision', 'system', 'nudge']),
    bodyMd: c.text('body_md'),
    templateKey: c.id('template_key', { nullable: true }),
    templateParamsJson: c.jsonText('template_params_json', { nullable: true }),
    mentionsJson: c.jsonText('mentions_json', { default: '[]' }),
    assignmentId: c.id('assignment_id', { nullable: true }),
    triggerMessageId: c.id('trigger_message_id', { nullable: true }),
    createdAt: c.epochMs('created_at', {
      default: raw(
        '(unixepoch() * 1000)',
        '(extract(epoch from clock_timestamp()) * 1000)::bigint',
      ),
    }),
  },
  foreignKeys: [
    foreignKey('workgroup_messages_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
    foreignKey(
      'workgroup_messages_trigger_message_id_workgroup_messages_id_fk',
      ['trigger_message_id'],
      'workgroup_messages',
      ['id'],
      { onDelete: 'set null' },
    ),
  ],
  indexes: [index('idx_wg_msg_task', ['task_id', 'id'])],
  retention: retention.business,
})

export const workgroupMessages = materializeDrizzle(workgroupMessagesDefinition).table

const tasksDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'tasks_parent_task_id_tasks_id_fk',
      columns: ['parent_task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'tasks_owner_user_fk',
      columns: ['owner_user_id'],
      foreignTable: 'users',
      foreignColumns: ['id'],
      onDelete: 'set null',
      onUpdate: 'no action',
      lifecycle: 'User removal retains task history and clears attribution.',
    },
  ],
  checks: [
    {
      name: 'tasks_workspace_pruning_at_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"tasks"."workspace_prune_cause" IS NULL OR ( "tasks"."workspace_prune_cause" = \'webhook-terminal\' AND "tasks"."workspace_pruning_at" IS NOT NULL )',
        postgresql:
          '"workspace_prune_cause" IS NULL OR ( "workspace_prune_cause" = \'webhook-terminal\' AND "workspace_pruning_at" IS NOT NULL )',
      },
    },
    {
      name: 'tasks_source_termination_fence_enum',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"tasks"."source_termination_fence" IS NULL OR "tasks"."source_termination_fence" IN (\'closed\',\'merged\')',
        postgresql:
          '"source_termination_fence" IS NULL OR "source_termination_fence" IN (\'closed\',\'merged\')',
      },
    },
    {
      name: 'tasks_source_termination_effect_rev_positive',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"tasks"."source_termination_effect_rev" IS NULL OR "tasks"."source_termination_effect_rev" >= 1',
        postgresql:
          '"source_termination_effect_rev" IS NULL OR "source_termination_effect_rev" >= 1',
      },
    },
  ],
  indexes: [
    {
      name: 'idx_tasks_live',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'id' }],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"tasks"."deleted_at" is null',
        postgresql: '"deleted_at" is null',
      },
    },
    {
      name: 'idx_tasks_list_started_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'started_at' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_branch_started_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'branch_started_at' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_status_finished',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'finished_at' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_list_status_started_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'started_at' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_list_parent_started_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'parent_task_id' },
        { kind: 'column', name: 'started_at' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_list_owner_started_id',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'owner_user_id' },
        { kind: 'column', name: 'started_at' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_root_missing',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'id' }],
      where: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"tasks"."root_task_id" is null',
        postgresql: '"root_task_id" is null',
      },
    },
    {
      name: 'idx_tasks_root_started',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'root_task_id' },
        { kind: 'column', name: 'started_at' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_status_parent_finished',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'parent_task_id' },
        { kind: 'column', name: 'finished_at' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_list_facets_cover',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'catalog_visibility' },
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'id' },
      ],
      where: null,
    },
    {
      name: 'idx_tasks_overview_counts',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'parent_task_id' },
        { kind: 'column', name: 'catalog_visibility' },
        { kind: 'column', name: 'finished_at' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'tasks',
  schemaSymbol: 'tasks',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    status: c.enum('status', [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'awaiting_review',
      'awaiting_human',
    ]),
    startedAt: c.epochMs('started_at'),
    runningMs: c.int('running_ms', { default: 0 }),
    runningSince: c.int('running_since', { nullable: true }),
    finishedAt: c.epochMs('finished_at', { nullable: true }),
    errorSummary: c.text('error_summary', { nullable: true }),
    errorMessage: c.text('error_message', { nullable: true }),
    failedNodeId: c.id('failed_node_id', { nullable: true }),
    autoRecoveryAttempts: c.int('auto_recovery_attempts', { default: 0 }),
    autoRecoverySuspended: c.bool('auto_recovery_suspended', { default: false }),
    autoRecoveryWindowStartedAt: c.epochMs('auto_recovery_window_started_at', { nullable: true }),
    expiresAt: c.epochMs('expires_at', { nullable: true }),
    deletedAt: c.epochMs('deleted_at', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    catalogVisibility: c.enum('catalog_visibility', ['public', 'internal'], { default: 'public' }),
    lifecycleEventRevision: c.int('lifecycle_event_revision', { default: 1 }),
    workspacePruningAt: c.epochMs('workspace_pruning_at', { nullable: true }),
    workspacePruneCause: c.enum('workspace_prune_cause', ['webhook-terminal'], { nullable: true }),
    workspacePrunedAt: c.epochMs('workspace_pruned_at', { nullable: true }),
    sourceTerminationFence: c.enum('source_termination_fence', ['closed', 'merged'], {
      nullable: true,
    }),
    sourceTerminationEffectRev: c.int('source_termination_effect_rev', { nullable: true }),
    parentTaskId: c.id('parent_task_id', { nullable: true }),
    rootTaskId: c.id('root_task_id', { nullable: true }),
    invocationDepth: c.int('invocation_depth', { default: 0 }),
    branchStartedAt: c.epochMs('branch_started_at', { default: 0 }),
    workspaceRootRef: c.text('workspace_root_ref', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const tasks = materializeDrizzle(tasksDefinition).table

const taskDefinitionsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'task_definitions_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [
    {
      name: 'task_definition_digital_employee_source',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: '<>',
          left: { kind: 'column', name: 'subject_kind' },
          right: { kind: 'literal', value: 'digital-employee' },
        },
        right: { kind: 'unary', op: 'IS NULL', value: { kind: 'column', name: 'source_id' } },
      },
    },
  ],
  indexes: [
    {
      name: 'task_definitions_source',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'subject_kind' },
        { kind: 'column', name: 'source_id' },
      ],
      where: null,
    },
    {
      name: 'task_definitions_subject_task',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'subject_kind' },
        { kind: 'column', name: 'task_id' },
      ],
      where: null,
    },
    {
      name: 'task_definitions_source_name',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'subject_kind' },
        { kind: 'column', name: 'source_name' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'task_definitions',
  schemaSymbol: 'taskDefinitions',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id', { primary: true }),
    subjectKind: c.enum('subject_kind', [
      'workflow',
      'agent',
      'workgroup',
      'digital-employee',
      'code-round',
      'unknown',
    ]),
    sourceId: c.id('source_id', { nullable: true }),
    sourceName: c.text('source_name', { nullable: true }),
    sourceRevision: c.int('source_revision', { nullable: true }),
    definitionOrigin: c.enum('definition_origin', ['authored', 'platform']),
    engineKind: c.text('engine_kind'),
    definitionRevision: c.int('definition_revision', { default: 1 }),
    workflowSnapshot: c.text('workflow_snapshot'),
    inputs: c.jsonText('inputs'),
    maxDurationMs: c.int('max_duration_ms', { nullable: true }),
    maxTotalTokens: c.int('max_total_tokens', { nullable: true }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    refClosureJson: c.jsonText('ref_closure_json', { nullable: true }),
    workgroupConfigJson: c.jsonText('workgroup_config_json', { nullable: true }),
  },
  primaryKey: ['task_id'],
  migrationKey: ['task_id'],
})

export const taskDefinitions = materializeDrizzle(taskDefinitionsDefinition).table

const taskLaunchContextsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'task_launch_contexts_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [
    {
      name: 'task_launch_contexts_termination_revision',
      expression: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'column', name: 'source_termination_launch_rev' },
        right: { kind: 'literal', value: 0 },
      },
    },
  ],
  indexes: [
    {
      name: 'idx_task_launch_contexts_event_delivery_unique',
      unique: true,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'event_delivery_id' }],
      where: {
        kind: 'unary',
        op: 'IS NOT NULL',
        value: { kind: 'column', name: 'event_delivery_id' },
      },
    },
    {
      name: 'idx_task_launch_contexts_source_termination',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'source_termination_binding' },
        { kind: 'column', name: 'source_termination_launch_rev' },
      ],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_scheduled_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'scheduled_task_id' }],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_webhook_trigger',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'webhook_trigger_id' }],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_webhook_fire',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'webhook_fire_id' }],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_event_subscription',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'event_subscription_id' }],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_digital_employee_round',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'digital_employee_round_id' }],
      where: null,
    },
    {
      name: 'idx_task_launch_contexts_lineage',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'execution_lineage_id' }],
      where: null,
    },
    {
      name: 'task_launch_contexts_origin_task',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'launch_origin' },
        { kind: 'column', name: 'task_id' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'task_launch_contexts',
  schemaSymbol: 'taskLaunchContexts',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id', { primary: true }),
    launchOrigin: c.enum('launch_origin', ['manual', 'scheduled', 'event', 'webhook', 'api'], {
      default: 'manual',
    }),
    scheduledTaskId: c.id('scheduled_task_id', { nullable: true }),
    webhookTriggerId: c.id('webhook_trigger_id', { nullable: true }),
    webhookFireId: c.id('webhook_fire_id', { nullable: true }),
    eventSubscriptionId: c.id('event_subscription_id', { nullable: true }),
    eventDeliveryId: c.id('event_delivery_id', { nullable: true }),
    digitalEmployeeRoundId: c.id('digital_employee_round_id', { nullable: true }),
    digitalEmployeeCaseId: c.id('digital_employee_case_id', { nullable: true }),
    parentNodeRunId: c.id('parent_node_run_id', { nullable: true }),
    triggerContextJson: c.jsonText('trigger_context_json', { nullable: true }),
    platformInputPathsJson: c.jsonText('platform_input_paths_json', { nullable: true }),
    sourceTerminationBinding: c.text('source_termination_binding', { nullable: true }),
    sourceTerminationLaunchRev: c.int('source_termination_launch_rev', { nullable: true }),
    executionLineageId: c.id('execution_lineage_id', { nullable: true }),
    lineageSlotPathJson: c.jsonText('lineage_slot_path_json', { nullable: true }),
  },
  primaryKey: ['task_id'],
  migrationKey: ['task_id'],
})

export const taskLaunchContexts = materializeDrizzle(taskLaunchContextsDefinition).table

const taskWorkspacesDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'task_workspaces_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'task_workspaces_requested_cached_repo',
      unique: false,
      nulls: 'distinct',
      columns: [
        {
          kind: 'raw',
          reason:
            'RFC-395 T: index the validated requestedSource@v2 cached repository without a mirror column.',
          sqlite: "json_extract(requested_source, '$.cachedRepoId')",
          postgresql: "(requested_source::jsonb ->> 'cachedRepoId')",
        },
        { kind: 'column', name: 'task_id' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'task_workspaces',
  schemaSymbol: 'taskWorkspaces',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id', { primary: true }),
    repoGroupId: c.id('repo_group_id', { nullable: true }),
    repoGroupName: c.text('repo_group_name', { nullable: true }),
    gitUserName: c.text('git_user_name', { nullable: true }),
    gitUserEmail: c.text('git_user_email', { nullable: true }),
    autoCommitPush: c.bool('auto_commit_push', { default: false }),
    spaceKind: c.enum('space_kind', ['local', 'remote', 'scratch', 'internal', 'inherited'], {
      default: 'remote',
    }),
    workingBranch: c.text('working_branch', { nullable: true }),
    requestedSource: c.jsonText('requested_source', {
      document: { kind: 'requested-source', version: 2 },
    }),
    taskBranch: c.text('task_branch'),
  },
  primaryKey: ['task_id'],
  migrationKey: ['task_id'],
})

export const taskWorkspaces = materializeDrizzle(taskWorkspacesDefinition).table

const taskRepositoryMountsDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'task_repository_mounts_ordinal', columns: ['task_id', 'ordinal'], nulls: 'distinct' },
    { name: 'task_repository_mounts_path', columns: ['task_id', 'mount_path'], nulls: 'distinct' },
  ],
  foreignKeys: [
    {
      name: 'task_repository_mounts_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [
    {
      name: 'task_repository_mounts_branch_shape',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'branch_state' },
            right: { kind: 'literal', value: 'branch' },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: { kind: 'unary', op: 'IS NOT NULL', value: { kind: 'column', name: 'branch' } },
            right: {
              kind: 'binary',
              op: '<>',
              left: { kind: 'column', name: 'branch' },
              right: { kind: 'literal', value: '' },
            },
          },
        },
        right: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '<>',
            left: { kind: 'column', name: 'branch_state' },
            right: { kind: 'literal', value: 'branch' },
          },
          right: { kind: 'unary', op: 'IS NULL', value: { kind: 'column', name: 'branch' } },
        },
      },
    },
    {
      name: 'task_repository_mounts_base_shape',
      expression: {
        kind: 'binary',
        op: 'AND',
        left: {
          kind: 'binary',
          op: 'OR',
          left: { kind: 'unary', op: 'IS NULL', value: { kind: 'column', name: 'base_branch' } },
          right: {
            kind: 'binary',
            op: '<>',
            left: { kind: 'column', name: 'base_branch' },
            right: { kind: 'literal', value: '' },
          },
        },
        right: {
          kind: 'binary',
          op: 'OR',
          left: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'binary',
              op: '=',
              left: { kind: 'column', name: 'branch_state' },
              right: { kind: 'literal', value: 'detached' },
            },
            right: {
              kind: 'binary',
              op: 'AND',
              left: {
                kind: 'binary',
                op: 'OR',
                left: {
                  kind: 'unary',
                  op: 'IS NULL',
                  value: { kind: 'column', name: 'base_branch' },
                },
                right: {
                  kind: 'binary',
                  op: '=',
                  left: { kind: 'column', name: 'base_branch' },
                  right: { kind: 'column', name: 'base_commit' },
                },
              },
              right: {
                kind: 'binary',
                op: 'AND',
                left: {
                  kind: 'unary',
                  op: 'IS NOT NULL',
                  value: { kind: 'column', name: 'base_commit' },
                },
                right: {
                  kind: 'binary',
                  op: '<>',
                  left: { kind: 'column', name: 'base_commit' },
                  right: { kind: 'literal', value: '' },
                },
              },
            },
          },
          right: {
            kind: 'binary',
            op: 'OR',
            left: {
              kind: 'binary',
              op: '=',
              left: { kind: 'column', name: 'branch_state' },
              right: { kind: 'literal', value: 'branch' },
            },
            right: {
              kind: 'binary',
              op: 'AND',
              left: {
                kind: 'binary',
                op: 'OR',
                left: {
                  kind: 'binary',
                  op: '=',
                  left: { kind: 'column', name: 'branch_state' },
                  right: { kind: 'literal', value: 'unborn' },
                },
                right: {
                  kind: 'binary',
                  op: '=',
                  left: { kind: 'column', name: 'branch_state' },
                  right: { kind: 'literal', value: 'none' },
                },
              },
              right: {
                kind: 'binary',
                op: 'AND',
                left: {
                  kind: 'unary',
                  op: 'IS NULL',
                  value: { kind: 'column', name: 'base_branch' },
                },
                right: {
                  kind: 'unary',
                  op: 'IS NULL',
                  value: { kind: 'column', name: 'base_commit' },
                },
              },
            },
          },
        },
      },
    },
    {
      name: 'task_repository_mounts_ordinal_nonnegative',
      expression: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'column', name: 'ordinal' },
        right: { kind: 'literal', value: 0 },
      },
    },
  ],
  indexes: [
    {
      name: 'task_repository_mounts_repo_path',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'repo_path' }],
      where: null,
    },
    {
      name: 'task_repository_mounts_repo_url',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'repo_url' }],
      where: null,
    },
    {
      name: 'task_repository_mounts_cached_repo_task',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'cached_repo_id' },
        { kind: 'column', name: 'task_id' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'task_repository_mounts',
  schemaSymbol: 'taskRepositoryMounts',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id'),
    repoKey: c.id('repo_key'),
    ordinal: c.int('ordinal'),
    repoPath: c.text('repo_path'),
    repoUrl: c.text('repo_url', { nullable: true }),
    cachedRepoId: c.id('cached_repo_id', { nullable: true }),
    workingBranch: c.text('working_branch', { nullable: true }),
    baseCommit: c.text('base_commit', { nullable: true }),
    mountPath: c.text('mount_path', { default: '' }),
    subdir: c.text('subdir', { default: '' }),
    readonly: c.bool('readonly', { default: false }),
    readonlyDirtyCount: c.int('readonly_dirty_count', { nullable: true }),
    workspaceProfileVersion: c.int('workspace_profile_version', { nullable: true }),
    workspaceProfileDigest: c.id('workspace_profile_digest', { nullable: true }),
    hasSubmodules: c.bool('has_submodules', { nullable: true }),
    submoduleInitOk: c.bool('submodule_init_ok', { nullable: true }),
    submoduleInitError: c.text('submodule_init_error', { nullable: true }),
    schemaVersion: c.int('schema_version', { default: 1 }),
    baseBranch: c.text('base_branch', { nullable: true }),
    branch: c.text('branch', { nullable: true }),
    branchState: c.enum('branch_state', ['branch', 'detached', 'unborn', 'none']),
  },
  primaryKey: ['task_id', 'repo_key'],
  migrationKey: ['task_id', 'repo_key'],
})

export const taskRepositoryMounts = materializeDrizzle(taskRepositoryMountsDefinition).table

const taskExecutionGenerationsDefinition = owner.table({
  version: 1,
  unique: [
    {
      name: 'task_execution_generations_operation',
      columns: ['task_id', 'operation_ref'],
      nulls: 'distinct',
    },
  ],
  foreignKeys: [
    {
      name: 'task_execution_generations_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'task_execution_generations',
  schemaSymbol: 'taskExecutionGenerations',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id'),
    generationSeq: c.seq('generation_seq'),
    cause: c.text('cause'),
    previousGenerationSeq: c.seq('previous_generation_seq', { nullable: true }),
    operationRef: c.id('operation_ref', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['task_id', 'generation_seq'],
  migrationKey: ['task_id', 'generation_seq'],
})

export const taskExecutionGenerations = materializeDrizzle(taskExecutionGenerationsDefinition).table

const nodeRunsDefinition = owner.table({
  version: 1,
  unique: [
    { name: 'node_runs_task_identity', columns: ['task_id', 'id'], nulls: 'distinct' },
    {
      name: 'node_runs_task_slot_identity',
      columns: ['task_id', 'slot_key', 'id'],
      nulls: 'distinct',
    },
  ],
  foreignKeys: [
    {
      name: 'node_runs_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
    {
      name: 'node_runs_container_same_task',
      columns: ['task_id', 'container_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['task_id', 'id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle: 'Container belongs to the same task; task deletion removes both via its cascade.',
    },
    {
      name: 'node_runs_generation',
      columns: ['task_id', 'generation_seq'],
      foreignTable: 'task_execution_generations',
      foreignColumns: ['task_id', 'generation_seq'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle: 'Generation and run are owned by the same task and removed together.',
    },
  ],
  checks: [
    {
      name: 'node_runs_executable_identity',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', name: 'record_mode' },
          right: { kind: 'literal', value: 'history-only' },
        },
        right: {
          kind: 'binary',
          op: 'AND',
          left: { kind: 'unary', op: 'IS NOT NULL', value: { kind: 'column', name: 'role' } },
          right: {
            kind: 'binary',
            op: 'AND',
            left: { kind: 'unary', op: 'IS NOT NULL', value: { kind: 'column', name: 'slot_key' } },
            right: {
              kind: 'binary',
              op: 'AND',
              left: {
                kind: 'unary',
                op: 'IS NOT NULL',
                value: { kind: 'column', name: 'scope_path' },
              },
              right: {
                kind: 'unary',
                op: 'IS NOT NULL',
                value: { kind: 'column', name: 'attempt_index' },
              },
            },
          },
        },
      },
    },
    {
      name: 'node_runs_executable_nonce',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', name: 'record_mode' },
          right: { kind: 'literal', value: 'history-only' },
        },
        right: {
          kind: 'unary',
          op: 'IS NOT NULL',
          value: { kind: 'column', name: 'envelope_nonce' },
        },
      },
    },
    {
      name: 'node_runs_synthetic_owner',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', name: 'record_mode' },
          right: { kind: 'literal', value: 'history-only' },
        },
        right: {
          kind: 'binary',
          op: 'OR',
          left: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'binary',
              op: '=',
              left: { kind: 'column', name: 'role' },
              right: { kind: 'literal', value: 'synthetic' },
            },
            right: {
              kind: 'unary',
              op: 'IS NOT NULL',
              value: { kind: 'column', name: 'synthetic_owner' },
            },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'binary',
              op: '<>',
              left: { kind: 'column', name: 'role' },
              right: { kind: 'literal', value: 'synthetic' },
            },
            right: {
              kind: 'unary',
              op: 'IS NULL',
              value: { kind: 'column', name: 'synthetic_owner' },
            },
          },
        },
      },
    },
  ],
  indexes: [
    {
      name: 'idx_node_runs_task_seq',
      unique: true,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'seq' },
      ],
      where: null,
    },
    {
      name: 'idx_node_runs_task_slot_seq',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'slot_key' },
        { kind: 'column', name: 'seq' },
      ],
      where: null,
    },
    {
      name: 'idx_node_runs_task',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'node_id' },
        { kind: 'column', name: 'iteration' },
        { kind: 'column', name: 'attempt_index' },
      ],
      where: null,
    },
    {
      name: 'idx_node_runs_parent',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'historical_parent_id' }],
      where: null,
    },
    {
      name: 'idx_node_runs_container',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'container_run_id' },
        { kind: 'column', name: 'node_id' },
        { kind: 'column', name: 'iteration' },
      ],
      where: null,
    },
    {
      name: 'idx_node_runs_child_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'child_task_id' }],
      where: null,
    },
    {
      name: 'idx_node_runs_status_active',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'status' },
        { kind: 'column', name: 'started_at' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'node_runs',
  schemaSymbol: 'nodeRuns',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    nodeId: c.id('node_id'),
    containerRunId: c.id('container_run_id', { nullable: true }),
    iteration: c.int('iteration', { default: 0 }),
    shardKey: c.id('shard_key', { nullable: true }),
    wgRound: c.int('wg_round', { nullable: true }),
    reviewIteration: c.int('review_iteration', { default: 0 }),
    status: c.enum('status', [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'skipped',
      'exhausted',
      'awaiting_review',
      'awaiting_human',
    ]),
    startedAt: c.epochMs('started_at', { nullable: true }),
    finishedAt: c.epochMs('finished_at', { nullable: true }),
    exitCode: c.int('exit_code', { nullable: true }),
    errorMessage: c.text('error_message', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    envelopeNonce: c.text('envelope_nonce', { nullable: true }),
    forceActivated: c.bool('force_activated', { default: false }),
    rerunCause: c.text('rerun_cause', { nullable: true }),
    childTaskId: c.id('child_task_id', { nullable: true }),
    continuationSlotKey: c.id('continuation_slot_key', { nullable: true }),
    lineageSlotPathJson: c.jsonText('lineage_slot_path_json', { nullable: true }),
    operationGeneration: c.int('operation_generation', { default: 0 }),
    historicalParentId: c.id('historical_parent_id', { nullable: true }),
    seq: c.seq('seq'),
    role: c.enum('role', ['node-attempt', 'container', 'synthetic'], { nullable: true }),
    syntheticOwner: c.text('synthetic_owner', { nullable: true }),
    scopePath: c.text('scope_path', { nullable: true, default: '' }),
    slotKey: c.slotKey('slot_key', { nullable: true }),
    generationSeq: c.seq('generation_seq'),
    attemptIndex: c.int('attempt_index', { nullable: true, default: 0 }),
    inputsRecorded: c.bool('inputs_recorded', { default: false }),
    recordMode: c.enum('record_mode', ['executable', 'history-only']),
    provenanceQuality: c.enum('provenance_quality', ['recorded', 'legacy-derived', 'unknown']),
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const nodeRuns = materializeDrizzle(nodeRunsDefinition).table

const nodeRunSelectionsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_selections_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
    {
      name: 'node_run_selections_run_slot',
      columns: ['task_id', 'slot_key', 'selected_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['task_id', 'slot_key', 'id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Selected identity belongs to the same task and canonical slot.',
    },
    {
      name: 'node_run_selections_generation',
      columns: ['task_id', 'generation_seq'],
      foreignTable: 'task_execution_generations',
      foreignColumns: ['task_id', 'generation_seq'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 no action delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'node_run_selections',
  schemaSymbol: 'nodeRunSelections',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id'),
    slotKey: c.slotKey('slot_key'),
    selectedRunId: c.id('selected_run_id', { nullable: true }),
    revision: c.int('revision'),
    generationSeq: c.seq('generation_seq'),
    cause: c.text('cause'),
    selectedAt: c.epochMs('selected_at'),
  },
  primaryKey: ['task_id', 'slot_key'],
  migrationKey: ['task_id', 'slot_key'],
})

export const nodeRunSelections = materializeDrizzle(nodeRunSelectionsDefinition).table

const nodeRunInputsDefinition = owner.table({
  version: 1,
  unique: [
    {
      name: 'node_run_inputs_source',
      columns: ['consumer_run_id', 'input_kind', 'producer_node_id', 'producer_shard_slot'],
      nulls: 'distinct',
    },
  ],
  foreignKeys: [
    {
      name: 'node_run_inputs_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
    {
      name: 'node_run_inputs_consumer',
      columns: ['task_id', 'consumer_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['task_id', 'id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'node_run_inputs_producer',
      columns: ['task_id', 'producer_run_ref'],
      foreignTable: 'node_runs',
      foreignColumns: ['task_id', 'id'],
      onDelete: 'no action',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 no action delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [
    {
      name: 'node_run_inputs_producer_provenance',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'unary',
            op: 'IS NOT NULL',
            value: { kind: 'column', name: 'producer_run_ref' },
          },
          right: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'producer_run_ref' },
            right: { kind: 'column', name: 'producer_run_id' },
          },
        },
        right: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'unary',
            op: 'IS NULL',
            value: { kind: 'column', name: 'producer_run_ref' },
          },
          right: {
            kind: 'binary',
            op: 'AND',
            left: {
              kind: 'binary',
              op: '=',
              left: { kind: 'column', name: 'provenance_quality' },
              right: { kind: 'literal', value: 'legacy-derived' },
            },
            right: {
              kind: 'unary',
              op: 'IS NOT NULL',
              value: { kind: 'column', name: 'evidence_ref_json' },
            },
          },
        },
      },
    },
  ],
  indexes: [
    {
      name: 'node_run_inputs_producer',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'producer_run_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'node_run_inputs',
  schemaSymbol: 'nodeRunInputs',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id'),
    consumerRunId: c.id('consumer_run_id'),
    ordinal: c.int('ordinal'),
    producerRunId: c.id('producer_run_id'),
    producerRunRef: c.id('producer_run_ref', { nullable: true }),
    provenanceQuality: c.enum('provenance_quality', ['recorded', 'legacy-derived'], {
      default: 'recorded',
    }),
    evidenceRefJson: c.jsonText('evidence_ref_json', { nullable: true }),
    inputKind: c.enum('input_kind', [
      'frame-input',
      'wrapper-parameter',
      'aggregator-shard',
      'review-source',
      'gate-open',
    ]),
    producerNodeId: c.id('producer_node_id'),
    producerShardSlot: c.slotKey('producer_shard_slot'),
  },
  primaryKey: ['consumer_run_id', 'ordinal'],
  migrationKey: ['consumer_run_id', 'ordinal'],
})

export const nodeRunInputs = materializeDrizzle(nodeRunInputsDefinition).table

const nodeRunConfigsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_configs_run_fk',
      columns: ['node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Run owns this row; task deletion cascades through the run.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'node_run_configs',
  schemaSymbol: 'nodeRunConfigs',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    nodeRunId: c.id('node_run_id', { primary: true }),
    runtime: c.text('runtime', { nullable: true }),
    runtimeBinary: c.text('runtime_binary', { nullable: true }),
    runtimeParamsJson: c.jsonText('runtime_params_json', { nullable: true }),
    inventorySnapshotJson: c.jsonText('inventory_snapshot_json', { nullable: true }),
    runtimeInventoryJson: c.jsonText('runtime_inventory_json', { nullable: true }),
    injectedMemoriesJson: c.jsonText('injected_memories_json', { nullable: true }),
    agentOverrideName: c.text('agent_override_name', { nullable: true }),
    agentOverrideId: c.id('agent_override_id', { nullable: true }),
    shardValueHash: c.text('shard_value_hash', { nullable: true }),
    promptRefJson: c.jsonText('prompt_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'prompt_inline_bytes' },
      nullable: true,
    }),
    promptInlineBytes: c.bytes('prompt_inline_bytes', { nullable: true }),
  },
  primaryKey: ['node_run_id'],
  migrationKey: ['node_run_id'],
})

export const nodeRunConfigs = materializeDrizzle(nodeRunConfigsDefinition).table

const nodeRunRuntimeStatesDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_runtime_states_run_fk',
      columns: ['node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Run owns this row; task deletion cascades through the run.',
    },
  ],
  checks: [],
  indexes: [
    {
      name: 'node_run_runtime_states_session',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'session_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'node_run_runtime_states',
  schemaSymbol: 'nodeRunRuntimeStates',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    nodeRunId: c.id('node_run_id', { primary: true }),
    pid: c.int('pid', { nullable: true }),
    spawnBinaryPath: c.text('spawn_binary_path', { nullable: true }),
    spawnLaunchNonce: c.text('spawn_launch_nonce', { nullable: true }),
    startupVerificationJson: c.jsonText('startup_verification_json', { nullable: true }),
    wrapperProgressJson: c.jsonText('wrapper_progress_json', { nullable: true }),
    mergeState: c.text('merge_state', { nullable: true }),
    sessionId: c.id('session_id', { nullable: true }),
    isolationRootRef: c.text('isolation_root_ref', { nullable: true }),
  },
  primaryKey: ['node_run_id'],
  migrationKey: ['node_run_id'],
})

export const nodeRunRuntimeStates = materializeDrizzle(nodeRunRuntimeStatesDefinition).table

const nodeRunResultsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_results_run_fk',
      columns: ['node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Run owns this row; task deletion cascades through the run.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'node_run_results',
  schemaSymbol: 'nodeRunResults',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    nodeRunId: c.id('node_run_id', { primary: true }),
    tokInput: c.int('tok_input', { nullable: true }),
    tokOutput: c.int('tok_output', { nullable: true }),
    tokCacheCreate: c.int('tok_cache_create', { nullable: true }),
    tokCacheRead: c.int('tok_cache_read', { nullable: true }),
    tokTotal: c.int('tok_total', { nullable: true }),
    portValidationFailuresJson: c.jsonText('port_validation_failures_json', { nullable: true }),
    commitPushJson: c.jsonText('commit_push_json', { nullable: true }),
    supersededByReview: c.text('superseded_by_review', { nullable: true }),
    rolledBack: c.bool('rolled_back', { nullable: true }),
  },
  primaryKey: ['node_run_id'],
  migrationKey: ['node_run_id'],
})

export const nodeRunResults = materializeDrizzle(nodeRunResultsDefinition).table

const nodeRunRepoCheckpointsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_repo_checkpoints_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
    {
      name: 'node_run_repo_checkpoints_run',
      columns: ['task_id', 'node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['task_id', 'id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
    {
      name: 'node_run_repo_checkpoints_mount',
      columns: ['task_id', 'repo_key'],
      foreignTable: 'task_repository_mounts',
      foreignColumns: ['task_id', 'repo_key'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'node_run_repo_checkpoints',
  schemaSymbol: 'nodeRunRepoCheckpoints',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    nodeRunId: c.id('node_run_id'),
    taskId: c.id('task_id'),
    repoKey: c.id('repo_key'),
    preSnapshot: c.text('pre_snapshot', { nullable: true }),
    isolationBase: c.text('isolation_base', { nullable: true }),
    nodeTree: c.text('node_tree', { nullable: true }),
    submodules: c.jsonText('submodules', { nullable: true }),
  },
  primaryKey: ['node_run_id', 'repo_key'],
  migrationKey: ['node_run_id', 'repo_key'],
})

export const nodeRunRepoCheckpoints = materializeDrizzle(nodeRunRepoCheckpointsDefinition).table

const executionLegacyEvidenceDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'execution_legacy_evidence_task_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'Task owns this row; deleting its subtree deletes all owned state.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'execution_legacy_evidence',
  schemaSymbol: 'executionLegacyEvidence',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    taskId: c.id('task_id', { nullable: true }),
    recordKind: c.text('record_kind'),
    recordId: c.id('record_id'),
    sourceContract: c.text('source_contract'),
    provenanceQuality: c.enum('provenance_quality', ['recorded', 'legacy-derived', 'unknown']),
    missingFieldsJson: c.jsonText('missing_fields_json'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['record_kind', 'record_id', 'source_contract'],
  migrationKey: ['record_kind', 'record_id', 'source_contract'],
})

export const executionLegacyEvidence = materializeDrizzle(executionLegacyEvidenceDefinition).table

const workgroupTaskStateDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'workgroup_task_state_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'workgroup_task_state',
  schemaSymbol: 'workgroupTaskState',
  columns: {
    taskId: c.id('task_id', { primary: true }),
    gateStatus: c.enum(
      'gate_status',
      ['idle', 'declared', 'awaiting_confirmation', 'approved', 'rejected'],
      { default: 'idle' },
    ),
    gateSummary: c.text('gate_summary', { nullable: true }),
    gateRejectedComment: c.text('gate_rejected_comment', { nullable: true }),
    pauseReason: c.text('pause_reason', { nullable: true }),
    dwStateJson: c.jsonText('dw_state_json', { nullable: true }),
    resultMessageId: c.id('result_message_id', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
    runtimeConfigJson: c.jsonText('runtime_config_json', { nullable: true }),
    configRevision: c.int('config_revision', { default: 1 }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['task_id'],
  migrationKey: ['task_id'],
})

export const workgroupTaskState = materializeDrizzle(workgroupTaskStateDefinition).table

const runtimeSessionLeasesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'runtime_session_leases_task_id_tasks_id_fk',
      columns: ['task_id'],
      foreignTable: 'tasks',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [
    {
      name: 'runtime_session_leases_all_or_none',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '(\n        (\n          "runtime_session_leases"."lease_node_run_id" IS NULL\n          AND "runtime_session_leases"."lease_nonce_digest" IS NULL\n          AND "runtime_session_leases"."leased_at" IS NULL\n        )\n        OR\n        (\n          "runtime_session_leases"."lease_node_run_id" IS NOT NULL\n          AND "runtime_session_leases"."lease_nonce_digest" IS NOT NULL\n          AND "runtime_session_leases"."leased_at" IS NOT NULL\n        )\n      )',
        postgresql:
          '( ( "lease_node_run_id" IS NULL AND "lease_nonce_digest" IS NULL AND "leased_at" IS NULL ) OR ( "lease_node_run_id" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL AND "leased_at" IS NOT NULL ) )',
      },
    },
    {
      name: 'runtime_session_leases_protocol_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"runtime_session_leases"."protocol" IN (\'opencode\', \'claude-code\')',
        postgresql: "\"protocol\" IN ('opencode', 'claude-code')",
      },
    },
    {
      name: 'runtime_session_leases_reset_pending_shape',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"runtime_session_leases"."reset_pending" IN (0, 1)',
        postgresql: '"reset_pending" IN (FALSE, TRUE)',
      },
    },
    {
      name: 'runtime_session_leases_reset_pending_held',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', name: 'reset_pending' },
          right: { kind: 'literal', value: false },
        },
        right: {
          kind: 'unary',
          op: 'IS NOT NULL',
          value: { kind: 'column', name: 'lease_node_run_id' },
        },
      },
    },
  ],
  indexes: [
    {
      name: 'idx_runtime_session_leases_task',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'task_id' }],
      where: null,
    },
    {
      name: 'idx_runtime_session_leases_created_run',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'created_node_run_id' }],
      where: null,
    },
    {
      name: 'idx_runtime_session_leases_lease_run',
      unique: false,
      nulls: 'distinct',
      columns: [{ kind: 'column', name: 'lease_node_run_id' }],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'runtime_session_leases',
  schemaSymbol: 'runtimeSessionLeases',
  columns: {
    protocol: c.enum('protocol', ['opencode', 'claude-code']),
    sessionId: c.id('session_id'),
    taskId: c.id('task_id'),
    nodeId: c.id('node_id'),
    createdNodeRunId: c.id('created_node_run_id'),
    leaseNodeRunId: c.id('lease_node_run_id', { nullable: true }),
    leaseNonceDigest: c.id('lease_nonce_digest', { nullable: true }),
    leasedAt: c.epochMs('leased_at', { nullable: true }),
    resetPending: c.bool('reset_pending', { default: false }),
  },
  primaryKey: ['protocol', 'session_id'],
  retention: {
    class: 'owner-managed-operational',
    rule: 'The owning bounded context defines retention and archive jobs through its application port.',
  },
  migrationKey: ['protocol', 'session_id'],
})

export const runtimeSessionLeases = materializeDrizzle(runtimeSessionLeasesDefinition).table

const nodeRunOutputsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [
    {
      name: 'node_run_outputs_node_run_id_node_runs_id_fk',
      columns: ['node_run_id'],
      foreignTable: 'node_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle:
        'Preserve epoch-1 cascade delete and no action update semantics; target is a logical table reference.',
    },
  ],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'node_run_outputs',
  schemaSymbol: 'nodeRunOutputs',
  columns: {
    nodeRunId: c.id('node_run_id'),
    portName: c.text('port_name'),
    kind: c.text('kind', { nullable: true }),
    archiveJson: c.jsonText('archive_json', { nullable: true }),
    active: c.bool('active', { default: true }),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['node_run_id', 'port_name'],
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  migrationKey: ['node_run_id', 'port_name'],
})

export const nodeRunOutputs = materializeDrizzle(nodeRunOutputsDefinition).table

const hostedTaskArtifactsDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'hosted_task_artifacts',
  schemaSymbol: 'hostedTaskArtifacts',
  columns: {
    reference: c.id('reference', { primary: true }),
    taskId: c.id('task_id'),
    digest: c.text('digest'),
    size: c.int('size'),
    createdAt: c.epochMs('created_at'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['reference'],
  migrationKey: ['reference'],
})

export const hostedTaskArtifacts = materializeDrizzle(hostedTaskArtifactsDefinition).table

const hostedNodeEventArchivesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [
    {
      name: 'hosted_node_event_archives_state_known',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"hosted_node_event_archives"."state" IN (\'prepared\', \'ready\')',
        postgresql: "\"state\" IN ('prepared', 'ready')",
      },
    },
    {
      name: 'hosted_node_event_archives_range',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite:
          '"hosted_node_event_archives"."first_id" > 0 AND "hosted_node_event_archives"."last_id" >= "hosted_node_event_archives"."first_id" AND "hosted_node_event_archives"."row_count" > 0',
        postgresql: '"first_id" > 0 AND "last_id" >= "first_id" AND "row_count" > 0',
      },
    },
    {
      name: 'hosted_node_event_archives_reference_known',
      expression: {
        kind: 'binary',
        op: 'OR',
        left: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'state' },
            right: { kind: 'literal', value: 'prepared' },
          },
          right: {
            kind: 'unary',
            op: 'IS NULL',
            value: { kind: 'column', name: 'content_ref_json' },
          },
        },
        right: {
          kind: 'binary',
          op: 'AND',
          left: {
            kind: 'binary',
            op: '=',
            left: { kind: 'column', name: 'state' },
            right: { kind: 'literal', value: 'ready' },
          },
          right: {
            kind: 'unary',
            op: 'IS NOT NULL',
            value: { kind: 'column', name: 'content_ref_json' },
          },
        },
      },
    },
  ],
  indexes: [
    {
      name: 'hosted_node_event_archives_run',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'task_id' },
        { kind: 'column', name: 'node_run_id' },
        { kind: 'column', name: 'last_id' },
      ],
      where: null,
    },
    {
      name: 'hosted_node_event_archives_pending',
      unique: false,
      nulls: 'distinct',
      columns: [
        { kind: 'column', name: 'state' },
        { kind: 'column', name: 'created_at' },
      ],
      where: null,
    },
  ],
  migrationPolicy: 'KEEP',
  id: 'hosted_node_event_archives',
  schemaSymbol: 'hostedNodeEventArchives',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    nodeRunId: c.id('node_run_id'),
    firstId: c.int('first_id'),
    lastId: c.int('last_id'),
    rowCount: c.int('row_count'),
    digest: c.text('digest'),
    size: c.int('size'),
    state: c.enum('state', ['prepared', 'ready']),
    createdAt: c.epochMs('created_at'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
      nullable: true,
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  retention: {
    class: 'owner-managed-operational',
    rule: 'The owning bounded context defines retention and archive jobs through its application port.',
  },
  primaryKey: ['id'],
  migrationKey: ['id'],
})

export const hostedNodeEventArchives = materializeDrizzle(hostedNodeEventArchivesDefinition).table

const hostedTaskArchiveEntriesDefinition = owner.table({
  version: 2,
  unique: [],
  foreignKeys: [],
  checks: [
    {
      name: 'hosted_task_archive_entries_kind_known',
      expression: {
        kind: 'raw',
        reason: 'Preserve the epoch-1 expression spelling and provider semantics (RFC-395 I-a).',
        sqlite: '"hosted_task_archive_entries"."kind" IN (\'directory\', \'file\')',
        postgresql: "\"kind\" IN ('directory', 'file')",
      },
    },
  ],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'hosted_task_archive_entries',
  schemaSymbol: 'hostedTaskArchiveEntries',
  columns: {
    path: c.id('path', { primary: true }),
    kind: c.enum('kind', ['directory', 'file']),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  primaryKey: ['path'],
  migrationKey: ['path'],
})

export const hostedTaskArchiveEntries = materializeDrizzle(hostedTaskArchiveEntriesDefinition).table

const hostedTaskArchiveEntryPartsDefinition = owner.table({
  version: 1,
  unique: [],
  foreignKeys: [
    {
      name: 'hosted_task_archive_entry_parts_entry',
      columns: ['path'],
      foreignTable: 'hosted_task_archive_entries',
      foreignColumns: ['path'],
      onDelete: 'cascade',
      onUpdate: 'no action',
      lifecycle: 'An entry owns zero or more ordered publication parts; directories have no parts.',
    },
  ],
  checks: [
    {
      name: 'hosted_task_archive_entry_parts_ordinal',
      expression: {
        kind: 'binary',
        op: '>=',
        left: { kind: 'column', name: 'ordinal' },
        right: { kind: 'literal', value: 0 },
      },
    },
  ],
  indexes: [],
  migrationPolicy: 'KEEP',
  id: 'hosted_task_archive_entry_parts',
  schemaSymbol: 'hostedTaskArchiveEntryParts',
  retention: {
    class: 'owner-managed-business',
    rule: 'Retain as live business or recovery state until the owning bounded context approves a replacement contract.',
  },
  columns: {
    path: c.text('path'),
    ordinal: c.int('ordinal'),
    partKey: c.id('part_key'),
    contentRefJson: c.jsonText('content_ref_json', {
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'content_inline_bytes' },
    }),
    contentInlineBytes: c.bytes('content_inline_bytes', { nullable: true }),
  },
  primaryKey: ['path', 'ordinal'],
  migrationKey: ['path', 'ordinal'],
})

export const hostedTaskArchiveEntryParts = materializeDrizzle(
  hostedTaskArchiveEntryPartsDefinition,
).table

export const schemaContribution = {
  owner: 'task-execution',
  version: 2,
  columnUniqueNulls: [
    { table: 'task_workspace_preparations', column: 'admitted_task_id', nulls: 'distinct' },
  ],
  tables: [
    hostedExecutionBindingsDefinition,
    hostedExecutionEventsDefinition,
    nodeExecutionEventSourcesDefinition,
    nodeRunEventsDefinition,
    nodeRunSeqAllocationsDefinition,
    hostedRecoveryRequestsDefinition,
    reactionExecutionAdmissionsDefinition,
    taskArchiveAuditDefinition,
    taskExecutionEffectAttemptsDefinition,
    taskExecutionEffectFencesDefinition,
    taskExecutionEffectsDefinition,
    taskExecutionIntentsDefinition,
    taskExecutionLineageOperationRecordsDefinition,
    taskExecutionMaintenanceClaimsDefinition,
    taskExecutionMaintenanceMembersDefinition,
    taskExecutionOwnersDefinition,
    taskNodeClarifyDirectivesDefinition,
    taskWorkspacePreparationsDefinition,
    taskSpaceNodesDefinition,
    workgroupAssignmentsDefinition,
    workgroupMemberCursorsDefinition,
    workgroupMessagesDefinition,
    tasksDefinition,
    taskDefinitionsDefinition,
    taskLaunchContextsDefinition,
    taskWorkspacesDefinition,
    taskRepositoryMountsDefinition,
    taskExecutionGenerationsDefinition,
    nodeRunsDefinition,
    nodeRunSelectionsDefinition,
    nodeRunInputsDefinition,
    nodeRunConfigsDefinition,
    nodeRunRuntimeStatesDefinition,
    nodeRunResultsDefinition,
    nodeRunRepoCheckpointsDefinition,
    executionLegacyEvidenceDefinition,
    workgroupTaskStateDefinition,
    runtimeSessionLeasesDefinition,
    nodeRunOutputsDefinition,
    hostedTaskArtifactsDefinition,
    hostedNodeEventArchivesDefinition,
    hostedTaskArchiveEntriesDefinition,
    hostedTaskArchiveEntryPartsDefinition,
  ],
} as const
