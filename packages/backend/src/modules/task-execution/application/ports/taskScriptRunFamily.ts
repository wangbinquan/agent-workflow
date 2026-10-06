import type { ScriptFailureCode, ScriptLanguage, WorkflowNode } from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { NodeExecutionPersistence } from './nodeExecutionPersistence'
import type { TaskExecutionContextRef } from './taskExecutionTopology'
import type { TaskExecutionEffectPersistence } from './taskExecutionEffectStore'
import type { ProcessEffectProjection } from './processEffectProjection'

/** Identities belong to the selected family. Ordinary Task policy forwards
 * them without interpreting a binary, run directory, dependency path or PID. */
export interface TaskScriptInterpreter {
  readonly kind: 'task-script-interpreter'
  readonly reference: object
  readonly label: string
  readonly version: string
}

export interface TaskScriptDependencyInterpreter {
  readonly kind: 'task-script-dependency-interpreter'
  readonly reference: object
}

export interface TaskScriptRunContent {
  readonly kind: 'task-script-run-content'
  readonly reference: object
}

export interface TaskScriptDependencyEnvironment {
  readonly kind: 'task-script-dependency-environment'
  readonly reference: object
  readonly hash: string
}

export interface TaskScriptStartReceipt {
  readonly kind: 'task-script-start'
  readonly reference: object
}

export interface TaskScriptResult {
  readonly outcome:
    | 'exited'
    | 'spawn-failed'
    | 'timeout'
    | 'aborted'
    | 'child-unkillable'
    | 'unreaped'
  readonly exitCode: number | null
  readonly rawStdout: string
  readonly stderrTail: string
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean }
  readonly spawnError?: string | undefined
  readonly settlement: { readonly kind: 'task-script-result'; readonly reference: object }
}

export interface TaskScriptOutcome {
  readonly result: TaskScriptResult
  readonly failureCode: ScriptFailureCode | null
}

export type TaskScriptEffectResources = readonly string[] | Readonly<{ writerWorkspace: string }>

/** The execution owner supplies the dialect; the existing application
 * coordinator still acquires ownership and acknowledges the start receipt. */
export interface TaskScriptStartProjection {
  project(
    persistence: TaskExecutionEffectPersistence,
    resources: TaskScriptEffectResources,
  ): ProcessEffectProjection<TaskScriptStartReceipt, TaskScriptResult>
}

export interface TaskScriptRunRequest {
  readonly node: WorkflowNode
  readonly inputs: Record<string, string>
  readonly runContent: TaskScriptRunContent
  readonly workspaceRef: string
  readonly repositories: ReadonlyArray<{ readonly name: string; readonly reference: string }>
  readonly taskId: string
  readonly nodeId: string
  readonly nodeRunId: string
  readonly iteration: number
  readonly retryIndex: number
  readonly shardKey: string | null
  readonly envelopeNonce: string
  readonly interpreter: TaskScriptInterpreter
  readonly dependencies: TaskScriptDependencyEnvironment | null
  readonly timeoutMs?: number
  readonly killEscalationGraceMs?: number
  readonly signal?: AbortSignal
  readonly beforeStart?: (projection: TaskScriptStartProjection) => Promise<void> | void
  readonly onStdoutLine?: (line: string) => Promise<void> | void
  readonly onStderrLine?: (line: string) => Promise<void> | void
  readonly onStarted?: (receipt: TaskScriptStartReceipt) => Promise<void> | void
  readonly requireStartReceipt?: boolean
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
  readonly log?: Logger
}

/** Shared error vocabulary; the compatibility service and native installer
 * export this same constructor so existing instanceof checks keep identity. */
export class ScriptDepsInstallError extends Error {
  readonly detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.name = 'ScriptDepsInstallError'
    this.detail = detail
  }
}

/** Complete bootstrap selection for one drive. A child binds its own family;
 * there are no native defaults or per-member compatibility fallbacks. */
export interface TaskScriptRunFamily {
  resolveInterpreter(
    language: ScriptLanguage,
    overrides: Partial<Record<ScriptLanguage, string>>,
  ): Promise<TaskScriptInterpreter | null>
  describeInterpreterResolution(
    language: ScriptLanguage,
    overrides: Partial<Record<ScriptLanguage, string>>,
  ): string
  prepareRunContent(taskId: string, nodeRunId: string): TaskScriptRunContent
  dependencyInterpreter(interpreter: TaskScriptInterpreter): TaskScriptDependencyInterpreter
  ensureDependencies(input: {
    readonly contentHomeRef: string
    readonly language: ScriptLanguage
    readonly interpreter: TaskScriptDependencyInterpreter
    readonly specs: readonly string[]
    readonly timeoutMs: number
    readonly signal?: AbortSignal
    readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => Promise<void> | void
    readonly log?: Logger
  }): Promise<TaskScriptDependencyEnvironment | null>
  execute(input: TaskScriptRunRequest): Promise<TaskScriptOutcome>
  runtimeParameters(input: {
    readonly interpreter: TaskScriptInterpreter
    readonly dependencies: TaskScriptDependencyEnvironment | null
  }): string
  recordUnownedStart(input: {
    readonly persistence: NodeExecutionPersistence
    readonly nodeRunId: string
    readonly receipt: TaskScriptStartReceipt
    readonly runtimeParamsJson: string
    readonly executionContext: () => { readonly executionContext?: TaskExecutionContextRef }
  }): Promise<void>
}
