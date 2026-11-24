import type { DeclaredInjectionManifest, Mcp, StartupObservation } from '@agent-workflow/shared'
import type {
  McpDiagnosticEventSink,
  McpDiagnosticRunResult,
} from '../mcps/runtimeDiagnosticsEffects'
import type { McpRuntimeTestSessionRecord } from '../mcps/runtimeTestPersistence'

// RFC-564: the request vocabulary of a diagnostic run in Resource Catalog's own shapes. Task Execution's runners turn the
// intent into their material intent and feed the sink and the usage; no runtime-management type is named here.

/** One model's token usage in a diagnostic call, as the runner reports it; Resource Catalog only passes it on. */
export interface McpDiagnosticUsageModel {
  readonly model: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

export interface McpDiagnosticUsageSnapshot {
  readonly state: 'partial' | 'complete'
  readonly models: readonly McpDiagnosticUsageModel[]
}

/** One diagnostic call's system-agent observation, opened when the agent starts (hosted and local runners alike). */
export type McpDiagnosticObservation = (startedAt: number) => Promise<{
  readonly callId: string
  accept(): Promise<void>
  usage(snapshot: McpDiagnosticUsageSnapshot): Promise<void>
  finish(outcome: {
    readonly status: 'done' | 'failed' | 'canceled' | 'interrupted'
    readonly endedAt: number
    readonly usage: McpDiagnosticUsageSnapshot | null
  }): Promise<void>
}>

/** The diagnostic agent's runtime parameters, read from the selected runtime row. */
export interface McpDiagnosticProfile {
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
  readonly isSandbox: boolean
}

/** What one hosted diagnostic turn asks the runner to materialise: the one MCP under test and the diagnostic agent. */
export interface McpDiagnosticIntent {
  readonly protocol: McpRuntimeTestSessionRecord['runtimeProtocol']
  readonly injection: {
    readonly mcps: readonly Mcp[]
    readonly profile: McpDiagnosticProfile
  }
  readonly prompt: string
  readonly agentName: string
  readonly systemPrompt: string
  readonly resolvedProfiles: readonly (readonly [string, McpDiagnosticProfile])[]
  readonly freshAgentRun: boolean
  readonly resumeSessionId?: string | null
}

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
    readonly intent: McpDiagnosticIntent
    readonly policy: {
      readonly feature: string
      readonly abortSignal: AbortSignal
      readonly eventSink: McpDiagnosticEventSink
      readonly nativeIdentityAuthoritative: boolean
      readonly resumeSessionId?: string
    }
    readonly timeoutMs: number
    readonly maxEventTextBytes: number
    readonly beforeStart: () => Promise<void>
    readonly acknowledgeStarted: () => Promise<void>
    readonly observe?: McpDiagnosticObservation
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
