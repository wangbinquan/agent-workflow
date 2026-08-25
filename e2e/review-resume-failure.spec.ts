// RFC-319 B38 —— HUMAN-18：决策已落库、但后续 resume 失败时不许假装成功。
//
// 提交评审决策做的是两件事：**记下决策**，然后**把任务踢回去继续跑**。
// 前者是本地事务、几乎不会失败；后者要碰工作树、要起进程，是真会失败的那一半。
//
// 两件事失败语义不同，所以不能合并成一个「成功/失败」：决策确实落库了（2xx 是
// 对的），但任务并没有继续。若响应对此只字不提，reviewer 看到「已通过」就走了，
// 而任务从此停在原地——**没有任何人会再回来看它**。这类「伪成功」是审计 R4 点名
// 的形态：真失败沉进 daemon 日志，HTTP 那头一片祥和。
//
// 判据三段：①决策**确实**落库（它不该因为踢不动就回滚）；②响应里带着
// `resume.ok === false` 与一个可归因的 code；③任务**没有**被说成在跑。
// 正向对照不能省：同样的流程在工作树健在时不带 `resume` 字段，否则「永远报警告」
// 也能让上面三条成立。
//
// 触发真失败的方式是把任务工作树从磁盘上删掉——这正是 `resumeTask` 的 410
// 前置检查所守的形态（GC 掉的工作树），也是源码注释里点名的第一个例子。
//
// 判据取自源码单一事实源：
//   routes/reviews.ts:300-333   决策 2xx 不变，踢的结果作为可选 `resume` 字段回传
//   services/task.ts:3473-3484  工作树没了 ⇒ task-worktree-missing（410）

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
let workflowId: string
let sequence = 0

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

interface DecisionResponse {
  ok: boolean
  resume?: { ok: boolean; code: string; message: string }
}

async function decide(
  nodeRunId: string,
  reviewIteration: number,
): Promise<{ status: number; body: DecisionResponse }> {
  const res = await fetch(`${daemon.baseUrl}/api/reviews/${nodeRunId}/decision`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', reviewIteration }),
  })
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as DecisionResponse }
}

interface ReviewRow {
  nodeRunId: string
  taskId: string
  reviewIteration: number
  awaitingReview: boolean
}

async function launchAndAwaitReview(name: string): Promise<{ task: string; review: ReviewRow }> {
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
  return { task: created.id, review: row as unknown as ReviewRow }
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-resumefail-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 resume-failure fixture\n', 'utf-8')
  initGitRepo(repoDir)
  daemon = await startDaemon()

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-resumefail-designer',
      description: 'RFC-319 resume-failure fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  workflowId = (
    await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-resumefail-wf',
        description: 'RFC-319 resume-failure fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentId: agent.id,
              agentName: 'rfc319-resumefail-designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 320, y: 0 },
            },
            {
              id: 'review_design',
              kind: 'review',
              inputSource: { nodeId: 'designer', portName: 'design' },
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
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

test('正向对照：工作树健在时，决策响应里不带任何 resume 警告 @nightly', async () => {
  const { task, review } = await launchAndAwaitReview(`rfc319-resumefail-ok-${++sequence}`)
  const done = await decide(review.nodeRunId, review.reviewIteration)
  expect(done.status).toBe(200)
  expect(
    done.body.resume,
    '一切正常也报 resume 警告的话，「有警告」就不再是信号——下面那条判据随之失效',
  ).toBeUndefined()
  expect(
    (await api<ReviewRow[]>('/api/reviews?status=pending')).some((r) => r.taskId === task),
    '决策提交完这条评审还挂在待办里',
  ).toBe(false)
})

test('工作树被回收后：决策照样落库，但响应必须点名 resume 失败，且不谎称任务在跑 @nightly', async () => {
  const { task, review } = await launchAndAwaitReview(`rfc319-resumefail-gone-${++sequence}`)
  const detail = await api<{ worktreePath: string }>(`/api/tasks/${task}`)
  expect(detail.worktreePath, '任务没有工作树路径 ⇒ 下面的删除构造不出那条失败').toBeTruthy()
  rmSync(detail.worktreePath, { recursive: true, force: true })

  const decided = await decide(review.nodeRunId, review.reviewIteration)
  expect(decided.status, '踢不动就把决策一起判失败 ⇒ reviewer 会重复点，而决策其实已经落库了').toBe(
    200,
  )
  expect(
    decided.body.resume?.ok,
    '响应对 resume 失败只字不提 ⇒ 这就是审计 R4 点名的「伪成功」：' +
      'reviewer 看到「已通过」就走了，任务从此停在原地，没有任何人会再回来看它',
  ).toBe(false)
  expect(
    decided.body.resume?.code,
    '警告没有可归因的 code ⇒ 界面只能显示一句无法排查的「出错了」',
  ).toBeTruthy()

  // 决策本身确实落库：这条评审不再挂在待办上。
  expect(
    (await api<ReviewRow[]>('/api/reviews?status=pending')).some((r) => r.taskId === task),
    '决策因为踢不动而回滚了 ⇒ 2xx 与库里的事实不一致',
  ).toBe(false)

  expect(
    (await api<{ status: string }>(`/api/tasks/${task}`)).status,
    '任务被说成 done ⇒ 踢失败被当成了跑完，这比不报警告更坏',
  ).not.toBe('done')
})
