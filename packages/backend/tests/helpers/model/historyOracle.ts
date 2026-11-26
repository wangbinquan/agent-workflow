import { expect } from 'bun:test'
import type {
  CodeHistoryQueryTable,
  CodeHistoryValue,
} from '@/modules/code-capability/domain/codeHistoryPackage'
import type { ProviderDatabaseHarness } from '../eachProvider'
import {
  historyFixtureSource,
  seedEmptyCodeHistory,
  seedCodeHistoryRows,
  preparedHistoryFixtureReader,
} from '../legacyCapabilitySeed'
import {
  createCodeWorkItemProjectionQuery,
  createCodeRoundAttemptsQuery,
  createCodeDeliveryChainQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import { createWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/workItemProjectionRead'
import { createRoundAttemptsRead } from '@/modules/code-capability/infrastructure/roundAttemptsRead'
import { createDeliveryChainRead } from '@/modules/code-capability/infrastructure/deliveryChainRead'
import { createCodeMetricsRead } from '@/modules/code-capability/infrastructure/codeMetricsRead'
export function historyProjectionParity<T extends object>(
  kind: 'workItems' | 'attempts' | 'deliveries' | 'metrics',
  source: readonly (readonly (readonly unknown[])[])[],
  oracle: T,
  harness: ProviderDatabaseHarness,
  reads: string[] = [],
): T {
  const project = (columns: string[], row: readonly unknown[]) =>
    Object.fromEntries(columns.map((name, index) => [name, row[index]]))
  let call = 0
  return new Proxy(oracle, {
    get(target, property, receiver) {
      const original: unknown = Reflect.get(target, property, receiver)
      if (typeof original !== 'function') return original
      return async (...args: unknown[]) => {
        const tables: Record<string, Record<string, unknown>[]> = {}
        const request = (args[0] ?? {}) as Record<string, unknown>
        if (kind === 'attempts')
          tables.code_ai_attempts = (source[0] ?? []).map((row) => ({
            ...project(
              [
                'id',
                'stage_name',
                'shard_key',
                'rerun_seq',
                'attempt_seq',
                'status',
                'validation_outcome',
                'session_ref',
                'node_run_id',
                'started_at',
                'ended_at',
              ],
              row,
            ),
            round_id: args[0],
          }))
        if (kind === 'deliveries')
          tables.code_trigger_deliveries = (source[call] ?? []).map((row) => ({
            ...project(
              [
                'id',
                'correlation_id',
                'capability',
                'step',
                'outcome',
                'reason',
                'queued_at',
                'queue_position',
                'waiting_on',
                'round_id',
                'is_probe',
                'created_at',
                'updated_at',
              ],
              row,
            ),
            stable_project_id: request.stableProjectId ?? null,
          }))
        if (kind === 'workItems') {
          tables.code_work_items = (source[0] ?? []).map((row) => ({
            ...project(
              ['id', 'capability', 'anchor_kind', 'anchor_id', 'status', 'epoch', 'created_at'],
              row,
            ),
            stable_project_id: request.stableProjectId,
          }))
          const rounds = (source[2] ?? []).map((row) => ({
            ...project(
              [
                'id',
                'round_seq',
                'outcome',
                'stage_contract_ver',
                'baseline_sha',
                'started_at',
                'ended_at',
              ],
              row,
            ),
            work_item_id: source[0]?.[0]?.[0],
          }))
          const count = Number(source[1]?.[0]?.[0] ?? 0)
          tables.code_work_rounds = [
            ...rounds,
            ...Array.from({ length: Math.max(0, count - rounds.length) }, (_, index) => ({
              ...rounds[0],
              id: 'hidden-' + index,
              round_seq: -index - 1,
            })),
          ]
          tables.code_round_stages = (source[3] ?? []).map((row) => ({
            ...project(
              [
                'stage_name',
                'stage_seq',
                'stage_kind',
                'status',
                'error',
                'started_at',
                'ended_at',
              ],
              row,
            ),
            round_id: source[2]?.[0]?.[0],
          }))
        }
        if (kind === 'metrics') {
          tables.code_findings = (source[0] ?? []).map((row, index) => ({
            ...project(['capability', 'resolved_at', 'code_changed_at'], row),
            id: 'finding-' + index,
            external_id: 'published-' + index,
            created_at: Number(request.now),
          }))
          tables.code_work_items = []
          tables.code_work_rounds = []
          for (const [index, row] of (source[1] ?? []).entries()) {
            const id = 'item-' + index
            tables.code_work_items.push({ id, capability: row[0] })
            for (let n = 0; n < Number(row[3]); n++)
              tables.code_work_rounds.push({
                id: id + '-' + n,
                work_item_id: id,
                outcome: row[1],
                ended_at: row[2],
                started_at: Number(request.now),
              })
          }
        }
        // The frozen SQL result remains the independent compatibility oracle.
        // Actual reads use real immutable packages and the production durable
        // builder on each provider; fixture setup finishes before query recording.
        const fixtureSource = {
          ...historyFixtureSource,
          sourceGeneration: `dbg_history_parity_${kind}_${call}`,
        }
        await seedEmptyCodeHistory(harness.db, fixtureSource)
        for (const [table, records] of Object.entries(tables)) {
          if (records.length > 0)
            await seedCodeHistoryRows(
              harness.db,
              table as CodeHistoryQueryTable,
              records as Record<string, CodeHistoryValue>[],
              fixtureSource,
            )
        }
        const reader = await preparedHistoryFixtureReader(harness.db, fixtureSource)
        const query =
          kind === 'workItems'
            ? createCodeWorkItemProjectionQuery(createWorkItemProjectionRead(reader))
            : kind === 'attempts'
              ? createCodeRoundAttemptsQuery(createRoundAttemptsRead(reader))
              : kind === 'deliveries'
                ? createCodeDeliveryChainQuery(createDeliveryChainRead(reader))
                : createCodeMetricsQuery(createCodeMetricsRead(reader))
        const method = Reflect.get(query, property) as (...values: unknown[]) => Promise<unknown>
        const expected = await Reflect.apply(original, target, args)
        const recording = harness.recordStatements()
        let actual: unknown
        try {
          actual = await method(...args)
        } finally {
          recording.stop()
        }
        for (const statement of recording.selects()) {
          expect(statement.sql).not.toMatch(/content_inline_bytes/)
          const table =
            /\bfrom\s+(?:"[^"]+"\.)?"?(code_history_(?:query_(?:work_items|rounds|stages|attempts|deliveries)|metric_(?:totals|prefixes)))"?/i.exec(
              statement.sql,
            )?.[1]
          if (table !== undefined) reads.push(table)
        }
        expect(actual).toEqual(expected)
        call++
        return actual
      }
    },
  })
}
