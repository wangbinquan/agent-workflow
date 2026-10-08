import type { Logger } from '@/util/log'
import type {
  RuntimeKind,
  RuntimeObservationIdentity,
} from '@/modules/runtime-management/public/types'
import type {
  AgentMaterialWorkspace,
  AgentMaterialIntent,
} from '@/modules/runtime-management/public/participants'
import type { AgentInvocationPreparation } from './agentInvocationPreparation'
import type { AgentInvocationBinding } from './agentInvocation'
import type { RuntimeDiagnosticTarget } from '@/modules/runtime-management/public/participants'
import type { SystemAgentObservationRun } from './systemAgentObservation'

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
    observe?(nonce: string, startedAt: number): Promise<SystemAgentObservationRun>
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

/** An ordinary smoke invocation carries a selected target, never a command or
 * workspace location. Its family opens before nonce/workspace allocation. */
export interface RuntimeSmokeRunRequest extends RuntimeSmokeCorePolicy {
  readonly target: RuntimeDiagnosticTarget
  readonly runtimeObservationIdentity?: RuntimeObservationIdentity
  readonly extraArgs?: readonly string[]
  readonly isSandbox?: boolean
  readonly timeoutMs?: number
  readonly log?: Logger
}

export interface RuntimeSmokeRunFamily {
  run(request: RuntimeSmokeRunRequest): Promise<SmokeResult>
}

export interface RuntimeSmokeInvocationFamily {
  open(
    request: RuntimeSmokeRunRequest,
    log: Logger,
  ): { materialize(): RuntimeSmokeCoreInput['invocation'] }
}
