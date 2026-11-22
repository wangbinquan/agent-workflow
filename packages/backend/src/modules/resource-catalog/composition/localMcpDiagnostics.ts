import type { McpDiagnosticsDependencies } from '../application/mcps/runtimeDiagnostics'
import {
  createLocalMcpDiagnosticsEffects,
  type McpDiagnosticsEffectDependencies,
} from '../infrastructure/local/mcpDiagnosticsEffects'
import {
  bindMcpDiagnosticsRuntime,
  createMcpDiagnosticsApplication,
  type McpDiagnosticsRuntime,
  type McpDiagnosticsSelectionInput,
} from './mcpDiagnostics'

export interface LocalMcpDiagnosticsApplicationInput
  extends McpDiagnosticsEffectDependencies, Omit<McpDiagnosticsDependencies, 'effects'> {}

/** Original native snapshot/getter order and actual application callback receiver. */
export function createLocalMcpDiagnosticsApplication(input: LocalMcpDiagnosticsApplicationInput) {
  const snapshot = { ...input }
  const effects = createLocalMcpDiagnosticsEffects(input, {
    persistence: snapshot.persistence,
    applicationReceiver: () => application,
  })
  const application = createMcpDiagnosticsApplication({ ...snapshot, effects })
  return application
}

/** The standalone profile's MCP diagnostics selection (RFC-531: typed by the neutral selection input). */
export function composeLocalMcpDiagnostics(
  input: McpDiagnosticsSelectionInput,
): McpDiagnosticsRuntime {
  return bindMcpDiagnosticsRuntime(createLocalMcpDiagnosticsApplication(input), input)
}
