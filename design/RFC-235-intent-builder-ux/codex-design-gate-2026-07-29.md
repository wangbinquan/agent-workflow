# RFC-235 Codex 设计门记录（2026-07-29）

## 1. Gate 输入

- snapshot base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- isolated snapshot：`23deebe114823034d9c102dbdddd610a159911e4`
- 范围：RFC-235 `proposal.md`、`design.md`、`plan.md`、本地 preflight、RFC-234 与当前
  frontend/backend/shared source/tests
- 模式：外部 Codex `exec --ephemeral --sandbox read-only`；隔离工作树在结束后为 clean
- 首轮结论：`NEEDS_REVISION — P0=0, P1=8, P2=3`

本文件保存首轮 source-backed gate 的 finding 与 RFC-235 的处理状态。Finding 在修订后不会
删除；每项的 Resolution 用于说明合同如何闭合，第二至第四轮复审结果追加在 §4–§6。

## 2. Findings

### P1-1 — `gap`：异步 generation 启动失败没有持久结果

失败序列：`create/message/answers` 已持久化 user turn 并返回 201/202；随后 runtime 解析失败，
或 generation budget 在 agent `running` turn 创建前耗尽；`fireTurn()` 只记日志。详情页只能
看到孤立 user turn，10 秒后的 Retry 仍重复同一个不可见失败。

证据：

- `packages/backend/src/routes/intentSessions.ts:108-143,157-168,259-288,344-354`
- `packages/backend/src/services/intent/turnEngine.ts:152-199,603-635`
- `packages/backend/tests/rfc234-intent-routes.test.ts:94-107,135-186`

要求：增加 durable launch-failure settlement，在 expected `turnSeq/contextRevision` 下落 terminal
`error` turn，保留结构化 code 并广播 finished/session update；覆盖 runtime-resolution、budget
和 response-loss。

Resolution：已折入 `design.md` §0.3：generation-starting transaction 先持久化 reserved
running/terminal turn，config/runtime/budget 失败原位 settle；`plan.md` T2.1–T2.9 覆盖实现与
pre-mint/boot/response-loss 回归。待第二轮门禁验证。

### P1-2 — `defect`：questions/answers/mount approvals 缺少服务端 source-turn fence

失败序列：Tab A 显示 turn T2 的 questions；Tab B 发送新 message 并完成 T3/T4；Tab A 随后
提交旧答案。request 没有 `sourceTurnId/expectedTurnSeq`，旧答案会成为新 user turn并触发错误
上下文上的 generation。Mount approval 同理；当前 route 逐项 mount 后才写 audit turn，途中
失败会留下无对应裁决记录的部分 mounts。

证据：

- `packages/shared/src/schemas/intentSession.ts:40-72`
- `packages/backend/src/routes/intentSessions.ts:275-310`
- `packages/backend/src/services/intent/session.ts:213-253`
- `packages/frontend/tests/intent-detail-inline.test.tsx:193-195`

要求：answers 和 mount approvals 携 `sourceTurnId + expectedTurnSeq`；服务端在同一 transaction
验证 source 仍是当前可答/可审批 agent turn且之后没有 cycle-advancing turn。Mount batch 需要
durable batch/decision id 与原子或逐项 receipt 合同，并持久化 source id。

Resolution：已折入 `design.md` §0.4/§5.2–5.3：answers/approvals 使用
`sourceTurnId/expectedTurnSeq/clientMutationId`，approval batch fresh ACL/name recheck并原子写
receipt；`plan.md` T3/T7 覆盖迟到/跨 tab/rollback。待第二轮门禁验证。

### P1-3 — `defect`：非幂等写的 marker 不是 attempt 身份

失败序列：Tab A、B 都以 `turnSeq=10` 为 baseline。A 的请求未到达但收到 transport error；
B 独立发送相同文本并落为 seq 11。仅凭更高 seq 和相同文本会把 B 的副作用误采纳为 A。
同理，更高 agent turn 或 `contextRevision` 变化不能证明 retry/rebase 是本 attempt。

证据：

- `packages/shared/src/schemas/intentSession.ts:35-38`
- `packages/backend/src/services/intent/session.ts:224-252,311-320,350-359,382-387`

要求：若要精确 reconciliation，相关 endpoint 增加 `clientMutationId/expectedSeq` 与唯一
receipt/journal；否则 UI 只能显示 effect-equivalent candidate/outcome unknown，不能自动清输入。

Resolution：已折入 `proposal.md` D13 与 `design.md` §0.3/§10：高风险 generation动作使用
durable id/hash receipt；manual mount/rebase/cancel使用 exact OCC/turn fence且 UI 只描述目标
状态，不认领 effect-equivalent marker。待第二轮门禁验证。

### P1-4 — `defect`：Commit wizard 只在 Apply 时冻结，可能提交未复核的新 draft

失败序列：用户打开 D1 wizard 并填写 secret；另一 tab 生成 D2。WS refetch 后 route 把 D2
的 identity/slots 传入仍打开的 Dialog，本地 decisions/secrets 未清。点击 Apply 时才从 live
props 建 request，可能用 D1 的决定提交 D2，并绕过 `intent-draft-superseded`。

证据：

- `packages/frontend/src/routes/intent.detail.tsx:384-453`
- `packages/backend/src/services/intent/resolveChangeset.ts:192-250`
- `packages/backend/src/services/intent/applyChangeset.ts:302-335`
- `packages/backend/tests/rfc234-resolve-bundle.test.ts:131-140`
- `packages/backend/tests/rfc234-apply-changeset.test.ts:587-610`

要求：Dialog 打开时 pin `{draftId,revision,draftHash,ops,slots}`；draft identity 变化立即锁定、
擦除 secret、关闭 wizard并要求重新复核。最终 request 只能来自 pinned snapshot。

Resolution：已折入 `design.md` §7.1/§7.4：route 在打开时建立
`PinnedIntentDraft`，live identity变化立即 lock/erase/close；最终 request只读 pinned snapshot。
`plan.md` T8.4/T8.9 指定相同 slot id 的 D1→D2回归。待第二轮门禁验证。

### P1-5 — `gap`：apply journal 无法被权威排序、关联和跨 tab 投影

失败序列：Tab B claim 后处于 `prepared/applying`，服务端不发 WS；Tab A 仍显示
`review-ready`。失败也没有 event。refetch 后 UI 只能以墙钟和 journal id 猜最新记录与当前
draft 关联；DTO 隐藏 DB 已有的 `draftId/draftHash/clientMutationId/updatedAt`，查询无
`ORDER BY`。

证据：

- `packages/backend/src/routes/intentSessions.ts:223-237`
- `packages/shared/src/schemas/intentSession.ts:219-227`
- `packages/backend/src/db/schema.ts:2517-2532`
- `packages/backend/src/services/intent/applyChangeset.ts:271,336-350`
- `packages/shared/src/schemas/ws.ts:415-443`
- `packages/frontend/src/hooks/useIntentSessionsWs.ts:12-27`
- `packages/frontend/src/routes/intent.detail.tsx:53-57`

要求：服务端明确排序并提供单调 attempt identity；DTO 暴露安全的 draft/attempt identity 和
`updatedAt`；prepared/applying/failed 也要触发 invalidation，或定义持续 polling 合同。

Resolution：已折入 `design.md` §0.5/§3/§6.3：单调 attemptSeq、explicit order、safe
draft/client identity、errorCode/updatedAt、apply WS invalidation与 unsettled poll；
`plan.md` T4 全面覆盖。待第二轮门禁验证。

### P1-6 — `defect`：archive 可穿过 unsettled apply，final transaction 不复验 active

失败序列：commit 已 claim 为 prepared；另一 tab archive 成功。最终 apply transaction 只复验
epoch/current draft/inFlight，不检查 `status==='active'`，因此资源与 receipt 仍可能落入已归档
会话。

证据：

- `packages/backend/src/services/intent/session.ts:179-201,391-409`
- `packages/backend/src/services/intent/applyChangeset.ts:701-721,819-840`
- `packages/backend/tests/rfc234-intent-routes.test.ts:135-348`

要求：archive/reopen 在 transaction 内调用 `assertNoUnsettledApply`；final apply 同时 CAS
`status==='active'`；覆盖 prepared→archive、archive→final-tx、reopen interleaving。

Resolution：已折入 `design.md` §0.5：status mutation在 fresh transaction 内调用
`assertNoUnsettledApply`，final apply检查 active并 conditional CAS；`plan.md` T3.5–T3.7 覆盖
全部 interleaving。待第二轮门禁验证。

### P1-7 — `defect`：`IntentMountDialog` 无法实现统一 gate 和部分成功恢复

失败序列：manual mount 选择两项；第一项成功、第二项结果不确定。组件保留完整 ids，普通
Retry 先重发第一项并得到 `intent-mount-exists`。Dialog 打开后即使会话进入
generation/apply-in-flight，submit 仍只受本地 `busy/ids.length` 控制。

证据：

- `packages/frontend/src/components/IntentMountDialog.tsx:39-47,63-80,98-104`
- `packages/frontend/tests/intent-detail-inline.test.tsx:222-255`

要求：把 `IntentMountDialog` 纳入修改范围；mutation orchestration 上移至 route/父组件，或
加入统一 gate、逐项 attempt 状态和 reconcile callback。按 concrete type/id 裁掉已生效项。

Resolution：已折入 `design.md` §5.4/§9：明确修改 `IntentMountDialog`，限单项选择、mutation
上移 parent、消费统一 gate与 expected revision；`plan.md` T7.7–T7.9 覆盖 response loss和
cross-tab gate。待第二轮门禁验证。

### P1-8 — `gap`：secret frozen request 与 MutationCache/navigation 生命周期冲突

失败序列：常规 `commit.mutate(request)` 会把含 secret 的 request 存成 TanStack mutation
variables，而 RFC 同时禁止其进入 cache。Dialog 的 dismiss lock 也不能阻止浏览器 Back、route
navigation 或 refresh；outcome-unknown 时卸载会丢失 exact request/clientMutationId。

证据：

- `packages/frontend/package.json:15-23`
- `packages/frontend/src/lib/query-client.ts:31-50`
- `packages/frontend/src/components/Dialog.tsx:138-158,248-296`
- `packages/frontend/src/components/split/UnsavedChangesGuard.tsx:52-79`
- `packages/frontend/tests/intent-detail-inline.test.tsx:257-287`

要求：secret request 只存在组件私有 reducer/ref；mutation variables 只能是无敏感 token/void；
定义 settle/unmount/draft-change 擦除。详情页接入 navigation/beforeunload guard，覆盖 cache、
storage、URL、log/error、Back、refresh、close/reopen。

Resolution：已折入 `design.md` §7.4：secret request仅在 private ref，以 direct API submit
绕开 MutationCache；storage只存无 decisions的 locator；详情接共享 navigation/beforeunload
guard并定义集中 erase。`plan.md` T8.6–T8.9 含 sentinel negative tests。待第二轮门禁验证。

### P2-1 — `gap`：只解析嵌套 content/changeset，HTTP DTO 仍 unchecked

失败序列：旧或损坏 daemon 返回错误的 `session/status/commits/currentDraft` shape；
`api.get<T>` 直接 cast。nested safeParse 尚未执行，journey/gate 就可能崩溃或误显示操作。

证据：

- `packages/frontend/src/api/client.ts:221-243`
- `packages/frontend/src/routes/intent.detail.tsx:53-57`
- `packages/frontend/src/routes/intent.tsx:66-73`
- `packages/shared/src/schemas/intentSession.ts:96-228`

要求：Intent list/detail/create response 先经 shared response schema safeParse，失败时 fail
closed、不建 journey/gate、不显示 raw payload。

Resolution：已折入 `design.md` §0.6：`lib/intent-api.ts` 对所有 Intent response从 unknown
执行 shared schema safeParse，失败不建 journey/gate/controls且不暴露 raw payload；
`plan.md` T5.1/T5.7/T6.8覆盖。待第二轮门禁验证。

### P2-2 — `defect`：Mounted context 以 opaque handle 为主，无法确认资源身份

失败序列：挂载两个同名 Agent 或从 modify entry 进入；context strip 只显示
`agent · res#agent#1`，用户无法确认 name/owner 或安全判断 unmount 目标。

证据：

- `packages/shared/src/schemas/intentSession.ts:206-216`
- `packages/backend/src/routes/intentSessions.ts:238-245`
- `packages/frontend/src/components/ResourcePicker.tsx:66-112`
- `e2e/intent-builder.spec.ts:108-115`

要求：以 actor-safe name/type/owner 为主标签，handle 只作技术次级信息；不可解析时安全
fallback。若现有列表不能稳定覆盖，扩 actor-safe mount DTO。

Resolution：已折入 `proposal.md` D18 与 `design.md` §0.6/§5.4：mount DTO增加 actor-safe
name/owner display，UI以 name/type/full owner为主且长 identity可换行，handle仅次级；
missing/invisible安全 fallback。待第二轮门禁验证。

### P2-3 — `gap`：plan 依赖图与真实依赖、并发测试不一致

问题：T2.8 需要 T1.6，T4.2 需要 T1.5，T5.5/T5.11 需要 T1.6，T7.8 需要 T1.5，但 plan
未声明；测试也缺少 pre-mint failure、source-turn TOCTOU、archive/apply、wizard draft swap、
manual mount partial、journal cross-tab 和 secret navigation/cache。

要求：修正依赖图；新增 shared/backend/DOM/E2E tasks 与全部并发回归；移除“零 backend/shared/
schema/API diff”验收项。

Resolution：`plan.md` 已按 T1 shared/migration → T2–T4 backend → T5 frontend contracts →
T6–T8 UI → T9/T10 gates重写，并显式列出全部 finding回归与交叉依赖；移除了零 backend/shared
验收。待第二轮门禁验证。

## 3. 首轮 Coverage note

| 风险面                                          | 首轮结论                                                     |
| ----------------------------------------------- | ------------------------------------------------------------ |
| 首次创建、持续调整、当前行动与恢复              | P1-1、P1-3：pre-mint failure 无终态，marker 不能证明 attempt |
| turn/draft/commit/inFlight/archived 优先级      | P1-2、P1-4、P1-5、P1-6                                       |
| owner/admin audit/archived 与统一 mutation gate | 基础推导可用，但 P1-6、P1-7、P2-1 未闭合                     |
| single/multi、mount candidate、部分成功         | choice 方向可行；source fence 与部分成功恢复未闭合           |
| response loss                                   | P1-2、P1-3、P1-7                                             |
| commit freeze、exact replay、secret 生命周期    | P1-4、P1-5、P1-8                                             |
| stale/baseline-stale/superseded                 | 基本分型可用；open wizard draft swap 未闭合                  |
| unknown DTO、名称与 route params                | P2-1、P2-2                                                   |
| a11y、响应式与视觉矩阵                          | 基础组件方向可行；navigation guard 和 mount dialog 未闭合    |
| 任务依赖、测试、范围                            | P2-3；必须加入 backend/shared/WS 合同变化                    |

## 4. 复审记录

### 4.1 第二轮隔离门禁

- snapshot：`f7a87466c9d1d4226da32ec5149580d086065415`
- 隔离目录：`/private/tmp/rfc235-design-gate-v2.BDZ1dE/repo`
- 模式：external Codex `--ephemeral --sandbox read-only`；未联网、未运行测试、未编辑文件。
- 只读证明：review结束后隔离 repo `git status --short` 为空。
- 结论：`NEEDS_REVISION — P0=0, P1=4, P2=0`

### 4.2 第二轮 findings 与 v3 resolution

#### V2-P1-1 — `defect`：mutation identity 被 create/turn/journal 三张表切开

失败序列：create 以 id `M` 写 session 表；随后 message/approval 在 turn 表查不到 `M`，commit
在 journal 也有独立 namespace，于是同 id 可跨 endpoint 再生效。现有 commit 对 same id
different draft/decisions 在比较 payload 前直接返回旧 journal；secret-bearing body也没有可安全
持久化的 exact fingerprint。

Resolution v3：

- `design.md` §0.1–§0.2 改为 owner-scoped `intent_mutation_ledger`，unique
  `(ownerUserId,clientMutationId)`；create/generation/approval/commit 都先查 ledger，再做
  freshness gate；
- ledger 持久化 endpoint/session scope、fingerprint version 与 typed anchor。endpoint/scope/
  fingerprint mismatch统一 `intent-mutation-id-reused`；anchor损坏 fail closed；
- fingerprint 是 strict normalized semantic body 的 domain-separated HMAC-SHA-256，复用现有
  host `secret.key`。commit 覆盖 draft与全部 decisions；raw secret/普通 secret hash均不落库；
- 旧 journal 因缺 request body迁为 `legacy-unverifiable`；跨 session owner/id collision 聚合为
  `legacy-ambiguous` tombstone。两者未来 POST均拒绝，只保留 detail/journal reconcile；
- `plan.md` T1/T2/T4新增全部 cross-endpoint pair、changed
  draft/applyMode/slot/human/waiver/secret与 secret negative tests。

状态：v3 已修订，待第三轮门禁验证。

#### V2-P1-2 — `gap`：reservation durable 后到 runner ownership 仍可能 daemon-alive 失主

失败序列：running turn/inFlight已提交；started callback或 route handoff在 runner/controller注册前
抛错；daemon仍存活，因此 boot-only recovery永不执行，session永久 inFlight，cancel也没有
matching controller。

Resolution v3：

- `design.md` §0.3 取消 route-owned launch，新增 daemon-scoped
  `IntentGenerationDispatcher`。reservation只写 queued running turn并 non-throwing wake；
- dispatcher short-tx CAS claim后注册 claimId/controller live-owner，才 best-effort发 started
  并从统一 try/catch/finally运行；
- 周期 reconciler重新 dispatch无 claim row；claimed但连续 grace scans没有 live owner的 exact
  row原位 terminal settle。live registry中的合法长任务不按墙钟误杀；
- boot仍在 HTTP listener前 settle旧 daemon owner；claim/settle/cancel均以 exact turn+claim
  CAS，旧 owner不能覆盖后来 turn；
- `plan.md` T2新增 reservation→claim、claim→registry、registry→run/broadcast 的
  daemon-alive fault injection，以及长任务不被误回收测试。

状态：v3 已修订，待第三轮门禁验证。

#### V2-P1-3 — `defect`：旧 journal 回填后未同步 `session.applyAttemptSeq`

失败序列：旧 session 有 attempt 1/2；migration只回填 journal而 session仍为默认 0；升级后每次
新 claim都尝试 attempt 1并撞 unique，transaction回滚后永久重试同一冲突。

Resolution v3：

- `design.md` §0.2 固定 migration 顺序：稳定回填 journal → session counter更新为 per-session
  `COALESCE(MAX(attemptSeq),0)` → SQLite NOT NULL/unique rebuild → legacy ledger backfill；
- fixture 覆盖 0/1/N、committed+failed、同毫秒/墙钟回拨，并真实执行升级后的下一次 claim，
  要求 `max+1`；不能以只计成功的 `commitSeq`替代。

状态：v3 已修订，待第三轮门禁验证。

#### V2-P1-4 — `defect`：expected revision 不能代替 final active/ACL freshness

失败序列 A：Tab A冻结 revision R；Tab B archive但不增 context；A 的迟到 manual mutation若只看
R便可写 archived session。失败序列 B：create/manual add 在 route 外 await ACL；grant被撤销、
visibility改变或资源删除后，transaction仍把旧 id写成 root。

Resolution v3：

- `design.md` §0.7 要求 create initial mounts 与 manual add在实际 `dbTxSync` 内读取 exact资源并
  调 `canViewResourceInTx`；route preview只服务 UX；
- add/remove/rebase同一 transaction fresh检查 owner、active、exact context、inFlight、
  unsettled apply；conditional update包含这些 predicates并检查 `changes===1`；
- remove验证 exact handle仍为 root；cancel区分 queued/live并只操作 matching turn/claim；
- `plan.md` T3覆盖 archive-before-tx、grant revoke、visibility change、delete与 response-loss
  interleaving。

状态：v3 已修订，待第三轮门禁验证。

### 4.3 首轮 resolution audit（第二轮裁决）

| 首轮项 | 第二轮状态              | 说明                                                             |
| ------ | ----------------------- | ---------------------------------------------------------------- |
| P1-1   | Still open              | config/runtime settlement已补；runner handoff由 V2-P1-2继续阻断  |
| P1-2   | Closed                  | source/seq、approval→answers、整批 ACL/name/receipt已闭合        |
| P1-3   | Replaced by new finding | marker已改 receipt/OCC；跨表 namespace由 V2-P1-1取代             |
| P1-4   | Closed                  | D1 pinned、D2 erase/close与同 slot id回归已明确                  |
| P1-5   | Still open              | DTO/ORDER BY/WS已补；legacy counter由 V2-P1-3继续阻断            |
| P1-6   | Closed                  | status transaction与 final active/currentDraft/context CAS已明确 |
| P1-7   | Replaced by new finding | 单项 parent-owned Dialog已闭合；manual final gate由 V2-P1-4取代  |
| P1-8   | Closed                  | private ref/direct submit/safe locator/集中 erase/导航恢复已明确 |
| P2-1   | Closed                  | 所有 Intent response unknown→safeParse，malformed fail closed    |
| P2-2   | Closed                  | actor-safe name/type/full owner、长 owner与 display=null已明确   |
| P2-3   | Closed                  | same-binary T1→T10依赖图与 supporting-contract tests已重写       |

### 4.4 下一步

以 v3 proposal/design/plan 创建全新隔离 snapshot执行第三轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC 为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 5. 第三轮复审记录

### 5.1 第三轮隔离门禁

- snapshot：`31eb1473de61b125f65c4ace7d15f3fdd8d626aa`
- 隔离目录：`/private/tmp/rfc235-design-gate-v3.2M4IoQ/repo`
- review task：`019fa9df-80ca-77b1-8a5b-c11327b9e040`
- 模式：external Codex `--ephemeral --sandbox read-only`；未联网、未运行测试、未编辑文件。
- 只读证明：review结束后隔离 repo `git status --short` 为空，进程 exit 0。
- 结论：`NEEDS_REVISION — P0=0, P1=2, P2=0`

完整 reviewer output 同时保存在隔离目录
`/private/tmp/rfc235-design-gate-v3.2M4IoQ/codex-design-gate-v3-output.md`；以下保留 finding、
failure sequence、当前源码证据与 v4 resolution。

### 5.2 第三轮 findings 与 v4 resolution

#### V3-P1-1 — `gap`：route-independent dispatcher 没有持久、可恢复且不提升权限的 execution actor

失败序列：

1. 普通用户 U 对私有资源 R 有 grant，并把 R 挂入 session。
2. U 提交 message；ledger、user turn、queued running turn与 `inFlightTurnId` 已提交，但
   `wake()`/callback故障。
3. route结束后 closure 中的 Actor消失；随后 U disabled，或 R grant被撤销。
4. periodic dispatcher只能从 DB取得 session/turn/claim。继续依赖 closure会永久 generating；
   fallback daemon/system会越过 ACL，把 U 已不可见的 R/closure送给模型；仅用
   `buildActor(owner)` 又不会自行拒绝 disabled user。

snapshot 证据：

- v3 turn持久字段只有 mutation/source/generation/claim identity，无 run-as principal：
  `design/RFC-235-intent-builder-ux/design.md:104-111`。
- dispatcher只规定
  `runReservedIntentTurn({turnId,claimId,...})`，没有 actor hydration/current-user policy：
  `design/RFC-235-intent-builder-ux/design.md:174-178`。
- 当前 route closure把 HTTP actor交给 engine，dump再直接以它过滤资源：
  `packages/backend/src/routes/intentSessions.ts:108-143`、
  `packages/backend/src/services/intent/turnEngine.ts:140-199,308-317`、
  `packages/backend/src/services/intent/dumpBuilder.ts:115-137`。
- system/manager/admin resource identity会 ACL bypass；`buildActor`只从 role生成 permission，不查
  status：`packages/backend/src/services/resourceAcl.ts:14-24,163-170`、
  `packages/backend/src/auth/actor.ts:33-67`。正常 credential resolver另行检查 active。
- 当前 Intent E2E只用 daemon token，不能证明普通 principal的 dispatcher路径：
  `e2e/intent-builder.spec.ts:33-48`。

Resolution v4：

- `intent_turns` 增 `runAsUserId/runAsPolicy`；reservation transaction断言
  actor/session owner/current active+`intent:write`一致，并原子写
  `current-session-owner-v1`。不保存 token、PAT secret/scopes或权限快照；旧 nullable row只
  terminal、不 resume。
- dispatcher claim transaction同时读取 exact turn/session/current user。missing、disabled、无
  permission或 policy/owner mismatch时，exact row原位 settle
  `intent-runner-principal-unavailable`、清 matching inFlight、保留 ledger并发 finished。
- valid claim只构造 current owner actor：普通 owner使用 session-equivalent current-role actor；
  exact system-owned session才可用 daemon actor，永不把普通 owner fallback为 `__system__`。
  credential revocation不撤销 accepted durable action；user status/role/ACL变化按执行时状态生效。
- config/budget后、dump前二次 hydrate；dump只用 current owner/current ACL。mounted root已
  missing/invisible则模型前 settle `intent-context-resource-unavailable`；非 admin owner的
  foreign-private canary不进 runner，普通 admin仍只按当前 role的既有 resource-admin合同读取。
  boot仍只 terminal旧 run，不用 system恢复普通 owner。
- `plan.md` T1/T2/T9新增 route actor销毁、periodic poll、disable/missing、role升降、PAT/session
  revocation、ordinary admin、exact system owner、grant revoke、非 admin foreign-private
  canary/admin既有 resource-admin visibility及 restart/cancel CAS，并要求至少一条非-system真实
  会话 E2E。

状态：v4 已修订，待第四轮门禁验证。

#### V3-P1-2 — `gap`：HMAC semantic normalizer 未与实际执行对象绑定

失败序列：

1. 当前 commit schema允许 duplicate `opId`/`slotId`；resolver的 Map语义是 last-wins。
2. request A 对同一 secret slot依次给 `alpha`,`beta`，B 反向；A执行 `beta`，B执行
   `alpha`。
3. v3 未规定 normalizer的 duplicate、order、lossless合同。若 fingerprinter按 keyed set
   排序/去重，executor仍消费 raw array，A/B可能共享 fingerprint。
4. A响应丢失后，以同 mutation id发送 B会被错误当 exact replay。create mounts同理：输入顺序
   会改变同类型 handle分配，lossy排序却可能抹掉差异。

snapshot 证据：

- v3只有“strict parse + endpoint normalizer”，未列各 endpoint的 ordered/set/default/trim与
  executor binding：`design/RFC-235-intent-builder-ux/design.md:118-138`。
- shared commit schema没有 `opId/slotId` uniqueness：
  `packages/shared/src/schemas/intentSession.ts:74-91`。
- resolver以 `Map.set/new Map` last-wins：
  `packages/backend/src/services/intent/resolveChangeset.ts:290-304,333-334`。
- create按输入顺序分配 root handle：
  `packages/backend/src/services/intent/session.ts:113-139`、
  `packages/backend/src/services/intent/manifest.ts:73-88`。
- v3 tests只列 changed value，没有 duplicate/permutation或 fingerprint/execution性质：
  `design/RFC-235-intent-builder-ux/plan.md:15-18,103-105`。

Resolution v4：

- strict schema/normalizer在副作用前拒绝 commit duplicate `opId`、duplicate
  `(opId,slotId)`，把 source question重复 options按精确文本首次出现去重，并拒绝 answers
  duplicate question/picked option或 single/multi数量错误；approval duplicate/missing/extra同样
  拒绝。
- 定义唯一 branded
  `normalizeIntentMutationV1({endpointKind,scope,parsedBody,source?})`。scope来自 trusted
  actor/session；raw parsed body随后丢弃。HMAC、ledger fields、turn/session/journal writer、
  mount allocator与 apply resolver只接受同一个 normalized object。
- 逐 endpoint固定语义：create message/hint trim+omit且 mounts ordered-first dedup；answers按
  durable source question/option order；approvals按 source request order；commit先 uniqueness再按
  `opId/slotId`排序，但 secret/human/waiver value逐字保留。纯换序只在 executor也消费相同排序
  结果时可 exact replay；会改变 handle的 create distinct mount换序保持 changed body。
- ledger新写固定 `fingerprint_version='intent-normalized-v1'`，HKDF domain升级为
  `intent-mutation:normalized-v1`；未知/legacy version继续 unverifiable，raw secret不持久化。
- `plan.md` T1/T3/T4新增 duplicate/reversed/permutation矩阵、raw-wire source guard与性质测试：
  固定 endpoint/scope/key下，fingerprint相同必须对应 executor相同 normalized canonical bytes。

状态：v4 已修订，待第四轮门禁验证。

### 5.3 第二轮 resolution audit（第三轮裁决）

| 第二轮项                                | 第三轮状态          | 裁决                                                              |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| V2-P1-1 mutation namespace/body binding | Replaced by V3-P1-2 | owner-scoped ledger/HMAC已建立；normalizer/executor同一性继续阻断 |
| V2-P1-2 daemon-alive runner失主         | Replaced by V3-P1-1 | claim/live-owner/orphan已闭合；route-independent actor继续阻断    |
| V2-P1-3 migration session counter       | Closed              | journal稳定回填→session MAX→next claim=max+1完整                  |
| V2-P1-4 create/manual final active/ACL  | Closed              | same-tx exact row/ACL、fresh active/context与 changes CAS完整     |

### 5.4 第三轮 Coverage note

- Unified ledger/HMAC：除 V3-P1-2 外，owner-scoped唯一域、typed anchor、
  ledger-before-freshness、cross-endpoint/session conflict、HKDF/key id/key loss、
  legacy-unverifiable/collision tombstone无新增 finding。
- Dispatcher：除 V3-P1-1 外，reservation→wake→claim→registry→run、周期 orphan、exact
  claim/cancel CAS、合法长任务保护、listener前 boot recovery无新增 finding。
- Migration/apply：0/1/N、failed+committed、同毫秒/墙钟回拨、真实 next claim、ordered
  attempt/WS/final active CAS无新增 finding。
- Create/manual final gate：same-tx exact row/ACL、fresh
  owner/active/context/inFlight/unsettled、remove exact root与 response-loss target-state语义无新增
  finding。
- 首轮 closed项抽验：source-bound answers/approval、pinned D1→D2、secret private
  ref/navigation/cache、outer DTO safeParse、actor-safe Owner与 same-binary依赖均未见回归。
- reviewer逐面核对 RFC-235三件套、RFC-234合同、shared/backend/frontend/E2E当前 source/tests；
  memory只用于选择全文件/失败序列审查方法，未作事实证据。

### 5.5 下一步

以 v4 proposal/design/plan创建全新隔离 snapshot执行第四轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 6. 第四轮复审记录

### 6.1 第四轮隔离门禁

- 隔离目录：`/private/tmp/rfc235-design-gate-v4.Dkwlt5/repo`
- snapshot：`3ec8c246772d898b12f69aa44a8cec7aa93910c8`
- reviewer session：`019faa18-702a-7f83-989b-6b76e69dcb1d`
- 模式：`codex exec --ephemeral --sandbox read-only`，未联网、未运行测试
- 隔离仓库门前/门后：clean
- 结论：`NEEDS_REVISION — P0=1, P1=2, P2=0`

完整 reviewer output 同时保存在隔离目录
`/private/tmp/rfc235-design-gate-v4.Dkwlt5/codex-design-gate-v4-output.md`；以下保留 finding、
failure sequence、当前源码证据与 v5 resolution。

### 6.2 第四轮 findings 与 v5 resolution

#### V4-P0-1 — `defect`：apply final transaction 未复验 Intent copy-only ownership

失败序列：

1. 人类 admin/manager A 拥有 Workflow W，并在自己的 Intent session确认
   `applyMode='modify'`。
2. apply claim/preflight把 W 判为可 modify；plugin install或 Skill stage拉长 final
   transaction前窗口。
3. 另一管理员把 W owner转给 B。ACL transaction只增 `aclRevision/updatedAt`，不增加 Workflow
   `version`。
4. v4 final transaction只复验 session active/currentDraft/context/inFlight，prepared op仍携旧
   route actor。
5. Workflow kernel见 A仍是 resource-admin而允许写；内容 version未变，CAS成功。A遂原地改写
   已属于 B、按 RFC-234 应为 copy-only 的资源。Workgroup同样受影响。

snapshot 证据：

- RFC-234 他人/内置仅副本与 session owner actor：
  `design/RFC-234-intent-driven-builder/proposal.md:38-47,91-96`。
- 当前 copy-only分类只在异步 preflight读取 owner：
  `packages/backend/src/services/intent/applyChangeset.ts:131-164,413-423`。
- ACL transfer增 `aclRevision`但 Workflow/Workgroup Intent fence只有 version：
  `packages/backend/src/services/resourceAcl.ts:430-475,493-547`、
  `packages/backend/src/services/intent/manifest.ts:22-28,110-115`。
- prepared Workflow/Workgroup保存旧 actor；final直接调用 kernel：
  `packages/backend/src/services/intent/applyChangeset.ts:573-612,687-797`。
- Workflow/Workgroup kernel对 resource-admin bypass，Workflow CAS只比 version：
  `packages/backend/src/services/workflow.ts:826-859,374-425`、
  `packages/backend/src/services/workgroups.ts:832-863`。
- v4只新增 session active CAS：
  `design/RFC-235-intent-builder-ux/design.md:384-389`、
  `design/RFC-235-intent-builder-ux/plan.md:103-109`。

Resolution v5：

- journal增 nullable-migration/新写 required语义的
  `runAsUserId/runAsPolicy='current-session-owner-v1'`；claim同 transaction fresh验证 ledger/
  session owner、active user与 `intent:write`。旧 null run-as的 prepared/applying只补偿失败，
  committed只允许既有 roll-forward。
- server-only manifest detail增
  `ownerUserId/visibility/aclRevision/builtin` authorization fence；content fence继续独立。
- final `dbTxSync`按 journal重读 current user/role并重建 session actor；prepared route actor无
  授权效力，进入 kernel前必须用 final actor重绑。
- `authorizeIntentBundleInTx`逐 target重跑 owner/builtin copy-only与 ACL/content fence。确认的
  modify若已 foreign/builtin，整包 `intent-foreign-modify-forbidden`，不能静默转 copy；
  final actor同时复验完整 bundle refs/human active。
- target authority、六类写、provenance、journal committed与 session CAS同 transaction。失败
  回滚 DB、逆序补偿 plugin/Skill artifacts、typed settle；exact replay只返回原失败。
- deterministic tests在 preflight/plugin/Skill/final各窗口注入 Workflow/Workgroup owner
  transfer、builtin flip、user disable/role变化与 reference grant revoke；MCP full operation hash
  作为既有 ACL fence对照。

状态：v5 已修订，待第五轮门禁验证。

#### V4-P1-1 — `gap`：current-owner dump 没有 ACL disclosure admission 线性化点

失败序列：

1. 普通 owner U暂获 foreign-private canary R并挂载。
2. claim与 dump前 hydrate都看到 U active/可见。
3. `loadVisibleCatalog` 的独立查询读到 grant并把 R缓存。
4. catalog返回后、serialization/Skill文件读取或 spawn前撤销 grant。
5. 后续 dump只消费缓存；turn engine持久 manifest也只检查 session inFlight/context。
6. 模型收到撤权后的 R。v4没有定义哪一时刻是权威执行 ACL。

snapshot 证据：

- v4声称 user/role/ACL变化按执行时状态，dump用 current ACL：
  `design/RFC-235-intent-builder-ux/design.md:239-270`。
- 当前 catalog由六类异步 list/filter查询组成：
  `packages/backend/src/services/intent/dumpBuilder.ts:115-132`。
- root/closure/serialization/file read均只消费缓存：
  `packages/backend/src/services/intent/dumpBuilder.ts:205-248,271-487`。
- dump后仅做 session turn/context CAS：
  `packages/backend/src/services/intent/turnEngine.ts:302-334`。
- 当前 tests只覆盖 build开始前的静态 visibility：
  `packages/backend/tests/rfc234-dump-builder.test.ts:91-118,351-363`。

Resolution v5：

- final disclosure-admission transaction是线性化点：其 commit前完成的 user/role/ACL/content
  变化必须生效，commit后变化不追溯取消已 admission live run。
- 第一个短 `dbTxSync` 同时读取 exact user/session/turn/claim、mounts、六类 rows/grants，冻结
  完整 visible catalog与 canonical tokens
  `{type,id,owner,visibility,aclRevision,builtin,contentFence}`；覆盖所有影响
  inventory/root/closure/hidden/seed的 row。
- transaction外只从 frozen rows和 Skill immutable version构造 seed；seed held in memory。
- 紧邻 spawn的第二个短 `dbTxSync`重读 current user并重算 exact visible-set/token digest；
  相等才 CAS running turn的非敏感 `dumpAdmissionDigest/dumpAdmittedAt`。HTTP/WS不投影 digest，
  不持久 name/body/secret。
- 任一 principal/token/root/claim失配先丢 seed，再原位 settle
  `intent-context-resource-unavailable`、清 exact slot/owner并发 finished，绝不调用模型。
- hooks/tests覆盖 catalog ACL read后、六类/Skill file read后、final admission前及
  admission→spawn的 grant revoke/owner transfer/visibility/content/delete/rename/role变化；
  普通 canary零模型字节，admin按 final current role policy，长 live run不被 sweep。

状态：v5 已修订，待第五轮门禁验证。

#### V4-P1-2 — `gap`：source-bound normalizer 在 immutable owner gate 前读取私有 turn

失败序列：

1. foreign/manager取得 victim session/source turn id。
2. 攻击者对 `/answers` 猜 question/option，或对 `/mount-approvals` 猜 type/name。
3. v4要求 normalizer先读取/safeParse durable source才能判断 source-aware合法性。
4. owner equality只在后续 new-ledger freshness transaction证明；不同猜测会先得到不同
   source-aware错误，完全匹配才晚到 owner 404。
5. 因此可枚举私有 question/request；owner-scoped ledger不能阻止 ledger之前的 source read。

snapshot 证据：

- v4 normalizer/source读取顺序：`design/RFC-235-intent-builder-ux/design.md:147-175`。
- owner只在仅新 id reservation transaction证明：
  `design/RFC-235-intent-builder-ux/design.md:212-227`。
- T3.1同样先 source normalize、后 seq/ACL：
  `design/RFC-235-intent-builder-ux/plan.md:91-97`。
- 当前安全路径先 `getIntentSessionForActor/assertWritable` 再插 turn：
  `packages/backend/src/services/intent/session.ts:47-59,203-234`。

Resolution v5：

- session endpoint顺序固定为 authentication/coarse permission → wire-only strict parse →
  `session.id + owner_user_id=actor.id` immutable write-scope 404 gate → route-session-scoped source
  load/safeParse → unique normalization/HMAC → ledger replay → 仅新 id freshness/ACL。
- `authorizeIntentMutationScopeV1`返回 branded scope；source loader与 normalizer不能接受未授权
  route id，source query同时约束 `turn.session_id=scope.sessionId`。
- owner gate不检查 status/turnSeq，因此已推进/归档后的 exact owner replay仍可重建原 bytes；
  owner source missing/corrupt typed fail closed。
- foreign/manager/admin auditor对 source-aware correct/incorrect body全部同形
  `intent-session-not-found`，spy证明零 source read/parse、零 ledger/turn。另锁 cross-session、
  advanced/archived exact replay与 changed-body conflict。

状态：v5 已修订，待第五轮门禁验证。

### 6.3 第三轮 resolution audit（第四轮裁决）

| 第三轮项                                         | 第四轮状态          | 裁决                                                                                                                                                                                    |
| ------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V3-P1-1 durable/recoverable/non-escalating actor | Replaced by V4-P1-1 | run-as、claim/dump hydrate、ordinary owner session actor、system exact分支、principal settlement与 live-owner合同已闭；current ACL disclosure线性化继续阻断                             |
| V3-P1-2 HMAC normalizer/executor object          | Closed              | 唯一 branded object、trusted scope、canonical envelope、HKDF/version/key-loss与 duplicate/permutation property/source guard完整；V4-P1-2是前置 owner authorization顺序，不是 object双轨 |

### 6.4 第四轮 Coverage note

- Durable actor除 disclosure admission外，reservation/claim/current user、zero system fallback、
  principal/config/budget/spawn failure settlement、live registry/orphan/cancel/boot与非 admin E2E
  任务无新增 finding。
- Normalizer除 source owner gate外，六 endpoint canonical body、source/commit order、
  duplicate/default/secret bytes、HMAC与 executor同一对象无新增 finding。
- Unified ledger、migration MAX/legacy、create/manual same-tx、ordered apply/WS、
  pinned secret/navigation、outer DTO/actor-safe Owner与 UX T1–T10覆盖无新增 finding。
- reviewer逐面读取 RFC-235/RFC-234、shared/backend/frontend/E2E当前源码与 tests；memory只用于
  全文件/失败序列审查方法，未作当前事实证据。

### 6.5 下一步

以 v5 proposal/design/plan创建全新隔离 snapshot执行第五轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 7. 第五轮复审记录

### 7.1 第五轮隔离门禁

- 隔离目录：`/private/tmp/rfc235-design-gate-v5.kU4Urw/repo`
- snapshot：`cadf74aa7c20a47ef8d8d522cda8f675ce9adb39`
- reviewer session：`019faa4c-6d59-78e3-ab31-a7e7cb36e5c3`
- 模式：`codex exec --ephemeral --sandbox read-only`，未联网、未运行测试
- 隔离仓库门前/门后：clean；进程 exit 0
- 结论：`NEEDS_REVISION — P0=0, P1=1, P2=0`

完整 reviewer output 同时保存在隔离目录
`/private/tmp/rfc235-design-gate-v5.kU4Urw/codex-design-gate-v5-output.md`；以下保留 finding、
failure sequence、当前源码证据与 v6 resolution。

### 7.2 第五轮 finding 与 v6 resolution

#### V5-P1-1 — `gap`：artifact 补偿缺少 durable exact identity，且 cleanup失败仍可 terminal

失败序列：

1. apply journal已 prepared，bundle包含 npm/git Plugin与 managed Skill。
2. 当前 Plugin artifact只先记 `pluginId`；installer在函数内部 mint generation
   `opId`，目录/安装/manifest完成后才返回 `generationDir`。任一中间 crash都会让 journal永远
   不知道本 attempt的 exact generation。
3. restart converger明确跳过 Plugin精确清理、依赖通用 GC，却仍写 failed；通用 GC默认 24h，
   且任一 non-terminal node run都会保留所有 orphan。
4. Plugin cleanup与 Skill compensation都吞掉 `rm`失败；Skill随后还删除 row/op。apply catch/
   converger仍 terminalize，exact replay又禁止重新 prestage。
5. UI与 session gate把 failed视为已结算，用户看到确定失败，但外部 bytes可能永久残留，违反
   all-or-nothing与“逆序补偿后再 failed”合同。

snapshot 证据：

- v5只笼统声明 transaction外逆序补偿后 failed：
  `design/RFC-235-intent-builder-ux/design.md:485-491`、
  `design/RFC-235-intent-builder-ux/plan.md:118-134`。
- 当前 Plugin journal artifact只有 `pluginId`：
  `packages/backend/src/services/intent/applyChangeset.ts:120-123,637-642`。
- installer内部 mint id并在完成后才返回 generation：
  `packages/backend/src/services/pluginInstaller.ts:161-193,248-265`；同 plugin可并发生成不同
  directory：`packages/backend/tests/services/pluginInstaller.test.ts:231-241`。
- converger跳过 Plugin cleanup却无条件 failed：
  `packages/backend/src/services/intent/applyChangeset.ts:931-968`。
- Plugin/Skill cleanup吞文件错误：
  `packages/backend/src/services/pluginInstaller.ts:514-516`、
  `packages/backend/src/services/skill.ts:386-401`。
- 通用 GC默认 24h且 active run全局阻断：
  `packages/backend/src/services/pluginGenerationGc.ts:1-36`、
  `packages/backend/tests/rfc201-plugin-exact-operation.test.ts:167-201`。
- 既有 apply crash matrix只使用 `file://` fixture，其 `generationDir=null`，没有覆盖 npm/git：
  `packages/backend/tests/rfc234-apply-changeset.test.ts:115-122,681-725`、
  `packages/backend/src/services/pluginInstaller.ts:268-293`。

Resolution v6：

- journal新写固定 `preparedArtifactsVersion=2`，receipt只含 exact canonical
  Plugin `{pluginId,generationId}`或 Skill `{skillId,operationId}`，不保存/信任 absolute path。
- apply caller预生成 npm/git generation id，receipt transaction成功后 installer才消费该 exact
  id；`file:`零 owned artifact。Skill receipt、invisible reserving row与 reserve op/lock同
  transaction建立后才 materialize，任何 writer都不得内部另 mint identity。
- 失败先保存原 typed error并 CAS `compensating`。daemon-scoped coordinator以 durable claim +
  live registry逆序 cleanup；boot/periodic重领 lost claim，live cleanup不按墙钟误杀。
- strict Plugin cleanup只删 exact generation并验证 root containment/no symlink/current refs/
  其它 receipts/live installs；strict Skill cleanup在文件确认 absent前保留 reserving row/op。
  cleanup error继续 compensating，只有全部 receipt被证明 absent才 CAS terminal failed并写
  cleanup-verified timestamp。
- shared DTO/WS/journey增
  `compensating|repair-required`；两者都阻断 session/archive/new apply。前者 1.5s poll显示撤销中，
  后者擦除 secret request、保留 safe locator并低频提示管理员修复。
- legacy `{pluginId}`不得猜 generation，进入 repair-required；保守 GC/doctor只有以 canonical
  inventory证明零 current/active/v2-held/unreferenced generation后才可收口。既有 terminal
  history只读保留、verified timestamp为空，UI标记 legacy cleanup unverified，不倒推曾经补偿
  成功。
- deterministic tests使用 fake npm真实子进程退出覆盖
  receipt→mkdir/install/manifest/return，Skill覆盖 reserve→materialize/version；同时锁
  first-fail-second-success、同 plugin多 generation/current ref、长期 node run、file:源、
  path/symlink、claim loss与 legacy repair proof。

状态：v6 已修订，待第六轮门禁验证。

### 7.3 第三/四轮 resolution audit（第五轮裁决）

| 既有项                                           | 第五轮状态 | 裁决                                                                                  |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| V3-P1-1 durable/recoverable/non-escalating actor | Closed     | current-owner policy/current-user claim/零普通用户 system fallback/disclosure CAS闭合 |
| V3-P1-2 HMAC normalizer/executor object          | Closed     | 唯一 branded object、顺序/duplicate/lossless与 property/source guard闭合              |
| V4-P0-1 apply owner transfer/final authority     | Closed     | final actor、target copy-only、ACL/content/ref authority与同事务 CAS闭合              |
| V4-P1-1 disclosure admission                     | Closed     | frozen full catalog/token + final exact digest/CAS与 held seed闭合                    |
| V4-P1-2 owner-before-source                      | Closed     | immutable owner 404 → scoped source → normalize/HMAC → replay/freshness顺序闭合       |

V5-P1-1不是旧权限 finding的重复，而是 v5新增“artifact已补偿再 failed”子合同缺少 exact identity/
settlement protocol。

### 7.4 第五轮 Coverage note

- `/intent` inline/dialog、最近会话、journey、single/multi questions、atomic mount approval、
  conversation/review双栏、commit wizard、audit/archive/cross-tab、390px/桌面、键盘/axe/
  reduced-motion均逐项检查；除 compensation六态投影外无新 UX finding。
- strict outer parse、统一 ledger/HMAC、generation dispatcher/source receipt、attempt
  ordering/WS、manual/status/apply OCC、migration MAX/tombstone与 same-binary发布除
  V5-P1-1外无新 finding。
- owner/admin/system、TOCTOU、owner/visibility/builtin/content、secret生命周期、idempotency、
  daemon crash/orphan/cancel与 final refs/humans authority无新 finding。
- reviewer逐面读取 RFC-235四份目标文档、RFC-234、shared/backend/frontend/E2E当前
  source/tests；memory只用于全文件/失败序列审查方法，未作当前事实证据。

### 7.5 下一步

以 v6 proposal/design/plan创建全新隔离 snapshot执行第六轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 8. 第六轮复审记录

### 8.1 第六轮隔离门禁

- 隔离目录：`/private/tmp/rfc235-design-gate-v6.doOYTx/repo`
- snapshot：`a3c72b914b70a6b0253af37a2e765126b7307065`
- reviewer session：`019faa7c-3a62-7031-bc93-5f962ff9b1ac`
- 模式：`codex exec --ephemeral --sandbox read-only`，未联网、未运行测试或构建
- 隔离仓库门前/门后：clean；进程 exit 0
- 结论：`NEEDS_REVISION — P0=0, P1=2, P2=0`

完整 reviewer output 同时保存在隔离目录
`/private/tmp/rfc235-design-gate-v6.doOYTx/codex-design-gate-v6-output.md`；以下保留 finding、
failure sequence、当前源码证据与 v7 resolution。

### 8.2 第六轮 findings 与 v7 resolution

#### V6-P1-1 — `gap`：Plugin cleanup 未证明安装进程树静默，terminal 后 generation仍可复活

失败序列：

1. exact Plugin receipt已经提交，installer创建 generation并启动 npm。
2. daemon在 npm lifecycle descendant仍运行时退出，或 timeout只杀 direct child便返回失败。
3. 新 daemon的内存 registry没有旧 writer。coordinator删除 exact generation并观察 missing，
   随即写 `failed + artifactCleanupVerifiedAt`。
4. 幸存 descendant稍后继续写入或重建 generation；journal、UI与新 apply gate却已声明补偿收口。

snapshot 证据：

- v6只有 daemon-local claim/live registry、reference check、`rm + lstat(missing)`与 final CAS，
  没有跨 daemon writer identity/quiescence fence：
  `design/RFC-235-intent-builder-ux/design.md:569-591,1632-1641`。
- 当前 installer直接 spawn npm，timeout只向 direct child发 `SIGKILL`后 reject：
  `packages/backend/src/services/pluginInstaller.ts:594-633`；既有 timeout test也只检查 promise
  失败：`packages/backend/tests/services/pluginInstaller.test.ts:217-228`。
- 仓库已有 process-group primitive并明确 direct PID kill会留下 grandchildren：
  `packages/backend/src/util/process.ts:23-45`。

Resolution v7：

- artifact codec升为 v3；每个 npm/git Plugin receipt保存
  `reserved → released(identity) → quiesced(identity,quiescedAt)` writer phase，并以
  `preparedArtifactsRevision` exact CAS推进。identity包含 protocol version、execution nonce、
  group leader pid、pid=pgid，以及 Linux `boot_id + /proc/<pid>/stat starttime`或 macOS
  `proc_pidinfo(PROC_PIDTBSDINFO)` birth time；裸 PID与 PID shape不是身份。
- 从 RFC-224封印 subprocess语义抽取 verified-self
  `OwnedProcessGroupSupervisorV1`。supervisor先建独立 process group并回 READY，此时不得启动
  npm或写 generation；host独立验证 exact start identity并持久化 `released`后，才发 authenticated
  GO释放 writer。
- 正常、EOF、timeout、cancel、watchdog与 restart recovery统一执行 whole-group
  TERM→KILL、reap leader、核验 exact identity并 latch negative PGID；只有 EXIT/ACK/RELEASE
  协议完成后才写 `quiesced`。PID reuse或身份歧义禁止 signal，保持 compensating或转
  repair-required。
- compensation只有在 receipt仍 reserved-without-GO或 exact writer已 quiesced时才能删除
  generation。空内存 registry、一次目录 missing或 direct child退出都不构成 terminal proof。
- deterministic fake npm必须启动 delayed descendant；在 running断点真杀 daemon以及 timeout/
  cancel路径都证明 whole group被 kill+reap，且 terminal后超过延迟写窗口目录仍不复活。

#### V6-P1-2 — `gap`：no-symlink containment 只约束 cleanup，未约束首次 filesystem write

失败序列：

1. Plugin receipt已提交，或 Skill receipt/reserving row/reserve op已原子建立。
2. receipt→mkdir间隙，受控根下 parent被替换为指向外部 sentinel的 symlink。
3. 当前 recursive mkdir、host write、npm `--prefix`、Skill producer与 version publication跟随
   symlink，先在外部位置产生 bytes。
4. 后续 cleanup即使发现 symlink并进入 repair-required，也无法依据 canonical receipt安全回收
   外部写入；record-before-act并没有形成 containment-before-act。

snapshot 证据：

- v6逐级 `lstat`/no-symlink只绑定 cleanup，forward materialization没有同等 authority：
  `design/RFC-235-intent-builder-ux/design.md:539-554`、
  `design/RFC-235-intent-builder-ux/plan.md:133-154`。
- 当前 Plugin使用 recursive mkdir，再沿该 path做 `Bun.write`、npm与 manifest rename：
  `packages/backend/src/services/pluginInstaller.ts:189-224,254-257`。
- 当前 Skill同样 recursive mkdir并调用 producer/version writer：
  `packages/backend/src/services/skill.ts:367-378`、
  `packages/backend/src/services/intent/applyChangeset.ts:652-676`。
- 仓库虽已有逐级 real-directory/no-symlink helper，forward stage尚未使用：
  `packages/backend/src/services/skillIdentityPaths.ts:111-145`。

Resolution v7：

- 新增 branded `ManagedArtifactPathAuthorityV1`，只接受 validated Plugin/Skill ids并自行推导
  canonical path。配置 root与所有既存 parent逐段 `lstat`为 real directory且禁止 symlink；
  缺失 segment逐项 non-recursive mkdir；exact leaf必须 exclusive create并记录 device/inode。
- host package、manifest、Skill files与 version archive使用 no-follow/exclusive file operation；
  每次 await之后、任何 write/spawn/producer/rename/publication之前，重新验证完整 parent与 leaf
  identity。任一 mismatch在 npm/producer调用前 fail closed。
- Plugin install/cleanup/GC/doctor共享 stable-id coordinator，Skill复用 universal operation
  lock，应用内 writer不能绕过 authority或并发替换受控 path。
- deterministic tests在 Plugin receipt→mkdir、Skill reserve→materialize以及 leaf
  create→publication断点注入 parent/leaf symlink replacement；断言外部 sentinel零新增 bytes、
  npm/producer零调用，receipt/row/op仍可恢复。

### 8.3 第五轮 resolution audit（第六轮裁决）

| v6 修订面                                                                             | 第六轮状态                 | 裁决                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| exact Plugin generation / Skill reserve identity、receipt-before-act、caller-owned ID | Closed                     | canonical receipt、Plugin caller ID及 Skill receipt+row+op同事务闭合          |
| file source、receipt禁止 absolute path                                                | Closed                     | `file:` 为零 owned artifact，receipt只存 canonical identity                   |
| compensation六态、durable claim/live owner、session/archive/apply gate                | Open → V6-P1-1             | DB claim/state gate闭合，但旧 npm writer不属于可恢复 ownership                |
| strict cleanup、全部 absent后 final CAS                                               | Replaced → V6-P1-1/V6-P1-2 | cleanup不再吞错；terminal proof仍缺 writer静默，forward symlink外写也不可补偿 |
| crash/path tests                                                                      | Open → V6-P1-1/V6-P1-2     | 验收文字尚未强制 process-tree quiescence与外部零写入                          |
| v1 Skill升级、legacy Plugin/损坏 receipt、GC/doctor proof、历史 failed语义            | Closed                     | repair-required与 legacy cleanup-unverified明确且保守                         |

V6-P1-1与 V6-P1-2是 V5-P1-1既有 all-or-nothing合同的两个不同必要条件：前者证明
terminal前不存在仍可写入的 owned writer，后者证明首次副作用从未逃逸 canonical root；不重复计算
原 finding。

### 8.4 第六轮 Coverage note

- reviewer逐项检查 `/intent` inline/Dialog、recent cards、journey、single/multi question、
  source-bound mount approvals、Conversation/Review双栏、pinned commit、归档/跨 tab/恢复、
  390px/桌面、键盘/axe/reduced-motion与 i18n；无新增 UX finding。
- shared strict wire/outer parse、统一 ledger/HMAC、generation dispatcher、source receipt、
  attemptSeq journal/WS、manual/status/apply OCC、migration MAX/tombstone/legacy及 same-binary
  发布，除上述 artifact边界外无 finding。
- owner/admin/system、TOCTOU、owner/visibility/builtin/content、secret生命周期、idempotency、
  daemon orphan/cancel、claim loss、committed保护均回归；V3 actor与 single normalized execution
  object继续 Closed。
- reviewer逐面读取 RFC-235四份目标文档、RFC-234、shared/backend/frontend/E2E当前
  source/tests；memory只用于全文件/失败序列审查方法，未作当前事实证据。

### 8.5 下一步

以 v7 proposal/design/plan创建全新隔离 snapshot执行第七轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 9. 第七轮复审记录

### 9.1 第七轮隔离门禁

- 隔离目录：`/private/tmp/rfc235-design-gate-v7.JuhgPs/repo`
- snapshot：`e415fed3b8cea6444a82e532fceffc94c7ba61bf`
- reviewer session：`019faaa2-9c6f-7a90-8083-aa3bd8f968b0`
- 模式：`codex exec --ephemeral --sandbox read-only`，未联网、未运行测试或构建
- 隔离仓库门前/门后：clean；进程 exit 0
- 结论：`NEEDS_REVISION — P0=0, P1=3, P2=0`

完整 reviewer output 同时保存在隔离目录
`/private/tmp/rfc235-design-gate-v7.JuhgPs/codex-design-gate-v7-output.md`，SHA-256 为
`e8ed6857c675c2b07197641574c5a4b5b583421743ade25de2c0e1b46ef349e5`；以下保留 finding、
failure sequence、当前源码证据与 v8 resolution。

### 9.2 第七轮 findings 与 v8 resolution

#### V7-P1-1 — `gap`：PGID 静默证明不覆盖 `setsid`/double-fork 逃逸 descendant

失败序列：

1. Plugin receipt 已是 released，host发送 GO。
2. npm lifecycle descendant执行 `setsid`、double-fork并关闭继承 pipe，脱离原 supervisor
   PGID，延迟写 generation。
3. npm direct child退出；supervisor TERM/KILL原 PGID并观察 ESRCH，错误写 quiesced。
4. compensation删除 generation并写 `failed + artifactCleanupVerifiedAt`。
5. 逃逸 descendant稍后重建 generation，terminal与实际 artifact状态分叉。

snapshot 证据：

- G20要求 terminal前 writer已静默：
  `design/RFC-235-intent-builder-ux/proposal.md:123-129`。
- v7证明集合只有原 process group，fixture也只要求 same-group descendant：
  `design/RFC-235-intent-builder-ux/design.md:638-647,1741-1748`、
  `design/RFC-235-intent-builder-ux/plan.md:171-174`。
- 被复用的 RFC-224 helper只把 child启动在当前 group，不能禁止后续 `setsid`：
  `packages/backend/src/services/runtime/opencode/sealedSubprocess.ts:325-332`。
- 仓库已有 private PID namespace fixture专门验证
  `setsid + double-fork`：
  `packages/backend/tests/integration-opencode/README.md:18-32`、
  `packages/backend/tests/integration-opencode/opencode-identity-preflight.integration.test.ts:346-384`。
- 当前 installer允许 npm lifecycle且没有相应 containment：
  `packages/backend/src/services/pluginInstaller.ts:220-224`。

Resolution v8：

- writer ownership从 PGID升级为 `OwnedArtifactContainmentV2`。Linux由 private PID namespace
  PID-1 anchor拥有整个不可逃逸后代集合。当前 macOS SDK明确标注递归
  `EVFILT_PROC NOTE_TRACK/NOTE_CHILD/NOTE_TRACKERR` 自 10.5起不受支持，仓库也没有其它可恢复
  descendant ownership primitive；Darwin npm/git Intent apply因此在 preflight、journal/leaf前
  typed fail closed，绝不以 PGID、child-list轮询、Seatbelt或禁 lifecycle伪造 parity。
- READY仍为零 child/零 generation写；receipt持久 exact nonce、supervisor start identity、
  PID namespace inode后才 GO。Linux真实 qualification必须运行
  `setsid + double-fork + closed-pipe + delayed-write` fixture；能力不完整则在 GO前 typed fail
  closed。
- normal/EOF/timeout/cancel/watchdog/restart都必须收口 kernel process set。只有 direct leader
  settled、PID namespace除 init外为空，verified supervisor才以从 host secret + nonce派生的
  一次性 key签出 HMAC empty proof。新 daemon只接受 exact valid proof；PGID ESRCH、
  PID shape、空 registry或一次 missing不再有权写 quiesced。
- deterministic Linux tests覆盖正常退出、timeout、cancel、daemon SIGKILL/restart、proof MAC
  错误与 identity mismatch；terminal后跨过 delayed-write窗口仍不得复活 generation。Darwin
  tests证明 npm/git case零 ledger/journal/leaf/child，managed Skill与 file: control仍可用。

#### V7-P1-2 — `gap`：path authority 仍是 check-then-path-use，不能保证首次外部零写

失败序列：

1. receipt与 exclusive leaf已建立，authority完成最后一次 inode复验。
2. 在复验返回后、npm `--prefix`、Skill producer write或 rename syscall前，同 UID writer替换
   parent/leaf为 sentinel symlink。
3. path-based syscall沿新路径在 sentinel产生 bytes。
4. 下一次复验虽发现 mismatch，但外部写已经无法由 canonical receipt安全补偿。

snapshot 证据：

- v7只要求每个 action前 `lstat`/inode复验并依靠应用内 coordinator：
  `design/RFC-235-intent-builder-ux/design.md:584-603`；没有 directory handle、
  descriptor-relative syscall或原子的 no-replace rename。
- 当前 Plugin把 string path交给 npm并用 path rename：
  `packages/backend/src/services/pluginInstaller.ts:190-223,254-257`。
- 当前 Skill把 string `filesDir`交给 producer：
  `packages/backend/src/services/skill.ts:367-378`。
- version/publish继续使用 recursive mkdir/copy与 path rename：
  `packages/backend/src/services/skillVersion.ts:532-557,608-612`、
  `packages/backend/src/services/skillFsPublish.ts:47-76`。
- v7测试只在 phase边界替换，没有覆盖 last-check→syscall：
  `design/RFC-235-intent-builder-ux/design.md:1749-1752`、
  `design/RFC-235-intent-builder-ux/plan.md:142-147,171-174`。

Resolution v8：

- `ManagedArtifactPathAuthorityV1`替换为不可序列化 `ArtifactFsCapabilityV2`。daemon从 app-home
  root dirfd开始，Linux使用
  `openat2(RESOLVE_BENEATH|NO_SYMLINKS|NO_MAGICLINKS)`，macOS使用 anchored
  `openat(O_DIRECTORY|O_NOFOLLOW)`；mkdir/open/walk/copy/unlink/publication全部通过
  `mkdirat/openat/fstatat/unlinkat/renameat*`。
- capability持有 root→leaf handles；同 UID进程即使在最后 fstat后替换 path，动作仍只作用于原
  inode。publication/cleanup通过 anchored parent核对 name→inode；mismatch零写 fail closed。
  Skill producer改接 `ArtifactTreeWriterV2`，不再得到裸 path。
- npm/git/lifecycle进入只暴露已打开 generation leaf为可写、authority ancestors与其余 host
  路径不可写的 OS filesystem view。当前只在 Linux从 inherited leaf fd建立 private mount view；
  Darwin npm/git在更早 preflight拒绝。无法用真实 replacement/symlink-to-sentinel
  qualification证明零写时，在 journal/leaf/spawn/GO前返回
  `intent-artifact-containment-unavailable`，禁止降级普通 prefix。
- Plugin install/update/publish/cleanup/GC/doctor与 Skill
  create/version/publish/import/ZIP/fusion/recovery全部进入可执行 inventory/source guard。
  tests在最后 fstat→每个 syscall窗口注入 replacement；两平台 host Skill writer sentinel零
  bytes，Linux fake lifecycle另主动 rename/symlink再写并必须零外部 bytes。

#### V7-P1-3 — `underspecified`：atomic mount approval 没有严格 HTTP/detail receipt DTO

失败序列：

1. 最新 agent turn同时有 mount requests与 questions。
2. mount-approval transaction提交，但 HTTP response正常返回或丢失。
3. UI必须确认 receipt逐项等于 frozen decisions，并取得新的 expected turn seq后才发 answers。
4. v7没有定义 approval response的 strict outer schema、result discriminant或 resulting seq。
5. 实现只能接受弱 `{mounted}`、猜 detail content，或无法继续 combined journey。

snapshot 证据：

- v7只定义 `IntentGenerationReceipt`：
  `design/RFC-235-intent-builder-ux/design.md:358-379`。
- approval定义了 request与 DB turn语义，但没有 response DTO：
  `design/RFC-235-intent-builder-ux/design.md:386-423`。
- 同文要求全部 action response safeParse，而 combined action依赖逐项 receipt与新 seq：
  `design/RFC-235-intent-builder-ux/design.md:723-728,1179-1194`。
- plan schema清单漏 approval receipt，但 T7.5直接假设存在：
  `design/RFC-235-intent-builder-ux/plan.md:28-34,57-60,262-263`。
- 当前 shared无可复用 receipt，route只返回 mounted handles：
  `packages/shared/src/schemas/intentSession.ts:94-228`、
  `packages/backend/src/routes/intentSessions.ts:291-309`。

Resolution v8：

- 新增 strict `IntentMountApprovalReceiptSchema`：
  `clientMutationId/sourceTurnId/expectedTurnSeq/approvalTurnId/resultingTurnSeq/
resultingContextRevision/results`；results按 source逐项、等长、闭集区分
  approve→`mounted|already-mounted`（含 exact resourceId/handle）与 reject→`rejected`。
- approval transaction预生成 turn id，HTTP、ledger anchor与 detail turn content共用同一
  receipt；detail另要求 outer turn id/seq等于 receipt的 approvalTurnId/resultingTurnSeq。
  exact replay逐字段相同。
- combined UI对 receipt strict parse并逐项比较 frozen body后，只用
  `resultingTurnSeq`发 answers。response loss只按 exact clientMutationId + sourceTurnId找回；
  malformed/mismatch必须零 answers POST，不从 mounts、文本或相邻 turn推断。

### 9.3 历史 resolution audit（第七轮裁决）

| 历史项                                         | 第七轮状态         | 裁决                                                                               |
| ---------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| V3-P1-1 durable current-owner actor            | Closed             | run-as、current-user claim、零普通 owner system fallback、orphan/restart均闭合     |
| V3-P1-2 single normalized execution object     | Closed             | branded object、duplicate/order/lossless、HMAC与 executor同对象继续闭合            |
| V4-P0-1 final copy-only authority              | Closed             | final actor、owner/builtin/content/ACL/ref authority与同事务 CAS闭合               |
| V4-P1-1 disclosure admission                   | Closed             | frozen full catalog/token + final digest CAS闭合                                   |
| V4-P1-2 owner-before-source                    | Closed             | immutable owner 404先于 private source hydration/normalization                     |
| V5-P1-1 durable artifact compensation umbrella | Replaced           | exact receipt/strict cleanup已闭；剩余 process-set/fs两个必要条件只计 V7-P1-1/P1-2 |
| V6-P1-1 process writer quiescence              | Reopened → V7-P1-1 | v7解决 direct-child/PGID，但未覆盖主动逃离 PGID                                    |
| V6-P1-2 forward no-symlink containment         | Reopened → V7-P1-2 | v7加入前置复验，但 last-check→path-use仍未原子绑定                                 |

V7-P1-3不是旧 source authorization finding重复：owner-first、whole-batch transaction与 ledger
anchor已闭合；它是 combined UX要消费的 strict response wire缺口。

### 9.4 第七轮 Coverage note

- `/intent` inline/Dialog、recent cards、journey、single/multi questions、Conversation/Review
  双栏与移动单栏、pinned wizard、归档/跨 tab/390px/键盘/axe/reduced-motion/i18n均复核；只有
  combined approval receipt wire新增 UX阻断。
- ACL/OCC/secret、current-owner dispatcher、final copy-only authority、disclosure admission、
  owner-before-source、attemptSeq/WS、migration/legacy/codec与 same-binary发布均无新增 finding。
- V6两项专项复证分别重新打开为更窄的 process-set与 last-check→syscall序列；boot barrier位置、
  v3 receipt/revision、strict cleanup、legacy repair语义继续成立。
- reviewer逐面读取 RFC-235四份目标文档、RFC-234 proposal/design/plan及当前
  shared/backend/frontend/E2E source/tests；memory只用于全文件/失败序列审查方法，未作当前事实
  证据。

### 9.5 下一步

以 v8 proposal/design/plan创建全新隔离 snapshot执行第八轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施；当前仍不改生产
代码。

## 10. 第八轮复审记录

### 10.1 第八轮隔离门禁

- snapshot：`a794df21d1d7fbd9b66a7981e2d7c0500925f604`
- 隔离目录：`/private/tmp/rfc235-design-gate-v8.5QEsMD/repo`
- review task：`019faacc-7b40-7e31-961e-4cc4bbf02dae`
- 模式：external Codex `--ephemeral --sandbox read-only`；未联网、未运行测试/构建、未编辑文件。
- 只读证明：review结束后隔离 repo `git status --short`为空，进程 exit 0，HEAD与 expected
  snapshot逐字相同。
- 完整 reviewer output：
  `/private/tmp/rfc235-design-gate-v8.5QEsMD/codex-design-gate-v8-output.md`
- output SHA-256：`93930b51b3bec73997d357abcf58b083ffca64b1390c56916a3a0e789d6bcbe4`
- 结论：`NEEDS_REVISION — P0=0, P1=6, P2=1`

Linux PID namespace的 kernel process-set主体机制与 strict mount receipt 已闭合。两个 P1 是
V7 process/filesystem finding 的残余必要条件；其余是 v8 platform resolution新引入的
幂等/产品冲突，或本轮端到端读取当前模型合同后暴露出的独立问题。

### 10.2 第八轮 findings 与 v9 resolution

#### V8-P1-1 — `underspecified`：empty proof trust root不能同时满足可恢复与不可伪造

失败序列：

1. supervisor READY，daemon持久化 nonce/PID namespace identity后发送 GO。
2. writer仍有 delayed descendant；daemon被 SIGKILL。
3. 若 `hostSecret` 是进程内 ephemeral key，新 daemon无法验证旧 supervisor的合法 EMPTY
   record，只能永久进入 `repair-required`。
4. 若复用当前 durable `secret.key`，同 UID进程可读取 key与 DB中的 nonce/identity；在允许
   same-UID ptrace、core/process-fd访问的支持环境中，还可取得或操纵 daemon control path，
   生成通过 HMAC/identity检查的伪造 EMPTY。
5. host据此写 `quiesced`并允许 cleanup/terminal，违反“新 daemon只凭可恢复且不可伪造
   evidence terminal”。

snapshot 证据：

- receipt保存 `completionKeyId`，但未定义 key store、轮换、销毁与 restart lookup：
  `design/RFC-235-intent-builder-ux/design.md:588-610`。
- proof key只写作未定义来源的 `HKDF(hostSecret,...,nonce)`；仅 supervisor被要求
  non-dumpable，未覆盖 host daemon、独立 same-UID process、core/ptrace/process-fd：
  `design/RFC-235-intent-builder-ux/design.md:787-818`。
- 文件 ownership清单只把现有 `secret.key`明确分配给 mutation HMAC，没有为 containment
  proof定义独立 trust root：`design/RFC-235-intent-builder-ux/design.md:1744-1769`。
- 当前 durable key只是同 UID可读的 `0600`文件：
  `packages/backend/src/auth/secretBox.ts:21-35`；源码也明确承认 mode bits不能隔离 same-UID
  agent：`packages/backend/src/db/client.ts:57-64`、
  `packages/backend/src/services/sandbox/policy.ts:4-8`。

现有 resolution/test不能阻断：`design.md:1927-1935`和`plan.md:158-190`只要求 wrong-MAC、
identity mismatch及 lifecycle内部访问失败；可用 injected test key让这些测试全绿，却没有生产
key lifecycle、daemon non-dumpable/core policy、same-UID sibling/control-fd/replay
qualification。V7 kernel process-set主体已解决，但 proof signer/verifier authority尚未解决。

Resolution v9：

- containment proof不再从 daemon/shared `secret.key`派生。supervisor先设置
  no-dump/no-core、清 env/argv/fds并锁+DONTDUMP signer memory，再在进程内生成一次性 Ed25519
  keypair；private key无 export frame、不进 daemon/disk/descendant，journal只持久化 public
  key/key id。
- persisted release record绑定 journal/attempt/artifact revision、Plugin generation、
  executionNonce、boot/start/PID namespace identity与 public key；EMPTY signature覆盖 exact release
  digest、direct leader settled与 process/error count=0。新 daemon只用 receipt公钥验签，无 key
  store/rotation/restart lookup问题；missing/wrong/replayed proof继续 repair-required。
- artifact threat model明确：能直接改 DB/app-home/executable的 unsandboxed same-UID host process
  等同 host compromise；untrusted agent/package必须在 OS containment内。与此同时 Linux
  qualification仍用无 app-state authority的 same-UID sibling实测 ptrace/process_vm_readv、
  `/proc/*/{mem,fd}`、control injection与 old-signature replay全部失败；daemon自身也在 artifact
  control fd前 no-dump/no-core。
- proposal AC-30/33、design §0.1.1/§0.5.1.2、plan T3.12/T3.15/T9.9已把 signer lifecycle、
  restart verifier和 adversarial platform test逐项映射。

#### V8-P1-2 — `conflict`：零状态 pre-accept 422无法保证旧 mutation id永久保持拒绝

失败序列：

1. Linux dynamic capability probe失败；服务端返回 definitive 422，但响应丢失。
2. 设计要求零 ledger、零 anchor、零 receipt、零后台状态。
3. 同一 daemon环境恢复，probe变绿。
4. 客户端因不知道第一次是422，只能重放 frozen body与原 `clientMutationId`。
5. 服务端没有任何证据区分它与一次新的、当前可接受请求，因而会接受；这与“旧 body/id仍返回
   同一422”冲突。

snapshot 证据：

- `design.md:741-757`同时规定“零 mutation ledger/anchor/receipt”和“同 daemon旧 body/id即使
  能力变化仍只能422”。
- `plan.md:140-146,184-190`进一步要求 fixture翻绿后旧 id仍被拒。

现有 resolution/test不能阻断：文档、schema、migration和任务清单均未指定 bounded rejection
cache/tombstone的 owner、key、生命周期、eviction及 restart语义。T3.13只断言期望结果；在声明
的零状态算法下不可实现。尤其 response loss时前端没有机会按422路径销毁旧 id。

Resolution v9：

- 删除“未接受旧 id在能力恢复后仍永久422”的不可能承诺。wire/static/dynamic capability
  validation继续在 ledger前零状态，因此没有 server-side rejection tombstone。
- 客户端确实收到 definitive 422时销毁本地 id；response丢失时保持 outcome-unknown并重放同一
  frozen body/id。若 capability后来恢复，该 id允许被**第一次接受**；从 accepted ledger claim
  开始才保证 exact replay与 effect at-most-once。
- design record-before-act/error recovery、proposal D31/AC-32、plan T3.9/T3.15均加入 known-422与
  lost-response→fixture-green测试，断言 accepted anchor唯一、副作用总数为1，不再测试不可实现的
  永久拒绝。

#### V8-P1-3 — `gap`：filesystem capability仍不能兑现 hardlink/mount/restore下的首次外部零写

失败序列：

1. broker在 canonical parent创建随机、具名 exclusive temp。
2. 同 UID进程通过目录观察，在写入前把该 temp inode hardlink到外部 sentinel。
3. broker通过已打开 temp fd写入并 fsync。
4. 后续 target `{dev,ino,nlink===1}`检查完全看不到 temp新增 link；外部 sentinel已获得 bytes。
5. journal仍可能正常发布或进入可补偿状态，但首次外部零写已经失败。

snapshot 证据：

- `writeFileAtomic`只检查最终 target identity/nlink；未要求匿名 temp，也未在每次 write前核对
  temp `nlink===1`：`design/RFC-235-intent-builder-ux/design.md:689-697`。
- public surface需要 `ArtifactEntryCapabilityV2`执行 rename/remove，却没有任何方法创建或取得
  该 capability；`writeFileAtomic`只返回 identity：
  `design/RFC-235-intent-builder-ux/design.md:650-674`。
- Linux traversal缺 `RESOLVE_NO_XDEV`，不能排除 canonical segment下的 bind mount；Darwin只用
  `O_NOFOLLOW`：`design/RFC-235-intent-builder-ux/design.md:683-688`。当前 SDK实际提供
  `O_RESOLVE_BENEATH`、`AT_RESOLVE_BENEATH`、`AT_UNIQUE`及
  `RENAME_RESOLVE_BENEATH`：
  `MacOSX26.5.sdk/usr/include/sys/fcntl.h:123-129,177-188`、
  `usr/include/sys/stdio.h:34-40`。
- current cold/pending restore在 DB/capability barrier前执行：
  `packages/backend/src/cli/start.ts:139-148,262-297`，并以裸 `rmSync/cpSync`替换整个
  canonical `skills/`：`packages/backend/src/services/restore.ts:449-465`。v8 capability
  identity只能表示单个 Plugin generation或 Skill reserve，未定义 whole-tree
  restore/bootstrap authority：`design.md:650-655,703-707`。
- embedded helper只声明 digest-sealed materialized cache，没有规定 verified-open-fd到 exec的
  不可替换绑定：`design.md:677-681,1770-1774`。

现有 resolution/test不能阻断：`design.md:1936-1944`与`plan.md:188-196`列出 sentinel矩阵，
但测试目标不能补齐缺失 primitive/API。按当前接口，hardlink temp攻击仍可通过；若 source guard
封锁当前 restore，restore会坏掉，若豁免则留下裸 canonical-root writer。以上是 V7-P1-2同一
descriptor-authority根因，只计一项。

Resolution v9：

- capability升为 V3并补齐可构造 surface：
  `createTemp/writeTemp/commitTempNoReplace|Replace/openEntry/removeTreeExact`明确产出/消费
  `ArtifactWritableTempCapabilityV3`与 `ArtifactEntryCapabilityV3`；不再有只声明、无法取得的
  entry authority。
- Linux temp固定 `O_TMPFILE`，write阶段 `nlink=0`，fsync完才 `linkat(AT_EMPTY_PATH)`/atomic
  rename且 link后不再写；Darwin private named staging对 contained child不可见，每次 write前后与
  fsync后要求 `O_UNIQUE/AT_UNIQUE + nlink=1`。traversal加入 Linux
  `RESOLVE_NO_XDEV`，Darwin beneath/no-follow-any/unique flags及每段 dev/fsid核对。
- 新 `ArtifactRestoreCapabilityV3`以 operation/archive/DB/tree digest持有 whole app generation；
  cold CLI/pending startup在 singleton lock后、DB/config/restore前先建立 verified broker，
  config/DB/whole skills staging、safety snapshot、root swap、migration/identity barrier与 old
  generation cleanup全走 phase marker + descriptor authority。source guard不给
  restore/backup/migration裸 `rm/cp/rename`例外。
- helper authority也闭合：Linux sealed memfd verified bytes + `execveat`；Darwin child在取得任何
  root dirfd前按 audit token、designated requirement/CDHash验证 actual running image，wrong/
  unsigned/open→spawn swap只得到无 authority socket。
- proposal D28/D30/AC-30/33、design §0.5.1.1/§0.5.1.3、plan
  T3.10–T3.13/T3.15/T9.9加入 anonymous/named-temp hardlink、mount crossing、restore phase crash与
  helper swap的 real-platform gates。

#### V8-P1-4 — `conflict`：Darwin主要 Plugin创建路径在方案 A 中实际不可用

失败序列：

1. macOS用户在 `/intent`选择一等展示的 Plugin。
2. Builder按当前 prompt生成正常 npm package或 git Plugin。
3. 用户完成多轮生成并到达 Review。
4. 平台此时才显示 `intent-artifact-containment-unavailable`并永久禁用 Apply。
5. 当前产品没有把本次 apply迁移到 admitted Linux host的交互，也没有从 Composer创建本地
   `file:` source的完整路径；用户无法完成该主流程。

snapshot 证据：

- macOS与Linux都是正式发布平台：`CLAUDE.md:158`。
- RFC-234承诺六类全覆盖并明确包含 Plugin：
  `design/RFC-234-intent-driven-builder/proposal.md:28-47,89-100`；Plugin安装失败属于
  all-or-nothing合同：同文件 `118-129`。
- Composer无差别展示 Plugin：`design/RFC-235-intent-builder-ux/design.md:995-1009`。
- Darwin npm/git固定 preflight reject，UI直到 Review才禁用 Apply，仅提示 `file:`或 Linux
  host：`design.md:723-737,1832-1844`。

现有 resolution/test不能阻断：T3.13/T9.9只证明安全拒绝及 managed Skill/`file:` control仍
可用：`plan.md:184-196,345-349`；没有 Darwin npm/git成功路径、入口前 capability disclosure、
remote Linux execution或明确缩减“六类完整创建”承诺。安全 fail-closed已 closed，但产品主路径
仍是 P1阻断。

Resolution v9：

- 产品承诺改为“六类 schema-supported；六类 create→apply完整闭环当前只承诺 admitted Linux；
  Darwin只承诺 strict capability DTO中 enabled路径”，不再把 schema parity冒充 platform parity。
- 新 strict `IntentArtifactCapabilitiesDto`在 generation前同时供 Composer与每轮
  `INTENT.md`。Darwin Plugin card保持可见但 disabled，带可访问的 npm/git unavailable reason；
  URL hint/快捷入口不能绕过或静默回 Auto。Auto/明确自然语言 Plugin目标也看到同一受信 capability，
  必须问回/解释而非生成死 op。
- Review preflight仍拒绝 capability drift，但只是 defense in depth。`file:`仅在已有 concrete、
  actor-selected source时可用；模型不得发明路径。
- proposal G2/D32/AC-4/32、design §0.2.1/§1.4与 plan T5/T6/T9明确了前置 UX、Linux六类 fixture和
  Darwin negative E2E。

#### V8-P1-5 — `conflict`：模型看到的 Plugin/Workflow payload合同与 strict parser不一致

失败序列：

- Plugin：模型按 authoritative prompt输出 `{name,spec,options}`并省略被标成 optional的
  description；strict parser因 unknown `options`及 missing `description`拒绝为
  `intent-changeset-invalid`。
- Workflow：用户要求产生最终结果的 workflow；模型按 prompt生成 `{id,kind:'output'}`并把
  edge接入该 node。prompt没有要求 output `ports:[{name,bind}]`，canonical validator以
  `edge-target-port-missing`拒绝。

snapshot 证据：

- prompt宣称字段 STRICT，却把 Plugin写成 `{name,spec,description?,options?}`，output node只写
  `{id,kind:'output'}`：`packages/backend/src/services/intent/intentDoc.ts:132-153`。
- 实际 Plugin schema要求 `description`，只接受 `optionsJson`：
  `packages/shared/src/schemas/intentChangeset.ts:254-263`；resolver才将其转为 canonical
  `options`：`packages/backend/src/services/intent/resolveChangeset.ts:518-525`。
- output target port必须在 node `ports`中声明：
  `packages/backend/src/services/workflow.validator.ts:687-698`；当前有效 starter也携带
  `ports`：`packages/frontend/src/lib/workflow-starters.ts:158-179`。
- RFC-235明确把 prompt/output schema排除在修改范围外：
  `design/RFC-235-intent-builder-ux/proposal.md:140-148`。

现有 resolution/test不能阻断：`rfc234-intent-doc.test.ts:56-77`只检查通用关键词；apply测试
手写正确 Plugin payload，Workflow fixture没有 output edge：
`rfc234-apply-changeset.test.ts:155-204`。canonical rejection测试只证明错误被 typed
settlement，不证明 prompt可生成合法对象：同文件 `637-679`。固定 E2E stub也永远返回一个
Agent：`e2e/fixtures/stub-opencode-intent.sh:38-42`。

Resolution v9：

- RFC-235不再把 prompt修正列为非目标。新增
  `INTENT_MODEL_CONTRACT_VERSION=2`与 shared六类 field tables/examples；prompt renderer消费同一
  source，六 example逐个通过 strict changeset schema、resolver与 canonical validator。
- Plugin prompt固定 `{name,spec,description,optionsJson?,enabled?}`；`description`必需，删除
  `options?`。Workflow output example固定
  `ports:[{name,bind:{nodeId,portName}}]`并包含 matching edge target port。
- golden/source guard禁止旧 `description?/options?`或无 ports output example回归；E2E stub改为
  实际读取 `INTENT.md` contract/hint并按六类返回 strict-valid changeset，不再固定 Agent。
- proposal G21/D33/AC-31、design §0.2.1/§11与 plan T1.11/T9.3形成从 prose到 parser/kernel的
  可执行链。

#### V8-P1-6 — `gap`：Artifact hint从 UI到模型的 wire确定性断路

失败序列：

1. 用户在 Composer选择 Plugin或 Workflow。
2. POST携 `hint`，service把它写入首个 turn。
3. 构造 `INTENT.md`时 `turnDisplayText()`对 message只返回 `content.message`。
4. hint既不在 session title，也不在 history文本，模型完全看不到该选择；类型卡成为无效果控件。

snapshot 证据：

- shared schema把 hint定义为产物类型 nudge：
  `packages/shared/src/schemas/intentSession.ts:14-32`。
- service仅把它保存进首轮 `contentJson`：
  `packages/backend/src/services/intent/session.ts:94-102,158-170`。
- history renderer丢弃 hint：
  `packages/backend/src/services/intent/turnEngine.ts:112-128`；`INTENT.md`只消费该 renderer结果：
  同文件 `336-387`。
- RFC-235只计划 frontend payload/helper测试：
  `design/RFC-235-intent-builder-ux/design.md:1954-1957`、
  `plan.md:252-268`，没有模型输入合同改动。

现有 resolution/test不能阻断：Composer DOM测试最多证明 POST含 hint；固定 Agent E2E stub不读
`INTENT.md`。当前 plan没有 backend test断言 selected hint出现在模型 seed/prompt，因此全部所列
UI/E2E验收可绿而控件仍是 no-op。

Resolution v9：

- shared `IntentArtifactHintSchema`固定六类；Auto仍为 wire omitted。create transaction把 hint
  原子写入 immutable `intent_sessions.artifact_hint`，modify/legacy为 null且后续 turn不可改。
- `IntentDocInput`新增 `requestedArtifactHint/artifactCapabilities`；`buildIntentDoc`在 fenced
  user/resource文本之外渲染 trusted section。hint明确为弱偏好，用户自然语言明确目标优先；
  capability是硬限制。
- backend覆盖 body→session→每轮 INTENT.md、Auto/modify/null、明确目标覆盖弱 hint；六类 E2E
  stub读取文档后按 hint分支，故 ChoiceCard不可能只在 POST测试中“有值”却对模型无效果。
- proposal G21/D33/AC-31、design §0.2.1/§1、plan T1.1a/T2.8a/T6/T9.3逐层映射。

#### V8-P2-1 — `conflict`：短视口、软键盘与 touch验收未进入可执行计划

失败序列：

1. 390px宽、约568px高或软键盘展开状态打开 create/commit Dialog。
2. footer、Stepper action或当前输入被 visual viewport压缩；touch用户无法稳定触达 CTA。
3. 1280×800、390×844、keyboard与axe门禁全部通过，因为没有短高度或 touch-only scene。

snapshot 证据：

- proposal明确承诺“390px + 虚拟键盘近似高度测试”：
  `design/RFC-235-intent-builder-ux/proposal.md:473-480`。
- CSS虽使用 `100dvh`与单滚动区：
  `design/RFC-235-intent-builder-ux/design.md:1676-1709`，但正式 browser gate只有1280×800与
  390×844：同文件 `2059-2062`。
- 实施计划同样只列390×844与 keyboard/axe，没有短视口、visual viewport、touch target或
  touch interaction：`design/RFC-235-intent-builder-ux/plan.md:325-344`。

现有 resolution/test不能阻断：`100dvh`是实现意图，不是触达证明；keyboard focus测试也不覆盖
触摸目标尺寸、软键盘 resize/overlay或短横屏。proposal风险承诺未映射到 task/scene，实施时可
被完整漏掉。

Resolution v9：

- CSS合同明确 create/commit Dialog都响应 dynamic `100dvh`，缩高时 header/footer不 shrink，只有
  声明的 body/Stepper body滚动；focused field可滚入 visual viewport，CTA与 safe-area持续可达。
- coarse pointer下 ChoiceCard、示例、question/mount choice与 Dialog/Stepper actions至少
  44×44 CSS px、相邻8px。
- Playwright新增390×568 `hasTouch:true` light/dark scene，并在 Dialog已打开且 field聚焦后从
  390×844动态 resize到390×568近似软键盘；以 tap、bounding rect/`elementFromPoint`、
  scroll-owner与 `scrollWidth===clientWidth`验证 create/commit field与 CTA无 overlay。
- proposal AC-6/风险、design §8/§11.5、plan T9.1/T9.7/T9.8均有同一可执行 gate。

### 10.3 第七轮 resolution audit（第八轮裁决）

- V7-P1-1 的 kernel process-set主体已闭合：fresh private PID namespace覆盖 `setsid`、
  double-fork及 nested namespace；READY阶段禁止 child/bytes，persist CAS后才 GO；
  normal/EOF/timeout/cancel/watchdog统一 TERM→KILL→reap；boot-id/start-ticks/PID namespace
  identity阻止 PID reuse猜测。剩余仅为 V8-P1-1 proof trust root。
- 本机 SDK事实成立：`NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD`自 macOS 10.5不再支持。Darwin不以
  该 primitive伪造 parity是正确安全结论。
- Darwin npm/git在 ledger/journal/leaf/child前 fail closed，managed Skill与 `file:` Plugin保持
  可用的安全合同明确；V8-P1-4只针对产品承诺，不重复计算安全 finding。
- V7-P1-2 中禁止裸 caller path/raw fd/callback、child只见 exact leaf、应用锁不能充当
  filesystem proof的方向已闭合；V8-P1-3是 capability surface、temp inode、mount与 restore
  bootstrap仍未闭合的同一残余，只计一次。
- V7-P1-3已完整 Closed：strict discriminated schema拒绝 missing/extra/unknown；HTTP、ledger、
  detail content及 outer turn id/seq同形；results source-order等长；整批 transaction至多一次
  revision/turnSeq推进；combined flow只消费 exact `resultingTurnSeq`，响应丢失绝不猜 history。

### 10.4 历史 findings 继续闭合项

- owner-first source authorization、route-independent current-owner dispatcher、disabled
  user/role settlement、final target/copy-only authority继续闭合。
- normalized branded object、owner-scoped mutation namespace、domain HMAC、legacy
  tombstone/MAX migration与 secret carrier继续闭合。
- create/manual same-transaction active/ACL/OCC、apply attemptSeq/WS/reconnect、
  archive/apply交错与 final transaction fence继续闭合。
- exact artifact receipt/revision、`compensating|repair-required`、reverse cleanup、boot
  barrier及 failed不可早于 verified cleanup的 DB状态机已闭合；仅 process proof authority与
  filesystem primitive由 V8-P1-1/V8-P1-3阻断。
- strict outer DTO、actor-safe mount projection、长 Owner不省略、archive/admin audit只读、
  secret request私有 ref/navigation guard继续闭合。
- 方案 A主要布局与状态投影完整：inline/Dialog同源、示例、最近会话、
  Goal/Generate/Review/Apply、桌面双栏/移动单栏、questions/mount/continue、review/commit、
  loading/error/reconnect均有明确 view owner与失败语义。开放项是模型合同、Darwin Plugin可用性
  与短视口验收，不是这些布局条款的重复。

### 10.5 下一步

本轮 6 P1 + 1 P2已逐项折入 v9 proposal/design/plan，`STATE.md`与总
`design/plan.md`也已同步为第八轮未通过与 v9 resolution。下一步创建全新隔离 snapshot执行
第九轮只读门禁；只有
reviewer判定 `APPROVED — P0=0, P1=0, P2=0` 才更新 RFC为设计门通过并请求用户明确批准实施。
当前仍不改生产代码。

## 11. 第九轮复审记录

### 11.1 第九轮隔离门禁

- snapshot：`9457d2859e76a91462e8565be7ed31fa5c879b42`
- 隔离目录：`/private/tmp/rfc235-design-gate-v9.jbtsTF/repo`
- reviewer session：`019fab14-6b97-7572-90ff-6ea83021d90a`
- 模式：external Codex `gpt-5.6-sol`、max reasoning、
  `codex exec --ephemeral --sandbox read-only`；未联网、未运行测试/构建、未编辑文件。
- 只读证明：review结束后隔离 repo `git status --porcelain=v1`为空，进程 exit 0，HEAD与
  expected snapshot逐字相同。
- 完整 reviewer output：
  `/private/tmp/rfc235-design-gate-v9.jbtsTF/codex-design-gate-v9-output.md`（171行）。
- output SHA-256：`66c8f731852d8069ece7638561deeffe17c9fcf9e17022bba89a20d8664e7399`
- 结论：`NEEDS_REVISION — P0=0, P1=5, P2=0`

方案 A 的整体 UX、ACL/OCC、secret、model contract、短视口等主体继续闭合。本轮五项均为跨层
正确性合同：accepted replay顺序、Skill目录发布 authority、restore跨 generation writer
obligation、live staging代理，以及 mounted `file:` exact source binding。

### 11.2 第九轮 findings 与 v10 resolution

#### V9-P1-1 — `conflict`：accepted commit replay会被 capability preflight抢先拒绝

失败序列：

1. Linux capability为 green，commit `M/body`已完成 ledger claim并被服务端接受。
2. HTTP response丢失。
3. capability随后变 red。
4. 前端按 frozen `M/body` exact replay。
5. 通用幂等合同要求先查 ledger并返回原 anchor；artifact章节却要求先跑 capability
   validation，于是返回 definitive 422，前端销毁 `M`，失去唯一的 accepted receipt reconcile
   路径。

snapshot 证据：

- 统一协议明确 ledger在 freshness/capability后续状态之前，exact replay不受后续状态影响：
  `design/RFC-235-intent-builder-ux/design.md:391-395`。
- commit claim同样规定 ledger replay first，仅新 id运行 fresh gates：
  `design/RFC-235-intent-builder-ux/design.md:597-609`。
- artifact章节却把顺序固定为 normalize/HMAC → capability validation → ledger claim，并要求
  422后销毁 id：`design/RFC-235-intent-builder-ux/design.md:930-949`。
- plan保留了同样矛盾：通用顺序在 `plan.md:76-79`，preflight-before-ledger在
  `plan.md:154-160`。

原有测试不能阻断：一组只覆盖“第一次请求从未 accepted，red→green后原 id首次 accepted”，
另一组只覆盖 accepted response丢失后 refetch，没有在 replay前把 capability翻 red。

Resolution v10：

- commit固定为 immutable owner gate → strict parse → 唯一 normalize/HMAC → owner-scoped ledger
  lookup；existing exact沿 typed anchor返回，不读取 current capability，mismatch/corrupt/
  legacy仍 fail closed。
- 只有 absent id才运行 pure static matrix validation与 zero-write dynamic probe。probe返回
  daemon-local、短寿命、不可序列化的 `ArtifactAdmissionLeaseV1`，绑定 boot id、provider
  revision、normalized op kinds和 expiry。
- claim transaction再次先查 ledger；若仍 absent才验证 lease并原子插入 ledger+journal，关闭
  probe→claim race。accepted后 capability漂红只驱动 anchored journal typed收敛，不把 replay
  改成422。
- proposal D34/AC-34、design commit/artifact protocol与 plan T2.1/T3.9/T4/T9.4形成同一顺序和
  组合回归。

#### V9-P1-2 — `gap`：V3 API没有 Skill目录 publication primitive

失败序列：

1. Intent创建 managed Skill。
2. `stageManagedSkill`创建文件并调用 `commitSkillVersion`。
3. `commitSkillVersion`必须把完整 staged directory发布为 canonical `files/`。
4. 当前实现依赖 `files→backup`、`staged→files`两次目录 rename及恢复/清理。
5. 新 source guard禁止 raw path rename，但 v9 `ArtifactFsCapabilityV3`只有 file temp
   commit/open/remove，没有 directory publication方法；实施只能阻断 Skill apply、绕过 V3，
   或另造未审查 authority。

snapshot 证据：

- V3 public surface只有 `mkdir/openDir/openEntry/createTemp/writeTemp/commitTemp*/
removeTreeExact`：`design.md:787-835`。
- 文档却要求 `skillFsPublish`、version/import/ZIP/fusion/recovery全部只走该 capability：
  `design.md:892-896`。
- plan把缺少目录 publication的方法列为“固定” public API：`plan.md:167-177`。
- file replace也只返回一个未区分角色的 entry capability，正文却要求 exchange后 old target仍有
  exact cleanup authority：`design.md:828-834,872-890`。

原有 API contract test无法创造 public surface中不存在的 directory operation，也无法判定
单一返回 capability代表 published还是 displaced entry。

Resolution v10：

- 新增 `ArtifactTreeWriterV3`、`ArtifactSealedTreeCapabilityV3`：
  `createTree → mkdir/writeFile → seal`在 broker-private namespace完整 materialize，逐文件/
  directory fsync并验证 digest；seal后 writer失效。
- 新增 public `commitTreeNoReplace`与
  `commitTreeReplace(RENAME_EXCHANGE|RENAME_SWAP)`；file/tree replace统一返回
  `ArtifactExchangeResultV3 {published, displaced}`，两个 role不可互换。
- durable `ArtifactPublicationReceiptV3`在 publication前记录 operation id、canonical slot
  role、staged/expected identity；exchange后记录 published/displaced identity。crash只按 exact
  receipt resume；displaced absent前 operation不得 complete。
- Skill version/import/ZIP/fusion/recovery改接 sealed tree authority；raw path source guard与
  staged→exchange、exchange→receipt、cleanup前真 crash矩阵进入 AC-35/T3.10/T9.9。

#### V9-P1-3 — `underspecified`：restore替换 DB后会丢失旧 writer obligation

失败序列：

1. backup `B`创建后，一个 npm/git Intent apply进入 `writer.phase='released'`；public key/
   release identity只在当前 live DB journal。
2. daemon被杀，旧 supervisor仍在收口 descendants并准备 signed EMPTY。
3. startup应用旧 backup `B`，先替换 DB，再运行 Intent artifact recovery。
4. Plugin generations不属于 restore generation；旧 generation和可能仍活的 writer留在磁盘，
   但 restored DB没有对应 receipt/public key。
5. boot barrier既无法发现 obligation，也无法验签 EMPTY或标记 `repair-required`，却可能继续
   开放 HTTP/GC/workers。

snapshot 证据：

- restart verifier只从 `released` receipt中的 public key验签：
  `design.md:1010-1019`。
- restore顺序是 restore generation → open/migrate restored DB → Intent artifact recovery：
  `design.md:1050-1059`。
- restore authority只交换 DB、config与 whole Skill tree，没有 Plugin generation或旧 Intent
  obligation carrier：`design.md:1039-1046,1077-1088`。
- 当前 backup只 materialize DB/config/skills/workflows：
  `packages/backend/src/services/backup.ts:99-161`。

原有 writer crash矩阵和 restore phase矩阵互相独立，没有覆盖
released writer未 EMPTY → DB restore到更早快照 → artifact barrier。

Resolution v10：

- verified broker独占 `ArtifactWriterObligationLedgerV3`，持久化 exact journal/artifact
  revision、Plugin generation、supervisor public key/key id、release identity与 phase；该
  broker-control ledger不进入 backup，不随 DB/config/Skill tree generation swap。
- release时先 fsync external obligation，再 CAS DB receipt；两边 exact匹配才发送 GO。单边
  durable crash按 obligation + DB保守恢复，不把缺一边解释为无 writer。
- startup在 pending DB swap前先扫描 obligation ledger并使所有 released writer quiesced；swap后
  open/migrate restored DB，再把 external obligations、restored DB rows和 current Plugin
  generation inventory合并，exact cleanup或 repair。
- obligation/cleanup/repair未收口前禁止 HTTP、Plugin GC与workers；组合 crash矩阵进入
  D36/AC-36/T3.12–T3.14/T9.9。

#### V9-P1-4 — `gap`：daemon运行时的 `restore --stage`没有合法 broker/capability路径

失败序列：

1. daemon持有 singleton lock。
2. 管理员执行当前支持的 `agent-workflow restore … --stage`。
3. v9规定 restore authority只能由取得 singleton lock的 cold CLI或 startup mint。
4. live CLI拿不到 lock；broker只有 anonymous socketpair，没有可发现 RPC。
5. CLI只能裸写 `.restore-pending`、让产品路径失败，或另造未审查 delegation协议。

snapshot 证据：

- 当前 CLI声明 `--stage`可在 daemon运行时执行：
  `packages/backend/src/cli/restore.ts:71-87`。
- 当前 staging真实执行 mkdir、copy tarball和写 marker：
  `packages/backend/src/services/pendingRestore.ts:123-155`。
- v9只允许 cold CLI/startup在 singleton lock后 mint authority：
  `design.md:1050-1058`。
- broker不监听 filesystem socket，只使用 anonymous authenticated socketpair：
  `design.md:841-845`。
- `pendingRestore`属于不得保留裸 writer的 source-guard inventory：
  `design.md:1084-1088`。

原有矩阵只覆盖 cold CLI与已 staged后的 pending startup，没有覆盖 live staging动作、认证、
并发 cancel/replace或独立 pending-stage capability。

Resolution v10：

- 新增 `PendingRestoreStageCapabilityV3`。HTTP route只调用 daemon-owned stage service；root
  dirfd/path不离开 daemon。
- live CLI使用独立 local admin Unix control socket；socket目录0700、socket 0600，server按
  `SO_PEERCRED/getpeereid`、same admin UID、daemon boot nonce与 strict length-delimited frame
  验证。CLI以 `SCM_RIGHTS`传已打开 archive fd，并绑定 archive digest/options。
- stopped CLI先取得 singleton lock，再启动同一 verified broker并使用同一 stage service。
  stage/cancel/status共用 exact id/revision receipt；payload/metadata先 fsync，marker最后原子
  publish并 fsync parent。
- peer/boot/fd-digest篡改、daemon stop/start、并发 stage/cancel与 response loss进入
  D37/AC-37/T3.13/T9.9。

#### V9-P1-5 — `underspecified`：`file:` capability没有绑定 actor选择的具体 source

失败序列：

1. Darwin用户创建 actor-visible `file:` Plugin `P`，再从资源快捷入口进入 Intent。
2. model capability只得到 `withConcreteSource=true`，dump暴露 `P.spec`。
3. untrusted model输出 Plugin copy/create，却把 `spec`改为另一个 host path。
4. strict changeset接受任意非空 `spec`；copy resolver规范化成 create并丢失 source manifest
   identity。
5. 若 apply按 payload打开路径，模型获得未由 actor选择的 host read authority；若一律拒绝，
   则文档宣称 enabled的 Darwin `file:`路径不可执行。

snapshot 证据：

- DTO只有布尔 `withConcreteSource`，没有 resource id、manifest handle、fence或 exact spec
  digest：`design.md:302-323`。
- 文档要求 `file:`只能读取用户明确选择的源：
  `design.md:898-900,917-920`。
- 当前 wire只携任意 raw `spec`：
  `packages/shared/src/schemas/intentChangeset.ts:254-263`。
- mounted Plugin dump把 raw spec交给模型：
  `packages/backend/src/services/intent/dumpBuilder.ts:375-387`。
- Plugin update强制 copy-only；resolver变 create后不保留 manifest entry：
  `packages/backend/src/services/intent/applyChangeset.ts:124-147`、
  `resolveChangeset.ts:424-433,594-602`。

原有测试只要求 `file:` control成功且源不删除，没有
source=P、payload.spec≠P.spec在任何 open前拒绝的合同。

Resolution v10：

- `IntentArtifactCapabilitiesDto`升级 v2，Plugin `file.concreteSources`只投影 session-scoped
  `{handle, displayName, bindingDigest}`；raw `spec/cachedPath/resourceId`不进模型。
- shared model contract升级 v3。Plugin package source严格为
  `{kind:'package',spec}`且只允许 npm/git；mounted file source严格为
  `{kind:'mounted-file',handle}`，unknown field和 raw path/spec均拒绝。
- create/mount transaction为 actor-selected source分配 opaque handle，并在 server-only manifest
  detail持久化 `sourceKind/operationConfigHash/specHmac`。dump只渲染 handle/display/fence digest。
- resolver/final transaction按 handle重读 current exact source、owner/ACL/source kind/
  operation hash/spec HMAC fence，随后由 broker mint read-only source capability；任一漂移在
  `realpath/open`前 fail closed，源不可被删除或改写。
- proposal D38/AC-38、design model/capability/source boundary与 plan T1.11/T2.8a/T3.9/T9.3–T9.4
  形成 raw-path negative chain。

### 11.3 第八轮 resolution audit（第九轮裁决）

- V8-P1-1正常 restart trust root已闭合：threat boundary区分 contained child与 host
  compromise；daemon/supervisor no-dump/no-core、signer memory、READY public key、release
  CAS、GO与 signed EMPTY顺序明确。跨 restore obligation只计 V9-P1-3。
- V8-P1-2已删除“零状态却永久拒绝旧 id”的不可能承诺；definitive 422、response loss、
  red→green首次 accepted语义闭合。accepted replay顺序冲突单列 V9-P1-1。
- V8-P1-3的 Linux `O_TMPFILE`/no-XDEV、Darwin private staging/nlink/dev/fsid与 verified helper
  顺序闭合；目录 surface、restore组合及 live staging分别单列 V9-P1-2/3/4。
- V8-P1-4的 Darwin npm/git产品承诺已诚实收窄，Composer前 strict capability、Plugin card/
  URL hint/Auto不能绕过。具体 `file:` source authority单列 V9-P1-5。
- V8-P1-5已闭合：shared model examples、Plugin required description/`optionsJson?`、Workflow
  output ports+matching edge及 golden/source guard共用 owner；v10只把 source union版本升级为
  v3以承接 mounted handle。
- V8-P1-6已闭合：hint从 strict enum进入 immutable session，再经 `IntentDocInput`进入 trusted
  section；弱 hint、明确目标、hard capability优先级清楚。
- V8-P2-1已闭合：390×844聚焦后动态缩到390×568、`hasTouch:true`、create/commit、单 scroll
  owner、hit-test、44px、safe-area、light/dark与 tap均进入正式 gate。

### 11.4 历史 findings 继续闭合项

- 方案 A主 UX继续覆盖 inline Composer、同源 Dialog、示例、产物卡、最近会话、阶段轨、桌面
  双栏/移动单栏、questions、mount approvals、continue、Review/commit、loading/error/
  reconnect/archive/audit。
- owner-first source authorization、current-owner dispatcher、disabled user/role settlement、
  final target/copy-only authority继续闭合。
- normalized mutation HMAC与 Ed25519 containment proof保持独立信任链；owner namespace、
  domain-separated HMAC、legacy/MAX migration和 secret carrier未被放宽。
- create/manual same-transaction ACL/active/OCC、strict mount receipt、apply ordering、WS/
  reconnect、archive/final active CAS与 actor-safe projection继续闭合。
- 前八轮33个历史标签按根因去重后，只有 mutation replay族的 V9-P1-1、artifact族的
  V9-P1-2/3/4及 platform source族的 V9-P1-5残余；五项失败序列和必要修复彼此独立。

### 11.5 下一步

本轮 5 P1已逐项折入 v10 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 17. 第十五轮独立设计门（2026-07-29）

### 17.1 隔离执行证据

- snapshot root：`/private/tmp/rfc235-design-gate-v15.xePQvj`
- snapshot repo：`/private/tmp/rfc235-design-gate-v15.xePQvj/repo`
- snapshot commit：`0afc2aaf4016869b8c5c84cbcdfa53fdfa7cec0c`
- parent/base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- reviewer：external Codex v0.146.0，`gpt-5.6-sol`，reasoning `max`，
  `--ephemeral --sandbox read-only`
- reviewer session：`019fac5b-ee43-7563-9111-764eed5bb17b`
- raw output：
  `/private/tmp/rfc235-design-gate-v15.xePQvj/codex-design-gate-v15-output.md`
- raw output：138 行、12,221 bytes，SHA-256
  `958fa8eca98d2bbc3e64d12726066bcb0242a7cc788a525c361d029ff380f122`
- process exit：0；reviewer token usage：1,140,897
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=3, P2=0`
- reviewer起止均确认 `HEAD`为指定 commit且
  `git status --porcelain=v1 --untracked-files=all`为空。snapshot内 proposal/design/plan/gate/
  `STATE.md`/总 `design/plan.md`与门禁前真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、总 `design/plan.md`、RFC-234/235
  proposal/design/plan及此前全部 gate记录；超长单行以固定字符区间补读到 EOF。随后只读核验
  current Intent shared/backend/frontend、restore/startup、backup/worktree/Git source与 tests。
  未运行测试/build、未联网、未写 source/doc。

### 17.2 结论与闭合范围

第十五轮确认：

- V14-P1-1 的 rename前 durable target publication主体 Closed：
  `declared/moving`已在 effect前绑定 source、parents、opaque target与 absent proof，target-only
  可补 moved receipt。本轮 cleanup finding发生在更晚的 `cleaning`，不是重复计数。
- V14-P1-2 的 declaration后零目录 effect、reservation-null逐层 cleanup、纯 absent baseline的
  Git not-started与 single-existing typed skip主体 Closed。
- active-pair operator gate、no-replace directory publication、方案 A完整 Goal/Generate/
  Review/Apply UX、inline Composer/同源 Dialog、responsive/touch/a11y、长 Owner、secret与 pinned
  draft没有新增阻断。
- RFC-234 ACL/OCC/copy-only/secret/all-or-nothing、current-owner dispatcher、final authority、
  mutation idempotency及 atomic mount approval没有新增冲突。
- 残余 3 个 P1仍是 recovery terminal algebra/strict durable codec缺口；不要求改变产品 UX范围。

### 17.3 第十五轮 findings 与 v16 resolution

#### V15-P1-1 — `conflict`：`cleaning`删除后的合法 neither被错误归类为 repair

失败序列：

1. reapply hold已 moved，V3 restore terminal且 cleanup verified。
2. ledger fsync `phase='cleaning'`。
3. exact target remove与 target-parent fsync成功。
4. 进程在 `phase='cleaned'` checkpoint前被杀。
5. restart看到 source absent、target absent；这是 cleanup唯一正常 after-state。
6. v15统一 discovery却把任何 neither都写为 repair，无法构造 cleaned。

source-backed证据：

- v15 cleaning/cleaned类型与 API：
  `design/RFC-235-intent-builder-ux/design.md:2040-2071`（v15 snapshot）。
- v15顺序明确是 cleaning → remove/fsync → cleaned：
  `design/RFC-235-intent-builder-ux/design.md:2228-2230`（v15 snapshot）。
- v15把不区分 phase的 neither一律 repair：
  `design/RFC-235-intent-builder-ux/design.md:2234-2236`、
  `proposal.md:738-748`（v15 snapshot）。
- released pending cleanup也存在 delete与后续收口分离的真实窗口：
  `packages/backend/src/services/pendingRestore.ts:241-248`；startup在 DB open前执行 pending
  barrier：`packages/backend/src/cli/start.ts:122-158`。

业务影响：已经成功的显式 reapply可因正常 kill/断电永久进入 repair，无法完成 hold cleanup；
实现若继续只能伪造 cleaned receipt。

Resolution v16：

- `LegacyPendingMoveAbsentProofV3`增加
  `purpose:'pre-move-target'|'post-cleanup-target'`与 phase revision，两类 proof不可互换。
- cleaned改持有 `LegacyPendingMoveCleanupEvidenceV3`，绑定同一 publication/cleaning revision、
  moved target identity、source/target absent observations、post-cleanup target proof与
  target-parent re-fsync。
- discovery改 phase truth table：moving只接受 source-only/target-only before/after；moved只接受
  exact target-only；cleaning的 target-only重试 remove，exact neither补 cleanup evidence并
  roll forward；cleaned只接受 exact neither。source reappear/both/replacement仍 repair。
- kill immediately after remove、parent fsync后/cleaned前、settled response-loss cleanup replay，
  以及 source reappear/target replacement/foreign proof进入 T3.13/T3.15/T9.9。
- 进入 G41、D57、AC-57。

#### V15-P1-2 — `gap`：worktree terminal compensation仍非全域

三个反例属于同一根因：

1. operation-created root/namespace的 disposition是 created-infrastructure；后续失败时策略要求
   shared infrastructure永不删除，但 cleanup union只有 closed-absent、removed与只接受原
   `phase='existing'`的 existing-retained，无法 terminal。
2. before是 unique-stale；adapter exact移除 stale registration后、Git尚未形成新 effect即失败。
   current observed absent不再等于原 before，不能构造 none；又没有 registered after。
3. Git add可能只形成 branch/ref、registration或 partial admin directory。v15只有
   not-started/完整 unique/ambiguous与 `none|registered`，无法保存并逆转唯一可归属 partial delta。

source-backed证据：

- v15 infrastructure dispositions与 cleanup union：
  `design/RFC-235-intent-builder-ux/design.md:2597-2610,2834-2870,3087-3091`。
- v15 unique-stale/no-effect结构与算法：
  `design/RFC-235-intent-builder-ux/design.md:2637-2657,2732-2746,3180-3199`。
- 当前代码明确说明并发 `git worktree add`可留下 partially initialized registration：
  `packages/backend/src/services/scheduler.ts:6310-6314`；普通 add非零直接抛出：
  `packages/backend/src/util/git.ts:706-719`；optional restore把 add非零转 skip：
  `packages/backend/src/services/worktreeBackup.ts:229-238`。

业务影响：optional worktree recovery无法生成真实 skipped receipt，会停在 compensating/repair并
阻断 startup barrier，或迫使实现把 retained/partial effect伪造成 absent/existing/registered。

Resolution v16：

- terminal cleanup新增 `created-infrastructure-retained`，只允许同 reconstruction发布、identity仍
  匹配、role为 worktrees-root/layout-namespace且 shared policy要求保留；container/target禁止。
- unique-stale成为 add前独立
  `already-absent | stale-removing | stale-removed | stale-retained | repair-required`
  preparation。remove前先 checkpoint cleanup attempt及唯一 expected-target admin entry的
  parent/leaf/identity，成功后 effective registration baseline固定 absent；kill可从 exact
  stale-present/absent admin delta收敛；remove effect前 cancel/明确未开始且 original inventory
  未变时以 `stale-retained + before-git none`清 target并 terminal skip。already-absent或
  stale-removed到 add intent之间取消或 baseline未变的 typed failure时，先写无 add intent的
  `effective-absent + before-git none`及 compensating checkpoint，再清 target terminal，不回造
  stale registration；任何 snapshot drift仍 repair。
- add syscall前保存 `GitWorktreeAddIntentV3`：addAttempt、target empty、effective registration、
  branch、bounded canonical repo-admin inventory及经 Git-version qualification可预声明的 exact
  admin-slot absent intent；deterministic naming/inventory cap在 directory declaration前对全部
  repos资格化，无法唯一声明或超 cap时零 effect typed skip。discovery变为
  `not-started | partial | registered | ambiguous`；Git非零也必须 discovery，不能直接假 no effect。
- partial effect逐项保存 branch-only、registration-only、predeclared admin slot内
  expected-target entries/target delta，先 checkpoint再按 target→admin/registration→branch逆序
  补偿并持久化 per-component progress；unrelated/unbounded/ambiguous delta只 repair。
- retained infrastructure、unique-stale remove前后、branch/registration/admin/target partial、
  multi第 N repo、first-fail/second-success与 foreign replacement fixtures进入
  T1.7/T3.13a/T3.15/T9.9。
- 进入 G42、D58、AC-58。

#### V15-P1-3 — `underspecified`：strict codec未排除 nested伪造与矛盾 receipt

按 v15逐字实现 union与已列 superRefine，仍可接受：

- move outer id匹配，但 target absent proof的 publication/parent/slot来自另一 publication；
- `sameInodeAsSource:true`但 moved target identity不等于 source；
- source/target fsync的 publication/parent/filesystem错配；
- cleaned removed identity不等于 moved target；
- worktree closed-absent observation引用另一 publication/fence/parent/leaf/private slot；
- removed identity不等于 publication中 selected private/canonical identity。

source-backed证据：

- v15 legacy evidence与唯一列出的 operator-level refine：
  `design/RFC-235-intent-builder-ux/design.md:1977-2050,2157-2164`。
- v15 worktree intent/observation/publication与高层 phase refine：
  `design/RFC-235-intent-builder-ux/design.md:2458-2547,3081-3099`。
- plan宣称 strict codec但没有逐字段负例：
  `design/RFC-235-intent-builder-ux/plan.md:64-84`。

业务影响：producer与consumer都可“遵循文档”却对同一 durable row得出不同结论；startup无法在
filesystem discovery前 deterministic fail closed。

Resolution v16：

- 明确定义 `.strict()` 的 `ArtifactEntryIdentityV3Schema`与两个用途封闭的共享 comparator：
  immutable receipt snapshot使用 `artifactEntrySnapshotEqual()`比较 dev/ino/mode/nlink/fsid，
  mutable directory重验使用 `artifactEntrySameObject()`比较 dev/ino/fsid/file type，consumer
  不得自选字段。
- 明确定义 `.strict()` 的 `LegacyPendingMovePublicationV3Schema`、
  `WorktreeDirectoryReservationPublicationV3Schema`、registration preparation/effect schemas及
  顶层 receipt schema。
- `superRefine`逐字段绑定 nested publication/reconstruction/action id、role、parents、slot、
  descriptor fence、same-inode identity、fsync filesystem/observation、removed identity与 absence
  observation；顶层嵌套引用再次 safeParse。
- 每个字段替换另一合法值、foreign same-inode claim、swapped fsync、foreign removed/absent proof
  以及 stale cleanup intent entry/digest、before-git baseline/preparation/addIntent矛盾均须在
  descriptor open/discover/remove/checkpoint/DB open前失败。
- 进入 G43、D59、AC-59、T1.7/T1.9/T3.13/T3.15/T9.9。

### 17.4 v15 finding coverage audit

| Finding  | v16 public contract owner                          | Crash/replay proof                                                | 产品可达性                                    |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| V15-P1-1 | phase truth table + cleanup evidence               | remove/fsync后 neither roll forward；foreign proof fail closed    | explicit reapply不因正常 kill永久 repair      |
| V15-P1-2 | retention + registration prep + partial effect     | shared retain、pre-add no-effect、partial delta逐点 kill/逆序补偿 | optional worktree真实 skipped、不阻断 startup |
| V15-P1-3 | strict nested schemas + canonical identity compare | per-field合法替换在任何 FS/DB effect前 safeParse失败              | producer/consumer对 durable row结论一致       |

前一轮 finding复核：

- V14-P1-1 pre-effect move target authority保持 Closed；本轮只补更晚的 cleanup after-state。
- V14-P1-2 zero-directory、pure absent no-Git-effect与 single-existing alias保持 Closed；本轮扩展
  retained/stale/partial effect全域性。
- V13 active-pair operator gate与 no-replace publication保持 Closed。

### 17.5 下一步

本轮 3 P1已逐项折入 v16 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十六轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 16. 第十四轮独立设计门（2026-07-29）

### 16.1 隔离执行证据

- snapshot base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- snapshot commit：`38d50b61bd3b9416b962df6d7b930697a1beb686`
- reviewer session：`019fac2d-b6b5-71f3-a6eb-46adaa6de8c8`
- raw output：
  `/private/tmp/rfc235-design-gate-v14.f3OWA0/codex-design-gate-v14-output.md`
- raw output：68 个换行、9,958 bytes（末行无换行），SHA-256
  `4c4b999439931e7ea21fa68fb9d6d43fe7955f825f829cccf6d942f1170c8c58`
- process exit：0；exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=2, P2=0`
- reviewer在审查前后均确认 `HEAD`为指定 commit且
  `git status --porcelain=v1 --untracked-files=all`为空。snapshot内 proposal/design/plan/gate/
  `STATE.md`/总 `design/plan.md`与真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、总 `design/plan.md`、RFC-234/235
  proposal/design/plan、preflight与前十三轮 gate记录；`STATE.md`和总 `design/plan.md`的超长
  单行按原始行号与固定字符区间补读到 EOF。随后只读交叉核验 released
  restore/pending、startup、worktree/Git/Intent source与 tests。未运行测试/build、未联网、未写文件。

### 16.2 结论与闭合范围

第十四轮确认：

- V13-P1-1 的核心已 Closed：`active-pair`不再推导“未开始”，所有同形 pair均在 DB open前进入
  operator gate；strict request/receipt、OS-peer caller scope、stopped CLI与 released-binary kill
  fixtures均已定义。
- V13-P1-2 的核心已 Closed：四级 worktree directory在 canonical effect前先 durable
  `declared`，再 broker-private prepare，并以 Linux `RENAME_NOREPLACE`/Darwin `RENAME_EXCL`及
  descriptor-rooted parent fd发布。
- 方案 A的目标优先 Composer、同源快捷入口、会话卡片、Goal/Generate/Review/Apply、对话/草稿
  双栏、分步 commit、长 Owner、390×568 touch/safe-area/axe合同继续闭合。
- RFC-234 ACL/OCC/secret/all-or-nothing、unified mutation ledger、current-owner dispatcher、
  final authority与 atomic mount approval没有新增冲突。
- 残余 2 个 P1都是 v14类型/恢复代数无法表达真实 crash state，而非“生产代码尚未实现”的泛化问题。

### 16.3 第十四轮 findings 与 v15 resolution

#### V14-P1-1 — `gap`：legacy handoff rename缺少 pre-effect目标 publication

失败序列：

1. operator reapply已 fsync `v3-staged`。
2. legacy active directory成功 no-replace rename到 adoption-hold并 fsync parent。
3. 进程在 `legacy-held` checkpoint前被杀。
4. restart看到 source absent，但 durable control只有 archive publication，没有目标 slot或
   publication；除非从 adoption id重新发明 path映射，否则无法证明哪个 target属于本次 move。

`quarantining → rename → settled`有同一窗口：pre-effect record只有 `sourceIdentity`，target
identity直到 terminal receipt才出现。

source-backed证据：

- v14 operator control中 `v3-staged`无 hold target，`legacy-held`才出现 `holdIdentity`；
  `quarantining`无 target slot：
  `design/RFC-235-intent-builder-ux/design.md:1982-2021`（v14 snapshot）。
- v14算法在两个 checkpoint之间直接 rename：
  `design/RFC-235-intent-builder-ux/design.md:2077-2087`（v14 snapshot）。
- 通用 publication合同本已要求 filesystem effect前保存 staged/expected identity：
  `design/RFC-235-intent-builder-ux/design.md:1060-1073`（v14 snapshot）。
- released restore确实在 DB swap后继续 config/skills/migration/worktree，catch首个 durable
  failure effect才是 quarantine rename：
  `packages/backend/src/services/restore.ts:437-526`、
  `packages/backend/src/services/pendingRestore.ts:207-238`。

业务影响：显式 reapply/quarantine在 response loss/restart后只能永久停在 DB-open前 repair，或由
实现伪造目标 authority。它不会自动误恢复，故不是 P0，但违背 exact replay合同。

Resolution v15：

- 新 `LegacyPendingMovePublicationV3`与 `LegacyPendingMovePublisherV3`，覆盖
  `declared → moving → moved → cleaning → cleaned`及 `repair-required`。
- rename前 durable保存 action/source identity、exact source/target parent、opaque
  hold/quarantine target slot与 target-absent proof；broker slot allowlist新增
  `pending-restore-legacy-hold|pending-restore-legacy-quarantine`。
- rename与双 parent fsync后保存 same-inode target identity及 source-absent proof。restart只接受
  source-only/target-only exact before/after；both、neither、replacement只 repair。
- operator terminal receipt保存 `movePublicationId`，settled control持续引用同一 publication；
  reapply hold在 V3 terminal后以 cleaning/cleaned exact收口，quarantine保留 moved target。
- 进入 G39、D55、AC-55、T1.7/T3.13/T3.15/T9.9。

#### V14-P1-2 — `conflict`：worktree cleanup代数无法表达 declaration/no-Git-effect分支

不可构造分支一：

1. directory `declared`已 fsync。
2. private mkdir前发生 ENOSPC/EIO/cancel；private/canonical均 absent。
3. v14 operation-created publication排除了 `declared`，`removed`又强制真实
   `removedIdentity`；container compensated还强制 reservation已形成。
4. 实现只能伪造 create/remove、永久保持 reserving，或把零 effect冒充 repair。

不可构造分支二：

1. empty target已 published，`adding(effect:null)`已 fsync。
2. Git在创建 registration/ref effect前返回非零，discovery明确 `not-started`。
3. target可 exact删除，但 v14 repo compensating/compensated强制
   `registrationAfter/branchAfter`，无法构造公开承诺的 terminal `git-registration-failed`。

同一根因还影响 single alias：target reservation固定 `operation-created-empty`，但 publication允许
`existing`；v14 matrix只要求相同 publication id，可能把 existing container误投影成可删除 target。

source-backed证据：

- v14 publication/remove/container cleanup类型：
  `design/RFC-235-intent-builder-ux/design.md:2382-2414,2617-2648`（v14 snapshot）。
- v14 `adding(effect:null)`、`discoverInterruptedAdd().not-started`与强制 after effect：
  `design/RFC-235-intent-builder-ux/design.md:2500-2586`（v14 snapshot）。
- v14 terminal outcome/matrix：
  `design/RFC-235-intent-builder-ux/design.md:2673-2687,2852-2862`（v14 snapshot）。
- released optional reconstruction把真实 `git worktree add`非零当 skip：
  `packages/backend/src/services/worktreeBackup.ts:229-238`。

业务影响：optional worktree恢复可在零目录/零 Git effect时永久阻断 recovery barrier，或迫使实现
伪造 effect/cleanup凭据。

Resolution v15：

- directory publication新增 terminal `closed-absent`，只允许 durable `declared`后以
  private/canonical双 absent observation与 exact parent proof关闭，不要求 removed identity。
- task-container compensated允许 `reservation=null`，但 root/namespace/container每个非空
  publication都必须逐层引用 closed-absent、removed或existing-retained evidence。
- repo compensation effect改为 strict `none | registered`。`none/git-not-started`保存 target、
  registration/branch before与 no-effect proof，禁止 after字段；reservation前失败另以
  `none/before-reservation`证明 Git未调用。
- `WorktreeRepoTargetReservationV3.publication`只接受 `published`；single target必须别名同一
  `published + operation-created` container，existing single container在 preflight返回
  `target-present`。
- declaration后失败、Git非零零 effect、reservation-null cleanup与 single-existing alias加入
  terminal receipt/真 crash测试。
- 进入 G40、D56、AC-56、T1.7/T3.13a/T3.15/T9.9。

### 16.4 v14 finding coverage audit

| Finding  | v15 public contract owner                          | Crash/replay proof                                              | 产品可达性                                    |
| -------- | -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| V14-P1-1 | legacy move publication + operator settled ref     | rename前 target intent；source/target闭集 discovery；same-inode | stopped CLI reapply/quarantine可 exact replay |
| V14-P1-2 | closed-absent + none/registered compensation union | zero-dir/zero-Git/single-existing terminal fixtures             | optional worktree失败可真实 skip，不阻断 boot |

前一轮 finding复核：

- V13-P1-1 active-pair operator gate保持 Closed；本轮 finding只收紧 operator决定后的 move authority。
- V13-P1-2 prior durable directory intent与 no-replace publication保持 Closed；本轮 finding只补零
  effect terminal及 single alias矩阵。

### 16.5 下一步

本轮 2 P1已逐项折入 v15 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十五轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 12. 第十轮隔离复审（v10 snapshot）

### 12.1 可复现元数据

- snapshot commit：`b08ac303833aa8cdc7f405fce8dcfb164e3f88c3`
- snapshot repo：`/private/tmp/rfc235-design-gate-v10.F78HIA/repo`
- reviewer session：`019fab46-4dcf-7b11-8155-6c468fe3100c`
- raw output：
  `/private/tmp/rfc235-design-gate-v10.F78HIA/codex-design-gate-v10-output.md`
- raw output SHA-256：
  `d6d336295a05a58e22d277807a2fe0cc337182c86605bc846e552e6bcfb8bbfe`
- raw output：123 行；reviewer exit code 0
- snapshot核对：HEAD与上述 commit一致；index/worktree clean，仅
  `main...origin/main [ahead 1]`
- reviewer遵守只读边界：逐份读取 proposal/design/plan、相邻 RFC、当前 source/tests；没有编辑
  文件，没有执行 test/build/network。为核对 Darwin SDK flags做了只读 SDK搜索；`xcrun`因
  readonly temp cache失败后改为直接读取 SDK header，没有改变裁决。

最终裁决原文：

```text
NEEDS_REVISION — P0=0, P1=4, P2=0
```

### 12.2 第九轮 resolution audit

- V9-P1-1 accepted replay：Closed。normalization/HMAC后先查 ledger；existing exact不再被 current
  capability抢先改成422。
- V9-P1-2 sealed Skill tree publication：Closed。tree writer可产出 sealed authority，replace
  返回 published/displaced并由 non-restored publication ledger跨 crash收敛。
- V9-P1-3 restore writer obligation：Closed。DB restore前收口 external obligation、swap后与
  restored refs合并；不再丢 released writer公钥。
- V9-P1-4 live staging：主体 Closed。daemon-owned stage authority与 local control delegation
  可实现；本轮只把 cancel response-loss replay作为新的独立 finding。
- V9-P1-5 mounted file source：主体 Closed。model只消费 session handle，final fence与 read-only
  source capability完整；本轮只把 session建立前的 Composer可达性作为新的独立 finding。
- 方案 A主 UX、ACL/OCC/secret、migration/current-owner dispatcher、final authority、responsive/
  a11y与前九轮其余闭合项没有新增阻断。

### 12.3 第十轮 findings 与 v11 resolution

#### V10-P1-1 — `conflict`：restore把 regular `config.json`当成 directory tree交换

失败序列：

1. 当前 `Paths.config`指向 regular file，startup直接 `loadConfig(Paths.config)`。
2. v10为 incoming config/skills统一使用 `ArtifactTreeWriterV3`。
3. restore slot名为 `restore-config-root`，并要求每个 root都
   `commitTreeReplace`。
4. 实现若照文档会把 config file当目录交换或隐式改 layout；若保持现有 file path则无法消费
   文档规定的 tree capability。

Resolution v11：

- slot分成 `restore-config-file`与`restore-skills-root`，不做 config layout migration。
- `StagedAppGenerationV3.configDisposition`显式为 preserve/replace。archive无 config保留 live
  file；有 config只接受 verified regular file。
- config用 `createTemp/writeTemp/sealTemp/commitFileNoReplace|Replace`，Skill才用
  `ArtifactTreeWriterV3/commitTreeReplace`。
- restore marker分别保存 file/tree publication ref及 published/displaced identity；file↔dir、
  present/absent、各 crash phase与最终 `loadConfig(Paths.config)`进入 D39/AC-39/T3.13/T9.9。

#### V10-P1-2 — `gap`：ordinary/scheduled/pre-migration backup没有可 mint 的 V3 authority

失败序列：

1. v10 closed operation union只有 Plugin、Skill、restore与pending-stage。
2. slot enum没有 backup staging/archive。
3. 文档又禁止 backup/raw DB snapshot/retention使用裸 path writer。
4. 当前 manual/scheduled/auto/pre-migration/pre-restore与 corrupt DB backup因而无法在 source
   guard后合法创建 staging/archive。

Resolution v11：

- operation新增 exact `backup-export {backupOperationId,backupKind,archiveName}`与独立
  `backup-retention {retentionOperationId}`；slot只允许 `backup-staging-tree/backup-archive`。
- `ArtifactBackupCapabilityV3`提供 closed logical-name copy/generated-file/SQLite snapshot/
  seal/pack/publish API。healthy DB由 branded SQLite adapter写 broker sink；corrupt/
  pre-migration只复制 exact DB/WAL/SHM read capabilities。
- packer sandbox只看 sealed staging与 exact output temp；publication ledger先于 archive publish。
  retention不能复用 export authority，并保护 active/protected/last-good。
- backup/raw snapshot/scheduler/worktree/archive helper全部纳入 D40/AC-40/T3.13a/T9.9 source
  guard与真实 crash测试。

#### V10-P1-3 — `underspecified`：successful cancel + response loss没有 durable replay anchor

失败序列：

1. v10只声明 `PendingRestoreStageReceiptV3`，没有 strict schema与持久 owner。
2. 当前 cancel删除 pending archive/marker；第二次 cancel只能看到 status为空。
3. 若effect后、response前崩溃，相同 id在restart后无法证明是这次 cancel成功，可能返回
   inactive或误认 later stage。
4. 文档没有 cancel ledger/tombstone、phase、boot merger或 retention policy。

Resolution v11：

- 定义 strict public `PendingRestoreStageReceiptV3`与 server-only
  `PendingRestoreControlEnvelope/InFlightRecordV3`。
- verified broker独占 non-restored `PendingRestoreControlLedgerV3`；stable caller scope +
  clientMutationId + request digest为 replay key。
- cancel先 fsync `canceling` exact archive/marker identities，再 `removeEntryExact`，最后 fsync
  terminal canceled receipt；boot在控制面前按 exact identities收敛。
- `status()`只表示 active stage，exact replay始终查 ledger。v1低频 receipt无限期保留、无 GC；
  caller/body mismatch、later stage与每个 crash phase进入 D41/AC-41/T3.13/T9.9。

#### V10-P1-4 — `conflict`：Darwin modify Composer需要一个尚未创建的 session handle

失败序列：

1. v10只有全局 Composer capabilities endpoint。
2. Darwin generic Plugin disabled；只有 `concreteSources`非空才允许 file Plugin copy。
3. concrete source handle只在 create transaction分配。
4. 但 Composer必须在 create前决定是否启用；它无法先有 session handle，所以合法 resource
   shortcut也永远 disabled。

Resolution v11：

- Composer与session model能力拆成 strict
  `IntentComposerCapabilitiesDtoV3/IntentArtifactCapabilitiesDtoV3`。
- side-effect-free `POST /api/intent-sessions/capabilities/resolve`接受 create或exact modify context；
  generic Darwin仍 disabled，actor-visible exact file Plugin可签 opaque
  `IntentPreSessionSourceGrantV1`。
- modify Composer在 resolve前冻结 create mutation id；grant绑定 actor/target/source fence/
  attempt/issuer/expiry，不携 raw path/spec，也不是 filesystem authority。
- new create在同一 transaction重验 actor/ACL/source fence并换成 session handle；accepted exact
  replay先查 ledger，不因后续 expiry/drift失败。tamper/invisible/drift/expired新 request零状态。
  全链进入 D42/AC-42/T1/T2/T5/T6/T9。

### 12.4 v10 finding coverage audit

| Finding  | v11 public contract owner                             | Crash/replay proof                          | 产品可达性                       |
| -------- | ----------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| V10-P1-1 | restore marker + file/tree publication refs           | file/tree各 phase exact identity resume     | config ABI与现有 startup不变     |
| V10-P1-2 | `ArtifactBackupCapabilityV3` + closed operation/slots | publication ledger + packer/retention gate  | 所有现有 backup入口有合法 writer |
| V10-P1-3 | `PendingRestoreControlLedgerV3`                       | prepare-before-delete + boot merger + no GC | status null后仍可 exact replay   |
| V10-P1-4 | context-aware Composer DTO + pre-session grant        | ledger-first accepted create replay         | Darwin exact file modify不再死路 |

### 12.5 下一步

本轮 4 P1已逐项折入 v11 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十一轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 13. 第十一轮隔离复审（v11 snapshot）

### 13.1 可复现元数据

- snapshot commit：`61b1cee7d5e6809a3a7bf8f06c8bd9c572261441`
- snapshot repo：`/private/tmp/rfc235-design-gate-v11.4Jpf6z/repo`
- reviewer session：`019fab87-2ebe-7183-bf9e-dd19f2e44c68`
- raw output：
  `/private/tmp/rfc235-design-gate-v11.4Jpf6z/codex-design-gate-v11-output.md`
- raw output SHA-256：
  `a34f4a0ebc0e560e9177637e45455e71f21538a0e41b7907a7cc6ea6dba2762a`
- raw output：148 行；reviewer exit code 0；external reviewer总 token usage：1,097,007
- snapshot核对：HEAD与上述 commit一致；index/worktree clean，仅
  `main...origin/main [ahead 1]`
- 当前工作区核对：proposal/design/plan/gate/preflight/`STATE.md`/总 `design/plan.md`与送审
  snapshot逐字一致，门禁完成前没有工作区修订。
- reviewer遵守只读边界：指定 RFC-235 四份文档与 RFC-234 三份文档均读到 EOF，复核当前
  restore/pending/backup/retention/worktree、Intent route/apply、Settings/Intent frontend及
  backend/frontend/E2E tests；没有编辑文件、运行 tests/build或联网。memory只用于审查清单，
  当前事实全部在 snapshot重新验证。

最终裁决原文：

```text
NEEDS_REVISION — P0=0, P1=5, P2=0
```

### 13.2 第十轮 resolution audit

- V10-P1-1 config file/tree：Closed。`configDisposition`、sealed file、Skill sealed tree、
  present/absent与 file/tree crash矩阵完整。
- V10-P1-2 backup authority：原 finding Closed，但被更窄的 legacy archive adoption与 Git
  reconstruction authority替代为本轮 P1-4/P1-5。
- V10-P1-3 cancel durable replay：内部 ledger合同 Closed，但真实 HTTP/CLI caller locator与旧
  marker cutover缺口替代为本轮 P1-2/P1-3。
- V10-P1-4 pre-session grant：Closed。Composer/session DTO、grant→session handle、raw
  path/spec禁止与 accepted replay均完整。
- 方案 A主 UX、responsive/a11y与 RFC-234 ACL/OCC/secret/all-or-nothing无新增阻断。

### 13.3 第十一轮 findings 与 v12 resolution

#### V11-P1-1 — `gap`：HTTP restore upload无法产出 read-only backup capability

失败序列：

1. Settings只提交 multipart `File`。
2. v11要求 stage消费未定义 acquisition的 `ReadOnlyBackupCapability`，并禁止
   `.restore-upload` raw writer。
3. 只有 CLI `SCM_RIGHTS`定义了 source acquisition；HTTP route只能继续 arrayBuffer/raw temp、
   偷传 raw fd/path或完全无法 stage。

Resolution v12：

- 定义 `ReadOnlyBackupCapabilityV3`、`StrictRestoreOptionsV3`、
  `SafetyGenerationV3/Swapped*GenerationV3`与 `PendingRestoreIngressCapabilityV3`。
- HTTP改 strict raw-stream PUT；route在读 body前完成 actor/id replay gate，broker writer做
  chunk hard cap、backpressure、incremental digest、exclusive private temp、file+parent fsync、
  seal与 disconnect/crash exact cleanup。route不取得 temp path/fd。
- live/stopped CLI fd、strict pending marker、dry-run与 boot apply都只产出/消费同一 sealed
  capability；跨 operation/boot/identity reuse与 multipart/raw fallback进入 D43/AC-43/T3.13/
  T9.9 source guard。

#### V11-P1-2 — `underspecified`：真实 HTTP/CLI caller无法保存并重放 exact identity

失败序列：

1. 当前 Settings cancel是无 body DELETE，只期待 `{cleared:boolean}`。
2. v11 cancel要求 mutation id + expected stage/revision。
3. effect后 response丢失并 reload，UI只有 `status=null`，CLI也没有可复用 id；caller无法查回
   ledger中的 terminal receipt。

Resolution v12：

- shared wire固定 raw-stream stage、status、owner-scoped mutation lookup、strict cancel body与
  typed repair summary；移除无 body DELETE/boolean response。
- Settings在 effect前写 owner-bound `RestoreControlLocatorV1`，只含 mutation/stage/revision/
  options digest身份，不含 filename/path/archive bytes/digest；reload先 lookup，terminal后删，
  actor变化清本地但 server仍重新授权。
- CLI支持 `--mutation-id/--replay/--status`；默认 id在 effect前写 broker-owned 0600 client
  locator、fsync并打印。未 seal stage要求以同 id/metadata重传 archive，terminal replay不重读
  fd。全链进入 D44/AC-44/T1/T3.13/T5.8/T9.9。

#### V11-P1-3 — `gap`：升级前 pending marker没有 adoption protocol

失败序列：

1. 旧 binary已留下 marker与 staged archive，随后升级。
2. 新 control ledger为空；旧 marker没有 caller/id/request digest/publication/phase。
3. 忽略会丢已授权 restore；按目录/文件名合成 receipt违反 ledger合同。

Resolution v12：

- verified broker在 singleton lock下运行独立
  `LegacyPendingRestoreAdoptionV3`，只从 canonical legacy marker与固定 staged archive
  descriptor-open，忽略 marker absolute path，验证 regular/nlink/digest/options/完整 archive。
- valid先 fsync `legacy-unverifiable` adoption phases，再由 publication ledger变成 origin
  `legacy-adopted`的 internal V3 marker，最后 exact清 legacy entries并继续 boot apply；不创建
  callerScope/clientMutationId exact replay。
- invalid/partial/identity ambiguous与旧 failed quarantine形成 typed repair；live generation
  未动才可隔离并继续 boot，否则 repair-required。每个 adoption phase真 crash、upgrade fixture
  与 operator行为进入 D45/AC-45/T1/T3.13/T3.15/T9.9。

#### V11-P1-4 — `conflict`：旧 backup archive没有 publication receipt，掉出 retention inventory

失败序列：

1. 当前 backup root已有 scheduled/auto/manual/pre-\* archives。
2. v11 inventory要求 publication ref；旧 archive不可能拥有。
3. 排除会让旧 scheduled/auto永久绕过 retention；伪造 receipt或 raw unlink违反 authority。

Resolution v12：

- 新增 non-restored `ArtifactLegacyArchiveAdoptionLedgerV3`与独立
  `backup-legacy-adoption` operation。descriptor scan只接受 regular `nlink=1` entry，计算
  archive/manifest digest、strict验证，并从 manifest而非 filename分类 kind/protection。
- inventory authority变成 `published | legacy-adopted` discriminated union；adoption receipt不
  冒充 publication，remove前重验对应 receipt + identity + digest。
- scan/digest/manifest/receipt crash期间保持 protected；symlink/hardlink/partial/corrupt/
  unknown manifest只 repair不删。新旧 verified archive统一 last-good，旧 scheduled/auto继续
  count/days/size。进入 D46/AC-46/T1/T3.13a/T3.15/T9.9。

#### V11-P1-5 — `gap`：worktree capability只解包，未产生真实 Git worktree

失败序列：

1. 当前产品必须 `git worktree add`后 overlay；普通目录不具 Git registration。
2. v11只有 `extractCapturedTree`，没有 repo-admin/target operation、Git add或 partial compensation。
3. 当前 raw `runGit(repoPath,[...,worktreePath,...])`又违反 path authority。
4. 当前多仓真值在 ordered `task_repos[]`，legacy `tasks.*`只镜像 repo[0]。

Resolution v12：

- capture从完整连续 ordered `task_repos[]` mint task source，写
  `worktrees/v2/<taskId>/repos/<repoIndex>/tree`；任一 repo失败 exact删全部 private partial并
  task级 skip。legacy v1只允许 single-repo，multi-repo typed skip。
- 新 closed `worktree-reconstruction` operation绑定 task status/repoCount、每个 repo的
  repo-admin/branch/base/target fences与 task/repo locks。adapter只清 exact stale registration，
  内部构造 allowlisted Git add，archive数据不能进入 argv/fd authority。
- 每 repo registration→overlay→`.git` back-reference/branch/status验证写 durable phase；multi
  全部 verified才 complete，partial add逆序 compensation失败则 repair-required，既存 target
  永不覆盖。进入 D47/AC-47/T1/T3.13a/T3.15/T9.9。

### 13.4 v11 finding coverage audit

| Finding  | v12 public contract owner                                   | Crash/replay proof                               | 产品可达性                                |
| -------- | ----------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| V11-P1-1 | ingress + `ReadOnlyBackupCapabilityV3` + phase result types | chunk/seal/fsync/abort exact cleanup             | Settings HTTP/CLI/pending/dry-run均可调用 |
| V11-P1-2 | strict wire + Settings/CLI safe locator                     | ledger-first lookup + reload/restart replay      | 人类 caller能找回原 receipt               |
| V11-P1-3 | legacy pending adoption + typed repair                      | phase record + publication + marker-last resume  | 升级不丢旧 staged restore                 |
| V11-P1-4 | legacy archive adoption ledger + union inventory            | adoption crash protected + exact remove          | 旧 archive继续 retention                  |
| V11-P1-5 | task repo-set source + Git reconstruction operation         | registration/overlay/verify/compensation receipt | single/multi-repo得到真实 Git worktree    |

### 13.5 下一步

本轮 5 P1已逐项折入 v12 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十二轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 14. 第十二轮隔离复审（v12 snapshot）

### 14.1 执行证据

- snapshot root：`/private/tmp/rfc235-design-gate-v12.mlOOvR`
- snapshot repo：`/private/tmp/rfc235-design-gate-v12.mlOOvR/repo`
- snapshot commit：`ed6a2291cb8698bc23deeeda9db31d322d24b157`
- reviewer session：`019fabc2-2689-7fb1-a6c7-e1180a1f48fa`
- raw output：
  `/private/tmp/rfc235-design-gate-v12.mlOOvR/codex-design-gate-v12-output.md`
- raw output：107 行，SHA-256
  `a41700397f1486bb4c04ec691761aa0cc687cbced32b28e08013392553612740`
- process exit：0；reviewer token usage：1,213,398
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=5, P2=0`
- snapshot `HEAD`与指定 commit一致、worktree clean、临时 gate branch只 ahead 1；snapshot内
  proposal/design/plan/gate/`STATE.md`/总 `design/plan.md`与门禁前真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、RFC-234/235 proposal/design/plan与历史 gate，
  并沿当前 source/tests复核 restore CLI/pending、Settings locator、backup/worktree layout。
  本轮只读；未运行测试/build、未联网、未写 source/doc。

### 14.2 结论与闭合范围

第十二轮确认：

- 方案 A 的目标优先 Composer、会话 journey、对话/草稿双栏、响应式和分步 commit UX没有新增
  P0/P1。
- RFC-234 ACL/OCC/secret/all-or-nothing、Intent mutation/dispatcher/final authority与前十一轮
  已闭合主体没有新增阻断。
- v12 的 bounded restore ingress、legacy backup adoption/retention主体仍成立。
- 5 个 P1全部位于 restore/upgrade/worktree control plane；它们会让真实入口不可执行或让 crash
  recovery缺少 exact evidence，必须在实施前闭合。

### 14.3 第十二轮 findings 与 v13 resolution

#### V12-P1-1 — `gap`：daemon-live dry-run没有可执行的 capability acquisition

失败序列：

1. released CLI把 default plan/`--dry-run`放在 daemon lock拒绝前，因此 daemon live时必须可用。
2. v12只说 dry-run消费 `ReadOnlyBackupCapabilityV3`，但 local admin control只有 stage/status/
   cancel，CLI本身又不能 mint broker capability。
3. 若继续 `planRestore(callerPath)`会绕过 bounded ingress；若复用 stage则会错误创建 pending/
   control/publication side effect。

Resolution v13：

- 新增 strict `RestorePlanDtoV3`与 `RestoreInspectionServiceV3`；default plan/`--dry-run`只消费
  sealed `ReadOnlyBackupCapabilityV3`。
- local-control变为 discriminated
  `inspect-backup | stage | lookup | cancel` union：inspect/stage恰一个 delegated fd，
  lookup/cancel零 fd。live CLI走 peer UID + boot nonce + fd identity/digest验证，stopped CLI持
  singleton lock后走同一 service。
- inspect用独立 request nonce，不写 caller locator/control ledger/publication/pending marker；
  response前 exact关闭 fd与清 ingress。peer/frame/fd/archive错误均零持久 side effect。
- embedded inspection直接从 build-bound sealed migration journal mint current axis，不调用会写
  app-home runtime的 `extractMigrationsTo()`；dev只读 repository descriptor。
- 进入 D48/G32/AC-48/T1.1a/T3.13/T3.15/T9.9。

#### V12-P1-2 — `conflict`：actor mismatch删除 locator破坏 A→B→A recovery

失败序列：

1. actor A在 stage/cancel effect后丢 response，本机 locator是找回 mutation id的唯一 caller线索。
2. 用户切换到 actor B；v12要求 actor mismatch时删除该 locator。
3. A再次登录后 key已经永久消失，无法沿仍存在的 server ledger取得 terminal receipt，直接违反
   AC-44的 reload/relogin recovery。

Resolution v13：

- locator key继续包含 actor id，但 current actor只枚举自己的 prefix；foreign locator不 lookup、
  不显示、不覆盖、不删除，sign-out也只隐藏。
- A回来后继续 mutation lookup，terminal只删除 A的 exact key。显式“清除本机恢复记录”才可删，
  且先警告会丢失 response-loss找回能力；server ledger/authorization不变。
- A response loss→B reload/restart→A与同 id跨 actor命名空间进入 deterministic test。
- 进入 D44/D49/G33/AC-44/AC-49/T5.8/T3.15/T9.9。

#### V12-P1-3 — `conflict`：legacy pending schema/layout与 released binary不符

失败序列：

1. released marker实际是
   `.restore-pending/restore-pending.json`，字段为 `stagedTarball`、可选三个 boolean与数字
   `requestedAt`；v12误写 `marker.json/archivePath`。
2. released stage先 copy `staged.tar.gz`再写 marker，可能留下 archive-only；successful apply先删
   archive再清目录，可能留下 marker-only；现有测试明确锁 marker-only=already consumed。
3. failure先 rename目录再写 `error.txt`，可能留下无 error文件的 failed quarantine。v12 record
   强制同时持 marker/archive identity，无法为这些真实 partial state mint。

Resolution v13：

- 锁 strict `LegacyPendingRestoreMarkerV1`真实字段/缺省；`stagedTarball`只解析不形成 path
  authority。
- 新增 `LegacyPendingEvidenceV3 = complete | marker-only | archive-only | empty-active |
failed-quarantine`；`empty-active`额外覆盖 mkdir-before-copy。record每分支只保存实际存在的
  directory/child exact identities，deterministic adoption id来自 canonical slot + evidence
  kind + present identities。
- complete完整验证后转 V3 internal marker；marker-only按 released idempotency只写
  consumed-without-caller-receipt并 exact cleanup；archive-only未 marker-last arm，只 quarantine；
  empty-active仅在 exact directory仍为空时清理；failed quarantine覆盖 rename/error-write前后，
  generation不可证明时 DB-open fail closed。
- mkdir/copy、copy/marker、archive-delete/cleanup、rename/error-write及 identity replacement全
  crash矩阵进入
  D45/D50/G34/AC-45/AC-50/T1.7–T1.9/T3.13/T3.15/T9.9。

#### V12-P1-4 — `gap`：missing multi-task parent没有可 mint的 creation authority

失败序列：

1. released multi-repo materialization先创建
   `worktrees/multi/<taskId>`，再逐 repo创建 child target。
2. v12 `WorktreeRepoTargetDescriptorV3`要求既存 `targetParentIdentity`；恢复的正常状态却可能整个
   task parent都不存在。
3. generic mkdir被 source guard禁止，因此 happy path无法产生第一个合法 target。

Resolution v13：

- 从 canonical worktrees root + restored task id + ordered repo descriptors mint closed
  `WorktreesRootSlotCapabilityV3`、task-container与 repo-target reservations。
- root/namespace/task parent/target按角色 exclusive创建并 fsync；每个 exact identity与
  existing/operation-created disposition在 Git前持久化。single task container可作为 target，
  multi parent下逐 child reservation。
- Git adapter qualification先证明受支持 Git可消费 existing empty directory；不支持则在创建
  reservation前 typed unavailable，绝不临时退回 raw absent path。
- compensation只删除 identity匹配的 operation-created target与仍为空 task parent；
  preexisting parent/root/namespace永不删。whole parent absent、parent-only、partial child与
  replacement进入 D51/G35/AC-51/T3.13a/T3.15/T9.9。

#### V12-P1-5 — `conflict`：reconstruction receipt缺 target/ref effect evidence

失败序列：

1. v12 receipt只有 `completedRepoIndexes + registrationIdentities`，没有 target reservation/
   post-add target identity或 branch/ref before-after。
2. crash可发生在 Git add effect后返回前，或返回后 ledger fsync前；startup无法区分未执行、
   已注册、target被替换或 branch/ref已变化。
3. `compensateExact`因此不能 rehydrate删除/回滚所需的 closed capabilities，multi-repo partial
   cleanup也无法证明只删本 operation。

Resolution v13：

- receipt改为 ordered per-repo discriminated ledger entry，保存 descriptor/task/repo fences、
  target reservation、registration before、branch/ref before与 phase。
- Git前先 fsync `reserved/adding`；add后先 fsync target identity、registration after、branch/ref
  after，再 overlay/verify。
- add-before-result或 result-before-ledger fsync由 closed `discoverInterruptedAdd()`枚举；只有
  target/registration/branch与 reservation/fences形成唯一匹配才补记，否则 repair-required。
- compensation从 ledger rehydrate capability，按 overlay→registration/target→branch CAS→空
  operation-created parent逆序执行；全 cleanup后 terminal typed compensated skip，identity
  replacement与 multi第 N repo失败不猜删。
- 进入 D52/G36/AC-52/T1.7/T3.13a/T3.15/T9.9。

### 14.4 v12 finding coverage audit

| Finding  | v13 public contract owner                        | Crash/replay proof                                    | 产品可达性                          |
| -------- | ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| V12-P1-1 | inspection service + strict local-control union  | fd/ingress exact cleanup，零 durable side effect      | live/stopped plan与dry-run同合同    |
| V12-P1-2 | actor-namespaced retained locator                | A→B→reload/restart→A exact lookup                     | 原 actor不丢 mutation key           |
| V12-P1-3 | released marker codec + five-state evidence      | mkdir/copy/cleanup/quarantine按 actual identity收敛   | upgrade不误 apply/误清 legacy state |
| V12-P1-4 | task-container/repo-target reservation authority | create/fsync/ledger先于Git，exact parent compensation | missing multi parent happy path可达 |
| V12-P1-5 | ordered per-repo reconstruction effect ledger    | add/result/fsync/overlay exact discover或repair       | resume/compensate有完整凭据         |

前一轮 finding复核：

- V11-P1-1保留的 dry-run可达性残项由 V12-P1-1/D48闭合；HTTP/stage ingress主体不回退。
- V11-P1-2的 caller locator主体保留，但 actor清理冲突由 V12-P1-2/D49纠正。
- V11-P1-3的 legacy adoption主体保留，但 schema/layout/partial evidence由
  V12-P1-3/D50改成 released事实。
- V11-P1-4 legacy backup adoption/retention保持 closed。
- V11-P1-5的 Git reconstruction方向保留，missing parent与 effect receipt分别由
  V12-P1-4/P1-5补全。

### 14.5 下一步

本轮 5 P1已逐项折入 v13 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十三轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 15. 第十三轮隔离复审（v13 snapshot）

### 15.1 执行证据

- snapshot root：`/private/tmp/rfc235-design-gate-v13.0DwOVF`
- snapshot repo：`/private/tmp/rfc235-design-gate-v13.0DwOVF/repo`
- snapshot commit：`266816d78f73d73f0e87c5e57619e2d8ec033d42`
- reviewer session：`019fabfc-1044-7700-b679-3abf2c0d1b91`
- raw output：
  `/private/tmp/rfc235-design-gate-v13.0DwOVF/codex-design-gate-v13-output.md`
- raw output：98 个逻辑行（末行无换行，`wc -l=97`），SHA-256
  `fc04592cf02c852a9a22a88abe3b6a415cc52fbaffed52833c72426848549fb1`
- process exit：0；reviewer token usage：1,272,962
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=2, P2=0`
- snapshot `HEAD`与指定 commit一致且 worktree clean；临时 gate branch只 ahead 1。门禁启动前，
  snapshot内 proposal/design/plan/gate/`STATE.md`/总 `design/plan.md`与真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、总 `design/plan.md`、RFC-234/235
  proposal/design/plan、preflight与前十二轮 gate记录；随后逐项复证 released
  restore/pending、CLI/startup、worktree materialization/Git cleanup及相关 tests。全程只读，
  未运行测试/build、未联网、未写 source/doc。

### 15.2 结论与闭合范围

第十三轮确认：

- V12-P1-1 daemon-live inspection与 V12-P1-2 actor-namespaced locator已 Closed。
- V12-P1-5 的 Git `reserved → adding → registered → overlaying → verified`效果账本、
  registration/target/branch before-after与 interrupted-add discovery主体已 Closed。
- 方案 A的创建入口、会话 journey、澄清/atomic mount approval、mounted context、pinned
  review/commit、secret生命周期、响应式/a11y，以及 RFC-234 ACL/OCC/幂等/final authority/apply
  compensation没有新增可证 P0/P1/P2。
- 残余 2 个 P1都早于上述 Git/UX流程：一个是 released legacy restore的物理状态不可区分，一个是
  canonical directory reservation publication先 effect后 receipt。

### 15.3 第十三轮 findings 与 v14 resolution

#### V13-P1-1 — `conflict`：post-swap failure在 quarantine rename前与合法 active pair不可区分

失败序列：

1. released pending restore已经 swap DB，随后在 config/skills/migration/worktree阶段失败。
2. `applyPendingRestoreIfAny()`进入 catch，但进程在第一项 durable failure effect
   `renameSync(.restore-pending, quarantine)`前被 SIGKILL。
3. live generation可能已经混合/部分推进；磁盘仍是
   `.restore-pending/restore-pending.json + staged.tar.gz`。
4. v13把同一物理 pair称为 `complete`并自动转 V3 stage/apply，无法区分从未开始的合法 pending与
   上述 post-swap failure。

source-backed证据：

- released restore在 DB swap后才处理 config/skills/migration/worktree：
  `packages/backend/src/services/restore.ts:437-526`。
- pending catch的第一项 durable effect才是 quarantine rename：
  `packages/backend/src/services/pendingRestore.ts:195-238`。
- 当前测试覆盖异常返回后的 quarantine，不覆盖 catch→rename真 kill：
  `packages/backend/tests/rfc213-pending-restore.test.ts:125-163`。
- v13 physical union/auto-adopt路径：
  `design/RFC-235-intent-builder-ux/design.md:1878-1905,1951-1985`（v13 snapshot）。

Resolution v14：

- physical evidence把 marker+archive分支改名为 `active-pair`，只陈述 bytes共存，永不推导 clean
  `complete`。
- startup验证 exact directory/marker/archive identities与 digests后，先在 non-restored adoption
  ledger fsync
  `operator-confirmation-required {adoptionId,evidenceDigest}`，再以
  `legacy-active-pair-ambiguous`在 DB open/migration/restore/HTTP/workers前 fail closed；不自动写
  V3 marker/publication。
- 新 strict `LegacyPendingOperatorRequestV3/ReceiptV3`。stopped CLI取得 singleton lock后，只能按
  exact adoption id读取 `RestorePlanDtoV3`，再以新 mutation/evidence digest显式
  `reapply | quarantine`。reapply先 seal独立 V3 private stage并落 durable control，再把旧 pair
  exact rename到 adoption-hold，最后发布 V3 marker并执行 generation；hold在 cleanup-verified前
  不删。quarantine exact no-replace rename。response loss/restart沿 operator/adoption/V3
  receipts replay，changed action/digest conflict，identity drift repair。
- 用 released binary在 DB swap后、config、skills、migration、worktree与 catch→rename逐点真 kill；
  它们与合法未开始 pair都必须得到同一 operator gate，零自动 apply。
- 进入 G34/G37、D45/D50/D53、AC-45/50/53、T1.1a/T1.7-T1.9/T3.13/T3.15/T9.9。

#### V13-P1-2 — `gap`：task/target reservation在 durable receipt前已有 canonical filesystem effect

失败序列：

1. restored task的 canonical container/target不存在，preflight通过。
2. v13 `reserveTaskContainer()`或 `reserveRepoTarget()`先在 canonical slot
   exclusive mkdir+fsync。
3. 进程在 prepared/`phase='reserved'` receipt fsync前崩溃。
4. restart看到 target存在，但 ledger没有 inode/identity/operation ownership；single target或
   multi child只能 target-present skip/repair，不能安全认领/删除。若把 multi parent当
   preexisting，又丢失 promised exact parent compensation authority。

source-backed证据：

- released multi layout先 mkdir task parent，再逐 child materialize：
  `packages/backend/src/services/task.ts:1197-1218`。
- v13 reservation type只有 directory创建后才可填的 exact identity，per-repo最早状态已是
  `reserved`：
  `design/RFC-235-intent-builder-ux/design.md:2158-2181,2274-2316`（v13 snapshot）。
- v13算法明确 mkdir+fsync后才写 prepared/reserved：
  `design/RFC-235-intent-builder-ux/design.md:2556-2568`（v13 snapshot）。
- Git add已有 pre-effect `adding`，directory mkdir没有对应 publication protocol：
  `design/RFC-235-intent-builder-ux/design.md:2569-2582`（v13 snapshot）。

Resolution v14：

- 新 `WorktreeDirectoryReservationPublicationV3`：
  `declared → private-prepared → publishing → published`，另有 `existing/repair-required`；
  root/namespace/task-container/repo-target全部走同一合同。
- `declared`在任何 mkdir前 fsync operation/role/descriptor fence/exact parent/validated leaf/opaque
  broker-private slot。private directory创建/fsync后保存 identity；canonical effect前先 fsync
  `publishing`。
- Linux只用 `renameat2(RENAME_NOREPLACE)`，Darwin只用
  `renameatx_np(RENAME_EXCL)`发布同一 inode；primitive/Git existing-empty-dir qualification任一失败，
  在 declaration/directory effect前 typed unavailable。
- crash discovery同时检查 recorded private/canonical identity：neither按 declared重做，
  private-only继续 publish，canonical-only exact匹配补 receipt，both/replacement repair。
  publication receipt durable后才进入 `reserved`/Git；single container/target共享同一
  publication。
- top-level container ledger与 per-repo entry新增 `reserving`/publication progress；compensation
  同时收口未发布 private slot与已发布 operation-created slot，并以 `removing → removed`
  cleanup receipt进入 repo/top-level compensated。每层 declaration/private-create/identity/
  publishing/rename/parent-fsync/receipt/removing/removed加入真 kill矩阵。
- 进入 G35/G38、D51/D52/D54、AC-47/51/52/54、T1.7/T3.13a/T3.15/T9.9。

### 15.4 v13 finding coverage audit

| Finding  | v14 public contract owner                       | Crash/replay proof                                              | 产品可达性                               |
| -------- | ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| V13-P1-1 | active-pair operator receipt + V3 reapply       | post-swap/catch kill同形 fail closed；decision exact replay     | 合法旧 pending多一次确认但不误自动重放   |
| V13-P1-2 | directory reservation publication state machine | prior durable intent + private/canonical before/after discovery | missing single/multi parent仍可安全 mint |

前一轮 finding复核：

- V12-P1-1/D48 inspection、V12-P1-2/D49 locator与 V12-P1-5/D52 Git effect evidence保持
  Closed。
- V12-P1-3 released marker codec/marker-only/archive-only/empty-active/quarantine主体保留；原
  `complete` auto-adopt被 V13-P1-1/D53替换。
- V12-P1-4 missing parent authority方向保留；canonical mkdir publication gap由
  V13-P1-2/D54替换。

### 15.5 下一步

本轮 2 P1已逐项折入 v14 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建
全新隔离 snapshot执行第十四轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 18. 第十六轮独立设计门（2026-07-29）

### 18.1 隔离执行证据

- snapshot root：`/private/tmp/rfc235-design-gate-v16.UIcXaT`
- snapshot repo：`/private/tmp/rfc235-design-gate-v16.UIcXaT/repo`
- snapshot commit：`a7956163df521f244ab5957d37df5dc4b725d272`
- parent/base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- reviewer：external Codex v0.146.0，`gpt-5.6-sol`，reasoning `max`，
  `--ephemeral --sandbox read-only`
- reviewer session：`019faca8-08d4-7932-bc5c-9f6399f7de42`
- gate prompt SHA-256：
  `369e364662ec346ef40b1b8d9d1e1a785dfa450b72520db012d92dc0752bd4bd`
- raw output：
  `/private/tmp/rfc235-design-gate-v16.UIcXaT/codex-design-gate-v16-output.md`
- raw output：57 行、6,629 bytes，SHA-256
  `f6674913aa8a44b5e7944b2cbcba5a4f068592f6b2e96601516ed30e82cb179f`
- process exit：0；reviewer token usage：1,204,070
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=1, P2=0`
- reviewer起止均确认 `HEAD`为指定 commit且
  `git status --porcelain=v1 --untracked-files=all`为空。snapshot内 proposal/design/plan/gate/
  preflight/`STATE.md`/总 `design/plan.md`与门禁前真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、总 `design/plan.md`、RFC-234/235
  proposal/design/plan、preflight与前十五轮 gate记录；超长单行按固定字符区间读到 EOF。随后只读
  交叉核验 current Intent shared/backend/frontend source与 tests、restore/pending/startup、
  worktree/Git recovery及 Settings restore UI。未运行测试/build、未联网、未写 source/doc。

### 18.2 结论与闭合范围

第十六轮确认：

- V15-P1-1 Closed：`cleaning + exact neither`已有 purpose/revision分型 proof、post-cleanup
  observation与 target-parent re-fsync，可 roll forward；`moved + neither`仍 repair。
- V15-P1-2 Closed：root/namespace retention、registration preparation、stale cleanup intent、
  no-add-intent terminal及 Git `none|partial|registered` effect形成全域 algebra，逐组件逆序补偿可
  真实返回 optional worktree skip。
- V15-P1-3 的 nested foreign-value/cross-field binding主体 Closed：canonical helper已逐字段绑定
  publication/reconstruction/action id、parent/slot/fence、fsync、removed identity与 observation。
- 方案 A的 inline Composer、同源快捷 Dialog、responsive cards、Goal/Generate/Review/Apply、
  pinned draft、secret生命周期、长 Owner、touch/keyboard/axe，以及 RFC-234
  ACL/OCC/copy-only/all-or-nothing/current-owner/final-authority没有新增可计数回归。
- 唯一新 P1是 v16编辑时把 identity decode transform误挂 approval receipt schema；这是公共
  executable codec的新 copy/paste根因，不重复计算 V15-P1-3。

### 18.3 第十六轮 finding 与 v17 resolution

#### R16-P1-01 — `defect`：identity decode transform误挂 mount approval receipt schema

失败序列：

1. 最新 agent turn同时含 `mountRequests`与 questions。
2. 用户提交 atomic approvals；服务端 transaction成功并返回合法
   `IntentMountApprovalReceipt`。
3. frontend按合同调用 `IntentMountApprovalReceiptSchema.safeParse()`。
4. v16 schema的 transform却读取 receipt不存在的 `wire.dev/ino/mode/nlink/fsid`，并宣称输出
   `ArtifactEntryIdentityV3`。
5. 严格实现会 TypeScript property-not-found；若 cast绕过，则 `BigInt(undefined)`抛错或产生错误
   identity shape。
6. approval业务 side effect已经提交，但 answers永远不 POST；HTTP response-loss后从 detail读取
   同一 receipt也走同一坏 schema，exact recovery同样不能解除 Generate阻塞。

source-backed证据：

- v16 receipt object与错误 transform：
  `design/RFC-235-intent-builder-ux/design.md:601-645`（v16 snapshot）。
- 真正需要 bigint decode的 identity schema未定义 canonical leaf且没有 transform：
  `design/RFC-235-intent-builder-ux/design.md:898-917`（v16 snapshot）；两个 comparator明确要求
  bigint output：`:919-944`。
- 所有 nested recovery identity被要求只经同一 schema：
  `design/RFC-235-intent-builder-ux/design.md:3541-3651`（v16 snapshot）。
- 组合 journey要求 receipt parse成功后才能 POST answers：
  `design/RFC-235-intent-builder-ux/design.md:4453-4473`、`plan.md:593-596`（v16 snapshot）。
- released current backend/shared仍是待替换的 `{mounted}`弱 shape，没有第二份 receipt codec兜底：
  `packages/backend/src/routes/intentSessions.ts:291-310`、
  `packages/shared/src/schemas/intentSession.ts:63-72`。

业务影响：正常“批准资源并回答问题”主路径在 approval已产生业务进展后永久卡住；response-loss
恢复也失效。它不是生产代码尚未实施导致的暂时缺口，而是 v16规范自身的 schema冲突。

Resolution v17：

- 删除 `IntentMountApprovalReceiptSchema`上的全部 transform；定义独立
  `IntentMountApprovalReceipt`并用编译期 equality断言 schema output精确等于 receipt。合法
  approve/reject runtime parse逐字段保持。
- 定义 strict `ArtifactEntryIdentityV3WireSchema`：dev/ino只接受
  `^(0|[1-9][0-9]*)$`且最大 20 位、值不超过 uint64 max；mode/nlink非负 safe integer，fsid为
  signed safe-integer tuple。`+1`、`01`、`-1`、overflow与 unsafe companion均 fail closed。
- 只有 `ArtifactEntryIdentityV3Schema`在完整 wire safeParse后把 dev/ino转换为 bigint；用
  input/output compile assertion锁 wire与 decoded type。唯一
  `encodeArtifactEntryIdentityV3()`把 bigint转 base-10并再次经 wire schema验证，禁止 consumer
  直接 `BigInt(raw)`、`JSON.stringify(decoded)`或自行编码。
- shared/backend测试覆盖 receipt output类型与合法逐字段 parse、identity字段注入/
  missing/extra/order/outer-turn mismatch零 answers POST；identity覆盖 zero、uint64 max、超
  JS-safe大值、非 canonical表示、overflow与 decoded→wire→decoded round trip。
- E2E在 approval transaction commit后、HTTP receipt前杀 daemon；重启后 detail strict receipt
  恢复，answers只提交一次。所有 nested recovery row继续只消费 decoded bigint identity，并以
  foreign value/live observation mismatch证明 descriptor/filesystem/DB effect前失败。
- v17 exact codec片段已在隔离临时文件以 repo TypeScript/Zod执行
  `tsc --noEmit --strict`与 Bun runtime proof：receipt input/output equality编译通过，合法
  receipt保持同形，非 canonical/overflow uint64拒绝，uint64 max decode为 bigint并 canonical
  round trip；两条命令 exit 0。
- 进入 G44、D60、AC-60、T1.1/T1.7/T7.5/T9.9/T10.6。

### 18.4 v16 finding coverage audit

| Finding   | v17 public contract owner                        | Negative/recovery proof                                            | 产品可达性                               |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------- |
| R16-P1-01 | receipt output assertion + identity wire/decoder | canonical边界/round trip；approval commit→response-loss→detail恢复 | atomic approval后可继续 answers/Generate |

前一轮 finding复核：

- V15-P1-1 phase-sensitive cleanup保持 Closed。
- V15-P1-2 retained/stale/partial worktree terminal algebra保持 Closed。
- V15-P1-3 cross-field strict binding保持 Closed；v17只修其公共 identity executable codec边界。

### 18.5 下一步

本轮唯一 P1已折入 v17 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步后，创建全新隔离
snapshot执行第十七轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 19. 第十七轮独立设计门（2026-07-29）

### 19.1 第十七轮隔离门禁证据

- base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- snapshot：`211733a5b90dacb2d5a262d5c65dfb1e317ef66c`
- 隔离目录：`/private/tmp/rfc235-design-gate-v17.O3KEHj/repo`
- reviewer session：`019facdb-8109-7051-bd25-8786437cadff`
- 模式：external Codex `gpt-5.6-sol`、max reasoning、
  `codex exec --ephemeral --sandbox read-only`；未联网、未运行测试/build、未编辑文件。
- prompt：
  `/private/tmp/rfc235-design-gate-v17.O3KEHj/gate-v17-prompt.txt`（116行、7,439 bytes），
  SHA-256：
  `ff996e480d130ec2bd861e2d8bd6b63bded40cbca49bbeebd120faff260890e5`
- 完整 reviewer output：
  `/private/tmp/rfc235-design-gate-v17.O3KEHj/codex-design-gate-v17-output.md`
  （56行、8,304 bytes），SHA-256：
  `cba04a488299be53a981b7a0919feb232db28008356a98c270f9438dace4d0ad`
- process exit：0；reviewer token usage：1,158,786
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=1, P2=0`
- reviewer起止均确认 `HEAD`为指定 commit且
  `git status --porcelain=v1 --untracked-files=all`为空。snapshot commit parent精确为 base，
  proposal/design/plan/gate/preflight/`STATE.md`/总 `design/plan.md`与门禁前真实工作区逐字节一致。
- reviewer完整读完 `CLAUDE.md`、`STATE.md`、总 `design/plan.md`、RFC-234/235
  proposal/design/plan、preflight与前十六轮 gate记录；超长单行按固定字符区间读到 EOF。随后只读
  交叉核验 current Intent frontend/backend/shared source与 tests、Zod 3.25.76/strict TypeScript、
  restore/pending/startup、artifact publication/obligation及 worktree/Git persistence seams。

### 19.2 结论与闭合范围

第十七轮确认：

- R16-P1-01 Closed：`IntentMountApprovalReceiptSchema`无 transform，input/output equality与合法
  approve/reject逐字段保持；approval + questions及 HTTP response-loss→detail recovery可继续
  answers。
- identity leaf codec Closed：canonical uint64 decimal、safe numeric companion、bigint decode、
  唯一 leaf encoder与 zero/max/overflow/非 canonical输入边界成立，极长输入也在 `BigInt()`前
  fail closed。
- V15 phase-sensitive cleanup、retained/stale/partial worktree terminal algebra与 nested
  cross-field读侧 strict binding继续 Closed。
- 方案 A的 inline Composer、同源 Dialog、responsive cards、Goal/Generate/Review/Apply、
  mount approval、pinned draft、分步 commit、secret生命周期、长 Owner、desktop/mobile/touch/
  keyboard/axe，以及 RFC-234 ACL/OCC/copy-only/closed secret set/all-or-nothing/current-owner/
  final authority没有新增可计数回归。
- 唯一新 P1是 decoded recovery root缺反向 durable wire producer；它与 leaf codec正确性、
  R16 receipt defect及 V15读侧 equality均是独立边界。

### 19.3 第十七轮 finding 与 v18 resolution

#### R17-P1-01 — `gap`：decoded recovery record没有顶层 durable-wire encoder

失败序列：

1. broker观察 filesystem entry并产生真实 bigint `ArtifactEntryIdentityV3`。
2. legacy reapply在 rename前必须 fsync `declared`/`moving`；worktree reconstruction也必须在
   private mkdir前 fsync含 parent identity的 `declared` publication。pending restore、
   artifact publication及 adoption ledger同样 checkpoint嵌套 identity的 root record。
3. 当前 root schema的 wire input含 decimal string，parse output却含 bigint；把 decoded root交给
   schema不匹配，把 wire root交给 schema只得到 decoded output。Zod 3.25.76没有反向 codec。
4. v17只定义 `encodeArtifactEntryIdentityV3()` leaf encoder，同时禁止 consumer直接
   `JSON.stringify(decoded)`、`BigInt(raw)`或自行挑字段；proposal/design/plan没有任一顶层
   root encoder、wire root type或 exhaustive mapper。
5. 严格实现因而无法写第一个合法 checkpoint；若临时使用 bigint replacer/partial mapper，新增
   union branch或 nested identity可静默漏映射，crash后丢失 authority evidence。
6. legacy active-pair会停在 non-terminal operator phase并持续阻断 restore/HTTP/workers；
   ordinary worktree reconstruction也无法遵守 record-before-act。

source-backed证据：

- leaf decoded/wire/encoder与禁止直接 stringify：
  `design/RFC-235-intent-builder-ux/design.md:914-992`（v17 snapshot）。
- legacy move nested identities与 decoded `checkpoint()`：
  `design.md:2101-2205,2395-2407,2450-2463`（v17 snapshot）。
- worktree declaration-before-mkdir与 ledger fsync：
  `design.md:3799-3829,3921-3929`（v17 snapshot）。
- 顶层 recovery schemas只闭合 wire→decoded读侧：
  `design.md:3616-3677`（v17 snapshot）。
- plan只要求 leaf round trip：
  `plan.md:80-83,692-695,950-954`（v17 snapshot）。
- current whole-object JSON persistence seams：
  `packages/backend/src/services/intent/applyChangeset.ts:382-390`、
  `packages/backend/src/services/worktreeBackup.ts:122-131`。这两处只证明集成边界必须明确，
  不把“RFC尚未实施”重复计 finding。

业务影响：可信 legacy recovery主路径可永久卡住 boot barrier，普通 worktree reconstruction无法
执行正常缺失目录恢复；自行发明 serializer又可能让 crash recovery无法重建完整 authority。

Resolution v18：

- 新 G45/D61/AC-61与 design §0.5.1.1a建立 build-bound durable root codec registry，覆盖
  writer obligation、artifact publication、pending control/in-flight、legacy
  adoption/move/operator、legacy backup adoption与 worktree directory/registration/
  stale-cleanup/before-Git/effect/reconstruction roots。
- 每个 root定义无 transform strict `*WireSchema`、wire→decoded `*Schema`、命名 wire/decoded
  type与 input/output compile equality；root registry key与 codec `rootKind`再做 exact equality，
  新增/遗漏 root都 typecheck失败。
- 每个 root只有一个显式 `encode*`；所有 discriminated union逐 case字段构造并以
  `assertNeverDurableBranch`锁 exhaustiveness，禁止 spread/cast。nested identity最终且只能调用
  `encodeArtifactEntryIdentityV3()`，root返回前重过对应 wire schema。
- storage primitive只接受 `CanonicalDurableRootBytesV3<exact-kind>`；唯一 constructor在 root
  wire parse后递归拒绝 bigint，再生成 canonical JSON/digest并 brand。decoded direct stringify、
  generic bigint replacer、`toJSON`与 partial mapper由 source guard禁止。
- test matrix使用 `dev/ino > Number.MAX_SAFE_INTEGER`逐 root、逐 identity-bearing branch执行
  decoded→root encoder→wire parse→JSON→decoded exact round trip；missing/extra/swapped identity
  在 descriptor/filesystem/DB effect前失败。
- kill matrix新增 legacy `moving` fsync后、rename前与 worktree `declared` fsync后、private mkdir前，
  restart必须沿同一 canonical bytes恢复且 effect至多一次。
- v18代表性 executable proof位于
  `/private/tmp/rfc235-root-codec-v18-proof/proof.ts`（436行、13,816 bytes，SHA-256
  `59d3e2e07a4b66f3c4fcb9ea26e200a4c19d5f1604b2b011dad55ca2b781e0b4`）：使用 repo
  Zod 3.25.76定义六态 legacy move wire/decoded root、显式逐 branch encoder、14-key registry
  key/kind equality与超 JS-safe bigint round trip；`tsc --noEmit --strict`和 Bun runtime均 exit 0。
  proof曾真实抓到 `as const` readonly registry与非 readonly expected map不等，修正为 readonly
  equality后才通过。
- 进入 G45、D61、AC-61、T1.7/T9.9/T10.6。

### 19.4 第十七轮 finding coverage audit

| Finding   | v18 public contract owner                  | Negative/recovery proof                                             | 产品可达性                                  |
| --------- | ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------- |
| R17-P1-01 | closed root codec registry + branded bytes | 全 root/branch bigint round trip；moving/mkdir前 kill；source guard | legacy boot与 worktree正常 checkpoint可恢复 |

前一轮 finding复核：

- R16-P1-01 receipt/identity transform分离保持 Closed。
- V15-P1-1 phase-sensitive cleanup保持 Closed。
- V15-P1-2 retained/stale/partial worktree terminal algebra保持 Closed。
- V15-P1-3 cross-field strict read-side binding保持 Closed；v18补其独立写侧 root encoder。

### 19.5 下一步

本轮唯一 P1已折入 v18 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步并完成本地
format/type-shape证明后，创建全新隔离 snapshot执行第十八轮只读门禁。只有 reviewer判定
`APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准实施。当前仍不改
生产代码。

## 20. 第十八轮独立设计门（2026-07-29）

### 20.1 第十八轮隔离门禁证据

- base：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- snapshot：`389992880bc3d2d053cbddb041bc2683496bbead`
- snapshot parent：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- 隔离目录：`/private/tmp/rfc235-design-gate-v18.kciNcv/repo`
- reviewer session：`019fad0a-d327-7330-a5a3-1ffebe9331ed`
- 模式：external Codex `gpt-5.6-sol`、max reasoning、
  `codex exec --ephemeral --sandbox read-only`；未联网、未运行测试/build、未编辑文件。
- prompt：
  `/private/tmp/rfc235-design-gate-v18.kciNcv/gate-v18-prompt.txt`（137行、9,130 bytes），
  SHA-256：
  `df7cc64e79de5a35ace40c2475bace41e78ee6a2bc48e2b63101f83e145ecdfe`
- 完整 reviewer output：
  `/private/tmp/rfc235-design-gate-v18.kciNcv/codex-design-gate-v18-output.md`
  （63行、7,579 bytes），SHA-256：
  `080ac88ffc97ccb721dd06406acd899c148abb0f72d670e35f8998c5c3ade243`
- process exit：0；reviewer token usage：1,269,295
- exact terminal verdict：
  `NEEDS_REVISION — P0=0, P1=2, P2=0`
- reviewer运行中发生一次 transient WebSocket disconnect，内建重试 `1/5`后恢复并完成；完整 output、
  exit code、terminal verdict与 snapshot clean检查均有效，不按门禁失败处理。
- reviewer起止均确认 `HEAD`为指定 commit且
  `git status --porcelain=v1 --untracked-files=all`为空。proposal/design/plan/gate/preflight/
  `STATE.md`/总 `design/plan.md`与门禁前真实工作区逐字节一致。
- reviewer完整读完指定 11份文档；`STATE.md`超长第 556行（44,753 chars）与总
  `design/plan.md`超长第 183行（8,746 chars）按固定字符窗读到 EOF。随后只读核验 current
  Intent frontend/backend/shared、restore/pending/startup、artifact publication/root codec与
  worktree persistence seams。

### 20.2 结论与闭合范围

第十八轮确认：

- R17-P1-01 Closed：14个已声明 durable root具有 strict wire/decoded schema pair、root-specific
  encoder、registry key/kind equality与 branded canonical writer boundary；leaf bigint与
  legacy/worktree kill/source-guard证明继续成立。
- R16 receipt/identity boundary、V15 phase-sensitive cleanup、retained/stale/partial worktree
  terminal algebra与 nested cross-field binding继续 Closed。
- 方案 A的 inline Composer、同源 Dialog、responsive cards、Goal/Generate/Review/Apply、
  mount approval、pinned draft、分步 commit、secret生命周期、长 Owner、desktop/mobile/touch/
  keyboard/axe，以及 RFC-234 ACL/OCC/copy-only/closed secret set/all-or-nothing/current-owner/
  final authority没有新增可计数回归。
- reviewer没有把 publication四态 union的 production schema尚未实现重复计为 finding；现有 role
  prose与 negative matrix足以作为设计合同。
- 两项新 P1分别位于 durable root集合闭合性与跨进程 raw-byte trust boundary，不重复计算前轮
  root encoder或 identity leaf问题。

### 20.3 第十八轮 findings 与 v19 resolution

#### R18-P1-01 — `gap`：restore generation marker漏出 durable root registry

失败序列：

1. restore broker按设计必须在 DB/config/skills交换前后 fsync
   `staging → safety-snapshotted → db-swapped → fs-swapped → db-migrated →
identity-verified → complete`。
2. marker保存 operation/digests/config disposition、staged/old/new exact identity与
   file/tree publication refs；其中 identity含真实 bigint。
3. v18 `DurableArtifactRootKindV3`与 registry只列 14个 artifact/pending/legacy/worktree root，
   没有 restore generation marker，也没有其 wire/decoded schema或 explicit encoder。
4. 严格实现无法在 DB swap前写出 marker；若临时 cast、generic mapper或直接 JSON，又违反
   R17已建立的 writer boundary并可能漏掉 bigint identity。
5. 在 DB exchange与 config/skills exchange之间杀进程后，cold/pending启动只能看到 mixed
   generation，无法用统一 codec加载 marker并决定 exact resume或 repair，可能永久阻断 boot。

source-backed证据：

- v18 14-kind union/registry/codec equality：
  `design/RFC-235-intent-builder-ux/design.md:1022-1152`（v18 snapshot）。
- capability-bearing staged/safety/swapped generation：
  `design.md:1890-1937`（v18 snapshot）。
- 七态 marker及 durable contents：
  `design.md:2782-2795`（v18 snapshot）。
- restore kill矩阵只声明从 marker恢复：
  `design.md:5478-5501`（v18 snapshot）。

业务影响：正常 restore一旦在跨 DB/FS generation窗口崩溃，可能无法安全重启；自行发明
serializer则会重新打开 bigint丢失与 foreign identity恢复风险。

Resolution v19：

- 新 G46/D62/AC-62把 `restore-generation-marker`加入
  `DurableArtifactRootKindV3`、schema闭集、15-key registry与 key/kind compile equality。
- 明确定义 capability-free `RestoreGenerationMarkerV3Wire/Decoded`：staged/safety/DB
  exchange/FS exchange/migration/identity barrier/cleanup形成七态 exact prefix，未到达字段必须
  为 null。所有 nested identity分别使用 canonical wire/decoded leaf。
- `encodeRestoreGenerationMarkerV3()`逐 phase字段构造并以 `assertNever`锁穷举；
  `superRefine`绑定 operation/digest/config preserve-or-replace、published=staged、
  displaced=safety、publication refs、final observation与 exact cleanup。
- marker位于 non-restored broker control root；cold/pending startup都在 DB open前以 exact
  root-specific locator读取。`safety-snapshotted→DB exchange`与
  `db-swapped→config/skills exchange`成为两条必须真实 kill的独立 gate。

#### R18-P1-02 — `underspecified`：磁盘 raw bytes没有唯一 raw→brand→decode合同

失败序列：

1. v18 encoder在当前进程创建 unique-symbol branded
   `CanonicalDurableRootBytesV3<Kind>`，decoder却要求调用方已经持有该 brand。
2. kill/restart后 storage只会返回磁盘 raw bytes；TypeScript brand不会跨进程持久化。
3. v18没有 strict outer frame、raw loader、root-specific lookup或 runtime unforgeability；
   实现者只能 cast/rebrand或绕过 decoder。
4. cast路径会跳过 runtime expected kind、digest、inner canonical bytes与 root cross-field验真；
   structurally valid foreign payload或非 canonical payload可到达 recovery consumer。
5. crash recovery因而可能消费 wrong-kind/stale/被改写 root，随后打开 descriptor、修改
   filesystem或 DB。

source-backed证据：

- v18 brand/encoder/decoder：
  `design/RFC-235-intent-builder-ux/design.md:1046-1092`（v18 snapshot）。
- storage writer只限制 branded输入，未定义 raw read侧：
  `design.md:1088-1152`、`plan.md:55-89,677-714`（v18 snapshot）。
- kill test只说 restart decode same record，没有 raw-frame跨进程步骤：
  `design.md:5620-5635`（v18 snapshot）。

业务影响：所有 durable recovery ledger都可在真实重启时被迫走未验真的私有 bypass；wrong root、
digest bit flip或非 canonical frame可能在副作用前不被发现。

Resolution v19：

- 新 G47/D63/AC-63定义 strict canonical storage frame：
  `{schemaVersion,rootKind,digestAlgorithm,digest,canonicalJson}`。digest覆盖 domain separator +
  exact root kind + payload；外层与内层均要求 byte-for-byte canonical。
- storage module唯一
  `loadCanonicalDurableRootV3(expectedCodec, rawFrame)`依次执行 size、fatal UTF-8、strict outer
  schema、expected kind、domain digest、inner wire parse/recanonicalize与 decoded cross-field
  parse，再调用同一个 private constructor。
- constructor产物登记在 module-private runtime `WeakSet`；decoder同时验证 membership与 exact
  kind。业务 ledger不暴露 `readRaw()`、`rebrand()`或 generic lookup，public API只返回
  root-specific decoded record。
- 跨进程 fixture要求进程 A落 disk frame、进程 B只从 raw bytes与 expected codec恢复；wrong
  kind、digest bit flip、inner/outer key-order/whitespace、duplicate key、BOM/trailing、
  structurally valid foreign payload、invalid UTF-8与 oversize全部 effect前失败。

v19 executable proof：

- 文件：`/private/tmp/rfc235-v19-proof/proof.ts`
- 大小：993行、32,115 bytes；SHA-256：
  `09fc7698ac79421a077c22e8f020cde41870754ef1ca10052b5ec8f37c0aac98`
- 使用 repo Zod 3.25.76；七态 marker有 strict wire union、decoded bigint transform、逐态 encoder、
  cross-field equality与 expected-kind canonical frame loader。
- `tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --types bun`
  exit 0。
- Bun runtime exit 0并输出 `v19 marker+raw-loader proof: ok`；七个 phase分别写入真实 disk frame，
  由七个新 Bun child process raw-load并核对超 JS-safe bigint。上述 tamper/foreign/runtime brand
  forgery负例全部通过。
- 进入 G46–G47、D62–D63、AC-62–AC-63、T1.7/T9.9/T10.6。

### 20.4 第十八轮 finding coverage audit

| Finding   | v19 public contract owner                             | Negative/recovery proof                                         | 产品可达性                                |
| --------- | ----------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| R18-P1-01 | 15-key registry + seven-phase restore marker codec    | 全 phase bigint/cross-field；safety→DB与 DB→FS真 kill           | cold/pending mixed generation可 exact恢复 |
| R18-P1-02 | canonical frame + expected-codec loader + runtime set | 跨进程 disk raw load；kind/digest/canonical/foreign/forgery负例 | 所有 durable ledger重启前有唯一验真边界   |

前一轮 finding复核：

- R17-P1-01 root-specific wire producer保持 Closed；v19只把漏项 marker纳入其闭集。
- R16-P1-01 receipt/identity transform分离保持 Closed。
- V15-P1-1 phase-sensitive cleanup保持 Closed。
- V15-P1-2 retained/stale/partial worktree terminal algebra保持 Closed。
- V15-P1-3 cross-field strict read-side binding保持 Closed。

### 20.5 下一步

两项 P1已折入 v19 proposal/design/plan；`STATE.md`与总 `design/plan.md`同步，Prettier与
marker/raw-loader executable proof均通过。下一步创建全新隔离 snapshot执行第十九轮只读门禁。
只有 reviewer判定 `APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并请求用户明确批准
实施。当前仍不改生产代码。

## 21. 第十九轮隔离复审（Draft v19）

### 21.1 隔离与证据

- 复审 snapshot：`/private/tmp/rfc235-design-gate-v19.NMgpg2/repo`
- snapshot commit：`7aa7df03d5c68db3ae221ad7a4cfdd846aff07ac`
- exact parent / shared-main base：
  `de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- reviewer session：`019fad4b-d5f6-7142-9437-d3c33a13c6ab`
- prompt：
  `/private/tmp/rfc235-design-gate-v19.NMgpg2/gate-v19-prompt.txt`
  - 163 行 / 11,466 bytes
  - SHA-256：
    `23d3a08ffe531bc108114e483e5372fd8988a219afe0620e035aa92b5db0bdbe`
- output：
  `/private/tmp/rfc235-design-gate-v19.NMgpg2/codex-design-gate-v19-output.md`
  - 128 行 / 15,683 bytes
  - SHA-256：
    `38acf129eb894cb4aeb7b76095790abc0c0d6fbc506c4318e10b539c6c53b39a`
- reviewer初始/最终 `HEAD`均为 snapshot commit，初始/最终
  `git status --porcelain=v1 --untracked-files=all`均为空。
- reviewer完整读取 11 份指定文档至 EOF，并核 current frontend/backend/shared source/tests；未修改
  文件、未运行测试/build、未联网。
- 最终判定：
  **`NEEDS_REVISION — P0=1, P1=4, P2=0`**。

### 21.2 Findings

#### R19-P0-01 — `conflict/gap`：restore把 SQLite generation错建模为单文件

失败序列与影响：

1. current DB固定 WAL mode，合法 committed row可只存在于 `db.sqlite-wal`。
2. v19 staged/safety/DB exchange/marker只保存单个 DB identity/digest。
3. `ArtifactFsSlotRoleV3`没有 restore DB/safety DB/WAL/SHM role，closed allowlist下甚至无法签发
   `dbExchange.publication`；marker refinement却要求这些不存在的 role。
4. 只交换主文件会让旧 WAL叠到 restored DB形成 mixed generation；临时 unlink又没有 identity、
   intent、receipt或 crash subphase。
5. current `restore.ts`明确要求先清 WAL/SHM再 rename；现有真实测试已锁 7→2 stale-WAL恢复反例。
6. backup exact-copy保存 DB/WAL/SHM，但 v19没有规定 incoming WAL如何 durable consolidate到 staged
   DB。

业务影响：restore可“成功”到错误 DB，或丢失只在 incoming/live WAL的 committed row，属于自动
误恢复与潜在不可逆数据破坏。

Resolution v20：

- `ArtifactSqliteGenerationV3`以 DB + optional WAL/SHM exact identity/digest/presence为单位。
- incoming trio先 exact-copy到 broker-private root，在私有副本 checkpoint/consolidate；staging
  marker只接受 self-contained DB与 sidecar absent。
- 新增 restore DB/live sidecar以及 safety DB-WAL-SHM/config/Skills独立 slot role，safety copy与
  live publication/removal authority不混用。
- 新增第16个 `restore-sqlite-publication` durable root：
  declared → WAL removing/settled → SHM removing/settled → DB publishing/published；每个 unlink前先
  durable intent，之后 parent fsync与 exact removed receipt。
- safety captured绑定全部 present DB/WAL/SHM bytes；skipped-by-operator只在显式 option下合法，但仍
  保留 live exact observation与 forward ledger。
- checked-in normative appendix直接运行真实 WAL-only incoming、stale live WAL/SHM与 safety trio
  fixture。

#### R19-P1-01 — `gap`：七态 marker schema/encoder/refiner仍只是未定义名字

失败序列与影响：

1. v19 registry引用 `RestoreGenerationMarkerV3Codec`。
2. 14个 phase schema、7个 encoder helper与2个 refinement函数只出现调用点，没有定义。
3. prose与 snapshot外 993行 representative proof不能替代 normative、可由 repo Zod/strict
   TypeScript编译的 design source。
4. 实现者只能自行补 schema/cast/generic mapper，R18 writer/reader closure不可复制。

Resolution v20：

- 新增 checked-in normative
  `design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`。
- 文件真实定义全部 component schema、7个 strict wire phase schema、7个 decoded phase schema、
  7个逐字段 encoder、wire/decoded完整 refiner、codec equality与 runtime fixtures。
- `design.md`明确 appendix与正文同为 normative；冲突时以可执行 appendix为准。
- extra key、错误 prefix/suffix、foreign identity/ref、options/migration错配均 effect前拒绝。

#### R19-P1-02 — `underspecified`：publication ref没有 root-specific locator与 operation digest

失败序列与影响：

1. restart加载 `db-swapped` marker后必须取得 referenced publication receipt。
2. v19 `DurableRootStorageKeyV3`只被引用、未定义 factory/runtime validation。
3. ref只含 id/revision/digest/role，完整 operation在 receipt内。
4. `operationDigest`没有 version/domain/canonical input/算法；raw loader只证明 frame kind/schema，不
   能证明 same-kind receipt属于该 operation。
5. 正常 recovery只能永久 repair或自行 cast/generic lookup。

Resolution v20：

- `DurableRootStorageKeyV3`固定 namespace/root kind/validated segment，并由 module-private factory +
  runtime WeakSet唯一构造。
- `artifactPublicationLocatorFromRefV3`与 `restoreSqlitePublicationLocatorV3`是 root-specific
  locator；业务层不接受 raw path/key。
- operation digest固定为
  `SHA-256("agent-workflow/artifact-fs-operation/v3\0" + canonicalJson(operation))`；restore operation
  含 full input digests/options/options digest。
- lookup后逐字段比较 namespace/kind/id/revision/role/digest/full operation；wrong namespace、
  same-kind foreign receipt、segment collision均 effect前失败。
- `assertRestoreSqlitePublicationRefMatchesV3`另把 SQLite ref与 decoded root的
  publication id/revision/full operation/staged DB identity逐字段绑定；publication root使用完整
  prepared/exchanged/cleanup/repair union，而不是只验证一个截断 header。

#### R19-P1-03 — `gap`：restore options跨 checkpoint丢失，`--no-migrate`无诚实终态

失败序列与影响：

1. current `--no-migrate`是正式的 botched-migration回滚逃生路径。
2. v19 pending record只存 options digest，generation marker/operation甚至没有 digest与三个 boolean。
3. `fs-swapped`后、migration前 kill，restart无法判断 migrate还是 skip。
4. marker强制 `db-migrated`，record没有 applied/skipped discriminant。
5. 任一默认都会违背一类用户指令；repair则让正常 staged restore永久阻断。

Resolution v20：

- canonical `RestoreExecutionOptionsV3`三个 boolean及 options digest进入 pending receipt/in-flight、
  legacy adoption/handoff、restore operation、generation marker与 SQLite root。
- same id changed options是 conflict，不能只比较 digest或补默认。
- migration改为 strict `applied | skipped-no-migrate | not-required`并与 schema delta/options
  cross-field绑定。
- safety改为 `captured | skipped-by-operator`，后一分支只匹配
  `noSafetyBackup=true`，不伪造 backup bytes。

#### R19-P1-04 — `conflict`：DB/Skills只支持 replace，无法表示 absent live target

失败序列与影响：

1. clean-machine cold restore或旧实例可没有 live DB/skills root。
2. v19 safety强制两个 identity，DB/skills exchange强制 displaced identity，cleanup强制 removed。
3. generic broker虽有 no-replace primitive，restore只给 config absent分支，Skills明确强制 replace。
4. 创建 placeholder是在首个合法 checkpoint前改变 live generation且无 receipt。

Resolution v20：

- live DB/config/Skills统一 strict `absent | present(identity,digest)` observation。
- DB/Skills publication统一 `no-replace | replace`：absent时 displaced=null且 cleanup
  not-applicable；present时 displaced=exact live identity且 cleanup removed。
- config保留 preserve/no-replace/replace；empty incoming Skills仍发布真实 sealed empty tree。
- clean app-home cold/pending与 present/absent笛卡尔矩阵进入 AC与 kill test。

### 21.3 历史 closure回归

- R18 marker进入 registry与 raw-frame loader/runtime trust boundary仍 Closed；本轮新增问题分别位于
  SQLite generation、实际 phase definitions与 raw load之后的 semantic locator/ref验证。
- R16 receipt/identity边界、V15 legacy cleanup与 worktree retained/stale/partial algebra继续
  Closed。
- 方案 A主 UX仍完整覆盖 inline Composer、同源 Dialog、responsive cards、Goal/Generate/Review/
  Apply、双栏、mount approval、pinned draft、分步 commit、secret lifecycle、长 Owner、touch/
  keyboard/axe。
- RFC-234 ACL/OCC/copy-only/secret closed set/all-or-nothing/current-owner dispatcher/final in-tx
  authority无新增阻断。

### 21.4 v20 executable evidence

- normative file：
  `design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
- 4,890 行 / 165,608 bytes；SHA-256：
  `e960b7dfc9179ac9e16f1106cf51ce1c7b20474617f76c2fdcc83eae04ce1fd9`。
- 使用 repo固定 Zod 3.25.76。
- strict typecheck：
  `bun x tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --types bun
design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
  exit 0。
- runtime：
  `bun design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
  exit 0，输出
  `rfc235-v20 normative restore generation proof: marker=7 variants=9 sqlite=7 wal=real ok`。
- runtime覆盖 captured/skipped、present/absent、config preserve/replace、DB/Skills四种 presence
  组合与 migration applied/skipped/not-required共9类完整 marker；七个 marker phase逐态执行
  top-level/nested extra key、错误 prefix/suffix、decoded identity进 wire、foreign ref与 unsafe
  revision负例。另覆盖七个 SQLite publication phase、initial/settled sidecar phase约束、
  root/receipt id/revision/role/full-operation/staged-identity/collision负例、超 JS-safe bigint，以及
  真实 incoming WAL-only、live stale WAL/SHM、safety trio与最终 exact DB内容。

### 21.5 下一步

R19的1个P0与4个P1已进入 G48–G52、D64–D68、AC-64–AC-68、T1/T3/T9/T10及 checked-in
normative appendix；`STATE.md`与总 `design/plan.md`已同步。下一步创建全新隔离 snapshot执行
第二十轮只读门禁。只有 reviewer判定 `APPROVED — P0=0, P1=0, P2=0`才把 RFC更新为设计门通过并
请求用户明确批准实施。当前仍不改生产代码。

## 22. 第二十轮隔离复审（Draft v20）

### 22.1 隔离与证据

- gate root：`/private/tmp/rfc235-design-gate-v20.8O7MrP`
- isolated repo：`/private/tmp/rfc235-design-gate-v20.8O7MrP/repo`
- snapshot：`5ebdfa356d96550f10e07100d44dae8e11539f7d`
- exact parent：`de3f2c4eaaaa28b4fcd7c6f6ae931ecd88d40d4f`
- 初始/最终 `git status --porcelain=v1 --untracked-files=all`均为空。
- reviewer：外部 `gpt-5.6-sol`，reasoning effort `max`，read-only；
  session id `019fadac-501f-7b83-837a-36c8e3292646`。
- output：
  `/private/tmp/rfc235-design-gate-v20.8O7MrP/codex-design-gate-v20-output.md`
  （120 lines / 14,191 bytes），SHA-256
  `328216a0313cf6d37c82268eb6dc0dc3ff67830c44ba7ad5c4491704974bf9e5`。
- reviewer逐字读取 RFC三件套、gate report、4,890行 normative appendix与指定 current
  implementation files；appendix snapshot SHA-256
  `e960b7dfc9179ac9e16f1106cf51ce1c7b20474617f76c2fdcc83eae04ce1fd9`。
- 结论：**`NEEDS_REVISION — P0=0, P1=4, P2=0`**。

### 22.2 Findings 与 v21 resolution

#### R20-P1-01 — `conflict`：long-lived marker引用 mutable root revision

失败序列是合法 inner checkpoint：marker先引用 SQLite `declared` revision 1，root随后持久化
`wal-removing` revision 2并在 outer marker更新前崩溃。v20 locator只能加载“当前 root”，ref
matcher又要求 revision 1，导致合法 revision 2被判 foreign；继续用 revision 1则丢 record-before-
unlink intent。artifact prepared→exchanged→cleanup也有同一矛盾。

Resolution v21：

- artifact与SQLite root的每一 revision成为不可变 canonical frame；ref与 trusted storage key均
  带 exact `rootId/revision/frameDigest`，旧 frame禁止覆写。
- revision>1必须保存并验证`previousRevision/previousFrameDigest`。
  `latestArtifactPublicationDescendantV3`与
  `latestRestoreSqlitePublicationDescendantV3`先验真 marker anchor，再只沿同 root唯一连续
  lineage前进；gap/fork/digest drift进入 repair。
- `safety-snapshotted` marker只引用真实 declaration anchor；只有`db-swapped`及以后引用 exact
  `db-published` checkpoint。proof不再把未来 revision 7倒灌进早期 marker。
- AC-69/T1.12/T3/T9要求每个 inner frame fsync后、outer marker更新前真 kill，restart必须找到
  unique latest descendant且不能把旧合法 anchor判 foreign。

#### R20-P1-02 — `gap`：publication verifier未绑定 phase/mode与 exact identities

v20 matcher只验证 id/revision/role/full operation；prepared、alternate同 operation receipt或另一
组 staged/published/displaced identities仍可冒充 barrier/cleanup。role multiset还允许同一
receipt id用不同 revision跨 role占位。

Resolution v21：

- `ArtifactPublicationExpectedProjectionV3`显式携 required phase、mode、staged identity/digest、
  expected/published/displaced identity；`assertPublicationRefMatchesV3`逐字段核对。
- `assertRestoreSafetyPublicationReceiptsV3`只接受
  `cleanup-verified + no-replace + exact captured identity/digest`。
- `assertRestoreExchangePublicationReceiptsV3`从 marker staged/live/exchange facts构造 barrier/
  cleanup projection；barrier refs逐字段等于 exchange refs，cleanup refs必须是同 receipt lineage
  的 cleanup-verified descendant。
- role唯一性改按`receiptId`，不是`receiptId:revision`。runtime proof加入
  prepared-as-exchanged、wrong mode/staged digest/staged+published/expected+displaced、
  alternate receipt与same-id-cross-role负例。

#### R20-P1-03 — `gap`：repair transition可丢失已知 forensic authority

v20 SQLite repair允许`databasePublication/database`全 null，artifact repair允许
expected/published/displaced退回 null；sidecar removed又丢`intentRevision`。exchange syscall
歧义后进入 repair时，operator会失去已知 locator/identity，无法安全分类。

Resolution v21：

- artifact repair改为按`repairFromPhase=prepared|exchanged|cleanup-verified`分型的 lossless
  union，每 branch保留进入 repair前全部字段。
- SQLite forensic按 declared到db-published七个 exact prefix分支建模；db-publishing保留
  database publication，db-published同时保留相同 publication与database exchange；removed
  sidecar继续保留产生 intent 的 revision。
- `assertArtifactPublicationTransitionV3`与
  `assertRestoreSqlitePublicationTransitionV3`先验 lineage/base，再要求 repair forensic的
  canonical projection逐字段等于 previous immutable frame；repair terminal。
- runtime proof覆盖artifact exchanged→repair、SQLite db-publishing/wal-settled→repair，
  drop/rewrite publication、identity与sidecar intent revision全部失败。

#### R20-P1-04 — `conflict`：legacy adoption/operator reapply没有完整 options authority

v20 prose声称完整 options贯穿 legacy handoff，但 adoption所有 phase都允许
`options/optionsDigest=null`，operator request/receipt/control又没有 options。若在`v3-staged`或
`legacy-held`后、V3 marker前崩溃，restart只能猜`noMigrate/noSafetyBackup/skipIntegrityCheck`。

Resolution v21：

- adoption改为 phase-discriminated union：
  evidence-only/quarantine/repair可明确`optionsAuthority=unavailable|bound`；
  `operator-confirmation-required`及全部 reapply phases强制
  `optionsAuthority.kind='bound'`。
- operator request的reapply分支、reapply receipt及
  claimed/v3-staged/legacy-moving/legacy-held/v3-marker-published/settled/repair control均携完整
  `options/optionsDigest`；quarantine是独立无 options分支。
- canonical validator把 request/adoption/control/receipt/new operation逐字段与重算 digest绑定；
  repair保留上一 authority，missing/changed/current-default fallback在 archive open前失败。
- AC-72/T1.12/T9加入各 handoff checkpoint真 kill及 options null/changed/digest mismatch负例。

### 22.3 用户新增需求：Intent turn复用统一 Session执行视图

第二十轮后，用户明确要求“在意图构建任务里，也要显示 session 的执行过程，就和其他 session
渲染界面一样，可以复用过来”。current source确认：

- task侧稳定 renderer是
  `SessionTab → SessionBody → ConversationFlow/SubagentBlock`；真正通用的是
  `SessionViewResponseSchema + parseSessionTree + ConversationFlow`，而 attempt picker、injected
  memories与runtime inventory是task-only外壳。
- Intent detail目前只渲染flat turns；`IntentTurnDto.runMeta`只是generic summary。
- `runSystemAgent`已经用 runtime driver解析normalized events，却只累计visible text，且在
  private store cleanup前没有把parent/child session持久化。
- `node_run_events`有required node-run FK，不能给Intent伪造node run。

v21据此加入G57/D73/AC-73及design §5.6/T1/T2/T5/T7/T9：

1. next migration新增turn-owned、seq/dedupe/row+byte bounded的`intent_turn_events`与capture
   summary；capture failure/truncation独立于Intent业务结果。
2. `runSystemAgent`与现有OpenCode/Claude live/post-run capture抽generic
   `SystemAgentEventSinkV1/SessionCaptureSink`；post-run capture发生在private store cleanup前，
   node adapter保持现有rows，Intent adapter写新表。
3. 新owner/system-admin-audit read endpoint严格验证route session与agent turn，再用既有
   `parseSessionTree + SessionViewResponseSchema`投影；foreign/missing同形404，WS只发locator/seq。
4. frontend只抽通用`SessionConversationPanel`并继续复用
   `ConversationFlow/SubagentBlock`；`SessionTab`保留attempt/memory/inventory。Intent最新running
   默认展开、历史折叠、WS断线poll兜底、局部load/capture失败不替换questions/draft。

### 22.4 v21 executable evidence

- normative file：
  `design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
- 6,467 lines / 223,933 bytes；SHA-256：
  `12da1431e45b0bca42b5a9223fab295e721fd2a5a4c16fdbc4469c4f84110778`。
- strict typecheck：
  `bun x tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --types bun
design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
  exit 0。
- runtime：
  `bun design/RFC-235-intent-builder-ux/restore-generation-v3.normative.ts`
  exit 0，输出
  `rfc235-v21 normative restore proof: marker=7 variants=9 sqlite=7 artifact=lineage-bound repair=lossless wal=real ok`。
- 在v20九类marker、七个SQLite phases与real WAL proof之上，v21新增artifact/SQLite immutable
  lineage/latest descendant、phase/mode/digest/identity semantic projections、safety/barrier/
  cleanup receipt binding，以及artifact/SQLite lossless repair正反例。

### 22.5 下一步

R20四个P1与用户新增Intent session要求已进入G53–G57、D69–D73、AC-69–AC-73、design、plan、
normative appendix、`STATE.md`与总`design/plan.md`。下一步创建全新隔离 snapshot执行第二十一轮
只读门禁；只有 reviewer判定`APPROVED — P0=0, P1=0, P2=0`才请求用户明确批准实施。当前仍不改
生产代码。
