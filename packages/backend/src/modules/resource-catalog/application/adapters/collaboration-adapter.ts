import type { ReviewUpstreamAgentPort } from '@/modules/collaboration/composition/required-ports'
import type { ReviewUpstreamAgentQuery } from '../ports/reviewUpstreamAgent'

export function composeReviewUpstreamAgentPort(
  query: ReviewUpstreamAgentQuery,
): ReviewUpstreamAgentPort {
  return { outputProfile: (agentId) => query.outputProfile(agentId) }
}
