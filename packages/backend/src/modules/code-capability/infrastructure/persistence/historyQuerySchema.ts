// RFC-602: rebuildable query projections. Original archives and ID indexes remain immutable.
import {
  column as c,
  defineContribution,
  foreignKey,
  index,
  retention,
} from '@/platform/persistence/schema/dsl'
import { materializeDrizzle } from '@/platform/persistence/schema/drizzle'
import type { SchemaExpression } from '@/platform/persistence/schema/expressions'

const owner = defineContribution('code-capability/history')
const descending = (name: string): SchemaExpression => ({
  kind: 'unary',
  op: 'DESC',
  value: { kind: 'column', name },
})
const buildForeignKey = (table: string) =>
  foreignKey(`${table}_build_fk`, ['build_id'], 'code_history_query_builds', ['id'], {
    onDelete: 'cascade',
    lifecycle: 'Derived rows belong to one build; only unreferenced builds may be removed.',
  })

const statesDefinition = owner.table({
  id: 'code_history_query_states',
  schemaSymbol: 'codeHistoryQueryStates',
  columns: {
    sourceGeneration: c.id('source_generation'),
    sourceContract: c.text('source_contract'),
    projectionVersion: c.int('projection_version'),
    activeBuildId: c.id('active_build_id', { nullable: true }),
    lastAttemptId: c.id('last_attempt_id', { nullable: true }),
    state: c.enum('state', ['ready', 'unavailable']),
    failureCode: c.text('failure_code', { nullable: true }),
    failureDetail: c.text('failure_detail', { nullable: true }),
    updatedAt: c.epochMs('updated_at'),
  },
  primaryKey: ['source_generation', 'source_contract', 'projection_version'],
  retention: retention.operational,
})

const buildsDefinition = owner.table({
  id: 'code_history_query_builds',
  schemaSymbol: 'codeHistoryQueryBuilds',
  columns: {
    id: c.id('id', { primary: true }),
    sourceGeneration: c.id('source_generation'),
    sourceContract: c.text('source_contract'),
    projectionVersion: c.int('projection_version'),
    manifestDigest: c.text('manifest_digest'),
    archiveManifestJson: c.jsonText('archive_manifest_json'),
    state: c.enum('state', ['building', 'ready', 'failed', 'superseded']),
    countsJson: c.jsonText('counts_json'),
    errorCode: c.text('error_code', { nullable: true }),
    errorDetail: c.text('error_detail', { nullable: true }),
    createdAt: c.epochMs('created_at'),
    completedAt: c.epochMs('completed_at', { nullable: true }),
  },
  indexes: [
    index('idx_code_history_query_builds_source', [
      'source_generation',
      'source_contract',
      'projection_version',
      'state',
    ]),
  ],
  retention: retention.operational,
})

const recordsDefinition = owner.table({
  id: 'code_history_query_records',
  schemaSymbol: 'codeHistoryQueryRecords',
  columns: {
    buildId: c.id('build_id'),
    sourceTable: c.text('source_table'),
    originalId: c.id('original_id'),
    archiveId: c.id('archive_id'),
    recordOrdinal: c.int('record_ordinal'),
    originalKeyJson: c.jsonText('original_key_json'),
    recordPayloadJson: c.jsonText('record_payload_json'),
  },
  primaryKey: ['build_id', 'source_table', 'original_id'],
  indexes: [
    index('uniq_code_history_query_record_ordinal', ['build_id', 'archive_id', 'record_ordinal'], {
      unique: true,
    }),
  ],
  foreignKeys: [buildForeignKey('code_history_query_records')],
  retention: retention.operational,
})

// Every supported equality-filter subset retains the same bounded keyset order.
const workItemFilters = [
  [],
  ['code_host_endpoint_id'],
  ['stable_project_id'],
  ['capability'],
  ['code_host_endpoint_id', 'stable_project_id'],
  ['code_host_endpoint_id', 'capability'],
  ['stable_project_id', 'capability'],
  ['code_host_endpoint_id', 'stable_project_id', 'capability'],
] as const
const workItemsDefinition = owner.table({
  id: 'code_history_query_work_items',
  schemaSymbol: 'codeHistoryQueryWorkItems',
  columns: {
    buildId: c.id('build_id'),
    id: c.id('id'),
    codeHostEndpointId: c.id('code_host_endpoint_id'),
    stableProjectId: c.id('stable_project_id'),
    capability: c.text('capability'),
    anchorKind: c.text('anchor_kind'),
    anchorId: c.id('anchor_id'),
    status: c.text('status'),
    epoch: c.int('epoch'),
    createdAt: c.epochMs('created_at'),
    roundCount: c.int('round_count'),
    idOrderKey: c.text('id_order_key'),
  },
  primaryKey: ['build_id', 'id'],
  indexes: workItemFilters.map((filters, ordinal) =>
    index(`idx_code_history_query_items_page_${ordinal}`, [
      'build_id',
      ...filters,
      descending('created_at'),
      descending('id_order_key'),
    ]),
  ),
  foreignKeys: [buildForeignKey('code_history_query_work_items')],
  retention: retention.operational,
})

const roundsDefinition = owner.table({
  id: 'code_history_query_rounds',
  schemaSymbol: 'codeHistoryQueryRounds',
  columns: {
    buildId: c.id('build_id'),
    id: c.id('id'),
    workItemId: c.id('work_item_id'),
    rank: c.int('rank'),
    sourceOrdinal: c.int('source_ordinal'),
    roundSeq: c.int('round_seq'),
    outcome: c.text('outcome', { nullable: true }),
    stageContractVer: c.int('stage_contract_ver'),
    baselineSha: c.text('baseline_sha', { nullable: true }),
    startedAt: c.epochMs('started_at'),
    endedAt: c.epochMs('ended_at', { nullable: true }),
  },
  primaryKey: ['build_id', 'id'],
  indexes: [index('idx_code_history_query_rounds_item_rank', ['build_id', 'work_item_id', 'rank'])],
  foreignKeys: [buildForeignKey('code_history_query_rounds')],
  retention: retention.operational,
})

const stagesDefinition = owner.table({
  id: 'code_history_query_stages',
  schemaSymbol: 'codeHistoryQueryStages',
  columns: {
    buildId: c.id('build_id'),
    id: c.id('id'),
    roundId: c.id('round_id'),
    stageName: c.text('stage_name'),
    stageSeq: c.int('stage_seq'),
    stageKind: c.text('stage_kind'),
    status: c.text('status'),
    error: c.text('error', { nullable: true }),
    startedAt: c.epochMs('started_at', { nullable: true }),
    endedAt: c.epochMs('ended_at', { nullable: true }),
    sourceOrdinal: c.int('source_ordinal'),
  },
  primaryKey: ['build_id', 'id'],
  indexes: [
    index('idx_code_history_query_stages_round', [
      'build_id',
      'round_id',
      'stage_seq',
      'source_ordinal',
    ]),
  ],
  foreignKeys: [buildForeignKey('code_history_query_stages')],
  retention: retention.operational,
})

const attemptsDefinition = owner.table({
  id: 'code_history_query_attempts',
  schemaSymbol: 'codeHistoryQueryAttempts',
  columns: {
    buildId: c.id('build_id'),
    id: c.id('id'),
    roundId: c.id('round_id'),
    stageName: c.text('stage_name'),
    shardKey: c.text('shard_key'),
    rerunSeq: c.int('rerun_seq'),
    attemptSeq: c.int('attempt_seq'),
    status: c.text('status'),
    validationOutcome: c.text('validation_outcome', { nullable: true }),
    sessionRef: c.text('session_ref', { nullable: true }),
    nodeRunId: c.id('node_run_id', { nullable: true }),
    startedAt: c.epochMs('started_at'),
    endedAt: c.epochMs('ended_at', { nullable: true }),
    sourceOrdinal: c.int('source_ordinal'),
  },
  primaryKey: ['build_id', 'id'],
  indexes: [
    index('idx_code_history_query_attempts_round', [
      'build_id',
      'round_id',
      'started_at',
      'rerun_seq',
      'attempt_seq',
      'source_ordinal',
    ]),
  ],
  foreignKeys: [buildForeignKey('code_history_query_attempts')],
  retention: retention.operational,
})

const deliveryFilters = [
  [],
  ['stable_project_id'],
  ['correlation_id'],
  ['outcome'],
  ['outcome', 'stable_project_id'],
] as const
const deliveriesDefinition = owner.table({
  id: 'code_history_query_deliveries',
  schemaSymbol: 'codeHistoryQueryDeliveries',
  columns: {
    buildId: c.id('build_id'),
    id: c.id('id'),
    correlationId: c.id('correlation_id'),
    stableProjectId: c.id('stable_project_id', { nullable: true }),
    capability: c.text('capability', { nullable: true }),
    step: c.text('step'),
    outcome: c.text('outcome'),
    reason: c.text('reason', { nullable: true }),
    queuedAt: c.epochMs('queued_at', { nullable: true }),
    queuePosition: c.int('queue_position', { nullable: true }),
    waitingOn: c.text('waiting_on', { nullable: true }),
    roundId: c.id('round_id', { nullable: true }),
    isProbe: c.bool('is_probe'),
    createdAt: c.epochMs('created_at'),
    updatedAt: c.epochMs('updated_at'),
    sourceOrdinal: c.int('source_ordinal'),
  },
  primaryKey: ['build_id', 'id'],
  indexes: deliveryFilters.map((filters, ordinal) =>
    index(`idx_code_history_query_deliveries_page_${ordinal}`, [
      'build_id',
      ...filters,
      descending('created_at'),
      'source_ordinal',
    ]),
  ),
  foreignKeys: [buildForeignKey('code_history_query_deliveries')],
  retention: retention.operational,
})

const metricCounters = {
  published: c.int('published'),
  adopted: c.int('adopted'),
  quietFix: c.int('quiet_fix'),
  disagreed: c.int('disagreed'),
  outstanding: c.int('outstanding'),
  rounds: c.int('rounds'),
  runPublished: c.int('run_published'),
  runFailed: c.int('run_failed'),
  runAwaiting: c.int('run_awaiting'),
  incomplete: c.int('incomplete'),
} as const
const metricTotalsDefinition = owner.table({
  id: 'code_history_metric_totals',
  schemaSymbol: 'codeHistoryMetricTotals',
  columns: { buildId: c.id('build_id'), capability: c.text('capability'), ...metricCounters },
  primaryKey: ['build_id', 'capability'],
  foreignKeys: [buildForeignKey('code_history_metric_totals')],
  retention: retention.operational,
})
const metricPrefixesDefinition = owner.table({
  id: 'code_history_metric_prefixes',
  schemaSymbol: 'codeHistoryMetricPrefixes',
  columns: {
    buildId: c.id('build_id'),
    capability: c.text('capability'),
    occurredAt: c.epochMs('occurred_at'),
    ...metricCounters,
  },
  primaryKey: ['build_id', 'capability', 'occurred_at'],
  foreignKeys: [buildForeignKey('code_history_metric_prefixes')],
  retention: retention.operational,
})

export const codeHistoryQueryStates = materializeDrizzle(statesDefinition).table
export const codeHistoryQueryBuilds = materializeDrizzle(buildsDefinition).table
export const codeHistoryQueryRecords = materializeDrizzle(recordsDefinition).table
export const codeHistoryQueryWorkItems = materializeDrizzle(workItemsDefinition).table
export const codeHistoryQueryRounds = materializeDrizzle(roundsDefinition).table
export const codeHistoryQueryStages = materializeDrizzle(stagesDefinition).table
export const codeHistoryQueryAttempts = materializeDrizzle(attemptsDefinition).table
export const codeHistoryQueryDeliveries = materializeDrizzle(deliveriesDefinition).table
export const codeHistoryMetricTotals = materializeDrizzle(metricTotalsDefinition).table
export const codeHistoryMetricPrefixes = materializeDrizzle(metricPrefixesDefinition).table

export const historyQuerySchemaContribution = owner.contribution([
  statesDefinition,
  buildsDefinition,
  recordsDefinition,
  workItemsDefinition,
  roundsDefinition,
  stagesDefinition,
  attemptsDefinition,
  deliveriesDefinition,
  metricTotalsDefinition,
  metricPrefixesDefinition,
])
