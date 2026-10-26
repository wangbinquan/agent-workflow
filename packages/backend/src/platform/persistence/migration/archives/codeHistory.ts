import type { ConversionRule } from '../conversion/rule'
import { packageHistoryTable } from './package'
import {
  acknowledgeableWorkTables,
  unfinishedCodeWork,
  unfinishedWorkPredicates,
} from './unfinishedWork'
import {
  HISTORY_ADOPTIONS,
  HISTORY_MISSIONS,
  HISTORY_ROUNDS,
  HISTORY_WORK_ITEMS,
} from './adoptions'

export const historySourceTables = [
  'code_ai_attempts',
  'code_artifacts',
  'code_findings',
  'code_fix_attempts',
  'code_mr_leases',
  'code_produced_mrs',
  'code_publish_intents',
  'code_round_stages',
  'code_trigger_deliveries',
  'code_work_items',
  'code_work_observations',
  'code_work_rounds',
  'legacy_code_work_item_links',
] as const
const groupColumns: Readonly<Record<string, string>> = {
  code_mr_leases: 'lease_key',
  code_produced_mrs: 'mr_key',
  code_publish_intents: 'batch_id',
}

export function historyRule(table: string, absentTables: readonly string[] = []): ConversionRule {
  return {
    ref: {
      id: `history/${table}`,
      version: acknowledgeableWorkTables.some((name) => name === table)
        ? 3
        : table in unfinishedWorkPredicates
          ? 2
          : 1,
    },
    owner: 'platform/persistence/migration/archives',
    claims: [table],
    produces: [{ table: 'code_history_archives' }, { table: 'code_history_id_index' }],
    lookups:
      table === 'legacy_code_work_item_links'
        ? [HISTORY_MISSIONS, HISTORY_ROUNDS, HISTORY_WORK_ITEMS, HISTORY_ADOPTIONS]
        : ['code_work_items', 'code_work_rounds'].includes(table)
          ? [HISTORY_ADOPTIONS]
          : [],
    // The target unique key is one package per source generation/contract/table.
    // All string-key groups form one unit, including a zero-row table.
    unit: {
      kind: 'group',
      driver: table,
      groupColumn: groupColumns[table] ?? 'id',
      members: [],
      groupsPerUnit: Number.MAX_SAFE_INTEGER,
    },
    convert(unit, ctx) {
      const rows = unit.rows.get(table)!
      for (const absent of absentTables) {
        const packaged = packageHistoryTable(absent, [], ctx)
        ctx.out.archive({
          kind: 'retired-table',
          sourceTable: absent,
          format: 'logical-row@1',
          bytes: packaged.bytes,
          rows: 0,
        })
        ctx.out.row('code_history_archives', packaged.archive, null)
        ctx.out.record({
          kind: 'decision',
          code: 'v2-code-history-originally-absent-table',
          payload: {
            table: absent,
            sourceContract: ctx.preflight.contract!.digest,
            sourceFingerprint: ctx.preflight.fingerprint.digest,
          },
        })
      }
      const unfinished = new Map(
        rows.flatMap((row) => {
          const block = unfinishedCodeWork(row, ctx)
          return block ? [[row.encodedKey, block] as const] : []
        }),
      )
      const blocks = rows.flatMap((row) => {
        const block = unfinished.get(row.encodedKey)
        return block && !ctx.operatorDecisions?.find(row, 'v2-code-history-unfinished')
          ? [block]
          : []
      })
      if (blocks.length) {
        for (const block of blocks) ctx.out.block(block)
        ctx.out.block({
          code: 'v2-code-history-package-blocked',
          scope: 'table',
          sourceTable: table,
          sourceKey: null,
          taskId: null,
          runId: null,
          missingFields: [],
          detail: { unfinishedKeys: blocks.map((block) => block.sourceKey) },
        })
        return
      }
      const packaged = packageHistoryTable(table, rows, ctx)
      const archiveRef = ctx.out.archive({
        kind: 'retired-table',
        sourceTable: table,
        format: 'logical-row@1',
        bytes: packaged.bytes,
        rows: rows.length,
      })
      ctx.out.row('code_history_archives', packaged.archive, null)
      for (const { row, values } of packaged.index) {
        const acknowledgement = unfinished.has(row.encodedKey)
          ? (ctx.operatorDecisions?.consume(row, 'v2-code-history-unfinished') ?? null)
          : null
        ctx.out.row('code_history_id_index', values, row)
        ctx.out.exception({
          sourceTable: table,
          sourceKey: row.encodedKey,
          class: 'archived',
          kind: 'archived',
          targets: [
            {
              table: 'code_history_archives',
              key: ctx.target.key('code_history_archives', packaged.archive),
            },
            {
              table: 'code_history_id_index',
              key: ctx.target.key('code_history_id_index', values),
            },
          ],
          archive: archiveRef,
          decision: {
            code: acknowledgement
              ? 'v2-code-history-acknowledged-unfinished'
              : ['code_work_items', 'code_work_rounds', 'legacy_code_work_item_links'].includes(
                    table,
                  ) && ctx.lookup(HISTORY_ADOPTIONS).get(row.encodedKey)
                ? 'v2-code-history-adopted'
                : table === 'code_trigger_deliveries'
                  ? 'v2-code-delivery-history'
                  : 'v2-code-history-packaged',
            detail: {
              sourceContract: ctx.preflight.contract!.digest,
              recordOrdinal: values.record_ordinal,
              ...(acknowledgement
                ? {
                    acknowledgement,
                    ...unfinishedWorkPredicates[table as keyof typeof unfinishedWorkPredicates],
                  }
                : {}),
              ...(['code_work_items', 'code_work_rounds', 'legacy_code_work_item_links'].includes(
                table,
              )
                ? {
                    adoptions: (ctx.lookup(HISTORY_ADOPTIONS).get(row.encodedKey) ?? []).map(
                      ({ linkKey, missionId, receipt }) => ({ linkKey, missionId, receipt }),
                    ),
                  }
                : {}),
              ...(table === 'code_trigger_deliveries'
                ? {
                    dispatch:
                      row.values.outcome === 'ok' &&
                      ['received', 'matched', 'routed'].includes(String(row.values.step))
                        ? 'interrupted'
                        : 'recorded',
                    step: row.values.step as string,
                    outcome: row.values.outcome as string,
                    roundId: row.values.round_id as string | null,
                  }
                : {}),
            },
          },
        })
      }
    },
  }
}
