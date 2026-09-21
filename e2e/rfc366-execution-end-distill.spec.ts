// RFC-366 —— 执行结束记忆提炼：跑完一个任务，队列里要多出两类新来源；把来源白名单
// 关掉，再跑一个就一条都不该多。
//
// 为什么这条必须是 e2e 而不是单测：RFC-366 的两个触发点分别挂在**引擎的节点结算处**
// （`nodeMechanics.ts` 每次 attempt 之后）与**持久化 committed-event 消费者**上，中间
// 隔着 bootstrap 装配、drive 漏斗、事件投递器三层。单测各自锁住了自己那一段
// （`rfc366-agent-run-observer` / `rfc366-task-terminal-consumer` /
// `rfc366-execution-end-enqueue`），但「这三段真的接在一起了吗」只有真跑一个任务才知道。
// 漏接的形态恰恰不响亮：任务照常跑完、界面照常显示 done，只是队列里静静地什么都没多。
//
// 同理，「白名单真的挡住了」也只有整条链路跑一遍才算数——准入闸在 `enqueueDistillJob`
// 里，而策略是**热读**的（D10），中间还隔着 `cli/start.ts` 注册的 provider。
// 只断言后端纯函数会让「provider 忘了注册」这种漏接全程绿着。
//
// **验收口径（重要）**：本用例断言到 `memory_distill_jobs` 的**行**为止，不断言候选
// 记忆落库。蒸馏器的输出协议在 RFC-367 之前是坏的（生产取证：最近 10 次蒸馏
// 10/10 输出被静默丢弃），那条链路归 RFC-367 修；RFC-366 只负责「把更多事件放进
// 队列」。详见 `design/RFC-366-execution-end-memory-distill/design.md §11.1`。
//
// 判据取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   modules/task-execution/composition/nodeMechanics.ts   agent 结算点只在 done/failed 通知
//   modules/task-execution/application/taskLifecycleConsumers.ts
//       `task-terminal-distill-enqueue`：done/failed 且非 continuationHandoff
//   modules/memory/application/distill/schedule.ts        enqueueDistillJob 单一准入闸
//   modules/memory/domain/distillAdmission.ts             判据与 reason 顺序
//   shared/schemas/config.ts                              memoryDistillLaunchOrigins 省略 ≡ ['manual']

import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let repoDir: string
let workflowId: string

interface DistillJobRow {
  id: string
  sourceKind: string
  sourceEventId: string
  taskId: string | null
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

async function jobsFor(taskId: string): Promise<DistillJobRow[]> {
  const all = await api<{ items: DistillJobRow[] }>('/api/memory-distill-jobs')
  return all.items.filter((job) => job.taskId === taskId)
}

/** 起一个任务并等它跑完，返回 task id。 */
async function runTask(name: string): Promise<string> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: name },
    }),
  })
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${task.id}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')
  return task.id
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc366-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc366 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon({ stubMode: 'basic' })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc366-worker',
      description: 'RFC-366 fixture',
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc366-wf',
      description: 'RFC-366 fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'worker',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc366-worker',
            promptTemplate: 'Work on {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'worker', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_worker',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'worker', portName: 'topic' },
          },
          {
            id: 'e_worker_out',
            source: { nodeId: 'worker', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  workflowId = wf.id
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('手工任务跑完：agent 结束与任务结束各自排进蒸馏队列 @nightly', async () => {
  const taskId = await runTask('rfc366-manual')

  // 两类源各自走不同的链路（引擎结算点 / 持久化事件消费者），所以分别等——
  // 一条到了不代表另一条也到了，合起来 poll 会把「只到了一条」读成「还没到」。
  await expect
    .poll(
      async () => (await jobsFor(taskId)).filter((job) => job.sourceKind === 'agent-run').length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  await expect
    .poll(
      async () => (await jobsFor(taskId)).filter((job) => job.sourceKind === 'task-run').length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)

  const jobs = await jobsFor(taskId)
  const agentRun = jobs.find((job) => job.sourceKind === 'agent-run')!
  const taskRun = jobs.find((job) => job.sourceKind === 'task-run')!

  // sourceEventId 的语义各不相同，写错了照样有行、追溯却断了：
  // agent-run 指向那一行 node_run，task-run 指向任务自己。
  expect(taskRun.sourceEventId).toBe(taskId)
  expect(agentRun.sourceEventId).not.toBe(taskId)
  const runs = await api<{ runs: Array<{ id: string; nodeId: string }> }>(
    `/api/tasks/${taskId}/node-runs`,
  )
  expect(runs.runs.map((run) => run.id)).toContain(agentRun.sourceEventId)
})

test('把 manual 移出白名单：再跑一个任务，队列一条都不多 @nightly', async () => {
  // 热读（D10）：改完配置**不重启 daemon**，下一个任务就该被挡住。
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ memoryDistillLaunchOrigins: [] }),
  })

  const taskId = await runTask('rfc366-gated')

  // 没有「变多」可等，只能等一段足以让两条链路都跑完的时间再看。两类源的入队分别
  // 发生在节点结算后与任务终态事件投递后，任务已经 done 意味着两者都早已越过。
  // 再多给一轮 worker tick（1Hz）+ 事件投递的余量。
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  expect(await jobsFor(taskId)).toEqual([])

  // 反证：白名单是唯一原因——把 manual 放回去，同一个工作流的下一个任务又有了。
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ memoryDistillLaunchOrigins: ['manual'] }),
  })
  const restored = await runTask('rfc366-restored')
  await expect
    .poll(async () => (await jobsFor(restored)).length, { timeout: 60_000 })
    .toBeGreaterThan(0)
})
