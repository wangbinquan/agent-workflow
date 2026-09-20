import { loadConfig } from '@/config'
import { getRuntimeDriver, tryGetRuntimeDriver } from '@/services/runtime'
import { createRuntimeRegistryApplication } from '../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from './runtimeRegistryEffects'
import { withRuntimeProbeConfigFence } from './runtimeProbeFence'
import { smokeRuntime, type SmokeOptions, type SmokeResult } from '@/services/runtimeSmoke'
import { isRuntimeMcpTestEligible, type McpRuntimeTestService } from '@/services/mcpRuntimeTest'
import type { RuntimeManagementDependencies } from '../application/ports/runtimeManagement'

export interface RuntimeDiagnosticDependencies {
  smokeRuntime(options: SmokeOptions): Promise<SmokeResult>
  beforeRuntimeProbeCache?(): void | Promise<void>
  probeTimeoutMsForTest?: number
}

export function createRuntimeManagementEffects(input: {
  readonly configPath: string
  readonly runtimeTests: Pick<McpRuntimeTestService, 'reconcileDurableIntents'>
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
}): Omit<RuntimeManagementDependencies, 'registry'> {
  const { assertRuntimeSpawnCapabilities } = createRuntimeRegistryApplication(
    createRuntimeRegistryEffects(),
  )
  return {
    config: {
      current() {
        const cfg = loadConfig(input.configPath)
        return {
          defaultRuntime: cfg.defaultRuntime,
          memoryDistillRuntime: cfg.memoryDistillRuntime,
          commitPushRuntime: cfg.commitPushRuntime,
          mergeAgentRuntime: cfg.mergeAgentRuntime,
          intentBuilderRuntime: cfg.intentBuilderRuntime,
          changeNarrativeRuntime: cfg.changeNarrativeRuntime,
          opencodePath: cfg.opencodePath,
          claudeCodePath: cfg.claudeCodePath,
        }
      },
      withProbeReceiptFence: (action) => withRuntimeProbeConfigFence(input.configPath, action),
    },
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
