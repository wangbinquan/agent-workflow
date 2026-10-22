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

export const committedEventAggregateHeads = materializeDrizzle(
  committedEventAggregateHeadsDefinition,
).table

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
      expression: raw('"committed_event_deliveries"."attempt_count" >= 0', '"attempt_count" >= 0'),
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
    index('idx_committed_event_deliveries_consumer_state', ['consumer_id', 'state', 'updated_at']),
  ],
  retention: retention.operational,
})

export const committedEventDeliveries = materializeDrizzle(committedEventDeliveriesDefinition).table

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

export const committedEventFamilyCutovers = materializeDrizzle(
  committedEventFamilyCutoversDefinition,
).table

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

export const committedEvents = materializeDrizzle(committedEventsDefinition).table

export const schemaContribution = owner.contribution([
  committedEventAggregateHeadsDefinition,
  committedEventDeliveriesDefinition,
  committedEventFamilyCutoversDefinition,
  committedEventsDefinition,
])
