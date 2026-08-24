// RFC-319 B45 —— HUMAN-33 / HUMAN-34：评审意见的增删改，以及它们**有没有真的到 agent 手里**。
//
// 评审意见是这个产品里「人告诉 agent 该改什么」的唯一通道。迭代（iterate）之后
// agent 会重跑一遍，而它凭什么改——全靠这批意见被渲染进重跑提示词。这条链断掉的形态
// 是**完全静默**的：
//
//   * 决策返回 200、任务确实继续跑、agent 确实重跑了一遍；
//   * 只是它**没收到任何意见**，于是产出与上一版基本一样；
//   * 评审的人看到「又是这个」，再迭代一次，再一次——一个没有报错面的死循环，
//     每一轮都烧真实的模型调用。
//
// 与 B39（澄清答案穿到下一轮提示词）是同一条判据在评审侧的镜像：判据取**提示词本身**，
// 而不是「意见写进库了吗」。写进库、渲染错、或者压根没渲染，在库那一层完全同形。
//
// 三个易碎点各自锁一条：
//
//   1. **意见正文进不了提示词**：`renderCommentsForPrompt` 的输出被写进
//      `doc_versions.decisionReason`，再由 `buildReviewPromptContext` 带进重跑。
//      中间任何一环丢了，就是上面那个死循环。
//   2. **锚点信息丢了**：意见不只是一句话，还带「改哪一段、改哪几个字」。
//      只留正文的话，agent 得靠猜——而它猜错时同样没有任何报错。
//   3. **决策时的归档**：意见要被快照进那一版的 `commentsJson` 与 `decisionReason`，
//      否则下一轮评审的人翻版本史时看不到自己上一轮说过什么，只能凭记忆判断 agent
//      有没有照着改。（原本还想锁「行侧 review_comments 被清空」，实测那条断言没有
//      预言力——决策后读的是**新**那一版的 id，陈旧行永远不会重现；去掉那句 delete
//      的变异不红。与其留一条空断言冒充覆盖，不如写清为什么不锁。）
//
// 判据取自源码单一事实源：
//   services/review.ts:3082-3104   renderCommentsForPrompt 的四行结构（Location / Selection / 引用 / Comment）
//   services/review.ts:2484-2516   决策时渲染进 decisionReason、快照进 commentsJson、清空行侧意见
//   services/review.ts:3121-3155   iterate ⇒ ctx.comments 进重跑提示词
//   schemas/review.ts:405-415      提交意见的载荷；后端按正文重算 occurrenceIndex

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
let workflowId: string

const COMMENT_ONE = 'rfc319-b45-tighten-the-enum'
const COMMENT_TWO = 'rfc319-b45-name-the-migration'
const COMMENT_EDITED = 'rfc319-b45-edited-after-second-thoughts'

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

interface ReviewRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}

async function launchAndAwaitReview(name: string): Promise<{ taskId: string; review: ReviewRow }> {
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
  return { taskId: created.id, review: row as unknown as ReviewRow }
}

interface Detail {
  currentBody: string
  currentVersion: { id: string }
  comments: Array<{ id: string; commentText: string }>
}

/**
 * 在文档正文里挑一段**真实存在**的文字做锚点——后端会按正文重算
 * `occurrenceIndex`，凭空编的选中文本锚不上去。
 */
function anchorOn(body: string, needle: string) {
  const at = body.indexOf(needle)
  expect(at, `文档正文里应当有 "${needle}"：\n${body}`).toBeGreaterThanOrEqual(0)
  return {
    sectionPath: '',
    paragraphIdx: 0,
    offsetStart: at,
    offsetEnd: at + needle.length,
    selectedText: needle,
    contextBefore: body.slice(Math.max(0, at - 12), at),
    contextAfter: body.slice(at + needle.length, at + needle.length + 12),
    occurrenceIndex: 1,
  }
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

/**
 * 迭代之后**新起的**那一轮 designer，且已经跑完。
 *
 * 两处都不能靠计数：
 *  - 迭代一落库，重跑行就以 `pending` + `startedAt=null` 立刻出现。按「有几行」等，
 *    条件当场满足，然后读到一个还没有提示词的空壳（实撞：首次运行即红在
 *    「第一条意见没进重跑提示词」，而实际是那一轮根本还没起）。
 *  - 换成「数 status=done 的行」同样不行：迭代会把**原来那一轮回滚并置为 canceled**，
 *    于是跑完之后 done 的 designer 行始终只有一条（实撞第二次）。
 *
 * 所以按 id 认人：记下决策**之前**的那批行 id，等一条不在其中、且已 done 的行出现。
 */
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

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-revcomments-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 review comments fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-revcomments-designer',
      description: 'RFC-319 review comments fixture',
      // 默认 stub（mode-basic）只发 `answer` 端口——声明 `design` 会得到一份**空文档**，
      // 评审就没有正文可锚，整条用例会在一个退化 fixture 上跑。
      outputs: ['answer'],
      outputKinds: { answer: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-revcomments-wf',
        description: 'RFC-319 review comments fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-revcomments-designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'review_design',
              kind: 'review',
              inputSource: { nodeId: 'designer', portName: 'answer' },
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
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
})

test('意见的增 / 改 / 删都落在这一版上，且列表如实反映', async () => {
  const { review } = await launchAndAwaitReview('rfc319-revcomments-crud')
  const detail = await api<Detail>(`/api/reviews/${review.nodeRunId}`)
  expect(detail.comments, '新开的评审不该带着上一轮的意见').toHaveLength(0)

  const word = detail.currentBody.trim().split(/\s+/)[0] ?? ''
  expect(word.length, '文档正文不能是空的，否则锚点无从谈起').toBeGreaterThan(0)

  const created = await api<{ id: string }>(`/api/reviews/${review.nodeRunId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ anchor: anchorOn(detail.currentBody, word), commentText: COMMENT_ONE }),
  })
  await api(`/api/reviews/${review.nodeRunId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ anchor: anchorOn(detail.currentBody, word), commentText: COMMENT_TWO }),
  })
  let after = await api<Detail>(`/api/reviews/${review.nodeRunId}`)
  expect(after.comments.map((c) => c.commentText).sort()).toEqual([COMMENT_ONE, COMMENT_TWO].sort())

  // 改：改的是那一条，不是全部（只断言「新文本在」的话，把两条都改掉也能过）。
  await api(`/api/reviews/${review.nodeRunId}/comments/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ commentText: COMMENT_EDITED }),
  })
  after = await api<Detail>(`/api/reviews/${review.nodeRunId}`)
  expect(after.comments.map((c) => c.commentText).sort()).toEqual(
    [COMMENT_EDITED, COMMENT_TWO].sort(),
  )

  // 删：删掉的那条走了，另一条留着。
  const del = await fetch(
    `${daemon.baseUrl}/api/reviews/${review.nodeRunId}/comments/${created.id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  expect(del.ok, `delete: ${del.status} ${await del.text()}`).toBe(true)
  after = await api<Detail>(`/api/reviews/${review.nodeRunId}`)
  expect(after.comments.map((c) => c.commentText)).toEqual([COMMENT_TWO])
})

test('迭代之后：意见连同锚点一起进重跑提示词，并被归档进那一版的快照', async () => {
  const { taskId, review } = await launchAndAwaitReview('rfc319-revcomments-iterate')
  const detail = await api<Detail>(`/api/reviews/${review.nodeRunId}`)
  const word = detail.currentBody.trim().split(/\s+/)[0] ?? ''
  const anchor = anchorOn(detail.currentBody, word)

  await api(`/api/reviews/${review.nodeRunId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ anchor, commentText: COMMENT_ONE }),
  })
  await api(`/api/reviews/${review.nodeRunId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ anchor, commentText: COMMENT_TWO }),
  })

  // 记下决策之前的那批 designer 行，重跑轮靠「不在其中」认出来。
  const beforeIds = new Set((await designerRuns(taskId)).map((r) => r.id))

  const decided = await fetch(`${daemon.baseUrl}/api/reviews/${review.nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'iterated', reviewIteration: review.reviewIteration }),
  })
  expect(decided.ok, `iterate: ${decided.status} ${await decided.text()}`).toBe(true)

  const prompt = await awaitRerunPrompt(taskId, beforeIds)
  // ① 两条意见的正文都在——只带一条的实现（「取最后一条」是常见写法）在这里露出来。
  expect(prompt, '第一条意见没进重跑提示词').toContain(COMMENT_ONE)
  expect(prompt, '第二条意见没进重跑提示词').toContain(COMMENT_TWO)
  // ② 锚点也在：agent 得知道改哪一段、改哪几个字，光有正文它只能猜。
  expect(prompt, '意见的选中文本没进提示词，agent 只能猜改哪儿').toContain(word)
  expect(prompt).toContain('**Comment**:')
  expect(prompt).toContain('**Location**:')

  // ③ 归档：决策时意见会被从行表搬进那一版的快照（`commentsJson`）与 `decisionReason`。
  //    快照丢了的后果同样静默——下一轮评审的人翻版本史时看不到自己上一轮到底提了什么，
  //    只能凭记忆判断 agent 有没有照着改。
  //
  //    这里**不**断言「行侧 review_comments 已清空」：实测那条断言是空的（决策后
  //    `getReviewDetail` 读的是**新**那一版的 id，陈旧行按旧 docVersionId 挂着，
  //    永远不会重现），把清场写成「否则下一轮重复渲染」是编出来的危害。删掉那条空断言，
  //    别让它冒充覆盖——变异（去掉那句 delete）实测不红，正是它没有预言力的证据。
  const versions = await api<
    Array<{ id: string; decision: string; commentsJson: string; decisionReason: string | null }>
  >(`/api/reviews/${review.nodeRunId}/versions`)
  const iterated = versions.find((v) => v.decision === 'iterated')
  expect(iterated, '迭代过的那一版应当在版本史里').toBeDefined()
  expect(iterated!.commentsJson, '这一版的意见快照丢了两条中的第一条').toContain(COMMENT_ONE)
  expect(iterated!.commentsJson, '这一版的意见快照丢了两条中的第二条').toContain(COMMENT_TWO)
  // decisionReason 就是进重跑提示词的那段渲染结果；与快照互为反向对照。
  expect(iterated!.decisionReason ?? '').toContain(COMMENT_ONE)
  expect(iterated!.decisionReason ?? '').toContain('**Comment**:')
})

const REJECT_REASON = 'rfc319-b45-reject-because-the-enum-is-open-ended'

test('驳回：理由是必填的，且它同样要进重跑提示词', async () => {
  const { taskId, review } = await launchAndAwaitReview('rfc319-revcomments-reject')

  // 空理由必须被当场拒绝。驳回是「推倒重来」那一下，没有理由的驳回等于让 agent
  // 在不知道错在哪的情况下重写一遍——收下它比拒绝它糟得多，因为界面会显示「已驳回」。
  const noReason = await fetch(`${daemon.baseUrl}/api/reviews/${review.nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'rejected', reviewIteration: review.reviewIteration }),
  })
  expect(noReason.status, '缺理由的驳回必须被拒').toBeGreaterThanOrEqual(400)
  expect(noReason.status).toBeLessThan(500)
  // 被拒之后这一轮必须**原样还在**：先落库再报错的实现同样会返回 4xx。
  const still = await api<ReviewRow[]>('/api/reviews?status=pending')
  expect(
    still.some((r) => r.nodeRunId === review.nodeRunId && r.awaitingReview),
    '被拒的驳回不该改变任何状态',
  ).toBe(true)

  const beforeIds = new Set((await designerRuns(taskId)).map((r) => r.id))
  const rejected = await fetch(`${daemon.baseUrl}/api/reviews/${review.nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision: 'rejected',
      rejectReason: REJECT_REASON,
      reviewIteration: review.reviewIteration,
    }),
  })
  expect(rejected.ok, `reject: ${rejected.status} ${await rejected.text()}`).toBe(true)

  const prompt = await awaitRerunPrompt(taskId, beforeIds)
  expect(prompt, '驳回理由没进重跑提示词，agent 只知道被打回、不知道为什么').toContain(
    REJECT_REASON,
  )
})
