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

export const intentApplyJournal = materializeDrizzle(intentApplyJournalDefinition).table

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

export const intentDraftResolutions = materializeDrizzle(intentDraftResolutionsDefinition).table

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

export const intentDrafts = materializeDrizzle(intentDraftsDefinition).table

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

export const intentProvenance = materializeDrizzle(intentProvenanceDefinition).table

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

export const intentSessions = materializeDrizzle(intentSessionsDefinition).table

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

export const intentTurnEvents = materializeDrizzle(intentTurnEventsDefinition).table

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

export const intentTurns = materializeDrizzle(intentTurnsDefinition).table

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

export const intentWorkingSetChanges = materializeDrizzle(intentWorkingSetChangesDefinition).table

export const schemaContribution = owner.contribution([
  intentApplyJournalDefinition,
  intentDraftResolutionsDefinition,
  intentDraftsDefinition,
  intentProvenanceDefinition,
  intentSessionsDefinition,
  intentTurnEventsDefinition,
  intentTurnsDefinition,
  intentWorkingSetChangesDefinition,
])
