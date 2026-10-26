import { rowBlock } from '../conversion/blockCodes'
import type { RuleContext } from '../conversion/rule'
import type { ConversionBlock, SourceRow } from '../conversion/types'
import { operatorDecisionRowDigest } from '../conversion/types'
import type { DecodedSourceRow } from '../sourceTypes'
import { adoptionFailure, HISTORY_ADOPTIONS } from './adoptions'

export const acknowledgeableWorkTables = [
  'code_ai_attempts',
  'code_round_stages',
  'code_work_items',
  'code_work_rounds',
  'legacy_code_work_item_links',
] as const

export const unfinishedWorkPredicates = {
  code_ai_attempts: {
    predicate: "status NOT IN ('validated','failed','interrupted') OR ended_at IS NULL",
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/infrastructure/sqliteAttemptRecorder.ts:39-49,100-109',
  },
  code_findings: {
    predicate: 'false: findings are ledger facts, not unfinished work',
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/infrastructure/sqliteFindingLedger.ts:102-145,181-217',
  },
  code_round_stages: {
    predicate: "status NOT IN ('done','failed','skipped','inherited') OR ended_at IS NULL",
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/application/stageEngine.ts:224-241,264-323',
  },
  code_trigger_deliveries: {
    predicate: 'false: deliveries are dispatch history; work liveness belongs to items and rounds',
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/infrastructure/sqliteDeliveryChain.ts:37-56,78-95; packages/backend/src/services/webhook/webhookDispatch.ts:1223-1369',
  },
  code_work_items: {
    predicate:
      "NOT valid_adoption AND (status NOT IN ('idle','settled','failed','closed') OR pending_generation IS NOT NULL OR publishing_epoch IS NOT NULL OR pending_revision IS NOT NULL)",
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/domain/workItemLifecycle.ts:289-338; packages/backend/src/modules/code-capability/infrastructure/sqliteWorkItemStore.ts:127-146,171-176,198-233',
  },
  code_work_rounds: {
    predicate:
      "NOT valid_adoption AND (outcome IS NULL OR outcome NOT IN ('published','failed','canceled','superseded') OR ended_at IS NULL)",
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/code-capability/infrastructure/sqliteMonitorStore.ts:180-207; packages/backend/src/modules/code-capability/application/stageEngine.ts:224-241',
  },
  legacy_code_work_item_links: {
    predicate:
      'adoption receipt unproven OR destination mission missing OR a non-NULL referenced legacy work item/round missing',
    source:
      '7a73ec97d72848aba752382d531111941d08dd4c:packages/backend/src/modules/development-automation/application/cutover.ts:63-68,175-187; packages/backend/src/modules/integration/application/mrEnsure.ts:219-225,253-257',
  },
} as const

function unfinishedItem(values: DecodedSourceRow): boolean {
  return (
    !['idle', 'settled', 'failed', 'closed'].includes(String(values.status)) ||
    values.pending_generation !== null ||
    values.publishing_epoch !== null ||
    values.pending_revision !== null
  )
}
function unfinishedRound(values: DecodedSourceRow): boolean {
  return (
    !['published', 'failed', 'canceled', 'superseded'].includes(String(values.outcome)) ||
    values.ended_at === null
  )
}
export function unfinishedCodeWork(row: SourceRow, ctx: RuleContext): ConversionBlock | null {
  const v = row.values
  let unfinished: boolean
  switch (row.table) {
    case 'code_ai_attempts':
      unfinished =
        !['validated', 'failed', 'interrupted'].includes(String(v.status)) || v.ended_at === null
      break
    case 'code_findings':
      return null
    case 'code_round_stages':
      unfinished =
        !['done', 'failed', 'skipped', 'inherited'].includes(String(v.status)) ||
        v.ended_at === null
      break
    case 'code_trigger_deliveries':
      return null
    case 'code_work_items':
      unfinished = !ctx.lookup(HISTORY_ADOPTIONS).get(row.encodedKey) && unfinishedItem(v)
      break
    case 'code_work_rounds':
      unfinished = !ctx.lookup(HISTORY_ADOPTIONS).get(row.encodedKey) && unfinishedRound(v)
      break
    case 'legacy_code_work_item_links':
      unfinished = adoptionFailure(row, ctx.lookup) !== null
      break
    default:
      return null
  }
  if (!unfinished) return null
  const evidence = unfinishedWorkPredicates[row.table as keyof typeof unfinishedWorkPredicates]
  return {
    ...rowBlock(
      'v2-code-history-unfinished',
      row,
      { ...evidence, original: row.canonical, rowDigest: operatorDecisionRowDigest(row) },
      Object.keys(v),
    ),
    acknowledgeable: true,
  }
}
