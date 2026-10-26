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

export const customEventSourceDefinitions = materializeDrizzle(
  customEventSourceDefinitionsDefinition,
).table

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

export const customEventSourceRevisions = materializeDrizzle(
  customEventSourceRevisionsDefinition,
).table

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

export const eventAutomationWorkIntents = materializeDrizzle(
  eventAutomationWorkIntentsDefinition,
).table

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

export const eventDeliveries = materializeDrizzle(eventDeliveriesDefinition).table

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

export const eventObserverRuns = materializeDrizzle(eventObserverRunsDefinition).table

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

export const eventRecords = materializeDrizzle(eventRecordsDefinition).table

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

export const eventResponseRules = materializeDrizzle(eventResponseRulesDefinition).table

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

export const eventSources = materializeDrizzle(eventSourcesDefinition).table

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

export const eventSubscriptions = materializeDrizzle(eventSubscriptionsDefinition).table

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
    index('idx_event_type_catalog_visibility', ['catalog_visibility', 'event_type_id', 'revision']),
  ],
  retention: retention.operational,
})

export const eventTypeCatalog = materializeDrizzle(eventTypeCatalogDefinition).table

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

export const observerActivations = materializeDrizzle(observerActivationsDefinition).table

export const schemaContribution = {
  owner: 'event-center',
  version: 1,
  tables: [
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
  ],
} as const
