import type { McpRuntimeTestSessionDto, SessionViewResponse } from '@agent-workflow/shared'

/** The existing session ownership and audit facts shared by both query modes. */
export interface McpDiagnosticsCaller {
  readonly user: { readonly id: string }
  readonly permissions: { has(permission: 'mcp-runtime-tests:audit'): boolean }
}

/** Stored facts remain readable before an execution owner has started. */
export interface McpDiagnosticsStoredQueries {
  latest(actor: McpDiagnosticsCaller, mcpId: string): Promise<McpRuntimeTestSessionDto | null>
  get(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
  ): Promise<McpRuntimeTestSessionDto>
  sessionView(
    actor: McpDiagnosticsCaller,
    mcpId: string,
    sessionId: string,
  ): Promise<SessionViewResponse>
}
