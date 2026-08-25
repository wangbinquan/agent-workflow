// RFC-319 B58 —— HUMAN-05：一个 designer 被**多个**跨节点反问指向时的「等齐」。
//
// 两个提问者各自反问同一个 designer，用户先答完其中一家。此时如果框架立刻让 designer
// 重跑，后果有两层，都不报错：
//
//   * designer 拿着**半份**反馈去改稿——另一家的意见还没到，它改出来的东西可能与之直接
//     冲突；等第二家答完又触发一次重跑，前一次的产出连同它烧掉的模型调用一起作废；
//   * 先答完的那个人**看不到任何提示**，他以为「我答完了，可以走了」，而实际上这一轮
//     要等另一家。真正该发生的是：告诉他还差谁，并把链接给他。
//
// 所以这条用例的判据是三段：答完第一家之后 **designer 不许重跑**、页面上出现**点名到
// 具体节点**的等待横幅、答完第二家之后 designer 才跑起来。
//
// 判据取自源码单一事实源：
//   services/clarify/service.ts:634-641   ready ⟺ 每个兄弟 cross-clarify 的本轮都已结清
//   services/clarify/service.ts:655-660    没有兄弟的 handler 立即 ready（reassign 增派的情形）
//   services/clarify/service.ts:696-714    未结清的兄弟进 pendingCrossClarifyNodeIds
//   routes/clarify.detail.tsx:539-551      提交响应 outcome='designer-waiting' ⇒ 留在页面并弹横幅
//   routes/clarify.detail.tsx:850-870      横幅逐条列出还差哪些节点（带跳链）
//
// 覆盖边界（如实记）：本条用 `stop` 作答，而 `stop` 按契约**只算结清、不喂反馈**
// （`services/clarify/service.ts:623-645`）。于是服务端那道 readiness 栅栏在这个 fixture 下
// **不可观测**——把它整个拆掉（`evaluateDesignerRerunReadiness` 恒 ready）实测**不红**：
// 反正没有可喂的 source，designer 本来也不会重跑；而界面的等待横幅另有一条独立来源
// （`crossPeers`，即仍在等人的兄弟轮），照样渲染。
// 要打中服务端那道栅栏，得让某一家以 `continue` 作答从而真的喂出 External Feedback；
// 现有 cross-clarify stub 的问答序列（questioner 前两次追问、第三次出稿）做不到这一点，
// 而改 stub 会让 RFC-254 的 shell↔TS 差分基线失去意义。这一档留给后续批次。
// 本条实际锁住的是**用户看得见的那三段**：横幅出现、点名到具体那一家、以及两家答完之后
// 任务真的往前走（栅栏坏在「永远不放行」那一侧时，界面上什么都不会发生）。

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

interface NodeRunRow {
  id: string
  nodeId: string
  status: string
  startedAt: number | null
}
const runsOf = async (nodeId: string): Promise<NodeRunRow[]> =>
  (await api<{ runs: NodeRunRow[] }>(`/api/tasks/${taskId}/node-runs`)).runs.filter(
    (r) => r.nodeId === nodeId,
  )

interface Session {
  id: string
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  iteration: number
}
const awaitingRounds = async (): Promise<Session[]> =>
  api<Session[]>(`/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`)

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
  await expect(page.getByTestId('clarify-question-q-redis')).toBeVisible()
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-multisrc-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 multi-source fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-multisrc-state-'))
  daemon = await startDaemon({
    stubMode: 'cross-clarify',
    extraEnv: { CROSS_CLARIFY_STUB_STATE: stubState },
  })

  const mkAgent = async (name: string, port: string) =>
    (
      await api<{ id: string }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'RFC-319 multi-source cross-clarify fixture',
          outputs: [port],
          outputKinds: { [port]: 'markdown' },
          readonly: true,
          bodyMd: '',
        }),
      })
    ).id
  // agent 名必须**逐字**是 `designer` / `questioner`：cross-clarify stub 按名字分支
  // （`mode-cross-clarify.ts:60-72`），别的名字会落进 `other` 分支直接出 output，
  // 而强制追问模式会当场拒掉它（实撞：第一版用了自定义名，两个提问者全部 failed，
  // 任务以 `clarify-required-output-emitted` 收场）。
  //
  // 两个提问**节点**共用同一个 questioner agent：stub 的轮次计数按 agent 名分键，
  // 于是两个节点的首轮恰好是 count 1 / 2，都 ≤2 ⇒ 都发起追问，正是本条要的多源局面。
  // 这样就不必去改 stub —— 改它会让 RFC-254 的 shell↔TS 差分基线失去意义。
  const designer = await mkAgent('designer', 'design')
  const questioner = await mkAgent('questioner', 'main')

  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-multisrc-wf',
      description: 'RFC-319 multi-source cross-clarify fixture',
      definition: {
        $schema_version: 4,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: designer,
            agentName: 'designer',
            promptTemplate: 'Design for {{topic}}.',
            position: { x: 220, y: 0 },
          },
          {
            id: 'questioner_a',
            kind: 'agent-single',
            agentId: questioner,
            agentName: 'questioner',
            promptTemplate: 'Review A {{design}}.',
            position: { x: 460, y: -140 },
          },
          {
            id: 'questioner_b',
            kind: 'agent-single',
            agentId: questioner,
            agentName: 'questioner',
            promptTemplate: 'Review B {{design}}.',
            position: { x: 460, y: 180 },
          },
          {
            id: 'cross_a',
            kind: 'clarify-cross-agent',
            title: 'Cross clarify A',
            position: { x: 700, y: -140 },
          },
          {
            id: 'cross_b',
            kind: 'clarify-cross-agent',
            title: 'Cross clarify B',
            position: { x: 700, y: 180 },
          },
        ],
        edges: [
          {
            id: 'e_in_designer',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'designer', portName: 'topic' },
          },
          {
            id: 'e_designer_qa',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'questioner_a', portName: 'design' },
          },
          {
            id: 'e_designer_qb',
            source: { nodeId: 'designer', portName: 'design' },
            target: { nodeId: 'questioner_b', portName: 'design' },
          },
          {
            id: 'e_qa_cross',
            source: { nodeId: 'questioner_a', portName: '__clarify__' },
            target: { nodeId: 'cross_a', portName: 'questions' },
          },
          {
            id: 'e_cross_qa',
            source: { nodeId: 'cross_a', portName: 'to_questioner' },
            target: { nodeId: 'questioner_a', portName: '__clarify_response__' },
          },
          {
            id: 'e_cross_a_designer',
            source: { nodeId: 'cross_a', portName: 'to_designer' },
            target: { nodeId: 'designer', portName: '__external_feedback__' },
          },
          {
            id: 'e_qb_cross',
            source: { nodeId: 'questioner_b', portName: '__clarify__' },
            target: { nodeId: 'cross_b', portName: 'questions' },
          },
          {
            id: 'e_cross_qb',
            source: { nodeId: 'cross_b', portName: 'to_questioner' },
            target: { nodeId: 'questioner_b', portName: '__clarify_response__' },
          },
          {
            id: 'e_cross_b_designer',
            source: { nodeId: 'cross_b', portName: 'to_designer' },
            target: { nodeId: 'designer', portName: '__external_feedback__' },
          },
        ],
      },
    }),
  })
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-multisrc-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  // 两家都反问上来才算 fixture 就绪。
  await expect.poll(async () => (await awaitingRounds()).length, { timeout: 180_000 }).toBe(2)
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('答完一家不算数：designer 不许重跑，页面要点名还差谁 @nightly', async ({ page }) => {
  const rounds = await awaitingRounds()
  const a = rounds.find((r) => r.intermediaryNodeId === 'cross_a')!
  const designerRunsBefore = (await runsOf('designer')).length

  await openClarify(page, a.intermediaryNodeRunId)
  await page.getByTestId('clarify-question-q-redis').locator('input[data-option-idx="0"]').check()
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()

  // ① 回到这一屏，必须告诉他还差谁——先答完的那个人否则会以为自己已经交差了。
  //
  // 为什么是「回到这一屏」而不是「提交后原地断言」：**提交完那一瞬间的落点不稳定**。
  // 2026-08-25 CI（macOS shard 1/2）实红一次，trace 里的页面快照是**任务详情页**——
  // 也就是说那次提交走了跳转分支；本机同一条用例每次都留在原地。差别出在提交响应是不是
  // `designer-waiting`（`clarify.detail.tsx:481-487`：是则把 pending 存进 crossWaiting
  // 留在原地，否则沿用旧的「跳回任务详情」）。落点本身算不算契约、该不该统一，已记进
  // `docs/audit-backlog.md` 交给该域的人判；**这条用例锁的是那句稳定的承诺**：
  // 这一屏必须点名还差哪一家。回访时数据来自 peers 查询（源码注释也写着这条通路是
  // 「navigation back to this page 时由 list refetch 填上」），与落点无关。
  // 先等服务端把这一轮记成已答，再回访：否则「提交后的跳转」可能在我 goto 之后才发生，
  // 把刚打开的页面又顶掉——那就成了新的竞态。
  await expect
    .poll(async () => (await awaitingRounds()).map((r) => r.intermediaryNodeId), {
      timeout: 30_000,
    })
    .toEqual(['cross_b'])
  await openClarify(page, a.intermediaryNodeRunId)
  await expect(
    page.getByTestId('cross-clarify-multi-source-banner'),
    '答完一家之后要告诉他还差谁',
  ).toBeVisible({ timeout: 30_000 })
  // 横幅要**点到具体那一家**：只说「还有别人」而不说是谁，等于让人去猜。
  await expect(
    page.getByTestId('cross-clarify-multi-source-link-cross_b'),
    '横幅要给出还没答那一家的跳链',
  ).toBeVisible()
  await expect(
    page.getByTestId('cross-clarify-multi-source-link-cross_a'),
    '已经答完的这一家不该还挂在待答清单里',
  ).toHaveCount(0)

  // ② designer 不许重跑：半份反馈改出来的稿子可能与另一家的意见直接冲突，
  //    而第二家答完还会再触发一次，前一次连同它烧掉的模型调用一起作废。
  await page.waitForTimeout(3_000)
  expect((await runsOf('designer')).length, '只答完一家就重跑 designer ⇒ 它拿到的是半份反馈').toBe(
    designerRunsBefore,
  )
  expect((await awaitingRounds()).map((r) => r.intermediaryNodeId)).toEqual(['cross_b'])
})

test('两家都答完之后：栅栏放行，任务必须往前走而不是无声卡死 @nightly', async ({ page }) => {
  const b = (await awaitingRounds())[0]!
  expect(b.intermediaryNodeId, '此刻应当只剩 B 那一家').toBe('cross_b')

  await openClarify(page, b.intermediaryNodeRunId)
  await page.getByTestId('clarify-question-q-redis').locator('input[data-option-idx="0"]').check()
  await page.getByTestId('clarify-submit-stop').click()
  await page.getByTestId('clarify-stop-confirm').click()

  // 栅栏放行：不再有待答的轮次，且**这一次不再出多源等待横幅**——
  // 少了这条对照，「横幅永远都在」也能让上一条成立。
  await expect.poll(async () => (await awaitingRounds()).length, { timeout: 60_000 }).toBe(0)
  await expect(page.getByTestId('cross-clarify-multi-source-banner')).toHaveCount(0)

  // 任务必须离开等人态。栅栏坏在「永远不放行」那一侧时，界面上什么都不会发生：
  // 两个人都答完了、看板干干净净，而任务就那么停着——最难被发现的一种卡死。
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 180_000,
    })
    .not.toBe('awaiting_human')

  // 顺带锁住一条**容易被误读**的契约：两家都以「停止追问」作答时，designer
  // **不会**因此重跑。`stop` 只算「已结清」，不进 External Feedback
  // （`services/clarify/service.ts:623-645` 逐字写着）。把它写成「答完就重跑」
  // 会让人以为自己的最后一句话被 agent 读到了，而实际上没有。
  expect(
    (await runsOf('designer')).length,
    '两家都 stop ⇒ 没有可喂的反馈 ⇒ designer 不该重跑',
  ).toBe(1)
})
