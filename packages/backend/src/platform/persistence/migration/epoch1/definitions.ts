// RFC-395 II-b V1: frozen epoch-1 declarations; update only with the source manifest.
import {
  column as c,
  defineContribution,
  retention,
  raw,
  foreignKey,
  index,
} from '../../schema/dsl'
import { createSchemaRegistry } from '../../schema/registry'

const frozen0 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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
      readiness: c.enum('readiness', ['disabled', 'misconfigured', 'ready'], {
        default: 'disabled',
      }),
      readinessIssuesJson: c.jsonText('readiness_issues_json', { default: '[]' }),
      dependencyRevision: c.int('dependency_revision', { default: 0 }),
      lastValidatedAt: c.epochMs('last_validated_at', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'repo_capability_config_enabled_boolean',
        expression: raw(
          '"repo_capability_config"."enabled" IN (0, 1)',
          '"enabled" IN (FALSE, TRUE)',
        ),
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

  const schemaContribution = owner.contribution([
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
      lifecycle: c.enum('lifecycle', ['active', 'disappeared', 'reappeared'], {
        default: 'active',
      }),
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

  const historySchemaContribution = historyOwner.contribution([
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

  return { schemaContribution, historySchemaContribution }
})()

const frozen1 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('collaboration')

  const clarifyRoundsDefinition = owner.table({
    id: 'clarify_rounds',
    schemaSymbol: 'clarifyRounds',
    columns: {
      id: c.id('id', { primary: true }),
      taskId: c.id('task_id'),
      kind: c.enum('kind', ['self', 'cross']),
      askingNodeId: c.id('asking_node_id'),
      askingNodeRunId: c.id('asking_node_run_id'),
      askingShardKey: c.id('asking_shard_key', { nullable: true }),
      intermediaryNodeId: c.id('intermediary_node_id'),
      intermediaryNodeRunId: c.id('intermediary_node_run_id'),
      targetConsumerNodeId: c.id('target_consumer_node_id', { nullable: true }),
      loopIter: c.int('loop_iter', { default: 0 }),
      containerRunId: c.id('container_run_id', { nullable: true }),
      iteration: c.int('iteration', { default: 0 }),
      questionsJson: c.jsonText('questions_json'),
      answersJson: c.jsonText('answers_json', { nullable: true }),
      directive: c.enum('directive', ['continue', 'stop'], { nullable: true }),
      status: c.enum('status', ['awaiting_human', 'answered', 'canceled', 'abandoned'], {
        default: 'awaiting_human',
      }),
      truncationWarningsJson: c.jsonText('truncation_warnings_json', { nullable: true }),
      designerRunTriggeredAt: c.epochMs('designer_run_triggered_at', { nullable: true }),
      abandonedAt: c.epochMs('abandoned_at', { nullable: true }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
      answeredAt: c.epochMs('answered_at', { nullable: true }),
      answeredBy: c.text('answered_by', { nullable: true }),
      submittedByRole: c.text('submitted_by_role', { nullable: true }),
      answerAttributionsJson: c.jsonText('answer_attributions_json', { nullable: true }),
      draftAnswersJson: c.jsonText('draft_answers_json', { nullable: true }),
    },
    foreignKeys: [
      foreignKey('clarify_rounds_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
        onDelete: 'cascade',
      }),
      foreignKey(
        'clarify_rounds_asking_node_run_id_node_runs_id_fk',
        ['asking_node_run_id'],
        'node_runs',
        ['id'],
        { onDelete: 'cascade' },
      ),
      foreignKey(
        'clarify_rounds_intermediary_node_run_id_node_runs_id_fk',
        ['intermediary_node_run_id'],
        'node_runs',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'clarify_rounds_kind_enum',
        expression: raw(
          '"clarify_rounds"."kind" IN (\'self\', \'cross\')',
          "\"kind\" IN ('self', 'cross')",
        ),
      },
      {
        name: 'clarify_rounds_directive_enum',
        expression: raw(
          '"clarify_rounds"."directive" IS NULL OR "clarify_rounds"."directive" IN (\'continue\', \'stop\')',
          '"directive" IS NULL OR "directive" IN (\'continue\', \'stop\')',
        ),
      },
      {
        name: 'clarify_rounds_status_enum',
        expression: raw(
          "\"clarify_rounds\".\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
          "\"status\" IN ('awaiting_human', 'answered', 'canceled', 'abandoned')",
        ),
      },
      {
        name: 'clarify_rounds_kind_shape',
        expression: raw(
          '("clarify_rounds"."kind" = \'self\' AND "clarify_rounds"."status" != \'abandoned\') OR ("clarify_rounds"."kind" = \'cross\' AND "clarify_rounds"."status" != \'canceled\')',
          '("kind" = \'self\' AND "status" != \'abandoned\') OR ("kind" = \'cross\' AND "status" != \'canceled\')',
        ),
      },
    ],
    indexes: [
      index('idx_clarify_rounds_task', ['task_id']),
      index('idx_clarify_rounds_kind_status', ['kind', 'status']),
      index('idx_clarify_rounds_asking', [
        'asking_node_id',
        'container_run_id',
        'loop_iter',
        'iteration',
      ]),
      index('idx_clarify_rounds_intermediary', ['intermediary_node_id', 'loop_iter', 'iteration']),
      index('idx_clarify_rounds_target_consumer', [
        'target_consumer_node_id',
        'loop_iter',
        'iteration',
      ]),
    ],
    retention: retention.business,
  })

  const collaborationGateArtifactsDefinition = owner.table({
    id: 'collaboration_gate_artifacts',
    schemaSymbol: 'collaborationGateArtifacts',
    columns: {
      operationId: c.id('operation_id'),
      artifactKey: c.id('artifact_key'),
      artifactKind: c.enum('artifact_kind', ['review-doc']),
      stagedPath: c.text('staged_path'),
      finalPath: c.text('final_path'),
      sha256: c.text('sha256'),
      byteSize: c.int('byte_size'),
      state: c.enum('state', ['declared', 'staged', 'consumed', 'finalized', 'cleanup_pending']),
      receiptJson: c.jsonText('receipt_json', { nullable: true }),
      updatedAt: c.epochMs('updated_at'),
    },
    primaryKey: ['operation_id', 'artifact_key'],
    foreignKeys: [
      foreignKey(
        'collaboration_gate_artifacts_operation_id_collaboration_gate_operations_id_fk',
        ['operation_id'],
        'collaboration_gate_operations',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'collaboration_gate_artifacts_byte_size_nonnegative',
        expression: raw('"collaboration_gate_artifacts"."byte_size" >= 0', '"byte_size" >= 0'),
      },
      {
        name: 'collaboration_gate_artifacts_receipt_json_valid',
        expression: raw(
          '"collaboration_gate_artifacts"."receipt_json" IS NULL OR json_valid("collaboration_gate_artifacts"."receipt_json")',
          '"receipt_json" IS NULL OR json_valid("receipt_json")',
        ),
      },
      {
        name: 'collaboration_gate_artifacts_artifact_kind_fixed',
        expression: raw(
          '"collaboration_gate_artifacts"."artifact_kind" = \'review-doc\'',
          '"artifact_kind" = \'review-doc\'',
        ),
      },
      {
        name: 'collaboration_gate_artifacts_state_enum',
        expression: raw(
          "\"collaboration_gate_artifacts\".\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
          "\"state\" IN ('declared','staged','consumed','finalized','cleanup_pending')",
        ),
      },
    ],
    indexes: [
      index('idx_collaboration_gate_artifacts_final_path', ['final_path'], { unique: true }),
      index('idx_collaboration_gate_artifacts_state', ['state', 'updated_at']),
    ],
    retention: retention.business,
  })

  const collaborationGateOperationsDefinition = owner.table({
    id: 'collaboration_gate_operations',
    schemaSymbol: 'collaborationGateOperations',
    columns: {
      id: c.id('id', { primary: true }),
      taskId: c.id('task_id'),
      gateKind: c.enum('gate_kind', ['review', 'clarify', 'questions']),
      operationKind: c.enum('operation_kind', [
        'open',
        'decide',
        'manual-question-open',
        'legacy-seed',
      ]),
      gateRef: c.id('gate_ref'),
      idempotencyKey: c.id('idempotency_key'),
      requestHash: c.text('request_hash'),
      actorUserId: c.id('actor_user_id', { nullable: true }),
      expectedTaskRevision: c.int('expected_task_revision'),
      expectedGateRevision: c.int('expected_gate_revision'),
      resultGateRevision: c.int('result_gate_revision', { nullable: true }),
      state: c.enum('state', [
        'preparing',
        'prepared',
        'committed',
        'cleanup_pending',
        'completed',
        'failed',
      ]),
      claimEpoch: c.int('claim_epoch', { default: 0 }),
      claimExpiresAt: c.epochMs('claim_expires_at', { nullable: true }),
      schemaVersion: c.int('schema_version', { default: 1 }),
      manifestJson: c.jsonText('manifest_json', { default: '{}' }),
      receiptJson: c.jsonText('receipt_json', { nullable: true }),
      failureJson: c.jsonText('failure_json', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      committedAt: c.epochMs('committed_at', { nullable: true }),
      completedAt: c.epochMs('completed_at', { nullable: true }),
    },
    foreignKeys: [
      foreignKey(
        'collaboration_gate_operations_task_id_tasks_id_fk',
        ['task_id'],
        'tasks',
        ['id'],
        {
          onDelete: 'cascade',
        },
      ),
    ],
    checks: [
      {
        name: 'collaboration_gate_operations_task_revision_nonnegative',
        expression: raw(
          '"collaboration_gate_operations"."expected_task_revision" >= 0',
          '"expected_task_revision" >= 0',
        ),
      },
      {
        name: 'collaboration_gate_operations_gate_revision_nonnegative',
        expression: raw(
          '"collaboration_gate_operations"."expected_gate_revision" >= 0',
          '"expected_gate_revision" >= 0',
        ),
      },
      {
        name: 'collaboration_gate_operations_result_revision_next',
        expression: raw(
          '"collaboration_gate_operations"."result_gate_revision" IS NULL OR "collaboration_gate_operations"."result_gate_revision" = "collaboration_gate_operations"."expected_gate_revision" + 1',
          '"result_gate_revision" IS NULL OR "result_gate_revision" = "expected_gate_revision" + 1',
        ),
      },
      {
        name: 'collaboration_gate_operations_claim_epoch_nonnegative',
        expression: raw('"collaboration_gate_operations"."claim_epoch" >= 0', '"claim_epoch" >= 0'),
      },
      {
        name: 'collaboration_gate_operations_schema_version_positive',
        expression: raw(
          '"collaboration_gate_operations"."schema_version" > 0',
          '"schema_version" > 0',
        ),
      },
      {
        name: 'collaboration_gate_operations_manifest_json_valid',
        expression: raw(
          'json_valid("collaboration_gate_operations"."manifest_json")',
          'json_valid("manifest_json")',
        ),
      },
      {
        name: 'collaboration_gate_operations_receipt_json_valid',
        expression: raw(
          '"collaboration_gate_operations"."receipt_json" IS NULL OR json_valid("collaboration_gate_operations"."receipt_json")',
          '"receipt_json" IS NULL OR json_valid("receipt_json")',
        ),
      },
      {
        name: 'collaboration_gate_operations_failure_json_valid',
        expression: raw(
          '"collaboration_gate_operations"."failure_json" IS NULL OR json_valid("collaboration_gate_operations"."failure_json")',
          '"failure_json" IS NULL OR json_valid("failure_json")',
        ),
      },
      {
        name: 'collaboration_gate_operations_committed_shape',
        expression: raw(
          '"collaboration_gate_operations"."state" <> \'committed\' OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL)',
          '"state" <> \'committed\' OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL)',
        ),
      },
      {
        name: 'collaboration_gate_operations_completed_shape',
        expression: raw(
          '"collaboration_gate_operations"."state" <> \'completed\' OR ("collaboration_gate_operations"."failure_json" IS NOT NULL OR ("collaboration_gate_operations"."result_gate_revision" IS NOT NULL AND "collaboration_gate_operations"."receipt_json" IS NOT NULL AND "collaboration_gate_operations"."committed_at" IS NOT NULL))',
          '"state" <> \'completed\' OR ("failure_json" IS NOT NULL OR ("result_gate_revision" IS NOT NULL AND "receipt_json" IS NOT NULL AND "committed_at" IS NOT NULL))',
        ),
      },
      {
        name: 'collaboration_gate_operations_failed_shape',
        expression: raw(
          '"collaboration_gate_operations"."state" <> \'failed\' OR "collaboration_gate_operations"."failure_json" IS NOT NULL',
          '"state" <> \'failed\' OR "failure_json" IS NOT NULL',
        ),
      },
      {
        name: 'collaboration_gate_operations_gate_kind_enum',
        expression: raw(
          "\"collaboration_gate_operations\".\"gate_kind\" IN ('review','clarify','questions')",
          "\"gate_kind\" IN ('review','clarify','questions')",
        ),
      },
      {
        name: 'collaboration_gate_operations_operation_kind_enum',
        expression: raw(
          "\"collaboration_gate_operations\".\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
          "\"operation_kind\" IN ('open','decide','manual-question-open','legacy-seed')",
        ),
      },
      {
        name: 'collaboration_gate_operations_state_enum',
        expression: raw(
          "\"collaboration_gate_operations\".\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
          "\"state\" IN ('preparing','prepared','committed','cleanup_pending','completed','failed')",
        ),
      },
    ],
    indexes: [
      index(
        'idx_collaboration_gate_operations_idempotency',
        ['task_id', 'gate_kind', 'operation_kind', 'idempotency_key'],
        { unique: true },
      ),
      index(
        'idx_collaboration_gate_operations_revision',
        ['gate_kind', 'gate_ref', 'result_gate_revision'],
        {
          unique: true,
          where: raw(
            '"collaboration_gate_operations"."result_gate_revision" IS NOT NULL',
            '"result_gate_revision" IS NOT NULL',
          ),
        },
      ),
      index(
        'idx_collaboration_gate_operations_one_active',
        ['task_id', 'gate_kind', 'gate_ref', 'operation_kind'],
        {
          unique: true,
          where: raw(
            "\"collaboration_gate_operations\".\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
            "\"state\" IN ('preparing', 'prepared', 'committed', 'cleanup_pending')",
          ),
        },
      ),
      index('idx_collaboration_gate_operations_recovery', [
        'state',
        'claim_expires_at',
        'updated_at',
      ]),
      index('idx_collaboration_gate_operations_task_gate', [
        'task_id',
        'gate_kind',
        'gate_ref',
        'created_at',
      ]),
    ],
    retention: retention.operational,
  })

  const docVersionsDefinition = owner.table({
    id: 'doc_versions',
    schemaSymbol: 'docVersions',
    columns: {
      id: c.id('id', { primary: true }),
      taskId: c.id('task_id'),
      reviewNodeId: c.id('review_node_id'),
      reviewNodeRunId: c.id('review_node_run_id'),
      sourceNodeId: c.id('source_node_id'),
      sourcePortName: c.text('source_port_name'),
      versionIndex: c.int('version_index'),
      reviewIteration: c.int('review_iteration'),
      bodyPath: c.text('body_path'),
      commentsJson: c.jsonText('comments_json', { default: '[]' }),
      decision: c.enum('decision', ['pending', 'approved', 'rejected', 'iterated', 'superseded'], {
        default: 'pending',
      }),
      decisionReason: c.text('decision_reason', { nullable: true }),
      promptSnapshot: c.text('prompt_snapshot', { nullable: true }),
      sourceFilePath: c.text('source_file_path', { nullable: true }),
      itemIndex: c.int('item_index', { nullable: true }),
      selection: c.enum('selection', ['unselected', 'accepted', 'not_accepted'], {
        nullable: true,
      }),
      itemPath: c.text('item_path', { nullable: true }),
      selectionStale: c.bool('selection_stale', { nullable: true }),
      roundGeneration: c.int('round_generation', { nullable: true }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
      decidedAt: c.epochMs('decided_at', { nullable: true }),
      decidedBy: c.text('decided_by', { nullable: true }),
      decidedByRole: c.text('decided_by_role', { nullable: true }),
    },
    foreignKeys: [
      foreignKey('doc_versions_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
        onDelete: 'cascade',
      }),
      foreignKey(
        'doc_versions_review_node_run_id_node_runs_id_fk',
        ['review_node_run_id'],
        'node_runs',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('idx_doc_versions_review_run', ['review_node_run_id', 'version_index']),
      index('idx_doc_versions_task', ['task_id']),
      index('idx_doc_versions_review_item', ['review_node_run_id', 'item_index']),
      index('idx_doc_versions_pending_created', ['created_at'], {
        where: raw('"doc_versions"."decision" = \'pending\'', '"decision" = \'pending\''),
      }),
    ],
    retention: retention.business,
  })

  const reviewCommentsDefinition = owner.table({
    id: 'review_comments',
    schemaSymbol: 'reviewComments',
    columns: {
      id: c.id('id', { primary: true }),
      docVersionId: c.id('doc_version_id'),
      anchorSectionPath: c.text('anchor_section_path'),
      anchorParagraphIdx: c.int('anchor_paragraph_idx'),
      anchorOffsetStart: c.int('anchor_offset_start'),
      anchorOffsetEnd: c.int('anchor_offset_end'),
      selectedText: c.text('selected_text'),
      contextBefore: c.text('context_before'),
      contextAfter: c.text('context_after'),
      occurrenceIndex: c.int('occurrence_index'),
      commentText: c.text('comment_text'),
      author: c.text('author', { default: 'local' }),
      authorRole: c.text('author_role', { nullable: true }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
    },
    foreignKeys: [
      foreignKey(
        'review_comments_doc_version_id_doc_versions_id_fk',
        ['doc_version_id'],
        'doc_versions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [index('idx_review_comments_version', ['doc_version_id', 'anchor_section_path'])],
    retention: retention.business,
  })

  const reviewNodeReviewersDefinition = owner.table({
    id: 'review_node_reviewers',
    schemaSymbol: 'reviewNodeReviewers',
    columns: {
      taskId: c.id('task_id'),
      reviewNodeId: c.id('review_node_id'),
      reviewerUserId: c.id('reviewer_user_id'),
      assignedByUserId: c.id('assigned_by_user_id'),
      assignedAt: c.epochMs('assigned_at'),
    },
    primaryKey: ['task_id', 'review_node_id', 'reviewer_user_id'],
    foreignKeys: [
      foreignKey('review_node_reviewers_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
        onDelete: 'cascade',
      }),
      foreignKey(
        'review_node_reviewers_reviewer_user_id_users_id_fk',
        ['reviewer_user_id'],
        'users',
        ['id'],
        { onDelete: 'restrict' },
      ),
      foreignKey(
        'review_node_reviewers_assigned_by_user_id_users_id_fk',
        ['assigned_by_user_id'],
        'users',
        ['id'],
        { onDelete: 'restrict' },
      ),
    ],
    indexes: [
      index('idx_review_node_reviewers_actor', ['reviewer_user_id', 'task_id', 'review_node_id']),
      index('idx_review_node_reviewers_node', ['task_id', 'review_node_id']),
    ],
    retention: retention.business,
  })

  const taskCollaboratorsDefinition = owner.table({
    id: 'task_collaborators',
    schemaSymbol: 'taskCollaborators',
    columns: {
      taskId: c.id('task_id'),
      userId: c.id('user_id'),
      role: c.enum('role', ['owner', 'collaborator', 'observer']),
      addedBy: c.text('added_by'),
      addedAt: c.epochMs('added_at'),
    },
    primaryKey: ['task_id', 'user_id', 'role'],
    foreignKeys: [
      foreignKey('task_collaborators_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
        onDelete: 'cascade',
      }),
      foreignKey('task_collaborators_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'restrict',
      }),
    ],
    indexes: [
      index('idx_task_collab_user', ['user_id']),
      index('idx_task_collab_task', ['task_id']),
    ],
    retention: retention.business,
  })

  const taskFeedbackDefinition = owner.table({
    id: 'task_feedback',
    schemaSymbol: 'taskFeedback',
    columns: {
      id: c.id('id', { primary: true }),
      taskId: c.id('task_id'),
      authorUserId: c.id('author_user_id', { nullable: true }),
      bodyMd: c.text('body_md'),
      createdAt: c.epochMs('created_at'),
      distilled: c.int('distilled', { default: 0 }),
      distillJobId: c.id('distill_job_id', { nullable: true }),
    },
    indexes: [index('idx_task_feedback_task', ['task_id', 'created_at'])],
    retention: retention.business,
  })

  const taskQuestionsDefinition = owner.table({
    id: 'task_questions',
    schemaSymbol: 'taskQuestions',
    columns: {
      id: c.id('id', { primary: true }),
      taskId: c.id('task_id'),
      originNodeRunId: c.id('origin_node_run_id'),
      questionId: c.id('question_id'),
      questionTitle: c.text('question_title'),
      sourceKind: c.enum('source_kind', ['self', 'cross', 'manual']),
      roleKind: c.enum('role_kind', ['self', 'questioner', 'designer']),
      iteration: c.int('iteration', { default: 0 }),
      loopIter: c.int('loop_iter', { default: 0 }),
      defaultTargetNodeId: c.id('default_target_node_id', { nullable: true }),
      overrideTargetNodeId: c.id('override_target_node_id', { nullable: true }),
      dispatchedAt: c.epochMs('dispatched_at', { nullable: true }),
      dispatchedBy: c.text('dispatched_by', { nullable: true }),
      triggerRunId: c.id('trigger_run_id', { nullable: true }),
      stagedAt: c.epochMs('staged_at', { nullable: true }),
      stagedBy: c.text('staged_by', { nullable: true }),
      autoDispatchDeferredAt: c.epochMs('auto_dispatch_deferred_at', { nullable: true }),
      sealedAt: c.epochMs('sealed_at', { nullable: true }),
      sealedBy: c.text('sealed_by', { nullable: true }),
      confirmation: c.enum('confirmation', ['open', 'confirmed'], { default: 'open' }),
      confirmedBy: c.text('confirmed_by', { nullable: true }),
      confirmedByRole: c.text('confirmed_by_role', { nullable: true }),
      confirmedAt: c.epochMs('confirmed_at', { nullable: true }),
      lastReassignedBy: c.text('last_reassigned_by', { nullable: true }),
      lastReassignedAt: c.epochMs('last_reassigned_at', { nullable: true }),
      manualBody: c.text('manual_body', { nullable: true }),
      manualCreatedBy: c.text('manual_created_by', { nullable: true }),
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
      foreignKey('task_questions_task_id_tasks_id_fk', ['task_id'], 'tasks', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [
      index('idx_task_questions_task', ['task_id']),
      index('idx_task_questions_origin', ['origin_node_run_id']),
      index('uniq_task_questions_identity', ['origin_node_run_id', 'question_id', 'role_kind'], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    clarifyRoundsDefinition,
    collaborationGateArtifactsDefinition,
    collaborationGateOperationsDefinition,
    docVersionsDefinition,
    reviewCommentsDefinition,
    reviewNodeReviewersDefinition,
    taskCollaboratorsDefinition,
    taskFeedbackDefinition,
    taskQuestionsDefinition,
  ])

  return { schemaContribution }
})()

const frozen2 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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

  const automationPoliciesDefinition = owner.table({
    id: 'automation_policies',
    schemaSymbol: 'automationPolicies',
    columns: {
      id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
      name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
      draftJson: c.jsonText('draft_json', {
        sqliteUniqueName: 'action_templates_draft_json_unique',
      }),
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
      createdAt: c.epochMs('created_at', {
        sqliteUniqueName: 'action_templates_created_at_unique',
      }),
      updatedAt: c.epochMs('updated_at', {
        sqliteUniqueName: 'action_templates_updated_at_unique',
      }),
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

  const developmentAdapterDefinitionsDefinition = owner.table({
    id: 'development_adapter_definitions',
    schemaSymbol: 'developmentAdapterDefinitions',
    columns: {
      id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
      name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
      draftJson: c.jsonText('draft_json', {
        sqliteUniqueName: 'action_templates_draft_json_unique',
      }),
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
      createdAt: c.epochMs('created_at', {
        sqliteUniqueName: 'action_templates_created_at_unique',
      }),
      updatedAt: c.epochMs('updated_at', {
        sqliteUniqueName: 'action_templates_updated_at_unique',
      }),
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
      index('dev_decisions_input_unique', ['mission_id', 'decision_input_digest'], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

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
      index('development_design_revisions_request_uq', ['design_id', 'request_id'], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

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
      index('dev_upload_plan_target_unique', ['plan_id', 'repository_target_path'], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

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

  const digitalEmployeesDefinition = owner.table({
    id: 'digital_employees',
    schemaSymbol: 'digitalEmployees',
    columns: {
      id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
      name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
      draftJson: c.jsonText('draft_json', {
        sqliteUniqueName: 'action_templates_draft_json_unique',
      }),
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
      createdAt: c.epochMs('created_at', {
        sqliteUniqueName: 'action_templates_created_at_unique',
      }),
      updatedAt: c.epochMs('updated_at', {
        sqliteUniqueName: 'action_templates_updated_at_unique',
      }),
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

  const verificationProfilesDefinition = owner.table({
    id: 'verification_profiles',
    schemaSymbol: 'verificationProfiles',
    columns: {
      id: c.id('id', { primary: true, sqliteUniqueName: 'action_templates_id_unique' }),
      name: c.text('name', { sqliteUniqueName: 'action_templates_name_unique' }),
      draftJson: c.jsonText('draft_json', {
        sqliteUniqueName: 'action_templates_draft_json_unique',
      }),
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
      createdAt: c.epochMs('created_at', {
        sqliteUniqueName: 'action_templates_created_at_unique',
      }),
      updatedAt: c.epochMs('updated_at', {
        sqliteUniqueName: 'action_templates_updated_at_unique',
      }),
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

  const schemaContribution = owner.contribution([
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

  return { schemaContribution }
})()

const frozen3 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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
      index('employee_attention_desired_identity_unique', ['desired_identity_key'], {
        unique: true,
      }),
      index('idx_employee_attention_case_state', ['case_id', 'state', 'updated_at']),
    ],
    retention: retention.business,
  })

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
      index('idx_employee_case_event_origins_subscription', [
        'event_subscription_id',
        'created_at',
      ]),
    ],
    retention: retention.operational,
  })

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
      foreignKey(
        'employee_case_inbox_case_id_employee_cases_id_fk',
        ['case_id'],
        'employee_cases',
        ['id'],
      ),
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
      index('idx_employee_cases_state_employee_terminal', [
        'state',
        'employee_id',
        'terminal_kind',
      ]),
      index('idx_employee_cases_owner_origin_updated', [
        'owner_user_id',
        'launch_origin',
        'updated_at',
        'id',
      ]),
    ],
    retention: retention.business,
  })

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
      state: c.enum(
        'state',
        ['planned', 'running', 'settling', 'completed', 'failed', 'obsolete'],
        {
          default: 'planned',
        },
      ),
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

  const schemaContribution = owner.contribution([
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

  return { schemaContribution }
})()

const frozen4 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('event-center')

  const customEventSourceDefinitionsDefinition = owner.table({
    id: 'custom_event_source_definitions',
    schemaSymbol: 'customEventSourceDefinitions',
    columns: {
      id: c.id('id', { primary: true }),
      draftJson: c.jsonText('draft_json'),
      publishedRevision: c.int('published_revision', { nullable: true }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      retiredAt: c.epochMs('retired_at', { nullable: true }),
    },
    indexes: [index('idx_custom_event_sources_state', ['retired_at', 'updated_at'])],
    retention: retention.operational,
  })

  const customEventSourceRevisionsDefinition = owner.table({
    id: 'custom_event_source_revisions',
    schemaSymbol: 'customEventSourceRevisions',
    columns: {
      sourceId: c.id('source_id'),
      revision: c.int('revision'),
      contentJson: c.jsonText('content_json'),
      contentDigest: c.id('content_digest'),
      validationReceiptJson: c.jsonText('validation_receipt_json'),
      publishedAt: c.epochMs('published_at'),
      publishedBy: c.text('published_by', { nullable: true }),
    },
    primaryKey: ['source_id', 'revision'],
    foreignKeys: [
      foreignKey(
        'custom_event_source_revisions_source_id_custom_event_source_definitions_id_fk',
        ['source_id'],
        'custom_event_source_definitions',
        ['id'],
      ),
    ],
    indexes: [index('idx_custom_event_source_revisions', ['source_id', 'revision'])],
    retention: retention.operational,
  })

  const eventAutomationWorkIntentsDefinition = owner.table({
    id: 'event_automation_work_intents',
    schemaSymbol: 'eventAutomationWorkIntents',
    columns: {
      originRef: c.id('origin_ref', { primary: true }),
      deliveryId: c.id('delivery_id'),
      subscriptionId: c.id('subscription_id'),
      ruleId: c.id('rule_id'),
      ruleRevision: c.int('rule_revision'),
      ruleDigest: c.id('rule_digest'),
      ownerUserId: c.id('owner_user_id'),
      portId: c.enum('port_id', [
        'task-automation-work-start.v1',
        'employee-automation-work-start.v1',
      ]),
      targetPayloadJson: c.jsonText('target_payload_json'),
      targetFormatVersion: c.int('target_format_version', { default: 1 }),
      targetDigest: c.id('target_digest'),
      resolvedTargetRef: c.id('resolved_target_ref'),
      receiptRef: c.id('receipt_ref', { nullable: true }),
      status: c.enum('status', ['prepared', 'launched', 'failed', 'obsolete'], {
        default: 'prepared',
      }),
      claimOwner: c.text('claim_owner'),
      claimAttempt: c.int('claim_attempt'),
      lastError: c.text('last_error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    foreignKeys: [
      foreignKey(
        'event_automation_work_intents_delivery_id_event_deliveries_id_fk',
        ['delivery_id'],
        'event_deliveries',
        ['id'],
      ),
    ],
    indexes: [
      index('event_automation_work_intents_delivery_unique', ['delivery_id'], { unique: true }),
      index('event_automation_work_intents_origin_port_unique', ['origin_ref', 'port_id'], {
        unique: true,
      }),
      index('idx_event_automation_work_intents_status', ['status', 'updated_at']),
    ],
    retention: retention.operational,
  })

  const eventDeliveriesDefinition = owner.table({
    id: 'event_deliveries',
    schemaSymbol: 'eventDeliveries',
    columns: {
      id: c.id('id', { primary: true }),
      eventId: c.id('event_id'),
      subscriptionId: c.id('subscription_id'),
      subscriberKind: c.text('subscriber_kind'),
      subscriberRef: c.id('subscriber_ref'),
      deliveryClass: c.text('delivery_class'),
      state: c.enum('state', ['pending', 'claimed', 'accepted', 'dead-letter'], {
        default: 'pending',
      }),
      attemptCount: c.int('attempt_count', { default: 0 }),
      nextAttemptAt: c.epochMs('next_attempt_at'),
      claimedBy: c.text('claimed_by', { nullable: true }),
      claimExpiresAt: c.epochMs('claim_expires_at', { nullable: true }),
      lastError: c.text('last_error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      acceptedAt: c.epochMs('accepted_at', { nullable: true }),
      deadLetterAt: c.epochMs('dead_letter_at', { nullable: true }),
    },
    foreignKeys: [
      foreignKey('event_deliveries_event_id_event_records_id_fk', ['event_id'], 'event_records', [
        'id',
      ]),
      foreignKey(
        'event_deliveries_subscription_id_event_subscriptions_id_fk',
        ['subscription_id'],
        'event_subscriptions',
        ['id'],
      ),
    ],
    indexes: [
      index('event_deliveries_event_subscription_unique', ['event_id', 'subscription_id'], {
        unique: true,
      }),
      index('idx_event_deliveries_pending', [
        'subscriber_kind',
        'subscriber_ref',
        'state',
        'next_attempt_at',
        'created_at',
      ]),
      index('idx_event_deliveries_due', [
        'subscriber_kind',
        'state',
        'next_attempt_at',
        'claim_expires_at',
      ]),
    ],
    retention: retention.operational,
  })

  const eventObserverRunsDefinition = owner.table({
    id: 'event_observer_runs',
    schemaSymbol: 'eventObserverRuns',
    columns: {
      id: c.id('id', { primary: true }),
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      generation: c.int('generation'),
      leaseEpoch: c.int('lease_epoch'),
      wakeEpoch: c.int('wake_epoch'),
      cursorBeforeJson: c.jsonText('cursor_before_json', { nullable: true }),
      cursorAfterJson: c.jsonText('cursor_after_json', { nullable: true }),
      state: c.enum('state', ['running', 'completed', 'failed', 'obsolete']),
      observationCount: c.int('observation_count', { default: 0 }),
      startedAt: c.epochMs('started_at'),
      finishedAt: c.epochMs('finished_at', { nullable: true }),
      errorCode: c.text('error_code', { nullable: true }),
      errorDetail: c.text('error_detail', { nullable: true }),
    },
    indexes: [
      index('idx_event_observer_runs_source', ['source_id', 'source_revision', 'started_at']),
    ],
    retention: retention.operational,
  })

  const eventRecordsDefinition = owner.table({
    id: 'event_records',
    schemaSymbol: 'eventRecords',
    columns: {
      id: c.id('id', { primary: true }),
      eventTypeId: c.id('event_type_id'),
      eventTypeRevision: c.int('event_type_revision'),
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      subjectType: c.text('subject_type'),
      subjectRef: c.id('subject_ref'),
      occurredAt: c.epochMs('occurred_at'),
      observedAt: c.epochMs('observed_at'),
      dedupeKey: c.id('dedupe_key'),
      summaryJson: c.jsonText('summary_json'),
      payloadArtifactRef: c.id('payload_artifact_ref', { nullable: true }),
    },
    indexes: [
      index('event_records_source_dedupe_unique', ['source_id', 'source_revision', 'dedupe_key'], {
        unique: true,
      }),
      index('idx_event_records_subject', ['subject_type', 'subject_ref', 'occurred_at']),
      index('idx_event_records_audit', ['observed_at', 'id']),
      index('idx_event_records_source_audit', ['source_id', 'observed_at', 'id']),
    ],
    retention: retention.operational,
  })

  const eventResponseRulesDefinition = owner.table({
    id: 'event_response_rules',
    schemaSymbol: 'eventResponseRules',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      ownerUserId: c.id('owner_user_id'),
      enabled: c.bool('enabled', { default: true }),
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      eventTypeId: c.id('event_type_id'),
      eventTypeRevision: c.int('event_type_revision'),
      subjectType: c.text('subject_type'),
      subjectMatch: c.enum('subject_match', ['all', 'exact', 'prefix'], { default: 'all' }),
      subjectPattern: c.text('subject_pattern', { nullable: true }),
      targetJson: c.jsonText('target_json'),
      lastFiredAt: c.epochMs('last_fired_at', { nullable: true }),
      lastStatus: c.enum('last_status', ['launched', 'failed'], { nullable: true }),
      lastError: c.text('last_error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    indexes: [
      index('idx_event_response_rules_event', [
        'enabled',
        'source_id',
        'source_revision',
        'event_type_id',
        'event_type_revision',
      ]),
      index('idx_event_response_rules_owner', ['owner_user_id', 'updated_at']),
    ],
    retention: retention.operational,
  })

  const eventSourcesDefinition = owner.table({
    id: 'event_sources',
    schemaSymbol: 'eventSources',
    columns: {
      sourceId: c.id('source_id'),
      revision: c.int('revision'),
      descriptorJson: c.jsonText('descriptor_json'),
      descriptorDigest: c.id('descriptor_digest'),
      state: c.enum('state', ['published', 'retired'], { default: 'published' }),
      registeredAt: c.epochMs('registered_at'),
    },
    primaryKey: ['source_id', 'revision'],
    retention: retention.operational,
  })

  const eventSubscriptionsDefinition = owner.table({
    id: 'event_subscriptions',
    schemaSymbol: 'eventSubscriptions',
    columns: {
      id: c.id('id', { primary: true }),
      eventTypeId: c.id('event_type_id'),
      eventTypeRevision: c.int('event_type_revision'),
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      subjectType: c.text('subject_type'),
      subjectRef: c.id('subject_ref'),
      subscriberKind: c.text('subscriber_kind'),
      subscriberRef: c.id('subscriber_ref'),
      mode: c.enum('mode', ['exact', 'filtered'], { default: 'exact' }),
      originKind: c.text('origin_kind', { nullable: true }),
      originRef: c.id('origin_ref', { nullable: true }),
      definitionRevision: c.text('definition_revision', { nullable: true }),
      displayNameJson: c.jsonText('display_name_json', { nullable: true }),
      selectorKind: c.text('selector_kind', { nullable: true }),
      selectorJson: c.jsonText('selector_json', { nullable: true }),
      activeIdentityKey: c.id('active_identity_key', { nullable: true }),
      state: c.enum('state', ['active', 'cancelled'], { default: 'active' }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      cancelledAt: c.epochMs('cancelled_at', { nullable: true }),
    },
    indexes: [
      index('event_subscriptions_active_identity_unique', ['active_identity_key'], {
        unique: true,
        where: raw(
          '"event_subscriptions"."active_identity_key" IS NOT NULL',
          '"active_identity_key" IS NOT NULL',
        ),
      }),
      index('idx_event_subscriptions_fanout', [
        'event_type_id',
        'event_type_revision',
        'subject_type',
        'subject_ref',
        'state',
      ]),
      index('idx_event_subscriptions_subscriber', ['subscriber_kind', 'subscriber_ref', 'state']),
      index('idx_event_subscriptions_mode', ['mode', 'state', 'updated_at']),
      index('idx_event_subscriptions_audit', ['mode', 'updated_at', 'id']),
    ],
    retention: retention.operational,
  })

  const eventTypeCatalogDefinition = owner.table({
    id: 'event_type_catalog',
    schemaSymbol: 'eventTypeCatalog',
    columns: {
      eventTypeId: c.id('event_type_id'),
      revision: c.int('revision'),
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      descriptorJson: c.jsonText('descriptor_json'),
      descriptorDigest: c.id('descriptor_digest'),
      catalogVisibility: c.enum('catalog_visibility', ['public', 'internal', 'compatibility'], {
        default: 'public',
      }),
      state: c.enum('state', ['published', 'retired'], { default: 'published' }),
      registeredAt: c.epochMs('registered_at'),
    },
    primaryKey: ['event_type_id', 'revision'],
    indexes: [
      index('idx_event_type_source', ['source_id', 'source_revision', 'state']),
      index('idx_event_type_catalog_visibility', [
        'catalog_visibility',
        'event_type_id',
        'revision',
      ]),
    ],
    retention: retention.operational,
  })

  const observerActivationsDefinition = owner.table({
    id: 'observer_activations',
    schemaSymbol: 'observerActivations',
    columns: {
      sourceId: c.id('source_id'),
      sourceRevision: c.int('source_revision'),
      subscriberCount: c.int('subscriber_count', { default: 0 }),
      state: c.enum('state', ['idle', 'active', 'draining', 'blocked'], { default: 'idle' }),
      generation: c.int('generation', { default: 0 }),
      wakeEpoch: c.int('wake_epoch', { default: 0 }),
      cursorJson: c.jsonText('cursor_json', { nullable: true }),
      leaseOwner: c.text('lease_owner', { nullable: true }),
      leaseEpoch: c.int('lease_epoch', { default: 0 }),
      leaseExpiresAt: c.epochMs('lease_expires_at', { nullable: true }),
      nextScanAt: c.epochMs('next_scan_at', { nullable: true }),
      lastScanAt: c.epochMs('last_scan_at', { nullable: true }),
      lastSuccessAt: c.epochMs('last_success_at', { nullable: true }),
      lastErrorCode: c.text('last_error_code', { nullable: true }),
      updatedAt: c.epochMs('updated_at'),
    },
    primaryKey: ['source_id', 'source_revision'],
    indexes: [index('idx_observer_activations_due', ['state', 'next_scan_at', 'lease_expires_at'])],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    customEventSourceDefinitionsDefinition,
    customEventSourceRevisionsDefinition,
    eventAutomationWorkIntentsDefinition,
    eventDeliveriesDefinition,
    eventObserverRunsDefinition,
    eventRecordsDefinition,
    eventResponseRulesDefinition,
    eventSourcesDefinition,
    eventSubscriptionsDefinition,
    eventTypeCatalogDefinition,
    observerActivationsDefinition,
  ])

  return { schemaContribution }
})()

const frozen5 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('identity-access')

  const authLoginPolicyDefinition = owner.table({
    id: 'auth_login_policy',
    schemaSymbol: 'authLoginPolicy',
    columns: {
      id: c.id('id', { primary: true }),
      passwordLoginEnabled: c.bool('password_login_enabled', { default: true }),
      oidcDefaultRole: c.enum('oidc_default_role', ['guest', 'user'], { default: 'guest' }),
      bootstrapCompletedAt: c.epochMs('bootstrap_completed_at', { nullable: true }),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'auth_login_policy_oidc_default_role_enum',
        expression: raw(
          '"auth_login_policy"."oidc_default_role" IN (\'guest\', \'user\')',
          "\"oidc_default_role\" IN ('guest', 'user')",
        ),
      },
      {
        name: 'auth_login_policy_id_fixed',
        expression: raw('"auth_login_policy"."id" = \'global\'', '"id" = \'global\''),
      },
    ],
    retention: retention.business,
  })

  const externalIdentitiesDefinition = owner.table({
    id: 'external_identities',
    schemaSymbol: 'externalIdentities',
    columns: {
      id: c.id('id', { primary: true }),
      issuer: c.text('issuer'),
      subject: c.text('subject'),
      userId: c.id('user_id'),
      linkedAt: c.epochMs('linked_at'),
    },
    foreignKeys: [
      foreignKey('external_identities_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [
      index('idx_external_identities_user', ['user_id']),
      index('external_identities_issuer_subject_unique', ['issuer', 'subject'], { unique: true }),
    ],
    retention: retention.business,
  })

  const oidcProvidersDefinition = owner.table({
    id: 'oidc_providers',
    schemaSymbol: 'oidcProviders',
    columns: {
      id: c.id('id', { primary: true }),
      slug: c.text('slug', { unique: 'oidc_providers_slug_unique' }),
      displayName: c.text('display_name'),
      issuerUrl: c.text('issuer_url'),
      clientId: c.id('client_id'),
      clientSecretEnc: c.text('client_secret_enc'),
      scopes: c.text('scopes', { default: 'openid profile email' }),
      provisioning: c.enum('provisioning', ['auto', 'allowlist', 'invite'], { default: 'invite' }),
      allowedEmailDomainsJson: c.jsonText('allowed_email_domains_json', { default: '[]' }),
      iconUrl: c.text('icon_url', { nullable: true }),
      enabled: c.bool('enabled', { default: true }),
      authorizationEndpoint: c.text('authorization_endpoint', { nullable: true }),
      tokenEndpoint: c.text('token_endpoint', { nullable: true }),
      userinfoEndpoint: c.text('userinfo_endpoint', { nullable: true }),
      userinfoRequestStyle: c.enum('userinfo_request_style', ['get_bearer', 'post_json'], {
        default: 'get_bearer',
      }),
      jwksUri: c.text('jwks_uri', { nullable: true }),
      trustEmailVerified: c.bool('trust_email_verified', { default: false }),
      usernameClaim: c.text('username_claim', { nullable: true }),
      gitNameClaim: c.text('git_name_claim', { nullable: true }),
      emailClaim: c.text('email_claim', { nullable: true }),
      subjectClaim: c.text('subject_claim', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      schemaVersion: c.int('schema_version', { default: 1 }),
    },
    indexes: [index('idx_oidc_providers_enabled', ['enabled'])],
    retention: retention.business,
  })

  const resourceGrantsDefinition = owner.table({
    id: 'resource_grants',
    schemaSymbol: 'resourceGrants',
    columns: {
      resourceType: c.enum('resource_type', [
        'agent',
        'skill',
        'mcp',
        'plugin',
        'workflow',
        'workgroup',
        'capability_template',
        'action_template',
        'verification_profile',
        'digital_employee',
        'automation_policy',
        'development_adapter',
        'employee_definition',
        'employee_tool',
        'employee_job_template',
        'scheduled_task',
      ]),
      resourceId: c.id('resource_id'),
      userId: c.id('user_id'),
      addedBy: c.text('added_by'),
      addedAt: c.epochMs('added_at'),
      level: c.enum('level', ['read', 'write'], { default: 'read' }),
    },
    primaryKey: ['resource_type', 'resource_id', 'user_id'],
    foreignKeys: [
      foreignKey('resource_grants_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    checks: [
      {
        name: 'resource_grants_level_enum',
        expression: raw(
          '"resource_grants"."level" IN (\'read\', \'write\')',
          "\"level\" IN ('read', 'write')",
        ),
      },
    ],
    indexes: [index('idx_resource_grants_user', ['user_id'])],
    retention: retention.business,
  })

  const tokenAuditDefinition = owner.table({
    id: 'token_audit',
    schemaSymbol: 'tokenAudit',
    columns: {
      id: c.id('id', { primary: true }),
      patId: c.id('pat_id'),
      userId: c.id('user_id'),
      channel: c.text('channel'),
      toolName: c.text('tool_name', { nullable: true }),
      method: c.text('method', { nullable: true }),
      path: c.text('path', { nullable: true }),
      resourceKind: c.text('resource_kind', { nullable: true }),
      resourceId: c.id('resource_id', { nullable: true }),
      statusCode: c.int('status_code'),
      snapshotFailed: c.bool('snapshot_failed', { default: false }),
      createdAt: c.epochMs('created_at'),
    },
    indexes: [
      index('idx_token_audit_user_created', ['user_id', 'created_at']),
      index('idx_token_audit_pat_created', ['pat_id', 'created_at']),
      index('idx_token_audit_created', ['created_at']),
    ],
    retention: retention.operational,
  })

  const tokenDeleteSnapshotDefinition = owner.table({
    id: 'token_delete_snapshot',
    schemaSymbol: 'tokenDeleteSnapshot',
    columns: {
      id: c.id('id', { primary: true }),
      auditId: c.id('audit_id'),
      resourceKind: c.text('resource_kind'),
      resourceId: c.id('resource_id'),
      snapshotJson: c.jsonText('snapshot_json'),
      createdAt: c.epochMs('created_at'),
    },
    indexes: [
      index('idx_token_delete_snapshot_audit', ['audit_id']),
      index('idx_token_delete_snapshot_created', ['created_at']),
    ],
    retention: retention.business,
  })

  const userAccessAuditDefinition = owner.table({
    id: 'user_access_audit',
    schemaSymbol: 'userAccessAudit',
    columns: {
      id: c.id('id', { primary: true }),
      targetUserId: c.id('target_user_id'),
      actorUserId: c.id('actor_user_id', { nullable: true }),
      actorKind: c.enum('actor_kind', ['session', 'cli', 'system']),
      operationId: c.id('operation_id'),
      correlationId: c.id('correlation_id', { nullable: true }),
      beforeRole: c.enum('before_role', ['admin', 'user', 'manager', 'guest']),
      afterRole: c.enum('after_role', ['admin', 'user', 'manager', 'guest']),
      addedPermissionsJson: c.jsonText('added_permissions_json'),
      removedPermissionsJson: c.jsonText('removed_permissions_json'),
      accessRevision: c.int('access_revision'),
      createdAt: c.epochMs('created_at'),
    },
    indexes: [
      index('idx_user_access_audit_target_revision', ['target_user_id', 'access_revision']),
      index('idx_user_access_audit_created', ['created_at']),
      index('idx_user_access_audit_operation', ['operation_id']),
    ],
    retention: retention.operational,
  })

  const userIdentitiesDefinition = owner.table({
    id: 'user_identities',
    schemaSymbol: 'userIdentities',
    columns: {
      id: c.id('id', { primary: true }),
      userId: c.id('user_id'),
      providerId: c.id('provider_id'),
      subject: c.text('subject'),
      email: c.text('email', { nullable: true }),
      emailVerified: c.int('email_verified', { default: 0 }),
      preferredSnapshot: c.text('preferred_snapshot', { nullable: true }),
      linkedAt: c.epochMs('linked_at'),
    },
    foreignKeys: [
      foreignKey('user_identities_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
      foreignKey(
        'user_identities_provider_id_oidc_providers_id_fk',
        ['provider_id'],
        'oidc_providers',
        ['id'],
        { onDelete: 'restrict' },
      ),
    ],
    indexes: [
      index('idx_user_identities_user', ['user_id']),
      index('idx_user_identities_provider', ['provider_id']),
      index('user_identities_provider_subject_unique', ['provider_id', 'subject'], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

  const userPatsDefinition = owner.table({
    id: 'user_pats',
    schemaSymbol: 'userPats',
    columns: {
      id: c.id('id', { primary: true }),
      userId: c.id('user_id'),
      name: c.text('name'),
      tokenHash: c.text('token_hash', { unique: 'user_pats_token_hash_unique' }),
      scopesJson: c.jsonText('scopes_json', { default: '[]' }),
      createdAt: c.epochMs('created_at'),
      lastUsedAt: c.epochMs('last_used_at', { nullable: true }),
      expiresAt: c.epochMs('expires_at', { nullable: true }),
      revokedAt: c.epochMs('revoked_at', { nullable: true }),
      purpose: c.text('purpose', { default: 'general' }),
    },
    foreignKeys: [
      foreignKey('user_pats_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [index('idx_user_pats_user', ['user_id'])],
    retention: retention.business,
  })

  const userPermissionGrantsDefinition = owner.table({
    id: 'user_permission_grants',
    schemaSymbol: 'userPermissionGrants',
    columns: {
      userId: c.id('user_id'),
      permission: c.id('permission'),
      grantedByUserId: c.id('granted_by_user_id', { nullable: true }),
      grantedAt: c.epochMs('granted_at'),
    },
    primaryKey: ['user_id', 'permission'],
    foreignKeys: [
      foreignKey('user_permission_grants_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [index('idx_user_permission_grants_permission', ['permission'])],
    retention: retention.business,
  })

  const userRepositoryTransportCredentialsDefinition = owner.table({
    id: 'user_repository_transport_credentials',
    schemaSymbol: 'userRepositoryTransportCredentials',
    columns: {
      userId: c.id('user_id'),
      provider: c.enum('provider', ['gitlab', 'github']),
      connectionGeneration: c.text('connection_generation'),
      endpointBindingDigest: c.id('endpoint_binding_digest'),
      tokenEnc: c.text('token_enc'),
      tokenHint: c.text('token_hint'),
      credentialRevision: c.int('credential_revision'),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    primaryKey: ['user_id', 'provider'],
    foreignKeys: [
      foreignKey(
        'user_repository_transport_credentials_user_id_users_id_fk',
        ['user_id'],
        'users',
        ['id'],
        { onDelete: 'cascade' },
      ),
      foreignKey(
        'user_repository_transport_credentials_connection_fk',
        ['provider', 'connection_generation'],
        'repository_transport_connections',
        ['provider', 'connection_generation'],
        { onDelete: 'cascade', onUpdate: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'user_repository_transport_credentials_provider_enum',
        expression: raw(
          '"user_repository_transport_credentials"."provider" IN (\'gitlab\', \'github\')',
          "\"provider\" IN ('gitlab', 'github')",
        ),
      },
      {
        name: 'user_repository_transport_credentials_connection_generation_length',
        expression: raw(
          'length("user_repository_transport_credentials"."connection_generation") BETWEEN 1 AND 128',
          'length("connection_generation") BETWEEN 1 AND 128',
        ),
      },
      {
        name: 'user_repository_transport_credentials_endpoint_binding_digest_length',
        expression: raw(
          'length("user_repository_transport_credentials"."endpoint_binding_digest") = 64 AND "user_repository_transport_credentials"."endpoint_binding_digest" NOT GLOB \'*[^0-9a-f]*\'',
          'length("endpoint_binding_digest") = 64 AND "endpoint_binding_digest" !~ \'[^0-9a-f]\'',
        ),
      },
      {
        name: 'user_repository_transport_credentials_token_hint_length',
        expression: raw(
          'length("user_repository_transport_credentials"."token_hint") = 4',
          'length("token_hint") = 4',
        ),
      },
      {
        name: 'user_repository_transport_credentials_credential_revision_positive',
        expression: raw(
          '"user_repository_transport_credentials"."credential_revision" > 0',
          '"credential_revision" > 0',
        ),
      },
    ],
    indexes: [
      index('idx_user_repository_transport_credentials_provider_generation', [
        'provider',
        'connection_generation',
      ]),
    ],
    retention: retention.business,
  })

  const userSessionsDefinition = owner.table({
    id: 'user_sessions',
    schemaSymbol: 'userSessions',
    columns: {
      id: c.id('id', { primary: true }),
      userId: c.id('user_id'),
      tokenHash: c.text('token_hash', { unique: 'user_sessions_token_hash_unique' }),
      userAgent: c.text('user_agent', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      lastUsedAt: c.epochMs('last_used_at'),
      expiresAt: c.epochMs('expires_at'),
      revokedAt: c.epochMs('revoked_at', { nullable: true }),
    },
    foreignKeys: [
      foreignKey('user_sessions_user_id_users_id_fk', ['user_id'], 'users', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [index('idx_user_sessions_user', ['user_id', 'expires_at'])],
    retention: retention.business,
  })

  const usersDefinition = owner.table({
    id: 'users',
    schemaSymbol: 'users',
    columns: {
      id: c.id('id', { primary: true }),
      username: c.text('username', { unique: 'users_username_unique' }),
      email: c.text('email', { nullable: true, unique: 'users_email_unique' }),
      displayName: c.text('display_name'),
      gitName: c.text('git_name', { default: '' }),
      passwordHash: c.text('password_hash', { nullable: true }),
      role: c.enum('role', ['admin', 'user', 'manager', 'guest'], { default: 'user' }),
      status: c.enum('status', ['active', 'disabled', 'invited'], { default: 'active' }),
      forcePasswordChange: c.bool('force_password_change', { default: false }),
      createdBy: c.text('created_by', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      lastLoginAt: c.epochMs('last_login_at', { nullable: true }),
      schemaVersion: c.int('schema_version', { default: 1 }),
      accessRevision: c.int('access_revision', { default: 0 }),
    },
    indexes: [index('idx_users_status', ['status'])],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    authLoginPolicyDefinition,
    externalIdentitiesDefinition,
    oidcProvidersDefinition,
    resourceGrantsDefinition,
    tokenAuditDefinition,
    tokenDeleteSnapshotDefinition,
    userAccessAuditDefinition,
    userIdentitiesDefinition,
    userPatsDefinition,
    userPermissionGrantsDefinition,
    userRepositoryTransportCredentialsDefinition,
    userSessionsDefinition,
    usersDefinition,
  ])

  return { schemaContribution }
})()

const frozen6 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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

  const csWebhookVerificationsDefinition = owner.table({
    id: 'cs_webhook_verifications',
    schemaSymbol: 'csWebhookVerifications',
    columns: {
      deliveryId: c.id('delivery_id', { primary: true }),
      transportReceiptRef: c.id('transport_receipt_ref'),
    },
    retention: retention.business,
  })

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
        expression: raw(
          '"webhook_mr_control_effects"."attempt_count" >= 0',
          '"attempt_count" >= 0',
        ),
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
      index('idx_webhook_mr_guard_stream_revision', [
        'endpoint_id',
        'stream_key',
        'launch_revision',
      ]),
      index('idx_webhook_mr_guard_task', ['task_id']),
      index('idx_webhook_mr_guard_status', ['status', 'updated_at']),
    ],
    retention: retention.business,
  })

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

  const schemaContribution = owner.contribution([
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

  return { schemaContribution }
})()

const frozen7 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('intent')

  const intentApplyJournalDefinition = owner.table({
    id: 'intent_apply_journal',
    schemaSymbol: 'intentApplyJournal',
    columns: {
      id: c.id('id', { primary: true }),
      sessionId: c.id('session_id'),
      clientMutationId: c.id('client_mutation_id'),
      draftId: c.id('draft_id'),
      draftHash: c.text('draft_hash'),
      state: c.enum('state', ['prepared', 'applying', 'committed', 'failed'], {
        default: 'prepared',
      }),
      preparedArtifactsJson: c.jsonText('prepared_artifacts_json', { default: '[]' }),
      receiptJson: c.jsonText('receipt_json', { nullable: true }),
      error: c.text('error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    foreignKeys: [
      foreignKey(
        'intent_apply_journal_session_id_intent_sessions_id_fk',
        ['session_id'],
        'intent_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('uniq_intent_apply_journal_mutation', ['session_id', 'client_mutation_id'], {
        unique: true,
      }),
      index('idx_intent_apply_journal_session', ['session_id']),
      index('idx_intent_apply_journal_state', ['state']),
    ],
    retention: retention.operational,
  })

  const intentDraftResolutionsDefinition = owner.table({
    id: 'intent_draft_resolutions',
    schemaSymbol: 'intentDraftResolutions',
    columns: {
      draftId: c.id('draft_id', { primary: true }),
      sessionId: c.id('session_id'),
      reason: c.enum('reason', ['superseded', 'discarded']),
      createdAt: c.epochMs('created_at'),
    },
    foreignKeys: [
      foreignKey(
        'intent_draft_resolutions_draft_id_intent_drafts_id_fk',
        ['draft_id'],
        'intent_drafts',
        ['id'],
        { onDelete: 'cascade' },
      ),
      foreignKey(
        'intent_draft_resolutions_session_id_intent_sessions_id_fk',
        ['session_id'],
        'intent_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'intent_draft_resolutions_reason_enum',
        expression: raw(
          '"intent_draft_resolutions"."reason" IN (\'superseded\',\'discarded\')',
          "\"reason\" IN ('superseded','discarded')",
        ),
      },
    ],
    indexes: [index('idx_intent_draft_resolutions_session', ['session_id', 'created_at'])],
    retention: retention.business,
  })

  const intentDraftsDefinition = owner.table({
    id: 'intent_drafts',
    schemaSymbol: 'intentDrafts',
    columns: {
      id: c.id('id', { primary: true }),
      sessionId: c.id('session_id'),
      revision: c.int('revision'),
      changesetJson: c.jsonText('changeset_json'),
      validationJson: c.jsonText('validation_json', { default: '[]' }),
      draftHash: c.text('draft_hash'),
      producedByTurnId: c.id('produced_by_turn_id', { nullable: true }),
      contextRevision: c.int('context_revision', { default: 0 }),
      createdAt: c.epochMs('created_at'),
    },
    foreignKeys: [
      foreignKey(
        'intent_drafts_session_id_intent_sessions_id_fk',
        ['session_id'],
        'intent_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('uniq_intent_drafts_session_revision', ['session_id', 'revision'], { unique: true }),
      index('idx_intent_drafts_session', ['session_id']),
    ],
    retention: retention.business,
  })

  const intentProvenanceDefinition = owner.table({
    id: 'intent_provenance',
    schemaSymbol: 'intentProvenance',
    columns: {
      resourceType: c.enum('resource_type', [
        'agent',
        'skill',
        'mcp',
        'plugin',
        'workflow',
        'workgroup',
      ]),
      resourceId: c.id('resource_id'),
      commitId: c.id('commit_id'),
      sessionId: c.id('session_id'),
      createdAt: c.epochMs('created_at'),
    },
    primaryKey: ['resource_type', 'resource_id', 'commit_id'],
    indexes: [
      index('idx_intent_provenance_resource', ['resource_type', 'resource_id']),
      index('idx_intent_provenance_session', ['session_id']),
    ],
    retention: retention.business,
  })

  const intentSessionsDefinition = owner.table({
    id: 'intent_sessions',
    schemaSymbol: 'intentSessions',
    columns: {
      id: c.id('id', { primary: true }),
      ownerUserId: c.id('owner_user_id'),
      title: c.text('title', { default: '' }),
      status: c.enum('status', ['active', 'archived'], { default: 'active' }),
      contextRevision: c.int('context_revision', { default: 0 }),
      contextManifestJson: c.jsonText('context_manifest_json', { default: '[]' }),
      handleWatermarkJson: c.jsonText('handle_watermark_json', { default: '{}' }),
      currentDraftId: c.id('current_draft_id', { nullable: true }),
      inFlightTurnId: c.id('in_flight_turn_id', { nullable: true }),
      turnSeq: c.int('turn_seq', { default: 0 }),
      commitSeq: c.int('commit_seq', { default: 0 }),
      budgetJson: c.jsonText('budget_json', { default: '{}' }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    indexes: [
      index('idx_intent_sessions_owner', ['owner_user_id']),
      index('idx_intent_sessions_owner_status', ['owner_user_id', 'status']),
    ],
    retention: retention.business,
  })

  const intentTurnEventsDefinition = owner.table({
    id: 'intent_turn_events',
    schemaSymbol: 'intentTurnEvents',
    columns: {
      id: c.identity('id', { primary: true }),
      turnId: c.id('turn_id'),
      eventSeq: c.int('event_seq'),
      ts: c.int('ts'),
      kind: c.text('kind'),
      payload: c.text('payload'),
      sessionId: c.id('session_id', { nullable: true }),
      parentSessionId: c.id('parent_session_id', { nullable: true }),
      source: c.enum('source', ['stream', 'live-child', 'post-run-child']),
      externalEventId: c.id('external_event_id', { nullable: true }),
    },
    foreignKeys: [
      foreignKey(
        'intent_turn_events_turn_id_intent_turns_id_fk',
        ['turn_id'],
        'intent_turns',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('uniq_intent_turn_events_turn_seq', ['turn_id', 'event_seq'], { unique: true }),
      index('uniq_intent_turn_events_external', ['turn_id', 'source', 'external_event_id'], {
        unique: true,
      }),
      index('idx_intent_turn_events_turn', ['turn_id', 'event_seq']),
    ],
    retention: retention.operational,
  })

  const intentTurnsDefinition = owner.table({
    id: 'intent_turns',
    schemaSymbol: 'intentTurns',
    columns: {
      id: c.id('id', { primary: true }),
      sessionId: c.id('session_id'),
      seq: c.int('seq'),
      role: c.enum('role', ['user', 'agent']),
      kind: c.enum('kind', [
        'message',
        'answers',
        'mount-approval',
        'running',
        'questions',
        'changeset',
        'error',
      ]),
      contentJson: c.jsonText('content_json', { default: '{}' }),
      contextRevision: c.int('context_revision', { default: 0 }),
      envelopeNonce: c.text('envelope_nonce', { nullable: true }),
      runMetaJson: c.jsonText('run_meta_json', { nullable: true }),
      clientMutationId: c.id('client_mutation_id', { nullable: true }),
      captureState: c.enum('capture_state', ['live', 'complete', 'truncated', 'incomplete'], {
        nullable: true,
      }),
      captureLastEventSeq: c.int('capture_last_event_seq', { default: 0 }),
      captureEventBytes: c.int('capture_event_bytes', { default: 0 }),
      captureRootSessionId: c.id('capture_root_session_id', { nullable: true }),
      captureIncompleteReason: c.enum(
        'capture_incomplete_reason',
        [
          'stream-persist-failed',
          'stream-frame-limit-exceeded',
          'child-capture-failed',
          'post-exit-flush-timeout',
        ],
        { nullable: true },
      ),
      scratchRetained: c.bool('scratch_retained', { default: false }),
      createdAt: c.epochMs('created_at'),
    },
    foreignKeys: [
      foreignKey(
        'intent_turns_session_id_intent_sessions_id_fk',
        ['session_id'],
        'intent_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('uniq_intent_turns_session_seq', ['session_id', 'seq'], { unique: true }),
      index('uniq_intent_turns_session_mutation', ['session_id', 'client_mutation_id'], {
        unique: true,
        where: raw(
          '"intent_turns"."client_mutation_id" IS NOT NULL',
          '"client_mutation_id" IS NOT NULL',
        ),
      }),
      index('idx_intent_turns_session', ['session_id']),
    ],
    retention: retention.business,
  })

  const intentWorkingSetChangesDefinition = owner.table({
    id: 'intent_working_set_changes',
    schemaSymbol: 'intentWorkingSetChanges',
    columns: {
      id: c.id('id', { primary: true }),
      sessionId: c.id('session_id'),
      clientMutationId: c.id('client_mutation_id'),
      requestHash: c.text('request_hash'),
      expectedTurnSeq: c.int('expected_turn_seq'),
      expectedContextRevision: c.int('expected_context_revision'),
      mode: c.enum('mode', ['after-current', 'interrupt']),
      deltaJson: c.jsonText('delta_json'),
      state: c.enum('state', ['queued', 'applying', 'applied', 'failed', 'canceled']),
      error: c.text('error', { nullable: true }),
      resultingContextRevision: c.int('resulting_context_revision', { nullable: true }),
      resultingTurnId: c.id('resulting_turn_id', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    foreignKeys: [
      foreignKey(
        'intent_working_set_changes_session_id_intent_sessions_id_fk',
        ['session_id'],
        'intent_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'intent_working_set_changes_mode_enum',
        expression: raw(
          '"intent_working_set_changes"."mode" IN (\'after-current\',\'interrupt\')',
          "\"mode\" IN ('after-current','interrupt')",
        ),
      },
      {
        name: 'intent_working_set_changes_state_enum',
        expression: raw(
          "\"intent_working_set_changes\".\"state\" IN ('queued','applying','applied','failed','canceled')",
          "\"state\" IN ('queued','applying','applied','failed','canceled')",
        ),
      },
    ],
    indexes: [
      index('uniq_intent_working_set_mutation', ['session_id', 'client_mutation_id'], {
        unique: true,
      }),
      index('uniq_intent_working_set_unresolved', ['session_id'], {
        unique: true,
        where: raw(
          "\"intent_working_set_changes\".\"state\" IN ('queued', 'applying', 'failed')",
          "\"state\" IN ('queued', 'applying', 'failed')",
        ),
      }),
      index('idx_intent_working_set_session', ['session_id', 'created_at']),
      index('idx_intent_working_set_state', ['state', 'updated_at']),
    ],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    intentApplyJournalDefinition,
    intentDraftResolutionsDefinition,
    intentDraftsDefinition,
    intentProvenanceDefinition,
    intentSessionsDefinition,
    intentTurnEventsDefinition,
    intentTurnsDefinition,
    intentWorkingSetChangesDefinition,
  ])

  return { schemaContribution }
})()

const frozen8 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('knowledge-evolution')

  const fusionsDefinition = owner.table({
    id: 'fusions',
    schemaSymbol: 'fusions',
    columns: {
      id: c.id('id', { primary: true }),
      skillId: c.id('skill_id'),
      skillName: c.text('skill_name'),
      baseSkillVersion: c.int('base_skill_version'),
      preconditionToken: c.text('precondition_token', { nullable: true }),
      memoryIdsJson: c.jsonText('memory_ids_json'),
      intent: c.text('intent', { default: '' }),
      status: c.enum(
        'status',
        ['running', 'awaiting_approval', 'applying', 'done', 'rejected', 'canceled', 'failed'],
        { default: 'running' },
      ),
      iteration: c.int('iteration', { default: 1 }),
      currentTaskId: c.id('current_task_id', { nullable: true }),
      proposedWorktreePath: c.text('proposed_worktree_path', { nullable: true }),
      proposedDiff: c.text('proposed_diff', { nullable: true }),
      incorporatedMemoryIdsJson: c.jsonText('incorporated_memory_ids_json', { nullable: true }),
      skippedJson: c.jsonText('skipped_json', { nullable: true }),
      changelog: c.text('changelog', { nullable: true }),
      appliedSkillVersion: c.int('applied_skill_version', { nullable: true }),
      ownerUserId: c.id('owner_user_id'),
      createdAt: c.epochMs('created_at'),
      decidedByUserId: c.id('decided_by_user_id', { nullable: true }),
      decidedAt: c.epochMs('decided_at', { nullable: true }),
      decisionReason: c.text('decision_reason', { nullable: true }),
      error: c.text('error', { nullable: true }),
    },
    checks: [
      {
        name: 'fusions_status_enum',
        expression: raw(
          "\"fusions\".\"status\" IN ('running','awaiting_approval','applying','done','rejected','canceled','failed')",
          "\"status\" IN ('running','awaiting_approval','applying','done','rejected','canceled','failed')",
        ),
      },
    ],
    indexes: [index('idx_fusions_skill', ['skill_id']), index('idx_fusions_status', ['status'])],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([fusionsDefinition])

  return { schemaContribution }
})()

const frozen9 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('memory')

  const memoriesDefinition = owner.table({
    id: 'memories',
    schemaSymbol: 'memories',
    columns: {
      id: c.id('id', { primary: true }),
      scopeType: c.enum('scope_type', ['agent', 'workflow', 'repo', 'repo_group', 'global']),
      scopeId: c.id('scope_id', { nullable: true }),
      title: c.text('title'),
      bodyMd: c.text('body_md'),
      tags: c.text('tags', { default: '[]' }),
      status: c.enum('status', [
        'candidate',
        'approved',
        'archived',
        'superseded',
        'rejected',
        'fused',
      ]),
      sourceKind: c.enum('source_kind', [
        'clarify',
        'review',
        'feedback',
        'agent-run',
        'task-run',
        'manual',
      ]),
      sourceEventId: c.id('source_event_id', { nullable: true }),
      sourceTaskId: c.id('source_task_id', { nullable: true }),
      distillJobId: c.id('distill_job_id', { nullable: true }),
      distillAction: c.enum(
        'distill_action',
        ['new', 'update_of', 'duplicate_of', 'conflict_with'],
        {
          nullable: true,
        },
      ),
      supersedesId: c.id('supersedes_id', { nullable: true }),
      supersededById: c.id('superseded_by_id', { nullable: true }),
      approvedByUserId: c.id('approved_by_user_id', { nullable: true }),
      approvedAt: c.epochMs('approved_at', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      version: c.int('version', { default: 1 }),
      fusedIntoSkill: c.text('fused_into_skill', { nullable: true }),
      fusedIntoSkillId: c.id('fused_into_skill_id', { nullable: true }),
      fusedIntoSkillVersion: c.int('fused_into_skill_version', { nullable: true }),
      fusedAt: c.epochMs('fused_at', { nullable: true }),
      fusedByUserId: c.id('fused_by_user_id', { nullable: true }),
      fusedFusionId: c.id('fused_fusion_id', { nullable: true }),
    },
    checks: [
      {
        name: 'memories_scope_type_enum',
        expression: raw(
          "\"memories\".\"scope_type\" IN ('agent','workflow','repo','repo_group','global')",
          "\"scope_type\" IN ('agent','workflow','repo','repo_group','global')",
        ),
      },
      {
        name: 'memories_status_enum',
        expression: raw(
          "\"memories\".\"status\" IN ('candidate','approved','archived','superseded','rejected','fused')",
          "\"status\" IN ('candidate','approved','archived','superseded','rejected','fused')",
        ),
      },
      {
        name: 'memories_source_kind_enum',
        expression: raw(
          "\"memories\".\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run','manual')",
          "\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run','manual')",
        ),
      },
      {
        name: 'memories_distill_action_enum',
        expression: raw(
          '"memories"."distill_action" IS NULL OR "memories"."distill_action" IN (\'new\',\'update_of\',\'duplicate_of\',\'conflict_with\')',
          "\"distill_action\" IS NULL OR \"distill_action\" IN ('new','update_of','duplicate_of','conflict_with')",
        ),
      },
      {
        name: 'memories_scope_type_shape',
        expression: raw(
          '("memories"."scope_type" = \'global\' AND "memories"."scope_id" IS NULL) OR ("memories"."scope_type" != \'global\' AND "memories"."scope_id" IS NOT NULL)',
          '("scope_type" = \'global\' AND "scope_id" IS NULL) OR ("scope_type" != \'global\' AND "scope_id" IS NOT NULL)',
        ),
      },
      {
        name: 'memories_fused_into_skill_shape',
        expression: raw(
          '("memories"."status" = \'fused\') = ("memories"."fused_into_skill" IS NOT NULL)',
          '("status" = \'fused\') = ("fused_into_skill" IS NOT NULL)',
        ),
      },
      {
        name: 'memories_fused_into_skill_id_shape',
        expression: raw(
          '("memories"."status" = \'fused\') = ("memories"."fused_into_skill_id" IS NOT NULL)',
          '("status" = \'fused\') = ("fused_into_skill_id" IS NOT NULL)',
        ),
      },
    ],
    indexes: [
      index('idx_memories_scope_status', ['scope_type', 'scope_id', 'status']),
      index('idx_memories_status_created', ['status', 'created_at']),
      index('idx_memories_supersedes', ['supersedes_id']),
      index('idx_memories_created', ['created_at']),
      index('idx_memories_source', ['source_kind', 'source_event_id']),
      index('idx_memories_fused_skill_id', ['fused_into_skill_id', 'fused_into_skill_version']),
    ],
    retention: retention.business,
  })

  const memoryDistillEventsDefinition = owner.table({
    id: 'memory_distill_events',
    schemaSymbol: 'memoryDistillEvents',
    columns: {
      id: c.identity('id', { primary: true }),
      distillJobId: c.id('distill_job_id'),
      attemptIndex: c.int('attempt_index'),
      sessionId: c.id('session_id'),
      parentSessionId: c.id('parent_session_id', { nullable: true }),
      ts: c.int('ts'),
      kind: c.text('kind'),
      payload: c.text('payload'),
    },
    foreignKeys: [
      foreignKey(
        'memory_distill_events_distill_job_id_memory_distill_jobs_id_fk',
        ['distill_job_id'],
        'memory_distill_jobs',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('idx_distill_events_job_attempt', ['distill_job_id', 'attempt_index', 'ts']),
      index('idx_distill_events_session', ['distill_job_id', 'session_id', 'ts']),
    ],
    retention: retention.operational,
  })

  const memoryDistillJobsDefinition = owner.table({
    id: 'memory_distill_jobs',
    schemaSymbol: 'memoryDistillJobs',
    columns: {
      id: c.id('id', { primary: true }),
      debounceKey: c.id('debounce_key'),
      sourceKind: c.enum('source_kind', ['clarify', 'review', 'feedback', 'agent-run', 'task-run']),
      sourceEventId: c.id('source_event_id'),
      taskId: c.id('task_id', { nullable: true }),
      scopeResolvedJson: c.jsonText('scope_resolved_json'),
      status: c.enum('status', ['pending', 'running', 'done', 'failed', 'canceled']),
      attempts: c.int('attempts', { default: 0 }),
      nextRunAt: c.epochMs('next_run_at'),
      lastError: c.text('last_error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      startedAt: c.epochMs('started_at', { nullable: true }),
      finishedAt: c.epochMs('finished_at', { nullable: true }),
      opencodeSessionId: c.id('opencode_session_id', { nullable: true }),
      userPromptMd: c.text('user_prompt_md', { nullable: true }),
      exitCode: c.int('exit_code', { nullable: true }),
      stderrExcerpt: c.text('stderr_excerpt', { nullable: true }),
      dedupSnapshotIdsJson: c.jsonText('dedup_snapshot_ids_json', { nullable: true }),
      outputLang: c.text('output_lang', { nullable: true }),
    },
    checks: [
      {
        name: 'memory_distill_jobs_source_kind_enum',
        expression: raw(
          "\"memory_distill_jobs\".\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run')",
          "\"source_kind\" IN ('clarify','review','feedback','agent-run','task-run')",
        ),
      },
      {
        name: 'memory_distill_jobs_status_enum',
        expression: raw(
          "\"memory_distill_jobs\".\"status\" IN ('pending','running','done','failed','canceled')",
          "\"status\" IN ('pending','running','done','failed','canceled')",
        ),
      },
    ],
    indexes: [
      index('idx_distill_jobs_status_next', ['status', 'next_run_at']),
      index('idx_distill_jobs_debounce', ['debounce_key', 'status']),
      index('idx_distill_jobs_task', ['task_id', 'source_kind']),
    ],
    retention: retention.business,
  })

  const memoryScopeMoveEventsDefinition = owner.table({
    id: 'memory_scope_move_events',
    schemaSymbol: 'memoryScopeMoveEvents',
    columns: {
      id: c.id('id', { primary: true }),
      memoryId: c.id('memory_id'),
      actorUserId: c.id('actor_user_id'),
      actorSource: c.enum('actor_source', ['session', 'pat', 'daemon', 'cli', 'system']),
      fromScopeType: c.enum('from_scope_type', [
        'agent',
        'workflow',
        'repo',
        'repo_group',
        'global',
      ]),
      fromScopeId: c.id('from_scope_id', { nullable: true }),
      toScopeType: c.enum('to_scope_type', ['agent', 'workflow', 'repo', 'repo_group', 'global']),
      toScopeId: c.id('to_scope_id', { nullable: true }),
      expectedVersion: c.int('expected_version'),
      resultingVersion: c.int('resulting_version'),
      correlationId: c.id('correlation_id'),
      causationId: c.id('causation_id', { nullable: true }),
      occurredAt: c.epochMs('occurred_at'),
    },
    checks: [
      {
        name: 'memory_scope_move_events_actor_source',
        expression: raw(
          "\"memory_scope_move_events\".\"actor_source\" IN ('session','pat','daemon','cli','system')",
          "\"actor_source\" IN ('session','pat','daemon','cli','system')",
        ),
      },
      {
        name: 'memory_scope_move_events_from_scope',
        expression: raw(
          '("memory_scope_move_events"."from_scope_type" = \'global\' AND "memory_scope_move_events"."from_scope_id" IS NULL) OR ("memory_scope_move_events"."from_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "memory_scope_move_events"."from_scope_id" IS NOT NULL AND length("memory_scope_move_events"."from_scope_id") > 0)',
          '("from_scope_type" = \'global\' AND "from_scope_id" IS NULL) OR ("from_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "from_scope_id" IS NOT NULL AND length("from_scope_id") > 0)',
        ),
      },
      {
        name: 'memory_scope_move_events_to_scope',
        expression: raw(
          '("memory_scope_move_events"."to_scope_type" = \'global\' AND "memory_scope_move_events"."to_scope_id" IS NULL) OR ("memory_scope_move_events"."to_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "memory_scope_move_events"."to_scope_id" IS NOT NULL AND length("memory_scope_move_events"."to_scope_id") > 0)',
          '("to_scope_type" = \'global\' AND "to_scope_id" IS NULL) OR ("to_scope_type" IN (\'agent\',\'workflow\',\'repo\',\'repo_group\') AND "to_scope_id" IS NOT NULL AND length("to_scope_id") > 0)',
        ),
      },
      {
        name: 'memory_scope_move_events_not_noop',
        expression: raw(
          '"memory_scope_move_events"."from_scope_type" <> "memory_scope_move_events"."to_scope_type" OR "memory_scope_move_events"."from_scope_id" IS NOT "memory_scope_move_events"."to_scope_id"',
          '"from_scope_type" <> "to_scope_type" OR "from_scope_id" IS DISTINCT FROM "to_scope_id"',
        ),
      },
      {
        name: 'memory_scope_move_events_version_step',
        expression: raw(
          '"memory_scope_move_events"."expected_version" > 0 AND "memory_scope_move_events"."resulting_version" = "memory_scope_move_events"."expected_version" + 1',
          '"expected_version" > 0 AND "resulting_version" = "expected_version" + 1',
        ),
      },
      {
        name: 'memory_scope_move_events_time_nonnegative',
        expression: raw('"memory_scope_move_events"."occurred_at" >= 0', '"occurred_at" >= 0'),
      },
    ],
    indexes: [
      index('idx_memory_scope_move_events_memory_version', ['memory_id', 'resulting_version'], {
        unique: true,
      }),
      index('idx_memory_scope_move_events_occurred', ['occurred_at', 'memory_id']),
    ],
    retention: retention.operational,
  })

  const schemaContribution = owner.contribution([
    memoriesDefinition,
    memoryDistillEventsDefinition,
    memoryDistillJobsDefinition,
    memoryScopeMoveEventsDefinition,
  ])

  return { schemaContribution }
})()

const frozen10 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('platform/committed-events')

  const committedEventAggregateHeadsDefinition = owner.table({
    id: 'committed_event_aggregate_heads',
    schemaSymbol: 'committedEventAggregateHeads',
    columns: {
      producer: c.enum('producer', ['task-execution', 'collaboration']),
      family: c.enum('family', ['task-lifecycle', 'review', 'clarify', 'questions']),
      aggregateKind: c.enum('aggregate_kind', [
        'task',
        'review-round',
        'clarify-round',
        'question-gate',
      ]),
      aggregateId: c.id('aggregate_id'),
      lastSeq: c.int('last_seq'),
      updatedAt: c.epochMs('updated_at'),
    },
    primaryKey: ['producer', 'family', 'aggregate_kind', 'aggregate_id'],
    checks: [
      {
        name: 'committed_event_aggregate_heads_last_seq_positive',
        expression: raw('"committed_event_aggregate_heads"."last_seq" > 0', '"last_seq" > 0'),
      },
    ],
    retention: retention.operational,
  })

  const committedEventDeliveriesDefinition = owner.table({
    id: 'committed_event_deliveries',
    schemaSymbol: 'committedEventDeliveries',
    columns: {
      eventId: c.id('event_id'),
      consumerId: c.id('consumer_id'),
      deliveryClass: c.enum('delivery_class', ['critical', 'rebuildable']),
      state: c.enum('state', ['pending', 'claimed', 'accepted', 'dead-letter'], {
        default: 'pending',
      }),
      attemptCount: c.int('attempt_count', { default: 0 }),
      nextAttemptAt: c.epochMs('next_attempt_at'),
      claimedBy: c.text('claimed_by', { nullable: true }),
      leaseEpoch: c.int('lease_epoch', { default: 0 }),
      claimExpiresAt: c.epochMs('claim_expires_at', { nullable: true }),
      lastErrorCode: c.text('last_error_code', { nullable: true }),
      lastErrorSummary: c.text('last_error_summary', { nullable: true }),
      replayGeneration: c.int('replay_generation', { default: 0 }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      acceptedAt: c.epochMs('accepted_at', { nullable: true }),
      deadLetterAt: c.epochMs('dead_letter_at', { nullable: true }),
    },
    primaryKey: ['event_id', 'consumer_id'],
    foreignKeys: [
      foreignKey(
        'committed_event_deliveries_event_id_committed_events_id_fk',
        ['event_id'],
        'committed_events',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'committed_event_deliveries_attempt_nonnegative',
        expression: raw(
          '"committed_event_deliveries"."attempt_count" >= 0',
          '"attempt_count" >= 0',
        ),
      },
      {
        name: 'committed_event_deliveries_lease_epoch_nonnegative',
        expression: raw('"committed_event_deliveries"."lease_epoch" >= 0', '"lease_epoch" >= 0'),
      },
      {
        name: 'committed_event_deliveries_replay_generation_nonnegative',
        expression: raw(
          '"committed_event_deliveries"."replay_generation" >= 0',
          '"replay_generation" >= 0',
        ),
      },
    ],
    indexes: [
      index('idx_committed_event_deliveries_due', [
        'state',
        'next_attempt_at',
        'claim_expires_at',
        'created_at',
      ]),
      index('idx_committed_event_deliveries_consumer_state', [
        'consumer_id',
        'state',
        'updated_at',
      ]),
    ],
    retention: retention.operational,
  })

  const committedEventFamilyCutoversDefinition = owner.table({
    id: 'committed_event_family_cutovers',
    schemaSymbol: 'committedEventFamilyCutovers',
    columns: {
      producer: c.enum('producer', ['task-execution', 'collaboration']),
      family: c.enum('family', ['task-lifecycle', 'review', 'clarify', 'questions']),
      mode: c.enum('mode', ['legacy', 'shadow', 'dispatchable']),
      epoch: c.int('epoch'),
      changedAt: c.epochMs('changed_at'),
      changeRef: c.id('change_ref'),
    },
    primaryKey: ['producer', 'family'],
    checks: [
      {
        name: 'committed_event_family_cutovers_epoch_positive',
        expression: raw('"committed_event_family_cutovers"."epoch" > 0', '"epoch" > 0'),
      },
    ],
    retention: retention.operational,
    migrationPolicy: 'DEFER',
  })

  const committedEventsDefinition = owner.table({
    id: 'committed_events',
    schemaSymbol: 'committedEvents',
    columns: {
      id: c.id('id', { primary: true }),
      eventGroupId: c.id('event_group_id'),
      eventGroupOrdinal: c.int('event_group_ordinal'),
      producer: c.enum('producer', ['task-execution', 'collaboration']),
      family: c.enum('family', ['task-lifecycle', 'review', 'clarify', 'questions']),
      eventType: c.text('event_type'),
      schemaVersion: c.int('schema_version'),
      aggregateKind: c.enum('aggregate_kind', [
        'task',
        'review-round',
        'clarify-round',
        'question-gate',
      ]),
      aggregateId: c.id('aggregate_id'),
      aggregateSeq: c.int('aggregate_seq'),
      operationRef: c.id('operation_ref'),
      correlationRef: c.id('correlation_ref', { nullable: true }),
      causationRef: c.id('causation_ref', { nullable: true }),
      occurredAt: c.epochMs('occurred_at'),
      payloadJson: c.jsonText('payload_json'),
      payloadDigest: c.id('payload_digest'),
      deliveryMode: c.enum('delivery_mode', ['shadow', 'dispatchable']),
      producerEpoch: c.int('producer_epoch'),
      createdAt: c.epochMs('created_at'),
    },
    checks: [
      {
        name: 'committed_events_schema_v1',
        expression: raw('"committed_events"."schema_version" = 1', '"schema_version" = 1'),
      },
      {
        name: 'committed_events_group_ordinal_nonnegative',
        expression: raw(
          '"committed_events"."event_group_ordinal" >= 0',
          '"event_group_ordinal" >= 0',
        ),
      },
      {
        name: 'committed_events_aggregate_seq_positive',
        expression: raw('"committed_events"."aggregate_seq" > 0', '"aggregate_seq" > 0'),
      },
      {
        name: 'committed_events_producer_epoch_positive',
        expression: raw('"committed_events"."producer_epoch" > 0', '"producer_epoch" > 0'),
      },
      {
        name: 'committed_events_payload_json_valid',
        expression: raw(
          'json_valid("committed_events"."payload_json")',
          'json_valid("payload_json")',
        ),
      },
      {
        name: 'committed_events_payload_digest_shape',
        expression: raw(
          'length("committed_events"."payload_digest") = 64 OR "committed_events"."payload_digest" = \'canonical-hex-v1:\' || lower(hex("committed_events"."payload_json"))',
          'length("payload_digest") = 64 OR "payload_digest" = \'canonical-hex-v1:\' || lower(hex("payload_json"))',
        ),
      },
    ],
    indexes: [
      index(
        'committed_events_aggregate_seq_unique',
        ['producer', 'family', 'aggregate_kind', 'aggregate_id', 'aggregate_seq'],
        { unique: true },
      ),
      index('committed_events_group_ordinal_unique', ['event_group_id', 'event_group_ordinal'], {
        unique: true,
      }),
      index('idx_committed_events_operation', ['producer', 'family', 'operation_ref']),
      index('idx_committed_events_aggregate', [
        'producer',
        'family',
        'aggregate_kind',
        'aggregate_id',
        'aggregate_seq',
      ]),
    ],
    retention: retention.operational,
  })

  const schemaContribution = owner.contribution([
    committedEventAggregateHeadsDefinition,
    committedEventDeliveriesDefinition,
    committedEventFamilyCutoversDefinition,
    committedEventsDefinition,
  ])

  return { schemaContribution }
})()

const frozen11 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('platform/content')

  const hostedObjectPublicationsDefinition = owner.table({
    id: 'hosted_object_publications',
    schemaSymbol: 'hostedObjectPublications',
    columns: {
      id: c.id('id', { primary: true }),
      owner: c.text('owner'),
      logicalKey: c.id('logical_key'),
      scope: c.text('scope', { nullable: true }),
      attempt: c.text('attempt'),
      state: c.enum('state', ['pending', 'ready', 'releasing', 'released']),
      sha256: c.text('sha256'),
      size: c.int('size'),
      objectId: c.id('object_id', { nullable: true }),
      epoch: c.int('epoch'),
      sourceSealed: c.text('source_sealed', { nullable: true }),
      attempts: c.int('attempts', { default: 0 }),
      nextAttemptAt: c.epochMs('next_attempt_at', { default: 0 }),
      createdAt: c.epochMs('created_at'),
      releasedAt: c.epochMs('released_at', { nullable: true }),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'hosted_object_publications_state_known',
        expression: raw(
          "\"hosted_object_publications\".\"state\" IN ('pending', 'ready', 'releasing', 'released')",
          "\"state\" IN ('pending', 'ready', 'releasing', 'released')",
        ),
      },
      {
        name: 'hosted_object_publications_shape_known',
        expression: raw(
          '("hosted_object_publications"."state" = \'pending\' AND "hosted_object_publications"."released_at" IS NULL) OR ("hosted_object_publications"."state" = \'ready\' AND "hosted_object_publications"."object_id" IS NOT NULL AND "hosted_object_publications"."released_at" IS NULL AND "hosted_object_publications"."source_sealed" IS NULL) OR ("hosted_object_publications"."state" IN (\'releasing\', \'released\') AND "hosted_object_publications"."released_at" IS NOT NULL AND "hosted_object_publications"."source_sealed" IS NULL)',
          '("state" = \'pending\' AND "released_at" IS NULL) OR ("state" = \'ready\' AND "object_id" IS NOT NULL AND "released_at" IS NULL AND "source_sealed" IS NULL) OR ("state" IN (\'releasing\', \'released\') AND "released_at" IS NOT NULL AND "source_sealed" IS NULL)',
        ),
      },
      {
        name: 'hosted_object_publications_size_valid',
        expression: raw('"hosted_object_publications"."size" >= 0', '"size" >= 0'),
      },
    ],
    indexes: [
      index('hosted_object_publications_identity', ['owner', 'logical_key'], { unique: true }),
      index('hosted_object_publications_work_idx', ['state', 'next_attempt_at']),
      index('hosted_object_publications_scope_idx', ['owner', 'scope', 'state']),
    ],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([hostedObjectPublicationsDefinition])

  return { schemaContribution }
})()

const frozen12 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('resource-catalog')

  const agentsDefinition = owner.table({
    id: 'agents',
    schemaSymbol: 'agents',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      outputs: c.jsonText('outputs', { default: '[]' }),
      inputs: c.jsonText('inputs', { default: '[]' }),
      syncOutputsOnIterate: c.bool('sync_outputs_on_iterate', { default: true }),
      runtime: c.text('runtime', { nullable: true }),
      permission: c.jsonText('permission', { default: '{}' }),
      skills: c.jsonText('skills', { default: '[]' }),
      dependsOn: c.jsonText('depends_on', { default: '[]' }),
      mcp: c.jsonText('mcp', { default: '[]' }),
      plugins: c.jsonText('plugins', { default: '[]' }),
      frontmatterExtra: c.jsonText('frontmatter_extra', { default: '{}' }),
      bodyMd: c.text('body_md', { default: '' }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      builtin: c.bool('builtin', { default: false }),
      schemaVersion: c.int('schema_version', { default: 1 }),
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
      index(
        'agents_owner_name_unique',
        [
          raw('COALESCE("agents"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'),
          'name',
        ],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const mcpProbesDefinition = owner.table({
    id: 'mcp_probes',
    schemaSymbol: 'mcpProbes',
    columns: {
      id: c.id('id', { primary: true }),
      mcpId: c.id('mcp_id', { unique: 'mcp_probes_mcp_id_unique' }),
      status: c.enum('status', ['ok', 'error']),
      latencyMs: c.int('latency_ms'),
      handshakeMs: c.int('handshake_ms', { nullable: true }),
      serverInfoJson: c.jsonText('server_info_json', { nullable: true }),
      protocolVersion: c.text('protocol_version', { nullable: true }),
      capabilitiesJson: c.jsonText('capabilities_json', { nullable: true }),
      toolsJson: c.jsonText('tools_json', { nullable: true }),
      resourcesJson: c.jsonText('resources_json', { nullable: true }),
      resourceTemplatesJson: c.jsonText('resource_templates_json', { nullable: true }),
      promptsJson: c.jsonText('prompts_json', { nullable: true }),
      errorCode: c.text('error_code', { nullable: true }),
      errorMessage: c.text('error_message', { nullable: true }),
      errorDetailJson: c.jsonText('error_detail_json', { nullable: true }),
      schemaVersion: c.int('schema_version', { default: 1 }),
      startedAt: c.epochMs('started_at'),
      finishedAt: c.epochMs('finished_at'),
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
      foreignKey('mcp_probes_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    retention: retention.business,
  })

  const mcpRuntimeTestCreateReceiptsDefinition = owner.table({
    id: 'mcp_runtime_test_create_receipts',
    schemaSymbol: 'mcpRuntimeTestCreateReceipts',
    columns: {
      mcpId: c.id('mcp_id'),
      ownerUserId: c.id('owner_user_id'),
      clientCreateId: c.id('client_create_id'),
      requestDigest: c.id('request_digest'),
      sessionId: c.id('session_id'),
      acceptedTurnId: c.id('accepted_turn_id'),
      createdAt: c.epochMs('created_at'),
      expiresAt: c.epochMs('expires_at'),
    },
    primaryKey: ['mcp_id', 'owner_user_id', 'client_create_id'],
    foreignKeys: [
      foreignKey('mcp_runtime_test_create_receipts_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], {
        onDelete: 'restrict',
      }),
      foreignKey(
        'mcp_runtime_test_create_receipts_owner_user_id_users_id_fk',
        ['owner_user_id'],
        'users',
        ['id'],
        { onDelete: 'restrict' },
      ),
    ],
    checks: [
      {
        name: 'mcp_runtime_test_create_receipts_shape',
        expression: raw(
          'length("mcp_runtime_test_create_receipts"."request_digest") = 64\n        AND "mcp_runtime_test_create_receipts"."request_digest" NOT GLOB \'*[^0-9a-f]*\'\n        AND "mcp_runtime_test_create_receipts"."created_at" >= 0\n        AND "mcp_runtime_test_create_receipts"."expires_at" > "mcp_runtime_test_create_receipts"."created_at"',
          'length("request_digest") = 64 AND "request_digest" !~ \'[^0-9a-f]\' AND "created_at" >= 0 AND "expires_at" > "created_at"',
        ),
      },
    ],
    indexes: [index('idx_mcp_runtime_test_create_receipts_expiry', ['expires_at'])],
    retention: retention.business,
  })

  const mcpRuntimeTestEventsDefinition = owner.table({
    id: 'mcp_runtime_test_events',
    schemaSymbol: 'mcpRuntimeTestEvents',
    columns: {
      id: c.identity('id', { primary: true }),
      testSessionId: c.id('test_session_id'),
      firstSeenTurnId: c.id('first_seen_turn_id'),
      eventSeq: c.int('event_seq'),
      ts: c.int('ts'),
      kind: c.text('kind'),
      payload: c.text('payload'),
      sessionId: c.id('session_id', { nullable: true }),
      parentSessionId: c.id('parent_session_id', { nullable: true }),
      source: c.enum('source', ['stream', 'live-child', 'post-run-child']),
      externalEventKey: c.id('external_event_key', { nullable: true }),
    },
    foreignKeys: [
      foreignKey(
        'mcp_runtime_test_events_test_session_id_mcp_runtime_test_sessions_id_fk',
        ['test_session_id'],
        'mcp_runtime_test_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'mcp_runtime_test_events_shape',
        expression: raw(
          '"mcp_runtime_test_events"."event_seq" > 0\n        AND "mcp_runtime_test_events"."ts" >= 0\n        AND "mcp_runtime_test_events"."source" IN (\'stream\', \'live-child\', \'post-run-child\')\n        AND (\n          "mcp_runtime_test_events"."external_event_key" IS NULL\n          OR (\n            length("mcp_runtime_test_events"."external_event_key") = 64\n            AND "mcp_runtime_test_events"."external_event_key" NOT GLOB \'*[^0-9a-f]*\'\n          )\n        )',
          '"event_seq" > 0 AND "ts" >= 0 AND "source" IN (\'stream\', \'live-child\', \'post-run-child\') AND ( "external_event_key" IS NULL OR ( length("external_event_key") = 64 AND "external_event_key" !~ \'[^0-9a-f]\' ) )',
        ),
      },
    ],
    indexes: [
      index('uniq_mcp_runtime_test_events_session_seq', ['test_session_id', 'event_seq'], {
        unique: true,
      }),
      index('uniq_mcp_runtime_test_events_external', ['test_session_id', 'external_event_key'], {
        unique: true,
        where: raw(
          '"mcp_runtime_test_events"."external_event_key" IS NOT NULL',
          '"external_event_key" IS NOT NULL',
        ),
      }),
      index('idx_mcp_runtime_test_events_session', ['test_session_id', 'event_seq']),
    ],
    retention: retention.operational,
  })

  const mcpRuntimeTestSessionLeasesDefinition = owner.table({
    id: 'mcp_runtime_test_session_leases',
    schemaSymbol: 'mcpRuntimeTestSessionLeases',
    columns: {
      protocol: c.enum('protocol', ['opencode', 'claude-code']),
      runtimeSessionId: c.id('runtime_session_id'),
      testSessionId: c.id('test_session_id'),
      createdTurnId: c.id('created_turn_id'),
      currentTurnId: c.id('current_turn_id'),
      leaseTurnId: c.id('lease_turn_id', { nullable: true }),
      leaseAcquiredAt: c.epochMs('lease_acquired_at', { nullable: true }),
      leaseNonceDigest: c.id('lease_nonce_digest', { nullable: true }),
    },
    primaryKey: ['protocol', 'runtime_session_id'],
    foreignKeys: [
      foreignKey(
        'mcp_runtime_test_session_leases_test_session_id_mcp_runtime_test_sessions_id_fk',
        ['test_session_id'],
        'mcp_runtime_test_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
      foreignKey(
        'mcp_runtime_test_session_leases_created_turn_id_mcp_runtime_test_turns_id_fk',
        ['created_turn_id'],
        'mcp_runtime_test_turns',
        ['id'],
        { onDelete: 'restrict' },
      ),
      foreignKey(
        'mcp_runtime_test_session_leases_current_turn_id_mcp_runtime_test_turns_id_fk',
        ['current_turn_id'],
        'mcp_runtime_test_turns',
        ['id'],
        { onDelete: 'restrict' },
      ),
      foreignKey(
        'mcp_runtime_test_session_leases_lease_turn_id_mcp_runtime_test_turns_id_fk',
        ['lease_turn_id'],
        'mcp_runtime_test_turns',
        ['id'],
        { onDelete: 'restrict' },
      ),
    ],
    checks: [
      {
        name: 'mcp_runtime_test_session_leases_all_or_none',
        expression: raw(
          '(\n        (\n          "mcp_runtime_test_session_leases"."lease_turn_id" IS NULL\n          AND "mcp_runtime_test_session_leases"."lease_acquired_at" IS NULL\n          AND "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NULL\n        )\n        OR\n        (\n          "mcp_runtime_test_session_leases"."lease_turn_id" IS NOT NULL\n          AND "mcp_runtime_test_session_leases"."lease_acquired_at" IS NOT NULL\n          AND "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NOT NULL\n        )\n      )',
          '( ( "lease_turn_id" IS NULL AND "lease_acquired_at" IS NULL AND "lease_nonce_digest" IS NULL ) OR ( "lease_turn_id" IS NOT NULL AND "lease_acquired_at" IS NOT NULL AND "lease_nonce_digest" IS NOT NULL ) )',
        ),
      },
      {
        name: 'mcp_runtime_test_session_leases_shape',
        expression: raw(
          '"mcp_runtime_test_session_leases"."protocol" IN (\'opencode\', \'claude-code\')\n        AND (\n          "mcp_runtime_test_session_leases"."lease_nonce_digest" IS NULL\n          OR (\n            length("mcp_runtime_test_session_leases"."lease_nonce_digest") = 64\n            AND "mcp_runtime_test_session_leases"."lease_nonce_digest" NOT GLOB \'*[^0-9a-f]*\'\n          )\n        )',
          '"protocol" IN (\'opencode\', \'claude-code\') AND ( "lease_nonce_digest" IS NULL OR ( length("lease_nonce_digest") = 64 AND "lease_nonce_digest" !~ \'[^0-9a-f]\' ) )',
        ),
      },
    ],
    indexes: [
      index('uniq_mcp_runtime_test_session_leases_test_session', ['test_session_id'], {
        unique: true,
      }),
    ],
    retention: retention.operational,
  })

  const mcpRuntimeTestSessionsDefinition = owner.table({
    id: 'mcp_runtime_test_sessions',
    schemaSymbol: 'mcpRuntimeTestSessions',
    columns: {
      id: c.id('id', { primary: true }),
      mcpId: c.id('mcp_id'),
      ownerUserId: c.id('owner_user_id'),
      clientCreateId: c.id('client_create_id'),
      clientCreateDigest: c.id('client_create_digest'),
      status: c.enum('status', ['active', 'ending', 'ended']),
      endReason: c.enum(
        'end_reason',
        [
          'user',
          'idle-timeout',
          'mcp-deleted',
          'mcp-disabled',
          'mcp-config-changed',
          'access-revoked',
          'runtime-disabled',
          'runtime-deleted',
          'runtime-profile-changed',
          'runtime-session-reset',
          'capture-truncated',
          'capture-incomplete',
          'session-unusable',
        ],
        { nullable: true },
      ),
      mcpConfigHash: c.text('mcp_config_hash'),
      runtimeRowId: c.id('runtime_row_id'),
      runtimeName: c.text('runtime_name'),
      runtimeProtocol: c.enum('runtime_protocol', ['opencode', 'claude-code']),
      runtimeSnapshotJson: c.jsonText('runtime_snapshot_json'),
      runtimeBinaryPath: c.text('runtime_binary_path'),
      runtimeSessionId: c.id('runtime_session_id', { nullable: true }),
      nativeSessionState: c.enum('native_session_state', ['pending', 'ready', 'unusable'], {
        default: 'pending',
      }),
      inFlightTurnId: c.id('in_flight_turn_id', { nullable: true }),
      turnSeq: c.int('turn_seq', { default: 0 }),
      sessionVersion: c.int('session_version', { default: 0 }),
      idleDeadlineAt: c.epochMs('idle_deadline_at', { nullable: true }),
      continuationBlockedReason: c.enum(
        'continuation_blocked_reason',
        [
          'mcp-config-changed',
          'runtime-profile-changed',
          'capture-truncated',
          'capture-incomplete',
        ],
        { nullable: true },
      ),
      scratchRoot: c.text('scratch_root'),
      cleanupState: c.enum('cleanup_state', ['not-started', 'pending', 'complete', 'quarantined'], {
        default: 'not-started',
      }),
      cleanupErrorCode: c.text('cleanup_error_code', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      endedAt: c.epochMs('ended_at', { nullable: true }),
    },
    foreignKeys: [
      foreignKey('mcp_runtime_test_sessions_mcp_id_mcps_id_fk', ['mcp_id'], 'mcps', ['id'], {
        onDelete: 'restrict',
      }),
      foreignKey(
        'mcp_runtime_test_sessions_owner_user_id_users_id_fk',
        ['owner_user_id'],
        'users',
        ['id'],
        { onDelete: 'restrict' },
      ),
    ],
    checks: [
      {
        name: 'mcp_runtime_test_sessions_status_shape',
        expression: raw(
          '(\n        (\n          "mcp_runtime_test_sessions"."status" = \'active\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NULL\n          AND (\n            ("mcp_runtime_test_sessions"."in_flight_turn_id" IS NOT NULL AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL)\n            OR\n            (\n              "mcp_runtime_test_sessions"."in_flight_turn_id" IS NULL\n              AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NOT NULL\n              AND "mcp_runtime_test_sessions"."native_session_state" = \'ready\'\n              AND "mcp_runtime_test_sessions"."continuation_blocked_reason" IS NULL\n            )\n          )\n        )\n        OR\n        (\n          "mcp_runtime_test_sessions"."status" = \'ending\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NULL\n          AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL\n        )\n        OR\n        (\n          "mcp_runtime_test_sessions"."status" = \'ended\'\n          AND "mcp_runtime_test_sessions"."end_reason" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."ended_at" IS NOT NULL\n          AND "mcp_runtime_test_sessions"."in_flight_turn_id" IS NULL\n          AND "mcp_runtime_test_sessions"."idle_deadline_at" IS NULL\n        )\n      )',
          '( ( "status" = \'active\' AND "end_reason" IS NULL AND "ended_at" IS NULL AND ( ("in_flight_turn_id" IS NOT NULL AND "idle_deadline_at" IS NULL) OR ( "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NOT NULL AND "native_session_state" = \'ready\' AND "continuation_blocked_reason" IS NULL ) ) ) OR ( "status" = \'ending\' AND "end_reason" IS NOT NULL AND "ended_at" IS NULL AND "idle_deadline_at" IS NULL ) OR ( "status" = \'ended\' AND "end_reason" IS NOT NULL AND "ended_at" IS NOT NULL AND "in_flight_turn_id" IS NULL AND "idle_deadline_at" IS NULL ) )',
        ),
      },
      {
        name: 'mcp_runtime_test_sessions_hash_shape',
        expression: raw(
          'length("mcp_runtime_test_sessions"."client_create_digest") = 64\n        AND "mcp_runtime_test_sessions"."client_create_digest" NOT GLOB \'*[^0-9a-f]*\'\n        AND length("mcp_runtime_test_sessions"."mcp_config_hash") = 64\n        AND "mcp_runtime_test_sessions"."mcp_config_hash" NOT GLOB \'*[^0-9a-f]*\'',
          'length("client_create_digest") = 64 AND "client_create_digest" !~ \'[^0-9a-f]\' AND length("mcp_config_hash") = 64 AND "mcp_config_hash" !~ \'[^0-9a-f]\'',
        ),
      },
      {
        name: 'mcp_runtime_test_sessions_enum_shape',
        expression: raw(
          "\"mcp_runtime_test_sessions\".\"status\" IN ('active', 'ending', 'ended')\n        AND \"mcp_runtime_test_sessions\".\"runtime_protocol\" IN ('opencode', 'claude-code')\n        AND \"mcp_runtime_test_sessions\".\"native_session_state\" IN ('pending', 'ready', 'unusable')\n        AND \"mcp_runtime_test_sessions\".\"cleanup_state\" IN ('not-started', 'pending', 'complete', 'quarantined')\n        AND (\n          \"mcp_runtime_test_sessions\".\"end_reason\" IS NULL\n          OR \"mcp_runtime_test_sessions\".\"end_reason\" IN (\n            'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled',\n            'mcp-config-changed', 'access-revoked', 'runtime-disabled',\n            'runtime-deleted', 'runtime-profile-changed',\n            'runtime-session-reset', 'capture-truncated',\n            'capture-incomplete', 'session-unusable'\n          )\n        )\n        AND (\n          \"mcp_runtime_test_sessions\".\"continuation_blocked_reason\" IS NULL\n          OR \"mcp_runtime_test_sessions\".\"continuation_blocked_reason\" IN (\n            'mcp-config-changed', 'runtime-profile-changed',\n            'capture-truncated', 'capture-incomplete'\n          )\n        )\n        AND \"mcp_runtime_test_sessions\".\"turn_seq\" >= 0\n        AND \"mcp_runtime_test_sessions\".\"session_version\" >= 0",
          "\"status\" IN ('active', 'ending', 'ended') AND \"runtime_protocol\" IN ('opencode', 'claude-code') AND \"native_session_state\" IN ('pending', 'ready', 'unusable') AND \"cleanup_state\" IN ('not-started', 'pending', 'complete', 'quarantined') AND ( \"end_reason\" IS NULL OR \"end_reason\" IN ( 'user', 'idle-timeout', 'mcp-deleted', 'mcp-disabled', 'mcp-config-changed', 'access-revoked', 'runtime-disabled', 'runtime-deleted', 'runtime-profile-changed', 'runtime-session-reset', 'capture-truncated', 'capture-incomplete', 'session-unusable' ) ) AND ( \"continuation_blocked_reason\" IS NULL OR \"continuation_blocked_reason\" IN ( 'mcp-config-changed', 'runtime-profile-changed', 'capture-truncated', 'capture-incomplete' ) ) AND \"turn_seq\" >= 0 AND \"session_version\" >= 0",
        ),
      },
    ],
    indexes: [
      index('uniq_mcp_runtime_test_sessions_owner_mcp_live', ['mcp_id', 'owner_user_id'], {
        unique: true,
        where: raw(
          '"mcp_runtime_test_sessions"."status" IN (\'active\', \'ending\')',
          "\"status\" IN ('active', 'ending')",
        ),
      }),
      index(
        'uniq_mcp_runtime_test_sessions_create',
        ['mcp_id', 'owner_user_id', 'client_create_id'],
        { unique: true },
      ),
      index('idx_mcp_runtime_test_sessions_owner_mcp_updated', [
        'owner_user_id',
        'mcp_id',
        'updated_at',
      ]),
      index('idx_mcp_runtime_test_sessions_idle', ['status', 'idle_deadline_at']),
    ],
    retention: retention.business,
  })

  const mcpRuntimeTestTurnsDefinition = owner.table({
    id: 'mcp_runtime_test_turns',
    schemaSymbol: 'mcpRuntimeTestTurns',
    columns: {
      id: c.id('id', { primary: true }),
      sessionId: c.id('session_id'),
      seq: c.int('seq'),
      clientMessageId: c.id('client_message_id'),
      promptText: c.text('prompt_text'),
      status: c.enum('status', [
        'queued',
        'running',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'interrupted',
      ]),
      hardDeadlineAt: c.epochMs('hard_deadline_at'),
      captureState: c.enum('capture_state', ['live', 'complete', 'truncated', 'incomplete'], {
        default: 'live',
      }),
      captureIncompleteReason: c.text('capture_incomplete_reason', { nullable: true }),
      captureFirstEventSeq: c.int('capture_first_event_seq', { nullable: true }),
      captureLastEventSeq: c.int('capture_last_event_seq', { default: 0 }),
      captureEventBytes: c.int('capture_event_bytes', { default: 0 }),
      cancelRequestedAt: c.epochMs('cancel_requested_at', { nullable: true }),
      pid: c.int('pid', { nullable: true }),
      spawnedAt: c.epochMs('spawned_at', { nullable: true }),
      spawnBinaryPath: c.text('spawn_binary_path', { nullable: true }),
      exitCode: c.int('exit_code', { nullable: true }),
      failureCode: c.text('failure_code', { nullable: true }),
      stderrTail: c.text('stderr_tail', { nullable: true }),
      durationMs: c.int('duration_ms', { nullable: true }),
      startedAt: c.epochMs('started_at', { nullable: true }),
      finishedAt: c.epochMs('finished_at', { nullable: true }),
      createdAt: c.epochMs('created_at'),
    },
    foreignKeys: [
      foreignKey(
        'mcp_runtime_test_turns_session_id_mcp_runtime_test_sessions_id_fk',
        ['session_id'],
        'mcp_runtime_test_sessions',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'mcp_runtime_test_turns_enum_shape',
        expression: raw(
          "\"mcp_runtime_test_turns\".\"status\" IN (\n          'queued', 'running', 'succeeded', 'failed',\n          'canceled', 'timed_out', 'interrupted'\n        )\n        AND \"mcp_runtime_test_turns\".\"capture_state\" IN ('live', 'complete', 'truncated', 'incomplete')\n        AND (\n          \"mcp_runtime_test_turns\".\"capture_incomplete_reason\" IS NULL\n          OR \"mcp_runtime_test_turns\".\"capture_incomplete_reason\" IN (\n            'stream-persist-failed', 'stream-frame-limit-exceeded',\n            'child-capture-failed', 'post-exit-flush-timeout'\n          )\n        )",
          "\"status\" IN ( 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted' ) AND \"capture_state\" IN ('live', 'complete', 'truncated', 'incomplete') AND ( \"capture_incomplete_reason\" IS NULL OR \"capture_incomplete_reason\" IN ( 'stream-persist-failed', 'stream-frame-limit-exceeded', 'child-capture-failed', 'post-exit-flush-timeout' ) )",
        ),
      },
      {
        name: 'mcp_runtime_test_turns_counter_shape',
        expression: raw(
          '"mcp_runtime_test_turns"."seq" > 0\n        AND "mcp_runtime_test_turns"."hard_deadline_at" >= "mcp_runtime_test_turns"."created_at"\n        AND "mcp_runtime_test_turns"."capture_last_event_seq" >= 0\n        AND "mcp_runtime_test_turns"."capture_event_bytes" >= 0\n        AND ("mcp_runtime_test_turns"."capture_first_event_seq" IS NULL OR "mcp_runtime_test_turns"."capture_first_event_seq" > 0)\n        AND ("mcp_runtime_test_turns"."duration_ms" IS NULL OR "mcp_runtime_test_turns"."duration_ms" >= 0)',
          '"seq" > 0 AND "hard_deadline_at" >= "created_at" AND "capture_last_event_seq" >= 0 AND "capture_event_bytes" >= 0 AND ("capture_first_event_seq" IS NULL OR "capture_first_event_seq" > 0) AND ("duration_ms" IS NULL OR "duration_ms" >= 0)',
        ),
      },
      {
        name: 'mcp_runtime_test_turns_lifecycle_shape',
        expression: raw(
          '(\n          "mcp_runtime_test_turns"."status" = \'queued\'\n          AND "mcp_runtime_test_turns"."started_at" IS NULL\n          AND "mcp_runtime_test_turns"."finished_at" IS NULL\n        )\n        OR (\n          "mcp_runtime_test_turns"."status" = \'running\'\n          AND "mcp_runtime_test_turns"."started_at" IS NOT NULL\n          AND "mcp_runtime_test_turns"."finished_at" IS NULL\n        )\n        OR (\n          "mcp_runtime_test_turns"."status" IN (\n            \'succeeded\', \'failed\', \'canceled\', \'timed_out\', \'interrupted\'\n          )\n          AND "mcp_runtime_test_turns"."finished_at" IS NOT NULL\n        )',
          '( "status" = \'queued\' AND "started_at" IS NULL AND "finished_at" IS NULL ) OR ( "status" = \'running\' AND "started_at" IS NOT NULL AND "finished_at" IS NULL ) OR ( "status" IN ( \'succeeded\', \'failed\', \'canceled\', \'timed_out\', \'interrupted\' ) AND "finished_at" IS NOT NULL )',
        ),
      },
    ],
    indexes: [
      index('uniq_mcp_runtime_test_turns_session_seq', ['session_id', 'seq'], { unique: true }),
      index('uniq_mcp_runtime_test_turns_message', ['session_id', 'client_message_id'], {
        unique: true,
      }),
      index('idx_mcp_runtime_test_turns_session', ['session_id', 'seq']),
      index('idx_mcp_runtime_test_turns_status', ['status', 'hard_deadline_at']),
    ],
    retention: retention.business,
  })

  const mcpsDefinition = owner.table({
    id: 'mcps',
    schemaSymbol: 'mcps',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      type: c.enum('type', ['local', 'remote']),
      config: c.text('config', { default: '{}' }),
      enabled: c.bool('enabled', { default: true }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      schemaVersion: c.int('schema_version', { default: 1 }),
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
      index(
        'mcps_owner_name_unique',
        [raw('COALESCE("mcps"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'), 'name'],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const pluginArtifactGenerationsDefinition = owner.table({
    id: 'plugin_artifact_generations',
    schemaSymbol: 'pluginArtifactGenerations',
    columns: {
      reference: c.id('reference', { primary: true }),
      pluginId: c.id('plugin_id'),
      generationId: c.id('generation_id'),
      spec: c.text('spec'),
      state: c.enum('state', ['installing', 'ready', 'releasing', 'retired']),
      epoch: c.int('epoch'),
      installedJson: c.jsonText('installed_json', { nullable: true }),
      objectId: c.id('object_id', { nullable: true }),
      digest: c.text('digest', { nullable: true }),
      size: c.int('size', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'plugin_artifact_generations_state_known',
        expression: raw(
          "\"plugin_artifact_generations\".\"state\" IN ('installing', 'ready', 'releasing', 'retired')",
          "\"state\" IN ('installing', 'ready', 'releasing', 'retired')",
        ),
      },
      {
        name: 'plugin_artifact_generations_ready_shape',
        expression: raw(
          '"plugin_artifact_generations"."state" != \'ready\' OR ("plugin_artifact_generations"."object_id" IS NOT NULL AND "plugin_artifact_generations"."digest" IS NOT NULL AND "plugin_artifact_generations"."size" IS NOT NULL)',
          '"state" != \'ready\' OR ("object_id" IS NOT NULL AND "digest" IS NOT NULL AND "size" IS NOT NULL)',
        ),
      },
    ],
    retention: retention.business,
  })

  const pluginsDefinition = owner.table({
    id: 'plugins',
    schemaSymbol: 'plugins',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      spec: c.text('spec'),
      optionsJson: c.jsonText('options_json', { default: '{}' }),
      description: c.text('description', { default: '' }),
      enabled: c.bool('enabled', { default: true }),
      sourceKind: c.enum('source_kind', ['npm', 'file', 'git']),
      cachedPath: c.text('cached_path'),
      resolvedVersion: c.text('resolved_version', { nullable: true }),
      installedAt: c.epochMs('installed_at'),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      schemaVersion: c.int('schema_version', { default: 1 }),
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
      index(
        'plugins_owner_name_unique',
        [
          raw('COALESCE("plugins"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'),
          'name',
        ],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const resourceBundleAppliesDefinition = owner.table({
    id: 'resource_bundle_applies',
    schemaSymbol: 'resourceBundleApplies',
    columns: {
      id: c.id('id', { primary: true }),
      scope: c.text('scope'),
      key: c.text('key'),
      actorUserId: c.id('actor_user_id'),
      state: c.enum('state', ['prepared', 'applying', 'committed', 'failed'], {
        default: 'prepared',
      }),
      preparedArtifactsJson: c.jsonText('prepared_artifacts_json', { default: '[]' }),
      receiptJson: c.jsonText('receipt_json', { nullable: true }),
      error: c.text('error', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    indexes: [
      index('uniq_resource_bundle_applies_key', ['scope', 'key'], { unique: true }),
      index('idx_resource_bundle_applies_state', ['state']),
      index('idx_resource_bundle_applies_actor', ['actor_user_id']),
    ],
    retention: retention.business,
  })

  const skillContentEntriesDefinition = owner.table({
    id: 'skill_content_entries',
    schemaSymbol: 'skillContentEntries',
    columns: {
      skillId: c.id('skill_id'),
      tree: c.text('tree'),
      path: c.text('path'),
      encoding: c.enum('encoding', ['utf8', 'base64']),
      content: c.text('content'),
      size: c.int('size'),
      updatedAt: c.epochMs('updated_at'),
    },
    primaryKey: ['skill_id', 'tree', 'path'],
    checks: [
      {
        name: 'skill_content_entries_encoding_enum',
        expression: raw(
          '"skill_content_entries"."encoding" IN (\'utf8\', \'base64\')',
          "\"encoding\" IN ('utf8', 'base64')",
        ),
      },
    ],
    retention: retention.business,
  })

  const skillOperationLocksDefinition = owner.table({
    id: 'skill_operation_locks',
    schemaSymbol: 'skillOperationLocks',
    columns: {
      lockedSkillId: c.id('locked_skill_id', { primary: true }),
      opId: c.id('op_id'),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
    },
    retention: retention.operational,
  })

  const skillOperationsDefinition = owner.table({
    id: 'skill_operations',
    schemaSymbol: 'skillOperations',
    columns: {
      opId: c.id('op_id', { primary: true }),
      skillId: c.id('skill_id'),
      kind: c.enum('kind', ['reserve', 'migrate', 'delete', 'version-write']),
      phase: c.text('phase'),
      active: c.int('active', { default: 1 }),
      stagingPath: c.text('staging_path', { nullable: true }),
      backupPath: c.text('backup_path', { nullable: true }),
      candidatePath: c.text('candidate_path', { nullable: true }),
      candidateFingerprint: c.text('candidate_fingerprint', { nullable: true }),
      backupFingerprint: c.text('backup_fingerprint', { nullable: true }),
      targetVersion: c.int('target_version', { nullable: true }),
      generation: c.int('generation', { nullable: true }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      preconditionJson: c.jsonText('precondition_json', { nullable: true }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
    },
    checks: [
      {
        name: 'skill_operations_kind_enum',
        expression: raw(
          "\"skill_operations\".\"kind\" IN ('reserve', 'migrate', 'delete', 'version-write')",
          "\"kind\" IN ('reserve', 'migrate', 'delete', 'version-write')",
        ),
      },
      {
        name: 'skill_operations_active_boolean',
        expression: raw('"skill_operations"."active" IN (0, 1)', '"active" IN (0, 1)'),
      },
    ],
    indexes: [
      index('uq_skill_operations_active', ['skill_id'], {
        unique: true,
        where: raw('"skill_operations"."active" = 1', '"active" = 1'),
      }),
    ],
    retention: retention.operational,
  })

  const skillVersionsDefinition = owner.table({
    id: 'skill_versions',
    schemaSymbol: 'skillVersions',
    columns: {
      id: c.id('id', { primary: true }),
      skillId: c.id('skill_id'),
      versionIndex: c.int('version_index'),
      filesPath: c.text('files_path'),
      source: c.enum('source', ['initial', 'editor', 'fusion', 'restore', 'import']),
      summary: c.text('summary', { nullable: true }),
      fusionId: c.id('fusion_id', { nullable: true }),
      restoredFromVersion: c.int('restored_from_version', { nullable: true }),
      authorUserId: c.id('author_user_id', { nullable: true }),
      contentHash: c.text('content_hash', { nullable: true }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
    },
    foreignKeys: [
      foreignKey('skill_versions_skill_id_skills_id_fk', ['skill_id'], 'skills', ['id'], {
        onDelete: 'cascade',
      }),
    ],
    indexes: [
      index('uq_skill_versions_skill_v', ['skill_id', 'version_index'], { unique: true }),
      index('idx_skill_versions_created', ['created_at']),
      index('idx_skill_versions_fusion', ['fusion_id']),
    ],
    retention: retention.business,
  })

  const skillsDefinition = owner.table({
    id: 'skills',
    schemaSymbol: 'skills',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      managedPath: c.text('managed_path', { nullable: true }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      schemaVersion: c.int('schema_version', { default: 1 }),
      contentVersion: c.int('content_version', { default: 1 }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      metaRevision: c.int('meta_revision', { default: 0 }),
      reservationState: c.enum('reservation_state', ['reserving', 'ready'], { default: 'ready' }),
      versionState: c.enum(
        'version_state',
        ['legacy-unbackfilled', 'snapshot-unverified', 'snapshot-authoritative', 'quarantined'],
        { default: 'legacy-unbackfilled' },
      ),
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
      index(
        'skills_owner_name_unique',
        [
          raw('COALESCE("skills"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'),
          'name',
        ],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const workflowsDefinition = owner.table({
    id: 'workflows',
    schemaSymbol: 'workflows',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      definition: c.jsonText('definition'),
      version: c.int('version', { default: 1 }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      builtin: c.bool('builtin', { default: false }),
      schemaVersion: c.int('schema_version', { default: 1 }),
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
      index('idx_workflows_builtin_name', ['name'], {
        unique: true,
        where: raw('"workflows"."builtin" = 1', '"builtin" = TRUE'),
      }),
    ],
    retention: retention.business,
  })

  const workgroupMembersDefinition = owner.table({
    id: 'workgroup_members',
    schemaSymbol: 'workgroupMembers',
    columns: {
      id: c.id('id', { primary: true }),
      workgroupId: c.id('workgroup_id'),
      memberType: c.enum('member_type', ['agent', 'human']),
      agentName: c.text('agent_name', { nullable: true }),
      agentId: c.id('agent_id', { nullable: true }),
      userId: c.id('user_id', { nullable: true }),
      displayName: c.text('display_name'),
      roleDesc: c.text('role_desc', { default: '' }),
      sortOrder: c.int('sort_order', { default: 0 }),
      createdAt: c.epochMs('created_at', {
        default: raw(
          '(unixepoch() * 1000)',
          '(extract(epoch from clock_timestamp()) * 1000)::bigint',
        ),
      }),
    },
    foreignKeys: [
      foreignKey(
        'workgroup_members_workgroup_id_workgroups_id_fk',
        ['workgroup_id'],
        'workgroups',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    indexes: [
      index('uq_workgroup_members_display', ['workgroup_id', 'display_name'], { unique: true }),
      index('idx_workgroup_members_group', ['workgroup_id']),
    ],
    retention: retention.business,
  })

  const workgroupsDefinition = owner.table({
    id: 'workgroups',
    schemaSymbol: 'workgroups',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      instructions: c.text('instructions', { default: '' }),
      mode: c.enum('mode', ['leader_worker', 'free_collab', 'dynamic_workflow'], {
        default: 'leader_worker',
      }),
      outputContract: c.enum('output_contract', ['files', 'discussion'], { default: 'files' }),
      leaderMemberId: c.id('leader_member_id', { nullable: true }),
      shareOutputs: c.bool('share_outputs', { default: true }),
      directMessages: c.bool('direct_messages', { default: false }),
      blackboard: c.bool('blackboard', { default: false }),
      maxRounds: c.int('max_rounds', { default: 20 }),
      completionGate: c.bool('completion_gate', { default: false }),
      clarifyBudget: c.int('clarify_budget', { default: 3 }),
      fanOut: c.bool('fan_out', { default: false }),
      version: c.int('version', { default: 1 }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      visibility: c.enum('visibility', ['private', 'public'], { default: 'public' }),
      aclRevision: c.int('acl_revision', { default: 0 }),
      schemaVersion: c.int('schema_version', { default: 1 }),
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
    checks: [
      {
        name: 'workgroups_output_contract_enum',
        expression: raw(
          '"workgroups"."output_contract" IN (\'files\', \'discussion\')',
          "\"output_contract\" IN ('files', 'discussion')",
        ),
      },
    ],
    indexes: [
      index(
        'workgroups_owner_name_unique',
        [
          raw('COALESCE("workgroups"."owner_user_id", \'\')', 'COALESCE("owner_user_id", \'\')'),
          'name',
        ],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    agentsDefinition,
    mcpProbesDefinition,
    mcpRuntimeTestCreateReceiptsDefinition,
    mcpRuntimeTestEventsDefinition,
    mcpRuntimeTestSessionLeasesDefinition,
    mcpRuntimeTestSessionsDefinition,
    mcpRuntimeTestTurnsDefinition,
    mcpsDefinition,
    pluginArtifactGenerationsDefinition,
    pluginsDefinition,
    resourceBundleAppliesDefinition,
    skillContentEntriesDefinition,
    skillOperationLocksDefinition,
    skillOperationsDefinition,
    skillVersionsDefinition,
    skillsDefinition,
    workflowsDefinition,
    workgroupMembersDefinition,
    workgroupsDefinition,
  ])

  return { schemaContribution }
})()

const frozen13 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('run-observability')

  const observationCallModelsDefinition = owner.table({
    id: 'observation_call_models',
    schemaSymbol: 'observationCallModels',
    columns: {
      callId: c.id('call_id'),
      model: c.text('model'),
      inputTokens: c.int('input_tokens', { default: 0 }),
      cacheReadTokens: c.int('cache_read_tokens', { default: 0 }),
      cacheWriteTokens: c.int('cache_write_tokens', { default: 0 }),
      outputTokens: c.int('output_tokens', { default: 0 }),
      reasoningTokens: c.int('reasoning_tokens', { default: 0 }),
      priceId: c.id('price_id', { nullable: true }),
      costNano: c.int('cost_nano', { nullable: true }),
      costState: c.enum('cost_state', ['none', 'priced', 'partial', 'unpriced']),
    },
    primaryKey: ['call_id', 'model'],
    foreignKeys: [
      foreignKey(
        'observation_call_models_call_id_observation_calls_id_fk',
        ['call_id'],
        'observation_calls',
        ['id'],
        { onDelete: 'cascade' },
      ),
    ],
    checks: [
      {
        name: 'observation_call_models_cost_state_ck',
        expression: raw(
          "\"observation_call_models\".\"cost_state\" IN ('none','priced','partial','unpriced')",
          "\"cost_state\" IN ('none','priced','partial','unpriced')",
        ),
      },
    ],
    retention: retention.business,
  })

  const observationCallsDefinition = owner.table({
    id: 'observation_calls',
    schemaSymbol: 'observationCalls',
    columns: {
      id: c.id('id', { primary: true }),
      purpose: c.enum('purpose', ['task', 'system']),
      taskId: c.id('task_id', { nullable: true }),
      nodeRunId: c.id('node_run_id', { nullable: true }),
      systemKind: c.text('system_kind', { nullable: true }),
      systemLabel: c.text('system_label', { nullable: true }),
      ownerUserId: c.id('owner_user_id', { nullable: true }),
      agentId: c.id('agent_id', { nullable: true }),
      agentName: c.text('agent_name'),
      runtimeId: c.id('runtime_id', { nullable: true }),
      runtimeName: c.text('runtime_name', { nullable: true }),
      protocol: c.text('protocol'),
      status: c.enum('status', ['running', 'done', 'failed', 'canceled', 'interrupted']),
      startedAt: c.epochMs('started_at'),
      endedAt: c.epochMs('ended_at', { nullable: true }),
      usageState: c.enum('usage_state', ['pending', 'partial', 'complete', 'none']),
      inputTokens: c.int('input_tokens', { default: 0 }),
      cacheReadTokens: c.int('cache_read_tokens', { default: 0 }),
      cacheWriteTokens: c.int('cache_write_tokens', { default: 0 }),
      outputTokens: c.int('output_tokens', { default: 0 }),
      reasoningTokens: c.int('reasoning_tokens', { default: 0 }),
      costNano: c.int('cost_nano', { default: 0 }),
      costState: c.enum('cost_state', ['none', 'priced', 'partial', 'unpriced']),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'observation_calls_purpose_ck',
        expression: raw(
          '"observation_calls"."purpose" IN (\'task\',\'system\')',
          "\"purpose\" IN ('task','system')",
        ),
      },
      {
        name: 'observation_calls_status_ck',
        expression: raw(
          "\"observation_calls\".\"status\" IN ('running','done','failed','canceled','interrupted')",
          "\"status\" IN ('running','done','failed','canceled','interrupted')",
        ),
      },
      {
        name: 'observation_calls_usage_state_ck',
        expression: raw(
          "\"observation_calls\".\"usage_state\" IN ('pending','partial','complete','none')",
          "\"usage_state\" IN ('pending','partial','complete','none')",
        ),
      },
      {
        name: 'observation_calls_cost_state_ck',
        expression: raw(
          "\"observation_calls\".\"cost_state\" IN ('none','priced','partial','unpriced')",
          "\"cost_state\" IN ('none','priced','partial','unpriced')",
        ),
      },
    ],
    indexes: [
      index('observation_calls_started_idx', ['started_at']),
      index('observation_calls_task_idx', ['task_id', 'started_at']),
      index('observation_calls_status_idx', ['status']),
    ],
    retention: retention.business,
  })

  const observationPricesDefinition = owner.table({
    id: 'observation_prices',
    schemaSymbol: 'observationPrices',
    columns: {
      id: c.id('id', { primary: true }),
      runtimeId: c.id('runtime_id'),
      model: c.text('model'),
      inputMicro: c.int('input_micro', { nullable: true }),
      cacheReadMicro: c.int('cache_read_micro', { nullable: true }),
      cacheWriteMicro: c.int('cache_write_micro', { nullable: true }),
      outputMicro: c.int('output_micro', { nullable: true }),
      effectiveFrom: c.int('effective_from'),
      createdAt: c.epochMs('created_at'),
      createdBy: c.text('created_by'),
      note: c.text('note', { default: '' }),
    },
    indexes: [index('observation_prices_line_idx', ['runtime_id', 'model', 'created_at'])],
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    observationCallModelsDefinition,
    observationCallsDefinition,
    observationPricesDefinition,
  ])

  return { schemaContribution }
})()

const frozen14 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('runtime-management')

  const runtimesDefinition = owner.table({
    id: 'runtimes',
    schemaSymbol: 'runtimes',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name', { unique: 'runtimes_name_unique' }),
      protocol: c.enum('protocol', ['opencode', 'claude-code']),
      binaryPath: c.text('binary_path', { nullable: true }),
      enabled: c.bool('enabled', { default: true }),
      model: c.text('model', { nullable: true }),
      variant: c.text('variant', { nullable: true }),
      temperature: c.real('temperature', { nullable: true }),
      steps: c.int('steps', { nullable: true }),
      maxSteps: c.int('max_steps', { nullable: true }),
      isSandbox: c.bool('is_sandbox', { default: false }),
      configDirEnv: c.text('config_dir_env', { nullable: true }),
      configDirName: c.text('config_dir_name', { nullable: true }),
      extraArgsJson: c.jsonText('extra_args_json', { nullable: true }),
      lastProbeJson: c.jsonText('last_probe_json', { nullable: true }),
      probeFence: c.int('probe_fence', { default: 0 }),
      createdBy: c.text('created_by', { nullable: true }),
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
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([runtimesDefinition])

  return { schemaContribution }
})()

const frozen15 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

  const owner = defineContribution('source-control')

  const cachedReposDefinition = owner.table({
    id: 'cached_repos',
    schemaSymbol: 'cachedRepos',
    columns: {
      id: c.id('id', { primary: true }),
      urlHash: c.text('url_hash', { unique: 'cached_repos_url_hash_unique' }),
      urlEnc: c.text('url_enc', { nullable: true }),
      urlRedacted: c.text('url_redacted', { nullable: true }),
      localPath: c.text('local_path'),
      defaultBranch: c.text('default_branch', { nullable: true }),
      lastFetchedAt: c.epochMs('last_fetched_at'),
      createdAt: c.epochMs('created_at'),
      hasSubmodules: c.bool('has_submodules', { nullable: true }),
      lastSubmoduleSyncOk: c.bool('last_submodule_sync_ok', { nullable: true }),
      lastSubmoduleSyncError: c.text('last_submodule_sync_error', { nullable: true }),
      lastAutoRefreshAt: c.epochMs('last_auto_refresh_at', { nullable: true }),
    },
    indexes: [
      index('idx_cached_repos_fetched_id', ['last_fetched_at', 'id']),
      index('idx_cached_repos_submodule_health', ['has_submodules', 'last_submodule_sync_ok']),
    ],
    retention: retention.business,
  })

  const hostedTaskWorkspacesDefinition = owner.table({
    id: 'hosted_task_workspaces',
    schemaSymbol: 'hostedTaskWorkspaces',
    columns: {
      taskId: c.id('task_id', { primary: true }),
      requestKey: c.id('request_key'),
      businessTaskId: c.id('business_task_id', { nullable: true }),
      state: c.enum('state', ['creating', 'ready', 'closing', 'closed']),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'hosted_task_workspaces_state_known',
        expression: raw(
          "\"hosted_task_workspaces\".\"state\" IN ('creating', 'ready', 'closing', 'closed')",
          "\"state\" IN ('creating', 'ready', 'closing', 'closed')",
        ),
      },
    ],
    indexes: [
      index('hosted_task_workspaces_business_task_unique', ['business_task_id'], { unique: true }),
    ],
    retention: retention.business,
  })

  const hostedWorkspaceCommandsDefinition = owner.table({
    id: 'hosted_workspace_commands',
    schemaSymbol: 'hostedWorkspaceCommands',
    columns: {
      executionId: c.id('execution_id', { primary: true }),
      taskId: c.id('task_id'),
      businessTaskId: c.id('business_task_id'),
      operation: c.text('operation'),
      requestKey: c.id('request_key'),
      requestJson: c.jsonText('request_json'),
      subtaskId: c.id('subtask_id', { nullable: true }),
      attempt: c.int('attempt', { nullable: true }),
      lastCursor: c.text('last_cursor', { nullable: true }),
      outcomeJson: c.jsonText('outcome_json', { nullable: true }),
      state: c.enum('state', ['submitting', 'running', 'settled', 'abandoned']),
      epoch: c.int('epoch'),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    checks: [
      {
        name: 'hosted_workspace_commands_state_known',
        expression: raw(
          "\"hosted_workspace_commands\".\"state\" IN ('submitting', 'running', 'settled', 'abandoned')",
          "\"state\" IN ('submitting', 'running', 'settled', 'abandoned')",
        ),
      },
    ],
    indexes: [
      index('idx_hosted_workspace_commands_state', ['state']),
      index('idx_hosted_workspace_commands_business_task', ['business_task_id', 'state']),
    ],
    retention: retention.business,
  })

  const repoGroupNodesDefinition = owner.table({
    id: 'repo_group_nodes',
    schemaSymbol: 'repoGroupNodes',
    columns: {
      groupId: c.id('group_id'),
      path: c.text('path'),
      attachmentKind: c.enum('attachment_kind', ['repo', 'group'], { nullable: true }),
      cachedRepoId: c.id('cached_repo_id', { nullable: true }),
      ref: c.text('ref', { default: '' }),
      subdir: c.text('subdir', { default: '' }),
      childGroupId: c.id('child_group_id', { nullable: true }),
      readonly: c.bool('readonly', { default: false }),
    },
    primaryKey: ['group_id', 'path'],
    foreignKeys: [
      foreignKey(
        'repo_group_nodes_group_id_repo_groups_id_fk',
        ['group_id'],
        'repo_groups',
        ['id'],
        {
          onDelete: 'cascade',
        },
      ),
      foreignKey(
        'repo_group_nodes_cached_repo_id_cached_repos_id_fk',
        ['cached_repo_id'],
        'cached_repos',
        ['id'],
      ),
    ],
    checks: [
      {
        name: 'repo_group_nodes_attachment_kind_enum',
        expression: raw(
          '"repo_group_nodes"."attachment_kind" IS NULL OR "repo_group_nodes"."attachment_kind" IN (\'repo\',\'group\')',
          '"attachment_kind" IS NULL OR "attachment_kind" IN (\'repo\',\'group\')',
        ),
      },
      {
        name: 'repo_group_nodes_attachment_kind_shape',
        expression: raw(
          '("repo_group_nodes"."attachment_kind" IS NULL AND "repo_group_nodes"."cached_repo_id" IS NULL AND "repo_group_nodes"."child_group_id" IS NULL AND "repo_group_nodes"."ref" = \'\' AND "repo_group_nodes"."subdir" = \'\' AND "repo_group_nodes"."readonly" = 0) OR ("repo_group_nodes"."attachment_kind" = \'repo\' AND "repo_group_nodes"."cached_repo_id" IS NOT NULL AND "repo_group_nodes"."child_group_id" IS NULL) OR ("repo_group_nodes"."attachment_kind" = \'group\' AND "repo_group_nodes"."child_group_id" IS NOT NULL AND "repo_group_nodes"."cached_repo_id" IS NULL AND "repo_group_nodes"."ref" = \'\' AND "repo_group_nodes"."subdir" = \'\')',
          '("attachment_kind" IS NULL AND "cached_repo_id" IS NULL AND "child_group_id" IS NULL AND "ref" = \'\' AND "subdir" = \'\' AND "readonly" = FALSE) OR ("attachment_kind" = \'repo\' AND "cached_repo_id" IS NOT NULL AND "child_group_id" IS NULL) OR ("attachment_kind" = \'group\' AND "child_group_id" IS NOT NULL AND "cached_repo_id" IS NULL AND "ref" = \'\' AND "subdir" = \'\')',
        ),
      },
    ],
    indexes: [
      index('idx_rgn_cached_repo', ['cached_repo_id']),
      index('idx_rgn_child_group', ['child_group_id']),
      index(
        'idx_rgn_path_ci',
        ['group_id', raw('lower("repo_group_nodes"."path")', 'lower("path")')],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const repoGroupsDefinition = owner.table({
    id: 'repo_groups',
    schemaSymbol: 'repoGroups',
    columns: {
      id: c.id('id', { primary: true }),
      name: c.text('name'),
      description: c.text('description', { default: '' }),
      version: c.int('version', { default: 1 }),
      createdByUserId: c.id('created_by_user_id', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
      schemaVersion: c.int('schema_version', { default: 1 }),
    },
    indexes: [
      index('idx_repo_groups_name_ci', [raw('lower("repo_groups"."name")', 'lower("name")')], {
        unique: true,
      }),
    ],
    retention: retention.business,
  })

  const repositoryTransportConnectionsDefinition = owner.table({
    id: 'repository_transport_connections',
    schemaSymbol: 'repositoryTransportConnections',
    columns: {
      provider: c.enum('provider', ['gitlab', 'github'], { primary: true }),
      connectionGeneration: c.text('connection_generation'),
      endpointBindingDigest: c.id('endpoint_binding_digest'),
      apiBaseUrl: c.text('api_base_url'),
      rejectUnauthorized: c.bool('reject_unauthorized'),
      transportMappingsJson: c.jsonText('transport_mappings_json'),
      allowedHttpBaseUrlsJson: c.jsonText('allowed_http_base_urls_json'),
      globalTokenEnc: c.text('global_token_enc'),
      globalTokenHint: c.text('global_token_hint'),
      credentialRevision: c.int('credential_revision', { default: 1 }),
      updatedAt: c.epochMs('updated_at'),
      updatedBy: c.text('updated_by', { nullable: true }),
    },
    checks: [
      {
        name: 'repository_transport_connections_generation_length',
        expression: raw(
          'length("repository_transport_connections"."connection_generation") BETWEEN 1 AND 128',
          'length("connection_generation") BETWEEN 1 AND 128',
        ),
      },
      {
        name: 'repository_transport_connections_provider_enum',
        expression: raw(
          '"repository_transport_connections"."provider" IN (\'gitlab\', \'github\')',
          "\"provider\" IN ('gitlab', 'github')",
        ),
      },
      {
        name: 'repository_transport_connections_endpoint_binding_digest_length',
        expression: raw(
          'length("repository_transport_connections"."endpoint_binding_digest") = 64 AND "repository_transport_connections"."endpoint_binding_digest" NOT GLOB \'*[^0-9a-f]*\'',
          'length("endpoint_binding_digest") = 64 AND "endpoint_binding_digest" !~ \'[^0-9a-f]\'',
        ),
      },
      {
        name: 'repository_transport_connections_reject_unauthorized_boolean',
        expression: raw(
          '"repository_transport_connections"."reject_unauthorized" IN (0, 1)',
          '"reject_unauthorized" IN (FALSE, TRUE)',
        ),
      },
      {
        name: 'repository_transport_connections_transport_mappings_json_json_valid',
        expression: raw(
          'json_valid("repository_transport_connections"."transport_mappings_json")',
          'json_valid("transport_mappings_json")',
        ),
      },
      {
        name: 'repository_transport_connections_allowed_http_base_urls_json_json_valid',
        expression: raw(
          'json_valid("repository_transport_connections"."allowed_http_base_urls_json")',
          'json_valid("allowed_http_base_urls_json")',
        ),
      },
      {
        name: 'repository_transport_connections_credential_revision_positive',
        expression: raw(
          '"repository_transport_connections"."credential_revision" > 0',
          '"credential_revision" > 0',
        ),
      },
    ],
    indexes: [
      index(
        'repository_transport_connections_provider_generation_uq',
        ['provider', 'connection_generation'],
        { unique: true },
      ),
    ],
    retention: retention.business,
  })

  const scPreparationOperationsDefinition = owner.table({
    id: 'sc_preparation_operations',
    schemaSymbol: 'scPreparationOperations',
    columns: {
      id: c.id('id', { primary: true }),
      snapshotRef: c.id('snapshot_ref'),
      state: c.enum(
        'state',
        ['planned', 'resolving', 'materializing', 'prepared', 'failed', 'stopped', 'cleaned'],
        { default: 'planned' },
      ),
      version: c.int('version', { default: 0 }),
      resolvedJson: c.jsonText('resolved_json', { nullable: true }),
      receiptRef: c.id('receipt_ref', {
        nullable: true,
        unique: 'sc_preparation_operations_receipt_ref_unique',
      }),
      receiptJson: c.jsonText('receipt_json', { nullable: true }),
      failureCode: c.text('failure_code', { nullable: true }),
      diagnosticsJson: c.jsonText('diagnostics_json', { nullable: true }),
      createdAt: c.epochMs('created_at'),
      updatedAt: c.epochMs('updated_at'),
    },
    foreignKeys: [
      foreignKey(
        'sc_preparation_operations_snapshot_ref_sc_repository_snapshots_id_fk',
        ['snapshot_ref'],
        'sc_repository_snapshots',
        ['id'],
      ),
    ],
    retention: retention.operational,
  })

  const scRepositorySnapshotsDefinition = owner.table({
    id: 'sc_repository_snapshots',
    schemaSymbol: 'scRepositorySnapshots',
    columns: {
      id: c.id('id', { primary: true }),
      sourceRef: c.id('source_ref'),
      revision: c.text('revision'),
      factsJson: c.jsonText('facts_json'),
      createdAt: c.epochMs('created_at'),
    },
    foreignKeys: [
      foreignKey(
        'sc_repository_snapshots_source_ref_sc_repository_sources_id_fk',
        ['source_ref'],
        'sc_repository_sources',
        ['id'],
      ),
    ],
    retention: retention.business,
  })

  const scRepositorySourcesDefinition = owner.table({
    id: 'sc_repository_sources',
    schemaSymbol: 'scRepositorySources',
    columns: {
      id: c.id('id', { primary: true }),
      requestKey: c.id('request_key', { unique: 'sc_repository_sources_request_key_unique' }),
      requestDigest: c.id('request_digest'),
      kind: c.enum('kind', ['repository', 'repository-group', 'public-url']),
      factsJson: c.jsonText('facts_json'),
      createdAt: c.epochMs('created_at'),
    },
    retention: retention.business,
  })

  const schemaContribution = owner.contribution([
    cachedReposDefinition,
    hostedTaskWorkspacesDefinition,
    hostedWorkspaceCommandsDefinition,
    repoGroupNodesDefinition,
    repoGroupsDefinition,
    repositoryTransportConnectionsDefinition,
    scPreparationOperationsDefinition,
    scRepositorySnapshotsDefinition,
    scRepositorySourcesDefinition,
  ])

  return { schemaContribution }
})()

const frozen16 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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

  const schemaContribution = owner.contribution([
    applicationConfigurationDefinition,
    hostedDatabaseBackupsDefinition,
    hostedExecutionControlDefinition,
    lifecycleAlertsDefinition,
    lifecycleRepairAuditDefinition,
    maintenanceRunsDefinition,
    maintenanceStateDefinition,
    recoveryEventsDefinition,
  ])

  return { schemaContribution }
})()

const frozen17 = (() => {
  // RFC-395 I-a: explicit epoch-1 schema contributions; no physical or runtime change.

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
      retryAuthority: c.enum(
        'retry_authority',
        ['none', 'probe', 'convergent', 'transport-policy'],
        {
          default: 'none',
        },
      ),
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
        expression: raw(
          '"task_execution_effects"."last_attempt_no" >= 0',
          '"last_attempt_no" >= 0',
        ),
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
      catalogVisibility: c.enum('catalog_visibility', ['public', 'internal'], {
        default: 'public',
      }),
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
      workspacePruneCause: c.enum('workspace_prune_cause', ['webhook-terminal'], {
        nullable: true,
      }),
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
      kind: c.enum('kind', [
        'chat',
        'dispatch',
        'result',
        'delivery',
        'decision',
        'system',
        'nudge',
      ]),
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

  const schemaContribution = owner.contribution([
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

  return { schemaContribution }
})()

export const frozenEpoch1Registry = createSchemaRegistry([
  frozen0.schemaContribution,
  frozen0.historySchemaContribution,
  frozen1.schemaContribution,
  frozen2.schemaContribution,
  frozen3.schemaContribution,
  frozen4.schemaContribution,
  frozen5.schemaContribution,
  frozen6.schemaContribution,
  frozen7.schemaContribution,
  frozen8.schemaContribution,
  frozen9.schemaContribution,
  frozen10.schemaContribution,
  frozen11.schemaContribution,
  frozen12.schemaContribution,
  frozen13.schemaContribution,
  frozen14.schemaContribution,
  frozen15.schemaContribution,
  frozen16.schemaContribution,
  frozen17.schemaContribution,
])
