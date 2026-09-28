import { getRuntimeDriver, tryGetRuntimeDriver } from '@/services/runtime'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from './runtimeRegistryEffects'
import { smokeRuntime, type SmokeOptions, type SmokeResult } from '@/services/runtimeSmoke'
import type { McpRuntimeTestReconciliationParticipant } from '@/modules/resource-catalog/public/participants'
import { isRuntimeMcpTestEligible } from './mcpTestEligibility'
import type {
  RuntimeManagementDependencies,
  RuntimeManagementConfigPort,
} from '../application/ports/runtimeManagement'

export interface RuntimeDiagnosticDependencies {
  smokeRuntime(options: SmokeOptions): Promise<SmokeResult>
  beforeRuntimeProbeCache?(): void | Promise<void>
  probeTimeoutMsForTest?: number
}

export function createRuntimeManagementEffects(input: {
  readonly configuration: RuntimeManagementConfigPort
  readonly runtimeTests: McpRuntimeTestReconciliationParticipant
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
}): Omit<RuntimeManagementDependencies, 'registry'> {
  const { assertRuntimeSpawnCapabilities } = createRuntimeRegistryApplication(
    createRuntimeRegistryEffects(),
  )
  return {
    config: input.configuration,
    drivers: {
      resolveBinary: (row, config) =>
        row.binaryPath ??
        tryGetRuntimeDriver(row.protocol)?.defaultBinary(config)[0] ??
        row.protocol,
      async probeStatus(protocol, binary, timeoutMs) {
        const driver = tryGetRuntimeDriver(protocol)
        return driver === null
          ? { binary, version: null, compatible: false, ran: false }
          : driver.probe(binary, { timeoutMs, quiet: true })
      },
      smoke: input.runtimeDiagnosticTestDependencies?.smokeRuntime ?? smokeRuntime,
      assertSpawnCapabilities: assertRuntimeSpawnCapabilities,
    },
    modelDiscovery: {
      resolveBinary(protocol, binaryPath, config) {
        const driver = getRuntimeDriver(protocol)
        return binaryPath ?? driver.defaultBinary(config)[0]!
      },
      list: (protocol, binary, refresh) =>
        getRuntimeDriver(protocol).listModels(binary, { refresh }),
    },
    tests: {
      eligible: isRuntimeMcpTestEligible,
      async reconcile() {
        await input.runtimeTests.reconcileDurableIntents()
      },
    },
    statusProbeTimeoutMs: input.runtimeDiagnosticTestDependencies?.probeTimeoutMsForTest ?? 5000,
    beforeProbeReceipt:
      input.runtimeDiagnosticTestDependencies?.beforeRuntimeProbeCache ?? (() => undefined),
  }
}
