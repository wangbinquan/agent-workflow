// RFC-448 — the MCP probe use cases bound to the deployment's probe. The test
// seam and the probe clock that routes/mcps.ts used to own live here; the MCP
// write clock in the composition root reads the same clock, so probes and
// writes keep one causal timeline.
import { createMcpProbeOperations } from '../application/mcps/probeOperations'
import type { McpProbeCoordinatorPort, McpProbeOperations } from '../application/mcps/ports'
import { probeMcp, type ProbeOptions } from '../infrastructure/mcpProbe'
import type {
  McpAclIdentityParticipant,
  McpProbeRunner,
  McpProbeStore,
} from '../public/participants'
import type { McpQueries } from '../public/queries'

// Allow tests to override the probe options (e.g. inject a fake openClient).
// In production this stays undefined and probeMcp uses defaults.
let probeOptionsOverride: ProbeOptions | undefined
export function __setMcpProbeOptionsForTesting(opts: ProbeOptions | undefined): void {
  probeOptionsOverride = opts
}

export function mcpProbeNow(): number {
  return (probeOptionsOverride?.now ?? Date.now)()
}

export function composeMcpProbeOperations(input: {
  readonly queries: McpQueries
  readonly aclIdentity: McpAclIdentityParticipant
  readonly store: McpProbeStore
  /** The shared process-wide MCP operation coordinator. */
  readonly coordinator: McpProbeCoordinatorPort
  /** Where the deployment runs its Agents' MCP servers; absent, in-process. */
  readonly probeRunner?: McpProbeRunner
}): McpProbeOperations {
  const runner = input.probeRunner
  return createMcpProbeOperations({
    queries: input.queries,
    aclIdentity: input.aclIdentity,
    store: input.store,
    coordinator: input.coordinator,
    now: mcpProbeNow,
    runProbe: (mcp, { startedAt }) =>
      runner === undefined
        ? probeMcp(mcp, { ...probeOptionsOverride, startedAt })
        : runner.probe(mcp, { startedAt }),
  })
}
