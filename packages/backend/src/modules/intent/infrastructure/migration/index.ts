import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { applyJournalRule } from './applyJournalRule'

export const conversion: ConversionContribution = {
  rules: [applyJournalRule],
  lookups: [],
  validators: [],
}
