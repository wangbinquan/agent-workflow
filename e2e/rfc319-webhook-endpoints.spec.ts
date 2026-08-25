// RFC-319 —— Webhook 入站端点的「配置面 + 入口面」用户面验收
// （EVENT-01 / 03 / 04 / 05 / 06 / 10 / 11 / 12 / 13）。
//
// 端点是整条事件自动化链路上唯一一个**对公网开放**的东西：一个 URL token 决定
// 谁能把请求送进来，一个 secret 决定这条请求算不算数。它的失效形态有两类，
// 而且都很安静：
//
//   ① 配置面骗人。用户在界面上做了一件事，服务端其实没做（provider 没落库、
//      clone 协议没落库、一次性 secret 显示的不是真的那一条）。用户带着一份
//      「我已经接好了」的错觉去代码平台粘贴，之后每一条投递都在 GitLab 的
//      Recent Deliveries 里变红，而平台这边一行日志都没有。
//   ② 入口面对陌生请求说太多话。未知 provider、未知 token、provider 对不上
//      这三种情况只要回答得不一样，一个不需要任何凭据的扫描器就能把「哪些
//      token 是真的」问出来——URL token 本身就是弱凭据（RFC-257 D19），它
//      被枚举出来之后攻击面就只剩一个 secret。
//
// 还有一条贯穿全篇的产品判断，必须在用例里钉死：**凡「平台侧决定不处理」一律
// 回 200**（routes/webhooks.ts:13-16 的注释写明了理由）。对 GitLab 回 4xx 会
// 累积 auto-disable，把几百个仓库共用的那一个 group hook 整个禁掉——受害的不是
// 发错事件的那个仓库，是所有人。所以 EVENT-13 断言的不只是「reason 对不对」，
// 更是「状态码绝不能是 4xx」。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链）：
//   * 入站三段式与状态码语义：packages/backend/src/routes/webhooks.ts:1-16
//   * 404 同形三处（未知 provider / 未知 token / provider 不匹配）：
//     packages/backend/src/routes/webhooks.ts:104-124
//   * 两档限流的调用点与先后顺序：packages/backend/src/routes/webhooks.ts:107、122、126-128
//   * 滑窗限流实现与两个阈值：packages/backend/src/services/webhook/rateLimiter.ts:13-55
//   * 1MiB 流式截断（超限即 cancel，不读完）：packages/backend/src/routes/webhooks.ts:39-66、130-131
//   * unsupported-event → 200 + ignored：packages/backend/src/routes/webhooks.ts:186-199
//   * 端点停用 → 200 + endpoint-disabled：packages/backend/src/routes/webhooks.ts:202-213
//   * URL 明文按 viewer 分层（session + manage 才给明文）：
//     packages/backend/src/services/webhookEndpoints.ts:50-57、68-85、99-102
//   * ingressUrl 只由 publicBaseUrl 拼装：packages/backend/src/services/webhookEndpoints.ts:87-97
//   * 删除的 restrict 判定：packages/backend/src/services/webhookEndpoints.ts:196-216
//   * URL token 轮换：packages/backend/src/services/webhookEndpoints.ts:234-247
//   * provider 不可变（PUT schema 是 .strict()）：packages/shared/src/schemas/webhook.ts:630-640
//   * 读面开放给 PAT、写面 tokenAccess:'never'：packages/backend/src/routes/webhookEndpoints.ts:26-127
//   * PAT 撞写面的固定错误码：packages/backend/src/routes/registry.ts:171-176
//   * GitLab 侧「哪些事件不处理」：packages/backend/src/services/webhook/gitlabAdapter.ts:239-247（MR action）、
//     356-366（pipeline 中间态）、436-440（未知 object_kind）
//   * 一次性 secret 弹窗与掩码渲染：packages/frontend/src/components/WebhookEndpointCard.tsx:405-440、550-610
//
// 与既有用例的分工（务必不要重复）：
//   * e2e/event-automation-guards.spec.ts —— EVENT-02/09（secret 轮换 + 验签拒绝
//     不占去重位）、EVENT-27（重放）、EVENT-35。本文件只在需要「一条合法投递」
//     时复用同样的投递姿势，不再重复断言验签本身。
//   * e2e/webhook-trigger-matching.spec.ts —— EVENT-18/19（五维匹配 / 熔断）。
//     本文件的 EVENT-05 只借用「建一条触发规则」这一步来制造引用关系。
//   * e2e/webhook-mr-runtime-races.spec.ts:654 —— EVENT-14（验签过但 body 非
//     JSON → 400 parse-failed）。本文件不碰这一条。
//   * EVENT-08（GitHub HMAC 投递 → 规则命中 → 真任务启动）与 EVENT-20（四类启动
//     目标）**刻意不在本文件范围内**：那是投递链路的另一批。EVENT-01 只验证
//     provider=github 的端点被正确创建与渲染，不发 HMAC 投递。

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

/**
 * 入站 URL 只能由 publicBaseUrl 拼装（webhookEndpoints.ts:87-97 明确禁止用
 * c.req.url）。harness 默认不写这个字段，此时 ingressUrl 全员为 null，
 * EVENT-01/03/06 想验的「用户到底能不能拿到那条要粘进 GitLab 的地址」就整个
 * 落空了——所以这里显式给一个。
 */
const PUBLIC_BASE_URL = 'https://hooks.rfc319.invalid'

const USER_PASSWORD = 'Rfc319EventPass!1'

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon({ configOverrides: { publicBaseUrl: PUBLIC_BASE_URL } })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EndpointWire {
  id: string
  name: string
  provider: 'gitlab' | 'github'
  urlToken: string | null
  urlTokenHint: string | null
  enabled: boolean
  preferredCloneProtocol: 'http' | 'ssh'
  hasSecret: boolean
  secretHint: string | null
  ingressUrl: string | null
}

type MintedEndpoint = EndpointWire & { secret: string; urlToken: string }

interface DeliveryRow {
  id: string
  eventUuid: string | null
  objectKind: string | null
  status: string
  statusReason: string | null
}

async function req(
  path: string,
  init?: RequestInit,
  token?: string,
  base: string = daemon.baseUrl,
): Promise<Response> {
  return fetch(`${base}${path}`, {
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

/** 建端点。响应里的 secret 是**唯一一次**明文（webhookEndpoints.ts:170-171）。 */
async function createEndpoint(
  options: { provider?: 'gitlab' | 'github'; preferredCloneProtocol?: 'http' | 'ssh' } = {},
  base: string = daemon.baseUrl,
  token?: string,
): Promise<MintedEndpoint> {
  return jsonOf<MintedEndpoint>(
    await req(
      '/api/webhook-endpoints',
      {
        method: 'POST',
        body: JSON.stringify({ name: `rfc319-ep-${++sequence}`, ...options }),
      },
      token,
      base,
    ),
    'create endpoint',
  )
}

/**
 * 事件体共用的 project 块。四个字段缺一不可，否则 normalize 直接判
 * `missing project fields`（gitlabAdapter.ts:108-116），用例会栽在它想测的语义
 * **之前**——这是 e2e/webhook-trigger-matching.spec.ts:59-67 实测撞出来的坑。
 */
function projectBlock(repoPath: string): Record<string, unknown> {
  return {
    path_with_namespace: repoPath,
    web_url: `https://gitlab.invalid/${repoPath}`,
    git_http_url: `https://gitlab.invalid/${repoPath}.git`,
    git_ssh_url: `git@gitlab.invalid:${repoPath}.git`,
  }
}

/** GitLab Push Hook —— 一条平台**支持**的事件（gitlabAdapter.ts:210-228）。 */
function pushBody(repoPath = 'rfc319/endpoint-fixture'): string {
  const n = ++sequence
  return JSON.stringify({
    object_kind: 'push',
    user: { username: 'rfc319-human' },
    project: projectBlock(repoPath),
    ref: 'refs/heads/main',
    before: `before${n}`,
    after: `after${n}`,
  })
}

interface DeliverOptions {
  provider?: string
  urlToken?: string
  secret?: string
  eventUuid?: string
  body?: string
  eventHeader?: string
  base?: string
}

/** 一条 GitLab 形态的入站投递。默认用端点自己的 secret 与一条合法 push。 */
async function deliver(endpoint: MintedEndpoint, options: DeliverOptions = {}): Promise<Response> {
  const base = options.base ?? daemon.baseUrl
  const provider = options.provider ?? 'gitlab'
  const urlToken = options.urlToken ?? endpoint.urlToken
  return fetch(`${base}/webhooks/${provider}/${urlToken}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gitlab-token': options.secret ?? endpoint.secret,
      'x-gitlab-event': options.eventHeader ?? 'Push Hook',
      'x-gitlab-event-uuid': options.eventUuid ?? `rfc319-uuid-${++sequence}`,
    },
    body: options.body ?? pushBody(),
  })
}

/** 端点的投递审计行（webhookDeliveries.ts:33-118 的封套形态）。 */
async function deliveriesOf(endpointId: string): Promise<{ total: number; items: DeliveryRow[] }> {
  return jsonOf<{ total: number; items: DeliveryRow[] }>(
    await req(`/api/webhook-deliveries?endpointId=${endpointId}&limit=200`),
    'list deliveries',
  )
}

/** 建一个普通账号并登录。普通 `user` 角色基线里就带 `webhook-endpoints:read`。 */
async function plainUserSession(): Promise<string> {
  const username = `rfc319-ep-user-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: USER_PASSWORD,
      }),
    }),
    `seed user ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: USER_PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

async function primeToken(target: Page, token: string = daemon.token): Promise<void> {
  await target.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: token },
  )
}

/**
 * 打开「新建端点」弹窗。
 *
 * `.first()` 不是偷懒：列表为空时 `webhook-endpoint-add` 这个 testid 会同时出现
 * 在面板标题栏和 EmptyState 的行动按钮上（WebhookEndpointCard.tsx:231-240 的同一
 * 个 `createAction` 元素被渲染两次），严格模式下裸 getByTestId 会直接报
 * strict mode violation。两个按钮行为相同，取第一个。
 */
async function openCreateDialog(page: Page) {
  await page.getByTestId('webhook-endpoint-add').first().click()
  const dialog = page.getByTestId('webhook-endpoint-create-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** 按名字从服务端取回刚建出来的那一行（界面上只有掩码，拿不到 urlToken）。 */
async function endpointByName(name: string): Promise<EndpointWire> {
  const rows = await jsonOf<EndpointWire[]>(await req('/api/webhook-endpoints'), 'list endpoints')
  const row = rows.find((candidate) => candidate.name === name)
  expect(row, `界面上点了「创建」，服务端却查不到名为 ${name} 的端点`).toBeDefined()
  return row as EndpointWire
}

// ---------------------------------------------------------------------------
// EVENT-01 —— 新建端点（provider + clone 协议 + 一次性 secret）
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-01：在事件中心新建 Webhook 端点 —— provider 与 clone 协议真的落库，一次性 secret 只显示一次而且就是能验签的那一条 @nightly', async ({
  page,
}) => {
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/events?tab=sources`)
  await expect(page.getByTestId('webhook-endpoints')).toBeVisible()

  // --- (a) GitLab + SSH ---------------------------------------------------
  const gitlabName = `rfc319-ui-gitlab-${++sequence}`
  const createDialog = await openCreateDialog(page)
  await createDialog.getByTestId('webhook-endpoint-name').fill(gitlabName)
  // provider 默认 GitLab（CreateWebhookEndpointSchema 的 default），这里只改
  // clone 协议：它决定「事件仓库还没导入时，平台优先用哪种地址去 clone」。
  await createDialog.getByRole('radio', { name: 'SSH', exact: true }).click()
  await page.getByTestId('webhook-endpoint-create-submit').click()

  const secretDialog = page.getByTestId('webhook-endpoint-secret-dialog')
  await expect(
    secretDialog,
    '点了创建却没有弹出「只显示一次」的 secret 窗 ⇒ 用户手里没有任何可以粘进 GitLab 的凭据，' +
      '而端点已经建好了：他会以为接完了，实际每条投递都会 401',
  ).toBeVisible()
  const shownSecret = (await page.getByTestId('webhook-endpoint-secret-value').textContent()) ?? ''
  expect(shownSecret.length, '弹窗里的 secret 是空的 ⇒ 同上，用户拿不到凭据').toBeGreaterThan(20)

  const gitlabRow = await endpointByName(gitlabName)
  expect(
    gitlabRow.preferredCloneProtocol,
    '界面上选了 SSH，服务端存的却不是 ssh ⇒ 事件仓库未导入时平台会用 HTTP 地址去 clone；' +
      '只配了部署密钥的环境里，每一次自动注册都会失败，而失败点离用户的这次选择很远',
  ).toBe('ssh')
  expect(gitlabRow.provider, 'provider 默认值没落成 gitlab').toBe('gitlab')
  expect(
    gitlabRow.ingressUrl,
    '端点的入站地址不是由 publicBaseUrl 拼出来的那一条 ⇒ 用户复制走的地址打不到自己部署的这台机器',
  ).toBe(`${PUBLIC_BASE_URL}/webhooks/gitlab/${gitlabRow.urlToken}`)

  // 弹窗里显示的 secret **就是**服务端会拿来验签的那一条。这一条不成立时，用户
  // 把它粘进 GitLab，之后每条投递都是 401：他只能在 GitLab 的 Recent Deliveries
  // 里看到一片红，而平台这边只留下一堆 rejected 审计行，两边都不会说「你粘的
  // 那条从来就不对」。
  const withShownSecret = await deliver(
    { ...gitlabRow, secret: shownSecret, urlToken: gitlabRow.urlToken ?? '' },
    { eventUuid: `rfc319-ui-secret-${sequence}` },
  )
  const withShownSecretBody = await withShownSecret.text()
  expect(
    withShownSecret.status,
    `弹窗里显示的 secret 过不了验签：${withShownSecret.status} ${withShownSecretBody}`,
  ).toBe(200)

  await secretDialog.getByRole('button', { name: 'I saved it' }).click()
  await expect(secretDialog).toBeHidden()

  const card = page.getByTestId(`webhook-endpoint-${gitlabRow.id}`)
  await expect(card).toBeVisible()
  expect(
    (await page.content()).includes(shownSecret),
    '关掉弹窗之后页面上还留着 secret 明文 ⇒ 「只显示一次」是句空话：' +
      '它会跟着页面一直留在别人看得见的屏幕上、也会进任何一次页面快照',
  ).toBe(false)
  await expect(
    card.locator('code', { hasText: `•••• ${gitlabRow.secretHint ?? ''}` }),
    '列表里没有把 secret 渲染成尾 4 位掩码 ⇒ 用户无法确认「我粘进 GitLab 的是不是这一条」',
  ).toBeVisible()

  // --- (b) GitHub + HTTP ---------------------------------------------------
  // provider 决定验签语义（GitLab 是明文 token 比对、GitHub 是 HMAC 签名，
  // codeHostAdapter.ts:36-39）。选错而不自知的后果是：用户在 GitHub 上配好了
  // secret，平台却按 GitLab 的规则去比对请求头，永远对不上。
  const githubName = `rfc319-ui-github-${++sequence}`
  const githubDialog = await openCreateDialog(page)
  await githubDialog.getByTestId('webhook-endpoint-name').fill(githubName)
  await githubDialog.getByRole('radio', { name: 'GitHub', exact: true }).click()
  await expect(
    page.getByTestId('webhook-endpoint-create-submit'),
    '选了 GitHub 之后提交按钮消失了',
  ).toBeEnabled()
  await page.getByTestId('webhook-endpoint-create-submit').click()
  await expect(page.getByTestId('webhook-endpoint-secret-dialog')).toBeVisible()
  await expect(
    page.getByTestId('webhook-endpoint-paste-hint'),
    '一次性凭据窗没有按 provider 给出对应的粘贴位置 ⇒ 用户拿着 GitHub 的 secret 去找 GitLab 的输入框',
  ).toContainText('GitHub')
  await page
    .getByTestId('webhook-endpoint-secret-dialog')
    .getByRole('button', {
      name: 'I saved it',
    })
    .click()

  const githubRow = await endpointByName(githubName)
  expect(
    githubRow.provider,
    '界面上选了 GitHub，服务端存的却不是 github ⇒ 平台会用 GitLab 的明文比对去校验 GitHub 的 HMAC 签名，' +
      '每一条投递都验不过，而界面上看起来一切正常',
  ).toBe('github')
  expect(
    githubRow.ingressUrl,
    'GitHub 端点的入站地址没有落在 /webhooks/github/ 下 ⇒ 粘到 GitHub 上的地址会被平台按另一个 provider 解析',
  ).toBe(`${PUBLIC_BASE_URL}/webhooks/github/${githubRow.urlToken}`)
  await expect(
    page.getByTestId(`webhook-endpoint-provider-${githubRow.id}`),
    '卡片上没有把 provider 显示出来 ⇒ 一个人接手别人建的端点时，无法判断它该配到哪个平台',
  ).toHaveText('GitHub')
})

// ---------------------------------------------------------------------------
// EVENT-03 —— 轮换 URL token
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-03：轮换端点 URL token —— 新地址立刻可用、旧地址与从不存在的地址同形 404，且 secret 不受牵连 @nightly', async () => {
  const endpoint = await createEndpoint()
  const tag = `rfc319-rotate-${++sequence}`

  const before = await deliver(endpoint, { eventUuid: `${tag}-before` })
  expect(before.status, `轮换之前这条地址本来就打不通：${await before.text()}`).toBe(200)

  const rotated = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}/rotate-url-token`, { method: 'POST' }),
    'rotate url token',
  )
  expect(
    rotated.urlToken,
    '轮换之后 URL token 没有变 ⇒ 「换掉泄露的入站地址」这个动作什么都没做，' +
      '而用户会以为自己已经止了血',
  ).not.toBe(endpoint.urlToken)
  expect(
    rotated.ingressUrl,
    '轮换后给出的完整地址没跟着换 ⇒ 用户复制走的还是旧地址，粘回代码平台等于没换',
  ).toBe(`${PUBLIC_BASE_URL}/webhooks/gitlab/${rotated.urlToken}`)
  expect(
    rotated.secretHint,
    '轮换 URL token 顺手把 secret 也换了 ⇒ 用户只改了地址却发现验签也失效了，' +
      '而界面从头到尾没提过这件事：他要排查两个失败原因，只能靠猜',
  ).toBe(endpoint.secretHint)

  const newToken = rotated.urlToken
  expect(newToken, '轮换响应里没有明文 URL token（管理员 session 本应拿得到）').not.toBeNull()

  // 旧地址必须死透。它没死 = 轮换不是撤销：一条泄露出去的地址永远有效。
  const viaOld = await deliver(endpoint, { eventUuid: `${tag}-old` })
  const viaOldBody = await viaOld.text()
  expect(viaOld.status, `轮换之后旧地址仍然收件 ⇒ 泄露的入站地址收不回来：${viaOldBody}`).toBe(404)

  // 而且旧地址的回答要和「从来没存在过的地址」**逐字一样**。不一样的话，
  // 一个不需要任何凭据的扫描器就能问出「这个 token 曾经是真的」——URL token 是
  // 弱凭据，被确认存在之后攻击面只剩一个 secret。
  const viaNever = await deliver(endpoint, {
    urlToken: 'aw_whk_this_token_never_existed',
    eventUuid: `${tag}-never`,
  })
  const viaNeverBody = await viaNever.text()
  expect(viaNever.status).toBe(404)
  expect(
    viaOldBody,
    '「轮换掉的旧地址」和「从来不存在的地址」回答不同 ⇒ 外部可以据此确认某个 token 曾经有效',
  ).toBe(viaNeverBody)

  // 新地址用**同一条 secret** 就能收件：轮换只换寻址，不动凭据。
  const viaNew = await deliver(endpoint, {
    urlToken: newToken ?? '',
    eventUuid: `${tag}-new`,
  })
  expect(viaNew.status, `新地址收不了件：${await viaNew.text()}`).toBe(200)

  // 打旧地址不该留下审计行——否则任何人都能不带凭据地往别人的审计里灌垃圾。
  const rows = await deliveriesOf(endpoint.id)
  const uuids = rows.items.map((row) => row.eventUuid)
  // 先证明这个查询本来就看得见这个端点的行，否则下面那条 not.toContain 恒真。
  expect(uuids, '轮换后从新地址收下的那条投递没有出现在审计里').toContain(`${tag}-new`)
  expect(
    uuids,
    '打在已作废地址上的请求也落了审计行 ⇒ 无凭据的外部请求可以无限撑大投递表',
  ).not.toContain(`${tag}-old`)
})

// ---------------------------------------------------------------------------
// EVENT-04 —— 编辑端点
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-04：编辑端点 —— 改名与 clone 协议真的落库、界面上的启停开关真的改变入站行为、provider 不可变 @nightly', async ({
  page,
}) => {
  const endpoint = await createEndpoint({ preferredCloneProtocol: 'http' })

  // --- 改名 + 改 clone 协议（当前只有 API 面，见文件末尾的产品缺陷备注）------
  const renamed = `rfc319-renamed-${++sequence}`
  const updated = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: renamed, preferredCloneProtocol: 'ssh' }),
    }),
    'update endpoint',
  )
  expect(updated.name, '改名没生效 ⇒ 端点多了之后没人分得清哪个接的是哪个平台').toBe(renamed)
  expect(
    updated.preferredCloneProtocol,
    'clone 协议改了却没落库 ⇒ 用户为了修「自动注册总是失败」而改的这一下毫无作用',
  ).toBe('ssh')
  const readBack = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}`),
    'read endpoint back',
  )
  expect(
    { name: readBack.name, protocol: readBack.preferredCloneProtocol },
    '改动只体现在 PUT 的响应里，重新读一次又变回去了 ⇒ 典型的「界面显示已保存、其实没保存」',
  ).toEqual({ name: renamed, protocol: 'ssh' })

  // --- provider 不可变 -----------------------------------------------------
  // 换 provider = 换验签语义。允许原地改，等于让一个**已经在收件**的端点在某一刻
  // 起换一套验签规则：代码平台那边一无所知，从此每条投递都 401。
  const switchProvider = await req(`/api/webhook-endpoints/${endpoint.id}`, {
    method: 'PUT',
    body: JSON.stringify({ provider: 'github' }),
  })
  const switchBody = await switchProvider.text()
  expect(
    switchProvider.ok,
    `provider 被原地改掉了 ⇒ 这个端点的验签规则在收件过程中被换掉，代码平台侧毫无感知：${switchBody}`,
  ).toBe(false)
  expect(
    switchBody,
    'provider 被拒绝了，但错误码不是稳定的 webhook-endpoint-invalid ⇒ 前端无法把它翻译成人话',
  ).toContain('webhook-endpoint-invalid')
  const afterSwitch = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}`),
    'read endpoint after provider attempt',
  )
  expect(afterSwitch.provider, '被拒绝的请求还是把 provider 改掉了（拒绝只是嘴上说说）').toBe(
    'gitlab',
  )

  // --- 启停：界面上唯一的那个开关 -----------------------------------------
  await primeToken(page)
  await page.goto(`${daemon.baseUrl}/events?tab=sources`)
  const card = page.getByTestId(`webhook-endpoint-${endpoint.id}`)
  await expect(card).toBeVisible()
  const enabledSwitch = card.getByRole('checkbox')
  await expect(enabledSwitch).toBeChecked()
  // 用 click 而不是 uncheck：Switch 是受控组件，服务端返回并 invalidate 之前
  // DOM 上的 checked 不会变，uncheck 的即时校验会误判成「点了没反应」。
  await enabledSwitch.click()
  await expect
    .poll(
      async () => {
        const row = await jsonOf<EndpointWire>(
          await req(`/api/webhook-endpoints/${endpoint.id}`),
          'poll enabled',
        )
        return row.enabled
      },
      {
        message:
          '界面上的启停开关点了，服务端仍然是启用状态 ⇒ 用户以为自己已经把这个入口关了，' +
          '实际上事件还在源源不断地进来并启动真任务',
      },
    )
    .toBe(false)
  await expect(
    card,
    '关掉之后卡片上仍然显示 Enabled ⇒ 用户无法确认这个入口现在到底收不收件',
  ).toContainText('Disabled')

  // 停用的端点必须**收下并记账**，而不是回 4xx：对 GitLab 回 4xx 会累积
  // auto-disable，把几百个仓库共用的那一个 group hook 整个禁掉。
  const disabledUuid = `rfc319-disabled-${++sequence}`
  const whileDisabled = await deliver(endpoint, { eventUuid: disabledUuid })
  const whileDisabledBody = await whileDisabled.text()
  expect(
    whileDisabled.status,
    `停用期间的投递回了非 200 ⇒ 代码平台会把这个 hook 记为失败，累积到阈值后整个禁用：${whileDisabledBody}`,
  ).toBe(200)
  expect(
    JSON.parse(whileDisabledBody),
    '停用期间的投递被当成正常收下 ⇒ 「关掉」这个动作没有真的挡住任何东西',
  ).toMatchObject({ status: 'ignored' })
  await expect
    .poll(async () => {
      const rows = await deliveriesOf(endpoint.id)
      return rows.items.find((row) => row.eventUuid === disabledUuid)?.statusReason
    })
    .toBe('endpoint-disabled')

  // 再打开：入口恢复。没有这一条，上面那些只能证明「关得掉」，证明不了「还能开回来」。
  await enabledSwitch.click()
  await expect
    .poll(async () => {
      const row = await jsonOf<EndpointWire>(
        await req(`/api/webhook-endpoints/${endpoint.id}`),
        'poll re-enabled',
      )
      return row.enabled
    })
    .toBe(true)
  const afterReEnable = await deliver(endpoint, { eventUuid: `rfc319-reenabled-${++sequence}` })
  expect(
    JSON.parse(await afterReEnable.text()),
    '重新启用之后端点仍然不收件 ⇒ 停用变成了不可逆操作，用户只能重建端点并去代码平台重配一遍',
  ).toMatchObject({ status: 'received' })
})

// ---------------------------------------------------------------------------
// EVENT-05 —— 删除端点：被引用时拒绝
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-05：被触发规则引用的端点拒绝删除并保持完好，解除引用后才真正消失 @nightly', async () => {
  const endpoint = await createEndpoint()
  const tag = `rfc319-delete-${++sequence}`
  const repoPath = `rfc319/delete-fixture-${sequence}`

  const workflow = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-ep-wf-${++sequence}`,
        description: 'RFC-319 endpoint delete fixture',
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
  const trigger = await jsonOf<{ id: string }>(
    await req('/api/webhook-triggers', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-ep-trigger-${++sequence}`,
        endpointId: endpoint.id,
        enabled: true,
        repoScope: { kind: 'exact', paths: [repoPath] },
        eventTypes: ['pipeline_failed'],
        maxConsecutiveFires: 2,
        autoRegisterRepos: false,
        launchKind: 'workflow',
        launchRefId: workflow.id,
        launchPayload: {
          scratch: true,
          inputs: { topic: { kind: 'template', template: 'rfc319' } },
        },
      }),
    }),
    'seed trigger',
  )

  const refused = await req(`/api/webhook-endpoints/${endpoint.id}`, { method: 'DELETE' })
  const refusedBody = await refused.text()
  expect(
    refused.status,
    `还有触发规则指着它，端点却被删掉了 ⇒ 那条规则从此指向一个不存在的入口：` +
      `它不会报错、只是再也不会触发，而用户完全看不出为什么自动化停了：${refusedBody}`,
  ).toBe(409)
  expect(
    refusedBody,
    '拒绝了但没有给出可辨识的原因码 ⇒ 用户只知道「删不掉」，不知道该先去动哪条规则',
  ).toContain('webhook-endpoint-has-triggers')

  // 被拒绝之后端点必须**完好**：既能读到，也还在收件。半删除比不删更糟——
  // 代码平台还在往这里投，而平台侧已经处于一个说不清的状态。
  const stillThere = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}`),
    'endpoint survives refused delete',
  )
  expect(stillThere.id).toBe(endpoint.id)
  const stillIngesting = await deliver(endpoint, { eventUuid: `${tag}-after-refuse` })
  expect(
    stillIngesting.status,
    '删除被拒绝了，端点却已经收不了件 ⇒ 一次失败的删除把入口悄悄弄坏了',
  ).toBe(200)

  // 解除引用后可删。
  const dropTrigger = await req(`/api/webhook-triggers/${trigger.id}`, { method: 'DELETE' })
  expect(dropTrigger.ok, `删触发规则失败：${await dropTrigger.text()}`).toBe(true)
  const deleted = await req(`/api/webhook-endpoints/${endpoint.id}`, { method: 'DELETE' })
  expect(
    deleted.ok,
    `引用已经清空，端点还是删不掉 ⇒ 用户被永久卡住：只能留着一个不再需要的公网入口：${await deleted.text()}`,
  ).toBe(true)

  const gone = await req(`/api/webhook-endpoints/${endpoint.id}`)
  expect(gone.status, '删掉之后详情还能读到 ⇒ 删除只是列表上看不见了').toBe(404)
  const ingressGone = await deliver(endpoint, { eventUuid: `${tag}-after-delete` })
  expect(
    ingressGone.status,
    '端点删了，它的入站地址还在收件 ⇒ 一个已经从界面上消失的公网入口仍然对外服务',
  ).toBe(404)
})

// ---------------------------------------------------------------------------
// EVENT-06 —— 入站 URL 明文按 viewer 分层
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-06：入站 URL 明文只给持管理权限的 session —— PAT 与普通用户只见尾 4 位，且写面对 PAT 整个关闭 @nightly', async ({
  page,
}) => {
  const endpoint = await createEndpoint()
  const plaintext = endpoint.urlToken

  // --- 管理员 session：明文 -------------------------------------------------
  const asAdmin = await jsonOf<EndpointWire[]>(
    await req('/api/webhook-endpoints'),
    'list as admin session',
  )
  const adminRow = asAdmin.find((row) => row.id === endpoint.id)
  expect(
    adminRow?.urlToken,
    '持有 webhook-endpoints:manage 的交互 session 也拿不到明文 ⇒ 没有任何人能取到那条要粘进 ' +
      'GitLab 的地址，端点等于建了个寂寞',
  ).toBe(plaintext)

  // --- PAT：掩码 -----------------------------------------------------------
  // `webhook-endpoints:read` 是 READ_POINT，任何 token 自动携带（permission.ts:876-878），
  // 所以空 scope 的 PAT 也读得到列表——分层要挡的正是这种「读得到」的调用者。
  const pat = await jsonOf<{ token: string }>(
    await req('/api/auth/pats', {
      method: 'POST',
      body: JSON.stringify({ name: `rfc319-ep-pat-${++sequence}`, purpose: 'general', scopes: [] }),
    }),
    'mint pat',
  )
  const patListRes = await req('/api/webhook-endpoints', undefined, pat.token)
  const patListText = await patListRes.text()
  expect(patListRes.ok, `PAT 读不到端点列表（读面本应对 token 开放）：${patListText}`).toBe(true)
  expect(
    patListText.includes(plaintext),
    'PAT 能读到入站 URL 明文 ⇒ 一枚可以躺在 CI 变量里、被日志打出来的长期凭据，' +
      '直接把「谁能往平台里投事件」的地址泄露出去（RFC-257 D19 明确要求 ingress 面不上令牌）',
  ).toBe(false)
  const patRow = (JSON.parse(patListText) as EndpointWire[]).find((row) => row.id === endpoint.id)
  expect(patRow?.urlToken, 'PAT 视角的 urlToken 应当被抹成 null').toBeNull()
  expect(patRow?.ingressUrl, 'PAT 视角的完整入站地址应当被抹成 null').toBeNull()
  expect(
    patRow?.urlTokenHint,
    '掩码之后连尾 4 位提示都没有 ⇒ 运维无法把界面上的某一行和代码平台上配的某个 URL 对上号',
  ).toBe(plaintext.slice(-4))

  // 写面对 PAT 是整个关闭的（tokenAccess:'never'），不是「能调但没权限」。
  const writeAttempts: Array<{ what: string; res: Response }> = [
    {
      what: 'POST /api/webhook-endpoints',
      res: await req(
        '/api/webhook-endpoints',
        { method: 'POST', body: JSON.stringify({ name: 'rfc319-pat-denied' }) },
        pat.token,
      ),
    },
    {
      what: 'PUT /api/webhook-endpoints/:id',
      res: await req(
        `/api/webhook-endpoints/${endpoint.id}`,
        { method: 'PUT', body: JSON.stringify({ enabled: false }) },
        pat.token,
      ),
    },
    {
      what: 'POST /api/webhook-endpoints/:id/rotate-secret',
      res: await req(
        `/api/webhook-endpoints/${endpoint.id}/rotate-secret`,
        { method: 'POST' },
        pat.token,
      ),
    },
    {
      what: 'POST /api/webhook-endpoints/:id/rotate-url-token',
      res: await req(
        `/api/webhook-endpoints/${endpoint.id}/rotate-url-token`,
        { method: 'POST' },
        pat.token,
      ),
    },
    {
      what: 'DELETE /api/webhook-endpoints/:id',
      res: await req(`/api/webhook-endpoints/${endpoint.id}`, { method: 'DELETE' }, pat.token),
    },
  ]
  const patOffenders: string[] = []
  for (const attempt of writeAttempts) {
    const body = await attempt.res.text()
    if (attempt.res.status !== 403 || !body.includes('token-forbidden-route')) {
      patOffenders.push(`${attempt.what} → ${attempt.res.status} ${body.slice(0, 160)}`)
    }
  }
  expect(
    patOffenders,
    'PAT 能走通端点写面 ⇒ 一枚长期凭据就能轮换 secret（把正在工作的接入打断）、' +
      '改地址、或者直接删掉入口。五个写点是各自独立的声明，删掉任何一个都不会影响其余四个，必须逐条打',
  ).toEqual([])

  // --- 普通用户 session：掩码 ---------------------------------------------
  const userSession = await plainUserSession()
  const userListText = await (await req('/api/webhook-endpoints', undefined, userSession)).text()
  expect(
    userListText.includes(plaintext),
    '任何一个普通成员都能读到入站 URL 明文 ⇒ 他离「以平台的名义伪造一条事件」只差一个 secret',
  ).toBe(false)
  const userGet = await jsonOf<EndpointWire>(
    await req(`/api/webhook-endpoints/${endpoint.id}`, undefined, userSession),
    'get as plain user',
  )
  expect(
    userGet.urlToken,
    '列表页脱敏了、详情页却给明文 ⇒ 分层被绕过，只要多点一下就拿到了',
  ).toBeNull()
  const userCreate = await req(
    '/api/webhook-endpoints',
    { method: 'POST', body: JSON.stringify({ name: 'rfc319-user-denied' }) },
    userSession,
  )
  expect(userCreate.status, '普通用户能新建公网入站端点').toBe(403)

  // --- 普通用户在界面上看到的形态 -----------------------------------------
  await primeToken(page, userSession)
  await page.goto(`${daemon.baseUrl}/events?tab=sources`)
  await expect(page.getByTestId('webhook-endpoints')).toBeVisible()
  await expect(
    page.getByTestId(`webhook-endpoint-url-masked-${endpoint.id}`),
    '脱敏 viewer 的卡片上没有渲染掩码地址 ⇒ 要么泄露了明文，要么这一行干脆没有地址可看',
  ).toHaveText(`/webhooks/gitlab/•••• ${plaintext.slice(-4)}`)
  expect(
    (await page.content()).includes(plaintext),
    '页面 HTML 里带着明文 URL token ⇒ 界面上打了码，但 view-source 一按就全出来了',
  ).toBe(false)
  expect(
    await page.getByTestId('webhook-endpoint-add').count(),
    '没有管理权限的人看得到「新建端点」入口 ⇒ 他会点下去、然后吃一个 403',
  ).toBe(0)
})

// ---------------------------------------------------------------------------
// EVENT-10 —— 三种打不中的请求一律 404 同形
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-10：未知 provider / 未知 URL token / provider 与端点不匹配三者 404 同形，都不留投递行，而验签失败仍然是 401 @nightly', async () => {
  const endpoint = await createEndpoint()

  // 三种「打不中」的形态。它们必须**逐字**一样：任何一处差异都是一个免费的
  // 探测口子——外部据此就能把 provider 段和 token 段分别试出来。
  const probes: Array<{ what: string; res: Response }> = [
    {
      what: '未知 provider',
      res: await deliver(endpoint, {
        provider: 'bitbucket',
        eventUuid: `rfc319-404-provider-${++sequence}`,
      }),
    },
    {
      what: '未知 URL token',
      res: await deliver(endpoint, {
        urlToken: 'aw_whk_definitely_not_a_real_token',
        eventUuid: `rfc319-404-token-${++sequence}`,
      }),
    },
    {
      what: 'provider 与端点不匹配',
      res: await deliver(endpoint, {
        provider: 'github',
        eventUuid: `rfc319-404-mismatch-${++sequence}`,
      }),
    },
  ]
  const shapes: string[] = []
  for (const probe of probes) {
    shapes.push(`${probe.res.status} ${await probe.res.text()}`)
  }
  expect(
    new Set(shapes).size,
    `三种打不中的请求回答不一致（${probes
      .map((p, i) => `${p.what}=${shapes[i]}`)
      .join(' | ')}）⇒ 不带任何凭据的扫描器可以据此把存在的 URL token 与它的 provider 逐个问出来`,
  ).toBe(1)
  expect(shapes[0], '打不中的请求回的不是 404 not-found').toBe('404 {"error":"not-found"}')

  // provider 不匹配那一条打中了一个**真实存在**的端点。它绝不能留下审计行：
  // 否则任何人都能不带凭据地往别人的投递审计里灌数据。
  const rows = await deliveriesOf(endpoint.id)
  expect(
    rows.total,
    '打不中的请求在真实端点上落了投递行 ⇒ 无凭据的外部请求可以把投递表撑爆，' +
      '同时把真正的投递淹没在噪声里',
  ).toBe(0)

  // 反向对照：地址打中了、只是 secret 不对，回的必须是 401 而不是 404。
  // 没有这一条，上面三条可能只是因为「这个入口对谁都 404」。
  const wrongSecret = await deliver(endpoint, {
    secret: 'definitely-not-the-secret',
    eventUuid: `rfc319-404-control-${++sequence}`,
  })
  expect(
    wrongSecret.status,
    '验签失败也被塌缩成 404 ⇒ 运维在 GitLab 的 Recent Deliveries 里看不到红色，' +
      '一个配错 secret 的接入会安静地一直丢事件（routes/webhooks.ts:13-16 要求 401 只给验签失败）',
  ).toBe(401)
  // 同一个查询在真的有行的时候确实查得到——否则上面那条 total=0 什么都没证明。
  expect(
    (await deliveriesOf(endpoint.id)).total,
    '打中地址、验签失败的那一条也没有落审计行 ⇒ 上面「打不中不落行」的断言是恒真的',
  ).toBe(1)
})

// ---------------------------------------------------------------------------
// EVENT-11 —— body 上限
// ---------------------------------------------------------------------------

/** 造一个字节数**精确**等于 size 的 GitLab 事件体（padding 用单字节 ASCII）。 */
function bodyOfExactSize(size: number): string {
  const skeleton = {
    object_kind: 'wiki_page',
    user: { username: 'rfc319-human' },
    project: projectBlock('rfc319/oversized'),
    pad: '',
  }
  const base = JSON.stringify(skeleton).length
  expect(size, '目标体积比骨架还小，padding 无从谈起').toBeGreaterThan(base)
  return JSON.stringify({ ...skeleton, pad: 'x'.repeat(size - base) })
}

test('RFC-319 EVENT-11：超过 1MiB 的 body 在流式读取中就被截断成 413，一行审计都不落；正好 1MiB 仍然收下 @nightly', async () => {
  const endpoint = await createEndpoint()
  const limit = 1024 * 1024

  // 三个体积档位一起打：超一个字节、超 4KiB、超 8 倍。第三档是要害——
  // 服务端如果先把 body 收全再判大小，8MiB 就已经进了进程内存；几个并发
  // 请求就能把跑着所有人任务的 daemon 打到 OOM。
  const oversized: Array<{ what: string; res: Response }> = []
  for (const [what, size] of [
    ['刚好超一个字节', limit + 1],
    ['超 4KiB', limit + 4096],
    ['超 8 倍', limit * 8],
  ] as Array<[string, number]>) {
    oversized.push({
      what,
      res: await deliver(endpoint, {
        body: bodyOfExactSize(size),
        eventUuid: `rfc319-oversized-${++sequence}`,
      }),
    })
  }
  for (const attempt of oversized) {
    const body = await attempt.res.text()
    expect(
      attempt.res.status,
      `${attempt.what} 的 body 没有被拒：${attempt.res.status} ${body}`,
    ).toBe(413)
    expect(
      body,
      `${attempt.what} 拒了但没给出稳定的 payload-too-large ⇒ 发件方无法区分「太大」和「服务坏了」`,
    ).toBe('{"error":"payload-too-large"}')
  }

  // 超限的请求**必须**在验签之前就被挡掉（上限检查在 unseal/verify 之前，
  // routes/webhooks.ts:126-156）。所以带着错 secret 的超大 body 同样是 413：
  // 谁都不能靠「先塞一个巨大的 body」来消耗验签与入库这两段成本。
  const oversizedUnsigned = await deliver(endpoint, {
    secret: 'definitely-not-the-secret',
    body: bodyOfExactSize(limit + 1),
    eventUuid: `rfc319-oversized-unsigned-${++sequence}`,
  })
  expect(
    oversizedUnsigned.status,
    '超大 body 先过了验签才被拒 ⇒ 上限检查形同虚设：内容已经被完整读进内存了',
  ).toBe(413)

  const afterOversized = await deliveriesOf(endpoint.id)
  expect(
    afterOversized.total,
    '被拒的超大投递还是落了审计行 ⇒ 任何人都能用一串巨大的请求把投递表和磁盘撑满',
  ).toBe(0)

  // 边界的另一侧：正好 1MiB 必须收下。上限如果悄悄低于 1MiB，一条带着大
  // diff 的真实投递会被丢掉，而 GitLab 对失败的投递不重投——事件永久丢失。
  const exact = await deliver(endpoint, {
    body: bodyOfExactSize(limit),
    eventUuid: `rfc319-exact-limit-${++sequence}`,
    eventHeader: 'Wiki Page Hook',
  })
  const exactBody = await exact.text()
  expect(exact.status, `正好 1MiB 的 body 被拒了：${exact.status} ${exactBody}`).toBe(200)
  const afterExact = await deliveriesOf(endpoint.id)
  expect(
    afterExact.total,
    '正好 1MiB 的投递收下了却没有留下审计行 ⇒ 收了什么、为什么没下文，事后无从查起',
  ).toBe(1)
})

// ---------------------------------------------------------------------------
// EVENT-12 —— 两档限流
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-12：端点 300/min 与未命中 600/min 两档限流各自在越线那一下开始 429，且互不牵连 @nightly', async () => {
  // 限流是**进程内**滑窗（rateLimiter.ts:13-39），计数随 daemon 生命周期存在，
  // 而全局未命中闸只有一个桶（key 恒为 'global'）。想精确断言「第 601 条才 429」
  // 就必须在一个干净进程上跑——别的用例只要打过一次不存在的地址，这个桶就已经
  // 有账了。所以这条用例自带一个 daemon。
  const own = await startDaemon()
  try {
    const endpointA = await createEndpoint({}, own.baseUrl, own.token)
    const endpointB = await createEndpoint({}, own.baseUrl, own.token)

    /** 并发打一批，只收状态码。滑窗的记账是同步发生的，所以并发不影响总数。 */
    const burst = async (total: number, urlOf: (i: number) => string): Promise<number[]> => {
      const codes: number[] = []
      const batch = 32
      for (let i = 0; i < total; i += batch) {
        const chunk = await Promise.all(
          Array.from({ length: Math.min(batch, total - i) }, (_unused, k) =>
            fetch(urlOf(i + k), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // 故意用错的 secret：这样每条请求都在**限流闸之后**立刻终结，
                // 既走完了限流记账，又不会去跑事件分发。
                'x-gitlab-token': 'not-the-secret',
                'x-gitlab-event': 'Push Hook',
                'x-gitlab-event-uuid': `rfc319-rate-${i + k}`,
              },
              body: '{}',
            }).then((res) => res.status),
          ),
        )
        codes.push(...chunk)
      }
      return codes
    }

    // --- 第一档：单端点 300/min --------------------------------------------
    const startedAt = Date.now()
    const endpointCodes = await burst(
      320,
      () => `${own.baseUrl}/webhooks/gitlab/${endpointA.urlToken}`,
    )
    const endpointElapsed = Date.now() - startedAt
    // 这条不是在测产品，是在保护上面那条断言的前提：滑窗是 60s，整轮请求必须
    // 在窗口内跑完，否则最早那些请求已经过期，「正好 300 条放行」就不再成立。
    expect(
      endpointElapsed,
      `这轮 320 个请求跑了 ${endpointElapsed}ms，接近 60s 滑窗 ⇒ 计数会因为窗口滚动而失真，` +
        '本条断言不再有意义（这是环境太慢，不是产品问题）',
    ).toBeLessThan(30_000)
    expect(
      endpointCodes.filter((code) => code !== 429).length,
      '单个端点上放行的条数不是 300 ⇒ 放少了：一次几百个仓库的批量 push 会被误伤成 429，' +
        '而 GitLab 不重投，事件直接丢；放多了：闸门形同虚设，一个失控的仓库就能把 daemon 打满',
    ).toBe(300)
    expect(
      [...new Set(endpointCodes.filter((code) => code !== 429))],
      '放行的那些请求里出现了 401 之外的状态码 ⇒ 它们并没有真的走到验签，说明限流之外还有别的东西在拦',
    ).toEqual([401])
    expect(endpointCodes.filter((code) => code === 429).length).toBe(20)

    // 隔离：A 被限住的同时 B 必须照常收件。两个团队的接入共用一个 daemon，
    // 一个仓库刷屏不能让另一个团队的事件全部消失。
    const otherEndpoint = await deliver(endpointB, {
      base: own.baseUrl,
      eventUuid: 'rfc319-rate-isolation',
    })
    expect(
      otherEndpoint.status,
      '一个端点被限流之后，另一个端点也跟着 429 ⇒ 任何人都能用自己的端点把别人的入口一起打停',
    ).not.toBe(429)

    // --- 第二档：未命中 token 的全局闸 600/min -----------------------------
    const unmatchedStartedAt = Date.now()
    const unmatchedCodes = await burst(
      640,
      (i) => `${own.baseUrl}/webhooks/gitlab/aw_whk_rfc319_missing_${i}`,
    )
    const unmatchedElapsed = Date.now() - unmatchedStartedAt
    expect(
      unmatchedElapsed,
      `这轮 640 个请求跑了 ${unmatchedElapsed}ms，接近 60s 滑窗 ⇒ 同上，计数失真`,
    ).toBeLessThan(30_000)
    expect(
      unmatchedCodes.filter((code) => code === 404).length,
      '未命中任何端点的请求放行条数不是 600 ⇒ 放多了等于没有防扫描闸：' +
        'URL token 的枚举成本被拉回到「随便打」；放少了则会在真实的误配置场景里' +
        '把正常 404 变成 429，掩盖掉「地址配错了」这个真正的原因',
    ).toBe(600)
    expect(
      unmatchedCodes.filter((code) => code === 429).length,
      '越过全局阈值之后没有开始 429 ⇒ 防扫描闸没有生效',
    ).toBe(40)

    // 全局闸拦的是**打不中**的请求，不该牵连打得中的端点。
    const matchedAfterFlood = await deliver(endpointB, {
      base: own.baseUrl,
      eventUuid: 'rfc319-rate-after-flood',
    })
    expect(
      matchedAfterFlood.status,
      '外部扫描把全局闸打满之后，正常端点也收不了件 ⇒ 任何人都能不带凭据地让整台机器停止接收事件',
    ).not.toBe(429)
  } finally {
    await own.stop()
  }
})

// ---------------------------------------------------------------------------
// EVENT-13 —— 合法但平台不支持的事件
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-13：平台不处理的合法事件一律 200 + ignored(unsupported-event)，绝不回 4xx @nightly', async () => {
  const endpoint = await createEndpoint()
  const repoPath = 'rfc319/unsupported-fixture'

  const cases: Array<{ what: string; objectKind: string; body: string; uuid: string }> = [
    {
      what: '整类不处理的 object_kind（wiki_page）',
      objectKind: 'wiki_page',
      uuid: `rfc319-unsupported-wiki-${++sequence}`,
      body: JSON.stringify({
        object_kind: 'wiki_page',
        user: { username: 'rfc319-human' },
        project: projectBlock(repoPath),
        object_attributes: { title: 'Home', action: 'update' },
      }),
    },
    {
      what: '同类事件里不处理的动作（merge_request / approved）',
      objectKind: 'merge_request',
      uuid: `rfc319-unsupported-mr-${++sequence}`,
      body: JSON.stringify({
        object_kind: 'merge_request',
        user: { username: 'rfc319-human' },
        project: projectBlock(repoPath),
        object_attributes: {
          action: 'approved',
          iid: 41,
          source_branch: 'feature/x',
          target_branch: 'main',
        },
      }),
    },
    {
      what: '中间态（pipeline / running）',
      objectKind: 'pipeline',
      uuid: `rfc319-unsupported-pipeline-${++sequence}`,
      body: JSON.stringify({
        object_kind: 'pipeline',
        user: { username: 'rfc319-human' },
        project: projectBlock(repoPath),
        object_attributes: { id: 4100, ref: 'main', status: 'running', sha: 'abc' },
      }),
    },
  ]

  for (const item of cases) {
    const res = await deliver(endpoint, { body: item.body, eventUuid: item.uuid })
    const text = await res.text()
    expect(
      res.status,
      `${item.what} 回了 ${res.status} ⇒ 对 GitLab 的每一次 4xx 都会被计入失败；` +
        '累积到阈值它会**自动禁用**这个 hook，而几百个仓库共用的往往就是这一个 group hook：' +
        `受害的不是发这条事件的仓库，是所有人（routes/webhooks.ts:186-190）：${text}`,
    ).toBe(200)
    expect(
      JSON.parse(text),
      `${item.what} 的应答没有说明它被忽略了 ⇒ 发件方以为平台接下了这件事`,
    ).toMatchObject({ status: 'ignored' })
  }

  // 审计行必须把「为什么没下文」写清楚，而且要和「解析失败」区分开：
  // 前者是「这个事件我们不管」，后者是「这个事件我们没看懂」——运维要采取的
  // 行动完全不同（前者不用管，后者要去看 payload）。
  const rows = await deliveriesOf(endpoint.id)
  const byUuid = new Map(rows.items.map((row) => [row.eventUuid, row]))
  for (const item of cases) {
    const row = byUuid.get(item.uuid)
    expect(row, `${item.what} 连审计行都没有 ⇒ 事件石沉大海，事后完全查不到它来过`).toBeDefined()
    expect(
      row?.statusReason,
      `${item.what} 的忽略原因不是 unsupported-event ⇒ 运维会把「平台不管这类事件」误读成解析出错，` +
        '跑去排查一个根本不存在的问题',
    ).toBe('unsupported-event')
    expect(
      row?.objectKind,
      `${item.what} 的审计行没有记下事件种类 ⇒ 「到底哪类事件被忽略了」在事后无法回答`,
    ).toBe(item.objectKind)
  }

  // 反向对照：同一个端点上，一条**受支持**的事件必须走到 received。
  // 没有这一条，上面三条可能只是因为「这个端点忽略一切」。
  const supported = await deliver(endpoint, {
    body: JSON.stringify({
      object_kind: 'pipeline',
      user: { username: 'rfc319-human' },
      project: projectBlock(repoPath),
      object_attributes: { id: 4200, ref: 'main', status: 'failed', sha: 'def' },
    }),
    eventUuid: `rfc319-supported-${++sequence}`,
  })
  expect(
    JSON.parse(await supported.text()),
    '受支持的事件也被判成 ignored ⇒ 上面三条证明不了「忽略是针对事件种类的」，' +
      '而且真正该开工的事件在这里被丢掉了',
  ).toMatchObject({ status: 'received' })
})
