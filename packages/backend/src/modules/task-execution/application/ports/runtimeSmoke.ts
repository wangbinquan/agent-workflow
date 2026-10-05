import type { Logger } from '@/util/log'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type {
  AgentMaterialWorkspace,
  AgentMaterialIntent,
} from '@/modules/runtime-management/public/participants'
import type { AgentInvocationPreparation } from './agentInvocationPreparation'
import type { AgentInvocationBinding } from './agentInvocation'

export type SmokeOutcome =
  | 'conforms'
  | 'spawn-failed'
  | 'auth-missing'
  // RFC-116: binary speaks the protocol but the model endpoint is unreachable
  // (403 region block / connection refused/timeout/DNS / missing proxy).
  | 'network-blocked'
  | 'model-call-failed'
  | 'stream-nonconforming'

export interface SmokeResult {
  outcome: SmokeOutcome
  conforms: boolean
  detail: string
  capturedSessionId?: string
  sawNonce: boolean
  sawEnvelope: boolean
  exitCode: number | null
}

export interface RuntimeSmokeCorePolicy {
  readonly protocol: RuntimeKind
  readonly model?: string
}

export interface RuntimeSmokeCompiledInvocation {
  bind(): AgentInvocationBinding
}

export interface RuntimeSmokeCoreInput {
  readonly log: Logger
  readonly timeoutMs: number
  readonly nonce: string
  readonly invocation: {
    readonly workspace: AgentMaterialWorkspace
    prepareWorkspace(): void | Promise<void>
    compile(prompt: string): Promise<RuntimeSmokeCompiledInvocation>
  }
}

export interface PreparedRuntimeSmokeOptions extends RuntimeSmokeCorePolicy {
  readonly preparation: AgentInvocationPreparation
  readonly runtimeBinding: NonNullable<AgentMaterialIntent['runtimeBinding']>
  readonly model?: string
  readonly extraArgs?: readonly string[]
  readonly isSandbox?: boolean
  readonly timeoutMs?: number
  readonly log?: Logger
}
