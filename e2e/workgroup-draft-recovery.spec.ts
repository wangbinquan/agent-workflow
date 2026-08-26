// RFC-319 B26 —— WG-08：工作组自动保存的失败与冲突处置。
//
// 工作组编辑器没有「保存」按钮——**用户唯一的凭据是那两个状态徽标**。所以这条
// 能力的失效形态是：编辑器安静地把一次编辑丢了，而界面从头到尾显示「已保存」。
//
// 它复用工作流那套草稿引擎（`lib/workflow-editor-draft.ts`），工作流侧的弱网行为
// 已由 `e2e/rfc199-save-reliability.spec.ts` 锁住。**但复用不等于接对了线**：
// `hooks/useWorkgroupAutosave.ts` 是一层独立的适配器——它把工作组快照编码进
// `WorkflowDraftSnapshot.description`、自己校验回执、自己把冲突负载映射回界面。
// 这一层接错（回执校验漏一项、冲突负载没往下传、副本动作没接上）在工作流侧的
// 用例里一条都照不出来，而症状同样是静默丢数据。这条用例覆盖的正是这一层。
//
// 三段对应能力条目里的三件事：
//   ① 离线队列——发不出去的那次尝试必须原样重发（同一个 clientMutationId），
//      期间的新编辑排队而不是插队；
//   ② 响应丢失重对账——服务端其实写成功了、只是回执没回来，恢复后必须按
//      版本/哈希精确对账，**不许重复写一遍**；
//   ③ 版本冲突三选一——载入远端 / 覆盖远端 / 另存副本，各自的结果两边都读。
//
// 判据取自源码单一事实源：
//   hooks/useWorkgroupAutosave.ts:153-197   适配器的回执逐项校验
//   components/workgroup/WorkgroupDraftStatus.tsx:179-212  冲突态三个按钮
//   routes/workgroups.detail.tsx:583-602    副本走 POST /api/workgroups 并跳转

import { expect, test, type Page } from '@playwright/test'
import type { WorkgroupDetail } from '@agent-workflow/shared'
import { randomBytes } from 'node:crypto'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let agentId: string
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
  agentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-wg08-agent',
        description: 'RFC-319 WG-08 fixture',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '',
      }),
    })
  ).id
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function mutationId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let value = BigInt(`0x${randomBytes(16).toString('hex')}`)
  let encoded = ''
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)]! + encoded
    value >>= 5n
  }
  return encoded
}

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

async function seedWorkgroup(name: string): Promise<WorkgroupDetail> {
  return api<WorkgroupDetail>('/api/workgroups', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 WG-08 fixture',
      instructions: 'base instructions',
      mode: 'leader_worker',
      leaderDisplayName: 'Lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 8,
      completionGate: false,
      clarifyBudget: 0,
      fanOut: false,
      members: [
        { memberType: 'agent', agentId, displayName: 'Lead', roleDesc: 'Coordinates the work.' },
        { memberType: 'agent', agentId, displayName: 'Builder', roleDesc: 'Implements the plan.' },
      ],
    }),
  })
}

async function readWorkgroup(id: string): Promise<WorkgroupDetail> {
  return api<WorkgroupDetail>(`/api/workgroups/${encodeURIComponent(id)}`)
}

/** 与 `projectWorkgroupDetailSnapshot` 同形：把远端详情投影成一次 PUT 的快照。 */
function snapshotOf(detail: WorkgroupDetail): Record<string, unknown> {
  const ordered = [...detail.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === detail.leaderMemberId)
  return {
    name: detail.name,
    description: detail.description,
    instructions: detail.instructions,
    mode: detail.mode,
    outputContract: detail.outputContract,
    ...(detail.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: detail.switches,
    maxRounds: detail.maxRounds,
    completionGate: detail.completionGate,
    clarifyBudget: detail.clarifyBudget ?? 0,
    fanOut: detail.fanOut ?? false,
    members: ordered.map((member) => ({
      memberType: member.memberType,
      ...(member.memberType === 'agent'
        ? { agentId: member.agentId }
        : { userId: member.userId ?? '' }),
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })),
  }
}

/** 服务端侧的「另一个人」：不经浏览器改指令，把远端版本推进一格。 */
async function editOnServer(id: string, instructions: string): Promise<void> {
  const current = await readWorkgroup(id)
  await api(`/api/workgroups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: current.version,
      clientMutationId: mutationId(),
      snapshot: { ...snapshotOf(current), instructions },
    }),
  })
}

async function openEditor(page: Page, id: string): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/workgroups/${encodeURIComponent(id)}`)
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
}

async function editInstructions(page: Page, value: string): Promise<void> {
  await page.getByTestId('workgroup-field-instructions').fill(value)
}

interface SavedProbe {
  clientMutationId: string
  snapshot: { instructions: string }
}

function readSave(postData: string | null): SavedProbe {
  return JSON.parse(postData ?? '{}') as SavedProbe
}

async function retryNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Retry now' }).evaluateAll((buttons) => {
    const button = buttons[buttons.length - 1]
    if (button instanceof HTMLButtonElement) button.click()
  })
}

test('发不出去的保存排队重发：同一次尝试原样重来，期间的新编辑排在它后面', async ({ page }) => {
  const detail = await seedWorkgroup(`rfc319-wg08-offline-${++sequence}`)
  await openEditor(page, detail.id)

  const endpoint = `${daemon.baseUrl}/api/workgroups/${encodeURIComponent(detail.id)}`
  const blocked = deferred<void>()
  const sent: SavedProbe[] = []
  let blockFirst = true
  let failReads = false
  await page.route(endpoint, async (route) => {
    const method = route.request().method()
    if (method === 'PUT') {
      sent.push(readSave(route.request().postData()))
      if (blockFirst) {
        blockFirst = false
        failReads = true
        blocked.resolve()
        await route.abort('failed')
        return
      }
    } else if (method === 'GET' && failReads) {
      await route.abort('failed')
      return
    }
    await route.continue()
  })

  await editInstructions(page, 'attempted while offline')
  await blocked.promise
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Checking save result')
  await expect(page.getByTestId('workgroup-draft-transport')).toHaveText('Offline')
  expect(
    (await readWorkgroup(detail.id)).instructions,
    '连接断了却把内容当成已保存写进服务端，是这条能力最坏的一种失效',
  ).toBe('base instructions')

  // 断网期间继续编辑：它必须排队，不许插到那次未决尝试前面。
  await editInstructions(page, 'queued while offline')
  await expect(page.getByRole('button', { name: 'Retry now' }).last()).toBeVisible()
  failReads = false
  await retryNow(page)

  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
  await expect(page.getByTestId('workgroup-draft-transport')).toHaveText('Online')
  await expect
    .poll(() => sent.map((probe) => probe.snapshot.instructions))
    .toEqual(['attempted while offline', 'attempted while offline', 'queued while offline'])
  expect(
    sent[1]?.clientMutationId,
    '重发必须是**同一次**尝试——换个 mutation id 重发，服务端会把它当成第二次写',
  ).toBe(sent[0]?.clientMutationId)
  await expect
    .poll(async () => (await readWorkgroup(detail.id)).instructions)
    .toBe('queued while offline')

  await page.reload()
  await expect(page.getByTestId('workgroup-field-instructions')).toHaveValue('queued while offline')
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
})

test('响应丢了但服务端其实写成功了：按版本对账收敛，不重复写第二遍', async ({ page }) => {
  const detail = await seedWorkgroup(`rfc319-wg08-lost-${++sequence}`)
  let droppedEchoMutationId: string | null = null

  // This case owns the HTTP-reconciliation branch. An out-of-band PUT also
  // emits a legitimate own WS echo; drop only that exact echo so it cannot
  // settle the attempt before the browser observes the lost HTTP response.
  await page.routeWebSocket(/\/ws\/workgroups(?:\?.*)?$/, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer()
    serverSocket.onMessage((message) => {
      try {
        const frame = JSON.parse(
          typeof message === 'string' ? message : message.toString('utf8'),
        ) as {
          type?: string
          workgroupId?: string
          clientMutationId?: string
        }
        if (
          frame.type === 'workgroup.updated' &&
          frame.workgroupId === detail.id &&
          frame.clientMutationId === droppedEchoMutationId
        ) {
          return
        }
      } catch {
        // Non-JSON frames still pass through unchanged.
      }
      browserSocket.send(message)
    })
  })
  await openEditor(page, detail.id)

  const endpoint = `${daemon.baseUrl}/api/workgroups/${encodeURIComponent(detail.id)}`
  const committed = deferred<void>()
  let dropFirstResponse = true
  let failReads = false
  await page.route(endpoint, async (route) => {
    const method = route.request().method()
    if (method === 'PUT' && dropFirstResponse) {
      dropFirstResponse = false
      droppedEchoMutationId = readSave(route.request().postData()).clientMutationId
      // 从 Node 侧独立连接真正提交，再把浏览器那次请求掐断——这正是
      // 「服务端写成功了、回执丢在路上」的形态。
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: route.request().postData() ?? undefined,
      })
      expect(response.ok, `out-of-band commit: ${response.status}`).toBe(true)
      failReads = true
      await route.abort('failed')
      committed.resolve()
      return
    }
    if (method === 'GET' && failReads) {
      await route.abort('failed')
      return
    }
    await route.continue()
  })

  await editInstructions(page, 'committed but unacknowledged')
  await committed.promise
  await expect
    .poll(async () => (await readWorkgroup(detail.id)).instructions)
    .toBe('committed but unacknowledged')
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Checking save result')

  await expect(page.getByRole('button', { name: 'Retry now' }).last()).toBeVisible()
  failReads = false
  await retryNow(page)

  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
  const settled = await readWorkgroup(detail.id)
  expect(settled.instructions).toBe('committed but unacknowledged')
  expect(
    settled.version,
    '对账应当认出那次写已经成功（v1 → v2）。重发一遍会把版本推到 v3，' +
      '而每一次多余的写都会把并发编辑者顶成冲突',
  ).toBe(2)
})

interface ConflictFixture {
  id: string
}

/**
 * 把工作组编辑器推进 conflict 相位：扣住本地第一次 PUT，期间在服务端把版本推进
 * 一格，再放行——服务端以 409 回绝那次基于旧版本的保存。
 */
async function enterConflict(page: Page): Promise<ConflictFixture> {
  const detail = await seedWorkgroup(`rfc319-wg08-conflict-${++sequence}`)
  await openEditor(page, detail.id)

  const endpoint = `${daemon.baseUrl}/api/workgroups/${encodeURIComponent(detail.id)}`
  const firstSaveSeen = deferred<void>()
  const release = deferred<void>()
  let held = false
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== 'PUT' || held) {
      await route.continue()
      return
    }
    held = true
    firstSaveSeen.resolve()
    await release.promise
    await route.continue()
  })

  await editInstructions(page, 'local instructions')
  await firstSaveSeen.promise
  await editOnServer(detail.id, 'remote instructions')
  release.resolve()

  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Version conflict')
  await page.unroute(endpoint)
  expect((await readWorkgroup(detail.id)).instructions).toBe('remote instructions')
  return { id: detail.id }
}

async function cancelConfirm(page: Page, dialogName: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('冲突后「载入远端」：取消不生效，确认后编辑器里剩下的是别人那一份', async ({ page }) => {
  const { id } = await enterConflict(page)

  await page.getByRole('button', { name: 'Load remote', exact: true }).click()
  await cancelConfirm(page, 'Load the remote version?')
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Version conflict')
  await expect(page.getByTestId('workgroup-field-instructions')).toHaveValue('local instructions')

  await page.getByRole('button', { name: 'Load remote', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Load the remote version?' })
    .getByRole('button', { name: 'Load remote and discard local changes' })
    .click()

  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
  await expect(
    page.getByTestId('workgroup-field-instructions'),
    '载入远端之后编辑框里还留着本地那一份，等于「载入」只换了个相位',
  ).toHaveValue('remote instructions')
  expect((await readWorkgroup(id)).instructions, '载入远端不许反向把本地推上去').toBe(
    'remote instructions',
  )
})

test('冲突后「覆盖远端」：取消时服务端不动，确认后本地这一份成为服务端的版本', async ({ page }) => {
  const { id } = await enterConflict(page)

  await page.getByRole('button', { name: 'Overwrite remote', exact: true }).click()
  await cancelConfirm(page, 'Overwrite the remote version?')
  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Version conflict')
  expect((await readWorkgroup(id)).instructions, '取消二次确认之后服务端仍必须是别人的那一版').toBe(
    'remote instructions',
  )

  await page.getByRole('button', { name: 'Overwrite remote', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Overwrite the remote version?' })
    .getByRole('button', { name: 'Overwrite remote', exact: true })
    .click()

  await expect(page.getByTestId('workgroup-draft-phase')).toHaveText('Saved')
  await expect.poll(async () => (await readWorkgroup(id)).instructions).toBe('local instructions')
})

test('冲突后「另存为副本」：本地这一份原样落到新文档，原文档一个字节都不动', async ({ page }) => {
  const { id } = await enterConflict(page)
  const copyName = `rfc319-wg08-copy-${sequence}`

  await page.getByRole('button', { name: 'Save as copy (recommended)', exact: true }).click()
  const copyDialog = page.getByTestId('workgroup-copy-rename-dialog')
  await expect(copyDialog).toBeVisible()
  await copyDialog.getByTestId('workgroup-copy-rename-name').fill(copyName)
  await copyDialog.getByTestId('workgroup-copy-rename-confirm').click()
  await page.waitForURL(
    (url) => /\/workgroups\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(id),
  )

  const copyId = page.url().split('/').pop() ?? ''
  const copy = await readWorkgroup(copyId)
  expect(copy.name).toBe(copyName)
  expect(
    copy.instructions,
    '副本存在的理由就是「谁都不丢」——它必须带走本地那一份未保存的编辑',
  ).toBe('local instructions')
  expect(
    (await readWorkgroup(id)).instructions,
    '另存为副本是三条里唯一非破坏性的一条，原文档必须原样不动',
  ).toBe('remote instructions')
})
