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
- `auth/oidc/discovery.ts`:改造为宽松 `fetchDiscoveryDocument` + 文档正缓存 +
  10s 超时;**删除** `getProviderMetadata`/`testDiscovery`/`oidc-discovery-incomplete`
  (生产调用方归零,design §3.3);oidc-login-chain discovery describe 4 条锁按
  §3.3 迁移(3 条语义保留 + 1 条被 D1 有意取代并注释)。
- 新 `auth/oidc/endpoints.ts`:`resolveEndpoints`(D1 逐字段合并)+ 负缓存(5min,
  仅 resolver 路径)+ `getJwksInstance`(按 jwksUri 键)+ `clearEndpointCaches`。
- 测试:S3。

## RFC-220-T3 身份层 + 路由接线

- `auth/oidc/tokens.ts`:`id_token` 可选化 + `fetchUserinfo`(raw JSON + 10s 超时)
  + OidcTokenError code 扩四员(design §4;claims 提取不在此,防模块环)。
- 新 `auth/oidc/identity.ts`:`acquireIdentityClaims` 五行矩阵(design §5,含「配置态
  判定/未验签不采信/sub 非空」三不变量)+ `readClaimField` + `composePreferred`
  + `extractUserinfoClaims` + usernameClaim/subjectClaim 语义(D5/D6/D7,design
  §5.2;subject 不回落是对抗性锁)。
- `services/userIdentities.ts`:`preferred_snapshot` 读写 + `syncPreferredSnapshot`
  三态(design §5.3)+ createIdentity 快照初值;callback login/create/bindInvited/
  link 四路径接线(design §6.2)。
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

- [ ] AC-1 Schema/API(T1;S1/S2)
- [ ] AC-2 逐字段合并(T2;S3)
- [ ] AC-3 无 id_token 全链(T3;S5/S6/S8)
- [ ] AC-4 有 id_token 不回归(T2/T3;S4/S6 + 既有 oidc 套件绿)
- [ ] AC-5 D4 矩阵(T3;S6)
- [ ] AC-6 trustEmailVerified(T3;S7)
- [ ] AC-7 诊断与前端(T4;S10)
- [ ] AC-8 迁移与兼容(T1/T5;S9 + 全量套件)
- [ ] AC-9 身份字段选择器(T1/T3/T4;S12/S13)
- [ ] AC-10 呈现名刷新(T1/T3;S14)
