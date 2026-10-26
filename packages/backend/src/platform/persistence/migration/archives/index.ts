import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { historyRule, historySourceTables } from './codeHistory'
import { familyCutoversRule } from './familyCutovers'
import { historyAdoptionsLookup } from './adoptions'
import { writerDrainLookup, writerDrainRule } from './writerDrain'

export const conversion: ConversionContribution = {
  rules: [familyCutoversRule, writerDrainRule],
  lookups: [historyAdoptionsLookup, writerDrainLookup],
  validators: [],
  forSource({ preflight }) {
    const present = historySourceTables.filter((table) =>
      preflight.tables.some((source) => source.table === table),
    )
    const absent = historySourceTables.filter(
      (table) => !present.includes(table) && preflight.expectedAbsent.includes(table),
    )
    const unexplained = historySourceTables.filter(
      (table) => !present.includes(table) && !absent.includes(table),
    )
    // Keep unexplained absences as claims so the core rejects the plan. Only
    // V1's catalog-bound expected absence permits a zero-row history package.
    return [...present, ...unexplained].map((table, index) =>
      historyRule(table, index === 0 ? absent : []),
    )
  },
}
