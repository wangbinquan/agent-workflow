import {
  McpDiagnosticsApplication,
  type McpDiagnosticsDependencies,
} from '../application/mcps/runtimeDiagnostics'
import { createMcpDiagnosticsOperations } from '../application/mcps/diagnosticsOperations'
import type { McpOperationCoordinatorPort } from '../application/mcps/ports'
import { createMcpDiagnosticsContexts } from '../infrastructure/mcpDiagnosticsContexts'
import type { McpRuntimeTestReconciliationParticipant } from '../public/participants'

export type McpDiagnosticsApplicationInput = McpDiagnosticsDependencies

/** Cold construction. Every owning root calls this once and explicitly shares the result. */
export function createMcpDiagnosticsApplication(input: McpDiagnosticsApplicationInput) {
  return new McpDiagnosticsApplication(input)
}

export interface McpDiagnosticsCompositionInput extends McpDiagnosticsApplicationInput {
  readonly requestBinding: Parameters<typeof createMcpDiagnosticsContexts>[0]
  readonly coordinator: McpOperationCoordinatorPort
}
export type McpDiagnosticsRuntime = ReturnType<typeof composeMcpDiagnostics>

export function composeMcpDiagnostics(input: McpDiagnosticsCompositionInput) {
  return bindMcpDiagnosticsRuntime(createMcpDiagnosticsApplication(input), input)
}

/** The ordinary and explicit native roots share the same complete runtime graph. */
export function bindMcpDiagnosticsRuntime(
  application: McpDiagnosticsApplication,
  input: Pick<McpDiagnosticsCompositionInput, 'requestBinding' | 'coordinator'>,
) {
  const contexts = createMcpDiagnosticsContexts(input.requestBinding)
  const operations = createMcpDiagnosticsOperations({
    application,
    contexts: contexts.resolver,
    coordinator: input.coordinator,
  })
  const reconciliation: McpRuntimeTestReconciliationParticipant = Object.freeze({
    reconcileDurableIntents: () => application.reconcileDurableIntents(),
  })
  return Object.freeze({
    commands: operations.commands,
    queries: operations.queries,
    contexts: Object.freeze({ command: contexts.command, query: contexts.query }),
    reconciliation,
    prepareMcpDelete: (id: string) => application.prepareMcpDelete(id),
    reconcileDurableIntents: reconciliation.reconcileDurableIntents,
    start: () => application.start(),
    stop: (budgetMs?: number) => application.stop(budgetMs),
    shutdown: (budgetMs?: number) => application.shutdown(budgetMs),
    dispose: (budgetMs?: number) => application.dispose(budgetMs),
    pause: (budgetMs?: number) => application.pause(budgetMs),
    resume: () => application.resume(),
  })
}
