// RFC-415 — the digital employee Reaction execution core, moved verbatim from composition/digitalEmployeeExecution.ts into
// the application layer: plan / attempt / environment parsing, the fixed and plan-review prompts, exact implementation
// references and host snapshots per implementation kind, launch, inspection (completed / failed / stopped, the plan path
// and workspace semantic checks) and cancel. It runs on DigitalEmployeeExecutionPorts; the composition binds the
// provider's root launch kernel behind `launchHost`.
import { createRunHistorySnapshot } from '@/modules/task-execution/public/queries'
import {
  utf16MaxLength,
  utf16MinLength,
  DAEMON_RESTART_ERROR_SUMMARY,
  WorkflowDefinitionSchema,
  isTerminalTaskStatus,
  type TaskStartOptions,
  type TaskStatus,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { z } from 'zod'
import {
  EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
  buildExecutionContractAgentPrompt,
  executionContractAgentImplementationSchema,
  executionContractImplementationSchema,
  type ExecutionContractRuntimeView,
} from '@/modules/execution-contract/public/types'
import type {
  DigitalEmployeeExecutionCore,
  DigitalEmployeeExecutionCoreSnapshot,
  DigitalEmployeeExecutionMeteringV1,
  TaskExecutionFailureClass,
} from './ports/digitalEmployeeExecutionCore'
import type {
  DigitalEmployeeExecutionPorts,
  DigitalEmployeeHostLaunch,
} from './ports/digitalEmployeeExecution'
import {
  DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
  synthesizeReviewedDigitalEmployeeHostSnapshot,
} from '../domain/digitalEmployeeHost'
import { taskStopProjection } from '../domain/sourceTermination'

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
    implementationJson: z.string().check(utf16MinLength(2)),
    inputEnvelopeJson: z.string().check(utf16MinLength(2)),
    inputSchemaId: z.string().min(1),
    outputSchemaId: z.string().min(1),
    workContractRef: z
      .object({ contractId: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    semanticValidatorId: z.string().min(1),
    allowedEffectKinds: z.array(z.string().min(1).check(utf16MaxLength(200))).max(100),
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
    executionEnvironmentJson: z.string().check(utf16MinLength(2)),
    humanReview: humanReviewSchema.nullable().default(null),
  })
  .passthrough()

const attemptSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    mode: z.enum(['initial', 'same-scene', 'fresh-scene']),
    previousError: z.string().check(utf16MaxLength(4_000)).nullable(),
  })
  .strict()

function resultFailure(
  // RFC-317 T31（DE-03）—— 类别是必传的第一个参数而不是可选项：新增一条失败路径时，
  // 作者必须当场说清它属于哪一类，而不是默认落进「不升级」。
  errorClass: TaskExecutionFailureClass,
  errorCode: string,
  errorDetail: string,
  metering: DigitalEmployeeExecutionMeteringV1,
  workspaceRoot: string | null,
): DigitalEmployeeExecutionCoreSnapshot {
  return {
    kind: 'failed',
    errorClass,
    errorCode,
    errorDetail: errorDetail.slice(0, 2_000),
    workspaceRoot,
    metering,
  }
}

/** The execution's own failure text for each program source check. */
function programSourceFailure(code: string): string {
  if (code === 'program-artifact-digest') return 'program executable artifact digest mismatch'
  if (code.startsWith('program-parameter-artifact-'))
    return 'program parameter artifact is unavailable'
  return 'program executable artifact is unavailable'
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
 * 「这个执行还活着吗」的**唯一判据**：活着 ⇒ `inspect` 报 `pending`，数字员工继续等。
 *
 * 注意 `interrupted` **是**终态（`shared/lifecycle.ts` 的 `TERMINAL_TASK_STATUSES` 含它），
 * 但「daemon 重启打断、自动恢复还没被停用」那一种是**要回来的**，必须算活着——否则会被当成
 * 失败、白烧一次重试预算再起一轮。
 *
 * RFC-368：它曾同时是 `launch` 按 round 反查去重的判据（E9-C 前置小修 `56bb82b50`）。新合同下
 * 执行身份在 admission 事务里预分配、重放按 id 命中，那套按 round 推断活性的兜底随旧路径删除。
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
export function createDigitalEmployeeExecutionCore(
  ports: DigitalEmployeeExecutionPorts,
): DigitalEmployeeExecutionCore {
  /**
   * RFC-368 T7 —— 启动的 **typed 核心**：plan / attempt 收对象而不是 JSON 字符串；`taskId` 是
   * admission 事务里预分配的执行身份，内核拿它当 taskId。重放由调用方先经 `executionExists`
   * 判断，这里不再按 round 推断活性（旧路径那套兜底随 RFC-368 刀 3 删除）。
   */
  async function launchCore(
    planInput: unknown,
    attemptInput: unknown,
    taskId: string,
  ): Promise<{ readonly executionRef: string }> {
    const plan = planSchema.parse(planInput)
    const attempt = attemptSchema.parse(attemptInput)
    const attemptJson = JSON.stringify(attempt)
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
      ports.workspace === undefined
        ? ({ kind: 'scratch' } as const)
        : await ports.workspace.prepare({ planJson: JSON.stringify(plan), attemptJson })
    const guide = ports.executionContracts.get(plan.workContractRef)
    const toolInputJson =
      ports.executionContracts.projectInput?.({
        contractRef: plan.workContractRef,
        roundRef: plan.roundRef,
        executionNonce: plan.executionNonce,
        inputEnvelopeJson: plan.inputEnvelopeJson,
        projectionJson: scene.kind === 'repository' ? scene.contractProjectionJson : null,
      }) ?? plan.inputEnvelopeJson
    const fixedPrompt = buildDigitalEmployeeFixedPrompt(
      { ...plan, inputEnvelopeJson: toolInputJson },
      attempt,
      guide,
    )
    const materialInstructions =
      scene.kind === 'repository' ? scene.materialInstructions : undefined
    // Prefix material directions so INPUT_JSON remains the final, unchanged business payload.
    const prompt = materialInstructions ? `${materialInstructions}\n\n${fixedPrompt}` : fixedPrompt
    const reviewedExecution = envelope.humanReview
    if (reviewedExecution && implementation.kind !== 'agent') {
      throw new Error('implementation plan review requires an Agent implementation')
    }
    const planPrompt = reviewedExecution
      ? buildDigitalEmployeePlanPrompt(
          {
            ...plan,
            inputEnvelopeJson:
              ports.executionContracts.projectInput?.({
                contractRef: reviewedExecution.planningTool.workContractRef,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                inputEnvelopeJson: plan.inputEnvelopeJson,
              }) ?? plan.inputEnvelopeJson,
          },
          attempt,
          reviewedExecution.documentPath,
          ports.executionContracts.get(reviewedExecution.planningTool.workContractRef).inputMode,
        )
      : null
    const task: TaskStartOptions = {
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

    let subject: DigitalEmployeeHostLaunch['subject']
    if (implementation.kind === 'workflow') {
      const workflow = await ports.workflows.get(implementation.workflowRef.id)
      if (workflow === null || workflow.version !== implementation.workflowRef.revision) {
        throw new Error(
          `exact workflow unavailable: ${implementation.workflowRef.id}@${implementation.workflowRef.revision}`,
        )
      }
      task.expectedWorkflowVersion = workflow.version
      task.inputs = { [DIGITAL_EMPLOYEE_PROMPT_KEY]: prompt }
      subject = {
        kind: 'workflow',
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowVersion: workflow.version,
        workflowSnapshot: workflow.definition,
      }
    } else {
      let snapshot: WorkflowDefinition
      if (implementation.kind === 'agent') {
        const agent = await ports.agents.get(implementation.agentRef.id)
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
          const planAgent = await ports.agents.get(planAgentRef.id)
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
        // RFC-370 §10 V19: the selected program store (platform objects when
        // hosted); the application home only for a standalone daemon.
        const program = await ports.programs.read(implementation)
        if (program.kind === 'failed') throw new Error(programSourceFailure(program.check.code))
        const source = program.source
        const parametersJson = JSON.stringify(
          programParametersSchema.parse(JSON.parse(program.parameterValuesJson) as unknown),
        )
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
              ...(materialInstructions
                ? { DIGITAL_EMPLOYEE_MATERIAL_INSTRUCTIONS: materialInstructions }
                : {}),
            },
            readonly: false,
          }),
        )
      }
      subject = { kind: 'digital-employee', workflowSnapshot: snapshot }
    }

    // RFC-415: the root launch request (actor, resource authority, invoker, subject, internal facts and the borrowed
    // workspace) is assembled by the composition binding.
    const launched = await ports.launchHost({
      taskId,
      roundRef: plan.roundRef,
      caseId: plan.caseRef.id,
      task,
      subject,
      repository:
        scene.kind === 'repository'
          ? {
              platformInputPaths: scene.platformInputPaths,
              workspacePath: scene.workspacePath,
              baselineSha: scene.baselineSha,
            }
          : null,
    })
    return { executionRef: launched.id }
  }

  /** 按任务行判执行结果；`stopped` 由调用方在它之前判（见 `core.inspect`）。 */
  async function inspectTask(executionRef: string): Promise<DigitalEmployeeExecutionCoreSnapshot> {
    const task = await ports.tasks.get(executionRef)
    if (task === null) {
      return resultFailure(
        'infrastructure',
        'execution-not-found',
        'TaskEngine execution is missing',
        { sourceRef: `task:${executionRef}`, durationMs: 0, totalTokens: 0 },
        null,
      )
    }
    const executionMetadata = await ports.executionMetadata.load(executionRef)
    if (executionMetadata?.roundRef && ports.committedProgress) {
      await ports.committedProgress.observe({ roundRef: executionMetadata.roundRef, executionRef })
    }
    if (
      digitalEmployeeExecutionIsLive({
        status: task.status,
        errorSummary: task.errorSummary,
        autoRecoverySuspended: executionMetadata?.autoRecoverySuspended === true,
      })
    ) {
      return { kind: 'pending' }
    }
    const usage = (await ports.resourceUsage.read(executionRef)) ?? {
      effectiveRunningMs: 0,
      totalTokens: 0,
    }
    const metering: DigitalEmployeeExecutionMeteringV1 = {
      sourceRef: `task:${executionRef}`,
      durationMs: usage.effectiveRunningMs,
      totalTokens: usage.totalTokens,
    }
    const outcome = await ports.readModels.executionOutcome.find(executionRef)
    if (outcome === null) {
      return resultFailure(
        'infrastructure',
        'execution-outcome-missing',
        'TaskEngine execution outcome is missing',
        metering,
        task.worktreePath,
      )
    }
    if (task.status !== 'done') {
      return resultFailure(
        'infrastructure',
        `execution-${task.status}`,
        outcome.task.errorMessage ?? outcome.task.errorSummary ?? `task ended as ${task.status}`,
        metering,
        task.worktreePath,
      )
    }
    // A workflow can publish this port on intermediate agents as well as its
    // output node. Use the same task-boundary projection as every other caller,
    // including settled-run freshness and inactive-branch semantics.
    const resultPort = (await ports.projectOutcome(outcome)).outputs[DIGITAL_EMPLOYEE_RESULT_PORT]
    const output = resultPort?.active === false ? null : (resultPort?.content ?? null)
    const planPrompt = task.inputs[DIGITAL_EMPLOYEE_PLAN_PROMPT_KEY]
    if (typeof planPrompt === 'string') {
      const expectedPath = parsedPlanOutputPath(planPrompt)
      const planRun = (
        await createRunHistorySnapshot(
          executionRef,
          outcome.runs.map((run) => ({ ...run, taskId: executionRef })),
        ).familyHistory(
          executionRef,
          { nodeId: DIGITAL_EMPLOYEE_PLAN_AGENT_NODE_ID },
          { statusIn: ['done'] },
        )
      ).at(-1)
      const planOutput = outcome.outputs.find(
        (candidate) =>
          candidate.active &&
          candidate.portName === 'analysis-plan' &&
          candidate.nodeRunId === planRun?.id,
      )
      if (expectedPath === null || planOutput?.content.trim() !== expectedPath) {
        return resultFailure(
          'semantic',
          'implementation-plan-path-mismatch',
          `analysis-plan must publish the exact platform path ${expectedPath ?? '<missing>'}`,
          metering,
          task.worktreePath,
        )
      }
    }
    const roundRef = executionMetadata?.roundRef ?? null
    if (ports.workspace !== undefined && roundRef !== null) {
      const validation = await ports.workspace.validate({
        roundRef,
        taskStatus: task.status,
        outputJson: output,
      })
      if (!validation.ok) {
        return resultFailure(
          validation.errorClass,
          validation.errorCode,
          validation.errorDetail,
          metering,
          task.worktreePath,
        )
      }
    }
    if (output === null) {
      return resultFailure(
        'semantic',
        'execution-output-missing',
        `task did not publish ${DIGITAL_EMPLOYEE_RESULT_PORT}`,
        metering,
        task.worktreePath,
      )
    }
    return { kind: 'completed', outputJson: output, metering }
  }

  // 「用户取消」的判据取自单一事实源（`domain/sourceTermination.ts`），不硬编码字符串。
  // 注意资源上限超时与空闲收割也会把任务置成 `canceled`，只是改写了 errorSummary——
  // 它们仍按失败走重试（改成 stopped 会让超时不再重试，那是 AC-12 禁止放宽的重试预算）。
  const userCancelSummary = taskStopProjection({ kind: 'user' }).summary

  const core: DigitalEmployeeExecutionCore = {
    async launch(input) {
      return await launchCore(input.plan, input.attempt, input.taskId)
    },

    async executionExists(executionRef: string) {
      return (await ports.tasks.get(executionRef)) !== null
    },

    async inspect(executionRef: string): Promise<DigitalEmployeeExecutionCoreSnapshot> {
      const task = await ports.tasks.get(executionRef)
      if (task !== null && task.status === 'canceled' && task.errorSummary === userCancelSummary) {
        const usage = (await ports.resourceUsage.read(executionRef)) ?? {
          effectiveRunningMs: 0,
          totalTokens: 0,
        }
        return {
          kind: 'stopped',
          metering: {
            sourceRef: `task:${executionRef}`,
            durationMs: usage.effectiveRunningMs,
            totalTokens: usage.totalTokens,
          },
        }
      }
      return await inspectTask(executionRef)
    },

    async inspectHumanReview(executionRef: string) {
      return await ports.humanReview.inspect(executionRef)
    },

    async cancel(executionRef: string) {
      const task = await ports.tasks.get(executionRef)
      if (task === null || isTerminalTaskStatus(task.status)) return
      await ports.tasks.cancel(executionRef)
    },
  }

  return Object.freeze(core)
}
