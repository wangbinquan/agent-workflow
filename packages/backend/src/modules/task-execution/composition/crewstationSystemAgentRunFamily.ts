import { composeCrewStationSystemAgentContents } from '@/modules/runtime-management/composition/crewstationSystemAgentMaterial'
import { createLocalSystemAgentRuntimeBindings } from '@/modules/runtime-management/composition/systemAgentMaterial'
import type { HostedRunFamilyInput } from '../infrastructure/crewstation/hostedRunFamilyProviders'
import { createHostedSystemAgentRunFamily } from '../infrastructure/crewstation/systemAgentRunFamily'
import { composeLocalSystemAgentRunFamily } from './localSystemAgentRunFamily'

/** All System Agent callers reuse the same core and normalized remote invocation. RFC-422: the hosted opener is
 * infrastructure/crewstation/systemAgentRunFamily.ts; this root selects the fixture family or the hosted family over
 * runtime-management's hosted contents. */
export function createCrewStationSystemAgentRunFamily(
  input: HostedRunFamilyInput,
): typeof composeLocalSystemAgentRunFamily {
  return (options) => {
    if (options.fixture !== undefined) return composeLocalSystemAgentRunFamily(options)
    const family = createHostedSystemAgentRunFamily(input, options, {
      contents: composeCrewStationSystemAgentContents,
    })
    // This compatibility binding only preserves profile getters; binary paths
    // are never resolved or executed on the service host.
    const runtimes = createLocalSystemAgentRuntimeBindings()
    return Object.freeze({
      family,
      bindRuntime: runtimes.bindRuntime,
      withFixture: (runFn) => composeLocalSystemAgentRunFamily(options).withFixture(runFn),
    })
  }
}
