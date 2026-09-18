// RFC-243 PR-1 — 启动调用面 / 引擎分派 / 终态守望的源码锁。
//
// **RFC-359 AC-1（plan §5hn 批次二 ⑦）：`services/execution/executor.ts` 整份删除。**
// 那个「统一执行门面」的核心 `startExecution` 是**启动编排的第二份写法**——同一个
// workflow / agent / workgroup 三分支 switch，只是终端转 `startTask` / `startAgentTask` /
// `startWorkgroupTask`。两个引擎的启动路合一之后，唯一的编排是启动参与者
//（`createTaskExecutionLaunchParticipant`）→ 根启动内核，门面的生产消费者归零。
//
// 本文件因此只剩三类锁（原第 1、2、4 类），第 3 类按下面各自的注释重新落位：
//   1. Source-text: the launch call faces (routes/tasks.ts incl. the
//      multipart handoff, routes/agents.ts, routes/workgroups.ts,
//      webhookDispatchRuntime.ts) go through a required closed launch port and
//      never call startTask / startAgentTask / startWorkgroupTask directly.
//   2. resolveTaskEngine — the engine fork extracted from scheduler.ts is
//      byte-equal to the pre-RFC-243 inline decision (RFC-164/167/217
//      semantics).
//   4. executionWatch: immediate resolve for already-terminal rows; multicast
//      resolve from the lifecycle write path for ALL FOUR terminal statuses
//      (failed/interrupted included — the single-slot RFC-202 hook only fires
//      for done|canceled); missing-row resolve; poll fallback catches a row
//      deleted after registration; abort resolves 'aborted'.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { setTaskStatus, trySetTaskStatus } from '../src/services/lifecycle'
import { resolveTaskEngineSelection as resolveTaskEngine } from '../src/modules/task-execution/engine/task/taskEngineRegistry'
import { createTaskExecutionLaunchParticipant } from '../src/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import {
  notifyTaskTerminal,
  resetTaskTerminalWatchersForTests,
  watchTaskTerminal,
} from '../src/services/execution/executionWatch'
import type { Actor } from '../src/auth/actor'
import type { TaskStatus } from '@agent-workflow/shared'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'

const SRC = resolve(import.meta.dir, '..', 'src')

function srcText(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8')
}

describe('RFC-243 T2 — launch call faces route through the executor (source lock)', () => {
  const CALL_FACES = [
    'routes/tasks.ts',
    'routes/agents.ts',
    'routes/workgroups.ts',
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①②）：`services/scheduleLaunch.ts` 已删除
    // ——定时启动改走与路由同一份编排（启动参与者 → 根内核），本条锁的「不得直调
    // start* 服务」由那条路自己的形状保证：参与者里压根没有那三个函数的 import。
    // RFC-257 (design gate F-7): the webhook fan-out is a launch call face —
    // this list is hand-maintained, new faces MUST be registered here.
    'modules/integration/infrastructure/webhookDispatchRuntime.ts',
  ]
  for (const rel of CALL_FACES) {
    test(`${rel} has no direct start* launch call`, () => {
      const text = srcText(rel)
      // direct launch-service invocations (`await startTask(`, `startAgentTask(`,
      // `startWorkgroupTask(`) are banned; the executor facade is the only path.
      expect(/\bstartTask\(/.test(text)).toBe(false)
      expect(/\bstartAgentTask\(/.test(text)).toBe(false)
      expect(/\bstartWorkgroupTask\(/.test(text)).toBe(false)
      if (rel === 'routes/agents.ts' || rel === 'routes/workgroups.ts') {
        // RFC-345/T8 provider cutover: classic Resource Catalog routes receive
        // the same executor through a required closed binding instead of a DB.
        expect(text).toContain('taskLaunch.launch')
        expect(text).not.toContain('AppDeps')
        expect(text).not.toContain('deps.db')
      } else if (rel === 'routes/tasks.ts') {
        expect(text).toContain('operations.launchMultipart')
        expect(text).toContain('operations.launchWorkflow')
        expect(text).not.toContain('startExecution')
      } else {
        expect(rel.includes('webhookDispatchRuntime')).toBe(true)
        expect(text).toContain('createWebhookExecutionRuntime')
        expect(text).toContain('taskExecutions: input.taskExecutions')
      }
      // RFC-359 AC-1（plan §5hn 批次二 ⑦）：门面删除之后**没有任何调用面**允许提到它。
      // 此前这里还有一条 `else` 分支要求「其余调用面必须转 `startExecution`」——
      // 那条分支的最后一个成员（`services/scheduleLaunch.ts`）在批次二 ①② 就删了。
      expect(text).not.toContain('startExecution')
    })
  }

  // RFC-359 AC-1（plan §5hn 批次二 ⑦）**改锚**：此前这条锁的是「`executor.ts` 是唯一允许
  // 同时调三个启动服务的模块」。那个文件已整份删除——它的存在本身就是第二份编排。
  // 这条锁的意图（**启动编排只有一处**）改由下面这条承担：三个 legacy 启动服务
  // 在生产里已经没有任何「同时调用它们」的模块，启动参与者一个都不 import。
  test('启动参与者不 import 任何 legacy 启动服务——编排只有一处', () => {
    const text = srcText('modules/task-execution/infrastructure/taskRouteLaunchOperations.ts')
    for (const legacy of ['startTask', 'startAgentTask', 'startWorkgroupTask']) {
      expect(new RegExp(`\\b${legacy}\\(`).test(text), `${legacy} 不该出现在启动参与者里`).toBe(
        false,
      )
    }
  })

  test('call 分支纪律：不持任何节点池名额；adoption 区零 mint（实现门 P2-4 源锁）', () => {
    const text = srcText('modules/task-execution/composition/nodeMechanics.ts')
    const fnStart = text.indexOf('async function runCallWorkflowNode')
    const fnEnd = text.indexOf('async function failCallRow')
    expect(fnStart).toBeGreaterThan(0)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = text.slice(fnStart, fnEnd)
    // RFC-266 显式改判：`globalSem` 已拆成 `agentSem` / `scriptSem` 两个独立池，
    // 只留原来那条 `not.toContain('globalSem.acquire')` 会**静默失效**（断言一个
    // 不复存在的标识符，永远真）。不变量本身没变——call 节点一个名额都不占，
    // 由子任务自己的节点去抢——所以这里改成对两个池都断言。
    for (const pool of ['agentSem', 'scriptSem']) {
      expect(body).not.toContain(`${pool}.acquire`)
    }
    const aStart = body.indexOf('RFC-243-LOCK:adoption-no-mint-begin')
    const aEnd = body.indexOf('RFC-243-LOCK:adoption-no-mint-end')
    expect(aStart).toBeGreaterThan(0)
    expect(aEnd).toBeGreaterThan(aStart)
    expect(body.slice(aStart, aEnd)).not.toContain('mintNodeRun(')
  })

  test('task orchestrator consumes the engine registry (no inline dispatch left)', () => {
    const text = srcText('modules/task-execution/composition/taskEngineApplication.ts')
    expect(text).toContain('resolveTaskEngine')
    expect(/\bderiveWorkgroupDispatch\(/.test(text)).toBe(false)
  })
})

describe('RFC-243 T3 — resolveTaskEngine (extracted fork, byte-equal semantics)', () => {
  const lwConfig = JSON.stringify({ mode: 'leader_worker' })
  const dwConfig = JSON.stringify({ mode: 'dynamic_workflow' })

  test('non-workgroup task → dag, no wg dispatch', () => {
    expect(resolveTaskEngine({ workgroupId: null }, null)).toEqual({
      engine: 'dag',
      wgDispatch: null,
    })
  })

  test('leader_worker → workgroup-turns (dw phase irrelevant)', () => {
    expect(resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: lwConfig }, null)).toEqual(
      { engine: 'workgroup-turns', wgDispatch: 'turn-engine' },
    )
  })

  test('unparsable config falls back to leader_worker → turn engine (RFC-217 T2)', () => {
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: 'not json' }, null),
    ).toEqual({ engine: 'workgroup-turns', wgDispatch: 'turn-engine' })
  })

  test('dynamic_workflow without executing phase → dw-generate', () => {
    expect(resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, null)).toEqual(
      { engine: 'dw-generate', wgDispatch: 'dw-generate' },
    )
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, 'awaiting_confirm'),
    ).toEqual({ engine: 'dw-generate', wgDispatch: 'dw-generate' })
  })

  test('dynamic_workflow executing → dag with dw-execute marker', () => {
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, 'executing'),
    ).toEqual({ engine: 'dag', wgDispatch: 'dw-execute' })
  })
})

describe('RFC-359 AC-1 —— 启动参与者继承了门面的 ref/payload 一致性守卫', () => {
  // RFC-359 AC-1（plan §5hn 批次二 ⑦）**改锚**：原本这一段测的是 `startExecution` 的两条守卫。
  // 门面整份删除之后：
  //
  //   · **ref/payload 不一致** —— 守卫**原样活着**，落在启动参与者三个臂各自的第一行
  //     （`execution-ref-mismatch`）。这里改测它；桩依赖照旧——守卫在任何库 / 鉴权访问之前抛。
  //   · **`node` invoker 必须 fail-closed** —— 这条**由类型承担**，不再需要运行期守卫：
  //     参与者的 `target` 联合类型里压根没有 node 形状，子任务走的是另一条有自己准入门的入口
  //     （`ChildExecutionLaunchOperations`，5 道亲子准入由 `rfc359-w8-child-launch-conformance`
  //     双引擎锁着）。删除，而不是留一条测不到东西的断言。
  const stubDeps = {} as unknown as Parameters<typeof createTaskExecutionLaunchParticipant>[0]
  const stubActor = { user: { id: 'u1' } } as unknown as Actor

  test('workflow ref/payload mismatch → execution-ref-mismatch', async () => {
    await expect(
      createTaskExecutionLaunchParticipant(stubDeps).launch({
        actor: stubActor,
        target: {
          kind: 'workflow',
          refId: 'wf-a',
          payload: { workflowId: 'wf-b', name: 't', inputs: {} },
        },
        invoker: { type: 'user', launchKind: 'direct-json' },
        resources: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'execution-ref-mismatch' })
  })
})

// ---------------------------------------------------------------------------
// executionWatch
// ---------------------------------------------------------------------------

async function seedTask(db: ProviderNeutralDatabase, status: TaskStatus): Promise<string> {
  const definition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId.slice(-6).toLowerCase()}`,
    definition: JSON.stringify(definition),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc243-watch',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc243-nowhere',
    worktreePath: '/tmp/rfc243-nowhere',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describeEachProvider('RFC-243 T5 — executionWatch', (harness) => {
  let uninstallAfterCommitPump: (() => void) | undefined

  afterEach(() => {
    uninstallAfterCommitPump?.()
    uninstallAfterCommitPump = undefined
    resetTaskTerminalWatchersForTests()
  })

  const installExecutionWatchPump = (db: ProviderNeutralDatabase): void => {
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onExecutionWatch(_db, taskId, status) {
        notifyTaskTerminal(taskId, status)
      },
    })
  }

  test('already-terminal task resolves on the immediate read', async () => {
    const db = harness.db
    const taskId = await seedTask(db, 'done')
    expect(await watchTaskTerminal(db, taskId)).toEqual({ kind: 'terminal', status: 'done' })
  })

  test('missing row resolves `missing` (never hangs)', async () => {
    const db = harness.db
    expect(await watchTaskTerminal(db, ulid())).toEqual({ kind: 'missing' })
  })

  test('lifecycle write resolves watchers for failed (a status the RFC-202 hook ignores)', async () => {
    resetTaskTerminalWatchersForTests()
    const db = harness.db
    installExecutionWatchPump(db)
    const taskId = await seedTask(db, 'running')
    const watching = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    await Bun.sleep(10)
    await setTaskStatus({
      db,
      taskId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: 'rfc243-test',
    })
    expect(await watching).toEqual({ kind: 'terminal', status: 'failed' })
  })

  test('multicast: two watchers both resolve; interrupted counts as terminal', async () => {
    resetTaskTerminalWatchersForTests()
    const db = harness.db
    installExecutionWatchPump(db)
    const taskId = await seedTask(db, 'running')
    const a = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    const b = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    await Bun.sleep(10)
    const won = await trySetTaskStatus({
      db,
      taskId,
      to: 'interrupted',
      allowedFrom: ['running'],
      reason: 'rfc243-test',
    })
    expect(won).toBe(true)
    expect(await a).toEqual({ kind: 'terminal', status: 'interrupted' })
    expect(await b).toEqual({ kind: 'terminal', status: 'interrupted' })
  })

  test('poll fallback: a row deleted after registration resolves `missing`', async () => {
    resetTaskTerminalWatchersForTests()
    const db = harness.db
    const taskId = await seedTask(db, 'running')
    const watching = watchTaskTerminal(db, taskId, { pollMs: 25 })
    await Bun.sleep(10)
    await db.delete(tasks).where(eq(tasks.id, taskId))
    expect(await watching).toEqual({ kind: 'missing' })
  })

  test('abort signal resolves `aborted` and deregisters', async () => {
    resetTaskTerminalWatchersForTests()
    const db = harness.db
    const taskId = await seedTask(db, 'running')
    const ctrl = new AbortController()
    const watching = watchTaskTerminal(db, taskId, { signal: ctrl.signal, pollMs: 60_000 })
    await Bun.sleep(10)
    ctrl.abort()
    expect(await watching).toEqual({ kind: 'aborted' })
  })
})
