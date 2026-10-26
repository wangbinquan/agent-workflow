import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { clarifyRule } from './clarifyRule'
import { gateOperationsRule, gateOperationsValidator } from './gateOperationsRule'

export const conversion: ConversionContribution = {
  rules: [clarifyRule, gateOperationsRule],
  lookups: [],
  validators: [gateOperationsValidator],
}
