// RFC-319 B59 —— HUMAN-17b：工作组把最后一个人撤走之后，那条还开着的反问怎么收场。
//
// 场景是真会发生的那种：一个工作组任务停在「等人回答」上，管理员这时把花名册里最后
// 一个人类成员移出去——可能是把这个组改成全自动跑，也可能只是那个人不再参与了。这一
// 步之后，那条反问**不可能再有人回答**：产品自己也这么认（`resolveWgClarifyAllowed`
// 在没有人类成员时恒 false，`services/workgroup/lifecycle.ts:471`），连邀请 agent 提问
// 都不再发出。
//
// 于是三件事必须同时发生，缺一件都是静默故障：
//
//   * **轮次得被撤掉**。不撤的话任务永远停在等人回答上，而「人」这个角色已经不存在了
//     ——RFC-181 A2 的注释逐字写着这条开关存在的理由：不撤销，开关对一个**已经在**
//     ping-pong 提问的任务就是个空操作（`lifecycle.ts:275-279`）。
//   * **打开着那一屏的人得知道为什么**。撤销和「任务结束了」在界面上完全同形（都是
//     突然不能答了），但后续动作完全不同：前者要去找管理员问花名册，后者去看任务结果。
//     RFC-202 T6 点名的回归正是「只读了但不说为什么」，以及更糟的「footer 还在说草稿
//     已安全保存」——人会以为自己打的答案在排队等处理。
//   * **迟到的答案得被拒绝**。「收下但什么也不做」与「拒绝」在界面上同形，前者会让人
//     以为答案进了系统。
//
// 口径同 B40（`clarify-round-sealed-readonly.spec.ts`）：原因取的是**转移那一刻**记下的
// `sealedCause`，不是任务此刻的可变状态。B40 锁的是 `task-canceled` 那一支，这条锁
// `wg-clarify-disabled`——两支走**不同文案**，只有两条都在，才挡得住「任取一条文案糊
// 上去」。
//
// 判据取自源码单一事实源：
//   services/workgroup/configActions.ts:457-461  最后一个人类成员被移除 ⇒ 触发撤销
//   services/workgroup/lifecycle.ts:355-385      round → canceled、park run → canceled + errorMessage='wg-clarify-disabled'
//   services/clarify/rounds.ts:305-321           canceled/abandoned 轮才带 sealedCause，逐字取自 park run
//   services/workgroup/lifecycle.ts:471          没有人类成员 ⇒ 不再邀请提问
//   routes/clarify.detail.tsx:886-895            按 sealedCause 选文案（wg-clarify-disabled ⇒ roundDismissedNoHuman）

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  seedShowcase,
  SHOWCASE_TASKS,
  type ShowcaseSeedResult,
} from '../examples/workgroups/showcase/seed'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let daemon: DaemonHandle
let stateDir: string
let showcase: ShowcaseSeedResult
let taskId: string
let nodeRunId: string
let roundIteration: number

/** 三条文案必须互不相同，否则「随便挑一条挂上」也能让断言过。 */
const COPY_NO_HUMAN = 'The workgroup no longer has a human member'
const COPY_TASK_TERMINAL = 'The owning task has ended'
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
  return body === '' ? (null as T) : (JSON.parse(body) as T)
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
  await expect(page.getByTestId('clarify-question-q-release-strategy')).toBeVisible()
}

interface RoomMember {
  id: string
  memberType: string
  displayName: string
}

test.beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-wg-dismiss-state-'))
  daemon = await startDaemon({
    stubMode: 'workgroup-matrix',
    extraEnv: { WORKGROUP_MATRIX_STATE_DIR: stateDir },
    configOverrides: {
      defaultRuntime: 'opencode',
      defaultNodeRetries: 1,
      sessionRestartBudget: 0,
      defaultPerNodeTimeoutMs: 10_000,
      maxConcurrentNodes: 6,
    },
  })
  showcase = await seedShowcase({
    baseUrl: daemon.baseUrl,
    token: daemon.token,
    runtime: 'opencode',
  })

  const group = showcase.workgroups.leaderWorker
  const spec = SHOWCASE_TASKS.leaderWorker
  const task = await api<{ id: string }>(`/api/workgroups/${group.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      name: spec.name,
      goal: spec.goal,
      scratch: true,
      expectedWorkgroupId: group.id,
      expectedWorkgroupVersion: group.version,
    }),
  })
  taskId = task.id

  interface Session {
    intermediaryNodeRunId: string
    askingNodeId: string
    iteration: number
  }
  let session: Session | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<Session[]>(
          `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
        )
        session = rows.find((row) => row.askingNodeId === '__wg_leader__') ?? null
        return session !== null
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  nodeRunId = session!.intermediaryNodeRunId
  roundIteration = session!.iteration
})

test.afterAll(async () => {
  await daemon?.stop()
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true })
})

test('最后一个人类成员被移出后：这一轮反问必须被撤销、页面要说清是被撤了、迟到的答案要被拒', async ({
  page,
}) => {
  // ── 正向对照：撤销之前这一屏确实能答 ────────────────────────────────────
  // 少了这一段，「这页永远只读」也能让下面每条断言成立。
  await openClarifyPage(page)
  await expect(page.getByTestId('clarify-submit-continue')).toBeEnabled()
  await expect(page.locator('.clarify-round-sealed')).toHaveCount(0)

  // ── 管理员把花名册里最后一个人类成员移出去 ──────────────────────────────
  const room = await api<{ config: { members: RoomMember[] } }>(
    `/api/workgroup-tasks/${taskId}/room`,
  )
  const humans = room.config.members.filter((m) => m.memberType === 'human')
  expect(humans.length, 'showcase 的 leader-worker 组恰好只有一个人类成员（owner）').toBe(1)
  const changed = await api<{ changes: string[] }>(`/api/workgroup-tasks/${taskId}/config`, {
    method: 'PUT',
    body: JSON.stringify({ removeMemberIds: [humans[0]!.id] }),
  })
  // 逐字断言这条 change：它是「撤销确实跑了」在 API 面上的唯一回执。少了它，
  // 下面的 canceled 也可能是别的路径（终态清扫）造成的，文案分支就白锁了。
  expect(
    changed.changes.join(' | '),
    '移除最后一个人类成员必须顺带撤掉在飞的反问（RFC-207 §3.4 承接 RFC-181 A2）',
  ).toContain('dismissed 1 open clarify session(s) (no human member left)')

  // ── 服务端：轮次被撤，原因是**撤销**而不是任务终态 ────────────────────────
  interface Detail {
    status: string
    terminatedAs: string | null
    sealedCause?: string
  }
  await expect
    .poll(async () => (await api<Detail>(`/api/clarify/${nodeRunId}`)).status, { timeout: 30_000 })
    .toBe('canceled')
  const detail = await api<Detail>(`/api/clarify/${nodeRunId}`)
  expect(detail.terminatedAs, 'terminatedAs 非空才会渲染原因横幅').not.toBeNull()
  expect(
    detail.sealedCause,
    "逐字锁 'wg-clarify-disabled'：写成 'task-canceled' 会让界面把撤销讲成任务结束",
  ).toBe('wg-clarify-disabled')

  // ── 收件箱里不能再挂着这条死待办 ────────────────────────────────────────
  const pending = await api<Array<{ intermediaryNodeRunId: string }>>(
    `/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
  )
  expect(
    pending.map((row) => row.intermediaryNodeRunId),
    '撤掉的轮次若还留在待答列表里，角标与收件箱会一直催人去回答一条没人能答的问题',
  ).not.toContain(nodeRunId)

  // ── 迟到的答案必须被拒绝 ───────────────────────────────────────────────
  const lateAnswer = await fetch(`${daemon.baseUrl}/api/clarify/${nodeRunId}/answers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      answers: [
        {
          questionId: 'q-release-strategy',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['blue-green'],
          customText: '',
        },
      ],
      ifMatchIteration: roundIteration,
      directive: 'stop',
    }),
  })
  expect(lateAnswer.status, '被撤销的轮次不接受作答').toBe(409)

  // ── 界面：只读 + 说清是**被撤销**，且 footer 不再声称草稿安全 ──────────────
  await page.reload()
  await expect(page.getByTestId('clarify-question-q-release-strategy')).toBeVisible()
  await expect(page.getByTestId('clarify-submit-continue')).toBeDisabled()
  await expect(page.getByTestId('clarify-submit-stop')).toBeDisabled()
  const indicator = page.getByTestId('clarify-draft-indicator')
  await expect(indicator).toHaveAttribute('data-draft-status', 'sealed')
  await expect(indicator).not.toContainText('Draft saved')
  const sealed = page.locator('.clarify-round-sealed')
  await expect(sealed).toHaveCount(1)
  await expect(sealed).toContainText(COPY_NO_HUMAN)
  await expect(sealed).not.toContainText(COPY_TASK_TERMINAL)
  await expect(sealed).not.toContainText(COPY_GENERIC)
})

test('撤销之后任务不能继续停在「等人回答」上——那正是这个开关存在的理由', async () => {
  // RFC-181 A2 的原话：不撤销，开关对一个**已经在**提问的任务就是空操作。撤销之后
  // 引擎必须被踢醒、任务离开 awaiting_human。
  //
  // 覆盖边界（如实记）：本 fixture 的 leader stub **只会提问**——它的兜底分支恒发
  // `<workflow-clarify>`（`packages/system-mocks/src/runtime/mode-workgroup-matrix.ts:223-232`），
  // 而没有人类成员时提问信封会被拒（`lifecycle.ts:254`）。所以这里能断言的是「离开
  // 等人回答这个态」，不是「继续把活干完」；后者需要一个会在无人可问时改走正常出参的
  // stub 分支，改 stub 会动到 RFC-254 的 shell↔TS 差分基线，留给后续批次。
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 120_000,
    })
    .not.toBe('awaiting_human')
})
