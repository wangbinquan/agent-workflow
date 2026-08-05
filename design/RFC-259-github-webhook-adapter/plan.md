# RFC-259 · 任务分解

单 RFC 单 PR（主干直推，一批 commit）。依赖顺序 T1 → T2 → T3 →（T4 ∥ T5 ∥ T6）→ T7。

## T1 — shared 契约层扩枚举

- `packages/shared/src/schemas/webhook.ts`：`CODE_HOST_PROVIDERS = ['gitlab', 'github']`。
- `packages/backend/src/db/schema.ts`：`webhook_endpoints.provider` 的 TS enum 数组 +`'github'`（D1：无 DB 迁移——迁移 0138 该列无 CHECK）。
- 验收：shared 既有 webhook-schema 测试全绿；`CodeHostEventSchema` 接受 `provider:'github'`。

## T2 — adapter 接口 v2 + 路由 provider 化（GitLab 行为零变化）

- 新 `services/webhook/codeHostAdapter.ts`：接口（+`headerAllowlist`/`deliveryIdHeader`/`eventHeader` 头名字段/`summaryKindOf`、`verify` 加 `rawBody: Uint8Array`）、`HeaderBag`、`NormalizeResult`、`CodeHostReportSink`、`replayHeaders`、`CODE_HOST_ADAPTERS` 注册表（design §1）。
- `gitlabAdapter.ts` 适配 v2（新方法就地实现；`objectKindOf` 自 routes 迁入作 `summaryKindOf`）。
- `routes/webhooks.ts`：`readBodyLimited` 返回 bytes+text；HeaderBag 按 allowlist 构造；三处摘要走 adapter 方法；import 改指 `codeHostAdapter.ts`。
- 验收：rfc257-webhook-ingress / rfc257-gitlab-adapter 仅改导入与 verify 形参、**断言零改动**全绿；rfc257-source-locks 绿。

## T3 — GitHub adapter + 单测 + fixtures

- 新 `services/webhook/githubAdapter.ts`：`githubVerify`（HMAC，design §2.1）+ `githubNormalize`（映射表 §2.2，ping 先于 repository 解析）。
- 新 `tests/rfc259-github-adapter.test.ts`（AC-1/2/4/5/6/7/8 的纯函数面全矩阵）。
- 新 `tests/fixtures/github-webhooks/README.md`（proposal §8 五项实测清单 + 采集方法）。

## T4 — ingress 集成测试（github 语义矩阵）

- 新 `tests/rfc259-github-ingress.test.ts`：AC-1/3/9 的 HTTP 层（401 两态落 rejected 行 / 404 provider 同形 / ping 200 ignored / GUID 去重 bump / 三段式 received）。

## T5 — 管理面 + 前端 + i18n

- `rfc257-webhook-management.test.ts` 补 AC-10 两 case（github 创建 / ingressUrl）。
- `WebhookEndpointCard.tsx`：创建 Dialog provider Segmented；列表卡 provider 展示（去硬编码 `<dd>GitLab</dd>`）；per-provider 指引文案。
- i18n zh/en 各两段（interface+const）新键：providerField / GitHub 版 hint、emptyDescription、secretPasteHint、createDescription；事件类型 label「MR / PR」中性化。
- `rfc257-webhook-endpoint-card.test.tsx` 补 AC-11 断言。

## T6 — 文档

- `docs/webhook-triggers.md` 新增「GitHub 接入」节：repo/org webhook 配置步骤（content type application/json + secret 必填 + 事件勾选清单）、公网可达 / 隧道转发（header/body 字节保留要求）、评论指令分支限制（D7'，普通评论默认分支 / 行内评论带分支）、Redeliver 语义、bot PAT 写凭据。

## T7 — e2e + 回归收口

- 新 `tests/rfc259-webhook-github-e2e.test.ts`（AC-13 全链路）。
- 全套门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check`；前端 `bun run --filter @agent-workflow/frontend test`。
- rfc257-* 全绿（AC-12）；棘轮清单核对（design §4 末条）。

## 验收清单（对照 proposal §7）

- [ ] AC-1..8 归一化与验签（T3/T4）
- [ ] AC-9 路由 provider 同形（T4）
- [ ] AC-10 管理面（T5）
- [ ] AC-11 前端（T5）
- [ ] AC-12 GitLab 零回归（T2/T7）
- [ ] AC-13 e2e（T7）
