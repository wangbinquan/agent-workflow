import type { LocalSystemAgentRunFamilyInput } from '../infrastructure/local/systemAgentRunFamily'
import type { HostedRunFamilyInput } from '../infrastructure/crewstation/hostedRunFamilyProviders'
import { createHostedSystemAgentRunFamily } from '../infrastructure/crewstation/systemAgentRunFamily'
import {
  composeLocalSystemAgentRunFamily,
  type LocalSystemAgentRunProviders,
} from './localSystemAgentRunFamily'

/** RFC-489: the providers of the hosted system agent run family (bootstrap passes them in): runtime-management's
 * hosted contents, and the native providers its fixture family and profile getters still use. */
export interface CrewStationSystemAgentRunProviders<Bind> {
  readonly contents: Parameters<typeof createHostedSystemAgentRunFamily>[2]['contents']
  readonly local: LocalSystemAgentRunProviders<Bind>
}

/** All System Agent callers reuse the same core and normalized remote invocation. RFC-422: the hosted opener is
 * infrastructure/crewstation/systemAgentRunFamily.ts; this root selects the fixture family or the hosted family over
 * runtime-management's hosted contents (RFC-489: given by bootstrap). */
export function createCrewStationSystemAgentRunFamily<Bind>(
  input: HostedRunFamilyInput,
  providers: CrewStationSystemAgentRunProviders<Bind>,
): (
  options: LocalSystemAgentRunFamilyInput,
) => ReturnType<typeof composeLocalSystemAgentRunFamily<Bind>> {
  return (options) => {
    if (options.fixture !== undefined)
      return composeLocalSystemAgentRunFamily(options, providers.local)
    const family = createHostedSystemAgentRunFamily(input, options, {
      contents: providers.contents,
    })
    // This compatibility binding only preserves profile getters; binary paths
    // are never resolved or executed on the service host.
    const runtimes = providers.local.runtimes()
    return Object.freeze({
      family,
      bindRuntime: runtimes.bindRuntime,
      withFixture: (runFn) =>
        composeLocalSystemAgentRunFamily(options, providers.local).withFixture(runFn),
    })
  }
}
