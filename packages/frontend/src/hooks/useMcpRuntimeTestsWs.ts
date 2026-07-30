// RFC-238 — owner-gated MCP runtime-test locator frames invalidate the
// canonical REST projections. Polling remains enabled as the correctness
// fallback when WebSocket delivery is unavailable.

import type { McpRuntimeTestWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

export const MCP_RUNTIME_TEST_QUERY_KEYS = {
  latest: (mcpId: string) => ['mcps', mcpId, 'runtime-test-session'] as const,
  sessionView: (mcpId: string, sessionId: string) =>
    ['mcps', mcpId, 'runtime-test-session', sessionId, 'session-view'] as const,
}

export function buildMcpRuntimeTestWsRules(
  mcpId: string,
): WsInvalidationRules<McpRuntimeTestWsMessage> {
  return {
    'mcp-runtime-test.updated': (message) => [
      MCP_RUNTIME_TEST_QUERY_KEYS.latest(mcpId),
      MCP_RUNTIME_TEST_QUERY_KEYS.sessionView(mcpId, message.sessionId),
    ],
  }
}

export function useMcpRuntimeTestsWs(input: { mcpId: string; enabled?: boolean }): void {
  const enabled = input.enabled ?? true
  useWsInvalidation<McpRuntimeTestWsMessage>(
    enabled ? WS_PATHS.mcpRuntimeTests : null,
    buildMcpRuntimeTestWsRules(input.mcpId),
    undefined,
    {
      reconcileOnOpen: () => [MCP_RUNTIME_TEST_QUERY_KEYS.latest(input.mcpId)],
    },
  )
}
