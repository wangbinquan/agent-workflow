// RFC-310 PR-4 T41/T43 —— AgentActionExecution 的 task-execution 侧装配。
//
// 「一次 AgentAttempt = 一个 digital-employee host task」：launch 走
// codeRoundLaunch 同款漏斗（builtin anchor 懒种 + synthesized snapshot +
// StartTaskSchema），执行/取消/中断修复/资源限额全部复用既有 task 机制——
// 唯一四级执行链不开旁路。development-automation 以结构同形依赖接收本
// runner（两模块互不 import 对方内部，rfc294 preflight 债务零增长；配对由
// rfc310-pr4 测试锁定）。
//
// 执行是长过程、reconciler 是单轮 arm：launch 只落任务并返回 durable
// executionRef（= taskId，天然可跨重启查询）；结果由 fetchOutcome 拉取
// （RFC-243 统一 outcome 投影），attempt 终态经 onTerminal 回调通知注入方
// （DA 侧自己записыв wake hint——本模块不写 development_* 表）。
//
// T43 separate-writer/disposable 语义：action workspace 由 development-
// automation 物化后**原样**作为任务 canonical 工作区传入——internalSource
// （RFC-165 F4 内部面，space_kind='internal'、GC 排除）+
// preCreatedWorktree（cleanup 'borrowed'：任务终态不删目录，废弃/重建归 DA
// 的 whole-workspace 回退）。Agent 节点仍走 RFC-130 隔离；launch-frozen
// platformInputPaths 让 Git-ignored requirement/pipeline mounts 进入每次快照。
//
// T44 零 Git identity/零凭据：StartTask 不携带 gitUserName/gitUserEmail
// （spawn 装配的「either empty ⇒ skip」分支即不注入，RFC-067 普通任务路径
// 不动）、autoCommitPush 恒 false、无 connection secret 经手本文件。

import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  isTerminalTaskStatus,
  serializeWorkflowDefinitionStorageV1,
  WORKFLOW_SCHEMA_VERSION,
  type StartTask,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_NAME,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeHostSnapshot,
} from '../domain/digitalEmployeeHost'
import { getAgentById } from '@/services/agent'
import { getExecutionOutcome, watchExecutionTerminal } from '@/services/execution/executor'
import { initialBuiltinResourceAcl } from '@/services/resourceAcl'
import { cancelTask, startTask, type StartTaskDeps } from '@/services/task'
import { normalizeTaskPlatformInputPaths } from '@/services/taskPlatformInputPaths'

/** DA 侧 OperationFailureReceipt 的结构同形（不跨 context import）。 */
export interface AgentExecutionFailure {
  readonly category: 'configuration' | 'transient' | 'contract-violation'
  readonly code: string
  readonly retryability: 'same-input' | 'after-configuration' | 'never'
  readonly attemptOrdinal: number
  readonly remediation: string
  readonly evidenceRef: null
}

export interface DigitalEmployeeLaunchInput {
  /** DA 侧 ActionRun id——只作任务命名/追踪，不进 prompt。 */
  readonly actionRunId: string
  readonly capabilityId: string
  /** 模板 executor 解析出的 agent 资源。 */
  readonly agentId: string
  /** 组装完毕的完整 prompt（平台说明+facts+supplement+protocol block）。 */
  readonly prompt: string
  /** DA 物化的 action workspace（含未提交 seed/evidence overlay）。 */
  readonly workspacePath: string
  /** exact baseline sha（40-hex；对拍/展示用，不再 checkout）。 */
  readonly baselineSha: string
  /** DA 已物化的只读 requirement/pipeline mount roots。 */
  readonly platformInputPaths: readonly string[]
  /** 墙钟预算；null = 不限（沿用任务默认限额）。 */
  readonly wallTimeMs: number | null
}

export type DigitalEmployeeExecutionSnapshot =
  | { readonly kind: 'not-found'; readonly executionRef: string }
  | { readonly kind: 'pending'; readonly executionRef: string; readonly taskStatus: string }
  | {
      readonly kind: 'exited'
      readonly executionRef: string
      readonly taskStatus: 'done' | 'failed' | 'canceled' | 'interrupted'
      /** done 时 agent-result 端口的原始文本；缺席（protocol-missing 候选）= null。 */
      readonly resultText: string | null
      readonly errorSummary: string | null
      readonly errorMessage: string | null
    }

export interface AgentActionExecutionRunner {
  launch(
    input: DigitalEmployeeLaunchInput,
  ): Promise<
    | { readonly ok: true; readonly executionRef: string }
    | { readonly ok: false; readonly failure: AgentExecutionFailure }
  >
  fetchOutcome(executionRef: string): Promise<DigitalEmployeeExecutionSnapshot>
  cancel(
    executionRef: string,
  ): Promise<{ readonly settled: 'canceled' | 'already-terminal' | 'not-found' }>
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

/** anchor 懒种（幂等；镜像 ensureAgentHostWorkflow / ensureCodeRoundHostWorkflow）。 */
export async function ensureDigitalEmployeeHostWorkflow(db: DbClient): Promise<void> {
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

export function composeAgentActionExecution(deps: {
  readonly db: DbClient
  /** 生产 = cli 的 buildStartTaskDeps 产物；测试注入 binaryOverride/awaitScheduler。 */
  readonly startDeps: StartTaskDeps
  /** attempt 终态通知（DA 侧据此记 wake hint）；daemon 内 watcher 轮询驱动。 */
  readonly onTerminal?: (executionRef: string) => void
  /** watcher 轮询间隔（测试提速用）。 */
  readonly terminalPollMs?: number
}): AgentActionExecutionRunner {
  const { db } = deps

  return {
    async launch(input) {
      if (!/^[0-9a-f]{40}$/.test(input.baselineSha)) {
        return fail(
          'contract-violation',
          'de-baseline-invalid',
          'never',
          'baselineSha must be a 40-hex commit sha',
        )
      }
      if (!existsSync(join(input.workspacePath, '.git'))) {
        return fail(
          'configuration',
          'de-workspace-unavailable',
          'after-configuration',
          'action workspace is missing or not a git checkout; rematerialize it',
        )
      }
      const platformInputPaths = normalizeTaskPlatformInputPaths(input.platformInputPaths)
      if (platformInputPaths === null) {
        return fail(
          'contract-violation',
          'de-input-mount-invalid',
          'never',
          'platform input mounts must be bounded roots below .agent-workflow/inputs or .agent-workflow/pipeline',
        )
      }
      const missingInputPath = platformInputPaths.find(
        (path) => !existsSync(join(input.workspacePath, path)),
      )
      if (missingInputPath !== undefined) {
        return fail(
          'configuration',
          'de-input-mount-missing',
          'after-configuration',
          `platform input mount '${missingInputPath}' is missing; rematerialize the action workspace`,
        )
      }
      const agent = await getAgentById(db, input.agentId)
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

      await ensureDigitalEmployeeHostWorkflow(db)
      const taskId = ulid()
      // 内部面不走 StartTaskSchema.parse：它的「必须带 repo 源」交叉校验只属
      // wire 面；仓库源经 deps.internalSource 注入（startTaskWithLocalRepo 同款
      // 先例——parse 会因 start-task-source-required 拒掉合法的内部启动）。
      const startInput: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: `de:${input.capabilityId}:${input.actionRunId}`.slice(0, 255),
        inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: input.prompt },
        ...(input.wallTimeMs !== null ? { maxDurationMs: input.wallTimeMs } : {}),
      }

      let task: { id: string }
      try {
        task = await startTask(startInput, {
          ...deps.startDeps,
          catalogVisibility: 'internal',
          digitalEmployeeLaunch: {
            actionRunId: input.actionRunId,
            snapshotJson: JSON.stringify(
              synthesizeDigitalEmployeeHostSnapshot({ agentId: agent.id, agentName: agent.name }),
            ),
          },
          internalSource: {
            kind: 'local-path',
            repoPath: input.workspacePath,
            baseBranch: input.baselineSha,
          },
          platformInputPaths,
          preCreatedWorktree: {
            taskId,
            worktreePath: input.workspacePath,
            branch: '',
            baseCommit: input.baselineSha,
            // borrowed：任务终态不回收目录——废弃/byte-identical 重建是 DA 的
            // whole-workspace 回退合同，不是任务清理的一部分。
            cleanup: { kind: 'borrowed' },
          },
          ...(deps.startDeps.launchProvenance === undefined &&
          deps.startDeps.callLaunch === undefined
            ? { launchProvenance: { kind: 'direct-json' as const, initiator: 'api' as const } }
            : {}),
        })
      } catch (err) {
        return fail(
          'transient',
          'de-launch-failed',
          'same-input',
          err instanceof Error ? err.message.slice(0, 300) : 'startTask failed',
        )
      }

      const executionRef = task.id
      if (deps.onTerminal !== undefined) {
        const notify = deps.onTerminal
        void watchExecutionTerminal(db, executionRef, {
          pollMs: deps.terminalPollMs ?? 1_000,
        })
          .then(() => notify(executionRef))
          .catch(() => {})
      }
      return { ok: true, executionRef }
    },

    async fetchOutcome(executionRef) {
      const row = db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (row === undefined) return { kind: 'not-found', executionRef }
      if (!isTerminalTaskStatus(row.status)) {
        return { kind: 'pending', executionRef, taskStatus: row.status }
      }
      const outcome = await getExecutionOutcome(db, executionRef)
      return {
        kind: 'exited',
        executionRef,
        taskStatus: row.status as 'done' | 'failed' | 'canceled' | 'interrupted',
        resultText: outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null,
        errorSummary: outcome.error?.summary ?? null,
        errorMessage: outcome.error?.message ?? null,
      }
    },

    async cancel(executionRef) {
      const row = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (row === undefined) return { settled: 'not-found' }
      if (isTerminalTaskStatus(row.status)) return { settled: 'already-terminal' }
      try {
        await cancelTask(db, executionRef)
        return { settled: 'canceled' }
      } catch {
        // cancelTask 对已终态拒绝——与并发结算竞争的输家按 already-terminal 收。
        return { settled: 'already-terminal' }
      }
    },
  }
}
