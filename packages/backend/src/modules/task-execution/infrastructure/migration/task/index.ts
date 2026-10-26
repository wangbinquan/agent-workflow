import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { taskConversionRule } from './rule'
import { taskFactsLookup, taskMountsLookup, taskIsolationLookup } from './lookups'
import { taskLineageLookup } from './lineage'
import { taskWorkspacePreparationValidator, hostedWorkspaceCommandValidator } from './validators'

export const conversion: ConversionContribution = {
  rules: [taskConversionRule],
  lookups: [taskFactsLookup, taskMountsLookup, taskIsolationLookup, taskLineageLookup],
  validators: [taskWorkspacePreparationValidator, hostedWorkspaceCommandValidator],
}
