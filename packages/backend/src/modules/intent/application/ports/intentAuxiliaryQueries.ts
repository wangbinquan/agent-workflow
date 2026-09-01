import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type { PlatformOnlyResourceType } from '../../domain/teaching/platformMap'

export interface IntentResolvedRuntime {
  readonly name: string
  readonly protocol: 'opencode' | 'claude-code'
  readonly binaryPath: string | null
  readonly configDir: RuntimeConfigDirProfile
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
  readonly isSandbox: boolean
  readonly extraArgs: readonly string[] | null
}

export interface IntentRuntimeInventoryRow {
  readonly name: string
  readonly protocol: IntentResolvedRuntime['protocol']
  readonly enabled: boolean
}

export interface IntentAgentPortNames {
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
}

/** Database-owned projections implemented by both native persistence providers. */
export interface IntentAuxiliaryPersistence {
  resolveIntentRuntime(name: string | null | undefined): Promise<IntentResolvedRuntime>
  listIntentRuntimeInventory(): Promise<readonly IntentRuntimeInventoryRow[]>
  loadIntentAgentPortNames(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, IntentAgentPortNames>>
}

export interface IntentTurnRuntimeResolver {
  resolve(input: {
    readonly runtimeName: string | null
    readonly defaultRuntime: string | null
  }): Promise<{
    readonly runtime: IntentResolvedRuntime
    readonly effectiveDefaultRuntime: {
      readonly name: string
      readonly protocol: IntentResolvedRuntime['protocol']
    }
  }>
}

export interface IntentPlatformInventoryRow {
  readonly id: string
  readonly name: string
  readonly description: string | null
}

/** Cross-context platform inventory is injected; Intent never reaches owner internals. */
export interface IntentPlatformInventoryParticipant {
  listRows(
    type: PlatformOnlyResourceType,
    actor: Actor,
  ): Promise<readonly IntentPlatformInventoryRow[]>
}

export interface IntentDumpAuxiliaryQueries {
  readonly runtimeInventory: {
    list(): Promise<readonly IntentRuntimeInventoryRow[]>
    resolveDefault(): Promise<{
      readonly name: string
      readonly protocol: IntentResolvedRuntime['protocol']
    }>
  }
  loadAgentPorts(ids: readonly string[]): Promise<ReadonlyMap<string, IntentAgentPortNames>>
  readonly platformInventory: IntentPlatformInventoryParticipant
}
