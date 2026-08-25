// RFC-319 B44 —— HUMAN-46：澄清页离开时的未保存草稿拦截（留下 / 保存并离开 / 放弃）。
//
// 这道闸只在一个很窄的窗口里有意义：本地草稿写下去了、但**还没落盘确认**。窗口平时
// 只有几毫秒（IDB 本地写不带防抖，`durability.ts` 的防抖只加在服务端队列上），可它一旦
// 变宽——私密模式、配额吃紧、机器忙——用户就正好在这段时间里点了别处。没有这道闸，
// 他刚打的字直接消失，而界面上不会有任何提示：**这正是「无声丢工作」的标准形态**。
//
// 更要紧的是「保存并离开」那一支的**失败关闭**语义：它必须先确认草稿真的落了盘才放行。
// 若它先跳转、再去存，那么存失败时人已经在别的页面上了，损失与根本没有这道闸一模一样，
// 却多了一句「已保存」的假回执。`UnsavedChangesGuard` 的注释把这条写成硬约束——
// 回调必须**同步清掉** `dirtyRef` 才算数，否则守卫 fail closed。
//
// 确定性前提：把 `clarify-drafts` 这个 store 的**写事务完成通知**扣住不发（数据照常落盘，
// 只是不告诉页面）。这不是伪造一个不存在的状态——它就是 `dirtyRef` 定义的那个状态
// （`latestGeneration > localAckGeneration`，clarify.detail.tsx:327-329），也正是这道闸
// 存在的理由。不扣的话窗口是毫秒级，用例只能靠抢跑，那种「本地绿、CI 红」的用例本仓不写。
//
// 判据取自源码单一事实源：
//   lib/clarify/draftStore.ts:63-73        本地写在 tx.oncomplete 上 resolve
//   lib/clarify/durability.ts:490-504      本地写**不**走防抖（防抖只在服务端队列上）
//   routes/clarify.detail.tsx:326-330      dirtyRef = latestGeneration > localAckGeneration
//   routes/clarify.detail.tsx:1050-1079    三个回调：保存并离开 / 放弃 / （默认留下）
//   components/split/UnsavedChangesGuard.tsx:63-70  onSaveAndProceed 必须同步清 dirtyRef，否则 fail closed
//   components/split/UnsavedChangesGuard.tsx:161-234 四个 testid

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

/** 每条用例一个唯一的自定义文本——理由见 openDirty 的注释。 */
const MARKER_STAY = 'rfc319-b44-stay'
const MARKER_SAVE = 'rfc319-b44-save'
const MARKER_DISCARD = 'rfc319-b44-discard'

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

/**
 * 装一个可开关的「本地草稿落盘回执延迟器」。
 *
 * 只拦 `clarify-drafts` 的 readwrite 事务，且**不改变落盘结果**——真事务照常提交，
 * 我们只是把 `oncomplete` 的送达推迟到调用方主动释放。页面因此停在
 * 「写下去了、还没确认」这个真实存在的中间态上。
 */
async function installDraftAckHold(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __awHoldDraftAcks: boolean
      __awPendingAcks: Array<() => void>
    }
    w.__awHoldDraftAcks = false
    w.__awPendingAcks = []
    const origTx = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      names: string | string[] | DOMStringList,
      mode?: IDBTransactionMode,
      opts?: IDBTransactionOptions,
    ): IDBTransaction {
      const tx = origTx.call(this, names as never, mode as never, opts as never)
      const list = typeof names === 'string' ? [names] : Array.from(names as Iterable<string>)
      if (mode !== 'readwrite' || !list.includes('clarify-drafts')) return tx
      let userComplete: ((ev: Event) => void) | null = null
      Object.defineProperty(tx, 'oncomplete', {
        configurable: true,
        get: () => userComplete,
        set: (fn: ((ev: Event) => void) | null) => {
          userComplete = fn
        },
      })
      tx.addEventListener('complete', (ev) => {
        const fire = () => {
          if (typeof userComplete === 'function') userComplete.call(tx, ev)
        }
        if (w.__awHoldDraftAcks) w.__awPendingAcks.push(fire)
        else fire()
      })
      return tx
    } as typeof IDBDatabase.prototype.transaction
  })
}

const holdAcks = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { __awHoldDraftAcks: boolean }).__awHoldDraftAcks = true
  })

const releaseAcks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __awHoldDraftAcks: boolean
      __awPendingAcks: Array<() => void>
    }
    w.__awHoldDraftAcks = false
    const queued = w.__awPendingAcks.splice(0)
    for (const fire of queued) fire()
  })

/**
 * 打开澄清页、扣住回执、改一个答案 ⇒ 页面进入「有未落盘草稿」的状态。
 *
 * `marker` 每条用例必须不同：RFC-099 D8 的服务端逐题草稿是协作事实源，上一条用例
 * 留下的草稿会在下一条载入时被采纳为基线；再「改」成同一个值时 `recordChange`
 * 判为无变化直接返回（`lib/clarify/durability.ts:520-523`），页面根本不会变脏，
 * 于是整条用例会在一个**没有前提**的状态上断言。实撞：第三条用例首次运行即红在
 * 「指示器应为 saving、实际是 saved」。
 */
async function openDirty(page: Page, marker: string): Promise<void> {
  await installDraftAckHold(page)
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
  // 等首次草稿状态稳定下来再扣——否则扣住的可能是页面装载时那次写。
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    /saved|local-only/,
  )
  await holdAcks(page)
  const qDb = page.getByTestId('clarify-question-q-db')
  await qDb.getByTestId('clarify-custom-radio').check()
  await qDb.getByTestId('clarify-custom-textarea').fill(marker)
  // 「正在保存」= 本地这一代还没被确认，也就是 dirtyRef 非空。
  await expect(page.getByTestId('clarify-draft-indicator')).toHaveAttribute(
    'data-draft-status',
    'saving',
  )
}

test.beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-draftguard-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 draft guard fixture\n', 'utf-8')
  initGitRepo(repoDir)
  stubState = mkdtempSync(join(tmpdir(), 'aw-rfc319-draftguard-state-'))
  daemon = await startDaemon({ stubMode: 'clarify', extraEnv: { CLARIFY_STUB_STATE: stubState } })

  const agent = await api<{ id: string }>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-draftguard-designer',
      description: 'RFC-319 draft guard fixture',
      outputs: ['design'],
      outputKinds: { design: 'markdown' },
      readonly: true,
      bodyMd: '',
    }),
  })
  const wf = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name: 'rfc319-draftguard-wf',
      description: 'RFC-319 draft guard fixture',
      definition: {
        $schema_version: 3,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'designer',
            kind: 'agent-single',
            agentId: agent.id,
            agentName: 'rfc319-draftguard-designer',
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
      name: 'rfc319-draftguard-task',
      workflowId: wf.id,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'order_status enum' },
    }),
  })
  taskId = task.id

  interface Session {
    intermediaryNodeRunId: string
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
})

test.afterAll(async () => {
  await daemon?.stop()
  if (repoDir !== undefined) rmSync(repoDir, { recursive: true, force: true })
  if (stubState !== undefined) rmSync(stubState, { recursive: true, force: true })
})

test('草稿还没落盘就想离开：拦下来；选「留下」则停在原地且答案还在 @nightly', async ({ page }) => {
  await openDirty(page, MARKER_STAY)

  await page.getByTestId('clarify-detail-task-name').click()
  await expect(page.getByTestId('unsaved-guard-dialog'), '未落盘的草稿必须拦住导航').toBeVisible()
  // 拦下来 ≠ 只是弹了个框：这一刻**不能已经跳走**。
  await expect(page).toHaveURL(new RegExp(`/clarify/${nodeRunId}$`))

  await page.getByTestId('unsaved-stay').click()
  await expect(page.getByTestId('unsaved-guard-dialog')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/clarify/${nodeRunId}$`))
  // 留下之后答案还在——「拦住了但把表单清了」等于换一种方式丢工作。
  await expect(
    page.getByTestId('clarify-question-q-db').getByTestId('clarify-custom-textarea'),
  ).toHaveValue(MARKER_STAY)

  await releaseAcks(page)
})

test('「保存并离开」必须先确认落盘：落盘回执没到之前不许跳走 @nightly', async ({ page }) => {
  await openDirty(page, MARKER_SAVE)
  await page.getByTestId('clarify-detail-task-name').click()
  await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()

  await page.getByTestId('unsaved-save-and-proceed').click()
  // 落盘回执还扣着 ⇒ 必须**停在原地**。先跳转再去存的实现在这里就会漏出来：
  // 它跳走了，而草稿到底存没存下来没人知道，界面还给了一句「已保存」。
  await page.waitForTimeout(1_000)
  await expect(page, '回执未到就跳走 ⇒ fail-closed 语义没了').toHaveURL(
    new RegExp(`/clarify/${nodeRunId}$`),
  )
  await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()

  // 回执一到，它就该继续走完那次被拦下的导航。
  await releaseAcks(page)
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}(\\?|$)`), { timeout: 15_000 })
})

test('「放弃」放行：不再拦，直接走到目标页 @nightly', async ({ page }) => {
  await openDirty(page, MARKER_DISCARD)
  await page.getByTestId('clarify-detail-task-name').click()
  await expect(page.getByTestId('unsaved-guard-dialog')).toBeVisible()

  await page.getByTestId('unsaved-discard').click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}(\\?|$)`), { timeout: 15_000 })
  await expect(page.getByTestId('unsaved-guard-dialog')).toHaveCount(0)
  // 说明：这里**不**断言「草稿真的没了」。放弃只删本地副本，而 RFC-099 D8 的
  // 服务端逐题草稿是协作事实源、回来时它会赢——把两者混在一条断言里，
  // 红了也分不清是哪一边。本地删除有单测覆盖（clarify-detail-route.test.ts）。
  await releaseAcks(page)
})
