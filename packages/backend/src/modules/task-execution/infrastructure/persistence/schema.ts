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

const hostedTaskArtifactsDefinition = owner.table({
  id: 'hosted_task_artifacts',
  schemaSymbol: 'hostedTaskArtifacts',
  columns: {
    reference: c.id('reference', { primary: true }),
    taskId: c.id('task_id'),
    objectId: c.id('object_id'),
    digest: c.text('digest'),
    size: c.int('size'),
    createdAt: c.epochMs('created_at'),
  },
  retention: retention.business,
})

export const hostedTaskArtifacts = materializeDrizzle(hostedTaskArtifactsDefinition).table

const hostedTaskArchiveEntriesDefinition = owner.table({
  id: 'hosted_task_archive_entries',
  schemaSymbol: 'hostedTaskArchiveEntries',
  columns: {
    path: c.id('path', { primary: true }),
    kind: c.enum('kind', ['directory', 'file']),
    partsJson: c.jsonText('parts_json', { default: '[]' }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'hosted_task_archive_entries_kind_known',
      expression: raw(
        '"hosted_task_archive_entries"."kind" IN (\'directory\', \'file\')',
        "\"kind\" IN ('directory', 'file')",
      ),
    },
  ],
  retention: retention.business,
})

export const hostedTaskArchiveEntries = materializeDrizzle(hostedTaskArchiveEntriesDefinition).table

const hostedNodeEventArchivesDefinition = owner.table({
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
    objectId: c.id('object_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  checks: [
    {
      name: 'hosted_node_event_archives_state_known',
      expression: raw(
        '"hosted_node_event_archives"."state" IN (\'prepared\', \'ready\')',
        "\"state\" IN ('prepared', 'ready')",
      ),
    },
    {
      name: 'hosted_node_event_archives_object_known',
      expression: raw(
        '("hosted_node_event_archives"."state" = \'prepared\' AND "hosted_node_event_archives"."object_id" IS NULL) OR ("hosted_node_event_archives"."state" = \'ready\' AND "hosted_node_event_archives"."object_id" IS NOT NULL)',
        '("state" = \'prepared\' AND "object_id" IS NULL) OR ("state" = \'ready\' AND "object_id" IS NOT NULL)',
      ),
    },
    {
      name: 'hosted_node_event_archives_range',
      expression: raw(
        '"hosted_node_event_archives"."first_id" > 0 AND "hosted_node_event_archives"."last_id" >= "hosted_node_event_archives"."first_id" AND "hosted_node_event_archives"."row_count" > 0',
        '"first_id" > 0 AND "last_id" >= "first_id" AND "row_count" > 0',
      ),
    },
  ],
  indexes: [
    index('hosted_node_event_archives_run', ['task_id', 'node_run_id', 'last_id']),
    index('hosted_node_event_archives_pending', ['state', 'created_at']),
  ],
  retention: retention.operational,
})

export const hostedNodeEventArchives = materializeDrizzle(hostedNodeEventArchivesDefinition).table

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

const nodeRunOutputsDefinition = owner.table({
  id: 'node_run_outputs',
  schemaSymbol: 'nodeRunOutputs',
  columns: {
    nodeRunId: c.id('node_run_id'),
    portName: c.text('port_name'),
    content: c.text('content'),
    kind: c.text('kind', { nullable: true }),
    archiveJson: c.jsonText('archive_json', { nullable: true }),
    active: c.bool('active', { default: true }),
  },
  primaryKey: ['node_run_id', 'port_name'],
  foreignKeys: [
    foreignKey(
      'node_run_outputs_node_run_id_node_runs_id_fk',
      ['node_run_id'],
      'node_runs',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  retention: retention.business,
})

export const nodeRunOutputs = materializeDrizzle(nodeRunOutputsDefinition).table

const nodeRunsDefinition = owner.table({
  id: 'node_runs',
  schemaSymbol: 'nodeRuns',
  columns: {
    id: c.id('id', { primary: true }),
    taskId: c.id('task_id'),
    nodeId: c.id('node_id'),
    parentNodeRunId: c.id('parent_node_run_id', { nullable: true }),
    containerRunId: c.id('container_run_id', { nullable: true }),
    scopePath: c.text('scope_path', { default: '' }),
    iteration: c.int('iteration', { default: 0 }),
    shardKey: c.id('shard_key', { nullable: true }),
    retryIndex: c.int('retry_index', { default: 0 }),
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
    pid: c.int('pid', { nullable: true }),
    spawnBinaryPath: c.text('spawn_binary_path', { nullable: true }),
    spawnLaunchNonce: c.text('spawn_launch_nonce', { nullable: true }),
    exitCode: c.int('exit_code', { nullable: true }),
    errorMessage: c.text('error_message', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    promptText: c.text('prompt_text', { nullable: true }),
    promptPath: c.text('prompt_path', { nullable: true }),
    envelopeNonce: c.text('envelope_nonce', { nullable: true }),
    forceActivated: c.bool('force_activated', { default: false }),
    tokInput: c.int('tok_input', { nullable: true }),
    tokOutput: c.int('tok_output', { nullable: true }),
    tokCacheCreate: c.int('tok_cache_create', { nullable: true }),
    tokCacheRead: c.int('tok_cache_read', { nullable: true }),
    tokTotal: c.int('tok_total', { nullable: true }),
    preSnapshot: c.text('pre_snapshot', { nullable: true }),
    opencodeSessionId: c.id('opencode_session_id', { nullable: true }),
    runtime: c.text('runtime', { nullable: true }),
    runtimeBinary: c.text('runtime_binary', { nullable: true }),
    runtimeParamsJson: c.jsonText('runtime_params_json', { nullable: true }),
    inventorySnapshotJson: c.jsonText('inventory_snapshot_json', { nullable: true }),
    runtimeInventoryJson: c.jsonText('runtime_inventory_json', { nullable: true }),
    startupVerificationJson: c.jsonText('startup_verification_json', { nullable: true }),
    wrapperProgressJson: c.jsonText('wrapper_progress_json', { nullable: true }),
    injectedMemoriesJson: c.jsonText('injected_memories_json', { nullable: true }),
    portValidationFailuresJson: c.jsonText('port_validation_failures_json', { nullable: true }),
    commitPushJson: c.jsonText('commit_push_json', { nullable: true }),
    preSnapshotReposJson: c.jsonText('pre_snapshot_repos_json', { nullable: true }),
    isoWorktreePath: c.text('iso_worktree_path', { nullable: true }),
    isoBaseSnapshot: c.text('iso_base_snapshot', { nullable: true }),
    isoBaseSnapshotReposJson: c.jsonText('iso_base_snapshot_repos_json', { nullable: true }),
    isoNodeTree: c.text('iso_node_tree', { nullable: true }),
    isoNodeTreeReposJson: c.jsonText('iso_node_tree_repos_json', { nullable: true }),
    isoSubmodulesJson: c.jsonText('iso_submodules_json', { nullable: true }),
    isoSubmodulesReposJson: c.jsonText('iso_submodules_repos_json', { nullable: true }),
    mergeState: c.text('merge_state', { nullable: true }),
    consumedUpstreamRunsJson: c.jsonText('consumed_upstream_runs_json', { nullable: true }),
    shardValueHash: c.text('shard_value_hash', { nullable: true }),
    rerunCause: c.text('rerun_cause', { nullable: true }),
    supersededByReview: c.text('superseded_by_review', { nullable: true }),
    rolledBack: c.bool('rolled_back', { nullable: true }),
    agentOverrideName: c.text('agent_override_name', { nullable: true }),
    agentOverrideId: c.id('agent_override_id', { nullable: true }),
    childTaskId: c.id('child_task_id', { nullable: true }),
    continuationSlotKey: c.id('continuation_slot_key', { nullable: true }),
    lineageSlotPathJson: c.jsonText('lineage_slot_path_json', { nullable: true }),
    operationGeneration: c.int('operation_generation', { default: 0 }),
    seq: c.int('seq', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('node_runs_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index('idx_node_runs_task_seq', ['task_id', 'seq'], { unique: true }),
    index('idx_node_runs_task', ['task_id', 'node_id', 'iteration', 'retry_index']),
    index('idx_node_runs_parent', ['parent_node_run_id']),
    index('idx_node_runs_container', ['task_id', 'container_run_id', 'node_id', 'iteration']),
    index('idx_node_runs_child_task', ['child_task_id']),
    index('idx_node_runs_status_active', ['status', 'started_at']),
  ],
  retention: retention.business,
})

export const nodeRuns = materializeDrizzle(nodeRunsDefinition).table

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

const runtimeSessionLeasesDefinition = owner.table({
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
  foreignKeys: [
    foreignKey('runtime_session_leases_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'runtime_session_leases_all_or_none',
      expression: raw(
        '(\n        (\n          "runtime_session_leases"."lease_node_run_id" IS NULL\n          AND "runtime_session_leases"."lease_nonce_digest" IS NULL\n          AND "runtime_session_leases"."leased_at" IS NULL\n        )\n        OR\n        (\n          "runtime_session_leases"."lease_node_run_id" IS NOT NULL\n          AND "runtime_session_leases"."lease_nonce_digest" IS NOT NULL\n          AND "runtime_session_leases"."leased_at" IS NOT NULL\n        )\n      )',
        '( ( "lease_node_run_id" IS NULL AND "lease_nonce_digest" IS NULL AND "leased_at" IS NULL ) OR ( "lease_node_run_id" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL AND "leased_at" IS NOT NULL ) )',
      ),
    },
    {
      name: 'runtime_session_leases_protocol_shape',
      expression: raw(
        '"runtime_session_leases"."protocol" IN (\'opencode\', \'claude-code\')',
        "\"protocol\" IN ('opencode', 'claude-code')",
      ),
    },
    {
      name: 'runtime_session_leases_reset_pending_held',
      expression: raw(
        '"runtime_session_leases"."reset_pending" = 0 OR "runtime_session_leases"."lease_node_run_id" IS NOT NULL',
        '"reset_pending" = FALSE OR "lease_node_run_id" IS NOT NULL',
      ),
    },
    {
      name: 'runtime_session_leases_reset_pending_shape',
      expression: raw(
        '"runtime_session_leases"."reset_pending" IN (0, 1)',
        '"reset_pending" IN (FALSE, TRUE)',
      ),
    },
  ],
  indexes: [
    index('idx_runtime_session_leases_task', ['task_id']),
    index('idx_runtime_session_leases_created_run', ['created_node_run_id']),
    index('idx_runtime_session_leases_lease_run', ['lease_node_run_id']),
  ],
  retention: retention.operational,
})

export const runtimeSessionLeases = materializeDrizzle(runtimeSessionLeasesDefinition).table

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

const taskReposDefinition = owner.table({
  id: 'task_repos',
  schemaSymbol: 'taskRepos',
  columns: {
    taskId: c.id('task_id'),
    repoIndex: c.int('repo_index'),
    repoPath: c.text('repo_path'),
    repoUrl: c.text('repo_url', { nullable: true }),
    cachedRepoId: c.id('cached_repo_id', { nullable: true }),
    baseBranch: c.text('base_branch', { default: '' }),
    branch: c.text('branch'),
    workingBranch: c.text('working_branch', { nullable: true }),
    baseCommit: c.text('base_commit', { nullable: true }),
    worktreePath: c.text('worktree_path'),
    worktreeDirName: c.text('worktree_dir_name', { default: '' }),
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
  },
  primaryKey: ['task_id', 'repo_index'],
  foreignKeys: [
    foreignKey('task_repos_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  indexes: [
    index('idx_task_repos_repo_path', ['repo_path']),
    index('idx_task_repos_repo_url', ['repo_url']),
    index('idx_task_repos_cached_repo_id', ['cached_repo_id']),
    index('idx_task_repos_cached_repo_task', ['cached_repo_id', 'task_id']),
  ],
  retention: retention.business,
})

export const taskRepos = materializeDrizzle(taskReposDefinition).table

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

const tasksDefinition = owner.table({
  id: 'tasks',
  schemaSymbol: 'tasks',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    workflowId: c.id('workflow_id'),
    workflowSnapshot: c.text('workflow_snapshot'),
    workflowVersion: c.int('workflow_version', { nullable: true }),
    repoPath: c.text('repo_path'),
    repoUrl: c.text('repo_url', { nullable: true }),
    cachedRepoId: c.id('cached_repo_id', { nullable: true }),
    repoGroupId: c.id('repo_group_id', { nullable: true }),
    repoGroupName: c.text('repo_group_name', { nullable: true }),
    worktreePath: c.text('worktree_path'),
    baseBranch: c.text('base_branch'),
    branch: c.text('branch'),
    baseCommit: c.text('base_commit', { nullable: true }),
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
    inputs: c.jsonText('inputs'),
    maxDurationMs: c.int('max_duration_ms', { nullable: true }),
    maxTotalTokens: c.int('max_total_tokens', { nullable: true }),
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
    schemaVersion: c.int('schema_version', { default: 1 }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    launchOrigin: c.enum('launch_origin', ['manual', 'scheduled', 'event', 'webhook', 'api'], {
      default: 'manual',
    }),
    catalogVisibility: c.enum('catalog_visibility', ['public', 'internal'], { default: 'public' }),
    gitUserName: c.text('git_user_name', { nullable: true }),
    gitUserEmail: c.text('git_user_email', { nullable: true }),
    workingBranch: c.text('working_branch', { nullable: true }),
    autoCommitPush: c.bool('auto_commit_push', { default: false }),
    repoCount: c.int('repo_count', { default: 1 }),
    scheduledTaskId: c.id('scheduled_task_id', { nullable: true }),
    webhookTriggerId: c.id('webhook_trigger_id', { nullable: true }),
    webhookFireId: c.id('webhook_fire_id', { nullable: true }),
    eventSubscriptionId: c.id('event_subscription_id', { nullable: true }),
    eventDeliveryId: c.id('event_delivery_id', { nullable: true }),
    lifecycleEventRevision: c.int('lifecycle_event_revision', { default: 1 }),
    sourceTerminationBinding: c.text('source_termination_binding', { nullable: true }),
    sourceTerminationLaunchRev: c.int('source_termination_launch_rev', { nullable: true }),
    sourceTerminationFence: c.enum('source_termination_fence', ['closed', 'merged'], {
      nullable: true,
    }),
    sourceTerminationEffectRev: c.int('source_termination_effect_rev', { nullable: true }),
    workgroupId: c.id('workgroup_id', { nullable: true }),
    workgroupConfigJson: c.jsonText('workgroup_config_json', { nullable: true }),
    spaceKind: c.enum('space_kind', ['local', 'remote', 'scratch', 'internal', 'inherited'], {
      default: 'remote',
    }),
    sourceAgentName: c.text('source_agent_name', { nullable: true }),
    codeRoundId: c.id('code_round_id', { nullable: true }),
    digitalEmployeeRoundId: c.id('digital_employee_round_id', { nullable: true }),
    digitalEmployeeCaseId: c.id('digital_employee_case_id', { nullable: true }),
    sourceAgentId: c.id('source_agent_id', { nullable: true }),
    workspacePruningAt: c.epochMs('workspace_pruning_at', { nullable: true }),
    workspacePruneCause: c.enum('workspace_prune_cause', ['webhook-terminal'], { nullable: true }),
    workspacePrunedAt: c.epochMs('workspace_pruned_at', { nullable: true }),
    parentTaskId: c.id('parent_task_id', { nullable: true }),
    parentNodeRunId: c.id('parent_node_run_id', { nullable: true }),
    invocationDepth: c.int('invocation_depth', { default: 0 }),
    refClosureJson: c.jsonText('ref_closure_json', { nullable: true }),
    triggerContextJson: c.jsonText('trigger_context_json', { nullable: true }),
    platformInputPathsJson: c.jsonText('platform_input_paths_json', { nullable: true }),
    branchStartedAt: c.epochMs('branch_started_at', { default: 0 }),
    rootTaskId: c.id('root_task_id', { nullable: true }),
    executionLineageId: c.id('execution_lineage_id', { nullable: true }),
    lineageSlotPathJson: c.jsonText('lineage_slot_path_json', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('tasks_parent_task_id_tasks_id_fk', ['parent_task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  checks: [
    {
      name: 'tasks_workspace_pruning_at_shape',
      expression: raw(
        '"tasks"."workspace_prune_cause" IS NULL OR ( "tasks"."workspace_prune_cause" = \'webhook-terminal\' AND "tasks"."workspace_pruning_at" IS NOT NULL )',
        '"workspace_prune_cause" IS NULL OR ( "workspace_prune_cause" = \'webhook-terminal\' AND "workspace_pruning_at" IS NOT NULL )',
      ),
    },
    {
      name: 'tasks_source_termination_launch_rev_nonnegative',
      expression: raw(
        '"tasks"."source_termination_launch_rev" IS NULL OR "tasks"."source_termination_launch_rev" >= 0',
        '"source_termination_launch_rev" IS NULL OR "source_termination_launch_rev" >= 0',
      ),
    },
    {
      name: 'tasks_source_termination_fence_enum',
      expression: raw(
        '"tasks"."source_termination_fence" IS NULL OR "tasks"."source_termination_fence" IN (\'closed\',\'merged\')',
        '"source_termination_fence" IS NULL OR "source_termination_fence" IN (\'closed\',\'merged\')',
      ),
    },
    {
      name: 'tasks_source_termination_effect_rev_positive',
      expression: raw(
        '"tasks"."source_termination_effect_rev" IS NULL OR "tasks"."source_termination_effect_rev" >= 1',
        '"source_termination_effect_rev" IS NULL OR "source_termination_effect_rev" >= 1',
      ),
    },
    {
      name: 'tasks_launch_origin_enum',
      expression: raw(
        "\"tasks\".\"launch_origin\" IN ('manual', 'scheduled', 'webhook', 'api', 'event')",
        "\"launch_origin\" IN ('manual', 'scheduled', 'webhook', 'api', 'event')",
      ),
    },
  ],
  indexes: [
    index('idx_tasks_live', ['id'], {
      where: raw('"tasks"."deleted_at" is null', '"deleted_at" is null'),
    }),
    index('idx_tasks_list_started_id', ['started_at', 'id']),
    index('idx_tasks_branch_started_id', ['branch_started_at', 'id']),
    index('idx_tasks_cached_repo', ['cached_repo_id']),
    index('idx_tasks_cached_repo_task', ['cached_repo_id', 'id']),
    index('idx_tasks_status_finished', ['status', 'finished_at']),
    index('idx_tasks_source_agent', ['source_agent_id']),
    index('idx_tasks_code_round', ['code_round_id']),
    index('idx_tasks_digital_employee_round', ['digital_employee_round_id']),
    index('idx_tasks_list_status_started_id', ['status', 'started_at', 'id']),
    index('idx_tasks_list_parent_started_id', ['parent_task_id', 'started_at', 'id']),
    index('idx_tasks_list_owner_started_id', ['owner_user_id', 'started_at', 'id']),
    index('idx_tasks_workflow', ['workflow_id', 'started_at']),
    index('idx_tasks_scheduled_task', ['scheduled_task_id']),
    index('idx_tasks_webhook_trigger', ['webhook_trigger_id']),
    index('idx_tasks_event_subscription', ['event_subscription_id']),
    index('idx_tasks_event_delivery_unique', ['event_delivery_id'], {
      unique: true,
      where: raw('"tasks"."event_delivery_id" IS NOT NULL', '"event_delivery_id" IS NOT NULL'),
    }),
    index('idx_tasks_source_termination', [
      'source_termination_binding',
      'source_termination_launch_rev',
    ]),
    index('idx_tasks_root_missing', ['id'], {
      where: raw('"tasks"."root_task_id" is null', '"root_task_id" is null'),
    }),
    index('idx_tasks_root_started', ['root_task_id', 'started_at']),
    index('idx_tasks_status_parent_finished', ['status', 'parent_task_id', 'finished_at']),
    index('idx_tasks_overview_counts', [
      'status',
      'parent_task_id',
      'catalog_visibility',
      'finished_at',
    ]),
    index('idx_tasks_list_facets_cover', [
      'catalog_visibility',
      'source_agent_name',
      'workgroup_id',
      'status',
      'id',
    ]),
    index('idx_tasks_status_workgroup', ['status', 'workgroup_id']),
    index('idx_tasks_workgroup', ['workgroup_id']),
  ],
  retention: retention.business,
})

export const tasks = materializeDrizzle(tasksDefinition).table

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

const workgroupTaskStateDefinition = owner.table({
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
  },
  foreignKeys: [
    foreignKey('workgroup_task_state_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
      onDelete: 'cascade',
    }),
  ],
  retention: retention.business,
})

export const workgroupTaskState = materializeDrizzle(workgroupTaskStateDefinition).table

export const schemaContribution = owner.contribution([
  hostedExecutionBindingsDefinition,
  hostedExecutionEventsDefinition,
  hostedTaskArtifactsDefinition,
  hostedTaskArchiveEntriesDefinition,
  hostedNodeEventArchivesDefinition,
  nodeExecutionEventSourcesDefinition,
  nodeRunEventsDefinition,
  nodeRunOutputsDefinition,
  nodeRunsDefinition,
  nodeRunSeqAllocationsDefinition,
  hostedRecoveryRequestsDefinition,
  reactionExecutionAdmissionsDefinition,
  runtimeSessionLeasesDefinition,
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
  taskReposDefinition,
  taskWorkspacePreparationsDefinition,
  taskSpaceNodesDefinition,
  tasksDefinition,
  workgroupAssignmentsDefinition,
  workgroupMemberCursorsDefinition,
  workgroupMessagesDefinition,
  workgroupTaskStateDefinition,
])
