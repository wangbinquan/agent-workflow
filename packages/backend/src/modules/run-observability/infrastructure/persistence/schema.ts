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

export const observationCallModels = materializeDrizzle(observationCallModelsDefinition).table

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

export const observationCalls = materializeDrizzle(observationCallsDefinition).table

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

export const observationPrices = materializeDrizzle(observationPricesDefinition).table

export const schemaContribution = {
  owner: 'run-observability',
  version: 1,
  tables: [
    observationCallModelsDefinition,
    observationCallsDefinition,
    observationPricesDefinition,
  ],
} as const
