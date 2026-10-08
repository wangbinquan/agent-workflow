import type { WorkflowOutputEvidence } from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { IntentTurnSessionEventSink } from '../turnSession'

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

/** Intent's execution demand; the complete producer family satisfies it
 * directly, without a wrapper or a second execution/material implementation. */
export interface IntentSystemAgentRunRequest {
  readonly feature: string
  readonly agentName: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly protocol: 'opencode' | 'claude-code'
  readonly runtimeBinding?: IntentSystemRuntimeReference | null
  readonly configDirEnv?: string | null
  readonly configDirName?: string | null
  readonly model?: string | null
  readonly isSandbox?: boolean
  readonly seedFiles?: readonly { readonly path: string; readonly content: string }[]
  readonly workspaceScope: IntentSystemWorkspaceScope
  readonly timeoutMs?: number
  readonly maxEventTextBytes?: number
  readonly abortSignal?: AbortSignal
  readonly eventSink?: IntentTurnSessionEventSink
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
