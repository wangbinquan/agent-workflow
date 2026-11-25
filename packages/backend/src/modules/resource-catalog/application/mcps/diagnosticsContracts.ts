// RFC-581 — the MCP diagnostics command / query ports and their inputs. They left `public/` with the MCP HTTP binding
// (now `inbound/http/mcpRoutes.ts`).
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  McpRuntimeTestCancelRequest,
  McpRuntimeTestCreateReceipt,
  McpRuntimeTestCreateRequest,
  McpRuntimeTestMessageReceipt,
  McpRuntimeTestMessageRequest,
  McpRuntimeTestMutationReceipt,
  McpRuntimeTestSessionDto,
  // MCP diagnostics retain their existing wire DTOs and request budgets. RFC-588: the transcript alias left
  // `public/types` — its one cross-module reference was the task diagnostics surface, which left task-execution's
  // public surface when the task routes moved into that module.
  SessionViewResponse as McpDiagnosticsTranscript,
} from '@agent-workflow/shared'

export interface McpDiagnosticsResourceRef {
  readonly mcpId: string
}

export interface McpDiagnosticsSessionRef extends McpDiagnosticsResourceRef {
  readonly sessionId: string
}

export interface StartMcpDiagnosticsInput extends McpDiagnosticsResourceRef {
  readonly request: McpRuntimeTestCreateRequest
}

export interface SubmitMcpDiagnosticsTurnInput extends McpDiagnosticsSessionRef {
  readonly request: McpRuntimeTestMessageRequest
}

export interface CancelMcpDiagnosticsTurnInput extends McpDiagnosticsSessionRef {
  readonly request: McpRuntimeTestCancelRequest
}

export interface McpDiagnosticsCommands {
  start(
    context: CommandContext,
    input: StartMcpDiagnosticsInput,
  ): Promise<McpRuntimeTestCreateReceipt>
  submitTurn(
    context: CommandContext,
    input: SubmitMcpDiagnosticsTurnInput,
  ): Promise<McpRuntimeTestMessageReceipt>
  cancel(
    context: CommandContext,
    input: CancelMcpDiagnosticsTurnInput,
  ): Promise<McpRuntimeTestMutationReceipt>
  end(
    context: CommandContext,
    input: McpDiagnosticsSessionRef,
  ): Promise<McpRuntimeTestMutationReceipt>
}

export interface McpDiagnosticsQueries {
  latest(
    context: QueryContext,
    input: McpDiagnosticsResourceRef,
  ): Promise<McpRuntimeTestSessionDto | null>
  session(context: QueryContext, input: McpDiagnosticsSessionRef): Promise<McpRuntimeTestSessionDto>
  transcript(
    context: QueryContext,
    input: McpDiagnosticsSessionRef,
  ): Promise<McpDiagnosticsTranscript>
}
