import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { agentsRule } from './agentsRule'
import { workflowsRule } from './workflowsRule'
import { resourceGrantsRule } from './resourceGrantsRule'
import { bundleAppliesRule } from './bundleAppliesRule'
import { hostPlaceholders, referencedWorkflowIds } from './lookups'

export const conversion: ConversionContribution = {
  rules: [agentsRule, workflowsRule, resourceGrantsRule, bundleAppliesRule],
  lookups: [hostPlaceholders, referencedWorkflowIds],
  validators: [],
}
