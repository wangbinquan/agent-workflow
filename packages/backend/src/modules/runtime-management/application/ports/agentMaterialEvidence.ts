import type { RuntimeUsageMeter, RuntimeUsageMeterInput } from '../../domain/usageMeter'
import type { NormalizedEvent } from './agentObservations'
import type { SystemAgentEventSinkV1 } from './agentSessionEvents'
import type { RuntimeSessionCapturePersistence } from './runtimeSessionCapturePersistence'
import type { AgentLiveCaptureRequest } from './agentLiveCapture'
import type { Logger } from '@/util/log'
import type { InventorySnapshot } from '@agent-workflow/shared'

/** Post-run subagent session capture. All location and fixture fields belong to
 * the selected implementation (RFC-465: the driver context adds them). */
export interface AgentSessionCaptureRequest {
  /** Native store/directory lookup key for this captured epoch. */
  rootSessionId: string
  /** Optional final logical root bucket when lookup and resume epochs differ. */
  logicalRootSessionId?: string
  nodeRunId: string
  taskId: string
  persistence: RuntimeSessionCapturePersistence
  log: Logger
  /** opencode: partId-level dedupe from the live poller (skip already-written rows). */
  alreadyInsertedPartIds?: ReadonlyMap<string, ReadonlySet<string>>
}
export type { AgentLiveCaptureRequest } from './agentLiveCapture'

/** RFC-237 — post-exit child-session sweep into a system agent's event sink. */
export interface SystemAgentSessionSweepRequest {
  rootSessionId: string
  sink: SystemAgentEventSinkV1
  log: Logger
}

export interface SystemAgentSessionSweepOutcome {
  failed: boolean
  failureReason?: unknown
}

/** Live evidence owns writes; post-run capture consumes its same read view. */
export interface AgentMaterialLiveCaptureStats {
  readonly ticks: number
  readonly insertedRows: number
  readonly failedTicks: number
  readonly disabled: boolean
  readonly insertedPartIdsBySession: ReadonlyMap<string, ReadonlySet<string>>
}

export interface AgentMaterialLiveCaptureHandle {
  stop(): void
  tickOnce(): Promise<number>
  stats(): AgentMaterialLiveCaptureStats
}

/** Invocation-local evidence. Absence has its original unsupported meaning;
 * callers never manufacture an empty or complete observation for it. This
 * contract contains no environment, run directory, binary or transcript path. */
export interface AgentMaterialEvidence {
  /** RFC-371 v2: invocation-local usage meter bound to the final child environment. */
  prepareUsageMeter?(input: RuntimeUsageMeterInput): RuntimeUsageMeter
  captureSessions(request: AgentSessionCaptureRequest): Promise<void>
  readInventory?(input: { readonly nodeKind: string }): Promise<InventorySnapshot | null>
  drainFinalEvents?(input: {
    readonly nodeKind: string
    readonly freshRun: boolean
  }): Promise<readonly NormalizedEvent[]>
  startLiveCapture?(request: AgentLiveCaptureRequest): AgentMaterialLiveCaptureHandle
  captureSessionsToSink?(
    request: SystemAgentSessionSweepRequest,
  ): Promise<SystemAgentSessionSweepOutcome>
}
