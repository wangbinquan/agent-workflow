// RFC-415 — the ports of the digital employee agent / script action executors (application/actionExecutionRunners.ts),
// moved verbatim from composition/actionExecutionRunners.ts. Providers appear only in the environment: launching a host
// task on a borrowed workspace, cancelling it, the read models, the task status read and the workspace entry check.
import type { TaskStatus } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { synthesizeDigitalEmployeeHostSnapshot } from '../../domain/digitalEmployeeHost'
import type {
  TaskExecutionOutcomeReadModel,
  TaskStatusProjectionReadModel,
} from '../../public/types'

export interface AgentExecutionFailure {
  readonly category: 'configuration' | 'transient' | 'contract-violation'
  readonly code: string
  readonly retryability: 'same-input' | 'after-configuration' | 'never'
  readonly attemptOrdinal: number
  readonly remediation: string
  readonly evidenceRef: null
}

export interface DigitalEmployeeLaunchInput {
  readonly actionRunId: string
  readonly capabilityId: string
  readonly agentId: string
  readonly prompt: string
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
  readonly wallTimeMs: number | null
}

export interface DigitalEmployeeScriptLaunchInput {
  readonly actionRunId: string
  readonly capabilityId: string
  readonly scriptRef: string
  readonly prompt: string
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
  readonly wallTimeMs: number | null
}

export type DigitalEmployeeExecutionSnapshot =
  | { readonly kind: 'not-found'; readonly executionRef: string }
  | { readonly kind: 'pending'; readonly executionRef: string; readonly taskStatus: string }
  | {
      readonly kind: 'exited'
      readonly executionRef: string
      readonly taskStatus: 'done' | 'failed' | 'canceled' | 'interrupted'
      readonly resultText: string | null
      readonly errorSummary: string | null
      readonly errorMessage: string | null
    }

export type ActionLaunchResult =
  | { readonly ok: true; readonly executionRef: string }
  | { readonly ok: false; readonly failure: AgentExecutionFailure }

export interface AgentActionExecutionRunner {
  launch(input: DigitalEmployeeLaunchInput): Promise<ActionLaunchResult>
  fetchOutcome(executionRef: string): Promise<DigitalEmployeeExecutionSnapshot>
  cancel(
    executionRef: string,
  ): Promise<{ readonly settled: 'canceled' | 'already-terminal' | 'not-found' }>
}

export interface ScriptActionExecutionRunner {
  launch(input: DigitalEmployeeScriptLaunchInput): Promise<ActionLaunchResult>
  fetchOutcome(executionRef: string): Promise<DigitalEmployeeExecutionSnapshot>
  cancel(
    executionRef: string,
  ): Promise<{ readonly settled: 'canceled' | 'already-terminal' | 'not-found' }>
}

/** 宿主任务的启动请求：工作区是调用方（development-automation）自己物化的，任务只是借用它。 */
export interface ActionHostTaskLaunch {
  /** 借用工作区的租约 id；provider 适配器把任务落在这个 id 上。 */
  readonly taskId: string
  readonly name: string
  readonly inputs: Readonly<Record<string, string>>
  readonly wallTimeMs: number | null
  readonly actionRunId: string
  /**
   * 合成的不可变宿主快照（agent 单节点 / script 单节点）。这里保持合成器的原始形状：SQLite 把它
   * 序列化进 `digitalEmployeeLaunch.snapshotJson`，PostgreSQL 用 schema 解析成启动主体的快照。
   */
  readonly snapshot: ReturnType<typeof synthesizeDigitalEmployeeHostSnapshot>
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
}

export interface ActionExecutionEnvironment {
  /** 宿主工作流播种、原始脚本定义与任务状态读取——两个引擎同一段 drizzle。 */
  readonly db: PersistenceDb
  readonly agents: Readonly<{
    get(id: string): Promise<{
      readonly id: string
      readonly name: string
      readonly outputs: readonly string[]
    } | null>
  }>
  readonly outcomes: TaskExecutionOutcomeReadModel
  readonly statusProjection: TaskStatusProjectionReadModel
  /** provider 私有：在借用工作区上启动宿主任务，返回 executionRef。 */
  launchHostTask(input: ActionHostTaskLaunch): Promise<string>
  /** provider 私有：取消宿主任务（已终态时抛错，由调用方兜成 already-terminal）。 */
  cancelHostTask(executionRef: string): Promise<void>
  /**
   * 终态回调，同步 / 异步都可以：唯一的消费者 `watchTerminal` 用 `.then(() => notify(ref))`
   * 接它，两种都会被等到。**这里的 `void |` 不是 dev-gotchas 警告的那种放宽**——那条说的是
   * 「产出方的 Promise 被调用方合法丢掉」；此处调用方显式串进了 promise 链。
   */
  readonly onTerminal?: (executionRef: string) => void | Promise<void>
  readonly terminalPollMs?: number
  /**
   * RFC-370 §10 V18: whether an entry exists below the action workspace (its
   * `.git`, an input mount). The selected workspace implementation interprets
   * the reference; a standalone daemon checks its own filesystem.
   * RFC-415: required here — the environment binding selects the standalone default.
   */
  readonly workspaceEntries: ActionWorkspaceEntries
  /** RFC-415: the task row's status (null when absent); the environment binding reads it. */
  taskStatus(executionRef: string): Promise<TaskStatus | null>
  /** RFC-415: the settled execution outcome projection (the binding uses the shared task-boundary projection). */
  executionOutcome(executionRef: string): Promise<{
    readonly outputs: Readonly<Record<string, { readonly content: string }>>
    readonly error?: { readonly summary: string | null; readonly message: string | null }
  }>
  /** RFC-415: settles once the task reaches a terminal status (the binding polls the status projection). */
  awaitTerminal(executionRef: string, pollMs: number): Promise<unknown>
}

export interface ActionWorkspaceEntries {
  exists(workspacePath: string, relativePath: string): Promise<boolean>
}
