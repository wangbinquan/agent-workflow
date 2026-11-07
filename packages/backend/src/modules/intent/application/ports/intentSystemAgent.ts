import type { WorkflowOutputEvidence } from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { IntentTurnEventRecord, IntentTurnRecord } from './intentPersistence'

/** RFC-464: the terminal capture states a turn settles to (the persistence port's `captureState`). */
export type IntentTurnCaptureTerminalState = Exclude<
  IntentTurnRecord['captureState'],
  'live' | null
>
/** RFC-464: why a turn's capture ended incomplete (the persistence port's `captureIncompleteReason`). */
export type IntentTurnCaptureIncompleteReason = NonNullable<
  IntentTurnRecord['captureIncompleteReason']
>
/** RFC-464: one event the system agent run observed — the fields the turn event log stores. */
export type IntentTurnObservedEvent = Pick<
  IntentTurnEventRecord,
  'ts' | 'kind' | 'payload' | 'sessionId' | 'parentSessionId' | 'source'
> & { readonly externalEventId?: string }

/** RFC-464: the observation-only sink a turn hands its system agent run. Declared here (intent does
 * not take runtime-management); the runner's session event sink contract is the same shape, locked by
 * the RFC-464 test member by member. Persisting it never decides the run's business result. */
export interface IntentTurnEventSink {
  append(event: IntentTurnObservedEvent): Promise<void>
  /** Persist that the current native root was invalidated before a replacement is known. */
  markRootSessionResetPending?(sessionId: string): Promise<void>
  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void>
  markTerminal(
    state: IntentTurnCaptureTerminalState,
    reason?: IntentTurnCaptureIncompleteReason,
  ): Promise<void>
}

/** Opaque selected content identity. Intent only forwards this exact object;
 * interpretation and lifetime remain with its selected content owner. */
export interface IntentSystemRuntimeReference {
  readonly owner: 'source-control' | 'resource-catalog' | 'runtime-management'
  readonly reference: string
  readonly version: string | number | null
}

export interface IntentSystemWorkspaceScope {
  readonly namespace: 'intent' | 'shared'
  readonly name?: string
}

/** A file the platform writes into the agent's scratch working directory before
 * spawn; `path` is relative (RFC-460: named here instead of borrowing the
 * system-agent run primitive's identical shape). */
export interface IntentSystemSeedFile {
  readonly path: string
  readonly content: string
}

/** Intent's execution demand; the complete producer family satisfies it
 * directly, without a wrapper or a second execution/material implementation. */
export interface IntentSystemAgentRunRequest {
  readonly feature: string
  readonly agentName: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly protocol: 'opencode' | 'claude-code'
  readonly runtimeObservationIdentity?: {
    readonly registrationId: string
    readonly configurationRevision: number
    readonly acceptedName?: string
  }
  readonly observationDemand?: {
    readonly kind: string
    readonly originalId: string
    readonly originalAttempt: string
    readonly name: string
    readonly ownerUserId?: string
    readonly purpose?: 'system'
  }
  readonly runtimeBinding?: IntentSystemRuntimeReference | null
  readonly configDirEnv?: string | null
  readonly configDirName?: string | null
  readonly model?: string | null
  readonly isSandbox?: boolean
  readonly seedFiles?: readonly IntentSystemSeedFile[]
  readonly workspaceScope: IntentSystemWorkspaceScope
  readonly timeoutMs?: number
  readonly maxEventTextBytes?: number
  readonly abortSignal?: AbortSignal
  readonly eventSink?: IntentTurnEventSink
  readonly retainScratchOnSuccess?: boolean
  readonly log?: Logger
}

export interface IntentSystemAgentRunResult {
  readonly status:
    | 'ok'
    | 'spawn-failed'
    | 'timeout'
    | 'aborted'
    | 'exit-nonzero'
    | 'result-error'
    | 'unreaped'
  readonly exitCode: number | null
  readonly eventText: string
  readonly stderrTail: string
  readonly durationMs: number
  readonly resultError?: string
  readonly capturedSessionId?: string
  readonly nativeSessionIntegrityFailed?: boolean
  readonly retainedRef: string
  readonly scratchRetained: boolean
  readonly outputEvidence: WorkflowOutputEvidence
}

export interface IntentSystemAgentRunFamily {
  readonly workspaces: {
    capture(input: IntentSystemWorkspaceScope): IntentSystemWorkspaceScope
  }
  run(request: IntentSystemAgentRunRequest): Promise<IntentSystemAgentRunResult>
  readonly retainedContents: {
    forget(input: { readonly retainedRef: string }): void
    release(input: {
      readonly retainedRef: string
      readonly scope: IntentSystemWorkspaceScope
    }):
      | { readonly removed: boolean; readonly reason?: 'unsafe-path' | 'remove-failed' }
      | Promise<{ readonly removed: boolean; readonly reason?: 'unsafe-path' | 'remove-failed' }>
  }
}
