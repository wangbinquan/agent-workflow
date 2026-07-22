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

// D5/D6 字段名选择器共用:普通键名白名单 + 原型链毒键黑名单(与 RFC-218 端口名的
// dunder/Object.prototype 毒键防御同一思路)。
export const CLAIM_NAME_REGEX = /^[A-Za-z0-9_.-]{1,64}$/
const BANNED_CLAIM_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ClaimNameSchema = z
  .string()
  .regex(CLAIM_NAME_REGEX)
  .refine((v) => !BANNED_CLAIM_KEYS.has(v))

// D7:usernameClaim 是**空格分隔的字段名列表**(1-8 个 token;拼接语义见 §5.2)。
// 键名正则不含空格,故空格分隔无歧义;与 scopes 字段同一配置形态(空格分隔串)。
const ClaimNameListSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_.-]{1,64}( [A-Za-z0-9_.-]{1,64}){0,7}$/)
  .refine((v) => v.split(' ').every((t) => !BANNED_CLAIM_KEYS.has(t)))

export const OidcProviderSchema = z.object({
  // ……既有字段不动……
  authorizationEndpoint: HttpUrlSchema.nullable(),
  tokenEndpoint: HttpUrlSchema.nullable(),
  userinfoEndpoint: HttpUrlSchema.nullable(),
  jwksUri: HttpUrlSchema.nullable(),
  trustEmailVerified: z.boolean(),
  /** D5+D7:身份响应中承载呈现名的字段名列表(空格分隔,按序拼接);
   *  null = 标准 preferred_username 单字段。 */
  usernameClaim: ClaimNameListSchema.nullable(),
  /** D6:userinfo 中承载 subject(身份键)的字段名;null = 标准 sub(容错 id)。 */
  subjectClaim: ClaimNameSchema.nullable(),
})
```

- `CreateOidcProviderBodySchema`(omit+extend 派生)中 7 个新字段全部
  `.optional()`(除 trustEmailVerified 外六项再 `.nullable()`):**旧客户端不带
  新字段的请求必须继续可用**(AC-1)。service 落库侧 `?? null` / `?? false` 补默认。
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
usernameClaim: text('username_claim'),   // 空格分隔字段名列表原样落库
subjectClaim: text('subject_claim'),
```

另 `user_identities` 表加 1 列(D7 呈现名刷新的三方比对基准,§5.3):

```ts
/** IdP 侧呈现值(usernameClaim 拼接结果)最近一次所见快照;null=尚未记录。 */
preferredSnapshot: text('preferred_snapshot'),
```

migration `0108_rfc220_oauth2_manual_endpoints.sql`:共 8 条
`ALTER TABLE ... ADD COLUMN`(oidc_providers 7 + user_identities 1),
条间 `--> statement-breakpoint`(缺分隔符只有首条生效——0052/0053 事故)。journal 条目
`when = 1786723200000`(上一条 0107 为 1786636800000,+86400000 合成轴;用真实
Date.now() 会让所有既有安装静默跳过本 migration)。`upgrade-rolling.test.ts` 的
「HEAD journal 有 N 条」锁同步 **107 → 108**(现 journal 共 107 条 entries,
idx 0-106 / 尾条 tag 0107;加 0108 后 108 条。标题+断言+注释三处一起改;初稿误写
108→109,设计门 P1 勘正)。

> 编号占用说明:0108 以**实现落地当天**的 journal 尾部为准——并发 RFC 可能先占号,
> 届时顺延取下一空位并同步本文与 plan。

### 2.3 service(`services/oidcProviders.ts`)

- `materialize`:显式透传 7 新列(`row.x ?? null` / `row.trustEmailVerified`)。
- `create`:落库 `body.x ?? null`、`body.trustEmailVerified ?? false`。
- `patch`:7 个 `if (body.x !== undefined)` 分支(nullable 字段 null 直写=清空)。
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
  /**
   * id_token 的 iss 期望:discovery 文档给出 issuer 时用文档值,否则用
   * provider.issuerUrl **原样**(不做任何裁剪——OIDC iss 是精确串比较,
   * 裁尾斜杠会让配置为 `https://x/` 的 IdP 全量拒签;设计门 P1 勘正。
   * 尾斜杠裁剪只发生在 discovery 请求 URL 的构造里)。
   */
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
2. **成功**(HTTP 2xx + JSON 普通对象):每字段
   `sanitize(discovery.x) ?? manual.x ?? null`。`sanitize` 是**运行时字段校验**
   (设计门 P1):仅当值为非空 string 且能被 `new URL` 解析为 http(s) URL 才算
   「discovery 提供了该字段」,空串/非串/畸形 URL/非 http(s) 协议一律视为缺失、
   落到手动补位——否则坏文档字段会压掉有效手动配置并在下游 `new URL` 炸 500。
   `issuer = (typeof doc.issuer === 'string' && doc.issuer) || provider.issuerUrl`
   (issuerUrl 原样,见类型注释)。宽松解析——部分文档也参与补位,不再要求 4 字段
   齐全。
3. **失败**(网络错误 / 超时 / 非 2xx / 非 JSON / 非对象):每字段 `manual.x ?? null`;
   `issuer = provider.issuerUrl`(原样);`discoveryOk=false` + error 记录。
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

- 成功结果:复用 discovery.ts 的文档正缓存(1h,§3.3)。**partial 文档也是成功、
  同样落正缓存**(设计门 P2:缓存值类型改为 `Partial<OidcMetadata>`,否则纯
  partial-文档 IdP 每次 start/callback 都重拉,同一登录 flow 内端点集甚至可能漂移)。
- 失败结果:`Map<issuerUrl, {error, fetchedAt}>`,TTL 5min(`NEG_TTL_MS`),窗口内
  直接走 manual,不再发探测。**失败永远以失败身份缓存**,绝不落进正缓存
  (承接 login-chain「失败不得缓存为成功」锁,§3.3)。
- /test 探测走 `probe`(§7)时显式绕过负缓存(admin 主动诊断要看实时结果)。

### 3.3 discovery.ts 改造(删除优于 deprecate)

本 RFC 落地后,严格 4 字段入口(`getProviderMetadata` / `testDiscovery` /
`oidc-discovery-incomplete`)**失去全部生产调用方**(路由改走 resolveEndpoints,
/test 改走 probe)——按仓规「删除优于 deprecate」直接删除,不留只喂测试的死导出。
discovery.ts 终态:

- `fetchDiscoveryDocument(issuerUrl, fetcher): Promise<Partial<OidcMetadata>>`
  ——宽松:HTTP 2xx + JSON 普通对象即成功,字段全可选;请求 URL 构造保留尾斜杠
  裁剪(仅此一处裁剪,issuer 期望值不裁,§3)。
- 文档正缓存:`Map<issuerUrl, { doc: Partial<OidcMetadata>; fetchedAt }>`(1h TTL,
  partial 即成功)+ `clearDiscoveryCache`。JWKS 实例移出缓存条目(→ §3.1
  per-uri map)。
- 默认 fetcher 加 `AbortSignal.timeout(10_000)`(Bun 支持;注入 fetcher 的测试可
  忽略 signal)。这是行为变化 #5:曾可无限挂起。

**既有测试锁迁移**(oidc-login-chain.test.ts:321-373 discovery describe,4 条):
尾斜杠裁剪、1h TTL 单次 fetch、「失败不得缓存为成功」三条迁移到
fetchDiscoveryDocument / resolveEndpoints 上语义保留;「incomplete 文档拒绝缓存」
一条被 D1 有意取代(partial 文档现在是受支持输入,其保护意图由 S3 合并矩阵 +
「失败不缓存为成功」承接),测试文件顶部注释写明取代理由与本 RFC 链接。

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
/** HTTP 层:只负责取回 raw JSON,不做 claims 提取(提取在 identity.ts,见下)。 */
export async function fetchUserinfo(input: {
  userinfoEndpoint: string
  accessToken: string
  fetcher?: typeof fetch
}): Promise<unknown>
```

- `GET userinfoEndpoint`,头:`authorization: Bearer <access_token>`、
  `accept: application/json`。默认 fetcher 同样加 `AbortSignal.timeout(10_000)`
  (设计门 P2:callback 的 one-shot state 此刻已被消费,userinfo 挂起会把公开回调
  吊死;超时归入 `userinfo-fetch-failed`)。
- 非 2xx → `OidcTokenError('userinfo-fetch-failed status=N', 'userinfo-fetch-failed')`。
- body 非 JSON / 非普通对象(含 signed userinfo 的 application/jwt 文本)→
  `OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')`。
- **claims 提取不在本模块**(设计门 P1 模块环勘正:提取要用 D5 的
  `readUsernameField`,若放 tokens.ts 则 tokens ⇄ identity 互引成环,踩
  no-circular 仓规)。`extractUserinfoClaims` 定义在 `identity.ts`(§5.2),
  tokens.ts 保持叶子:只被 identity.ts 单向引用。
- `OidcTokenError.code` 联合类型扩**四**个成员(设计门 P1:acquire 抛的兜底码也要
  进联合,否则 typecheck 不过):`'userinfo-fetch-failed' | 'userinfo-shape-invalid'
  | 'userinfo-unavailable' | 'jwks-unavailable'`。

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
  subjectClaim?: string | null    // D6,仅 userinfo 路径消费
  fetcher?: typeof fetch
  /** 测试注入静态 key resolver;生产缺省 = getJwksInstance(effective.jwksUri) */
  jwks?: VerifyIdTokenInput['jwks']
}): Promise<IdTokenClaims>   // 失败抛 OidcTokenError
```

模块依赖方向(设计门 P1 勘正):`identity.ts → tokens.ts / endpoints.ts` 单向;
`extractUserinfoClaims`(D2)与 `readUsernameField`(D5)都定义在 identity.ts,
tokens.ts 只回 raw JSON,不回引 identity——无环,过 no-circular 仓规与
`build:binary` 模块环兜底。

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

### 5.2 身份字段选择器(D5 usernameClaim + D6 subjectClaim)

`identity.ts` 内一个共享读取器,是两个选择器与 D2 容错的唯一取值原语:

```ts
/** own-property + 类型收窄的单字段读取。number 仅接受安全整数(设计门 P1:
 *  超过 Number.MAX_SAFE_INTEGER 的数值 id 会被 JSON.parse 舍入,相邻 IdP 用户
 *  可能折叠成同一本地 subject——身份键绝不允许有损归一)。 */
function readClaimField(source: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null
  const v = source[key]
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v)
  return null
}
```

**usernameClaim(D5+D7 拼接,两路径生效)**:

```ts
/** D7:按配置序读取各字段,非空值以单空格拼接;全缺 → null。截断 256 字符
 *  (个性签名类字段可能超长,displayName 不应无界)。 */
function composePreferred(source: Record<string, unknown>, claimList: string[]): string | null {
  const parts = claimList.map((k) => readClaimField(source, k)).filter((v): v is string => v !== null)
  return parts.length > 0 ? parts.join(' ').slice(0, 256) : null
}
```

- `usernameClaim` 配置(空格分隔列表,§2.1)→
  `composePreferred(source, list)`;留空 → `readClaimField(source, 'preferred_username')`
  单字段现状。结果写入 `claims.preferred_username`;null 时由既有
  `pickUniqueUsername` 推导链兜底(`preferred_username || email 局部 || oidc-{sub}`,
  `routes/oidc-auth.ts:237-250` **零改动**)。
- **部分字段缺失只跳过、不整体作废**(个性签名类字段本就时有时无);全部缺失才回落
  推导链。
- **配置后不再回读标准 `preferred_username`**——admin 显式指定即权威,静默回读会
  掩盖配错字段名;推导链兜底已保证登录不因此失败(呈现值是展示性字段,允许兜底)。

**subjectClaim(D6,仅 userinfo 路径,用户 2026-07-22 二次追加)**:

- 动机:userinfo 的格式由 IdP 平台自定,标准 `sub`(乃至 D2 的 `id` 容错)不一定
  存在;subject 必须能显式指定来源。
- `extractUserinfoClaims` 的 sub 取值:
  - `subjectClaim` 配置 → `readClaimField(json, subjectClaim)`,未命中/类型不符
    **直接抛 `userinfo-shape-invalid`,绝不回落**任何其它字段——subject 是
    `findByProviderSubject` 的登录身份键,静默换源会造成同一用户身份键漂移
    (账号分裂)甚至串号;与 usernameClaim 的「可兜底」是有意不对称。
  - 留空 → D2 默认:`readClaimField(json,'sub') ?? readClaimField(json,'id')`,
    皆缺 → `userinfo-shape-invalid`。
- **id_token 路径永远用标准 `payload.sub`**,subjectClaim 不作用于它:id_token 的
  sub 语义由 OIDC 规范锚定(稳定+唯一),给它开配置洞只会引入身份键被重定向到
  可变字段(如 email)的接管风险;而需要 subjectClaim 的平台本就不发 id_token。
- 混用告警(文档级):OIDC IdP 因 discovery 抖动落入 userinfo 降级路径时,若误配
  subjectClaim,userinfo 路径的身份键将与 id_token 路径不一致。表单 hint 写明
  「仅纯 OAuth 2.0 IdP 需要配置;IdP 会签发 id_token 时请留空」。

两个选择器共享 §2.1 的键名 schema(白名单正则 + 毒键黑名单);own-property 判定
在读取侧兜第二层。显示名 `claims.name` 提取不受影响。

### 5.3 呈现名跟随 IdP 刷新(D7,用户 2026-07-22 三次追加)

动机:用户会在 IdP 侧改名字/呈现信息(如个性签名),平台的呈现名(
`users.displayName`)应跟随刷新;subject(D6)是定位身份的唯一标识。

- **仅 `usernameClaim` 配置时启用**(opt-in):未配置的 Provider 行为与现状逐字节
  一致(displayName 建号后永不自动变)。想对标准 OIDC IdP 启用「跟随 name 刷新」,
  把 usernameClaim 配成 `name` 即可——机制可表达,不必另开开关。
- **三方比对,不与 displayName 直比**:`user_identities.preferred_snapshot` 记录
  该身份最近一次所见的拼接值。登录时(`decideProvisioning → 'login'` 分支,身份已由
  (providerId, subject) 定位):
  - `composed !== null && snapshot !== null && composed !== snapshot` →
    `users.displayName = composed` 且快照更新;
  - `composed === snapshot` → 全不动(**站内改名在 IdP 未变时永不被覆盖**——这是
    与「displayName 直比」方案的本质区别,后者会把站内编辑一律冲掉);
  - `snapshot === null`(存量身份首次经过新逻辑)→ 只落快照、**不刷新** displayName
    (存量用户可能已站内改名,首见即覆盖是数据破坏)。
- **create 路径**:新用户 `displayName = composed ?? claims.name ?? claims.email ??
  'OIDC User'`(composed 优先,新用户无可保护的站内值);快照随 identity 创建落库。
- **bindInvited / link 路径**:只落快照、不动 displayName(邀请时 admin 起的名 /
  被关联账号的既有名受保护,后续 IdP 侧变更才开始跟随)。
- 多身份用户(多 Provider 关联):谁登录谁刷新,最后登录的身份胜出——与「呈现名
  跟随最近使用的 IdP」直觉一致,文档明示。
- 落点:`services/userIdentities.ts` 增
  `syncPreferredSnapshot(db, { providerId, subject, composed, userId })`(内部按上表
  三态处理,返回是否刷新了 displayName 供测试断言);callback 在 login 分支调用。

## 6. 路由接线(`routes/oidc-auth.ts`)

### 6.1 login/start

```ts
const eff = await resolveEndpoints(provider)
if (!eff.authorizationEndpoint) {
  return c.json(
    {
      ok: false,
      code: 'oidc-endpoints-unresolved',
      // message 必须在场:前端 extractErrorBody(api/client.ts:259-267)要求
      // code 与 message 同为 string 才保留结构化 code,缺 message 会塌成
      // 泛化 http-503(设计门 P2 勘正)。
      message: 'identity provider endpoints could not be resolved',
    },
    503,
  )
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
      subjectClaim: provider.subjectClaim,
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

provisioning 决策与 session 签发段零改动;link 路径因共享 claims 获取而自动获得
纯 OAuth2 支持。D7 的增量接线(§5.3):`'login'` 分支在签发 session 前调
`syncPreferredSnapshot`;`'create'` 分支 displayName 取 `composed ?? name ?? email
?? 'OIDC User'`;identity 创建点(create / bindInvited / link)随行落快照初值。

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
  /**
   * loginReady:authorization + token 且至少一条身份通道**真正可走**:
   * userinfo 已配,或(jwksUri 已配且本次探测可达)。jwks 是唯一身份通道而
   * 探测不可达时必须 ok=false——该配置下 id_token 硬失败、无 id_token 又无
   * userinfo,任何回调都不可能成功(设计门 P2 勘正;也与现状 /test 的
   * 「jwks 拉不到 → ok:false」行为对齐)。
   */
  ok: boolean
  discovery: { ok: boolean; error?: string }
  issuer: string
  endpoints: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    { url: string; source: EndpointSource } | null
  >
  /** jwksUri 非空时实拉一次;userinfo 同时在场时失败仅降级为前端警示。 */
  jwksReachable?: boolean
  scopesSupported: string[]   // discovery 可用时透传,否则 []
}
```

- probe 绕过负缓存(admin 主动诊断要实时结果),复用 `resolveEndpoints` 的合并逻辑
  (注入 fetcher)。
- 路由响应:**恒 200 + ProbeResult**(probe 成功执行=200,`ok` 表达结论;4xx 只留给
  provider-not-found)。现状 `ok=false → 422` 会让前端 onError 丢掉结构化 body、只剩
  笼统 message,新 shape 的逐字段诊断在失败场景才最有价值,故改恒 200,前端单一
  onSuccess 路径按 `r.ok` 分支。该端点为 admin 内部 API,前端同 PR 更新(§8.2),
  无第三方契约;`contracts/registry.ts` 无新路由。

## 8. 前端(`routes/settings.tsx` + i18n)

### 8.1 表单新增

- 新 fieldset「手动端点(可选)」置于 Provider 组之后:4 个 `<Field>+<TextInput
  type="url">`(非必填),组 hint 写明 D1 合并语义:「Discovery 失败或缺字段时逐字段
  启用;纯 OAuth 2.0 IdP 至少需填 authorize + token + userinfo」。
- `trustEmailVerified`:`<Switch>` 放 Behavior 组 provisioning 之后,hint 写明安全
  含义(「信任该 IdP 返回的 email 已验证;IdP 允许用户自改未验证邮箱时勿开」)。
- `usernameClaim`(D5)与 `subjectClaim`(D6):两个 `<Field>+<TextInput>` 以
  `oidc-form__row--cols-2` 并排放 Behavior 组,均非必填。
  - usernameClaim placeholder `preferred_username`,hint:「从 id_token/userinfo
    响应读取呈现名的字段名,可空格分隔多个、按序拼接(如 name signature);留空用
    标准 preferred_username。用于自动建号的用户名推导;配置后每次登录跟随 IdP 刷新
    呈现名」。
  - subjectClaim placeholder `sub`,hint:「userinfo 中承载用户唯一 ID 的字段名,
    留空用标准 sub(容错 id)。必须选平台保证**稳定且唯一**的 ID 字段,勿用 email
    等可变字段;仅纯 OAuth 2.0 IdP 需要配置,IdP 会签发 id_token 时请留空」。
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
8. **字段名选择器键名卫生**(D5/D6):schema 白名单正则 + 毒键黑名单,读取侧再加
   own-property 判定(§5.2 `readClaimField`),双防线杜绝原型链污染读;取值只接受
   非空 string 与**安全整数** number(设计门 P1:大数 id 经 JSON.parse 舍入会把
   相邻 IdP 用户折叠成同一 subject——身份键禁止有损归一),不做对象 `String()`。
   用户名仅进入 `pickUniqueUsername` 的既有清洗管道(lowercase + 非法字符替换 +
   截断),不改变其安全属性。
9. **subjectClaim 的身份键纪律**(D6):配置后缺失即硬失败、绝不回落(§5.2);
   不作用于 id_token 路径(OIDC sub 规范锚定,防止身份键被重定向到 email 等可
   重新分配字段造成账号接管);UI hint 要求选稳定唯一 ID 字段。
10. **D7 刷新的写入纪律**:只写 `users.displayName` 与身份快照,不触碰
    username/role/status 等任何权限相关字段;拼接值截断 256;快照初见不覆盖、三方
    比对保护站内编辑(§5.3)。displayName 的 XSS 面由前端渲染层(React 转义)兜,
    与现状一致。

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
- 冻结迁移测试:全仓 tests 无对 `oidc_providers` 的裸表名引用;`userIdentities`
  仅三个测试文件触及(rfc212-revalidation-behavior / oidc-providers-service /
  auth-self-service-idor)且均无直接 drizzle `insert(userIdentities)` / raw INSERT
  (均已 grep)——drizzle 全列 INSERT × 冻结旧库的陷阱两张表都不触发;T1 落地时
  仍以当日 grep 复核为准。
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
  redacted 含新字段;`probe` 的 loginReady 判定与 sources 组装(全 tests 已盘:
  service 层无既有 testDiscovery 锁,迁移面仅 login-chain discovery describe)。
- **S3 resolveEndpoints**:D1 矩阵(全 discovery / 部分文档补位 / 整体失败全 manual /
  双缺 → null+sources.none);**畸形 discovery 字段视为缺失**(空串/数值/非 http(s)
  URL → 落 manual 补位,设计门 P1 锁);issuer 来源两态且**尾斜杠原样保留**;partial
  文档落正缓存(第二次 resolve 不再 fetch);负缓存(失败后窗口内 fetch 计数不增,
  过期后重探);超时路径(fetcher 抛 AbortError 按失败处理)。
- **S4 exchange**:无 id_token 有 access_token → 成功且 `id_token === undefined`;
  无 access_token → `token-exchange-shape-invalid`(回归);`id_token: null` 脏字段
  按不存在处理。
- **S5 fetchUserinfo + extractUserinfoClaims**:请求头 Bearer + accept 断言;标准
  claims 提取;sub 缺失取 id(安全整数 number → string);sub/id 皆缺 →
  shape-invalid;object sub 拒绝;**大数 id 拒绝**;401 → fetch-failed;非 JSON
  body → shape-invalid;fetcher 超时(AbortError)→ fetch-failed。
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
  含空格键名,合法键通过;`readClaimField` own-property(原型链键读不到)/
  string|安全整数 number 归一/大数与其它类型 null;userinfo 路径与 id_token 路径各
  一条「配置 usernameClaim 后 preferred_username 取自该字段」;配置了但字段缺失 →
  null 并回落推导链(不回读标准 preferred_username);留空 → 现状逐字节一致(回归)。
- **S13 subjectClaim(D6)**:配置后 sub 取自该字段(string 与安全整数 number 两
  形);配置了但字段缺失/类型不符 → `userinfo-shape-invalid`(**不回落** sub/id,
  对抗性锁);留空 → D2 默认链(sub→id)回归;**大数 id 拒绝**(`9007199254740993`
  之类 → shape-invalid,锁 P1 折叠向量);id_token 路径忽略 subjectClaim
  (payload.sub 仍是身份键,断言两者不同时结果取 payload.sub)。
- **S14 拼接与呈现名刷新(D7)**:`ClaimNameListSchema` 拒双空格/首尾空格/毒键
  token/超 8 token,单字段串向后兼容;`composePreferred` 顺序保持、缺字段跳过、
  全缺 null、256 截断;刷新三态各一条——快照相同不动、快照不同刷 displayName+快照、
  **快照 null 只落快照不刷**(存量保护锁);**站内改名 + IdP 未变 → 不覆盖**
  (三方比对对抗锁);create 路径 displayName=composed 优先;bindInvited/link 只落
  快照;未配置 usernameClaim → 永不刷新(回归);多身份最后登录胜出。

## 13. 模块耦合点清单

| 模块 | 影响 |
| --- | --- |
| `services/oidc/provisioning.ts` | 只增 `applyEmailTrust` 纯函数;`decideProvisioning` 零改动 |
| `pickUniqueUsername`(routes/oidc-auth.ts:237-250) | 零改动(D5 只改 `claims.preferred_username` 的来源) |
| `services/userIdentities.ts` | 新增 `preferred_snapshot` 列的读写 + `syncPreferredSnapshot`(D7,§5.3);createIdentity 增快照初值参数;emailVerified 仍由归一化 claims 驱动 |
| `auth/sessionStore` / session 签发 | 零改动 |
| `ws` / scheduler / 引擎 | 无关 |
| `auth/secretBox` | 无关(新字段非机密) |
| `contracts/registry.ts` | 无新路由 |
| e2e 三 spec | mock 兼容,不改 |

## 14. 设计门修订账(Codex review @ 2ae698be,6 P1 + 5 P2,全采纳)

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | 数值 id 超过 `MAX_SAFE_INTEGER` 被 JSON.parse 舍入,相邻 IdP 用户可折叠成同一 subject(身份串号) | `readClaimField` number 分支限 `Number.isSafeInteger`,大数拒绝(§5.2/§9.8;S5/S12/S13 锁) |
| 2 | P1 | extractUserinfoClaims 放 tokens.ts 但依赖 identity.ts 的字段读取器 → tokens ⇄ identity 运行时环 | 提取层整体移入 identity.ts,tokens.ts 只回 raw JSON,依赖单向(§4.2/§5) |
| 3 | P1 | acquire 要抛 `userinfo-unavailable`/`jwks-unavailable` 但 OidcTokenError 联合只扩了 fetch/shape 两码,typecheck 不过 | code 联合扩四员(§4.2) |
| 4 | P1 | manual 模式 issuer 裁尾斜杠改变精确 iss 比较,配置 `https://x/` 的 IdP 全量拒签 | issuer 用 issuerUrl **原样**;尾斜杠裁剪只用于 discovery 请求 URL 构造(§3) |
| 5 | P1 | discovery 2xx 对象里空串/非串/畸形端点被 `??` 视为「已提供」,压掉有效手动补位并在 `new URL` 炸 500 | 合并前逐字段 `sanitize` 运行时校验,不合格视为缺失(§3;S3 锁) |
| 6 | P1 | migration 计数锁写成 108→109,实际 journal 现 107 条,加 0108 后 108 条 | 勘正为 107→108(§2.2) |
| 7 | P2 | ProbeResult 走 422 会被前端 ApiError 路径丢弃结构化 body(评审期已自查发现) | /test 恒 200 + ProbeResult(§7;与自查修订相同结论,双源印证) |
| 8 | P2 | fetchUserinfo 无超时,userinfo 挂起吊死已消费 one-shot state 的公开回调 | 默认 fetcher 加 `AbortSignal.timeout(10_000)`,超时归 fetch-failed(§4.2;S5 锁) |
| 9 | P2 | partial 文档不落正缓存 → 每次 start/callback 重拉,同一 flow 内端点集可漂移 | 正缓存值改 `Partial<OidcMetadata>`,partial 即成功即缓存(§3.2/§3.3;S3 锁) |
| 10 | P2 | start 503 体缺 `message`,前端 extractErrorBody 要求 code+message 同为 string,塌成泛化 http-503 | 响应体补 message(§6.1,已核对 api/client.ts:259-267) |
| 11 | P2 | jwks 是唯一身份通道且探测不可达时仍报 ok:true,实际任何回调都不可能成功 | ok 判定纳入「jwks 唯一通道时的可达性」(§7),并对齐现状 /test 行为 |

另:评审窗口内自查折入(不在 Codex findings 内):严格 discovery 入口按「删除优于
deprecate」删除并迁移 login-chain 锁(§3.3)、`client_secret_post` 与「手动不覆盖
discovery」两条非目标明示(proposal §3)。D6 subjectClaim 与 D7 拼接+呈现名刷新为
用户评审窗口内二、三次追加,未经本轮 Codex 覆盖——设计门第二轮需重点看:§5.2 的
subject 不回落语义与 id_token 路径隔离、§5.3 三态快照(尤其存量身份 null 快照不覆盖
与站内编辑保护)、`user_identities` 新列对冻结迁移类测试的 drizzle 全列 INSERT 影响。
