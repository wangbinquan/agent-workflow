import dispositions from '../../epoch1/tableDispositions.json'
import type { SourceTableDisposition } from '../../sourceTypes'
import type { ConversionRule, ConversionSourceCatalog } from '../rule'
import type { SourcePhase } from '../types'
import { archiveRule, blockedTableRule } from './archive'
import { metadataRule } from './metadata'

const frozenTables = new Set(dispositions.map((entry) => entry.table))

export function sourceTableRules(catalog: ConversionSourceCatalog): readonly ConversionRule[] {
  const current = new Set(catalog.preflight.tables.map((entry) => entry.table))
  const rule = (entry: SourceTableDisposition, phase: SourcePhase): ConversionRule => {
    if (entry.disposition === 'metadata' && entry.destination.kind === 'migration-records')
      return metadataRule(entry, phase)
    if (
      entry.disposition === 'archived' &&
      entry.destination.kind === 'archive' &&
      entry.reason.trim()
    )
      return archiveRule(
        entry,
        phase,
        phase === 'pre-upgrade' && !current.has(entry.table)
          ? 'dropped-by-chain'
          : entry.reason.startsWith('frozen historical table:')
            ? 'retired-table'
            : 'unknown-table',
      )
    return blockedTableRule(entry, phase)
  }
  return [
    ...catalog.preflight.tables
      .filter((entry) => !frozenTables.has(entry.table))
      .map((entry) => rule(entry, 'current')),
    ...(catalog.preUpgradePreflight?.tables ?? [])
      .filter(
        (entry) =>
          !current.has(entry.table) ||
          (!frozenTables.has(entry.table) &&
            ['archived', 'metadata', 'blocked'].includes(entry.disposition)),
      )
      .map((entry) => rule(entry, 'pre-upgrade')),
  ]
}
