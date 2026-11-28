import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { usersRule } from './users'
import { taskCollaboratorsRule } from './taskCollaborators'
import { repoGroupNodesRule } from './repoGroupNodes'
import { developmentMissionsRule } from './developmentMissions'
import {
  intentTurnEventsRule,
  intentEventConflicts,
  intentEventUniqueValidator,
} from './intentTurnEvents'
import { runtimeSessionLeasesRule } from './runtimeSessionLeases'
import { userAccessAuditRule } from './userAccessAudit'
import { alignmentReferencePolicies } from './referencePolicies'

export const conversion: ConversionContribution = {
  rules: [
    usersRule,
    taskCollaboratorsRule,
    repoGroupNodesRule,
    developmentMissionsRule,
    intentTurnEventsRule,
    runtimeSessionLeasesRule,
    userAccessAuditRule,
  ],
  lookups: [intentEventConflicts],
  validators: [intentEventUniqueValidator],
  // RFC-626 §3.3: the same constant the rules apply when the referenced row is absent.
  references: alignmentReferencePolicies,
}
