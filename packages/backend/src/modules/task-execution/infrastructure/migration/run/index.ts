import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { runRule } from './rule'
import { allocationRule } from './allocations'
import {
  runDefinitions,
  runSequences,
  writerEvidence,
  runFrames,
  runAllocationSummary,
} from './lookups'

export const conversion: ConversionContribution = {
  rules: [runRule, allocationRule],
  lookups: [runDefinitions, runSequences, writerEvidence, runFrames, runAllocationSummary],
  validators: [],
}
