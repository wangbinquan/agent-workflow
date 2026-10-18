// RFC-370 hosted acceptance (2026-10-18) — the RFC-030 MCP probe on CrewStation.
//
// The probe route spawned the server inside the AW service container, which has
// no `node`/`npx` and is not where hosted Agents start their MCP servers: a
// local stdio server failed `Executable not found in $PATH: "node"` in 82 ms.
// Like every other hosted execution, the probe now runs in the task image.
import { z } from 'zod'
import { McpSchema } from '@agent-workflow/shared'
import { probeMcp, type ProbeResult } from '@/services/mcpProbe'

const Request = z.object({ mcp: McpSchema, startedAt: z.number().int() }).strict()

/** One probe inside the CS task image: a local server starts from the task
 * container's PATH and environment and a remote one is reached over the task
 * container's network, as the deployment's Agents use them. `startedAt` is the
 * route's capture, taken before it read the configuration snapshot. */
export async function executeTaskImageMcpProbe(value: unknown): Promise<ProbeResult> {
  const request = Request.parse(value)
  return probeMcp(request.mcp, { startedAt: request.startedAt })
}
