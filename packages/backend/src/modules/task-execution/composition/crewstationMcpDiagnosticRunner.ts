import { createLogger } from '@/util/log'
import { runSystemAgentCore } from '../application/systemAgentRun'
import type { SystemAgentRunPolicy } from '../application/ports/systemAgentRun'
import {
  createHostedMcpDiagnosticSessions,
  type HostedMcpDiagnosticInput,
  type HostedMcpDiagnosticTurn,
} from '../infrastructure/crewstation/mcpDiagnosticSessions'

/** MCP diagnostics use the ordinary Agent execution core. RFC-416: the hosted
 * sessions (naming, probes, cleanup, recovery, workspace and compile) are the
 * CrewStation adapter; this binding runs each turn through the core. */
export function createCrewStationMcpDiagnosticRunner(input: HostedMcpDiagnosticInput) {
  const { invocation, ...sessions } = createHostedMcpDiagnosticSessions(input)
  return {
    ...sessions,
    async run(
      request: HostedMcpDiagnosticTurn & {
        readonly policy: SystemAgentRunPolicy
        readonly timeoutMs: number
        readonly maxEventTextBytes: number
      },
    ) {
      const log = createLogger('hosted-mcp-runtime-test')
      const turn = invocation(request, log)
      return runSystemAgentCore(
        { ...request.policy, retainScratchOnSuccess: true },
        {
          log,
          timeoutMs: request.timeoutMs,
          maxEventTextBytes: request.maxEventTextBytes,
          startedAt: Date.now(),
          retainedRef: turn.workspace.retainedRef,
          invocation: turn,
        },
      )
    },
  }
}
