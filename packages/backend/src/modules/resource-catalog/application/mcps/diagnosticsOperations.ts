import type { Mcp } from '@agent-workflow/shared'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import { NotFoundError } from '@/util/errors'
import type { McpDiagnosticsCommands } from '../../public/commands'
import type { McpDiagnosticsQueries } from '../../public/queries'
import type { McpDiagnosticsApplication, McpDiagnosticsCaller } from './runtimeDiagnostics'
import type { McpOperationCoordinatorPort } from './ports'

export interface McpDiagnosticsRequest {
  readonly caller: McpDiagnosticsCaller
  readonly loadVisibleMcp: (id: string) => Promise<Mcp | null>
}
export interface McpDiagnosticsContextResolver {
  command(context: CommandContext): McpDiagnosticsRequest
  query(context: QueryContext): McpDiagnosticsRequest
}

/** Preserve CRUD's coordinator and the original under-lock visibility/freshness reads. */
export function createMcpDiagnosticsOperations(input: {
  readonly application: Pick<
    McpDiagnosticsApplication,
    'create' | 'message' | 'cancel' | 'end' | 'latest' | 'get' | 'sessionView'
  >
  readonly contexts: McpDiagnosticsContextResolver
  readonly coordinator: McpOperationCoordinatorPort
}): { readonly commands: McpDiagnosticsCommands; readonly queries: McpDiagnosticsQueries } {
  const { application, contexts, coordinator } = input
  async function visible(request: McpDiagnosticsRequest, id: string): Promise<Mcp> {
    const mcp = await request.loadVisibleMcp(id)
    if (mcp === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
    return mcp
  }
  const commands: McpDiagnosticsCommands = Object.freeze<McpDiagnosticsCommands>({
    async start(context, input) {
      const request = contexts.command(context)
      const resolved = await visible(request, input.mcpId)
      return coordinator.runExclusive(resolved.id, async () => {
        const fresh = await visible(request, resolved.id)
        return application.create(request.caller, fresh, input.request)
      })
    },
    async submitTurn(context, input) {
      const request = contexts.command(context)
      const resolved = await visible(request, input.mcpId)
      return coordinator.runExclusive(resolved.id, async () => {
        const fresh = await visible(request, resolved.id)
        return application.message(request.caller, fresh, input.sessionId, input.request)
      })
    },
    async cancel(context, input) {
      const request = contexts.command(context)
      return coordinator.runExclusive(input.mcpId, async () => {
        const mcp = await visible(request, input.mcpId)
        return application.cancel(request.caller, mcp.id, input.sessionId, input.request)
      })
    },
    async end(context, input) {
      const request = contexts.command(context)
      return coordinator.runExclusive(input.mcpId, async () => {
        const mcp = await visible(request, input.mcpId)
        return application.end(request.caller, mcp.id, input.sessionId)
      })
    },
  })
  const queries: McpDiagnosticsQueries = Object.freeze<McpDiagnosticsQueries>({
    async latest(context, input) {
      const request = contexts.query(context)
      return coordinator.runExclusive(input.mcpId, async () => {
        const mcp = await visible(request, input.mcpId)
        return application.latest(request.caller, mcp.id)
      })
    },
    async session(context, input) {
      const request = contexts.query(context)
      return coordinator.runExclusive(input.mcpId, async () => {
        const mcp = await visible(request, input.mcpId)
        return application.get(request.caller, mcp.id, input.sessionId)
      })
    },
    async transcript(context, input) {
      const request = contexts.query(context)
      return coordinator.runExclusive(input.mcpId, async () => {
        const mcp = await visible(request, input.mcpId)
        return application.sessionView(request.caller, mcp.id, input.sessionId)
      })
    },
  })
  return Object.freeze({ commands, queries })
}
