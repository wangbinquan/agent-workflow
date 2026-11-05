import type {
  CodeHostCustomRequest,
  CodeHostFailureCode,
  CodeHostProvider,
  CodeHostTemplateContext,
  TriggerContext,
} from '@agent-workflow/shared'
import type {
  createCodeHostEffectAttemptObserver,
  DurableCodeHostEffectObserver,
} from '../codeHostEffectObserver'
import type {
  CodeHostProbeOutcome,
  CodeHostRecoveryDescriptor,
} from '../../domain/codeHostRecovery'
import type { TaskExecutionEffectPersistence } from './taskExecutionEffectStore'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { ScriptInputPort, ScriptRunLedger } from './scriptNodeExecution'
import type { NodeStatusEvents } from './nodeExecutionSupport'

/** Facts used by the existing transport; the receiver is selected at call time. */
export interface CodeHostNodeConnection {
  provider: CodeHostProvider
  baseUrl: string
  repositoryUrlPrefixes: string[]
  connectionGeneration?: string
  token: string
  rejectUnauthorized: boolean
}
export type CodeHostNodeFetch = (url: string, init?: RequestInit) => Promise<Response>
/** RFC-449: resolves the configured connection of one provider; null when not
 * configured. Assembly injects the credential service (any service whose
 * resolved connection carries these facts fits). */
export interface CodeHostConnectionResolver {
  resolve(provider: CodeHostProvider): Promise<CodeHostNodeConnection | null>
}
export type CodeHostProjectFallback =
  | { ok: true; value: string }
  | { ok: false; code: CodeHostFailureCode; message: string }
export interface CodeHostRequestPort {
  executeCodeHostCall(
    spec: {
      provider: CodeHostProvider
      action: string
      params: Readonly<Record<string, string>>
      request?: CodeHostCustomRequest
      allowDestructive?: boolean
      timeoutMs?: number
    },
    deps: {
      connection: CodeHostNodeConnection
      ctx: CodeHostTemplateContext
      projectFallback: CodeHostProjectFallback
      fetchImpl?: CodeHostNodeFetch
      maxResponseBytes?: number
      attemptObserver?: DurableCodeHostEffectObserver
    },
  ): Promise<
    | {
        ok: true
        status: number
        body: string
        truncated: boolean
        method: string
        pathname: string
      }
    | { ok: false; code: CodeHostFailureCode; summary: string; message: string }
  >
  resolveProjectFallback(input: {
    provider: CodeHostProvider
    baseUrl: string
    repositoryUrlPrefixes: readonly string[]
    repoUrl: string | null
    repoCount: number
  }): CodeHostProjectFallback
  probeCodeHostMutation(input: {
    descriptor: CodeHostRecoveryDescriptor
    resolveConnection(provider: CodeHostProvider): Promise<CodeHostNodeConnection | null>
    fetchImpl?: CodeHostNodeFetch
    timeoutMs?: number
  }): Promise<CodeHostProbeOutcome>
}
export interface CodeHostNodeExecutionPorts {
  readonly task: {
    readonly taskId: string
    readonly workflowVersion: number | null
    readonly executionLineageId: string | null
    readonly repoUrl: string | null
    readonly repoCount: number
    readonly triggerContext: TriggerContext | null
  }
  readonly policy: {
    readonly codeHostConnections?: {
      resolve(provider: CodeHostProvider): Promise<CodeHostNodeConnection | null>
    }
    readonly codeHostRequestTimeoutMs?: number
    readonly codeHostResponseMaxBytes?: number
    readonly codeHostFetch?: CodeHostNodeFetch
  }
  readonly input: ScriptInputPort
  readonly ledger: Pick<
    ScriptRunLedger,
    'listNodeRuns' | 'resolveSchedulerRunRow' | 'setNodeRunStatus' | 'upsertOutputs'
  > & {
    read: NodeExecutionPersistence['read']
  }
  readonly effects: {
    readonly enabled: boolean
    planCodeHostAttempt: TaskExecutionEffectPersistence['planCodeHostAttempt']
    createCodeHostEffectAttemptObserver(
      input: Omit<
        Parameters<typeof createCodeHostEffectAttemptObserver>[0],
        'persistence' | 'context'
      >,
    ): DurableCodeHostEffectObserver
  }
  readonly requests: CodeHostRequestPort
  readonly codeHostSem: { acquire(): Promise<() => void> }
  readonly status: NodeStatusEvents
}
