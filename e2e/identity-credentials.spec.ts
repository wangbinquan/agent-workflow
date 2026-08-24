// RFC-319 B9 —— 凭据与归属的四条 P1（IAM-12/13/27/32）。
//
// 这四条共享一个特征：**改完之后界面上看不出区别**，只有下一个人拿旧凭据来敲门时
// 才知道有没有生效。
//
//   * 改密 / 重置密码若没有真的吊销其它会话，被盗的会话在改密之后照样活着——
//     而用户以为自己已经把入侵者踢出去了（这正是他改密的**唯一目的**）。
//   * 关闭密码登录若只改了设置页上的开关、没在登录端点上生效，管理员以为自己
//     收紧了入口，实际大门还开着。
//   * 所有者转让若只写了一行归属、没真的移交管理权，原所有者仍能改 ACL，
//     而新所有者以为东西已经归自己了。
//
// 判据取自源码单一事实源：
//   `POST /api/auth/change-password`（routes/auth.ts:274，含 revokeAllSessionsForUser）
//   `POST /api/users/:id/reset-password` → `resetPassword`（services/users.ts:129）
//   `PUT /api/oidc/login-policy` + `routes/auth.ts:85` 的 password-login-disabled
//   `PUT /api/{resource}/:id/acl` 的 ownerUserId（schemas/resourceAcl.ts:169）

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

const PASSWORD = 'Rfc319CredentialPass!1'

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

interface SeededUser {
  id: string
  username: string
}

async function seedUser(label: string): Promise<SeededUser> {
  const username = `rfc319-${label}-${++sequence}`
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
  return { id: created.id, username }
}

async function login(username: string, password: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

async function loginToken(username: string, password: string): Promise<string> {
  const res = await login(username, password)
  return (await jsonOf<{ sessionToken: string }>(res, `login ${username}`)).sessionToken
}

/** 会话还活着吗。用账号自查面，它对会话恒可达、对已吊销的会话回 401。 */
async function sessionAlive(token: string): Promise<boolean> {
  return (await req('/api/auth/me', undefined, token)).ok
}

// ---------------------------------------------------------------------------
// IAM-13 —— 改自己的密码：踢掉其它会话，旧密码立即失效
// ---------------------------------------------------------------------------

test('RFC-319 IAM-13: changing your own password kills every other session and retires the old password', async () => {
  const user = await seedUser('selfpw')
  const sessionA = await loginToken(user.username, PASSWORD)
  const sessionB = await loginToken(user.username, PASSWORD)
  expect(await sessionAlive(sessionA)).toBe(true)
  expect(await sessionAlive(sessionB)).toBe(true)

  // 旧密码不对 ⇒ 拒绝。没有这条，「改密」就变成了任何持有会话的人都能做的事，
  // 而会话恰恰是最可能被偷走的那个东西。
  const wrongOld = await req(
    '/api/auth/change-password',
    {
      method: 'POST',
      body: JSON.stringify({ oldPassword: 'not-the-password', newPassword: 'Rfc319Rotated!2' }),
    },
    sessionA,
  )
  expect(wrongOld.status, '旧密码错了也放行 ⇒ 偷到会话就等于偷到账号').toBe(403)
  expect((await wrongOld.json()).code).toBe('old-password-mismatch')

  const rotated = 'Rfc319Rotated!2'
  const changed = await jsonOf<{ sessionToken?: string }>(
    await req(
      '/api/auth/change-password',
      { method: 'POST', body: JSON.stringify({ oldPassword: PASSWORD, newPassword: rotated }) },
      sessionA,
    ),
    'change password',
  )

  // 另一条会话必须已经死了——这是用户改密的**唯一目的**。
  expect(
    await sessionAlive(sessionB),
    '改密之后另一条会话仍然活着 ⇒ 用户以为自己把入侵者踢出去了，其实没有',
  ).toBe(false)

  // 调用方自己拿到一张新票，旧票同样作废（服务端 revokeAllSessionsForUser 之后重新签发）。
  expect(changed.sessionToken, '改密回执没有回签新会话 ⇒ 调用方会被自己踢下线').toBeTruthy()
  expect(await sessionAlive(changed.sessionToken!)).toBe(true)
  expect(await sessionAlive(sessionA), '改密之后旧票仍可用').toBe(false)

  // 密码本身确实换了：新的能登、旧的不能。
  expect((await login(user.username, rotated)).status).toBe(200)
  expect((await login(user.username, PASSWORD)).status, '旧密码还能登录 ⇒ 改密只改了个显示值').toBe(
    401,
  )
})

// ---------------------------------------------------------------------------
// IAM-27 —— 管理员重置他人密码：强制下次改密 + 吊销全部会话
// ---------------------------------------------------------------------------

test('RFC-319 IAM-27: an administrator password reset revokes the target sessions and can force a change on next sign-in', async () => {
  const user = await seedUser('resetpw')
  const victimSession = await loginToken(user.username, PASSWORD)
  expect(await sessionAlive(victimSession)).toBe(true)

  const issued = 'Rfc319Issued!3'
  await jsonOf(
    await req(`/api/users/${user.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: issued, force: true }),
    }),
    'admin reset password',
  )

  // 重置的场景通常是「这个账号可能已经被人拿走了」。会话不吊销，重置就没有意义。
  expect(
    await sessionAlive(victimSession),
    '管理员重置了密码，目标的既有会话却还活着 ⇒ 重置解决不了它要解决的问题',
  ).toBe(false)
  expect((await login(user.username, PASSWORD)).status, '旧密码在重置后仍可登录').toBe(401)

  // 「下次必须改密」是从**登录回执**的 mustChangePassword 出来的（auth.ts:121），
  // 前端正是据它跳转改密页——所以判据要落在这个字段上，而不是某个内部列名。
  const signIn = await jsonOf<{ sessionToken: string; mustChangePassword?: boolean }>(
    await login(user.username, issued),
    'sign in with the issued password',
  )
  expect(
    signIn.mustChangePassword,
    'force=true 却没有在登录回执里要求改密 ⇒ 管理员发的临时密码会被一直用下去',
  ).toBe(true)
  const fresh = signIn.sessionToken

  // 带着 forcePasswordChange 的人可以不提供旧密码直接改（他本来就不知道旧密码）。
  const selfSet = 'Rfc319SelfSet!4'
  await jsonOf(
    await req(
      '/api/auth/change-password',
      { method: 'POST', body: JSON.stringify({ newPassword: selfSet }) },
      fresh,
    ),
    'first-login password change',
  )
  expect((await login(user.username, selfSet)).status).toBe(200)

  // __system__ 不接受重置——它没有人类持有者，给它设密码等于开一个无人认领的入口。
  const system = await req('/api/users/__system__/reset-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword: 'Rfc319System!5' }),
  })
  expect(system.status, '__system__ 被设上了密码 ⇒ 平台内部身份变成了可登录账号').toBe(422)
  expect((await system.json()).code).toBe('system-user-immutable')
})

// ---------------------------------------------------------------------------
// IAM-12 —— 登录方式策略：关掉密码登录后，登录端点必须真的拒绝
// ---------------------------------------------------------------------------

test('RFC-319 IAM-12: password sign-in cannot be switched off without a way back in, and once off the login endpoint really refuses', async () => {
  const user = await seedUser('policy')
  expect((await login(user.username, PASSWORD)).status, '前提：策略未改时能登').toBe(200)

  // ① 锁死自己的保护：一个 enabled 的 OIDC provider 都没有时，关掉密码登录
  //    就等于把所有人关在门外——服务端必须拒绝，而不是照做然后让人去改数据库。
  const lockout = await req('/api/oidc/login-policy', {
    method: 'PUT',
    body: JSON.stringify({ passwordLoginEnabled: false }),
  })
  expect(
    lockout.status,
    '没有任何可用身份源时也允许关掉密码登录 ⇒ 一次点击把整个实例锁死，' +
      '而管理员是在设置页上做的这个操作，界面上看不出后果',
  ).toBe(409)
  expect((await lockout.json()).code).toBe('password-login-requires-enabled-oidc')
  expect((await login(user.username, PASSWORD)).status, '被拒的策略变更却生效了').toBe(200)

  // ② 有了退路之后才允许关。这一步同时是上面那条的正向对照：
  //    没有它，「关不掉」可能只是「这个开关根本不能动」。
  await jsonOf(
    await req('/api/oidc/providers', {
      method: 'POST',
      body: JSON.stringify({
        slug: `rfc319-idp-${sequence}`,
        displayName: 'RFC-319 fixture IdP',
        issuerUrl: 'https://idp.example.invalid',
        clientId: 'rfc319-client',
        clientSecret: 'rfc319-secret',
        scopes: 'openid profile email',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        userinfoEndpoint: null,
        userinfoRequestStyle: 'get_bearer',
        jwksUri: null,
        trustEmailVerified: true,
        usernameClaim: null,
        emailClaim: null,
        subjectClaim: null,
      }),
    }),
    'create enabled oidc provider',
  )

  const off = await jsonOf<{ passwordLoginEnabled: boolean }>(
    await req('/api/oidc/login-policy', {
      method: 'PUT',
      body: JSON.stringify({ passwordLoginEnabled: false }),
    }),
    'disable password login',
  )
  expect(off.passwordLoginEnabled).toBe(false)

  // ③ 关掉之后**登录端点**必须真的拒绝。设置存下来了但端点照旧放行，是这条
  //    能力最可能的失效形态——管理员以为收紧了入口，大门还开着。
  // 变异实证记录：真正执行这条策略的是 `auth/loginPolicy.ts:306`，不是
  // `routes/auth.ts:85`——把路由那道摘掉用例仍绿（它是冗余的第二层），把
  // loginPolicy 那道摘掉才转红。判据落在**行为**上而不是某一处实现，所以
  // 两层里任何一层还在，这条能力就还成立。
  const blocked = await login(user.username, PASSWORD)
  expect(blocked.status, '密码登录已关闭，登录端点却照旧放行').toBe(403)
  expect((await blocked.json()).code).toBe('password-login-disabled')

  // ④ 是开关不是单向门——恢复不了的设置没人敢碰。
  await jsonOf(
    await req('/api/oidc/login-policy', {
      method: 'PUT',
      body: JSON.stringify({ passwordLoginEnabled: true }),
    }),
    're-enable password login',
  )
  expect((await login(user.username, PASSWORD)).status).toBe(200)

  // ⑤ OIDC 默认角色：**自动开户的账号永远拿不到管理档**。
  //    这个字段决定「陌生人从身份源第一次登进来时是什么身份」——它一旦能填
  //    manager / admin，任何能在该 IdP 里注册的人就直接成了这里的管理员。
  for (const forbidden of ['manager', 'admin']) {
    const res = await req('/api/oidc/login-policy', {
      method: 'PUT',
      body: JSON.stringify({ oidcDefaultRole: forbidden }),
    })
    expect(
      res.status,
      `OIDC 默认角色接受了 ${forbidden} ⇒ 能在该身份源注册的人自动成为这里的管理员`,
    ).toBe(422)
    expect((await res.json()).code).toBe('login-policy-invalid')
  }

  const role = await jsonOf<{ oidcDefaultRole: string }>(
    await req('/api/oidc/login-policy', {
      method: 'PUT',
      body: JSON.stringify({ oidcDefaultRole: 'guest' }),
    }),
    'set oidc default role',
  )
  expect(role.oidcDefaultRole).toBe('guest')
  const readBack = await jsonOf<{ oidcDefaultRole: string; passwordLoginEnabled: boolean }>(
    await req('/api/oidc/login-policy'),
    'read login policy',
  )
  expect(readBack.oidcDefaultRole).toBe('guest')
  expect(readBack.passwordLoginEnabled, '写 role 时把另一个字段冲掉了').toBe(true)
})

// ---------------------------------------------------------------------------
// IAM-32 —— 所有者转让真的移交了管理权
// ---------------------------------------------------------------------------

test('RFC-319 IAM-32: transferring ownership actually hands over control — someone who could not even see the resource can now manage its ACL', async () => {
  const heir = await seedUser('heir')
  const heirToken = await loginToken(heir.username, PASSWORD)

  const agent = await jsonOf<{ id: string }>(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-transfer-${sequence}`,
        description: 'RFC-319 ownership transfer fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
      }),
    }),
    'seed agent',
  )

  // 转让**之前**：继承人连这个资源都看不见（私有 + 非所有者 ⇒ 与不存在同形）。
  // 没有这一步，后面的「他能改了」可能一直都成立。
  const beforeRead = await req(`/api/agents/${agent.id}`, undefined, heirToken)
  expect(beforeRead.status, '前提不成立：继承人在转让前就能看到这个资源').toBe(404)

  await jsonOf(
    await req(`/api/agents/${agent.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        ownerUserId: heir.id,
        expectedResourceId: agent.id,
        expectedAclRevision: 0,
      }),
    }),
    'transfer ownership',
  )

  const acl = await jsonOf<{ ownerUserId: string; aclRevision: number }>(
    await req(`/api/agents/${agent.id}/acl`),
    'read acl after transfer',
  )
  expect(acl.ownerUserId, '归属没有落到新所有者身上').toBe(heir.id)

  // 归属只是**记录**；真正要验的是管理权跟着走了：新所有者能改这个资源的 ACL。
  // 前后对照（转让前 404 / 转让后可写）证明控制权确实移动了。
  //
  // 「原所有者从此不能管」这半边这里没有断言：本用例的原所有者是管理档，
  // 自带 `resource-acl:bypass`，而 bypass 按设计就绕开归属——拿它做否定断言
  // 只会锁死一个错误的期望。要证那一半得让一个普通用户当原所有者
  // （`user` 基线确实含 `agents:create`，见 USER_RESOURCE_WRITES），
  // 那是一条独立的用例，不在本条的判据范围内。
  const heirWrite = await req(
    `/api/agents/${agent.id}/acl`,
    {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agent.id,
        expectedAclRevision: acl.aclRevision,
      }),
    },
    heirToken,
  )
  expect(
    heirWrite.status,
    `转让完成了，新所有者却改不了它的 ACL ⇒ 转让只写了一行归属记录: ${await heirWrite.clone().text()}`,
  ).toBe(200)
})
