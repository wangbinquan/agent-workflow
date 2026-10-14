import type { ProviderNeutralDatabase } from '@/db/query'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'
import { createClarifyFollowupGeneration } from '../infrastructure/clarifyFollowupGeneration'
import { composeLocalSystemAgentRunFamily } from './localSystemAgentRunFamily'

/** Reuse the ordinary System executor with the asking run's frozen runtime. */
export function composeClarifyFollowupGenerator(input: {
  db: ProviderNeutralDatabase
  appHome: () => string
  registry: RuntimeExecutionQueries
  observations?: () => SystemAgentObservationFactory
}) {
  const binding = composeLocalSystemAgentRunFamily({
    appHome: input.appHome,
    observations: input.observations,
  })
  // Bootstrap checks compatibility with the collaboration-owned port; the
  // execution adapter keeps its own input instead of importing its consumer.
  return createClarifyFollowupGeneration({
    db: input.db,
    registry: input.registry,
    family: binding.family,
    bindRuntime: binding.bindRuntime,
  })
}
