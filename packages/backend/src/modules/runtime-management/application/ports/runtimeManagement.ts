import type {
  RuntimeRefConfig,
  RuntimeRegistryOperations,
  RuntimeRow,
} from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import type { RuntimeKind, RuntimeSmokeResult } from '../../public/types'
import type { RuntimeModelList } from '../../public/queries'

/** Read on demand, retaining the existing per-operation hot configuration semantics. */
export interface RuntimeManagementConfig extends RuntimeRefConfig {
  readonly opencodePath?: string | null
  readonly claudeCodePath?: string | null
}

export interface RuntimeManagementConfigPort {
  current(): RuntimeManagementConfig
  withProbeReceiptFence<T>(action: () => Promise<T>): Promise<T>
}

export interface RuntimeSmokeRequest {
  readonly protocol: RuntimeKind
  readonly binaryPath: string
  readonly config: Pick<RuntimeManagementConfig, 'opencodePath' | 'claudeCodePath'>
  readonly model?: string
  readonly isSandbox: boolean
  readonly extraArgs?: readonly string[]
}

export interface RuntimeDriverManagementPort {
  resolveBinary(
    row: Pick<RuntimeRow, 'protocol' | 'binaryPath'>,
    config: RuntimeManagementConfig,
  ): string
  probeStatus(
    protocol: RuntimeKind,
    binary: string,
    timeoutMs: number,
  ): Promise<{
    readonly binary: string
    readonly version: string | null
    readonly compatible: boolean
    readonly ran?: boolean
  }>
  smoke(input: RuntimeSmokeRequest): Promise<RuntimeSmokeResult>
  assertSpawnCapabilities(
    protocol: RuntimeKind,
    input: { readonly extraArgs?: readonly string[] | null; readonly isSandbox?: boolean },
  ): void
}

export interface RuntimeModelDiscoveryPort {
  resolveBinary(
    protocol: RuntimeKind,
    binaryPath: string | null,
    config: RuntimeManagementConfig,
  ): string
  list(protocol: RuntimeKind, binary: string, refresh: boolean): Promise<RuntimeModelList>
}

export interface RuntimeTestManagementPort {
  eligible(row: RuntimeRow): boolean
  reconcile(): Promise<void>
}

export interface RuntimeManagementDependencies {
  readonly registry: RuntimeRegistryOperations
  readonly config: RuntimeManagementConfigPort
  readonly drivers: RuntimeDriverManagementPort
  readonly modelDiscovery: RuntimeModelDiscoveryPort
  readonly tests: RuntimeTestManagementPort
  readonly statusProbeTimeoutMs: number
  readonly beforeProbeReceipt: () => void | Promise<void>
}
