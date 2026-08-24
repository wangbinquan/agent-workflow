// RFC-319 B15 —— 任务启动前置门与终态删除（TASK-46 / TASK-28）。
//
// 两条都在任务的**两端**，也都属于「错了要很久才发现」的类别：
//
//   * 启动门漏 ⇒ 一个看不见某工作流的人可以用它开工。泄漏形式是「任务启动成功」，
//     完全不像一次越权（`routes/tasks.ts:295` 对同类问题的原话）。
//   * 删除门漏 ⇒ 任务连同它的工作树、节点运行记录、产物一并消失，没有回收站。
//     删错一次没有任何补救手段。
//
// 判据取自源码单一事实源：
//   `assertWorkflowLaunchable`（services/taskLaunchGate.ts:26）——不可见与不存在
//     **同形 404**；内置工作流 403；静态校验不过 422。
//   `deleteTask`（services/taskDelete.ts:76）—— 非终态 409 `task-not-terminal`。
//   `assertDeleteConfirm`（services/deleteConfirm.ts:44）—— 逐字回显任务名。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const PASSWORD = 'Rfc319TaskGatePass!1'
const NEVER_EXISTED = '01JZZZZZZZZZZZZZZZZZZZZZZZ'

let daemon: DaemonHandle
let repoDir: string
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-taskgate-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 task gate fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

function normalizeRefusal(body: string, askedId: string): string {
  return body.split(askedId).join('<asked-id>')
}

async function plainUser(): Promise<string> {
  const username = `rfc319-taskgate-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

/** 一个能通过静态校验的最小工作流：一个输入直连一个输出。 */
async function seedWorkflow(name: string): Promise<string> {
  const created = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 task-gate fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    `seed workflow ${name}`,
  )
  return created.id
}

/**
 * 一个会**停在评审门**上的工作流：input → agent → review → output。
 *
 * 评审节点的 `inputSource` 必须来自 agent 节点且是 markdown 产物（实测：直接
 * 接 input 会被静态校验拒为 `review-input-source-not-markdown`），所以中间那个
 * agent 是必需的，不是装饰。stub runtime 的 basic 模式会吐
 * `<port name="answer">…</port>`，因此 agent 就声明这一个口。
 *
 * 评审门等人拍板，所以任务**确定性地**停在 `awaiting_review`，不依赖任何时序窗口。
 */
async function seedParkingWorkflow(name: string): Promise<string> {
  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: `${name}-agent`,
        description: 'RFC-319 parking fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: 'Stub agent for the RFC-319 task-gate spec.',
      }),
    }),
    `seed agent for ${name}`,
  )
  const created = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: 'RFC-319 non-terminal fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'writer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: `${name}-agent`,
              promptTemplate: 'Write about {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'gate',
              kind: 'review',
              title: 'hold here',
              description: '',
              inputSource: { nodeId: 'writer', portName: 'answer' },
              rerunnableOnReject: [],
              rerunnableOnIterate: [],
              rollbackFilesOnReject: false,
              rollbackFilesOnIterate: false,
              position: { x: 640, y: 0 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'gate', portName: 'approved_doc' } }],
              position: { x: 960, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_writer',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'writer', portName: 'topic' },
            },
            {
              id: 'e_writer_gate',
              source: { nodeId: 'writer', portName: 'answer' },
              target: { nodeId: 'gate', portName: '__review_input__' },
            },
            {
              id: 'e_gate_out',
              source: { nodeId: 'gate', portName: 'approved_doc' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    `seed parking workflow ${name}`,
  )
  return created.id
}

// ---------------------------------------------------------------------------
// TASK-46 —— 启动前置门
// ---------------------------------------------------------------------------

test('RFC-319 TASK-46: launching refuses an invisible workflow exactly as it refuses one that never existed, and refuses a caller without tasks:execute', async () => {
  const workflowId = await seedWorkflow(`rfc319-private-wf-${++sequence}`)
  const outsider = await plainUser()

  const launch = async (id: string, token?: string): Promise<Response> =>
    req(
      '/api/tasks',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `rfc319-launch-${sequence}`,
          workflowId: id,
          repoUrl: repoRemoteUrl(repoDir),
          ref: 'main',
          inputs: { topic: 'x' },
        }),
      },
      token,
    )

  // 前提：owner 自己启动得起来（否则「别人启动不了」什么也证明不了）。
  const own = await launch(workflowId)
  expect(own.status, `owner 自己都启动不了: ${await own.clone().text()}`).toBe(201)
  const ownTaskId = ((await own.json()) as { id: string }).id

  // ① 不可见的工作流：与「不存在」同形。泄漏形式是「任务启动成功」，
  //    所以这条一旦漏掉，症状是**没有症状**。
  const hidden = await launch(workflowId, outsider)
  const absent = await launch(NEVER_EXISTED, outsider)
  expect(hidden.status).toBe(404)
  expect(hidden.status).toBe(absent.status)
  expect(
    normalizeRefusal(await hidden.text(), workflowId),
    '「看不见」与「不存在」的拒绝不同 ⇒ 可以拿工作流 id 空间做存在性探测',
  ).toBe(normalizeRefusal(await absent.text(), NEVER_EXISTED))

  // ② 公开之后同一个人就能启动了——这条正向对照排除「他压根启动不了任何东西」。
  const acl = await jsonOf<{ aclRevision: number }>(
    await req(`/api/workflows/${workflowId}/acl`),
    'read workflow acl',
  )
  await jsonOf(
    await req(`/api/workflows/${workflowId}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: workflowId,
        expectedAclRevision: acl.aclRevision,
      }),
    }),
    'publish workflow',
  )
  const nowVisible = await launch(workflowId, outsider)
  expect(
    nowVisible.status,
    `工作流公开之后这个用户仍然启动不了: ${await nowVisible.clone().text()}`,
  ).toBe(201)

  // ③ 缺 `tasks:execute` 的调用方（guest 预设里没有它）被方法门挡下，
  //    而且拒绝形状是 403 —— 与上面的 404 不同，因为这时**工作流是公开的**，
  //    藏无可藏，能力缺失才是真正的原因。
  const guestName = `rfc319-guest-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username: guestName,
        displayName: guestName,
        email: `${guestName}@example.com`,
        role: 'guest',
        password: PASSWORD,
      }),
    }),
    'seed guest',
  )
  const { sessionToken: guestToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: guestName, password: PASSWORD }),
    }),
    'login guest',
  )
  const guestLaunch = await launch(workflowId, guestToken)
  expect(guestLaunch.status, '没有 tasks:execute 的账号启动了任务 ⇒ 只读预设不再只读').toBe(403)

  // 清理：owner 那条任务留给 TASK-28 用不着，直接确认它存在即可。
  expect((await req(`/api/tasks/${ownTaskId}`)).status).toBe(200)
})

// ---------------------------------------------------------------------------
// TASK-28 —— 终态删除：非终态拒绝 + 逐字确认 + 真的删掉
// ---------------------------------------------------------------------------

test('RFC-319 TASK-28: deleting a task requires it to be terminal and the name typed back verbatim', async () => {
  const workflowId = await seedWorkflow(`rfc319-delete-wf-${++sequence}`)
  const taskName = `rfc319-deletable-${sequence}`
  const task = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: taskName,
        workflowId,
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
        inputs: { topic: 'x' },
      }),
    }),
    'launch task',
  )

  // 等它到终态。这个工作流只有 input → output，没有 agent，所以很快就 done。
  const deadline = Date.now() + 60_000
  let status = ''
  while (Date.now() < deadline) {
    status = (await jsonOf<{ status: string }>(await req(`/api/tasks/${task.id}`), 'read task'))
      .status
    if (['done', 'failed', 'canceled'].includes(status)) break
    await new Promise((r) => setTimeout(r, 200))
  }
  expect(['done', 'failed', 'canceled'], `任务没有走到终态（${status}）`).toContain(status)

  // ① 非终态的任务不能删。这条用一个**确定性**停住的任务来证：它停在评审门上
  //    等人拍板，不依赖任何时序窗口。删一个还在跑的任务会留下孤儿进程与孤儿
  //    工作树，所以这道门必须在确认门之前就挡下来。
  //
  //    变异实证记录：这道门有**两处**实现——`taskDelete.ts:93` 的廉价前置检查，
  //    与 :174 事务锁内的权威复查。只短路前置那道用例仍绿；两道一起短路才转红。
  //    判据落在行为上，所以任一层还在这条能力就成立。
  const parkingWorkflow = await seedParkingWorkflow(`rfc319-parking-wf-${++sequence}`)
  const parkedName = `rfc319-parked-${sequence}`
  const parked = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: parkedName,
        workflowId: parkingWorkflow,
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
        inputs: { topic: 'x' },
      }),
    }),
    'launch parking task',
  )
  const parkDeadline = Date.now() + 60_000
  let parkedStatus = ''
  while (Date.now() < parkDeadline) {
    parkedStatus = (
      await jsonOf<{ status: string }>(await req(`/api/tasks/${parked.id}`), 'read parked task')
    ).status
    if (parkedStatus === 'awaiting_review') break
    await new Promise((r) => setTimeout(r, 200))
  }
  expect(parkedStatus, '任务没有停在评审门上 —— 非终态断言将无从证明').toBe('awaiting_review')
  const nonTerminal = await req(`/api/tasks/${parked.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: parkedName }),
  })
  expect(
    nonTerminal.status,
    '还在等人拍板的任务被删掉了 ⇒ 孤儿工作树与孤儿进程留在机器上，且没有回收站',
  ).toBe(409)
  expect((await nonTerminal.json()).code).toBe('task-not-terminal')
  expect((await req(`/api/tasks/${parked.id}`)).status).toBe(200)

  // ② 不回显名字 ⇒ 422，任务还在。
  const naked = await req(`/api/tasks/${task.id}`, { method: 'DELETE' })
  expect(naked.status).toBe(422)
  expect((await naked.json()).code).toBe('delete-confirm-required')
  expect((await req(`/api/tasks/${task.id}`)).status, '被拒的删除却真删了').toBe(200)

  // ③ 回显错了 ⇒ 422。这道门防的是「点错了一行」——列表里相邻两条任务的
  //    名字往往只差一个词。
  const wrong = await req(`/api/tasks/${task.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: `${taskName}-not-this-one` }),
  })
  expect(wrong.status).toBe(422)
  expect((await wrong.json()).code).toBe('delete-confirm-mismatch')

  // ④ 回显对了 ⇒ 真删掉，且再读是 404（不是残留一条空壳）。
  const ok = await req(`/api/tasks/${task.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: taskName }),
  })
  expect(ok.status, `逐字确认之后仍删不掉: ${await ok.clone().text()}`).toBe(200)
  expect((await req(`/api/tasks/${task.id}`)).status).toBe(404)
})
