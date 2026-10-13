import {
  McpDiagnosticsApplication,
  type McpDiagnosticsDependencies,
} from '../application/mcps/runtimeDiagnostics'
import { createMcpDiagnosticsOperations } from '../application/mcps/diagnosticsOperations'
import type { McpOperationCoordinatorPort } from '../application/mcps/ports'
import { createMcpDiagnosticsContexts } from '../infrastructure/mcpDiagnosticsContexts'
import type { McpRuntimeTestReconciliationParticipant } from '../public/participants'
import type { McpDiagnosticsStoredQueries } from '../application/mcps/runtimeDiagnosticsQueries'
export type { McpDiagnosticsExecutionLifecycle } from '../application/mcps/runtimeDiagnosticsExecution'

export type McpDiagnosticsApplicationInput = McpDiagnosticsDependencies

/** Cold construction. Every owning root calls this once and explicitly shares the result. */
export function createMcpDiagnosticsApplication(input: McpDiagnosticsApplicationInput) {
  return new McpDiagnosticsApplication(input)
}

/** Select all three stored queries from the same cold application instance. */
export function selectMcpDiagnosticsStoredQueries(
  application: McpDiagnosticsApplication,
): McpDiagnosticsStoredQueries {
  return application.storedQueries
}

export interface McpDiagnosticsCompositionInput extends McpDiagnosticsApplicationInput {
  readonly requestBinding: Parameters<typeof createMcpDiagnosticsContexts>[0]
  readonly coordinator: McpOperationCoordinatorPort
  readonly queryMode?: 'native' | 'stored'
}
export type McpDiagnosticsRuntime = ReturnType<typeof composeMcpDiagnostics>

export function composeMcpDiagnostics(input: McpDiagnosticsCompositionInput) {
  return bindMcpDiagnosticsRuntime(createMcpDiagnosticsApplication(input), input)
}

/** The ordinary and explicit native roots share the same complete runtime graph. */
export function bindMcpDiagnosticsRuntime(
  application: McpDiagnosticsApplication,
  input: Pick<McpDiagnosticsCompositionInput, 'requestBinding' | 'coordinator' | 'queryMode'>,
) {
  if (
    input.queryMode !== undefined &&
    input.queryMode !== 'native' &&
    input.queryMode !== 'stored'
  ) {
    throw new Error('mcp-diagnostics-query-mode-invalid')
  }
  if (application.executionLifecycle !== undefined && input.queryMode === 'native') {
    throw new Error('mcp-diagnostics-host-requires-stored-queries')
  }
  const contexts = createMcpDiagnosticsContexts(input.requestBinding)
  const operations = createMcpDiagnosticsOperations({
    application:
      input.queryMode === 'stored' || application.executionLifecycle !== undefined
        ? Object.freeze({
            create: application.create.bind(application),
            message: application.message.bind(application),
            cancel: application.cancel.bind(application),
            end: application.end.bind(application),
            recover: application.recover.bind(application),
            ...selectMcpDiagnosticsStoredQueries(application),
          })
        : application,
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
    ...(application.executionLifecycle === undefined
      ? {}
      : { execution: application.executionLifecycle }),
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
