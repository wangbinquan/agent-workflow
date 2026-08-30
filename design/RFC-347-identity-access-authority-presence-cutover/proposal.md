# RFC-347 — Identity Access authority / presence cutover（RFC-294 W4-E0）

- 状态：Done（2026-08-30；D1～D12、T0～T6、AC-1～AC-12、canonical 与 exact-SHA hosted closeout 已完成）
- 开工 source pin：`fdaf22e77db4d592702c5a9c9f44d393d4d0e41a`
- CLI/bootstrap seam：`ef59054c5a15109e42e058d9a3611e656a3a40f1`
- authority / presence 主切换：`15d58e6766ce9abe58e075a99cf91ced9c45f453`
- hosted source repair：`86977b388518ae1f9065f928aed9c14c344e3a69`
- canonical repair payload / permit retirement：`52752cede61291b468eb53f860d63adff407067f` →
  `309db978674c56868988fc3ca9baa86f59a39ba9`
- governance debt retirement：`6a7df29b0201786416c74b1406e2ae1f2b8a5171`
- final functional exact SHA / Main CI：`7ede76a88649f9c3f5501eef47106631e89f24c1` /
  `33317698270`（terminal success）
- canonical source digest：`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`
- RFC-owning docs containing parent：`abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9`
- 归属：只关闭 RFC-294 W4-E0；E1/E2/E3/E8/E9/E10 与 W9 的后续 domain/timer cutover 均不倒签

实施期并发边界（已履行）：RFC-344、RFC-345、RFC-346 与 RFC-348 由各自 owner 落地；RFC-347 按 source、shared root、canonical、
publication 与 docs-only 短临界区分段，完整保留其并发输出。本次 RFC-owning docs-only publication 不修改或 stage `STATE.md`、
`design/plan.md` 与 RFC-294 plan；三份共享投影由协调 session 后续唯一提交。

## 1. 摘要

RFC-305 已建立 opaque `RequestAuthority`、direct/delegated authority contract、role/grant 单写与 access revision；RFC-312 已建立
二态 presence、专用 WS channel、60 秒 grace、500ms batch 与 revision fence。但开工 source pin仍有四段未收口：

- session/PAT/daemon credential 先在 `auth/actor.ts` 重建完整 `Actor`，route 再把普通对象复制成 branded direct authority；
- public direct factory 接受 `{ userId, source }` 普通对象，调用者仍可绕开唯一 admission chain 创建 operation context；
- delegated resolver/context factory 只有测试 consumer，schedule、webhook、call-workflow/call-workgroup 仍调用
  `buildInheritedActor`，解析后又丢弃 delegated ref；
- `composeIdentityAccess(db)` 通过 module-level `WeakMap` 隐式缓存，WS registry 又自行 compose 三次；identity-access
  composition 反向 import WS broadcaster/revalidation hook，使 daemon 内的实际 module lifetime 与依赖方向不可见。

本 RFC 关闭 RFC-294 W4-E0：让 direct/delegated authority 只能由 bootstrap 注入的可信 factory 产生，把 presence/WS 接缝改为
明确 runtime binding，并退役中央 `Actor` 构造 facade 与 ambient module cache。

这不是 134 个 legacy `Actor` consumer 的全仓机械迁移。尚未进入 E1/E2/E3/E8/E9/E10 的 bounded context 可以暂时消费唯一、
有账的 `LegacyActorProjection`；每个后续 wave 必须把该 projection 替换成自己的 exact command/query authority。RFC-347 只领取共同
前置 credit，不冒领六个子波的 domain cutover。

## 2. 开工 source-pin 事实

### 2.1 Direct authority 仍经历两次构造

当前链路是：

```text
credential -> auth/session.resolveActor -> auth/actor.buildCurrentActor
           -> composeIdentityAccess(db).resolveAuthority -> full Actor
           -> Hono actor variable
           -> routes/operationAuthority copies plain snapshot
           -> DirectAuthenticatedAuthorityFactory
           -> DirectOperationContextFactory
```

- `auth/session.ts` 负责 session/PAT/daemon token admission，却只返回 legacy `Actor`；
- `auth/actor.ts` 调 identity-access current authority resolver 后，再拼装完整 user/permissions/purpose/PAT snapshot；
- `routes/operationAuthority.ts` 不是 authority source，只把同一事实复制成第二个对象；
- `AuthenticatedAuthoritySnapshot` 与 `authorityFromAuthenticatedPrincipal({ userId, source, ... })` 是 public plain-data mint seam；
- HTTP/MCP/WS 尚未共同持有同一个 factory-minted direct authority。

### 2.2 Delegated contracts 没有 production consumer

- `DelegatedAuthorityResolver` 与 `DelegatedOperationContextFactory` 已存在并有测试；
- production 对 `.delegatedContexts` / `fromDurableAttempt` 的调用为 0；
- `buildInheritedActor` 会调用 delegated resolver，但随后丢弃返回的 branded ref，再重建 legacy `Actor`；
- 当前 production arms 为 schedule、webhook、event、call-workflow、call-workgroup 与 intent dispatcher；RFC-294 W4-E0 只收
  schedule/webhook/call，event 留 W4-E9，intent 的 committed-consumer cutover 留其 owner wave；
- schedule/webhook/call 当前都在每次执行前重读 owner active 与 current grants。错误/结果形态分别包括 `owner-inactive`、
  webhook `owner-invalid`/skipped receipt、`call-owner-inactive`；NULL call owner 的 Q5 compatibility 与 manual resume Q6
  bypass 也必须保持。

### 2.3 Presence domain 已存在，composition 仍是 ambient

RFC-312 的 production behavior 已包括：

- user online 当且仅当至少一个 session-authenticated `/ws/presence` connection active，或处于最后连接关闭后的 60 秒 grace；
- projection 只有 `online` / `offline`，使用 monotonic clock，最多每 500ms 合并广播；
- PAT/daemon credential 不贡献 online；snapshot 在 ack 后发送，resync 返回 current projection；
- grant/revision 变化触发 WS current-authority 重解析与 fence；失效连接使用既有 close code/ordering 收口。

但 current composition 存在：

- `composeIdentityAccess(db)` 的 module-level `WeakMap<object, IdentityAccessModule>`；
- production 符号命中 14 处，WS registry 自己调用三次；
- identity-access composition 直接 import `PRESENCE_CHANNEL`、presence broadcaster 与 WS revalidation trigger；
- WS global specs 接收 DB，而不是接收 daemon bootstrap 已创建的 exact presence/authority binding。

### 2.4 Public/facade 账本不能用名称启发式替代

- identity-access canonical public surface 当前有 47 个 symbol，其中 29 个没有 production reference；这 29 个同时包含可删除的
  executable facade 与仍被 exported DTO 组合引用的 constituent type，不能按计数整批删除；
- `public/commands.ts` 直接 re-export infrastructure provisioning function；
- `composition/userOperations.ts` 与 legacy `services/users.ts` 互相穿透；
- `auth/actor.ts` 被 134 个 production files import，说明 E0 必须先切断构造入口，再由 E1～E10 按 domain 收缩 consumer；
- canonical 中以 `identity` 命名的 14 个 facade 并不都属于 identity-access，例如 skill identity path、resource identity 与 injection
  identity。RFC-347 必须逐项 recategorize，不能扩大模块边界。

## 3. 目标

1. 建立唯一 direct admission chain：credential resolution 一次产出 factory-minted direct authority，HTTP/MCP/WS 复用同一对象。
2. 建立真实 production delegated authority chain：schedule、webhook、call 从 persisted owner/source/attempt 解析 current authority，
   不再先解析 branded ref 后重建另一套 Actor。
3. 把 identity-access module lifetime 提升到 daemon/CLI composition root；删除 module-level DB cache 与 inbound 内部 compose。
4. 把 presence connection lease、snapshot/resync、WS authority fence 作为窄 application/runtime binding 注入 WS adapter。
5. 退役 central `buildCurrentActor` / `buildInheritedActor` 与 route-level snapshot copy；为尚未 cutover 的子波保留唯一、有账、无二次查询的
   compatibility projection。
6. 收紧 identity-access public exports、required ports、owner/facade ledger，并把名称相似但事实不属于本模块的 entry 归回真实 owner。
7. 保持全部现有 credential、schedule/webhook/call、presence、WS wire/ordering/error 与产品行为。

## 4. 非目标

- 不把 134 个 `auth/actor` importer 一次性改造成 identity-access consumer；E1/E2/E3/E8/E9/E10 各自拥有下游 cutover。
- 不完成 user/OIDC route→DB、token/session/profile 管理的全部物理迁移；W4-B 继续拥有其 route/application cutover。
- 不把 Event Center `event` arm、intent committed consumer、code-host publication 或 background lifecycle 收进 E0。
- 不创建 arbitrary `SystemActor` 或 generic system-operation factory；system effect authority 继续由后续 exact owner wave 处理。
- 不改变 RFC-312 grace/batch 数值，也不在本 RFC重写 timer lifecycle；timer ownership 的跨代清理留 W9。
- 不新增或删除 HTTP route、MCP tool、CLI command、WS channel、schema、migration、配置项、页面或用户能力。
- 不改变 session/PAT/daemon token wire、PAT permission narrowing、purpose、revision、close code 或 error code。
- 不修改、代交或倒签 RFC-344/345/346 的实现与发布状态。

## 5. 批准裁决（已履行）

### D1 — E0 只关闭共同 authority/presence 前置

RFC-347 的完成条件是可信 authority mint、明确 module lifetime、presence/WS injection 与 central Actor construction facade 归零。
它不要求所有 legacy Actor field consumer 归零，也不领取 E1/E2/E3/E8/E9/E10 的 command/query、事实 owner 或数据迁移 credit。

### D2 — Direct authority 在 credential admission 后只铸造一次

session/PAT/daemon credential resolver 调用 identity-access admission service，一次返回 opaque `DirectRequestAuthority`。HTTP、MCP 与 WS
只传递这个 handle；`DirectOperationContextFactory.fromAuthority` 只接受该 handle。删除 public plain snapshot mint，以及 route 中
`Actor -> snapshot -> authority` 的复制链。PAT narrowing、purpose、patId 与 access revision 仍来自同一次 current resolution。

### D3 — Local CLI 与 bootstrap admin 使用不同 exact context

本地 CLI 使用 composition-only `LocalOperatorContextFactory`；first-admin provisioning 使用一次性的 `BootstrapAuthorityContext`，两者都不
伪装成 HTTP user/PAT authority。RFC-344 已预留的 bootstrap-admin operation descriptor 可在 E0 接入，但 method/path/body/result 与
first-user-only invariant 不变；普通 direct factory 不接受 caller-supplied user id。

### D4 — 保留 opaque claim registry，删除 ambient module cache

`RequestAuthority`、direct authority、delegated authority/context 的 per-instance `WeakMap` claim registry 是 opaque handle 的实现，继续
保留。必须删除的是 module-level `WeakMap<Db, IdentityAccessModule>` 与所有 non-bootstrap `composeIdentityAccess(db)`。Daemon bootstrap
只创建一个 instance并注入 HTTP/MCP/WS；每个 local CLI process 显式创建自己的 instance；测试用 fixture 显式持有 lifetime。

### D5 — Delegated factory 绑定 persisted source 与真实 attempt

建立 source-specific `DelegatedRequestAuthorityFactory`，输入只来自已加载的 persisted schedule/webhook/call record 与 current durable
invocation identity；factory 同一次重读 owner active/current grants/revision，返回 branded authority，并可为已有 durable attempt 创建
idempotent request context。不得从 `{ userId }` cast `AuthorizationSubjectRef`，不得在 adapter 内随机伪造 attempt id。

T0 必须先为三条 arm 固定真实 mapping：webhook 复用现有 fire/delivery identity，call 复用 parent node-run/call execution identity；schedule
需区分 automated occurrence 与 manual run-now。若 current schema 对某 arm没有 durable attempt，先保留 non-idempotent exact command
context并登记 owner，不得为满足类型新增虚假 durable 语义；任何 schema 扩张必须另行呈批。

### D6 — Delegated 现有行为逐臂保持

schedule、webhook、call 每次执行仍重读 current owner/account/grants，分别保持 `owner-inactive`、webhook skipped/failed receipt、
`call-owner-inactive`。NULL call owner 的 Q5 compatibility 仍只能走现有 explicit branch；字符串 `__system__` 仍解析真实 system-user row，
不能被泛化成系统权限。Manual resume Q6 bypass 保持。`event` arm 明确转交 E9，不被 RFC-347 completion 计数吞掉。

### D7 — Legacy Actor projection 只能从已铸造 authority 派生

为未完成 E1～E10 cutover 的 caller 保留一个 composition/inbound-owned `LegacyActorProjection`：它只从 branded current/delegated
authority 的已解析事实做纯 projection，不再查询 DB，不接受 plain user id，不持有 mint 能力。每个 consumer 必须进入 exact owner-wave
ledger；新增 consumer 或新增字段依赖均由 architecture guard 判红。

### D8 — Presence 使用 session authority 与 opaque lease

public application surface 改为 `PresenceConnectionTracker.open(sessionAuthority): PresenceLease`。Lease 的 `release()` 幂等且最多结算一次；
caller 不再用 free-form `opened(userId)` / `closed(userId)`。Snapshot/resync 通过 exact query；只有 session authority 能产生 presence lease，
PAT/daemon 继续只可连其它已允许 channel，不贡献 online。

### D9 — WS adapter 接受 exact runtime binding，不接受 DB 自行 compose

Daemon root 向 `buildWebSocketAdapter` 注入一个 `IdentityAccessWsBinding`，包含 credential admission/current re-resolution、authority fence、
presence tracker/query 与 projection sink。WS registry/spec 不 import identity-access composition、不接 DB 来 compose。反向方向由
identity-access 依赖 `IdentityAccessEventSink` / `PresenceProjectionSink` port，bootstrap 把它们接到现有 WS broadcaster/revalidation adapter；
identity-access module 不再 import `ws/*`。

### D10 — RFC-312 与 WS current behavior 是完整 oracle

60s grace、500ms batch、monotonic clock、online/offline 二态、session-only counting、ack→snapshot ordering、resync、fresh actor replacement、
revision fence 与现有 4401/4403 close semantics 全部不变。不得出现双 lease、双 broadcaster、双 resolver 或新旧 module instance 并存。

### D11 — Public/canonical 按 executable consumer 与事实 owner 收口

删除无 production consumer 的 executable factory/facade；DTO constituent type 只有在真实 exported contract引用时保留。Infrastructure
provisioning 不再由 `public/commands.ts` 直出，改成 application participant。所有 facade/edge 使用 exact path+symbol+consumer ledger；
resource/skill/injection 等仅名称相似的 identity entry 归回真实 owner，不计 identity-access cutover credit。

### D12 — 分段实施与 hosted closeout

只有在用户明确批准 D1～D12 且 RFC-344 published exact-SHA hosted closeout 全绿后，才可修改生产代码。T1/T2 建合同与显式 root；
之后 delegated cohort 与 presence/WS cohort 可并行，但 `server.ts`、WS registry、canonical 与 publication 各自使用短 ownership window。
RFC-347 只有在 published exact SHA 的 Main CI 与全部适用 scheduled workflows terminal success后才能标 Done。

## 6. 用户故事

- 作为已登录用户或 PAT caller，我的 request authority 只在 credential admission 时解析一次，HTTP/MCP/WS 对同一次请求使用相同身份事实。
- 作为 schedule/webhook/call 的 owner，我的 active/current grants 每次执行仍重新核对，现有成功、跳过与错误结果不变。
- 作为在线用户，我的 presence 在多标签页、断连 grace、resync 与权限变化时表现完全不变。
- 作为后续 bounded-context 实现者，我能消费 opaque direct/delegated authority，不再依赖完整 Actor，也能从 ledger 找到自己的迁移责任。
- 作为架构维护者，我能从 daemon root 看见 identity-access module 的唯一 lifetime与 WS adapter依赖，不再靠 DB-keyed ambient cache猜测。

## 7. 验收标准

- **AC-1**：session/PAT/daemon direct admission各有 parity fixture；每次请求 current authority resolve exactly once；HTTP/MCP/WS 不再复制
  plain snapshot mint authority。
- **AC-2**：public API 不存在接受 `{ userId, source }` 或普通 snapshot 的 direct authority/context factory；negative type/source fixture
  对任意 caller-supplied user id 必红。
- **AC-3**：schedule、webhook、call-workflow、call-workgroup 有真实 production delegated factory consumer；owner/source/invocation binding
  与 D6 outcomes 全量锁定，event/intent 留有唯一后续 owner。
- **AC-4**：module-level `WeakMap<Db, IdentityAccessModule>` 与 non-bootstrap `composeIdentityAccess(db)` production calls 均为 0；daemon
  HTTP/MCP/WS 共用一个显式 instance。
- **AC-5**：WS registry/spec 对 identity-access composition 与 DB-compose imports 为 0；identity-access 对 `ws/*` production imports 为 0；
  event/presence ports只在 bootstrap binding。
- **AC-6**：presence multi-tab、idempotent release、60s grace、500ms batch、monotonic clock、session-only、snapshot/resync 全部 RFC-312
  behavior oracle相等。
- **AC-7**：WS credential refresh、revision fence、fresh authority replacement、channel re-evaluation、4401/4403 close 与消息 ordering
  oracle相等，且不存在 double resolver/broadcast/close。
- **AC-8**：`buildCurrentActor`、`buildInheritedActor` 与 route snapshot-copy 作为 central construction facade 的 production consumers 为 0；
  remaining legacy Actor projections只有一个 factory和 exact E1～E10 consumer ledger。
- **AC-9**：bootstrap-admin 与 local CLI context不构造 ordinary user authority；first-admin与既有 CLI flags/output/exit behavior不变。
- **AC-10**：identity-access public infrastructure re-export 为 0；zero-consumer executable symbols 为 0；保留 DTO types均有 exported
  contract consumer；名称相似的非 IA facade不被误迁移。
- **AC-11**：无 route/tool/channel/schema/migration/config/UI 增删；session/PAT/daemon、schedule/webhook/call、presence/WS 成功与失败 wire
  全量 parity。
- **AC-12**：RFC-344 前置、shared-main publication、remote ancestry、published exact-SHA Main CI 与适用 scheduled workflows 全部有终态
  evidence；文档/index/STATE/canonical 指向同一事实后才可标 RFC-347 Done，并且只关闭 W4-E0。

## 8. 能力影响

本 RFC 是内部 authority 与 composition cutover，不增加、删除或收缩用户能力：

- credential 类型、route/tool/channel 与 access result不变；
- schedule/webhook/call owner语义与结果不变；
- presence、WS refresh/fence/close behavior不变；
- first-admin与 local CLI 产品面不变；
- compatibility projection 只改变内部来源，不改变当前 caller看到的 Actor字段。

## 9. 批准记录

- 2026-08-30：用户指示“开始”；据此授权 current-source 审计与 RFC 草案，不视为 D1～D12、生产实现、commit 或 push 授权。
- 2026-08-30：用户明确回复“批准”；据此批准 D1～D12。
- 2026-08-30：用户进一步明确“批准实现，完整实现后提交上库”；据此授权 T0～T6、commit 与 push。
- RFC-344 前置已由 functional exact SHA `c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68` 的 Main CI 与 8 个
  scheduled workflows terminal success满足；其 own docs亦已发布。
- RFC-347 实施、修复、canonical 与 exact-SHA hosted closeout均已完成；能力边界仍严格限定为 W4-E0。

## 10. 实际落地与 hosted closeout

最终 production topology 与 D1～D12 一致：

- daemon与 local CLI composition root显式创建 identity-access runtime；module-level DB cache删除，production WS registry不再自行
  compose identity-access；
- session/PAT/daemon admission铸造 registry-owned opaque direct authority，HTTP/MCP/WS传递同一 handle；
  `AuthorityClaimRegistry` 是 direct/delegated authority freeze、brand、claim registration 的唯一 owner；
- schedule、webhook、call-workflow与call-workgroup消费 persisted source-bound delegated factory；owner active、current grants、revision、
  NULL-owner Q5、literal `__system__`与 manual-resume Q6 parity保持；
- presence以 session authority打开 opaque、幂等 lease；WS只消费注入的 direct authority、authority fence、presence tracker/query binding；
  60 秒 grace、500ms batch、snapshot/resync、4401/4403 与 ordering oracle保持；
- central `buildCurrentActor` / `buildInheritedActor` production consumers归零；剩余 legacy字段只由单一 projection产生并进入 exact
  successor-wave ledger；
- composition-only event/projection sinks与零 consumer public symbols已内部化；transaction-bound initial-user participant、public surface、
  consumer/owner ledger与 canonical provenance一并收口，未扩 architecture debt。

最终功能候选为 `7ede76a88649f9c3f5501eef47106631e89f24c1`；RFC-347 source、repair、canonical与 governance commits均为其祖先。
九条 clean-checkout hosted workflows全部 `COMPLETED / SUCCESS`：

| Workflow             | Run           | 结果                  |
| -------------------- | ------------- | --------------------- |
| Main CI              | `33317698270` | `COMPLETED / SUCCESS` |
| e2e-full-nightly     | `33317736186` | `COMPLETED / SUCCESS` |
| e2e-webkit-nightly   | `33317732124` | `COMPLETED / SUCCESS` |
| evidence scenarios   | `33317735982` | `COMPLETED / SUCCESS` |
| git protocols E2E    | `33317735272` | `COMPLETED / SUCCESS` |
| integration OpenCode | `33317735322` | `COMPLETED / SUCCESS` |
| maintenance soak     | `33317735048` | `COMPLETED / SUCCESS` |
| visual regression    | `33317735095` | `COMPLETED / SUCCESS` |
| Windows platform     | `33317734896` | `COMPLETED / SUCCESS` |

Main CI 的 backend 8/8、三平台 Playwright与 required rollup全绿；8 个 scheduled workflows逐条 `headSha`精确匹配，且
`failed=[]` / `unfinished=[]`。因此 AC-1～AC-12均已闭合；RFC-347只关闭 RFC-294 W4-E0，不关闭其余 W4 子波或 W9。

本次 RFC-owning docs-only commit以 RFC-346 docs successor
`abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9` 为 parent。含并发 RFC-347/348 hunks 的 `STATE.md`、`design/plan.md`与 RFC-294
plan由协调 session在独立短临界区完成共享 closeout，不进入本提交。
