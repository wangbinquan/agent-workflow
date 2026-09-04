// RFC-359 W1-T3（F-H2-2）—— 数字员工 action 执行器（agent / script）的**一份**实现，两个引擎共用。
//
// 此前 `composeAgentActionExecution` / `composeScriptActionExecution` 只有 SQLite 形态（`startTask` +
// `DbClient` 直读），PostgreSQL daemon 因此**没有 launcher 可注入**：development mission 的每个
// agent / script 动作在 PG 上直接被 `agent-launcher-not-wired` / `script-launcher-not-wired` 挡下
// （`agentActionOrchestrator.ts` 的 preflight），终态观察者也零调用（dual-provider-parity-audit F-H2-2）。
//
// 这里把校验、宿主快照合成、结果投影、取消语义写一次；provider 只出现在两件事上：
// 「怎么启动一个借用工作区的宿主任务」与「怎么取消它」——由 `ActionExecutionEnvironment` 注入。

import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  isTerminalTaskStatus,
  serializeWorkflowDefinitionStorageV1,
  ScriptNodeSchema,
  WORKFLOW_SCHEMA_VERSION,
  type TaskStatus,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import { getExecutionOutcome } from '@/services/execution/executor'
import { watchTaskTerminal } from '@/services/execution/executionWatch'
import { initialBuiltinResourceAcl } from '@/services/resourceAcl'
import { normalizeTaskPlatformInputPaths } from '@/services/taskPlatformInputPaths'
import { sha256Hex } from '@/util/hash'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
} from '../domain/digitalEmployeeHost'
import type { TaskExecutionOutcomeReadModel, TaskStatusProjectionReadModel } from '../public/types'

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
  readonly db: ProviderNeutralDatabase
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
  readonly onTerminal?: (executionRef: string) => void
  readonly terminalPollMs?: number
}

function fail(
  category: AgentExecutionFailure['category'],
  code: string,
  retryability: AgentExecutionFailure['retryability'],
  remediation: string,
): { ok: false; failure: AgentExecutionFailure } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

function parseScriptRef(value: string): { workflowId: string; digest: string } | null {
  const at = value.lastIndexOf('@')
  if (at <= 0) return null
  const digest = value.slice(at + 1)
  return /^[0-9a-f]{64}$/.test(digest) ? { workflowId: value.slice(0, at), digest } : null
}

/** 数字员工宿主工作流的幂等播种（RFC-310）。两个引擎同一条 upsert。 */
export async function ensureDigitalEmployeeHostWorkflow(
  db: ProviderNeutralDatabase,
): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
      name: DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME,
      description: 'RFC-310 digital-employee attempt anchor — do not launch directly',
      definition: serializeWorkflowDefinitionStorageV1({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      ...initialBuiltinResourceAcl(null),
      builtin: true,
    })
    .onConflictDoNothing({ target: workflows.id })
}

/** 共享的工作区 / 输入挂载前置校验（纯文件系统 + 纯函数）。 */
function assertWorkspace(input: {
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
  readonly codes: Readonly<{ baseline: string; workspace: string; mount: string }>
  readonly checkMounts: boolean
}):
  | { ok: true; platformInputPaths: readonly string[] }
  | { ok: false; failure: AgentExecutionFailure } {
  if (!/^[0-9a-f]{40}$/.test(input.baselineSha)) {
    return fail(
      'contract-violation',
      input.codes.baseline,
      'never',
      'baselineSha must be a 40-hex commit sha',
    )
  }
  if (!existsSync(join(input.workspacePath, '.git'))) {
    return fail(
      'configuration',
      input.codes.workspace,
      'after-configuration',
      'action workspace is missing or not a git checkout; rematerialize it',
    )
  }
  const platformInputPaths = normalizeTaskPlatformInputPaths(input.platformInputPaths)
  if (platformInputPaths === null) {
    return fail(
      'contract-violation',
      input.codes.mount,
      'never',
      'platform input mounts must be bounded roots below .agent-workflow/inputs or .agent-workflow/pipeline',
    )
  }
  if (input.checkMounts) {
    const missing = platformInputPaths.find((path) => !existsSync(join(input.workspacePath, path)))
    if (missing !== undefined) {
      return fail(
        'configuration',
        'de-input-mount-missing',
        'after-configuration',
        `platform input mount '${missing}' is missing; rematerialize the action workspace`,
      )
    }
  }
  return { ok: true, platformInputPaths }
}

async function readTaskStatus(
  db: ProviderNeutralDatabase,
  executionRef: string,
): Promise<TaskStatus | null> {
  const row = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, executionRef)).limit(1)
  )[0]
  return row?.status ?? null
}

function watchTerminal(env: ActionExecutionEnvironment, executionRef: string): void {
  if (env.onTerminal === undefined) return
  const notify = env.onTerminal
  void watchTaskTerminal(env.statusProjection, executionRef, {
    pollMs: env.terminalPollMs ?? 1_000,
  })
    .then(() => notify(executionRef))
    .catch(() => {})
}

async function fetchOutcome(
  env: ActionExecutionEnvironment,
  executionRef: string,
): Promise<DigitalEmployeeExecutionSnapshot> {
  const status = await readTaskStatus(env.db, executionRef)
  if (status === null) return { kind: 'not-found', executionRef }
  if (!isTerminalTaskStatus(status)) return { kind: 'pending', executionRef, taskStatus: status }
  const outcome = await getExecutionOutcome(env.outcomes, executionRef)
  return {
    kind: 'exited',
    executionRef,
    taskStatus: status as 'done' | 'failed' | 'canceled' | 'interrupted',
    resultText: outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null,
    errorSummary: outcome.error?.summary ?? null,
    errorMessage: outcome.error?.message ?? null,
  }
}

async function cancel(
  env: ActionExecutionEnvironment,
  executionRef: string,
): Promise<{ settled: 'canceled' | 'already-terminal' | 'not-found' }> {
  const status = await readTaskStatus(env.db, executionRef)
  if (status === null) return { settled: 'not-found' }
  if (isTerminalTaskStatus(status)) return { settled: 'already-terminal' }
  try {
    await env.cancelHostTask(executionRef)
    return { settled: 'canceled' }
  } catch {
    // 已终态 / 与并发结算竞争的输家按 already-terminal 收。
    return { settled: 'already-terminal' }
  }
}

/** RFC-310 数字员工 agent 动作执行器。 */
export function createAgentActionExecutionRunner(
  env: ActionExecutionEnvironment,
): AgentActionExecutionRunner {
  return {
    async launch(input) {
      const workspace = assertWorkspace({
        workspacePath: input.workspacePath,
        baselineSha: input.baselineSha,
        platformInputPaths: input.platformInputPaths,
        codes: {
          baseline: 'de-baseline-invalid',
          workspace: 'de-workspace-unavailable',
          mount: 'de-input-mount-invalid',
        },
        checkMounts: true,
      })
      if (!workspace.ok) return workspace
      const agent = await env.agents.get(input.agentId)
      if (agent === null) {
        return fail(
          'configuration',
          'de-agent-unavailable',
          'after-configuration',
          `agent resource ${input.agentId} not found; fix the action template executor`,
        )
      }
      if (!agent.outputs.includes(DIGITAL_EMPLOYEE_RESULT_PORT)) {
        return fail(
          'configuration',
          'de-agent-result-port-missing',
          'after-configuration',
          `agent '${agent.name}' must declare output port '${DIGITAL_EMPLOYEE_RESULT_PORT}'`,
        )
      }

      await ensureDigitalEmployeeHostWorkflow(env.db)
      let executionRef: string
      try {
        executionRef = await env.launchHostTask({
          taskId: ulid(),
          name: `de:${input.capabilityId}:${input.actionRunId}`.slice(0, 255),
          inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: input.prompt },
          wallTimeMs: input.wallTimeMs,
          actionRunId: input.actionRunId,
          snapshot: synthesizeDigitalEmployeeHostSnapshot({
            agentId: agent.id,
            agentName: agent.name,
          }),
          workspacePath: input.workspacePath,
          baselineSha: input.baselineSha,
          platformInputPaths: workspace.platformInputPaths,
        })
      } catch (error) {
        return fail(
          'transient',
          'de-launch-failed',
          'same-input',
          error instanceof Error ? error.message.slice(0, 300) : 'startTask failed',
        )
      }
      watchTerminal(env, executionRef)
      return { ok: true, executionRef }
    },
    fetchOutcome: (executionRef) => fetchOutcome(env, executionRef),
    cancel: (executionRef) => cancel(env, executionRef),
  }
}

/** RFC-310 PR-11 数字员工 script 动作执行器（`scriptRef` = `<workflow-id>@<sha256(stored definition)>`）。 */
export function createScriptActionExecutionRunner(
  env: ActionExecutionEnvironment,
): ScriptActionExecutionRunner {
  return {
    async launch(input) {
      const workspace = assertWorkspace({
        workspacePath: input.workspacePath,
        baselineSha: input.baselineSha,
        platformInputPaths: input.platformInputPaths,
        codes: {
          baseline: 'de-baseline-invalid',
          workspace: 'de-workspace-unavailable',
          mount: 'de-input-mount-invalid',
        },
        checkMounts: false,
      })
      if (!workspace.ok) return workspace
      const parsedRef = parseScriptRef(input.scriptRef)
      if (parsedRef === null) {
        return fail(
          'configuration',
          'de-script-ref-invalid',
          'after-configuration',
          'scriptRef must be workflow-id@definition-sha256',
        )
      }
      const row = (
        await env.db
          .select({ definition: workflows.definition })
          .from(workflows)
          .where(eq(workflows.id, parsedRef.workflowId))
          .limit(1)
      )[0]
      if (row === undefined || sha256Hex(row.definition) !== parsedRef.digest) {
        return fail(
          'configuration',
          'de-script-revision-unavailable',
          'after-configuration',
          'publish a new exact script reference; the workflow is missing or changed',
        )
      }
      let definition: WorkflowDefinition
      try {
        definition = JSON.parse(row.definition) as WorkflowDefinition
      } catch {
        return fail(
          'configuration',
          'de-script-definition-invalid',
          'after-configuration',
          'invalid workflow JSON',
        )
      }
      const scriptNodes = definition.nodes.filter((node) => node.kind === 'script')
      if (scriptNodes.length !== 1) {
        return fail(
          'configuration',
          'de-script-node-count-invalid',
          'after-configuration',
          'the referenced workflow must contain exactly one Script node',
        )
      }
      const script = ScriptNodeSchema.safeParse(scriptNodes[0])
      if (!script.success) {
        return fail(
          'configuration',
          'de-script-node-invalid',
          'after-configuration',
          script.error.issues[0]?.message ?? 'invalid Script node',
        )
      }

      await ensureDigitalEmployeeHostWorkflow(env.db)
      let executionRef: string
      try {
        executionRef = await env.launchHostTask({
          taskId: ulid(),
          name: `de-script:${input.capabilityId}:${input.actionRunId}`.slice(0, 255),
          inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: input.prompt },
          wallTimeMs: input.wallTimeMs,
          actionRunId: input.actionRunId,
          snapshot: synthesizeDigitalEmployeeScriptHostSnapshot({
            inputPort: DIGITAL_EMPLOYEE_PROMPT_KEY,
            language: script.data.language,
            script: script.data.script,
            dependencies: script.data.dependencies ?? [],
            env: script.data.env ?? {},
            readonly: script.data.readonly === true,
          }),
          workspacePath: input.workspacePath,
          baselineSha: input.baselineSha,
          platformInputPaths: workspace.platformInputPaths,
        })
      } catch (error) {
        return fail(
          'transient',
          'de-script-launch-failed',
          'same-input',
          error instanceof Error ? error.message.slice(0, 300) : 'startTask failed',
        )
      }
      watchTerminal(env, executionRef)
      return { ok: true, executionRef }
    },
    fetchOutcome: (executionRef) => fetchOutcome(env, executionRef),
    cancel: (executionRef) => cancel(env, executionRef),
  }
}
