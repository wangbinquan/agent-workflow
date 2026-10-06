import type { McpDiagnosticsDependencies } from '../application/mcps/runtimeDiagnostics'
import {
  createLocalMcpDiagnosticsEffects,
  type McpDiagnosticsEffectDependencies,
} from '../infrastructure/local/mcpDiagnosticsEffects'
import {
  bindMcpDiagnosticsRuntime,
  createMcpDiagnosticsApplication,
  type McpDiagnosticsCompositionInput,
} from './mcpDiagnostics'

export interface LocalMcpDiagnosticsApplicationInput
  extends McpDiagnosticsEffectDependencies, Omit<McpDiagnosticsDependencies, 'effects'> {}
export interface LocalMcpDiagnosticsCompositionInput extends LocalMcpDiagnosticsApplicationInput {
  readonly requestBinding: McpDiagnosticsCompositionInput['requestBinding']
  readonly coordinator: McpDiagnosticsCompositionInput['coordinator']
}

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

export function composeLocalMcpDiagnostics(input: LocalMcpDiagnosticsCompositionInput) {
  return bindMcpDiagnosticsRuntime(createLocalMcpDiagnosticsApplication(input), input)
}
