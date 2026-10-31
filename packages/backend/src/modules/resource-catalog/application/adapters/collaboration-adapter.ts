import type { CollaborationTaskRolePolicy } from '@/modules/collaboration/composition/required-ports'
import type { ReviewUpstreamAgentPort } from '@/modules/collaboration/composition/required-ports'
import type { ReviewUpstreamAgentQuery } from '../ports/reviewUpstreamAgent'

export function composeReviewUpstreamAgentPort(
  query: ReviewUpstreamAgentQuery,
): ReviewUpstreamAgentPort {
  return { outputProfile: (agentId) => query.outputProfile(agentId) }
}

export function composeCollaborationTaskRolePolicy(
  policy: CollaborationTaskRolePolicy,
): CollaborationTaskRolePolicy {
  return {
    resolveTaskRole: (actor, ownerUserId, isMember) =>
      policy.resolveTaskRole(actor, ownerUserId, isMember),
    hasResourceAclBypass: (actor) => policy.hasResourceAclBypass(actor),
  }
}
