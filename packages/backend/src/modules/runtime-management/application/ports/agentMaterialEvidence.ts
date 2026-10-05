import type { NativeUsageCapture, NativeUsageCaptureIdentity } from './nativeUsageCapture'
import type { PreparedRuntimeSpanCapture } from '@/services/runtime/spanCapture'
import type { RuntimeUsageContext, RuntimeUsageFrame } from '@/services/runtime/usage'
import type {
  NormalizedEvent,
  SessionCaptureContext,
  SystemAgentSessionSweepContext,
  SystemAgentSessionSweepOutcome,
} from '@/services/runtime/types'
import type { AgentLiveCaptureRequest, AgentLiveCaptureHandle } from './agentLiveCapture'
import type { InventorySnapshot } from '@agent-workflow/shared'

/** All location and fixture fields belong to the selected implementation. */
export type AgentSessionCaptureRequest = Omit<
  SessionCaptureContext,
  'worktreePath' | 'configDirEnv' | 'configDirName' | 'opencodeDbPath'
>
export type { AgentLiveCaptureRequest } from './agentLiveCapture'

/** Invocation-local evidence. Absence has its original unsupported meaning;
 * callers never manufacture an empty or complete observation for it. This
 * contract contains no environment, run directory, binary or transcript path. */
export interface AgentMaterialEvidence {
  prepareUsageNormalizer?(): (raw: unknown, context: RuntimeUsageContext) => RuntimeUsageFrame
  prepareNativeUsageCapture?(identity: NativeUsageCaptureIdentity): NativeUsageCapture
  prepareSpanCapture?(input: { readonly invocationId: string }): PreparedRuntimeSpanCapture
  captureSessions(request: AgentSessionCaptureRequest): Promise<void>
  readInventory?(input: { readonly nodeKind: string }): Promise<InventorySnapshot | null>
  drainFinalEvents?(input: {
    readonly nodeKind: string
    readonly freshRun: boolean
  }): Promise<readonly NormalizedEvent[]>
  startLiveCapture?(request: AgentLiveCaptureRequest): AgentLiveCaptureHandle
  captureSessionsToSink?(
    request: SystemAgentSessionSweepContext,
  ): Promise<SystemAgentSessionSweepOutcome>
}
