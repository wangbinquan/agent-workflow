import type { DeclaredInjectionManifest } from '@agent-workflow/shared'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
  SessionCaptureIncompleteReason,
  StartupInventory,
  SystemAgentEventSinkV1,
  SystemAgentOutputEvidence,
} from '@/modules/runtime-management/public/participants'
import type { Logger } from '@/util/log'
import type { AgentInvocationBinding } from './agentInvocation'
import type { AgentInvocationPreparation } from './agentInvocationPreparation'
import type {
  SystemAgentObservationDemand,
  SystemAgentObservationRun,
} from './systemAgentObservation'
import type { RuntimeObservationIdentity } from '@/modules/runtime-management/public/types'

export type SystemAgentRunStatus =
  | 'ok'
  | 'spawn-failed'
  | 'timeout'
  | 'aborted'
  | 'exit-nonzero'
  /** RFC-237 (P2-4): clean exit but the runtime reported a terminal
   *  application error (claude `result` with `is_error:true` — auth/API
   *  failures that previously masqueraded as a missing envelope). */
  | 'result-error'
  | 'unreaped'

export interface SystemAgentExecutionRecovery {
  readonly executionRef: string
  /** Original physical retirement and material cleanup, with no new invocation. */
  recoverOriginal(): Promise<boolean>
}

export interface SystemAgentExecutionReceipt {
  readonly executionRef: string
  readonly retainedRef: string
  readonly startedAt: number | null
  readonly recoveryRef: string | null
}

/** Consumer-owned durability. Prepared ACK precedes submit; started ACK
 * precedes activation where the selected native/hosted binding supports it. */
export interface SystemAgentExecutionReceiptSink {
  prepared(receipt: SystemAgentExecutionReceipt): Promise<void>
  started(receipt: SystemAgentExecutionReceipt): Promise<void>
}

export interface PreparedSystemAgentRunResult {
  status: SystemAgentRunStatus
  exitCode: number | null
  /** Concatenated PARSED-event text — the envelope extraction source. */
  eventText: string
  /** Capped stderr tail, credential-masked. */
  stderrTail: string
  durationMs: number
  /** RFC-237 (P2-4): masked terminal error text for `status: 'result-error'`. */
  resultError?: string
  capturedSessionId?: string
  /** Native resume identity was contradicted or reset without a replacement. */
  nativeSessionIntegrityFailed?: boolean
  /** Logical retained content identity, interpreted only by its owner. */
  retainedRef: string
  /** True when the scratch dir was deliberately kept (failure diagnosis / GC). */
  scratchRetained: boolean
  /** Present for an unknown original execution; its status remains unreaped. */
  executionRecovery?: SystemAgentExecutionRecovery
  executionReceipt?: SystemAgentExecutionReceipt
  /** The gated original helper retired without activating the target runtime. */
  executionNotActivated?: boolean
  /** Metadata-only stdout evidence; never contains assistant text. */
  outputEvidence: SystemAgentOutputEvidence
  /**
   * RFC-280 T6 — the runtime's one-shot startup report (claude init:
   * tools/agents/skills/mcp_servers with statuses), captured in-stream for the
   * startup-verification layer. Absent on runtimes that report none (opencode
   * observation rides the RFC-029 inventory file instead).
   */
  startupInventory?: StartupInventory
  /** RFC-282 B1b (§2.1b-2) — the declared manifest from THIS run's unified
   *  assembly. Absent on testPlanOverride fixture runs. Settle-time
   *  verification consumes this instead of re-rendering (same computation). */
  declared?: DeclaredInjectionManifest
}

/** The business policy remains independent of material locations and targets. */
export interface SystemAgentRunPolicy {
  /** Selected owner checks actual authority immediately before a new submit. */
  readonly admitExecution?: () => boolean
  readonly feature: string
  readonly abortSignal?: AbortSignal
  readonly eventSink?: SystemAgentEventSinkV1
  readonly nativeIdentityAuthoritative?: boolean
  readonly retainScratchOnSuccess?: boolean
  readonly observationDemand?: SystemAgentObservationDemand
  readonly runtimeObservationIdentity?: RuntimeObservationIdentity
  readonly resumeSessionId?: string
  readonly executionReceipts?: SystemAgentExecutionReceiptSink
}

export interface PreparedSystemAgentRunOptions extends SystemAgentRunPolicy {
  readonly preparation: AgentInvocationPreparation
  readonly intent: AgentMaterialIntent
  readonly seedFiles?: readonly { readonly path: string; readonly content: string }[]
  readonly timeoutMs?: number
  readonly maxEventTextBytes?: number
  readonly log?: Logger
}

/** Internal composition seam also preserves raw native fixtures with no declaration. */
export interface SystemAgentCompiledInvocation {
  readonly declared?: DeclaredInjectionManifest
  bind(): AgentInvocationBinding
  cleanup?(): void | Promise<void>
}

export interface SystemAgentCoreInvocation {
  readonly workspace: AgentMaterialWorkspace
  /** Keep admission at the original late start-receipt boundary. */
  acknowledgeStart(): boolean
  prepareWorkspace(): void | Promise<void>
  compile(): Promise<SystemAgentCompiledInvocation>
  observe?(startedAt: number): Promise<SystemAgentObservationRun>
}

export type { SessionCaptureIncompleteReason }
