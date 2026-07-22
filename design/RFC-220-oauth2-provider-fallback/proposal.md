# RFC-220 — 纯 OAuth 2.0 Provider 接入:手动端点降级与 userinfo 身份源

- 状态:Draft
- 发起:用户,2026-07-22
- 前置阅读:`design/RFC-036`(SSO 登录原始设计,oidc\_providers / 登录链的来源)

## 1. 背景

RFC-036 落地的 SSO 登录链假定 IdP 是**完整 OIDC 实现**,有两处硬依赖:

1. **Discovery 硬依赖**。`login/start` 与 `callback` 都要先拉
   `<issuer>/.well-known/openid-configuration`,且要求文档同时含
   `issuer + authorization_endpoint + token_endpoint + jwks_uri` 四字段
   (`auth/oidc/discovery.ts:54-56`,缺一即 `oidc-discovery-incomplete`)。
   失败后果:
   - `login/start` 处未捕获(`routes/oidc-auth.ts:43`)→ HTTP 500;
   - `callback` 处 `friendly('discovery-failed')` → HTTP 503(`routes/oidc-auth.ts:71-79`)。
2. **id_token 硬依赖**。token 响应必须同时含 `access_token` 与 `id_token`,否则
   `token-exchange-shape-invalid`(`auth/oidc/tokens.ts:58-62`);随后 `verifyIdToken`
   强制验签 + iss/aud/exp + nonce(`auth/oidc/tokens.ts:74-95`)。

现实中大量自建/内网 IdP 只是**纯 OAuth 2.0 authorization server**:没有 discovery
文档、token 响应没有 `id_token`,只有 authorize / token / userinfo 三件套。现状下这类
Provider 在本平台**完全无法接入**——登录流程在上述两处直接报错。

## 2. 目标

1. Provider Schema 增加 **4 个可选手动端点字段**:`authorizationEndpoint` /
   `tokenEndpoint` / `userinfoEndpoint` / `jwksUri`。
2. **Discovery 失败时降级使用手动端点**而非直接报错;Discovery 成功但缺个别字段时,
   手动字段**逐字段补位**(D1)。
3. **token 响应无 id_token 时改调 userinfoEndpoint** 获取用户信息,不再强制校验
   id_token;id_token 存在且 JWKS 可得时验签行为与现状完全一致(D4)。
4. 纯 OAuth 2.0 IdP 也能配合 `invite` / `allowlist` 供给政策使用:新增 per-provider
   `trustEmailVerified` 开关(D3)。
5. **身份字段来源可配置**(userinfo 的格式由 IdP 平台自定,标准字段名不一定存在):
   - `usernameClaim`:指定从身份响应(id_token payload / userinfo JSON)读取呈现名
     的字段名,**支持空格分隔多个字段、取值按序空格拼接**(如 `name signature`);
     留空 = 标准 `preferred_username`(D5+D7,用户 2026-07-22 中途追加)。
   - `subjectClaim`:指定从 userinfo 读取 subject(登录身份键)的字段名;留空 =
     标准 `sub`(容错 `id`);仅作用于 userinfo 路径,id_token 路径永远用规范
     `sub`(D6,用户 2026-07-22 二次追加)。
6. **呈现名跟随 IdP 刷新**:每次登录以 subject 定位身份,拼接值与上次快照不同则
   刷新 `users.displayName`(覆盖「用户在 IdP 侧改名/改个性签名」场景);快照三方
   比对保证站内改名在 IdP 未变时不被覆盖(D7,用户 2026-07-22 三次追加)。

## 3. 非目标

- **不做通用 per-provider claim 映射配置**。userinfo 按标准 OIDC claims 提取,仅内置
  `sub ← id` 单点容错(D2)与两个单字段选择器 `usernameClaim`(D5)/
  `subjectClaim`(D6);更复杂的映射需求(如 `email ← mail`)将来另立 RFC。
- **不支持 signed userinfo(application/jwt 响应)**、token introspection、
  UserInfo POST 形态;只接受 JSON userinfo。
- **不改变完整 OIDC Provider 的既有行为**:discovery 健康且 token 响应带 id_token
  时,验签、nonce、iss/aud 校验逐字节保留。
- **不动 issuerUrl 的既有语义与校验**(仍必填,仍是 discovery 探测基址 / 缓存键 /
  手动模式下的 iss 期望值);不为存量字段追加校验(避免存量行 materialize 失败)。
- 不做「禁用 PKCE」开关:纯 OAuth2 server 按惯例忽略不认识的
  `code_challenge`/`nonce` 参数;遇到会拒绝未知参数的严格 server 再议。
- token 端点客户端认证维持现状 `client_secret_post`(随表单体发送);只接受
  `client_secret_basic` 的 IdP 另立 RFC。
- 手动端点**永不覆盖** discovery 已提供的字段(D1 是补位不是覆盖,用户拍板);IdP
  discovery 文档本身写错端点属 IdP 侧修复范畴。
- 不补账号关联(link)的发起入口:callback 的 `flow.linkUserId` 分支在现树不可达
  (RFC-036 遗留死分支,startFlow 唯一调用方不传 linkUserId);本 RFC 的 claims
  获取改造在共享点落地,未来接通入口即自动生效,但补入口本身另立 issue/RFC。
- 不触碰权限审计(2026-07-15)里与 OIDC 相关的其它遗留项(开放重定向等)。

## 4. 用户故事

- **US-1(纯 OAuth2 IdP)**:管理员在 Settings → Authentication 新建 Provider:填
  issuerUrl(作为标识与兜底探测)、client 凭据,再在「手动端点」组里填
  authorize / token / userinfo 三个 URL,打开 trustEmailVerified,`usernameClaim`
  填 `login`、`subjectClaim` 填 `id`(该平台的 userinfo 用 `login` 承载用户名、
  `id` 承载稳定用户标识),provisioning 选 invite。
  被邀请用户点登录按钮 → 跳 IdP 授权 → 回调换 token(无 id_token)→ 平台调
  userinfo 拿到 sub/email/用户名 → 绑定邀请、签发 session,登录成功。
- **US-2(OIDC IdP 的 discovery 故障韧性)**:管理员给标准 OIDC Provider 预填了手动
  端点。某天 IdP 的 `/.well-known` 路由被网关误伤:登录自动落到手动端点继续可用,
  不再 503。
- **US-3(诊断)**:管理员点「Test connection」,看到每个有效端点的取值与来源
  (discovery / manual)、discovery 探测结果,以及「当前配置是否足以完成登录」的
  结论,据此补齐缺失字段。

## 5. 设计决策记录(用户 2026-07-22 四拍板)

| # | 决策 |
| --- | --- |
| D1 | 端点合并**逐字段补位**:discovery 有的字段用 discovery,缺的用手动补;discovery 整体失败(网络/非 200/非 JSON)→ 全套用手动。 |
| D2 | userinfo 按**标准 claims + sub 容错**提取:认 `sub/email/email_verified/name/preferred_username`;`sub` 缺失时容错取 `id`(string/number → 字符串);不做可配映射。 |
| D3 | 新增 per-provider 布尔 **`trustEmailVerified`**(默认关):开启后该 Provider 返回的 email 一律视为已验证(作用于 id_token 与 userinfo 两条路径)。 |
| D4 | 有 id_token 但 **JWKS 配置不可得**(discovery 挂且未配 jwksUri)→ 忽略未验签 id_token,**降级走 userinfo**;两者都无才报错。只要 JWKS **配置可得**,验签失败(含 JWKS 运行时拉取失败)一律硬失败,不降级。 |
| D5 | (2026-07-22 中途追加)per-provider 可选 **`usernameClaim`**:指定从身份响应读取用户名的字段名,命中值写入 `claims.preferred_username`;字段缺失/留空时回落标准 `preferred_username` 及既有用户名推导链。作用于 id_token 与 userinfo 两条路径。 |
| D6 | (2026-07-22 二次追加;二轮设计门升级为模式开关)per-provider 可选 **`subjectClaim`**:指定从 userinfo 读取 subject(登录身份键)的字段名。与 D5 有意不对称——配置后字段缺失**硬失败不回落**(身份键静默换源会造成账号分裂/串号);留空走 D2 默认(sub→id)。**配置即把该 Provider 的身份源锁死为 userinfo**(id_token 即便可验签也不参与身份判定):两路径命名空间混用会让自定字段值命中他人 sub 而以他人身份登录,单命名空间必须由机制而非 UI 告警保证;id_token 路径的规范 `sub` 永不可被配置重定向。**已有身份的 Provider 禁改 subjectClaim**(三轮设计门:存量身份键留在旧命名空间,换源可致重复建号或身份串号;PATCH 变更在存在 user_identities 时 409,需先 force 清身份或另建 Provider)。 |
| D7 | (2026-07-22 三次追加)`usernameClaim` 升级为**空格分隔字段名列表**,取值按序空格拼接(缺字段跳过、全缺回落推导链、128 截断对齐 UserSchema);并新增**呈现名跟随刷新**:`user_identities.preferred_snapshot` 记录 IdP 侧拼接值快照(空串=已观察无值的哨兵,null 仅存量身份),登录时(以 subject 定位)快照有值且与新值不同且新值非空 → 刷新 `users.displayName`(与快照、updatedAt 同事务);存量身份 null 快照首见只落库不覆盖(保护已站内改名者),IdP 值消失不清名;仅 usernameClaim 配置时启用,未配置行为与现状逐字节一致。 |

## 6. 行为变化(明示)

对存量部署可感知的变化,全部列出:

1. `login/start` 处 discovery 失败:曾未捕获异常 → HTTP 500;现返回
   `503 {ok:false, code:'oidc-endpoints-unresolved'}`(无手动端点可降级时)。属纠偏。
2. `callback` 处 token 响应无 id_token:曾 400(`verify-failed` 文案);现走 userinfo
   路径(若可用),否则 400 `userinfo-unavailable`。
3. `callback` 的错误码塌缩纠偏:`OidcTokenError` 曾统一塌成 `verify-failed`
   (`routes/oidc-auth.ts:106-108` 只识别 `BadRequestErrorOrFriendlyHtml`),现透传
   精确 code(`token-exchange-failed` / `id-token-verify-failed` 等,friendly 表中的
   既有死文案复活)。
4. id_token 的 `sub` 为空串:曾会创建 `subject=''` 的 identity(
   `routes/oidc-auth.ts:99` `String(payload.sub ?? '')`);现拒绝(400)。属纠偏。
5. discovery 探测挂起:曾无超时(可吊死登录请求);现 10s 超时后按失败处理(可降级)。
6. admin 内部 `/api/oidc/providers/:id/test`:响应从「ok=false → 422」改为恒 200 +
   结构化 ProbeResult(design §7),前端同 PR 适配。
7. 其余路径(discovery 健康 + 完整 OIDC + 未配手动字段)**逐字节等价**。

## 7. 验收标准

- **AC-1 Schema/API**:4 个端点字段 + `trustEmailVerified` + `usernameClaim` +
  `subjectClaim` 可创建 / PATCH / 读取(redacted 输出含新字段);全部可选,不传等价
  于 null/false;旧客户端不带新字段的 create/patch 请求继续可用;端点字段拒绝非
  http(s) 协议 URL,两个字段名选择器拒绝非法字段名(含 `__proto__` 等原型链毒键);
  存在关联身份时 `subjectClaim` 变更被 409 拒绝(身份键命名空间锁)。
- **AC-2 逐字段合并**:discovery 成功 → 其字段优先(逐字段运行时校验,畸形值视为
  缺失)、缺字段用手动补;discovery 失败 → 全用手动;有效集仍缺所需端点时报确定性
  错误码(design §10 失败模式表)。**缓存不得放大故障**:正/负缓存命中都以「登录
  可行」为门,无兜底配置保持现状的每请求重试语义(design §3.2)。
- **AC-3 无 id_token 全链**:token 响应仅有 access_token 时,以 Bearer 调
  userinfoEndpoint,按 D2/D6 提取 claims;login / 自动建号 / 绑定邀请全链可用,
  含一条**路由级 callback 全链测试**(本地假 IdP,断言建号/identity/session/
  重定向;身份关联分支现树不可达,见非目标)。
- **AC-4 有 id_token 不回归**:JWKS 配置可得时验签失败(含 JWKS 拉取失败)仍硬失败,
  不降级;nonce 校验保留;现有 oidc 测试面(oidc-login-chain / oidc-providers-service
  / oidc-redirect-sanitize)全绿。
- **AC-5 D4/D6 矩阵**:id_token 存在 + JWKS 配置不可得 + userinfo 可用 → userinfo
  路径成功;+ userinfo 不可用 → 400 `jwks-unavailable`;subjectClaim 配置 ⇒ 身份源
  恒 userinfo(id_token 即便可验签也不参与,单命名空间锁)。
- **AC-6 trustEmailVerified**:开启后 email 视为已验证(两路径),invite/allowlist
  可放行且 identity.emailVerified 落库为 true;默认关,行为与现状一致。
- **AC-7 诊断与前端**:/test 恒 200 报告 discovery 结果、每字段有效值与来源、
  loginReady 结论(与登录可行性谓词同源:subjectClaim 模式要求 userinfo;jwks 唯一
  通道探测不可达 → not ready);表单新增「手动端点」组(4 URL)、trustEmailVerified
  开关与两个字段名选择器,复用公共表单原语;登录失败页对新错误码有友好文案;
  zh/en i18n 齐全。
- **AC-8 迁移与兼容**:migration 向后兼容(oidc_providers 7 列 + user_identities
  1 列,均可空/带默认);journal `when` 单调递增;upgrade-rolling 计数锁同步 bump
  (107→108);全量后端测试绿。
- **AC-9 身份字段选择器**:
  - usernameClaim:配置后 id_token 与 userinfo 两路径都按该列表拼接取呈现值并驱动
    自动建号的用户名推导;多字段按序空格拼接、缺字段跳过;全缺回落既有推导链;
    留空行为与现状逐字节一致。
  - subjectClaim:配置后 userinfo 路径 subject 取自该字段;字段缺失/类型不符 →
    确定性 400,**不回落**;留空走 sub→id 默认链;id_token 路径不受影响;
    大数(非安全整数)id 拒绝。
  - 两者非法字段名在 create/patch 即被拒。
- **AC-10 呈现名刷新**:usernameClaim 配置的 Provider,登录时拼接值(非空)与身份
  快照不同 → `users.displayName` 刷新且快照同事务更新;快照相同或 IdP 值缺失 →
  displayName 不动;存量身份 null 快照首见只落快照不覆盖;新建身份建号时字段缺失
  (哨兵空串)、IdP 次登出值 → 正常刷新;未配置 usernameClaim 的 Provider 永不刷新
  (回归锁)。
