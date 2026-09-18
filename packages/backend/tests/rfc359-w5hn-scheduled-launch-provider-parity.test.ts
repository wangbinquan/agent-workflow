// RFC-359 AC-1 / AC-6（plan §5hn 批次二 ①②）—— **定时启动**在两个引擎上落出同一行。
//
// 为什么这条测试存在：批次一 / 批次二 ③ 只统一了**路由**那两条启动路。剩下的入口
//（定时 / webhook / 子任务 / multipart）在 SQLite 上仍走 `services/execution/executor.ts#startExecution`
// ——那是一份和 `taskRouteLaunchOperations#createTaskExecutionLaunchParticipant`
// **逐格对得上的三分支 switch**（workflow / agent / workgroup），只是终端不同：
// SQLite 转 `startTask` / `startAgentTask` / `startWorkgroupTask`，PG 转
// `launchRoot` / `arms.launchAgent` / `arms.launchWorkgroup`。
//
// 合并那个 switch 之前先把等价性钉住——这是前两刀验证过的次序：先有基线，换终端时
// 才知道「行为没动」不是自我说服。走的入口是 `POST /api/scheduled-tasks/:id/run-now`：
// 它经 `fireSchedule` → `createBuildScheduleLaunch` → **触发器参与者** → 启动参与者，
// 一条路同时覆盖批次二的 ①（启动参与者）和 ②（触发器参与者，SQLite 侧目前自己调
// `startExecution`，PG 侧只是八行转发）。
//
// 判据形状照抄前两条：**拒绝清单**（把逐次必然不同的那几格摘掉、其余整行都比）
// + 各自的正确性断言（相等只证明「一致」，不证明「对」）。
import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { tasks } from '@/db/schema'
import { comparableTaskRow } from './helpers/taskRowParity'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { WORKGROUP_HOST_WORKFLOW_ID } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/launch'

const TOKEN = 'e'.repeat(64)
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const
const EMPTY_DEF = { $schema_version: 1, inputs: [], nodes: [], edges: [] } as const

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

/**
 * 逐次必然不同的那几格。顶层 `repos[]` 里还嵌着同样逐次不同的
 * baseCommit / repoPath / worktreePath，顶层清单罩不到——整格摘掉，另比形状。
 */
const VOLATILE = new Set([
  'id',
  'startedAt',
  'finishedAt',
  'expiresAt',
  'deletedAt',
  'branch',
  'repoPath',
  'worktreePath',
  'baseCommit',
  'workflowId',
  'workflowName',
  'workgroupId',
  'workgroupName',
  'sourceAgentId',
  'sourceAgentName',
  'scheduledTaskId',
  'repos',
  // **时间相关，间歇性不等**（本轮实撞：18 文件同跑时 PG 那两条偶发红）。
  // `decorateTaskName` 给定时任务名追加 ` · YYYY-MM-DD HH:MM`（`scheduledTasks.ts:843`，
  // **分钟粒度**）。两个 lane 相隔几秒跑，只要跨过一次分钟边界这一格就不等。
  // 摘掉它、改由 `assertScheduledName` 逐 lane 断言装饰确实加上了——
  // 相等面不该由墙钟决定，但「有没有装饰」仍然必须守住。
  'name',
  // **时间相关，不是引擎差异**：调度器是异步接手的，读回来时任务可能已经从
  // `pending` 翻到 `running`。拿它做相等断言等于把一条 flaky 写进守卫
  //（本仓硬规则：「绝不允许重跑就过了」）。改为各自 lane 断言它落在启动早期的
  // 两个合法状态之一——见下面的 `assertEarlyLifecycle`。
  'status',
])

/** 定时任务名必须带上 `decorateTaskName` 的分钟级装饰——相等面摘掉它之后由这条守。 */
function assertScheduledName(task: Record<string, unknown>, base: string): void {
  expect(String(task['name']), '定时启动的任务名必须保留基名并追加 ` · YYYY-MM-DD HH:MM`').toMatch(
    new RegExp(`^${base} \u00b7 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`),
  )
}

/** `status` 从相等面摘掉之后仍要证明它没跑飞：启动刚完成只能是这两个状态。 */
function assertEarlyLifecycle(task: Record<string, unknown>): void {
  expect(String(task['status']), '启动刚返回，任务状态却跑到了启动早期之外').toMatch(
    /^(pending|running)$/,
  )
}

function comparableTask(task: Record<string, unknown>): Record<string, unknown> {
  const snapshot = task['workflowSnapshot'] as
    | { nodes?: ReadonlyArray<Record<string, unknown>>; edges?: ReadonlyArray<unknown> }
    | undefined
  const comparable: Record<string, unknown> = {}
  for (const key of Object.keys(task).sort()) {
    if (VOLATILE.has(key)) continue
    comparable[key] =
      key === 'workflowSnapshot'
        ? {
            // 快照按形状比：坐标与 agent 名逐次不同。
            nodeIds: (snapshot?.nodes ?? []).map((node) => node['id']).sort(),
            nodeKinds: (snapshot?.nodes ?? []).map((node) => node['kind']).sort(),
            edgeCount: (snapshot?.edges ?? []).length,
            everyNodePositioned: (snapshot?.nodes ?? []).every(
              (node) => node['position'] !== undefined,
            ),
          }
        : task[key]
  }
  comparable['repoShape'] = (task['repos'] as ReadonlyArray<Record<string, unknown>>).map(
    (repo) => ({ mountPath: repo['mountPath'], scratch: repo['scratch'] }),
  )
  return comparable
}

/**
 * 每个 kind 各记一份「定时启动后 task 行的可比投影」，两条 lane 都到齐时当场比对。
 *
 * 不用两个 describe 分别记录 / 比较——CI 跑 `--randomize`，用例顺序不可依赖
 *（本仓实撞过：`rfc359-w5-composition-root-route-surface` 第一版就是那么写的，
 * 比较那条先跑、看到空账本直接绿）。比较折进 lane 用例本身，谁最后到齐谁做比较。
 */
const launched = new Map<string, Record<string, unknown>>()
/**
 * RFC-359 AC-1（plan §5hn 批次二 ④）——**落库那一行**也要比。
 * 响应体是 `taskProjection(...)` 现算的投影，不是回读：变异实证显示，只比响应体时
 * 把内核 INSERT 的 `name` 改掉**照样绿**。标题写着「落库对等」就得真去读库。
 */
const persistedRows = new Map<string, Record<string, unknown>>()

async function createAgent(app: Hono, name: string): Promise<{ id: string }> {
  const res = await req(app, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'scheduled parity',
    }),
  })
  expect(res.status, await res.clone().text()).toBe(201)
  return (await res.json()) as { id: string }
}

/** 建定时行 → run-now → 取回它启动出来的 task 行（连同定时行 id，供归属断言用）。 */
async function scheduleAndRunNow(
  app: Hono,
  launchKind: 'workflow' | 'agent' | 'workgroup',
  launchPayload: Record<string, unknown>,
): Promise<{ scheduleId: string; task: Record<string, unknown> }> {
  const created = await req(app, '/api/scheduled-tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `sched-${launchKind}`,
      launchKind,
      launchPayload,
      scheduleSpec: SPEC,
      // run-now 是手动覆盖，禁用的行也能触发——顺便避免自动节拍插一脚。
      enabled: false,
    }),
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const schedule = (await created.json()) as { id: string }

  const fired = await req(app, `/api/scheduled-tasks/${schedule.id}/run-now`, { method: 'POST' })
  expect(fired.status, await fired.clone().text()).toBe(201)
  const { taskId } = (await fired.json()) as { taskId: string }

  const read = await req(app, `/api/tasks/${taskId}`)
  expect(read.status, await read.clone().text()).toBe(200)
  return { scheduleId: schedule.id, task: (await read.json()) as Record<string, unknown> }
}

describeEachProviderHttpApplication(
  'RFC-359 AC-1 —— 定时启动的两个引擎落库对等',
  {
    token: TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-scheduled-launch-parity-',
  },
  (scope) => {
    let app: Hono

    beforeEach(async () => {
      await seedTestDefaultOpencodeRuntime(scope.harness.db)
      ;({ app } = await scope.open())
    })

    test('kind=workflow：定时触发的 task 行两个引擎逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const wfRes = await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: `sched-wf-${suffix}`,
          description: '',
          definition: EMPTY_DEF,
        }),
      })
      expect(wfRes.status, await wfRes.clone().text()).toBe(201)
      const workflow = (await wfRes.json()) as { id: string }

      const { scheduleId, task } = await scheduleAndRunNow(app, 'workflow', {
        workflowId: workflow.id,
        name: 'rfc359 scheduled workflow',
        scratch: true,
      })

      // 先钉住这一侧**本身**确实是定时启动落出来的——两个引擎同样地错也会让相等断言绿掉。
      assertEarlyLifecycle(task)
      assertScheduledName(task, 'rfc359 scheduled workflow')
      expect(task['scheduledTaskId'], '定时启动必须把定时行 id 盖进任务').toBe(scheduleId)
      expect(task['workflowId'], '工作流定时必须挂在被选中的工作流上').toBe(workflow.id)

      const comparable = comparableTask(task)
      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persistedRows.set(
        `workflow:${scope.harness.capabilities.provider}`,
        comparableTaskRow(row, [
          'scheduledTaskId',
          'sourceAgentId',
          'sourceAgentName',
          'workgroupId',
          'workgroupName',
          'workgroupConfigJson',
          'name',
        ]),
      )

      launched.set(`workflow:${scope.harness.capabilities.provider}`, comparable)
      if (!launched.has('workflow:sqlite') || !launched.has('workflow:postgresql')) return
      expect(
        launched.get('workflow:postgresql'),
        '两个引擎的定时工作流启动落库结果不一致——合并 startExecution 之前必须先解释清楚（plan §5hn 批次二 ①）',
      ).toEqual(launched.get('workflow:sqlite'))
      expect(
        persistedRows.get('workflow:postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persistedRows.get('workflow:sqlite'))
    })

    test('kind=agent：定时触发的 task 行两个引擎逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const agent = await createAgent(app, `sched-agent-${suffix}`)

      const { scheduleId, task } = await scheduleAndRunNow(app, 'agent', {
        agentId: agent.id,
        name: 'rfc359 scheduled agent',
        description: 'fix the flaky test',
        scratch: true,
        allowClarify: false,
      })

      assertEarlyLifecycle(task)
      assertScheduledName(task, 'rfc359 scheduled agent')
      expect(task['scheduledTaskId'], '定时启动必须把定时行 id 盖进任务').toBe(scheduleId)
      expect(task['sourceAgentId'], '单代理定时必须记下发起它的 agent').toBe(agent.id)

      const comparable = comparableTask(task)
      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persistedRows.set(
        `agent:${scope.harness.capabilities.provider}`,
        comparableTaskRow(row, [
          'scheduledTaskId',
          'sourceAgentId',
          'sourceAgentName',
          'workgroupId',
          'workgroupName',
          'workgroupConfigJson',
          'name',
        ]),
      )

      launched.set(`agent:${scope.harness.capabilities.provider}`, comparable)
      if (!launched.has('agent:sqlite') || !launched.has('agent:postgresql')) return
      expect(
        launched.get('agent:postgresql'),
        '两个引擎的定时单代理启动落库结果不一致（plan §5hn 批次二 ①）',
      ).toEqual(launched.get('agent:sqlite'))
      expect(
        persistedRows.get('agent:postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persistedRows.get('agent:sqlite'))
    })

    test('kind=workgroup：定时触发的 task 行两个引擎逐字相同', async () => {
      const suffix = ulid().slice(-8).toLowerCase()
      const agent = await createAgent(app, `sched-wg-lead-${suffix}`)
      const groupRes = await req(app, '/api/workgroups', {
        method: 'POST',
        body: JSON.stringify({
          name: `sched-wg-${suffix}`,
          description: '',
          instructions: '',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 5,
          completionGate: false,
          members: [{ memberType: 'agent', agentId: agent.id, displayName: 'lead', roleDesc: '' }],
        }),
      })
      expect(groupRes.status, await groupRes.clone().text()).toBe(201)
      const group = (await groupRes.json()) as { id: string }

      const { scheduleId, task } = await scheduleAndRunNow(app, 'workgroup', {
        workgroupId: group.id,
        name: 'rfc359 scheduled workgroup',
        goal: 'ship it',
        scratch: true,
      })

      assertEarlyLifecycle(task)
      assertScheduledName(task, 'rfc359 scheduled workgroup')
      expect(task['scheduledTaskId'], '定时启动必须把定时行 id 盖进任务').toBe(scheduleId)
      expect(task['workgroupId'], '工作组定时必须记下发起它的工作组').toBe(group.id)
      expect(task['workflowId'], '工作组启动必须挂在 __workgroup_host__ 锚上').toBe(
        WORKGROUP_HOST_WORKFLOW_ID,
      )

      const comparable = comparableTask(task)
      expect(
        (comparable['workflowSnapshot'] as { edgeCount: number }).edgeCount,
        '宿主边扫成 0 ⇒ 比较面失效',
      ).toBeGreaterThan(0)
      const row = (
        await scope.harness.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, String(task['id'])))
          .limit(1)
      )[0] as unknown as Record<string, unknown>
      expect(row, '任务行必须真的落库了').toBeDefined()
      persistedRows.set(
        `workgroup:${scope.harness.capabilities.provider}`,
        comparableTaskRow(row, [
          'scheduledTaskId',
          'sourceAgentId',
          'sourceAgentName',
          'workgroupId',
          'workgroupName',
          'workgroupConfigJson',
          'name',
        ]),
      )

      launched.set(`workgroup:${scope.harness.capabilities.provider}`, comparable)
      if (!launched.has('workgroup:sqlite') || !launched.has('workgroup:postgresql')) return
      expect(
        launched.get('workgroup:postgresql'),
        '两个引擎的定时工作组启动落库结果不一致（plan §5hn 批次二 ①）',
      ).toEqual(launched.get('workgroup:sqlite'))
      expect(
        persistedRows.get('workgroup:postgresql'),
        '两个引擎**落库那一行**不一致（响应体一致不代表行一致——响应是现算的投影）',
      ).toEqual(persistedRows.get('workgroup:sqlite'))
    })
  },
)
