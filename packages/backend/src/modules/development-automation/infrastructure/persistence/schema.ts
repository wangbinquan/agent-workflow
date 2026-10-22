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

const owner = defineContribution('development-automation')

const actionTemplateRevisionsDefinition = owner.table({
  id: 'action_template_revisions',
  schemaSymbol: 'actionTemplateRevisions',
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
      'action_template_revisions_template_id_action_templates_id_fk',
      ['template_id'],
      'action_templates',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const actionTemplateRevisions = materializeDrizzle(actionTemplateRevisionsDefinition).table

const actionTemplatesDefinition = owner.table({
  id: 'action_templates',
  schemaSymbol: 'actionTemplates',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    draftJson: c.jsonText('draft_json'),
    publishedRevision: c.int('published_revision', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['private', 'public'], { default: 'private' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    archivedAt: c.epochMs('archived_at', { nullable: true }),
    capabilityId: c.id('capability_id'),
  },
  indexes: [
    index(
      'action_templates_owner_name_unique',
      [
        raw(
          'COALESCE("action_templates"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const actionTemplates = materializeDrizzle(actionTemplatesDefinition).table

const automationPoliciesDefinition = owner.table({
  id: 'automation_policies',
  schemaSymbol: 'automationPolicies',
  columns: {
    id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
    name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
    draftJson: c.jsonText('draft_json', { sqliteUniqueName: 'action_templates_draft_json_unique' }),
    publishedRevision: c.int('published_revision', {
      nullable: true,
      sqliteUniqueName: 'action_templates_published_revision_unique',
    }),
    ownerUserId: c.id('owner_user_id', {
      nullable: true,
      sqliteUniqueName: 'action_templates_owner_user_id_unique',
    }),
    visibility: c.enum('visibility', ['private', 'public'], {
      sqliteUniqueName: 'action_templates_visibility_unique',
      default: 'private',
    }),
    aclRevision: c.int('acl_revision', {
      sqliteUniqueName: 'action_templates_acl_revision_unique',
      default: 0,
    }),
    createdAt: c.epochMs('created_at', { sqliteUniqueName: 'action_templates_created_at_unique' }),
    updatedAt: c.epochMs('updated_at', { sqliteUniqueName: 'action_templates_updated_at_unique' }),
    archivedAt: c.epochMs('archived_at', {
      nullable: true,
      sqliteUniqueName: 'action_templates_archived_at_unique',
    }),
  },
  indexes: [
    index(
      'automation_policies_owner_name_unique',
      [
        raw(
          'COALESCE("automation_policies"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const automationPolicies = materializeDrizzle(automationPoliciesDefinition).table

const automationPolicyRevisionsDefinition = owner.table({
  id: 'automation_policy_revisions',
  schemaSymbol: 'automationPolicyRevisions',
  columns: {
    policyId: c.id('policy_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['policy_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'automation_policy_revisions_policy_id_automation_policies_id_fk',
      ['policy_id'],
      'automation_policies',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const automationPolicyRevisions = materializeDrizzle(
  automationPolicyRevisionsDefinition,
).table

const developmentActionRunsDefinition = owner.table({
  id: 'development_action_runs',
  schemaSymbol: 'developmentActionRuns',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    missionRevision: c.int('mission_revision'),
    decisionId: c.id('decision_id'),
    capabilityId: c.id('capability_id'),
    capabilityContractVersion: c.int('capability_contract_version'),
    templateId: c.id('template_id', { nullable: true }),
    templateRevision: c.int('template_revision', { nullable: true }),
    workSetDigest: c.id('work_set_digest', { nullable: true }),
    inputFactDigest: c.id('input_fact_digest'),
    baselineRef: c.id('baseline_ref', { nullable: true }),
    writable: c.int('writable', { default: 0 }),
    status: c.text('status'),
    resultRef: c.id('result_ref', { nullable: true }),
    failureJson: c.jsonText('failure_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_action_runs_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_action_runs_decision_unique', ['decision_id'], { unique: true }),
    index('dev_action_runs_single_writable', ['mission_id'], {
      unique: true,
      where: raw(
        "\"development_action_runs\".\"writable\" = 1 AND \"development_action_runs\".\"status\" IN ('claimed','materializing','running','validating','awaiting-effect')",
        "\"writable\" = 1 AND \"status\" IN ('claimed','materializing','running','validating','awaiting-effect')",
      ),
    }),
  ],
  retention: retention.business,
})

export const developmentActionRuns = materializeDrizzle(developmentActionRunsDefinition).table

const developmentAdapterDefinitionRevisionsDefinition = owner.table({
  id: 'development_adapter_definition_revisions',
  schemaSymbol: 'developmentAdapterDefinitionRevisions',
  columns: {
    adapterId: c.id('adapter_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['adapter_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'development_adapter_definition_revisions_adapter_id_development_adapter_definitions_id_fk',
      ['adapter_id'],
      'development_adapter_definitions',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const developmentAdapterDefinitionRevisions = materializeDrizzle(
  developmentAdapterDefinitionRevisionsDefinition,
).table

const developmentAdapterDefinitionsDefinition = owner.table({
  id: 'development_adapter_definitions',
  schemaSymbol: 'developmentAdapterDefinitions',
  columns: {
    id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
    name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
    draftJson: c.jsonText('draft_json', { sqliteUniqueName: 'action_templates_draft_json_unique' }),
    publishedRevision: c.int('published_revision', {
      nullable: true,
      sqliteUniqueName: 'action_templates_published_revision_unique',
    }),
    ownerUserId: c.id('owner_user_id', {
      nullable: true,
      sqliteUniqueName: 'action_templates_owner_user_id_unique',
    }),
    visibility: c.enum('visibility', ['private', 'public'], {
      sqliteUniqueName: 'action_templates_visibility_unique',
      default: 'private',
    }),
    aclRevision: c.int('acl_revision', {
      sqliteUniqueName: 'action_templates_acl_revision_unique',
      default: 0,
    }),
    createdAt: c.epochMs('created_at', { sqliteUniqueName: 'action_templates_created_at_unique' }),
    updatedAt: c.epochMs('updated_at', { sqliteUniqueName: 'action_templates_updated_at_unique' }),
    archivedAt: c.epochMs('archived_at', {
      nullable: true,
      sqliteUniqueName: 'action_templates_archived_at_unique',
    }),
    purpose: c.enum('purpose', [
      'requirement-source',
      'pipeline-gate',
      'pipeline-classifier',
      'approval-gateway',
    ]),
  },
  indexes: [
    index(
      'development_adapter_definitions_owner_name_unique',
      [
        raw(
          'COALESCE("development_adapter_definitions"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const developmentAdapterDefinitions = materializeDrizzle(
  developmentAdapterDefinitionsDefinition,
).table

const developmentAgentAttemptsDefinition = owner.table({
  id: 'development_agent_attempts',
  schemaSymbol: 'developmentAgentAttempts',
  columns: {
    id: c.id('id', { primary: true }),
    actionRunId: c.id('action_run_id'),
    rerunSeq: c.int('rerun_seq'),
    attemptSeq: c.int('attempt_seq'),
    executionRef: c.id('execution_ref', { nullable: true }),
    baselineRef: c.id('baseline_ref'),
    nonceDigest: c.id('nonce_digest'),
    inputDigest: c.id('input_digest'),
    status: c.text('status'),
    rejectionJson: c.jsonText('rejection_json', { nullable: true }),
    outcomeRef: c.id('outcome_ref', { nullable: true }),
    preSnapshotRef: c.id('pre_snapshot_ref', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_agent_attempts_action_run_id_development_action_runs_id_fk',
      ['action_run_id'],
      'development_action_runs',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_agent_attempts_ordinal_unique', ['action_run_id', 'rerun_seq', 'attempt_seq'], {
      unique: true,
    }),
    index('idx_dev_agent_attempts_execution_ref', ['execution_ref']),
  ],
  retention: retention.operational,
})

export const developmentAgentAttempts = materializeDrizzle(developmentAgentAttemptsDefinition).table

const developmentApprovalSagasDefinition = owner.table({
  id: 'development_approval_sagas',
  schemaSymbol: 'developmentApprovalSagas',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    stepRunId: c.id('step_run_id'),
    adapterId: c.id('adapter_id'),
    adapterRevision: c.int('adapter_revision'),
    draftRef: c.id('draft_ref'),
    submitIntentDigest: c.id('submit_intent_digest'),
    idempotencyKey: c.id('idempotency_key'),
    correlationRef: c.id('correlation_ref', { nullable: true }),
    externalRequestRef: c.id('external_request_ref', { nullable: true }),
    submittedRevision: c.text('submitted_revision', { nullable: true }),
    latestStatus: c.text('latest_status', { default: 'submitting' }),
    observedRevision: c.text('observed_revision', { nullable: true }),
    evidenceRef: c.id('evidence_ref', { nullable: true }),
    deadlineAt: c.epochMs('deadline_at'),
    attemptOrdinal: c.int('attempt_ordinal', { default: 0 }),
    nextObserveAt: c.epochMs('next_observe_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_approval_sagas_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
    foreignKey(
      'development_approval_sagas_step_run_id_development_step_runs_id_fk',
      ['step_run_id'],
      'development_step_runs',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_approval_sagas_idem_unique', ['idempotency_key'], { unique: true }),
    index('idx_dev_approval_sagas_mission', ['mission_id']),
    index('idx_dev_approval_sagas_correlation', ['correlation_ref']),
  ],
  retention: retention.business,
})

export const developmentApprovalSagas = materializeDrizzle(developmentApprovalSagasDefinition).table

const developmentBundleRefsDefinition = owner.table({
  id: 'development_bundle_refs',
  schemaSymbol: 'developmentBundleRefs',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    purpose: c.text('purpose'),
    evidenceRef: c.id('evidence_ref'),
    manifestDigest: c.id('manifest_digest'),
    fileCount: c.int('file_count'),
    totalBytes: c.int('total_bytes'),
    retentionState: c.text('retention_state', { default: 'active' }),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_bundle_refs_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [index('idx_dev_bundle_refs_mission', ['mission_id'])],
  retention: retention.business,
})

export const developmentBundleRefs = materializeDrizzle(developmentBundleRefsDefinition).table

const developmentDecisionsDefinition = owner.table({
  id: 'development_decisions',
  schemaSymbol: 'developmentDecisions',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    missionRevision: c.int('mission_revision'),
    policyId: c.id('policy_id', { nullable: true }),
    policyRevision: c.int('policy_revision', { nullable: true }),
    employeeId: c.id('employee_id', { nullable: true }),
    employeeRevision: c.int('employee_revision', { nullable: true }),
    factSnapshotId: c.id('fact_snapshot_id', { nullable: true }),
    factDigest: c.id('fact_digest'),
    workSetJson: c.jsonText('work_set_json', { nullable: true }),
    guardTraceJson: c.jsonText('guard_trace_json'),
    ruleTraceJson: c.jsonText('rule_trace_json'),
    selectedJson: c.jsonText('selected_json'),
    canonicalDigest: c.id('canonical_digest'),
    decisionInputDigest: c.id('decision_input_digest'),
    decidedAt: c.epochMs('decided_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_decisions_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_decisions_input_unique', ['mission_id', 'decision_input_digest'], { unique: true }),
  ],
  retention: retention.business,
})

export const developmentDecisions = materializeDrizzle(developmentDecisionsDefinition).table

const developmentDeferredWakesDefinition = owner.table({
  id: 'development_deferred_wakes',
  schemaSymbol: 'developmentDeferredWakes',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    decisionId: c.id('decision_id'),
    reason: c.text('reason'),
    resumeAt: c.epochMs('resume_at', { nullable: true }),
    wakeSourcesJson: c.jsonText('wake_sources_json'),
    attemptOrdinal: c.int('attempt_ordinal', { default: 0 }),
    state: c.text('state', { default: 'armed' }),
    createdAt: c.epochMs('created_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_deferred_wakes_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_deferred_wakes_decision_unique', ['mission_id', 'decision_id'], { unique: true }),
    index('idx_dev_deferred_wakes_due', ['resume_at'], {
      where: raw('"development_deferred_wakes"."state" = \'armed\'', '"state" = \'armed\''),
    }),
  ],
  retention: retention.business,
})

export const developmentDeferredWakes = materializeDrizzle(developmentDeferredWakesDefinition).table

const developmentDesignsDefinition = owner.table({
  id: 'development_designs',
  schemaSymbol: 'developmentDesigns',
  columns: {
    id: c.id('id', { primary: true }),
    caseId: c.id('case_id'),
    revision: c.int('revision'),
    presentationJson: c.jsonText('presentation_json', { default: '{}' }),
    presentationRevision: c.int('presentation_revision', { default: 1 }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'development_designs_revision_ck',
      expression: raw(
        '"development_designs"."revision" > 0 AND "development_designs"."presentation_revision" > 0',
        '"revision" > 0 AND "presentation_revision" > 0',
      ),
    },
  ],
  indexes: [index('development_designs_case_uq', ['case_id'], { unique: true })],
  retention: retention.business,
})

export const developmentDesigns = materializeDrizzle(developmentDesignsDefinition).table

const developmentDesignRevisionsDefinition = owner.table({
  id: 'development_design_revisions',
  schemaSymbol: 'developmentDesignRevisions',
  columns: {
    designId: c.id('design_id'),
    revision: c.int('revision'),
    artifactRef: c.id('artifact_ref'),
    digest: c.text('digest'),
    requestId: c.id('request_id'),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['design_id', 'revision'],
  checks: [
    {
      name: 'development_design_revisions_revision_ck',
      expression: raw('"development_design_revisions"."revision" > 0', '"revision" > 0'),
    },
  ],
  indexes: [
    index('development_design_revisions_request_uq', ['design_id', 'request_id'], { unique: true }),
  ],
  retention: retention.business,
})

export const developmentDesignRevisions = materializeDrizzle(
  developmentDesignRevisionsDefinition,
).table

const developmentDesignProposalsDefinition = owner.table({
  id: 'development_design_proposals',
  schemaSymbol: 'developmentDesignProposals',
  columns: {
    designId: c.id('design_id'),
    id: c.id('id'),
    kind: c.text('kind'),
    requestDigest: c.id('request_digest'),
    status: c.text('status'),
    version: c.int('version'),
    payloadJson: c.jsonText('payload_json'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['design_id', 'id'],
  checks: [
    {
      name: 'development_design_proposals_version_ck',
      expression: raw('"development_design_proposals"."version" > 0', '"version" > 0'),
    },
  ],
  indexes: [index('development_design_proposals_status_idx', ['design_id', 'kind', 'status'])],
  retention: retention.business,
})

export const developmentDesignProposals = materializeDrizzle(
  developmentDesignProposalsDefinition,
).table

const developmentDesignBaselinesDefinition = owner.table({
  id: 'development_design_baselines',
  schemaSymbol: 'developmentDesignBaselines',
  columns: {
    designId: c.id('design_id'),
    id: c.id('id'),
    digest: c.text('digest'),
    artifactRef: c.id('artifact_ref'),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['design_id', 'id'],
  indexes: [index('development_design_baselines_digest_idx', ['design_id', 'digest'])],
  retention: retention.business,
})

export const developmentDesignBaselines = materializeDrizzle(
  developmentDesignBaselinesDefinition,
).table

const developmentDesignLinksDefinition = owner.table({
  id: 'development_design_links',
  schemaSymbol: 'developmentDesignLinks',
  columns: {
    designId: c.id('design_id'),
    id: c.id('id'),
    kind: c.text('kind'),
    payloadJson: c.jsonText('payload_json'),
    createdAt: c.epochMs('created_at'),
  },
  primaryKey: ['design_id', 'id'],
  indexes: [index('development_design_links_kind_idx', ['design_id', 'kind'])],
  retention: retention.business,
})

export const developmentDesignLinks = materializeDrizzle(developmentDesignLinksDefinition).table

const developmentEffectsDefinition = owner.table({
  id: 'development_effects',
  schemaSymbol: 'developmentEffects',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    actionRunId: c.id('action_run_id', { nullable: true }),
    effectKind: c.text('effect_kind'),
    intentDigest: c.id('intent_digest'),
    idempotencyKey: c.id('idempotency_key'),
    epoch: c.int('epoch'),
    state: c.text('state', { default: 'prepared' }),
    receiptRef: c.id('receipt_ref', { nullable: true }),
    failureJson: c.jsonText('failure_json', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_effects_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_effects_idempotency_unique', ['idempotency_key'], { unique: true }),
    index('idx_dev_effects_mission_state', ['mission_id', 'state']),
    index('idx_dev_effects_prepared', ['created_at'], {
      where: raw('"development_effects"."state" = \'prepared\'', '"state" = \'prepared\''),
    }),
  ],
  retention: retention.business,
})

export const developmentEffects = materializeDrizzle(developmentEffectsDefinition).table

const developmentFactSnapshotsDefinition = owner.table({
  id: 'development_fact_snapshots',
  schemaSymbol: 'developmentFactSnapshots',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    missionRevision: c.int('mission_revision'),
    capturedAt: c.text('captured_at'),
    cellsJson: c.jsonText('cells_json'),
    refsJson: c.jsonText('refs_json'),
    digest: c.text('digest'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_fact_snapshots_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [index('idx_dev_fact_snapshots_mission', ['mission_id'])],
  retention: retention.business,
})

export const developmentFactSnapshots = materializeDrizzle(developmentFactSnapshotsDefinition).table

const developmentFeedbackLedgerDefinition = owner.table({
  id: 'development_feedback_ledger',
  schemaSymbol: 'developmentFeedbackLedger',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    threadRef: c.id('thread_ref'),
    revision: c.text('revision'),
    headSha: c.text('head_sha'),
    fingerprint: c.text('fingerprint'),
    authorClass: c.text('author_class'),
    state: c.text('state', { default: 'observed' }),
    actionRunId: c.id('action_run_id', { nullable: true }),
    replyEffectId: c.id('reply_effect_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_feedback_ledger_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_feedback_ledger_unique', ['mission_id', 'thread_ref', 'revision', 'head_sha'], {
      unique: true,
    }),
  ],
  retention: retention.business,
})

export const developmentFeedbackLedger = materializeDrizzle(
  developmentFeedbackLedgerDefinition,
).table

const developmentMissionLinksDefinition = owner.table({
  id: 'development_mission_links',
  schemaSymbol: 'developmentMissionLinks',
  columns: {
    id: c.id('id', { primary: true }),
    parentMissionId: c.id('parent_mission_id'),
    parentStepRunId: c.id('parent_step_run_id'),
    targetRepositoryId: c.id('target_repository_id'),
    targetEmployeeId: c.id('target_employee_id'),
    targetEmployeeRevision: c.int('target_employee_revision'),
    inputDigest: c.id('input_digest'),
    idempotencyKey: c.id('idempotency_key'),
    childMissionId: c.id('child_mission_id', { nullable: true }),
    completion: c.text('completion'),
    state: c.text('state', { default: 'creating' }),
    latestChildRevision: c.int('latest_child_revision', { nullable: true }),
    latestStatus: c.text('latest_status', { nullable: true }),
    completionSatisfied: c.int('completion_satisfied', { default: 0 }),
    outputRef: c.id('output_ref', { nullable: true }),
    observedAt: c.epochMs('observed_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_mission_links_parent_mission_id_development_missions_id_fk',
      ['parent_mission_id'],
      'development_missions',
      ['id'],
    ),
    foreignKey(
      'development_mission_links_parent_step_run_id_development_step_runs_id_fk',
      ['parent_step_run_id'],
      'development_step_runs',
      ['id'],
    ),
    foreignKey(
      'development_mission_links_child_mission_id_development_missions_id_fk',
      ['child_mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_mission_links_idem_unique', ['idempotency_key'], { unique: true }),
    index('idx_dev_mission_links_parent', ['parent_mission_id']),
    index('dev_mission_links_child_unique', ['child_mission_id'], { unique: true }),
  ],
  retention: retention.business,
})

export const developmentMissionLinks = materializeDrizzle(developmentMissionLinksDefinition).table

const developmentMissionSourcesDefinition = owner.table({
  id: 'development_mission_sources',
  schemaSymbol: 'developmentMissionSources',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    generation: c.int('generation', { default: 1 }),
    sourceKind: c.text('source_kind'),
    externalId: c.id('external_id', { nullable: true }),
    adapterId: c.id('adapter_id', { nullable: true }),
    adapterRevision: c.int('adapter_revision', { nullable: true }),
    sourceRevision: c.text('source_revision', { nullable: true }),
    bundleRef: c.id('bundle_ref', { nullable: true }),
    manifestDigest: c.id('manifest_digest', { nullable: true }),
    fileCount: c.int('file_count', { nullable: true }),
    totalBytes: c.int('total_bytes', { nullable: true }),
    state: c.text('state', { default: 'active' }),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_mission_sources_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [index('idx_dev_mission_sources_mission', ['mission_id'])],
  retention: retention.business,
})

export const developmentMissionSources = materializeDrizzle(
  developmentMissionSourcesDefinition,
).table

const developmentMissionsDefinition = owner.table({
  id: 'development_missions',
  schemaSymbol: 'developmentMissions',
  columns: {
    id: c.id('id', { primary: true }),
    revision: c.int('revision', { default: 0 }),
    epoch: c.int('epoch', { default: 0 }),
    status: c.text('status'),
    automationMode: c.text('automation_mode', { default: 'active' }),
    transitionFence: c.text('transition_fence', { default: 'none' }),
    repositoryId: c.id('repository_id'),
    sourceKind: c.text('source_kind'),
    sourceContentDigest: c.id('source_content_digest', { nullable: true }),
    requestedSourceKey: c.id('requested_source_key', { nullable: true }),
    externalId: c.id('external_id', { nullable: true }),
    resolvedSourceKey: c.id('resolved_source_key', { nullable: true }),
    resolvedAdapterId: c.id('resolved_adapter_id', { nullable: true }),
    resolvedAdapterRevision: c.int('resolved_adapter_revision', { nullable: true }),
    deliveryKind: c.text('delivery_kind'),
    deliveryTargetRef: c.id('delivery_target_ref', { nullable: true }),
    deliverySourceBranch: c.text('delivery_source_branch', { nullable: true }),
    adoptedMrRef: c.id('adopted_mr_ref', { nullable: true }),
    assignmentId: c.id('assignment_id', { nullable: true }),
    employeeId: c.id('employee_id', { nullable: true }),
    employeeRevision: c.int('employee_revision', { nullable: true }),
    policyId: c.id('policy_id', { nullable: true }),
    policyRevision: c.int('policy_revision', { nullable: true }),
    requirementBundleRef: c.id('requirement_bundle_ref', { nullable: true }),
    repositoryFactsRef: c.id('repository_facts_ref', { nullable: true }),
    uploadPlanRef: c.id('upload_plan_ref', { nullable: true }),
    uploadPlacementRef: c.id('upload_placement_ref', { nullable: true }),
    uploadPublicationRef: c.id('upload_publication_ref', { nullable: true }),
    mrClaimId: c.id('mr_claim_id', { nullable: true }),
    currentActionRunId: c.id('current_action_run_id', { nullable: true }),
    readinessJson: c.jsonText('readiness_json', { nullable: true }),
    blockCode: c.text('block_code', { nullable: true }),
    blockDetail: c.text('block_detail', { nullable: true }),
    terminalKind: c.text('terminal_kind', { nullable: true }),
    terminalUploadFulfillment: c.text('terminal_upload_fulfillment', { nullable: true }),
    terminalAt: c.epochMs('terminal_at', { nullable: true }),
    reopenedFromMissionId: c.id('reopened_from_mission_id', { nullable: true }),
    launchIdempotencyKey: c.id('launch_idempotency_key', { nullable: true }),
    createdBy: c.text('created_by', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index('development_missions_launch_idem_unique', ['launch_idempotency_key'], {
      unique: true,
      where: raw(
        '"development_missions"."launch_idempotency_key" IS NOT NULL',
        '"launch_idempotency_key" IS NOT NULL',
      ),
    }),
    index('idx_development_missions_status', ['status']),
    index('idx_development_missions_status_employee', ['status', 'employee_id']),
    index('idx_development_missions_repo', ['repository_id']),
    index('idx_development_missions_created', ['created_at']),
    index('idx_development_missions_created_id', ['created_at', 'id']),
    index('idx_development_missions_open', ['created_at', 'id'], {
      where: raw('"development_missions"."terminal_at" IS NULL', '"terminal_at" IS NULL'),
    }),
    index('idx_development_missions_fenced', ['id'], {
      where: raw(
        '"development_missions"."transition_fence" != \'none\'',
        '"transition_fence" != \'none\'',
      ),
    }),
  ],
  retention: retention.business,
})

export const developmentMissions = materializeDrizzle(developmentMissionsDefinition).table

const developmentMrClaimsDefinition = owner.table({
  id: 'development_mr_claims',
  schemaSymbol: 'developmentMrClaims',
  columns: {
    id: c.id('id', { primary: true }),
    codeHostEndpointRef: c.id('code_host_endpoint_ref'),
    stableProjectRef: c.id('stable_project_ref'),
    mrIid: c.text('mr_iid'),
    missionId: c.id('mission_id'),
    epoch: c.int('epoch'),
    headSha: c.text('head_sha', { nullable: true }),
    state: c.text('state', { default: 'active' }),
    createdAt: c.epochMs('created_at'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_mr_claims_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index(
      'dev_mr_claims_active_unique',
      ['code_host_endpoint_ref', 'stable_project_ref', 'mr_iid'],
      {
        unique: true,
        where: raw('"development_mr_claims"."state" = \'active\'', '"state" = \'active\''),
      },
    ),
    index('idx_dev_mr_claims_lookup', ['code_host_endpoint_ref', 'stable_project_ref', 'mr_iid']),
  ],
  retention: retention.business,
})

export const developmentMrClaims = materializeDrizzle(developmentMrClaimsDefinition).table

const developmentObjectArtifactsDefinition = owner.table({
  id: 'development_object_artifacts',
  schemaSymbol: 'developmentObjectArtifacts',
  columns: {
    reference: c.id('reference', { primary: true }),
    objectId: c.id('object_id'),
    digest: c.text('digest'),
    size: c.int('size'),
    createdAt: c.epochMs('created_at'),
  },
  retention: retention.business,
})

export const developmentObjectArtifacts = materializeDrizzle(
  developmentObjectArtifactsDefinition,
).table

const developmentRepositoryUploadPlanEntriesDefinition = owner.table({
  id: 'development_repository_upload_plan_entries',
  schemaSymbol: 'developmentRepositoryUploadPlanEntries',
  columns: {
    planId: c.id('plan_id'),
    ordinal: c.int('ordinal'),
    fileId: c.id('file_id'),
    uploadBlobRef: c.id('upload_blob_ref'),
    uploadSha256: c.text('upload_sha256'),
    repositoryTargetPath: c.text('repository_target_path'),
    contentPolicy: c.text('content_policy'),
    targetFileMode: c.text('target_file_mode'),
    expectedTargetKind: c.text('expected_target_kind'),
    expectedTargetSha256: c.text('expected_target_sha256', { nullable: true }),
    expectedTargetFileMode: c.text('expected_target_file_mode', { nullable: true }),
  },
  primaryKey: ['plan_id', 'ordinal'],
  foreignKeys: [
    foreignKey(
      'development_repository_upload_plan_entries_plan_id_development_repository_upload_plans_id_fk',
      ['plan_id'],
      'development_repository_upload_plans',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_upload_plan_target_unique', ['plan_id', 'repository_target_path'], { unique: true }),
  ],
  retention: retention.business,
})

export const developmentRepositoryUploadPlanEntries = materializeDrizzle(
  developmentRepositoryUploadPlanEntriesDefinition,
).table

const developmentRepositoryUploadPlansDefinition = owner.table({
  id: 'development_repository_upload_plans',
  schemaSymbol: 'developmentRepositoryUploadPlans',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    missionRevision: c.int('mission_revision'),
    repositoryId: c.id('repository_id'),
    baselineSnapshotRef: c.id('baseline_snapshot_ref'),
    baselineSha: c.text('baseline_sha'),
    planDigest: c.id('plan_digest'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_repository_upload_plans_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const developmentRepositoryUploadPlans = materializeDrizzle(
  developmentRepositoryUploadPlansDefinition,
).table

const developmentRepositoryUploadReceiptsDefinition = owner.table({
  id: 'development_repository_upload_receipts',
  schemaSymbol: 'developmentRepositoryUploadReceipts',
  columns: {
    id: c.id('id', { primary: true }),
    planId: c.id('plan_id'),
    baselineSnapshotRef: c.id('baseline_snapshot_ref'),
    receiptKind: c.text('receipt_kind'),
    seedChangeRef: c.id('seed_change_ref', { nullable: true }),
    seedTreeDigest: c.id('seed_tree_digest', { nullable: true }),
    fulfillmentKind: c.text('fulfillment_kind', { nullable: true }),
    commitSha: c.text('commit_sha', { nullable: true }),
    entriesJson: c.jsonText('entries_json'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'development_repository_upload_receipts_plan_id_development_repository_upload_plans_id_fk',
      ['plan_id'],
      'development_repository_upload_plans',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_upload_receipts_unique', ['plan_id', 'baseline_snapshot_ref', 'receipt_kind'], {
      unique: true,
    }),
  ],
  retention: retention.business,
})

export const developmentRepositoryUploadReceipts = materializeDrizzle(
  developmentRepositoryUploadReceiptsDefinition,
).table

const developmentStepJoinsDefinition = owner.table({
  id: 'development_step_joins',
  schemaSymbol: 'developmentStepJoins',
  columns: {
    missionId: c.id('mission_id'),
    groupId: c.id('group_id'),
    memberStepId: c.id('member_step_id'),
    mode: c.text('mode'),
    quorum: c.int('quorum', { nullable: true }),
    deadlineAt: c.epochMs('deadline_at'),
    memberState: c.text('member_state', { default: 'pending' }),
    receiptRevision: c.text('receipt_revision', { nullable: true }),
    settledResult: c.text('settled_result', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['mission_id', 'group_id', 'member_step_id'],
  foreignKeys: [
    foreignKey(
      'development_step_joins_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [index('idx_dev_step_joins_pending', ['mission_id', 'settled_result'])],
  retention: retention.business,
})

export const developmentStepJoins = materializeDrizzle(developmentStepJoinsDefinition).table

const developmentStepRunsDefinition = owner.table({
  id: 'development_step_runs',
  schemaSymbol: 'developmentStepRuns',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    employeeId: c.id('employee_id'),
    employeeRevision: c.int('employee_revision'),
    stepId: c.id('step_id'),
    attempt: c.int('attempt', { default: 0 }),
    inputDigest: c.id('input_digest'),
    producerKind: c.text('producer_kind'),
    state: c.text('state', { default: 'claimed' }),
    decisionId: c.id('decision_id', { nullable: true }),
    actionRunId: c.id('action_run_id', { nullable: true }),
    deadlineAt: c.epochMs('deadline_at', { nullable: true }),
    outputRef: c.id('output_ref', { nullable: true }),
    outputRevision: c.text('output_revision', { nullable: true }),
    failureCategory: c.text('failure_category', { nullable: true }),
    failureCode: c.text('failure_code', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_step_runs_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index(
      'dev_step_runs_replay_unique',
      ['mission_id', 'employee_id', 'employee_revision', 'step_id', 'attempt', 'input_digest'],
      { unique: true },
    ),
    index('idx_dev_step_runs_mission_state', ['mission_id', 'state']),
    index('idx_dev_step_runs_action', ['action_run_id']),
  ],
  retention: retention.business,
})

export const developmentStepRuns = materializeDrizzle(developmentStepRunsDefinition).table

const developmentWakeHintsDefinition = owner.table({
  id: 'development_wake_hints',
  schemaSymbol: 'developmentWakeHints',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    source: c.text('source'),
    deliveryKey: c.id('delivery_key'),
    observedAt: c.epochMs('observed_at'),
    consumedAt: c.epochMs('consumed_at', { nullable: true }),
  },
  foreignKeys: [
    foreignKey(
      'development_wake_hints_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  indexes: [
    index('dev_wake_hints_delivery_unique', ['mission_id', 'delivery_key'], { unique: true }),
    index('idx_dev_wake_hints_unconsumed', ['mission_id'], {
      where: raw('"development_wake_hints"."consumed_at" IS NULL', '"consumed_at" IS NULL'),
    }),
  ],
  retention: retention.business,
})

export const developmentWakeHints = materializeDrizzle(developmentWakeHintsDefinition).table

const digitalEmployeeRevisionsDefinition = owner.table({
  id: 'digital_employee_revisions',
  schemaSymbol: 'digitalEmployeeRevisions',
  columns: {
    employeeId: c.id('employee_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['employee_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'digital_employee_revisions_employee_id_digital_employees_id_fk',
      ['employee_id'],
      'digital_employees',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const digitalEmployeeRevisions = materializeDrizzle(digitalEmployeeRevisionsDefinition).table

const digitalEmployeesDefinition = owner.table({
  id: 'digital_employees',
  schemaSymbol: 'digitalEmployees',
  columns: {
    id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
    name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
    draftJson: c.jsonText('draft_json', { sqliteUniqueName: 'action_templates_draft_json_unique' }),
    publishedRevision: c.int('published_revision', {
      nullable: true,
      sqliteUniqueName: 'action_templates_published_revision_unique',
    }),
    ownerUserId: c.id('owner_user_id', {
      nullable: true,
      sqliteUniqueName: 'action_templates_owner_user_id_unique',
    }),
    visibility: c.enum('visibility', ['private', 'public'], {
      sqliteUniqueName: 'action_templates_visibility_unique',
      default: 'private',
    }),
    aclRevision: c.int('acl_revision', {
      sqliteUniqueName: 'action_templates_acl_revision_unique',
      default: 0,
    }),
    createdAt: c.epochMs('created_at', { sqliteUniqueName: 'action_templates_created_at_unique' }),
    updatedAt: c.epochMs('updated_at', { sqliteUniqueName: 'action_templates_updated_at_unique' }),
    archivedAt: c.epochMs('archived_at', {
      nullable: true,
      sqliteUniqueName: 'action_templates_archived_at_unique',
    }),
  },
  indexes: [
    index(
      'digital_employees_owner_name_unique',
      [
        raw(
          'COALESCE("digital_employees"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const digitalEmployees = materializeDrizzle(digitalEmployeesDefinition).table

const missionInputUploadsDefinition = owner.table({
  id: 'mission_input_uploads',
  schemaSymbol: 'missionInputUploads',
  columns: {
    id: c.id('id', { primary: true }),
    actorUserId: c.id('actor_user_id', { nullable: true }),
    originalName: c.text('original_name'),
    bytes: c.int('bytes'),
    sha256: c.text('sha256'),
    blobRef: c.id('blob_ref'),
    state: c.text('state', { default: 'pending' }),
    claimedByMissionId: c.id('claimed_by_mission_id', { nullable: true }),
    uploadIdempotencyKey: c.id('upload_idempotency_key', { nullable: true }),
    expiresAt: c.epochMs('expires_at'),
    createdAt: c.epochMs('created_at'),
    claimedAt: c.epochMs('claimed_at', { nullable: true }),
  },
  indexes: [
    index('mission_input_uploads_idem_unique', ['actor_user_id', 'upload_idempotency_key'], {
      unique: true,
      where: raw(
        '"mission_input_uploads"."upload_idempotency_key" IS NOT NULL',
        '"upload_idempotency_key" IS NOT NULL',
      ),
    }),
    index('idx_mission_input_uploads_state', ['state', 'expires_at']),
  ],
  retention: retention.business,
})

export const missionInputUploads = materializeDrizzle(missionInputUploadsDefinition).table

const repositoryEmployeeAssignmentsDefinition = owner.table({
  id: 'repository_employee_assignments',
  schemaSymbol: 'repositoryEmployeeAssignments',
  columns: {
    id: c.id('id', { primary: true }),
    scopeKind: c.enum('scope_kind', ['repository', 'repository-group', 'global-default']),
    scopeRef: c.id('scope_ref', { nullable: true }),
    employeeId: c.id('employee_id', { nullable: true }),
    employeeRevision: c.int('employee_revision', { nullable: true }),
    selectionPolicyId: c.id('selection_policy_id', { nullable: true }),
    selectionPolicyRevision: c.int('selection_policy_revision', { nullable: true }),
    executionPolicyId: c.id('execution_policy_id', { nullable: true }),
    executionPolicyRevision: c.int('execution_policy_revision', { nullable: true }),
    defaultRequirementSourceKey: c.id('default_requirement_source_key', { nullable: true }),
    updatedBy: c.text('updated_by', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index(
      'repository_employee_assignments_scope_unique',
      [
        'scope_kind',
        raw(
          'COALESCE("repository_employee_assignments"."scope_ref", \'\')',
          'COALESCE("scope_ref", \'\')',
        ),
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const repositoryEmployeeAssignments = materializeDrizzle(
  repositoryEmployeeAssignmentsDefinition,
).table

const verificationProfileRevisionsDefinition = owner.table({
  id: 'verification_profile_revisions',
  schemaSymbol: 'verificationProfileRevisions',
  columns: {
    profileId: c.id('profile_id'),
    revision: c.int('revision'),
    contentJson: c.jsonText('content_json'),
    contentDigest: c.id('content_digest'),
    publishedAt: c.epochMs('published_at'),
    publishedBy: c.text('published_by', { nullable: true }),
  },
  primaryKey: ['profile_id', 'revision'],
  foreignKeys: [
    foreignKey(
      'verification_profile_revisions_profile_id_verification_profiles_id_fk',
      ['profile_id'],
      'verification_profiles',
      ['id'],
    ),
  ],
  retention: retention.business,
})

export const verificationProfileRevisions = materializeDrizzle(
  verificationProfileRevisionsDefinition,
).table

const verificationProfilesDefinition = owner.table({
  id: 'verification_profiles',
  schemaSymbol: 'verificationProfiles',
  columns: {
    id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
    name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
    draftJson: c.jsonText('draft_json', { sqliteUniqueName: 'action_templates_draft_json_unique' }),
    publishedRevision: c.int('published_revision', {
      nullable: true,
      sqliteUniqueName: 'action_templates_published_revision_unique',
    }),
    ownerUserId: c.id('owner_user_id', {
      nullable: true,
      sqliteUniqueName: 'action_templates_owner_user_id_unique',
    }),
    visibility: c.enum('visibility', ['private', 'public'], {
      sqliteUniqueName: 'action_templates_visibility_unique',
      default: 'private',
    }),
    aclRevision: c.int('acl_revision', {
      sqliteUniqueName: 'action_templates_acl_revision_unique',
      default: 0,
    }),
    createdAt: c.epochMs('created_at', { sqliteUniqueName: 'action_templates_created_at_unique' }),
    updatedAt: c.epochMs('updated_at', { sqliteUniqueName: 'action_templates_updated_at_unique' }),
    archivedAt: c.epochMs('archived_at', {
      nullable: true,
      sqliteUniqueName: 'action_templates_archived_at_unique',
    }),
  },
  indexes: [
    index(
      'verification_profiles_owner_name_unique',
      [
        raw(
          'COALESCE("verification_profiles"."owner_user_id", \'\')',
          'COALESCE("owner_user_id", \'\')',
        ),
        'name',
      ],
      { unique: true },
    ),
  ],
  retention: retention.business,
})

export const verificationProfiles = materializeDrizzle(verificationProfilesDefinition).table

export const schemaContribution = owner.contribution([
  actionTemplateRevisionsDefinition,
  actionTemplatesDefinition,
  automationPoliciesDefinition,
  automationPolicyRevisionsDefinition,
  developmentActionRunsDefinition,
  developmentAdapterDefinitionRevisionsDefinition,
  developmentAdapterDefinitionsDefinition,
  developmentAgentAttemptsDefinition,
  developmentApprovalSagasDefinition,
  developmentBundleRefsDefinition,
  developmentDecisionsDefinition,
  developmentDeferredWakesDefinition,
  developmentDesignsDefinition,
  developmentDesignRevisionsDefinition,
  developmentDesignProposalsDefinition,
  developmentDesignBaselinesDefinition,
  developmentDesignLinksDefinition,
  developmentEffectsDefinition,
  developmentFactSnapshotsDefinition,
  developmentFeedbackLedgerDefinition,
  developmentMissionLinksDefinition,
  developmentMissionSourcesDefinition,
  developmentMissionsDefinition,
  developmentMrClaimsDefinition,
  developmentObjectArtifactsDefinition,
  developmentRepositoryUploadPlanEntriesDefinition,
  developmentRepositoryUploadPlansDefinition,
  developmentRepositoryUploadReceiptsDefinition,
  developmentStepJoinsDefinition,
  developmentStepRunsDefinition,
  developmentWakeHintsDefinition,
  digitalEmployeeRevisionsDefinition,
  digitalEmployeesDefinition,
  missionInputUploadsDefinition,
  repositoryEmployeeAssignmentsDefinition,
  verificationProfileRevisionsDefinition,
  verificationProfilesDefinition,
])
