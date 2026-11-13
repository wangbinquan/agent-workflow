import { getRuntimeDriver, tryGetRuntimeDriver } from '../drivers'
import { createRuntimeRegistryApplication } from '../../application/runtimeRegistry'
import { createRuntimeRegistryEffects } from '../runtimeRegistryEffects'
import type { RuntimeKind, RuntimeSmokeResult } from '../../public/types'
import type { McpRuntimeTestReconciliationParticipant } from '@/modules/resource-catalog/public/participants'
import { isRuntimeMcpTestEligible } from '../mcpTestEligibility'
import type {
  RuntimeManagementConfigPort,
  RuntimeManagementEffects,
  RuntimeSmokeRequest,
  RuntimeDriverManagementPort,
} from '../../application/ports/runtimeManagement'
import type { createLocalRuntimeDiagnosticTargets } from './runtimeDiagnosticTargets'

/** RFC-491: what the smoke fixture seam receives — the fields this effect builds from the smoke request (the
 * executable or test command head instead of the diagnostic target). The result is the public smoke wire. */
export interface RuntimeSmokeFixtureOptions {
  readonly protocol: RuntimeKind
  readonly binaryPath: string | readonly string[]
  readonly config?: {
    readonly opencodePath?: string | null
    readonly claudeCodePath?: string | null
  }
  readonly model?: string
  readonly extraArgs?: readonly string[]
  readonly isSandbox?: boolean
}

export interface RuntimeDiagnosticDependencies {
  smokeRuntime(options: RuntimeSmokeFixtureOptions): Promise<RuntimeSmokeResult>
  beforeRuntimeProbeCache?(): void | Promise<void>
  probeTimeoutMsForTest?: number
}

export function createLocalRuntimeManagementEffects(input: {
  readonly configuration: RuntimeManagementConfigPort
  readonly runtimeTests: McpRuntimeTestReconciliationParticipant
  readonly runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticDependencies>
  readonly targets: ReturnType<typeof createLocalRuntimeDiagnosticTargets>
  readonly smoke: {
    run(request: RuntimeSmokeRequest): ReturnType<RuntimeDriverManagementPort['smoke']>
  }
}): RuntimeManagementEffects {
  const { assertRuntimeSpawnCapabilities } = createRuntimeRegistryApplication(
    createRuntimeRegistryEffects(),
  )
  return {
    config: input.configuration,
    drivers: {
      resolveTarget(row, config) {
        const binary =
          row.binaryPath ??
          tryGetRuntimeDriver(row.protocol)?.defaultBinary(config)[0] ??
          row.protocol
        return input.targets.capture({ protocol: () => row.protocol, binaryPath: binary })
      },
      capture: (request) => input.targets.capture(request),
      async probeStatus(protocol, target, timeoutMs) {
        const driver = tryGetRuntimeDriver(protocol)
        const binary = input.targets.binary(target)
        return driver === null
          ? { binary, version: null, compatible: false, ran: false }
          : driver.probe(binary, { timeoutMs, quiet: true })
      },
      smoke: ((fixture) =>
        fixture == null
          ? (request: RuntimeSmokeRequest) => input.smoke.run(request)
          : function (this: RuntimeDriverManagementPort, request: RuntimeSmokeRequest) {
              // Preserve the original drivers receiver and optional key absence.
              const native: RuntimeSmokeFixtureOptions = {
                get protocol() {
                  return request.protocol
                },
                get binaryPath() {
                  return input.targets.binary(request.target)
                },
              }
              for (const field of ['config', 'model', 'isSandbox', 'extraArgs'] as const) {
                if (field in request) {
                  Object.defineProperty(native, field, {
                    enumerable: true,
                    get: () => request[field],
                  })
                }
              }
              return fixture.call(this, native)
            })(input.runtimeDiagnosticTestDependencies?.smokeRuntime),
      assertSpawnCapabilities: assertRuntimeSpawnCapabilities,
    },
    modelDiscovery: {
      resolveTarget(protocol, binaryPath, config) {
        const driver = getRuntimeDriver(protocol)
        const binary = binaryPath ?? driver.defaultBinary(config)[0]!
        return input.targets.capture({ protocol: () => protocol, binaryPath: binary })
      },
      list: (protocol, target, refresh) =>
        getRuntimeDriver(protocol).listModels(input.targets.binary(target), { refresh }),
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
    get protocols() {
      return createRuntimeRegistryEffects().protocols
    },
  }
}
