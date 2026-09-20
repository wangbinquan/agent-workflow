import type { RuntimeProtocol, CreateRuntimeInput, UpdateRuntimeInput } from '../../public/types'
import type {
  RuntimeRow,
  RuntimeProbeTarget,
  ResolvedRuntime,
  RuntimeRefConfig,
} from '../../domain/runtimeProfile'
export type {
  RuntimeProtocol,
  RuntimeProfile,
  RuntimeView,
  CreateRuntimeInput,
  UpdateRuntimeInput,
  RuntimeProfileInput,
} from '../../public/types'
export type {
  RuntimeRow,
  RuntimeProbeTarget,
  ResolvedRuntime,
  RuntimeRefConfig,
  RuntimeExecutionProfileFingerprint,
} from '../../domain/runtimeProfile'

export interface RuntimeRegistryOperations {
  listRuntimes(): Promise<readonly RuntimeRow[]>
  getRuntime(name: string): Promise<RuntimeRow | null>
  resolveRuntimeByName(name: string | null | undefined): Promise<ResolvedRuntime>
  resolveAgentRuntime(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<ResolvedRuntime>
  resolveInternalAgentRuntime(input: {
    readonly runtimeName?: string | null
    readonly deprecatedModel?: string | null
    readonly defaultRuntime?: string | null
  }): Promise<ResolvedRuntime>
  createRuntime(input: CreateRuntimeInput): Promise<RuntimeRow>
  updateRuntime(name: string, input: UpdateRuntimeInput): Promise<RuntimeRow>
  cacheRuntimeProbe(target: RuntimeProbeTarget, smoke: unknown): Promise<boolean>
  invalidateInheritedRuntimeProbeReceipts(protocols: readonly RuntimeProtocol[]): Promise<number>
  setRuntimeEnabled(
    name: string,
    enabled: boolean,
    defaultRuntimeName: string | null | undefined,
  ): Promise<RuntimeRow>
  deleteRuntime(name: string, refs: RuntimeRefConfig): Promise<void>
  seedBuiltinRuntimes(): Promise<void>
  migrateConfigIntoBuiltins(config: {
    readonly opencodePath?: string | null
    readonly claudeCodePath?: string | null
  }): Promise<void>
  assertConfigDefaultsMigrated(configPath: string): Promise<void>
}

export interface RuntimeInsertRecord {
  readonly id: string
  readonly name: string
  readonly protocol: RuntimeProtocol
  readonly binaryPath: string | null
  readonly configDirEnv: string | null
  readonly configDirName: string | null
  readonly extraArgsJson: string | null
  readonly isSandbox: boolean
  readonly lastProbeJson: string | null
  readonly createdBy: string | null
  readonly model?: string | null
  readonly variant?: string | null
  readonly temperature?: number | null
  readonly steps?: number | null
  readonly maxSteps?: number | null
}

export interface RuntimeUpdateRecord {
  readonly model?: string | null
  readonly variant?: string | null
  readonly temperature?: number | null
  readonly steps?: number | null
  readonly maxSteps?: number | null
  readonly isSandbox?: boolean
  readonly extraArgsJson?: string | null
  readonly binaryPath?: string | null
  readonly configDirEnv?: string | null
  readonly configDirName?: string | null
  readonly lastProbeJson?: string | null
  readonly updatedAt: number
  readonly incrementProbeFence: boolean
}

export type RuntimeEnabledMutationResult =
  | { readonly status: 'not-found' }
  | { readonly status: 'default-cannot-disable' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'changed' }

export type RuntimeDeleteMutationResult =
  | { readonly status: 'not-found' }
  | { readonly status: 'last-runtime' }
  | { readonly status: 'in-use'; readonly references: readonly string[] }
  | { readonly status: 'deleted'; readonly binaryPath: string | null }

export interface RuntimeBuiltinProfileRecord {
  readonly name: string
  readonly protocol: RuntimeProtocol
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
}

/** Provider-owned, transaction-safe persistence primitives for the registry application. */
export interface RuntimeRegistryPersistence {
  listRuntimes(): Promise<readonly RuntimeRow[]>
  getRuntime(name: string): Promise<RuntimeRow | null>
  insertRuntime(record: RuntimeInsertRecord): Promise<void>
  updateRuntime(input: {
    readonly name: string
    readonly patch: RuntimeUpdateRecord
    readonly executionProfileChanged: boolean
  }): Promise<void>
  cacheRuntimeProbe(input: {
    readonly target: RuntimeProbeTarget
    readonly lastProbeJson: string
    readonly updatedAt: number
  }): Promise<boolean>
  invalidateInheritedRuntimeProbeReceipts(input: {
    readonly protocols: readonly RuntimeProtocol[]
    readonly now: number
  }): Promise<number>
  setRuntimeEnabled(input: {
    readonly name: string
    readonly enabled: boolean
    readonly effectiveDefaultName: string
    readonly now: number
  }): Promise<RuntimeEnabledMutationResult>
  deleteRuntime(input: {
    readonly name: string
    readonly refs: RuntimeRefConfig
    readonly builtinNames: ReadonlySet<string>
    readonly now: number
  }): Promise<RuntimeDeleteMutationResult>
  seedBuiltinRuntimes(
    builtins: readonly {
      readonly id: string
      readonly name: string
      readonly protocol: RuntimeProtocol
    }[],
  ): Promise<void>
  backfillBuiltinBinary(input: {
    readonly name: string
    readonly protocol: RuntimeProtocol
    readonly binaryPath: string
    readonly updatedAt: number
  }): Promise<void>
  listBuiltinProfiles(names: readonly string[]): Promise<readonly RuntimeBuiltinProfileRecord[]>
}
