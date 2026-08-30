# RFC-347 技术设计：Identity Access authority / presence cutover

配套：`proposal.md`（D1～D12）· `plan.md`（实施 DAG）

- 状态：Done（2026-08-30；实现、canonical、AC-1～AC-12 与 exact-SHA hosted closeout 已完成）
- 开工 source pin：`fdaf22e77db4d592702c5a9c9f44d393d4d0e41a`
- CLI/bootstrap seam：`ef59054c5a15109e42e058d9a3611e656a3a40f1`
- authority / presence 主切换：`15d58e6766ce9abe58e075a99cf91ced9c45f453`
- hosted source repair：`86977b388518ae1f9065f928aed9c14c344e3a69`
- final functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`
- canonical source digest：`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`
- RFC-owning docs containing parent：`abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9`

## 1. 设计结论

W4-E0 的目标不是创建更大的“身份服务”，而是把已经存在的 identity-access contracts 变成唯一 runtime truth：

```text
credential admission
  -> IdentityAccessRuntime.directAuthority
  -> opaque DirectRequestAuthority
  -> exact HTTP / MCP / WS binding
  -> DirectOperationContextFactory

persisted schedule/webhook/call invocation
  -> IdentityAccessRuntime.delegatedAuthority
  -> opaque DelegatedRequestAuthority
  -> source-owned command/context

daemon bootstrap
  -> createIdentityAccessRuntime(deps) exactly once
  -> inject HTTP + MCP + WS
```

未进入后续子波的 legacy caller 只能经过一个纯 `LegacyActorProjection`：

```text
opaque current/delegated authority
  -> pure projection, no DB lookup, no mint input
  -> exact ledgered legacy caller
  -> removed by E1/E2/E3/E8/E9/E10
```

## 2. 开工 source-pin inventory 与 exit ledger

### 2.1 开工 measurements

| 指标                                                             | Source pin current |                                                 RFC-347 exit |
| ---------------------------------------------------------------- | -----------------: | -----------------------------------------------------------: |
| `composeIdentityAccess` production symbol hits                   |                 14 |            bootstrap/composition-only；non-bootstrap calls 0 |
| WS registry 内 compose                                           |                  3 |                                                            0 |
| identity-access module-level DB cache                            |        1 `WeakMap` |                                                            0 |
| production `.delegatedContexts` / `fromDurableAttempt` consumers |                  0 |                        schedule/webhook/call exact consumers |
| `auth/actor.ts` production importers                             |                134 | 不承诺全归零；central constructors归零，remaining按 wave入账 |
| identity-access canonical public symbols                         |                 47 |           executable zero-consumer=0；DTO按真实 contract保留 |
| 其中 production reference=0                                      |                 29 |                                  逐 symbol裁决，不按总数删除 |
| canonical IA legacy inbound/outbound edges                       |            26 / 13 |           由 exact consumer/owner ledger取代；只领取E0 delta |
| external-layer debt                                              |                  2 |                                      归零或转交唯一明确 wave |
| schema/migration/route/tool/channel delta                        |                  0 |                                                            0 |

这些数值是 source pin 的审计基线；开工 T0 必须在 RFC-344 final published SHA 重算。若数值漂移，只更新 inventory 与 task
allowlist，不可在未呈批时改变 D1～D12 的模块边界。

### 2.2 开工 owner map

| Current seam                      | Current owner/path                                   | RFC-347裁决                                               |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| credential parsing                | `auth/session.ts`                                    | inbound adapter保留，结果改为 opaque direct authority     |
| current actor construction        | `auth/actor.ts`                                      | central constructor退役；纯 legacy projection限时保留     |
| route authority copy              | `routes/operationAuthority.ts`                       | 删除；transport直接传 factory-minted handle               |
| direct/delegated claim registries | `modules/identity-access/domain/operationContext.ts` | 保留为 instance-owned opaque claims                       |
| DB-keyed module cache             | `modules/identity-access/composition.ts`             | 删除；root显式创建一次                                    |
| presence state/timers             | RFC-312 domain/application/infrastructure            | behavior保持；tracker改接 session authority/lease         |
| WS registry                       | `ws/registry.ts`                                     | 注入 exact `IdentityAccessWsBinding`；禁止自行 compose    |
| WS live connection/fence          | `ws/connections.ts`, revalidation hook               | 保留 mechanism，改由 bootstrap adapter实现 sink/binding   |
| schedule owner rebuild            | `services/scheduledTasks.ts`                         | source-owned adapter消费 delegated factory                |
| webhook owner rebuild             | `services/webhook/webhookDispatch.ts`                | source-owned adapter消费 delegated factory                |
| child call owner rebuild          | task-execution `nodeMechanics.ts`                    | source-owned adapter消费 delegated factory                |
| event owner rebuild               | webhook event arm                                    | W4-E9，不计 RFC-347 exit consumer                         |
| intent dispatcher owner rebuild   | intent dispatcher                                    | committed-consumer owner wave，不计 RFC-347 exit consumer |

## 3. Target module/runtime shape

建议保留现有 feature-first 目录，只调整 public/application/composition责任：

```text
modules/identity-access/
├── domain/
│   ├── operationContext.ts       # opaque claims, no DB/Hono/WS
│   └── presence.ts               # RFC-312 state machine
├── application/
│   ├── directAuthority.ts        # credential-admitted current resolution
│   ├── delegatedAuthority.ts     # persisted owner/source resolution
│   ├── presenceTracker.ts        # session authority -> lease
│   └── ports/
│       ├── identityAccessStore.ts
│       ├── identityAccessEventSink.ts
│       └── presenceProjectionSink.ts
├── public/
│   ├── authority.ts
│   ├── contexts.ts
│   ├── presence.ts
│   ├── queries.ts
│   └── participants.ts
├── infrastructure/
│   ├── sqliteIdentityAccessStore.ts
│   └── monotonicPresenceClock.ts
└── composition.ts                # pure factory, no module cache, no ws import
```

最终文件名可以随 source drift 调整，但以下不变：

- `domain/public/application` 不 import Hono、WS registry、DB client、session row或 legacy Actor；
- `composition.ts` 只组装明确 deps，不保存 process-global module instance；
- runtime singleton ownership在 daemon root，不在 module内部；
- WS broadcaster与 revalidation mechanism实现 application-owned sinks，而不是被 module直接调用；
- public不 re-export infrastructure implementation。

## 4. Authority contracts

### 4.1 Direct authority

概念合同：

```ts
declare const directAuthorityBrand: unique symbol

export interface DirectRequestAuthority {
  readonly [directAuthorityBrand]: 'direct-request-authority-v1'
}

export interface DirectAuthorityAdmission {
  fromSession(credential: AdmittedSessionCredential): Promise<DirectRequestAuthority>
  fromPersonalAccessToken(credential: AdmittedPatCredential): Promise<DirectRequestAuthority>
  fromDaemonToken(credential: AdmittedDaemonCredential): Promise<DirectRequestAuthority>
}

export interface DirectOperationContextFactory {
  command(authority: DirectRequestAuthority, operation: OperationIdentity): CommandContext
  query(authority: DirectRequestAuthority, operation: OperationIdentity): QueryContext
}
```

约束：

- `Admitted*Credential` 由对应 inbound credential adapter铸造，不是 string token或 caller-supplied user id；
- direct authority claim内部可包含 current user、purpose、PAT narrowing、patId、revision等事实，但 public不暴露可复制的完整 snapshot；
- transport只能持有/传递 handle，不能 reconstruct；
- operation context factory必须验证同一 runtime instance的 claim；foreign/plain object失败；-同一 request/channel admission只 resolve一次。后续 WS revision change属于明确 re-resolution，不算重复 request mint。

### 4.2 Direct authority projection

下游 exact operation需要的 user id、purpose或 permission不是通过 public snapshot读取，而是通过 consumer-owned context query/claim
projection获取。过渡期 `LegacyActorProjection` 是唯一例外：

```ts
interface LegacyActorProjection {
  fromDirect(authority: DirectRequestAuthority): LegacyActor
  fromDelegated(authority: DelegatedRequestAuthority): LegacyActor
}
```

它必须满足：

- implementation在 daemon composition/inbound compatibility adapter，不在 domain/public；
- 只读 authority claim，零 DB query；
- 无 `fromUserId` / `fromSnapshot` / public constructor；
- field allowlist固定为 source-pin `Actor` current shape；新增字段或 consumer需要更新 exact debt ledger并呈批；
- 每个 consumer记录 `ownerWave` 与 removal acceptance，不允许 generic facade继续扩散。

### 4.3 Bootstrap与 local contexts

```ts
interface LocalOperatorContextFactory {
  forCommand(command: LocalAdministrationCommand): LocalOperatorContext
}

interface BootstrapAuthorityContextFactory {
  forInitialAdministrator(candidate: BootstrapAdminCandidate): BootstrapAuthorityContext
}
```

这两个 factory只在 composition可见。Bootstrap context只覆盖 first-admin transaction；local operator context只覆盖明确本地命令，
都不转换为 `DirectRequestAuthority`，也不接受任意 HTTP user identity。

## 5. Delegated authority

### 5.1 Closed source set

RFC-347 production cutover只包含：

```ts
type DelegatedInvocation =
  | ScheduledInvocation
  | WebhookInvocation
  | ChildWorkflowInvocation
  | ChildWorkgroupInvocation
```

每个 variant包含 source-specific persisted ref；没有 generic `{ source: string, userId: string }` arm。`event` 与 intent dispatcher保持
legacy projection并登记到 E9/committed-consumer owner，不加入 closed union。

### 5.2 Resolve与 context规则

```ts
interface DelegatedRequestAuthorityFactory {
  resolve(invocation: DelegatedInvocation): Promise<DelegatedAuthorityOutcome>
}

type DelegatedAuthorityOutcome =
  | { readonly kind: 'granted'; readonly authority: DelegatedRequestAuthority }
  | { readonly kind: 'owner-inactive'; readonly ownerUserId: string }
  | { readonly kind: 'compatibility-null-owner' }
```

Factory内部必须在 current read/transaction边界：

1. 以 source-owned persisted ref读取 owner与 invocation identity；
2. 用 identity-access store重读 active/current role+grants/revision；
3. 将 source kind、source id、invocation/attempt ref与 current claim绑定到 opaque authority；
4. consumer从同一 authority生成 exact command/context或一次 legacy projection；
5. 不做第二次 owner lookup，不把 branded ref丢弃后重建 Actor。

### 5.3 Attempt mapping gate

T0 必须生成下表的 live mapping并以测试锁定：

| Arm                      | Candidate current identity                       | 必须证明                                              |
| ------------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| webhook                  | `fireId` + `deliveryId`/trigger id               | retry/replay沿用同一 durable identity，未提前随机重铸 |
| call-workflow            | task + parent `nodeRunId` + call kind            | 与当前 child call row/launch exactly-one对应          |
| call-workgroup           | task + parent `nodeRunId` + call kind            | 与当前 child call row/launch exactly-one对应          |
| scheduled automated fire | schedule id + persisted/deterministic occurrence | retry不碰撞，cadence advance语义不变                  |
| scheduled manual run-now | schedule id + inbound operation identity         | 不修改 `next_run_at` / `last_*` / failure counters    |

Source pin尚未证明 schedule具有独立 durable fire row。因此 RFC-347 不预先承诺新增表：如果 live mapping不能形成 durable attempt，factory
仍可返回 source-bound delegated authority，consumer使用 exact non-idempotent command context；schema/receipt扩张必须另立裁决。

### 5.4 Behavior matrix

| Arm                  | Owner missing/inactive                               | Current grants              | Special behavior                        |
| -------------------- | ---------------------------------------------------- | --------------------------- | --------------------------------------- |
| schedule             | `ValidationError('owner-inactive')`                  | 每次 fire重读               | manual run-now不推进 cadence state      |
| webhook              | current skipped/failed receipt与 `owner-invalid`语义 | 每次 fire重读               | fire/delivery outcome与熔断计数来源不变 |
| call-workflow        | `call-owner-inactive`                                | 每次 child launch重读       | parent node-run/child adoption不变      |
| call-workgroup       | `call-owner-inactive`                                | 每次 child launch重读       | frozen group/child relation不变         |
| NULL call owner      | Q5 compatibility branch                              | 不授予 generic system facts | 只在 current exact call path保留        |
| literal `__system__` | 解析实际 row                                         | actual current grants       | 不等价 NULL compatibility               |
| manual resume Q6     | 既有 bypass                                          | 既有 behavior               | 本 RFC不改变                            |

## 6. Presence contract

### 6.1 Session-only lease

```ts
declare const presenceLeaseBrand: unique symbol

export interface PresenceLease {
  readonly [presenceLeaseBrand]: 'presence-lease-v1'
  release(): void
}

export interface PresenceConnectionTracker {
  open(authority: DirectSessionAuthority): PresenceLease
}

export interface PresenceQuery {
  snapshot(): readonly PresenceView[]
}
```

`DirectSessionAuthority` 是 direct claim的窄 view，只能由 session admission产生。PAT/daemon authority无法传给 `open`。WS adapter每个实际
presence connection获取一个 lease；close/error/abort多个路径都可调用 `release()`，但 store只结算一次。

### 6.2 State/oracle

不改 RFC-312 state machine：

```text
first active lease       -> online immediately
additional lease         -> remains online
last lease release       -> enter 60s grace
new lease during grace   -> cancel offline transition
grace expires            -> offline
state delta              -> batch projection, max 500ms
```

Clock继续 monotonic；wall-clock只用于现有 display projection。Snapshot/resync读取同一个 application state，不从 DB推导 online，也不
增加 polling。

## 7. WS runtime binding

### 7.1 Exact binding

```ts
interface IdentityAccessWsBinding {
  readonly admitCredential: WsCredentialAdmission
  readonly currentAuthority: WsCurrentAuthorityResolver
  readonly fence: WsAuthorityFence
  readonly presence: PresenceConnectionTracker
  readonly presenceQuery: PresenceQuery
}

function buildWebSocketAdapter(input: {
  readonly identityAccess: IdentityAccessWsBinding
  readonly channels: WsChannelRegistry
  readonly connections: WsConnectionMechanism
}): WebSocketAdapter
```

WS registry/spec只能使用 binding，不接收 DB来查 identity-access module。`PRESENCE_CHANNEL`仍可由 WS channel owner定义，但 IA module不
import该 constant；bootstrap通过 adapter把 channel open/close映射为 tracker lease。

### 7.2 Reverse effects

IA application只依赖：

```ts
interface IdentityAccessEventSink {
  authorityRevisionChanged(subject: SubjectRef, revision: number): void
}

interface PresenceProjectionSink {
  publish(delta: readonly PresenceView[]): void
}
```

Daemon bootstrap用现有 connection set/broadcaster实现两个 sink。这样 authority/presence决定留在 IA，连接遍历、channel publish、close
mechanism留在 WS。禁止 process-global callback registration成为第二个 composition root；如果其他 legacy module仍依赖 current
revalidation hook，必须登记 exact owner/deletion wave，不能冒充 RFC-347已全仓归零。

### 7.3 Connection refresh sequence

保持 current顺序：

```text
revision event
  -> select affected live connections
  -> re-resolve current direct authority
  -> replace connection authority/fingerprint atomically
  -> re-evaluate subscribed channels
  -> keep or close with existing code/reason
```

Presence channel：admission ack先完成，再发 current snapshot；随后只接 delta。Resync读同一 `PresenceQuery`。任何实施不得让旧/new
identity runtime同时监听 revision或同时 publish。

## 8. Composition topology

### 8.1 Daemon root

```text
openDb + platform deps
  -> createIdentityAccessRuntime({ store, clock, eventSink, projectionSink })
  -> createHttpApp({ identityAccess, ... })
  -> createMcpServer({ identityAccess, ... })
  -> buildWebSocketAdapter({ identityAccess: identityAccess.wsBinding, ... })
  -> start listeners/workers
```

Root持有唯一 runtime lifetime与 shutdown：presence timers/leases在 shutdown path明确 release/stop。RFC-312 grace/batch timer跨 generation
清理的最终机制仍归 W9，本 RFC只确保单个 daemon generation不靠 module cache泄漏第二实例。

### 8.2 CLI root

需要 current identity data的 local CLI process显式创建一次 runtime/participant；纯 bootstrap admin只创建 bootstrap participant。CLI不
import daemon singleton，也不通过 `composeIdentityAccess(db)`取 ambient instance。

### 8.3 Tests

测试 fixture必须显式：

```ts
const fixture = createIdentityAccessFixture({ clock, store, sinks })
using runtime = fixture.runtime
```

不得依靠 module cache跨 test复用。Fake foreign runtime authority传入另一 runtime factory必须失败，从而锁 instance ownership。

## 9. Public/canonical closeout

T5对每个 current public symbol分类：

| Classification                | Exit action                                               |
| ----------------------------- | --------------------------------------------------------- |
| production-executable         | 必须有 exact production consumer与 owner                  |
| exported DTO root             | 必须有 production contract consumer                       |
| constituent DTO type          | 允许只被 exported DTO引用，但需记录 parent symbol         |
| composition-only participant  | 从 public移到 composition/application participant surface |
| infrastructure implementation | 禁止 public re-export                                     |
| obsolete facade               | 删除并以 source guard锁 consumer=0                        |

Facade/edge recategorization只能按 AST owner/consumer，不按 filename keyword。`identity`表示资源标识、skill path或 injection key时归其事实
owner；只有 account/principal/role/grant/current/delegated authority/presence属于 IA。

Canonical exit需要同时记录：

- direct admission入口与 forbidden plain mint；
- delegated closed arms及 event/intent exclusions；
- daemon/CLI runtime owners；
- IA→WS imports=0、WS registry compose=0；-唯一 legacy projection与每个 remaining consumer的 owner wave；
- exact public symbols、required ports、production consumers与 exceptions。

## 10. Failure、rollback 与 parity

### 10.1 Additive阶段

新 authority contracts/runtime先可由 fake/compatibility adapters消费；现有 ingress不切换。Rollback是删除 additive wiring，不影响 DB/wire。

### 10.2 Cutover阶段

每条入口只允许单切：

- direct：旧 `Actor` mint与新 authority admission不能并行 resolve；
- delegated：同一 invocation不能同时调用 `buildInheritedActor`与新 factory；
- presence：同一 connection不能同时调用 old opened/closed与 new lease；
- WS fence：同一 revision event不能同时走 old global trigger与 new sink。

若 parity失败，整条 binding切回 source-pin adapter；禁止保留两条 effect path。无 schema变化，因此不需要数据 rollback。

### 10.3 Required behavior oracles

- credential：session/PAT/daemon success、inactive/missing、PAT narrowing/purpose/revision；
- direct operation：HTTP/MCP同 handler/context、WS initial/current refresh；
- delegated：D6全部 arm与 error/receipt/order；
- presence：multi-tab、duplicate release、grace reconnect/expire、batch、snapshot/resync、PAT/daemon negative；
- WS：revision refresh、channel removal、4401/4403、ack/snapshot/delta ordering、shutdown cleanup；
- bootstrap/CLI：first-admin invariant、flags/output/exit parity。

## 11. Concurrency/file ownership

- RFC-344 closeout前不改 production；RFC review文件可独立落地但不代交任何并发实现。
- 后续 delegated cohort主要触及 scheduled/webhook/task-execution caller；presence cohort主要触及 IA/WS；二者可在 T1/T2 后并行。
- `server.ts`、WS registry/connections、auth/session/actor、canonical manifests与 shared index属于短 ownership window；进入前重新检查
  worktree/index与其他 session状态。
- shared file若同时含其他 session同任务输出，只能完整保留后按 shared-main规则协调提交；不得移除、暂存或覆盖对方内容。

## 12. 实际落地与机器证据

最终 runtime topology：

```text
session / PAT / daemon admission
  -> one AuthorityClaimRegistry-owned DirectRequestAuthority
  -> HTTP / MCP / WS exact binding
  -> IdentityAccessRuntime.contexts

persisted schedule / webhook / call invocation
  -> IdentityAccessRuntime.delegatedRequests
  -> source-bound DelegatedRequestAuthority
  -> exact command context or the single legacy projection

daemon bootstrap
  -> createIdentityAccessRuntime({ db, events, presenceProjection }) exactly once
  -> createApp + MCP operation binding + WebSocket adapter
  -> shutdown one runtime generation
```

落地结果与 D1～D12逐项一致：

- `AuthorityClaimRegistry`统一 mint、freeze、brand与 register direct/delegated handle；route、legacy projection与 operation context不再
  cast或重包敏感 authority；
- public direct admission只接受 admitted session/PAT/daemon credential；`DirectAuthorityBinding`只为 bootstrap/compatibility projection
  暴露窄 `AuthenticatedAuthoritySnapshot` handoff，ordinary caller不能从 `{ userId, source }` mint authority/context；
- daemon/CLI root显式持有 runtime；旧 DB-keyed module `WeakMap`删除，`composeIdentityAccess(db)`只保留为测试 fixture constructor，
  production WS registry不再 import composition或接 DB自行 compose；
- schedule、webhook、call-workflow与call-workgroup使用 `delegatedRequests`，persisted source与真实 invocation identity绑定；owner/current
  grant/revision与 D6 compatibility outcomes保持；event与其余 successor consumers仍按 exact owner-wave ledger推进；
- presence connection通过 session direct authority取得幂等 lease；WS binding仅见 direct authority、authority fence、presence tracker/query与
  request revalidation，IA module对 `ws/*` import为 0；
- `RuntimeIdentityAccessEventSink`与`RuntimePresenceProjectionSink`为 composition-local ports，public surface只保留有真实 contract consumer
  的 participant/event types；
- initial-user provisioning通过同一 transaction-bound participant执行；actor-present legacy HTTP self/role guard与 actor-absent local CLI
  break-glass边界在 hosted repair中恢复；
- `buildCurrentActor` / `buildInheritedActor` production call归零；单一 direct/delegated legacy projection与 exact successor-wave ledger保留，
  未冒领 E1/E2/E3/E8/E9/E10；
- canonical public/consumer/owner/transaction/cross-context payload在 source repair后重生成；5 个已消费或删除的 zero-consumer debt entries
  与对应 high-water baseline已退役，未用新 exemption或增长许可掩盖债务。

实现期静态验证包括 backend `tsc --noEmit`、exact ESLint/Prettier/diff-check与 `architecture:report`，均通过；未按用户边界运行本地
Bun tests、E2E或 full gate。权威验证来自 final exact SHA `7ede76a88649f9c3f5501eef47106631e89f24c1` 的 clean-checkout hosted
结果：

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

Main CI 的 backend 8/8、三平台 Playwright与 required rollup全绿；八条 scheduled workflows逐条 `headSha`精确匹配，且
`failed=[]` / `unfinished=[]`。Canonical source digest为
`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`。因此 AC-1～AC-12均已闭合，RFC-347只关闭
RFC-294 W4-E0。

RFC-owning docs-only commit以 `abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9`为 parent。共享 `STATE.md`、`design/plan.md`与
RFC-294 plan含并发 hunks，已按 shared-main规则交回协调 session在独立短临界区完成，不进入本提交。
