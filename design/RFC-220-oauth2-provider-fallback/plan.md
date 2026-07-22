# RFC-220 任务分解

依赖顺序:T1 → T2 → T3 → T4 → T5(T2 与 T1 后半可并行,但同 session 内顺序执行即可)。

## RFC-220-T1 存储层:schema + migration + service

- shared `schemas/oidcProvider.ts`:`HttpUrlSchema` + 4 端点字段 + `trustEmailVerified`
  + `usernameClaim`(D5+D7 列表形,`ClaimNameListSchema`)/`subjectClaim`(D6,
  `ClaimNameSchema`),毒键黑名单共用(输出 schema 必填,create/patch 可选,见
  design §2.1)。
- `db/schema.ts`:oidc_providers 7 新列 + user_identities `preferred_snapshot`
  (D7);migration `0108_rfc220_oauth2_manual_endpoints`(共 8 条 ALTER +
  `--> statement-breakpoint`;journal `when=1786723200000`;编号以落地当天 journal
  尾部为准,被并发占号则顺延并回改本文)。
- `upgrade-rolling.test.ts` journal 计数锁 bump(107→108,design §2.2)。
- `services/oidcProviders.ts`:materialize / create / patch / redacted 接新字段。
- 测试:S1 / S2(roundtrip 部分)/ S9。

## RFC-220-T2 解析层:discovery 最小改动 + endpoints.ts

- 前置:全量盘 oidc 符号测试锁
  (`grep -rn 'getProviderMetadata|testDiscovery|exchangeCodeForTokens|verifyIdToken' packages/backend/tests`)。
- `auth/oidc/discovery.ts`:改造为宽松纯 fetch `fetchDiscoveryDocument` + 10s 超时
  (**无缓存**,五轮 P2);**删除** `getProviderMetadata`/`testDiscovery`/
  `oidc-discovery-incomplete`(生产调用方归零,design §3.3);oidc-login-chain
  discovery describe 4 条锁按 §3.3 迁移(3 条语义保留 + 1 条被 D1 有意取代并注释)。
- 新 `auth/oidc/endpoints.ts`:`resolveEndpoints`(D1 逐字段合并 + `forceFresh`)+
  两级缓存(1h 正 + 5min 负,`loginViable` 条件命中、单键覆盖,design §3.2)+
  `getJwksInstance`(按 jwksUri 键)+ `clearEndpointCaches`。
- 测试:S3。

## RFC-220-T3 身份层 + 路由接线

- `auth/oidc/tokens.ts`:`id_token` 可选化 + `fetchUserinfo`(raw JSON + 10s 超时)
  + OidcTokenError code 扩四员(design §4;claims 提取不在此,防模块环)。
- 新 `auth/oidc/identity.ts`:`acquireIdentityClaims` 五行矩阵(design §5,含「配置态
  判定/未验签不采信/sub 非空」三不变量)+ `readClaimField` + `composePreferred`
  + `extractUserinfoClaims` + usernameClaim/subjectClaim 语义(D5/D6/D7,design
  §5.2;subject 不回落是对抗性锁)。
- `services/userIdentities.ts`:`preferred_snapshot` 读写 + `syncPreferredSnapshot`
  (design §5.3 哨兵语义,displayName/快照/updatedAt 同事务)+ createIdentity 快照
  初值;callback login/create/bindInvited 三路径接线(link 分支现树不可达,
  design §5.3;快照落在 createIdentity 共用点,未来接通即生效)。
- `services/oidc/provisioning.ts`:`applyEmailTrust`。
- `routes/oidc-auth.ts`:start/callback 改接 `resolveEndpoints` + `acquireIdentityClaims`
  + OidcTokenError 塌码纠偏(design §6)。
- `util/oidcResponse.ts`:新 friendly 码四条。
- 测试:S4 / S5 / S6 / S7 / S8 / S11 / S12 / S13 / S14。

## RFC-220-T4 诊断 + 前端

- `services/oidcProviders.ts`:`testDiscovery` → `probe(provider)`(ProbeResult,
  绕负缓存);`routes/oidc.ts` /test 换新 shape(design §7)。
- `frontend/routes/settings.tsx`:手动端点 fieldset + trustEmailVerified Switch +
  usernameClaim/subjectClaim 双输入(Behavior 组,cols-2)+ ProbeResult 展示
  (恒 200,含 jwks 唯一通道可达性判定)+ `OidcProviderRow`/`OidcTestResult` 类型;
  i18n zh/en 全 key;空串→null 归一。
- 视觉自查(与 /settings 其它 tab 对齐;复用公共原语零新 chrome)。
- 测试:S2(probe 锁迁移)/ S10。

## RFC-220-T6 D8 userinfo 请求方式(交付后追加,2026-07-22)

- shared `UserinfoRequestStyleSchema` + Provider 字段;migration 0109
  (`userinfo_request_style` NOT NULL DEFAULT 'get_bearer');upgrade-rolling
  108→109。
- tokens.fetchUserinfo 双风格(post_json:POST/JSON 三成员/无鉴权头)+
  identity/callback 透传 provider.scopes。
- 前端手动端点组 `<Segmented>` 两选项 + i18n;shared fixture 补字段。
- 测试:S5 扩 POST 断言(方法/头/三成员精确)、S1/S2 枚举 roundtrip、S9 0109 列、
  S8 假 IdP 仅收 POST 的全链、前端 segmented 默认/切换/回填。
- (D9)fetchUserinfo 识别 200 错误对象(非空 error/非零 errorCode → fetch-failed
  携带 IdP 错误串;零值成功包装不误伤),S5 双向锁。

## RFC-220-T5 收尾

- `bun run typecheck && bun run lint && bun run test && bun run format:check` +
  `bun run build:binary`(模块环兜底);frontend vitest;e2e 关注面确认(design §11)。
- grep `e2e/` 确认无 provider 字段 wire 引用残留。
- `design/plan.md` RFC 索引置 Done + `STATE.md` 登记;push 后按 sha 查 CI。
- Codex 实现门 review(设计门已在落档时跑)。

## PR 拆分

默认**单 PR**(commit 按 T1-T4 分段,前缀 `feat(backend|frontend): RFC-220 ...`)。
如并发树冲突显著,可拆 PR-1(T1-T3 后端)/ PR-2(T4 前端+probe),plan 不变。

## 验收清单(对照 proposal §7)

- [x] AC-1 Schema/API(T1;S1/S2——`a38fa0e1`,变更锁三形 + 等值放行)
- [x] AC-2 逐字段合并(T2;S3——`1e23a141`,含缓存条件命中/负缓存通道门槛)
- [x] AC-3 无 id_token 全链(T3;S5/S6/S8——`106de2ff`,本地假 IdP 路由级全链)
- [x] AC-4 有 id_token 不回归(T2/T3;S4/S6 + oidc-login-chain 迁移后全绿)
- [x] AC-5 D4/D6 矩阵(T3;S6 五行 + 模式开关单命名空间锁)
- [x] AC-6 trustEmailVerified(T3;S7 四象限 + 存量双向同步)
- [x] AC-7 诊断与前端(T4;S2-probe/S10——`7e30b6dc`,恒 200 ProbeResult)
- [x] AC-8 迁移与兼容(T1/T5;S9 两表 8 列逐列断言 + 全量后端套件)
- [x] AC-9 身份字段选择器(T1/T3/T4;S12/S13,大数拒绝 + 同值异型语义锁)
- [x] AC-10 呈现名刷新(T1/T3;S14 三态/哨兵/存量保护/dbTxSync 原子)
- [x] AC-11 userinfo 请求方式 D8(T6;S1/S2/S5/S8/S9/S10 扩)

## 交付记录(2026-07-22)

`a38fa0e1` T1 存储层 → `1e23a141` T2 解析层 → `106de2ff` T3 身份层+路由 →
`7e30b6dc` T4 诊断+前端 → `c11b930f` T5 格式批。测试:backend rfc220 五件
(schema-service 11 / endpoint-resolution 13 / identity-acquisition 27 /
presented-name-sync 13 / probe 5 / callback-route 5)+ oidc-login-chain 迁移
(20)+ frontend rfc220 表单 4;全量门槛 typecheck/lint/format/build:binary 绿。
T2 的严格 discovery 入口删除按「逐提交绿」原则实际分两步落地(getProviderMetadata
在 T3、testDiscovery 在 T4),与 plan 的 T2 归属差异仅为提交边界,终态一致。
