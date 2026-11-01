// RFC-359 W1-T3（F-H2-2）—— 数字员工 action 执行器（agent / script）的**一份**实现，两个引擎共用。
//
// 此前 `composeAgentActionExecution` / `composeScriptActionExecution` 只有 SQLite 形态（`startTask` +
// `DbClient` 直读），PostgreSQL daemon 因此**没有 launcher 可注入**：development mission 的每个
// agent / script 动作在 PG 上直接被 `agent-launcher-not-wired` / `script-launcher-not-wired` 挡下
// （`agentActionOrchestrator.ts` 的 preflight），终态观察者也零调用（dual-provider-parity-audit F-H2-2）。
//
// 这里把校验、宿主快照合成、结果投影、取消语义写一次；provider 只出现在两件事上：
// 「怎么启动一个借用工作区的宿主任务」与「怎么取消它」——由 `ActionExecutionEnvironment` 注入。
//
// RFC-415: moved from composition/actionExecutionRunners.ts into the application layer; the task status read and the
// workspace entry check arrive through the environment port.

import { createWorkflowExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { ulid } from 'ulid'

import { normalizeTaskPlatformInputPaths } from '../domain/taskPlatformInputPaths'
import { sha256Hex } from '@/util/hash'
import {
  isTerminalTaskStatus,
  ScriptNodeSchema,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
  synthesizeDigitalEmployeeScriptHostSnapshot,
} from '../domain/digitalEmployeeHost'
import type {
  ActionExecutionEnvironment,
  ActionWorkspaceEntries,
  AgentActionExecutionRunner,
  AgentExecutionFailure,
  DigitalEmployeeExecutionSnapshot,
  ScriptActionExecutionRunner,
} from './ports/actionExecution'

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

/** 共享的工作区 / 输入挂载前置校验（经所选工作区实现查存在性 + 纯函数）。 */
async function assertWorkspace(input: {
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
  readonly codes: Readonly<{ baseline: string; workspace: string; mount: string }>
  readonly checkMounts: boolean
  readonly entries: ActionWorkspaceEntries
}): Promise<
  | { ok: true; platformInputPaths: readonly string[] }
  | { ok: false; failure: AgentExecutionFailure }
> {
  if (!/^[0-9a-f]{40}$/.test(input.baselineSha)) {
    return fail(
      'contract-violation',
      input.codes.baseline,
      'never',
      'baselineSha must be a 40-hex commit sha',
    )
  }
  if (!(await input.entries.exists(input.workspacePath, '.git'))) {
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
    let missing: string | undefined
    for (const path of platformInputPaths) {
      if (await input.entries.exists(input.workspacePath, path)) continue
      missing = path
      break
    }
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

function watchTerminal(env: ActionExecutionEnvironment, executionRef: string): void {
  if (env.onTerminal === undefined) return
  const notify = env.onTerminal
  void env
    .awaitTerminal(executionRef, env.terminalPollMs ?? 1_000)
    .then(() => notify(executionRef))
    .catch(() => {})
}

async function fetchOutcome(
  env: ActionExecutionEnvironment,
  executionRef: string,
): Promise<DigitalEmployeeExecutionSnapshot> {
  const status = await env.taskStatus(executionRef)
  if (status === null) return { kind: 'not-found', executionRef }
  if (!isTerminalTaskStatus(status)) return { kind: 'pending', executionRef, taskStatus: status }
  const outcome = await env.executionOutcome(executionRef)
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
  const status = await env.taskStatus(executionRef)
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
      const workspace = await assertWorkspace({
        entries: env.workspaceEntries,
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
      const workspace = await assertWorkspace({
        entries: env.workspaceEntries,
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
        await createWorkflowExecutionQueries(env.db)
          .documents([parsedRef.workflowId], true)
          .then((rows) => rows.map((row) => ({ definition: row.definition })))
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
