// RFC-319 B65 —— HUMAN-43：上游一份文档都没有时，评审门不许把人困在那儿。
//
// Code → Audit → Fix 这条链上，「审计输出为空」是**成功**的那一档：没有问题要修。
// 但它下游挂着一道人工评审门，而这道门被设计成「逐份文档看」——一份都没有时，它既
// 无从渲染、也无从决策。RFC-202 T1 记的就是这个事故形态：旧行为会停一个空轮，而那个
// 轮次**从每一个用户入口都够不着**——收件箱里看不见（没有 doc_version）、详情页 404、
// 画布导航为 null、API 上 `submitReviewDecision` 对零条待决行回 409。于是任务永远停在
// `awaiting_review`，没有任何人能把它推动一步，也没有任何地方会报错。
//
// 现行行为：零条即自动通过，发布与「人工勾选了空集」逐字相同的 `accepted` +
// `approval_meta`（`auto: 'empty-list'` 标明是框架判的），关掉这一跑，让下游继续。
//
// 判据取自源码单一事实源：
//   services/review.ts:583-592   list<markdown> 走 splitMarkdownDocs / list<path<md>> 走 splitListItems
//   services/review.ts:823-876   docs.length === 0 ⇒ 直接发布空 accepted + approval_meta 并结束
//   services/review.ts:840-846   approval_meta 里 itemCount/acceptedCount 为 0、auto='empty-list'、无决策人身份
//
// fixture 说明：`workflow-matrix` stub 按**提示词里的标记**分支（不是 agent 名），且
// `iteration=` 也是从提示词里读的（`mode-workflow-matrix.ts:55-61`）。所以在
// promptTemplate 里写死 `MATRIX_LOOP_EMPTY` + `iteration=1` 就能拿到一个**空端口**，
// 写 `iteration=0` 则拿到非空的一份——两条工作流除这一处外逐字相同，正好互为对照。

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
let stateDir: string
let agentId: string

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return body === '' ? (null as T) : (JSON.parse(body) as T)
}

interface NodeRunsResponse {
  runs: Array<{ id: string; nodeId: string; status: string }>
  outputs: Array<{ nodeRunId: string; port: string; value: string; kind: string | null }>
}

/** 两条工作流只差 promptTemplate 里的 `iteration=` 一个字符。 */
async function makeWorkflow(name: string, iteration: 0 | 1): Promise<string> {
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 B65 empty-review fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'producer',
            kind: 'agent-single',
            agentId,
            agentName: 'rfc319-b65-producer',
            promptTemplate: `MATRIX_LOOP_EMPTY\niteration=${iteration}\ntopic={{topic}}`,
            position: { x: 320, y: 0 },
          },
          {
            id: 'doc_review',
            kind: 'review',
            title: 'B65 review gate',
            inputSource: { nodeId: 'producer', portName: 'status' },
            position: { x: 640, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'accepted', bind: { nodeId: 'doc_review', portName: 'accepted' } }],
            position: { x: 960, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e_in_producer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'producer', portName: 'topic' },
          },
          {
            id: 'e_producer_review',
            source: { nodeId: 'producer', portName: 'status' },
            target: { nodeId: 'doc_review', portName: '__review_input__' },
          },
          {
            id: 'e_review_out',
            source: { nodeId: 'doc_review', portName: 'accepted' },
            target: { nodeId: 'out_1', portName: 'accepted' },
          },
        ],
      },
    }),
  })
  return wf.id
}

async function launch(workflowId: string, name: string): Promise<string> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'empty review gate' },
    }),
  })
  return task.id
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b65-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 b65 fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-b65-state-'))
  daemon = await startDaemon({
    stubMode: 'workflow-matrix',
    extraEnv: { MATRIX_STATE_DIR: stateDir },
  })
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-b65-producer',
      description: 'RFC-319 B65 fixture',
      outputs: ['status', 'items'],
      // status 走 list<markdown>：空串 ⇒ 零份文档；非空 ⇒ 一份内联文档。
      outputKinds: { status: 'list<markdown>', items: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  agentId = agent.id
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

test('上游零份文档：评审门自动放行，任务往前走，而不是停在一个谁也点不开的空轮上', async () => {
  const wfId = await makeWorkflow('rfc319-b65-empty', 1)
  const taskId = await launch(wfId, 'rfc319-b65-empty-task')

  // ① 任务必须走到底。停在 awaiting_review 就是那个「谁也推不动」的事故形态。
  const status = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 120_000
    const tick = async (): Promise<void> => {
      const t = await api<{ status: string; errorMessage?: string | null }>(`/api/tasks/${taskId}`)
      if (['done', 'failed', 'canceled'].includes(t.status)) return resolve(t.status)
      if (Date.now() > deadline) return reject(new Error(`stuck at ${t.status}`))
      setTimeout(() => void tick(), 300)
    }
    void tick()
  })
  expect(status, '零份文档时任务应当直接跑完').toBe('done')

  // ② 从来没有出现在收件箱里——「有人得去处理」这件事本身就不该发生。
  const pending = await api<Array<{ taskId: string }>>('/api/reviews?status=pending')
  expect(
    pending.filter((r) => r.taskId === taskId),
    '零份文档却挂进了待办 —— 那条待办点开是 404，只会消耗人的时间',
  ).toEqual([])

  // ③ 发布的东西要和「人工勾了空集」逐字一致，且标明是框架自己判的。
  const runs = await api<NodeRunsResponse>(`/api/tasks/${taskId}/node-runs`)
  const reviewRun = runs.runs.find((r) => r.nodeId === 'doc_review')
  expect(reviewRun?.status).toBe('done')
  const outs = runs.outputs.filter((o) => o.nodeRunId === reviewRun?.id)
  const accepted = outs.find((o) => o.port === 'accepted')
  expect(accepted, '空轮也必须发布 accepted 端口，否则下游节点会拿不到输入').not.toBeUndefined()
  expect(accepted!.value).toBe('')
  const meta = outs.find((o) => o.port === 'approval_meta')
  expect(meta, 'approval_meta 是下游判断「这轮是怎么过的」的唯一依据').not.toBeUndefined()
  const parsed = JSON.parse(meta!.value) as Record<string, unknown>
  expect(parsed.decision).toBe('approved')
  expect(parsed.itemCount).toBe(0)
  expect(parsed.acceptedCount).toBe(0)
  expect(
    parsed.auto,
    "自动通过必须留下 auto='empty-list' —— 否则下游分不清这是人批的还是框架判的",
  ).toBe('empty-list')
  // RFC-099：approval_meta 是下游可消费端口，不许带决策人身份。
  expect(Object.keys(parsed)).not.toContain('decidedBy')
})

test('对照：上游有一份文档时，这道门照常拦住人工评审', async () => {
  // 少了这条，「评审门永远自动放行」也能让上一条成立——那就等于把人工门整个废掉了。
  const wfId = await makeWorkflow('rfc319-b65-nonempty', 0)
  const taskId = await launch(wfId, 'rfc319-b65-nonempty-task')

  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 120_000,
    })
    .toBe('awaiting_review')
  const pending = await api<Array<{ taskId: string; awaitingReview: boolean }>>(
    '/api/reviews?status=pending',
  )
  expect(
    pending.some((r) => r.taskId === taskId && r.awaitingReview),
    '有文档时就该出现在待办里等人看',
  ).toBe(true)
})
