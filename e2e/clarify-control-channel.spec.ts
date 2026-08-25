// RFC-319 B36 —— HUMAN-19：澄清的 defer 控制通道，以及它与快速通道的非法组合。
//
// 同一个端点上挂着两条语义完全不同的通道：
//
//   * **快速通道**（`defer` 缺省/false）：回答**整轮**，封存并当场下发——轮次
//     终结、重跑落地、任务继续跑；
//   * **控制通道**（`defer: true`）：只封存被点名的那几题，**不铸重跑、不推进
//     任务**，题目进入待下发等批量下发。
//
// 两个只在控制通道上有意义的字段（`questionIds` 子集上限、`resubmitQuestionIds`
// 重答声明）如果被允许配在快速通道上，后果是**静默丢题**：服务端会按子集作答、
// 却仍然把**整轮**判为已回答并铸出重跑，没被点名的问题从此永远停在那儿——
// 而调用方收到的是 200。所以这两个组合必须当场拒绝，而不是「过滤掉再往下走」。
//
// 判据三段：两条非法组合各自被点名拒绝且看板逐字不变；控制通道真的**只封存
// 不下发**——被点名那题进 `staged`，没点名的那题不动，任务仍停在等人上。
//
// 判据取自源码单一事实源：
//   routes/clarify.ts:245-258   两条非法组合的拒绝（各自独立的 code）
//   routes/clarify.ts:266-292   defer ⇒ sealRoundQuestions(autoStage) 且**不** resumeTask
//   shared/task-questions.ts:48 phase 词汇：pending 待指派 / staged 待下发

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
let stubState: string
let taskId: string
let nodeRunId: string
let baseIteration: number

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

async function rawPost(
  path: string,
  payload: unknown,
): Promise<{ status: number; code: string | null }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
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

interface BoardEntry {
  questionId: string
  phase: string
}
const board = async (): Promise<Array<{ questionId: string; phase: string }>> =>
  (await api<BoardEntry[]>(`/api/tasks/${taskId}/questions`))
    .map((row) => ({ questionId: row.questionId, phase: row.phase }))
    .sort((a, b) => a.questionId.localeCompare(b.questionId))

const taskStatus = async (): Promise<string> =>
  (await api<{ status: string }>(`/api/tasks/${taskId}`)).status

/** 两道题各给一个答案；stub 的题是 q-db（单选）与 q-lang（多选）。 */
const ANSWERS = [
  { questionId: 'q-db', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
  { questionId: 'q-lang', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
]

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-ctrlchan-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 control channel fixture\n', 'utf-8')
  initGitRepo(repoDir)
  // 每次运行独立的 stub 状态目录：clarify stub 的轮次计数是标记**文件**，
  // 缺省落 `/tmp/aw-e2e-clarify-state` 且比整次运行活得久（见
  // `e2e/human-gate-optimistic-locks.spec.ts` 里记的那处假 flaky）。
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-ctrlchan-state-'))
  daemon = await startDaemon({
    stubMode: 'clarify',
    extraEnv: { CLARIFY_STUB_STATE: stubState },
  })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-ctrlchan-designer',
      description: 'RFC-319 control channel fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-ctrlchan-wf',
      description: 'RFC-319 control channel fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-ctrlchan-designer',
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'clarify_1',
            kind: 'clarify',
            title: 'Clarify design',
            position: { x: 560, y: 160 },
          },
        ],
        edges: [
          {
            id: 'e_in_designer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
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
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-ctrlchan-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
    intermediaryNodeRunId: string
    iteration: number
    questionCount: number
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  const found = session as unknown as Session
  nodeRunId = found.intermediaryNodeRunId
  baseIteration = found.iteration
  expect(found.questionCount, '这一轮应当有两道题，子集上限才有被测面').toBe(2)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const path of [repoDir, stubState]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

test('快速通道上带子集上限被当场拒绝，而不是「过滤掉再往下走」 @nightly', async () => {
  const before = await board()
  const rejected = await rawPost(`/api/clarify/${nodeRunId}/answers`, {
    answers: ANSWERS,
    questionIds: ['q-db'],
    ifMatchIteration: baseIteration,
  })
  expect(
    { status: rejected.status, code: rejected.code },
    '快速通道接受了子集上限 ⇒ 它会按子集作答却把**整轮**判为已回答并铸出重跑，' +
      '没被点名的问题从此永远停在那儿，而调用方收到的是 200',
  ).toEqual({ status: 422, code: 'clarify-question-ids-requires-defer' })
  expect(await board(), '被拒之后看板却动了 ⇒ 拒绝发生在写之后').toEqual(before)
  expect(await taskStatus()).toBe('awaiting_human')
})

test('快速通道上带重答声明同样被拒（两条组合各有各的 code） @nightly', async () => {
  const before = await board()
  const rejected = await rawPost(`/api/clarify/${nodeRunId}/answers`, {
    answers: ANSWERS,
    resubmitQuestionIds: ['q-db'],
    ifMatchIteration: baseIteration,
  })
  expect(
    { status: rejected.status, code: rejected.code },
    '两条非法组合共用一个 code 的话，界面无法区分「不能带子集」与「不能重答」',
  ).toEqual({ status: 422, code: 'clarify-resubmit-requires-defer' })
  expect(await board()).toEqual(before)
  expect(await taskStatus()).toBe('awaiting_human')
})

test('控制通道只封存不下发：被点名那题进待下发，另一题不动，任务仍停在等人上 @nightly', async () => {
  const accepted = await rawPost(`/api/clarify/${nodeRunId}/answers`, {
    answers: ANSWERS,
    defer: true,
    questionIds: ['q-db'],
    ifMatchIteration: baseIteration,
  })
  expect(accepted.status, `控制通道被拒（code=${accepted.code ?? 'null'}）`).toBe(200)

  const after = await board()
  const phaseOf = (id: string): string | undefined =>
    after.find((row) => row.questionId === id)?.phase
  expect(phaseOf('q-db'), '被点名的题没进待下发 ⇒ 控制通道封了个寂寞，批量下发拿不到它').toBe(
    'staged',
  )
  expect(
    phaseOf('q-lang'),
    '没被点名的题也被一起封了 ⇒ 子集上限没生效，这正是快速通道要拒绝它的原因',
  ).not.toBe('staged')

  expect(
    await taskStatus(),
    'defer 的全部意义就是**不推进执行**；任务被推走了说明它当成快速通道处理了',
  ).toBe('awaiting_human')
})
