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

const owner = defineContribution('digital-employee')

const employeeApprovalSagasDefinition = owner.table({
  id: 'employee_approval_sagas',
  schemaSymbol: 'employeeApprovalSagas',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    submitRoundId: c.id('submit_round_id'),
    adapterId: c.id('adapter_id'),
    adapterRevision: c.int('adapter_revision'),
    validatedDraftRef: c.id('validated_draft_ref'),
    deadlineAt: c.text('deadline_at'),
    idempotencyKey: c.id('idempotency_key'),
    intentDigest: c.id('intent_digest'),
    correlationRef: c.id('correlation_ref', { nullable: true }),
    externalRequestRef: c.id('external_request_ref', { nullable: true }),
    submittedRevision: c.text('submitted_revision', { nullable: true }),
    submittedAt: c.text('submitted_at', { nullable: true }),
    latestStatus: c.enum(
      'latest_status',
      ['prepared', 'pending', 'approved', 'rejected', 'expired', 'unavailable'],
      { default: 'prepared' },
    ),
    observedRevision: c.text('observed_revision', { nullable: true }),
    evidenceRef: c.id('evidence_ref', { nullable: true }),
    observedAt: c.text('observed_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_approval_sagas_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_approval_sagas_submit_round_id_employee_reaction_rounds_id_fk',
      ['submit_round_id'],
      'employee_reaction_rounds',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_approval_sagas_idempotency_unique', ['idempotency_key'], { unique: true }),
    index(
      'employee_approval_sagas_correlation_unique',
      ['adapter_id', 'adapter_revision', 'correlation_ref'],
      {
        unique: true,
        where: raw(
          '"employee_approval_sagas"."correlation_ref" is not null',
          '"correlation_ref" is not null',
        ),
      },
    ),
    index('idx_employee_approval_sagas_case_state', ['case_id', 'latest_status', 'updated_at']),
  ],
  retention: retention.business,
})

export const employeeApprovalSagas = materializeDrizzle(employeeApprovalSagasDefinition).table

const employeeAttentionBindingsDefinition = owner.table({
  id: 'employee_attention_bindings',
  schemaSymbol: 'employeeAttentionBindings',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    contextId: c.id('context_id'),
    contextRevision: c.int('context_revision'),
    eventTypeId: c.id('event_type_id'),
    eventTypeRevision: c.int('event_type_revision'),
    subjectType: c.text('subject_type'),
    subjectRef: c.id('subject_ref'),
    desiredIdentityKey: c.id('desired_identity_key'),
    eventSubscriptionId: c.id('event_subscription_id', { nullable: true }),
    state: c.enum('state', ['desired', 'active', 'cancel-requested', 'cancelled'], {
      default: 'desired',
    }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_attention_bindings_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_attention_bindings_context_id_employee_context_records_id_fk',
      ['context_id'],
      'employee_context_records',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_attention_desired_identity_unique', ['desired_identity_key'], { unique: true }),
    index('idx_employee_attention_case_state', ['case_id', 'state', 'updated_at']),
  ],
  retention: retention.business,
})

export const employeeAttentionBindings = materializeDrizzle(
  employeeAttentionBindingsDefinition,
).table

const employeeCaseEventOriginsDefinition = owner.table({
  id: 'employee_case_event_origins',
  schemaSymbol: 'employeeCaseEventOrigins',
  columns: {
    caseId: c.id('case_id', { primary: true }),
    eventSubscriptionId: c.id('event_subscription_id'),
    eventDeliveryId: c.id('event_delivery_id'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_case_event_origins_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_case_event_origins_delivery_unique', ['event_delivery_id'], { unique: true }),
    index('idx_employee_case_event_origins_subscription', ['event_subscription_id', 'created_at']),
  ],
  retention: retention.operational,
})

export const employeeCaseEventOrigins = materializeDrizzle(employeeCaseEventOriginsDefinition).table

const employeeCaseInboxDefinition = owner.table({
  id: 'employee_case_inbox',
  schemaSymbol: 'employeeCaseInbox',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    deliveryId: c.id('delivery_id'),
    eventId: c.id('event_id'),
    eventTypeId: c.id('event_type_id'),
    eventTypeRevision: c.int('event_type_revision'),
    sourceId: c.id('source_id'),
    sourceRevision: c.int('source_revision'),
    subjectType: c.text('subject_type'),
    subjectRef: c.id('subject_ref'),
    deliveryClass: c.text('delivery_class'),
    priority: c.int('priority'),
    occurredAt: c.epochMs('occurred_at'),
    summary: c.text('summary'),
    payloadArtifactRef: c.id('payload_artifact_ref', { nullable: true }),
    state: c.enum('state', ['pending', 'claimed', 'settled', 'coalesced', 'obsolete'], {
      default: 'pending',
    }),
    roundId: c.id('round_id', { nullable: true }),
    acceptedAt: c.epochMs('accepted_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey('employee_case_inbox_case_id_employee_cases_id_fk', ['case_id'], 'employee_cases', [
      'id',
    ]),
  ],
  indexes: [
    index('employee_case_inbox_delivery_unique', ['delivery_id'], { unique: true }),
    index('idx_employee_case_inbox_queue', [
      'case_id',
      'state',
      'priority',
      'occurred_at',
      'event_id',
    ]),
  ],
  retention: retention.business,
})

export const employeeCaseInbox = materializeDrizzle(employeeCaseInboxDefinition).table

const employeeCaseMembersDefinition = owner.table({
  id: 'employee_case_members',
  schemaSymbol: 'employeeCaseMembers',
  columns: {
    caseId: c.id('case_id'),
    userId: c.id('user_id'),
    role: c.enum('role', ['collaborator', 'observer']),
    addedBy: c.text('added_by'),
    addedAt: c.epochMs('added_at'),
  },
  primaryKey: ['case_id', 'user_id'],
  foreignKeys: [
    foreignKey(
      'employee_case_members_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
      { onDelete: 'cascade' },
    ),
    foreignKey('employee_case_members_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
      onDelete: 'restrict',
    }),
  ],
  checks: [
    {
      name: 'employee_case_members_role_enum',
      expression: raw(
        '"employee_case_members"."role" IN (\'collaborator\', \'observer\')',
        "\"role\" IN ('collaborator', 'observer')",
      ),
    },
  ],
  indexes: [index('idx_employee_case_members_user', ['user_id', 'case_id'])],
  retention: retention.business,
})

export const employeeCaseMembers = materializeDrizzle(employeeCaseMembersDefinition).table

const employeeCaseMeteringReceiptsDefinition = owner.table({
  id: 'employee_case_metering_receipts',
  schemaSymbol: 'employeeCaseMeteringReceipts',
  columns: {
    sourceRef: c.id('source_ref', { primary: true }),
    caseId: c.id('case_id'),
    roundId: c.id('round_id'),
    durationMs: c.int('duration_ms'),
    totalTokens: c.int('total_tokens'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_case_metering_receipts_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
      { onDelete: 'cascade' },
    ),
  ],
  indexes: [index('idx_employee_case_metering_case', ['case_id', 'created_at'])],
  retention: retention.business,
})

export const employeeCaseMeteringReceipts = materializeDrizzle(
  employeeCaseMeteringReceiptsDefinition,
).table

const employeeCaseWorkspacesDefinition = owner.table({
  id: 'employee_case_workspaces',
  schemaSymbol: 'employeeCaseWorkspaces',
  columns: {
    caseId: c.id('case_id', { primary: true }),
    repositoryId: c.id('repository_id'),
    cachedRepoId: c.id('cached_repo_id'),
    baselineSha: c.text('baseline_sha'),
    targetBranch: c.text('target_branch'),
    sourceBranch: c.text('source_branch'),
    remoteHeadSha: c.text('remote_head_sha', { nullable: true }),
    state: c.enum('state', ['active', 'published', 'released'], { default: 'active' }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_case_workspaces_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [
    index('idx_employee_case_workspaces_repo_state', ['repository_id', 'state', 'updated_at']),
  ],
  retention: retention.business,
})

export const employeeCaseWorkspaces = materializeDrizzle(employeeCaseWorkspacesDefinition).table

const employeeCasesDefinition = owner.table({
  id: 'employee_cases',
  schemaSymbol: 'employeeCases',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name', { default: '' }),
    employeeId: c.id('employee_id'),
    employeeRevision: c.int('employee_revision'),
    typeId: c.id('type_id'),
    typeRevision: c.int('type_revision'),
    primaryContextId: c.id('primary_context_id'),
    executionPolicyRevision: c.int('execution_policy_revision'),
    maxDurationMs: c.int('max_duration_ms', { nullable: true }),
    consumedDurationMs: c.int('consumed_duration_ms', { default: 0 }),
    maxTotalTokens: c.int('max_total_tokens', { nullable: true }),
    consumedTotalTokens: c.int('consumed_total_tokens', { default: 0 }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    launchOrigin: c.enum('launch_origin', ['manual', 'scheduled', 'event', 'webhook', 'api'], {
      default: 'api',
    }),
    state: c.enum('state', ['active', 'waiting', 'blocked', 'terminal'], { default: 'active' }),
    terminalKind: c.text('terminal_kind', { nullable: true }),
    blockReason: c.text('block_reason', { nullable: true }),
    currentWorkItemRef: c.id('current_work_item_ref', { nullable: true }),
    activeRoundId: c.id('active_round_id', { nullable: true }),
    revision: c.int('revision', { default: 1 }),
    writerGeneration: c.int('writer_generation', { default: 1 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    terminalAt: c.epochMs('terminal_at', { nullable: true }),
  },
  indexes: [
    index('idx_employee_cases_employee_state', [
      'employee_id',
      'employee_revision',
      'state',
      'updated_at',
    ]),
    index('idx_employee_cases_state_employee_terminal', ['state', 'employee_id', 'terminal_kind']),
    index('idx_employee_cases_owner_origin_updated', [
      'owner_user_id',
      'launch_origin',
      'updated_at',
      'id',
    ]),
  ],
  retention: retention.business,
})

export const employeeCases = materializeDrizzle(employeeCasesDefinition).table

const employeeChangeCandidatesDefinition = owner.table({
  id: 'employee_change_candidates',
  schemaSymbol: 'employeeChangeCandidates',
  columns: {
    candidateRef: c.id('candidate_ref', { primary: true }),
    caseId: c.id('case_id'),
    roundId: c.id('round_id'),
    baselineSha: c.text('baseline_sha'),
    treeOid: c.text('tree_oid'),
    receiptJson: c.jsonText('receipt_json'),
    summarySource: c.text('summary_source'),
    state: c.enum('state', ['prepared', 'committed', 'published', 'obsolete'], {
      default: 'prepared',
    }),
    commitSha: c.text('commit_sha', { nullable: true }),
    pushReceiptJson: c.jsonText('push_receipt_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_change_candidates_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_change_candidates_round_id_employee_reaction_rounds_id_fk',
      ['round_id'],
      'employee_reaction_rounds',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_change_candidates_round_unique', ['round_id'], { unique: true }),
    index('idx_employee_change_candidates_case_state', ['case_id', 'state', 'updated_at']),
  ],
  retention: retention.business,
})

export const employeeChangeCandidates = materializeDrizzle(employeeChangeCandidatesDefinition).table

const employeeChannelResultsDefinition = owner.table({
  id: 'employee_channel_results',
  schemaSymbol: 'employeeChannelResults',
  columns: {
    id: c.id('id', { primary: true }),
    channelId: c.id('channel_id'),
    milestoneType: c.text('milestone_type'),
    envelopeJson: c.jsonText('envelope_json'),
    envelopeDigest: c.id('envelope_digest'),
    monotonic: c.bool('monotonic', { default: false }),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_channel_results_channel_id_employee_channels_id_fk',
      ['channel_id'],
      'employee_channels',
      ['id'],
    ),
  ],
  indexes: [
    index(
      'employee_channel_results_identity_unique',
      ['channel_id', 'milestone_type', 'envelope_digest'],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const employeeChannelResults = materializeDrizzle(employeeChannelResultsDefinition).table

const employeeChannelsDefinition = owner.table({
  id: 'employee_channels',
  schemaSymbol: 'employeeChannels',
  columns: {
    id: c.id('id', { primary: true }),
    invocationId: c.id('invocation_id'),
    parentCaseId: c.id('parent_case_id'),
    childCaseId: c.id('child_case_id'),
    correlationRef: c.id('correlation_ref'),
    resultContractRefJson: c.jsonText('result_contract_ref_json'),
    state: c.enum('state', ['open', 'satisfied', 'failed', 'detached'], { default: 'open' }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_channels_invocation_id_employee_invocations_id_fk',
      ['invocation_id'],
      'employee_invocations',
      ['id'],
    ),
    foreignKey(
      'employee_channels_parent_case_id_employee_cases_id_fk',
      ['parent_case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_channels_child_case_id_employee_cases_id_fk',
      ['child_case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [index('employee_channels_invocation_unique', ['invocation_id'], { unique: true })],
  retention: retention.business,
})

export const employeeChannels = materializeDrizzle(employeeChannelsDefinition).table

const employeeContextLinksDefinition = owner.table({
  id: 'employee_context_links',
  schemaSymbol: 'employeeContextLinks',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    fromContextId: c.id('from_context_id'),
    relation: c.enum('relation', [
      'derived-from',
      'handles',
      'delivers',
      'tracks',
      'delegates-to',
      'supersedes',
    ]),
    toContextId: c.id('to_context_id'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_context_links_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [
    index(
      'employee_context_links_identity_unique',
      ['case_id', 'from_context_id', 'relation', 'to_context_id'],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const employeeContextLinks = materializeDrizzle(employeeContextLinksDefinition).table

const employeeContextRecordsDefinition = owner.table({
  id: 'employee_context_records',
  schemaSymbol: 'employeeContextRecords',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    typeId: c.id('type_id'),
    schemaVersion: c.int('schema_version'),
    currentRevision: c.int('current_revision'),
    lifecycleState: c.enum('lifecycle_state', ['active', 'waiting', 'terminal']),
    stateJson: c.jsonText('state_json'),
    artifactRefsJson: c.jsonText('artifact_refs_json'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_context_records_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [index('idx_employee_context_case_type', ['case_id', 'type_id', 'lifecycle_state'])],
  retention: retention.business,
})

export const employeeContextRecords = materializeDrizzle(employeeContextRecordsDefinition).table

const employeeContextRevisionsDefinition = owner.table({
  id: 'employee_context_revisions',
  schemaSymbol: 'employeeContextRevisions',
  columns: {
    contextId: c.id('context_id'),
    revision: c.int('revision'),
    stateJson: c.jsonText('state_json'),
    artifactRefsJson: c.jsonText('artifact_refs_json'),
    contentDigest: c.id('content_digest'),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['context_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'employee_context_revisions_context_id_employee_context_records_id_fk',
      ['context_id'],
      'employee_context_records',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const employeeContextRevisions = materializeDrizzle(employeeContextRevisionsDefinition).table

const employeeDefinitionRevisionsDefinition = owner.table({
  id: 'employee_definition_revisions',
  schemaSymbol: 'employeeDefinitionRevisions',
  columns: {
    employeeId: c.id('employee_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    createdAt: c.epochMs('published_at'),
    createdBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['employee_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'employee_definition_revisions_employee_id_employee_definitions_id_fk',
      ['employee_id'],
      'employee_definitions',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const employeeDefinitionRevisions = materializeDrizzle(
  employeeDefinitionRevisionsDefinition,
).table

const employeeDefinitionsDefinition = owner.table({
  id: 'employee_definitions',
  schemaSymbol: 'employeeDefinitions',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    typeId: c.id('type_id'),
    typeRevision: c.int('type_revision'),
    configurationJson: c.jsonText('draft_json'),
    currentRevision: c.int('published_revision', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'private' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    archivedAt: c.epochMs('archived_at', { nullable: true }),
  },
  indexes: [
    index(
      'employee_definitions_owner_name_unique',
      [
        raw(
          'COALESCE("employee_definitions"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
    index('idx_employee_definitions_type', ['type_id', 'type_revision', 'archived_at']),
  ],
  retention: retention.business,
})

export const employeeDefinitions = materializeDrizzle(employeeDefinitionsDefinition).table

const employeeExecutionPolicyRevisionsDefinition = owner.table({
  id: 'employee_execution_policy_revisions',
  schemaSymbol: 'employeeExecutionPolicyRevisions',
  columns: {
    revision: c.int('revision', { primary: true }),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  retention: retention.business,
})

export const employeeExecutionPolicyRevisions = materializeDrizzle(
  employeeExecutionPolicyRevisionsDefinition,
).table

const employeeExternalContextBindingsDefinition = owner.table({
  id: 'employee_external_context_bindings',
  schemaSymbol: 'employeeExternalContextBindings',
  columns: {
    subjectType: c.text('subject_type'),
    subjectRef: c.id('subject_ref'),
    caseId: c.id('case_id'),
    contextId: c.id('context_id'),
    bindingRevision: c.int('binding_revision'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['subject_type', 'subject_ref'],
  foreignKeys: [
    foreignKey(
      'employee_external_context_bindings_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_external_context_bindings_context_id_employee_context_records_id_fk',
      ['context_id'],
      'employee_context_records',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const employeeExternalContextBindings = materializeDrizzle(
  employeeExternalContextBindingsDefinition,
).table

const employeeInputUploadsDefinition = owner.table({
  id: 'employee_input_uploads',
  schemaSymbol: 'employeeInputUploads',
  columns: {
    id: c.id('id', { primary: true }),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    originalName: c.text('original_name'),
    bytes: c.int('bytes'),
    sha256: c.text('sha256'),
    blobRef: c.id('blob_ref'),
    uploadIdempotencyKey: c.id('upload_idempotency_key', { nullable: true }),
    state: c.enum('state', ['pending', 'claimed'], { default: 'pending' }),
    claimedByCaseId: c.id('claimed_by_case_id', { nullable: true }),
    expiresAt: c.epochMs('expires_at'),
    createdAt: c.epochMs('created_at'),
    claimedAt: c.epochMs('claimed_at', { nullable: true }),
  },
  indexes: [
    index(
      'employee_input_uploads_actor_idempotency_unique',
      [
        raw(
          'COALESCE("employee_input_uploads"."actor_user_id", \'\')',
          'COALESCE("actor_user_id", \'\')',
        ),
        'upload_idempotency_key',
      ],
      {
        unique: true,
        where: raw(
          '"employee_input_uploads"."upload_idempotency_key" IS NOT NULL',
          '"upload_idempotency_key" IS NOT NULL',
        ),
      },
    ),
    index('idx_employee_input_uploads_expiry', ['state', 'expires_at']),
  ],
  retention: retention.business,
})

export const employeeInputUploads = materializeDrizzle(employeeInputUploadsDefinition).table

const employeeInvocationsDefinition = owner.table({
  id: 'employee_invocations',
  schemaSymbol: 'employeeInvocations',
  columns: {
    id: c.id('id', { primary: true }),
    idempotencyKey: c.id('idempotency_key'),
    parentCaseId: c.id('parent_case_id'),
    parentRoundId: c.id('parent_round_id'),
    targetEmployeeId: c.id('target_employee_id'),
    targetEmployeeRevision: c.int('target_employee_revision'),
    targetWorkScopeRefJson: c.jsonText('target_work_scope_ref_json'),
    inputEnvelopeRef: c.id('input_envelope_ref'),
    inputDigest: c.id('input_digest'),
    completionContractRefJson: c.jsonText('completion_contract_ref_json'),
    deadlineAt: c.epochMs('deadline_at'),
    childCaseId: c.id('child_case_id', { nullable: true }),
    state: c.enum(
      'state',
      ['requested', 'accepted', 'waiting', 'satisfied', 'failed', 'detached'],
      { default: 'requested' },
    ),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_invocations_parent_case_id_employee_cases_id_fk',
      ['parent_case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_invocations_parent_round_id_employee_reaction_rounds_id_fk',
      ['parent_round_id'],
      'employee_reaction_rounds',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_invocations_idempotency_unique', ['idempotency_key'], { unique: true }),
    index('idx_employee_invocations_parent_state', ['parent_case_id', 'state', 'deadline_at']),
  ],
  retention: retention.business,
})

export const employeeInvocations = materializeDrizzle(employeeInvocationsDefinition).table

const employeeJobTemplateRevisionsDefinition = owner.table({
  id: 'employee_job_template_revisions',
  schemaSymbol: 'employeeJobTemplateRevisions',
  columns: {
    templateId: c.id('template_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['template_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'employee_job_template_revisions_template_id_employee_job_templates_id_fk',
      ['template_id'],
      'employee_job_templates',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const employeeJobTemplateRevisions = materializeDrizzle(
  employeeJobTemplateRevisionsDefinition,
).table

const employeeJobTemplatesDefinition = owner.table({
  id: 'employee_job_templates',
  schemaSymbol: 'employeeJobTemplates',
  columns: {
    id: c.id('id', { primary: true }),
    typeId: c.id('type_id'),
    typeRevision: c.int('type_revision'),
    name: c.text('name'),
    draftJson: c.jsonText('draft_json'),
    publishedRevision: c.int('published_revision', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    archivedAt: c.epochMs('archived_at', { nullable: true }),
  },
  indexes: [
    index(
      'employee_job_templates_owner_type_name_unique',
      [
        raw(
          'COALESCE("employee_job_templates"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'type_id',
        'type_revision',
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const employeeJobTemplates = materializeDrizzle(employeeJobTemplatesDefinition).table

const employeeOsOutboxDefinition = owner.table({
  id: 'employee_os_outbox',
  schemaSymbol: 'employeeOsOutbox',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id', { nullable: true }),
    kind: c.enum('kind', [
      'event-subscribe',
      'event-unsubscribe',
      'event-publish',
      'execution-launch',
      'platform-work-item-execute',
      'invocation-create',
    ]),
    payloadJson: c.jsonText('payload_json'),
    dedupeKey: c.id('dedupe_key'),
    state: c.enum('state', ['pending', 'claimed', 'completed', 'failed'], { default: 'pending' }),
    attemptCount: c.int('attempt_count', { default: 0 }),
    nextAttemptAt: c.epochMs('next_attempt_at'),
    claimedBy: c.text('claimed_by', { nullable: true }),
    claimExpiresAt: c.epochMs('claim_expires_at', { nullable: true }),
    lastError: c.text('last_error', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey('employee_os_outbox_case_id_employee_cases_id_fk', ['case_id'], 'employee_cases', [
      'id',
    ]),
  ],
  indexes: [
    index('employee_os_outbox_dedupe_unique', ['dedupe_key'], { unique: true }),
    index('idx_employee_os_outbox_due', ['state', 'next_attempt_at', 'claim_expires_at']),
  ],
  retention: retention.operational,
})

export const employeeOsOutbox = materializeDrizzle(employeeOsOutboxDefinition).table

const employeeOsSettingsDefinition = owner.table({
  id: 'employee_os_settings',
  schemaSymbol: 'employeeOsSettings',
  columns: {
    singletonKey: c.id('singleton_key', { primary: true }),
    executionPolicyRevision: c.int('execution_policy_revision'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'employee_os_settings_execution_policy_revision_employee_execution_policy_revisions_revision_fk',
      ['execution_policy_revision'],
      'employee_execution_policy_revisions',
      ['revision'],
    ),
  ],
  retention: retention.business,
})

export const employeeOsSettings = materializeDrizzle(employeeOsSettingsDefinition).table

const employeeOsWriterStateDefinition = owner.table({
  id: 'employee_os_writer_state',
  schemaSymbol: 'employeeOsWriterState',
  columns: {
    id: c.id('id', { primary: true }),
    activeGeneration: c.int('active_generation'),
    mode: c.enum('mode', ['pre-cutover', 'legacy-draining', 'os-active']),
    legacyAdmissionsEnabled: c.bool('legacy_admissions_enabled'),
    legacyOpenMissionCount: c.int('legacy_open_mission_count'),
    updatedAt: c.epochMs('updated_at'),
  },
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const employeeOsWriterState = materializeDrizzle(employeeOsWriterStateDefinition).table

const employeeReactionArtifactsDefinition = owner.table({
  id: 'employee_reaction_artifacts',
  schemaSymbol: 'employeeReactionArtifacts',
  columns: {
    digest: c.id('digest', { primary: true }),
    kind: c.enum('kind', ['retry-feedback', 'diagnostics']),
    body: c.text('body'),
    bytes: c.int('bytes'),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [index('idx_employee_reaction_artifacts_kind', ['kind', 'created_at'])],
  retention: retention.business,
})

export const employeeReactionArtifacts = materializeDrizzle(
  employeeReactionArtifactsDefinition,
).table

const employeeReactionDispatchDefinition = owner.table({
  id: 'employee_reaction_dispatch',
  schemaSymbol: 'employeeReactionDispatch',
  columns: {
    roundRef: c.id('round_ref', { primary: true }),
    caseId: c.id('case_id'),
    claimEpoch: c.int('claim_epoch', { default: 0 }),
    nextAttemptAt: c.epochMs('next_attempt_at', { default: 0 }),
    dispatchAttempts: c.int('dispatch_attempts', { default: 0 }),
    dispatchClaimedBy: c.text('dispatch_claimed_by', { nullable: true }),
    dispatchLeaseExpiresAt: c.epochMs('dispatch_lease_expires_at', { nullable: true }),
    lastDispatchError: c.text('last_dispatch_error', { nullable: true }),
    operationRef: c.id('operation_ref', { nullable: true }),
    retryFeedbackRef: c.id('retry_feedback_ref', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index('idx_employee_reaction_dispatch_due', ['next_attempt_at', 'dispatch_lease_expires_at']),
    index('idx_employee_reaction_dispatch_case', ['case_id']),
  ],
  retention: retention.business,
})

export const employeeReactionDispatch = materializeDrizzle(employeeReactionDispatchDefinition).table

const employeeReactionRoundsDefinition = owner.table({
  id: 'employee_reaction_rounds',
  schemaSymbol: 'employeeReactionRounds',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    caseRevision: c.int('case_revision'),
    inboxId: c.id('inbox_id', { nullable: true }),
    employeeId: c.id('employee_id'),
    employeeRevision: c.int('employee_revision'),
    ruleId: c.id('rule_id'),
    workItemRef: c.id('work_item_ref'),
    workContractId: c.id('work_contract_id'),
    workContractVersion: c.int('work_contract_version'),
    toolId: c.id('tool_id', { nullable: true }),
    toolRevision: c.int('tool_revision', { nullable: true }),
    executionPolicyRevision: c.int('execution_policy_revision'),
    inputContextRefsJson: c.jsonText('input_context_refs_json'),
    planJson: c.jsonText('plan_json'),
    state: c.enum('state', ['planned', 'running', 'settling', 'completed', 'failed', 'obsolete'], {
      default: 'planned',
    }),
    executionRef: c.id('execution_ref', { nullable: true }),
    outputJson: c.jsonText('output_json', { nullable: true }),
    attemptOrdinal: c.int('attempt_ordinal', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'employee_reaction_rounds_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
    foreignKey(
      'employee_reaction_rounds_inbox_id_employee_case_inbox_id_fk',
      ['inbox_id'],
      'employee_case_inbox',
      ['id'],
    ),
  ],
  indexes: [
    index('employee_reaction_rounds_inbox_unique', ['inbox_id'], { unique: true }),
    index('employee_reaction_rounds_one_active', ['case_id'], {
      unique: true,
      where: raw(
        "\"employee_reaction_rounds\".\"state\" IN ('planned', 'running', 'settling')",
        "\"state\" IN ('planned', 'running', 'settling')",
      ),
    }),
    index('idx_employee_reaction_rounds_execution', ['execution_ref', 'state']),
  ],
  retention: retention.business,
})

export const employeeReactionRounds = materializeDrizzle(employeeReactionRoundsDefinition).table

const employeeRoundWorkspaceStatesDefinition = owner.table({
  id: 'employee_round_workspace_states',
  schemaSymbol: 'employeeRoundWorkspaceStates',
  columns: {
    roundId: c.id('round_id'),
    attemptOrdinal: c.int('attempt_ordinal'),
    caseId: c.id('case_id'),
    baselineSha: c.text('baseline_sha'),
    preStateJson: c.jsonText('pre_state_json'),
    checkpointDigest: c.id('checkpoint_digest'),
    validationJson: c.jsonText('validation_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['round_id', 'attempt_ordinal'],
  foreignKeys: [
    foreignKey(
      'employee_round_workspace_states_round_id_employee_reaction_rounds_id_fk',
      ['round_id'],
      'employee_reaction_rounds',
      ['id'],
    ),
    foreignKey(
      'employee_round_workspace_states_case_id_employee_cases_id_fk',
      ['case_id'],
      'employee_cases',
      ['id'],
    ),
  ],
  indexes: [index('idx_employee_round_workspace_case', ['case_id', 'created_at'])],
  retention: retention.business,
})

export const employeeRoundWorkspaceStates = materializeDrizzle(
  employeeRoundWorkspaceStatesDefinition,
).table

const employeeToolRegistrationRevisionsDefinition = owner.table({
  id: 'employee_tool_registration_revisions',
  schemaSymbol: 'employeeToolRegistrationRevisions',
  columns: {
    toolId: c.id('tool_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    validationReceiptJson: c.jsonText('validation_receipt_json'),
    state: c.enum('state', ['published', 'retired'], { default: 'published' }),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['tool_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'employee_tool_registration_revisions_tool_id_employee_tool_registrations_id_fk',
      ['tool_id'],
      'employee_tool_registrations',
      ['id'],
    ),
  ],
  indexes: [index('idx_employee_tool_revisions_state', ['state', 'tool_id', 'revision'])],
  retention: retention.business,
})

export const employeeToolRegistrationRevisions = materializeDrizzle(
  employeeToolRegistrationRevisionsDefinition,
).table

const employeeToolRegistrationsDefinition = owner.table({
  id: 'employee_tool_registrations',
  schemaSymbol: 'employeeToolRegistrations',
  columns: {
    id: c.id('id', { primary: true }),
    typeId: c.id('type_id'),
    typeRevision: c.int('type_revision'),
    workItemRef: c.id('work_item_ref'),
    draftJson: c.jsonText('draft_json'),
    publishedRevision: c.int('published_revision', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    name: c.text('name', { default: '' }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    retiredAt: c.epochMs('retired_at', { nullable: true }),
  },
  indexes: [
    index('idx_employee_tools_node', ['type_id', 'type_revision', 'work_item_ref', 'retired_at']),
  ],
  retention: retention.business,
})

export const employeeToolRegistrations = materializeDrizzle(
  employeeToolRegistrationsDefinition,
).table

const employeeTypePackagesDefinition = owner.table({
  id: 'employee_type_packages',
  schemaSymbol: 'employeeTypePackages',
  columns: {
    typeId: c.id('type_id'),
    revision: c.int('revision'),
    descriptorJson: c.jsonText('descriptor_json'),
    descriptorDigest: c.id('descriptor_digest'),
    state: c.enum('state', ['published', 'retired'], { default: 'published' }),
    registeredAt: c.epochMs('registered_at'),
  },
  primaryKey: ['type_id', 'revision'],
  indexes: [index('idx_employee_type_packages_state', ['state', 'type_id', 'revision'])],
  retention: retention.business,
})

export const employeeTypePackages = materializeDrizzle(employeeTypePackagesDefinition).table

const employeeWorkScopeRevisionsDefinition = owner.table({
  id: 'employee_work_scope_revisions',
  schemaSymbol: 'employeeWorkScopeRevisions',
  columns: {
    scopeId: c.id('scope_id'),
    revision: c.int('revision'),
    typeId: c.id('type_id'),
    typeRevision: c.int('type_revision'),
    encodedScopeJson: c.jsonText('encoded_scope_json'),
    displaySummary: c.text('display_summary'),
    contentDigest: c.id('content_digest'),
    createdAt: c.epochMs('created_at'),
    createdBy: c.text('created_by', { nullable: true }),
  },
  primaryKey: ['scope_id', 'revision'],
  retention: retention.business,
})

export const employeeWorkScopeRevisions = materializeDrizzle(
  employeeWorkScopeRevisionsDefinition,
).table

export const schemaContribution = owner.contribution([
  employeeApprovalSagasDefinition,
  employeeAttentionBindingsDefinition,
  employeeCaseEventOriginsDefinition,
  employeeCaseInboxDefinition,
  employeeCaseMembersDefinition,
  employeeCaseMeteringReceiptsDefinition,
  employeeCaseWorkspacesDefinition,
  employeeCasesDefinition,
  employeeChangeCandidatesDefinition,
  employeeChannelResultsDefinition,
  employeeChannelsDefinition,
  employeeContextLinksDefinition,
  employeeContextRecordsDefinition,
  employeeContextRevisionsDefinition,
  employeeDefinitionRevisionsDefinition,
  employeeDefinitionsDefinition,
  employeeExecutionPolicyRevisionsDefinition,
  employeeExternalContextBindingsDefinition,
  employeeInputUploadsDefinition,
  employeeInvocationsDefinition,
  employeeJobTemplateRevisionsDefinition,
  employeeJobTemplatesDefinition,
  employeeOsOutboxDefinition,
  employeeOsSettingsDefinition,
  employeeOsWriterStateDefinition,
  employeeReactionArtifactsDefinition,
  employeeReactionDispatchDefinition,
  employeeReactionRoundsDefinition,
  employeeRoundWorkspaceStatesDefinition,
  employeeToolRegistrationRevisionsDefinition,
  employeeToolRegistrationsDefinition,
  employeeTypePackagesDefinition,
  employeeWorkScopeRevisionsDefinition,
])
