import type {
  AgentMaterialEvidence,
  AgentSessionCaptureRequest,
  AgentLiveCaptureRequest,
} from '../../application/ports/agentMaterialEvidence'
import type { NativeUsageCaptureIdentity } from '../../application/ports/nativeUsageCapture'
import type {
  RuntimeDriver,
  SessionCaptureContext,
  SystemAgentSessionSweepContext,
} from '@/services/runtime/types'

/** Native API compatibility inputs; never an application or deployment port. */
export type NativeAgentMaterialEvidenceHooks = Pick<
  RuntimeDriver,
  | 'prepareUsageNormalizer'
  | 'prepareNativeUsageCapture'
  | 'prepareSpanCapture'
  | 'captureSessions'
  | 'readInventory'
  | 'drainFinalEvents'
  | 'startLiveCapture'
  | 'captureSessionsToSink'
>

export interface NativeAgentMaterialEvidenceScope {
  environment(): Readonly<Record<string, string | undefined>>
  runContent(): string
  sessionLocation(): Pick<
    SessionCaptureContext,
    'worktreePath' | 'configDirEnv' | 'configDirName' | 'opencodeDbPath'
  >
  /** Native fixture location only; the application live request never contains it. */
  liveLocation?(): { readonly opencodeDbPath?: string }
}

/** Resolve physical facts only after an original optional method is present.
 * Method lookup remains at the consumer's call point, and every original hook
 * retains its receiver. No registry, Paths or alternate native target is read. */
export function createLocalAgentMaterialEvidence(input: {
  readonly hooks: NativeAgentMaterialEvidenceHooks
  readonly scope: NativeAgentMaterialEvidenceScope
}): AgentMaterialEvidence {
  return {
    get prepareUsageNormalizer() {
      const method = input.hooks.prepareUsageNormalizer
      return method === undefined
        ? undefined
        : () => method.call(input.hooks, { env: input.scope.environment() })
    },
    get prepareNativeUsageCapture() {
      const method = input.hooks.prepareNativeUsageCapture
      return method === undefined
        ? undefined
        : (identity: NativeUsageCaptureIdentity) =>
            method.call(input.hooks, {
              env: input.scope.environment(),
              invocationId: identity.invocationId,
              taskId: identity.taskId,
              nodeRunId: identity.nodeRunId,
              agentId: identity.agentId,
              ...('resumeSessionId' in identity
                ? { resumeSessionId: identity.resumeSessionId }
                : {}),
              ...('nextRevision' in identity ? { nextRevision: identity.nextRevision } : {}),
              ...('durableOwner' in identity ? { durableOwner: identity.durableOwner } : {}),
            })
    },
    get prepareSpanCapture() {
      const method = input.hooks.prepareSpanCapture
      return method === undefined
        ? undefined
        : (identity: { readonly invocationId: string }) =>
            method.call(input.hooks, {
              env: input.scope.environment(),
              invocationId: identity.invocationId,
            })
    },
    get captureSessions() {
      const method = input.hooks.captureSessions
      return (request: AgentSessionCaptureRequest) => {
        const location = input.scope.sessionLocation()
        return method.call(input.hooks, {
          rootSessionId: request.rootSessionId,
          ...('logicalRootSessionId' in request
            ? { logicalRootSessionId: request.logicalRootSessionId }
            : {}),
          nodeRunId: request.nodeRunId,
          taskId: request.taskId,
          persistence: request.persistence,
          log: request.log,
          worktreePath: location.worktreePath,
          ...('configDirEnv' in location ? { configDirEnv: location.configDirEnv } : {}),
          ...('configDirName' in location ? { configDirName: location.configDirName } : {}),
          ...('opencodeDbPath' in location ? { opencodeDbPath: location.opencodeDbPath } : {}),
          ...('alreadyInsertedPartIds' in request
            ? { alreadyInsertedPartIds: request.alreadyInsertedPartIds }
            : {}),
        })
      }
    },
    get readInventory() {
      const method = input.hooks.readInventory
      return method === undefined
        ? undefined
        : (request: { readonly nodeKind: string }) =>
            method.call(input.hooks, {
              runRoot: input.scope.runContent(),
              nodeKind: request.nodeKind,
            })
    },
    get drainFinalEvents() {
      const method = input.hooks.drainFinalEvents
      return method === undefined
        ? undefined
        : (request: { readonly nodeKind: string; readonly freshRun: boolean }) =>
            method.call(input.hooks, {
              runRoot: input.scope.runContent(),
              nodeKind: request.nodeKind,
              freshRun: request.freshRun,
            })
    },
    get startLiveCapture() {
      const method = input.hooks.startLiveCapture
      return method === undefined
        ? undefined
        : (request: AgentLiveCaptureRequest) => {
            const location = input.scope.liveLocation?.()
            return method.call(input.hooks, {
              nodeRunId: request.nodeRunId,
              taskId: request.taskId,
              nodeId: request.nodeId,
              getRootSessionId: request.getRootSessionId,
              persistence: request.persistence,
              pollMs: request.pollMs,
              consecutiveFailureLimit: request.consecutiveFailureLimit,
              ...('log' in request ? { log: request.log } : {}),
              ...('signal' in request ? { signal: request.signal } : {}),
              ...('onInsert' in request ? { onInsert: request.onInsert } : {}),
              ...(location && 'opencodeDbPath' in location
                ? { opencodeDbPath: location.opencodeDbPath }
                : {}),
            })
          }
    },
    get captureSessionsToSink() {
      const method = input.hooks.captureSessionsToSink
      return method === undefined
        ? undefined
        : (request: SystemAgentSessionSweepContext) => method.call(input.hooks, request)
    },
  }
}
