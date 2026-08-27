// RFC-333 T12 —— review 决策的成功边界是「决策 + durable continuation」同事务。
//
// 决策事务同时落下领域决定、node/task projection、公开 receipt 与 exact
// gate-continuation intent；commit 后的 wake 只是对同一持久事实的加速。因此工作树
// 被 GC 掉会让后续 repository preparation 失败，但不能把已提交的用户决定
// 伪装成失败，也不能暴露已退役的 `resume` / `resumeRequired` 内部协议。
//
// 判据三段：①响应携带可对账的 committed receipt；②两个旧 resume 字段
// 始终不存在；③决策确实落库，但下游没跑完也不谎报任务 done。
//
// 触发下游真失败的方式仍是把任务工作树从磁盘上删掉；这能证明
// HTTP 成功不依赖工作树或当前进程内 wake，而依赖已落库的持久事实。

import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let daemon: DaemonHandle
let repoDir: string
let workflowId: string
let sequence = 0

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface DecisionResponse {
  ok: boolean
  receipt: {
    operationId: string
    gate: { kind: string; ref: string }
    gateRevision: number
    taskRevision: number
    acceptedAt: number
    replayed: boolean
  }
  resume?: unknown
  resumeRequired?: unknown
}

async function decide(
  nodeRunId: string,
  reviewIteration: number,
): Promise<{ status: number; body: DecisionResponse }> {
  const res = await fetch(`${daemon.baseUrl}/api/reviews/${nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', reviewIteration }),
  })
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as DecisionResponse }
}

interface ReviewRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}

async function launchAndAwaitReview(name: string): Promise<{ task: string; review: ReviewRow }> {
  const created = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  let row: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        row = rows.find((r) => r.taskId === created.id && r.awaitingReview) ?? null
        return row !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return { task: created.id, review: row as unknown as ReviewRow }
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-resumefail-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 resume-failure fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-resumefail-designer',
      description: 'RFC-319 resume-failure fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-resumefail-wf',
        description: 'RFC-319 resume-failure fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-resumefail-designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'review_design',
              kind: 'review',
              inputSource: { nodeId: 'designer', portName: 'design' },
              rerunnableOnIterate: ['designer'],
              rerunnableOnReject: ['designer'],
              position: { x: 640, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_designer',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'designer', portName: 'topic' },
            },
          ],
        },
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

test('正向对照：工作树健在时，决策响应里不带任何 resume 警告 @nightly', async () => {
  const { task, review } = await launchAndAwaitReview(`rfc319-resumefail-ok-${++sequence}`)
  const done = await decide(review.nodeRunId, review.reviewIteration)
  expect(done.status).toBe(200)
  expect(done.body.receipt).toMatchObject({
    gate: { kind: 'review', ref: `review:${review.nodeRunId}` },
    replayed: false,
  })
  expect(done.body.resume).toBeUndefined()
  expect(done.body.resumeRequired).toBeUndefined()
  expect(
    (await api<ReviewRow[]>('/api/reviews?status=pending')).some((r) => r.taskId === task),
    '决策提交完这条评审还挂在待办里',
  ).toBe(false)
})

test('工作树被回收后：决策与 durable continuation 照样落库，且不泄露内部 wake @nightly', async () => {
  const { task, review } = await launchAndAwaitReview(`rfc319-resumefail-gone-${++sequence}`)
  const detail = await api<{ worktreePath: string }>(`/api/tasks/${task}`)
  expect(detail.worktreePath, '任务没有工作树路径 ⇒ 下面的删除构造不出那条失败').toBeTruthy()
  rmSync(detail.worktreePath, { recursive: true, force: true })

  const decided = await decide(review.nodeRunId, review.reviewIteration)
  expect(decided.status, '工作树故障不得回滚已提交的决策与持久续跑事实').toBe(200)
  expect(
    decided.body.receipt,
    '响应没有 committed receipt ⇒ 调用方无法对账这次已接受的决策',
  ).toMatchObject({
    gate: { kind: 'review', ref: `review:${review.nodeRunId}` },
    replayed: false,
  })
  expect(decided.body.receipt.operationId).toBeTruthy()
  expect(decided.body.receipt.gateRevision).toBeGreaterThan(0)
  expect(decided.body.resume, '公开响应不得再暴露进程内 wake 结果').toBeUndefined()
  expect(decided.body.resumeRequired, '公开响应不得再要求客户端补 resume').toBeUndefined()

  // 决策本身确实落库：这条评审不再挂在待办上。
  expect(
    (await api<ReviewRow[]>('/api/reviews?status=pending')).some((r) => r.taskId === task),
    '决策因为踢不动而回滚了 ⇒ 2xx 与库里的事实不一致',
  ).toBe(false)

  expect(
    (await api<{ status: string }>(`/api/tasks/${task}`)).status,
    '任务被说成 done ⇒ 踢失败被当成了跑完，这比不报警告更坏',
  ).not.toBe('done')
})
