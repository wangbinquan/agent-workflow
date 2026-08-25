// RFC-319 B35 —— HUMAN-08 / HUMAN-31：澄清与评审的乐观锁。
//
// 人工门是**多人同时看着同一屏**的地方：一个任务停在澄清或评审上，任务成员都能
// 打开它。两个人同时作答 / 同时决策时，服务端只能接受一个——而拒绝哪一个不是
// 细节，是这条能力的全部：
//
//   * 没有这把锁，后到的那次提交会**静默覆盖**先到的。界面两边都显示"已提交"，
//     而 agent 拿着其中一份答案重跑，另一个人的输入从此不存在于任何地方；
//   * 更隐蔽的是评审侧：驳回理由与重跑节点都挂在决策上，覆盖掉的不只是一次点击，
//     是下一轮 agent 的**修改依据**。
//
// 两条判据同形：拿一个**过期的轮次号**提交，必须以 409 被拒，且被拒之后
// **服务端状态逐字不变**（仍停在等人上、轮次号没动）。只断言"返回 409"不够——
// 一个"先落库再返回 409"的实现同样能让状态码正确。收尾都跟一次正确轮次号的
// 提交作正向对照，否则"任何提交都被拒"也能全绿。
//
// 判据取自源码单一事实源：
//   services/clarify/autoDispatch.ts:558-565  ifMatchIteration !== round.iteration ⇒ 409
//   services/review.ts:2435-2440              reviewIteration !== run.reviewIteration ⇒ 409

import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let repoDir: string
let clarifyStubState: string

interface Daemons {
  clarify: DaemonHandle
  review: DaemonHandle
}
const daemons: Partial<Daemons> = {}

async function api<T>(d: DaemonHandle, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${d.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

/** 不断言成功——这条用来观察**被拒**的响应。 */
async function rawPost(
  d: DaemonHandle,
  path: string,
  payload: unknown,
): Promise<{ status: number; code: string | null }> {
  const res = await fetch(`${d.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let code: string | null = null
  try {
    code = (JSON.parse(text) as { code?: string }).code ?? null
  } catch {
    code = null
  }
  return { status: res.status, code }
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-humanlock-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 human-gate fixture\n', 'utf-8')
  initGitRepo(repoDir)
  // 两种 stub：`clarify` 让 designer 先反问一轮；`basic` 直接出稿交给评审。
  //
  // `CLARIFY_STUB_STATE` 必须**每次运行一份新的**：clarify stub 的轮次计数是一个
  // 标记**文件**（skeleton 的 `markCalled`），缺省落在 `/tmp/aw-e2e-clarify-state`，
  // 比 daemon 和整次测试运行都活得久。不隔离的话第二次跑时 stub 认为「这个 agent
  // 已经问过了」，直接出最终输出、任务根本不停在等人上——实测第一次绿、第二次
  // 在等待反问的轮询上超时，看起来像 flaky，其实是跨运行的状态泄漏。
  clarifyStubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-humanlock-clarify-state-'))
  daemons.clarify = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: clarifyStubState },
  })
  daemons.review = await startDaemon()
})

test.afterAll(async () => {
  for (const d of [daemons.clarify, daemons.review]) {
    if (d !== undefined) await d.stop()
  }
  for (const path of [repoDir, clarifyStubState]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

async function seedDesignerWorkflow(
  d: DaemonHandle,
  name: string,
  withClarify: boolean,
): Promise<string> {
  const agent = await api<{ id: string }>(d, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `${name}-designer`,
      description: 'RFC-319 human-gate fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const nodes: Array<Record<string, unknown>> = [
    { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
    {
      id: 'designer',
      kind: 'agent-single',
      agentId: agent.id,
      agentName: `${name}-designer`,
      promptTemplate: 'Design for {{topic}}.',
      position: { x: 320, y: 0 },
    },
    {
      id: 'review_design',
      kind: 'review',
      inputSource: { nodeId: 'designer', portName: 'design' },
      rerunnableOnIterate: ['designer'],
      rerunnableOnReject: ['designer'],
      position: { x: 820, y: 0 },
    },
  ]
  const edges: Array<Record<string, unknown>> = [
    {
      id: 'e_in_designer',
      source: { nodeId: 'in_1', portName: 'topic' },
      target: { nodeId: 'designer', portName: 'topic' },
    },
  ]
  if (withClarify) {
    nodes.push({
      id: 'clarify_1',
      kind: 'clarify',
      title: 'Clarify design',
      position: { x: 560, y: 160 },
    })
    edges.push(
      {
        id: 'e_clarify_ask',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify_1', portName: 'questions' },
      },
      {
        id: 'e_clarify_ans',
        source: { nodeId: 'clarify_1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    )
  }
  const wf = await api<{ id: string }>(d, '/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 human-gate fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes,
        edges,
      },
    }),
  })
  return wf.id
}

async function launch(d: DaemonHandle, workflowId: string, name: string): Promise<string> {
  const task = await api<{ id: string }>(d, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  return task.id
}

test('HUMAN-08 澄清：拿过期轮次号提交被 409 拒绝，且服务端状态一个字节不变 @nightly', async () => {
  const d = daemons.clarify as DaemonHandle
  const workflowId = await seedDesignerWorkflow(d, 'rfc319-human08', true)
  const taskId = await launch(d, workflowId, 'rfc319-human08-task')

  interface Session {
    intermediaryNodeRunId: string
    iteration: number
    questionCount: number
    status?: string
  }
  const sessionOf = async (): Promise<Session | null> => {
    const rows = await api<Session[]>(
      d,
      `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
    )
    return rows[0] ?? null
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        session = await sessionOf()
        return session !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  const before = session as unknown as Session
  expect(before.questionCount).toBeGreaterThan(0)

  const answers = {
    answers: [
      {
        questionId: 'q-db',
        selectedOptionIndices: [0],
        selectedOptionLabels: [],
        customText: '',
      },
      {
        questionId: 'q-lang',
        selectedOptionIndices: [0],
        selectedOptionLabels: [],
        customText: '',
      },
    ],
    directive: 'stop' as const,
  }

  const stale = await rawPost(d, `/api/clarify/${before.intermediaryNodeRunId}/answers`, {
    ...answers,
    ifMatchIteration: before.iteration + 1,
  })
  expect(
    { status: stale.status, code: stale.code },
    '过期轮次号被放行 ⇒ 后到的提交会静默覆盖先到的，两边界面都显示「已提交」，' +
      '而 agent 只会拿着其中一份重跑',
  ).toEqual({ status: 409, code: 'clarify-iteration-mismatch' })

  const after = await sessionOf()
  expect(
    after === null ? null : { iteration: after.iteration, questionCount: after.questionCount },
    '被拒之后轮次却动了 ⇒ 这是「先落库再返回 409」，状态码对、数据已经被改了',
  ).toEqual({ iteration: before.iteration, questionCount: before.questionCount })

  // 正向对照：同一份答案配正确的轮次号必须被接受，否则上面的 409 可能只是
  //「这条链路根本提交不了」。
  const fresh = await rawPost(d, `/api/clarify/${before.intermediaryNodeRunId}/answers`, {
    ...answers,
    ifMatchIteration: before.iteration,
  })
  expect(fresh.status, `正确轮次号也被拒（code=${fresh.code ?? 'null'}）`).toBe(200)
})

test('HUMAN-31 评审：拿过期轮次号决策被 409 拒绝，任务仍停在等人评审上 @nightly', async () => {
  const d = daemons.review as DaemonHandle
  const workflowId = await seedDesignerWorkflow(d, 'rfc319-human31', false)
  const taskId = await launch(d, workflowId, 'rfc319-human31-task')

  interface ReviewRow {
    nodeRunId: string
    taskId: string
    reviewIteration: number
    awaitingReview: boolean
  }
  const pendingOf = async (): Promise<ReviewRow | null> => {
    const rows = await api<ReviewRow[]>(d, '/api/reviews?status=pending')
    return rows.find((row) => row.taskId === taskId && row.awaitingReview) ?? null
  }
  let pending: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        pending = await pendingOf()
        return pending !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  const before = pending as unknown as ReviewRow

  // 决策值是 `approved` 而不是 `approve`（shared/schemas/review.ts:134 的枚举）。
  // 写错的话 422 会在**乐观锁之前**把请求拦下，这条判据就打不到目标了——第一版
  // 正是这样，红出来的是 `review-decision-invalid`。
  const stale = await rawPost(d, `/api/reviews/${before.nodeRunId}/decision`, {
    decision: 'approved',
    reviewIteration: before.reviewIteration + 1,
  })
  expect(
    { status: stale.status, code: stale.code },
    '过期轮次号被放行 ⇒ 覆盖掉的不只是一次点击，是下一轮 agent 的修改依据' +
      '（驳回理由与重跑节点都挂在决策上）',
  ).toEqual({ status: 409, code: 'review-iteration-mismatch' })

  const after = await pendingOf()
  expect(
    after === null ? null : after.reviewIteration,
    '被拒之后评审轮次却动了 ⇒ 决策已经落库，409 只是事后诸葛',
  ).toBe(before.reviewIteration)
  expect(
    (await api<{ status: string }>(d, `/api/tasks/${taskId}`)).status,
    '被拒的决策把任务推走了 ⇒ 那次评审再也回不来',
  ).toBe('awaiting_review')

  const fresh = await rawPost(d, `/api/reviews/${before.nodeRunId}/decision`, {
    decision: 'approved',
    reviewIteration: before.reviewIteration,
  })
  expect(fresh.status, `正确轮次号也被拒（code=${fresh.code ?? 'null'}）`).toBe(200)
})
