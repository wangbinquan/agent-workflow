import type { ResolvedRuntimeProfile } from './types'
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

/** RFC-371: immutable registration identity and pricing metadata, without probing. */
export interface RuntimeObservationQueries {
  directory(): Promise<{
    readonly runtimes: readonly {
      readonly registrationId: string
      readonly name: string
      readonly configurationRevision: number
      readonly protocol: RuntimeKind
      readonly model: string | null
      readonly enabled: boolean
    }[]
  }>
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

export { isRuntimeMcpTestEligible } from '../infrastructure/mcpTestEligibility'

/** The original driver declares native capture support; callers do not select by protocol name. */
export { isRuntimeNativeUsageCaptureEligible } from '../infrastructure/local/localAgentMaterialDefinition'
