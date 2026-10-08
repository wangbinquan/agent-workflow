import type { ObservationCapturedUsage, ObservationNativeProcessFact } from '@agent-workflow/shared'
import type { ObservationInvocationStart } from '@/modules/run-observability/public/participants'
import type {
  NativeUsageCapture,
  NativeUsageCaptureIdentity,
} from '@/modules/runtime-management/public/participants'
import type {
  RuntimeKind,
  RuntimeObservationIdentity,
} from '@/modules/runtime-management/public/types'

export type SystemObservationOwnerRef = object

export interface SystemAgentObservationDemand {
  readonly kind: string
  readonly originalId: string
  readonly originalAttempt: string
  readonly name: string
  readonly parentTaskId?: string | null
  readonly ownerUserId?: string | null
  readonly purpose?: 'system' | 'memory' | 'playground'
}

/** Issued only for one original System call, before its selected process starts. */
export interface SystemAgentObservationRun {
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly agentId: string | null
  readonly agentRevision: number | null
  readonly purpose: 'system' | 'memory' | 'playground'
  readonly runtime: ObservationInvocationStart['runtime']
  readonly durableOwner?: NonNullable<NativeUsageCaptureIdentity['durableOwner']>
  accept(input: {
    readonly nativeCaptureContract?: ObservationInvocationStart['nativeCaptureContract']
    readonly nativeCaptureSource?: string
  }): Promise<void>
  root(sessionId: string, previous?: string): Promise<void>
  append(evidence: readonly ObservationCapturedUsage[]): Promise<void>
  process(fact: ObservationNativeProcessFact): Promise<void>
  settle(outcome: string, finishedAt: number): Promise<void>
  reconcile(): Promise<void>
  finalize(capture: NativeUsageCapture, rootSessionId: string | null): Promise<void>
}

export interface SystemAgentObservationFactory {
  open(input: {
    readonly feature: string
    readonly agentName: string
    readonly protocol: RuntimeKind
    readonly runtimeObservationIdentity?: RuntimeObservationIdentity
    readonly resumeSessionId?: string
    readonly demand?: SystemAgentObservationDemand
    readonly startedAt: number
  }): Promise<SystemAgentObservationRun>
}
