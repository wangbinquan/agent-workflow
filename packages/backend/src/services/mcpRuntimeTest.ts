// RFC-364 temporary T4/T6 composition compatibility. The application, stream
// and effects implementations live in Resource Catalog; remove with root cutover.
import { McpDiagnosticsApplication } from '@/modules/resource-catalog/application/mcps/runtimeDiagnostics'
import {
  createMcpDiagnosticsEffects,
  type McpDiagnosticsEffectDependencies,
} from '@/modules/resource-catalog/infrastructure/mcpDiagnosticsEffects'
import type { McpDiagnosticsDependencies } from '@/modules/resource-catalog/application/mcps/runtimeDiagnostics'
export { McpRuntimeTestEventSink } from '@/modules/resource-catalog/application/mcps/runtimeTestEventSink'
export {
  MCP_RUNTIME_TEST_IDLE_MS,
  MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
  MCP_RUNTIME_TEST_RECEIPT_MS,
  MCP_RUNTIME_TEST_MAX_TURNS,
  MCP_RUNTIME_TEST_MESSAGE_BYTES,
  MCP_RUNTIME_TEST_EVENT_ROWS,
  MCP_RUNTIME_TEST_EVENT_BYTES,
  MCP_RUNTIME_TEST_SINGLE_EVENT_BYTES,
  applyPlaygroundVerification,
} from '@/modules/resource-catalog/domain/mcps/runtimeDiagnostics'
export { isRuntimeMcpTestEligible } from '@/modules/runtime-management/public/queries'
export interface McpRuntimeTestDependencies
  extends McpDiagnosticsEffectDependencies, Omit<McpDiagnosticsDependencies, 'effects'> {}
export class McpRuntimeTestService extends McpDiagnosticsApplication {
  constructor(deps: McpRuntimeTestDependencies) {
    super({ ...deps, effects: createMcpDiagnosticsEffects(deps) })
  }
}
const SERVICE_INSTANCES = new WeakMap<object, McpRuntimeTestService>()

export function getMcpRuntimeTestService(deps: McpRuntimeTestDependencies): McpRuntimeTestService {
  const key = deps.persistence.identity
  const existing = SERVICE_INSTANCES.get(key)
  if (existing !== undefined) return existing
  const created = new McpRuntimeTestService(deps)
  SERVICE_INSTANCES.set(key, created)
  return created
}
