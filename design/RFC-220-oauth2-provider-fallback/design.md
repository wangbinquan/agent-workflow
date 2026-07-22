# RFC-220 设计 — 纯 OAuth 2.0 Provider:手动端点降级与 userinfo 身份源

配套 `proposal.md`;决策 D1-D4 见 proposal §5。本文所有行号为 2026-07-22 HEAD。

## 1. 现状锚点

| 关注点 | 位置 |
| --- | --- |
| Provider zod schema | `packages/shared/src/schemas/oidcProvider.ts:13-51` |
| oidc_providers 表 | `packages/backend/src/db/schema.ts:1738-1761` |
| discovery(严格 4 字段 + 1h 正缓存,无负缓存无超时) | `auth/oidc/discovery.ts:22-58` |
| JWKS 实例随 discovery 缓存(键=issuerUrl) | `auth/oidc/discovery.ts:37-40` |
| token 交换(id_token 硬要求) | `auth/oidc/tokens.ts:37-63` |
| id_token 验签(iss/aud/exp + nonce 强制) | `auth/oidc/tokens.ts:74-95` |
| login/start(discovery 未捕获→500) | `routes/oidc-auth.ts:28-53` |
| callback(discovery→exchange→verify→claims→provisioning) | `routes/oidc-auth.ts:55-185` |
| OidcTokenError 塌码为 verify-failed | `routes/oidc-auth.ts:106-108` |
| service materialize/create/patch | `services/oidcProviders.ts:41-133` |
| /test 路由(discovery + jwks 可达性) | `routes/oidc.ts:60-73` |
| friendly 错误页文案表 | `util/oidcResponse.ts:5-23` |
| provisioning 决策树(email_verified 要求) | `services/oidc/provisioning.ts:45-70` |
| 前端 Provider 表单/Test 展示 | `frontend/src/routes/settings.tsx:1710-2069` |
| authorizeUrl 直接跳转(协议白名单动机) | `frontend/src/routes/auth.tsx:172-178` |
| 前端错误码域映射(`oidc-` 前缀已收编) | `frontend/src/i18n/errors.ts:114` |
| 登录链离线测试基建(stub fetcher + jose 本地签名) | `packages/backend/tests/oidc-login-chain.test.ts` |

## 2. Schema 与存储

### 2.1 shared(`schemas/oidcProvider.ts`)

```ts
// 手动端点统一校验:合法 URL + http(s) 协议白名单 + 长度上限。
// 协议白名单是硬要求:authorizeUrl 会被前端直接 window.location.href 跳转
// (auth.tsx:178),不锁协议则 admin 配置面可注入 javascript: URL。
const HttpUrlSchema = z.string().url().max(2048).regex(/^https?:\/\//i)

// D5 用户名字段名:普通键名白名单 + 原型链毒键黑名单(与 RFC-218 端口名的
// dunder/Object.prototype 毒键防御同一思路)。
export const USERNAME_CLAIM_REGEX = /^[A-Za-z0-9_.-]{1,64}$/
const BANNED_CLAIM_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const UsernameClaimSchema = z
  .string()
  .regex(USERNAME_CLAIM_REGEX)
  .refine((v) => !BANNED_CLAIM_KEYS.has(v))

export const OidcProviderSchema = z.object({
  // ……既有字段不动……
  authorizationEndpoint: HttpUrlSchema.nullable(),
  tokenEndpoint: HttpUrlSchema.nullable(),
  userinfoEndpoint: HttpUrlSchema.nullable(),
  jwksUri: HttpUrlSchema.nullable(),
  trustEmailVerified: z.boolean(),
  /** D5:身份响应中承载用户名的字段名;null = 标准 preferred_username。 */
  usernameClaim: UsernameClaimSchema.nullable(),
})
```

- `CreateOidcProviderBodySchema`(omit+extend 派生)中 6 个新字段全部
  `.optional()`(端点四项与 usernameClaim 再 `.nullable()`):**旧客户端不带新字段的
  请求必须继续可用**(AC-1)。service 落库侧 `?? null` / `?? false` 补默认。
- `PatchOidcProviderBodySchema = Create.partial()` 自然获得三态:`undefined`=不动、
  `null`=清空端点、字符串=设置。
- `OidcProviderPublicSchema`(登录页公开投影)**不含**新字段——手动端点与
  trustEmailVerified 均为服务端配置,不下发匿名端。
- 空串不是合法值(`z.string().url()` 拒绝):前端提交层负责 `'' → null` 归一
  (§8.2),API 直调传空串则 400,符合「显式错误优于静默容忍」。

### 2.2 DB(`db/schema.ts` + migration)

```ts
authorizationEndpoint: text('authorization_endpoint'),
tokenEndpoint: text('token_endpoint'),
userinfoEndpoint: text('userinfo_endpoint'),
jwksUri: text('jwks_uri'),
trustEmailVerified: integer('trust_email_verified', { mode: 'boolean' })
  .notNull()
  .default(false),
usernameClaim: text('username_claim'),
```

migration `0108_rfc220_oauth2_manual_endpoints.sql`:6 条 `ALTER TABLE ... ADD COLUMN`,
条间 `--> statement-breakpoint`(缺分隔符只有首条生效——0052/0053 事故)。journal 条目
`when = 1786723200000`(上一条 0107 为 1786636800000,+86400000 合成轴;用真实
Date.now() 会让所有既有安装静默跳过本 migration)。`upgrade-rolling.test.ts` 的
「HEAD journal 有 N 条」锁同步 108 → 109(标题+断言+注释)。

> 编号占用说明:0108 以**实现落地当天**的 journal 尾部为准——并发 RFC 可能先占号,
> 届时顺延取下一空位并同步本文与 plan。

### 2.3 service(`services/oidcProviders.ts`)

- `materialize`:显式透传 6 新列(`row.x ?? null` / `row.trustEmailVerified`)。
- `create`:落库 `body.x ?? null`、`body.trustEmailVerified ?? false`。
- `patch`:6 个 `if (body.x !== undefined)` 分支(nullable 字段 null 直写=清空)。
- `redactedProvider`:spread 自动带出新字段,测试补断言防回归。

## 3. 端点解析器(新文件 `auth/oidc/endpoints.ts`)

核心新抽象,D1 的唯一实现点。**discovery.ts 保持最小改动**(§3.3),合并、负缓存、
JWKS 实例表全部放本文件,既有 discovery 测试锁面不动。

```ts
export type EndpointSource = 'discovery' | 'manual'

export interface EffectiveEndpoints {
  authorizationEndpoint: string | null
  tokenEndpoint: string | null
  userinfoEndpoint: string | null
  jwksUri: string | null
  /** id_token 的 iss 期望:discovery 可用时取文档 issuer,否则 issuerUrl 去尾斜杠。 */
  issuer: string
  sources: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    EndpointSource | 'none'
  >
  discoveryOk: boolean
  discoveryError?: string
}

export async function resolveEndpoints(
  provider: Pick<
    OidcProvider,
    'issuerUrl' | 'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri'
  >,
  opts?: { now?: number; fetcher?: typeof fetch },
): Promise<EffectiveEndpoints>
```

语义(D1):

1. 先尝试 discovery(经 §3.2 缓存)。
2. **成功**(HTTP 2xx + JSON 对象):每字段 `discovery.x ?? manual.x ?? null`;
   `issuer = doc.issuer ?? trimSlash(provider.issuerUrl)`。宽松解析——部分文档也参与
   补位,不再要求 4 字段齐全。
3. **失败**(网络错误 / 超时 / 非 2xx / 非 JSON):每字段 `manual.x ?? null`;
   `issuer = trimSlash(provider.issuerUrl)`;`discoveryOk=false` + error 记录。
4. resolver **不抛「缺端点」错**——完备性由调用点按需检查(start 只需
   authorization_endpoint,callback 需 token_endpoint,claims 阶段见 §5 矩阵),
   错误码因此可以精确到缺什么。

### 3.1 JWKS 实例缓存

```ts
const jwksInstances = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export function getJwksInstance(jwksUri: string): ReturnType<typeof createRemoteJWKSet>
```

按 **resolved jwks_uri** 键缓存(现状按 issuerUrl 随 discovery 条目缓存,manual 模式
无处安放)。jose 的 RemoteJWKSet 实例内部自带 key 缓存与 cooldown,复用实例是它生效
的前提。`clearEndpointCaches()` 供测试清理(与 `clearDiscoveryCache` 并列)。

### 3.2 负缓存

纯 OAuth2 IdP 的 discovery **永远失败**,不加负缓存则每次 login/start 与 callback 都
要空探一次(慢网关下最多 10s,见 §3.3)。在 endpoints.ts 内维护:

- 成功结果:复用 discovery.ts 既有 1h 正缓存(不重复缓存)。
- 失败结果:`Map<issuerUrl, {error, fetchedAt}>`,TTL 5min(`NEG_TTL_MS`),窗口内
  直接走 manual,不再发探测。
- 负缓存**只作用于 resolveEndpoints 路径**;`getProviderMetadata` / `testDiscovery`
  的「失败即重试」既有语义不变(oidc-login-chain 对其有行为锁)。/test 探测走
  `probe`(§7)时显式绕过负缓存(admin 主动诊断要看实时结果)。

### 3.3 discovery.ts 的最小改动

- `fetchDiscovery` 拆出宽松层 `fetchDiscoveryDocument(issuerUrl, fetcher):
  Promise<Partial<OidcMetadata>>`——HTTP 2xx + JSON 对象即成功,字段全可选;
  现有 `fetchDiscovery` 在其上保留 4 字段严格校验(`getProviderMetadata` /
  `testDiscovery` 语义与错误串逐字节不变)。
- 默认 fetcher 加 `AbortSignal.timeout(10_000)`(Bun 支持;注入 fetcher 的测试可
  忽略 signal)。这是行为变化 #5:曾可无限挂起。
- 其余(正缓存结构、TTL、导出面)不动。

## 4. tokens.ts:id_token 可选 + userinfo 取数

### 4.1 exchange 放宽

```ts
export interface TokenResponse {
  access_token: string
  id_token?: string   // ← 可选化
  // ……其余不动
}
```

校验:`access_token` 仍必须为 string(缺失 → `token-exchange-shape-invalid`,回归锁);
`id_token` 存在且为 string 才保留,其它类型按不存在处理(宽容:纯 OAuth2 server 可能
返回 `id_token: null` 之类的脏字段)。

### 4.2 fetchUserinfo(新)

```ts
export async function fetchUserinfo(input: {
  userinfoEndpoint: string
  accessToken: string
  usernameClaim?: string | null   // D5,透传给提取层
  fetcher?: typeof fetch
}): Promise<IdTokenClaims>
```

- `GET userinfoEndpoint`,头:`authorization: Bearer <access_token>`、
  `accept: application/json`。
- 非 2xx → `OidcTokenError('userinfo-fetch-failed status=N', 'userinfo-fetch-failed')`。
- body 非 JSON / 非对象(含 signed userinfo 的 application/jwt 文本)→
  `OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')`。
- claims 提取抽纯函数 `extractUserinfoClaims(json: unknown, opts?: { usernameClaim?:
  string | null }): IdTokenClaims`(D2 + D5):
  - `sub`:`json.sub ?? json.id`;仅接受非空 string 或 number(`String()` 归一);
    两者皆缺/空 → `userinfo-shape-invalid`。**不**对 object 做 `String()`(会得
    `[object Object]` 垃圾主体)。
  - `email` / `name` / `preferred_username`:`typeof === 'string'` 才取,否则 null
    (与 callback 现有 id_token 提取逻辑同构,`routes/oidc-auth.ts:98-105`)。
  - `email_verified`:`=== true` 才 true。
  - 用户名(D5):`preferred_username` 的取值经 §5.2 `readUsernameField` 统一决定
    (配置了 usernameClaim 则优先读该字段)。
- `OidcTokenError.code` 联合类型扩两个成员:`'userinfo-fetch-failed' |
  'userinfo-shape-invalid'`。

## 5. 身份获取分支(新文件 `auth/oidc/identity.ts`)

callback 的 claims 获取从路由体抽成可注入纯函数——这是本 RFC 的**首选可断言面**,
8 格矩阵在单测里全锁,路由只剩薄接线。

```ts
export async function acquireIdentityClaims(input: {
  tokens: TokenResponse
  effective: EffectiveEndpoints
  clientId: string
  nonce: string
  usernameClaim?: string | null   // D5,两条路径共用
  fetcher?: typeof fetch
  /** 测试注入静态 key resolver;生产缺省 = getJwksInstance(effective.jwksUri) */
  jwks?: VerifyIdTokenInput['jwks']
}): Promise<IdTokenClaims>   // 失败抛 OidcTokenError
```

分支矩阵(D4;`jwks 配置可得` = `effective.jwksUri !== null`,**只看配置态**):

| id_token | jwks 配置 | userinfo 端点 | 行为 |
| --- | --- | --- | --- |
| 有 | 可得 | 任意 | `verifyIdToken`(iss=`effective.issuer`, aud=clientId, nonce)。失败**硬 400,不降级**——含 JWKS 运行时拉取失败。 |
| 有 | 不可得 | 有 | 忽略未验签 id_token,走 userinfo。 |
| 有 | 不可得 | 无 | 抛 `jwks-unavailable`。 |
| 无 | 任意 | 有 | 走 userinfo。 |
| 无 | 任意 | 无 | 抛 `userinfo-unavailable`。 |

安全不变量(§9 展开):

- **未验签 id_token 永不采信**——降级分支里 id_token 只被忽略,绝不解析取 claims。
- **降级判定只看配置态**。若按运行态(JWKS fetch 失败)降级,攻击者打挂 JWKS 端点
  即可把强验签流量降级成 userinfo 流量;配置态判定杜绝该向量。
- 统一 sub 非空校验:两条路径产出的 `claims.sub` 为空串即抛(id_token 路径纠偏,
  行为变化 #4)。

### 5.1 trustEmailVerified 归一化(D3)

`services/oidc/provisioning.ts` 增加纯函数:

```ts
export function applyEmailTrust(claims: IdTokenClaims, trustEmailVerified: boolean): IdTokenClaims {
  if (trustEmailVerified && claims.email) return { ...claims, email_verified: true }
  return claims
}
```

callback 在 `acquireIdentityClaims` 返回后统一套用(**两条路径共享**——OIDC IdP 不发
email_verified 的场景同样存在)。下游 `decideProvisioning` / `createIdentity`
(emailVerified 落库)自然吃到归一化结果,**决策树本体零改动**。

### 5.2 用户名字段选择(D5)

`identity.ts` 内共享读取器,id_token payload 与 userinfo JSON 两条路径同用:

```ts
function readUsernameField(source: Record<string, unknown>, usernameClaim: string | null): string | null {
  const key = usernameClaim ?? 'preferred_username'
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null   // own property 才读
  const v = source[key]
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number') return String(v)
  return null
}
```

- 命中值写入 `claims.preferred_username`;未命中(字段缺失/类型不符)→
  `preferred_username = null`,由既有 `pickUniqueUsername` 推导链兜底
  (`preferred_username || email 局部 || oidc-{sub}`,`routes/oidc-auth.ts:237-250`
  **零改动**)。
- **配置了 usernameClaim 时不再回读标准 `preferred_username`**——admin 显式指定即
  权威,静默回读会掩盖配错字段名(fail-quiet);推导链兜底已保证登录不因此失败。
- own-property + schema 层毒键黑名单双防线,杜绝 `__proto__` 之类键名读到原型链
  继承值。
- schema 校验(§2.1)保证字段名合法;显示名 `claims.name` 提取不受影响。

## 6. 路由接线(`routes/oidc-auth.ts`)

### 6.1 login/start

```ts
const eff = await resolveEndpoints(provider)
if (!eff.authorizationEndpoint) {
  return c.json({ ok: false, code: 'oidc-endpoints-unresolved' }, 503)
}
const authorizeUrl = buildAuthorizeUrl(eff.authorizationEndpoint, { ... })
```

行为变化 #1:discovery 失败曾未捕获 → 500;现在结构化 503。前端 `i18n/errors.ts:114`
已有 `oidc-` 前缀域收编,新码自动落 auth 域文案桶,无需前端映射改动。

### 6.2 callback

```ts
const eff = await resolveEndpoints(provider)
if (!eff.tokenEndpoint) return c.html(friendly('endpoints-unresolved'), 503)

let claims: IdTokenClaims
try {
  const tokens = await exchangeCodeForTokens({ tokenEndpoint: eff.tokenEndpoint, ... })
  claims = applyEmailTrust(
    await acquireIdentityClaims({
      tokens,
      effective: eff,
      clientId,
      nonce: flow.nonce,
      usernameClaim: provider.usernameClaim,
    }),
    provider.trustEmailVerified,
  )
} catch (err) {
  const code =
    err instanceof BadRequestErrorOrFriendlyHtml ? err.code
    : err instanceof OidcTokenError ? err.code       // ← 行为变化 #3:塌码纠偏
    : 'verify-failed'
  return c.html(friendly(code), 400)
}
```

后续 link / provisioning / session 段零改动(link 路径因共享 claims 获取而自动获得
纯 OAuth2 支持)。

### 6.3 friendly 文案(`util/oidcResponse.ts`)

新增四条:

| code | 文案(英文,与既有条目同风格) |
| --- | --- |
| `endpoints-unresolved` | The identity provider endpoints could not be resolved. Contact your administrator. |
| `userinfo-unavailable` | The identity provider returned no id_token and no userinfo endpoint is configured. Contact your administrator. |
| `jwks-unavailable` | The id_token cannot be verified (no JWKS available) and no userinfo endpoint is configured. Contact your administrator. |
| `userinfo-fetch-failed` / `userinfo-shape-invalid` | Could not fetch identity information from the provider. / The provider returned an unusable userinfo response. |

## 7. /test 端点(`routes/oidc.ts` + service)

现状 `svc.testDiscovery(issuerUrl)` 只探 discovery+JWKS,对手动端点配置毫无诊断力。
替换为:

```ts
// service 新方法(testDiscovery 移除,唯一调用点就是本路由;既有测试锁迁移见 §12 S2)
probe(provider: OidcProvider, fetcher?: typeof fetch): Promise<ProbeResult>

interface ProbeResult {
  ok: boolean                 // = loginReady:authorization+token 且 (jwks | userinfo)
  discovery: { ok: boolean; error?: string }
  issuer: string
  endpoints: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    { url: string; source: EndpointSource } | null
  >
  /** jwksUri 非空时实拉一次(现状行为保留);失败不翻转 ok,仅供前端警示。 */
  jwksReachable?: boolean
  scopesSupported: string[]   // discovery 可用时透传,否则 []
}
```

- probe 绕过负缓存(admin 主动诊断要实时结果),复用 `resolveEndpoints` 的合并逻辑
  (注入 fetcher)。
- 路由响应:`ok=false` 仍 422(现状),body 换新 shape;该端点为 admin 内部 API,
  前端同 PR 更新(§8.3),无第三方契约。`contracts/registry.ts` 无新路由。

## 8. 前端(`routes/settings.tsx` + i18n)

### 8.1 表单新增

- 新 fieldset「手动端点(可选)」置于 Provider 组之后:4 个 `<Field>+<TextInput
  type="url">`(非必填),组 hint 写明 D1 合并语义:「Discovery 失败或缺字段时逐字段
  启用;纯 OAuth 2.0 IdP 至少需填 authorize + token + userinfo」。
- `trustEmailVerified`:`<Switch>` 放 Behavior 组 provisioning 之后,hint 写明安全
  含义(「信任该 IdP 返回的 email 已验证;IdP 允许用户自改未验证邮箱时勿开」)。
- `usernameClaim`(D5):`<Field>+<TextInput>` 放 Behavior 组,非必填,placeholder
  `preferred_username`,hint:「从 id_token/userinfo 响应读取用户名的字段名,留空用
  标准 preferred_username;纯 OAuth 2.0 IdP 常见值:login / username。用于自动建号
  的用户名推导」。
- 全部复用 `Field/TextInput/Switch` 公共原语与 `oidc-form__group` 既有样式,零新
  chrome(前台一致性强制原则)。
- 提交归一:`'' → null`;`OidcProviderRow` 接口补 5 字段。

### 8.2 Test 结果展示

按 ProbeResult 重写测试结果块:discovery 状态一行(ok / 失败原因)、四端点逐行
`<code>` 展示有效值 + 来源标记(discovery/manual,文字即可,不引入新组件)、
`ok=true` 但 discovery 失败时提示「discovery 不可用,当前依赖手动端点」。
`OidcTestResult` 前端类型同步。

### 8.3 i18n

zh-CN / en-US 补全部新 key(组标题、hint、来源标记、test 展示行、trustEmailVerified
文案)。视觉自查:与 `/settings` 其它 tab side-by-side 比对一次。

## 9. 安全性分析

1. **协议白名单**(§2.1):authorizeUrl 由前端直接 `window.location.href` 跳转,端点
   字段锁 `https?://`,封死 admin 面注入 `javascript:` 的向量。
2. **未验签 id_token 永不采信 + 配置态降级判定**(§5):防「打挂 JWKS 即绕验签」的
   降级攻击;验签失败永远硬失败。
3. **userinfo 路径的信任基础**:access_token 来自 client-authenticated 的 code 交换
   (client_secret + PKCE code_verifier,TLS 传输),code 一次性、state 一次性消费
   (`flow.ts` one-shot)。这正是 GitHub-style OAuth2 登录的行业标准信任模型。
4. **nonce 在 userinfo 路径缺席是安全的**:nonce 防的是 id_token 重放注入;该路径
   不消费 id_token,攻击面不存在。CSRF/授权码注入仍由 state + PKCE 覆盖。
5. **trustEmailVerified 是显式 admin 声明**:默认关;UI hint 载明风险;仅影响
   email_verified 位,不放宽任何其它校验。
6. **SSRF 面不变**:手动端点与 issuerUrl 同为 `oidc:configure` 权限的 admin 配置,
   daemon 本就按 admin 配置发起出站请求,无新增信任级别。
7. **新字段非机密**:端点 URL 明文落库(与 issuerUrl 同级),不进 secretBox。
8. **usernameClaim 键名卫生**(D5):schema 白名单正则 + 毒键黑名单,读取侧再加
   own-property 判定(§5.2),双防线杜绝原型链污染读;取值只接受 string/number,
   不做对象 `String()`。用户名仅进入 `pickUniqueUsername` 的既有清洗管道
   (lowercase + 非法字符替换 + 截断),不改变其安全属性。

## 10. 失败模式表

| 场景 | 结果 |
| --- | --- |
| discovery 失败 + 无手动端点 | start/callback 503 `endpoints-unresolved`(start 从 500 纠偏) |
| discovery 失败 + 手动齐全 | 正常登录(全 manual) |
| discovery 成功但缺 userinfo_endpoint + 无 id_token + 手动配了 userinfo | 正常(逐字段补位) |
| 无 id_token + 无 userinfo 端点 | 400 `userinfo-unavailable` |
| 有 id_token + JWKS 配置可得 + 验签失败(含 JWKS 拉取失败) | 400 硬失败,不降级 |
| 有 id_token + JWKS 配置不可得 + userinfo 可用 | userinfo 路径 |
| 有 id_token + JWKS 配置不可得 + 无 userinfo | 400 `jwks-unavailable` |
| userinfo 非 2xx / 非 JSON / sub 与 id 皆缺 | 400 `userinfo-fetch-failed` / `userinfo-shape-invalid` |
| sub 归一后为空串(任一路径) | 400(行为变化 #4) |
| trustEmailVerified 关 + userinfo 无 email_verified + invite/allowlist | 403 `not-invited` / `email-not-verified`(现状语义) |
| discovery 探测挂起 | 10s 超时 → 按失败降级 |

## 11. 兼容性与迁移

- 存量 Provider:新列全 null / false;discovery 健康路径 `manual.x` 全 null →
  effective ≡ discovery,逐字节等价(AC-4 回归锁)。
- e2e:`visual-regression` / `a11y` / `ux-consistency` 仅 mock providers 列表或打开
  dialog;新字段在 dialog 中 `initial?.x ?? ''` 容忍缺失,mock 不需改。a11y 的
  add-provider dialog axe 扫描覆盖新 Field(复用公共原语,无新 pattern)。
- `contracts/registry.ts`:无新路由,不动。
- 冻结迁移测试:全仓 tests 无对 `oidc_providers` 的裸表名引用(已 grep),drizzle
  全列 INSERT 陷阱不触发。
- 模块图:endpoints.ts / identity.ts 只依赖 discovery/tokens/shared,无环;T5 跑
  `build:binary` 兜底。

## 12. 测试策略(必写 case)

新文件 `packages/backend/tests/rfc220-oauth2-fallback.test.ts`(复用 oidc-login-chain
的 stubFetch + jose 本地签名基建),另扩既有套件。**实施前先全量盘
`grep -rn 'getProviderMetadata|testDiscovery|exchangeCodeForTokens|verifyIdToken'
packages/backend/tests` 锁清单**(feedback_grep_locks_before_push),下述 S2 是已知
迁移项。

- **S1 schema**(shared 或 service 层):端点字段拒 `javascript:`/`ftp:`/空串;null
  与缺省通过;trustEmailVerified 缺省 false;Patch 三态(undefined/null/串)。
- **S2 service**:create/patch/materialize 6 字段 roundtrip;patch null 清空;
  redacted 含新字段;`testDiscovery` → `probe` 的既有测试锁迁移
  (oidc-providers-service.test.ts)。
- **S3 resolveEndpoints**:D1 矩阵(全 discovery / 部分文档补位 / 整体失败全 manual /
  双缺 → null+sources.none);issuer 来源两态;负缓存(失败后窗口内 fetch 计数不增,
  过期后重探);超时路径(fetcher 抛 AbortError 按失败处理)。
- **S4 exchange**:无 id_token 有 access_token → 成功且 `id_token === undefined`;
  无 access_token → `token-exchange-shape-invalid`(回归);`id_token: null` 脏字段
  按不存在处理。
- **S5 fetchUserinfo**:请求头 Bearer + accept 断言;标准 claims 提取;sub 缺失取 id
  (number → string);sub/id 皆缺 → shape-invalid;object sub 拒绝;401 →
  fetch-failed;非 JSON body → shape-invalid。
- **S6 acquireIdentityClaims 矩阵**:§5 五行全锁;重点对抗性 case——id_token 验签
  失败 + userinfo 可用 → **仍硬失败**(不降级);jwks 配置可得但运行时拉取失败 +
  userinfo 可用 → **仍硬失败**;未验签 id_token 的 claims 绝不出现在结果里
  (id_token 与 userinfo 给出不同 sub,断言结果 = userinfo 的 sub)。
- **S7 applyEmailTrust**:开/关 × email 有/无 四格;开启时经 callback 落库
  `user_identities.email_verified = 1`(集成断言);默认关行为与现状一致。
- **S8 路由级**:start 对 discovery 失败 + 无手动端点 → 503 `oidc-endpoints-unresolved`
  (issuerUrl 指向 127.0.0.1 关闭端口,连接即拒,快速且离线;负缓存使同 spec 内重复
  调用不放大);start 对 discovery 失败 + 手动 authorize → 200 且 authorizeUrl 前缀
  为手动端点。
- **S9 migration**:upgrade-rolling 计数 bump;从 HEAD 建库含 5 新列且默认值正确;
  push 前跑全量后端 `bun test`(feedback_full_suite_after_migration)。
- **S10 前端 vitest**:表单渲染 4 端点 + Switch + usernameClaim 输入;编辑回填;
  空串提交归一 null;test 结果按新 shape 展示来源;既有 create/edit 测试不回归。
- **S11 纠偏锁**:OidcTokenError code 透传到 friendly 页(token-exchange-failed 不再
  塌成 verify-failed);sub 空串拒绝(id_token 路径)。
- **S12 usernameClaim(D5)**:schema 拒 `__proto__`/`constructor`/`prototype`/超长/
  含空格键名,合法键通过;`readUsernameField` own-property(原型链键读不到)/
  string|number 归一/其它类型 null;userinfo 路径与 id_token 路径各一条「配置
  usernameClaim 后 preferred_username 取自该字段」;配置了但字段缺失 → null 并回落
  推导链(不回读标准 preferred_username);留空 → 现状逐字节一致(回归)。

## 13. 模块耦合点清单

| 模块 | 影响 |
| --- | --- |
| `services/oidc/provisioning.ts` | 只增 `applyEmailTrust` 纯函数;`decideProvisioning` 零改动 |
| `pickUniqueUsername`(routes/oidc-auth.ts:237-250) | 零改动(D5 只改 `claims.preferred_username` 的来源) |
| `services/userIdentities.ts` | 零改动(emailVerified 由归一化 claims 驱动) |
| `auth/sessionStore` / session 签发 | 零改动 |
| `ws` / scheduler / 引擎 | 无关 |
| `auth/secretBox` | 无关(新字段非机密) |
| `contracts/registry.ts` | 无新路由 |
| e2e 三 spec | mock 兼容,不改 |
