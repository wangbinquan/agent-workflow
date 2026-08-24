// RFC-319 B24 —— IAM-08：OIDC 开户策略的三条拒绝分支。
//
// 这三条是**开门的判据**：IdP 已经把身份验过了，平台还要不要给这个人开户。
// 判错的代价不对称——放行一个不该进的人，他就成了系统里一个正常的 active 账号，
// 之后所有 ACL 都建立在这个错误之上；而且这条路径**没有界面**可看，管理员改完
// `provisioning` 之后，唯一能知道它有没有生效的方式就是让一个不该进的人来敲门。
//
// 所以这条用例必须走**真实授权码流**：真的 IdP（system-mock 统一身份提供方）、
// 真的 PKCE/state、真的 id_token 签名与校验，最后由 daemon 的 callback 作判定。
// 只调 `decideProvisioning` 纯函数是不够的——它已经有单测了，而线上出事的形态是
// 「纯函数判对了，但 callback 没把 reject 落成拒绝」。
//
// 判据取自源码单一事实源：
//   services/oidc/provisioning.ts:56-82   decideProvisioning 的六分支表
//   routes/oidc-auth.ts:216-218           reject ⇒ c.html(friendly(reason), 403)
//   util/oidcResponse.ts:32-37            三条拒绝各自的文案
//   auth/oidc/identity.ts:113             email_verified 只认布尔真
//
// 第 4 条是**正向对照**，与第 3 条共用一份 provider 配置（同样的 allowlist 域、
// 同样 trustEmailVerified:false），只换点哪个身份。没有它，前三条会退化成
// 「这条链路本来就走不通」的假绿。

import { expect, test, type Page } from '@playwright/test'

import {
  MOCK_OIDC_CLIENT_ID,
  MOCK_OIDC_CLIENT_SECRET,
  SystemMockClient,
} from '@agent-workflow/system-mocks'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle
let mocks: SystemMockClient
let issuerUrl: string

/** 域与 alice 同为 `mock.test`——第 3 条的拒绝只能来自「邮箱未验证」这一支。 */
const UNVERIFIED = {
  sub: 'iam08-unverified',
  email: 'iam08-unverified@mock.test',
  name: 'Unverified Mock',
  preferredUsername: 'iam08unverified',
  emailVerified: false,
} as const

function requiredEnv(name: string): string {
  const value = process.env[name]
  expect(value, `${name} 必须由 e2e/global-setup.ts 注入`).toBeTruthy()
  return value as string
}

test.beforeAll(async () => {
  issuerUrl = requiredEnv('AW_SYSTEM_MOCK_OIDC_ISSUER_URL')
  mocks = new SystemMockClient(
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_URL'),
    requiredEnv('AW_SYSTEM_MOCK_CONTROL_TOKEN'),
  )
  // 追加而不是替换：一套 system-mock 服务所有 Playwright worker（见 e2e/global-setup.ts），
  // 把名单整个换掉会抽掉并行 worker 正在点的那个身份。同理不在 afterAll 里摘除。
  const before = await mocks.snapshot()
  if (!before.oidc.users.some((user) => user.sub === UNVERIFIED.sub)) {
    await mocks.configureOidc({ users: [...before.oidc.users, { ...UNVERIFIED }] })
  }
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function createProvider(
  slug: string,
  policy: {
    provisioning: 'auto' | 'allowlist' | 'invite'
    allowedEmailDomains: string[]
    trustEmailVerified: boolean
  },
): Promise<void> {
  const res = await req('/api/oidc/providers', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      displayName: `IAM-08 ${slug}`,
      issuerUrl,
      clientId: MOCK_OIDC_CLIENT_ID,
      clientSecret: MOCK_OIDC_CLIENT_SECRET,
      scopes: 'openid profile email',
      iconUrl: null,
      enabled: true,
      userinfoRequestStyle: 'get_bearer',
      usernameClaim: null,
      subjectClaim: null,
      emailClaim: null,
      ...policy,
    }),
  })
  expect(res.status, `创建 provider ${slug}: ${await res.clone().text()}`).toBe(201)
}

async function accountEmails(): Promise<string[]> {
  const res = await req('/api/users')
  expect(res.ok, `列用户: ${res.status}`).toBe(true)
  return ((await res.json()) as Array<{ email: string | null }>).map((row) => row.email ?? '')
}

/** 走完整授权码流并在 IdP 页面上点某个身份，回传 callback 的状态码。 */
async function loginAs(page: Page, slug: string, sub: string): Promise<number> {
  const start = await fetch(`${daemon.baseUrl}/api/auth/oidc/${slug}/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postLoginRedirect: '/agents' }),
  })
  expect(start.status, `login/start ${slug}: ${await start.clone().text()}`).toBe(200)
  const { authorizeUrl } = (await start.json()) as { authorizeUrl: string }

  await page.goto(authorizeUrl)
  await expect(
    page.getByRole('heading', { name: 'Choose a mock identity', exact: true }),
  ).toBeVisible()
  // 按 **pathname 逐段**匹配，不用 `${daemon.baseUrl}/api/...` 拼前缀：
  // ①前缀写法会被 `api-contract-coverage` 的 e2e 调用扫描器当成一次真实
  //   API 调用，而 `/api/auth/oidc`（去掉尾斜杠后的形态）不是注册端点，守卫即红；
  // ②逐段匹配同时更准——它钉死了 callback 的路径形状，而不只是「URL 里有
  //   /callback」。
  const daemonOrigin = new URL(daemon.baseUrl).origin
  const callback = page.waitForResponse((res) => {
    const url = new URL(res.url())
    return url.origin === daemonOrigin && /^\/api\/auth\/oidc\/[^/]+\/callback$/.test(url.pathname)
  })
  await page.getByTestId(`oidc-user-${sub}`).click()
  return (await callback).status()
}

async function expectRefused(page: Page, message: string): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Login failed', exact: true })).toBeVisible()
  await expect(page.getByText(message, { exact: true })).toBeVisible()
  expect(
    await page.evaluate(() => window.localStorage.getItem('agent-workflow.token')),
    '被拒之后仍然拿到了会话令牌——拒绝页只是块看板，门其实开着',
  ).toBeNull()
}

test('allowlist 开户：邮箱域不在白名单里，IdP 验过身份也不开户', async ({ page }) => {
  const before = await accountEmails()
  await createProvider('iam08-domain', {
    provisioning: 'allowlist',
    allowedEmailDomains: ['@corp.invalid'],
    trustEmailVerified: true,
  })

  expect(await loginAs(page, 'iam08-domain', 'mock-alice')).toBe(403)
  await expectRefused(
    page,
    'Your email domain is not on the allowlist. Please contact your administrator.',
  )

  expect(await accountEmails(), '拒绝分支不得留下任何账号——半个账号比放行更难查').toEqual(before)
})

test('invite 开户：没有对应邀请的邮箱一律不开户', async ({ page }) => {
  const before = await accountEmails()
  await createProvider('iam08-invite', {
    provisioning: 'invite',
    allowedEmailDomains: [],
    trustEmailVerified: true,
  })

  expect(await loginAs(page, 'iam08-invite', 'mock-alice')).toBe(403)
  await expectRefused(
    page,
    'No invitation found for this email. Please ask your administrator to invite you first.',
  )

  expect(await accountEmails()).toEqual(before)
})

test('allowlist 开户：邮箱域命中但 IdP 没验过邮箱，同样不开户', async ({ page }) => {
  const before = await accountEmails()
  // 与下一条正向对照**同一份配置**：域是 @mock.test（白名单条目是 `@` 前缀的
  // 邮箱后缀，不是裸域名——EMAIL_DOMAIN_REGEX 见 shared/schemas/oidcProvider.ts:19），
  // 且不信任 IdP 的邮箱声明。
  await createProvider('iam08-unverified', {
    provisioning: 'allowlist',
    allowedEmailDomains: ['@mock.test'],
    trustEmailVerified: false,
  })

  expect(await loginAs(page, 'iam08-unverified', UNVERIFIED.sub)).toBe(403)
  await expectRefused(page, 'Your identity provider has not verified your email.')

  expect(await accountEmails()).toEqual(before)
})

test('正向对照：同一份 allowlist 配置下，域命中且邮箱已验证的身份真的开出账号', async ({
  page,
}) => {
  await createProvider('iam08-allow-ok', {
    provisioning: 'allowlist',
    allowedEmailDomains: ['@mock.test'],
    trustEmailVerified: false,
  })

  expect(await loginAs(page, 'iam08-allow-ok', 'mock-alice')).toBe(302)
  await page.waitForURL(`${daemon.baseUrl}/agents`)

  const whoami = await page.evaluate(async () => {
    const token = window.localStorage.getItem('agent-workflow.token') ?? ''
    const response = await fetch('/api/whoami', { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  })
  expect(whoami.status).toBe(200)
  expect(whoami.body).toMatchObject({ user: { username: 'alice' }, source: 'session' })
  expect(await accountEmails()).toContain('alice@mock.test')
})
