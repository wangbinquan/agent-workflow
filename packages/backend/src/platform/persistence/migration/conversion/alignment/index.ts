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
}
