// RFC-319 —— IAM 前缀的用户面 e2e：OIDC 登录一族（IAM-07 / 09 / 10 / 11 / 15）
// 加上三条资源权限判据（IAM-33 / 35 / 48）与一条强制改密信号链（IAM-X1）。
//
// 这一批的共同点是：**判错的代价不对称，而且大部分没有界面可以自查**。
// 逐条说清这里到底在防什么：
//
//   * 【IAM-07】授权码登录是「一个陌生人怎么变成系统里的一个 active 账号」的
//     **唯一**入口。它坏掉的形态不是报错，而是「按钮点下去什么都没发生」或者
//     「登进来了但会话没落地、下一次刷新又回登录页」。既有覆盖
//     （`e2e/system-mocks.spec.ts`、`e2e/oidc-provisioning-refusals.spec.ts`）
//     都是用 `fetch` 手工调 `login/start` 起流的——`/auth` 上那个 provider 按钮
//     **从来没有被点过一次**，`stores/auth.ts` 的 `#aw_session=` 片段消费也只是
//     被间接带到。本条从 `/auth` 出发，一路点到 `/agents`。
//   * 【IAM-09】邀请绑定是「管理员先建号、本人后到」的那条路：建号时**没有密码**，
//     账号停在 `invited`，只有 IdP 送回同一个已验证邮箱时才被绑定并激活。它坏掉
//     的形态最坏——`bindInvited` 分支一旦退化成 `create`，同一个人会得到**第二个**
//     账号，而管理员在第一个账号上配的角色 / 授权全部落空，且没有任何报错。
//   * 【IAM-10】回调失败态是**唯一**会直接呈现给终端用户的 OIDC 界面。四种成因
//     必须各自成立且互相分得开：state 过期是「重试一次就好」，provider 被停用是
//     「找管理员」，端点解析失败是「IdP 或配置出问题了」，换 token 失败是「凭据
//     或 IdP 侧故障」。混成一句 `OIDC login failed.` 等于把用户和管理员一起推进
//     黑箱。这条同时锁住**它是一张 HTML 友好页而不是 JSON 500**。
//   * 【IAM-11】provider 的增删改查是管理员唯一的配置面。既有 e2e 只在
//     `ux-consistency.spec.ts` 里用 `page.route` 灌假数据后点 Cancel——没有一次
//     真的落库。本条全程真 daemon：新增之后立刻用它起一次真实登录流，编辑时
//     **secret 留空**再跑一次完整回调（走到 `not-invited` 说明换 token 成功、
//     密封的 secret 没被空串覆盖），连接测试正反两种结果，最后删除。
//   * 【IAM-15】OIDC 托管账号在本站改密码是一条**权限提升**路径：本地密码一旦能
//     被写进去，IdP 侧的停用 / 改密就管不住这个账号了。判据必须**两层**：界面不
//     给表单，服务端也拒绝——只有前者等于任何脚本都能绕过。
//   * 【IAM-33】ACL 面板的 409 是并发管理员的最后一道防线。它坏掉的形态是静默
//     覆盖：A 刚把 carol 加进来，B 的旧快照一保存就把 carol 抹掉，两个人都以为
//     自己成功了。所以「保存失败之后弹窗**不许关**」与「同一份陈旧草稿重试仍然
//     失败」是同等重要的判据——弹窗一关，用户就以为存住了。
//   * 【IAM-35】RFC-317 C1 的教训：这五类配置资源的写路径曾经只做「看得见就写得
//     动」，而 `user` 角色预设本就持有它们的 `:update` / `:archive` 点，于是任何
//     登录用户都能改写别人的 public 动作模板。本条把「持有权限点」与「不是 owner」
//     两件事同时摆上台面——只断言 403 而不证明 bob 真的持有那个点，用例会在权限
//     点被误删时假绿。
//   * 【IAM-48】内置资源的权限只读：`assertNotBuiltin` 在 ACL PUT 的**事务内**
//     那一跳。它坏掉的后果是框架自带的融合代理 / 融合工作流可以被私有化，从此
//     所有人的技能融合一起挂。
//   * 【IAM-X1】强制改密：后端在三处发信号（登录回执 `mustChangePassword`、
//     `GET /api/users` 的 `forcePasswordChange`、改密时允许省略 `oldPassword`），
//     **前端零消费**（见文末 §产品缺陷）。本条只锁后端确实发了信号这一段，
//     不锁「界面把用户引到哪里」——那正是将来修复时要改的地方。
//
// 判据全部取自源码单一事实源（纯文本引用，禁 GitHub 外链——外链会被 CI 的
// markdown link check 逐条请求，见 CLAUDE.md §opencode 源码自取规则）：
//   packages/frontend/src/routes/auth.tsx:242-255            handleOidcLogin：POST login/start 后整页跳转
//   packages/frontend/src/routes/auth.tsx:303-338            auth-oidc-method 面板与 aria-label="Login with X" 按钮
//   packages/frontend/src/stores/auth.ts:44-63               `#aw_session=` 片段消费（模块初始化时机）
//   packages/backend/src/routes/oidc-auth.ts:96-108          startFlow + buildAuthorizeUrl（PKCE S256 + nonce + state）
//   packages/backend/src/routes/oidc-auth.ts:124-144         回调四道前置门：bootstrap / secretBox / 参数 / state / provider / 端点
//   packages/backend/src/routes/oidc-auth.ts:146-178         换 token + 取声明；失败一律 friendly(code) 400
//   packages/backend/src/routes/oidc-auth.ts:210-299         provisioning 判定 → 建号 / 绑定 → `#aw_session=` 重定向
//   packages/backend/src/services/oidc/provisioning.ts:57-82 decideProvisioning 六分支（本文件只走 auto / invite）
//   packages/backend/src/services/userIdentities.ts:256-275  bindInvitedUserWithIdentity：同一事务里置 active + 插身份
//   packages/backend/src/util/oidcResponse.ts:5-45           友好页文案表 + friendly() 的 HTML 外壳
//   packages/backend/src/auth/oidc/endpoints.ts:177-219      resolveEndpoints：discovery 合并 manual + 两级缓存
//   packages/backend/src/auth/oidc/identity.ts:209-240       id_token + JWKS 可用时走验签路径
//   packages/backend/src/auth/oidc/tokens.ts:81-102          换 token 的三种失败形态
//   packages/backend/src/services/oidcProviders.ts:186-188   PATCH 空 clientSecret = 保留原值
//   packages/backend/src/services/oidcProviders.ts:293-358   probe：forceFresh + 逐字段来源 + loginReady 判定
//   packages/backend/src/services/accountAuthPolicy.ts:37-73 writeLocalPasswordIfUnmanaged：有身份就 403
//   packages/backend/src/routes/auth.ts:228-234              change-password 的 oidc-password-managed
//   packages/backend/src/routes/auth.ts:290-310              forcePasswordChange 时允许省略 oldPassword 并清零
//   packages/backend/src/routes/auth.ts:121                  登录回执的 mustChangePassword
//   packages/backend/src/services/users.ts:139-154           resetPassword：OIDC 托管拒绝 + force 落库
//   packages/frontend/src/components/account/AccountSecurityPanel.tsx:34-43  托管账号不渲染改密表单
//   packages/frontend/src/components/users/EditUserDialog.tsx:200-217        托管账号不渲染重置按钮
//   packages/backend/src/services/resourceAcl.ts:814-822     ACL 的 OCC 围栏（resource id + revision）
//   packages/backend/src/services/resourceAcl.ts:897         每次成功 PUT 单调 +1
//   packages/frontend/src/components/AclPanel.tsx:264-275    保存失败后刷新权威快照、草稿围栏保持冻结
//   packages/backend/src/routes/resourceAcl.ts:184-185       assertNotBuiltin 在锁内的新鲜行上执行
//   packages/backend/src/services/systemResources.ts:43-44   两个内置行的确定性 id
//   packages/backend/src/routes/agents.ts:113                excludeBuiltinAgents 把内置行从用户面列表里剥掉
//   packages/backend/src/routes/developmentConfig.ts:336-372 requireEditable / requireGovernable 的分档
//   packages/backend/src/services/resourceAcl.ts:643-660     requireResourceEdit → resource-read-only
//   packages/backend/src/services/resourceAcl.ts:621-633     requireResourceGovern → resource-govern-owner-only
//   packages/shared/src/schemas/permission.ts:979-982        user 预设持有 action-templates 的 update / archive
//
// 与既有覆盖的分工（务必不重复）：
//   · `e2e/oidc-provisioning-refusals.spec.ts` —— IAM-08 的三条**拒绝**分支
//     （allowlist 域 / invite 未邀请 / 邮箱未验证），用共享的 system-mock IdP。
//     本文件一条 provisioning 拒绝分支都不碰，只走 auto 与 invite 的**成功**面
//     以及回调**机制**层面的四种失败。
//   · `e2e/system-mocks.spec.ts` —— API 层的 provider 建号 + 探针 ok + 手工起流。
//     本文件不重复探针的 happy path，只补它没有的**失败**探针与浏览器表单。
//   · `e2e/rfc099-ownership-acl.spec.ts` —— 公开/私有切换、授权后只读面板、
//     所有者转让。本文件的 IAM-33 只碰它没碰的**保存冲突**分支。
//   · `e2e/rfc324-graded-grants.spec.ts` —— 工作流授权分档的浏览器旅程。
//     本文件的 IAM-35 换一类资源（`/api/code/action-templates`）且全程 API，
//     锁的是 RFC-317 C1 那条「看得见 ≠ 写得动」。
//   · `e2e/rfc319-users-and-account.spec.ts` / `e2e/identity-credentials.spec.ts`
//     —— 账号页与凭据面的其余部分。本文件只取「托管账号的改密面」这一格。
//
// 执行模型：一个 daemon + 一台**行为可编程的本地假 IdP**，**不用 serial**
// （`docs/dev-gotchas.md`：serial 下第一条红之后其余 `did not run`，变异验证
// 无法按「红了几条」归因）。每条用例自带 realm / 用户 / provider，互不承接状态。
// 本文件**零 `page.route`**：假 IdP 是一台真的 HTTP 服务，daemon 与浏览器都真
// 连它，因此不存在 `route.fetch()` 的竞态面（`test.afterEach` 里仍按仓规摘一次
// 注入，作为「将来有人加 route 也不会漏」的兜底）。
//
// ⚠️ 假 IdP 的覆盖边界（不要把它当成真 IdP 的等价物，详见报告 §5）：
//   覆盖到 —— discovery 文档、RS256 签名的 id_token + JWKS、PKCE S256 校验、
//   state / nonce 回传、client_secret 校验、userinfo、以及可编程的
//   「discovery 404」与「token 端点 500」两种故障。
//   **没有**覆盖 —— 真实 IdP 的 discovery 字段差异（`response_modes_supported`
//   之类的扩展字段、非标准大小写、`issuer` 带尾斜杠）、JWKS 轮转与多 kid 选择、
//   HTTPS / 证书链、token 端点的 `client_secret_basic` 变体、userinfo 返回
//   `application/jwt`、refresh token 续期、以及任何真实网络时延 / 重试语义。

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(240_000)

const IDP_CLIENT_ID = 'rfc319-iam-client'
// 固定的、一眼可辨的测试口令：gitleaks 的 git 模式扫的是历史，随机串一旦入库
// 就再也改不掉（docs/dev-gotchas.md §gitleaks）。
const IDP_CLIENT_SECRET = 'rfc319-iam-fake-idp-secret'
const IDP_KID = 'rfc319-iam-key-1'
const PASSWORD = 'Rfc319IamPass!1'

/** RFC-223 PR-4 的确定性内建 id（services/systemResources.ts:43-44）。 */
const BUILTIN_MERGER_AGENT_ID = '00000000000000000000000001'
const BUILTIN_FUSION_WORKFLOW_ID = '00000000000000000000000002'

let daemon: DaemonHandle
let idp: FakeIdp

// ---------------------------------------------------------------------------
// 一台行为可编程的假 OIDC provider
// ---------------------------------------------------------------------------

interface IdpUser {
  readonly sub: string
  readonly email: string
  readonly emailVerified: boolean
  readonly name: string
  readonly preferredUsername: string
}

interface TokenRequestRecord {
  clientIdOk: boolean
  clientSecretOk: boolean
  hasCodeVerifier: boolean
  pkceOk: boolean
  redirectUriMatched: boolean
}

interface AuthorizeRequestRecord {
  hasState: boolean
  hasNonce: boolean
  codeChallengeMethod: string | null
  redirectUri: string | null
}

/**
 * 一个 realm = 一个独立 issuer 路径。**必须一条用例一个 realm**：daemon 的
 * discovery 正缓存按 issuerUrl key、TTL 一小时，jose 的 RemoteJWKSet 按
 * jwks_uri key 且与进程同寿（auth/oidc/endpoints.ts:61-95），共用 issuer 会让
 * 前一条用例的成功状态渗进后一条的失败断言里。
 */
interface IdpRealm {
  readonly name: string
  readonly issuer: string
  users: IdpUser[]
  /** 'http-500' 让 /token 端点稳定回 500，用来触发 token-exchange-failed。 */
  tokenMode: 'ok' | 'http-500'
  /** 'not-found' 让 discovery 文档 404，用来触发端点解析失败。 */
  discoveryMode: 'full' | 'not-found'
  readonly requests: string[]
  readonly authorizeRequests: AuthorizeRequestRecord[]
  readonly tokenRequests: TokenRequestRecord[]
}

interface FakeIdp {
  readonly origin: string
  realm(name: string, users: readonly IdpUser[]): IdpRealm
  close(): Promise<void>
}

interface PendingCode {
  realm: string
  redirectUri: string
  codeChallenge: string
  nonce: string
  user: IdpUser
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function writeText(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` })
  res.end(body)
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

async function startFakeIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: IDP_KID,
    alg: 'RS256',
    use: 'sig',
  }
  const realms = new Map<string, IdpRealm>()
  const codes = new Map<string, PendingCode>()
  const accessTokens = new Map<string, { realm: string; user: IdpUser }>()
  const sockets = new Set<Socket>()
  let origin = ''

  const signIdToken = (realm: IdpRealm, user: IdpUser, nonce: string): string => {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT', kid: IDP_KID }
    const payload = {
      iss: realm.issuer,
      sub: user.sub,
      aud: IDP_CLIENT_ID,
      iat: now,
      exp: now + 600,
      nonce,
      email: user.email,
      email_verified: user.emailVerified,
      name: user.name,
      preferred_username: user.preferredUsername,
    }
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey)
    return `${signingInput}.${signature.toString('base64url')}`
  }

  const handle = (req: IncomingMessage, res: ServerResponse, body: Buffer): void => {
    const url = new URL(req.url ?? '/', origin === '' ? 'http://127.0.0.1' : origin)
    const matched = /^\/idp\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname)
    if (matched === null) {
      writeText(res, 404, 'not a realm path')
      return
    }
    const realm = realms.get(matched[1] ?? '')
    if (realm === undefined) {
      // 未注册的 realm 是 IAM-10 「端点解析失败」用到的确定性坏 issuer。
      writeText(res, 404, 'unknown realm')
      return
    }
    const path = matched[2] ?? '/'
    realm.requests.push(`${req.method ?? '?'} ${path}`)

    if (path === '/.well-known/openid-configuration') {
      if (realm.discoveryMode === 'not-found') {
        writeText(res, 404, 'discovery document is switched off for this realm')
        return
      }
      writeJson(res, 200, {
        issuer: realm.issuer,
        authorization_endpoint: `${realm.issuer}/authorize`,
        token_endpoint: `${realm.issuer}/token`,
        userinfo_endpoint: `${realm.issuer}/userinfo`,
        jwks_uri: `${realm.issuer}/jwks.json`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        scopes_supported: ['openid', 'profile', 'email'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }

    if (path === '/jwks.json') {
      writeJson(res, 200, { keys: [publicJwk] })
      return
    }

    if (path === '/authorize') {
      const params = url.searchParams
      realm.authorizeRequests.push({
        hasState: (params.get('state') ?? '') !== '',
        hasNonce: (params.get('nonce') ?? '') !== '',
        codeChallengeMethod: params.get('code_challenge_method'),
        redirectUri: params.get('redirect_uri'),
      })
      // 缺任何一项都当场 400：daemon 一旦不再送 PKCE / state / nonce，
      // 登录会在这里断掉而不是悄悄降级成裸 OAuth。
      for (const key of [
        'client_id',
        'redirect_uri',
        'response_type',
        'state',
        'nonce',
        'code_challenge',
      ]) {
        if ((params.get(key) ?? '') === '') {
          writeText(res, 400, `missing ${key}`)
          return
        }
      }
      if (params.get('client_id') !== IDP_CLIENT_ID) {
        writeText(res, 400, 'unknown client_id')
        return
      }
      if (params.get('response_type') !== 'code') {
        writeText(res, 400, 'unsupported response_type')
        return
      }
      if (params.get('code_challenge_method') !== 'S256') {
        writeText(res, 400, 'unsupported code_challenge_method')
        return
      }
      const chosen = params.get('mock_sub')
      if (chosen === null) {
        // 浏览器路径：渲染一张身份选择页，链接指向同一个 /authorize + mock_sub。
        const links = realm.users
          .map((user) => {
            const next = new URL(`${realm.issuer}/authorize`)
            for (const [k, v] of params.entries()) next.searchParams.set(k, v)
            next.searchParams.set('mock_sub', user.sub)
            return `<p><a data-testid="idp-approve-${htmlEscape(user.sub)}" href="${htmlEscape(
              next.toString(),
            )}">Sign in as ${htmlEscape(user.name)}</a></p>`
          })
          .join('\n')
        writeText(
          res,
          200,
          `<!doctype html><html><head><meta charset="utf-8"><title>RFC-319 mock identity provider</title></head>` +
            `<body><h1>Choose a mock identity</h1>${links}</body></html>`,
          'text/html',
        )
        return
      }
      const user = realm.users.find((candidate) => candidate.sub === chosen)
      if (user === undefined) {
        writeText(res, 400, `unknown mock_sub ${chosen}`)
        return
      }
      const code = randomBytes(24).toString('base64url')
      codes.set(code, {
        realm: realm.name,
        redirectUri: params.get('redirect_uri') ?? '',
        codeChallenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce') ?? '',
        user,
      })
      const back = new URL(params.get('redirect_uri') ?? '')
      back.searchParams.set('code', code)
      back.searchParams.set('state', params.get('state') ?? '')
      res.writeHead(302, { location: back.toString() })
      res.end()
      return
    }

    if (path === '/token') {
      if (realm.tokenMode === 'http-500') {
        writeJson(res, 500, { error: 'server_error', error_description: 'realm is switched off' })
        return
      }
      const form = Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries())
      const pending = codes.get(form.code ?? '')
      const verifier = form.code_verifier ?? ''
      const pkceOk =
        pending !== undefined &&
        createHash('sha256').update(verifier).digest('base64url') === pending.codeChallenge
      const record: TokenRequestRecord = {
        clientIdOk: form.client_id === IDP_CLIENT_ID,
        clientSecretOk: form.client_secret === IDP_CLIENT_SECRET,
        hasCodeVerifier: verifier !== '',
        pkceOk,
        redirectUriMatched: pending !== undefined && pending.redirectUri === form.redirect_uri,
      }
      realm.tokenRequests.push(record)
      if (!record.clientIdOk || !record.clientSecretOk) {
        writeJson(res, 401, { error: 'invalid_client' })
        return
      }
      if (pending === undefined || pending.realm !== realm.name) {
        writeJson(res, 400, { error: 'invalid_grant' })
        return
      }
      codes.delete(form.code ?? '')
      if (!record.redirectUriMatched || !record.pkceOk) {
        writeJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE / redirect_uri' })
        return
      }
      const accessToken = randomBytes(24).toString('base64url')
      accessTokens.set(accessToken, { realm: realm.name, user: pending.user })
      writeJson(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email',
        id_token: signIdToken(realm, pending.user, pending.nonce),
      })
      return
    }

    if (path === '/userinfo') {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
      const entry = accessTokens.get(bearer)
      if (entry === undefined || entry.realm !== realm.name) {
        writeJson(res, 401, { error: 'invalid_token' })
        return
      }
      writeJson(res, 200, {
        sub: entry.user.sub,
        email: entry.user.email,
        email_verified: entry.user.emailVerified,
        name: entry.user.name,
        preferred_username: entry.user.preferredUsername,
      })
      return
    }

    writeText(res, 404, `no such endpoint ${path}`)
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks))
      } catch (error) {
        writeText(res, 500, `fake idp crashed: ${String(error)}`)
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    origin,
    realm(name, users) {
      const realm: IdpRealm = {
        name,
        issuer: `${origin}/idp/${name}`,
        users: [...users],
        tokenMode: 'ok',
        discoveryMode: 'full',
        requests: [],
        authorizeRequests: [],
        tokenRequests: [],
      }
      realms.set(name, realm)
      return realm
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function mockUser(tag: string, overrides: Partial<IdpUser> = {}): IdpUser {
  return {
    sub: `${tag}-sub`,
    email: `${tag}@rfc319.test`,
    emailVerified: true,
    name: `${tag} Mock`,
    preferredUsername: tag,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// daemon 侧夹具
// ---------------------------------------------------------------------------

interface SeededUser {
  username: string
  userId: string
  token: string
}

interface AdminUserRow {
  id: string
  username: string
  email: string | null
  status: 'active' | 'invited' | 'disabled'
  hasOidcIdentity: boolean
  forcePasswordChange: boolean
}

async function raw(
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
  }
}

async function api<T>(
  token: string | null,
  path: string,
  init: RequestInit | undefined,
  what: string,
): Promise<T> {
  const res = await raw(token, path, init)
  expect(res.status < 400, `${what}: HTTP ${res.status} ${res.body}`).toBe(true)
  return (res.body === '' ? undefined : JSON.parse(res.body)) as T
}

async function seedUser(tag: string, role: 'user' | 'admin' = 'user'): Promise<SeededUser> {
  const username = `rfc319iam-${tag}`
  const created = await api<{ id: string }>(
    daemon.token,
    '/api/users',
    {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@rfc319.test`,
        role,
        password: PASSWORD,
      }),
    },
    `seed user ${username}`,
  )
  const login = await api<{ sessionToken: string }>(
    null,
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password: PASSWORD }) },
    `login ${username}`,
  )
  return { username, userId: created.id, token: login.sessionToken }
}

interface ProviderSeed {
  slug: string
  displayName: string
  issuerUrl: string
  provisioning: 'auto' | 'allowlist' | 'invite'
}

async function seedProvider(seed: ProviderSeed): Promise<string> {
  const created = await api<{ id: string }>(
    daemon.token,
    '/api/oidc/providers',
    {
      method: 'POST',
      body: JSON.stringify({
        slug: seed.slug,
        displayName: seed.displayName,
        issuerUrl: seed.issuerUrl,
        clientId: IDP_CLIENT_ID,
        clientSecret: IDP_CLIENT_SECRET,
        scopes: 'openid profile email',
        provisioning: seed.provisioning,
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
        userinfoRequestStyle: 'get_bearer',
        usernameClaim: null,
        emailClaim: null,
        subjectClaim: null,
      }),
    },
    `create provider ${seed.slug}`,
  )
  return created.id
}

async function adminUsers(): Promise<AdminUserRow[]> {
  return api<AdminUserRow[]>(daemon.token, '/api/users', undefined, 'list users')
}

async function userByUsername(username: string): Promise<AdminUserRow | undefined> {
  return (await adminUsers()).find((row) => row.username === username)
}

/** 起一条授权码流，返回 daemon 交给浏览器的 authorizeUrl。 */
async function startLoginFlow(slug: string, postLoginRedirect = '/agents'): Promise<string> {
  const started = await api<{ authorizeUrl: string }>(
    null,
    `/api/auth/oidc/${slug}/login/start`,
    { method: 'POST', body: JSON.stringify({ postLoginRedirect }) },
    `login/start ${slug}`,
  )
  return started.authorizeUrl
}

/** 纯 Node 走完整回环（不开浏览器），返回 daemon 回调的响应。 */
async function completeFlowWithFetch(
  authorizeUrl: string,
  sub: string,
): Promise<{ status: number; body: string; contentType: string; location: string | null }> {
  const withSub = new URL(authorizeUrl)
  withSub.searchParams.set('mock_sub', sub)
  const approved = await fetch(withSub.toString(), { redirect: 'manual' })
  const location = approved.headers.get('location')
  expect(
    location,
    `假 IdP 没有把浏览器送回回调地址（HTTP ${approved.status}）：${await approved.text()}`,
  ).not.toBeNull()
  const callback = await fetch(location as string, { redirect: 'manual' })
  return {
    status: callback.status,
    body: await callback.text(),
    contentType: callback.headers.get('content-type') ?? '',
    location: callback.headers.get('location'),
  }
}

async function openAs(
  browser: Browser,
  token: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await context.addInitScript(
    ([baseUrl, tok]) => {
      window.localStorage.setItem('agent-workflow.baseUrl', baseUrl ?? '')
      window.localStorage.setItem('aw-language', 'en-US')
      if (tok !== null && tok !== undefined)
        window.localStorage.setItem('agent-workflow.token', tok)
    },
    [daemon.baseUrl, token] as const,
  )
  return { context, page: await context.newPage() }
}

function storedToken(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem('agent-workflow.token'))
}

interface WhoamiSnapshot {
  status: number
  source?: string
  username?: string
  userId?: string
}

/** 用浏览器里那份会话令牌自证身份——断言的是 SPA 真的拿到了可用会话。 */
async function whoamiFromBrowser(page: Page): Promise<WhoamiSnapshot> {
  return page.evaluate(async () => {
    const token = window.localStorage.getItem('agent-workflow.token')
    if (token === null) return { status: 0 }
    const response = await fetch('/api/whoami', { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) return { status: response.status }
    const parsed = (await response.json()) as {
      source?: string
      user?: { id?: string; username?: string }
    }
    return {
      status: response.status,
      source: parsed.source,
      username: parsed.user?.username,
      userId: parsed.user?.id,
    }
  })
}

/** 回调失败页的两条共同判据：是 friendly HTML，且没有任何会话落地。 */
async function expectFriendlyFailure(page: Page, message: string): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Login failed', exact: true }),
    '回调失败必须落在 friendly HTML 页上，而不是 JSON 500 / 空白页',
  ).toBeVisible()
  await expect(page.getByText(message, { exact: true })).toBeVisible()
  expect(
    await storedToken(page),
    '登录被拒之后浏览器里仍然躺着会话令牌——拒绝页只是块看板，门其实开着',
  ).toBeNull()
}

test.beforeAll(async () => {
  idp = await startFakeIdp()
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (idp !== undefined) await idp.close()
})

test.afterEach(async ({ page }) => {
  // 本文件不注入任何 page.route（假 IdP 是真服务）；这一句是仓规的统一兜底，
  // 保证将来有人补注入时不会漏掉在飞的 handler。
  await page.unrouteAll({ behavior: 'wait' })
})

// ---------------------------------------------------------------------------
// IAM-07 —— 授权码登录（自动开户）的完整浏览器回环
// ---------------------------------------------------------------------------

test('RFC-319 IAM-07: 从 /auth 点身份提供方按钮走完授权码回环，浏览器落回应用且自动开出一个 active 账号 @nightly', async ({
  browser,
}) => {
  const alice = mockUser('iam07alice')
  const realm = idp.realm('iam07', [alice])
  const displayName = 'RFC-319 IAM-07 IdP'
  await seedProvider({
    slug: 'iam07',
    displayName,
    issuerUrl: realm.issuer,
    provisioning: 'auto',
  })

  const before = (await adminUsers()).map((row) => row.username)
  expect(before, '前置：这个账号必须还不存在，否则走的是 login 分支而不是 create').not.toContain(
    alice.preferredUsername,
  )

  // 干净上下文：没有任何令牌，登录页必须自己把 provider 亮出来。
  const { context, page } = await openAs(browser, null)
  try {
    await page.goto(`${daemon.baseUrl}/auth`)
    await expect(
      page.getByTestId('auth-oidc-method'),
      '注册了一个启用的 provider，登录页却没有身份提供方面板 ⇒ 用户根本没有入口',
    ).toBeVisible()
    const providerButton = page.getByRole('button', { name: `Login with ${displayName}` })
    await expect(providerButton).toBeVisible()

    const daemonOrigin = new URL(daemon.baseUrl).origin
    // 按 pathname 逐段匹配：拼 baseUrl 前缀会被 api-contract-coverage 的
    // e2e 调用扫描器当成一次真实 API 调用（`/api/auth/oidc` 不是注册端点）。
    const callback = page.waitForResponse((res) => {
      const url = new URL(res.url())
      return (
        url.origin === daemonOrigin && /^\/api\/auth\/oidc\/[^/]+\/callback$/.test(url.pathname)
      )
    })
    await providerButton.click()

    await expect(
      page.getByRole('heading', { name: 'Choose a mock identity', exact: true }),
      '点了 provider 按钮却没有跳到 IdP —— handleOidcLogin 的整页跳转断了',
    ).toBeVisible()
    await page.getByTestId(`idp-approve-${alice.sub}`).click()
    expect((await callback).status(), '成功的回调必须是一次 302 重定向回应用').toBe(302)

    // 片段消费发生在模块初始化，落地 URL 上不应再有 `#aw_session=`。
    await page.waitForURL(`${daemon.baseUrl}/agents`)
    expect(
      page.url(),
      '会话令牌还留在地址栏片段里 —— stores/auth.ts 的 replaceState 没跑',
    ).not.toContain('aw_session')
    expect(
      await storedToken(page),
      'SPA 没有把回调送回来的会话令牌存进 localStorage',
    ).not.toBeNull()

    const who = await whoamiFromBrowser(page)
    expect(who).toMatchObject({
      status: 200,
      source: 'session',
      username: alice.preferredUsername,
    })
  } finally {
    await context.close()
  }

  const after = await adminUsers()
  expect(
    after.map((row) => row.username).filter((name) => !before.includes(name)),
    '一次 auto 开户必须恰好新增一个账号',
  ).toEqual([alice.preferredUsername])
  const created = after.find((row) => row.username === alice.preferredUsername)
  expect(created).toMatchObject({
    email: alice.email,
    // IdP 已经验过身份，所以新账号直接 active（routes/oidc-auth.ts:254-258）。
    status: 'active',
    hasOidcIdentity: true,
  })

  // IdP 侧的对账：daemon 真的送了 state / nonce / S256 挑战，并且用
  // code_verifier 完成了 PKCE 兑换。少任何一项都是安全降级而不是功能缺失。
  expect(realm.authorizeRequests.at(-1)).toMatchObject({
    hasState: true,
    hasNonce: true,
    codeChallengeMethod: 'S256',
  })
  expect(realm.tokenRequests).toHaveLength(1)
  expect(realm.tokenRequests[0]).toMatchObject({
    clientIdOk: true,
    clientSecretOk: true,
    hasCodeVerifier: true,
    pkceOk: true,
    redirectUriMatched: true,
  })
})

// ---------------------------------------------------------------------------
// IAM-09 —— 邀请绑定
// ---------------------------------------------------------------------------

test('RFC-319 IAM-09: 管理员在 /users 建的 SSO 账号，本人首次 SSO 登录被绑定并激活而不是另开一个号 @nightly', async ({
  browser,
}) => {
  const invitee = mockUser('iam09invitee')
  const realm = idp.realm('iam09', [invitee])
  await seedProvider({
    slug: 'iam09',
    displayName: 'RFC-319 IAM-09 IdP',
    issuerUrl: realm.issuer,
    // invite：只有事先建好、邮箱一致且已验证的账号才能进来。
    provisioning: 'invite',
  })

  const adminSession = await openAs(browser, daemon.token)
  const username = 'rfc319iam-invited09'
  try {
    const adminPage = adminSession.page
    await adminPage.goto(`${daemon.baseUrl}/users`)
    await adminPage.getByRole('button', { name: 'New user', exact: true }).click()
    const createDialog = adminPage.getByRole('dialog')
    await expect(createDialog).toBeVisible()

    // 「等待身份提供方」这一档 = 不给密码；账号停在 invited。
    await adminPage.getByTestId('users-create-mode-sso').click()
    await expect(
      createDialog.locator('input[type="password"]'),
      '选了 SSO 档还渲染密码输入框 ⇒ 建出来的是本地密码账号，绑定分支永远走不到',
    ).toHaveCount(0)
    await createDialog.getByRole('textbox', { name: /^Username/ }).fill(username)
    await createDialog.getByRole('textbox', { name: /^Display name/ }).fill('Invited 09')
    await createDialog.getByRole('textbox', { name: /^Email/ }).fill(invitee.email)
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(
      adminPage.getByText('The invited account is ready for its first identity-provider sign-in.'),
    ).toBeVisible()
    const row = adminPage.locator('li.user-directory__item', { hasText: `@${username}` })
    await expect(row).toContainText('Awaiting first sign-in')
    await expect(row).toContainText('Awaiting OIDC')
  } finally {
    await adminSession.context.close()
  }

  const invited = await userByUsername(username)
  expect(invited, '建号回执落库失败').toBeDefined()
  expect(invited).toMatchObject({ status: 'invited', hasOidcIdentity: false })
  const idsBefore = (await adminUsers()).map((row) => row.id).sort()

  const { context, page } = await openAs(browser, null)
  try {
    await page.goto(`${daemon.baseUrl}/auth`)
    await page.getByRole('button', { name: 'Login with RFC-319 IAM-09 IdP' }).click()
    await page.getByTestId(`idp-approve-${invitee.sub}`).click()
    await page.waitForURL(`${daemon.baseUrl}/agents`)

    const who = await whoamiFromBrowser(page)
    expect(
      who.userId,
      '首次 SSO 登录登进了另一个账号 ⇒ 绑定退化成开户，管理员配好的角色与授权全部落空',
    ).toBe(invited?.id)
  } finally {
    await context.close()
  }

  const after = await adminUsers()
  expect(
    after.map((row) => row.id).sort(),
    'invite 绑定不许新增账号——多出来的那个就是同一个人的影子账号',
  ).toEqual(idsBefore)
  expect(after.find((row) => row.id === invited?.id)).toMatchObject({
    status: 'active',
    hasOidcIdentity: true,
  })
})

// ---------------------------------------------------------------------------
// IAM-10 —— 回调的四种失败态
// ---------------------------------------------------------------------------

test('RFC-319 IAM-10: 回调的四种失败各自落在能区分成因的友好页上，而且都不发会话 @nightly', async ({
  page,
}) => {
  const user = mockUser('iam10user')
  const okRealm = idp.realm('iam10ok', [user])
  const brokenTokenRealm = idp.realm('iam10token', [user])
  await seedProvider({
    slug: 'iam10a',
    displayName: 'RFC-319 IAM-10 A',
    issuerUrl: okRealm.issuer,
    provisioning: 'auto',
  })
  const disabledProviderId = await seedProvider({
    slug: 'iam10b',
    displayName: 'RFC-319 IAM-10 B',
    issuerUrl: okRealm.issuer,
    provisioning: 'auto',
  })
  const movedProviderId = await seedProvider({
    slug: 'iam10c',
    displayName: 'RFC-319 IAM-10 C',
    issuerUrl: okRealm.issuer,
    provisioning: 'auto',
  })
  await seedProvider({
    slug: 'iam10d',
    displayName: 'RFC-319 IAM-10 D',
    issuerUrl: brokenTokenRealm.issuer,
    provisioning: 'auto',
  })

  // ① state 过期 / 从未存在：一次性 state 消费掉之后重放就是这条。
  const expired = await page.goto(
    `${daemon.baseUrl}/api/auth/oidc/iam10a/callback?code=whatever&state=never-issued`,
  )
  expect(expired?.status(), 'state 对不上必须是 400').toBe(400)
  expect(expired?.headers()['content-type'] ?? '').toContain('text/html')
  await expectFriendlyFailure(page, 'Your login session expired. Please try again.')

  // ② provider 在登录途中被停用：流已经起了，回调时那一行已经不可用。
  const disabledAuthorize = await startLoginFlow('iam10b')
  await api(
    daemon.token,
    `/api/oidc/providers/${disabledProviderId}`,
    { method: 'PATCH', body: JSON.stringify({ enabled: false }) },
    'disable provider iam10b',
  )
  await page.goto(disabledAuthorize)
  await page.getByTestId(`idp-approve-${user.sub}`).click()
  await expectFriendlyFailure(page, 'The selected provider is currently disabled.')

  // ③ 端点解析失败：管理员在登录途中把 issuer 指到了一个解析不出端点的地址，
  //    且没有配任何 manual 端点 ⇒ tokenEndpoint 为 null。
  const movedAuthorize = await startLoginFlow('iam10c')
  await api(
    daemon.token,
    `/api/oidc/providers/${movedProviderId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ issuerUrl: `${idp.origin}/idp/iam10-nonexistent-realm` }),
    },
    'repoint provider iam10c',
  )
  await page.goto(movedAuthorize)
  await page.getByTestId(`idp-approve-${user.sub}`).click()
  await expectFriendlyFailure(
    page,
    'The identity provider endpoints could not be resolved. Contact your administrator.',
  )

  // ④ 换 token 失败：IdP 的 token 端点回 500。
  brokenTokenRealm.tokenMode = 'http-500'
  const brokenAuthorize = await startLoginFlow('iam10d')
  await page.goto(brokenAuthorize)
  await page.getByTestId(`idp-approve-${user.sub}`).click()
  await expectFriendlyFailure(page, 'Failed to exchange the authorization code.')

  // 四条文案必须互不相同——否则「区分成因」只是文档里的承诺。
  const texts = [
    'Your login session expired. Please try again.',
    'The selected provider is currently disabled.',
    'The identity provider endpoints could not be resolved. Contact your administrator.',
    'Failed to exchange the authorization code.',
  ]
  expect(new Set(texts).size).toBe(texts.length)
  // ②③ 都必须**停在 daemon 之前**：一次 token 请求都不该发出去。
  expect(
    okRealm.tokenRequests,
    'provider 已停用 / 端点解析不出来，daemon 却仍然拿授权码去换 token 了',
  ).toHaveLength(0)
})

// ---------------------------------------------------------------------------
// IAM-11 —— 设置 → 身份认证：新增 / 编辑 / 连接测试 / 删除
// ---------------------------------------------------------------------------

test('RFC-319 IAM-11: 设置页新增的 provider 立刻能起真实登录流，留空 secret 的编辑不清空密封值，连接测试两种结论分得开，删除后彻底消失 @nightly', async ({
  browser,
}) => {
  const user = mockUser('iam11user')
  const realm = idp.realm('iam11', [user])
  const slug = 'iam11'

  const session = await openAs(browser, daemon.token)
  const page = session.page
  try {
    await page.goto(`${daemon.baseUrl}/settings?tab=authentication`)
    await expect(page.locator('#settings-section-title-authentication')).toHaveText(
      'Authentication',
      { timeout: 30_000 },
    )

    // ---- 新增 ----
    await page.getByTestId('oidc-add-provider').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Add OIDC provider')).toBeVisible()
    await dialog.getByRole('textbox', { name: /^Slug/ }).fill(slug)
    await dialog.getByRole('textbox', { name: /^Display name/ }).fill('RFC-319 IAM-11 IdP')
    await dialog.getByRole('textbox', { name: /^Issuer URL/ }).fill(realm.issuer)
    await dialog.getByRole('textbox', { name: /^Client ID/ }).fill(IDP_CLIENT_ID)
    await dialog.locator('input[type="password"]').fill(IDP_CLIENT_SECRET)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const row = page.locator('table.account-table tbody tr', { hasText: slug })
    await expect(row, '保存成功但表格里没有这一行 ⇒ 值没落库或列表没刷新').toHaveCount(1)
    await expect(row).toContainText('RFC-319 IAM-11 IdP')
    await expect(row).toContainText('enabled')

    // 表单填出来的这份配置必须**真的能起流**——只看表格多了一行等于什么都没验。
    const authorizeUrl = await startLoginFlow(slug)
    expect(authorizeUrl.startsWith(`${realm.issuer}/authorize`), authorizeUrl).toBe(true)

    const providers = await api<Array<{ id: string; slug: string }>>(
      daemon.token,
      '/api/oidc/providers',
      undefined,
      'list providers',
    )
    const providerId = providers.find((p) => p.slug === slug)?.id
    expect(providerId, '列表里找不到刚建的 provider').toBeDefined()

    // ---- 编辑：只改显示名，secret 留空 ----
    await page.getByTestId(`oidc-edit-${providerId}`).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog.getByText('Edit OIDC provider')).toBeVisible()
    await editDialog.getByRole('textbox', { name: /^Display name/ }).fill('RFC-319 IAM-11 renamed')
    await expect(
      editDialog.locator('input[type="password"]'),
      '编辑态的 secret 输入框必须是空的（占位提示「留空即保留」）——预填任何值都会把密封值覆盖掉',
    ).toHaveValue('')
    await editDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editDialog).toHaveCount(0)
    await expect(row).toContainText('RFC-319 IAM-11 renamed')

    // 留空是否真的保留了密封 secret：跑一次完整回调。provisioning 仍是默认的
    // invite 且没有对应邀请，所以正确的结局是 403 not-invited —— 那句话只有在
    // **换 token 成功**之后才可能出现，正好把 secret 幸存证明出来。
    const outcome = await completeFlowWithFetch(authorizeUrl, user.sub)
    expect(outcome.status, `回调应当走到 provisioning 判定：${outcome.body}`).toBe(403)
    expect(outcome.body).toContain('No invitation found for this email')
    expect(realm.tokenRequests.at(-1)).toMatchObject({ clientSecretOk: true, pkceOk: true })

    // ---- 连接测试：可用 / 不可用两种结论 ----
    await page.getByTestId(`oidc-edit-${providerId}`).click()
    const probeDialog = page.getByRole('dialog')
    await probeDialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    const okResult = probeDialog.locator('.oidc-form__test-result--ok')
    await expect(okResult).toBeVisible()
    await expect(okResult).toContainText('Configuration can complete a sign-in')
    await expect(okResult).toContainText('discovery: reachable')
    await expect(
      okResult,
      '探针必须逐字段报出解析到的端点与来源，否则配错时管理员看不到线索',
    ).toContainText(`${realm.issuer}/token`)
    await expect(okResult).toContainText('(discovery)')

    realm.discoveryMode = 'not-found'
    await probeDialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    const badResult = probeDialog.locator('.oidc-form__test-result--err')
    await expect(
      badResult,
      'IdP 的 discovery 都 404 了，探针仍然说「可以完成登录」⇒ 这个按钮是装饰品',
    ).toBeVisible()
    await expect(badResult).toContainText('Configuration cannot complete a sign-in')
    await expect(badResult).toContainText('discovery unavailable')
    await expect(page.locator('.oidc-form__test-result--ok')).toHaveCount(0)
    await probeDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(probeDialog).toHaveCount(0)

    // ---- 删除 ----
    await page.getByTestId(`oidc-delete-${providerId}`).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toContainText(`Delete provider "RFC-319 IAM-11 renamed"?`)
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(row).toHaveCount(0)
  } finally {
    await session.context.close()
  }

  const remaining = await api<Array<{ slug: string }>>(
    daemon.token,
    '/api/oidc/providers',
    undefined,
    'list providers after delete',
  )
  expect(remaining.map((p) => p.slug)).not.toContain(slug)
  const afterDelete = await raw(null, `/api/auth/oidc/${slug}/login/start`, { method: 'POST' })
  expect(afterDelete.status, '行从表格里消失了，登录端点却还认这个 slug ⇒ 删除只删了界面').toBe(404)
})

// ---------------------------------------------------------------------------
// IAM-15 —— OIDC 托管账号不得在本站改密码
// ---------------------------------------------------------------------------

test('RFC-319 IAM-15: OIDC 托管账号的改密面在界面与服务端两层都关死，管理员也不能替它重置 @nightly', async ({
  browser,
}) => {
  const user = mockUser('iam15user')
  const realm = idp.realm('iam15', [user])
  await seedProvider({
    slug: 'iam15',
    displayName: 'RFC-319 IAM-15 IdP',
    issuerUrl: realm.issuer,
    provisioning: 'auto',
  })
  // 默认新账号是 guest；这条用例要打开 /account，把它抬到 user 以贴近真实场景。
  await api(
    daemon.token,
    '/api/oidc/login-policy',
    { method: 'PUT', body: JSON.stringify({ oidcDefaultRole: 'user' }) },
    'set oidc default role',
  )

  let managedToken: string | null = null
  const { context, page } = await openAs(browser, null)
  try {
    await page.goto(`${daemon.baseUrl}/auth`)
    await page.getByRole('button', { name: 'Login with RFC-319 IAM-15 IdP' }).click()
    await page.getByTestId(`idp-approve-${user.sub}`).click()
    await page.waitForURL(`${daemon.baseUrl}/agents`)
    managedToken = await storedToken(page)
    expect(managedToken).not.toBeNull()

    await page.goto(`${daemon.baseUrl}/account?section=security`)
    await expect(page.getByText('Your identity provider manages the password')).toBeVisible()
    await expect(
      page.locator('form.account-password-form'),
      '托管账号仍然渲染了本地改密表单 ⇒ 用户可以在本站另立一套凭据，IdP 侧的停用就管不住这个账号了',
    ).toHaveCount(0)
  } finally {
    await context.close()
  }

  // 服务端第二层：界面藏起来不算数，接口必须自己拒绝。
  const selfChange = await raw(managedToken, '/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword: PASSWORD, newPassword: 'AnotherPass!12345' }),
  })
  expect(selfChange.status).toBe(403)
  expect(JSON.parse(selfChange.body)).toMatchObject({ code: 'oidc-password-managed' })

  const managed = await userByUsername(user.preferredUsername)
  expect(managed, 'OIDC 账号没建出来，后面的断言全部落空').toBeDefined()

  const adminSession = await openAs(browser, daemon.token)
  try {
    const adminPage = adminSession.page
    await adminPage.goto(`${daemon.baseUrl}/users`)
    await adminPage.getByTestId(`user-manage-${managed?.id}`).click()
    const dialog = adminPage.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(
      dialog.getByText(
        'Password changes are controlled by the linked identity provider. No local reset is available.',
      ),
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Reset password', exact: true }),
      '托管账号的管理弹窗里还给管理员留着「重置密码」按钮 ⇒ 管理员可以给它种一把本地钥匙',
    ).toHaveCount(0)
  } finally {
    await adminSession.context.close()
  }

  const adminReset = await raw(daemon.token, `/api/users/${managed?.id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword: 'AdminForced!12345', force: true }),
  })
  expect(adminReset.status).toBe(403)
  expect(JSON.parse(adminReset.body)).toMatchObject({ code: 'oidc-password-managed' })
})

// ---------------------------------------------------------------------------
// IAM-35 —— 配置资源的写门
// ---------------------------------------------------------------------------

test('RFC-319 IAM-35: 持有 action-templates 写权限点的普通用户改不动别人的 public 模板，read 授权也不行，升到 write 才放开内容而治理面仍然锁死 @nightly', async () => {
  const alice = await seedUser('t35-alice')
  const bob = await seedUser('t35-bob')

  const template = await api<{ id: string }>(
    alice.token,
    '/api/code/action-templates',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-iam35-template',
        capabilityId: 'change.review',
        draft: { note: 'owned by alice' },
      }),
    },
    'alice creates action template',
  )
  await api(
    alice.token,
    `/api/code/action-templates/${template.id}/acl`,
    {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: template.id,
        expectedAclRevision: 0,
      }),
    },
    'alice publishes the template to everyone',
  )

  // 反假绿的前置：bob 必须**真的持有**那两个权限点，403 才说明判据来自归属，
  // 而不是来自「他连粗粒度的门都进不去」。
  const me = await api<{ permissions: string[] }>(bob.token, '/api/auth/me', undefined, 'bob /me')
  expect(me.permissions).toContain('action-templates:update')
  expect(me.permissions).toContain('action-templates:archive')

  interface TemplateContent {
    name: string
    draft: unknown
    publishedRevision: number | null
    archivedAt: number | null
  }
  /** 只取**内容面**四项：`updatedAt` 会被 ACL 写入本身推进，把它算进「内容未变」
   *  会让 ② 的授权步骤自己把用例弄红。 */
  const readBack = async (): Promise<TemplateContent> => {
    const row = await api<TemplateContent>(
      alice.token,
      `/api/code/action-templates/${template.id}`,
      undefined,
      'alice reads her template',
    )
    return {
      name: row.name,
      draft: row.draft,
      publishedRevision: row.publishedRevision,
      archivedAt: row.archivedAt,
    }
  }
  const original = await readBack()

  const bobRevise = (draft: unknown) =>
    raw(bob.token, `/api/code/action-templates/${template.id}`, {
      method: 'PUT',
      body: JSON.stringify({ draft }),
    })
  const bobArchive = () =>
    raw(bob.token, `/api/code/action-templates/${template.id}/archive`, { method: 'POST' })

  // ① 只是 public：看得见，但写不动。
  const visible = await api<{ items: Array<{ id: string }> }>(
    bob.token,
    '/api/code/action-templates',
    undefined,
    'bob lists templates',
  )
  expect(
    visible.items.map((r) => r.id),
    'public 资源对 bob 不可见的话，下面的 403 可能只是 404 的马甲',
  ).toContain(template.id)

  const strangerRevise = await bobRevise({ note: 'bob was here' })
  expect(strangerRevise.status, strangerRevise.body).toBe(403)
  expect(JSON.parse(strangerRevise.body)).toMatchObject({ code: 'resource-read-only' })
  const strangerPublish = await raw(
    bob.token,
    `/api/code/action-templates/${template.id}/publish`,
    {
      method: 'POST',
    },
  )
  expect(strangerPublish.status, strangerPublish.body).toBe(403)
  expect(JSON.parse(strangerPublish.body)).toMatchObject({ code: 'resource-read-only' })
  const strangerArchive = await bobArchive()
  expect(strangerArchive.status, strangerArchive.body).toBe(403)
  expect(JSON.parse(strangerArchive.body)).toMatchObject({ code: 'resource-govern-owner-only' })
  expect(await readBack(), '被拒的写请求却改到了内容 —— 判定在写之后才做').toEqual(original)

  // ② 加成员但只给 read 档：仍然写不动（安全默认，AclPanel 新加的人一律 read）。
  const grant = async (level: 'read' | 'write', expectedAclRevision: number) =>
    api<{ aclRevision: number }>(
      alice.token,
      `/api/code/action-templates/${template.id}/acl`,
      {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'public',
          grants: [{ userId: bob.userId, level }],
          expectedResourceId: template.id,
          expectedAclRevision,
        }),
      },
      `alice grants bob ${level}`,
    )
  const afterRead = await grant('read', 1)
  const readerRevise = await bobRevise({ note: 'bob with a read grant' })
  expect(readerRevise.status, readerRevise.body).toBe(403)
  expect(JSON.parse(readerRevise.body)).toMatchObject({ code: 'resource-read-only' })
  expect(await readBack()).toEqual(original)

  // ③ 升到 write：内容写放开，但治理面（archive）仍然只认 owner。
  await grant('write', afterRead.aclRevision)
  const editorRevise = await bobRevise({ note: 'bob with a write grant' })
  expect(editorRevise.status, editorRevise.body).toBe(200)
  expect(await readBack()).toMatchObject({ draft: { note: 'bob with a write grant' } })
  const editorArchive = await bobArchive()
  expect(
    editorArchive.status,
    '编辑授权把归档权也一起带过去了 —— 归档与删除同级，只有 owner 能做',
  ).toBe(403)
  expect(JSON.parse(editorArchive.body)).toMatchObject({ code: 'resource-govern-owner-only' })
  expect((await readBack()).archivedAt).toBeNull()
})

// ---------------------------------------------------------------------------
// IAM-48 —— 内置资源的权限只读
// ---------------------------------------------------------------------------

test('RFC-319 IAM-48: 框架内置的代理与工作流既不出现在用户面列表里，管理员也改不动它们的权限 @nightly', async ({
  browser,
}) => {
  const beforeAgent = await api<{ visibility: string; canManage: boolean }>(
    daemon.token,
    `/api/agents/${BUILTIN_MERGER_AGENT_ID}/acl`,
    undefined,
    'read builtin agent acl',
  )
  expect(beforeAgent.visibility, '内置行必须保持 public——它是所有人技能融合链路的依赖').toBe(
    'public',
  )

  const refusedAgent = await raw(daemon.token, `/api/agents/${BUILTIN_MERGER_AGENT_ID}/acl`, {
    method: 'PUT',
    body: JSON.stringify({
      visibility: 'private',
      expectedResourceId: BUILTIN_MERGER_AGENT_ID,
      expectedAclRevision: 0,
    }),
  })
  expect(
    refusedAgent.status,
    '管理员持有 resource-acl:bypass，但内置身份高于归属：这一条必须 403',
  ).toBe(403)
  expect(JSON.parse(refusedAgent.body)).toMatchObject({ code: 'builtin-readonly' })

  const refusedWorkflow = await raw(
    daemon.token,
    `/api/workflows/${BUILTIN_FUSION_WORKFLOW_ID}/acl`,
    {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: BUILTIN_FUSION_WORKFLOW_ID,
        expectedAclRevision: 0,
      }),
    },
  )
  expect(refusedWorkflow.status, refusedWorkflow.body).toBe(403)
  expect(JSON.parse(refusedWorkflow.body)).toMatchObject({ code: 'builtin-readonly' })

  const afterAgent = await api<{ visibility: string }>(
    daemon.token,
    `/api/agents/${BUILTIN_MERGER_AGENT_ID}/acl`,
    undefined,
    're-read builtin agent acl',
  )
  expect(afterAgent.visibility, '被拒之后可见性仍然被改掉了 ⇒ 守卫在写之后才跑').toBe('public')

  // 用户面：内置行根本不进列表，所以界面上连一个入口都不该有。
  const { context, page } = await openAs(browser, daemon.token)
  try {
    await page.goto(`${daemon.baseUrl}/agents`)
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
    // 按**卡片自己的 testid** 定位，不按可访问名。`ResourceSplitPage` 的卡片是整块
    // `<Link>`，可访问名是卡内全部可见文字拼起来的（名字 + 描述 + 徽标），
    // `{ name: 'aw-skill-merger', exact: true }` 因此**在场也匹配不到**——那样写出来的
    // 是一条恒真断言：把 `excludeBuiltinAgents` 整个摘掉它照样绿（2026-08-26 变异实测）。
    // 代理卡没有显式 testid，回退成 `split-card-${key}`，而 agents 路由的 key 就是 id。
    await expect(
      page.getByTestId(`split-card-${BUILTIN_MERGER_AGENT_ID}`),
      '内置代理出现在用户面列表里 ⇒ excludeBuiltinAgents 失效，用户会以为它可编辑',
    ).toHaveCount(0)
    await page.goto(`${daemon.baseUrl}/workflows`)
    await expect(page.getByTestId('workflow-card-aw-skill-fusion')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

// ---------------------------------------------------------------------------
// IAM-33 —— 权限面板上的并发冲突
// ---------------------------------------------------------------------------

test('RFC-319 IAM-33: 权限面板撞上并发 ACL 改动时保存被 409 挡住——弹窗不关、面板刷回权威快照、陈旧草稿没有覆盖对方 @nightly', async ({
  browser,
}) => {
  const alice = await seedUser('t33-alice')
  const agent = await api<{ id: string }>(
    alice.token,
    '/api/agents',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'rfc319-iam33-agent',
        description: 'rfc319 IAM-33 fixture',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'fixture body',
      }),
    },
    'alice creates agent',
  )

  const { context, page } = await openAs(browser, alice.token)
  try {
    await page.goto(`${daemon.baseUrl}/agents/${agent.id}`)
    await page.getByTestId('detail-more-actions').click()
    await page.getByTestId('detail-actions-dialog').getByTestId('acl-dialog-button').click()
    const panel = page.getByTestId('acl-panel')
    await expect(panel).toBeVisible()

    // 面板已经握着 aclRevision=0 的快照；先把草稿改脏（RFC-231 起新建即 private）。
    await page.getByTestId('acl-visibility-public').click()

    // 另一个写者（这里用 alice 自己的另一条通道，等价于第二个管理员的浏览器）
    // 抢先落了一次 ACL 写入，revision 前进到 1。
    const bumped = await api<{ aclRevision: number }>(
      alice.token,
      `/api/agents/${agent.id}/acl`,
      {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'private',
          expectedResourceId: agent.id,
          expectedAclRevision: 0,
        }),
      },
      'concurrent writer bumps the acl revision',
    )
    expect(bumped.aclRevision, '并发写没有推进 revision，冲突分支根本不可达').toBe(1)

    await page.getByTestId('acl-save').click()

    // 判据一：弹窗**不许关**。一次成功的保存才关弹窗（AclPanel.tsx:256）；
    // 撞了 409 还关，用户就得到了一个「已保存」的假信号。
    await expect(
      panel,
      '保存被 409 挡下之后弹窗仍然关掉了 ⇒ 用户会以为改动存住了，而服务端上是对方的值',
    ).toBeVisible()
    // 判据二：面板收敛回**权威**快照，而不是继续显示那份陈旧草稿。
    await expect(page.getByTestId('acl-visibility-private')).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 15_000 },
    )
    await expect(page.getByTestId('acl-visibility-public')).toHaveAttribute('aria-checked', 'false')

    const afterConflict = await api<{ visibility: string; aclRevision: number }>(
      alice.token,
      `/api/agents/${agent.id}/acl`,
      undefined,
      'read acl after the conflict',
    )
    expect(
      afterConflict,
      '陈旧草稿还是盖掉了并发写者的结果 —— OCC 围栏形同虚设，两个管理员都会以为自己成功了',
    ).toMatchObject({ visibility: 'private', aclRevision: 1 })

    // 判据三（正向对照）：冲突不是死锁。在刷新后的快照上重做同一个改动必须成功，
    // 否则「刷回权威值」就退化成了「这个面板从此再也存不进东西」。
    await page.getByTestId('acl-visibility-public').click()
    await page.getByTestId('acl-save').click()
    await expect(panel, '在新快照上重做同样的改动仍然存不进去 ⇒ 冲突把面板永久锁死了').toHaveCount(
      0,
    )
  } finally {
    await context.close()
  }

  const authoritative = await api<{ visibility: string; aclRevision: number }>(
    alice.token,
    `/api/agents/${agent.id}/acl`,
    undefined,
    'read authoritative acl',
  )
  expect(
    authoritative,
    '重做的那次保存没有落库 ⇒ 弹窗关了但什么都没存，这比报错更坏',
  ).toMatchObject({ visibility: 'public', aclRevision: 2 })
})

// ---------------------------------------------------------------------------
// IAM-X1 —— 强制改密的信号链
// ---------------------------------------------------------------------------

test('RFC-319 IAM-X1: 管理员勾了「下次登录必须改密」之后，后端三处信号（用户行 / 登录回执 / 免旧密码改密）确实成立 @nightly', async ({
  browser,
}) => {
  const target = await seedUser('tx1-target')
  const NEW_PASSWORD = 'Rfc319ForcedPass!1'

  const adminSession = await openAs(browser, daemon.token)
  try {
    const adminPage = adminSession.page
    await adminPage.goto(`${daemon.baseUrl}/users`)
    await adminPage.getByTestId(`user-manage-${target.userId}`).click()
    await adminPage.getByRole('button', { name: 'Reset password', exact: true }).click()
    const resetDialog = adminPage.getByRole('dialog')
    await expect(resetDialog.getByText(`Reset password for ${target.username}`)).toBeVisible()
    const passwords = resetDialog.locator('input[type="password"]')
    await passwords.nth(0).fill(NEW_PASSWORD)
    await passwords.nth(1).fill(NEW_PASSWORD)
    // Switch 落的是 <input type="checkbox">（components/Form.tsx:452-465），
    // 无障碍名取自包裹 label 的全部文本，所以按前缀正则认。
    const forceSwitch = resetDialog.getByRole('checkbox', {
      name: /^Require another password change at next sign-in/,
    })
    await expect(
      forceSwitch,
      '「下次登录必须改密」的默认值不是开 ⇒ 管理员重置口令时会默默留下一把长期有效的临时密码',
    ).toBeChecked()
    await resetDialog.getByRole('button', { name: 'Save new password', exact: true }).click()
    await expect(
      adminPage.getByText('The password was reset and existing web sessions were revoked.'),
    ).toBeVisible()
  } finally {
    await adminSession.context.close()
  }

  // 信号一：用户行上的 forcePasswordChange。
  expect(
    (await adminUsers()).find((row) => row.id === target.userId),
    '界面上的开关没有落到用户行 —— 管理员以为设了，实际没有',
  ).toMatchObject({ forcePasswordChange: true })

  // 信号二：登录回执里的 mustChangePassword（浏览器真登一次）。
  const { context, page } = await openAs(browser, null)
  try {
    await page.goto(`${daemon.baseUrl}/auth`)
    const daemonOrigin = new URL(daemon.baseUrl).origin
    // 本文件前面的用例会在同一个 daemon 上留下启用的 provider，于是登录页的首选
    // 方法变成 OIDC（auth.tsx:40-46 把 oidc 排在 password 之前）。方法选择器只在
    // 「不止一种方法」时渲染。先等 discovery 真把密码表单挂上；立即 count tab 会在
    // loading 首帧读到 0，然后把隐藏的密码表单一直等到超时。
    const passwordForm = page.getByTestId('auth-password-form')
    await expect(passwordForm, '密码登录已启用，discovery 却没有挂出密码表单').toBeAttached()
    const passwordTab = page.getByRole('tab', { name: 'Password', exact: true })
    if (!(await passwordForm.isVisible())) {
      await expect(passwordTab, 'OIDC 是首选方法时没有密码切换页签').toBeVisible()
      await passwordTab.click()
    }
    await expect(passwordForm, '密码登录仍然开着，登录页却拿不出密码表单').toBeVisible()
    await passwordForm.getByRole('textbox', { name: /^Username/ }).fill(target.username)
    await passwordForm.locator('input[type="password"]').fill(NEW_PASSWORD)
    const [loginResponse] = await Promise.all([
      page.waitForResponse((res) => {
        const url = new URL(res.url())
        return url.origin === daemonOrigin && url.pathname === '/api/auth/login'
      }),
      passwordForm.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ])
    const receipt = (await loginResponse.json()) as { mustChangePassword?: boolean }
    expect(
      receipt.mustChangePassword,
      '登录回执没有带上 mustChangePassword ⇒ 前端将来想做强制改密引导也无从判断',
    ).toBe(true)
    // 刻意不断言「界面把用户引到哪里」：今天前端对这个信号零消费（见文末
    // §产品缺陷），把现状写成断言会挡住将来的修复。
    expect(await storedToken(page), '登录本身应当成立').not.toBeNull()
  } finally {
    await context.close()
  }

  // 信号三：置位期间改密可以省略 oldPassword，改完即清零，此后必须再带旧口令。
  const forced = await api<{ sessionToken: string }>(
    null,
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username: target.username, password: NEW_PASSWORD }) },
    'login as forced user',
  )
  const FINAL_PASSWORD = 'Rfc319ChosenPass!1'
  const changed = await raw(forced.sessionToken, '/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword: FINAL_PASSWORD }),
  })
  expect(
    changed.status,
    '置位期间仍然强制要求 oldPassword ⇒ 被管理员重置的人拿不出旧口令，永远改不了密码',
  ).toBe(200)
  expect(
    (await adminUsers()).find((row) => row.id === target.userId),
    '改完密码之后标志位没有清零 ⇒ 这个账号会被永久允许免旧口令改密',
  ).toMatchObject({ forcePasswordChange: false })

  const secondSession = (JSON.parse(changed.body) as { sessionToken?: string }).sessionToken ?? null
  expect(secondSession, '改密后应当回一枚新的会话令牌').not.toBeNull()
  const again = await raw(secondSession, '/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword: 'Rfc319Another!1' }),
  })
  expect(again.status, again.body).toBe(422)
  expect(JSON.parse(again.body)).toMatchObject({ code: 'old-password-required' })
})

// ---------------------------------------------------------------------------
// §产品缺陷（如实记录，未写成断言）
//
// 【前端对 forcePasswordChange 零消费】—— `grep -rn "mustChangePassword\|
// forcePasswordChange" packages/frontend/src` 零命中。管理员在
// `ResetUserPasswordDialog` 里勾上的那个开关（默认就是开）会让后端在
// `routes/auth.ts:121` 的登录回执里回 `mustChangePassword: true`，也会让
// `routes/auth.ts:294-310` 在这次改密里放行省略的 `oldPassword`；但登录页拿到
// 回执之后直接 `setToken` + 跳转（`routes/auth.tsx:201-206`），没有任何界面把
// 用户引到改密处。实际后果：管理员发出去的临时口令会被长期使用，而「必须改密」
// 这件事只存在于数据库列里。本条用例因此只锁后端三处信号，**不锁**跳转目的地
// ——将来补上引导页时这条用例应当依旧全绿。
//
// 【内置资源的权限弹窗仍然可写】—— `getResourceAcl` 的 `canManage` 只看
// `canGovernAccess`（services/resourceAcl.ts:741），不看 `builtin`，所以持有
// `resource-acl:bypass` 的管理员在面板上会看到可用的「保存」按钮，而
// `routes/resourceAcl.ts:184-185` 的 `assertNotBuiltin` 一定会把这次保存打回。
// 本条用例锁的是服务端拒绝 + 列表里没有入口这两件确定的事，没有把「按钮可点」
// 写成期望（那是缺陷现状，不是契约）。
// ---------------------------------------------------------------------------
