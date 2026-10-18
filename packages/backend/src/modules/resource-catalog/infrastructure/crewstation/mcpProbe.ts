// RFC-370 hosted acceptance (2026-10-18) — the RFC-030 MCP probe runs as a
// task-image command; the route keeps admission, freshness and persistence.
import { McpProbeSchema, McpSchema } from '@agent-workflow/shared'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { McpProbeRunner } from '../../public/participants'

/** The scratch volume of hosted system work: it holds no state of its own and
 * follows the running release, so its helper always knows `mcp-probe`. */
const OWNER = 'system:shared'
/** The probe's own ceiling is 60 s; the command adds admission and helper start. */
export const HOSTED_MCP_PROBE_TIMEOUT_MS = 120_000
const Measurement = McpProbeSchema.omit({ id: true, mcpId: true, mcpName: true, updatedAt: true })

export function createHostedMcpProbe(input: { readonly helper: WorkspaceHelper }): McpProbeRunner {
  return {
    async probe(mcp, options) {
      return Measurement.parse(
        await input.helper.call(
          OWNER,
          'mcp-probe',
          { mcp: McpSchema.parse(mcp), startedAt: options.startedAt },
          {
            operationId: `mcp-probe:${mcp.id}:${options.startedAt}`,
            timeoutMs: HOSTED_MCP_PROBE_TIMEOUT_MS,
          },
        ),
      )
    },
  }
}
