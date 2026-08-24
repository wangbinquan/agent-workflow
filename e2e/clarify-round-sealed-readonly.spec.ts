// RFC-319 B40 —— HUMAN-17：轮次被系统封存之后的只读态与**原因说明**。
//
// 澄清页是**多人同时看着的一屏**：任务停在等人回答上，任务成员各自打开它、各自
// 在打字。此时任务在别处走到终态（有人点了取消 / 任务跑完），那些还开着的页面上
// 不会有任何东西自己变——除非服务端封了轮次、页面据此转成只读并说明原因。
//
// 这条链上的失效全是静默的：
//
//   * 封存这一步**没跑**：轮次永远停在「待回答」，收件箱与角标里挂着一条死任务的
//     待办，谁点进去回答都是白费——2026-07-16 的 UX 审计（§1 R8）逐字记着这个形态：
//     「answering was pointless (or worse, the answer committed and then errored)」；
//   * 封了、页面却仍是**一张裸的只读表单**：RFC-202 T6 点名的正是这个——footer 还在
//     说「草稿已保存（可以安全关闭标签页）」，人以为自己的答案在等着被处理；
//   * 封了、也只读了，但**不说为什么**：人只看到「不能答了」，分不出「任务结束了」
//     与「工作组把反问撤了」——两者的后续动作完全不同。
//
// 还有一条口径必须锁死：原因取的是**转移发生那一刻**记下的 `sealedCause`
// （park 载体 node_run 的 `errorMessage`），**不是**任务此刻的可变状态。按当前状态
// 反推会把历史说错——一个取消后又被重试的任务，会把它那轮历史反问重新标成
// 「工作组自主撤销」。这条判据在 `services/clarify/rounds.ts:304-311` 与
// `routes/clarify.detail.tsx:885-889` 两处各写了一遍注释，说明它被踩过。
//
// 另外，封存的钩子是在 **daemon 装配处**接线的（`cli/start.ts:1013`
// `sealOpenHumanGatesForTask(hookDb, taskId, 'task-' + to)`），`services/lifecycle.ts`
// 因为循环依赖拿不到它。也就是说「这个钩子到底有没有被挂上」只有跑真 daemon 才验得出来
// ——正是 system-mock e2e 的职责。
//
// 判据取自源码单一事实源：
//   services/terminalSweep.ts:76-110   self 轮 → 'canceled'，park run → canceled + errorMessage=cause
//   cli/start.ts:1013                  cause = `task-${to}`（done / canceled）
//   services/clarify/rounds.ts:312-320 canceled/abandoned 轮才带 sealedCause
//   services/clarify/autoDispatch.ts:550-555  非 awaiting_human 的轮次作答 ⇒ 409 clarify-already-answered
//   routes/clarify.detail.tsx:660-666  readonly ⇒ draftStatus='sealed'，footer 改口
//   routes/clarify.detail.tsx:883-897  terminatedAs 非空 ⇒ 按 sealedCause 选文案

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
let taskId: string
let nodeRunId: string
let roundIteration: number

/** 三条文案必须**互不相同**，否则「按任务当前状态选文案」也能让断言通过。 */
const COPY_TASK_TERMINAL =
  'The owning task has ended; this clarify round is sealed and needs no answer.'
const COPY_NO_HUMAN = 'The workgroup no longer has a human member'
const COPY_GENERIC = 'This round is sealed; no answer is needed.'

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

async function openClarifyPage(page: Page): Promise<void> {
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
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-sealed-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 sealed-round fixture\n', 'utf-8')
  initGitRepo(repoDir)
  // 每次运行独立的 stub 状态目录：clarify stub 的轮次计数是标记**文件**，缺省落
  // `/tmp/aw-e2e-clarify-state` 且比整次运行活得久。
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-sealed-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-sealed-designer',
      description: 'RFC-319 sealed-round fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-sealed-wf',
      description: 'RFC-319 sealed-round fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-sealed-designer',
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
      name: 'rfc319-sealed-task',
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
  nodeRunId = session!.intermediaryNodeRunId
  roundIteration = session!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('任务走到终态时，开着的那一轮反问必须被封存并说明原因，而不是继续挂着等人', async ({
  page,
}) => {
  // ── 正向对照：封存之前，这一屏确实是能答的 ──────────────────────────────
  // 少了这一段，「页面永远只读」也能让下面每一条断言成立。
  await openClarifyPage(page)
  await expect(page.getByTestId('clarify-submit-continue')).toBeEnabled()
  await expect(page.locator('.clarify-round-sealed')).toHaveCount(0)
  await expect(page.getByTestId('clarify-draft-indicator')).not.toHaveAttribute(
    'data-draft-status',
    'sealed',
  )

  // ── 任务在别处走到终态 ──────────────────────────────────────────────────
  const cancelRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(cancelRes.ok, `cancel: ${cancelRes.status} ${await cancelRes.text()}`).toBe(true)

  // ── 服务端：轮次被封存，且记下的是**转移那一刻**的原因 ────────────────────
  interface Detail {
    status: string
    terminatedAs: string | null
    sealedCause?: string
  }
  await expect
    .poll(async () => (await api<Detail>(`/api/clarify/${nodeRunId}`)).status, { timeout: 60_000 })
    .toBe('canceled')
  const detail = await api<Detail>(`/api/clarify/${nodeRunId}`)
  expect(
    detail.terminatedAs,
    'terminatedAs 是终态判别式，界面据它决定要不要出原因横幅',
  ).not.toBeNull()
  // 逐字断言而不是「非空即可」：'task-done' 与 'task-canceled' 走同一条文案分支，
  // 但把 'wg-clarify-disabled' 写成 'task-canceled' 会让界面把撤销说成任务结束。
  expect(
    detail.sealedCause,
    '原因取自 park 载体 run 的 errorMessage（cli/start.ts:1013 传入的 `task-${to}`）',
  ).toBe('task-canceled')

  // ── 服务端：这时候再作答必须被**拒绝**，不能收下 ──────────────────────────
  // 「收下但什么也不做」与「拒绝」在界面上完全同形（都是提交后没反应），
  // 但前者会让人以为自己的答案进了系统。
  const lateAnswer = await fetch(`${daemon.baseUrl}/api/clarify/${nodeRunId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-db',
          selectedOptionIndices: [0],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
      ifMatchIteration: roundIteration,
      directive: 'stop',
    }),
  })
  expect(lateAnswer.status, '封存后的轮次不接受作答').toBe(409)
  // 这里锁的是**当前实际行为**：外层那道 `round.status !== 'awaiting_human'` 守卫先命中，
  // 于是被取消的轮次拿到的是 `clarify-already-answered`。它背后还有一道更深的
  // `clarify-round-terminal`（`sealRoundQuestions`）——实测把外层放开后仍然拦得住，
  // 所以「能不能答」是双保险。但外层那个**码名说错了事**：没有人答过，是任务结束了；
  // 界面若照码出文案，会把「任务被取消」讲成「别人已经答过」。已记进
  // `docs/audit-backlog.md`；哪天有人把它改成 `clarify-round-terminal`，这条会红，
  // 那正是提醒他顺手看一眼这段注释。
  expect((JSON.parse(await lateAnswer.text()) as { code?: string }).code).toBe(
    'clarify-already-answered',
  )

  // ── 界面：只读 + 说明原因，且 footer 不再声称草稿安全 ──────────────────────
  await page.reload()
  await expect(page.getByTestId('clarify-question-q-db')).toBeVisible()
  await expect(page.getByTestId('clarify-submit-continue')).toBeDisabled()
  await expect(page.getByTestId('clarify-submit-stop')).toBeDisabled()
  // RFC-202 T6 点名的回归：只读表单的 footer 还在说「草稿已保存，可以安全关闭标签页」。
  const indicator = page.getByTestId('clarify-draft-indicator')
  await expect(indicator).toHaveAttribute('data-draft-status', 'sealed')
  await expect(indicator).not.toContainText('Draft saved')
  // 原因横幅：必须是**任务终态**那一条，不是通用兜底、更不是工作组撤销。
  const sealed = page.locator('.clarify-round-sealed')
  await expect(sealed).toHaveCount(1)
  await expect(sealed).toContainText(COPY_TASK_TERMINAL)
  await expect(sealed).not.toContainText(COPY_NO_HUMAN)
  await expect(sealed).not.toContainText(COPY_GENERIC)
})
