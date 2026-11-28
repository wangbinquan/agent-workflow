import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { clarifyRule } from './clarifyRule'
import { gateOperationsRule, gateOperationsValidator } from './gateOperationsRule'
import { clarifyRoundSettler } from './settlement'

export const conversion: ConversionContribution = {
  rules: [clarifyRule, gateOperationsRule],
  lookups: [],
  validators: [gateOperationsValidator],
  // RFC-626 §3.2.3: what ending a task does to this module's rows.
  settlement: { settlers: [clarifyRoundSettler] },
}
