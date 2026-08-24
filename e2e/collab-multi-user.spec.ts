// RFC-054 W2-4 — multi-user collaboration through TWO real browser contexts.
//
// LOCKS the end-to-end RBAC + WS-isolation story at the UI layer:
//   * Two simultaneous browser sessions for two different real users
//     (alice = admin, bob = regular user) only see what they're
//     authorized to see — and the WS event stream respects the boundary.
//   * Per-task channel updates fired by user A's task DO NOT arrive on
//     user B's browser unless they're explicitly granted visibility.
//     This is the most subtle leak path because the WS server's
//     channel-subscription gate is OFF the request thread and is easy
//     to regress.
//   * Admin sees all (`/tasks` lists alice's + bob's tasks under the
//     admin's session), regular user sees only their own.
//
// W1-5 already covers the API gate (cross-user 403); W2-4 lifts the
// same contract up to the browser, where the auth header is the session
// cookie / localStorage token and the WS subscribe handshake is the
// new attack surface.

import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'
import { initGitRepo, repoRemoteUrl } from './command'

let daemon: DaemonHandle
let repoDir: string
let seededCollabAgentId = ''

interface SeededUser {
  username: string
  sessionToken: string
  userId: string
  role: 'admin' | 'user'
}

async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user'
}): Promise<SeededUser> {
  const createRes = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  if (!createRes.ok) {
    throw new Error(`createUser ${opts.username}: ${createRes.status}`)
  }
  const { id } = (await createRes.json()) as { id: string }

  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  if (!loginRes.ok) throw new Error(`login ${opts.username}: ${loginRes.status}`)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken, role: opts.role }
}

async function makeResourcePublic(resource: 'agents' | 'workflows', id: string): Promise<void> {
  const res = await fetch(`${daemon.baseUrl}/api/${resource}/${id}/acl`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      visibility: 'public',
      expectedResourceId: id,
      expectedAclRevision: 0,
    }),
  })
  if (!res.ok) {
    throw new Error(`publish ${resource}/${id}: ${res.status} ${await res.text().catch(() => '')}`)
  }
}

async function seedWorkflow(): Promise<{ workflowId: string; agentName: string }> {
  const headers = {
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  }
  const agentName = 'collab-agent'
  if (seededCollabAgentId === '') {
    const agentRes = await fetch(`${daemon.baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: agentName,
        description: 'collab e2e agent',
        outputs: ['answer'],
        readonly: true,
        bodyMd: '',
      }),
    })
    if (!agentRes.ok) throw new Error(`seed agent: ${agentRes.status}`)
    seededCollabAgentId = ((await agentRes.json()) as { id: string }).id
    await makeResourcePublic('agents', seededCollabAgentId)
  }
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'collab-wf',
      description: 'collab e2e',
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
        nodes: [
          { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
          {
            id: 'agent_1',
            kind: 'agent-single',
            agentId: seededCollabAgentId,
            agentName,
            promptTemplate: 'Echo {{topic}}.',
            position: { x: 320, y: 0 },
          },
          {
            id: 'out_1',
            kind: 'output',
            ports: [{ name: 'answer', bind: { nodeId: 'agent_1', portName: 'answer' } }],
            position: { x: 640, y: 0 },
          },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 'in_1', portName: 'topic' },
            target: { nodeId: 'agent_1', portName: 'topic' },
          },
          {
            id: 'e2',
            source: { nodeId: 'agent_1', portName: 'answer' },
            target: { nodeId: 'out_1', portName: 'answer' },
          },
        ],
      },
    }),
  })
  if (!wfRes.ok) throw new Error(`seedWorkflow: ${wfRes.status}`)
  const { id } = (await wfRes.json()) as { id: string }
  await makeResourcePublic('workflows', id)
  return { workflowId: id, agentName }
}

async function createTaskAsUser(
  user: SeededUser,
  workflowId: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      workflowId,
      repoUrl: repoRemoteUrl(repoDir),
      ref: 'main',
      inputs: { topic: 'collab-test' },
    }),
  })
  if (!res.ok) throw new Error(`createTask as ${user.username}: ${res.status}`)
  const body = (await res.json()) as { id: string }
  return body.id
}

async function primeAuthForContext(ctx: BrowserContext, user: SeededUser): Promise<void> {
  // Each context isolates its own localStorage, so we seed via
  // addInitScript that fires before the SPA mounts.
  await ctx.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: user.sessionToken },
  )
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(async () => {
  seededCollabAgentId = ''
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-collab-'))
  writeFileSync(join(repoDir, 'README.md'), '# collab fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (repoDir !== undefined) {
    try {
      rmSync(repoDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('two browsers, two users: each only sees their own task on /tasks (admin sees both)', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice-collab',
    password: 'AliceCollabPass#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab',
    password: 'BobCollabPass#1',
    role: 'user',
  })
  const wf = await seedWorkflow()

  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-task')
  const bobTaskId = await createTaskAsUser(bob, wf.workflowId, 'bob-task')

  // Two contexts = two isolated browsers (different localStorage, different
  // cookies, different WS connections).
  const ctxAlice = await browser.newContext()
  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxAlice, alice)
  await primeAuthForContext(ctxBob, bob)

  const aPage = await ctxAlice.newPage()
  const bPage = await ctxBob.newPage()

  // Alice (admin) visits /tasks — sees BOTH tasks.
  await aPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(aPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
  // Wait for the table to populate; the row count reflects the API call.
  await expect(aPage.getByText('alice-task').first()).toBeVisible()
  await expect(aPage.getByText('bob-task').first()).toBeVisible()

  // Bob (regular user) visits /tasks — sees ONLY his task.
  await bPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(bPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()
  await expect(bPage.getByText('bob-task').first()).toBeVisible()
  // Negative — alice's task name should NOT appear anywhere in bob's view.
  await expect(bPage.getByText('alice-task')).toHaveCount(0)

  await ctxAlice.close()
  await ctxBob.close()

  // Sanity — also verify directly via API that the tasks exist for the
  // record (this is the contract W1-5 already locked, repeated here so
  // a future API change doesn't silently make this UI test pass on
  // shared visibility regressions).
  expect(aliceTaskId).toBeTruthy()
  expect(bobTaskId).toBeTruthy()
})

test("two browsers, two users: bob CANNOT navigate to alice's task detail (403)", async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice-collab-2',
    password: 'AliceCollab2#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab-2',
    password: 'BobCollab2#1',
    role: 'user',
  })
  const wf = await seedWorkflow()
  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-detail-task')

  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxBob, bob)
  const bPage = await ctxBob.newPage()

  // Hard-navigate to alice's task detail. The page should refuse — either
  // by redirecting to an error / unauthorized view, or by showing an
  // explicit 403 / "not found" state. Both are acceptable; we just need
  // to confirm the task content is NOT rendered.
  await bPage.goto(`${daemon.baseUrl}/tasks/${aliceTaskId}`)
  // Wait for any of: a 403 message, the task list redirect, or a
  // "not found" indicator. The exact UX may evolve; the negative
  // assertion is: the task NAME doesn't render anywhere on bob's view.
  await bPage.waitForLoadState('networkidle')
  await expect(bPage.getByText('alice-detail-task')).toHaveCount(0)

  await ctxBob.close()
})

test('/ws/tasks list channel filters per-frame by canViewTask (post-fix)', async ({ browser }) => {
  // Post-fix (RFC-054 W2-4 KNOWN_GAP resolved): the WS server now runs
  // a per-frame canViewTask gate against the subscriber's actor. Bob's
  // /ws/tasks subscription must NOT receive frames mentioning alice's
  // task id — server-side dropping happens before send, so the bytes
  // never cross the wire.
  //
  // See packages/backend/src/ws/server.ts handleOpen('tasks-list') for
  // the gate + extractTaskIdFromListMessage for the per-message taskId
  // extraction (drops unknown-shape variants by default).
  const alice = await createUserAndLogin({
    username: 'alice-collab-3',
    password: 'AliceCollab3#1',
    role: 'admin',
  })
  const bob = await createUserAndLogin({
    username: 'bob-collab-3',
    password: 'BobCollab3#1',
    role: 'user',
  })
  const wf = await seedWorkflow()

  const ctxBob = await browser.newContext()
  await primeAuthForContext(ctxBob, bob)
  const bPage = await ctxBob.newPage()

  // Capture every WS frame received by bob's page.
  const wsFrames: Array<{ url: string; payload: string }> = []
  bPage.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : ''
      if (text.length > 0) wsFrames.push({ url: ws.url(), payload: text })
    })
  })

  await bPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(bPage.getByRole('heading', { name: /tasks/i }).first()).toBeVisible()

  const aliceTaskId = await createTaskAsUser(alice, wf.workflowId, 'alice-ws-task')
  await bPage.waitForTimeout(2000)

  const leakingFrames = wsFrames.filter((f) => f.payload.includes(aliceTaskId))
  expect(leakingFrames).toHaveLength(0)

  await ctxBob.close()
})

// ⚠️ RFC-319 T34（审计条目 TASK-32）—— 任务成员面板此前**从未被打开过**。
//
// 全仓 `rg task-members e2e/` 只有一处命中：`visual-regression.spec.ts:1993` 的一行
// `toBeVisible`，而且它嵌在一个截图用例（RFC-199 动态工作流预览）里，是顺手加的
// 存在性锚，与成员管理无关。对话框从没被打开、`members-save` 从没被点、转让所有权
// 从没被跑过。
//
// 成员即权限边界：任务成员（owner + collaborator）就是评审 / 反问的回答权范围
// （CLAUDE.md §Resource ACL）。这条边界坏了，症状是「别人能回答我的评审」或
// 「我的协作者看不见任务」，两者都不会有任何报错。
test('RFC-319: task owner grants a collaborator through the members panel, then transfers ownership', async ({
  browser,
}) => {
  const carol = await createUserAndLogin({
    username: 'carol-members',
    password: 'CarolMembersPass#1',
    role: 'user',
  })
  const dave = await createUserAndLogin({
    username: 'dave-members',
    password: 'DaveMembersPass#1',
    role: 'user',
  })
  const wf = await seedWorkflow()
  const taskId = await createTaskAsUser(carol, wf.workflowId, 'carol-members-task')

  const ctxCarol = await browser.newContext()
  const ctxDave = await browser.newContext()
  await primeAuthForContext(ctxCarol, carol)
  await primeAuthForContext(ctxDave, dave)
  const cPage = await ctxCarol.newPage()
  const dPage = await ctxDave.newPage()

  const membersOf = async (token: string) => {
    const res = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: res.status, body: res.ok ? await res.json() : null }
  }

  // 起点：dave 完全看不见这个任务（任务是成员制私有模型）。
  await dPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(dPage.getByText('carol-members-task')).toHaveCount(0)
  expect((await membersOf(dave.sessionToken)).status).not.toBe(200)

  // carol 打开成员面板，把 dave 加成协作者。
  await cPage.goto(`${daemon.baseUrl}/tasks/${taskId}`)
  await cPage.getByTestId('task-members-dialog-button').click()
  const panel = cPage.getByTestId('task-members-panel')
  await expect(panel).toBeVisible()
  // 面板的 UserPicker onChange 里有一句 `if (!sessionIsCurrent()) return`——会话还没
  // 落定时**静默丢弃**用户的选择，症状是「选了但保存按钮一直灰着」。满载并行下这个
  // 窗口是真实存在的（这条用例单跑绿、全量跑红，就是这么红的）。
  // `members-transfer-owner` 只在 canManage 为真时渲染，用它当就绪信号。
  await expect(panel.getByTestId('members-transfer-owner')).toBeVisible()
  await panel.getByTestId('members-users-input').click()
  await panel.getByTestId('members-users-input').fill('dave')
  // 结果列表被 portal 到 document.body（原本的 in-panel 下拉会被 .dialog__body 的
  // 滚动区裁掉、点不到——`rfc099-ownership-acl.spec.ts:190-193` 的注释记着这个用户
  // 报过的「搜索用户无法点击」缺陷）。所以选项要从 page 而不是 panel 子树里找。
  await cPage.getByTestId(`members-users-option-${dave.username}`).click()
  // 选择真的落进了 chip（而不是被上面那条早退悄悄丢掉）——这一步把「静默丢弃」
  // 从一个 flaky 的超时变成一条说得清的失败。
  await expect(cPage.getByTestId(`members-users-remove-${dave.username}`)).toBeVisible()
  // 结果列表是 portal 出来的，且**会盖住 Save 按钮**——用户越多列表越长，覆盖越确定
  // （这条用例单跑时库里只有两三个用户、列表短，所以隔离跑绿、全量跑红）。
  // UserPicker 对 Dialog 内的第一个 Escape 做了 stopPropagation，专门用来只关列表
  // 不关弹窗（UserPicker.tsx:181-188），正好是这里要的。
  await panel.getByTestId('members-users-input').press('Escape')
  await expect(cPage.getByRole('listbox')).toHaveCount(0)
  await panel.getByTestId('members-save').click()

  // 服务端真的记住了（不是只改了本地 state）。
  await expect
    .poll(async () => {
      const { body } = (await membersOf(carol.sessionToken)) as {
        body: { users?: Array<{ id: string }> } | null
      }
      return (body?.users ?? []).map((u) => u.id).includes(dave.userId)
    })
    .toBe(true)

  // 于是 dave 看见了这个任务，并且能打开它的详情。
  await dPage.goto(`${daemon.baseUrl}/tasks`)
  await expect(
    dPage.getByText('carol-members-task').first(),
    '加成协作者之后对方仍然看不到任务 ⇒ 成员制没有真正生效',
  ).toBeVisible()
  await dPage.goto(`${daemon.baseUrl}/tasks/${taskId}`)
  await expect(dPage.locator('.error-box')).toHaveCount(0)

  // carol 把所有权转给 dave（带二次确认的独立弹窗）。
  await cPage.reload()
  await cPage.getByTestId('task-members-dialog-button').click()
  await expect(cPage.getByTestId('task-members-panel')).toBeVisible()
  await cPage.getByTestId('members-transfer-owner').click()
  await cPage.getByTestId('members-transfer-input').click()
  await cPage.getByTestId('members-transfer-input').fill('dave')
  await cPage.getByTestId(`members-transfer-option-${dave.username}`).click()
  await cPage.getByTestId('members-transfer-confirm').click()

  await expect
    .poll(async () => {
      const { body } = (await membersOf(dave.sessionToken)) as {
        body: { ownerUserId?: string | null } | null
      }
      return body?.ownerUserId ?? null
    })
    .toBe(dave.userId)

  await ctxCarol.close()
  await ctxDave.close()
})
