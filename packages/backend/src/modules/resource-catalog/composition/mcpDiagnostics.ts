import {
  McpDiagnosticsApplication,
  type McpDiagnosticsDependencies,
} from '../application/mcps/runtimeDiagnostics'
import { createMcpDiagnosticsOperations } from '../application/mcps/diagnosticsOperations'
import { createInProcessMcpProbeRunner } from './mcpProbeOperations'
import type { McpOperationCoordinatorPort } from '../application/mcps/ports'
import { createMcpDiagnosticsContexts } from '../infrastructure/mcpDiagnosticsContexts'
import type {
  McpProbeRunner,
  McpRuntimeTestReconciliationParticipant,
} from '../public/participants'
import type { McpDiagnosticsEffectDependencies } from '../infrastructure/local/mcpDiagnosticsEffects'

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

/** RFC-531: what the session hands the deployment's MCP diagnostics selection. Both profiles take the same input (the
 * hosted one spreads it into its own effects); its effect dependencies are still declared beside the local effects. */
export interface McpDiagnosticsSelectionInput
  extends
    McpDiagnosticsEffectDependencies,
    Omit<McpDiagnosticsDependencies, 'effects'>,
    Pick<McpDiagnosticsCompositionInput, 'requestBinding' | 'coordinator'> {}

/** RFC-531: the deployment's MCP diagnostics (standalone: local probes; hosted: probes in the release's system volume). */
export type McpDiagnosticsSelection = (input: McpDiagnosticsSelectionInput) => McpDiagnosticsRuntime

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
    /** A deployment that runs Agents elsewhere selects where probes run too; standalone probes in-process
     * (RFC-525: an explicit selection, not an absent one). */
    probeRunner: createInProcessMcpProbeRunner() as McpProbeRunner,
  })
}
