// RFC-448 — the MCP probe use cases bound to the deployment's probe. The MCP
// write clock in the composition root reads the same clock, so probes and
// writes keep one causal timeline.
// RFC-538 — the probe options and that clock belong to one application's probe
// environment (the composition root builds one per application), not to a
// process-wide test seam.
import { createMcpProbeOperations } from '../application/mcps/probeOperations'
import type {
  McpProbeCoordinatorPort,
  McpProbeOperations,
  McpProbeRunner,
  McpProbeStore,
} from '../application/mcps/ports'
import { probeMcp, type ProbeOptions } from '../infrastructure/mcpProbe'
import type { McpAclIdentityParticipant } from '../public/participants'
import type { McpQueries } from '../public/queries'

/** RFC-538: what a test hands an application (a fake client factory, a clock); production hands none. */
export type McpProbeOptions = ProbeOptions

/** RFC-538: one application's MCP probe environment — the options its in-process probes run with and the clock that
 * probes and MCP writes share. Both read the options each time they are used. */
export interface McpProbeEnvironment {
  readonly clock: () => number
  readonly options: () => McpProbeOptions | undefined
}

/** RFC-538: without options the probe uses its own client factory and `Date.now`. */
export function createMcpProbeEnvironment(
  options: () => McpProbeOptions | undefined = () => undefined,
): McpProbeEnvironment {
  return Object.freeze({
    clock: () => (options()?.now ?? Date.now)(),
    options,
  })
}

/** RFC-525 — the in-process probe: each probe reads the environment's options, then runs `probeMcp` here. */
export function createInProcessMcpProbeRunner(environment: McpProbeEnvironment): McpProbeRunner {
  return Object.freeze({
    probe: (
      mcp: Parameters<McpProbeRunner['probe']>[0],
      { startedAt }: { readonly startedAt: number },
    ) => probeMcp(mcp, { ...environment.options(), startedAt }),
  })
}

export function composeMcpProbeOperations(input: {
  readonly queries: McpQueries
  readonly aclIdentity: McpAclIdentityParticipant
  readonly store: McpProbeStore
  /** The shared process-wide MCP operation coordinator. */
  readonly coordinator: McpProbeCoordinatorPort
  /** Where the deployment runs its Agents' MCP servers (standalone: `createInProcessMcpProbeRunner(environment)`). */
  readonly probeRunner: McpProbeRunner
  /** RFC-538: the application's probe clock (the one its MCP writes read). */
  readonly clock: () => number
}): McpProbeOperations {
  const runner = input.probeRunner
  return createMcpProbeOperations({
    queries: input.queries,
    aclIdentity: input.aclIdentity,
    store: input.store,
    coordinator: input.coordinator,
    now: input.clock,
    runProbe: (mcp, { startedAt }) => runner.probe(mcp, { startedAt }),
  })
}
