// RFC-415 — the ports of the digital employee Reaction execution core (application/digitalEmployeeExecution.ts). The
// composition binds them from `DigitalEmployeeExecutionDependencies`: the read ports pass through, the program source is
// selected there, and `launchHost` is the narrow launch of one host task on the provider's root launch kernel.
import type { TaskStartOptions, WorkflowDefinition } from '@agent-workflow/shared'
import type {
  ExecutionContractParticipant,
  ExecutionContractProjectionParticipant,
} from '@/modules/execution-contract/public/types'
import type { DigitalEmployeeWorkspacePort } from '../../composition/required-ports'
import type { TaskExecutionReadModels } from '../../public/types'
import type { TaskRouteOperations } from '../../public/commands'
import type { DigitalEmployeeHumanReviewCoreSnapshot } from './digitalEmployeeExecutionCore'
import type { ProgramToolSource } from './scriptFixture'

/** One digital employee host task as the core asks for it; the binding maps it onto the root launch request. */
export interface DigitalEmployeeHostLaunch {
  /** The execution identity the admission transaction preallocated. */
  readonly taskId: string
  readonly roundRef: string
  readonly caseId: string
  readonly task: TaskStartOptions
  readonly subject:
    | {
        readonly kind: 'workflow'
        readonly workflowId: string
        readonly workflowName: string
        readonly workflowVersion: number
        readonly workflowSnapshot: WorkflowDefinition
      }
    | { readonly kind: 'digital-employee'; readonly workflowSnapshot: WorkflowDefinition }
  /** A materialized repository scene the task borrows; null for scratch / cached / group environments. */
  readonly repository: {
    readonly platformInputPaths: readonly string[]
    readonly workspacePath: string
    readonly baselineSha: string
  } | null
}

export interface DigitalEmployeeExecutionPorts {
  /** The selected program artifact store (the composition supplies the standalone file store when none is selected). */
  readonly programs: ProgramToolSource
  launchHost(request: DigitalEmployeeHostLaunch): Promise<{ readonly id: string }>
  /**
   * The task-boundary output projection of an execution outcome (settled-run freshness, inactive branches) — the same
   * projection every caller uses; the composition binds it.
   */
  projectOutcome(
    outcome: NonNullable<Awaited<ReturnType<TaskExecutionReadModels['executionOutcome']['find']>>>,
  ): Promise<{
    readonly outputs: Readonly<
      Record<string, { readonly content: string; readonly active?: boolean }>
    >
  }>
  readonly tasks: Pick<TaskRouteOperations, 'get' | 'cancel'>
  readonly readModels: Pick<TaskExecutionReadModels, 'executionOutcome'>
  readonly resourceUsage: Readonly<{
    read(taskId: string): Promise<{
      readonly effectiveRunningMs: number
      readonly totalTokens: number
    } | null>
  }>
  readonly agents: Readonly<{
    get(id: string): Promise<{
      readonly id: string
      readonly name: string
      readonly updatedAt: number
      readonly outputs: readonly string[]
    } | null>
  }>
  readonly workflows: Readonly<{
    get(id: string): Promise<{
      readonly id: string
      readonly name: string
      readonly version: number
      readonly definition: WorkflowDefinition
    } | null>
  }>
  readonly executionMetadata: Readonly<{
    load(taskId: string): Promise<{
      readonly roundRef: string | null
      readonly autoRecoverySuspended: boolean
    } | null>
  }>
  /**
   * RFC-359：计划人审闸门的状态读。SQLite 侧的 composition 直接拿 db 算，PG 侧这份 deps 不带 db，
   * 所以按端口接进来——装配处把同一个中立实现 `inspectDigitalEmployeeHumanReviewSnapshot` 绑到
   * PG 客户端上。此前这个方法在 PG 侧**根本不存在**，闸门只能按 round 状态推断、永远报不出
   * `waiting`。
   */
  readonly humanReview: Readonly<{
    /** RFC-368：六态快照（`unknown` 与 `not-applicable` 分开）。 */
    inspect(executionRef: string): Promise<DigitalEmployeeHumanReviewCoreSnapshot>
  }>
  readonly workspace?: DigitalEmployeeWorkspacePort
  /** Observe committed intermediate artifacts during the existing execution inspection. */
  readonly committedProgress?: {
    observe(input: { readonly roundRef: string; readonly executionRef: string }): Promise<void>
  }
  readonly executionContracts: ExecutionContractParticipant & ExecutionContractProjectionParticipant
}
