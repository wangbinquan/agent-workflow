import type { DeclaredInjectionManifest, StartupObservation } from '@agent-workflow/shared'
import type {
  AgentMaterialIntent,
  SystemAgentEventSinkV1,
  RuntimeUsageSnapshot,
} from '@/modules/runtime-management/public/participants'
import type { McpDiagnosticRunResult } from '../mcps/runtimeDiagnosticsEffects'

/** The selected runner for one diagnostics-effects instance. */
export interface McpDiagnosticExecution {
  workspaceReference(sessionId: string): string
  workspaceExists(sessionId: string): Promise<boolean>
  cleanup(sessionId: string): Promise<boolean>
  hasExecution(turn: { readonly sessionId: string; readonly id: string }): Promise<boolean>
  settled(turn: { readonly sessionId: string; readonly id: string }): Promise<boolean>
  run(request: {
    readonly sessionId: string
    readonly turnId: string
    readonly intent: Pick<
      AgentMaterialIntent,
      | 'protocol'
      | 'injection'
      | 'prompt'
      | 'agentName'
      | 'systemPrompt'
      | 'resolvedProfiles'
      | 'freshAgentRun'
      | 'resumeSessionId'
    >
    readonly policy: {
      readonly feature: string
      readonly abortSignal: AbortSignal
      readonly eventSink: SystemAgentEventSinkV1
      readonly nativeIdentityAuthoritative: boolean
      readonly resumeSessionId?: string
    }
    readonly timeoutMs: number
    readonly maxEventTextBytes: number
    readonly beforeStart: () => Promise<void>
    readonly acknowledgeStarted: () => Promise<void>
    readonly observe?: (startedAt: number) => Promise<{
      readonly callId: string
      accept(): Promise<void>
      usage(snapshot: RuntimeUsageSnapshot): Promise<void>
      finish(outcome: {
        readonly status: 'done' | 'failed' | 'canceled' | 'interrupted'
        readonly endedAt: number
        readonly usage: RuntimeUsageSnapshot | null
      }): Promise<void>
    }>
  }): Promise<
    Omit<McpDiagnosticRunResult, 'verifyAfterCapture'> & {
      readonly declared?: DeclaredInjectionManifest
      readonly startupObservation?: StartupObservation
    }
  >
}

export type McpDiagnosticExecutionFactory = (extra: {
  readonly startupInventoryAvailable: (id: string) => Promise<boolean>
}) => McpDiagnosticExecution
