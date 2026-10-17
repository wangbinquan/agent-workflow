import type {
  RuntimeKind,
  RuntimeObservationIdentity,
} from '@/modules/runtime-management/public/types'
import type { RuntimeUsageSnapshot } from '@/modules/runtime-management/public/participants'

// RFC-371 v2 §4 — a platform system-agent call is recorded like any other
// runtime call (purpose `system` with its kind), through the same contract.

export interface SystemAgentObservationDemand {
  readonly kind: string
  readonly originalId: string
  readonly originalAttempt: string
  readonly name: string
  readonly parentTaskId?: string | null
  readonly ownerUserId?: string | null
  readonly purpose?: 'system' | 'memory' | 'playground'
}

/** Issued for one system call before its process starts. */
export interface SystemAgentObservationRun {
  readonly callId: string
  /** Persist the call before spawn; a failure prevents the spawn. */
  accept(): Promise<void>
  usage(snapshot: RuntimeUsageSnapshot): Promise<void>
  finish(outcome: {
    readonly status: 'done' | 'failed' | 'canceled' | 'interrupted'
    readonly endedAt: number
    readonly usage: RuntimeUsageSnapshot | null
  }): Promise<void>
}

export interface SystemAgentObservationFactory {
  open(input: {
    /** Stable identity supplied by transports that can adopt a prior call. */
    readonly callId?: string
    readonly feature: string
    readonly agentName: string
    readonly protocol: RuntimeKind
    readonly runtimeObservationIdentity?: RuntimeObservationIdentity
    readonly resumeSessionId?: string
    readonly demand?: SystemAgentObservationDemand
    readonly startedAt: number
  }): Promise<SystemAgentObservationRun>
}
