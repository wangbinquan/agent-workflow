// RFC-359 W1-T3（F-H2-2）—— 数字员工 agent / script 动作执行器一份实现，两个引擎各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 F-H2-2：PostgreSQL daemon 没接 agentLauncher / scriptLauncher，
// development mission 的每个动作都被 `*-launcher-not-wired` 挡下。执行器现在只有一份
// （`composition/actionExecutionRunners.ts`：校验 → 宿主快照合成 → launchHostTask → 终态观察），
// provider 只提供「在借用工作区上启动 / 取消宿主任务」两件私有能力（`actionExecutionEnvironment.ts`）。
// 这里用一个可观测的假环境把执行器在两个引擎上各跑一遍（宿主工作流播种、脚本定义读取走真库），
// 再用源码锁钉住 PG daemon 的接线与两个 composer 的「薄」形态。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import {
  createAgentActionExecutionRunner,
  createScriptActionExecutionRunner,
  type ActionExecutionEnvironment,
  type ActionHostTaskLaunch,
} from '@/modules/task-execution/composition/actionExecutionRunners'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

const BASELINE = 'a'.repeat(40)

interface FakeEnvironment {
  readonly env: ActionExecutionEnvironment
  readonly launches: ActionHostTaskLaunch[]
  readonly cancels: string[]
}

function fakeEnvironment(
  db: ProviderNeutralDatabase,
  over: {
    readonly agent?: { id: string; name: string; outputs: readonly string[] } | null
    readonly launch?: (input: ActionHostTaskLaunch) => Promise<string>
    readonly cancelThrows?: boolean
    readonly onTerminal?: (executionRef: string) => void
  } = {},
): FakeEnvironment {
  const launches: ActionHostTaskLaunch[] = []
  const cancels: string[] = []
  const env: ActionExecutionEnvironment = {
    db,
    agents: { get: async () => over.agent ?? null },
    outcomes: {
      // 终态任务的结果读模型：只给最小的空产出，让 fetchOutcome 走到 exited 分支。
      find: async (taskId) => {
        const row = (
          await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
        )[0]
        if (row === undefined) return null
        return {
          task: {
            id: taskId,
            status: row.status,
            errorSummary: null,
            errorMessage: null,
            failedNodeId: null,
            workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
            workgroupId: null,
            workgroupConfigJson: null,
            sourceAgentName: null,
            codeRoundId: null,
          },
          runs: [],
          outputs: [],
          workgroup: null,
        }
      },
    },
    statusProjection: {
      find: async (taskId) => {
        const row = (
          await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
        )[0]
        return row === undefined ? null : { taskId, status: row.status, errorSummary: null }
      },
    },
    async launchHostTask(input) {
      launches.push(input)
      if (over.launch !== undefined) return await over.launch(input)
      return input.taskId
    },
    async cancelHostTask(executionRef) {
      cancels.push(executionRef)
      if (over.cancelThrows === true) throw new Error('already terminal')
    },
    ...(over.onTerminal === undefined ? {} : { onTerminal: over.onTerminal }),
    terminalPollMs: 5,
  }
  return { env, launches, cancels }
}

function workspaceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc359-t3-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}

const RESULT_AGENT = { id: 'agent-de', name: 'de-impl', outputs: [DIGITAL_EMPLOYEE_RESULT_PORT] }

async function seedTask(db: ProviderNeutralDatabase, status: 'running' | 'done'): Promise<string> {
  const id = `t3_${ulid()}`
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 1,
    ...(status === 'done' ? { finishedAt: 2 } : {}),
  })
  return id
}

describeEachProvider('RFC-359 T3 —— agent 动作执行器（F-H2-2）', (harness) => {
  test('agent 缺失 / 缺结果端口 / baseline 非法 / 工作区不存在：四条配置失败路径同一份判定', async () => {
    const db = harness.db
    const workspace = workspaceDir()
    try {
      const base = {
        actionRunId: 'run-1',
        capabilityId: 'cap-1',
        agentId: 'agent-de',
        prompt: 'do it',
        workspacePath: workspace,
        baselineSha: BASELINE,
        platformInputPaths: [],
        wallTimeMs: null,
      }
      const missing = createAgentActionExecutionRunner(fakeEnvironment(db, { agent: null }).env)
      expect(await missing.launch(base)).toMatchObject({
        ok: false,
        failure: { code: 'de-agent-unavailable', category: 'configuration' },
      })
      const noPort = createAgentActionExecutionRunner(
        fakeEnvironment(db, { agent: { ...RESULT_AGENT, outputs: [] } }).env,
      )
      expect(await noPort.launch(base)).toMatchObject({
        ok: false,
        failure: { code: 'de-agent-result-port-missing', retryability: 'after-configuration' },
      })
      const runner = createAgentActionExecutionRunner(
        fakeEnvironment(db, { agent: RESULT_AGENT }).env,
      )
      expect(await runner.launch({ ...base, baselineSha: 'not-a-sha' })).toMatchObject({
        ok: false,
        failure: { code: 'de-baseline-invalid' },
      })
      expect(
        await runner.launch({ ...base, workspacePath: join(workspace, 'nope') }),
      ).toMatchObject({ ok: false, failure: { code: 'de-workspace-unavailable' } })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('正向：宿主工作流在本引擎播种，宿主任务按合成快照启动，终态观察者在任务终态后被叫到', async () => {
    const db = harness.db
    const workspace = workspaceDir()
    try {
      const terminal: string[] = []
      let launchedTaskId = ''
      const fake = fakeEnvironment(db, {
        agent: RESULT_AGENT,
        onTerminal: (ref) => {
          terminal.push(ref)
        },
        launch: async (input) => {
          launchedTaskId = input.taskId
          // 模拟宿主任务立刻跑完：状态投影读到终态，观察者随之被叫到。
          await seedTaskWithId(db, input.taskId, 'done')
          return input.taskId
        },
      })
      const runner = createAgentActionExecutionRunner(fake.env)
      const result = await runner.launch({
        actionRunId: 'run-2',
        capabilityId: 'cap-2',
        agentId: RESULT_AGENT.id,
        prompt: 'implement the thing',
        workspacePath: workspace,
        baselineSha: BASELINE,
        platformInputPaths: [],
        wallTimeMs: 60_000,
      })
      expect(result).toEqual({ ok: true, executionRef: launchedTaskId })
      expect(fake.launches).toHaveLength(1)
      const launch = fake.launches[0]!
      expect(launch.name).toBe('de:cap-2:run-2')
      expect(launch.inputs).toEqual({ [DIGITAL_EMPLOYEE_PROMPT_KEY]: 'implement the thing' })
      expect(launch.wallTimeMs).toBe(60_000)
      expect(launch.workspacePath).toBe(workspace)
      expect(launch.baselineSha).toBe(BASELINE)
      expect(JSON.stringify(launch.snapshot)).toContain(RESULT_AGENT.id)
      // 宿主工作流行在本引擎上存在（两个引擎同一段 drizzle 播种）。
      const host = (
        await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(eq(workflows.id, DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID))
      )[0]
      expect(host?.id).toBe(DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID)
      // 终态观察者：状态投影轮询到终态后通知一次。
      await waitFor(() => terminal.length === 1)
      expect(terminal).toEqual([launchedTaskId])
      // fetchOutcome：终态 + 无输出 → exited 且 resultText 为 null。
      expect(await runner.fetchOutcome(launchedTaskId)).toMatchObject({
        kind: 'exited',
        taskStatus: 'done',
        resultText: null,
      })
      expect(await runner.fetchOutcome('missing-ref')).toEqual({
        kind: 'not-found',
        executionRef: 'missing-ref',
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('启动抛错 → transient de-launch-failed（同一输入可重试）', async () => {
    const db = harness.db
    const workspace = workspaceDir()
    try {
      const runner = createAgentActionExecutionRunner(
        fakeEnvironment(db, {
          agent: RESULT_AGENT,
          launch: async () => {
            throw new Error('kernel refused')
          },
        }).env,
      )
      expect(
        await runner.launch({
          actionRunId: 'run-3',
          capabilityId: 'cap-3',
          agentId: RESULT_AGENT.id,
          prompt: 'p',
          workspacePath: workspace,
          baselineSha: BASELINE,
          platformInputPaths: [],
          wallTimeMs: null,
        }),
      ).toMatchObject({
        ok: false,
        failure: {
          code: 'de-launch-failed',
          category: 'transient',
          retryability: 'same-input',
          remediation: 'kernel refused',
        },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('cancel：运行中 → 调用 provider 的取消并记 canceled；已终态 → already-terminal；不存在 → not-found', async () => {
    const db = harness.db
    const fake = fakeEnvironment(db, { agent: RESULT_AGENT })
    const runner = createAgentActionExecutionRunner(fake.env)
    const running = await seedTask(db, 'running')
    const done = await seedTask(db, 'done')
    expect(await runner.cancel(running)).toEqual({ settled: 'canceled' })
    expect(fake.cancels).toEqual([running])
    expect(await runner.cancel(done)).toEqual({ settled: 'already-terminal' })
    expect(await runner.cancel('nope')).toEqual({ settled: 'not-found' })
    // 取消与并发结算竞争的输家也按 already-terminal 收。
    const losing = fakeEnvironment(db, { agent: RESULT_AGENT, cancelThrows: true })
    const other = await seedTask(db, 'running')
    expect(await createAgentActionExecutionRunner(losing.env).cancel(other)).toEqual({
      settled: 'already-terminal',
    })
  })
})

describeEachProvider('RFC-359 T3 —— script 动作执行器（F-H2-2）', (harness) => {
  test('scriptRef 非法 / 工作流缺失 / 摘要不匹配 / Script 节点数不为一：同一份判定', async () => {
    const db = harness.db
    const workspace = workspaceDir()
    try {
      const runner = createScriptActionExecutionRunner(fakeEnvironment(db).env)
      const base = {
        actionRunId: 'run-s1',
        capabilityId: 'cap-s1',
        scriptRef: `wf_missing@${'0'.repeat(64)}`,
        prompt: 'p',
        workspacePath: workspace,
        baselineSha: BASELINE,
        platformInputPaths: [],
        wallTimeMs: null,
      }
      expect(await runner.launch({ ...base, scriptRef: 'no-at-sign' })).toMatchObject({
        ok: false,
        failure: { code: 'de-script-ref-invalid' },
      })
      expect(await runner.launch(base)).toMatchObject({
        ok: false,
        failure: { code: 'de-script-revision-unavailable' },
      })
      const twoScripts = await seedScriptWorkflow(db, 2)
      expect(await runner.launch({ ...base, scriptRef: twoScripts.ref })).toMatchObject({
        ok: false,
        failure: { code: 'de-script-node-count-invalid' },
      })
      expect(
        await runner.launch({ ...base, scriptRef: `${twoScripts.workflowId}@${'0'.repeat(64)}` }),
      ).toMatchObject({ ok: false, failure: { code: 'de-script-revision-unavailable' } })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('正向：exact 脚本引用命中 → 宿主任务按脚本快照启动', async () => {
    const db = harness.db
    const workspace = workspaceDir()
    try {
      const fake = fakeEnvironment(db)
      const runner = createScriptActionExecutionRunner(fake.env)
      const seeded = await seedScriptWorkflow(db, 1)
      const result = await runner.launch({
        actionRunId: 'run-s2',
        capabilityId: 'cap-s2',
        scriptRef: seeded.ref,
        prompt: 'run me',
        workspacePath: workspace,
        baselineSha: BASELINE,
        platformInputPaths: [],
        wallTimeMs: null,
      })
      expect(result).toMatchObject({ ok: true })
      expect(fake.launches).toHaveLength(1)
      const launch = fake.launches[0]!
      expect(launch.name).toBe('de-script:cap-s2:run-s2')
      expect(launch.inputs).toEqual({ [DIGITAL_EMPLOYEE_PROMPT_KEY]: 'run me' })
      expect(JSON.stringify(launch.snapshot)).toContain('echo hi')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

async function seedTaskWithId(
  db: ProviderNeutralDatabase,
  id: string,
  status: 'running' | 'done',
): Promise<void> {
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 1,
    ...(status === 'done' ? { finishedAt: 2 } : {}),
  })
}

async function seedScriptWorkflow(
  db: ProviderNeutralDatabase,
  scriptNodes: number,
): Promise<{ workflowId: string; ref: string }> {
  const workflowId = `wf_${ulid()}`
  const nodes = Array.from({ length: scriptNodes }, (_, index) => ({
    id: `script-${index}`,
    kind: 'script',
    name: `script ${index}`,
    language: 'bash',
    script: 'echo hi',
    position: { x: 0, y: 0 },
  }))
  const definition = JSON.stringify({
    $schema_version: 2,
    inputs: [],
    nodes,
    edges: [],
  })
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition,
    version: 1,
    schemaVersion: 2,
  })
  return { workflowId, ref: `${workflowId}@${sha256Hex(definition)}` }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('源码锁：PG daemon 接上 launcher 与终态观察者；两个 composer 是薄壳，执行器只有一份', () => {
  const root = resolve(import.meta.dir, '..', 'src')
  const daemon = readFileSync(join(root, 'cli', 'postgresqlDaemonApplication.ts'), 'utf8')
  expect(daemon).toContain('agentLauncher: composePostgresqlAgentActionExecution({')
  expect(daemon).toContain('scriptLauncher: composePostgresqlScriptActionExecution({')
  expect(daemon).toContain('createDevelopmentMissionExecutionTerminalObserver({')
  expect(daemon).toContain('developmentAutomationRef.current = developmentAutomation')
  expect(daemon.indexOf('const taskLaunchKernel = ')).toBeLessThan(
    daemon.indexOf('agentLauncher: composePostgresqlAgentActionExecution({'),
  )
  for (const file of ['agentActionExecution.ts', 'scriptActionExecution.ts']) {
    const source = readFileSync(
      join(root, 'modules', 'task-execution', 'composition', file),
      'utf8',
    )
    expect(source).toContain("from './actionExecutionRunners'")
    expect(source).toContain("from './actionExecutionEnvironment'")
    // 薄壳：不再各自持有 startTask / cancelTask / 校验 / 快照合成——那些只在 actionExecutionRunners.ts。
    expect(source).not.toContain('startTask(')
    expect(source).not.toContain('cancelTask(')
    expect(source).not.toContain('provider === ')
    expect(source).not.toContain('watchTaskTerminal(')
  }
  const environment = readFileSync(
    join(root, 'modules', 'task-execution', 'composition', 'actionExecutionEnvironment.ts'),
    'utf8',
  )
  expect(environment).not.toContain('resource-catalog/infrastructure')
})
