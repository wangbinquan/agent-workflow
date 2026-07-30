// RFC-238 — OpenCode's dedicated MCP-only verified playground plan.

import type { McpTestSpawnContext, McpTestSpawnPlan } from '../types'
import { buildVerifiedOpencodeMcpTestPlan } from './verifiedMcpTestPlan'

export async function buildOpencodeMcpTestSpawn(
  ctx: McpTestSpawnContext,
): Promise<McpTestSpawnPlan> {
  const command =
    ctx.runtimeBinary !== undefined && ctx.runtimeBinary !== null && ctx.runtimeBinary !== ''
      ? [ctx.runtimeBinary]
      : ['opencode']
  return buildVerifiedOpencodeMcpTestPlan(ctx, command)
}
