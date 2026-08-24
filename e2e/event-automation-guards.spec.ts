// RFC-319 B6 —— 事件自动化的拒绝分支与凭据止血（EVENT-02/09/27/35）。
//
// 打头的 EVENT-35 是本轮审计里**唯一一条直接违反 CLAUDE.md 硬规则**的：
// 「凡以安全 / 隔离为由关闭或收缩能力的分支，每条禁用 / 拒绝分支必须有测试覆盖」。
// `event-center` 的 `scripts:author` 拒绝分支有 **5 处**
// （eventCenter.ts:316 / 339 / 359 / 381 / 401，对应创建 / 读 / 改 / 校验 / 发布），
// 而 `scripts-author-required` 在全仓 grep **零命中**。
//
// 这五处守的是「谁能往平台里写会被执行的宿主代码」——权限目录里 `scripts:author`
// 明确不给任何 PAT（RFC-253 AC-26），因为它是宿主代码执行能力。守卫失效的后果不是
// 报错，是一个普通用户可以往轮询观察器里塞任意程序。
//
// 判据必须**逐条**打这五个端点：只测其中一个不能说明另外四个还在（它们是五段各自
// 独立的 `if (!actor.permissions.has(...))`，删掉任何一段都不会影响其余四段）。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(90_000)

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

/**
 * 一条**完整**的 GitLab Pipeline Hook 事件体。
 *
 * 只带 path_with_namespace 是不够的：入口会以
 * `webhook-delivery-unsupported: missing project fields` 拒收，于是用例根本走不到
 * 它想测的那一段语义（实测撞出来的）。
 */
const PIPELINE_BODY = JSON.stringify({
  object_kind: 'pipeline',
  user: { username: 'rfc319-operator' },
  project: {
    path_with_namespace: 'rfc319/guard-fixture',
    web_url: 'https://gitlab.invalid/rfc319/guard-fixture',
    git_http_url: 'https://gitlab.invalid/rfc319/guard-fixture.git',
    git_ssh_url: 'git@gitlab.invalid:rfc319/guard-fixture.git',
  },
  object_attributes: {
    id: 319,
    ref: 'main',
    status: 'failed',
    sha: '319319',
    url: 'https://gitlab.invalid/rfc319/guard-fixture/-/pipelines/319',
  },
})

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

/** 建一个账号并登录，可显式指定额外权限（不走角色预设）。 */
async function userWith(
  extra: readonly string[],
  role: 'user' | 'admin' = 'user',
): Promise<string> {
  const username = `rfc319-ev-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role,
        password: 'Rfc319EventPass!1',
        additionalPermissions: extra,
      }),
    }),
    `seed user ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Rfc319EventPass!1' }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

// ---------------------------------------------------------------------------
// EVENT-35 —— scripts:author 的五处拒绝分支
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-35: all five scripts:author refusals fire for an actor that holds the event-source permissions but not scripts:author', async () => {
  // 这个账号必须**有** `event-sources:*`、**没有** `scripts:author`：路由级权限门先跑，
  // 门不放行的话请求根本走不到处理器里那五段 `if (!actor.permissions.has(...))`，
  // 拿到的会是通用 403——用例看起来绿，实测什么都没锁。
  // 普通 `user` 角色正好是这个形状（显式再授 `event-sources:*` 反而会被判
  // `user-permission-redundant`）。
  const session = await userWith([])

  const attempts: Array<{ what: string; res: Response }> = [
    {
      what: 'POST /sources（创建草稿）',
      res: await req(
        '/api/event-center/sources',
        { method: 'POST', body: JSON.stringify({ name: 'rfc319-denied' }) },
        session,
      ),
    },
    {
      what: 'GET /sources/:id（读程序）',
      res: await req('/api/event-center/sources/rfc319-nope', undefined, session),
    },
    {
      what: 'PUT /sources/:id（改程序）',
      res: await req(
        '/api/event-center/sources/rfc319-nope',
        { method: 'PUT', body: JSON.stringify({ name: 'rfc319-denied' }) },
        session,
      ),
    },
    {
      what: 'POST /sources/:id/validate（跑样例）',
      res: await req(
        '/api/event-center/sources/rfc319-nope/validate',
        { method: 'POST', body: JSON.stringify({}) },
        session,
      ),
    },
    {
      what: 'POST /sources/:id/publish（发布不可变版本）',
      res: await req(
        '/api/event-center/sources/rfc319-nope/publish',
        { method: 'POST', body: JSON.stringify({}) },
        session,
      ),
    },
  ]

  const offenders: string[] = []
  for (const attempt of attempts) {
    const body = await attempt.res.text()
    if (attempt.res.status !== 403 || !body.includes('scripts-author-required')) {
      offenders.push(`${attempt.what} → ${attempt.res.status} ${body.slice(0, 160)}`)
    }
  }
  expect(
    offenders,
    'scripts:author 的拒绝分支没有全部生效。它守的是「谁能往平台里写会被执行的宿主代码」——' +
      '权限目录明确不把它给任何 PAT（RFC-253 AC-26）。五段是各自独立的判断，' +
      '删掉任何一段都不会影响其余四段，所以必须逐条打',
  ).toEqual([])

  // 反向对照：拿着 `scripts:author` 的账号在同一个端点上**不会**撞这堵墙。
  // 没有这一条，上面五条可能只是因为「这些端点对谁都 403」。
  const authorized = await userWith([], 'admin')
  const allowed = await req(
    '/api/event-center/sources',
    { method: 'POST', body: JSON.stringify({ name: `rfc319-allowed-${++sequence}` }) },
    authorized,
  )
  const allowedBody = await allowed.text()
  expect(
    allowedBody.includes('scripts-author-required'),
    '持有 scripts:author 的账号也被那条分支拦下 ⇒ 上面五条证明不了针对性',
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// EVENT-02 + EVENT-09 —— 凭据轮换与验签拒绝
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-02/09: rotating the secret kills the old signature, and a rejected delivery is audited without consuming the dedup slot', async () => {
  const endpoint = await jsonOf<{ id: string; urlToken: string; secret: string }>(
    await req('/api/webhook-endpoints', {
      method: 'POST',
      body: JSON.stringify({ name: `rfc319-rotate-${++sequence}` }),
    }),
    'create endpoint',
  )

  const uuid = `rfc319-dedup-${sequence}`
  const deliver = async (secret: string, eventUuid: string): Promise<Response> =>
    fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': secret,
        'x-gitlab-event': 'Pipeline Hook',
        'x-gitlab-event-uuid': eventUuid,
      },
      body: PIPELINE_BODY,
    })

  // EVENT-09 —— 错 token：401，且**不占去重位**。
  // 后半条是要害：如果被拒的投递也占了那个 UUID，攻击者只要用错误签名抢先发一次，
  // 真正的那条投递就会被当成重复丢掉——一个不需要任何凭据的拒绝服务。
  const rejected = await deliver('definitely-not-the-secret', uuid)
  expect(rejected.status, `错 token 的投递没有被拒：${await rejected.text()}`).toBe(401)

  const accepted = await deliver(endpoint.secret, uuid)
  const acceptedBody = await jsonOf<{ status: string }>(accepted, 'accepted delivery')
  expect(
    acceptedBody.status,
    '同一个 UUID 先被错签名投递过一次，随后合法投递就被当成重复丢掉了 ⇒ ' +
      '任何人都能用一次无凭据的请求把真实事件挤掉',
  ).not.toBe('duplicate')

  // 拒绝确实留下了审计行（而不是被静默丢弃）。
  const audit = await jsonOf<Array<{ status?: string }> | { rows?: Array<{ status?: string }> }>(
    await req('/api/webhook-deliveries?status=rejected'),
    'rejected deliveries',
  )
  expect(
    JSON.stringify(audit),
    '被拒的投递没有留下任何审计行 ⇒ 「有人在拿错凭据打我们」这件事完全不可见',
  ).toContain('rejected')

  // EVENT-02 —— 轮换 secret：旧的立刻失效、新的可用。
  // 这是凭据泄露之后唯一的止血手段；轮换后旧 secret 仍能过验签的话，泄露就永远收不回来。
  const rotated = await jsonOf<{ secret: string }>(
    await req(`/api/webhook-endpoints/${endpoint.id}/rotate-secret`, { method: 'POST' }),
    'rotate secret',
  )
  expect(rotated.secret, '轮换没有给出新的明文 secret').toBeTruthy()
  expect(rotated.secret).not.toBe(endpoint.secret)

  const withOld = await deliver(endpoint.secret, `${uuid}-after-rotate-old`)
  expect(withOld.status, '轮换之后旧 secret 仍然能过验签 ⇒ 泄露收不回来').toBe(401)
  const withNew = await deliver(rotated.secret, `${uuid}-after-rotate-new`)
  expect(withNew.status, `轮换之后新 secret 不能用：${await withNew.text()}`).toBe(200)
})

// ---------------------------------------------------------------------------
// EVENT-27 —— 投递重放
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-27: replaying a delivery is possible for an accepted row and refused for a rejected one', async () => {
  const endpoint = await jsonOf<{ id: string; urlToken: string; secret: string }>(
    await req('/api/webhook-endpoints', {
      method: 'POST',
      body: JSON.stringify({ name: `rfc319-replay-${++sequence}` }),
    }),
    'create endpoint',
  )
  const deliver = async (secret: string, eventUuid: string): Promise<Response> =>
    fetch(`${daemon.baseUrl}/webhooks/gitlab/${endpoint.urlToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': secret,
        'x-gitlab-event': 'Pipeline Hook',
        'x-gitlab-event-uuid': eventUuid,
      },
      body: PIPELINE_BODY,
    })

  const ok = await jsonOf<{ deliveryId: string }>(
    await deliver(endpoint.secret, `rfc319-replay-ok-${sequence}`),
    'accepted delivery',
  )
  await deliver('wrong-secret', `rfc319-replay-bad-${sequence}`)

  // replay 是平台侧唯一的主恢复路径——GitLab 对失败的投递不会重投。
  const replayed = await req(`/api/webhook-deliveries/${ok.deliveryId}/replay`, { method: 'POST' })
  expect(
    replayed.status,
    `已接收的投递重放不了 ⇒ 平台侧没有恢复手段：${await replayed.text()}`,
  ).toBeLessThan(400)

  // 不存在的投递不能重放，且与「无权访问」同形——replay 是个写操作，
  // 它的存在性回声会把「哪些投递 id 是真的」泄露出去。
  const ghost = await req('/api/webhook-deliveries/01JZZZZZZZZZZZZZZZZZZZZZZZ/replay', {
    method: 'POST',
  })
  expect(ghost.ok, '不存在的投递也能重放').toBe(false)
})
