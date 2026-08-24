// RFC-319 B25 —— WF-44：画布草稿撞版本之后的三条恢复动作。
//
// 冲突态本身已经有覆盖（`e2e/rfc199-save-reliability.spec.ts` 的两标签页用例锁到
// 「出现冲突且谁都没被覆盖」为止）。**没被覆盖的是它之后**——用户此刻手里握着一份
// 没保存的工作，界面给了三个按钮，每一个都可能销毁一边的成果：
//
//   * 「载入远端」丢掉**我的**改动；
//   * 「覆盖远端」丢掉**别人的**改动；
//   * 「另存为副本」谁都不丢，代价是多出一份文档。
//
// 三者接错线的形态都是静默的：点了「载入远端」结果把本地推上去了，页面照样回到
// 「已保存」，用户要到别人回来问「我的改动呢」才知道。所以判据不能只看相位回到
// clean，必须**两边都读**：本地看到什么、服务端存的是什么。
//
// 二次确认同样是判据的一部分而不是装饰——它是这三个不可逆动作唯一的挽回机会。
// 因此每条都先**打开对话框再取消**，断言什么都没发生，再走确认路径。只测确认路径
// 的话，一个「点按钮即执行、对话框只是个通知」的实现同样能全绿。
//
// 本地改动刻意做成**两处**：一次改名（可从标题与服务端字段读出）+ 一个新节点
// （可从 definition.nodes 数出）。只改名的话，「副本带走了本地工作」这条断言会
// 退化成「副本被建出来了」——副本的名字本来就是我在对话框里填的。
//
// 判据取自源码单一事实源：
//   lib/workflow-editor-draft.ts:641-660     PUT 409 ⇒ phase='conflict'
//   components/workflow-editor/WorkflowDraftStatus.tsx:191-232  三个按钮
//   routes/workflows.edit.tsx:835-846        副本走 POST /api/workflows 并跳转

import { expect, test, type Page } from '@playwright/test'
import type { WorkflowDetail } from '@agent-workflow/shared'
import { randomBytes } from 'node:crypto'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
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

async function seedWorkflow(name: string): Promise<string> {
  const created = await api<{ id: string }>('/api/workflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 WF-44 conflict-recovery fixture',
      definition: { $schema_version: 3, inputs: [], nodes: [], edges: [] },
    }),
  })
  return created.id
}

async function readWorkflow(id: string): Promise<WorkflowDetail> {
  return api<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}`)
}

/** 服务端侧的「另一个人」：不经浏览器改名，把远端版本推进一格。 */
async function renameOnServer(id: string, name: string): Promise<void> {
  const current = await readWorkflow(id)
  await api(`/api/workflows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: current.version,
      clientMutationId: mutationId(),
      snapshot: { name, description: current.description, definition: current.definition },
    }),
  })
}

async function openEditor(page: Page, id: string, expectedName: string): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/workflows/${encodeURIComponent(id)}`)
  await expect(page.getByRole('heading', { level: 1, name: expectedName })).toBeVisible()
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
}

async function addReviewNode(page: Page): Promise<void> {
  await page.getByTestId('workflow-empty-add-first').click()
  const picker = page.getByTestId('workflow-node-picker-dialog')
  await expect(picker).toBeVisible()
  await picker.getByTestId('workflow-node-picker-item-kind-review').first().click()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  // 宽视口下检查器是常驻侧栏（不是 modalSurface==='inspector' 那个 Dialog），
  // 收起它才能让下面的冲突横幅与「更多操作」不被遮住。
  await page.locator('.inspector__close').click()
}

async function renameDraft(page: Page, name: string): Promise<void> {
  await page.getByTestId('workflow-more-actions').click()
  const actions = page.getByTestId('workflow-actions-dialog')
  await expect(actions).toBeVisible()
  await actions.getByTestId('workflow-rename-button').click()
  await expect(page.getByTestId('workflow-rename-dialog')).toBeVisible()
  await page.getByTestId('workflow-rename-name').fill(name)
  await page.getByTestId('workflow-rename-confirm').click()
  await expect(page.getByTestId('workflow-rename-dialog')).toBeHidden()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

interface ConflictFixture {
  id: string
  localName: string
  remoteName: string
}

/**
 * 把编辑器推进 conflict 相位：扣住本地第一次 PUT，期间在服务端把版本推进一格，
 * 再放行——服务端以 409 回绝那次基于旧版本的保存。
 */
async function enterConflict(page: Page): Promise<ConflictFixture> {
  const tag = `rfc319-wf44-${++sequence}`
  const id = await seedWorkflow(`${tag}-base`)
  const localName = `${tag}-local`
  const remoteName = `${tag}-remote`
  await openEditor(page, id, `${tag}-base`)

  const endpoint = `${daemon.baseUrl}/api/workflows/${encodeURIComponent(id)}`
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

  await addReviewNode(page)
  await firstSaveSeen.promise
  await renameDraft(page, localName)
  await renameOnServer(id, remoteName)
  release.resolve()

  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Version conflict')
  await page.unroute(endpoint)

  // 冲突当下的两边状态：本地握着改名 + 新节点，服务端只有别人的改名。
  await expect(page.getByRole('heading', { level: 1, name: localName })).toBeVisible()
  const server = await readWorkflow(id)
  expect(server.name).toBe(remoteName)
  expect(server.definition.nodes).toHaveLength(0)
  return { id, localName, remoteName }
}

async function cancelConfirm(page: Page, dialogName: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('冲突后「载入远端」：确认前什么都不做，确认后丢掉的是本地这一份', async ({ page }) => {
  const { id, localName, remoteName } = await enterConflict(page)

  // 二次确认必须真的挡住：打开再取消，两边都不许动。
  await page.getByRole('button', { name: 'Load remote', exact: true }).click()
  await cancelConfirm(page, 'Load the remote version?')
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Version conflict')
  await expect(page.getByRole('heading', { level: 1, name: localName })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  await page.getByRole('button', { name: 'Load remote', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Load the remote version?' })
  await dialog.getByRole('button', { name: 'Load remote and discard local changes' }).click()

  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await expect(page.getByRole('heading', { level: 1, name: remoteName })).toBeVisible()
  await expect(
    page.locator('.react-flow__node'),
    '载入远端之后本地新增的节点必须消失——留着它等于「载入」只换了个名字',
  ).toHaveCount(0)

  const server = await readWorkflow(id)
  expect(server.name, '载入远端不许反向把本地推上去').toBe(remoteName)
  expect(server.definition.nodes).toHaveLength(0)
})

test('冲突后「覆盖远端」：确认前服务端不动，确认后本地这一份成为服务端的版本', async ({ page }) => {
  const { id, localName, remoteName } = await enterConflict(page)

  await page.getByRole('button', { name: 'Overwrite remote', exact: true }).click()
  await cancelConfirm(page, 'Overwrite the remote version?')
  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Version conflict')
  const untouched = await readWorkflow(id)
  expect(untouched.name, '取消二次确认之后服务端仍必须是别人的那一版').toBe(remoteName)
  expect(untouched.definition.nodes).toHaveLength(0)

  await page.getByRole('button', { name: 'Overwrite remote', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Overwrite the remote version?' })
  await dialog.getByRole('button', { name: 'Overwrite remote', exact: true }).click()

  await expect(page.getByTestId('workflow-draft-phase')).toHaveText('Saved')
  await expect(page.getByRole('heading', { level: 1, name: localName })).toBeVisible()

  const server = await readWorkflow(id)
  expect(server.name).toBe(localName)
  expect(
    server.definition.nodes,
    '覆盖远端必须把本地的**全部**工作推上去，只推改名等于悄悄丢掉画布上的改动',
  ).toHaveLength(1)
})

test('冲突后「另存为副本」：本地工作原样落到新文档，原文档一个字节都不动', async ({ page }) => {
  const { id, remoteName } = await enterConflict(page)
  const copyName = `rfc319-wf44-copy-${sequence}`

  await page.getByRole('button', { name: 'Save as copy (recommended)', exact: true }).click()
  const dialog = page.getByTestId('workflow-copy-create-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('workflow-copy-create-name').fill(copyName)
  await dialog.getByTestId('workflow-copy-create-confirm').click()

  // 副本建成后编辑器跳到新文档；从 URL 拿它的 id 而不是靠列表里按名字找。
  await page.waitForURL(
    (url) => /\/workflows\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(id),
  )
  await expect(page.getByRole('heading', { level: 1, name: copyName })).toBeVisible()
  const copyId = page.url().split('/').pop() ?? ''
  expect(copyId).not.toBe(id)

  const copy = await readWorkflow(copyId)
  expect(copy.name).toBe(copyName)
  expect(
    copy.definition.nodes,
    '副本存在的理由就是「谁都不丢」——它必须带走本地画布上的改动',
  ).toHaveLength(1)

  const original = await readWorkflow(id)
  expect(original.name, '另存为副本是三条里唯一非破坏性的一条，原文档必须原样不动').toBe(remoteName)
  expect(original.definition.nodes).toHaveLength(0)
})
