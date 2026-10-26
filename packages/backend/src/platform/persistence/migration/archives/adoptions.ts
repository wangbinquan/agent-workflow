import {
  columnLookup,
  idSetLookup,
  lookupKey,
  type LookupBuilder,
  type LookupResolver,
} from '../conversion/lookups'
import { canonicalValue, encodeMigrationKey } from '../conversion/migrationKey'
import type { EncodedKey, SourceRow } from '../conversion/types'

export const HISTORY_WORK_ITEMS = columnLookup(
  'code_work_items',
  ['id'],
  ['status', 'pending_generation', 'publishing_epoch', 'pending_revision'],
).key
export const HISTORY_ROUNDS = columnLookup('code_work_rounds', ['id'], ['outcome', 'ended_at']).key
export const HISTORY_MISSIONS = idSetLookup('development_missions', 'id').key

export interface HistoryAdoption {
  readonly linkKey: EncodedKey
  readonly missionId: string
  readonly receipt: string
}
export const HISTORY_ADOPTIONS = lookupKey<readonly HistoryAdoption[]>('history/adoptions', 1)

export function adoptionFailure(row: SourceRow, lookup: LookupResolver): string | null {
  const value = row.values
  if (typeof value.mission_id !== 'string' || !lookup(HISTORY_MISSIONS).get(value.mission_id))
    return 'destination-mission-missing'
  if (typeof value.cutover_receipt_json !== 'string') return 'receipt-unproven'
  let receipt: unknown
  try {
    receipt = JSON.parse(value.cutover_receipt_json)
  } catch {
    return 'receipt-unproven'
  }
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('observedState' in receipt) ||
    typeof receipt.observedState !== 'string' ||
    !['opened', 'merged', 'closed'].includes(receipt.observedState) ||
    !('headSha' in receipt) ||
    !(receipt.headSha === null || typeof receipt.headSha === 'string') ||
    !('targetBranch' in receipt) ||
    !(receipt.targetBranch === null || typeof receipt.targetBranch === 'string') ||
    !('adoptedAt' in receipt) ||
    !Number.isSafeInteger(receipt.adoptedAt)
  )
    return 'receipt-unproven'
  for (const [column, key] of [
    ['legacy_work_item_id', HISTORY_WORK_ITEMS],
    ['legacy_round_id', HISTORY_ROUNDS],
  ] as const) {
    const id = value[column]
    // Existence, not the retired writer's status, proves the named handover.
    // CORE-7 includes present-but-undecodable rows in these identity lookups.
    if (id !== null && (typeof id !== 'string' || !lookup(key).get(id))) return `${column}-missing`
  }
  return null
}

export const historyAdoptionsLookup: LookupBuilder<readonly HistoryAdoption[]> = {
  key: HISTORY_ADOPTIONS,
  sources: ['legacy_code_work_item_links'],
  dependsOn: [HISTORY_MISSIONS, HISTORY_WORK_ITEMS, HISTORY_ROUNDS],
  build(staged, put, lookup) {
    const proofs = new Map<string, HistoryAdoption[]>()
    for (const row of staged.rows('legacy_code_work_item_links')) {
      if (row.codecFailure || adoptionFailure(row, lookup)) continue
      const proof: HistoryAdoption = {
        linkKey: row.encodedKey,
        missionId: row.values.mission_id as string,
        receipt: row.values.cutover_receipt_json as string,
      }
      const keys = [row.encodedKey]
      for (const [column, table] of [
        ['legacy_work_item_id', 'code_work_items'],
        ['legacy_round_id', 'code_work_rounds'],
      ] as const)
        if (typeof row.values[column] === 'string')
          keys.push(encodeMigrationKey(table, [canonicalValue(row.values[column])]))
      for (const key of keys) {
        const entries = proofs.get(key) ?? []
        entries.push(proof)
        proofs.set(key, entries)
      }
    }
    for (const [key, entries] of proofs)
      put(
        key,
        entries.sort((a, b) => (a.linkKey < b.linkKey ? -1 : a.linkKey > b.linkKey ? 1 : 0)),
      )
  },
}
