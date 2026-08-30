# RFC-347 实施计划：Identity Access authority / presence cutover

状态：Done（2026-08-30；T0～T6、AC-1～AC-12、canonical 与 exact-SHA hosted closeout 已完成）

- 开工 source pin：`fdaf22e77db4d592702c5a9c9f44d393d4d0e41a`
- CLI/bootstrap seam：`ef59054c5a15109e42e058d9a3611e656a3a40f1`
- authority / presence 主切换：`15d58e6766ce9abe58e075a99cf91ced9c45f453`
- hosted source repair：`86977b388518ae1f9065f928aed9c14c344e3a69`
- canonical repair payload / permit retirement：`52752cede61291b468eb53f860d63adff407067f` →
  `309db978674c56868988fc3ca9baa86f59a39ba9`
- governance debt retirement：`6a7df29b0201786416c74b1406e2ae1f2b8a5171`
- final functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`
- canonical source digest：`sha256:867b62d0070be085a7a4a36f566134b02248bd80d6212859974343319bdd22ec`
- RFC-owning docs containing parent：`abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9`

## 0. 执行纪律

- D1～D12、生产实现、commit 与 push 已于 2026-08-30 获用户明确批准。
- RFC-344 published exact-SHA Main CI与全部适用 scheduled workflows terminal success后才进入生产切换；该前置已履行。
- 只在现有 shared `main` primary checkout工作；不用 branch/worktree/stash/reset/rebase/alternate index。
- 开工、commit、push前与 push后 fetch并比较 `origin/main...main`；shared index必须为空，publication只 exact-stage owned allowlist。
- RFC-344/345/346/348 owned files不修改、不代交；共享 root/canonical文件均经短 ownership window交接。
- 功能 parity优先；本 RFC无 schema/wire/UI/product capability delta。
- 按用户边界不跑本地 Bun tests/E2E/full gate；只跑静态检查，最终以 published exact-SHA hosted evidence为权威。

## 1. Dependency DAG

```text
T0 source repin + RFC-344 hosted closeout + D1-D12 approval
  -> T1 authority/presence contracts + source guards
      -> T2 explicit runtime root + direct admission cutover
          ├─> T3 delegated schedule/webhook/call cutover
          └─> T4 presence/WS injection cutover
                  \
                   -> T5 facade/public/canonical closeout
                       -> T6 publication + exact-SHA hosted closeout

T3 and T4 may run in parallel after T2.
T5 shared root/canonical work is serialized in a short ownership window.
```

## 2. T0 — Baseline、approval 与 exact source lock

**前置**：RFC-344 published exact-SHA hosted closeout；用户明确批准 proposal D1～D12。

- [x] fetch/sync shared `main`，记录 source SHA、origin SHA、divergence、status与 cached paths；
- [x] 确认 RFC-344 Main CI与全部适用 scheduled workflows对 published exact SHA terminal success；
- [x] 用户明确批准 D1～D12；实现与 commit/push需分别按用户授权执行；
- [x] 重算 direct/delegated/presence/WS public/consumer/facade/edge measurements；
- [x] 锁 credential、schedule/webhook/call、presence/WS、bootstrap/CLI source-pin behavior fixtures；
- [x] 生成 schedule/webhook/call persisted source + invocation/attempt mapping表，证明每个 id的durable/重试语义；
- [x] 对没有 durable attempt的 arm记录 exact non-idempotent command context与 owner；不自行加 schema；
- [x] 建唯一 legacy Actor projection consumer ledger，给每个 entry标 E1/E2/E3/E8/E9/E10/other exact owner；
- [x] 区分 event/intent exclusions与 NULL-owner Q5/manual-resume Q6 compatibility；
- [x] 确认 RFC-344/345/346/348 concurrent paths与 shared root ownership窗口。

**退出门**：source与behavior inventory可复跑；D1～D12已批；RFC-344 hosted前置全绿；仍无生产修改。

## 3. T1 — Additive authority/presence contracts 与 source guards

**前置**：T0。

- [x] 把 direct authority contract收成 opaque `DirectRequestAuthority`；
- [x] direct operation context factory只接受同 runtime factory-minted handle；
- [x] 移除 ordinary public plain-snapshot mint；bootstrap compatibility handoff收窄为 `AuthenticatedAuthoritySnapshot`并由 registry唯一 mint；
- [x] 建 closed delegated invocation variants与 `DelegatedRequestAuthorityFactory`；
- [x] 定义 source/attempt claim、owner-inactive outcome与 legacy projection input；
- [x] 定义 `PresenceConnectionTracker.open(sessionAuthority): PresenceLease`、idempotent release与 query；
- [x] 定义 composition-local event/projection sinks与 WS-owned `IdentityAccessWsBinding`；
- [x] 将 infrastructure provisioning从 public re-export改为 application participant contract；
- [x] source guards锁 domain/public/application无 DB/Hono/WS/legacy Actor/infrastructure import；
- [x] foreign-runtime/plain-object/duplicate-release/invalid-source negative matrix全绿。

**优先 owned files**：`modules/identity-access/{domain,application,public}/**` 与新 RFC-347专项测试。若这些文件有其他 session并发修改，
先协调，不新建第二套合同。

**退出门**：additive contracts可由 fake consumer执行；runtime入口仍未双写；无 route/tool/channel/schema变化。

**回滚**：删除 additive contracts/tests；current runtime保持 source-pin行为。

## 4. T2 — Explicit runtime root 与 direct admission单切

**前置**：T1。

- [x] production改用纯 `createIdentityAccessRuntime(deps)`；删除 module-level DB `WeakMap` cache，旧 compose helper仅留测试 fixture；
- [x] daemon root显式创建一个 runtime，并注入 HTTP/MCP/WS construction；
- [x] CLI/bootstrap root按 D3创建 local/bootstrap participant，不取 daemon ambient singleton；
- [x] session/PAT/daemon admission一次产出 `DirectRequestAuthority`；
- [x] Hono/MCP/WS request state持有同一 handle；删除 route snapshot复制；
- [x] direct context factory不再接受 plain `{ userId, source }`；
- [x] PAT narrowing、purpose、patId、revision、inactive/missing/error parity全绿；
- [x] bootstrap-admin descriptor按 RFC-344 exact contract接入，wire与 first-user-only invariant不变；
- [x] 为未切 downstream caller启用唯一 `LegacyActorProjection`，从同一 claim纯投影、零第二次DB query；
- [x] runtime shutdown明确停止本 generation timers/leases；不冒领 W9 cross-generation timer work；
- [x] 证明 request current resolve exactly once、daemon runtime instance exactly one、CLI instance explicit。

**冲突面**：`auth/{session,actor}.ts`、route authority adapter、daemon/CLI roots、RFC-344 identity/bootstrap descriptors。进入前等待 RFC-344
session完全退出 owned files，并重新 pin current contract。

**退出门**：direct admission新链唯一生效；plain mint与 route copy consumer=0；non-bootstrap compose=0；wire parity全绿。

**回滚**：整条 admission binding切回 source-pin compatibility adapter；禁止 old/new resolver并行。

## 5. T3 — Delegated schedule/webhook/call cutover

**前置**：T2 + T0 attempt mapping。

- [x] schedule adapter用 persisted schedule/occurrence或 exact invocation ref调用 delegated factory；
- [x] automated fire与manual run-now分别锁 cadence state与 operation identity；
- [x] webhook adapter用 current fire/delivery/trigger identity调用 delegated factory；
- [x] call-workflow/workgroup用 task + parent node-run + call kind调用 delegated factory；
- [x] 四条 arm只从 factory结果生成 exact context或一次 legacy projection；不再调用 `buildInheritedActor`；
- [x] owner active/current grants/revision每次执行重读且 exactly once；
- [x] D6 error/skipped/receipt/failure counter/child relation parity全绿；
- [x] NULL owner Q5、literal `__system__`与manual resume Q6有独立 fixture；
- [x] event与 remaining compatibility caller按 E9/committed-consumer exact owner登记；已触及 intent caller透传同一 runtime；
- [x] delegated attempt context已有真实 production consumer；无 durable attempt的 arm未伪造 idempotency；
- [x] `buildInheritedActor` production consumer对E0 arms归零。

**Owned cohorts**：

- T3-A：scheduled task caller/tests；
- T3-B：webhook dispatch caller/tests；
- T3-C：task-execution child call caller/tests。

三者可分别进入短文件窗口，但同一时刻不做 shared Git publication。

**退出门**：三类 delegated arm走唯一 branded authority path；current behavior相等；exclusions有账。

**回滚**：逐 arm整条 binding回切；同一 invocation不得双 resolve/launch/record。

## 6. T4 — Presence lease 与 WS runtime binding cutover

**前置**：T2；可与 T3并行。

- [x] WS root接收 `IdentityAccessWsBinding`，registry/spec不再接 DB compose identity runtime；
- [x] presence channel open取得 session-authority lease；close/error/abort都可幂等 release；
- [x] free-form `opened(userId)` / `closed(userId)` production callers归零；
- [x] PAT/daemon negative fixture证明不贡献 online；
- [x] ack→snapshot、delta、resync只读同一 PresenceQuery；
- [x] IA composition不再 import WS channel/broadcaster/revalidation trigger；
- [x] bootstrap adapters实现 event/projection sinks；无 process-global second root；
- [x] revision event只触发一条 current re-resolution/fence path；
- [x] fresh authority/fingerprint replace与 channel re-evaluation保持 current ordering；
- [x] 4401/4403 close code/reason与connection cleanup parity；
- [x] multi-tab、60s grace、reconnect cancellation、500ms batch、monotonic clock、shutdown fixtures全绿；
- [x] 证明 WS registry compose=0、IA→WS imports=0、每connection lease exactly one。

**冲突面**：IA composition/presence、`ws/{registry,server,connections,revalidationHook}.ts`、daemon root。若 RFC-344或其他 session修改
同一 root/catalog文件，等待短 ownership window，不绕行另造 singleton/hook。

**退出门**：presence/WS source-pin行为相等；old opened/closed与global IA compose/revalidation path不再生效。

**回滚**：整条 WS binding回到 source-pin adapter；禁止同时运行两套 tracker/sink/resolver。

## 7. T5 — Central facade、public 与 canonical closeout

**前置**：T3 + T4。

- [x] 删除 central `buildCurrentActor` / `buildInheritedActor` 与 route snapshot-copy production paths；
- [x] 全仓 legacy Actor只经唯一 pure projection产生；每个 remaining consumer与 field dependency有 exact owner-wave ledger；
- [x] source guard拒绝新 projection consumer、plain mint、user-id cast与第二 module instance；
- [x] 对开工时47个 public symbols逐项重算/classify；zero-consumer executable=0；
- [x] DTO constituent types记录 exported parent；无 parent则删除；
- [x] public→infrastructure provisioning export=0；required ports均有 production composition consumer；
- [x] 对名称含 identity的 facades逐 path/symbol recategorize；不把 resource/skill/injection identity宽归 IA；
- [x] canonical记录 direct/delegated roots、presence/WS sinks、runtime owner、exclusions与 compatibility projection debt；
- [x] architecture write后核对 payload/provenance/denominator/source digest与所有 foreign keys；
- [x] mutation fixtures：plain mint、WS自行compose、IA import WS、第二 projection、generic delegated source、错误 owner-wave任一项必红；
- [x] RFC-294 canonical只领取 W4-E0/N13；E1/E2/E3/E8/E9/E10状态不变。

**退出门**：live source/canonical双向相等；只领取E0 credit；无未登记 central authority/presence debt。

## 8. T6 — Verification、publication 与 hosted closeout

**前置**：T5。

- [x] backend `tsc --noEmit`、exact ESLint/Prettier/diff-check与 `architecture:report`通过；专项/类型/架构门由 Main hosted clean checkout全绿；
- [x] credential、scheduled/webhook/call、bootstrap/CLI、HTTP/MCP/WS parity由 Main backend 8/8与三平台 E2E验证；
- [x] 确认无 schema/migration/route/tool/channel/config/UI delta；
- [x] 按用户边界未运行本地 Bun tests/E2E/full gate；以 final exact SHA的 Main + 8 schedules 9/9 success为权威；
- [x] proposal/design/plan勾选实际完成项并分别记录 source、behavior、canonical、published SHA；
- [x] RFC-294 W4-E0、`design/plan.md`与 `STATE.md`共享 closeout已明确交回协调 session；RFC-owning docs-only commit不 stage三条共享路径；
- [x] publication前 fetch/compare、index-empty、exact-stage allowlist、审查完整 staged path/diff/message/contributors；
- [x] commit/push已获用户“完整实现后提交上库”授权；push前再次同步，push后验证 remote ancestry与 local/remote exact match；
- [x] published exact SHA `7ede76a8` 的 Main CI与全部8个适用 scheduled workflows terminal success；
- [x] hosted失败按 exact job/test/path修复；最终 candidate与 evidence已更新，不以 ancestor/cancelled/retry-only冒充 green；
- [x] canonical与 RFC-owning docs指向同一最终事实；共享 STATE/index投影独立交回，RFC-347只关闭 W4-E0。

**退出门**：remote ancestry成立、local/remote同步、exact-SHA hosted全绿、无未登记E0 debt。

## 9. Acceptance checklist

- [x] AC-1 direct resolve once and shared handle
- [x] AC-2 no plain direct authority/context mint
- [x] AC-3 production delegated schedule/webhook/call consumers
- [x] AC-4 explicit single runtime; no module cache/non-bootstrap compose
- [x] AC-5 WS injected binding; IA↔WS dependency direction closed
- [x] AC-6 RFC-312 presence parity
- [x] AC-7 WS revision/fence/close/order parity
- [x] AC-8 central Actor constructors zero; one exact legacy projection ledger
- [x] AC-9 bootstrap/CLI exact contexts and parity
- [x] AC-10 public/facade/canonical exact closure
- [x] AC-11 zero schema/wire/product delta
- [x] AC-12 publication, ancestry and exact-SHA hosted closeout

## 10. 批准门（已满足）

- [x] 用户授权 current-source 审计与 RFC 草案（2026-08-30，“开始”）。
- [x] 用户明确批准 proposal D1～D12（2026-08-30，“批准”）。
- [x] RFC-344 published exact-SHA hosted closeout terminal success。
- [x] 用户授权生产实现（2026-08-30，“批准实现”）。
- [x] 用户授权 commit/push（2026-08-30，“完整实现后提交上库”）。

以上五项分开记录；草案批准不自动等于实现或发布授权。

## 11. Hosted evidence

最终 functional exact SHA：`7ede76a88649f9c3f5501eef47106631e89f24c1`。RFC-347 source、repair、canonical与 governance
commits均为其祖先；以下9条 clean-checkout workflows全部 `COMPLETED / SUCCESS`：

| Workflow             | Run           |
| -------------------- | ------------- |
| Main CI              | `33317698270` |
| e2e-full-nightly     | `33317736186` |
| e2e-webkit-nightly   | `33317732124` |
| evidence scenarios   | `33317735982` |
| git protocols E2E    | `33317735272` |
| integration OpenCode | `33317735322` |
| maintenance soak     | `33317735048` |
| visual regression    | `33317735095` |
| Windows platform     | `33317734896` |

Main CI backend 8/8、三平台 Playwright与 required rollup全绿；scheduled suites逐条 `headSha`精确匹配，且 `failed=[]` /
`unfinished=[]`。因此 T0～T6与 AC-1～AC-12均已闭合。RFC-347只关闭 RFC-294 W4-E0，不关闭 E1/E2/E3/E8/E9/E10或 W9。

本次 RFC-owning docs-only commit以 `abf484d8b08c9ff64b1ed150e4ca45e49b88d1e9`为 parent，只提交本目录三件套。共享
`STATE.md`、`design/plan.md`与 RFC-294 plan由协调 session在后续独立短临界区完成，不进入本提交。
