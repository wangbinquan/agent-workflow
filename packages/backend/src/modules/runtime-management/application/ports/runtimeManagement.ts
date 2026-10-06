import type {
  RuntimeRefConfig,
  RuntimeRegistryOperations,
  RuntimeRow,
} from '@/modules/runtime-management/application/ports/runtimeRegistry'
import type { RuntimeKind, RuntimeSmokeResult } from '../../public/types'
import type { RuntimeModelList } from '../../public/queries'
import type { AgentMaterialContentReference } from './agentMaterial'

/** Read on demand, retaining the existing per-operation hot configuration semantics. */
export interface RuntimeManagementConfig extends RuntimeRefConfig {
  readonly opencodePath?: string | null
  readonly claudeCodePath?: string | null
}

export interface RuntimeManagementConfigPort {
  current(): RuntimeManagementConfig | Promise<RuntimeManagementConfig>
  withProbeReceiptFence<T>(action: () => Promise<T>): Promise<T>
}

/** Label and receiptKey retain the existing views and receipt comparison;
 * execution uses only the selected owner's opaque runtime binding. */
export interface RuntimeDiagnosticTarget {
  readonly protocol: RuntimeKind
  readonly label: string
  readonly receiptKey: string
  readonly runtimeBinding: AgentMaterialContentReference
}

export interface RuntimeSmokeRequest {
  readonly protocol: RuntimeKind
  readonly target: RuntimeDiagnosticTarget
  readonly config: Pick<RuntimeManagementConfig, 'opencodePath' | 'claudeCodePath'>
  readonly model?: string
  readonly isSandbox: boolean
  readonly extraArgs?: readonly string[]
}

export interface RuntimeDriverManagementPort {
  resolveTarget(
    row: Pick<RuntimeRow, 'protocol' | 'binaryPath'>,
    config: RuntimeManagementConfig,
  ): RuntimeDiagnosticTarget
  capture(input: {
    readonly protocol: () => RuntimeKind
    readonly binaryPath: string
  }): RuntimeDiagnosticTarget
  probeStatus(
    protocol: RuntimeKind,
    target: RuntimeDiagnosticTarget,
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
  resolveTarget(
    protocol: RuntimeKind,
    binaryPath: string | null,
    config: RuntimeManagementConfig,
  ): RuntimeDiagnosticTarget
  list(
    protocol: RuntimeKind,
    target: RuntimeDiagnosticTarget,
    refresh: boolean,
  ): Promise<RuntimeModelList>
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

/** A root selects the whole family, including its supported protocol view. */
export interface RuntimeManagementEffects extends Omit<RuntimeManagementDependencies, 'registry'> {
  readonly protocols: readonly RuntimeKind[]
}
