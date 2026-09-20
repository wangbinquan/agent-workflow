import {
  McpDiagnosticsApplication,
  type McpDiagnosticsDependencies,
} from '../application/mcps/runtimeDiagnostics'
import { createMcpDiagnosticsOperations } from '../application/mcps/diagnosticsOperations'
import type { McpOperationCoordinatorPort } from '../application/mcps/ports'
import {
  createMcpDiagnosticsEffects,
  type McpDiagnosticsEffectDependencies,
} from '../infrastructure/mcpDiagnosticsEffects'
import { createMcpDiagnosticsContexts } from '../infrastructure/mcpDiagnosticsContexts'
import type { McpRuntimeTestReconciliationParticipant } from '../public/participants'

export interface McpDiagnosticsApplicationInput
  extends McpDiagnosticsEffectDependencies, Omit<McpDiagnosticsDependencies, 'effects'> {}

/** Cold construction. Every owning root calls this once and explicitly shares the result. */
export function createMcpDiagnosticsApplication(input: McpDiagnosticsApplicationInput) {
  return new McpDiagnosticsApplication({ ...input, effects: createMcpDiagnosticsEffects(input) })
}

export interface McpDiagnosticsCompositionInput extends McpDiagnosticsApplicationInput {
  readonly requestBinding: Parameters<typeof createMcpDiagnosticsContexts>[0]
  readonly coordinator: McpOperationCoordinatorPort
}
export type McpDiagnosticsRuntime = ReturnType<typeof composeMcpDiagnostics>

export function composeMcpDiagnostics(input: McpDiagnosticsCompositionInput) {
  const application = createMcpDiagnosticsApplication(input)
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
