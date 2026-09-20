import type { ResolvedRuntimeProfile, RuntimeProfileInspection } from './types'
import type { RuntimeView } from './types'
import type { RuntimeKind } from './types'

interface RuntimeStatusView {
  readonly name: string
  readonly protocol: RuntimeKind
  readonly binary: string
  readonly ok: boolean
  readonly version: string | null
  readonly reportedVersion: string | null
  readonly state: 'ready' | 'protocol-incompatible' | 'not-found'
  readonly isDefault: boolean
}

export interface RuntimeProfileQueries {
  list(): Promise<{
    readonly runtimes: readonly (RuntimeView & {
      readonly capabilities: { readonly mcpRuntimeTestV1: boolean }
    })[]
  }>
  status(): Promise<{ readonly runtimes: readonly RuntimeStatusView[] }>
}

export interface RuntimeModelList {
  readonly binary: string
  readonly models: readonly {
    readonly id: string
    readonly provider?: string
    readonly modelID?: string
    readonly name?: string
  }[]
  readonly cached: boolean
}

export type RuntimeModelQueryResult =
  | { readonly kind: 'listed'; readonly models: RuntimeModelList }
  | {
      readonly kind: 'unavailable'
      readonly error: {
        readonly ok: false
        readonly code: 'opencode-models-failed'
        readonly message: string
        readonly runtime: string | null
      }
    }

export interface RuntimeModelQueries {
  list(input: {
    readonly runtime?: string
    readonly refresh: boolean
  }): Promise<RuntimeModelQueryResult>
}

export interface RuntimeExecutionQueries {
  resolveRuntimeByName(name: string | null | undefined): Promise<ResolvedRuntimeProfile>
  resolveAgentRuntime(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<ResolvedRuntimeProfile>
  resolveInternalAgentRuntime(input: {
    readonly runtimeName?: string | null
    readonly deprecatedModel?: string | null
    readonly defaultRuntime?: string | null
  }): Promise<ResolvedRuntimeProfile>
}

export interface RuntimeProfileInspectionQueries {
  getRuntime(name: string): Promise<RuntimeProfileInspection | null>
}
