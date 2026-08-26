// RFC-326 —— 评审门的 MCP / API 完整面（proposal AC-30 / AC-32；US1 / US2 / US3 / US6 / US8）。
//
// 一个外部代理（PAT + JSON-RPC 打 POST /api/mcp）在本地检视一份设计文档并提交意见：
// 读到待评审文档、按「引文」定位提交意见、坏引文被拒且零写入、打包 iterate 让门重开、
// approve 收口；网页端按**源文偏移**把三条意见各自高亮在标题 / 行内代码 / 代码块里。
//
// 判据取自源码单一事实源：
//   packages/backend/src/mcp/tools.ts GATE_TOOLS —— 七个评审工具 + submit_review 的批
//   packages/backend/src/modules/collaboration/domain/reviewAnchor.ts —— 引文解析
//   packages/frontend/src/components/prose/rehypeWrapAnchors.ts —— mode:'source-offset'
//   packages/system-mocks/src/runtime/mode-review-doc.ts —— 固定的设计文档 REVIEW_DOC_BODY
//
// 文档正文与 stub 保持逐字一致（下面的 DOC 常量），任何一处改动都要一起改。

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

/** Byte-identical to REVIEW_DOC_BODY in packages/system-mocks/src/runtime/mode-review-doc.ts. */
const DOC = [
  '# Order status design',
  '',
  '## Summary',
  '',
  'The `order_status` enum should include partially_refunded.',
  '',
  '## Notes',
  '',
  'The export job reads the enum too.',
  '',
  '```ts',
  'const orderStatus = "partially_refunded"',
  '```',
  '',
  '<!-- reviewer note: not rendered -->',
  '',
].join('\n')

let daemon: DaemonHandle
let repoDir: string
let patToken = ''
let readOnlyToken = ''
let taskId = ''
let nodeRunId = ''
let reviewIteration = 0
const commentIds: Record<string, string> = {}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc326-review-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc326 review fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon({ stubMode: 'review-doc' })

  // 夹具(任务 + 待评审轮 + 两个 PAT)在这里建,不挂在第一条用例里:每条用例的
  // 标题都是一条独立能力的证据,让 HUMAN-50…53 依赖 HUMAN-49 的副作用会把
  // 「这条能力有没有」与「上一条跑没跑」绑在一起(实现门 P2#13)。
  const workflowId = await seedDesignerWorkflow('rfc326-review')
  const task = await api<{ id: string }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc326-review-task',
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id
  const pending = await waitForPendingReview(0)
  nodeRunId = pending.nodeRunId
  reviewIteration = pending.reviewIteration
  patToken = await mintPat('rfc326-mcp-rw', ['tasks:execute'])
  readOnlyToken = await mintPat('rfc326-mcp-ro', [])
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

async function api<T>(path: string, init?: RequestInit, token = daemon.token): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function mintPat(name: string, scopes: string[]): Promise<string> {
  const minted = await api<{ token: string }>('/api/auth/pats', {
    method: 'POST',
    body: JSON.stringify({ name, scopes, purpose: 'mcp_only' }),
  })
  return minted.token
}

interface RpcFrame {
  result?: {
    tools?: Array<{ name: string }>
    isError?: boolean
    content?: Array<{ type: string; text: string }>
  }
  error?: { code: number; message: string }
}

/** One stateless Streamable-HTTP request; the answer rides in an SSE `data:` frame. */
async function rpc(
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcFrame> {
  const res = await fetch(`${daemon.baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  expect(res.status, `${method}: ${res.status} ${text.slice(0, 300)}`).toBe(200)
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse(line === undefined ? text : line.slice('data: '.length)) as RpcFrame
}

/** tools/call → the parsed JSON the tool returned, or the refusal text. */
async function toolCall(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; text: string }> {
  const frame = await rpc(token, 'tools/call', { name, arguments: args })
  if (frame.error !== undefined) return { ok: false, text: frame.error.message }
  const text = (frame.result?.content ?? []).map((c) => c.text).join('\n')
  if (frame.result?.isError === true) return { ok: false, text }
  return { ok: true, value: JSON.parse(text) as unknown }
}

function seedAuth(page: Page): Promise<void> {
  return page.addInitScript(
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
}

async function seedDesignerWorkflow(name: string): Promise<string> {
  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `${name}-designer`,
      description: 'RFC-326 review-gate fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-326 review-gate fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
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
  return wf.id
}

interface ReviewRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}

async function waitForPendingReview(iteration: number): Promise<ReviewRow> {
  let found: ReviewRow | null = null
  await expect
    .poll(
      async () => {
        const rows = await api<ReviewRow[]>('/api/reviews?status=pending')
        found =
          rows.find(
            (r) => r.taskId === taskId && r.awaitingReview && r.reviewIteration === iteration,
          ) ?? null
        return found !== null
      },
      { timeout: 180_000 },
    )
    .toBe(true)
  return found as unknown as ReviewRow
}

test('RFC-326 HUMAN-49: an MCP token reads the pending review — list_pending_gates / get_review / list_review_history', async () => {
  expect(taskId, 'beforeAll 必须已经把任务跑到待评审').not.toBe('')
  const gates = await toolCall(patToken, 'list_pending_gates', {})
  expect(gates.ok).toBe(true)
  const gateValue = (
    gates as {
      value: {
        complete: boolean
        reviews: { ok: true; data: ReviewRow[] } | { ok: false; error: string }
      }
    }
  ).value
  expect(gateValue.complete).toBe(true)
  expect(gateValue.reviews.ok).toBe(true)
  if (!gateValue.reviews.ok) {
    throw new Error(`reviews gate lane failed: ${gateValue.reviews.error}`)
  }
  expect(gateValue.reviews.data.map((r) => r.nodeRunId)).toContain(nodeRunId)

  const detail = await toolCall(patToken, 'get_review', { nodeRunId })
  expect(detail.ok).toBe(true)
  const body = (detail as { value: { currentBody: string } }).value.currentBody
  // The envelope parser trims the port's trailing newline; offsets below are
  // unaffected (only the tail differs).
  expect(body.trimEnd(), 'the stub must hand the review the fixture document verbatim').toBe(
    DOC.trimEnd(),
  )

  const history = await toolCall(patToken, 'list_review_history', { nodeRunId })
  expect(history.ok).toBe(true)
  const versions = (history as { value: { versions: Array<{ id: string }> } }).value.versions
  expect(versions.length).toBe(1)
})

test('RFC-326 HUMAN-50: add_review_comment anchors by quote (title / inline code / code block) and the page highlights each at its offset', async ({
  page,
}) => {
  interface Created {
    id: string
    anchor: { offsetStart: number; offsetEnd: number; sectionPath: string; occurrenceIndex: number }
    warnings: string[]
  }
  const title = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: 'Order status design',
    commentText: 'title: say which service owns it',
  })
  expect(title.ok, JSON.stringify(title)).toBe(true)
  const titleCreated = (title as { value: Created }).value
  expect(titleCreated.anchor.offsetStart).toBe(DOC.indexOf('Order status design'))
  expect(titleCreated.warnings).toEqual([])
  commentIds.title = titleCreated.id

  const inlineCode = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: 'order_status',
    commentText: 'inline code: rename to order_state?',
  })
  expect(inlineCode.ok, JSON.stringify(inlineCode)).toBe(true)
  const inlineCreated = (inlineCode as { value: Created }).value
  expect(inlineCreated.anchor.offsetStart).toBe(DOC.indexOf('order_status'))
  expect(inlineCreated.anchor.sectionPath).toBe('# Order status design > ## Summary')
  commentIds.inline = inlineCreated.id

  // `partially_refunded` occurs twice: the paragraph and the fenced code — the
  // second one, named by its global occurrence number, is the code-block comment.
  const inCode = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: 'partially_refunded',
    occurrence: 2,
    commentText: 'code block: quote the literal',
  })
  expect(inCode.ok, JSON.stringify(inCode)).toBe(true)
  const codeCreated = (inCode as { value: Created }).value
  expect(codeCreated.anchor.occurrenceIndex).toBe(2)
  expect(codeCreated.anchor.offsetStart).toBe(DOC.indexOf('partially_refunded"'))
  expect(codeCreated.warnings).toEqual(['quote-in-code-block'])
  commentIds.code = codeCreated.id

  // 判据分离(实现门 P1#10):上面三个引文与**渲染文本**逐字相同,一个只按渲染文本
  // 匹配的实现照样能全绿。这一条的引文带 Markdown 标记(反引号在源文里、渲染时消失),
  // 只有真的用「存储的源文偏移 → 渲染文本」投影才可能命中。
  const withMarkup = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: '## Notes',
    commentText: 'markup-bearing quote: only source offsets can locate this',
  })
  expect(withMarkup.ok, JSON.stringify(withMarkup)).toBe(true)
  const markupCreated = (withMarkup as { value: Created }).value
  expect(markupCreated.anchor.offsetStart).toBe(DOC.indexOf('## Notes'))
  commentIds.markup = markupCreated.id

  const stored = await api<{ comments: Array<{ id: string }> }>(`/api/reviews/${nodeRunId}`)
  expect(stored.comments.map((c) => c.id).sort()).toEqual(Object.values(commentIds).sort())

  // US8 — the page highlights each comment where it was made, by source offset.
  await seedAuth(page)
  await page.goto(`${daemon.baseUrl}/reviews/${nodeRunId}`)
  const body = page.locator('.review-detail__body')
  await expect(body).toBeVisible()
  const titleMark = body.locator(`h1 mark.comment-anchor[data-comment-id="${commentIds.title}"]`)
  await expect(titleMark).toHaveText('Order status design')
  const inlineMark = body.locator(
    `p code mark.comment-anchor[data-comment-id="${commentIds.inline}"]`,
  )
  await expect(inlineMark).toHaveText('order_status')
  // The fence is highlighted by shiki (real wasm in the browser); the decoration
  // survives as a <mark> inside the shiki <pre>.
  const codeMark = body.locator(
    `[data-prose-code="ts"] pre.shiki mark.comment-anchor[data-comment-id="${commentIds.code}"]`,
  )
  await expect(codeMark).toHaveText('partially_refunded')
  // The paragraph occurrence of the same word is NOT marked by the code comment.
  await expect(
    body.locator(`p mark.comment-anchor[data-comment-id="${commentIds.code}"]`),
  ).toHaveCount(0)

  // 带标记的引文:`## ` 只存在于源文,渲染后消失。因此这条锚只可能来自
  // 「存储的源文偏移 → 渲染文本」投影;纯文本匹配在页面上根本找不到 “## Notes”。
  const markupMark = body.locator(`h2 mark.comment-anchor[data-comment-id="${commentIds.markup}"]`)
  await expect(markupMark).toHaveText('Notes')
  expect(await body.textContent()).not.toContain('## Notes')

  // AC-30 的另一半:侧栏逐条都在(高亮与意见列表是同一份数据的两个面)。
  for (const [key, id] of Object.entries(commentIds)) {
    await expect(
      page.locator(`.comment-bubble[data-comment-id="${id}"]`),
      `侧栏应当有 ${key} 这条意见`,
    ).toHaveCount(1)
  }
})

test('RFC-326 HUMAN-51: an ambiguous quote is refused with its candidates and writes nothing', async () => {
  const before = await api<{ comments: unknown[] }>(`/api/reviews/${nodeRunId}`)
  const refused = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: 'partially_refunded',
    commentText: 'which one?',
  })
  expect(refused.ok).toBe(false)
  const text = (refused as { text: string }).text
  expect(text).toContain('review-anchor-ambiguous')
  expect(text).toContain('occurrence 1')
  expect(text).toContain('occurrence 2')
  const missing = await toolCall(patToken, 'add_review_comment', {
    nodeRunId,
    quote: 'not in this document at all',
    commentText: 'x',
  })
  expect(missing.ok).toBe(false)
  expect((missing as { text: string }).text).toContain('review-anchor-not-found')
  const after = await api<{ comments: unknown[] }>(`/api/reviews/${nodeRunId}`)
  expect(after.comments.length).toBe(before.comments.length)
})

test('RFC-326 HUMAN-52: submit_review iterated with a batched comment re-opens the gate; approved closes it', async () => {
  const decided = await toolCall(patToken, 'submit_review', {
    nodeRunId,
    decision: 'iterated',
    reviewIteration,
    comments: [{ quote: 'export job', commentText: 'batched: name the job' }],
  })
  expect(decided.ok, JSON.stringify(decided)).toBe(true)
  const result = (
    decided as { value: { ok: boolean; reviewIteration: number; commentsAdded: number } }
  ).value
  expect(result.ok).toBe(true)
  expect(result.reviewIteration).toBe(reviewIteration + 1)
  expect(result.commentsAdded).toBe(1)

  // The designer re-runs (same stub document) and the gate re-opens at iteration 1.
  const reopened = await waitForPendingReview(reviewIteration + 1)
  expect(reopened.nodeRunId).toBe(nodeRunId)
  const history = await toolCall(patToken, 'list_review_history', { nodeRunId })
  expect(history.ok).toBe(true)
  const versions = (
    history as {
      value: { versions: Array<{ decision: string; commentsJson?: string; comments?: unknown[] }> }
    }
  ).value.versions
  expect(versions.length).toBe(2)
  const archived = versions.find((v) => v.decision === 'iterated')
  expect(archived).toBeDefined()

  const approved = await toolCall(patToken, 'submit_review', {
    nodeRunId,
    decision: 'approved',
    reviewIteration: reviewIteration + 1,
  })
  expect(approved.ok, JSON.stringify(approved)).toBe(true)
  await expect
    .poll(async () => (await api<{ status: string }>(`/api/tasks/${taskId}`)).status, {
      timeout: 120_000,
    })
    .toBe('done')
})

test('RFC-326 HUMAN-53: a read-only token neither lists nor can call the review write tools', async () => {
  const listed = await rpc(readOnlyToken, 'tools/list', {})
  const names = (listed.result?.tools ?? []).map((t) => t.name)
  expect(names).toEqual(
    expect.arrayContaining(['list_reviews', 'get_review', 'list_review_history']),
  )
  for (const tool of ['add_review_comment', 'submit_review', 'set_review_document_selection']) {
    expect(names, `${tool} must not be offered to a read-only token`).not.toContain(tool)
  }
  const hard = await toolCall(readOnlyToken, 'add_review_comment', {
    nodeRunId,
    quote: 'Notes',
    commentText: 'x',
  })
  expect(hard.ok).toBe(false)
  expect((hard as { text: string }).text.toLowerCase()).toContain('not found')
})
