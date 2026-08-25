// RFC-319 B39 —— HUMAN-X2：澄清作答的**答案类型矩阵**，以及它落进下一轮提示词的形态。
//
// 澄清这条链上真正决定成败的不是「点得动」，而是**用户点的东西有没有原样穿到
// agent 手里**。这一段没有任何报错面：作答返回 200、轮次照样封存、任务照样重跑，
// 只要中间某一环把答案捏错了，agent 就拿着一份**看起来完整的错答案**继续干活，
// 而人在界面上看到的是「已回答」。典型三种捏法：
//
//   1. 多选只落最后一个（`toggleMultiOption` 若写成覆盖而非并入）——提示词里从
//      `User selected: "TypeScript", "Python"` 退化成 `User selected: "Python"`；
//   2. 自定义文本（单选的「其他」行）被当成没答——单选一旦没有选中项，
//      `summariseClarifyAnswer` 走的是 `User chose custom answer:` 那一支，
//      这支若丢了，agent 收到的是「用户没回答」，而人明明打了字；
//   3. 空答被悄悄补齐或整题消失——本产品**接受空答**（`schemas/clarify.ts:69-71`
//      明写「submit accepts empty answers」，必填 chip 已废弃），所以正确行为是
//      **如实告诉 agent「这题没答」**，而不是把题吞掉让 agent 以为问过了。
//
// 还有一条同样静默的：`selectedOptionLabels` 是**服务端按 index 重算**的，客户端
// 送什么标签都不算数（`services/clarify/service.ts:849-850`）。这是防提示词注入的
// 那道门——它若失守，任何调用方都能把任意字符串塞进 agent 的 `Answer:` 行，而
// 请求返回 200、界面一切正常。越界 index 同理：被丢掉、退化成「没答」，不是报错。
//
// 判据一律取**提示词本身**（`GET …/node-runs/:id/session` 的 `promptText`，即
// RFC-311 externalize 之后经 `readNodeRunPrompt` 双读解析出的正文）——那是 agent
// 真正读到的字节，比任何中间态都更接近用户的实际损失。
//
// 判据取自源码单一事实源：
//   shared/clarify.ts:256-280         summariseClarifyAnswer 的六种句式
//   shared/clarify.ts:448-466         renderFlatQaItem：`- Q:` / `Type:` / `Answer:` 三行
//   shared/clarify.ts:431             FLAT_CLARIFY_QUEUE_BLOCK_TITLE = '## Clarify Q&A'
//   shared/schemas/clarify.ts:69-71   必填 chip 已废弃、submit 接受空答
//   services/clarify/service.ts:849-850  labels 由 index 重算（客户端标签不算数）
//   services/clarify/service.ts:848      越界 index 被 filter 掉
//   components/clarify/QuestionForm.tsx:164-178  多选并入并按 index 排序
//   components/clarify/QuestionForm.tsx:155-163  单选「其他」行清空选中项

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let repoDir: string
let stubState: string
let workflowIdFilled: string
let workflowIdRaw: string

/** 单选题「其他」行里打的字。刻意含空格与破折号，确保它是被整段搬运、
 *  而不是被切词或按 option 匹配出来的。 */
const CUSTOM_SINGLE = 'DuckDB — analytics only, no OLTP'
/** 多选题的补充说明。 */
const CUSTOM_MULTI = 'Rust for the hot path'
/** 客户端伪造的标签：服务端必须按 index 重算，这串字节永远不该进提示词。 */
const INJECTED_LABEL = 'RFC319-INJECTED-LABEL'

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

/** 建一条 designer→clarify 的最小工作流；`agentName` 决定 stub 的轮次标记文件，
 *  两个用例各用各的 agent，轮次计数才不会互相串（stub 的 key 是 agent.shard）。 */
async function createWorkflow(agentName: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: agentName,
      description: 'RFC-319 answer-type matrix fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `${agentName}-wf`,
      description: 'RFC-319 answer-type matrix fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName,
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
  return wf.id
}

interface Session {
  intermediaryNodeRunId: string
  iteration: number
}

/** 起任务并等它停在等人作答上，返回 taskId + 该轮的 intermediary node_run。 */
async function launchAndAwaitClarify(
  workflowId: string,
  taskName: string,
): Promise<{ taskId: string; session: Session }> {
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: taskName,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(task.id)}`,
        )
        session = rows[0] ?? null
        return session !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return { taskId: task.id, session: session! }
}

interface NodeRunRow {
  id: string
  nodeId: string
  startedAt: number | null
}

/**
 * 等任务收尾，取 designer 的**最后一次** node_run（即答完之后的那一轮重跑）
 * 的提示词正文。读的是 session 视图而不是 node-runs 列表的 `promptText` 列：
 * RFC-311 之后新行只写 `prompt_path`、列留空，只有 session 视图才走
 * `readNodeRunPrompt` 的双读（`services/nodeRunPrompt.ts:82-86`）。
 */
async function finalDesignerPrompt(taskId: string): Promise<string> {
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .toBe('done')
  const runs = await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)
  const designerRuns = runs.runs
    .filter((r) => r.nodeId === 'designer')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  expect(designerRuns.length, 'designer 应当跑了两轮：先问、再答完重跑').toBeGreaterThanOrEqual(2)
  const last = designerRuns[designerRuns.length - 1]!
  const view = await api<{ tree: { messages: Array<{ kind: string; text?: string }> } }>(
    `/api/tasks/${taskId}/node-runs/${last.id}/session`,
  )
  // 会话树把提示词渲染成根上的 user 消息（`sessionView.ts:36-40`）；全部拼起来
  // 而不是只取第一条，免得将来多一条 user 消息就把断言悄悄挪空。
  const prompt = view.tree.messages
    .filter((m) => m.kind === 'user')
    .map((m) => m.text ?? '')
    .join('\n')
  // 自证：这确实是**答完之后**那一轮的提示词，而不是第一轮。两个标记缺一不可——
  // Q&A 区块只在有已封存答案时才渲染，STOP 指令只在 directive='stop' 时才追加。
  expect(prompt, '取到的应是答后重跑轮的提示词').toContain('## Clarify Q&A')
  expect(prompt, 'directive=stop 应在提示词里显式解除追问模式').toContain(
    'User directive: STOP CLARIFYING',
  )
  return prompt
}

async function openClarifyPage(page: Page, nodeRunId: string): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
  await page.goto(`${daemon.baseUrl}/clarify/${encodeURIComponent(nodeRunId)}`)
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
  await expect(page.getByTestId('clarify-question-q-lang')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-answermatrix-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 answer matrix fixture\n', 'utf-8')
  initGitRepo(repoDir)
  // 每次运行独立的 stub 状态目录：clarify stub 的轮次计数是标记**文件**，缺省落
  // `/tmp/aw-e2e-clarify-state` 且比整次运行活得久（见 human-gate-optimistic-locks
  // 里记的那处假 flaky——第一遍绿、第二遍超时）。
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-answermatrix-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })
  workflowIdFilled = await createWorkflow('rfc319-answermatrix-filled')
  workflowIdRaw = await createWorkflow('rfc319-answermatrix-raw')
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('多选并入与单选「其他」文本，都要原样穿到下一轮提示词里 @nightly', async ({ page }) => {
  const { taskId, session } = await launchAndAwaitClarify(workflowIdFilled, 'rfc319-answermatrix-a')
  await openClarifyPage(page, session.intermediaryNodeRunId)

  // 单选题 q-db：不点 Postgres / SQLite，改点「其他」行并打字。
  const qDb = page.getByTestId('clarify-question-q-db')
  await qDb.getByTestId('clarify-custom-radio').check()
  await qDb.getByTestId('clarify-custom-textarea').fill(CUSTOM_SINGLE)

  // 多选题 q-lang：两个都勾上，**再**额外补一段自定义说明（多选的自定义行与
  // 候选项不互斥——这正是与单选不同的那条支路）。
  const qLang = page.getByTestId('clarify-question-q-lang')
  await qLang.locator('input[data-option-idx="0"]').check()
  await qLang.locator('input[data-option-idx="1"]').check()
  await qLang.getByTestId('clarify-custom-checkbox').check()
  await qLang.getByTestId('clarify-custom-textarea').fill(CUSTOM_MULTI)
  // 勾完两项后界面必须**两项同时**处于选中态；只剩一个就是「覆盖而非并入」。
  await expect(qLang.locator('input[data-option-idx="0"]')).toBeChecked()
  await expect(qLang.locator('input[data-option-idx="1"]')).toBeChecked()

  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()

  const prompt = await finalDesignerPrompt(taskId)
  // 多选：两个候选都在，且按 option 顺序（TypeScript=0, Python=1），外加补充说明。
  expect(prompt).toContain(
    `User selected: "TypeScript", "Python" with additional note: "${CUSTOM_MULTI}"`,
  )
  // 单选走「自定义」那一支：既要有自定义句式，也**不能**冒出一个并未选中的候选项。
  expect(prompt).toContain(`User chose custom answer: "${CUSTOM_SINGLE}"`)
  expect(prompt).not.toContain('User chose: "Postgres"')
  expect(prompt).not.toContain('User chose: "SQLite"')
  // 两题都答了，就不该出现「没答」。
  expect(prompt).not.toContain('User did not answer this question.')
})

test('空答如实上报、越界 index 退化成没答、客户端伪造的标签一律不算数 @nightly', async ({
  page,
}) => {
  const { taskId, session } = await launchAndAwaitClarify(workflowIdRaw, 'rfc319-answermatrix-b')
  // 这一段的语义全在服务端（标签重算 / 越界过滤 / 空答放行），所以直接打端点：
  // 界面根本没有「伪造标签」这个入口，走 UI 反而测不到那道门。
  const res = await fetch(
    `${daemon.baseUrl}/api/clarify/${session.intermediaryNodeRunId}/answers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [
          {
            // 越界 index（题目只有 2 个选项）+ 伪造标签：两者都必须被丢掉，
            // 结果等价于「这题没答」。注意这不是 4xx——契约是静默归一化。
            questionId: 'q-db',
            selectedOptionIndices: [7],
            selectedOptionLabels: [INJECTED_LABEL],
            customText: '',
          },
          {
            // 什么都没选，只塞了一个伪造标签。
            questionId: 'q-lang',
            selectedOptionIndices: [],
            selectedOptionLabels: [INJECTED_LABEL],
            customText: '',
          },
        ],
        ifMatchIteration: session.iteration,
        directive: 'stop',
      }),
    },
  )
  expect(res.status, `空答 + 越界 index 应被接受并归一化，而不是报错：${await res.text()}`).toBe(
    200,
  )

  const prompt = await finalDesignerPrompt(taskId)
  // 两题都退化成「没答」，且是**逐题**如实上报，不是把题目整个吞掉。
  // 客户端送来的标签一个字节都不该进提示词（这是最尖的那条，先断言）。
  expect(prompt).not.toContain(INJECTED_LABEL)
  const notAnswered = prompt.split('User did not answer this question.').length - 1
  expect(notAnswered, '两道题都该各自出现一次「没答」').toBe(2)
  expect(prompt).toContain('- Q: Which database should we use?')
  expect(prompt).toContain('- Q: Pick languages')
  // 也不该出现任何「选中了某项」的句式——越界 index 不许被当成选中。
  expect(prompt).not.toContain('User selected:')
  expect(prompt).not.toContain('User chose')

  // 界面侧的收尾自证：这一轮确实已封存（不是卡在等人上），任务已收工。
  await openClarifyPage(page, session.intermediaryNodeRunId)
  await expect(page.getByTestId('clarify-submit-continue')).toBeDisabled()
})
