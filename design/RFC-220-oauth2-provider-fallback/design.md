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
  .max(519) // = 8×64 + 7 个分隔空格(六轮设计门:512 会拒掉自身宣称的合法上界)
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
  /** D6:userinfo 中承载 subject(身份键)的字段名;null = 标准 sub
   *  (string-only,无隐式回退——D2 修订,§5.2)。 */
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
  **subjectClaim 变更锁**(设计门三轮 P1):`body.subjectClaim !== undefined 且
  与现值不同`(含 null↔值、值↔值)时,若该 provider 存在任何 `user_identities`
  行 → `ConflictError('subject-claim-locked-by-identities')` 拒绝——存量身份键在旧
  命名空间,换源后新值可能 miss(重复建号)或撞他人旧 sub(**以他人身份登录**);
  「强制走 userinfo」只管未来回调,管不了已落库的行。**确需换源 = 删除并重建
  Provider**(五轮 P2 勘正:初稿写的「force 清身份后 PATCH」是不存在的路径——
  `remove(force)` 连 provider 行一起删;删除重建的数据后果明示:该 Provider 全部
  关联身份消失,无密码用户需重新邀请/绑定)。不提供 force 旁路(身份键完整性不
  给洞)。
  **写入时重验**(四轮 P1 + 五轮 P1 收紧,补 PATCH 锁的 TOCTOU 双向缺口):
  - 正向交错:在途 callback 以旧 subjectClaim 取得 claims、PATCH 在其 identity
    落库前通过(表内尚无行、锁放行),callback 随后按旧命名空间写入;
  - 反向交错(五轮):PATCH 先读到「无身份」、callback 事务先提交旧命名空间
    identity、PATCH 再提交新 claim——检查与更新不同一事务时同样漏。
  因此**两侧都必须是 dbTxSync 同步事务**:PATCH 侧「零身份谓词 + provider 更新」
  一个同步事务;identity 写入侧「重读 provider.subjectClaim 比对 callback 快照 +
  写入」另一个同步事务。bun:sqlite 单写锁使两个同步事务全序化,任一交错次序都有
  一侧观察到另一侧的提交结果:要么 PATCH 撞见已存在的身份而 409,要么 callback
  撞见新 claim 而 `friendly('provider-config-changed')` 400(用户重登即走新配置)。
  S2 以反向次序显式测试。
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
  /** discovery 文档 scopes_supported 透传(运行时校验为 string[],否则 [])——
   *  probe 的 ProbeResult.scopesSupported 唯一来源(六轮设计门:probe 只复用
   *  resolver,契约里没有它就填不出来)。 */
  scopesSupported: string[]
  discoveryOk: boolean
  discoveryError?: string
}

export async function resolveEndpoints(
  provider: Pick<
    OidcProvider,
    // subjectClaim 是缓存门槛 loginViable 的输入(§3.2,D6 模式恒需 userinfo)——
    // 设计门四轮 P1:初稿 Pick 漏了它,照契约实现 loginViable 无从判模式。
    | 'issuerUrl' | 'authorizationEndpoint' | 'tokenEndpoint'
    | 'userinfoEndpoint' | 'jwksUri' | 'subjectClaim'
  >,
  opts?: { now?: number; fetcher?: typeof fetch; forceFresh?: boolean },
): Promise<EffectiveEndpoints>
// forceFresh:绕过正/负两级缓存强制实拉(probe 专用,§7;设计门三轮 P2——
// §7 要求 fresh 而初稿契约没有该入口,实现将无从满足)。
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

两级缓存共用一个**登录可行性谓词**(三轮设计门把二轮的「authz+token 齐」升级为
「完整登录通道」——start 能跳走但 callback 必败的配置不配吃缓存):

```ts
/** effective 已完成 discovery/manual 合并;身份通道按 §5 规则计。 */
function loginViable(effective, provider): boolean {
  if (!effective.authorizationEndpoint || !effective.tokenEndpoint) return false
  if (provider.subjectClaim) return effective.userinfoEndpoint !== null   // D6 模式恒需 userinfo
  return effective.userinfoEndpoint !== null || effective.jwksUri !== null
}
```

- **两级缓存的所有权都在 endpoints.ts**(五轮 P2 勘正:条件命中 / 单键覆盖 /
  forceFresh 都是 resolver 语义,discovery.ts 若持有缓存则只能暴露「raw 文档 +
  全局 clear」,resolver 无法区分命中与新鲜、也无法只刷新单个 issuer;故
  discovery.ts 退化为纯 fetch,缓存结构
  `Map<issuerUrl, {doc: Partial<OidcMetadata>, fetchedAt}>` 由 resolver 维护)。
- 成功结果:1h TTL,**partial 文档也落缓存**(纯 partial IdP 每次 start/callback
  重拉会让同一登录 flow 内端点集漂移)。**命中的采纳有条件**(三轮 P1 勘正):
  命中后先合并 manual,`loginViable` 才采纳;不可行(如标准 OIDC IdP 瞬时回 200
  `{}` 且无手动兜底)→ 视为 miss 重探一次并以 fresh 结果**覆盖该键**——保持现状
  「incomplete 文档每请求重试、IdP 恢复即恢复」的语义,partial 缓存收益只留给
  「合并后可登录」的配置,不成为宕机固化器。
- 失败结果:`Map<issuerUrl, {error, fetchedAt}>`,TTL 5min(`NEG_TTL_MS`)。
  **命中同样以 `loginViable`(manual-only 合并)为门**(二轮 P1 + 三轮 P2:仅
  authz+token 手动齐、身份通道缺失的配置,负缓存窗口内 start 会成功跳转而 callback
  必然无身份源——这种「半可行」不配吃缓存,照常重探)。判定放读取侧:provider
  手动字段可能在窗口内被 PATCH,以当下配置为准。
  **失败永远以失败身份缓存**,绝不落进正缓存(承接 login-chain「失败不得缓存为
  成功」锁,§3.3)。
- /test 探测走 `probe`(§7)时显式绕过负缓存(admin 主动诊断要看实时结果)。

### 3.3 discovery.ts 改造(删除优于 deprecate)

本 RFC 落地后,严格 4 字段入口(`getProviderMetadata` / `testDiscovery` /
`oidc-discovery-incomplete`)**失去全部生产调用方**(路由改走 resolveEndpoints,
/test 改走 probe)——按仓规「删除优于 deprecate」直接删除,不留只喂测试的死导出。
discovery.ts 终态:

- `fetchDiscoveryDocument(issuerUrl, fetcher): Promise<Partial<OidcMetadata>>`
  ——宽松:HTTP 2xx + JSON 普通对象即成功,字段全可选;请求 URL 构造保留尾斜杠
  裁剪(仅此一处裁剪,issuer 期望值不裁,§3)。**无缓存,纯 fetch**(五轮 P2:
  两级缓存及其条件命中/单键覆盖/forceFresh 语义全部归 endpoints.ts,§3.2;
  `clearEndpointCaches` 一处清空,测试用)。
- 默认 fetcher 加 `AbortSignal.timeout(10_000)`(Bun 支持;注入 fetcher 的测试可
  忽略 signal)。这是行为变化 #5:曾可无限挂起。JWKS 实例缓存见 §3.1
  (per-uri map,同在 endpoints.ts)。

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
**传输/解析异常包裹**(设计门三轮 P2):fetch 网络异常与 200+非法 JSON 目前抛裸
异常,callback 会把它们塌成 `verify-failed`,行为变化 #3 的「精确码」承诺落空——
exchange 内 try/catch 统一包成 `OidcTokenError('token-exchange-failed', ...)`
(非 OidcTokenError 的一切异常),两形态各一条测试。

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
- **响应体上限 256 KiB**(设计门二轮 P2:`res.json()` 无字节界,公开回调可被恶意/
  误配 IdP 流式灌爆内存):逐块读流累计,超限中止 →
  `OidcTokenError('userinfo-fetch-failed body-too-large', 'userinfo-fetch-failed')`。
- 非 2xx → `OidcTokenError('userinfo-fetch-failed status=N', 'userinfo-fetch-failed')`。
- body 非 JSON / 非普通对象(含 signed userinfo 的 application/jwt 文本)→
  `OidcTokenError('userinfo-shape-invalid', 'userinfo-shape-invalid')`。
- **请求方式(D8,交付后追加)**:input 增 `requestStyle`(`get_bearer` 默认 /
  `post_json`)与 `clientId`/`scope`。`post_json` = POST + `content-type:
  application/json` + body 恰好三成员 `{ client_id, access_token, scope }`,
  **不带** Authorization 头;`scope` 取 provider.scopes 原样(用户两拍板,
  2026-07-22)。对应 Provider 新列 `userinfo_request_style`(migration 0109,
  NOT NULL DEFAULT 'get_bearer')、shared 枚举 `UserinfoRequestStyleSchema`、
  前端手动端点组 `<Segmented>`;acquire 经 `userinfoRequestStyle`/`scopes` 透传。
- **200 错误对象识别(D9,交付后追加)**:body 为合法 JSON 对象但携带非空
  `error` / 非零 `errorCode` → 直接抛 `userinfo-fetch-failed idp-error …`
  (附 description 类字段),不进提取层;零值/空串/null 是平台成功包装
  (`{errorCode:0,…}`),照常提取。S5 双向锁。
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

**前置规则(D6 模式开关,设计门二轮 P1 勘正)**:`subjectClaim` 配置的 Provider,
身份源**恒定锁死 userinfo**——即便 token 响应带 id_token 且 JWKS 可得,也不进入
验签分支(id_token 仅被忽略,仍绝不解析取值)。原因:身份键必须单一命名空间。若
允许两路径并存,D4 会随 JWKS/id_token 可用性切换路径,id_token 路径产出
`payload.sub`、userinfo 路径产出自定字段——自定字段值与同 Provider 下他人的 sub
相同时,`findByProviderSubject` 直接命中他人账号(**以他人身份登录**)。UI 告警守
不住身份不变量,只有机制能:subjectClaim 配置 ⇒ 单源;未配置 ⇒ 两路径同用规范
`sub`,OIDC 保证同名同义,亦是单命名空间。

分支矩阵(D4;`jwks 配置可得` = `effective.jwksUri !== null`,**只看配置态**;
subjectClaim 配置时跳过前两行、按「id_token=无」行处理):

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
**存量身份同步**(六轮设计门):`'login'` 分支不再走 createIdentity,identity 建立
后才开启 trustEmailVerified 的存量行会永远停在 `email_verified=0`——login 分支把
归一化后的 `claims.email_verified` 与 identity 行比对,不同则更新(并入
`syncPreferredSnapshot` 的同一 dbTxSync 事务,零额外写点),AC-6 的落库承诺覆盖
新建、绑定与存量三形。

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
/** D7:按配置序读取各字段,非空值以单空格拼接;全缺 → null。截断 128 字符——
 *  与 UserSchema.displayName 的 max(128) 对齐(shared/schemas/user.ts:14;
 *  设计门二轮 P2:截 256 会写出违反公开 schema 的 users 行)。 */
function composePreferred(source: Record<string, unknown>, claimList: string[]): string | null {
  const parts = claimList.map((k) => readClaimField(source, k)).filter((v): v is string => v !== null)
  return parts.length > 0 ? parts.join(' ').slice(0, 128) : null
}
```

- `usernameClaim` 配置(空格分隔列表,§2.1)→
  `composePreferred(source, list)`;留空 → 标准 `preferred_username` **string-only**
  读取(`typeof === 'string'` 才取——**不**走 readClaimField 的 number 归一;设计门
  三轮 P3:现状 callback 对该标准 claim 只认 string,默认路径必须逐字节等价,数值
  容忍只属于显式配置的选择器)。结果写入 `claims.preferred_username`;null 时由既有
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
  - 留空 → 标准 `sub`,**string-only、无任何回退**(设计门四轮 P1 勘正,D2 的
    隐式 `?? id` 容错**撤销**:逐次回退是又一个命名空间混用——A 用户走 sub、B 用户
    缺 sub 时走 id,B 的 id 恰等于 A 的 sub 即串号,同一用户两次响应形态抖动则重复
    建号。D6 已提供显式表达:数值/自定 id 平台配 `subjectClaim: 'id'` 即可,隐式
    容错只剩风险没有收益)。缺失 → `userinfo-shape-invalid`。
- **subjectClaim 是身份源模式开关**(设计门二轮 P1 勘正,取代初稿的「文档级混用
  告警」):配置 ⇒ 该 Provider 身份源恒定 userinfo(§5 前置规则),id_token 永不
  参与身份判定——单一命名空间由机制保证而非 hint。id_token 的 `payload.sub` 语义
  仍由 OIDC 规范锚定,任何配置都不能把验签路径的身份键重定向到自定字段(防身份键
  指向 email 等可重分配字段的接管风险)。
- 表单 hint 仍写明「仅纯 OAuth 2.0 IdP 需要配置;IdP 会签发 id_token 时请留空
  (配置后将不再走 id_token 验签路径)」。

两个选择器共享 §2.1 的键名 schema(白名单正则 + 毒键黑名单);own-property 判定
在读取侧兜第二层。显示名 `claims.name` 提取不受影响。

### 5.3 呈现名跟随 IdP 刷新(D7,用户 2026-07-22 三次追加)

动机:用户会在 IdP 侧改名字/呈现信息(如个性签名),平台的呈现名(
`users.displayName`)应跟随刷新;subject(D6)是定位身份的唯一标识。

- **仅 `usernameClaim` 配置时启用**(opt-in):未配置的 Provider 行为与现状逐字节
  一致(displayName 建号后永不自动变)。想对标准 OIDC IdP 启用「跟随 name 刷新」,
  把 usernameClaim 配成 `name` 即可——机制可表达,不必另开开关。
- **三方比对,不与 displayName 直比**:`user_identities.preferred_snapshot` 记录
  该身份最近一次所见的 IdP 侧值。**快照取值域**(设计门二轮 P2 勘正——「从未观察」
  与「观察到无值」必须分开表示):记 `cur = composed ?? ''`,空串是「已观察、IdP
  无值」的哨兵;`null` 只可能出现在 migration 前创建的存量身份上(新逻辑创建的
  identity 恒落 `cur` 初值)。登录时(`decideProvisioning → 'login'` 分支,身份已由
  (providerId, subject) 定位):
  - `snapshot === null`(存量身份首过新逻辑)→ 只落 `cur`、**不刷新** displayName
    (存量用户可能已站内改名,首见即覆盖是数据破坏);
  - `snapshot === cur` → 全不动(**站内改名在 IdP 未变时永不被覆盖**——与
    「displayName 直比」方案的本质区别,后者会把站内编辑一律冲掉);
  - `snapshot !== cur && cur !== ''` → `users.displayName = cur` 且快照 = `cur`;
    新建身份即使建号时字段缺失(快照 `''`),IdP 之后开始返回该字段也能在此分支
    正常跟上(P2-F 的哨兵意义所在);
  - `snapshot !== cur && cur === ''`(IdP 值消失)→ 快照 = `''`,displayName
    **不动**(值缺失不清名)。
- **原子性**(设计门二轮 P2 + 三轮 P2):displayName、快照、`users.updatedAt` 三写
  必须走 **`dbTxSync`**(`db/txSync.ts:31`)配同步 `.get()/.run()`——bun:sqlite 的
  `db.transaction(async …)` 在回调首个 `await` 处就提交,拿裸 async 事务包这三写
  等于没包,正是快照/呈现名分裂窗口本身;dbTxSync 是仓内为该失败模式立的原语。
- **create 路径**:新用户 `displayName = composed ?? claims.name ?? claims.email ??
  'OIDC User'`(composed 优先,新用户无可保护的站内值);快照随 identity 创建落
  `cur` 初值。
- **bindInvited 路径**:只落快照初值、不动 displayName(邀请时 admin 起的名受保护,
  后续 IdP 侧变更才开始跟随)。callback 的 `flow.linkUserId` 关联分支共享
  createIdentity 落快照;该分支在现树**不可达**(startFlow 唯一调用方不传
  linkUserId,`routes/oidc-auth.ts:39`——RFC-036 遗留死分支,补 link-start 入口
  不在本 RFC 范围,见 proposal 非目标)。
- 多身份用户(多 Provider 关联):谁登录谁刷新,最后登录的身份胜出——与「呈现名
  跟随最近使用的 IdP」直觉一致,文档明示。
- 落点:`services/userIdentities.ts` 增
  `syncPreferredSnapshot(db, { providerId, subject, composed, userId })`(内部按上表
  处理,返回是否刷新了 displayName 供测试断言);callback 在 login 分支调用。

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

provisioning **决策**(decideProvisioning)与 session 签发零改动;link 路径因共享
claims 获取而自动获得纯 OAuth2 支持。**供给写段两点增量**(五轮设计门):

1. **create / bindInvited 的用户写与 identity 写并入同一 dbTxSync 事务**,写入时
   重验(§2.3)在该事务内执行——否则重验 mismatch 只回滚 identity 插入,会留下
   「无身份的 active 用户」或「已激活却绑定失败的邀请」半供给残骸;mismatch 时
   整体回滚,断言零副作用(S8)。
2. **供给写段包第二层 try/catch**:写入时重验抛出的 `provider-config-changed`
   发生在 claims try/catch 之后的写段,不接住会落到全局 errorHandler(JSON/500)
   而非承诺的 friendly 400 HTML;该 catch 识别配置漂移错误 →
   `c.html(friendly('provider-config-changed'), 400)`。

D7 的增量接线(§5.3):`'login'` 分支在签发 session 前调 `syncPreferredSnapshot`;
`'create'` 分支 displayName 取 `composed ?? name ?? email ?? 'OIDC User'`;identity
创建点(create / bindInvited / link)随行落快照初值。

### 6.3 friendly 文案(`util/oidcResponse.ts`)

新增四条:

| code | 文案(英文,与既有条目同风格) |
| --- | --- |
| `endpoints-unresolved` | The identity provider endpoints could not be resolved. Contact your administrator. |
| `userinfo-unavailable` | The identity provider returned no id_token and no userinfo endpoint is configured. Contact your administrator. |
| `jwks-unavailable` | The id_token cannot be verified (no JWKS available) and no userinfo endpoint is configured. Contact your administrator. |
| `userinfo-fetch-failed` / `userinfo-shape-invalid` | Could not fetch identity information from the provider. / The provider returned an unusable userinfo response. |
| `provider-config-changed` | The provider configuration changed during sign-in. Please try again. |

## 7. /test 端点(`routes/oidc.ts` + service)

现状 `svc.testDiscovery(issuerUrl)` 只探 discovery+JWKS,对手动端点配置毫无诊断力。
替换为:

```ts
// service 新方法(testDiscovery 移除,唯一调用点就是本路由;既有测试锁迁移见 §12 S2)
probe(provider: OidcProvider, fetcher?: typeof fetch): Promise<ProbeResult>

interface ProbeResult {
  /**
   * loginReady:authorization + token 且身份通道按运行时分支(§5)悲观可走:
   * - subjectClaim 配置(D6 模式)⇒ 必须 userinfo,**jwks 完全不参与**(该模式
   *   运行时忽略 jwks;六轮设计门:discovery 带失效 jwks_uri 而手动 userinfo
   *   完好的纯 OAuth Provider,登录明明能成却被 Test 报失败是反向假诊断——
   *   此模式跳过 jwks 探测,jwksReachable 置 undefined);
   * - 未配置 ⇒ `jwksUri 已配 ? jwksReachable : userinfo 已配`。四轮 P2 勘正:
   *   jwksUri 已配但探测不可达时,**无论 userinfo 是否在场都 not-ready**——
   *   §5 矩阵第一行规定 id_token+jwks 配置可得必走验签且拉取失败硬失败不降级,
   *   IdP 一旦发 id_token 则全部回调失败,userinfo 救不了;诊断不能宣称 ready。
   * 已知不可判定残余(明示):jwks-only 且可达的配置,对「IdP 不发 id_token」的
   *   形态仍会 userinfo-unavailable——IdP 是否发 id_token 无法探测,悲观化会把
   *   健康的标准 OIDC(jwks-only)全部误报 not-ready,故保持 ready 并在前端
   *   展示一行说明。
   * 与 §3.2 loginViable 同源实现,仅 jwksReachable 维度是 probe 独有。
   */
  ok: boolean
  discovery: { ok: boolean; error?: string }
  issuer: string
  endpoints: Record<
    'authorizationEndpoint' | 'tokenEndpoint' | 'userinfoEndpoint' | 'jwksUri',
    { url: string; source: EndpointSource } | null
  >
  /** 未配置 subjectClaim 且 jwksUri 非空时实拉一次,不可达则 ok=false(五轮 P2
   *  统一口径——userinfo 在场也救不了会发 id_token 的 IdP);subjectClaim 模式
   *  不探测、恒 undefined(六轮)。本字段只为前端展示失败原因。 */
  jwksReachable?: boolean
  scopesSupported: string[]   // discovery 可用时透传,否则 []
}
```

- probe **双缓存都绕过、强制 fresh fetch**(设计门二轮 P2:只绕负缓存仍会吃到
  1h 陈旧正缓存,IdP 元数据变更/劣化后 admin 拿到假诊断),复用 `resolveEndpoints`
  的合并逻辑(注入 fetcher + forceFresh);探测结果按 §3.2 规则回填两级缓存
  (成功回填正缓存;失败仅在「manual 足以继续」时写负缓存),使诊断顺带修正
  运行态缓存而非与其分叉。
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
    留空用标准 sub;数值 id 平台请显式填 id。必须选平台生成、**稳定唯一且类型
    稳定**的 ID 字段,勿用 email 等可变字段;仅纯 OAuth 2.0 IdP 需要配置,IdP 会
    签发 id_token 时请留空(配置后不再走 id_token 验签路径,且有关联身份后不可
    再改)」。
- scopes 字段 hint 更新(设计门二轮 P2:现 hint「openid is required」对纯 OAuth2
  IdP 是错误指引,严格 server 会对未知 `openid` scope 抛 invalid_scope):改为
  「OIDC IdP 必含 openid;纯 OAuth 2.0 IdP 按其文档填写(不支持时勿带 openid)」。
  默认值 `openid profile email` 不动(存量兼容;纯 OAuth2 场景 admin 按 hint 改)。
- 全部复用 `Field/TextInput/Switch` 公共原语与 `oidc-form__group` 既有样式,零新
  chrome(前台一致性强制原则)。
- 提交归一:`'' → null`;`OidcProviderRow` 接口补 7 字段。

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
   重新分配字段造成账号接管);默认路径 `sub` string-only 且**无 id 回退**(四轮
   P1:逐次回退=命名空间混用);变更锁 + 写入时重验(§2.3)。UI hint 要求选
   **平台生成、稳定唯一、类型稳定**的 ID 字段。
   **已知残余(四轮 P1-iii,部分采纳)**:配置分支对 number 值 `String(v)` 归一,
   意味着同字段 `"7"`(string)与 `7`(number)折叠同键。不加类型前缀的理由:
   ID 字段由 IdP 平台侧生成、序列化类型非终端用户可控——能让用户改写自身 ID 字段
   类型的平台等于允许伪造身份键,已超出「配了不稳定字段」的同级信任破坏(hint 已
   警告);而类型前缀会把常见平台的序列化抖动(同一用户有时 `"7"` 有时 `7`)变成
   静默重复建号,常态代价高于理论攻击面。S13 以显式语义锁把折叠行为钉住,防未来
   无意识漂移。
10. **D7 刷新的写入纪律**:只写 `users.displayName` 与身份快照,不触碰
    username/role/status 等任何权限相关字段;拼接值截断 128(对齐
    UserSchema.displayName 上限);存量身份 null 快照首见不覆盖、三方比对保护站内
    编辑、三写同事务(§5.3)。displayName 的 XSS 面由前端渲染层(React 转义)兜,
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
| userinfo 非 2xx / 非 JSON / subject 字段缺失(默认 `sub`,或配置的 subjectClaim) | 400 `userinfo-fetch-failed` / `userinfo-shape-invalid` |
| 在途 callback 撞上 subjectClaim 变更(写入时重验失败) | 400 `provider-config-changed`(重登即走新配置) |
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
- **S2 service**:create/patch/materialize 7 字段 roundtrip;patch null 清空;
  redacted 含新字段;**subjectClaim 变更锁**(三轮 P1)——有 identities 时
  null→值 / 值→值 / 值→null 三形均 409、等值重写不拦、无 identities 放行;
  **反向交错锁**(五轮 P1)——callback 侧身份事务先提交、PATCH 后提交 → PATCH
  409(两侧 dbTxSync 全序化);`probe` 的 loginReady 判定(subjectClaim 模式要求
  userinfo;jwksUri 配置且不可达 → 恒 not-ready,userinfo 在场亦然)与 sources
  组装(全 tests 已盘:service 层无既有 testDiscovery 锁,迁移面仅 login-chain
  discovery describe)。
- **S3 resolveEndpoints**:D1 矩阵(全 discovery / 部分文档补位 / 整体失败全 manual /
  双缺 → null+sources.none);**畸形 discovery 字段视为缺失**(空串/数值/非 http(s)
  URL → 落 manual 补位,设计门 P1 锁);issuer 来源两态且**尾斜杠原样保留**;partial
  文档落正缓存(第二次 resolve 不再 fetch,限合并后 loginViable 的配置);
  **正缓存条件命中两 case**(三轮 P1)——200 `{}` 无 manual 兜底:窗口内每次仍
  重探、IdP 恢复即恢复;200 partial + manual 补齐:第二次不 fetch;**负缓存门槛
  含身份通道**(二轮 P1+三轮 P2)——manual 仅 authz+token(无 userinfo/jwks):
  负缓存按 miss 重探;manual 全通道齐:窗口内直走 manual;subjectClaim 配置且
  manual 无 userinfo:按 miss;`forceFresh` 双缓存绕过 + 结果回填;超时路径
  (fetcher 抛 AbortError 按失败处理)。
- **S4 exchange**:无 id_token 有 access_token → 成功且 `id_token === undefined`;
  无 access_token → `token-exchange-shape-invalid`(回归);`id_token: null` 脏字段
  按不存在处理;**传输异常(fetcher throw)与 200+非法 JSON 均包为
  `token-exchange-failed`**(三轮 P2,行为变化 #3 的支撑锁)。
- **S5 fetchUserinfo + extractUserinfoClaims**:请求头 Bearer + accept 断言;标准
  claims 提取(默认 `sub` string-only,数值 sub / 有 id 无 sub → shape-invalid,
  D2 修订锁);object sub 拒绝;401 → fetch-failed;非 JSON body → shape-invalid;
  fetcher 超时(AbortError)→ fetch-failed;**body 超 256 KiB → fetch-failed
  (body-too-large 回归锁)**。
- **S6 acquireIdentityClaims 矩阵**:§5 五行全锁;重点对抗性 case——id_token 验签
  失败 + userinfo 可用 → **仍硬失败**(不降级);jwks 配置可得但运行时拉取失败 +
  userinfo 可用 → **仍硬失败**;未验签 id_token 的 claims 绝不出现在结果里
  (id_token 与 userinfo 给出不同 sub,断言结果 = userinfo 的 sub)。
- **S7 applyEmailTrust**:开/关 × email 有/无 四格;开启时经 callback 落库
  `user_identities.email_verified = 1`(集成断言);**存量身份 login 分支同步**
  (六轮:identity 先建、后开 trustEmailVerified、再登录 → 行更新为 1;关闭后
  再登录不回写 0?——回写:比对语义是「与归一化 claims 一致」,双向同步,各一
  case);默认关行为与现状一致。
- **S8 路由级**:start 对 discovery 失败 + 无手动端点 → 503 `oidc-endpoints-unresolved`
  且 body 含 message(issuerUrl 指向 127.0.0.1 关闭端口,连接即拒,快速且离线);
  start 对 discovery 失败 + 手动 authorize → 200 且 authorizeUrl 前缀为手动端点;
  **OAuth-only callback 全链**(设计门二轮 P2:S5/S6 只测助手函数,路由接线可断而
  全绿):测试内 `Bun.serve` 起本地假 IdP(token 端点回 access-token-only、userinfo
  端点回自定形状),provider 手动端点指向它、issuerUrl 指向关闭端口;走
  login/start 取 state → GET callback → 断言 provisioning 建号/identity 落库
  (subject 取自 subjectClaim 字段)/session 签发/`#aw_session` 重定向全链;
  **配置漂移路由级 case**(五轮 P2):callback 进行中 PATCH subjectClaim →
  400 HTML `provider-config-changed`(非 JSON/500),且**零副作用断言**——无新
  users 行、邀请用户 status 仍 invited、无 identity 行(五轮 P1 半供给残骸锁)。
- **S9 migration**:upgrade-rolling 计数 bump(107→108);从 HEAD 建库对**两表全部
  8 个新列逐列断言**(列名/可空/默认值——oidc_providers 7 + user_identities
  preferred_snapshot;设计门二轮 P2:计数式断言漏单列仍会绿);push 前跑全量后端
  `bun test`(feedback_full_suite_after_migration)。
- **S10 前端 vitest**:表单渲染 4 端点 + Switch + usernameClaim 输入;编辑回填;
  空串提交归一 null;test 结果按新 shape 展示来源;既有 create/edit 测试不回归。
- **S11 纠偏锁**:OidcTokenError code 透传到 friendly 页(token-exchange-failed 不再
  塌成 verify-failed);sub 空串拒绝(id_token 路径)。
- **S12 usernameClaim(D5)**:schema 拒 `__proto__`/`constructor`/`prototype`/超长/
  含空格键名,合法键通过;`readClaimField` own-property(原型链键读不到)/
  string|安全整数 number 归一/大数与其它类型 null;userinfo 路径与 id_token 路径各
  一条「配置 usernameClaim 后 preferred_username 取自该字段」;配置了但字段缺失 →
  null 并回落推导链(不回读标准 preferred_username);留空 → 现状逐字节一致(回归,
  **含数值 preferred_username 被忽略**——默认路径 string-only,三轮 P3 锁)。
- **S13 subjectClaim(D6)**:配置后 sub 取自该字段(string 与安全整数 number 两
  形);配置了但字段缺失/类型不符 → `userinfo-shape-invalid`(**不回落** sub/id,
  对抗性锁);留空 → 标准 `sub` **string-only 且无 id 回退**(四轮 P1 锁:有 id
  无 sub → shape-invalid;数值 sub → shape-invalid);**大数值拒绝**
  (`9007199254740993` → shape-invalid,精度折叠锁);**同值异型折叠语义锁**
  (`"7"` 与 `7` 归一同键,注明 §9.9 rationale,防无意识漂移);**模式开关锁
  (二轮 P1)**:subjectClaim 配置 + id_token 存在 + JWKS 可得 → 仍走 userinfo,
  sub 取自定字段且 id_token 的 claims 不出现在结果里(单命名空间对抗锁);未配置 +
  id_token 路径 → payload.sub 照旧;**写入时重验锁(四轮 P1)**:createIdentity
  携带 callback 快照的 expectedSubjectClaim,事务内 provider 现值不一致 → 拒写。
- **S14 拼接与呈现名刷新(D7)**:`ClaimNameListSchema` 拒双空格/首尾空格/毒键
  token/超 8 token,单字段串向后兼容;`composePreferred` 顺序保持、缺字段跳过、
  全缺 null、**128 截断**(对齐 UserSchema);刷新分支各一条——快照相同不动、快照
  不同且 cur 非空刷 displayName+快照(**dbTxSync 同步事务**,断言两写一致)、
  **快照 null 只落快照不刷**(存量保护锁)、**建号时字段缺失(快照 `''`)→ IdP 次登出值 → 正常
  刷新**(哨兵锁,二轮 P2)、IdP 值消失(cur `''`)→ 快照更新但 displayName 不清;
  **站内改名 + IdP 未变 → 不覆盖**(三方比对对抗锁);create 路径
  displayName=composed 优先;bindInvited 只落快照;未配置 usernameClaim → 永不
  刷新(回归);多身份最后登录胜出。link 分支不设 case(现树不可达,§5.3)。

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
discovery」两条非目标明示(proposal §3)。

### 14.1 设计门二轮(Codex @ 合成提交,基座 7f7296a4;2 P1 + 9 P2,全采纳)

覆盖一轮修订 + D6/D7 追加后的全量文档:

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | subjectClaim 配置下 id_token/userinfo 两路径产出不同命名空间的 subject,D4 路径切换时自定字段值可命中他人 sub → **以他人身份登录**;UI 告警守不住身份不变量 | subjectClaim 升级为**身份源模式开关**:配置 ⇒ 恒走 userinfo,id_token 不参与身份判定(§5 前置规则/§5.2;S13 单命名空间对抗锁) |
| 2 | P1 | 负缓存对无手动端点的标准 OIDC IdP 把一次瞬时 discovery 故障放大成 5min 全量拒登(现状每请求重试自然恢复) | 负缓存仅对「manual authz+token 齐备」的 Provider 生效,判定在读取侧(§3.2;S3 两 case) |
| 3 | P2 | callback 的 linkUserId 分支在现树不可达(startFlow 唯一调用方不传),AC/S14 的 link 承诺兜空 | 从 AC-3/S14 移除 link 承诺,§5.3 注明 RFC-036 遗留死分支、补入口不在本 RFC(proposal 非目标) |
| 4 | P2 | scopes 默认值+hint「openid is required」对纯 OAuth2 是错误指引(invalid_scope) | hint 双分支改写,默认值不动(§8.1) |
| 5 | P2 | composePreferred 截 256 超 UserSchema.displayName max(128),会写出违反公开 schema 的 users 行 | 截断改 128(§5.2/§9.10;S14) |
| 6 | P2 | 快照 null 双语义:新建号时字段缺失也落 null,IdP 后来出值被存量保护分支吞掉 | 快照域改 `cur = composed ?? ''` 哨兵,null 仅存量;新身份恒落初值(§5.3;S14 哨兵锁) |
| 7 | P2 | displayName 与快照两写无事务,崩溃窗口造成永久跳过刷新 | 三写(含 users.updatedAt)单 db.transaction(§5.3;S14) |
| 8 | P2 | probe 只绕负缓存仍吃 1h 陈旧正缓存,诊断失真 | probe 双缓存绕过 + 结果按规则回填(§7) |
| 9 | P2 | fetchUserinfo `res.json()` 无字节界,公开回调可被灌爆内存 | 响应体 256 KiB 上限,超限 fetch-failed(§4.2;S5) |
| 10 | P2 | AC-3 无路由级 OAuth-only callback 全链测试,路由接线可断而全绿 | S8 增 Bun.serve 本地假 IdP 的 callback 全链 case(§12) |
| 11 | P2 | S9 计数式断言(且残留「5 新列」旧文)漏单列仍绿 | S9 改两表 8 列逐列断言(§12) |

### 14.2 设计门三轮(Codex @ 合成提交 v3,基座同前;2 P1 + 5 P2 + 1 P3,全采纳)

覆盖二轮修订(模式开关/条件负缓存/哨兵/事务)后的全量文档:

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | 已有 identities 的 provider 改/清 subjectClaim → 存量身份键留在旧命名空间,新值 miss 重复建号或撞他人旧 sub **以他人身份登录**;强制 userinfo 只管未来回调管不了已落库行 | patch 加 subjectClaim 变更锁:存在 identities 即 409,无 force 旁路(§2.3;S2 三形锁) |
| 2 | P1 | 标准 OIDC IdP 瞬时 200 `{}`/partial 被当成功缓存 1h,无 manual 兜底时把「incomplete 每请求重试」的现状变成 1h 宕机固化 | 正缓存命中条件化:合并 manual 后 `loginViable` 才采纳,否则视 miss 重探并覆盖条目(§3.2;S3) |
| 3 | P2 | 负缓存门槛只查 authz+token,身份通道缺失的「半可行」配置窗口内 start 跳转成功而 callback 必败 | 谓词升级为完整登录通道 `loginViable`(subjectClaim 模式恒需 userinfo),两级缓存共用(§3.2;S3) |
| 4 | P2 | probe ok 在 subjectClaim 模式下仍把可达 jwks 当身份通道,报 ready 而回调必抛 userinfo-unavailable | ok 公式按模式分支,与 loginViable 同源(§7;S2) |
| 5 | P2 | §7 要求 probe forceFresh 但 resolveEndpoints 契约无该选项,照契约实现拿不到 fresh | opts 增 `forceFresh?: boolean`(§3) |
| 6 | P2 | bun:sqlite 裸 `db.transaction(async …)` 在首个 await 提交,三写事务形同虚设 | 指定 `dbTxSync`(db/txSync.ts:31)+ 同步 .get()/.run()(§5.3;S14) |
| 7 | P2 | token 交换的传输异常/200 非法 JSON 抛裸异常,callback 仍塌 verify-failed,行为变化 #3 落空 | exchange 内统一包 `token-exchange-failed`(§4.1;S4 两形锁) |
| 8 | P3 | 默认路径经 readClaimField 会把数值 preferred_username 归一成串,现状只认 string,违背逐字节等价 | 默认路径 string-only,数值容忍仅限显式配置的选择器(§5.2;S12 回归锁) |

### 14.3 设计门四轮(Codex @ 合成提交 v4;4 P1 + 1 P2,3.5 采纳 + 1 部分采纳)

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | 默认 `sub ?? id` 逐次回退本身是命名空间混用:B 缺 sub 时其 id 撞 A 的 sub 即串号,同一用户形态抖动则重复建号 | **采纳,D2 隐式 id 容错撤销**:默认 `sub` string-only 无回退;数值/自定 id 平台显式配 `subjectClaim: 'id'`(§5.2;S13;proposal D2 修订注) |
| 2 | P1 | PATCH 变更锁有 TOCTOU:在途 callback 读旧配置、PATCH 在 identity 落库前通过、随后按旧命名空间写入 | **采纳**:identity 写入点 dbTxSync 事务内重验 provider.subjectClaim 与 callback 快照,mismatch → 400 `provider-config-changed`(§2.3/§10;S13 重验锁) |
| 3 | P1 | `readClaimField` 把 `"7"` 与 `7` 折叠同键,病态混型 IdP 下可跨用户折叠 | **部分采纳**:不加类型前缀(会把常见序列化抖动变成静默重复建号,且 ID 字段类型非终端用户可控,属「配了不满足契约的字段」同级信任破坏);hint 加「类型稳定」要求 + S13 显式语义锁钉住行为 + §9.9 记 rationale |
| 4 | P1 | resolveEndpoints 的 Pick 缺 subjectClaim,loginViable 无从判模式 | **采纳**:契约补 `'subjectClaim'`(§3) |
| 5 | P2 | jwksUri 已配但探测不可达时,userinfo 在场仍报 ready;而 §5 规定 id_token+jwks 配置必走验签且硬失败 | **采纳**:未配 subjectClaim 时 ready = `jwksUri ? jwksReachable : userinfo`;jwks-only 对「无 id_token 形态」的不可判定残余明示并前端注记(§7) |

### 14.4 设计门五轮(Codex @ 合成提交 v5;3 P1 + 5 P2,全采纳)

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P1 | 变更锁反向交错:PATCH 读「无身份」→ callback 身份事务提交旧命名空间 → PATCH 提交新 claim,四轮的单侧重验挡不住 | PATCH 侧「零身份谓词+更新」也收进 dbTxSync,与身份写入事务经 SQLite 单写锁全序化(§2.3;S2 反向锁) |
| 2 | P1 | 写入时重验 mismatch 只回滚 identity 插入,留下无身份 active 用户 / 已激活邀请的半供给残骸 | create/bindInvited 的用户写+identity 写+重验并入同一 dbTxSync,mismatch 整体回滚零副作用(§6.2;S8 断言) |
| 3 | P1 | proposal 非目标/D6 残留 stale `sub ← id` 表述,与 D2 修订冲突(proposal 先于 design 被阅读) | 全文清扫,非目标改「无任何隐式字段回退」,D5/D6 行统一口径 |
| 4 | P2 | 「force 清身份后 PATCH」是不存在的路径:remove(force) 连 provider 一起删 | 改「删除并重建 Provider」,数据后果明示(§2.3;S2 case 同步改) |
| 5 | P2 | 正缓存留在 discovery.ts 时 resolver 无法做条件命中/单键覆盖/forceFresh | 两级缓存所有权全部移入 endpoints.ts,discovery.ts 退化纯 fetch(§3.2/§3.3) |
| 6 | P2 | 写入时重验的错误抛在 claims try/catch 之后,会落全局 handler(JSON/500)而非 friendly 400 | 供给写段第二层 try/catch → friendly('provider-config-changed')(§6.2;S8 路由级) |
| 7 | P2 | proposal D5 行「字段缺失回落标准 preferred_username」与 design「不回读」矛盾 | D5 行拆「留空」与「配置而缺失」两态,与 §5.2/S12 对齐 |
| 8 | P2 | §7 jwksReachable 字段注释残留「userinfo 在场仅警示」旧契约,与 ok 公式矛盾 | 注释统一 fail-closed 口径(§7) |

### 14.5 设计门六轮(Codex @ 合成提交 v6;0 P1 + 4 P2,全采纳)——收敛收口

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P2 | subjectClaim 模式运行时完全不用 jwks,但 probe 仍因 jwksUri 不可达报失败(反向假诊断) | 该模式跳过 jwks 探测、不参与 ok(§7) |
| 2 | P2 | trustEmailVerified 在 identity 建立后开启时,login 分支永不回写 email_verified,AC-6 落库承诺缺存量形 | login 分支比对同步(并入 syncPreferredSnapshot 事务),双向;AC-6 明示三形(§5.1;S7) |
| 3 | P2 | ProbeResult.scopesSupported 在 resolver 契约里没有来源 | EffectiveEndpoints 增 `scopesSupported: string[]`(运行时校验透传,§3) |
| 4 | P2 | ClaimNameListSchema `.max(512)` 低于自身宣称上界 8×64+7=519 | `.max(519)` 并注明来源(§2.1) |

**收口判定**:六轮 P1 归零、findings 降为纯一致性修订(P2×4),对照一至五轮
(6→11→8→5→8 findings、P1 计 14 条)已收敛;设计门就此关闭,剩余把关移交实现门
(Codex impl review)与 S1-S14 测试面。

### 14.6 实现门(Codex @ 实现全链合成提交,基座 1152d219;0 P1 + 4 P2,全采纳)

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P2 | fresh 探测失败只写负缓存不删正缓存条目:负窗口(5min)过后,仍在 1h TTL 内的陈旧正条复活,返回过期 discovery 端点 | 失败路径无条件 `positiveCache.delete`(最新事实优先);S3 增「fresh 失败驱逐陈条」锁 |
| 2 | P2 | probe 的 jwks 可达性只看 `res.ok`,200+HTML/空体也报 reachable,而运行时 `createRemoteJWKSet` 必败(旧 testDiscovery 本会消费 body) | 探测解析 body 并校验 `{ keys: [...] }` 形状;probe 测试增 200 非 JWKS 体 case |
| 3 | P2 | userinfo 头部已回、body 流中途 reset/abort 时异常抛在 `reader.read()`(transport catch 之外),塌成 verify-failed | `readBodyCapped` 内 catch 流读异常包 `userinfo-fetch-failed body-read`(body-too-large 原样透传);S5 增流中断 case |
| 4 | P2 | 前端 discovery-down 文案在 not-ready 配置下仍称「正在使用手动端点」且丢弃 `discovery.error` | 文案按 `result.ok` 分支:ready 才用回退措辞,否则展示真实失败原因(新 i18n key `testDiscoveryError`);前端测试断言真实错误串 |

### 14.7 实现门二(Codex @ D8+D9 增量;0 P1 + 2 P2,全采纳)

| # | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | P2 | 字符串型零码 `{"errorCode":"0"}` 被 D9 判为错误,stringly API 的成功包装全灭 | idpErrorOf 对 errorCode 键做数值零豁免(仅 errorCode;标准 `error` 是裸错误标识不豁免);S5 双向补锁 |
| 2 | P2 | 请求方式 Field 缺 `group`,`<label>` 包裹两个 radio——点标签/hint 文字代理到首选项,静默把已存的 post_json 重置 | Field 加 `group`(role=group + aria-labelledby);前端锁「点标签不改选择」 |
