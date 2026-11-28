import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { lifecycleAlertSettler } from './settlement'

/**
 * RFC-626 §3.2.3: system-operations converts no table of its own (its alerts are copied by
 * the generic rules); it only says what ending a task does to those alerts.
 */
export const conversion: ConversionContribution = {
  rules: [],
  lookups: [],
  validators: [],
  settlement: { settlers: [lifecycleAlertSettler] },
}
