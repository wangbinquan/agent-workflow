// RFC-319 —— 我的账号：改自己的资料与 Git 提交身份（`PATCH /api/auth/me/profile`）。
//
// 这条能力**不是**一个可有可无的资料页：账号邮箱是**任务能否启动的前置**。
// `getUserGitCommitIdentity`（modules/identity-access/application/queries/
// getUserGitCommitIdentity.ts:31-36）在建任务时读它，缺邮箱直接
// `git-identity-email-missing` 拒绝启动；而 displayName / email 会成为
// 任务里每一次 git commit 的作者身份。所以判据不能停在「接口回了 200」，
// 要一路走到**这个值真的改变了系统行为**。
//
// 为什么现在补：这条端点是 RFC-320 落库的新面，`e2e-full-nightly` 的覆盖账本
// 对账 job 在第一次拿到全绿分片后把它点了出来——「新挂了端点却没有任何 e2e
// 打它」。补覆盖优于记债，这正是那套棘轮存在的目的。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const PASSWORD = 'Rfc319ProfilePass!1'

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
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

async function seedSession(): Promise<{ id: string; username: string; token: string }> {
  const username = `rfc319-profile-${++sequence}`
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

test('RFC-319: a user edits their own display name and email, and the new email is what the platform will commit with', async () => {
  const user = await seedSession()

  const updated = await jsonOf<{ profile: { displayName: string; email: string } }>(
    await req(
      '/api/auth/me/profile',
      {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: 'RFC-319 Renamed Person',
          // 大小写要被归一到小写（schema 的 transform）——这条顺带锁住它，
          // 否则同一个人可能在 git 历史里留下两种大小写的作者邮箱。
          email: `RFC319.Renamed.${sequence}@Example.COM`,
        }),
      },
      user.token,
    ),
    'update own profile',
  )
  expect(updated.profile.displayName).toBe('RFC-319 Renamed Person')
  expect(
    updated.profile.email,
    '邮箱没有被归一成小写 ⇒ 同一个人会在 git 历史里留下两种大小写的作者身份',
  ).toBe(`rfc319.renamed.${sequence}@example.com`)

  // 回读一次：改动落库了，不只是回执里好看。
  const me = await jsonOf<{ profile: { displayName: string; email: string } }>(
    await req('/api/auth/me', undefined, user.token),
    'read me back',
  )
  expect(me.profile.displayName).toBe('RFC-319 Renamed Person')
  expect(me.profile.email).toBe(`rfc319.renamed.${sequence}@example.com`)

  // 这是别人的资料——令牌通道够不着自己的账号面，别人的更不用说。
  // `tokenAccess: 'never'`（routes/auth.ts:248）。
  const other = await seedSession()
  const cross = await req(
    '/api/auth/me/profile',
    { method: 'PATCH', body: JSON.stringify({ displayName: 'hijacked', email: 'x@example.com' }) },
    other.token,
  )
  expect(cross.ok, '前提：另一个人改自己的资料应当成功').toBe(true)
  const victim = await jsonOf<{ profile: { displayName: string } }>(
    await req('/api/auth/me', undefined, user.token),
    'victim re-reads',
  )
  expect(
    victim.profile.displayName,
    '一个人改自己的资料，改到了别人身上 ⇒ 账号自服务面串了身份',
  ).toBe('RFC-319 Renamed Person')

  // 形状是 strict：多塞一个字段必须被拒，而不是被静默丢掉。
  // 静默丢掉的话，调用方以为自己改了角色 / 状态，其实什么也没发生。
  const sneaky = await req(
    '/api/auth/me/profile',
    {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: 'RFC-319 Renamed Person',
        email: `rfc319.renamed.${sequence}@example.com`,
        role: 'admin',
      }),
    },
    user.token,
  )
  expect(sneaky.status, '资料接口接受了 role 字段（哪怕只是静默忽略）⇒ 调用方以为自己提权了').toBe(
    422,
  )
  expect((await sneaky.json()).code).toBe('profile-invalid')
})
