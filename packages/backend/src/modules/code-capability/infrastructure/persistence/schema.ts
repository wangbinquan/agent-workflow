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

const owner = defineContribution('code-capability')

const capabilityTemplatesDefinition = owner.table({
  id: 'capability_templates',
  schemaSymbol: 'capabilityTemplates',
  columns: {
    id: c.id('id', { primary: true }),
    name: c.text('name'),
    description: c.text('description', { nullable: true }),
    capability: c.text('capability'),
    scriptsJson: c.jsonText('scripts_json', { default: '{}' }),
    hooksJson: c.jsonText('hooks_json', { default: '[]' }),
    paramSchemaJson: c.jsonText('param_schema_json', { default: '[]' }),
    paramDefaultsJson: c.jsonText('param_defaults_json', { default: '{}' }),
    agentBySlotJson: c.jsonText('agent_by_slot_json', { default: '{}' }),
    promptBySlotJson: c.jsonText('prompt_by_slot_json', { default: '{}' }),
    paramsJson: c.jsonText('params_json', { default: '{}' }),
    stageContractVer: c.int('stage_contract_ver', { default: 1 }),
    upstreamId: c.id('upstream_id', { nullable: true }),
    upstreamVersion: c.int('upstream_version', { nullable: true }),
    baseDigest: c.id('base_digest', { nullable: true }),
    baseSnapshotJson: c.jsonText('base_snapshot_json', { nullable: true }),
    ownerUserId: c.id('owner_user_id', { nullable: true }),
    visibility: c.enum('visibility', ['public', 'private'], { default: 'public' }),
    aclRevision: c.int('acl_revision', { default: 0 }),
    builtin: c.bool('builtin', { default: false }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'capability_templates_visibility_enum',
      expression: raw(
        '"capability_templates"."visibility" IN (\'public\',\'private\')',
        "\"visibility\" IN ('public','private')",
      ),
    },
  ],
  indexes: [
    index('capability_templates_owner_name_unique', ['owner_user_id', 'name'], { unique: true }),
    index('idx_capability_templates_capability', ['capability']),
    index('idx_capability_templates_upstream', ['upstream_id']),
  ],
  retention: retention.business,
})

export const capabilityTemplates = materializeDrizzle(capabilityTemplatesDefinition).table

const repoCapabilityConfigDefinition = owner.table({
  id: 'repo_capability_config',
  schemaSymbol: 'repoCapabilityConfig',
  columns: {
    id: c.id('id', { primary: true }),
    repoId: c.id('repo_id'),
    capability: c.text('capability'),
    templateId: c.id('template_id', { nullable: true }),
    enabled: c.bool('enabled', { default: false }),
    triggerConfigJson: c.jsonText('trigger_config_json', { default: '{}' }),
    readiness: c.enum('readiness', ['disabled', 'misconfigured', 'ready'], { default: 'disabled' }),
    readinessIssuesJson: c.jsonText('readiness_issues_json', { default: '[]' }),
    dependencyRevision: c.int('dependency_revision', { default: 0 }),
    lastValidatedAt: c.epochMs('last_validated_at', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  checks: [
    {
      name: 'repo_capability_config_enabled_boolean',
      expression: raw('"repo_capability_config"."enabled" IN (0, 1)', '"enabled" IN (FALSE, TRUE)'),
    },
    {
      name: 'repo_capability_config_readiness_enum',
      expression: raw(
        "\"repo_capability_config\".\"readiness\" IN ('disabled','misconfigured','ready')",
        "\"readiness\" IN ('disabled','misconfigured','ready')",
      ),
    },
  ],
  indexes: [
    index('uniq_repo_capability_cell', ['repo_id', 'capability'], { unique: true }),
    index('idx_repo_capability_template', ['template_id']),
    index('idx_repo_capability_readiness', ['readiness']),
  ],
  retention: retention.business,
})

export const repoCapabilityConfig = materializeDrizzle(repoCapabilityConfigDefinition).table

export const schemaContribution = owner.contribution([
  capabilityTemplatesDefinition,
  repoCapabilityConfigDefinition,
])

const historyOwner = defineContribution('code-capability/history')

const codeAiAttemptsDefinition = historyOwner.table({
  id: 'code_ai_attempts',
  schemaSymbol: 'codeAiAttempts',
  columns: {
    id: c.id('id', { primary: true }),
    roundId: c.id('round_id'),
    stageName: c.text('stage_name'),
    shardKey: c.id('shard_key', { default: '' }),
    rerunSeq: c.int('rerun_seq', { default: 0 }),
    attemptSeq: c.int('attempt_seq', { default: 0 }),
    status: c.enum('status', ['claimed', 'running', 'validated', 'failed', 'interrupted'], {
      default: 'claimed',
    }),
    validationOutcome: c.text('validation_outcome', { nullable: true }),
    sessionRef: c.id('session_ref', { nullable: true }),
    nodeRunId: c.id('node_run_id', { nullable: true }),
    startedAt: c.epochMs('started_at'),
    endedAt: c.epochMs('ended_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_ai_attempts_rerun_seq_nonnegative',
      expression: raw('"code_ai_attempts"."rerun_seq" >= 0', '"rerun_seq" >= 0'),
    },
    {
      name: 'code_ai_attempts_attempt_seq_nonnegative',
      expression: raw('"code_ai_attempts"."attempt_seq" >= 0', '"attempt_seq" >= 0'),
    },
    {
      name: 'code_ai_attempts_status_enum',
      expression: raw(
        "\"code_ai_attempts\".\"status\" IN ('claimed','running','validated','failed','interrupted')",
        "\"status\" IN ('claimed','running','validated','failed','interrupted')",
      ),
    },
  ],
  indexes: [
    index(
      'uniq_code_ai_attempts_identity',
      ['round_id', 'stage_name', 'shard_key', 'rerun_seq', 'attempt_seq'],
      { unique: true },
    ),
    index('idx_code_ai_attempts_round', ['round_id']),
    index('idx_code_ai_attempts_status', ['status']),
    index('idx_code_ai_attempts_started', ['started_at']),
  ],
  retention: retention.operational,
  migrationPolicy: 'DEFER',
})

export const codeAiAttempts = materializeDrizzle(codeAiAttemptsDefinition).table

const codeArtifactsDefinition = historyOwner.table({
  id: 'code_artifacts',
  schemaSymbol: 'codeArtifacts',
  columns: {
    id: c.id('id', { primary: true }),
    repoPath: c.text('repo_path'),
    commitSha: c.text('commit_sha'),
    baseSha: c.text('base_sha'),
    digest: c.text('digest'),
    keepRef: c.id('keep_ref'),
    roundId: c.id('round_id', { nullable: true }),
    workItemId: c.id('work_item_id', { nullable: true }),
    generation: c.int('generation', { default: 1 }),
    refCount: c.int('ref_count', { default: 0 }),
    state: c.text('state', { default: 'live' }),
    createdAt: c.epochMs('created_at'),
    releasedAt: c.epochMs('released_at', { nullable: true }),
  },
  indexes: [
    index('idx_code_artifacts_digest', ['digest']),
    index('idx_code_artifacts_item', ['work_item_id', 'state']),
    index('idx_code_artifacts_reclaim', ['state', 'ref_count']),
    index('idx_code_artifacts_released', ['released_at'], {
      where: raw('"code_artifacts"."ref_count" = 0', '"ref_count" = 0'),
    }),
  ],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codeArtifacts = materializeDrizzle(codeArtifactsDefinition).table

const codeFindingsDefinition = historyOwner.table({
  id: 'code_findings',
  schemaSymbol: 'codeFindings',
  columns: {
    id: c.id('id', { primary: true }),
    codeHostEndpointId: c.id('code_host_endpoint_id'),
    stableProjectId: c.id('stable_project_id'),
    anchorKind: c.enum('anchor_kind', ['mr', 'issue', 'pipeline', 'platform']),
    anchorId: c.id('anchor_id'),
    capability: c.text('capability'),
    fingerprint: c.text('fingerprint'),
    generation: c.int('generation', { default: 1 }),
    lifecycle: c.enum('lifecycle', ['active', 'disappeared', 'reappeared'], { default: 'active' }),
    severity: c.text('severity', { nullable: true }),
    title: c.text('title', { nullable: true }),
    filePath: c.text('file_path', { nullable: true }),
    anchorLine: c.int('anchor_line', { nullable: true }),
    externalId: c.id('external_id', { nullable: true }),
    publishedRoundId: c.id('published_round_id', { nullable: true }),
    disappearedRoundId: c.id('disappeared_round_id', { nullable: true }),
    resolvedAt: c.epochMs('resolved_at', { nullable: true }),
    resolvedRoundId: c.id('resolved_round_id', { nullable: true }),
    codeChangedAt: c.epochMs('code_changed_at', { nullable: true }),
    codeChangedRoundId: c.id('code_changed_round_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    lastSeenAt: c.epochMs('last_seen_at'),
    closedAt: c.epochMs('closed_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_findings_anchor_kind_enum',
      expression: raw(
        "\"code_findings\".\"anchor_kind\" IN ('mr','issue','pipeline','platform')",
        "\"anchor_kind\" IN ('mr','issue','pipeline','platform')",
      ),
    },
    {
      name: 'code_findings_lifecycle_enum',
      expression: raw(
        "\"code_findings\".\"lifecycle\" IN ('active','disappeared','reappeared')",
        "\"lifecycle\" IN ('active','disappeared','reappeared')",
      ),
    },
  ],
  indexes: [
    index(
      'uniq_code_finding_identity',
      [
        'code_host_endpoint_id',
        'stable_project_id',
        'anchor_kind',
        'anchor_id',
        'fingerprint',
        'generation',
      ],
      { unique: true },
    ),
    index('idx_code_findings_anchor', [
      'code_host_endpoint_id',
      'stable_project_id',
      'anchor_kind',
      'anchor_id',
      'lifecycle',
    ]),
    index('idx_code_findings_seen', ['stable_project_id', 'last_seen_at']),
    index('idx_code_findings_external_created', ['created_at'], {
      where: raw('"code_findings"."external_id" IS NOT NULL', '"external_id" IS NOT NULL'),
    }),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const codeFindings = materializeDrizzle(codeFindingsDefinition).table

const codeFixAttemptsDefinition = historyOwner.table({
  id: 'code_fix_attempts',
  schemaSymbol: 'codeFixAttempts',
  columns: {
    id: c.id('id', { primary: true }),
    workItemId: c.id('work_item_id'),
    fingerprint: c.text('fingerprint'),
    attemptSeq: c.int('attempt_seq'),
    roundId: c.id('round_id'),
    summary: c.text('summary'),
    outcome: c.text('outcome'),
    detail: c.text('detail', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('uniq_code_fix_attempts_seq', ['work_item_id', 'fingerprint', 'attempt_seq'], {
      unique: true,
    }),
    index('idx_code_fix_attempts_item', ['work_item_id', 'fingerprint']),
  ],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codeFixAttempts = materializeDrizzle(codeFixAttemptsDefinition).table

const codeMrLeasesDefinition = historyOwner.table({
  id: 'code_mr_leases',
  schemaSymbol: 'codeMrLeases',
  columns: {
    leaseKey: c.id('lease_key', { primary: true }),
    holderRoundId: c.id('holder_round_id'),
    token: c.text('token'),
    acquiredAt: c.epochMs('acquired_at'),
    expiresAt: c.epochMs('expires_at'),
  },
  indexes: [
    index('idx_code_mr_leases_holder', ['holder_round_id']),
    index('idx_code_mr_leases_expiry', ['expires_at']),
  ],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codeMrLeases = materializeDrizzle(codeMrLeasesDefinition).table

const codeProducedMrsDefinition = historyOwner.table({
  id: 'code_produced_mrs',
  schemaSymbol: 'codeProducedMrs',
  columns: {
    mrKey: c.id('mr_key', { primary: true }),
    codeHostEndpointId: c.id('code_host_endpoint_id'),
    stableProjectId: c.id('stable_project_id'),
    mrIid: c.text('mr_iid'),
    workItemId: c.id('work_item_id'),
    roundId: c.id('round_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    closedAt: c.epochMs('closed_at', { nullable: true }),
  },
  indexes: [index('idx_code_produced_mrs_item', ['work_item_id'])],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codeProducedMrs = materializeDrizzle(codeProducedMrsDefinition).table

const codePublishIntentsDefinition = historyOwner.table({
  id: 'code_publish_intents',
  schemaSymbol: 'codePublishIntents',
  columns: {
    batchId: c.id('batch_id', { primary: true }),
    roundId: c.id('round_id'),
    epoch: c.int('epoch'),
    state: c.enum('state', ['pending', 'settled', 'compensated', 'abandoned'], {
      default: 'pending',
    }),
    fingerprintsJson: c.jsonText('fingerprints_json'),
    externalIdsJson: c.jsonText('external_ids_json', { default: '{}' }),
    anchorRef: c.id('anchor_ref'),
    createdAt: c.epochMs('created_at'),
    settledAt: c.epochMs('settled_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_publish_intents_epoch_positive',
      expression: raw('"code_publish_intents"."epoch" >= 1', '"epoch" >= 1'),
    },
    {
      name: 'code_publish_intents_state_enum',
      expression: raw(
        "\"code_publish_intents\".\"state\" IN ('pending','settled','compensated','abandoned')",
        "\"state\" IN ('pending','settled','compensated','abandoned')",
      ),
    },
  ],
  indexes: [
    index('idx_code_publish_intents_round', ['round_id']),
    index('idx_code_publish_intents_state', ['state']),
  ],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codePublishIntents = materializeDrizzle(codePublishIntentsDefinition).table

const codeRoundStagesDefinition = historyOwner.table({
  id: 'code_round_stages',
  schemaSymbol: 'codeRoundStages',
  columns: {
    id: c.id('id', { primary: true }),
    roundId: c.id('round_id'),
    stageSeq: c.int('stage_seq'),
    stageName: c.text('stage_name'),
    stageKind: c.enum('stage_kind', ['program', 'script', 'ai', 'invoke']),
    status: c.enum('status', ['pending', 'running', 'done', 'failed', 'skipped', 'inherited'], {
      default: 'pending',
    }),
    countsJson: c.jsonText('counts_json', { nullable: true }),
    error: c.text('error', { nullable: true }),
    startedAt: c.epochMs('started_at', { nullable: true }),
    endedAt: c.epochMs('ended_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_round_stages_stage_seq_nonnegative',
      expression: raw('"code_round_stages"."stage_seq" >= 0', '"stage_seq" >= 0'),
    },
    {
      name: 'code_round_stages_stage_kind_enum',
      expression: raw(
        "\"code_round_stages\".\"stage_kind\" IN ('program','script','ai','invoke')",
        "\"stage_kind\" IN ('program','script','ai','invoke')",
      ),
    },
    {
      name: 'code_round_stages_status_enum',
      expression: raw(
        "\"code_round_stages\".\"status\" IN ('pending','running','done','failed','skipped','inherited')",
        "\"status\" IN ('pending','running','done','failed','skipped','inherited')",
      ),
    },
  ],
  indexes: [
    index('uniq_code_round_stages_seq', ['round_id', 'stage_seq'], { unique: true }),
    index('idx_code_round_stages_round', ['round_id']),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const codeRoundStages = materializeDrizzle(codeRoundStagesDefinition).table

const codeTriggerDeliveriesDefinition = historyOwner.table({
  id: 'code_trigger_deliveries',
  schemaSymbol: 'codeTriggerDeliveries',
  columns: {
    id: c.id('id', { primary: true }),
    correlationId: c.id('correlation_id'),
    codeHostEndpointId: c.id('code_host_endpoint_id', { nullable: true }),
    stableProjectId: c.id('stable_project_id', { nullable: true }),
    anchorKind: c.text('anchor_kind', { nullable: true }),
    anchorId: c.id('anchor_id', { nullable: true }),
    capability: c.text('capability', { nullable: true }),
    step: c.text('step'),
    outcome: c.text('outcome'),
    reason: c.text('reason', { nullable: true }),
    queuedAt: c.epochMs('queued_at', { nullable: true }),
    queuePosition: c.int('queue_position', { nullable: true }),
    waitingOn: c.text('waiting_on', { nullable: true }),
    roundId: c.id('round_id', { nullable: true }),
    isProbe: c.bool('is_probe', { default: false }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
  },
  indexes: [
    index('idx_code_trigger_deliveries_project', ['stable_project_id', 'created_at']),
    index('idx_code_trigger_deliveries_correlation', ['correlation_id']),
    index('idx_code_trigger_deliveries_outcome', ['outcome', 'created_at']),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const codeTriggerDeliveries = materializeDrizzle(codeTriggerDeliveriesDefinition).table

const codeWorkItemsDefinition = historyOwner.table({
  id: 'code_work_items',
  schemaSymbol: 'codeWorkItems',
  columns: {
    id: c.id('id', { primary: true }),
    codeHostEndpointId: c.id('code_host_endpoint_id'),
    stableProjectId: c.id('stable_project_id'),
    capability: c.text('capability'),
    anchorKind: c.enum('anchor_kind', ['mr', 'issue', 'pipeline', 'platform']),
    anchorId: c.id('anchor_id'),
    status: c.enum(
      'status',
      [
        'idle',
        'queued',
        'running',
        'awaiting',
        'settled',
        'failed',
        'superseding',
        'handed_off',
        'closing',
        'closed',
      ],
      { default: 'idle' },
    ),
    epoch: c.int('epoch', { default: 1 }),
    currentRoundId: c.id('current_round_id', { nullable: true }),
    pendingGeneration: c.int('pending_generation', { nullable: true }),
    handedOffFingerprint: c.text('handed_off_fingerprint', { nullable: true }),
    publishingEpoch: c.int('publishing_epoch', { nullable: true }),
    pendingRevision: c.text('pending_revision', { nullable: true }),
    anchorMeta: c.text('anchor_meta', { nullable: true }),
    initiatorUserId: c.id('initiator_user_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    closedAt: c.epochMs('closed_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_work_items_anchor_kind_enum',
      expression: raw(
        "\"code_work_items\".\"anchor_kind\" IN ('mr','issue','pipeline','platform')",
        "\"anchor_kind\" IN ('mr','issue','pipeline','platform')",
      ),
    },
    {
      name: 'code_work_items_status_enum',
      expression: raw(
        "\"code_work_items\".\"status\" IN ('idle','queued','running','awaiting','settled','failed','superseding','handed_off','closing','closed')",
        "\"status\" IN ('idle','queued','running','awaiting','settled','failed','superseding','handed_off','closing','closed')",
      ),
    },
    {
      name: 'code_work_items_epoch_positive',
      expression: raw('"code_work_items"."epoch" >= 1', '"epoch" >= 1'),
    },
    {
      name: 'code_work_items_publishing_epoch_positive',
      expression: raw(
        '"code_work_items"."publishing_epoch" IS NULL OR "code_work_items"."publishing_epoch" >= 1',
        '"publishing_epoch" IS NULL OR "publishing_epoch" >= 1',
      ),
    },
  ],
  indexes: [
    index(
      'uniq_code_work_items_identity',
      ['code_host_endpoint_id', 'stable_project_id', 'capability', 'anchor_kind', 'anchor_id'],
      { unique: true },
    ),
    index('idx_code_work_items_status', ['status']),
    index('idx_code_work_items_created', ['created_at']),
    index('idx_code_work_items_anchor', [
      'code_host_endpoint_id',
      'stable_project_id',
      'anchor_kind',
      'anchor_id',
    ]),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const codeWorkItems = materializeDrizzle(codeWorkItemsDefinition).table

const codeWorkObservationsDefinition = historyOwner.table({
  id: 'code_work_observations',
  schemaSymbol: 'codeWorkObservations',
  columns: {
    id: c.id('id', { primary: true }),
    workItemId: c.id('work_item_id'),
    kind: c.text('kind'),
    reason: c.text('reason'),
    observedRevision: c.text('observed_revision', { nullable: true }),
    causationId: c.id('causation_id', { nullable: true }),
    eventId: c.id('event_id', { nullable: true }),
    createdAt: c.epochMs('created_at'),
  },
  indexes: [
    index('idx_code_work_observations_item', [
      'work_item_id',
      raw('"code_work_observations"."created_at" DESC', '"created_at" DESC'),
    ]),
    index('uniq_code_work_observations_event', ['event_id'], { unique: true }),
  ],
  retention: retention.archive,
  migrationPolicy: 'ARCHIVE_THEN_OMIT',
})

export const codeWorkObservations = materializeDrizzle(codeWorkObservationsDefinition).table

const codeWorkRoundsDefinition = historyOwner.table({
  id: 'code_work_rounds',
  schemaSymbol: 'codeWorkRounds',
  columns: {
    id: c.id('id', { primary: true }),
    workItemId: c.id('work_item_id'),
    roundSeq: c.int('round_seq'),
    epoch: c.int('epoch'),
    taskId: c.id('task_id', { nullable: true }),
    baselineSha: c.text('baseline_sha', { nullable: true }),
    workPackage: c.text('work_package', { nullable: true }),
    templateSnapshot: c.text('template_snapshot', { nullable: true }),
    stageContractVer: c.int('stage_contract_ver', { default: 1 }),
    outcome: c.enum('outcome', ['published', 'awaiting', 'failed', 'canceled', 'superseded'], {
      nullable: true,
    }),
    startedAt: c.epochMs('started_at'),
    endedAt: c.epochMs('ended_at', { nullable: true }),
  },
  checks: [
    {
      name: 'code_work_rounds_round_seq_positive',
      expression: raw('"code_work_rounds"."round_seq" >= 1', '"round_seq" >= 1'),
    },
    {
      name: 'code_work_rounds_epoch_positive',
      expression: raw('"code_work_rounds"."epoch" >= 1', '"epoch" >= 1'),
    },
    {
      name: 'code_work_rounds_outcome_enum',
      expression: raw(
        "\"code_work_rounds\".\"outcome\" IS NULL OR \"code_work_rounds\".\"outcome\" IN ('published','awaiting','failed','canceled','superseded')",
        "\"outcome\" IS NULL OR \"outcome\" IN ('published','awaiting','failed','canceled','superseded')",
      ),
    },
  ],
  indexes: [
    index('uniq_code_work_rounds_seq', ['work_item_id', 'round_seq'], { unique: true }),
    index('idx_code_work_rounds_item', ['work_item_id']),
    index('idx_code_work_rounds_task', ['task_id']),
    index('idx_code_work_rounds_started', ['started_at']),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const codeWorkRounds = materializeDrizzle(codeWorkRoundsDefinition).table

const legacyCodeWorkItemLinksDefinition = historyOwner.table({
  id: 'legacy_code_work_item_links',
  schemaSymbol: 'legacyCodeWorkItemLinks',
  columns: {
    id: c.id('id', { primary: true }),
    missionId: c.id('mission_id'),
    legacyWorkItemId: c.id('legacy_work_item_id', { nullable: true }),
    legacyRoundId: c.id('legacy_round_id', { nullable: true }),
    cutoverReceiptJson: c.jsonText('cutover_receipt_json'),
    createdAt: c.epochMs('created_at'),
  },
  foreignKeys: [
    foreignKey(
      'legacy_code_work_item_links_mission_id_development_missions_id_fk',
      ['mission_id'],
      'development_missions',
      ['id'],
    ),
  ],
  retention: retention.business,
  migrationPolicy: 'DEFER',
})

export const legacyCodeWorkItemLinks = materializeDrizzle(legacyCodeWorkItemLinksDefinition).table

export const historySchemaContribution = historyOwner.contribution([
  codeAiAttemptsDefinition,
  codeArtifactsDefinition,
  codeFindingsDefinition,
  codeFixAttemptsDefinition,
  codeMrLeasesDefinition,
  codeProducedMrsDefinition,
  codePublishIntentsDefinition,
  codeRoundStagesDefinition,
  codeTriggerDeliveriesDefinition,
  codeWorkItemsDefinition,
  codeWorkObservationsDefinition,
  codeWorkRoundsDefinition,
  legacyCodeWorkItemLinksDefinition,
])
