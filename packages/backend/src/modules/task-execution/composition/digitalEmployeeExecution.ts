import { and, desc, eq } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'

import {
  DAEMON_RESTART_ERROR_SUMMARY,
  isTerminalTaskStatus,
  type StartTask,
  type TaskStatus,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks } from '@/db/schema'
import type {
  DigitalEmployeeExecutionMetering,
  DigitalEmployeeExecutionParticipant,
  DigitalEmployeeHumanReviewState,
} from '../public/participants'
import {
  executionContractAgentImplementationSchema,
  executionContractImplementationSchema,
  EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
  buildExecutionContractAgentPrompt,
  type ExecutionContractParticipant,
  type ExecutionContractProjectionParticipant,
  type ExecutionContractRuntimeView,
} from '@/modules/execution-contract/public/types'
import { composeTaskCancellation } from './taskCancellation'
import { getTask } from '@/services/task'
import { NotFoundError } from '@/util/errors'
import { createTaskExecutionReadModels } from '../infrastructure/taskExecutionReadModels'
import { readTaskResourceUsage } from '@/services/limits'
import { sha256Hex } from '@/util/hash'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeReviewedDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
} from '../domain/digitalEmployeeHost'
import { borrowedPostgresqlWorkspace } from './actionExecutionEnvironment'
import { ensureDigitalEmployeeHostWorkflow } from './actionExecutionRunners'
import type { DigitalEmployeeWorkspacePort } from './required-ports'
import type {
  RootTaskLaunchKernel,
  RootTaskLaunchSubject,
} from '../infrastructure/taskRouteLaunchOperations'
import type { TaskExecutionReadModels } from '../public/types'
import type { TaskRouteOperations } from '../public/taskRoutes'

const exactRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

// RFC-317 T45（DE-08）—— implementation 联合直接用 execution-contract 的**导出 schema**。
//
// 这里原本逐字段手抄了一份：`exactRefSchema` / agent / workflow / program 四段，连
// `/^[a-f0-9]{64}$/` 的 digest 正则和 `z.enum(['bash','node','python'])` 都一模一样。
// 而本文件**早就**在 import `@/modules/execution-contract/public/types`（拿的是
// EXECUTION_CONTRACT_SCRIPT_INPUT_PORT 与 prompt 构造器），单一事实源只差一个标识符。
// 手抄的那份必然过期：内核加一种 implementation kind、或收紧某个字段，这里不会红——
// 它会安静地按旧形状解析，把新形态判成非法。

const programParametersSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseRef: exactRefSchema,
    roundRef: z.string().min(1),
    executionNonce: z.string().regex(/^[a-f0-9]{64}$/),
    toolSlotRef: z.string().min(1),
    connectionRef: exactRefSchema.nullable(),
    implementationRef: exactRefSchema.nullable(),
    implementationKind: z.enum(['agent', 'workflow', 'program']),
    implementationJson: z.string().min(2),
    inputEnvelopeJson: z.string().min(2),
    inputSchemaId: z.string().min(1),
    outputSchemaId: z.string().min(1),
    workContractRef: z
      .object({ contractId: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    semanticValidatorId: z.string().min(1),
    allowedEffectKinds: z.array(z.string().min(1).max(200)).max(100),
    roundBudgetMs: z.number().int().positive(),
    maxTotalTokens: z.number().int().positive().nullable().default(null),
  })
  .passthrough()

const environmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scratch') }).strict(),
  z.object({ kind: z.literal('cached-repository'), cachedRepoId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('repository-group'), repoGroupId: z.string().min(1) }).strict(),
])

const humanReviewSchema = z
  .object({
    kind: z.literal('implementation-plan'),
    artifactPort: z.string().min(1),
    documentPath: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    planningTool: z
      .object({
        slotRef: z.literal('plan'),
        registrationRef: exactRefSchema,
        workContractRef: z.union([
          z
            .object({ contractId: z.literal('development.analyze-plan'), version: z.literal(1) })
            .strict(),
          z
            .object({
              contractId: z.literal('development.plan-implementation'),
              version: z.literal(2),
            })
            .strict(),
        ]),
        implementation: executionContractAgentImplementationSchema,
      })
      .strict(),
  })
  .strict()

const inputEnvelopeSchema = z
  .object({
    executionEnvironmentJson: z.string().min(2),
    humanReview: humanReviewSchema.nullable().default(null),
  })
  .passthrough()

const attemptSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
    previousError: z.string().max(4_000).nullable(),
  })
  .strict()

function resultFailure(
  executionRef: string,
  // RFC-317 T31（DE-03）—— 类别是必传的第二个参数而不是可选项：新增一条失败路径时，
  // 作者必须当场说清它属于哪一类，而不是默认落进「不升级」。
  errorClass: WorkspaceFailureClass,
  errorCode: string,
  errorDetail: string,
  metering: DigitalEmployeeExecutionMetering,
) {
  return {
    kind: 'failed' as const,
    executionRef,
    errorClass,
    errorCode,
    errorDetail: errorDetail.slice(0, 2_000),
    metering,
  }
}

function containedArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

export function buildDigitalEmployeeFixedPrompt(
  plan: Pick<
    z.infer<typeof planSchema>,
    | 'roundRef'
    | 'executionNonce'
    | 'toolSlotRef'
    | 'semanticValidatorId'
    | 'inputEnvelopeJson'
    | 'allowedEffectKinds'
  >,
  attempt: Pick<z.infer<typeof attemptSchema>, 'previousError'>,
  guide: ExecutionContractRuntimeView,
): string {
  return buildExecutionContractAgentPrompt({
    guide,
    roundRef: plan.roundRef,
    executionNonce: plan.executionNonce,
    toolSlotRef: plan.toolSlotRef,
    semanticValidatorId: plan.semanticValidatorId,
    inputEnvelopeJson: plan.inputEnvelopeJson,
    allowedEffectKinds: plan.allowedEffectKinds,
    policyLines:
      guide.inputMode === 'direct-json'
        ? [
            'Use the available network and the repository, Git, and code-host read operations when they are useful for this action.',
            'Do not publish external changes: the platform owns commit, push, merge, comment publication, and approval submission.',
            'Only modify business files required by this action.',
          ]
        : [
            'Use read-only repository and Git inspection when it is useful for this action.',
            'Do not run Git commands that mutate the worktree or metadata, including add, commit, push, merge, rebase, reset, or checkout.',
            'Do not approve, call a code host, or choose the next action.',
            'Only modify business files allowed by the supplied workspace contract.',
          ],
    previousError: attempt.previousError,
  })
}

export function buildDigitalEmployeePlanPrompt(
  plan: Pick<z.infer<typeof planSchema>, 'inputEnvelopeJson'>,
  attempt: Pick<z.infer<typeof attemptSchema>, 'previousError'>,
  documentPath: string,
  inputMode: ExecutionContractRuntimeView['inputMode'] = 'direct-json',
): string {
  return [
    'You are writing an implementation plan for human review.',
    'Read the requirements directory and the relevant repository files before planning.',
    'Use the available network and repository, Git, or code-host reads when they help you verify the plan.',
    `Write the complete Markdown plan only to this exact platform path: ${documentPath}`,
    'Do not publish external changes: the platform owns commit, push, merge, comment publication, and approval submission.',
    'Do not modify business files while writing the plan.',
    `Publish exactly ${documentPath} through the analysis-plan output port; no other output path is accepted.`,
    'The plan must cover requirement understanding, affected code, implementation steps, tests, risks, assumptions, and unresolved questions.',
    inputMode === 'direct-json'
      ? ''
      : `EXPECTED_ANALYSIS_PLAN_PATH_JSON\n${JSON.stringify(documentPath)}`,
    attempt.previousError === null ? '' : `PREVIOUS_ERROR:\n${attempt.previousError}`,
    inputMode === 'direct-json' ? 'INPUT_JSON' : 'INPUT_ENVELOPE_JSON',
    plan.inputEnvelopeJson,
  ]
    .filter((line) => line.length > 0)
    .join('\n\n')
}

/**
 * 数字员工「计划人审」闸门的对外状态。
 *
 * RFC-359：这一条曾经是**同步**的、且只有 SQLite 那侧的 composition 提供——
 * `composeDigitalEmployeeExecution` 根本没有实现 `inspectHumanReview`，于是
 * PostgreSQL 上这个闸门永远退回按 round 状态推断，**报不出 `waiting`**：同一个案子在 SQLite 上
 * 显示「等待人审」，在 PG 上显示「规划中」。这是用户可见的行为分叉，也正是本 RFC 要消灭的形态。
 * 现在改成 async 的一份中立实现（查的是 `tasks` + `nodeRuns`，本来就没有方言），两侧 composition
 * 都装它。
 */
export async function inspectDigitalEmployeeHumanReviewState(
  db: ProviderNeutralDatabase,
  executionRef: string,
): Promise<'planning' | 'waiting' | 'approved' | 'failed' | null> {
  const task = await db
    .select({ inputs: tasks.inputs })
    .from(tasks)
    .where(eq(tasks.id, executionRef))
    .get()
  if (task === undefined) return null
  let parsedInputs: z.SafeParseReturnType<unknown, Record<string, unknown>>
  try {
    parsedInputs = z.record(z.string(), z.unknown()).safeParse(JSON.parse(task.inputs) as unknown)
  } catch {
    return null
  }
  if (
    !parsedInputs.success ||
    typeof parsedInputs.data[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY] !== 'string'
  ) {
    return null
  }
  const reviewRun = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, executionRef),
        eq(nodeRuns.nodeId, DIGITAL_EMPLOYEE_PLAN_REVIEW_NODE_ID),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .get()
  if (reviewRun?.status === 'awaiting_review') return 'waiting'
  if (reviewRun?.status === 'done') return 'approved'
  if (
    reviewRun !== undefined &&
    ['failed', 'canceled', 'interrupted', 'skipped', 'exhausted'].includes(reviewRun.status)
  ) {
    return 'failed'
  }
  return 'planning'
}

/**
 * 「这个执行还活着吗」的**唯一判据**。
 *
 * 两个调用点必须共用它，否则会各自漂开：
 *   - `inspect`：活着 ⇒ 报 `pending`，数字员工继续等；
 *   - `launch`：这个 ReactionRound 已经有一个活着的执行 ⇒ 复用它，不再建第二个任务。
 *
 * 注意 `interrupted` **是**终态（`shared/lifecycle.ts` 的 `TERMINAL_TASK_STATUSES` 含它），
 * 但「daemon 重启打断、自动恢复还没被停用」那一种是**要回来的**，必须算活着。这恰恰是崩溃
 * 窗口里那个孤儿的状态：只看 `isTerminalTaskStatus` 会把它判成死的，于是又起一个新任务。
 */
export function digitalEmployeeExecutionIsLive(input: {
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly autoRecoverySuspended: boolean
}): boolean {
  if (
    input.status === 'interrupted' &&
    input.errorSummary === DAEMON_RESTART_ERROR_SUMMARY &&
    !input.autoRecoverySuspended
  ) {
    return true
  }
  return !isTerminalTaskStatus(input.status)
}

export interface DigitalEmployeeExecutionDependencies {
  readonly appHome: string
  /**
   * **惰性**取 actor：只有 `launch` 用得到它，而 SQLite 那个组合根
   * （`server.ts` 的 `composeSqliteApiRouteMounts`）是**同步**函数，
   * 取不到 `await admitDaemonIdentity(...)`。惰性是两个组合根都成立的那半
   * （同 `actionExecutionEnvironment.ts` 的 `resolveActor`，plan §5hi）。
   */
  readonly resolveActor: () => Promise<Actor>
  readonly resourceAuthorityFor: (
    actor: Actor,
  ) => Parameters<RootTaskLaunchKernel['launch']>[0]['resourceAuthority']
  readonly launch: RootTaskLaunchKernel
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
  /**
   * 合成宿主工作流行的**幂等播种**（2026-09-19 回补）。
   *
   * `DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID` 是一个合成 id：只有这行 builtin 锚存在，执行任务的
   * `workflow_id` 才指得到东西。合一（`c932bc8e8`）时这一步被整个丢掉了，于是数字员工的执行
   * 任务落在一个**不存在的工作流**上；用户可见后果在人工评审这条路上炸——`getReviewDetail`
   * 拿 `task.workflowId` 查 workflows 查不到就抛 `review-not-found`，评审页只剩一句
   * 「Review not found.」：案例一直等着人工评审，评审人点进去打不开（e2e DE-28）。
   *
   * 按端口接进来而不是拿 `db` 自己写——这份 deps 刻意不带 db（两个 provider 各自绑定）。
   */
  readonly hostWorkflow: Readonly<{ ensure(): Promise<void> }>
  readonly executionMetadata: Readonly<{
    load(taskId: string): Promise<{
      readonly roundRef: string | null
      readonly autoRecoverySuspended: boolean
    } | null>
    /**
     * 按 ReactionRound 反查已经起过的执行（`tasks.digital_employee_round_id`，
     * 索引 `idx_tasks_digital_employee_round`）。`launch` 的幂等判据靠它。
     */
    findByRound(roundRef: string): Promise<
      readonly {
        readonly taskId: string
        readonly status: TaskStatus
        readonly errorSummary: string | null
        readonly autoRecoverySuspended: boolean
        readonly startedAt: number
      }[]
    >
  }>
  /**
   * RFC-359：计划人审闸门的状态读。SQLite 侧的 composition 直接拿 db 算，PG 侧这份 deps 不带 db，
   * 所以按端口接进来——装配处把同一个中立实现 `inspectDigitalEmployeeHumanReviewState` 绑到
   * PG 客户端上。此前这个方法在 PG 侧**根本不存在**，闸门只能按 round 状态推断、永远报不出
   * `waiting`。
   */
  readonly humanReview: Readonly<{
    inspect(executionRef: string): Promise<DigitalEmployeeHumanReviewState | null>
  }>
  readonly workspace?: DigitalEmployeeWorkspacePort
  readonly executionContracts: ExecutionContractParticipant & ExecutionContractProjectionParticipant
}

function parsedPlanOutputPath(planPrompt: string): string | null {
  const legacyExpectedMatch = /EXPECTED_ANALYSIS_PLAN_PATH_JSON\n("[^"\\]*(?:\\.[^"\\]*)*")/.exec(
    planPrompt,
  )
  const directInputMarker = '\n\nINPUT_JSON\n\n'
  const directInputStart = planPrompt.lastIndexOf(directInputMarker)
  if (directInputStart >= 0) {
    try {
      const directInput = z
        .object({ outputFile: z.string().min(1) })
        .passthrough()
        .safeParse(JSON.parse(planPrompt.slice(directInputStart + directInputMarker.length)))
      if (directInput.success) return directInput.data.outputFile
    } catch {
      return null
    }
  }
  if (legacyExpectedMatch?.[1] === undefined) return null
  try {
    return z.string().parse(JSON.parse(legacyExpectedMatch[1]) as unknown)
  } catch {
    return null
  }
}

/**
 * Digital Employee execution on the provider-selected root launch kernel.
 * It neither reopens a second database handle nor owns a second task writer.
 *
 * RFC-359 AC-1（plan §5hl）：此前这里有**两份**——SQLite 那份在函数体里直接读库、
 * 用 `startTask` + `preCreatedWorktree` 启动（按定义只服务 SQLite），
 * PostgreSQL 那份收端口、走启动内核。合一取端口 + 内核那半：
 * 内核在两个引擎上都真启动过（`rfc359-w5-kernel-launch-provider-parity`），
 * 库内缺省端口见下面的 `composeDatabaseDigitalEmployeeExecutionPorts`。
 */
export function composeDigitalEmployeeExecution(
  deps: DigitalEmployeeExecutionDependencies,
): DigitalEmployeeExecutionParticipant {
  const participant: DigitalEmployeeExecutionParticipant = {
    async launch(planJson: string, attemptJson: string) {
      const plan = planSchema.parse(JSON.parse(planJson) as unknown)
      const attempt = attemptSchema.parse(JSON.parse(attemptJson) as unknown)
      // RFC-294 E9-C 前置小修 —— **launch 对同一个 ReactionRound 幂等**。
      //
      // 数字员工侧的调用序列是「`launch()` 建任务 → `markRoundRunning()` 记下 executionRef」
      // （`digital-employee/application/runtimeService.ts:2587-2588`），两步之间没有事务；
      // 而「这一轮归谁做」只靠 outbox 行 60s 的租约兜着。daemon 在这中间重启，重启后那行
      // 租约已过期会被重新领走，于是同一个 round 起出第二个任务：第一个从此无人 inspect /
      // cancel（round 只记得住第二个），却继续吃 Case 的时长与 token 预算，并且和新任务
      // **写同一个 worktree**（同一个 round 解析出同一个 scene）。
      //
      // 反查落在这里而不是数字员工侧，是因为知识在这边：每次启动都会把 round 写进任务行
      // （`services/task.ts:2441` 的 `digitalEmployeeRoundId`），还带着索引；数字员工那边
      // 在 `markRoundRunning` 之前手上什么都没有。
      //
      // 重试路径天然不受影响：重试只在 `inspect` 判出终态失败之后发生，那时旧任务已经不活了。
      const launchedForRound = await deps.executionMetadata.findByRound(plan.roundRef)
      const live = [...launchedForRound]
        .filter((candidate) => digitalEmployeeExecutionIsLive(candidate))
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt || left.taskId.localeCompare(right.taskId),
        )
        .at(0)
      if (live !== undefined) return { executionRef: live.taskId }
      const implementation = executionContractImplementationSchema.parse(
        JSON.parse(plan.implementationJson) as unknown,
      )
      if (implementation.kind !== plan.implementationKind) {
        throw new Error('reaction plan implementation kind mismatch')
      }
      const envelope = inputEnvelopeSchema.parse(JSON.parse(plan.inputEnvelopeJson) as unknown)
      const environment = environmentSchema.parse(
        JSON.parse(envelope.executionEnvironmentJson) as unknown,
      )
      const scene =
        deps.workspace === undefined
          ? ({ kind: 'scratch' } as const)
          : await deps.workspace.prepare({ planJson: JSON.stringify(plan), attemptJson })
      const guide = deps.executionContracts.get(plan.workContractRef)
      const toolInputJson =
        deps.executionContracts.projectInput?.({
          contractRef: plan.workContractRef,
          roundRef: plan.roundRef,
          executionNonce: plan.executionNonce,
          inputEnvelopeJson: plan.inputEnvelopeJson,
          projectionJson: scene.kind === 'repository' ? scene.contractProjectionJson : null,
        }) ?? plan.inputEnvelopeJson
      const prompt = buildDigitalEmployeeFixedPrompt(
        { ...plan, inputEnvelopeJson: toolInputJson },
        attempt,
        guide,
      )
      const reviewedExecution = envelope.humanReview
      if (reviewedExecution && implementation.kind !== 'agent') {
        throw new Error('implementation plan review requires an Agent implementation')
      }
      const planPrompt = reviewedExecution
        ? buildDigitalEmployeePlanPrompt(
            {
              ...plan,
              inputEnvelopeJson:
                deps.executionContracts.projectInput?.({
                  contractRef: reviewedExecution.planningTool.workContractRef,
                  roundRef: plan.roundRef,
                  executionNonce: plan.executionNonce,
                  inputEnvelopeJson: plan.inputEnvelopeJson,
                }) ?? plan.inputEnvelopeJson,
            },
            attempt,
            reviewedExecution.documentPath,
            deps.executionContracts.get(reviewedExecution.planningTool.workContractRef).inputMode,
          )
        : null
      const task: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: `employee:${plan.roundRef}`.slice(0, 255),
        inputs:
          implementation.kind === 'program'
            ? { [EXECUTION_CONTRACT_SCRIPT_INPUT_PORT]: toolInputJson }
            : reviewedExecution
              ? {
                  [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt,
                  [DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]: planPrompt!,
                }
              : { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt },
        maxDurationMs: plan.roundBudgetMs,
        ...(plan.maxTotalTokens === null ? {} : { maxTotalTokens: plan.maxTotalTokens }),
        ...(scene.kind === 'repository'
          ? {}
          : environment.kind === 'scratch'
            ? { scratch: true }
            : environment.kind === 'cached-repository'
              ? { cachedRepoId: environment.cachedRepoId }
              : { repoGroupId: environment.repoGroupId }),
      }

      let subject: RootTaskLaunchSubject
      if (implementation.kind === 'workflow') {
        const workflow = await deps.workflows.get(implementation.workflowRef.id)
        if (workflow === null || workflow.version !== implementation.workflowRef.revision) {
          throw new Error(
            `exact workflow unavailable: ${implementation.workflowRef.id}@${implementation.workflowRef.revision}`,
          )
        }
        task.workflowId = workflow.id
        task.expectedWorkflowVersion = workflow.version
        task.inputs = { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt }
        subject = {
          workflowId: workflow.id,
          workflowName: workflow.name,
          workflowVersion: workflow.version,
          workflowSnapshot: workflow.definition,
          // 用户选定的既有工作流：保留作者几何，不重排（plan §5hn）。
          builtin: false,
        }
      } else {
        let snapshot: WorkflowDefinition
        if (implementation.kind === 'agent') {
          const agent = await deps.agents.get(implementation.agentRef.id)
          if (agent === null || agent.updatedAt !== implementation.agentRef.revision) {
            throw new Error(
              `exact agent unavailable: ${implementation.agentRef.id}@${implementation.agentRef.revision}`,
            )
          }
          if (!agent.outputs.includes(DIGITAL_EMPLOYEE_RESULT_PORT)) {
            throw new Error(`agent must expose ${DIGITAL_EMPLOYEE_RESULT_PORT}`)
          }
          if (reviewedExecution === null) {
            snapshot = WorkflowDefinitionSchema.parse(
              synthesizeDigitalEmployeeHostSnapshot({ agentId: agent.id, agentName: agent.name }),
            )
          } else {
            const planAgentRef = reviewedExecution.planningTool.implementation.agentRef
            const planAgent = await deps.agents.get(planAgentRef.id)
            if (planAgent === null || planAgent.updatedAt !== planAgentRef.revision) {
              throw new Error(
                `exact implementation plan Agent unavailable: ${planAgentRef.id}@${planAgentRef.revision}`,
              )
            }
            if (!planAgent.outputs.includes(reviewedExecution.artifactPort)) {
              throw new Error(
                `implementation plan Agent must expose ${reviewedExecution.artifactPort}`,
              )
            }
            snapshot = WorkflowDefinitionSchema.parse(
              synthesizeReviewedDigitalEmployeeHostSnapshot({
                planAgentId: planAgent.id,
                planAgentName: planAgent.name,
                implementationAgentId: agent.id,
                implementationAgentName: agent.name,
                artifactPort: reviewedExecution.artifactPort,
                documentPath: reviewedExecution.documentPath,
                reviewTitle: reviewedExecution.title,
                reviewDescription: reviewedExecution.description,
              }),
            )
          }
        } else {
          const artifactPath = containedArtifact(deps.appHome, implementation.executableArtifactRef)
          if (artifactPath === null || !existsSync(artifactPath)) {
            throw new Error('program executable artifact is unavailable')
          }
          const source = readFileSync(artifactPath, 'utf8')
          if (sha256Hex(source) !== implementation.executableDigest) {
            throw new Error('program executable artifact digest mismatch')
          }
          let parametersJson = '{}'
          if (implementation.parameterValuesRef !== null) {
            const parameterPath = containedArtifact(deps.appHome, implementation.parameterValuesRef)
            if (parameterPath === null || !existsSync(parameterPath)) {
              throw new Error('program parameter artifact is unavailable')
            }
            parametersJson = JSON.stringify(
              programParametersSchema.parse(
                JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown,
              ),
            )
          }
          snapshot = WorkflowDefinitionSchema.parse(
            synthesizeDigitalEmployeeScriptHostSnapshot({
              inputPort: EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
              language: implementation.runtimeKind,
              script: source,
              dependencies: [],
              env: {
                DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON: parametersJson,
                DIGITAL_EMPLOYEE_TOOL_CONNECTION_REF_JSON: JSON.stringify(plan.connectionRef),
                DIGITAL_EMPLOYEE_TOOL_SLOT: plan.toolSlotRef,
              },
              readonly: false,
            }),
          )
        }
        subject = {
          workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
          workflowName: '__digital_employee_host__',
          workflowVersion: 1,
          workflowSnapshot: snapshot,
          // 合成的宿主快照：写时冻结规范排版（plan §5hn）。
          builtin: true,
        }
      }

      // RFC-359 AC-1 回补（2026-09-19）：**宿主工作流行的幂等播种在合一（`c932bc8e8`）时丢了**。
      // `DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID` 是一个合成 id，只有这行 builtin 锚存在，任务的
      // `workflow_id` 才指得到东西。丢了之后数字员工的执行任务落在一个**不存在的工作流**上，
      // 用户可见后果在人工评审这条路上炸：`getReviewDetail` 拿 `task.workflowId` 查 workflows
      // 查不到 ⇒ `review-not-found`，评审页只剩一句「Review not found.」
      // ——案例一直等着人工评审，而评审人点进去打不开（e2e DE-28 实撞，连红三天）。
      // 播种必须在 launch **之前**：launch 那一笔就要写 task 行。
      await deps.hostWorkflow.ensure()
      const launchActor = await deps.resolveActor()
      const launched = await deps.launch.launch({
        actor: launchActor,
        resourceAuthority: deps.resourceAuthorityFor(launchActor),
        invoker: { type: 'user', launchKind: 'direct-json' },
        task,
        subject,
        internal: {
          catalogVisibility: 'internal',
          digitalEmployeeLaunch: {
            actionRunId: plan.roundRef,
            caseId: plan.caseRef.id,
          },
          ...(scene.kind === 'repository'
            ? {
                platformInputPaths: scene.platformInputPaths,
                workspace: borrowedPostgresqlWorkspace({
                  workspacePath: scene.workspacePath,
                  baselineSha: scene.baselineSha,
                }),
              }
            : {}),
        },
      })
      return { executionRef: launched.id }
    },

    async inspect(executionRef: string) {
      const task = await deps.tasks.get(executionRef)
      if (task === null) {
        return resultFailure(
          executionRef,
          'infrastructure',
          'execution-not-found',
          'TaskEngine execution is missing',
          { sourceRef: `task:${executionRef}`, durationMs: 0, totalTokens: 0 },
        )
      }
      const executionMetadata = await deps.executionMetadata.load(executionRef)
      if (
        digitalEmployeeExecutionIsLive({
          status: task.status,
          errorSummary: task.errorSummary,
          autoRecoverySuspended: executionMetadata?.autoRecoverySuspended === true,
        })
      ) {
        return { kind: 'pending', executionRef }
      }
      const usage = (await deps.resourceUsage.read(executionRef)) ?? {
        effectiveRunningMs: 0,
        totalTokens: 0,
      }
      const metering: DigitalEmployeeExecutionMetering = {
        sourceRef: `task:${executionRef}`,
        durationMs: usage.effectiveRunningMs,
        totalTokens: usage.totalTokens,
      }
      const outcome = await deps.readModels.executionOutcome.find(executionRef)
      if (outcome === null) {
        return resultFailure(
          executionRef,
          'infrastructure',
          'execution-outcome-missing',
          'TaskEngine execution outcome is missing',
          metering,
        )
      }
      if (task.status !== 'done') {
        return resultFailure(
          executionRef,
          'infrastructure',
          `execution-${task.status}`,
          outcome.task.errorMessage ?? outcome.task.errorSummary ?? `task ended as ${task.status}`,
          metering,
        )
      }
      const output =
        outcome.outputs.find(
          (candidate) => candidate.active && candidate.portName === DIGITAL_EMPLOYEE_RESULT_PORT,
        )?.content ?? null
      const planPrompt = task.inputs[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]
      if (typeof planPrompt === 'string') {
        const expectedPath = parsedPlanOutputPath(planPrompt)
        const planRunIds = new Set(
          outcome.runs
            .filter(
              (run) => run.nodeId === DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID && run.status === 'done',
            )
            .map((run) => run.id),
        )
        const planOutput = [...outcome.outputs]
          .reverse()
          .find(
            (candidate) =>
              candidate.active &&
              candidate.portName === 'analysis-plan' &&
              planRunIds.has(candidate.nodeRunId),
          )
        if (expectedPath === null || planOutput?.content.trim() !== expectedPath) {
          return resultFailure(
            executionRef,
            'semantic',
            'implementation-plan-path-mismatch',
            `analysis-plan must publish the exact platform path ${expectedPath ?? '<missing>'}`,
            metering,
          )
        }
      }
      const roundRef = executionMetadata?.roundRef ?? null
      if (deps.workspace !== undefined && roundRef !== null) {
        const validation = await deps.workspace.validate({
          roundRef,
          taskStatus: task.status,
          outputJson: output,
        })
        if (!validation.ok) {
          return resultFailure(
            executionRef,
            validation.errorClass,
            validation.errorCode,
            validation.errorDetail,
            metering,
          )
        }
      }
      if (output === null) {
        return resultFailure(
          executionRef,
          'semantic',
          'execution-output-missing',
          `task did not publish ${DIGITAL_EMPLOYEE_RESULT_PORT}`,
          metering,
        )
      }
      return { kind: 'completed', executionRef, outputJson: output, metering }
    },

    async inspectHumanReview(executionRef) {
      return await deps.humanReview.inspect(executionRef)
    },

    async cancel(executionRef: string) {
      const task = await deps.tasks.get(executionRef)
      if (task === null || isTerminalTaskStatus(task.status)) return
      await deps.tasks.cancel(executionRef)
    },
  }
  return Object.freeze(participant)
}

/**
 * RFC-359 AC-1（plan §5hl）—— 三个端口的**库内缺省实现**。
 *
 * 合一前 SQLite 那份 composer 在函数体里直接读库（`deps.db.select(...).get()`），
 * PostgreSQL 那份把同样三件事收成端口。合一取端口那半——它是两个引擎都成立的那种形状
 * （`.get()` 在 PG 上返回 Promise，在 SQLite 上返回值，直接读库的写法按定义只服务一个引擎）。
 * 但端口化不该让每个组合根各抄一遍同样的三段库读，所以缺省实现放在这里，
 * 装配方只在确有更好来源时（例如 PG daemon 的 `resourceLimitOperations`）覆盖它。
 */
export function composeDatabaseDigitalEmployeeExecutionPorts(
  db: ProviderNeutralDatabase,
): Pick<
  DigitalEmployeeExecutionDependencies,
  'tasks' | 'readModels' | 'resourceUsage' | 'executionMetadata' | 'humanReview' | 'hostWorkflow'
> {
  return Object.freeze({
    hostWorkflow: { ensure: () => ensureDigitalEmployeeHostWorkflow(db) },
    tasks: {
      get: (taskId: string) => getTask(db, taskId),
      async cancel(taskId: string) {
        await composeTaskCancellation(db).cancel(taskId)
        const task = await getTask(db, taskId)
        if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
        return task
      },
    },
    readModels: createTaskExecutionReadModels(db),
    resourceUsage: {
      read: (taskId: string) => readTaskResourceUsage(db, taskId),
    },
    executionMetadata: {
      async load(taskId: string) {
        const row = await db
          .select({
            roundRef: tasks.digitalEmployeeRoundId,
            autoRecoverySuspended: tasks.autoRecoverySuspended,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()
        return row ?? null
      },
      async findByRound(roundRef: string) {
        return await db
          .select({
            taskId: tasks.id,
            status: tasks.status,
            errorSummary: tasks.errorSummary,
            autoRecoverySuspended: tasks.autoRecoverySuspended,
            startedAt: tasks.startedAt,
          })
          .from(tasks)
          .where(eq(tasks.digitalEmployeeRoundId, roundRef))
          .all()
      },
    },
    humanReview: {
      inspect: (executionRef: string) => inspectDigitalEmployeeHumanReviewState(db, executionRef),
    },
  })
}
