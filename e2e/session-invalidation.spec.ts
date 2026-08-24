// RFC-319 B19 —— 会话在页面开着的时候失效（UX-08）。
//
// 这条锁的是**用户正看着页面时凭据被撤销**会发生什么。两种形态，处置必须不同：
//
//   * 4401 / HTTP 401 —— 凭据本身死了（会话被吊销 / 账号被停用）。继续拿它重连
//     就是一个 30 秒一次的静默循环：页面看着还在，数据永远不再更新，而用户
//     完全不知道自己已经掉线了。正确处置是清掉 token、回登录页。
//   * 4403 —— **凭据还有效，只是这条通道要的权限被收回了**。这时把人踢去登录
//     是错的（他还能用系统的其它部分）；正确处置是让权威（`/me`）失效重取，
//     订阅方自己停订。
//
// 这两条 RFC-212 / RFC-312 都各自栽过一次，注释写在 `hooks/useWebSocket.ts:40-54`：
// 早先只认 4401，4403 落进默认分支一路重连，叠加控制帧可能被丢，结果是永久
// 403 循环且 `/me` 永不刷新。所以判据要**分别**打，不能合成一条「会掉线」。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const PASSWORD = 'Rfc319SessionPass!1'

let daemon: DaemonHandle
let repoDir: string
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
  repoDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-session-repo-'))
  writeFileSync(join(repoDir, 'README.md'), '# rfc319 session fixture\n', 'utf-8')
  initGitRepo(repoDir)
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(repoDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function primeToken(page: Page, token: string): Promise<void> {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

interface SeededUser {
  id: string
  username: string
  token: string
}

async function seedUser(): Promise<SeededUser> {
  const username = `rfc319-session-${++sequence}`
  const created = await jsonOf<{ id: string }>(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return { id: created.id, username, token: sessionToken }
}

// ---------------------------------------------------------------------------
// UX-08 ① —— 凭据死了：清 token + 回登录
// ---------------------------------------------------------------------------

test('RFC-319 UX-08: when the credential dies mid-session the app clears it and returns to sign-in instead of reconnecting forever', async ({
  page,
}) => {
  const user = await seedUser()
  await primeToken(page, user.token)

  // 页面开着、WS 连着。`/memory` 是全站少数几个显式建订阅的路由之一。
  await page.goto(`${daemon.baseUrl}/memory`)
  await expect(page.getByRole('heading', { name: /memory/i }).first()).toBeVisible({
    timeout: 30_000,
  })
  expect(
    await page.evaluate(() => window.localStorage.getItem('agent-workflow.token')),
    '前提：页面得先是登录态',
  ).toBe(user.token)

  // 从管理档把这个账号停用 —— 已发出的会话立刻作废（HTTP 401 + WS 4401）。
  await jsonOf(
    await req(`/api/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    }),
    'disable the user',
  )

  // 触发一次真实的前台请求：导航到另一个页面即可。
  await page.goto(`${daemon.baseUrl}/agents`)

  // 判据一：token 被清掉。留着它就是那个静默重连循环的燃料。
  await expect
    .poll(async () => page.evaluate(() => window.localStorage.getItem('agent-workflow.token')), {
      timeout: 30_000,
      message:
        '凭据已经死了，前端却还留着它 ⇒ 页面看着还在、数据永不更新，' +
        '而用户完全不知道自己已经掉线',
    })
    .toBeNull()

  // 判据二：人回到了登录入口，而不是停在一个空白的业务页上。
  await expect
    .poll(async () => new URL(page.url()).pathname, {
      timeout: 30_000,
      message: '清了 token 却没有回登录页 ⇒ 用户对着一个再也不会有数据的界面',
    })
    .toContain('/auth')
})

// ---------------------------------------------------------------------------
// UX-08 ② —— 凭据还活着、只是权限被收回：不许把人踢去登录
// ---------------------------------------------------------------------------

test('RFC-319 UX-08: a 4403 close means the credential is still good — the user keeps their session instead of being signed out', async ({
  page,
}) => {
  // 这一条是上一条的**反面**，两条必须同时成立才算这个能力做对了。
  // 只写「会掉线」的话，把 4403 也当成 4401 处理同样能通过——而那正是
  // RFC-312 修掉的那个 bug 的镜像。
  //
  // 4403 的真实触发点只有一个：`ws/registry.ts:620` 里 **task 频道**声明了
  // `rerunUpgradeGate: true`。把人从任务成员里摘掉，服务端会对**已经连着的**
  // 那条 socket 重跑上门门禁并以 4403 关闭（`ws/connections.ts:194-208`）。
  // 第一版拿 presence 通道构造，那个频道**不**重跑门禁 —— 用例因此什么也没
  // 观察到、变异实证下仍然绿（一条教科书式的空洞绿，当场作废重写）。
  //
  // 变异实证：把 `useWebSocket.ts:223` 的 4403 分支换成 `clearToken()`（也就是
  // 「当成 4401 处理」，RFC-312 修掉的那个 bug 的原样），这条用例转红。
  const user = await seedUser()

  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-session-wf-${++sequence}`,
        description: 'RFC-319 session invalidation fixture',
        definition: {
          $schema_version: 3,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'echo', bind: { nodeId: 'in_1', portName: 'topic' } }],
              position: { x: 320, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_out',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'out_1', portName: 'echo' },
            },
          ],
        },
      }),
    }),
    'seed workflow',
  )
  const task = await jsonOf<{ id: string }>(
    await req('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-session-task-${sequence}`,
        workflowId: workflow.id,
        repoUrl: repoRemoteUrl(repoDir),
        ref: 'main',
        inputs: { topic: 'x' },
      }),
    }),
    'launch task',
  )
  await jsonOf(
    await req(`/api/tasks/${task.id}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [user.id] }),
    }),
    'add the user as a task member',
  )

  await primeToken(page, user.token)
  await page.goto(`${daemon.baseUrl}/tasks/${task.id}`)
  // 页面真的打开了 ⇒ `/ws/tasks/:id` 这条订阅确实建起来了，4403 才有对象。
  await expect(page.getByText(`rfc319-session-task-${sequence}`).first()).toBeVisible({
    timeout: 30_000,
  })

  // 把他从成员里摘掉：凭据一动没动，只是这条通道的门禁不再放行。
  await jsonOf(
    await req(`/api/tasks/${task.id}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [] }),
    }),
    'remove the user from the task',
  )

  // 给关闭帧与权威刷新留出时间，然后断言**两件事都没发生**。
  await page.waitForTimeout(3000)
  expect(
    await page.evaluate(() => window.localStorage.getItem('agent-workflow.token')),
    '只是失去了一个任务的访问权，凭据却被清掉了 ⇒ 用户被踢出他仍然有权使用的整个系统',
  ).toBe(user.token)
  expect(new URL(page.url()).pathname, '权限收窄把人赶去了登录页').not.toContain('/auth')

  // 而且系统其余部分照常可用。
  await page.goto(`${daemon.baseUrl}/agents`)
  await expect(page.getByRole('heading', { name: /agents/i }).first()).toBeVisible({
    timeout: 30_000,
  })
})
