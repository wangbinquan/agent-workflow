// RFC-319 B51 —— HUMAN-27 / HUMAN-07：两个「停止反问」的闸。
//
// 「停止反问」是一条**单向门**：它把这个节点从强制追问模式里放出来，下一轮它就不再
// 提问、直接出稿。误按的代价是把「本来还能问清楚」的机会关掉，而后果要到产出错了
// 才看得见——中间没有任何报错。所以两个入口各有一道保护，本条各锁一道：
//
//   * **画布上的开关（HUMAN-27）**：按 (task, 提问节点) 记一个 override。
//     它的守卫是「目标必须是快照里的**提问 agent 节点**」——挂到 clarify / io 节点上
//     既没有意义，也会让人以为自己关掉了某个东西而其实什么都没发生。
//   * **澄清页的「提交并停止澄清」（HUMAN-07）**：必须先弹二次确认。少了它，一次误点
//     就把这一轮的追问机会用掉了，且不可撤销。
//
// 画布开关那条还锁**行为**而不只是接口：开关置 stop 之后，即使用户在澄清页按的是
// 「继续追问」，下一轮提示词里也**不该**再出现追问协议块（`<workflow-clarify ...>`
// 的格式示例）。这正是 `resolveEffectiveClarifyChannel` 里 `nodeStopOverride` 那一项的
// 全部意义；只断言接口 200 的话，这条覆盖是空的。
//
// 判据取自源码单一事实源：
//   routes/taskClarifyDirective.ts:65-118   set：成员门 + 取值校验 + 提问节点校验
//   routes/taskClarifyDirective.ts:53-62    list：{ nodeId: directive } 映射
//   services/scheduler.ts:6297-6301         nodeStopOverride 强制关掉追问（self 与 cross 皆然）
//   shared/prompt.ts:981-984                追问协议块里的 `<workflow-clarify nonce=...>` 格式示例
//   routes/clarify.detail.tsx:1085-1120     停止澄清的二次确认弹窗与两个按钮

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

interface Fixture {
  taskId: string
  nodeRunId: string
  iteration: number
}
let toggle: Fixture
let modal: Fixture

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

async function raw(
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

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  startedAt: number | null
}
const designerRuns = async (taskId: string): Promise<NodeRunRow[]> =>
  (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)).runs.filter(
    (r) => r.nodeId === 'designer',
  )

/** 等答完之后**新起**的那一轮 designer 跑完，取它的提示词（按 id 认人，见 B45）。 */
async function awaitRerunPrompt(taskId: string, before: ReadonlySet<string>): Promise<string> {
  let fresh: NodeRunRow | undefined
  await expect
    .poll(
      async () => {
        fresh = (await designerRuns(taskId)).find(
          (r) => !before.has(r.id) && r.status === 'done' && r.startedAt !== null,
        )
        return fresh !== undefined
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  const view = await api<{ tree: { messages: Array<{ kind: string; text?: string }> } }>(
    `/api/tasks/${taskId}/node-runs/${fresh!.id}/session`,
  )
  return view.tree.messages
    .filter((m) => m.kind === 'user')
    .map((m) => m.text ?? '')
    .join('\n')
}

async function createWorkflow(slug: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-stopctl-${slug}`,
      description: 'RFC-319 stop-clarifying controls fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-stopctl-${slug}-wf`,
      description: 'RFC-319 stop-clarifying controls fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: `rfc319-stopctl-${slug}`,
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

async function makeFixture(slug: string): Promise<Fixture> {
  // 每个 fixture 自建 agent：clarify stub 的轮次标记按 agent 名分键（见 B49 实撞）。
  const workflowId = await createWorkflow(slug)
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-stopctl-${slug}-task`,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: `${slug} order_status enum` },
    }),
  })
  interface Session {
    intermediaryNodeRunId: string
    iteration: number
  }
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
  return {
    taskId: task.id,
    nodeRunId: session!.intermediaryNodeRunId,
    iteration: session!.iteration,
  }
}

async function openClarify(page: Page, nodeRunId: string): Promise<void> {
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
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-stopctl-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 stop controls fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-stopctl-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })
  toggle = await makeFixture('toggle')
  modal = await makeFixture('modal')
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('画布开关只认「提问 agent 节点」：挂到 clarify / io 节点上必须被拒，且不留下任何记录', async () => {
  const path = (nodeId: string) =>
    `/api/tasks/${toggle.taskId}/nodes/${encodeURIComponent(nodeId)}/clarify-directive`
  const before = await api<Record<string, string>>(`/api/tasks/${toggle.taskId}/clarify-directives`)

  for (const nodeId of ['clarify_1', 'in_1', 'no_such_node']) {
    const res = await raw(path(nodeId), { directive: 'stop' })
    expect(res.status, `挂到 ${nodeId} 上必须被拒`).toBe(422)
    expect(res.code).toBe('not-asking-node')
  }
  // 取值本身也要校验——落一个非法值等于让调度端读到一个它不认识的开关。
  const badValue = await raw(path('designer'), { directive: 'maybe' })
  expect(badValue.status).toBe(422)
  expect(badValue.code).toBe('clarify-directive-invalid')

  // 被拒之后一条记录都不该留下：留下了的话，人以为自己关掉了某个东西，
  // 而调度端读到的是另一回事。
  expect(
    await api<Record<string, string>>(`/api/tasks/${toggle.taskId}/clarify-directives`),
    '被拒的设置不该改动指令表',
  ).toEqual(before)

  // 正向对照：挂在真正的提问节点上要能落下并读得回来。
  const ok = await raw(path('designer'), { directive: 'stop' })
  expect(ok.status, `合法设置应当通过：${ok.code}`).toBe(200)
  const after = await api<Record<string, string>>(`/api/tasks/${toggle.taskId}/clarify-directives`)
  expect(after['designer'], '设置完要读得回来').toBe('stop')
})

test('开关一旦置 stop：即使用户按的是「继续追问」，下一轮也不再带追问协议块', async () => {
  // 上一条已经把 designer 置成了 stop。这里用户在澄清页按的是「继续追问」——
  // 两者冲突时，画布开关赢（`nodeStopOverride` 强制关掉追问）。
  // 只断言接口 200 的话，这条覆盖是空的：真正的用户后果是「下一轮还会不会问」。
  const before = new Set((await designerRuns(toggle.taskId)).map((r) => r.id))
  const submitted = await raw(`/api/clarify/${toggle.nodeRunId}/answers`, {
    answers: [
      { questionId: 'q-db', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      {
        questionId: 'q-lang',
        selectedOptionIndices: [0],
        selectedOptionLabels: [],
        customText: '',
      },
    ],
    ifMatchIteration: toggle.iteration,
    directive: 'continue',
  })
  expect(submitted.status, `submit: ${submitted.code}`).toBe(200)

  const prompt = await awaitRerunPrompt(toggle.taskId, before)
  expect(prompt, '答案本身仍要进提示词（这一轮不是白跑的）').toContain('## Clarify Q&A')
  // 判据要取协议块**独有**的形态：裸的 `<workflow-clarify>` 这个子串也出现在「释放」
  // 那句话里（「do NOT emit another <workflow-clarify> envelope」），拿它做否定断言
  // 是永远不会红的——协议块的格式示例带的是本轮 nonce（`shared/prompt.ts:983`）。
  expect(
    prompt,
    '画布开关置 stop 之后，下一轮不该再带追问协议块——否则那个开关等于没接上',
  ).not.toContain('<workflow-clarify nonce="')
  // 变异实测记录（说明这条断言的预言力落在哪儿）：
  //   * 打掉 `resolveEffectiveClarifyChannel` 的 `nodeStopOverride` 一项 ⇒ **不红**。
  //     那两项（`contextDirective` 与 `nodeStopOverride`）按源码注释本就是**冗余**的，
  //     单打一项另一项顶上——这是纵深防御，不是覆盖空洞。
  //   * 两项一起打掉 ⇒ 仍**不红**：STOP 那句话根本不从这条 oracle 来，
  //     而来自 `shouldInjectStopNotice` 那条独立的 trailer 路径（scheduler.ts:6354-6357）。
  //   * 打掉 trailer 路径 ⇒ **红在下面这条**。
  //   * 强行把追问通道打开 ⇒ **红在上面的等待里**（节点会继续提问、永远不 done），
  //     这正是用户看到的形态：开关按了，它还在问。
  // 正反两面都断言，才说明「是开关赢了」而不是「碰巧两边都没写」：
  expect(prompt, '画布开关赢 ⇒ 下一轮拿到的是 STOP 指令').toContain(
    'User directive: STOP CLARIFYING',
  )
  expect(prompt, '用户在澄清页按的是「继续追问」，但画布开关置 stop 时它不该生效').not.toContain(
    'User directive: KEEP CLARIFYING',
  )
})

test('澄清页的「提交并停止澄清」必须先问一句；取消掉就什么都不发', async ({ page }) => {
  const decisionCalls: string[] = []
  await page.route('**/api/clarify/*/answers', async (route) => {
    decisionCalls.push(route.request().method())
    await route.fallback()
  })

  await openClarify(page, modal.nodeRunId)
  await page.getByTestId('clarify-submit-stop').click()

  const dialog = page.getByTestId('clarify-stop-modal')
  await expect(dialog, '停止澄清是单向门，必须先问一句').toBeVisible()

  // 取消 = 什么都没发生。弹窗关了却已经提交，是这类确认闸最恶劣的坏法。
  await page.getByTestId('clarify-stop-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(decisionCalls, '取消不该产生任何提交请求').toEqual([])
  const still = await api<{ status: string }>(`/api/clarify/${modal.nodeRunId}`)
  expect(still.status, '取消之后这一轮必须原样还在').toBe('awaiting_human')

  // 确认 = 真的以 stop 提交。
  await page.getByTestId('clarify-submit-stop').click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('clarify-stop-confirm').click()
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/clarify/${modal.nodeRunId}`)).status, {
      timeout: 60_000,
    })
    .toBe('answered')
  expect(decisionCalls.length, '确认之后应当恰好发出一次提交').toBe(1)
})
