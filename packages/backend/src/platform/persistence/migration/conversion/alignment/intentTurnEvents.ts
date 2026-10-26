import { lookupKey, columnLookupKey, type LookupBuilder } from '../lookups'
import { rowBlock } from '../blockCodes'
import type { RowValidator } from '../rule'
import { alignmentRule, copyAlignedRow } from './common'

const uniqueKeys = [
  { name: 'uniq_intent_turn_events_turn_seq', columns: ['turn_id', 'event_seq'] },
  { name: 'uniq_intent_turn_events_external', columns: ['turn_id', 'source', 'external_event_id'] },
] as const

export const intentEventConflicts: LookupBuilder<
  readonly { readonly index: string; readonly keys: readonly string[] }[]
> = {
  key: lookupKey('alignment/intent-event-conflicts', 1),
  sources: ['intent_turn_events'],
  build(staged, put) {
    const groups = new Map<string, { index: string; keys: string[] }>()
    for (const row of staged.rows('intent_turn_events')) {
      if (row.codecFailure) continue
      for (const index of uniqueKeys) {
        if (
          index.name === 'uniq_intent_turn_events_external' &&
          row.values.external_event_id === null
        )
          continue
        const key = columnLookupKey(
          index.name,
          index.columns.map((column) => row.values[column]!),
        )
        const group = groups.get(key) ?? { index: index.name, keys: [] }
        group.keys.push(row.encodedKey)
        groups.set(key, group)
      }
    }
    const conflicts = new Map<string, { index: string; keys: readonly string[] }[]>()
    for (const group of groups.values())
      if (group.keys.length > 1) {
        const keys = group.keys.sort()
        for (const key of keys)
          conflicts.set(key, [...(conflicts.get(key) ?? []), { index: group.index, keys }])
      }
    for (const [key, value] of conflicts) put(key, value)
  },
}

export const intentEventUniqueValidator: RowValidator = {
  ref: { id: 'alignment/intent-event-unique', version: 1 },
  table: 'intent_turn_events',
  lookups: [intentEventConflicts.key],
  validate(row, ctx) {
    const conflicts = ctx.lookup(intentEventConflicts.key).get(row.encodedKey)
    return conflicts ? [rowBlock('v2-intent-event-unique', row, { conflicts })] : []
  },
}

export const intentTurnEventsRule = alignmentRule('intent_turn_events', [], copyAlignedRow)
