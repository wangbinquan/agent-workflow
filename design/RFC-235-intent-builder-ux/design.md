# RFC-235 意图构建完整创建体验 UX 重构 — design

> 读序：先读 [proposal.md](./proposal.md)。v22 是当前规范；下文 v21 的 artifact/recovery
> 设计只保留历史审计价值，与 v22 或 RFC-276 冲突处均已被取代。RFC-234 的权限、安全、OCC、
> secret 与 all-or-nothing 语义继续是权威。

## 0A. v22 当前主干设计

### 0A.1 读模型与四步状态

shared 新增 strict `IntentJourneySnapshotSchema`：

```ts
type IntentJourneySnapshot = {
  kind:
    | 'goal'
    | 'generating'
    | 'clarifying'
    | 'review-ready'
    | 'review-blocked'
    | 'applying'
    | 'applied'
    | 'error'
    | 'archived'
  step: 1 | 2 | 3 | 4
  completedThrough: 0 | 1 | 2 | 3 | 4
  reason:
    | 'describe-goal'
    | 'generation-running'
    | 'answer-questions'
    | 'review-draft'
    | 'draft-stale'
    | 'draft-invalid'
    | 'apply-running'
    | 'generation-failed'
    | 'apply-failed'
    | 'applied'
    | 'archived'
}
```

`IntentSessionSummary.journey` 是列表与详情 header/rail 的唯一业务状态输入。backend 按同一纯函数
投影：latest unsettled journal → Apply running；in-flight → Generate running；latest agent
questions → Clarify；current draft stale/invalid/clean → Review blocked/ready；latest failed journal
且仍针对 current draft → Apply error；latest agent error → Generate error；commit 后无 current
draft → Applied；否则 Goal。archive 只覆盖 `kind/reason`，保留计算出的 step/completion，让历史
位置仍可读。浏览器只负责翻译和布局，不从计数器猜状态。

`GET /api/intent-sessions?page=1` additive 返回 strict `{items,nextCursor}`，`limit` 默认 12、最大
50；不带 `page=1` 的既有调用继续返回 legacy array，避免打断外部脚本。cursor 绑定
`updatedAt + id`，查询按两者倒序，下一页使用严格 `<`，保证静态结果集在同毫秒更新值下也不重
不漏；活跃任务在翻页期间更新会改变排序，因此 Intent WS invalidation 必须清空 cursor pages、
从第一页重取，frontend 仍按 session id 防御性去重，不能宣称跨并发更新的 snapshot isolation。
`status/all` 继续生效；坏 cursor/limit 返回 `intent-invalid`。frontend 使用“加载更多”，刷新第一页
时保留已渲染内容直到新响应落定。

### 0A.1a generation reservation

当前 route 在 user turn 落库后才异步 resolve runtime，再由 `runIntentTurn` mint running turn；配置
失败或两个标签页并发时会留下“消息已收下、没有 in-flight/error”的不可解释状态。v22 不新建表，
但把既有 row 写法收成一个 transaction：

- create：session + initial user turn + agent `running` turn + `inFlightTurnId` 同时落库；
- message/answers：fresh owner/active/no-apply gate + user turn + agent `running` turn 同时落库；
- retry：fresh gate + agent `running` turn同一 transaction；
- `runIntentTurn` 只消费 exact reserved turn id/envelope nonce/context revision，不再自行抢 slot；
- runtime resolution、dump、spawn 任一步失败都 settle 该 exact running row 为 typed error，并清 exact
  in-flight slot；cancel/supersede 仍走既有 context CAS。

这样 create response 与 mutation 202 一旦成功，summary 必然已经是 Generate step；同 session 两个
并发 mutation 只有一个能拿到 reservation，另一个在写用户 turn 前 409，不产生 orphan 对话历史。
budget gate也在 reservation transaction 内判定，失败不写 user turn。无需 migration：使用现有
`intent_turns` / `in_flight_turn_id` / `envelope_nonce` 列。

### 0A.2 actor-safe mount 与审批

detail 的 mounted root 投影为 `{handle,resourceType,resourceId,displayName,detail}`；`displayName` 由
当前 actor 可见 catalog 投影。不可见/已删除资源返回中性 fallback，不向非审计 actor泄露历史
名称。`resourceId` 只为已有 picker/route mutation 兼容保留，不作为 UI 主文案。

detail 另返回 latest unresolved `mountSuggestions[]`：原始 `{resourceType,name,reason}` 来自最近
agent turn；backend 只在 actor 当前可见 catalog 中做 exact-name 匹配，返回 0..N 个
`candidates{id,name,description}`。0 表示当前不可解析；N>1 由用户明确选一个，不按名称猜。
在 source agent turn 后已有 `mount-approval` turn 时，该批不再 pending。

`POST /mount-approvals` 升级为 source-bound strict body：

```ts
{
  sourceTurnId: string
  expectedTurnSeq: number
  expectedContextRevision: number
  decisions: Array<
    | {resourceType:string; name:string; action:'approve'; resourceId:string}
    | {resourceType:string; name:string; action:'reject'}
  >
}
```

backend 先做 owner 404 gate，随后在一个 transaction 内验证 source 是本 session 的 agent
questions/changeset turn、expected seq/context 仍匹配、每个 decision 精确对应 source 中首次出现的
request、decision key 不重复、所有 request 都有且只有一个 outcome，并以
`canViewResourceInTx` 重验 approve candidate 仍是当前 actor 可见且 exact-name 匹配；然后才去重
concrete refs、更新 manifest、context revision 只增一次、写一个语义完整的 approval turn、turn
seq 只增一次。任一候选失效则整批失败；admin audit 仍是 404-shape read-only。HTTP receipt 返回
source identity、ordered approved handles/rejected names、resulting context/turn revision，detail 历史
复用同一 strict content。questions 与 requests 同轮时，UI 必须先关闭整批 request，再允许提交
answers，避免 answers 启动下一轮后旧建议从 pending surface 消失。

### 0A.3 信息架构

```text
/intent
├─ Goal composer
│  ├─ Auto mode（独立整行默认选择）
│  └─ Choose type（六类 3×2 / mobile 2×3）
└─ Recent tasks（12 items + Load more）

/intent/$sessionId
├─ PageHeader（标题 + secondary actions；不重复阶段 chip）
├─ Four-step rail（唯一阶段摘要 + 当前原因）
├─ Mobile TabBar: Build | Review（desktop 隐藏但两栏同时显示）
└─ Workspace
   ├─ Build
   │  ├─ semantic timeline
   │  ├─ pending questions / mount approvals
   │  ├─ mounted context
   │  └─ continue composer
   └─ Review
      ├─ state-specific empty/blocking state
      ├─ op outline + one selected rich preview
      ├─ sticky current action
      └─ commit history
```

移动端默认页签由 `journey.reason` 决定：review-draft/draft-stale/draft-invalid/apply-* /applied 打开
Review，其余打开 Build。仅首次进入或 session id 变化时选择默认；用户手动切换后，后台刷新不得
夺回页签。两个 panel 始终 mounted，以 `hidden`/CSS 切可见性，保留 Session 折叠、问题选择和预览
相机状态。desktop ≥1080px 忽略 active tab并显示双栏。

### 0A.4 semantic timeline 与 review scaling

timeline 先建立 `(question turn seq,id) → question label/options` 索引：answers turn 以 question
文本 + 已选值呈现；找不到 source 时显示中性“已提交 N 个回答”，不得 fallback 为 JSON。
mount-approval 以“已挂载/已拒绝”分组呈现；changeset 显示 summary/op count；error 继续使用 RFC-273
诊断；agent turn 下继续复用 `IntentTurnSession → SessionConversationPanel`，不复制 renderer。

Review 将 64-op 上限视为真实规模：左侧 outline 渲染轻量 action/type/name/error count，右侧只
mount selected op 的 `IntentOpPreview`。默认选择第一个 blocking op，否则第一个 op；draft identity
变化时重选，普通 refetch 保持用户选择。工作流预览继续使用只读 `WorkflowCanvas`，不新增 canvas。
空状态按 generating/clarifying/error/applied/goal 分文案；CTA 只有一个，sticky 在 review panel
底部，disabled 原因就地可读。

### 0A.5 Commit Stepper 与 mutation identity

三步固定为 Strategy → Details → Review。无 update 时 Strategy 显示“全部新建”；无 slots 时
Details 显示“无需补充”，仍保持稳定的三步心智模型。Next 只校验当前步；Review 展示每个 update
的 modify/copy、各 slot 的完成状态与资源数，不回显 secret value。

dialog open 时 mint 一次 ULID；网络错误重试与 response-loss reconciliation 复用它。只有成功或
用户关闭 dialog 后才销毁 id。commit pending 时 `Dialog.dismissDisabled=true`，关闭按钮、Esc、
overlay、Back/submit 均不能开启第二次 mutation。server 现有 `(sessionId,clientMutationId)` journal
幂等合同继续权威。

### 0A.6 明确不做

- 不迁移 Intent 到 `BundleApply`，不新建通用 mutation ledger。
- 不恢复 sandbox/containment、verified identity、artifact V3、backup/restore 或 worktree recovery。
- 不改变六类 changeset wire、secret carrier、ACL 权限点或 apply 的 copy-only/final authority。
- 不让 UI 直接解析 DB JSON 来决定权限或副作用；新 wire 必须 shared strict parse。

## 0. 总览

本 RFC 把现有两个 route 内联巨型 JSX 拆为四层：

```text
/intent
├─ IntentCreateComposer (inline)
└─ IntentSessionList (responsive link cards)

/intent?create=true...
└─ Dialog(size=lg)
   └─ IntentCreateComposer (dialog; same fields/payload builder)

/intent/$sessionId
├─ IntentJourneyProgress (pure projection, non-interactive)
└─ IntentSessionWorkspace
   ├─ IntentConversation (mount context + timeline + questions + composer)
   └─ IntentReviewWorkspace (current draft + commits + CTA)

CommitDialog
└─ Stepper (strategy? → required-inputs? → review)
```

前端的主读取模型仍是：

```text
IntentSessionDetail
  → session / turns / mounts / currentDraft / commits
  → shared schema parse (fail closed)
  → deriveIntentJourneyState(detail)
  → presentational view-models
```

任何 UI view-model 都不能回写或替代服务端 gate。receipt-bearing mutation identity 由统一
ledger 签收，generation/source/apply 只投影它的 anchor；UI 只消费 receipt，不用文本、墙钟或
另一标签页产生的 revision 猜测“本次请求已成功”。

### 0.1 Supporting contract 总图

```text
create/message/answers/retry/mount-approvals/commit
  └─ normalizeIntentMutationV1 (the only executor input)
     └─ intent_mutation_ledger (owner + clientMutationId unique)
        ├─ endpoint + scope + intent-normalized-v1 HMAC
        ├─ exact replay → original typed anchor
        └─ endpoint/body mismatch → fail closed before freshness gates

create/message/answers/retry (new ledger id)
  └─ one db transaction
     ├─ validate fresh owner/active/turn/source
     ├─ persist ledger + request anchor + queued agent running turn
     │  (runAsUserId + current-session-owner-v1)
     └─ set inFlightTurnId
        └─ dispatcher current-owner hydrate + claim + live-owner registry
           ├─ best-effort started event
           ├─ freeze current-owner disclosure snapshot
           ├─ build seed outside DB transaction
           ├─ final disclosure admission CAS immediately before spawn
           ├─ async runtime resolve/run (zero ordinary-owner system fallback)
           └─ settle that exact agent turn + WS finished
              (periodic orphan reconciliation closes lost handoff)

mount approvals
  └─ immutable owner scope gate before private source hydration
     └─ one db transaction
     ├─ validate sourceTurnId/expectedTurnSeq
     ├─ re-authorize every concrete resource
     ├─ apply the whole normalized decision batch
     └─ persist one source-bound receipt turn
        └─ strict same-shape HTTP/detail receipt + resultingTurnSeq

commit
  └─ ledger fingerprint + journal attemptSeq + draft identity
     ├─ durable current-session-owner run-as
     ├─ prepared WS invalidation
     ├─ v3 exact Plugin generation / Skill reserve receipts before filesystem actions
     ├─ descriptor-relative ArtifactFsCapabilityV3 for every host writer
     ├─ exact-leaf filesystem sandbox for npm/git/lifecycle
     ├─ persisted kernel-backed containment identity + supervisor public key before GO
     ├─ final current-user + per-target copy-only/ACL/reference authorization
     ├─ applying/committed or compensating/repair-required
     ├─ strict reverse cleanup under a durable compensation claim
     ├─ failed only after every artifact is proven absent
     └─ terminal WS invalidation + ordered detail DTO

create initial mount / manual add-remove-rebase
  └─ one db transaction
     ├─ fresh owner + active + exact context + no run/apply
     ├─ create/add: canViewResourceInTx
     └─ conditional update changes === 1
```

#### 0.1.1 Artifact threat boundary

artifact safety必须先声明能证明什么，不能用一个无法实现的“same UID全隔离”口号替代：

- **边界内**：daemon自身并发/崩溃/重启、被本 RFC containment约束的 agent、npm/git及 lifecycle
  descendants、恶意 package制造的 `setsid`/double-fork、symlink/hardlink/mount输入、TOCTOU与
  stale receipt/control replay。package child只能看到其 private mount/PID view，不能直接读取
  app DB、app-home、proof/control root或 authority parent；
- **边界外（host compromise）**：任意已经 unsandboxed、可直接改写 app DB、app-home canonical
  roots或 executable的 same-UID host process，以及 root/kernel compromise。这类 actor可以直接
  改 journal/public key/资源本身，任何应用内 receipt都无法形成隔离；部署必须让不受信代码进入
  OS containment，而不是与 daemon共享完整 host authority；
- **仍需证明的 same-UID process防线**：即使不把完整 host compromise纳入支持边界，Linux exact
  qualification也必须启动不持有 app-state path authority的 same-UID sibling，确认
  `ptrace/process_vm_readv`、`/proc/<pid>/mem`、`/proc/<pid>/fd`、control frame injection与旧
  signature replay均失败。daemon和 supervisor在创建/接收 artifact control fd前设置
  `PR_SET_DUMPABLE=0`、`RLIMIT_CORE=0`；signer memory另 `mlock + MADV_DONTDUMP`。任一 primitive
  不可用，Linux npm/git capability unavailable。

该边界不减弱“外部 sentinel零写”测试：所有测试攻击者都从真实 child/container API出发，host
broker/restore的 raw path绕过由 source guard阻断。测试不能通过直接改 DB/public key来模拟一个
本 RFC从未声称可抵御的 host takeover。

### 0.2 Migration 与持久身份

使用下一个有序 migration，旧行以 nullable/default 兼容，新增写路径必须填值：

- 新增 `intent_mutation_ledger`
  - `id TEXT PRIMARY KEY`
  - `owner_user_id TEXT NOT NULL`
  - `session_id TEXT NULL`（仅 `legacy-ambiguous` tombstone 可空；新写必须非空）
  - `client_mutation_id TEXT NOT NULL`
  - `endpoint_kind TEXT NOT NULL`
  - `fingerprint_version TEXT NOT NULL`
  - `fingerprint_key_id TEXT NULL`
  - `request_fingerprint TEXT NULL`
  - `anchor_kind TEXT NOT NULL`
  - `anchor_id TEXT NULL`
  - `created_at INTEGER NOT NULL`
  - unique `(owner_user_id, client_mutation_id)`；这是 create/session/turn/journal 共用的唯一
    replay namespace
- `intent_sessions`
  - `apply_attempt_seq INTEGER NOT NULL DEFAULT 0`
  - `artifact_hint TEXT NULL`：新 create只允许 shared六类 enum；session lifetime immutable；
    Auto/modify/legacy为 null
- `intent_turns`
  - `client_mutation_id TEXT NULL`
  - `source_turn_id TEXT NULL`
  - `generation_turn_id TEXT NULL`
  - `expected_turn_seq INTEGER NULL`
  - `run_as_user_id TEXT NULL`
  - `run_as_policy TEXT NULL`
  - `runner_claim_id TEXT NULL`
  - `runner_claimed_at INTEGER NULL`
  - `dump_admission_digest TEXT NULL`
  - `dump_admitted_at INTEGER NULL`
  - unique `(session_id, client_mutation_id)`
- `intent_apply_journal`
  - `attempt_seq INTEGER`：migration 按每个 session 的 `(created_at,id)` 给旧行稳定回填后设为
    required/default-free 新写字段
  - `error_code TEXT NULL`
  - `recovery_code TEXT NULL`
  - `run_as_user_id TEXT NULL`
  - `run_as_policy TEXT NULL`
  - `prepared_artifacts_version INTEGER NOT NULL DEFAULT 1`；新写固定为 3
  - `prepared_artifacts_revision INTEGER NOT NULL DEFAULT 0`
  - `artifact_cleanup_verified_at INTEGER NULL`
  - `compensation_claim_id TEXT NULL`
  - `compensation_claimed_at INTEGER NULL`
  - `state` 新增 `compensating|repair-required`；两者均为 unsettled
  - unique `(session_id, attempt_seq)`

ledger 的 `request_fingerprint` 只从唯一 normalized execution object 计算：

```ts
type IntentMutationEndpoint =
  | 'create'
  | 'message'
  | 'answers'
  | 'retry'
  | 'mount-approvals'
  | 'commit'

interface NormalizedIntentMutationV1<E extends IntentMutationEndpoint> {
  readonly __brand: 'NormalizedIntentMutationV1'
  clientMutationId: string
  fingerprintVersion: 'intent-normalized-v1'
  endpointKind: E
  scope: {
    ownerUserId: string // 只来自 authenticated actor/session，不信任 wire
    sessionId: string | null // create 为 null；其余必须是 exact route session
  }
  body: NormalizedIntentMutationBody[E]
}

interface AuthorizedIntentMutationScopeV1 {
  readonly __brand: 'AuthorizedIntentMutationScopeV1'
  ownerUserId: string
  sessionId: string
}
```

create 在 route strict parse 后可直接调用
`normalizeIntentMutationV1({endpointKind,scope,parsedBody})`。其余 session-scoped endpoint
必须先由 `authorizeIntentMutationScopeV1` 以 exact route session +
`owner_user_id=actor.user.id` 取得 branded scope；answers/approvals 再用该 scope读取 exact
`turn.session_id=scope.sessionId` 的 source，之后才调用
`normalizeIntentMutationV1({endpointKind,scope,parsedBody,source?})`。source loader与 normalizer
的 public signature不接受未授权 route id。后续 service 的 ledger
claim、turn/session/journal writer、mount allocator 与 apply resolver 的 public signature 只接受
上述 branded object，不再接受 wire/raw parsed type。`clientMutationId` 只作 owner-scoped ledger
key；canonical bytes 是同一对象的
`{fingerprintVersion,endpointKind,scope,body}`，executor 直接消费同一 `body` reference。不得再
构造一份“fingerprint body”，也不得在 HMAC 后回到 raw array。

create 的 request scope固定 `sessionId=null`，因为 session尚未存在；transaction预生成 session
id后把它写入 ledger `session_id/anchor_id` 作为结果 anchor。replay 比较的仍是 normalized create
scope/body，再验证该非空 anchor指向原 session，不能把结果 id反灌进 fingerprint造成首写/重放
字节不同。

各 endpoint 的 v1 语义固定如下：

| endpoint        | string/default 规则                                                                | array 规则与 executor 输入                                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create          | `message.trim()`；trim 后空则拒绝。`hint?.trim()`；空 hint 省略；其余 Unicode 不改 | absent/empty mounts 均物化为 `[]`；按 wire 顺序保留 exact `(resourceType,resourceId)` 的首次出现。该顺序直接分配 handle，所以不同 distinct-mount 顺序是 changed body                                            |
| message         | `message.trim()`；trim 后空则拒绝                                                  | 无；`expectedTurnSeq` 原值进入 normalized body                                                                                                                                                                  |
| answers         | `other?.trim()`；空 other 省略；option 文本保持 source 原字节                      | source questions 先 safeParse，每题 options 按精确文本首次出现顺序去重；duplicate/missing/extra question id 拒绝。single必须恰选1项，multi选1..N项；picked拒绝 duplicate/非法值并按 source question/option 顺序 |
| retry           | 无字符串 default                                                                   | `sourceTurnId/expectedTurnSeq` 原值进入 normalized body                                                                                                                                                         |
| mount-approvals | type/name/resourceId 保持精确字节                                                  | source requests 先按 `(resourceType,name)` 首次出现顺序去重；decision duplicate/missing/extra 拒绝，再按该 source 顺序输出；executor/receipt 消费这一顺序                                                       |
| commit          | slot `value`（含 secret/human/waiver）逐字保留，不 trim、不 case-fold              | absent decisions/slots 均物化为 `[]`；先拒绝 duplicate `opId` 与任一重复 `(opId,slotId)`；present decision 的缺省 applyMode 物化为 `modify`，再按 `opId`、每项 slots 按 `slotId` 排序                           |

answers/approvals 的 `source` 是在 immutable owner scope gate **之后**，按
`scope.sessionId + sourceTurnId` 读取并 safeParse 的 durable turn 内容，不要求它仍 fresh，因此
exact owner replay 可在 session 已推进/归档后重建相同 normalized bytes；freshness/source
current 检查仍只对新 ledger id执行。owner scope gate不检查 status/turnSeq，因而不是 freshness；
foreign/manager/system-admin auditor 对 source-aware valid/invalid body一律在 source read/parse
之前得到 `intent-session-not-found`。commit 的 draft/slot validity也属于新 id freshness，不得为了
normalization 把 raw secret写入任何中间表。normalizer 返回后 raw parsed object立即失去引用；
开发期 source guard禁止 executor import wire schema type。

canonical JSON 只负责从 normalized object 确定字节；companion helper 先以 HKDF-SHA-256 从现有
host `secret.key` 派生 domain `intent-mutation:normalized-v1` 的独立子 key，再计算
HMAC-SHA-256，禁止直接把 AES key跨协议复用。ledger 同时保存由高熵子 key单向派生的非敏感
`fingerprint_key_id`，用来区分 body mismatch 与异机恢复/换 key；key id不等于 key且不能用于
重算 HMAC。这样 message 与 commit secret 都没有可离线枚举的普通 hash，raw request/secret 也不
落 ledger。fingerprinter 从 daemon startup 注入 service；测试使用固定 key。相同 id 只有
endpoint、owner、session scope、key id与 fingerprint 全相同才是 replay；同 key不同 fingerprint
返回 `intent-mutation-id-reused`，key id不匹配返回
`intent-mutation-fingerprint-unverifiable`。`clientMutationId/fingerprint/ledger id` 都不进入
agent prompt；fingerprint/key id不进入 HTTP DTO。ledger 新写必须固定
`fingerprint_version='intent-normalized-v1'`；任何未知 version 与 legacy version 都只能只读
reconcile，不能执行或重新 fingerprint。

migration 顺序必须显式：

1. SQLite table rebuild/临时列按每 session 的 `(created_at,id)` 给旧 journal 稳定回填
   `attempt_seq=1..N`。
2. 执行
   `intent_sessions.apply_attempt_seq = COALESCE(MAX(intent_apply_journal.attempt_seq),0)`，再建立
   journal `NOT NULL` 与 unique；不能把旧 session 留在默认 0。
3. 为旧 journal 回填 ledger。旧 request decisions 不存在，故
   `fingerprint_version='legacy-unverifiable'`、fingerprint 为 null；未来 POST 必须返回
   `intent-mutation-fingerprint-unverifiable`，由 detail/journal 只读 reconcile，绝不当 exact
   replay。
4. 若旧数据出现同 owner/client id 的跨 session journal collision，聚合为一个
   `anchor_kind='legacy-ambiguous'` tombstone；保留原 journal 历史，但永久拒绝该 id 的新副作用。
5. 旧 running turn 的 `run_as_*` 保持 null并由 listener 前 boot recovery terminal；migration
   不从历史 route/credential猜 run-as，也不允许 dispatcher claim nullable/unknown policy row。
   新 `dump_admission_*` 保持 null。
6. 旧 apply journal 的 `run_as_*` 保持 null，不能重新进入 final transaction。migration先以
   strict parser读取旧 artifact array：带 exact `skillId/opId` 的 Skill entry可转成 v3
   `skill-reserve`（忽略并拒绝不匹配的 legacy absolute path）；只有 `pluginId` 的
   `plugin-install`没有 generation authority，绝不扫描/猜目录。
7. 旧 `prepared/applying` 转为 `compensating`；若全部 artifact均可转成 exact v3 receipt则走
   同一严格 cleanup，只有成功后才 terminal
   `intent-apply-principal-unavailable`。含不可证明 Plugin identity、损坏 receipt或 path
   mismatch的 row转 `repair-required`并阻断 session write；保守 generation GC/doctor只有在
   证明该 plugin不存在未引用、未被其它 v3 receipt/active install持有的 generation后才可收口。
   既有 terminal `failed/committed`只读保留历史，`artifact_cleanup_verified_at=null`，不倒推
   “当年已补偿”；history把 v1 failed标为 legacy cleanup unverified。committed仍只允许幂等
   post-commit roll-forward。
8. migration fixture 实际执行升级后的下一次 claim，必须得到 `MAX(attemptSeq)+1`，并覆盖
   v1 Skill可升级、v1 Plugin repair-required、损坏 artifact fail closed与历史 terminal可读。

### 0.2.1 Model input、artifact hint 与 host capability

现有 `hint`只留在首轮 turn content、`turnDisplayText()`又只返回 message，ChoiceCard因而是
no-op；现有 prompt还把 Plugin/Workflow字段写错。v11把 hint、pre-create capability、
session-scoped model capability与 actor-selected Plugin source收成 versioned contracts，避免用
只有 session建立后才存在的 handle回答 Composer建立 session之前的问题。

shared新增：

```ts
export const IntentArtifactHintSchema = z.enum([
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
])
export type IntentArtifactHint = z.infer<typeof IntentArtifactHintSchema>
export const INTENT_MODEL_CONTRACT_VERSION = 3 as const

interface IntentConcreteFileSourceDto {
  handle: IntentHandle
  displayName: string
  bindingDigest: string // HMAC(server-only source fence)，不是 path/spec hash
}

interface IntentPreSessionSourceGrantDto {
  token: string // opaque authenticated envelope；没有 path/spec/resource bytes
  displayName: string
  expiresAt: string
}

type IntentComposerCapabilityContext =
  | { kind: 'create' }
  | {
      kind: 'modify'
      resourceType: IntentArtifactHint
      resourceId: string
      clientMutationId: string
    }

interface IntentComposerCapabilitiesDtoV3 {
  schemaVersion: 3
  hostPlatform: 'linux' | 'darwin'
  resources: {
    agent: { composerCreate: true }
    skill: { composerCreate: true }
    mcp: { composerCreate: true }
    plugin: {
      composerCreate: boolean
      npm: { create: boolean; update: boolean }
      git: { create: boolean; update: boolean }
      file: {
        requiresConcreteSource: true
        composerCanSelectSource: false
        preSessionGrant?: IntentPreSessionSourceGrantDto
      }
      reasonCode?: 'intent-artifact-containment-unavailable'
    }
    workflow: { composerCreate: true }
    workgroup: { composerCreate: true }
  }
}

interface IntentArtifactCapabilitiesDtoV3 {
  schemaVersion: 3
  hostPlatform: 'linux' | 'darwin'
  resources: {
    agent: { create: true }
    skill: { create: true }
    mcp: { create: true }
    plugin: {
      npm: { create: boolean; update: false }
      git: { create: boolean; update: false }
      file: {
        requiresConcreteSource: true
        concreteSources: IntentConcreteFileSourceDto[]
      }
      reasonCode?: 'intent-artifact-containment-unavailable'
    }
    workflow: { create: true }
    workgroup: { create: true }
  }
}
```

Composer只从 side-effect-free
`POST /api/intent-sessions/capabilities/resolve`取得第一个 DTO；route必须注册在 `/:id`之前，
body从 `unknown` strict parse为 `IntentComposerCapabilityContext`。`kind:'create'`不读取私有
resource，Darwin Plugin保持 disabled。`kind:'modify'`先按 exact resource type/id做 actor-visible
projection；只有 Plugin source kind为 `file`且 current config/spec fence可签时，才返回
`preSessionGrant`并只为该 source-bound copy上下文启用 Plugin。missing/invisible都同形
`intent-resource-not-found`，响应不含 resource id、path、spec、owner-private field或 raw fence。

`IntentPreSessionSourceGrantV1`是短寿命 authenticated envelope，canonical payload固定绑定
`{version,actorUserId,resourceType:'plugin',resourceId,clientMutationId,sourceKind:'file',
operationConfigHash,specHmac,issuerBootId,keyRevision,expiresAt}`；wire只投影 opaque token、
actor-safe displayName与 expiry。issuer用 host `secret.key`经独立 HKDF domain
`intent-pre-session-source-grant:v1`派生 AEAD key，以随机 nonce封装 canonical payload；不复用
mutation fingerprint子 key，token外部不可读、不可改且从不含 raw spec/path。Composer在调用
resolve前生成并冻结 create
`clientMutationId`，提交时把同一 token作为 `preSessionSourceGrant`放入 frozen body。它不是
filesystem capability，不可供模型、resolver或 broker消费。新 create在同一 transaction验证
token/authentication/expiry，并要求 body中恰有一个与 grant逐字节匹配的 Plugin initial mount且
hint omitted；随后重读 current actor/resource/ACL/source kind/config/spec fence，
随后才分配 session-scoped handle并保存 server-only manifest detail。任一失败在 ledger/session/
turn之前 typed fail closed。create exact replay顺序仍是 owner scope → strict parse/normalize/
HMAC → ledger lookup；existing exact直接沿 session anchor返回，不重新验证 grant expiry或
current source。不同 token/body复用同一 id仍是 fingerprint conflict。

第二个 DTO只在 session建立后由 dispatcher/detail构造；其 `concreteSources`全部来自 session
manifest handles。pre-session grant不进入 `INTENT.md`，也不能直接变成 model handle；只有 create
transaction产出的 session handle可进入 model contract和 final apply fence。

`auto`仅是 frontend form值，wire中仍为 omitted。create transaction把 parsed hint同时写入 initial
turn content和 immutable `intent_sessions.artifact_hint`；旧 session/null、modify mount入口与
后续 message都不能改它。dispatcher每轮构造：

```ts
interface IntentDocInput {
  // existing fields...
  requestedArtifactHint: IntentArtifactHint | null
  artifactCapabilities: IntentArtifactCapabilitiesDtoV3
}
```

`buildIntentDoc`在所有 fenced user/resource文本之前写一个受信
`## Requested artifact and host capabilities` section：

- hint是弱偏好；用户自然语言明确要求另一类时，以明确目标为准；
- capability是执行限制而非建议；unsupported operation必须提问/解释，不能输出一个注定无法
  apply的 op；
- 两平台 npm/git in-place update都固定 false，符合 RFC-234当前 copy-only合同；Linux只有 fresh
  exact qualification成功时 npm/git create=true，Darwin create=false。详情/Review preflight会
  再检查 drift，但不是第一次告知用户；
- `file:`只有 `concreteSources`中已有、actor-safe且 session-scoped的 mounted handle可用。
  `bindingDigest`绑定 server-only `{session,handle,pluginId,sourceKind,operationConfigHash,specHmac}`，
  不把 path/spec投影给模型；Intent Composer没有路径选择器，模型也不能发明或修改本机路径；
- Linux只有 fresh exact qualification成功时 npm/git create=true；Darwin只有 create transaction
  已把 exact pre-session grant换成 session concrete handle时，model capability才开放该
  mounted-file copy；generic Darwin model capability仍不开放 npm/git。

`packages/shared/src/intentModelContract.ts`导出 prompt renderer所消费的 exact field table与六个
changeset examples；每个 example都先过 `IntentChangesetSchema`，再过
`resolveIntentBundle`及对应 canonical validator。Plugin package create合同固定为
`{name,source:{kind:'package',spec},description,optionsJson?,enabled?}`；`spec`只允许 npm/git
shape。mounted file copy固定为
`{name,source:{kind:'mounted-file',handle},description,optionsJson?,enabled?}`，`handle`必须来自
`concreteSources`且 payload中 `spec/path`均为 unknown field。不接受 prompt旧字段 `options`，
`description`必需。Workflow output node固定包含
`ports:[{name,bind:{nodeId,portName}}]`，并用 matching edge的 target port连接，例如：

```json
{
  "id": "result",
  "kind": "output",
  "ports": [{ "name": "report", "bind": { "nodeId": "worker", "portName": "report" } }]
}
```

```json
{
  "id": "edge-result",
  "source": { "nodeId": "worker", "portName": "report" },
  "target": { "nodeId": "result", "portName": "report" }
}
```

golden/source guard禁止 prompt重新出现 `description?`、`options?`、raw file path或无 `ports`的
output example。mounted file Plugin的 dump只显示 actor-safe name/handle/说明，不输出 raw
`spec/cachedPath`。E2E stub必须读取真实 `INTENT.md`的 contract version、hint与capability后分支，
不能固定返回 Agent。

### 0.3 Generation reservation 与 durable launch failure

新增统一 service `reserveIntentGeneration`，create/message/answers/retry 都通过它，禁止 route
先写 user turn、再等待后台 mint agent turn：

1. route 先完成 authentication/coarse `intent:write` 与 wire-only strict parse。wire parse只验证
   public shape/limits，不读取 session、turn、draft或其它私有 source。
2. message/answers/retry 随后调用 `authorizeIntentMutationScopeV1`，查询条件固定为
   `session.id=routeSessionId AND session.ownerUserId=actor.user.id`。missing、foreign、manager与
   system-admin auditor均返回同一 `intent-session-not-found`；该 gate不检查
   status/turnSeq/inFlight，因此 session推进/归档后的 owner exact replay仍可继续。
3. answers 只有拿到 branded scope后才能查询
   `turn.id=sourceTurnId AND turn.sessionId=scope.sessionId` 并 safeParse source；source
   missing/corrupt分别 typed fail closed且不回退跨 session turn。随后 create/message/answers/retry
   各自调用唯一 normalizer/HMAC，raw wire/source对象不再交给 executor。
4. transaction 再按 `(scope.ownerUserId,clientMutationId)` 查统一 ledger。已存在时比较
   endpoint/session scope/fingerprint：完全相同才沿 `anchorKind/anchorId` 返回原 typed receipt，
   不受后续 turnSeq/status 变化影响；不同 fail closed，anchor 缺失/类型错返回
   `intent-mutation-receipt-corrupt`。这一 owner-authorization → normalization →
   ledger-before-freshness 顺序同时保住私有 source隔离与幂等。
5. 仅对**新 id**验证 `active`、无 unsettled apply、无 inFlight；对
   message/answers/retry 验证 `expectedTurnSeq===session.turnSeq`。answers 另验证
   `sourceTurnId` 仍是当前 unresolved questions turn。只允许其后的 source-bound
   mount-approval receipt，不允许任何后续 message/answers/agent turn。
6. 新动作在同一 transaction 插 ledger、user request turn（retry 无 user turn）和 agent
   `kind='running'` turn；同 transaction fresh 读取 user，断言 actor active、有
   `intent:write` 且 `actor.user.id===session.ownerUserId`，并把
   `runAsUserId=session.ownerUserId`、
   `runAsPolicy='current-session-owner-v1'` 写入 running row。row 初始
   `runnerClaimId=null`，request anchor 回填 `generationTurnId`，session 原子设置
   `inFlightTurnId/turnSeq`。不得持久化 session token、PAT id/secret/scopes或权限快照；旧
   nullable row只允许 boot/maintenance terminal，不能 resume。
7. route 不直接调用 runner，也不在 ownership 前广播 started。daemon startup 创建单一
   `IntentGenerationDispatcher`；reservation commit 后只调用不可抛到 route 的 `wake()`，即使
   wake/callback 故障，周期 poll 仍会发现 queued running row。
8. dispatcher claim 使用一个 short transaction 同时读取 exact running turn、session 与
   current user，要求
   `runAsPolicy==='current-session-owner-v1'`、
   `runAsUserId===session.ownerUserId`、user存在且 `status==='active'`、当前 role具有
   `intent:write`。不满足时不 claim，而是在同一 transaction 把 exact row原位 settle为
   `{code:'intent-runner-principal-unavailable'}`、清 matching `inFlightTurnId`；ledger receipt
   保留，commit 后发送 finished invalidation。任何普通 owner都不得回退
   `__system__`。
9. principal 合法时，同一 claim transaction 对 exact
   `session.inFlightTurnId/turn.kind/runnerClaimId` 做 CAS并生成 claim token。返回的 current
   user snapshot经专用 `hydrateIntentRunActor` 构造：普通 user显式调用
   `buildActor({user,source:'session'})`，即无 credential replay、从 current role计算
   permission的非-system actor；只有
   `runAsUserId===session.ownerUserId===SYSTEM_USER_ID` 的既有 system-owned session可调用
   `buildActor({user,source:'daemon'})`，这不是 fallback。PAT/session credential在 reservation
   accepted 后撤销不取消 durable action；user disable、role升降及 ACL/grant变化按执行时当前
   状态生效。
10. claim 后注册 `liveIntentRunOwners[turnId]={claimId,controller}`，才 best-effort 广播
    `intent.turn.started` 并从统一 `try/catch/finally` 调
    `runReservedIntentTurn({turnId,claimId,actor,...})`。broadcast/listener 异常不得阻止 run。
11. daemon-alive reconciler 使用 fake-clock 可测的短周期：

- 无 claim 且超过 handoff grace 的 running row重新交给 dispatcher；
- 已 claim 但连续 grace scans 都不在当前 daemon live-owner registry 的 exact row，原位
  settle `intent-runner-owner-lost` 并清 exact inFlight；
- registry 中的 live owner 绝不因墙钟/长模型调用被回收；合法长任务仍由 runtime timeout 或
  exact cancel 收口；
- settle/claim/update 都校验 claim/turn CAS，旧 owner 不能覆盖后来 turn。

12. runner 先 `loadConfig/resolveIntentTurnConfig`，再用一个短 `dbTxSync` 复验 exact
    `inFlightTurnId/contextRevision` 并按已解析的 `maxGenerateRounds` 检查 budget。budget
    exhausted把 reserved running原位 settle为 allowlisted
    `{code:'intent-budget-exhausted'}`；不能为了在首个 transaction检查 budget而把可能失败的
    config load放回 reservation之前。
13. config/budget 后调用 `prepareIntentDisclosureSnapshotInTx`。第一个短 `dbTxSync` 用 exact
    turn/claim同时重读 current user/session/mounts、六类完整 resource rows与 actor grants，
    构造一个 frozen `IntentDisclosureSnapshotV1`；不能再调用六条异步
    `list*().then(filterVisibleRows)`。snapshot header绑定 user id/role、session/context、
    turn/claim，按 `(resourceType,id)` canonical排序的每个 visible row token为
    `{resourceType,id,ownerUserId,visibility,aclRevision,builtin,contentFence}`。`contentFence`
    复用/补齐各类型完整内容围栏：agent `{updatedAt}`、skill immutable
    `{contentVersion,metaRevision}`、MCP/Plugin full operation hash、Workflow/Workgroup
    `{version}`；ACL字段独立存在，不能假设 content version随 owner transfer递增。token set覆盖
    全部会影响 inventory排序/计数、mounted root、closure/hidden判断与 seed bytes的 row。
14. transaction 外的 `buildIntentDumpFromSnapshot` 只能消费 frozen catalog；Skill 文件只从
    snapshot绑定的 immutable version目录读取。所有 seed先留在内存，不写入 model scratch/store。
    任一 mounted root不在 frozen visible set即 fail closed；不可见 dependency沿既有
    hidden-count/omit合同，不记录 identity。
15. 紧邻 `runSystemAgent`/store seed 的最后一步调用
    `admitIntentDisclosureInTx`：第二个短 `dbTxSync` 再次重读 exact
    turn/claim/session/current user，重算 current visible-set/token canonical digest并要求与 frozen
    snapshot完全相同。成功时以 claim CAS在 running turn写非敏感
    `dumpAdmissionDigest='sha256:intent-disclosure-v1:…'` 与 `dumpAdmittedAt`；digest输入可含
    ids/ACL/content fences但不含 name/body/secret，HTTP/WS不投影。只有该 CAS成功后才把 held seed
    交给模型。final admission commit前完成的 user/role/ACL/grant/content变化必须使 seed作废；
    commit后的变化不追溯取消已经 admission 的 live run。普通 admin仍只按其 final current role
    的既有 resource-admin policy取 visible set，普通 owner永不 fallback system。
16. snapshot/read/final admission 任一 principal、visible-set、token、root或 claim失配，都先
    丢弃 held seed，再由 `settleReservedIntentTurnFailure` 原位 settle allowlisted
    `intent-context-resource-unavailable`、清 exact inFlight、注销 matching live owner并发
    finished，绝不调用模型。config parse/runtime unsupported、budget、handoff 与 spawn前其它
    失败也走同一 exact settlement；不再有 log-only catch。
17. daemon 在 reserve/claim/admission 后崩溃仍由 boot recovery 在 HTTP listener 启动前把旧
    running row settle 为 `intent-run-daemon-restart`。因此每个 accepted generation action 都有
    daemon-alive 与 daemon-restart 两条 durable terminal path；boot绝不尝试以 system actor恢复
    普通 owner 的旧 run。

新增 shared request/response：

```ts
interface IntentMutationEnvelope {
  clientMutationId: string
  expectedTurnSeq: number
}

type PostIntentMessageV2 = IntentMutationEnvelope & { message: string }
type PostIntentAnswersV2 = IntentMutationEnvelope & {
  sourceTurnId: string
  answers: IntentAnswer[]
}
type RetryIntentTurnV2 = IntentMutationEnvelope & { sourceTurnId: string }

interface IntentGenerationReceipt {
  clientMutationId: string
  requestTurnId: string | null
  generationTurnId: string
  state: 'running' | 'error' | 'settled'
}
```

create 增 `clientMutationId`；server 预生成 session/turn ids，再以统一 ledger 的
`(ownerUserId,clientMutationId)` 原子 get-or-create session，并在同一 transaction 完成 initial
mount in-tx ACL、首个 user turn与 queued agent turn。旧的无 id body 不再由新 UI 发出；
same-release embedded frontend/backend 必须协调上线。

### 0.4 Source-bound answers 与原子 mount approvals

`PostIntentMountApprovalsSchema` 改为：

```ts
interface PostIntentMountApprovalsV2 extends IntentMutationEnvelope {
  sourceTurnId: string
  decisions: Array<
    | { resourceType: AclResourceType; name: string; decision: 'approve'; resourceId: string }
    | { resourceType: AclResourceType; name: string; decision: 'reject' }
  >
}
```

HTTP response 与 `kind='mount-approval'` detail turn content共用以下 **strict** shared schema；
不得返回当前 `{mounted}` 的弱 shape，也不得由 frontend自行拼出 receipt：

```ts
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Expect<Value extends true> = Value

const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const IntentMountApprovalResultSchema = z.discriminatedUnion('decision', [
  z
    .object({
      resourceType: AclResourceTypeSchema,
      name: z.string(),
      decision: z.literal('approve'),
      resourceId: z.string(),
      outcome: z.enum(['mounted', 'already-mounted']),
      handle: z.string(),
    })
    .strict(),
  z
    .object({
      resourceType: AclResourceTypeSchema,
      name: z.string(),
      decision: z.literal('reject'),
      outcome: z.literal('rejected'),
    })
    .strict(),
])

interface IntentMountApprovalReceipt {
  clientMutationId: string
  sourceTurnId: string
  expectedTurnSeq: number
  approvalTurnId: string
  resultingTurnSeq: number
  resultingContextRevision: number
  results: Array<z.output<typeof IntentMountApprovalResultSchema>>
}

export const IntentMountApprovalReceiptSchema = z
  .object({
    clientMutationId: z.string(),
    sourceTurnId: z.string(),
    expectedTurnSeq: NonNegativeSafeIntegerSchema,
    approvalTurnId: z.string(),
    resultingTurnSeq: NonNegativeSafeIntegerSchema,
    resultingContextRevision: NonNegativeSafeIntegerSchema,
    results: z.array(IntentMountApprovalResultSchema),
  })
  .strict()

type _IntentMountApprovalReceiptOutputIsReceipt = Expect<
  Equal<z.output<typeof IntentMountApprovalReceiptSchema>, IntentMountApprovalReceipt>
>
type _IntentMountApprovalReceiptInputIsReceipt = Expect<
  Equal<z.input<typeof IntentMountApprovalReceiptSchema>, IntentMountApprovalReceipt>
>
```

`results` 必须与 normalized source request逐项、同序且等长；reject项不允许
`resourceId/handle`，approve项必须回显 request所选 exact `resourceId`与服务端分配/复用的
`handle`。transaction在写前预生成 `approvalTurnId`，因此 HTTP、ledger anchor与 turn content
可逐字段相同；detail mapper还要求外层 `turn.id===approvalTurnId`、
`turn.seq===resultingTurnSeq`。unknown/missing/extra field、顺序漂移或 top-level/content不一致都
是 contract error，不降级为历史文本。

route wire-only strict parse 后先调用 `authorizeIntentMutationScopeV1`；只有 exact owner scope
才能查询被 `scope.sessionId` 约束的 source turn。source missing/corrupt时 owner得到 typed
`intent-source-unavailable`/`intent-source-corrupt`；foreign/manager/admin auditor无论 decisions
是否碰巧匹配都在 source read前得到同形 404，且零 ledger/turn。随后
`normalizeIntentMutationV1` 按 source turn 中 safe-parsed `mountRequests` 的
`(resourceType,name)` 首次出现顺序去重，并把 decisions 投影为同一 source 顺序。一次请求必须对
全部 unresolved request 各给一个决定，不能 duplicate，也不能带额外 name/type。transaction
只消费该 normalized object：

- owner授权 + source normalization 后按统一 ledger 的 owner/id 查既有 mutation；
  same endpoint/session/fingerprint 沿
  approval-turn anchor 返回，不重新验证已经被该 receipt 推进的 source。不同 endpoint/body
  fail closed；仅新 id 继续 freshness gate；
- fresh session 必须匹配 `expectedTurnSeq`，source 必须仍是当前 unresolved agent turn；
- 每个 approve 重新读取具体资源的 `id/name/owner/visibility/aclRevision`，用
  `canViewResourceInTx` 做最终授权，并要求 type/name 与 source request 精确相等；
- 同一 resource 已是 root 时记录 `already-mounted`，否则一次更新 manifest；批次不论批准
  多少项只把 `contextRevision` 增 1，reject-only/already-mounted-only 不增；
- 插入一个 `kind='mount-approval'` user turn，top-level columns 持久化
  `clientMutationId/sourceTurnId/expectedTurnSeq`，content 保存完整
  `IntentMountApprovalReceipt`；`resultingTurnSeq`是本 transaction推进后的 exact session
  `turnSeq`，`resultingContextRevision`是同 transaction最终值；
- ledger row、approval turn、manifest/session update 同 transaction 生死与共。任一
  验证/授权/写入失败回滚整批；exact replay 返回同一 receipt，不同 id 的迟到决定返回
  `intent-source-superseded`。

answers transaction 用同一 source fence；若 preceding mount approval receipt 与该 source
绑定则允许继续，否则任何后续 turn 都使答案 superseded。这样前端不再从“source 之后同名
rejection”猜当前 batch，也不存在逐项 mount 后 audit turn 丢失。

### 0.5 Apply attempt、WS 与 status fence

commit strict parse 后只调用 `normalizeIntentMutationV1`；它拒绝 duplicate，再按
`opId/slotId` 排序但逐字保留 secret/human/waiver value。HMAC 与
`resolveIntentBundle`/journal writer 都消费这一个 normalized object。normalization/HMAC后先做
owner-scoped ledger lookup：existing exact立即沿 typed anchor返回，不读取 current capability；
mismatch/corrupt/legacy fail closed。只有 absent的新 id才做 static matrix validation与 dynamic
zero-write exact probe，得到短寿命、daemon-local、不可序列化的
`ArtifactAdmissionLeaseV1 {bootId,providerRevision,opKinds,expiresAt}`。随后 claim transaction
**再次**先做统一 ledger replay/mismatch check：并发者已插 exact row则直接 replay；仍 absent才
验证 lease未过期、boot/provider revision与 normalized op kinds仍相同，再执行 fresh
draft/epoch/active/inFlight/unsettled gates，把 `session.applyAttemptSeq + 1` 写回 session，并在
同一 transaction 插 ledger anchor 与 journal `attemptSeq`，同时 fresh读取 current user并要求
`actor.user.id===session.ownerUserId`、active且当前 role有 `intent:write`，再写
`runAsUserId=session.ownerUserId`、`runAsPolicy='current-session-owner-v1'`。不保存
token/PAT scopes或 lease。exact replay 不分配新 attemptSeq；
unique decisions/slots 的纯换序会得到同一 normalized bytes和同一执行语义，changed
draft/applyMode/slot/human/waiver/secret 在任何 freshness gate 前返回
`intent-mutation-id-reused`。detail query 必须显式 `.orderBy(asc(attemptSeq))`，DTO 为：

```ts
interface IntentCommitAttemptDto {
  journalId: string
  attemptSeq: number
  clientMutationId: string
  draftId: string
  draftHash: string
  state: 'prepared' | 'applying' | 'compensating' | 'repair-required' | 'committed' | 'failed'
  receipt: IntentApplyReceipt | null
  errorCode: string | null
  error: string | null // allowlisted/sanitized human detail only
  recoveryCode: string | null // allowlisted cleanup/repair status；绝不含 path
  preparedArtifactsVersion: 1 | 3 | 'unsupported'
  artifactCleanupVerifiedAt: number | null
  createdAt: number
  updatedAt: number
}
```

DB 中任何非 1/3 version在 migration/converger先进入 `repair-required`，DTO mapper只投影
`'unsupported'`，不得把未知 integer交给 artifact parser或前端猜 codec。不以 `createdAt`
排序，也不以它判断 journal 属于哪个 draft。`recordApplyFailure` 从 typed error单独写
`errorCode`并先转 compensating；只有 compensation coordinator可最终写 failed。前端不再从任意
error string解析 gate。

WS 新增 invalidation frame
`intent.apply.updated {sessionId,journalId,state,ownerUserId}`。claim durable 后发
`prepared`，任何对外可观察的 applying/compensating/repair-required transition及
`failed/committed` terminal settlement后再发；保留 committed 时六类资源 list
invalidation。连接丢失由 WS reopen 的
`['intent-sessions']` reconcile 补齐。detail 在任一 journal unsettled 或当前页面持有
outcome-unknown locator 时另以 1.5s poll；`repair-required` 改 30s低频 reconcile并明确提示需要
管理员修复，直到服务端证明收口。所有 session mutation、archive/reopen与新 apply都把
`prepared|applying|compensating|repair-required` 视为 unsettled。

`setIntentSessionStatus` 改为单一 `dbTxSync`：fresh owner/status 检查、
`inFlightTurnId===null`、`assertNoUnsettledApply` 和 status update 在同一 transaction。
apply final transaction 除 epoch/currentDraft/inFlight 外必须检查
`sessionNow.status==='active'`，并按 journal `runAsUserId/runAsPolicy` 在 transaction 内重读
current user。missing/disabled、owner/policy mismatch或当前 role无 `intent:write` 以 typed
`intent-apply-principal-unavailable` 失败；valid时调用纯
`buildActor({user:currentUser,source:'session'})`（exact system-owned session才是 daemon
source）。credential撤销不追溯取消已 claim action，但 user/role/ACL变化以该 final transaction
为准。prepared op中的 route actor/principal只是旧预检输入，不能授权：进入 kernel前必须用
final actor重绑；source guard禁止旧 actor引用到达任何 Intent commit wrapper。

每个 server-only manifest detail entry 增：

```ts
interface IntentAuthorizationFenceV1 {
  ownerUserId: string | null
  visibility: ResourceVisibility
  aclRevision: number
  builtin: boolean
}
```

final transaction 的 `authorizeIntentBundleInTx` 在任何资源写入前：

1. 按 exact type/id重读每个 update target，要求 authorization fence与 current row完全相同，
   existing content fence仍匹配；
2. 对每个用户确认的 `modify` 重新执行 Intent-specific copy-only分类：current
   `ownerUserId===finalActor.user.id` 且 `builtin===false`。resource-admin bypass不改变这个产品
   语义；失配返回 `intent-foreign-modify-forbidden`，不能静默改成 copy；
3. 用 final actor 对 bundle 中将持久化的全部 direct refs/dependency closure/human bindings做
   canonical in-tx existence/visibility/active检查。create/copy与完整文档 update都不使用
   preflight grant snapshot或 route actor grandfather；
4. 将 final actor覆盖到 Agent/Workflow/Workgroup prepared principal，并让 MCP等无 actor
   kernel先经过同一 branded `AuthorizedIntentPreparedBundleV1` wrapper；六类 kernel不得单独
   重建 authority。

target authorization、六类资源写入、provenance、journal `committed` 与最终含
active/currentDraft/context 的 session conditional CAS必须处于同一个 `dbTxSync`。任一错误回滚
全部 DB 写入；transaction 外只能按 §0.5.1 的 durable exact receipts逆序补偿。journal先保存
原 typed failure并 CAS为 `compensating`；全部 artifact被严格证明 absent 后才可 CAS
`failed`并广播。cleanup失败或 ownership丢失时继续 unsettled，exact replay只返回原
compensating/repair状态，不能重新 prestage。于是 archive、owner
transfer、builtin/role/user/引用 ACL变化都不能穿过 final authority，也不能以一个假
terminal掩盖外部 bytes残留。committed legacy row只做幂等 roll-forward，不重新执行资源
transaction。

#### 0.5.1 Durable exact artifact receipt 与 compensation state machine

`prepared_artifacts_json` 新写由 `prepared_artifacts_version=3` 解释；journal另增仅服务端使用的
`prepared_artifacts_revision`，每次 append或 writer phase变化都以
`journal id + state + attemptSeq + preparedArtifactsRevision` CAS整份 strict-parsed array并检查
`changes===1`。v3严格类型为：

```ts
interface LinuxProcessStartIdentityV1 {
  platform: 'linux'
  bootId: string
  startTicks: string
}

interface OwnedArtifactContainmentIdentityV3 {
  protocol: 'owned-artifact-containment-v3'
  executionNonce: string
  supervisorPid: number
  supervisorStartIdentity: LinuxProcessStartIdentityV1
  containment: {
    kind: 'linux-private-pidns-v1'
    pidNamespaceInode: string
  }
  proofSigner: {
    algorithm: 'Ed25519'
    publicKeyBase64: string
    keyId: string // sha256(canonical public key)
  }
  releaseRecordDigest: string
}

interface ArtifactContainmentEmptyProofV3 {
  protocol: 'artifact-containment-empty-v3'
  executionNonce: string
  releaseRecordDigest: string
  proofKeyId: string
  containmentKind: OwnedArtifactContainmentIdentityV3['containment']['kind']
  supervisorStartIdentity: LinuxProcessStartIdentityV1
  pidNamespaceInode: string
  directLeaderSettled: true
  trackedProcessCount: 0
  trackingErrorCount: 0
  emptyObservedAt: number
  recordDigest: string
  signatureBase64: string
}

type OwnedPluginWriterV3 =
  | { phase: 'reserved' }
  | { phase: 'released'; identity: OwnedArtifactContainmentIdentityV3 }
  | {
      phase: 'quiesced'
      identity: OwnedArtifactContainmentIdentityV3
      emptyProof: ArtifactContainmentEmptyProofV3
      quiescedAt: number
    }

type IntentApplyArtifactV3 =
  | {
      kind: 'plugin-generation'
      pluginId: string
      generationId: string
      writer: OwnedPluginWriterV3
    }
  | {
      kind: 'skill-reserve'
      skillId: string
      operationId: string
    }

interface ArtifactWriterObligationV3 {
  obligationId: string
  journalId: string
  attemptSeq: number
  artifactRevision: number
  pluginId: string
  generationId: string
  release: OwnedArtifactContainmentIdentityV3
  phase: 'released' | 'quiesced' | 'cleanup-verified' | 'retired'
  emptyProof?: ArtifactContainmentEmptyProofV3
}
```

只持久化 canonical identity component；禁止保存或消费 absolute path。所有 id先经既有
ULID/path-segment validator，再从 `Paths.pluginsDir` 或 app-home Skill root推导目标。
containment/process-start identity只用于 writer lifecycle，不能当 path selector，也不投影到
HTTP/WS/log；public key/key id/record digest不含 secret。private signing key从不进入 durable
codec或 daemon。
当前 released binary只可能产生 legacy v1；v2是未实施的 v6 draft codec，migration不合成 v2。
若发现手工/部分构建留下的 v2或任何 unknown codec，一律 `repair-required`，不得按 v3解释。

`ArtifactWriterObligationLedgerV3`由 verified broker在 app-home control root下独占，使用 strict
codec、append/checkpoint fsync与单调 revision保存上述 obligation。它不是第二份业务 journal：
只携收口 writer所需的 canonical id/public verifier/phase，不含 path、secret或用户 payload；
不进入 backup archive，也不随 DB/config/Skill generation restore。DB receipt与 obligation
ledger互相保存对方的 id/revision digest。任何单边持久化都保守可恢复：obligation-only且从未 GO
可取得 zero-child EMPTY后 retire；DB released但 obligation缺失进入 repair-required且禁止 GO；
两者都 durable且逐字段匹配才允许 GO。

##### 0.5.1.1 Descriptor-rooted filesystem capability

record-before-act与“每次 syscall 前再 `lstat`”都不能消除 check-then-use；具名 temp若先被
hardlink，之后经已打开 fd写入也会把 bytes写到受控根外。Plugin generation与 managed Skill的
host writer因此只接收不可序列化的 branded `ArtifactFsCapabilityV3`。V3必须能**产出**后续
rename/remove所需的 authority，不能只声明一个无法取得的 `ArtifactEntryCapability`：

```ts
interface ValidatedPathSegment {
  readonly __brand: 'ValidatedPathSegment'
  readonly value: string
}

interface ArtifactEntryIdentityV3 {
  dev: bigint
  ino: bigint
  mode: number
  nlink: number
  fsid: readonly [number, number]
}

interface ArtifactEntryIdentityV3Wire {
  dev: string
  ino: string
  mode: number
  nlink: number
  fsid: [number, number]
}

const UINT64_MAX = 18_446_744_073_709_551_615n
const CANONICAL_UINT64_PATTERN = /^(0|[1-9][0-9]*)$/
const CanonicalUnsignedDecimalSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(CANONICAL_UINT64_PATTERN)
  .superRefine((wire, context) => {
    if (wire.length > 20 || !CANONICAL_UINT64_PATTERN.test(wire)) return
    if (BigInt(wire) > UINT64_MAX) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'uint64-overflow' })
    }
  })

const SignedSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)

const ArtifactEntryIdentityV3WireSchema = z
  .object({
    dev: CanonicalUnsignedDecimalSchema,
    ino: CanonicalUnsignedDecimalSchema,
    mode: NonNegativeSafeIntegerSchema,
    nlink: NonNegativeSafeIntegerSchema,
    fsid: z.tuple([SignedSafeIntegerSchema, SignedSafeIntegerSchema]),
  })
  .strict()

const ArtifactEntryIdentityV3Schema = ArtifactEntryIdentityV3WireSchema.transform(
  (wire): ArtifactEntryIdentityV3 => ({
    dev: BigInt(wire.dev),
    ino: BigInt(wire.ino),
    mode: wire.mode,
    nlink: wire.nlink,
    fsid: [wire.fsid[0], wire.fsid[1]],
  }),
)

type _ArtifactEntryIdentityWireInput = Expect<
  Equal<z.input<typeof ArtifactEntryIdentityV3Schema>, ArtifactEntryIdentityV3Wire>
>
type _ArtifactEntryIdentityDecodedOutput = Expect<
  Equal<z.output<typeof ArtifactEntryIdentityV3Schema>, ArtifactEntryIdentityV3>
>

function encodeArtifactEntryIdentityV3(
  decoded: ArtifactEntryIdentityV3,
): ArtifactEntryIdentityV3Wire {
  return ArtifactEntryIdentityV3WireSchema.parse({
    dev: decoded.dev.toString(10),
    ino: decoded.ino.toString(10),
    mode: decoded.mode,
    nlink: decoded.nlink,
    fsid: [decoded.fsid[0], decoded.fsid[1]],
  })
}

// Durable wire只使用上述 canonical uint64 decimal；+1、01、-1、overflow及 unsafe number均拒绝。
// decode后只由下列函数比较，encode也只能调用 encodeArtifactEntryIdentityV3()。
// 任何 consumer不得 JSON.stringify、BigInt(raw)或自行选择字段。full snapshot用于不可变
// checkpoint；same-object允许 directory内容变化导致的 nlink/mode permission bits变化，但文件
// 类型不能变。
function artifactEntrySnapshotEqual(
  left: ArtifactEntryIdentityV3,
  right: ArtifactEntryIdentityV3,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.fsid[0] === right.fsid[0] &&
    left.fsid[1] === right.fsid[1]
  )
}

function artifactEntrySameObject(
  left: ArtifactEntryIdentityV3,
  right: ArtifactEntryIdentityV3,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    (left.mode & S_IFMT) === (right.mode & S_IFMT) &&
    left.fsid[0] === right.fsid[0] &&
    left.fsid[1] === right.fsid[1]
  )
}
```

##### 0.5.1.1a Durable root 双向 codec boundary

```ts
/**
 * R17-P1-01: the leaf codec is not itself a durable-record codec. Every
 * append/checkpoint root below has a build-bound, root-specific bidirectional
 * codec. The storage layer never receives a decoded object.
 */
type DurableArtifactRootKindV3 =
  | 'artifact-writer-obligation'
  | 'artifact-publication'
  | 'restore-generation-marker'
  | 'restore-sqlite-publication'
  | 'pending-restore-control-envelope'
  | 'pending-restore-in-flight'
  | 'legacy-pending-adoption'
  | 'legacy-pending-move-publication'
  | 'legacy-pending-operator-control'
  | 'legacy-backup-adoption'
  | 'worktree-directory-publication'
  | 'git-registration-preparation'
  | 'git-stale-cleanup-intent'
  | 'worktree-before-git-no-effect'
  | 'worktree-compensation-effect'
  | 'worktree-reconstruction'

const DurableArtifactRootKindV3Schema = z.enum([
  'artifact-writer-obligation',
  'artifact-publication',
  'restore-generation-marker',
  'restore-sqlite-publication',
  'pending-restore-control-envelope',
  'pending-restore-in-flight',
  'legacy-pending-adoption',
  'legacy-pending-move-publication',
  'legacy-pending-operator-control',
  'legacy-backup-adoption',
  'worktree-directory-publication',
  'git-registration-preparation',
  'git-stale-cleanup-intent',
  'worktree-before-git-no-effect',
  'worktree-compensation-effect',
  'worktree-reconstruction',
])

type _DurableRootKindSchemaIsClosed = Expect<
  Equal<z.output<typeof DurableArtifactRootKindV3Schema>, DurableArtifactRootKindV3>
>

interface DurableRootStorageFrameV3 {
  readonly schemaVersion: 3
  readonly rootKind: DurableArtifactRootKindV3
  readonly digestAlgorithm: 'sha256'
  readonly digest: string
  readonly canonicalJson: string
}

const DurableRootStorageFrameV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    rootKind: DurableArtifactRootKindV3Schema,
    digestAlgorithm: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    canonicalJson: z.string().min(2).max(MAX_DURABLE_ROOT_JSON_BYTES_V3),
  })
  .strict()

declare const CanonicalDurableRootBytesV3Brand: unique symbol
interface CanonicalDurableRootBytesV3<Kind extends DurableArtifactRootKindV3> {
  readonly [CanonicalDurableRootBytesV3Brand]: Kind
  readonly rootKind: Kind
  readonly canonicalJson: string
  readonly digest: string
  // Immutable UTF-8 source; only the storage module may encode it to bytes.
  readonly canonicalFrameText: string
}

interface DurableRootCodecV3<Kind extends DurableArtifactRootKindV3, Wire, Decoded> {
  readonly rootKind: Kind
  // Wire schema has no transform; input and output are the same JSON-safe type.
  readonly wireSchema: z.ZodType<Wire, z.ZodTypeDef, Wire>
  // Decoded schema consumes exactly Wire and produces bigint-bearing Decoded.
  readonly decodedSchema: z.ZodType<Decoded, z.ZodTypeDef, Wire>
  // This is an explicit root mapper, never a JSON replacer or structural cast.
  readonly encode: (decoded: Decoded) => Wire
}

function assertNeverDurableBranch(value: never): never {
  throw new Error(`unhandled durable codec branch: ${String(value)}`)
}

function encodeCanonicalDurableRootV3<Kind extends DurableArtifactRootKindV3, Wire, Decoded>(
  codec: DurableRootCodecV3<Kind, Wire, Decoded>,
  decoded: Decoded,
): CanonicalDurableRootBytesV3<Kind> {
  const candidate = codec.encode(decoded)
  const wire = codec.wireSchema.parse(candidate)
  assertJsonTreeContainsNoBigIntV3(wire)
  return constructCanonicalDurableRootV3(codec.rootKind, canonicalJsonV3(wire))
}

function decodeCanonicalDurableRootV3<Kind extends DurableArtifactRootKindV3, Wire, Decoded>(
  codec: DurableRootCodecV3<Kind, Wire, Decoded>,
  bytes: CanonicalDurableRootBytesV3<Kind>,
): Decoded {
  if (!canonicalDurableRootInstancesV3.has(bytes) || bytes.rootKind !== codec.rootKind) {
    throw new Error('untrusted-or-foreign-durable-root')
  }
  return codec.decodedSchema.parse(JSON.parse(bytes.canonicalJson))
}

/**
 * R18-P1-02: disk/child-process bytes are never branded by assertion. This is
 * the storage module's only raw-frame trust boundary.
 */
function loadCanonicalDurableRootV3<Kind extends DurableArtifactRootKindV3, Wire, Decoded>(
  expectedCodec: DurableRootCodecV3<Kind, Wire, Decoded>,
  rawFrame: Uint8Array,
): CanonicalDurableRootBytesV3<Kind> {
  if (rawFrame.byteLength === 0 || rawFrame.byteLength > MAX_DURABLE_ROOT_FRAME_BYTES_V3) {
    throw new Error('durable-root-frame-size')
  }

  const frameText = new TextDecoder('utf-8', { fatal: true }).decode(rawFrame)
  const parsedFrame = DurableRootStorageFrameV3Schema.parse(JSON.parse(frameText))
  if (parsedFrame.rootKind !== expectedCodec.rootKind) {
    throw new Error('durable-root-kind-mismatch')
  }

  const expectedDigest = sha256HexV3(
    `agent-workflow-durable-root-v3\0${parsedFrame.rootKind}\0${parsedFrame.canonicalJson}`,
  )
  if (!constantTimeHexEqualV3(parsedFrame.digest, expectedDigest)) {
    throw new Error('durable-root-digest-mismatch')
  }

  const parsedWire = expectedCodec.wireSchema.parse(JSON.parse(parsedFrame.canonicalJson))
  assertJsonTreeContainsNoBigIntV3(parsedWire)
  if (canonicalJsonV3(parsedWire) !== parsedFrame.canonicalJson) {
    throw new Error('non-canonical-durable-root-payload')
  }
  // Run decoded cross-field refinements before any caller can receive a brand.
  expectedCodec.decodedSchema.parse(parsedWire)

  const canonical = constructCanonicalDurableRootV3(
    expectedCodec.rootKind,
    parsedFrame.canonicalJson,
  )
  if (!byteEqualV3(encodeStrictUtf8V3(canonical.canonicalFrameText), rawFrame)) {
    throw new Error('non-canonical-durable-root-frame')
  }
  return canonical
}

declare const DurableRootStorageKeyV3Brand: unique symbol

interface DurableRootStorageKeyV3<Kind extends DurableArtifactRootKindV3> {
  readonly [DurableRootStorageKeyV3Brand]: Kind
  readonly namespace: 'artifact-control-v3'
  readonly rootKind: Kind
  readonly segment: string
}

const durableRootStorageKeyInstancesV3 = new WeakSet<object>()

/**
 * Module-private. `segment` first passes the closed ULID/path-segment
 * validator; callers cannot supply namespace, root kind, slash, dot segment,
 * absolute path or storage path.
 */
function constructDurableRootStorageKeyV3<Kind extends DurableArtifactRootKindV3>(
  rootKind: Kind,
  segment: string,
): DurableRootStorageKeyV3<Kind> {
  const validated = validateDurableRootSegmentV3(segment)
  const key = Object.freeze({
    namespace: 'artifact-control-v3',
    rootKind,
    segment: validated.value,
  })
  durableRootStorageKeyInstancesV3.add(key)
  return key as DurableRootStorageKeyV3<Kind>
}

interface DurableRootStorageLocatorV3<Kind extends DurableArtifactRootKindV3, Wire, Decoded> {
  readonly key: DurableRootStorageKeyV3<Kind>
  readonly rootKind: Kind
  readonly codec: DurableRootCodecV3<Kind, Wire, Decoded>
}

interface DurableRootStorageV3 {
  checkpoint<Kind extends DurableArtifactRootKindV3, Wire, Decoded>(
    locator: DurableRootStorageLocatorV3<Kind, Wire, Decoded>,
    canonical: CanonicalDurableRootBytesV3<Kind>,
  ): Promise<void>
  lookup<Kind extends DurableArtifactRootKindV3, Wire, Decoded>(
    locator: DurableRootStorageLocatorV3<Kind, Wire, Decoded>,
  ): Promise<Decoded | null>
}

function artifactPublicationLocatorFromRefV3(
  ref: ArtifactPublicationReceiptRefV3,
): DurableRootStorageLocatorV3<
  'artifact-publication',
  ArtifactPublicationReceiptV3Wire,
  ArtifactPublicationReceiptV3
> {
  const parsed = ArtifactPublicationReceiptRefV3Schema.parse(ref)
  return {
    key: constructDurableRootStorageKeyV3('artifact-publication', parsed.receiptId),
    rootKind: 'artifact-publication',
    codec: ArtifactPublicationReceiptV3Codec,
  }
}

function restoreSqlitePublicationLocatorV3(
  restoreOperationId: string,
): DurableRootStorageLocatorV3<
  'restore-sqlite-publication',
  RestoreSqlitePublicationV3Wire,
  RestoreSqlitePublicationV3Decoded
> {
  const parsed = RestoreOperationIdV3Schema.parse(restoreOperationId)
  return {
    key: constructDurableRootStorageKeyV3('restore-sqlite-publication', parsed),
    rootKind: 'restore-sqlite-publication',
    codec: RestoreSqlitePublicationV3Codec,
  }
}
```

`assertJsonTreeContainsNoBigIntV3`只做递归 fail-closed 检查，不转换值；
`canonicalJsonV3`只在该检查与 root wire parse之后调用原生 `JSON.stringify`。
`constructCanonicalDurableRootV3`是 storage module私有 constructor：digest固定覆盖
domain separator + exact root kind + canonical payload，再逐字段构造
`DurableRootStorageFrameV3`并把**外层 frame本身** canonical JSON保存为 immutable
`canonicalFrameText`。
constructor创建的 frozen instance登记在 module-private `WeakSet`
`canonicalDurableRootInstancesV3`；encoder与 raw loader是仅有两条登记路径，decoder会同时检查
WeakSet membership与 runtime exact kind。因此 `as CanonicalDurableRootBytesV3<...>`、结构相同
对象或 foreign kind都不能成为可消费的 loaded root。通用
`(key,value) => typeof value === 'bigint' ? ...` replacer、对象
`toJSON()`、decoded root上的 object spread/cast及任意“遍历后遇 bigint就转字符串”都被 source
guard禁止。底层 append/checkpoint/fsync primitive的参数只能是
`CanonicalDurableRootBytesV3<exact-kind>`；各 ledger的 public service wrapper可接 decoded record，
但内部唯一实现必须是 `encodeCanonicalDurableRootV3(rootCodec, record)`后交 storage，不能暴露
第二条 writer。

`canonicalFrameText`是 immutable string而不是可变 `Uint8Array` view；只有 storage module会在
append syscall前把它 strict UTF-8编码为新 byte buffer，业务 caller无法在 record-before-act
窗口篡改将要 fsync的 backing buffer。

底层 storage locator本身带 exact `rootKind`；写路径只把 canonical instance的
`canonicalFrameText`重新编码后落盘，
读路径只取得 raw `Uint8Array`并在 storage module内调用
`loadCanonicalDurableRootV3(locator.codec, rawFrame)`，随后才
`decodeCanonicalDurableRootV3()`。业务 ledger没有 `readRaw()`、`rebrand()`或 generic
`lookup(key): unknown`；其 public lookup返回 root-specific decoded record。`checkpoint()`在
syscall前还要验证 canonical与storage-key两个 WeakSet membership、
`key.namespace==='artifact-control-v3'`、`key.rootKind===locator.rootKind`、
`canonical.rootKind === locator.rootKind`及 codec rootKind全部相等，不能只依赖 generic
inference。strict UTF-8、
outer frame strict schema、expected kind、domain-separated digest、inner wire parse、inner与
outer byte-for-byte recanonicalization及 decoded cross-field parse任一失败，都在
descriptor/filesystem/DB effect前返回 typed repair。BOM、trailing bytes、duplicate key、
key-order/whitespace变化、digest bit flip及结构合法的 foreign-root payload均不可被加载。
业务层只持 root-specific locator factory；wrong namespace、same-kind foreign receipt、wrong
receipt id/revision/role/operation或 segment collision在 descriptor/DB/FS effect前失败。

所有 durable root使用下列封闭 registry；“identity-free” obligation/control envelope也进入
registry，避免同一 ledger出现一半有 codec、一半直接 stringify。每一行都必须存在：

| root kind                        | strict wire / decoded schema pair                                                                         | 唯一顶层 encoder                                  | 必须穷举的 discriminant                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| artifact-writer-obligation       | `ArtifactWriterObligationV3WireSchema` / `ArtifactWriterObligationV3Schema`                               | `encodeArtifactWriterObligationV3`                | `phase`四态                                                         |
| artifact-publication             | `ArtifactPublicationReceiptV3WireSchema` / `ArtifactPublicationReceiptV3Schema`                           | `encodeArtifactPublicationReceiptV3`              | `phase`四态 + exchanged/cleanup的 `publicationMode`                 |
| restore-generation-marker        | `RestoreGenerationMarkerV3WireSchema` / `RestoreGenerationMarkerV3Schema`                                 | `encodeRestoreGenerationMarkerV3`                 | `phase`七态 + config `preserve`/`replace`                           |
| restore-sqlite-publication       | `RestoreSqlitePublicationV3WireSchema` / `RestoreSqlitePublicationV3Schema`                               | `RestoreSqlitePublicationV3Codec.encode`          | sidecar intent/removal + DB `no-replace\|replace`                   |
| pending-restore-control-envelope | `PendingRestoreControlEnvelopeV3WireSchema` / `PendingRestoreControlEnvelopeV3Schema`                     | `encodePendingRestoreControlEnvelopeV3`           | receipt `operation/state`闭集                                       |
| pending-restore-in-flight        | `PendingRestoreInFlightRecordV3WireSchema` / `PendingRestoreInFlightRecordV3Schema`                       | `encodePendingRestoreInFlightRecordV3`            | `phase=ingress\|staging\|canceling\|repair-required`                |
| legacy-pending-adoption          | `LegacyPendingRestoreAdoptionRecordV3WireSchema` / `LegacyPendingRestoreAdoptionRecordV3Schema`           | `encodeLegacyPendingRestoreAdoptionRecordV3`      | adoption `phase`全闭集 + evidence `kind`五态                        |
| legacy-pending-move-publication  | `LegacyPendingMovePublicationV3WireSchema` / `LegacyPendingMovePublicationV3Schema`                       | `encodeLegacyPendingMovePublicationV3`            | `phase=declared\|moving\|moved\|cleaning\|cleaned\|repair-required` |
| legacy-pending-operator-control  | `LegacyPendingOperatorControlV3WireSchema` / `LegacyPendingOperatorControlV3Schema`                       | `encodeLegacyPendingOperatorControlV3`            | operator `phase`八态 + settled `action`                             |
| legacy-backup-adoption           | `ArtifactLegacyArchiveAdoptionReceiptV3WireSchema` / `ArtifactLegacyArchiveAdoptionReceiptV3Schema`       | `encodeArtifactLegacyArchiveAdoptionReceiptV3`    | 单 branch但逐字段构造                                               |
| worktree-directory-publication   | `WorktreeDirectoryReservationPublicationV3WireSchema` / `WorktreeDirectoryReservationPublicationV3Schema` | `encodeWorktreeDirectoryReservationPublicationV3` | directory `phase`九态                                               |
| git-registration-preparation     | `GitWorktreeRegistrationPreparationV3WireSchema` / `GitWorktreeRegistrationPreparationV3Schema`           | `encodeGitWorktreeRegistrationPreparationV3`      | preparation `phase`五态                                             |
| git-stale-cleanup-intent         | `GitWorktreeStaleCleanupIntentV3WireSchema` / `GitWorktreeStaleCleanupIntentV3Schema`                     | `encodeGitWorktreeStaleCleanupIntentV3`           | 单 branch但逐字段构造                                               |
| worktree-before-git-no-effect    | `WorktreeRepoBeforeGitNoEffectV3WireSchema` / `WorktreeRepoBeforeGitNoEffectV3Schema`                     | `encodeWorktreeRepoBeforeGitNoEffectV3`           | `baseline=effective-absent\|stale-retained`                         |
| worktree-compensation-effect     | `WorktreeRepoCompensationEffectV3WireSchema` / `WorktreeRepoCompensationEffectV3Schema`                   | `encodeWorktreeRepoCompensationEffectV3`          | `kind=none\|partial\|registered`及 partial component `kind`         |
| worktree-reconstruction          | `WorktreeReconstructionReceiptV3WireSchema` / `WorktreeReconstructionReceiptV3Schema`                     | `encodeWorktreeReconstructionReceiptV3`           | receipt/task-container/repo/publication/preparation/effect全部分支  |

```ts
const DURABLE_ARTIFACT_ROOT_CODEC_REGISTRY_V3 = {
  'artifact-writer-obligation': ArtifactWriterObligationV3Codec,
  'artifact-publication': ArtifactPublicationReceiptV3Codec,
  'restore-generation-marker': RestoreGenerationMarkerV3Codec,
  'restore-sqlite-publication': RestoreSqlitePublicationV3Codec,
  'pending-restore-control-envelope': PendingRestoreControlEnvelopeV3Codec,
  'pending-restore-in-flight': PendingRestoreInFlightRecordV3Codec,
  'legacy-pending-adoption': LegacyPendingRestoreAdoptionRecordV3Codec,
  'legacy-pending-move-publication': LegacyPendingMovePublicationV3Codec,
  'legacy-pending-operator-control': LegacyPendingOperatorControlV3Codec,
  'legacy-backup-adoption': ArtifactLegacyArchiveAdoptionReceiptV3Codec,
  'worktree-directory-publication': WorktreeDirectoryReservationPublicationV3Codec,
  'git-registration-preparation': GitWorktreeRegistrationPreparationV3Codec,
  'git-stale-cleanup-intent': GitWorktreeStaleCleanupIntentV3Codec,
  'worktree-before-git-no-effect': WorktreeRepoBeforeGitNoEffectV3Codec,
  'worktree-compensation-effect': WorktreeRepoCompensationEffectV3Codec,
  'worktree-reconstruction': WorktreeReconstructionReceiptV3Codec,
} as const

type _DurableRootRegistryKeysAreClosed = Expect<
  Equal<keyof typeof DURABLE_ARTIFACT_ROOT_CODEC_REGISTRY_V3, DurableArtifactRootKindV3>
>
type _DurableRootRegistryKindsMatchKeys = Expect<
  Equal<
    {
      [Key in keyof typeof DURABLE_ARTIFACT_ROOT_CODEC_REGISTRY_V3]: (typeof DURABLE_ARTIFACT_ROOT_CODEC_REGISTRY_V3)[Key]['rootKind']
    },
    { readonly [Key in DurableArtifactRootKindV3]: Key }
  >
>
```

`*WireSchema`的 nested identity只能是 `ArtifactEntryIdentityV3WireSchema`；
对应 `*Schema`的相同位置只能是 `ArtifactEntryIdentityV3Schema`。每一行都有三条 compile-time
proof：wire schema input/output均等于命名 `*Wire` type、decoded schema input等于同一 `*Wire`
type、decoded schema output等于命名 decoded type。registry由 exact
`Record<DurableArtifactRootKindV3, ...>` source assertion锁闭集，少一行、多一行或名字漂移均
typecheck失败。

顶层 encoder与 nested encoder不得靠“覆盖已知 identity字段”的 spread实现，而是逐字段构造。
以下结构是实现合同；各 branch helper返回自己的 exact wire branch并在返回表达式使用
`satisfies`，同样不得 spread decoded record：

```ts
function encodeLegacyPendingMovePublicationV3(
  decoded: LegacyPendingMovePublicationV3,
): LegacyPendingMovePublicationV3Wire {
  const candidate: LegacyPendingMovePublicationV3Wire = (() => {
    switch (decoded.phase) {
      case 'declared':
        return encodeLegacyMoveDeclaredBranchV3(decoded)
      case 'moving':
        return encodeLegacyMoveMovingBranchV3(decoded)
      case 'moved':
        return encodeLegacyMoveMovedBranchV3(decoded)
      case 'cleaning':
        return encodeLegacyMoveCleaningBranchV3(decoded)
      case 'cleaned':
        return encodeLegacyMoveCleanedBranchV3(decoded)
      case 'repair-required':
        return encodeLegacyMoveRepairBranchV3(decoded)
      default:
        return assertNeverDurableBranch(decoded)
    }
  })()
  return LegacyPendingMovePublicationV3WireSchema.parse(candidate)
}

function encodeWorktreeReconstructionReceiptV3(
  decoded: WorktreeReconstructionReceiptV3,
): WorktreeReconstructionReceiptV3Wire {
  const candidate: WorktreeReconstructionReceiptV3Wire = (() => {
    switch (decoded.phase) {
      case 'reserving':
        return encodeWorktreeReservingRootV3(decoded)
      case 'prepared':
        return encodeWorktreePreparedRootV3(decoded)
      case 'registering':
        return encodeWorktreeRegisteringRootV3(decoded)
      case 'registered':
        return encodeWorktreeRegisteredRootV3(decoded)
      case 'overlaying':
        return encodeWorktreeOverlayingRootV3(decoded)
      case 'verified':
        return encodeWorktreeVerifiedRootV3(decoded)
      case 'compensating':
        return encodeWorktreeCompensatingRootV3(decoded)
      case 'complete':
        return encodeWorktreeCompleteRootV3(decoded)
      case 'compensated':
        return encodeWorktreeCompensatedRootV3(decoded)
      case 'repair-required':
        return encodeWorktreeRepairRootV3(decoded)
      default:
        return assertNeverDurableBranch(decoded)
    }
  })()
  return WorktreeReconstructionReceiptV3WireSchema.parse(candidate)
}
```

worktree root branch helper必须显式调用
`encodeWorktreeTaskContainerLedgerV3()`和逐项
`encodeWorktreeRepoReconstructionEntryV3()`；后两者继续分别穷举 task-container
`reserving|reserved|compensated|repair-required`与 repo
`reserving|reserved|preparing-registration|adding|registered|overlaying|overlayed|verifying|
verified|compensating|compensated|repair-required`。它们再调用 registry中的 directory、
registration、stale-cleanup、before-Git与effect encoder。任何 nested identity最终且只能到达
`encodeArtifactEntryIdentityV3()`，不能由 root mapper直接 `.toString()`。

```ts
interface ArtifactDirCapabilityV3 {
  readonly __brand: 'ArtifactDirCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
}

interface ArtifactWritableTempCapabilityV3 {
  readonly __brand: 'ArtifactWritableTempCapabilityV3'
  readonly platformKind: 'linux-anonymous' | 'darwin-private-named'
}

interface ArtifactSealedFileCapabilityV3 {
  readonly __brand: 'ArtifactSealedFileCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
  readonly fileDigest: string
}

interface ArtifactEntryCapabilityV3 {
  readonly __brand: 'ArtifactEntryCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
}

interface ArtifactTreeDirCapabilityV3 {
  readonly __brand: 'ArtifactTreeDirCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
}

interface ArtifactTreeWriterV3 {
  readonly __brand: 'ArtifactTreeWriterV3'
  readonly root: ArtifactTreeDirCapabilityV3
  mkdir(
    parent: ArtifactTreeDirCapabilityV3,
    name: ValidatedPathSegment,
  ): Promise<ArtifactTreeDirCapabilityV3>
  writeFile(
    parent: ArtifactTreeDirCapabilityV3,
    name: ValidatedPathSegment,
    bytes: Uint8Array,
  ): Promise<ArtifactEntryCapabilityV3>
  seal(expectedTreeDigest: string): Promise<ArtifactSealedTreeCapabilityV3>
}

interface ArtifactSealedTreeCapabilityV3 {
  readonly __brand: 'ArtifactSealedTreeCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
  readonly treeDigest: string
}

type ArtifactFsSlotRoleV3 =
  | 'plugin-manifest'
  | 'skill-live-files'
  | 'skill-version'
  | 'restore-database-file'
  | 'restore-live-database-wal-removal'
  | 'restore-live-database-shm-removal'
  | 'restore-safety-database-file'
  | 'restore-safety-database-wal'
  | 'restore-safety-database-shm'
  | 'restore-safety-config-file'
  | 'restore-safety-skills-root'
  | 'restore-config-file'
  | 'restore-skills-root'
  | 'pending-restore-upload-ingress'
  | 'pending-restore-archive'
  | 'pending-restore-legacy-archive'
  | 'pending-restore-legacy-hold'
  | 'pending-restore-legacy-quarantine'
  | 'backup-staging-tree'
  | 'backup-archive'
  | 'backup-archive-adoption'
  | 'worktree-reservation-private'
  | 'worktree-reconstruction-target'
  | 'worktree-repo-admin'

interface ArtifactPublicationReceiptRefV3 {
  readonly receiptId: string
  readonly revision: number
  readonly operationDigest: string
  readonly slotRole: ArtifactFsSlotRoleV3
}

interface ArtifactPublicationReceiptBaseV3 {
  readonly schemaVersion: 3
  readonly receiptId: string
  readonly operation: ArtifactFsOperationIdentityV3
  readonly operationDigest: string
  readonly slotRole: ArtifactFsSlotRoleV3
  readonly revision: number
  readonly stagedIdentity: ArtifactEntryIdentityV3
}

type ArtifactPublicationReceiptV3 =
  | (ArtifactPublicationReceiptBaseV3 & {
      readonly phase: 'prepared'
      readonly publicationMode: 'no-replace' | 'replace'
      readonly expectedIdentity: ArtifactEntryIdentityV3 | null
      readonly publishedIdentity: null
      readonly displacedIdentity: null
    })
  | (ArtifactPublicationReceiptBaseV3 & {
      readonly phase: 'exchanged'
      readonly publishedIdentity: ArtifactEntryIdentityV3
      readonly cleanupVerifiedAt: null
    } & (
        | {
            readonly publicationMode: 'no-replace'
            readonly expectedIdentity: null
            readonly displacedIdentity: null
          }
        | {
            readonly publicationMode: 'replace'
            readonly expectedIdentity: ArtifactEntryIdentityV3
            readonly displacedIdentity: ArtifactEntryIdentityV3
          }
      ))
  | (ArtifactPublicationReceiptBaseV3 & {
      readonly phase: 'cleanup-verified'
      readonly publishedIdentity: ArtifactEntryIdentityV3
      readonly cleanupVerifiedAt: string
    } & (
        | {
            readonly publicationMode: 'no-replace'
            readonly expectedIdentity: null
            readonly displacedIdentity: null
          }
        | {
            readonly publicationMode: 'replace'
            readonly expectedIdentity: ArtifactEntryIdentityV3
            readonly displacedIdentity: ArtifactEntryIdentityV3
          }
      ))
  | (ArtifactPublicationReceiptBaseV3 & {
      readonly phase: 'repair-required'
      readonly publicationMode: 'no-replace' | 'replace'
      readonly expectedIdentity: ArtifactEntryIdentityV3 | null
      readonly publishedIdentity: ArtifactEntryIdentityV3 | null
      readonly displacedIdentity: ArtifactEntryIdentityV3 | null
      readonly repairId: string
    })

interface ArtifactExchangeResultV3 {
  readonly publication: ArtifactPublicationReceiptRefV3
  readonly published: ArtifactEntryCapabilityV3
  readonly displaced: ArtifactEntryCapabilityV3
}

interface ArtifactNoReplaceResultV3 {
  readonly publication: ArtifactPublicationReceiptRefV3
  readonly published: ArtifactEntryCapabilityV3
}

type ArtifactFsOperationIdentityV3 =
  | { kind: 'plugin-generation'; pluginId: string; generationId: string }
  | { kind: 'skill-reserve'; skillId: string; operationId: string }
  | RestoreOperationIdentityV3
  | { kind: 'pending-restore-stage'; stageId: string }
  | { kind: 'pending-restore-legacy-adoption'; adoptionId: string }
  | {
      kind: 'backup-export'
      backupOperationId: string
      backupKind: 'manual' | 'scheduled' | 'auto' | 'pre-migration' | 'pre-restore'
      archiveName: ValidatedPathSegment
    }
  | { kind: 'backup-retention'; retentionOperationId: string }
  | { kind: 'backup-legacy-adoption'; adoptionScanId: string }
  | {
      kind: 'worktree-reconstruction'
      restoreOperationId: string
      taskId: ValidatedPathSegment
      reconstructionId: string
    }

function digestArtifactFsOperationIdentityV3(operation: ArtifactFsOperationIdentityV3): string {
  const wire = ArtifactFsOperationIdentityV3WireSchema.parse(
    encodeArtifactFsOperationIdentityV3(operation),
  )
  return sha256HexV3(`agent-workflow/artifact-fs-operation/v3\0${canonicalJsonV3(wire)}`)
}

async function loadAndVerifyArtifactPublicationRefV3(
  ref: ArtifactPublicationReceiptRefV3,
  expectedOperation: ArtifactFsOperationIdentityV3,
  expectedRole: ArtifactFsSlotRoleV3,
): Promise<ArtifactPublicationReceiptV3> {
  const locator = artifactPublicationLocatorFromRefV3(ref)
  const receipt = await durableRootStorageV3.lookup(locator)
  if (receipt === null) throw new Error('artifact-publication-receipt-missing')
  const expectedDigest = digestArtifactFsOperationIdentityV3(expectedOperation)
  if (
    receipt.receiptId !== ref.receiptId ||
    receipt.revision !== ref.revision ||
    receipt.slotRole !== expectedRole ||
    ref.slotRole !== expectedRole ||
    !constantTimeHexEqualV3(receipt.operationDigest, expectedDigest) ||
    !constantTimeHexEqualV3(ref.operationDigest, expectedDigest) ||
    !artifactFsOperationIdentityEqualV3(receipt.operation, expectedOperation)
  ) {
    throw new Error('foreign-artifact-publication-reference')
  }
  return receipt
}

interface ArtifactFsCapabilityV3 {
  readonly __brand: 'ArtifactFsCapabilityV3'
  readonly operation: ArtifactFsOperationIdentityV3

  mkdirExclusive(
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
  ): Promise<ArtifactDirCapabilityV3>
  openDir(
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
  ): Promise<ArtifactDirCapabilityV3>
  openEntry(
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
    expected?: ArtifactEntryIdentityV3,
  ): Promise<ArtifactEntryCapabilityV3 | 'absent'>
  createTemp(parent: ArtifactDirCapabilityV3): Promise<ArtifactWritableTempCapabilityV3>
  createTree(slotRole: ArtifactFsSlotRoleV3): Promise<ArtifactTreeWriterV3>
  writeTemp(temp: ArtifactWritableTempCapabilityV3, bytes: Uint8Array): Promise<void>
  sealTemp(
    temp: ArtifactWritableTempCapabilityV3,
    slotRole: ArtifactFsSlotRoleV3,
    expectedFileDigest: string,
  ): Promise<ArtifactSealedFileCapabilityV3>
  commitFileNoReplace(
    file: ArtifactSealedFileCapabilityV3,
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
  ): Promise<ArtifactNoReplaceResultV3>
  commitFileReplace(
    file: ArtifactSealedFileCapabilityV3,
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
    expected: ArtifactEntryIdentityV3,
  ): Promise<ArtifactExchangeResultV3>
  commitTreeNoReplace(
    tree: ArtifactSealedTreeCapabilityV3,
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
  ): Promise<ArtifactNoReplaceResultV3>
  commitTreeReplace(
    tree: ArtifactSealedTreeCapabilityV3,
    parent: ArtifactDirCapabilityV3,
    name: ValidatedPathSegment,
    expected: ArtifactEntryIdentityV3,
  ): Promise<ArtifactExchangeResultV3>
  removeEntryExact(entry: ArtifactEntryCapabilityV3): Promise<'removed' | 'absent'>
  removeTreeExact(entry: ArtifactEntryCapabilityV3): Promise<'removed' | 'absent'>
}
```

API不接受 string path、`URL`、raw fd或任意 callback；capabilities只能由 broker从 daemon-minted
canonical artifact/restore identity产生，不能序列化、跨 operation复用或从 caller path重建。
`ArtifactTreeWriterV3`只接受自己的 `root/mkdir`产出的
`ArtifactTreeDirCapabilityV3`，不能拿 canonical `ArtifactDirCapabilityV3`在 staging tree外写。
`slotRole`也必须由 broker按 `operation`的 closed allowlist验证，不能把一个 Skill/restore
capability改指向其它 canonical slot。
`ArtifactExchangeResultV3.published`固定表示 canonical target的新 entry，`displaced`固定表示被
交换到 broker-private operation slot的旧 entry；不能用一个未标角色的 capability兼任两者。

file/tree publication的每个 public方法内部都先向 broker-owned、非 restore 的
`ArtifactPublicationLedgerV3` fsync
`ArtifactPublicationReceiptV3 {operation,slotRole,revision,phase:'prepared',stagedIdentity,
expectedIdentity}`；`slotRole`只能是 enum（如 `skill-live-files`、`skill-version`、
`plugin-manifest`、`restore-safety-database-wal`、`restore-safety-config-file`、
`restore-config-file`、`restore-skills-root`、`backup-archive`），
broker-private segment只由 broker从 canonical
operation identity内部推导，不进入 caller API或 durable path。syscall后把 exact
`publishedIdentity/displacedIdentity`与 `phase='exchanged'` fsync/CAS，再返回不可序列化 entry
capabilities与可持久化的 receipt id/revision ref；业务 journal/Skill operation/restore marker只
保存该 ref并逐字段核对 operation/slot。若 crash发生在 syscall与 phase update之间，新 broker先
扫描 publication ledger，只比较 canonical slot与 private operation slot中的 staged/expected
identity，精确判定 before/after或进入 repair-required，不按名称/mtime猜测。file displaced由
`removeEntryExact`、tree displaced由 `removeTreeExact`证明 absent，并把 publication receipt
fsync为 `cleanup-verified`前，所属 Skill op/Plugin publish/restore phase不得 complete。

broker是同版本的最小 native helper，通过 anonymous authenticated socketpair启动；root/child
dirfd只在 helper actual executable identity验证成功后经 `SCM_RIGHTS`传递，control fd均
`CLOEXEC`且不进入 npm/producer。它不监听 filesystem socket，不接受 caller supplied root/path，
每个 frame绑定 capability nonce、canonical identity、operation lock lease与严格 phase；
unknown/replayed/out-of-phase frame关闭 broker并让 journal保持 unsettled。

1. **Verified executable先于 authority**：
   - Linux把 embedded helper bytes写入 `memfd_create(MFD_CLOEXEC|MFD_ALLOW_SEALING)`，核对
     build-id/digest后加 `F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK|F_SEAL_SEAL`，只以该 verified fd
     `execveat(...,AT_EMPTY_PATH)`；path cache不是 exec authority；
   - Darwin可从 broker-private cache path `posix_spawn`，但 child在收到任何 root dirfd前必须以
     inherited nonce返回 audit token。parent用 Security.framework/`csops`核对 actual running
     process的 pinned designated requirement、CDHash、team/build identity；再核对 cache vnode
     digest。unsigned、ad-hoc identity不在 allowlist、spawn/path swap或 audit token mismatch都杀
     child并令 capability unavailable。测试构建使用专门 test signing identity，不以关闭验证
     绕过；
   - 两平台 wrong helper在验证前只有无 authority socket；因此即使 path在 open→spawn间被替换，
     也拿不到 root dirfd。
2. daemon在 singleton lock后、任何 restore/DB/HTTP/worker前打开 app-home root为
   `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` root dirfd。builder只从 validated canonical ids产生一个
   segment：
   - Linux逐段使用
     `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV)`；
   - Darwin逐段使用
     `openat(O_DIRECTORY|O_RESOLVE_BENEATH|O_NOFOLLOW_ANY|O_UNIQUE)`，lookup/rename另带
     `AT_RESOLVE_BENEATH|AT_SYMLINK_NOFOLLOW_ANY|AT_UNIQUE`和
     `RENAME_RESOLVE_BENEATH|RENAME_NOFOLLOW_ANY`；
   - 每个 opened segment都 `fstat/fstatfs`，要求 root的 `st_dev/fsid`不变。bind/volume mount、
     hardlinked directory、non-directory、symlink、identity变化或 OS flag不可用均在零写下
     fail closed。缺失目录只由 anchored parent `mkdirat`建立后重开；`EEXIST`不猜用途。
3. 所有 file create/open、tree walk、copy、unlink与 publication只相对上述 handles：
   - Linux `createTemp`必须是 parent上的 `O_TMPFILE|O_RDWR|O_CLOEXEC`，写/flush/fsync阶段
     `nlink===0`；`sealTemp`核对 digest并用 `linkat(AT_EMPTY_PATH)`只链接到 broker-private
     operation slot、fsync parent后返回 sealed file。`commitFileNoReplace`才发布 canonical
     no-replace target；replace核对 expected target后 descriptor-relative
     `renameat2(RENAME_EXCHANGE)`并返回明确的 `{published,displaced}`。seal后不再写 temp，故
     外部 hardlink无法把
     后续 write导向 sentinel；filesystem不支持 anonymous temp/linkat时 capability unavailable；
   - Darwin没有可依赖的 `O_TMPFILE`。`createTemp`只在 contained child不可见、仅 verified broker
     持有 dirfd的 private staging dir中用
     `O_CREAT|O_EXCL|O_NOFOLLOW_ANY|O_RESOLVE_BENEATH|O_UNIQUE`建立，且每个 write前后与 fsync后
     都要求 exact `{dev,ino,fsid,nlink===1}`。发布用
     `renameatx_np(RENAME_EXCL|RENAME_NOFOLLOW_ANY|RENAME_RESOLVE_BENEATH)`或 exact-expected
     `RENAME_SWAP`并返回明确的 `{published,displaced}`。任一 link count变化零后续 write并 fail
     closed；
   - 该 Darwin防线针对边界内 contained child与app并发；能直接进入 broker-private app-home并
     hardlink temp的 unsandboxed same-UID process已满足 §0.1.1 的 host-compromise定义，不能由
     pathname API安全隔离。
4. existing regular file永不 `O_TRUNC`或原位改写。replace先通过 `openEntry`取得 exact capability，
   验证 target `{dev,ino,fsid,nlink===1}`，再用同 parent descriptor atomic swap；final component
   为 symlink只拒绝，绝不 follow。每次 publication/cleanup以 anchored parent重读
   name→expected identity；mismatch不写、不删并进入 `repair-required`。caller必须保留 exchange
   receipt并消费 displaced cleanup；应用 coordinator/lock负责业务串行，但不充当 filesystem
   proof。`ArtifactSealedFileCapabilityV3`只能由 matching operation/slot的 `sealTemp`产出，seal
   会把文件durable放入 broker-private namespace；boot只能由 matching publication/restore marker
   的 exact identity/digest重新 mint，caller不能从 path或普通 entry伪造。
5. `createTree`只在 broker-private operation namespace建立 writer；producer只能用 validated
   segment调用 `mkdir/writeFile`。`seal`前 broker逐 regular file fsync、逐目录 bottom-up fsync、
   拒绝 symlink/hardlink/device/FIFO并核对 tree digest；seal后 writer write方法永久失效。完整目录
   只可 `commitTreeNoReplace`或 exact-expected `commitTreeReplace`：Linux使用 descriptor-relative
   `renameat2(RENAME_NOREPLACE|RENAME_EXCHANGE)`，Darwin使用
   `renameatx_np(RENAME_EXCL|RENAME_SWAP|RENAME_NOFOLLOW_ANY|RENAME_RESOLVE_BENEATH)`。不支持原子
   directory exchange的平台 capability unavailable。
6. Skill producer接口改为上述 `ArtifactTreeWriterV3`，不再把 `filesDir`字符串交给 callback。
   `stageManagedSkill`、`commitSkillVersion`、`skillFsPublish`、editor/fusion/import/ZIP、identity
   migration、restore与 boot recovery全部进入 capability inventory；live `files/`与version tree
   使用 sealed-tree publication receipt；backup staging只能由下述独立 backup authority建立，
   不能把 Skill operation或 restore operation挪作它用。source guard禁止 canonical
   Skill/Plugin/config/restore roots下新增
   `mkdirSync/writeFileSync/cpSync/renameSync/rmSync`或等价 path writer。

```ts
interface ReadOnlyPluginSourceCapabilityV3 {
  readonly __brand: 'ReadOnlyPluginSourceCapabilityV3'
  readonly sessionHandle: string
  readonly bindingDigest: string
  readonly rootIdentity: ArtifactEntryIdentityV3
  readonly treeDigest: string
  listRootEntries(maxEntries: number): Promise<readonly ValidatedPathSegment[]>
  readRelativeFile(name: ValidatedPathSegment, maxBytes: number): Promise<Uint8Array | 'absent'>
}
```

该接口只允许 bounded inspection；不返回 raw path/fd，不允许 write/delete，也不能自己构造 Plugin
persisted spec。canonical Plugin service在 final transaction内从 current mounted row取得
server-only spec/fence并与 capability逐字段匹配，模型与 wire均拿不到它。

7. Plugin install/update/manifest publish/cleanup/GC/doctor同走 stable `pluginId` coordinator与
   capability；host package/manifest temp也不得使用 `Bun.write`或 string rename。`file:` Plugin
   只通过 session handle/fence mint的 `ReadOnlyPluginSourceCapabilityV3`读取用户已明确选择的源；
   model payload不能携 path，source capability永不取得 host-owned generation authority，也永不
   删除源路径。

npm/git/lifecycle无法直接消费 dirfd API，因此 admitted child还必须在 §0.5.1.2 的 OS filesystem
view内运行：唯一可写 inode是 host已 exclusive打开的 generation leaf（attempt cache/scratch
位于该 leaf内），authority ancestors不可写，其余 host路径只读或不可见。Linux supervisor从
inherited leaf fd建立 private mount view `/artifact`。symlink target在 view外/只读，故 owned
child即使在 last-check→syscall窗口植入 symlink也只能安全失败。每次发布的 exact
qualification self-test必须真实执行 anonymous/named temp hardlink、parent/leaf replacement、
bind mount与 symlink-to-sentinel攻击；平台
不能同时证明 process-set ownership与 sentinel零写时，Intent Plugin operation在 journal
receipt、leaf create、spawn/GO前返回 `intent-artifact-containment-unavailable`，不得降级成
普通 `--prefix <path>`。

当前平台矩阵故意不伪造 parity：

| 平台/操作                   | RFC-235 admission                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Linux npm/git Plugin        | private PID + mount namespace、dirfd-bound `/artifact`；fresh exact qualification后可执行  |
| Darwin npm/git Plugin       | Composer/model capability中 disabled；preflight仍 typed reject，零 accepted attempt/child  |
| Linux/Darwin managed Skill  | host-only `ArtifactTreeWriterV3` / descriptor capability；不需要 package child containment |
| Linux/Darwin `file:` Plugin | 仅 concrete actor-selected source；read-only capability、零 host-owned generation          |

Darwin的 Seatbelt能限制 filesystem，却不能提供可恢复、不可逃逸的 descendant ownership；
SDK还明确标记 `EVFILT_PROC NOTE_TRACK/NOTE_CHILD/NOTE_TRACKERR` 自 macOS 10.5起不受支持。
因此不能以 Seatbelt + PGID、`proc_listchildpids`轮询、`--ignore-scripts`或“npm通常不 daemonize”
替代 §0.5.1.2 empty proof。Darwin Composer在 generation前就从 strict capability DTO把 Plugin
card显示为 disabled并解释当前 host不支持 npm/git；Auto/明确目标进入的受信模型 capability也禁止
输出该 op。Review validation仍以 `intent-artifact-containment-unavailable`禁 Apply，防止 host
capability在生成后漂移；它是 defense in depth，不再是用户第一次知道死路。

`file:`不是“host支持路径读取”的布尔开关。create-time Plugin mount经 transaction ACL后成为
session manifest handle，server-only detail另保存
`{sourceKind:'file',operationConfigHash,specHmac}`；模型 dump与 capability只投影 handle、
actor-safe display和 binding digest。strict Plugin source union要求
`{kind:'mounted-file',handle}`且禁止 `spec/path`；resolver要求 handle位于当前
`concreteSources`，final transaction再按 handle重读 current Plugin/source kind/ACL/config/spec
fence，由 broker从 current row mint `ReadOnlyPluginSourceCapabilityV3`。模型 payload永不传给
`realpath/open`；handle、fence或 source kind漂移在 source fd打开前 typed fail closed。npm/git
package create则使用 `{kind:'package',spec}`且 grammar拒绝 file/absolute/relative path。两平台
npm/git `update=false`，mounted Plugin修改只允许用户确认 copy；不得进入不存在的 in-place
update kernel。

record-before-act 顺序固定：

0. owner authorization → strict parse → `normalizeIntentMutationV1`/HMAC后，先查 unified
   ledger。existing exact不运行本段；只有 absent的新 id才按 source kind与 current host读取
   capability matrix。任何 npm/git Plugin op只在 Linux fresh zero-write qualification产生
   `ArtifactAdmissionLeaseV1`后进入 claim；Darwin、static unavailable或 probe失败直接返回 typed
   validation error，零 mutation ledger/journal/receipt、零 generation id/leaf。claim transaction
   二次 ledger lookup并验证 lease；它是 absent-check与claim之间的 race fence，不持久化也不授权
   spawn。Darwin返回 definitive HTTP 422
   `{code:'intent-artifact-containment-unavailable',retryable:false}`；该请求从未被服务端接受，
   不产生 anchor，也不得在后台排队。前端收到该 422 后必须销毁 frozen commit attempt/id，
   保留非敏感决定并继续禁用 Apply；用户挂载已有 concrete `file:` Plugin source或切到 admitted
   Linux host 后才以新 `clientMutationId`提交。若 422 response丢失，客户端不知道该 id应销毁，
   只能重放 frozen
   body/id；因为服务端明确保持零状态，capability后来恢复时该 id **允许被第一次接受**，再由
   ledger永久锚定并保证副作用至多一次。它不能被称作旧 attempt成功，因为旧请求从未
   accepted。Linux dynamic exact probe失败也按同一语义：看见 definitive 422才 mint新 id，
   outcome unknown则保留原 id重试。因而 §0.1 unified ledger覆盖所有**已接受** mutation；
   wire/schema/capability rejection没有 durable receipt，也不承诺不存在的 rejection tombstone。
   claim后 capability变 red是 accepted attempt的执行失败：journal进入 compensating/failed或
   repair-required，exact replay始终返回该 anchor，绝不倒退成无状态422。
1. npm/git Plugin create由 apply service预生成 `generationId`。一个 short transaction先向 exact
   journal追加 `{pluginId,generationId,writer:{phase:'reserved'}}`并提交；失败则零文件动作。
   exported `installPluginGeneration`只消费该 caller id与 journal-bound authority，installer不得
   内部重 mint。
2. managed Skill create预生成 `skillId/operationId`；同一个 short transaction同时追加
   `skill-reserve` receipt、插 invisible `reservationState='reserving'` row、建立 exact reserve
   operation/lock。`beginOperation`新增 caller-id入口，既有调用仍可由兼容 wrapper内部 mint；
   `materializeManagedSkillStage`只能消费既有 operation与filesystem capability，不能另 mint op。
   receipt或 reservation transaction失败时零 Skill文件动作。
3. 每追加一项及更新 writer phase都使用上述 artifact revision CAS；artifact array顺序就是真实
   side-effect顺序，补偿总是 reverse。journal进入 compensating后禁止再 append、release writer
   或开始 forward phase。

##### 0.5.1.2 Owned Plugin writer：persist-before-GO 与不可逃逸 process-set proof

npm/git不得再由 daemon直接 `spawn`，普通 PGID也不是 quiescence authority：package lifecycle可
`setsid`、double-fork并关闭继承 pipe。实现保留 RFC-224 authenticated control协议，但新建
verified-self `OwnedArtifactContainmentIdentityV3`，只在能证明 kernel process-set ownership的平台
admit：

1. apply preflight在 journal claim/prestage前先查询 exact capability。当前 admitted provider只有
   Linux private PID + mount namespace；Darwin固定返回
   `intent-artifact-containment-unavailable`，所以不会产生 Plugin receipt、generation leaf或
   supervisor。不得以 PGID、`proc_listchildpids`轮询、Seatbelt或禁 lifecycle降低门槛。
2. Linux每次 Plugin writer做 fresh exact qualification，从 inherited leaf fd建立 filesystem
   view并启动 namespace PID 1/anchor。namespace内 descendant即使再建 session、double-fork或
   嵌套 namespace，也仍属于该祖先 namespace。真实 self-test必须包含
   `setsid + double-fork + close pipes + delayed write`；bwrap/userns/PID/proc/mount任一能力
   不完整时仍在 receipt/leaf前 typed fail closed。
3. daemon在创建任何 artifact control socket前已设置
   `PR_SET_DUMPABLE=0 + RLIMIT_CORE=0`。namespace与 writable view建立后，supervisor先设置相同
   no-dump/no-core、清 env/argv、关闭非 allowlist fd、`mlock + MADV_DONTDUMP` signer memory，
   **再在进程内生成一次性 Ed25519 keypair**。private key没有 export frame，不进入 daemon、disk、
   env、argv、core、npm或 descendants。supervisor只监听 inherited bounded anonymous
   socketpair并报告
   `READY {executionNonce,supervisorPid,supervisorStartIdentity,containment,proofPublicKey,keyId}`；
   此时不能启动 npm、mkdir或写 generation byte。host独立重读 boot-id/start-ticks、
   verified-self command/nonce、PID namespace inode与 key-id digest；qualification必须让
   same-UID sibling的 ptrace/process-vm-read、`/proc/*/{mem,fd}`与 control injection全部失败。
4. host构造 canonical
   `ArtifactContainmentReleaseV3 {journalId,attemptSeq,artifactRevision,pluginId,generationId,
executionNonce,supervisorStartIdentity,pidNamespaceInode,proofPublicKey}`并计算
   `releaseRecordDigest`。先把 exact release写入 broker-owned
   `ArtifactWriterObligationLedgerV3`并 fsync，再以 artifact revision CAS把完整
   identity/public key/digest/obligation id写为 `writer.phase='released'`并提交；只有两者
   revision/digest逐字段匹配且 DB `changes===1` 后才沿既有 anonymous socket发送
   `GO {executionNonce,releaseRecordDigest}`。socket不是 filesystem-discoverable endpoint，
   daemon/supervisor non-dumpable阻断同 UID fd复制；nonce、strict phase与 digest阻断旧 frame
   replay。CAS失败、control write/flush失败或 GO前 daemon退出时，supervisor绝不能 spawn writer；
   其零子进程 EMPTY仍走同一 signature协议。GO后才在 exact filesystem sandbox中以 leaf fd为
   cwd启动 npm/git，允许 lifecycle但不给 authority parent write或 host外部 write。
5. npm direct exit不代表完成。正常、control EOF、malformed frame、timeout、cancel与 watchdog都
   进入 containment stop：Linux namespace init向 namespace全体 TERM→bounded grace→KILL并
   reap全部 reparented descendants，反复核验 namespace中除 init外为空。任一 namespace/proc
   identity ambiguity、kill/wait错误、deadline或 supervisor异常都不得签 proof，只能保持
   `compensating/repair-required`。
6. 只有 direct leader settled且 namespace process set empty时，supervisor才构造 canonical
   unsigned `ArtifactContainmentEmptyProofV3`，其中绑定 exact `releaseRecordDigest/keyId/
executionNonce/bootId/startTicks/pidNamespaceInode/directLeaderSettled/processCount=0/
trackingErrorCount=0/emptyObservedAt`。`recordDigest`是 unsigned payload的 SHA-256；
   `signatureBase64=Ed25519.sign(privateKey, canonicalUnsignedProof)`。supervisor在 npm不可见的
   control root写 exclusive+fsynced record、发送 `EMPTY`，随后显式清零/解锁 private key并退出。
   host strict parse，以 **obligation + journal released identity共同持有的同一 public key**验签并
   逐字段核对 release/artifact/protocol monotonicity；先把 obligation fsync为 quiesced，再以
   revision CAS写 journal `writer.phase='quiesced'`。任一单边更新由 boot merger以 exact proof
   补齐，不猜测。PGID ESRCH、一次 directory missing、空 daemon registry、仅有 record digest或
   未经验证的 completion file都不是 proof；manifest读取/host publication只能在该 CAS后发生。
7. daemon SIGKILL会关闭 control pipe，旧 supervisor继续 stop并落 signed EMPTY record。新 daemon
   在 singleton lock与 FS broker qualification后，先核对 non-restored
   `ArtifactPublicationLedgerV3`中的 prepared/exchanged publication：只把 syscall歧义精确分类为
   before/after或 repair-required，保留 displaced authority，绝不在读到业务 barrier前猜删；再
   **先于任何 pending DB restore**扫描 `ArtifactWriterObligationLedgerV3`：`released` obligation若 exact
   supervisor仍活则等待其自主
   EOF stop；supervisor已退出时只从 derived control location读取 record并用 obligation public key
   验签。全部 obligation必须到 quiesced或明确 repair-required，仍 live/ambiguous时拒绝 restore与
   boot。随后才允许 swap DB。restored DB open/migrate后，第二阶段 merger把 external obligations
   与 restored journal、current Plugin generation id/ref inventory逐项对照：restore中已消失的
   journal变成 `restore-orphaned` cleanup obligation，只有 valid EMPTY + exact generation absent
   proof后才 cleanup-verified/retired；若 restored Plugin仍引用该 generation或 identity不符则
   repair-required。HTTP listener/Plugin GC/worker必须等 merger全部收口。`reserved`从未收到 GO；
   obligation-only pre-GO row也先关闭 supervisor并取得 signed零子进程 proof。旧 proof不能跨
   releaseRecordDigest或 artifactRevision重放；整个流程不读取/恢复 private key，也绝不凭旧
   PID/PGID枚举或删除 generation。

##### 0.5.1.3 Cold/pending restore 的 whole-tree generation authority

`ArtifactFsCapabilityV3`的 Plugin/Skill operation identity不能代表“用备份替换整个 skills/”。
restore不是 source-guard例外，而是独立、可恢复的 capability：

```ts
type RestoreIngressSourceV3 =
  | 'http-stream'
  | 'live-cli-fd'
  | 'stopped-cli-fd'
  | 'pending-marker'
  | 'legacy-adopted'

type StrictRestoreOptionsV3 = RestoreExecutionOptionsV3

interface ReadOnlyBackupCapabilityV3 {
  readonly __brand: 'ReadOnlyBackupCapabilityV3'
  readonly restoreOperationId: string
  readonly source: RestoreIngressSourceV3
  readonly identity: ArtifactEntryIdentityV3
  readonly archiveDigest: string
  readonly byteLength: number
}

type RestoreBackupKindV3 = 'manual' | 'scheduled' | 'auto' | 'pre-restore' | 'pre-migration'

interface RestorePlanDtoV3 {
  readonly schemaVersion: 3
  readonly archiveDigest: string
  readonly byteLength: number
  readonly manifestKind: RestoreBackupKindV3 | 'legacy'
  readonly backupMigrationCreatedAt: number | null
  readonly currentMigrationCreatedAt: number
  readonly direction: 'forward' | 'same' | 'downgrade'
  readonly validation: {
    readonly archive: 'verified'
    readonly databaseIntegrity: 'verified' | 'explicitly-skipped'
    readonly wouldTakeSafetyBackup: boolean
    readonly wouldRunMigrations: boolean
  }
}

interface CurrentMigrationAxisCapabilityV3 {
  readonly __brand: 'CurrentMigrationAxisCapabilityV3'
  readonly source: 'embedded-sealed-journal' | 'dev-readonly-descriptor'
  readonly binaryDigest: string
  readonly maxCreatedAt: number
  readonly migrationCount: number
}

interface RestoreInspectionServiceV3 {
  readonly __brand: 'RestoreInspectionServiceV3'
  readonly currentMigrationAxis: CurrentMigrationAxisCapabilityV3
  inspect(
    source: ReadOnlyBackupCapabilityV3,
    options: StrictRestoreOptionsV3,
  ): Promise<RestorePlanDtoV3>
}

interface RestoreHttpIngressMetadataV3 {
  readonly actorUserId: string // route从 authenticated actor注入；wire不能自报
  readonly clientMutationId: string
  readonly contentLength: number | null
  readonly options: StrictRestoreOptionsV3
}

interface RestoreUploadWriterV3 {
  readonly __brand: 'RestoreUploadWriterV3'
  readonly clientMutationId: string
  readonly stageId: string
  readonly restoreOperationId: string
  readonly metadataDigest: string
  writeChunk(chunk: Uint8Array): Promise<void> // await即 backpressure
  seal(): Promise<ReadOnlyBackupCapabilityV3>
  abort(reason: 'disconnect' | 'over-limit' | 'digest-mismatch'): Promise<void>
}

interface RestoreReplayVerifierV3 {
  readonly __brand: 'RestoreReplayVerifierV3'
  readonly clientMutationId: string
  writeChunk(chunk: Uint8Array): Promise<void>
  verifyExact(): Promise<PendingRestoreStageReceiptV3>
  abort(reason: 'disconnect' | 'over-limit' | 'digest-mismatch'): Promise<void>
}

interface DelegatedReadOnlyArchiveFdV3 {
  readonly __brand: 'DelegatedReadOnlyArchiveFdV3'
  readonly peerScope: StablePendingRestoreCallerScope
  readonly bootNonce: string
  readonly identity: ArtifactEntryIdentityV3
  readonly archiveDigest: string
  readonly byteLength: number
}

type PendingRestoreLocalControlRequestV3 =
  | {
      readonly schemaVersion: 3
      readonly operation: 'inspect-backup'
      readonly requestNonce: string
      readonly options: StrictRestoreOptionsV3
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'stage'
      readonly clientMutationId: string
      readonly options: StrictRestoreOptionsV3
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'lookup'
      readonly query:
        | { readonly kind: 'mutation'; readonly clientMutationId: string }
        | { readonly kind: 'active' }
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'cancel'
      readonly clientMutationId: string
      readonly expectedStageId: string
      readonly expectedRevision: number
    }

type PendingRestoreLocalControlResponseV3 =
  | {
      readonly schemaVersion: 3
      readonly operation: 'inspect-backup'
      readonly requestNonce: string
      readonly plan: RestorePlanDtoV3
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'stage'
      readonly receipt: PendingRestoreStageReceiptV3
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'lookup'
      readonly result:
        | { readonly kind: 'mutation'; readonly value: PendingRestoreMutationLookupDtoV3 }
        | { readonly kind: 'active'; readonly value: PendingRestoreStatusDtoV3 }
    }
  | {
      readonly schemaVersion: 3
      readonly operation: 'cancel'
      readonly receipt: PendingRestoreStageReceiptV3
    }

interface StrictPendingArchiveRefV3 {
  readonly __brand: 'StrictPendingArchiveRefV3'
  readonly markerIdentity: ArtifactEntryIdentityV3
  readonly archiveIdentity: ArtifactEntryIdentityV3
  readonly archiveDigest: string
}

type DelegatedRestoreIngressRequestV3 =
  | {
      readonly operation: 'inspect-backup'
      readonly requestNonce: string
      readonly options: StrictRestoreOptionsV3
    }
  | {
      readonly operation: 'stage'
      readonly clientMutationId: string
      readonly options: StrictRestoreOptionsV3
    }

interface PendingRestoreIngressCapabilityV3 {
  readonly __brand: 'PendingRestoreIngressCapabilityV3'
  beginHttpUpload(input: RestoreHttpIngressMetadataV3): Promise<
    | { kind: 'upload'; writer: RestoreUploadWriterV3 }
    | {
        kind: 'verify-terminal-replay'
        verifier: RestoreReplayVerifierV3
        expected: PendingRestoreStageReceiptV3
      }
  >
  acceptDelegatedFile(
    source: DelegatedReadOnlyArchiveFdV3,
    request: DelegatedRestoreIngressRequestV3,
  ): Promise<ReadOnlyBackupCapabilityV3>
  openPendingArchive(source: StrictPendingArchiveRefV3): Promise<ReadOnlyBackupCapabilityV3>
}

/**
 * Draft v21: the executable appendix is normative. These imports name the
 * durable projections used below; the appendix contains every component
 * schema, all 14 phase schemas, seven explicit phase encoders, both complete
 * refiners, compile-time equality proofs, fixtures, and the real WAL proof.
 */
import type {
  ArtifactPublicationExpectedProjectionV3,
  ArtifactSqliteGenerationV3Decoded,
  RestoreDatabaseExchangeV3Decoded,
  RestoreDatabaseMigrationV3Decoded,
  RestoreExecutionOptionsV3,
  RestoreFsExchangeV3Decoded,
  RestoreGenerationCleanupV3Decoded,
  RestoreGenerationMarkerV3Decoded,
  RestoreGenerationMarkerV3Wire,
  RestoreIdentityBarrierV3Decoded,
  RestoreLiveGenerationObservationV3Decoded,
  RestoreOperationIdentityV3,
  RestoreSafetyGenerationV3Decoded,
  RestoreSqlitePublicationRefV3,
  RestoreSqlitePublicationV3Decoded,
  RestoreStagedGenerationV3Decoded,
} from './restore-generation-v3.normative'
```

`restore-generation-v3.normative.ts`与本节同为 normative design source；正文摘要与 appendix
冲突时以 appendix 为准，implementation gate须复制/抽取其合同而不是自行发明 schema。它必须以
repo固定的 Zod 3.25.76与 strict TypeScript编译，并直接运行 runtime proof。它闭合以下协议：

1. `RestoreOperationIdentityV3`完整保存 archive/DB/config/skills digest、canonical
   `RestoreExecutionOptionsV3 {noMigrate,noSafetyBackup,skipIntegrityCheck}`及
   domain-separated options digest。operation digest固定为
   `SHA-256("agent-workflow/artifact-fs-operation/v3\0" + canonicalJson(operation))`；pending
   control、legacy handoff、generation marker、SQLite publication与每个 publication receipt必须
   保存逐字段相同的 options/operation/digest，不能从 browser/CLI locator反推执行策略。
2. archive内 DB/WAL/SHM先 exact-copy到 broker-private generation；只在该私有 generation打开
   SQLite并 checkpoint/consolidate。`staging` marker只能引用自包含 DB、`wal=absent`、
   `shm=absent`且 `consolidatedFromArchiveDigest`匹配的 sealed generation。incoming WAL-only
   committed rows若未进入 consolidated DB，首个 marker不得落盘。
3. live generation在任何 destructive effect前形成
   `RestoreLiveGenerationObservationV3Decoded`：DB/WAL/SHM/config/skills各自是 strict
   `absent|present(identity,digest)`，不创建 placeholder。safety copy分别使用
   `restore-safety-database-file|restore-safety-database-wal|restore-safety-database-shm|`
   `restore-safety-config-file|restore-safety-skills-root`，与 live publication/removal slot不混用。safety是
   `captured|skipped-by-operator`；前者逐项复制全部 present bytes并fsync，后者只在
   `noSafetyBackup=true`时合法且诚实保留 capture=null。两者都保留相同 live observation，供
   expected-identity publication与 forward recovery使用。
4. 第 16 个 durable root `restore-sqlite-publication`在任何 sidecar effect前先落 immutable
   `declared`。marker随后以 `safety-snapshotted + RestoreSqlitePublicationRefV3`引用它；只有这两
   次 checkpoint均 durable后才允许 effect。ref含 exact `revision + frameDigest`，storage key也
   以 root id/revision/frame digest寻址；若在 root declared与 marker checkpoint间崩溃，尚无
   effect，重启按 deterministic operation locator复用该 frame。后续 checkpoint只 append新 frame，
   不覆盖 marker引用的 declaration anchor。
5. SQLite root严格按
   `declared → wal-removing? → wal-settled → shm-removing? → sidecars-settled →
db-publishing → db-published`推进。present sidecar必须先写 `removing(expectedIdentity,
intentRevision)`，再 exact unlink、parent fsync，最后写
   `removed(expectedIdentity,removedIdentity,parentFsyncFence)`；`declared`只接受
   `pending|not-applicable`，WAL settled前 SHM不得离开初态，absent sidecar只能
   `not-applicable`。replacement、both、identity drift或无法证明 unlink结果进入
   `repair-required`，不得打开新 DB。
6. DB publication在 WAL/SHM均 settled后才可 prepared。live DB absent走
   `no-replace,published,displaced=null`；present走 exact
   `replace,published,displaced=liveBefore.database`。只有 SQLite root达到 `db-published`并由
   root-specific locator加载、逐字段验证 full operation/ref后，marker才可 checkpoint
   `db-swapped`。这保持 RFC-213的“先清 stale WAL/SHM、再换 DB”语义。
7. incoming Skills即使为空也必须是 sealed真实空 tree；live Skills absent走 tree no-replace，
   present走 replace。config保持 `preserve|no-replace|replace`。DB/config/skills cleanup分别是
   `not-applicable|removed(exact displaced)`；不存在 displaced identity时禁止伪造 removed。
8. migration是 strict
   `applied|skipped-no-migrate|not-required`：schema不同且 `noMigrate=false`只能 applied，
   schema不同且 `noMigrate=true`只能 skipped，schema相同只能 not-required。kill在
   `fs-swapped`之后也可只凭 marker恢复正确策略。
9. 七态 marker仍为
   `staging → safety-snapshotted → db-swapped → fs-swapped → db-migrated →
identity-verified → complete`，但每态由 appendix内真实 `.strict()` wire schema、真实 decoded
   schema与逐字段 encoder实现；exact prefix/suffix、operation/options、safety、SQLite ref、
   no-replace/replace、migration、barrier与cleanup全部由 wire/decoded两套完整 refiner检查。
10. cold与pending startup都在任何 DB open前先加载 marker，再以
    `restoreSqlitePublicationLocatorV3(marker.sqlitePublicationRef)`加载 exact SQLite anchor，并用
    `artifactPublicationLocatorFromRefV3(ref)`加载 publication root。wrong namespace、kind、
    receipt id/revision/role/operation/digest或未经 module-private factory构造的 storage key一律
    effect前失败。`assertPublicationRefMatchesV3`消费完整
    prepared/exchanged/cleanup/repair receipt与用途专属`ArtifactPublicationExpectedProjectionV3`；
    `assertRestoreSqlitePublicationRefMatchesV3`另把
    SQLite root revision、full operation与 staged DB identity绑定到 marker ref。
11. artifact与SQLite root都保存 `previousRevision/previousFrameDigest`。loader验真 marker的旧
    anchor后，`latestArtifactPublicationDescendantV3`/
    `latestRestoreSqlitePublicationDescendantV3`只沿相同 root id、revision连续且 previous digest
    精确匹配的 immutable frames前进。gap、fork、旧 frame覆写、foreign root或 lineage digest
    漂移只可进入 repair；合法 inner checkpoint不要求 outer marker同步改写。
12. safety、identity barrier与cleanup不是 role multiset。safety receipt必须是
    `cleanup-verified + no-replace`并逐字段匹配 captured identity/digest；barrier必须匹配 exact
    exchanged mode/staged/expected/published/displaced facts；cleanup ref必须是同 receipt id的
    `cleanup-verified` descendant。同一 receipt id跨 role重复、alternate同 operation receipt及
    prepared receipt冒充 exchanged一律在 effect前拒绝。
13. repair是 lossless terminal transition。artifact receipt以
    `repairFromPhase=prepared|exchanged|cleanup-verified`保存该 prefix全部字段；SQLite forensic以
    `fromPhase=declared|wal-removing|wal-settled|shm-removing|sidecars-settled|db-publishing|
db-published`保存 exact sidecar intent、publication ref与database exchange。
    `assertArtifactPublicationTransitionV3/assertRestoreSqlitePublicationTransitionV3`先验证
    immutable lineage，再比较上一 frame的 canonical forensic projection；已知字段不得变 null、
    替换或丢失，repair之后不得继续隐式 effect。
14. legacy active-pair只要进入 `operator-confirmation-required`或任一 reapply phase，就必须拥有
    canonical `RestoreExecutionOptionsV3 + optionsDigest`。operator request/receipt/control/new
    operation逐字段继承；options unavailable只允许停留在 evidence-only/quarantine/repair路径，
    不能在 restart时补当前默认值。

`noSafetyBackup=true`明确放弃 sidecar bytes rollback，但不放弃记账：staged consolidated DB在
`complete`前保留，sidecar与 DB publication仍按上述 root exact roll-forward；不得虚构 safety
generation。`skipIntegrityCheck`同样持久化并只影响已定义的 integrity gate，不能绕过 archive
seal、identity或publication验证。

appendix直接运行真实 SQLite WAL fixture：incoming committed rows只在 WAL时，私有 consolidation后
行数保持；live DB含 stale WAL/SHM时，按 record-before-act顺序删除 sidecar再发布 consolidated
DB，最终内容精确等于 incoming，且 safety DB/WAL/SHM仍能恢复 live行。另逐态运行 captured/
skipped、present/absent、`noMigrate` true/false与 foreign ref/options/migration/identity负例。

```ts
interface ArtifactRestoreCapabilityV3 {
  readonly __brand: 'ArtifactRestoreCapabilityV3'
  readonly identity: RestoreOperationIdentityV3
  stageIncomingGeneration(
    source: ReadOnlyBackupCapabilityV3,
  ): Promise<RestoreStagedGenerationV3Decoded>
  snapshotLiveGeneration(
    staged: RestoreStagedGenerationV3Decoded,
  ): Promise<RestoreSafetyGenerationV3Decoded>
  declareSqlitePublication(
    staged: RestoreStagedGenerationV3Decoded,
    safety: RestoreSafetyGenerationV3Decoded,
  ): Promise<{
    readonly ref: RestoreSqlitePublicationRefV3
    readonly record: RestoreSqlitePublicationV3Decoded
  }>
  settleSqliteSidecarsAndPublishDb(
    staged: RestoreStagedGenerationV3Decoded,
    safety: RestoreSafetyGenerationV3Decoded,
    ref: RestoreSqlitePublicationRefV3,
  ): Promise<RestoreDatabaseExchangeV3Decoded>
  swapConfigAndSkillsExact(
    staged: RestoreStagedGenerationV3Decoded,
    safety: RestoreSafetyGenerationV3Decoded,
    database: RestoreDatabaseExchangeV3Decoded,
  ): Promise<RestoreFsExchangeV3Decoded>
  migrateOrRecordSkip(
    database: RestoreDatabaseExchangeV3Decoded,
  ): Promise<RestoreDatabaseMigrationV3Decoded>
  verifyIdentityBarrier(
    database: RestoreDatabaseExchangeV3Decoded,
    filesystem: RestoreFsExchangeV3Decoded,
  ): Promise<RestoreIdentityBarrierV3Decoded>
  cleanupExactDisplacedGeneration(
    database: RestoreDatabaseExchangeV3Decoded,
    filesystem: RestoreFsExchangeV3Decoded,
  ): Promise<RestoreGenerationCleanupV3Decoded>
}

interface PendingRestoreReceiptBaseV3 {
  readonly schemaVersion: 3
  readonly origin: 'v3'
  readonly clientMutationId: string
  readonly stageId: string
  readonly revision: number
  readonly archiveDigest: string
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
  readonly archivePublication: ArtifactPublicationReceiptRefV3
  readonly createdAt: string
  readonly settledAt: string
}

type PendingRestoreStageReceiptV3 =
  | (PendingRestoreReceiptBaseV3 & {
      readonly operation: 'stage'
      readonly state: 'staged'
    })
  | (PendingRestoreReceiptBaseV3 & {
      readonly operation: 'cancel'
      readonly state: 'canceled'
    })

interface LegacyAdoptedPendingRestoreStatusV3 {
  readonly schemaVersion: 3
  readonly origin: 'legacy-adopted'
  readonly adoptionId: string
  readonly stageId: string
  readonly revision: number
  readonly archiveDigest: string
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
  readonly requestedAt: string
}

interface PendingRestoreRepairSummaryV3 {
  readonly schemaVersion: 3
  readonly repairId: string
  readonly phase:
    | 'ingress'
    | 'legacy-adoption'
    | 'backup-adoption'
    | 'worktree-reconstruction'
    | 'stage'
    | 'cancel'
    | 'restore'
  readonly code:
    | 'restore-ingress-interrupted'
    | 'legacy-pending-invalid'
    | 'legacy-active-pair-ambiguous'
    | 'legacy-quarantine-invalid'
    | 'legacy-backup-invalid'
    | 'worktree-registration-ambiguous'
    | 'restore-identity-ambiguous'
    | 'restore-publication-incomplete'
  readonly occurredAt: string
  readonly operatorAction: 'run-doctor' | 'inspect-and-confirm-legacy-pending'
}

interface PendingRestoreStatusDtoV3 {
  readonly active: PendingRestoreStageReceiptV3 | LegacyAdoptedPendingRestoreStatusV3 | null
  readonly repairs: readonly PendingRestoreRepairSummaryV3[]
}

type PendingRestoreMutationLookupDtoV3 =
  | { readonly state: 'in-flight'; readonly operation: 'stage' | 'cancel' }
  | { readonly state: 'settled'; readonly receipt: PendingRestoreStageReceiptV3 }
  | { readonly state: 'repair-required'; readonly repair: PendingRestoreRepairSummaryV3 }

interface PendingRestoreControlEnvelopeV3 {
  readonly schemaVersion: 3
  readonly callerScope: string // server-only stable scope；不接受 caller supplied
  readonly requestDigest: string
  readonly receipt: PendingRestoreStageReceiptV3
}

interface StablePendingRestoreCallerScope {
  readonly __brand: 'StablePendingRestoreCallerScope'
  readonly value: string
}

interface PendingRestoreInFlightRecordV3 {
  readonly schemaVersion: 3
  readonly callerScope: string
  readonly clientMutationId: string
  readonly operation: 'stage' | 'cancel'
  readonly metadataDigest: string
  readonly requestDigest: string | null // archive seal后才可固定完整 request
  readonly stageId: string
  readonly revision: number
  readonly phase: 'ingress' | 'staging' | 'canceling' | 'repair-required'
  readonly archiveDigest: string | null
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
  readonly createdAt: string
  readonly archivePublication?: ArtifactPublicationReceiptRefV3
  readonly archiveIdentity?: ArtifactEntryIdentityV3
  readonly markerIdentity?: ArtifactEntryIdentityV3
  readonly ingressIdentity?: ArtifactEntryIdentityV3
}

interface PendingRestoreStageCapabilityV3 {
  readonly __brand: 'PendingRestoreStageCapabilityV3'
  stage(
    source: ReadOnlyBackupCapabilityV3,
    request: {
      callerScope: StablePendingRestoreCallerScope
      clientMutationId: string
      archiveDigest: string // ingress从 sealed source注入；wire不能自报
      options: StrictRestoreOptionsV3
    },
  ): Promise<PendingRestoreStageReceiptV3>
  cancel(input: {
    callerScope: StablePendingRestoreCallerScope
    clientMutationId: string
    expectedStageId: string
    expectedRevision: number
  }): Promise<PendingRestoreStageReceiptV3>
  status(): Promise<PendingRestoreStatusDtoV3>
}

interface PendingRestoreControlLedgerV3 {
  readonly __brand: 'PendingRestoreControlLedgerV3'
  lookup(
    callerScope: StablePendingRestoreCallerScope,
    clientMutationId: string,
  ): Promise<PendingRestoreControlEnvelopeV3 | PendingRestoreInFlightRecordV3 | null>
}
```

HTTP不再把 multipart `File`整体 `arrayBuffer()`后写 `.restore-upload`。same-binary wire固定为：

`RESTORE_ARCHIVE_MAX_BYTES_V3=64 GiB`、`RESTORE_EXPANDED_MAX_BYTES_V3=256 GiB`与
`RESTORE_ENTRY_MAX_V3=1_000_000`是 boot前可用的 released constants，HTTP/CLI/pending/dry-run
同值；不能从尚未 load/可能被恢复的 config读取，也没有 wire override。超限返回 closed
`restore-archive-limit-exceeded`并 exact清 ingress，避免某入口比另一入口更宽。

- `PUT /api/restore/pending/stages/:clientMutationId`：body是
  `application/vnd.agent-workflow.backup+gzip` raw stream；path id与 strict query
  `noMigrate/skipIntegrityCheck/noSafetyBackup`先过 shared schema，`Content-Length`若存在必须在
  上限内，但 chunked request仍由 sink逐 chunk累计 hard cap。route在读取第一块 body前完成 admin
  authorization、server-derived caller scope与 control-ledger lookup。existing terminal不会
  盲返：重复 PUT取得 `RestoreReplayVerifierV3`，流式消费并核对 metadata + byteLength +
  archive digest后才返回旧 receipt；changed body conflict。无需重传 bytes的恢复使用下述 GET
  mutation lookup。absent/incomplete才取得 `RestoreUploadWriterV3`。每次 `writeChunk` await形成
  backpressure，disconnect/超限/parse/digest错误必须调用 broker abort；
  private temp与其 directory exact cleanup前不得接受同 id的新 upload。只有 bytes、file与parent
  都 fsync且 seal identity/digest成功后，`stage()`才可 publish archive/marker。
- `GET /api/restore/pending`：strict返回 `PendingRestoreStatusDtoV3`，不再暴露 failed quarantine
  raw directory。
- `GET /api/restore/pending/mutations/:clientMutationId`：按 authenticated HTTP caller scope只返回
  `PendingRestoreMutationLookupDtoV3`；unknown/foreign同形 404，不投影 request digest、archive
  path或 broker identity。
- `POST /api/restore/pending/cancel`：strict JSON
  `{clientMutationId,expectedStageId,expectedRevision}`；替代无 body
  `DELETE /api/restore/pending`与 `{cleared:boolean}`。
- default plan、`--dry-run`、cold apply与 boot pending apply只接受
  `ReadOnlyBackupCapabilityV3`；它们不接 `File/ArrayBuffer/string path/raw fd`。plan/dry-run统一
  进入 `RestoreInspectionServiceV3.inspect`并返回 strict `RestorePlanDtoV3`，不得调用
  stage service。live CLI received fd、stopped CLI locked fd先由 ingress重验
  `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`、regular/nlink、peer/boot identity、byte cap与 digest，seal后
  才返回同一 capability。

前端 `RestoreControlLocatorV1`是唯一可持久化的 caller状态：

```ts
interface RestoreControlLocatorV1 {
  readonly schemaVersion: 1
  readonly actorUserId: string
  readonly operation: 'stage' | 'cancel'
  readonly clientMutationId: string
  readonly expectedStageId?: string
  readonly expectedRevision?: number
  readonly options?: StrictRestoreOptionsV3
  readonly optionsDigest?: string
  readonly createdAt: string
}
```

Settings在 fetch前写 per-id
`localStorage["aw.restore-locator.v1:<actorUserId>:<clientMutationId>"]`；不同 tab/id不覆盖，storage
event只触发 lookup，不自行认领结果。locator不含 filename、local path、
archive bytes/digest、fd或 repair detail；stage locator可保存 strict三个非敏感 boolean options
及其 shared canonical digest，以便未 seal上传在 reload后重建相同 query。mount/reload先核对 current actor，再查
mutation endpoint；actor不同则忽略且保留，不查询、不显示、不覆盖，server仍独立授权。原 actor
重新登录后继续 reconcile；terminal receipt逐字段 strict parse后只删除 current actor的 exact
locator。显式「清除本机恢复记录」可删除用户选中的 exact key，但确认文案必须说明“服务端操作
不会取消，且清除后无法凭本机 locator找回 response-loss receipt”。in-flight继续 poll，
repair-required显示 typed operator action。stage若在 seal前中断，UI保留同 id/options digest并
要求用户重新选择 archive；server只允许同 metadata，seal时 archive digest不同则 conflict。
cancel在 terminal前始终 replay相同 body。

CLI支持 `--mutation-id <id>`、`--replay <id>`与`--status <id>`。省略 id时，CLI在任何 fd传递/
stage/cancel effect前生成，先通过 broker/local-control把不含 archive path的 locator写入
non-restored 0600 client-locator store并 fsync，再向 stderr打印；terminal后保存 receipt摘要。
stage未 seal时 replay必须带 `--stage <archive> --mutation-id <same-id>`；`--replay/--status`
走无 fd lookup直接返回旧 receipt，而再次执行 `--stage ... --mutation-id <same-id>`仍重验 fd
digest，changed archive conflict。cancel从 active status冻结 expected stage/revision与新 id后才发送。client
locator仅帮助 caller找回 key，server control ledger仍是唯一 replay authority。

default plan与 `--dry-run`不生成或读取该 locator：CLI为每次只读请求生成不持久化的
`requestNonce`。daemon live时使用 local-control `inspect-backup`并委托 archive fd；daemon
stopped时先持 singleton lock，再由同一 ingress + `RestoreInspectionServiceV3`执行。两条路径打印
同一个 `RestorePlanDtoV3` projector；inspect响应丢失只允许重新检查 bytes，不存在要 exact replay
的副作用 receipt。embedded binary的 current migration axis必须直接从 build-bound sealed
`MIGRATION_FILES/meta/_journal.json` mint `CurrentMigrationAxisCapabilityV3`；dev只用 repository
read-only descriptor。inspect严禁调用当前会写
`~/.agent-workflow/runtime/migrations`的 `extractMigrationsTo()`。真正 stage/apply需要 filesystem
migrations时才在相应 durable operation下通过既有 broker authority materialize。

两种 authority都只可由已经持有 singleton lock并完成 verified broker qualification的进程 mint。
cold CLI与 startup调用同一 `executeRestoreGenerationV3`，不能分别保留 path implementation。
startup顺序改为：

1. lock；
2. verified FS broker qualification并打开 app-home root dirfd；
3. 扫描 `ArtifactPublicationLedgerV3`，按 exact slot/staged/expected identity把 syscall歧义
   分类为 prepared/exchanged或 repair-required；保留 displaced entry，等对应 business
   journal/Skill operation/restore marker的 barrier后才 cleanup-verified；
4. 先扫描 `LegacyPendingOperatorLedgerV3`，按 claimed/V3-private-stage/legacy-move
   publication/adoption-hold/V3-marker/quarantine exact identities恢复 in-flight operator
   handoff，无法唯一判定即 repair-required；
   再扫描 canonical legacy pending/failed quarantine并运行
   `LegacyPendingRestoreAdoptionV3`。按 active-pair/marker-only/archive-only/empty-active/
   failed-quarantine
   evidence exact收敛。active-pair先 durable记录
   `operator-confirmation-required`并以 `legacy-active-pair-ambiguous`在 DB open前停止自动 boot；
   只有 stopped CLI对 exact adoption id/evidence digest显式 reapply或 quarantine后才继续。
   marker-only只记 consumed并 cleanup，archive-only只 quarantine，empty-active只在 exact empty
   directory下 cleanup；failed/invalid/ambiguous形成 typed repair，不按 `stagedTarball`或旧目录名
   行动；
5. 扫描 `PendingRestoreControlLedgerV3`，用 exact publication/archive/marker identities收敛
   interrupted stage/cancel；同时扫描 `WorktreeReconstructionLedgerV3`并登记未收口 operation，
   但在 restored DB可用前不执行 Git动作；repair-required时拒绝控制面与restore，不从空 marker
   猜 terminal；
6. 扫描 `ArtifactWriterObligationLedgerV3`，使所有 released writer quiesced；任何 live/ambiguous
   obligation拒绝 restore/boot；
7. strict parse V3或 `legacy-adopted` pending marker/archive，通过 ingress mint
   `ReadOnlyBackupCapabilityV3`与 restore capability；
8. apply/resume restore generation；
9. load config、open/migrate DB、运行 Skill identity barrier；
10. 把 non-restored publication receipts/writer obligations/worktree reconstruction receipts与
    restored DB、Skill/Plugin generation refs及 ordered `task_repos[]`合并并完成
    publication/Intent artifact/worktree recovery barrier；worktree按 task/container reservation
    与每 repo registration/target/branch before-after ledger exact resume/compensate；
11. HTTP/GC/workers。

daemon运行时的 staging不启动第二个 broker。HTTP admin route在 daemon内直接消费
`PendingRestoreStageCapabilityV3`；CLI发现 live lock后连接独立 local admin control socket：

- socket位于 daemon-owned 0700 runtime dir，mode 0600；Linux用 `SO_PEERCRED`、Darwin用
  `getpeereid`要求 peer UID等于 daemon UID，并以 lock file中的 boot nonce完成 strict
  challenge/response。它是本机 break-glass控制面，不替代 HTTP的应用 admin permission；
- CLI以 `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`打开用户明确选择的 archive，先 fstat/digest，再通过
  `SCM_RIGHTS`传 fd、digest与 strict discriminated frame；daemon重做 digest/validation。
  `inspect-backup | stage`必须且只能各携一个 archive fd，`lookup | cancel`必须携零 fd；多余、
  缺失、错误 role的 fd在任何 ingress/control-ledger写前拒绝并关闭。control socket不接收 caller
  path，绝不返回/转发 broker root/child dirfd；
- `inspect-backup`只把 delegated fd seal成 operation-scoped
  `ReadOnlyBackupCapabilityV3`，交 `RestoreInspectionServiceV3`产出
  `RestorePlanDtoV3`；响应前关闭原 fd、释放 capability并 exact删除 private ingress。它不创建
  `PendingRestoreControlLedgerV3` row、caller locator、publication、pending marker或 restore
  generation；peer UID、boot nonce、fd identity/digest、frame或 archive验证失败同样零持久写；
- daemon service用 exact `stageId/revision/clientMutationId` claim；archive先经
  `ReadOnlyBackupCapabilityV3`复制/验收到 immutable staged entry，fsync payload与目录后最后原子
  发布 marker。并发 stage返回409，replace必须 exact cancel；status/cancel同样返回 typed receipt，
  response loss只按同一 id replay；
- daemon stopped时 CLI先取得 singleton lock，启动同一 verified broker并 mint stage capability；
  plan/dry-run则 mint同一 inspection service。daemon stop/start竞态只允许“持锁 cold
  inspect/stage”或“peer-auth live delegation”二者之一成功，不能回退裸读/裸写
  `.restore-upload/.restore-pending`或 caller path。

`PendingRestoreControlLedgerV3`与 writer/publication ledgers一样位于 broker-owned、
non-restored control root，不进入 backup，也不随 DB/config/Skill restore回滚。只有 broker实现
可以写；public interface仅允许 strict lookup。ledger使用 versioned strict codec、append +
checkpoint fsync与单调 revision，key为 server-derived
`(callerScope,clientMutationId)`：HTTP scope是 authenticated user id，local control scope是
peer UID + 固定 local-admin domain；wire中的 caller string永不成为 scope。canonical
ingress `metadataDigest`先覆盖 operation/content-length/options；archive seal后才把 exact
archive digest并入 immutable `requestDigest`。cancel requestDigest覆盖 expected stage/revision。
二者都不含 path、fd或 secret。HTTP/local-control projector只返回 strict
`PendingRestoreStageReceiptV3`，不投影
`callerScope/requestDigest`。

stage/cancel固定按以下顺序执行：

1. 在读取 active marker/freshness前 lookup ledger。existing terminal且 request digest完全相同，
   直接返回逐字段相同 receipt；operation/body/caller mismatch fail closed。
2. absent HTTP stage先验证“没有 active stage”，fsync `ingress` metadata record；stream seal后
   原子推进带 archive digest/full requestDigest的 `staging` record，再验收/publish archive，最后
   fsync terminal `staged` receipt；absent cancel才验证 exact active stage id/revision。
3. cancel在任何删除前 fsync
   `canceling {stageId,revision,archivePublication,archiveIdentity,markerIdentity}`；随后只用
   `removeEntryExact`删除该 archive与marker。两项 effect都 proven absent后，fsync terminal
   `canceled` receipt。它是非 restore 业务 receipt，不因 marker消失而消失。
4. broker startup在开放 HTTP/local control前扫描 in-flight record与 publication ledger，用记录
   的 exact identities区分 before/after并完成或进入 repair-required；不按 filename、mtime或
   “status为 null”猜测。后来 stage的 identity mismatch绝不删除。
5. `status()`只投影当前 active staged receipt；exact replay永远查 control ledger。因此同一个
   cancel在 status为 null、response loss或restart后仍返回原 receipt；另一个 id只得到 typed
   inactive/conflict。v1低频 control ledger不做 GC且由 broker owner无限期保留；未来 compaction
   必须有另一个可证明不破坏 replay的 protocol migration，不能偷偷按 TTL清理。

升级前 released binary实际留下的是
`.restore-pending/restore-pending.json + staged.tar.gz`，也可能在 copy完成、marker写入前只留下
archive，在 apply成功删除 archive、清目录前只留下 marker，或把整个目录 rename为
`.restore-pending.failed-<ts>`后在 `error.txt`写入前崩溃。这些状态没有 caller id、request
digest、publication receipt或 V3 phase，不能因新 control ledger为空而忽略，也不能补造 normal
stage/apply receipt。verified broker实现独立：

```ts
interface LegacyPendingRestoreMarkerV1 {
  readonly stagedTarball: string // 历史数据；strict parse但永不作为 path authority
  readonly noSafetyBackup?: boolean
  readonly noMigrate?: boolean
  readonly skipIntegrityCheck?: boolean
  readonly requestedAt: number
}

type LegacyPendingEvidenceV3 =
  | {
      // 只陈述 marker+archive 同时存在；released bytes无法证明 apply 是否已开始。
      readonly kind: 'active-pair'
      readonly activeDirectoryIdentity: ArtifactEntryIdentityV3
      readonly markerIdentity: ArtifactEntryIdentityV3
      readonly archiveIdentity: ArtifactEntryIdentityV3
    }
  | {
      readonly kind: 'marker-only'
      readonly activeDirectoryIdentity: ArtifactEntryIdentityV3
      readonly markerIdentity: ArtifactEntryIdentityV3
    }
  | {
      readonly kind: 'archive-only'
      readonly activeDirectoryIdentity: ArtifactEntryIdentityV3
      readonly archiveIdentity: ArtifactEntryIdentityV3
    }
  | {
      readonly kind: 'empty-active'
      readonly activeDirectoryIdentity: ArtifactEntryIdentityV3
    }
  | {
      readonly kind: 'failed-quarantine'
      readonly quarantineIdentity: ArtifactEntryIdentityV3
      readonly markerIdentity?: ArtifactEntryIdentityV3
      readonly archiveIdentity?: ArtifactEntryIdentityV3
      readonly errorIdentity?: ArtifactEntryIdentityV3
    }

interface LegacyPendingRestoreAdoptionBaseV3 {
  readonly schemaVersion: 3
  readonly adoptionId: string
  readonly provenance: 'legacy-unverifiable'
  readonly evidence: LegacyPendingEvidenceV3
  readonly archiveDigest: string | null
  readonly v3ArchivePublication?: ArtifactPublicationReceiptRefV3
  readonly v3MarkerIdentity?: ArtifactEntryIdentityV3
  readonly quarantineIdentity?: ArtifactEntryIdentityV3
  readonly operatorReceipt?: LegacyPendingOperatorReceiptV3
}

type LegacyPendingOptionsAuthorityV3 =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'bound'
      readonly options: RestoreExecutionOptionsV3
      readonly optionsDigest: string
    }

type LegacyPendingRestoreAdoptionRecordV3 =
  | (LegacyPendingRestoreAdoptionBaseV3 & {
      // Pre-authority evidence paths may not have a trusted marker.
      readonly phase: 'discovered' | 'classified' | 'orphan-quarantined' | 'failure-recorded'
      readonly optionsAuthority: LegacyPendingOptionsAuthorityV3
    })
  | (LegacyPendingRestoreAdoptionBaseV3 & {
      // Every phase that can authorize or continue reapply requires the exact
      // options inspected by the operator; nullable/defaulted options are illegal.
      readonly phase:
        | 'operator-confirmation-required'
        | 'reapply-authorized'
        | 'validated'
        | 'archive-published'
        | 'legacy-held'
        | 'marker-written'
        | 'legacy-cleaning'
        | 'adopted'
        | 'consumed-cleaned'
      readonly optionsAuthority: Extract<
        LegacyPendingOptionsAuthorityV3,
        { readonly kind: 'bound' }
      >
    })
  | (LegacyPendingRestoreAdoptionBaseV3 & {
      readonly phase: 'repair-required'
      // Repair retains the last immutable authority exactly; unavailable stays
      // unavailable, bound stays fully bound.
      readonly optionsAuthority: LegacyPendingOptionsAuthorityV3
      readonly repairId: string
    })

interface LegacyPendingOperatorRequestBaseV3 {
  readonly schemaVersion: 3
  readonly clientMutationId: string
  readonly adoptionId: string
  readonly evidenceDigest: string
}

type LegacyPendingOperatorRequestV3 =
  | (LegacyPendingOperatorRequestBaseV3 & {
      readonly action: 'reapply'
      readonly options: RestoreExecutionOptionsV3
      readonly optionsDigest: string
    })
  | (LegacyPendingOperatorRequestBaseV3 & {
      readonly action: 'quarantine'
    })

type LegacyPendingOperatorReceiptV3 =
  | {
      readonly schemaVersion: 3
      readonly clientMutationId: string
      readonly adoptionId: string
      readonly evidenceDigest: string
      readonly action: 'reapply'
      readonly options: RestoreExecutionOptionsV3
      readonly optionsDigest: string
      readonly restoreOperationId: string
      readonly movePublicationId: string
      readonly state: 'reapply-authorized'
    }
  | {
      readonly schemaVersion: 3
      readonly clientMutationId: string
      readonly adoptionId: string
      readonly evidenceDigest: string
      readonly action: 'quarantine'
      readonly movePublicationId: string
      readonly state: 'quarantined'
      readonly quarantineIdentity: ArtifactEntryIdentityV3
    }

interface LegacyPendingMoveTargetSlotV3 {
  readonly __brand: 'LegacyPendingMoveTargetSlotV3'
  readonly slotId: string // opaque；caller不得解释为 path/leaf
  readonly brokerRootIdentity: ArtifactEntryIdentityV3
  readonly filesystemIdentity: string
  readonly role: 'pending-restore-legacy-hold' | 'pending-restore-legacy-quarantine'
}

interface LegacyPendingMoveAbsentProofV3 {
  readonly publicationId: string
  readonly purpose: 'pre-move-target' | 'post-cleanup-target'
  readonly phaseRevision: number
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly targetSlot: LegacyPendingMoveTargetSlotV3
  readonly observationFence: string
  readonly state: 'absent'
}

interface LegacyPendingMoveParentFsyncReceiptV3 {
  readonly publicationId: string
  readonly phaseRevision: number
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly filesystemIdentity: string
  readonly afterObservationFence: string
  readonly syncFence: string
}

interface LegacyPendingMoveIntentV3 {
  readonly publicationId: string
  readonly declaredRevision: number
  readonly adoptionId: string
  readonly action: 'reapply-hold' | 'operator-quarantine'
  readonly sourceIdentity: ArtifactEntryIdentityV3
  readonly sourceParentIdentity: ArtifactEntryIdentityV3
  readonly targetParentIdentity: ArtifactEntryIdentityV3
  readonly targetSlot: LegacyPendingMoveTargetSlotV3
  readonly targetAbsentProof: LegacyPendingMoveAbsentProofV3 & {
    readonly purpose: 'pre-move-target'
  }
}

interface LegacyPendingMoveMovedEvidenceV3 {
  readonly publicationId: string
  readonly movingRevision: number
  readonly movedRevision: number
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly targetObservationFence: string
  readonly sameInodeAsSource: true
  readonly sourceAbsentProof: {
    readonly publicationId: string
    readonly phaseRevision: number
    readonly parentIdentity: ArtifactEntryIdentityV3
    readonly observationFence: string
    readonly state: 'absent'
  }
  readonly sourceParentFsync: LegacyPendingMoveParentFsyncReceiptV3
  readonly targetParentFsync: LegacyPendingMoveParentFsyncReceiptV3
}

interface LegacyPendingMoveCleanupEvidenceV3 {
  readonly publicationId: string
  readonly cleaningRevision: number
  readonly removedIdentity: ArtifactEntryIdentityV3
  readonly sourceAbsentProof: {
    readonly publicationId: string
    readonly phaseRevision: number
    readonly parentIdentity: ArtifactEntryIdentityV3
    readonly observationFence: string
    readonly state: 'absent'
  }
  readonly targetAbsentProof: LegacyPendingMoveAbsentProofV3 & {
    readonly purpose: 'post-cleanup-target'
  }
  readonly targetParentFsync: LegacyPendingMoveParentFsyncReceiptV3
}

type LegacyPendingMovePublicationV3 =
  | {
      readonly phase: 'declared'
      readonly intent: LegacyPendingMoveIntentV3
      readonly moved: null
    }
  | {
      readonly phase: 'moving'
      readonly intent: LegacyPendingMoveIntentV3
      readonly moved: null
      readonly movingRevision: number
    }
  | {
      readonly phase: 'moved'
      readonly intent: LegacyPendingMoveIntentV3
      readonly moved: LegacyPendingMoveMovedEvidenceV3
    }
  | {
      readonly phase: 'cleaning'
      readonly intent: LegacyPendingMoveIntentV3 & { readonly action: 'reapply-hold' }
      readonly moved: LegacyPendingMoveMovedEvidenceV3
      readonly cleaningRevision: number
    }
  | {
      readonly phase: 'cleaned'
      readonly intent: LegacyPendingMoveIntentV3 & { readonly action: 'reapply-hold' }
      readonly moved: LegacyPendingMoveMovedEvidenceV3
      readonly cleaningRevision: number
      readonly cleanup: LegacyPendingMoveCleanupEvidenceV3
    }
  | {
      readonly phase: 'repair-required'
      readonly intent: LegacyPendingMoveIntentV3
      readonly moved: LegacyPendingMoveMovedEvidenceV3 | null
      readonly repair: PendingRestoreRepairSummaryV3
    }

interface LegacyPendingMovePublisherV3 {
  readonly __brand: 'LegacyPendingMovePublisherV3'
  declare(
    adoptionId: string,
    action: LegacyPendingMoveIntentV3['action'],
    source: ArtifactTreeDirCapabilityV3,
  ): Promise<Extract<LegacyPendingMovePublicationV3, { phase: 'declared' }>>
  moveNoReplace(
    publication: Extract<LegacyPendingMovePublicationV3, { phase: 'declared' | 'moving' }>,
  ): Promise<Extract<LegacyPendingMovePublicationV3, { phase: 'moved' }>>
  discover(publication: LegacyPendingMovePublicationV3): Promise<LegacyPendingMovePublicationV3>
  cleanupReapplyHold(
    publication: Extract<LegacyPendingMovePublicationV3, { phase: 'moved' | 'cleaning' }>,
  ): Promise<Extract<LegacyPendingMovePublicationV3, { phase: 'cleaned' }>>
}

const LegacyPendingMovePublicationV3Schema = z
  .discriminatedUnion('phase', [
    LegacyPendingMoveDeclaredV3Schema.strict(),
    LegacyPendingMoveMovingV3Schema.strict(),
    LegacyPendingMoveMovedV3Schema.strict(),
    LegacyPendingMoveCleaningV3Schema.strict(),
    LegacyPendingMoveCleanedV3Schema.strict(),
    LegacyPendingMoveRepairV3Schema.strict(),
  ])
  .superRefine((record, ctx) => {
    // 下列全部是 required equality，不是 producer约定；任一失败 addIssue并拒绝。
    assertMoveIntentCanonical(record.intent, ctx)
    assertActionMatchesTargetRole(record.intent.action, record.intent.targetSlot.role, ctx)
    assertAbsentProofMatchesIntent(record.intent.targetAbsentProof, record.intent, {
      purpose: 'pre-move-target',
      phaseRevision: record.intent.declaredRevision,
      ctx,
    })
    if (record.moved !== null) assertMovedEvidenceCanonical(record.moved, record.intent, ctx)
    if (record.phase === 'cleaned') {
      assertCleanupEvidenceCanonical(
        record.cleanup,
        record.intent,
        record.moved,
        record.cleaningRevision,
        ctx,
      )
    }
  })
```

`assertMoveIntentCanonical`与三个 evidence helper必须使用共享 comparator，rename/moved的
immutable snapshot用 `artifactEntrySnapshotEqual()`，cleanup重验同一 directory object用
`artifactEntrySameObject()`，并逐字段锁住：

- nested `publicationId`全部等于 `intent.publicationId`；phase revisions是 finite safe
  integer且严格 `declared < moving < moved < cleaning`；target slot的
  slotId/brokerRootIdentity/filesystemIdentity/role逐字段等于 intent，pre-move proof的
  parent等于 `targetParentIdentity`；
- `moved.targetIdentity === intent.sourceIdentity`（canonical comparator，不接受
  `sameInodeAsSource:true`自证）；source absent parent等于 source parent。source/target fsync
  receipt分别绑定 publication、对应 parent与该 parent filesystem，且 phase revision等于 moved
  revision；source fsync的 after fence等于 source absence observation，target fsync的 after fence
  等于 exact target-present observation；
- cleaned只允许 reapply hold；`cleanup.removedIdentity === moved.targetIdentity`，
  cleanup source/target proof均绑定同一 publication/cleaning revision，post-cleanup target proof
  purpose固定、parent/slot等于 intent，target parent fsync的
  phase revision等于 cleaning revision且
  `afterObservationFence === cleanup.targetAbsentProof.observationFence`；
- outer operator control每次嵌入 move publication都再次
  `LegacyPendingMovePublicationV3Schema.safeParse`，再比较 control/adoption/receipt/publication
  ids；parse成功前不得 open descriptor或调用 `discover()`。

```ts
interface LegacyPendingOperatorControlCommonV3 {
  readonly schemaVersion: 3
  readonly callerScope: StablePendingRestoreCallerScope
  readonly clientMutationId: string
  readonly requestDigest: string
  readonly adoptionId: string
  readonly evidenceDigest: string
}

interface LegacyPendingOperatorReapplyBaseV3 extends LegacyPendingOperatorControlCommonV3 {
  readonly action: 'reapply'
  readonly options: RestoreExecutionOptionsV3
  readonly optionsDigest: string
}

interface LegacyPendingOperatorQuarantineBaseV3 extends LegacyPendingOperatorControlCommonV3 {
  readonly action: 'quarantine'
}

type LegacyPendingOperatorControlV3 =
  | (LegacyPendingOperatorReapplyBaseV3 & {
      readonly phase: 'claimed'
      readonly restoreOperationId: null
    })
  | (LegacyPendingOperatorQuarantineBaseV3 & {
      readonly phase: 'claimed'
      readonly restoreOperationId: null
    })
  | (LegacyPendingOperatorReapplyBaseV3 & {
      readonly phase: 'v3-staged'
      readonly restoreOperationId: string
      readonly archivePublication: ArtifactPublicationReceiptRefV3
    })
  | (LegacyPendingOperatorReapplyBaseV3 & {
      readonly phase: 'legacy-moving'
      readonly restoreOperationId: string
      readonly archivePublication: ArtifactPublicationReceiptRefV3
      readonly movePublication: Extract<
        LegacyPendingMovePublicationV3,
        { phase: 'declared' | 'moving' }
      >
    })
  | (LegacyPendingOperatorReapplyBaseV3 & {
      readonly phase: 'legacy-held'
      readonly restoreOperationId: string
      readonly archivePublication: ArtifactPublicationReceiptRefV3
      readonly movePublication: Extract<
        LegacyPendingMovePublicationV3,
        { phase: 'moved' | 'cleaning' | 'cleaned' }
      >
    })
  | (LegacyPendingOperatorReapplyBaseV3 & {
      readonly phase: 'v3-marker-published'
      readonly restoreOperationId: string
      readonly archivePublication: ArtifactPublicationReceiptRefV3
      readonly movePublication: Extract<
        LegacyPendingMovePublicationV3,
        { phase: 'moved' | 'cleaning' | 'cleaned' }
      >
      readonly v3MarkerIdentity: ArtifactEntryIdentityV3
    })
  | (LegacyPendingOperatorQuarantineBaseV3 & {
      readonly phase: 'quarantining'
      readonly restoreOperationId: null
      readonly movePublication: Extract<
        LegacyPendingMovePublicationV3,
        { phase: 'declared' | 'moving' | 'moved' }
      >
    })
  | ({
      readonly phase: 'settled'
    } & (
      | (LegacyPendingOperatorReapplyBaseV3 & {
          readonly receipt: Extract<LegacyPendingOperatorReceiptV3, { action: 'reapply' }>
          readonly movePublication: Extract<
            LegacyPendingMovePublicationV3,
            { phase: 'moved' | 'cleaning' | 'cleaned' }
          >
        })
      | (LegacyPendingOperatorQuarantineBaseV3 & {
          readonly receipt: Extract<LegacyPendingOperatorReceiptV3, { action: 'quarantine' }>
          readonly movePublication: Extract<LegacyPendingMovePublicationV3, { phase: 'moved' }>
        })
    ))
  | ({
      readonly phase: 'repair-required'
      readonly repair: PendingRestoreRepairSummaryV3
    } & (LegacyPendingOperatorReapplyBaseV3 | LegacyPendingOperatorQuarantineBaseV3))
```

`LegacyPendingOperatorControlV3Schema`不是类型别名：

```ts
const LegacyPendingOperatorControlV3Schema = z
  .discriminatedUnion('phase', [
    LegacyOperatorClaimedV3Schema.strict(),
    LegacyOperatorV3StagedV3Schema.strict(),
    LegacyOperatorMovingV3Schema.strict(),
    LegacyOperatorHeldV3Schema.strict(),
    LegacyOperatorMarkerPublishedV3Schema.strict(),
    LegacyOperatorQuarantiningV3Schema.strict(),
    LegacyOperatorSettledV3Schema.strict(),
    LegacyOperatorRepairV3Schema.strict(),
  ])
  .superRefine(assertLegacyOperatorControlCanonical)
```

`assertLegacyOperatorControlCanonical`必须先对每个 nested move publication调用
`LegacyPendingMovePublicationV3Schema.safeParse`，再锁住：request action与 move intent
action/target role一一对应；control/adoption/receipt/move publication id逐字段相同；reapply receipt的
`restoreOperationId`与 control一致；reapply request、adoption bound authority、control及
receipt的 `options/optionsDigest`逐字段相同，digest必须由 canonical options重算；repair保留进入
repair前相同 authority。quarantine receipt的 `quarantineIdentity`与 moved
`targetIdentity`一致；`settled`不得引用 declared/moving/repair publication；cleaning/cleaned只允许
reapply hold。任何 mismatch都在 filesystem discovery前 fail closed，consumer不得 cast。
这里的 `settled`只表示 operator decision mutation已有可重放 public receipt，不表示 V3 restore或
hold cleanup完成；后两者可在 receipt保持逐字段不变时把同一 move publication从 moved推进到
cleaning/cleaned。

```ts
interface LegacyPendingOperatorLedgerV3 {
  readonly __brand: 'LegacyPendingOperatorLedgerV3'
  lookup(
    callerScope: StablePendingRestoreCallerScope,
    clientMutationId: string,
  ): Promise<LegacyPendingOperatorControlV3 | null>
  claimExact(
    callerScope: StablePendingRestoreCallerScope,
    request: LegacyPendingOperatorRequestV3,
  ): Promise<LegacyPendingOperatorControlV3>
  checkpoint(record: LegacyPendingOperatorControlV3): Promise<void>
}

interface LegacyPendingRestoreAdoptionV3 {
  readonly __brand: 'LegacyPendingRestoreAdoptionV3'
  readonly movePublisher: LegacyPendingMovePublisherV3
  adoptCanonicalLegacyState(): Promise<{
    readonly active: LegacyAdoptedPendingRestoreStatusV3 | null
    readonly observations: readonly LegacyPendingRestoreAdoptionRecordV3[]
    readonly repairs: readonly PendingRestoreRepairSummaryV3[]
  }>
  inspectActivePair(adoptionId: string): Promise<RestorePlanDtoV3>
  decideActivePair(request: LegacyPendingOperatorRequestV3): Promise<LegacyPendingOperatorReceiptV3>
}
```

adoption只在 singleton lock + broker qualification下运行，并固定：

1. 只在 canonical app-home root dirfd下枚举 exact `.restore-pending`与单 segment
   `.restore-pending.failed-<finite-decimal>`目录；active目录内只承认
   `restore-pending.json`与固定 `staged.tar.gz`。marker按
   `LegacyPendingRestoreMarkerV1` strict parse：`stagedTarball`必须是非空 string但永不参与
   join/open/display，三个 optional字段只能为 boolean且缺省 false，`requestedAt`必须为 finite、
   non-negative safe integer。三个 option立即补全为 canonical
   `RestoreExecutionOptionsV3`并连 options digest持久化到 adoption/operator/V3 handoff；不能只存
   digest后在重启时猜 boolean。archive必须 regular、`nlink===1`、无 symlink/hardlink/mount
   ambiguity。
2. scanner在任何 rename/remove/publish前生成上述 physical evidence；active三种 entry组合之外，
   mkdir后copy前的空目录显式为 `empty-active`。record保存 directory与该分支实际存在的 child
   identities。`adoptionId = H(canonical legacy slot, evidence.kind, sorted present identities)`，
   不依赖 path字符串、mtime、error文本或缺失 entry；exclusive fsync
   `discovered → classified`后才允许下一 effect。restart先核对 evidence identity，不重复认领
   replacement。
3. `active-pair`分支即使 archive/marker均 strict valid，也只证明两项 bytes共存。released
   restore在 DB swap、config、skills、migration、worktree任一 post-swap失败后，可能进入 catch但
   在 quarantine rename前被杀；该状态与从未 apply的合法 pending物理同形。因此 scanner先验证
   exact identities并计算 archive/options/evidence digest，fsync
   `operator-confirmation-required`，返回
   `legacy-active-pair-ambiguous + inspect-and-confirm-legacy-pending`，并在 DB open、migration、
   restore、HTTP/workers前停止。它不得自动写 V3 marker、publication或
   `LegacyAdoptedPendingRestoreStatusV3`。
4. stopped CLI取得 singleton lock后，可按 exact adoption id读取只读
   `RestorePlanDtoV3`；真正处理必须提交 strict
   `LegacyPendingOperatorRequestV3`。route/service先从 OS peer派生 stable caller scope，再按
   `(callerScope,clientMutationId)` lookup/`claimExact` non-restored
   `LegacyPendingOperatorLedgerV3`；exact existing沿原 phase/receipt resume，request digest/action/
   adoption/evidence mismatch在任何 freshness/effect前 conflict。reapply request还必须逐字段携
   adoption在 inspect时固定的 `options/optionsDigest`；missing、current defaults、任一 boolean
   改变或 digest不符都在 archive open前 conflict。新 request先连同该 authority fsync `claimed`，
   后续 `v3-staged/legacy-moving/legacy-held/v3-marker-published/settled/repair-required`均原样
   继承，不得转回 nullable。
   `reapply`重新核对 directory/marker/archive identity与 digest，
   先打开 exact archive fd并 mint `ReadOnlyBackupCapabilityV3`，复制/seal到与 legacy canonical
   slot不冲突的 V3 broker-private stage并 checkpoint `v3-staged`；随后先声明
   `LegacyPendingMovePublicationV3`，把 action/source identity、exact source/target parent、
   opaque adoption-hold slot与 target-absent proof fsync为 `declared`，再在 syscall前 fsync
   `moving`。exact legacy active directory no-replace rename与双 parent fsync完成后，只有
   same-inode target/source-absent evidence写成 `moved`并随 control checkpoint `legacy-held`，
   才发布 V3 canonical marker并 checkpoint `v3-marker-published`，然后完整走 generation
   protocol。hold在 V3 terminal/cleanup-verified前不得删；之后先写 `cleaning` revision，使用
   moved target capability执行 exact remove，再重新观察 source/target absent、fsync target
   parent并写带 post-cleanup purpose的 cleanup evidence，最后写 `cleaned`。这样 old
   `.restore-pending`不会与新 marker争用同一 slot，任一 handoff crash都由 operator/adoption/V3
   三份 exact receipt判 before/after。
   `quarantine`同样在 `quarantining`前建立 declared/moving move publication，只把 target role
   换成 `pending-restore-legacy-quarantine`；moved target保留并进入 public terminal receipt。
   restart按 phase使用下表，不能把 rename与cleanup共用一条 truth table：

   | Durable phase      | source-only | exact target-only             | exact neither                                        | both/replacement |
   | ------------------ | ----------- | ----------------------------- | ---------------------------------------------------- | ---------------- |
   | `declared`         | 继续 moving | repair                        | repair                                               | repair           |
   | `moving`           | 重试 rename | same-inode后补 moved          | repair                                               | repair           |
   | `moved`            | repair      | 保持 moved                    | repair                                               | repair           |
   | `cleaning`         | repair      | exact重试 remove              | post-cleanup observation + parent re-fsync后 cleaned | repair           |
   | `cleaned`          | repair      | repair                        | 复验 cleanup evidence后保持 cleaned                  | repair           |
   | quarantine `moved` | repair      | 保留并返回 quarantine receipt | repair                                               | repair           |

   `cleaning + neither`只能在 source仍 absent、moved identity与 durable cleaning revision匹配、
   post-cleanup target proof不能复用 pre-move proof、target parent re-fsync后 roll forward。
   public terminal receipt写入 `settled`后才返回；response loss/restart返回逐字段相同 receipt，
   绝不从 adoption id推导 target path。不存在原 legacy caller exact replay。

   产品入口固定为
   `restore --legacy-status`（列 typed adoption id/code）、
   `restore --legacy-inspect <adoptionId>`、
   `restore --legacy-reapply <adoptionId> --mutation-id <id> --yes`与
   `restore --legacy-quarantine <adoptionId> --mutation-id <id> --yes`。startup fail-closed输出
   adoption id与 status/inspect提示，但不输出 marker/archive path或 raw error。所有命令都只在
   daemon stopped + singleton lock + broker qualification下可用；status/inspect零 mutation，
   reapply/quarantine从 OS peer派生 stable caller scope，不接受 caller-supplied scope。

5. `marker-only`必须是 strict valid marker，且 canonical archive确实 absent；这与 released
   apply顺序“成功后先删 archive，再清 marker/dir”一致。先 fsync
   `consumed-without-caller-receipt`语义的 `legacy-cleaning` record，再 exact删除 marker与仍为空
   的目录并 terminal `consumed-cleaned`。它不得重新 apply、不得产生
   `LegacyAdoptedPendingRestoreStatusV3`，也不得声称 restore成功；只是保持 released boot的
   idempotent consumed语义。目录含未知 entry、marker malformed或 identity变化则 repair。
6. `archive-only`来自 released stage的 copy-before-marker窗口，未被 marker-last arm。先 durable
   `classified`，再以 closed capability把 exact active目录 no-replace rename到 broker命名的
   repair quarantine，fsync parent并记录 resulting identity，terminal `orphan-quarantined`；
   永不 apply或合成 options/caller receipt。rename前/后崩溃按 directory/archive identity exact
   收敛；active目录含其它 entry则不猜 ownership，进入 repair-required。
7. `empty-active`来自 mkdir-before-copy窗口；它不含任何 restore authorization或 archive bytes。
   先 durable `classified`，再只在 directory identity仍匹配且确认为空时 exact remove + parent
   fsync，terminal `consumed-cleaned`；replacement或新增 entry转 repair，绝不把“空”解释成
   staged/canceled receipt。
8. `failed-quarantine`同时接受 rename完成但 `error.txt`尚不存在、error写入完成、以及 marker/
   archive已部分存在的 released形态；error bytes只可作为受限 operator diagnostic，不进入
   fingerprint、authority或 Settings DTO。legacy没有可靠 post-swap phase，因此除非独立的 V3
   generation/publication evidence能证明 live generation未动，否则一律先 fsync
   `failure-recorded` + typed repair并在 DB open前 fail closed；doctor完成 generation证明后才可
   显式放行/清理。
9. quarantine rename前/后、error write前/后、旧 cleanup各 effect都有 before/after identity与
   parent fsync。malformed、unknown extra、identity-replaced或 generation ambiguous状态不触碰
   live DB/config/skills，只投影 closed `PendingRestoreRepairSummaryV3`；Settings永不返回 raw
   dir/path/error。不得从空 legacy目录猜 adopted/consumed，也不得把 adoption record投影成
   `PendingRestoreStageReceiptV3`。

restore marker与 SQLite publication是 §0.5.1.1a registry中的两个独立 root：
`restore-generation-marker`保存业务代际，`restore-sqlite-publication`保存 DB/WAL/SHM逐
syscall收敛。两者都由 V3 broker exclusive+fsync持久，不是 capability快照、普通 JSON或 DB
row。marker phase固定
`staging → safety-snapshotted → db-swapped → fs-swapped → db-migrated →
identity-verified → complete`；每次 CAS revision只能调用
`encodeRestoreGenerationMarkerV3()`并由 canonical root writer落盘。marker位于不进
backup/restore的 broker control root，cold CLI与 pending startup在打开 live DB/config/skills前，
都必须以 root-specific locator调用唯一 raw loader；kind/digest/canonical/schema/cross-field任一
不成立即阻断启动并投影 typed repair，不得 cast/rebrand、忽略或从 live path猜 phase。

`staging`只在 incoming DB/WAL/SHM已在 private root consolidation为 self-contained DB、config
disposition与skills generation均 seal且 exact identity可持久化后写；此前的 broker-private orphan
没有 live effect，可按 declaration清理。live DB/WAL/SHM/config/Skills先形成 exact
present/absent observation；captured safety逐项复制并fsync，或在 option明确时写诚实
skipped-by-operator。随后先写 SQLite publication declared root，再写含其 ref的
`safety-snapshotted` marker；两者 durable前禁止 unlink/exchange。SQLite root逐 WAL/SHM
removing→removed+parent-fsync收口，全部 settled后才 DB no-replace/replace并写 db-published；
marker核验该 root与 publication receipt后才写 `db-swapped`。后续每态同理。启动时 phase与 live
observation按 exact marker/root收敛：
`staging|safety-snapshotted`只能继续已声明 sidecar/DB publication或清 exact staged generation；
`db-swapped`必须先验证 published/displaced DB与 publication ref再恢复 config/skills；
`fs-swapped|db-migrated|identity-verified`按记录继续下一 barrier或 exact displaced cleanup；
`complete`只接受 final generation与 cleanup observation仍一致。任何 before/after同时存在、
同时缺失、foreign replacement或 publication ref漂移只 repair，不能回滚/前滚猜测。

incoming skills先在 app-home同 filesystem sibling generation中用
`ArtifactTreeWriterV3`完整 materialize、逐层 fsync、seal并核对 digest；empty skills也是一个真实
sealed empty generation，绝不解释为“保留 live tree”。incoming config必须是一个满足 size上限、
digest、`mode=regular`且无 hardlink/symlink的 file entry：`kind:'replace'`时只走
`createTemp/writeTemp/sealTemp('restore-config-file')`，live config absent用
`commitFileNoReplace`，present则先 `openEntry(expected)`再 `commitFileReplace`；
`kind:'preserve'`完全不触碰 live config。
config不能交给 `ArtifactTreeWriterV3`，也没有 `config/`目录 layout migration。Skill root live
absent用 `commitTreeNoReplace`，present才用 `commitTreeReplace`；DB也同样由 live presence决定
no-replace/replace。file/tree publication的 `{published,displaced?}`及 receipt ref分别写入 marker；
只有 replace产生 displaced并要求 removed cleanup，no-replace只能 not-applicable。marker只保存
durable identity/digest/publication projection，`ArtifactEntryCapabilityV3`、sealed writer、fd、
dirfd、path、secret与任何 runtime capability都不允许进入 codec。

archive本身也不由 system `tar`直接向 live/staging path解包。`ReadOnlyBackupCapabilityV3`先从用户
明确选择/strict pending marker打开 exact archive fd并核对 digest；streaming extractor只接受
validated relative regular-file/directory entries，拒绝 absolute/`..`、symlink、hardlink、device、
FIFO、duplicate、case-fold collision及 size/count上限，再通过 `ArtifactTreeWriterV3`写 staging。
若保留外部 tar做压缩/解压，它只能在一个无 app-home/root dirfd、只挂载 capability-owned staging
的 sandbox内运行，输出仍由 broker逐 entry验收后才能成为
`RestoreStagedGenerationV3Decoded`。backup创建也
不能复用 restore authority；其完整 authority如下。

##### 0.5.1.4 Backup export 与 retention authority

manual、scheduled、auto、pre-migration、pre-restore和 corrupt-DB backup都必须有可 mint 的
闭集 operation，
不能只在 source guard中写“禁止 raw path”：

```ts
interface ArtifactReadOnlyFileCapabilityV3 {
  readonly __brand: 'ArtifactReadOnlyFileCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
  readonly digest: string
}

interface ArtifactReadOnlyTreeCapabilityV3 {
  readonly __brand: 'ArtifactReadOnlyTreeCapabilityV3'
  readonly identity: ArtifactEntryIdentityV3
  readonly treeDigest: string
}

type BackupCopyFileRoleV3 = 'config' | 'database' | 'database-wal' | 'database-shm'
type BackupLogicalTreeNameV3 = 'skills' | 'worktrees'

interface ValidatedBackupWorkflowIdV3 {
  readonly __brand: 'ValidatedBackupWorkflowIdV3'
  readonly value: string
}

type BackupGeneratedFileTargetV3 =
  | { kind: 'workflow-yaml'; workflowId: ValidatedBackupWorkflowIdV3 }
  | { kind: 'manifest' }
type BackupFileTargetV3 =
  | { kind: 'copied'; role: BackupCopyFileRoleV3 }
  | BackupGeneratedFileTargetV3

interface ArtifactBackupTreeWriterV3 {
  readonly __brand: 'ArtifactBackupTreeWriterV3'
  readonly operationId: string
}

interface ArtifactBackupFileSinkV3 {
  readonly __brand: 'ArtifactBackupFileSinkV3'
  write(bytes: Uint8Array): Promise<void>
  seal(expectedDigest: string): Promise<ArtifactBackupFileReceiptV3>
}

interface ArtifactBackupFileReceiptV3 {
  readonly target: BackupFileTargetV3
  readonly digest: string
  readonly byteLength: number
}

interface ArtifactBackupTreeReceiptV3 {
  readonly logicalName: BackupLogicalTreeNameV3
  readonly treeDigest: string
  readonly fileCount: number
  readonly byteLength: number
}

interface ValidatedRepoIndexV3 {
  readonly __brand: 'ValidatedRepoIndexV3'
  readonly value: number
}

interface ArtifactBackupWorktreeRepoSourceV3 {
  readonly __brand: 'ArtifactBackupWorktreeRepoSourceV3'
  readonly repoIndex: ValidatedRepoIndexV3
  readonly worktreeDirName: ValidatedPathSegment | null
  readonly sourceIdentity: ArtifactEntryIdentityV3
  readonly sourceFence: string
}

interface ArtifactBackupWorktreeTaskSourceV3 {
  readonly __brand: 'ArtifactBackupWorktreeTaskSourceV3'
  readonly taskId: ValidatedPathSegment
  readonly taskSnapshotFence: string
  readonly repos: readonly ArtifactBackupWorktreeRepoSourceV3[]
}

type StrictBackupSkipReasonV3 =
  | 'repo-set-invalid'
  | 'source-missing'
  | 'source-changed'
  | 'unsafe-entry'
  | 'over-cap'
  | 'pack-failed'

type StrictWorktreeReconstructionSkipReasonV3 =
  | 'task-terminal'
  | 'task-repo-set-changed'
  | 'legacy-multi-repo-incomplete'
  | 'source-repo-missing'
  | 'registration-adapter-unavailable'
  | 'reservation-publication-unavailable'
  | 'target-present'
  | 'registration-ambiguous'
  | 'captured-tree-invalid'

interface ArtifactBackupWorktreeReceiptV3 {
  readonly taskId: ValidatedPathSegment
  readonly layoutVersion: 2
  readonly taskSnapshotFence: string
  readonly repoTreeDigests: readonly {
    repoIndex: ValidatedRepoIndexV3
    treeDigest: string
    byteLength: number
  }[]
  readonly byteLength: number
}

interface CapturedWorktreeTaskCapabilityV3 {
  readonly __brand: 'CapturedWorktreeTaskCapabilityV3'
  readonly taskId: ValidatedPathSegment
  readonly layoutVersion: 1 | 2
  readonly taskSnapshotFence: string | null
  readonly repos: readonly {
    repoIndex: ValidatedRepoIndexV3
    tree: ArtifactReadOnlyTreeCapabilityV3
    treeDigest: string
  }[]
}

interface WorktreesRootSlotCapabilityV3 {
  readonly __brand: 'WorktreesRootSlotCapabilityV3'
  readonly slot: 'canonical-worktrees-root'
  readonly appHome: ArtifactDirCapabilityV3
  readonly appHomeIdentity: ArtifactEntryIdentityV3
}

interface WorktreeTaskContainerDescriptorV3 {
  readonly layout: 'single' | 'multi'
  readonly taskId: ValidatedPathSegment
  readonly namespaceSegment: ValidatedPathSegment
  readonly taskContainerSegment: ValidatedPathSegment
  readonly descriptorFence: string
}

interface WorktreeRepoTargetDescriptorV3 {
  readonly repoIndex: ValidatedRepoIndexV3
  readonly worktreeDirName: ValidatedPathSegment | null
  readonly repoAdminIdentity: ArtifactEntryIdentityV3
  readonly repoFence: string
  readonly targetKind: 'task-container-target' | 'child-of-task-container'
  readonly targetLeafName: ValidatedPathSegment
  readonly branchFence: string
  readonly baseCommitFence: string | null
}

type WorktreeDirectorySlotRoleV3 =
  | 'worktrees-root'
  | 'layout-namespace'
  | 'task-container'
  | 'repo-target'

interface BrokerPrivateDirectorySlotV3 {
  readonly __brand: 'BrokerPrivateDirectorySlotV3'
  readonly slotId: string // opaque；不是 path/leaf，caller与Git child不可解释
  readonly brokerRootIdentity: ArtifactEntryIdentityV3
  readonly filesystemIdentity: string
}

interface WorktreeDirectoryPublicationIntentV3 {
  readonly publicationId: string
  readonly reconstructionId: string
  readonly role: WorktreeDirectorySlotRoleV3
  readonly descriptorFence: string
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly canonicalLeaf: ValidatedPathSegment
  readonly privateSlot: BrokerPrivateDirectorySlotV3
}

interface WorktreeDirectoryAbsentObservationV3 {
  readonly publicationId: string
  readonly descriptorFence: string
  readonly canonical: {
    readonly parentIdentity: ArtifactEntryIdentityV3
    readonly leaf: ValidatedPathSegment
    readonly state: 'absent'
  }
  readonly private: {
    readonly slot: BrokerPrivateDirectorySlotV3
    readonly state: 'absent'
  }
  readonly parentProofFence: string
}

type WorktreeDirectoryReservationPublicationV3 =
  | {
      readonly phase: 'declared'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: null
      readonly canonicalIdentity: null
    }
  | {
      readonly phase: 'private-prepared'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3
      readonly canonicalIdentity: null
    }
  | {
      readonly phase: 'publishing'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3
      readonly canonicalIdentity: null
    }
  | {
      readonly phase: 'published'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3
      readonly canonicalIdentity: ArtifactEntryIdentityV3
      readonly disposition: 'operation-created'
    }
  | {
      readonly phase: 'existing'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: null
      readonly canonicalIdentity: ArtifactEntryIdentityV3
      readonly disposition: 'existing'
    }
  | {
      readonly phase: 'removing'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3 | null
      readonly canonicalIdentity: ArtifactEntryIdentityV3 | null
      readonly removeFrom: 'private' | 'canonical'
      readonly disposition: 'operation-created'
    }
  | {
      readonly phase: 'removed'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3 | null
      readonly canonicalIdentity: ArtifactEntryIdentityV3 | null
      readonly removedIdentity: ArtifactEntryIdentityV3
      readonly removedFrom: 'private' | 'canonical'
      readonly disposition: 'operation-created'
    }
  | {
      readonly phase: 'closed-absent'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: null
      readonly canonicalIdentity: null
      readonly absent: WorktreeDirectoryAbsentObservationV3
      readonly disposition: 'never-created'
    }
  | {
      readonly phase: 'repair-required'
      readonly intent: WorktreeDirectoryPublicationIntentV3
      readonly privateIdentity: ArtifactEntryIdentityV3 | null
      readonly canonicalIdentity: ArtifactEntryIdentityV3 | null
      readonly repairId: string
    }

type WorktreeTerminalDirectoryPublicationV3 = Extract<
  WorktreeDirectoryReservationPublicationV3,
  { phase: 'published' | 'existing' }
>

type WorktreeRemovedDirectoryPublicationV3 = Extract<
  WorktreeDirectoryReservationPublicationV3,
  { phase: 'removed' }
>

type WorktreeClosedAbsentDirectoryPublicationV3 = Extract<
  WorktreeDirectoryReservationPublicationV3,
  { phase: 'closed-absent' }
>

type WorktreeOperationCreatedDirectoryPublicationV3 = Extract<
  WorktreeDirectoryReservationPublicationV3,
  { phase: 'private-prepared' | 'publishing' | 'published' | 'removing' }
>

interface WorktreeDirectoryReservationPublisherV3 {
  readonly __brand: 'WorktreeDirectoryReservationPublisherV3'
  declare(
    role: WorktreeDirectorySlotRoleV3,
    parent: ArtifactDirCapabilityV3,
    leaf: ValidatedPathSegment,
    descriptorFence: string,
  ): Promise<Extract<WorktreeDirectoryReservationPublicationV3, { phase: 'declared' }>>
  preparePrivate(
    declared: Extract<WorktreeDirectoryReservationPublicationV3, { phase: 'declared' }>,
  ): Promise<Extract<WorktreeDirectoryReservationPublicationV3, { phase: 'private-prepared' }>>
  publishNoReplace(
    prepared: Extract<
      WorktreeDirectoryReservationPublicationV3,
      { phase: 'private-prepared' | 'publishing' }
    >,
  ): Promise<Extract<WorktreeTerminalDirectoryPublicationV3, { phase: 'published' }>>
  discover(
    record: WorktreeDirectoryReservationPublicationV3,
  ): Promise<WorktreeDirectoryReservationPublicationV3>
  closeDeclaredAbsent(
    publication: Extract<WorktreeDirectoryReservationPublicationV3, { phase: 'declared' }>,
  ): Promise<WorktreeClosedAbsentDirectoryPublicationV3>
  removeOperationCreatedExact(
    publication: WorktreeOperationCreatedDirectoryPublicationV3,
  ): Promise<WorktreeRemovedDirectoryPublicationV3>
}

interface WorktreeTaskContainerReservationV3 {
  readonly __brand: 'WorktreeTaskContainerReservationV3'
  readonly reconstructionId: string
  readonly descriptorFence: string
  readonly rootPublication: WorktreeTerminalDirectoryPublicationV3
  readonly namespacePublication: WorktreeTerminalDirectoryPublicationV3 | null
  readonly containerPublication: WorktreeTerminalDirectoryPublicationV3
  readonly rootIdentity: ArtifactEntryIdentityV3
  readonly namespaceIdentity: ArtifactEntryIdentityV3 | null
  readonly containerIdentity: ArtifactEntryIdentityV3
  readonly rootDisposition: 'existing' | 'created-infrastructure'
  readonly namespaceDisposition: 'existing' | 'created-infrastructure'
  readonly containerDisposition: 'existing' | 'operation-created'
}

interface WorktreeRepoTargetReservationV3 {
  readonly __brand: 'WorktreeRepoTargetReservationV3'
  readonly reconstructionId: string
  readonly repoIndex: ValidatedRepoIndexV3
  readonly descriptorFence: string
  readonly repoFence: string
  readonly kind: 'task-container-target' | 'child-of-task-container'
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly targetLeafName: ValidatedPathSegment
  readonly reservationIdentity: ArtifactEntryIdentityV3
  readonly publication: Extract<WorktreeTerminalDirectoryPublicationV3, { phase: 'published' }>
  readonly disposition: 'operation-created-empty'
}

interface ValidatedGitRefV3 {
  readonly __brand: 'ValidatedGitRefV3'
  readonly value: string
}

interface GitBranchRefSnapshotV3 {
  readonly refName: ValidatedGitRefV3 // adapter由 DB-derived branch fence解析
  readonly oid: string | null
  readonly refIdentity: string
}

type GitWorktreeRegistrationSnapshotV3 =
  | {
      readonly state: 'absent'
      readonly registrationIdentity: null
      readonly registrationFence: string
    }
  | {
      readonly state: 'unique-stale'
      readonly registrationIdentity: string
      readonly registrationFence: string
    }
  | {
      readonly state: 'registered'
      readonly registrationIdentity: string
      readonly registrationFence: string
    }

type GitWorktreeRegistrationBeforeV3 = Exclude<
  GitWorktreeRegistrationSnapshotV3,
  { state: 'registered' }
>
type GitWorktreeRegistrationAfterV3 = Extract<
  GitWorktreeRegistrationSnapshotV3,
  { state: 'registered' }
>

interface GitRepoAdminInventoryEntryV3 {
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly entryLeaf: ValidatedPathSegment
  readonly entryIdentity: ArtifactEntryIdentityV3
  readonly entryKind: 'registration-root' | 'admin-file' | 'admin-directory'
  readonly relation:
    | { readonly kind: 'expected-target'; readonly targetIdentity: ArtifactEntryIdentityV3 }
    | { readonly kind: 'unrelated' }
}

interface GitRepoAdminInventoryV3 {
  readonly repoAdminIdentity: ArtifactEntryIdentityV3
  readonly inventoryDigest: string
  readonly entries: readonly GitRepoAdminInventoryEntryV3[] // bounded + canonical order
  readonly observationFence: string
}

interface GitWorktreeAdminSlotIntentV3 {
  readonly addAttemptId: string
  readonly parentIdentity: ArtifactEntryIdentityV3
  readonly expectedLeaf: ValidatedPathSegment
  readonly absentProof: {
    readonly parentIdentity: ArtifactEntryIdentityV3
    readonly expectedLeaf: ValidatedPathSegment
    readonly state: 'absent'
    readonly observationFence: string
  }
  readonly namingAlgorithm: 'qualified-git-worktree-admin-slot-v1'
  readonly gitVersionFence: string
}

interface GitWorktreeStaleCleanupIntentV3 {
  readonly cleanupAttemptId: string
  readonly registrationIdentity: string
  readonly registrationFence: string
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly adminEntry: GitRepoAdminInventoryEntryV3 & {
    readonly relation: {
      readonly kind: 'expected-target'
      readonly targetIdentity: ArtifactEntryIdentityV3
    }
  }
  readonly adminBeforeDigest: string
  readonly observationFence: string
}

type GitWorktreeRegistrationPreparationV3 =
  | {
      readonly phase: 'already-absent'
      readonly original: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
      readonly effective: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
      readonly adminBefore: GitRepoAdminInventoryV3
      readonly staleCleanup: null
    }
  | {
      readonly phase: 'stale-removing'
      readonly original: Extract<GitWorktreeRegistrationBeforeV3, { state: 'unique-stale' }>
      readonly effective: null
      readonly adminBefore: GitRepoAdminInventoryV3
      readonly cleanupIntent: GitWorktreeStaleCleanupIntentV3
      readonly staleCleanup: null
    }
  | {
      readonly phase: 'stale-removed'
      readonly original: Extract<GitWorktreeRegistrationBeforeV3, { state: 'unique-stale' }>
      readonly effective: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
      readonly adminBefore: GitRepoAdminInventoryV3
      readonly cleanupIntent: GitWorktreeStaleCleanupIntentV3
      readonly staleCleanup: {
        readonly removedRegistrationIdentity: string
        readonly removedEntry: GitRepoAdminInventoryEntryV3
        readonly observedRegistration: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
        readonly adminAfter: GitRepoAdminInventoryV3
        readonly parentFsyncFence: string
        readonly cleanupFence: string
      }
    }
  | {
      readonly phase: 'stale-retained'
      readonly original: Extract<GitWorktreeRegistrationBeforeV3, { state: 'unique-stale' }>
      readonly effective: null
      readonly adminBefore: GitRepoAdminInventoryV3
      readonly cleanupIntent: GitWorktreeStaleCleanupIntentV3
      readonly staleCleanup: {
        readonly outcome: 'not-removed'
        readonly observedRegistration: Extract<
          GitWorktreeRegistrationBeforeV3,
          { state: 'unique-stale' }
        >
        readonly adminAfter: GitRepoAdminInventoryV3
        readonly failureCode: 'canceled-before-effect' | 'remove-not-started'
        readonly observationFence: string
      }
    }
  | {
      readonly phase: 'repair-required'
      readonly original: GitWorktreeRegistrationBeforeV3
      readonly effective: null
      readonly adminBefore: GitRepoAdminInventoryV3
      readonly staleCleanup: null
      readonly repairId: string
    }

type GitWorktreeEffectiveRegistrationPreparationV3 = Extract<
  GitWorktreeRegistrationPreparationV3,
  { phase: 'already-absent' | 'stale-removed' }
>

type GitWorktreeTerminalRegistrationPreparationV3 = Extract<
  GitWorktreeRegistrationPreparationV3,
  { phase: 'already-absent' | 'stale-removed' | 'stale-retained' }
>

interface GitWorktreeAddIntentV3 {
  readonly addAttemptId: string
  readonly reconstructionId: string
  readonly repoIndex: ValidatedRepoIndexV3
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly targetEmptyFence: string
  readonly adminSlotIntent: GitWorktreeAdminSlotIntentV3
  readonly registrationPreparation: GitWorktreeEffectiveRegistrationPreparationV3
  readonly branchBefore: GitBranchRefSnapshotV3
  readonly adminBefore: GitRepoAdminInventoryV3
}

interface GitRegisteredWorktreeCapabilityV3 {
  readonly __brand: 'GitRegisteredWorktreeCapabilityV3'
  readonly addIntent: GitWorktreeAddIntentV3
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly registrationAfter: GitWorktreeRegistrationAfterV3
  readonly branchAfter: GitBranchRefSnapshotV3
  readonly adminAfter: GitRepoAdminInventoryV3
}

interface GitWorktreeRegistrationAdapterV3 {
  readonly __brand: 'GitWorktreeRegistrationAdapterV3'
  snapshotBranchRef(target: WorktreeRepoTargetDescriptorV3): Promise<GitBranchRefSnapshotV3>
  snapshotRegistration(
    target: WorktreeRepoTargetDescriptorV3,
  ): Promise<GitWorktreeRegistrationSnapshotV3>
  snapshotAdminInventory(target: WorktreeRepoTargetDescriptorV3): Promise<GitRepoAdminInventoryV3>
  prepareRegistrationBaseline(
    target: WorktreeRepoTargetDescriptorV3,
    before: GitWorktreeRegistrationBeforeV3,
    adminBefore: GitRepoAdminInventoryV3,
  ): Promise<GitWorktreeRegistrationPreparationV3>
  declareAdd(
    target: WorktreeRepoTargetDescriptorV3,
    reservation: WorktreeRepoTargetReservationV3,
    registrationPreparation: GitWorktreeEffectiveRegistrationPreparationV3,
    branchBefore: GitBranchRefSnapshotV3,
    adminBefore: GitRepoAdminInventoryV3,
    adminSlotIntent: GitWorktreeAdminSlotIntentV3,
  ): Promise<GitWorktreeAddIntentV3>
  registerExact(
    target: WorktreeRepoTargetDescriptorV3,
    reservation: WorktreeRepoTargetReservationV3,
    addIntent: GitWorktreeAddIntentV3,
  ): Promise<GitRegisteredWorktreeCapabilityV3>
  discoverInterruptedAdd(
    target: WorktreeRepoTargetDescriptorV3,
    reservation: WorktreeRepoTargetReservationV3,
    addIntent: GitWorktreeAddIntentV3,
  ): Promise<
    | { kind: 'not-started'; proof: GitWorktreeNoEffectProofV3 }
    | { kind: 'partial'; effect: GitWorktreePartialEffectV3 }
    | { kind: 'unique'; target: GitRegisteredWorktreeCapabilityV3 }
    | { kind: 'ambiguous'; repairId: string }
  >
  verifyExact(target: GitRegisteredWorktreeCapabilityV3): Promise<void>
  removeOperationCreatedExact(target: GitRegisteredWorktreeCapabilityV3): Promise<void>
  compensatePartialComponentExact(
    effect: GitWorktreePartialEffectV3,
    component: GitWorktreePartialComponentV3,
  ): Promise<void>
  restoreBranchRefExact(
    before: GitBranchRefSnapshotV3,
    after: GitBranchRefSnapshotV3,
  ): Promise<void>
}

interface WorktreeRepoReservationLedgerBaseV3 {
  readonly repoIndex: ValidatedRepoIndexV3
  readonly descriptorFence: string
  readonly taskFence: string
  readonly repoFence: string
  readonly targetReservation: WorktreeRepoTargetReservationV3
}

interface WorktreeRepoReservationIntentLedgerBaseV3 {
  readonly repoIndex: ValidatedRepoIndexV3
  readonly descriptorFence: string
  readonly taskFence: string
  readonly repoFence: string
  readonly targetPublication: WorktreeDirectoryReservationPublicationV3
}

interface WorktreeRepoEffectLedgerBaseV3 extends WorktreeRepoReservationLedgerBaseV3 {
  readonly addIntent: GitWorktreeAddIntentV3
}

interface WorktreeRegisteredEffectV3 {
  readonly kind: 'registered'
  readonly addAttemptId: string
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly registrationAfter: GitWorktreeRegistrationAfterV3
  readonly branchAfter: GitBranchRefSnapshotV3
  readonly adminAfter: GitRepoAdminInventoryV3
}

type GitWorktreePartialComponentV3 =
  | {
      readonly kind: 'branch-delta'
      readonly before: GitBranchRefSnapshotV3
      readonly after: GitBranchRefSnapshotV3
    }
  | {
      readonly kind: 'registration-delta'
      readonly after: GitWorktreeRegistrationAfterV3
    }
  | {
      readonly kind: 'admin-partial'
      readonly operationOwnedEntries: readonly [
        GitRepoAdminInventoryEntryV3,
        ...GitRepoAdminInventoryEntryV3[],
      ]
    }
  | {
      readonly kind: 'target-delta'
      readonly targetIdentity: ArtifactEntryIdentityV3
      readonly targetStateFence: string
    }

interface GitWorktreePartialEffectV3 {
  readonly kind: 'partial'
  readonly addAttemptId: string
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly components: readonly [GitWorktreePartialComponentV3, ...GitWorktreePartialComponentV3[]]
  readonly observedRegistration: GitWorktreeRegistrationSnapshotV3
  readonly observedBranch: GitBranchRefSnapshotV3
  readonly adminAfter: GitRepoAdminInventoryV3
  readonly observationFence: string
}

interface GitWorktreeNoEffectProofV3 {
  readonly kind: 'not-started'
  readonly addAttemptId: string
  readonly targetIdentity: ArtifactEntryIdentityV3
  readonly targetStillEmpty: true
  readonly observedRegistration: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
  readonly observedBranch: GitBranchRefSnapshotV3
  readonly observedAdmin: GitRepoAdminInventoryV3
  readonly observationFence: string
}

type WorktreeRepoCompensationEffectV3 =
  | {
      readonly kind: 'none'
      readonly stage: 'git-not-started'
      readonly proof: GitWorktreeNoEffectProofV3
    }
  | GitWorktreePartialEffectV3
  | WorktreeRegisteredEffectV3

type WorktreeRepoEffectCleanupProgressV3 =
  | {
      readonly kind: 'none'
      readonly noEffectReverified: boolean
    }
  | {
      readonly kind: 'partial'
      readonly targetDeltaReverted: boolean
      readonly adminEntries: readonly {
        readonly entry: GitRepoAdminInventoryEntryV3
        readonly removed: boolean
      }[]
      readonly registrationAbsent: boolean
      readonly branchRestored: boolean
    }
  | {
      readonly kind: 'registered'
      readonly overlayCleaned: boolean
      readonly registrationAbsent: boolean
      readonly branchRestored: boolean
    }

type WorktreeRepoTerminalEffectCleanupV3 =
  | {
      readonly kind: 'none'
      readonly noEffectReverified: true
    }
  | {
      readonly kind: 'partial'
      readonly targetDeltaReverted: true
      readonly adminEntries: readonly {
        readonly entry: GitRepoAdminInventoryEntryV3
        readonly removed: true
      }[]
      readonly registrationAbsent: true
      readonly branchRestored: true
    }
  | {
      readonly kind: 'registered'
      readonly overlayCleaned: true
      readonly registrationAbsent: true
      readonly branchRestored: true
    }

interface WorktreeRepoBeforeReservationNoEffectV3 {
  readonly kind: 'none'
  readonly stage: 'before-reservation'
  readonly proof: {
    readonly targetNeverReserved: true
    readonly gitNeverInvoked: true
    readonly observationFence: string
  }
}

type WorktreeRepoBeforeGitNoEffectV3 =
  | {
      readonly kind: 'none'
      readonly stage: 'before-git'
      readonly baseline: 'effective-absent'
      readonly proof: {
        readonly targetIdentity: ArtifactEntryIdentityV3
        readonly registrationPreparation: GitWorktreeEffectiveRegistrationPreparationV3
        readonly observedRegistration: Extract<GitWorktreeRegistrationBeforeV3, { state: 'absent' }>
        readonly observedBranch: GitBranchRefSnapshotV3
        readonly observedAdmin: GitRepoAdminInventoryV3
        readonly gitNeverInvoked: true
        readonly observationFence: string
      }
    }
  | {
      readonly kind: 'none'
      readonly stage: 'before-git'
      readonly baseline: 'stale-retained'
      readonly proof: {
        readonly targetIdentity: ArtifactEntryIdentityV3
        readonly registrationPreparation: Extract<
          GitWorktreeRegistrationPreparationV3,
          { phase: 'stale-retained' }
        >
        readonly observedRegistration: Extract<
          GitWorktreeRegistrationBeforeV3,
          { state: 'unique-stale' }
        >
        readonly observedBranch: GitBranchRefSnapshotV3
        readonly observedAdmin: GitRepoAdminInventoryV3
        readonly gitNeverInvoked: true
        readonly observationFence: string
      }
    }

type WorktreeRepoTerminalDirectoryCleanupV3 =
  | {
      readonly kind: 'closed-absent'
      readonly publication: WorktreeClosedAbsentDirectoryPublicationV3
    }
  | {
      readonly kind: 'operation-created-removed'
      readonly publication: WorktreeRemovedDirectoryPublicationV3
    }

type WorktreeRepoReconstructionEntryV3 =
  | (WorktreeRepoReservationIntentLedgerBaseV3 & {
      readonly phase: 'reserving'
      readonly targetReservation: null
    })
  | (WorktreeRepoReservationLedgerBaseV3 & {
      readonly phase: 'reserved'
    })
  | (WorktreeRepoReservationLedgerBaseV3 & {
      readonly phase: 'preparing-registration'
      readonly registrationPreparation: GitWorktreeRegistrationPreparationV3
      readonly branchBefore: GitBranchRefSnapshotV3
    })
  | (WorktreeRepoEffectLedgerBaseV3 & {
      readonly phase: 'adding'
      readonly effect: null
    })
  | (WorktreeRepoEffectLedgerBaseV3 & {
      readonly phase: 'registered' | 'overlaying' | 'overlayed' | 'verifying' | 'verified'
      readonly effect: WorktreeRegisteredEffectV3
    })
  | (WorktreeRepoReservationLedgerBaseV3 & {
      readonly phase: 'compensating'
      readonly addIntent: null
      readonly registrationPreparation: GitWorktreeTerminalRegistrationPreparationV3
      readonly branchBefore: GitBranchRefSnapshotV3
      readonly effect: WorktreeRepoBeforeGitNoEffectV3
      readonly effectCleanup: Extract<WorktreeRepoEffectCleanupProgressV3, { kind: 'none' }>
      readonly directoryCleanup: WorktreeDirectoryReservationPublicationV3
    })
  | (WorktreeRepoEffectLedgerBaseV3 & {
      readonly phase: 'compensating'
      readonly effect: WorktreeRepoCompensationEffectV3
      readonly effectCleanup: WorktreeRepoEffectCleanupProgressV3
      readonly directoryCleanup: WorktreeDirectoryReservationPublicationV3
    })
  | ({
      readonly phase: 'compensated'
      readonly directoryCleanup: WorktreeRepoTerminalDirectoryCleanupV3
      readonly effectCleanup: WorktreeRepoTerminalEffectCleanupV3
    } & (
      | (WorktreeRepoEffectLedgerBaseV3 & {
          readonly effect: WorktreeRepoCompensationEffectV3
        })
      | (WorktreeRepoReservationIntentLedgerBaseV3 & {
          readonly targetReservation: null
          readonly effect: WorktreeRepoBeforeReservationNoEffectV3
        })
      | (WorktreeRepoReservationLedgerBaseV3 & {
          readonly registrationPreparation: GitWorktreeTerminalRegistrationPreparationV3
          readonly branchBefore: GitBranchRefSnapshotV3
          readonly effect: WorktreeRepoBeforeGitNoEffectV3
        })
    ))
  | {
      readonly phase: 'repair-required'
      readonly repoIndex: ValidatedRepoIndexV3
      readonly descriptorFence: string
      readonly taskFence: string
      readonly repoFence: string
      readonly targetPublication: WorktreeDirectoryReservationPublicationV3
      readonly targetReservation?: WorktreeRepoTargetReservationV3
      readonly registrationPreparation?: GitWorktreeRegistrationPreparationV3
      readonly addIntent?: GitWorktreeAddIntentV3
      readonly effect:
        | WorktreeRepoBeforeReservationNoEffectV3
        | WorktreeRepoBeforeGitNoEffectV3
        | WorktreeRepoCompensationEffectV3
        | null
      readonly repairId: string
    }

interface WorktreeTaskContainerPublicationProgressV3 {
  readonly root: WorktreeDirectoryReservationPublicationV3 | null
  readonly namespace: WorktreeDirectoryReservationPublicationV3 | null
  readonly container: WorktreeDirectoryReservationPublicationV3 | null
}

interface WorktreeTaskContainerTerminalPublicationsV3 {
  readonly root: WorktreeTerminalDirectoryPublicationV3
  readonly namespace: WorktreeTerminalDirectoryPublicationV3 | null
  readonly container: WorktreeTerminalDirectoryPublicationV3
}

interface WorktreeCreatedInfrastructureRetentionV3 {
  readonly reconstructionId: string
  readonly publicationId: string
  readonly role: 'worktrees-root' | 'layout-namespace'
  readonly retainedIdentity: ArtifactEntryIdentityV3
  readonly observedIdentity: ArtifactEntryIdentityV3
  readonly observationFence: string
  readonly policy: 'shared-infrastructure'
}

type WorktreeDirectoryTerminalCleanupV3 =
  | {
      readonly kind: 'closed-absent'
      readonly publication: WorktreeClosedAbsentDirectoryPublicationV3
    }
  | {
      readonly kind: 'operation-created-removed'
      readonly publication: WorktreeRemovedDirectoryPublicationV3
    }
  | {
      readonly kind: 'existing-retained'
      readonly publication: Extract<WorktreeTerminalDirectoryPublicationV3, { phase: 'existing' }>
    }
  | {
      readonly kind: 'created-infrastructure-retained'
      readonly publication: Extract<WorktreeTerminalDirectoryPublicationV3, { phase: 'published' }>
      readonly retention: WorktreeCreatedInfrastructureRetentionV3
    }

interface WorktreeTaskContainerCleanupV3 {
  readonly root: WorktreeDirectoryTerminalCleanupV3 | null
  readonly namespace: WorktreeDirectoryTerminalCleanupV3 | null
  readonly container: WorktreeDirectoryTerminalCleanupV3 | null
}

type WorktreeTaskContainerLedgerV3 =
  | {
      readonly phase: 'reserving'
      readonly publications: WorktreeTaskContainerPublicationProgressV3
      readonly reservation: null
    }
  | {
      readonly phase: 'reserved'
      readonly publications: WorktreeTaskContainerTerminalPublicationsV3
      readonly reservation: WorktreeTaskContainerReservationV3
    }
  | {
      readonly phase: 'compensated'
      readonly publications: WorktreeTaskContainerPublicationProgressV3
      readonly reservation: WorktreeTaskContainerReservationV3 | null
      readonly cleanup: WorktreeTaskContainerCleanupV3
    }
  | {
      readonly phase: 'repair-required'
      readonly publications: WorktreeTaskContainerPublicationProgressV3
      readonly reservation: WorktreeTaskContainerReservationV3 | null
      readonly repairId: string
    }

interface WorktreeReconstructionReceiptBaseV3 {
  readonly schemaVersion: 3
  readonly restoreOperationId: string
  readonly reconstructionId: string
  readonly taskId: ValidatedPathSegment
  readonly taskFence: string
  readonly taskContainer: WorktreeTaskContainerLedgerV3
  readonly repos: readonly WorktreeRepoReconstructionEntryV3[]
}

type WorktreeReconstructionReceiptV3 =
  | (WorktreeReconstructionReceiptBaseV3 & {
      readonly phase:
        | 'reserving'
        | 'prepared'
        | 'registering'
        | 'registered'
        | 'overlaying'
        | 'verified'
        | 'compensating'
      readonly outcome: null
    })
  | (WorktreeReconstructionReceiptBaseV3 & {
      readonly phase: 'complete'
      readonly outcome: { readonly kind: 'reconstructed' }
    })
  | (WorktreeReconstructionReceiptBaseV3 & {
      readonly phase: 'compensated'
      readonly outcome: {
        readonly kind: 'skipped'
        readonly reason:
          | 'directory-reservation-failed'
          | 'git-registration-failed'
          | 'overlay-failed'
          | 'postcondition-failed'
          | 'fence-changed'
      }
    })
  | (WorktreeReconstructionReceiptBaseV3 & {
      readonly phase: 'repair-required'
      readonly outcome: { readonly kind: 'repair'; readonly repairId: string }
    })

interface WorktreeReconstructionLedgerV3 {
  readonly __brand: 'WorktreeReconstructionLedgerV3'
  lookup(
    restoreOperationId: string,
    taskId: ValidatedPathSegment,
  ): Promise<WorktreeReconstructionReceiptV3 | null>
}

interface WorktreeReconstructionCapabilityV3 {
  readonly __brand: 'WorktreeReconstructionCapabilityV3'
  readonly taskId: ValidatedPathSegment
  readonly reconstructionId: string
  readonly taskFence: string
  readonly rootSlot: WorktreesRootSlotCapabilityV3
  readonly directoryPublisher: WorktreeDirectoryReservationPublisherV3
  readonly taskContainer: WorktreeTaskContainerDescriptorV3
  readonly targets: readonly WorktreeRepoTargetDescriptorV3[]
  preflightAll(
    source: CapturedWorktreeTaskCapabilityV3,
  ): Promise<{ kind: 'ready' } | { kind: 'skip'; reason: StrictWorktreeReconstructionSkipReasonV3 }>
  reserveTaskContainer(): Promise<WorktreeTaskContainerReservationV3>
  reserveRepoTarget(
    container: WorktreeTaskContainerReservationV3,
    repoIndex: ValidatedRepoIndexV3,
  ): Promise<WorktreeRepoTargetReservationV3>
  registerReservedWorktree(
    reservation: WorktreeRepoTargetReservationV3,
  ): Promise<GitRegisteredWorktreeCapabilityV3>
  overlayCapturedTree(
    target: GitRegisteredWorktreeCapabilityV3,
    source: ArtifactReadOnlyTreeCapabilityV3,
  ): Promise<void>
  verifyRepoPostcondition(target: GitRegisteredWorktreeCapabilityV3): Promise<void>
  compensateExact(receipt: WorktreeReconstructionReceiptV3): Promise<void>
}

type ArtifactBackupInventoryAuthorityV3 =
  | {
      readonly kind: 'published'
      readonly publication: ArtifactPublicationReceiptRefV3
    }
  | {
      readonly kind: 'legacy-adopted'
      readonly adoption: ArtifactLegacyArchiveAdoptionReceiptV3
    }

interface ArtifactLegacyArchiveAdoptionReceiptV3 {
  readonly schemaVersion: 3
  readonly adoptionId: string
  readonly archiveDigest: string
  readonly archiveIdentity: ArtifactEntryIdentityV3
  readonly manifestDigest: string
  readonly backupKind: 'manual' | 'scheduled' | 'auto' | 'pre-migration' | 'pre-restore'
  readonly adoptedAt: string
}

interface ArtifactLegacyArchiveAdoptionLedgerV3 {
  readonly __brand: 'ArtifactLegacyArchiveAdoptionLedgerV3'
  lookupByIdentity(
    identity: ArtifactEntryIdentityV3,
  ): Promise<ArtifactLegacyArchiveAdoptionReceiptV3 | null>
}

interface ArtifactBackupInventoryEntryV3 {
  readonly __brand: 'ArtifactBackupInventoryEntryV3'
  readonly archiveName: ValidatedPathSegment
  readonly archiveDigest: string
  readonly identity: ArtifactEntryIdentityV3
  readonly authority: ArtifactBackupInventoryAuthorityV3
  readonly protection: 'removable' | 'active' | 'explicit' | 'last-good'
}

interface ArtifactSqliteSnapshotSourceV3 {
  readonly __brand: 'ArtifactSqliteSnapshotSourceV3'
  writeConsistentSnapshot(sink: ArtifactBackupFileSinkV3): Promise<ArtifactBackupFileReceiptV3>
}

interface ArtifactBackupExportCapabilityV3 {
  readonly __brand: 'ArtifactBackupExportCapabilityV3'
  readonly operation: Extract<ArtifactFsOperationIdentityV3, { kind: 'backup-export' }>
  createStagingTree(): Promise<ArtifactBackupTreeWriterV3>
  copyFile(
    writer: ArtifactBackupTreeWriterV3,
    role: BackupCopyFileRoleV3,
    source: ArtifactReadOnlyFileCapabilityV3,
  ): Promise<ArtifactBackupFileReceiptV3>
  copyTree(
    writer: ArtifactBackupTreeWriterV3,
    logicalName: BackupLogicalTreeNameV3,
    source: ArtifactReadOnlyTreeCapabilityV3,
  ): Promise<ArtifactBackupTreeReceiptV3>
  createGeneratedFile(
    writer: ArtifactBackupTreeWriterV3,
    target: BackupGeneratedFileTargetV3,
    bytes: Uint8Array,
  ): Promise<ArtifactBackupFileReceiptV3>
  snapshotSqlite(
    writer: ArtifactBackupTreeWriterV3,
    source: ArtifactSqliteSnapshotSourceV3,
  ): Promise<ArtifactBackupFileReceiptV3>
  captureWorktreeTask(
    writer: ArtifactBackupTreeWriterV3,
    source: ArtifactBackupWorktreeTaskSourceV3,
  ): Promise<ArtifactBackupWorktreeReceiptV3 | { skipped: StrictBackupSkipReasonV3 }>
  sealStaging(
    writer: ArtifactBackupTreeWriterV3,
    expectedManifestDigest: string,
  ): Promise<ArtifactSealedTreeCapabilityV3>
  packAndPublish(
    staging: ArtifactSealedTreeCapabilityV3,
    archiveName: ValidatedPathSegment,
  ): Promise<ArtifactNoReplaceResultV3>
}

interface ArtifactBackupRetentionCapabilityV3 {
  readonly __brand: 'ArtifactBackupRetentionCapabilityV3'
  readonly operation: Extract<ArtifactFsOperationIdentityV3, { kind: 'backup-retention' }>
  listVerifiedArchives(): Promise<readonly ArtifactBackupInventoryEntryV3[]>
  removeArchiveExact(
    entry: ArtifactBackupInventoryEntryV3,
  ): Promise<'removed' | 'protected' | 'last-good'>
}

interface ArtifactLegacyArchiveAdoptionCapabilityV3 {
  readonly __brand: 'ArtifactLegacyArchiveAdoptionCapabilityV3'
  readonly operation: Extract<ArtifactFsOperationIdentityV3, { kind: 'backup-legacy-adoption' }>
  scanUnclaimedArchives(): Promise<
    readonly (
      | { kind: 'candidate'; entry: ArtifactReadOnlyFileCapabilityV3 }
      | { kind: 'protected-repair'; repair: PendingRestoreRepairSummaryV3 }
    )[]
  >
  adoptExact(
    entry: ArtifactReadOnlyFileCapabilityV3,
  ): Promise<ArtifactLegacyArchiveAdoptionReceiptV3>
}

type ArtifactBackupCapabilityV3 =
  | ArtifactBackupExportCapabilityV3
  | ArtifactBackupRetentionCapabilityV3
  | ArtifactLegacyArchiveAdoptionCapabilityV3
```

broker mint时按 operation返回不同 branded interface：`backup-export`只能使用
`backup-staging-tree`与`backup-archive`，其 type surface只有 create/copy/seal/pack/publish；
`backup-retention`的 type surface只有读取 broker验证的 archive inventory并对 exact entry
remove，`backup-legacy-adoption`只能 scan/seal/adopt existing entry，不能创建、覆盖或删除
archive。broker frame仍重复做 closed operation/slot allowlist，不能靠
TypeScript防 untrusted frame。`archiveName`由既有日期/sequence规则生成并先过单 segment
validator；caller不能传 app-home-relative path。active pending-restore archive、当前 export、
explicit protected entry与最后一个 verified good archive永远不删除。

同理，`pending-restore-stage`只 mint ingress/stage高层接口，
`pending-restore-legacy-adoption`只 mint canonical legacy adoption接口与
`LegacyPendingMovePublisherV3`；后者按 action把 target role固定为 hold或quarantine，不能互换，
`worktree-reconstruction`只 mint `WorktreeReconstructionCapabilityV3`与内部 Git adapter；
三者都拿不到通用 `ArtifactFsCapabilityV3`的任意 mkdir/open/write surface。frame层逐次核对
operation、stage/adoption/reconstruction id、slot与 DB-derived descriptor，不能因为 union包含该
operation就获得其它 slot。

以下 recovery codec是实现合同，不是 TypeScript示意。每个 decoded schema都有 §0.5.1.1a registry
中同结构、无 transform的 `*WireSchema`与显式 root encoder；所有 object branch均 `.strict()`，
wire branch的 nested identity只用 `ArtifactEntryIdentityV3WireSchema`，decoded branch的所有
nested identity只经 `ArtifactEntryIdentityV3Schema` decode；不可变 proof用
`artifactEntrySnapshotEqual()`，允许 directory内容变化的 same-inode/retention/target重验用
`artifactEntrySameObject()`，consumer不得自建第三种比较：

```ts
const WorktreeDirectoryReservationPublicationV3Schema = z
  .discriminatedUnion('phase', [
    WorktreeDirectoryDeclaredV3Schema.strict(),
    WorktreeDirectoryPrivatePreparedV3Schema.strict(),
    WorktreeDirectoryPublishingV3Schema.strict(),
    WorktreeDirectoryPublishedV3Schema.strict(),
    WorktreeDirectoryExistingV3Schema.strict(),
    WorktreeDirectoryRemovingV3Schema.strict(),
    WorktreeDirectoryRemovedV3Schema.strict(),
    WorktreeDirectoryClosedAbsentV3Schema.strict(),
    WorktreeDirectoryRepairV3Schema.strict(),
  ])
  .superRefine(assertWorktreeDirectoryPublicationCanonical)

const GitWorktreeRegistrationPreparationV3Schema = z
  .discriminatedUnion('phase', [
    GitRegistrationAlreadyAbsentV3Schema.strict(),
    GitRegistrationStaleRemovingV3Schema.strict(),
    GitRegistrationStaleRemovedV3Schema.strict(),
    GitRegistrationStaleRetainedV3Schema.strict(),
    GitRegistrationPreparationRepairV3Schema.strict(),
  ])
  .superRefine(assertGitRegistrationPreparationCanonical)

const GitWorktreeStaleCleanupIntentV3Schema =
  GitStaleCleanupIntentFieldsV3Schema.strict().superRefine(assertGitStaleCleanupIntentCanonical)

const WorktreeRepoBeforeGitNoEffectV3Schema = z
  .discriminatedUnion('baseline', [
    GitEffectiveAbsentBeforeGitNoEffectV3Schema.strict(),
    GitStaleRetainedBeforeGitNoEffectV3Schema.strict(),
  ])
  .superRefine(assertGitBeforeGitNoEffectCanonical)

const WorktreeRepoCompensationEffectV3Schema = z
  .discriminatedUnion('kind', [
    GitNoEffectV3Schema.strict(),
    GitPartialEffectV3Schema.strict(),
    GitRegisteredEffectV3Schema.strict(),
  ])
  .superRefine(assertGitEffectCanonical)

const WorktreeReconstructionReceiptV3Schema = z
  .discriminatedUnion('phase', [
    WorktreeReconstructionReservingV3Schema.strict(),
    WorktreeReconstructionPreparedV3Schema.strict(),
    WorktreeReconstructionRegisteringV3Schema.strict(),
    WorktreeReconstructionRegisteredV3Schema.strict(),
    WorktreeReconstructionOverlayingV3Schema.strict(),
    WorktreeReconstructionVerifiedV3Schema.strict(),
    WorktreeReconstructionCompensatingV3Schema.strict(),
    WorktreeReconstructionCompleteV3Schema.strict(),
    WorktreeReconstructionCompensatedV3Schema.strict(),
    WorktreeReconstructionRepairV3Schema.strict(),
  ])
  .superRefine(assertWorktreeReconstructionCanonical)
```

三个 canonical helper必须逐字段执行下列约束：

- directory所有 nested publication/reconstruction/descriptor id等于 intent；absence observation的
  publication/fence、canonical parent/leaf与 private slot逐字段等于 intent。`published`的
  private/canonical identity相同；`removed.removedIdentity`必须等于 `removedFrom`所选的 recorded
  private/canonical identity；不得以 foreign identity配一个合法 phase；
- registration preparation的 repo-admin inventory root始终等于 descriptor
  `repoAdminIdentity`。stale cleanup intent的 registration id/fence等于 original，target identity
  等于 reserved target，adminBefore digest等于 canonical inventory；其 admin entry必须是该
  inventory中唯一 expected-target entry，parent/leaf/identity及 relation target逐字段匹配。
  `stale-removed`只接受 original unique-stale、effective absent、
  removedRegistrationIdentity等于 original、removedEntry等于 cleanup intent entry、parent已
  fsync，且 admin before→after的唯一 delta是该 entry消失；`stale-retained`只接受 explicit
  cancel/remove-not-started、original registration及 admin inventory逐字段不变，并只能进入
  before-git compensation，不能进入 add intent；`stale-removing`/`repair-required`同样不能进入
  add intent；
- add intent的 reconstruction/repo/target逐字段等于 outer entry/reservation，effective
  registration必须 absent；already-absent时 add adminBefore等于 preparation.adminBefore，
  stale-removed时等于 staleCleanup.adminAfter。adapter在 preparation后同一 coordinator lease下
  重新 snapshot branch/admin/target-empty，任一 drift先 repair；三类 fence来自该同一 durable
  snapshot。
  admin slot intent的 addAttempt/parent等于 add intent/descriptor，expected leaf在 adminBefore中
  absent且 absent proof observation不早于 add admin snapshot，naming algorithm与 Git version等于
  已资格化 adapter；
  `none`要求 target仍为空、registration/branch/admin逐字段等于 effective before；
  `partial|registered`的 addAttemptId与 target必须相同。partial components kind不可重复、至少一项
  真 delta，admin entries必须全部位于 predeclared expected admin slot、before inventory不存在且
  唯一关联 expected target；任何 unrelated/additional/missing inventory变化转 ambiguous repair；
- compensating/compensated的 `effectCleanup.kind === effect.kind`；partial cleanup的 admin entry
  set与 effect中 operation-owned entries逐 parent/leaf/identity恰好相等，不可缺项/多项/duplicate，
  且每个
  target/admin/registration/branch boolean只在对应 exact effect已验证后单调变 true；terminal
  要求全部 true；
- no-add-intent的 before-git compensation只接受 target已 reserve与 terminal registration
  preparation。`baseline='effective-absent'`时 preparation只能
  already-absent/stale-removed，observed registration必须 absent，observed admin分别等于
  preparation adminBefore/staleCleanup.adminAfter；`baseline='stale-retained'`时 original
  unique-stale registration与 admin before/after必须逐字段未变。两支 observed branch都等于
  preparing阶段的 branchBefore，且 durable `gitNeverInvoked`为 true；remove target前必须已写
  compensating，terminal才可写 compensated；
- created-infrastructure retention只允许 root/namespace cleanup，publication必须是相同
  reconstruction的 `published + operation-created`，intent role与 retention role相同，
  retained/observed/canonical identity全相等。container/repo-target、existing publication或
  replacement不能使用该分支；
- 顶层 receipt对每个 nested directory/preparation/effect schema再次 `safeParse`，再绑定 ordered
  repoIndex、task/repo/descriptor fence、publication id、reservation identity与 cleanup。parse
  failure必须早于 descriptor open、discovery、remove、checkpoint及 DB open。

`WorktreeReconstructionReceiptV3Schema`除 discriminated union外还以 `superRefine`锁 cross-field
phase矩阵，consumer必须 `safeParse`，不能 cast：

- top-level `reserving`只允许 container `reserving|repair-required`，repo只能缺席或
  `reserving|repair-required`；
- `prepared`及任何 Git phase要求 container=`reserved`且 ordered repo全都至少 `reserved`；
- `complete`要求 container=`reserved`且每个 repo=`verified`；`compensated`要求
  container=`compensated`、每个 repo=`compensated`，但允许 container reservation或 repo target
  reservation尚未形成；每个非空 publication必须以 `closed-absent`、`removed`、
  `existing-retained`或仅限 root/namespace的 `created-infrastructure-retained`逐层闭合。
  `closed-absent`只接受 durable `declared`后、private/canonical双 absent与 exact parent proof，
  不能拿来掩盖 prepared/publishing authority丢失；
- repo compensated的 `effect.kind='none'`若 stage=`git-not-started`，必须有 target identity、
  registration/branch/admin逐字段等于 **effective** before snapshot的 `not-started` proof且没有
  任何 after字段；stage=`before-reservation`则必须证明 target未 reserve、Git未调用；
  stage=`before-git`只接受 target已 reserve，并按 baseline证明 effective absent或
  stale-retained的 registration/branch/admin未漂移且 Git未调用；add intent必须为 null。
  `effect.kind='partial|registered'`必须保存真实 component delta并要求 exact逆序 cleanup；
- `repair-required`必须有至少一个 matching nested repair id。terminal publication要求
  private/canonical identity指向 same inode/operation；single container-target必须引用同一
  `published + operation-created` publication id，`existing` container只能在 preflight返回
  `target-present`，不能复制一份“看起来相同”的 target receipt或进入删除路径。

export staging是 broker-private `ArtifactBackupTreeWriterV3`，只接受 closed
`BackupCopyFileRoleV3/BackupLogicalTreeNameV3/BackupGeneratedFileTargetV3`：config、database、
database-wal、database-shm、skills、worktrees与manifest都是 singleton role；每份 workflow YAML
另携先过 canonical resource-id + path-segment validator的 `ValidatedBackupWorkflowIdV3`，broker
内部唯一映射为 `workflows/<id>.yaml`。API不接受任意 relative name或 callback。config/Skill/
worktree从 canonical read-only file/tree capability复制；generated workflow YAML与manifest必须
先过 byte/count上限再写，duplicate workflow id拒绝。healthy DB由 DB service mint专用
`ArtifactSqliteSnapshotSourceV3`，通过 SQLite online-backup/serialize adapter流入 broker-owned
sink；adapter不能看 sink path/root fd，broker也不把 DB path交给 callback。corrupt或
pre-migration exact-copy模式不打开 SQLite，只从已经锁定 identity/digest的 DB/WAL/SHM read-only
file capabilities复制，并在 manifest标记模式。

可选 worktree capture不接受 caller path，也不再把 legacy `tasks.worktreePath/repoPath`当完整
真值。service在一个 DB snapshot内选择 current non-terminal task，按
`task_repos.repoIndex ASC`读取恰好 `tasks.repoCount`个连续 row；任一 missing/duplicate/gap或
legacy mirror与 repo[0] fence不符，整个 task skip。每个 repo的 exact worktree/repo/base/
branch identity被打开为 read-only descriptor后，才共同 mint
`ArtifactBackupWorktreeTaskSourceV3`；capability不投影任何 path。

broker为 task建立单一 private writer，逐 repo复制到 versioned
`worktrees/v2/<taskId>/repos/<repoIndex>/tree`，排除任意层级 Git administrative `.git`
entry（含 submodule gitdir file），拒绝
symlink/hardlink/device/FIFO/mount crossing并执行 per-repo/per-task/total size+count上限。任一
repo在 walk中 identity变化、消失、超限或不安全时，先用 private capability exact删除该 task
全部 partial，再按现有 skip-not-abort语义返回 closed reason；不能留下部分 repo。成功后写
broker-generated `manifest.json {layoutVersion:2,taskId,taskSnapshotFence,repos[
{repoIndex,worktreeDirName,treeDigest,byteLength}]}`，其中不含 repo/worktree path或可执行 argv。
outer packer只看 sealed staging，不再为新 layout创建 per-task nested tar。legacy
`worktrees/<taskId>.tar.gz + .json`仍只作为 read-only v1 input。

reconstruction发生在 restored DB open/migration/identity barrier之后。service重新按
`task_repos[]`构造 task fence并取得 task workspace recovery lease、每个 source repo coordinator
与 canonical worktrees-root/target-slot locks；任一 task已 terminal、row set漂移、source
repo/admin root missing、任一**非本 reconstruction reservation**的 target已存在或 v2 manifest
repo set/digest不完全匹配时，**任何 repo action前** skip整个 task。canonical worktrees root、
single repo namespace、`multi` namespace或
`worktrees/multi/<taskId>`不存在本身不再是 skip：它们只可由下述 descriptor-rooted reservation
authority建立。
锁顺序固定为 task recovery lease → 去重后按 canonical repo identity排序的 source coordinators →
按 descriptor role/repoIndex排序的 worktree slots；必须 all-or-none取得，失败在任何
directory/Git effect前 task级 skip。restart按同一顺序重取，禁止按 archive repo顺序或 filesystem
enumeration顺序加锁。
legacy v1 payload只允许 `repoCount===1`；multi-repo遇 v1返回
`legacy-multi-repo-incomplete`并零写。single-repo v1的 nested tar先在无 repo/target/app-home
authority的 extractor sandbox中按同一 entry limits展开，经 broker逐 entry验收并 seal成
repoIndex=0的 `ArtifactReadOnlyTreeCapabilityV3`；legacy JSON只取 strict taskId，branch/repo/
worktree path全部忽略。

新 `worktree-reconstruction` operation先从 canonical app-home identity mint
`WorktreesRootSlotCapabilityV3`，按 current DB生成
`WorktreeTaskContainerDescriptorV3 + ordered WorktreeRepoTargetDescriptorV3[]`。在任何 directory
declaration前，它先为全部 ordered repos取得 coordinator locks并资格化：existing-empty target、
directory no-replace primitive、当前 Git version的 deterministic admin-slot naming及 bounded
repo-admin inventory cap必须全部通过；任一失败 task级 typed skip且零 directory/Git effect。之后：

1. `reserveTaskContainer()`在 root slot内只解析 allowlisted namespace + task segment。每个缺失
   root/namespace/task-container先把
   `declared {publicationId,role,parentIdentity,leaf,descriptorFence,privateSlotId}`写入
   non-restored ledger并 fsync，之后才在 broker-private namespace exclusive创建 empty directory、
   fsync并写 `private-prepared + privateIdentity`。canonical publish前再 fsync `publishing`，只用
   Linux `renameat2(RENAME_NOREPLACE)`或 Darwin `renameatx_np(RENAME_EXCL)`把同一 inode移到
   canonical slot；syscall消费 mint时的 exact `ArtifactDirCapabilityV3` parent dirfd，不按记录的
   identity重新解析字符串 path。随后 fsync canonical parent并写 terminal `published` receipt。
   若 slot本来存在，
   只 descriptor-open/verify并写 `existing` receipt，不产生 canonical effect。
   receipt记录每层 exact publication与
   `existing | created-infrastructure | operation-created`。multi layout可借用 identity匹配的
   existing empty task parent但补偿永不删它；single layout的 task container同时是 target，共享
   同一 terminal publication，不再创建第二个 directory，但只有该 publication是本 operation的
   `published + operation-created`才可投影 target；existing single container在任何 target
   reservation/Git前以 `target-present` skip。完整 container reservation durable后才继续。
2. `reserveRepoTarget()`按 ordered repoIndex执行。multi为 task container下的每个 child先写
   `phase='reserving' + declared publication`，再走相同 private prepare/publishing/no-replace
   protocol；terminal publication后才形成
   `WorktreeRepoTargetReservationV3`并推进 `phase='reserved'`。single直接投影 task-container
   publication为 `task-container-target`。每个 reservation保存 parent identity、leaf segment、
   repo/descriptor fence与 same-inode private/canonical identities。crash discovery固定检查
   recorded private slot与 canonical slot：只有 `declared`且两处 absent可重做 private create；
   若 operation在该零 effect点取消或 create返回 ENOSPC/EIO，则以双 absent observation与 exact
   parent proof写 terminal `closed-absent`，不得伪造 removed identity。declared后、identity
   checkpoint前发现 private-only时，只有 broker opaque slot ownership与 descriptor fence都唯一
   匹配才可补 `private-prepared`；
   `private-prepared|publishing`两处都 absent为 authority丢失并 repair；private-only exact继续
   publish，canonical-only identity匹配补 receipt，both或任一 replacement进入 repair。whole parent
   absent、parent-only与 N-1 children已 reserve均可仅按 ledger resume，不允许 generic
   mkdir/caller path。
3. adapter通过 DB-derived descriptor与 source-repo coordinator lock记录 branch/ref、
   registration及 bounded canonical repo-admin inventory before snapshot。unique stale
   registration只有 gitdir、branch与 expected target slot全部匹配时才进入独立
   `preparing-registration`子状态：
   `already-absent`可直接继续；unique stale先 fsync `stale-removing`及
   `GitWorktreeStaleCleanupIntentV3`，其中固定 cleanup attempt、registration identity/fence、
   reserved target identity，以及 bounded inventory中唯一 expected-target admin entry的 exact
   parent/leaf/identity。之后才 exact移除该 entry，观察 registration absent与 admin唯一 delta、
   fsync其 parent后写 `stale-removed`。crash时 stale仍在则只凭该 intent exact重试，已 absent且
   inventory只少 intent entry则补 receipt，replacement/additional delta repair。若 explicit
   cancel或 remove明确未开始，且 original registration/admin inventory逐字段未变，则连同同一
   cleanup intent写 `stale-retained`，以 baseline=`stale-retained`的 before-git no-effect
   receipt逆序清 target reservation并 terminal skip；不把它冒充 effective baseline。
   `already-absent|stale-removed`形成 terminal effective-absent preparation；若在 add
   intent前取消、遇到不改变 baseline的 typed failure或 operation决定 skip，则先保存
   `effect:none,stage:'before-git',baseline:'effective-absent'`与当前 absent registration、
   branch/admin逐字段证据，再删除 exact target并 terminal，不回造已清理的 stale registration。
   pre-add snapshot只要有 registration/branch/admin/target drift便直接 repair；
   duplicate/live/path/branch ambiguity同样 repair，绝不调用 broad
   `git worktree prune`。从此 add的 effective baseline固定为 absent，不能再拿 original
   unique-stale证明 no-effect。preflight后 inventory若在 coordinator lease内仍发生超 cap/drift，
   视为 external ambiguity并 repair，不能在已创建 target后返回无 cleanup凭据的 skip。
4. adapter消费 exact empty target reservation，内部构造 allowlisted
   `git worktree add --no-checkout <exact-target> <exact-branch>`；Git child只获得 exact repo
   objects/refs、repo-admin leaf与该 reservation capability，不获得 app-home/archive/root fd，
   caller/archive值不能进入 argv。release qualification必须先在 broker-private probe中证明当前
   supported Git可消费 existing empty directory，并证明当前 OS的 directory no-replace rename
   primitive保持 inode且在目标存在时零覆盖。Git不支持 existing empty target时返回
   `registration-adapter-unavailable`；directory publication primitive不支持时返回
   `reservation-publication-unavailable`。两者都在 declaration/目录创建前结束，不得临时删除
   reservation再用 raw absent path。registration preparation完成后先在同一 coordinator lease
   下重新 snapshot effective registration/branch/admin/target-empty；任何 drift在 add intent前
   repair。已资格化 adapter在
   repo-admin parent下为 expected validated leaf记录 absent proof，形成
   `GitWorktreeAdminSlotIntentV3`。若实际 absent slot与 preflight资格结果不一致则按 drift
   repair，不得在已创建 target后退化成无 cleanup凭据的 unavailable。随后 fsync
   `GitWorktreeAddIntentV3 {addAttemptId,targetEmptyFence,effectiveRegistrationBefore,
branchBefore,adminBefore,adminSlotIntent}`与 `phase='adding'`。若 crash发生在 add effect后、返回前或返回后
   ledger fsync前，或 Git非零返回，统一调用 `discoverInterruptedAdd()`：
   - target仍为空、registration仍 effective absent、branch与 bounded admin inventory逐字段不变，
     返回 `not-started`；
   - registration/target/branch形成完整唯一 tuple且 admin delta恰为 expected target entries，返回
     `registered`；
   - 仅出现 branch、registration、predeclared expected admin slot内 entries或 target内容中的
     唯一可归属子集，返回 `partial`并保存每个 component exact before/after；
   - unrelated entry、duplicate target、无法绑定 expected target的 partial admin directory、超出
     bounded inventory或任何 replacement返回 `ambiguous`。

   `not-started|partial|registered`都先 checkpoint effect再进入 resume/compensation；尚无失败且
   true no-effect才可重试 add。Git非零绝不能直接假设 not-started。

5. add返回后先 fsync per-repo
   `effect {addAttemptId,targetIdentity,registrationAfter,branchAfter,adminAfter}`与
   `phase='registered'`，才可把 phase推进 `overlaying`并调用 `overlayCapturedTree`。overlay只从
   matching repoIndex sealed tree写 target；之后以单独 `verifying` phase验证 target `.git`
   back-reference、repo common-dir registration、branch/base fence、`git status`与 tree digest/
   file count，再推进 `verified`。multi-repo全部 verified才 terminal complete。
6. kill/failure按 receipt中的 repo倒序执行。`effect.kind='registered'`走
   overlay cleanup → exact operation-created registration/target remove →
   `branchAfter → branchBefore` CAS restore；`effect.kind='partial'`按 target delta → exact
   operation-owned admin/registration entries → branch delta的逆序逐项清理，每步 checkpoint，
   first-fail保持 compensating并由下一次重试；`effect.kind='none'`不伪造 after，只验证 effective
   no-effect proof并删除 exact operation-created target；`before-git`按 baseline复验
   effective-absent或 stale-retained registration/branch/admin以及 Git-never-invoked后删除
   target。该分支在 remove前先写无 add intent的 `compensating` entry，cleanup成功后才写
   `compensated`，因此 target remove后的 crash仍可 exact replay。成功的 stale baseline cleanup
   已经是独立 terminal preparation effect，不回造无效 stale registration。若失败发生在
   reservation完成前，repo以
   `stage:'before-reservation'`证明 Git never invoked，并将对应 publication关闭为
   `closed-absent`或 exact `removed`。每项成功写 `compensated`。所有 child收口后，只在 task
   container `containerDisposition='operation-created'`、identity仍匹配且确认为空时删除并 fsync
   parent；每个 private/canonical directory remove前先 fsync publication `removing`，identity
   matching absent + parent fsync后写 `removed`，repo/top-level compensated receipt必须引用该
   cleanup record。尚未 canonical publish的 private directory也只能按 publication ledger exact删除；
   declared且从未创建的 layer写 `closed-absent`。container reservation尚未形成也可逐层引用
   closed-absent/removed/existing-retained/created-infrastructure-retained并 terminal
   compensated，不得永久卡在 reserving。existing container不删；同 reconstruction创建且 identity
   仍匹配的 shared root/namespace不删，而是复验 role/policy/identity并写
   `created-infrastructure-retained`，以后 operation把它作为 existing使用。partial cleanup
   first-fail保持
   `compensating/repair-required`并阻断该 task recovery，不得按空路径或普通目录猜成功。
   全部 compensation + parent cleanup完成则 top-level terminal `compensated`并携 closed skip
   reason；worktree是 optional payload，此时 restore可继续但不得把 task标成 reconstructed。

receipt由 broker-owned non-restored `WorktreeReconstructionLedgerV3` append/checkpoint fsync；
它不随正在恢复的 DB回滚，也不含 absolute path。每个 repo是上述 discriminated ledger entry，
task container另保存 root/namespace/container publication progress，不再维护
`completedRepoIndexes/registrationIdentities`平行数组。startup在 DB swap前只登记未收口
reconstruction并保持 HTTP/workers关闭；restored DB open后按 exact restoreOperationId/taskId重建
descriptor，先逐项收敛 private/canonical directory publication，再匹配 task/container/repo
fences、reservation、registration/target与 branch/ref before-after后 resume或compensate。DB row
消失、repo set/fence不符、private/canonical replacement或 identity ambiguity只能
repair-required，不能按 archive meta/旧 DB path继续。

packer sandbox只有 sealed staging的 read-only view与一个 broker-owned exact output temp；没有
app-home、canonical root或 broker root fd。broker重新解析产物、核对 manifest/tree/archive
digest，并要求 manifest kind/app version/migration identity与 operation/staged receipts一致后
fsync；随后用 `backup-archive` no-replace publication；publication ledger在 syscall前
持久化，business backup receipt保存其 ref，response loss/restart只沿 exact publication
收敛。manual/API/scheduler/auto/pre-migration/pre-restore调用同一 service；任何 caller都不能自己
`cp/tar/rename`。source guard inventory必须覆盖 `backup.ts`、`rawDbSnapshot.ts`、
`backupScheduler.ts`、`worktreeBackup.ts`及 archive/retention helper。

升级前 `backups/`中的 archive没有 V3 publication receipt。retention在任何 delete policy前先以
`ArtifactLegacyArchiveAdoptionCapabilityV3`扫描 canonical backup root；只打开单 segment
`.tar.gz` regular、`nlink===1`、未被 active pending/current export持有的 descriptor entry。
它计算 archive/manifest digest，以 strict当前 limits验证完整 archive；parser只接受已经发布的
`BackupManifestV1`与本 RFC的新 manifest版本并做显式 version mapping，unknown version拒绝。
kind从 manifest而非
filename取得 `manual|scheduled|auto|pre-migration|pre-restore`。每项先向 non-restored
`ArtifactLegacyArchiveAdoptionLedgerV3`写
`discovered → verified → adopted` exact identity/digest/manifest/protection phases并 fsync；
只有 terminal adoption receipt可进入 inventory的 `legacy-adopted`分支。它不是历史
publication receipt。

adoption在 scan/digest/manifest/ledger任一点崩溃都保持 archive protected并按 exact identity
重试；symlink/hardlink/partial/corrupt/unknown manifest、entry在验收中被替换或同 identity出现
冲突，产生 broker repair inventory且永不由 retention删除。last-good从所有
published/legacy-adopted且完整验证的 archive统一选取。retention的 count/days/total-size策略先
按 manifest kind分类：scheduled/auto可轮转，manual/pre-\* explicit保护；`removeArchiveExact`
必须同时重验 discriminated authority receipt、identity与digest，不能按 filename/mtime raw
unlink。

live DB仍用 verified temp + atomic exact replace；config使用 `sealTemp/commitFile*`的
descriptor-relative
regular-file publication，skills使用 tree swap。replace在 Linux用 `renameat2(RENAME_EXCHANGE)`、
Darwin用 `renameatx_np(RENAME_SWAP|RENAME_NOFOLLOW_ANY|RENAME_RESOLVE_BENEATH)`，但分别经
file/tree public primitive而不是额外 path helper。`Paths.config`在恢复前后都直接交给既有
`loadConfig(Paths.config)`，必须保持 regular file。旧 generation在
`identity-verified`前一直由 marker exact持有，post-swap失败只拒绝 boot，不删除 proof；下次从
last durable phase幂等 resume或按 safety generation rollback。identity ambiguity、mount crossing、
missing old/new entry或 marker/digest不符进入 operator repair，绝不裸 `rm/cp`猜状态。

`snapshotFsStateForSafety`、cold restore、`applyPendingRestoreIfAny`、live stage/cancel、
`runSkillIdentityMigrationBarrier`、generic Skill recovery及旧 generation cleanup都消费该 broker
的 read/tree/entry capability；pre-migration与其它 backup只消费独立
`ArtifactBackupCapabilityV3`。source guard覆盖
restore/pendingRestore/skillIdentityMigration/backup/rawDbSnapshot/backupScheduler/
worktreeBackup/archive-retention paths；canonical roots、`.restore-upload`、
`.restore-pending`与 backup archive root下没有 `rmSync/cpSync/renameSync`豁免。恢复成功且
external obligation merger完成后，才按 entry kind分别通过 V3 `removeEntryExact`或
`removeTreeExact`删除 exact old generation、displaced file/tree与 marker。

失败与恢复只有一条状态机：

```text
prepared/applying
  ├─ final DB commit ───────────────────────────────→ committed
  └─ typed failure CAS + preserve exact receipts ──→ compensating
       ├─ strict reverse cleanup all proven absent ─→ failed
       ├─ cleanup error / daemon-alive owner loss ──→ compensating (retry)
       └─ legacy/corrupt identity cannot prove safe ─→ repair-required
```

- `IntentApplyCompensationCoordinator` 用 short transaction CAS
  `compensationClaimId/compensationClaimedAt`，再注册 daemon-local live claim。只有 matching
  claim可写 recovery code或 terminal。boot barrier在 HTTP listener、Plugin GC与周期 worker前
  把旧 daemon遗留的
  prepared/applying先以 exact journal CAS转为
  `compensating + intent-apply-daemon-restart`，把旧 compensation claim视为 lost并重领；
  daemon-alive周期扫描也把连续 grace scans不在 apply/compensation live registry的 exact
  prepared/applying转 compensating，并重领无 live owner的 compensation claim。两个 registry
  中的 live apply/cleanup都不按墙钟误杀。claim之后崩溃会从 receipt 0开始幂等 reverse
  cleanup，已经 absent的 artifact算成功；final DB commit与 journal committed同 transaction，
  state CAS保证 coordinator绝不补偿 committed row。
- `cleanupPluginGenerationByIdentity`先要求 writer为 reserved-without-GO，或
  quiesced且带 receipt-matching valid empty proof，再只删除 exact generation；删除前查询 current
  Plugin `cachedPath`、其它 unsettled v3 receipts与 coordinated live installs，任何引用/identity
  mismatch都 fail closed。它不按 `pluginId`遍历删除，不依赖24h generic GC；必须通过
  `ArtifactFsCapabilityV3.removeTreeExact`做 fd-walk/unlinkat，并从 anchored parent证明 exact
  name absent才返回 success。错误必须上抛/返回 typed failure，禁止 catch-and-ignore。
- `cleanupManagedSkillReserveStrict`从 identity重建 Skill root并验证 row仍
  `reserving`、active reserve op exact匹配；先严格删除 files/root，成功或已 absent后再在一个
  transaction删除 reserving row并 abandon exact op。文件删除失败时保留 row/op供下次重试；
  若通用 Skill boot recovery已完成同一 rollback，则“root missing + row/op absent”是幂等
  success；ready/published或 identity mismatch一律 repair-required，绝不删除。
- 所有 artifact cleanup success后，matching claim的 final transaction再次 strict parse v3
  receipt、确认每个 Plugin writer为 reserved-without-GO或带 valid empty proof的 quiesced、
  journal仍 `compensating`且没有引用残留，再写原 `errorCode/sanitized error`的 terminal
  `failed`、`artifactCleanupVerifiedAt=now`、清 claim/recoveryCode并广播。任何一项失败只更新
  allowlisted `recoveryCode`、释放 claim供周期重试；不删除 ledger anchor，不变成 failed。
- v1 `{kind:'plugin-install',pluginId}`没有 generation authority。migration/converger不得按
  plugin目录猜测；它进入 `repair-required`。现有保守 GC可独立回收确认未引用 generation；
  doctor/verifier只有在 canonical inventory证明该 plugin下没有 current ref、active install、
  v3 receipt所持或其它未引用 generation后，才把该 legacy obligation视为已清并完成原 typed
  failure。DTO只暴露 allowlisted repair code，不暴露 pluginsDir、generation id或 Skill path。
  既有 v1 terminal failed保持 `artifactCleanupVerifiedAt=null`，history必须标为“legacy cleanup
  unverified”，不能套用 v3 failed=已清理语义；committed显示 not-applicable。

### 0.6 Actor-safe mounts 与完整 DTO parse

detail route 按 mount 的 type/id 从六类资源表读取 actor-visible display projection，并批量解析
owner identity：

```ts
interface IntentMountDto {
  handle: string
  resourceType: AclResourceType
  resourceId: string // identity only; never primary UI label
  detail: boolean
  display: {
    name: string
    ownerUserId: string | null
    owner: OwnerIdentity | null
  } | null
}
```

资源已删除、actor 当前不可见或 owner row 不存在时 `display=null`；不返回未经授权的 name。
UI 主标签为 name，次行完整显示 type + owner（允许长 identity 换行），handle 放 technical
details。modify entry 在创建前按严格 typed `mountType/mountId` 调 actor-safe detail/list
resolver；失败时显示不可用并禁止带该 mount 创建，绝不把 query 中的 id/name当标签。

frontend 新增 `lib/intent-api.ts`：所有 list/detail/create/action response 先以 shared schema
对 `unknown` 做 `safeParse`。parse failure 转成不含 raw payload 的 `IntentContractError`；
detail 不建立 journey、owner gate、资源选择或任何 session mutation controls；list failure
只隔离最近会话 section，不阻断上方独立 Composer；create/action response failure保持该
attempt outcome unknown并走 exact receipt核对。不得把 `api.get<IntentSessionDetail>` 的
generic cast 当 runtime validation。

### 0.7 Create/manual session mutation 的 final gate

route 层的 actor-safe modify preview 只用于 UX，不能成为最终 ACL/active 证据。以下规则在
service 的同一个 `dbTxSync` 内完成；callback 禁止 `await`：

- create initial mounts：预生成 session/turn/ledger ids 后进入 transaction；逐项从
  `ACL_TABLES[type]` 读取 exact row并调用 `canViewResourceInTx`。任一 missing/invisible 以既有
  404 shape 回滚 session、ledger 与所有 turns，不能把 route 外旧结果写成 root；
- manual add：fresh 读取 session，验证 owner、`status==='active'`、
  `contextRevision===expectedContextRevision`、`inFlightTurnId===null`、
  `assertNoUnsettledApply`，再在 transaction 内验证 exact resource + ACL；
- manual remove/rebase：做同一组 session checks；remove 还必须验证 exact handle 仍是 root；
- session update 的 predicate 同时包含 id/owner/active/exact context/inFlight null，必须检查
  `changes===1`。SQLite transaction 内虽已串行，这个 CAS 仍是防未来 refactor 漂移的可测试
  choke point；
- cancel 用 `expectedInFlightTurnId` fresh 读取 exact row；queued turn 可直接 terminal settle，
  live turn 只 signal matching claim/controller。旧 cancel 不能杀后来 turn；
- response loss 后，manual actions 仍按 §10 只描述目标状态；expected revision 允许同一 request
  至多改变一次 epoch，但不是 durable receipt。

## 1. 创建入口

### 1.1 单一业务组件

新增 `components/intent/IntentCreateComposer.tsx`：

```ts
type IntentArtifactHintChoice = 'auto' | IntentArtifactHint

interface IntentCreateContext {
  mode: 'create' | 'modify'
  initialHint: IntentArtifactHintChoice
  mount?: {
    resourceType: IntentArtifactHint
    resourceId: string
  }
}

interface IntentCreateComposerBaseProps {
  context: IntentCreateContext
  capabilities: IntentComposerCapabilitiesDtoV3
  onCreated: (session: IntentSessionSummary) => void
  initialFocusRef?: RefObject<HTMLTextAreaElement | null>
}

type IntentCreateComposerProps =
  | (IntentCreateComposerBaseProps & { variant: 'inline' })
  | (IntentCreateComposerBaseProps & {
      variant: 'dialog'
      open: boolean
      onCancel: () => void
      triggerRef?: RefObject<HTMLElement | null>
      restoreFocusFallbackRef: RefObject<HTMLElement | null>
    })
```

`validateIntentSearch` 可以继续接受 URL 上的 string，但进入组件前必须经
`normalizeIntentArtifactHint(search.hint)` 收紧为 shared allowlist + local `auto`；未知/空值都回落 `auto`，
不能出现控件显示 Auto、POST 却发送 URL 原始 hint 的分叉。`IntentEntryButton.hint` 同批收紧为
`IntentArtifactHint`。

组件拥有 `message/hint` 表单态和 create mutation。两种 variant 都渲染真正的
`<form onSubmit>`；dialog variant 由同一组件组合公共 `Dialog`，footer submit button 通过
稳定 form id 触发该 form。`Cmd/Ctrl+Enter` 调 `requestSubmit()`，不能维护第二条提交路径。
`buildIntentCreatePayload` 是导出的纯函数：

```ts
function buildIntentCreatePayload(
  clientMutationId: string,
  message: string,
  hint: IntentArtifactHintChoice,
  mount?: IntentCreateContext['mount'],
  preSessionSourceGrant?: string,
): CreateIntentSession {
  return {
    clientMutationId,
    message: message.trim(),
    ...(hint === 'auto' || mount !== undefined ? {} : { hint }),
    ...(mount === undefined ? {} : { mounts: [mount] }),
    ...(preSessionSourceGrant === undefined ? {} : { preSessionSourceGrant }),
  }
}
```

约束：

- `message.trim()===''` 时 CTA disabled。
- `TextArea.maxLength=INTENT_MESSAGE_MAX`，显示本地化字符计数（接近上限时提升），continue
  Composer 使用同一上限；不等 422 后才告诉用户超长。
- create模式在首次 submit前、modify模式在首次 capability resolve前生成一次
  `clientMutationId`。modify resolve与最终 create共用该 id，grant bytes也进入唯一 normalized
  body/HMAC并随 payload一起冻结；不允许在 submit时偷偷换 attempt/grant。组件私有 attempt state
  在响应丢失时只重放同一 payload/id。服务端 create get-or-create receipt 后，成功或 exact
  replay 都返回同一 session；不同 payload 复用 id 是 definitive error。
- mutation pending 时目标输入、类型卡、示例、取消/关闭和 CTA 全锁；Dialog 同时
  `dismissDisabled=true`，避免请求已发出却丢失导航结果。
- mutation 成功后先通知 `onCreated`；route 用真实 response 更新/失效 list cache，先
  replace 清 ephemeral search，再立即导航详情，不等待 list refetch 才让用户离开。
- API error 就地保留 message/hint，并按 §10 分类：definitive 4xx 可修正后生成新 id；
  transport/5xx/unknown 保留 frozen payload，提供「核对/重试同一次创建」，不能生成第二 id。
- `Cmd+Enter` 或 `Ctrl+Enter` 仅在目标 textarea 聚焦、composition 已结束、
  `message.trim()!==''` 且 mutation 非 pending 时触发与按钮相同的 submit；普通 Enter 仍换行。
- page/dialog在 composer可交互前 strict POST/parse
  `/api/intent-sessions/capabilities/resolve`（route注册在 `/:id`之前）。inline传
  `{kind:'create'}`；modify先冻结 id，再传 exact
  `{kind:'modify',resourceType,resourceId,clientMutationId}`。malformed/unknown response不得乐观
  启用 Plugin；invisible target同形不可用。inline历史列表仍可独立显示。选择、URL hint或快捷
  入口若指向 disabled type，保留可见选项并聚焦其 reason，不静默回落 Auto，也不发 create。
- generic Darwin create不返回 grant且 Plugin disabled。Darwin exact file-Plugin modify只有拿到
  actor-safe pre-session grant才启用；grant过期/目标漂移的 definitive pre-accept error保留用户
  文本、清除该未 accepted attempt并重新 resolve。transport/5xx或未知 create outcome仍冻结原
  id/body重放，不能因为 grant时间过去而猜请求未被接受。

### 1.2 Inline 形态

`/intent` 页面结构：

```text
PageHeader
  Intent Builder
  “从目标开始；不必先决定要建哪些资源”

IntentCreateComposer.inline
  [目标 textarea ..........................................]
  [示例 1] [示例 2] [示例 3]        (only while empty/create)
  产物偏好（可选）
  [AI 判断] [Agent] [Skill] [MCP] [Plugin] [Workflow] [Workgroup]
  ✓ 只生成草稿；复核提交前不会修改任何资源     [生成第一版]

最近会话
  [session link card]
```

页面头不再放第二个「新建」按钮。已有会话不会折叠 Composer：Intent Builder 的首要任务就是发起
新意图；历史列表是次级内容。Composer 外层使用 `<section aria-labelledby>`，内部是真正的
`<form>`，不是可点击大卡。

### 1.3 示例

新增三条双语静态文本，覆盖不同认知入口而非绑定固定资源：

1. 「构建一个实现 → 按文件审计 → 修复的工作流」
2. 「组建一个会分工、汇总并向我确认的工作组」
3. 「创建一个专注安全审计、输出结构化发现的 Agent」

行为锁：

- 仅 `mode=create && message.trim()===''` 渲染。
- 点击后 `setMessage(example)` 并把焦点移到 textarea 尾部；绝不调用 mutation。
- 一旦输入非空，示例区退出布局，避免点击覆盖用户文字；清空后重新出现。
- modify 入口永不显示，避免把通用模板与明确目标混在一起。

### 1.4 产物选择

复用 `ChoiceCards` 与 `ResourceIcon`，新增 `.intent-create__types` 业务 class 调整为紧凑网格。
`auto` 使用一个与现有 inline SVG idiom 一致的 sparkle `intent` icon；它同时替换 sidebar
目前借用的 workflow glyph。`components/icons/resourceIcons.tsx` 只做向后兼容新增 key，
其余六项复用既有图标。

桌面 4 列、≤720px 2 列；卡片只显示 icon + label，不放七段重复描述。字段上方一条 hint 说明
这是弱提示，AI 仍会按目标补充关联资源。每项同时消费 strict host capability：

- supported：正常 radio choice；
- unsupported：仍展示 icon/label和短 reason badge，但用原生 disabled/`aria-disabled`语义，
  不进入 roving selection，reason以 `aria-describedby`关联；
- Darwin Plugin reason明确“当前 host不支持由 Intent安装 npm/git Plugin；可在 admitted Linux
  host完成，或从 Plugin管理页显式选择已有 file source”，不能只写笼统“出错”；
- Auto始终可选，但受信 model capability会阻止它绕过 disabled type。Review仍重验 drift。

modify context 不渲染 radiogroup，改为：

```text
[resource icon] 正在修改 Workflow
已在第一轮生成前挂载此资源；原件是否直接修改仍在复核阶段逐项决定。
```

由 §0.6 actor-safe resolver 显示资源 name + owner；加载中显示类型骨架，404/contract failure
显示「目标不可用」并禁止创建。raw id 只可放 technical details，不能进入主标签，也不得从
不可信 query 注入 name。

### 1.5 Search 与 Dialog 生命周期

`IntentSearch` wire 保持 `create/hint/mountType/mountId`。route 用 `search.create===true` 作为
Dialog open 的权威，而不是 `useState(initialValue)`：

- inline Composer 永远以 `{mode:'create',initialHint:'auto'}` 独立初始化；search hint/mount
  只属于 `create=true` 的 dialog，不能在 Dialog 关闭时暗改 inline 草稿。
- 打开：资源入口导航到同一 search，Dialog 随 search 渲染。
- 关闭/成功：`navigate({to:'/intent', search:{}, replace:true})` 清除 ephemeral search；
  focus 由 `Dialog.triggerRef` 恢复。若跨 route 触发按钮已卸载，fallback 是 inline textarea。
- browser back/forward 只按 URL 决定开闭，消除 local state 与 URL 分叉。
- `/intent` 页面自己的 inline Composer 不通过 search 打开 Dialog，也不与 Dialog 共享未提交
  message。

`IntentEntryButton` 增可选 `triggerRef` 透传不是必要条件；现有按钮在跨 route 后会卸载，
Dialog 使用 `restoreFocusFallbackRef` 指向 inline textarea。列表页本地打开场景若未来出现，
仍可传 triggerRef。

## 2. 最近会话

新增 `components/intent/IntentSessionList.tsx`。HTML 为
`<section><h2><ul><li><Card to=... params=...>>`：

- title：会话标题，可两行 clamp；`title` attribute/可访问文本保留全文。
- header-right：running / active / archived `StatusChip`。
- body meta：轮次、提交次数、`RelativeTime`；不得从 title 猜产物类型。
- running card 允许 info-tinted border，但整卡仍只有一个 link，内部无嵌套按钮。
- 公共 `Card` 当前没有转发 TanStack `params`；为 link card 增一个向后兼容 `params` prop 并
  直传 `Link`，补公共组件测试，不手写第二套 card shell。
- 空列表用 `EmptyState size="compact"`，文案只说明「新会话会出现在这里」，不再含第三个创建
  CTA。list loading/error 也只占该 section；不能让历史 query 阻塞上方 Composer。

`TableViewport` 与 `shouldRowNavigate` 从本 route 删除，API/query/WS invalidation 不变。

## 3. 当前循环状态

### 3.1 唯一纯函数

新增 `lib/intent-journey.ts`：

```ts
type IntentJourneyKind =
  | 'generating'
  | 'clarifying'
  | 'review-ready'
  | 'review-blocked'
  | 'applying'
  | 'applied'
  | 'error'
  | 'idle-active'
  | 'archived'

interface IntentJourneyState {
  kind: IntentJourneyKind
  step: 0 | 1 | 2 | 3 // Goal / Generate / Review / Apply
  completedThrough: -1 | 0 | 1 | 2 | 3
  reason?:
    | 'stale'
    | 'validation'
    | 'turn-error'
    | 'commit-error'
    | 'commit-compensating'
    | 'commit-repair-required'
    | 'awaiting-next-message'
  latestCommitState?:
    | 'prepared'
    | 'applying'
    | 'compensating'
    | 'repair-required'
    | 'committed'
    | 'failed'
}
```

输入只取已通过 `IntentSessionDetailSchema` 的 detail。先通过纯 helper 分别选权威
`latestTurn`、`latestAgentTurn`、`latestCommit`：

- turn 按 `(seq, id)` 最大值选，虽然当前 backend 已按 `seq` 返回，状态推导仍不用
  `turns.at(-1)` 把数组位置当判据；timeline 展示继续逐项保持 response 顺序；
- commit DTO 已由 server 按 `attemptSeq ASC` 返回；helper 仍验证严格递增/唯一，失败即把
  detail 判为 contract error而不是 fallback 到时间戳。latest 取最大 attemptSeq；
- current-draft apply failure只按 `commit.draftId===currentDraft.id` 关联，不比较客户端/服务端
  墙钟；history 不原地 mutate query cache。

随后按以下优先级固定：

1. `session.status==='archived'` → `archived`（只读事实最高）。
2. 任一 commit 为 `prepared|applying|compensating|repair-required` → `applying`；正常
   invariant至多一个，多个时另显示 contract warning并 fail closed。reason分别区分正在应用、
   正在逆序清理与需要管理员修复；后两者绝不投影成 terminal commit error。
3. `session.inFlight===true` → `generating`。
4. `latestAgentTurn.kind==='questions'` 且它仍是服务端可答 source → `clarifying`。
5. `currentDraft!==null`：
   - `stale || validation.errors.length>0` → `review-blocked`（reason 精确区分）；
   - 否则，最新 commit 为 `failed` 且 `commit.draftId===currentDraft.id` →
     `error/commit-error`；这是对当前 draft 的 Apply 失败，draft 仍留作修正；
   - 否则 → `review-ready`。
6. `latestTurn.kind==='error'` → `error/turn-error`。
7. 最新 commit 为 `committed` → `applied`。
8. 其余 active → `idle-active`。

说明：

- reservation transaction 保证 generation-starting response 返回时已同时存在 running/error
  agent turn；若 detail 出现“最新 generation request anchor 后没有 generationTurnId”则是
  contract corruption，fail closed，不再用 10 秒本地 heuristic 猜 awaiting-start。
- currentDraft 高于历史 turn error/旧 commit；只有相同 `draftId` 的 failed commit 是当前 Apply
  失败。新 draft identity 与旧 failure 天然分离。
- `applied` 只是当前循环结束，不归档会话；发送下一条调整后按第 3 条回到 generating。
- UI 任何位置不得自行重复上述分支。

`step/completedThrough` 不是组件自行猜测，按表返回：

| kind                          |                         `step` | `completedThrough` | 轨道语义                             |
| ----------------------------- | -----------------------------: | -----------------: | ------------------------------------ |
| generating / clarifying       |                              1 |                  0 | Goal done，Generate current          |
| review-ready / review-blocked |                              2 |                  1 | Review current；blocked 另带 warning |
| applying                      |                              3 |                  2 | Apply current                        |
| applied                       |                              3 |                  3 | Apply completed，本轮结束            |
| error + turn-error            |                              1 |                  0 | Generate error                       |
| error + commit-error          |                              3 |                  2 | Apply error                          |
| idle-active                   |                              0 |                 -1 | 等待下一条 Goal                      |
| archived                      | 继承忽略 status 后的 base step |          继承 base | 全轨只读 paused，不设置 aria-current |

archived 仍是最高 kind；“继承”只保留归档前所处阶段的展示信息，不会让底层状态变成可操作。

### 3.2 阶段轨

新增业务组件 `IntentJourneyProgress`，渲染非交互 `<ol>`：

```text
Goal ─ Generate ─ Review ─ Apply
```

每项为 `done/current/todo/blocked`，当前项带 `aria-current="step"`；不是按钮，不复用交互式
`Stepper`。阶段轨下方显示单行状态：

- generating：正在生成草稿
- clarifying：等待你的回答
- review-ready：草稿已就绪，请复核
- review-blocked：需先解决 stale/validation
- applying：正在应用、撤销未完成 artifact，或等待管理员修复；结算前不可重复提交
- applied：本轮已提交，可继续调整
- error：本轮生成/应用失败，可在时间线处理
- idle-active：输入下一条目标开始新一轮
- archived：已归档，只读

CSS 只用颜色之外再提供 check/current dot/warning icon，满足非颜色判别。`prefers-reduced-motion`
下不运行进度动画；初版不需要动画。

detail query 在 `session.inFlight`、任一 apply
`prepared|applying|compensating` 或本页 commit `outcome-unknown` 时以 1.5s refetch；
`repair-required` 以 30s低频 refetch并显示管理员修复说明；其余实时变化依赖 WS
invalidation/reopen reconcile。
runtime/config/budget 的 pre-spawn failure 直接是时间线 terminal error，可按原
`clientMutationId` receipt核对并从该错误 card 发起带新 id/expected seq 的 Retry。

## 4. 会话详情信息架构

### 4.1 桌面线框

```text
┌ title + status ─────────────────────── Cancel / Refresh ┐
│ Goal ───── Generate ───── Review ───── Apply             │
├────────────────────────────┬─────────────────────────────┤
│ Conversation               │ Review workspace            │
│ [mounted context chips]    │ Draft revision + validation │
│                            │                             │
│ user message          ◉    │ [op card + rich preview]    │
│ ◉ Builder reply            │ [op card + rich preview]    │
│ ◉ questions / error        │                             │
│ ◉ generating               │ [stable review action bar]  │
│                            │                             │
│ [continue adjusting......] │ Commit history              │
└────────────────────────────┴─────────────────────────────┘
```

`.intent-session__workspace`：

```css
grid-template-columns: minmax(320px, 0.9fr) minmax(480px, 1.1fr);
align-items: start;
```

当可用内容宽度 ≤1080px 时单列。DOM/读屏顺序永远是 progress → conversation → review；
CSS 不能把右栏视觉移动到 DOM 前。页面保持唯一主滚动，不给两栏各造滚动容器。

### 4.2 PageHeader

- title 两行 clamp/自然换行，不能把长 title 撑出 viewport。
- meta 显示 session status + 当前 journey 状态摘要。
- `isAuditView = detail.session.ownerUserId !== undefined`（detail endpoint 只在 actor 不是 creator
  时返回该字段）；统一 `canMutate = !isAuditView && session.status==='active'`。所有 mutation
  入口都消费这一个 gate，不能只靠 endpoint 404。
- `hasUnsettledApply = commits.some(state is
prepared|applying|compensating|repair-required)`；DTO 已按 attemptSeq 验证，WS每次
  transition/terminal invalidation + unsettled poll 让跨 tab gate及时更新；
  `canStartSessionWrite = canMutate && !session.inFlight && !hasUnsettledApply`。answers/
  approvals/retry/rebase/mount add/remove 用它；Cancel generation 单独要求
  `canMutate && session.inFlight`，request 必须携 detail 的 exact `inFlightTurnId`，服务端不得
  取消后来启动的新 turn。
- `hasPendingDecision` 只来自当前 source agent turn 的 safe-parsed unanswered questions 或尚未
  reconcile 的 mount requests。`canAdvanceIntent = canStartSessionWrite && !hasPendingDecision`；
  Continue message 与 commit 用它，mount approval/manual mount 自身仍用
  `canStartSessionWrite`，避免 gate 把解决 gate 的动作也锁死。
- actions：
  - owner-active + inFlight：Cancel generation（pending 锁、错误就地）。
  - `canStartSessionWrite`、current draft 非 stale，且 local `ApiError.code` 或相同 draft 的
    latest failed journal `errorCode` 为 `intent-baseline-stale`：显示「刷新上下文」；
    不从任意 error 文本恢复状态。POST rebase 携 `expectedContextRevision`；成功后
    当前 draft 会 stale，清 commit attempt、聚焦 Continue Composer，并明确要求使用者发送
    调整消息生成新版。普通 `draft.stale` 不显示 Rebase。
  - archived/admin audit：只显示本地化只读说明，无 Cancel/Retry/Rebase。
- Header 下集中呈现 cancel/rebase mutation errors，不能把失败塞进按钮 tooltip。
- 删除当前用于消除 unused navigate 的隐藏 `<span>`；route 不再导入无用 `useNavigate`。

## 5. Conversation

### 5.1 时间线投影

新增 `projectIntentTimeline(turns)` 纯投影，而不是让孤立的 turn 猜上下文。它按 response 顺序
一次扫描，safeParse 每种结构化 content，并把最近一次 preceding questions map 传给 answers：

- `message`：角色气泡；用户靠右轻 accent，Builder 靠左 panel；正文复用 `ClampedText`
  （默认 8 行，可展开/收起，全文仍在 DOM），不能对 16KiB message 硬裁切。
- `answers`：用 `PostIntentAnswersSchema.safeParse({answers:content.answers})`；从该 turn 之前最近
  一组合法 questions 按 id 显示问题标签 + 选择值。question id 跨轮复用时不能拿未来/全局
  label；shape 不可识别时显示本地化「已提交回答」，禁止 `JSON.stringify`。
- `changeset`：Builder event card，summary + op count + 「查看草稿」锚点（仅 current draft 存在）。
- `questions`：summary；仅当它是最新 agent questions 且 session 非 inFlight 时嵌入可操作答题表单，
  历史 questions 只读。
- `error`：danger event，code + allowlisted 安全诊断字段；Retry 仅 owner-active 的最新可重试
  错误显示。
- `mount-approval/running`：按现有 content 投影为 system event；不得因当前 route 未专门处理而
  静默空卡。

每个 turn 是 `<li>`，timeline 是 `<ol aria-label>`。角色 icon、名称、turn kind 与时间同一
meta 行；长文本 `overflow-wrap:anywhere`。不改变 `detail.turns` 顺序，也不做客户端合并。

### 5.2 Pending questions

`pendingQuestions` 只来自 detail 中服务端仍认可为 unresolved source 的最后一个 agent turn。
问答 state 是
`{sourceTurnId, expectedTurnSeq, clientMutationId, values: Record<questionId,string[]>}`，
而不是跨轮持久的 question-id map：

- `content.questions` 先经 `IntentQuestionsSchema.safeParse`；失败时只显示不可操作的本地化
  system event，不 `as`-cast、不把未知结构带入 answers request；
- source turn 之后一旦已有 user `message|answers` 或不属于该 source 的 turn，该 question card
  只读并隐藏 controls；属于同 source 的 mount-approval receipt 不会复活/替换 source，只让
  answers 进入下一阶段；
- source agent turn id 变化时清空旧 values；同一 turn mutation 失败保留，不能因模型复用
  `q1` 把上一轮答案预选到新问题；
- feature-scoped `IntentQuestionOptions` 对单选渲染纵向原生 radio group，对多选渲染纵向
  checkbox group；复用 `Field(group)`，每个 input 都有可点击 label，2–4 个最长 512 字符的
  option 自然换行。`Segmented` 的 `white-space:nowrap` 只适合短模式标签，禁止用于本 wire；
- multi toggle 维护去重且按原 `question.options` 顺序输出 `picked`。不把选项藏进 searchable
  `MultiSelect` popover，也不把单选 `ChoiceCards` 错扩成多选；
- 全题有答案才允许 Submit；submit 时冻结 answers、source、expected seq 与 id。服务端在一个
  transaction 内复验 source 后预留 generation turn；definitive
  `intent-source-superseded/intent-turn-seq-mismatch` 清除旧 form并聚焦当前 source。
- transport/5xx 只以同一 body/id replay；server 返回原
  `IntentGenerationReceipt`，不能从 matching answer text 猜 applied。成功/receipt replay 后
  才清 answers并 invalidate；journey 由 reserved running turn 自动转 generating。

### 5.3 Agent mount requests

`IntentTurnDto.content` 在 detail wire 上只是 unknown record；前端必须对
`content.mountRequests` 调 `IntentMountRequestsSchema.safeParse`，不能因 producer 当前已经
校验就 `as`-cast。解析失败时渲染本地化的不可操作 system event，并将该字段当作无有效建议，
不能显示半可信资源选择控件或阻断同轮合法 questions。解析成功时得到
`{resourceType,name,reason?}[]`。新增 `IntentMountApprovalCard`，只让**最新 agent turn** 的
有效建议可操作：

- 先按 `(resourceType,name)` 去重且保持首次出现顺序；重复项显示合并计数/首条 reason，只产生
  一个决定。UI 与 server 使用同一 shared normalizer；key/state 均包含 `sourceTurnId`，
  agent turn 变化立即丢弃旧 decisions。
- source turn 之后已有 user `message|answers` 时建议只读，不再接受迟到审批。
- 每条建议显示 ResourceIcon、type、name、reason。
- `Approve` 展开与 request type 固定的 `ResourcePicker`；候选仍来自现有六类 list endpoint，
  并按 `row.name===request.name` 精确过滤。使用者必须在 actor-visible 同名候选中选一个具体
  resource id；该受控 picker 将 `value` 限为 0..1，`onChange` 只保留最后明确选择项，不能把
  通用 `ResourcePicker` 的 multi-value 能力泄漏为「一次批准多个资源」。同名多 owner 不自动
  猜。已在 `detail.mounts` 的 exact candidate 仍形成显式 approve decision，由 server receipt
  记录 `already-mounted`；不能在客户端静默删掉决定。没有可见精确候选时只能 Reject 或另走
  Add mount。
- `Reject` 记录 `{resourceType,name}`；默认 undecided。
- 主行动只有在每条建议都 approve/reject 后可用。
- POST §0.4 的 source-bound body；request name 同时是 source request identity 和服务端
  transaction 的精确 name fence，但 resource id + fresh ACL 才是授权依据。

若最新 turn 同时有 questions：

1. 页面呈现一个统一「提交决定并继续」行动；
2. action 前 refetch 并冻结 `sourceTurnId/expectedTurnSeq/decisions/clientMutationId`；
3. POST mount-approvals。2xx 或 same-id replay先经
   `IntentMountApprovalReceiptSchema.safeParse`；receipt top-level request identity必须等于 frozen request，
   `results`必须按 source顺序逐项等于 frozen decision，approve项还须 exact resourceId；
4. receipt 确认后只以其 `resultingTurnSeq` 作为 answers 的新 `expectedTurnSeq`，冻结 answers
   id/body再 POST；禁止从 refetch时的 session seq或数组位置替代。answers 才 reserve/fire
   下一轮；
5. mount-approvals definitive 4xx 证明 transaction 零副作用；source/seq conflict 丢弃旧
   state。transport/5xx 只 replay 同一 frozen body/id，由 ledger fingerprint证明 exact，不发
   answers；
6. 第一步 receipt 已 committed、第二步失败时保留 answers，仅 replay answers id；不再重发
   approval batch。

前端不从 mounts、文本、source 后任意 history 猜 batch。权威证据只有当前 HTTP receipt或
detail 中 strict-parse成功且 `clientMutationId/sourceTurnId/expectedTurnSeq` 完全相同的
`mount-approval` receipt；外层 turn id/seq还必须分别等于
`approvalTurnId/resultingTurnSeq`。outer/turn content parse或逐项 comparison失败保持 fail
closed并零 answers POST。

若只有 changeset + mountRequests，审批独立完成，不自动发新一轮：reject-only/already-mounted
不改变 epoch，当前 draft 仍可复核；任一新 approve 让 context revision 只 +1、当前 draft
立刻 stale，必须用 Composer 明确要求基于新挂载生成新版，不能继续 commit 旧 draft。
`mount-approval` history 以 resource name/type/owner、decision 与 handle 的可读 receipt 呈现。

### 5.4 Mounted context

挂载从独立 section 提升到 conversation 顶部 context strip：

- 每个 mount 为不可编辑 identity chip：ResourceIcon + actor-safe name 为主行，type + 完整 owner
  为次行，长 owner `overflow-wrap:anywhere`；handle 只在 expandable technical detail。
- `display=null` 时主行显示本地化「资源不可用」，type + handle 为次级证据；绝不回退 raw
  resource id或旧缓存 name。
- unmount 是具名小按钮，仅 `canStartSessionWrite`；不能只显示无 accessible name 的 `×`；
- Add mount 复用并**修改** `IntentMountDialog`：picker 限单项，route/父组件拥有 mutation；
  组件接 `canSubmit/disabledReason/onSubmit(ref)`，不再内部循环 POST。submit 前冻结
  `expectedContextRevision`；dialog 打开后 gate 变化时锁 input/CTA并显示原因，pending 锁关闭。
- backend 不信任该 picker/refetch 的 ACL 或 active snapshot：add/remove 的 final service按
  §0.7 在同一个 `dbTxSync` 复验 owner/active/exact revision/inFlight/unsettled；add 再调用
  `canViewResourceInTx`。archive、撤权、visibility change 或 delete 穿过 route read 时写入为
  404/409 且 epoch 不变。
- manual mount transport/5xx 后先 refetch：exact type/id 已成为 root时只说明“目标状态已满足
  （可能由并发操作完成）”并关闭；未出现则保持 outcome unknown。相同
  `expectedContextRevision + ref` 的显式 replay至多一次生效，duplicate/seq conflict触发 refetch；
  不把 contextRevision 增长冒充本 request receipt。
- 空挂载显示一句弱提示，不占一整个空 section。

handle 是 RFC-234 会话内技术句柄，可显示但不承担人类身份；raw resource id 不显示。

### 5.5 Continue composer

Composer 放在 conversation 尾部的独立 `Card`：

- 仅 owner-active 渲染 form；admin audit 与 archived 都只显示说明。
- `!canAdvanceIntent` 时禁用并显示精确原因：pending decision → 跳到当前 question/request，
  inFlight → 等待/取消，unsettled apply → 等待 settlement；不能只给 disabled 按钮。
- `Cmd/Ctrl+Enter` 规则与创建 Composer 一致。
- send 时冻结 `clientMutationId/expectedTurnSeq/message`；transport/5xx 只重放 exact body/id，
  由 ledger fingerprint证明 exact。success 或 replayed `IntentGenerationReceipt` 后才清空；
  不能按更高 seq + 相同文本认领另一个 tab 的 message。
- 始终 normal flow，不做 sticky/fixed，避免移动键盘与长 error 叠层。turn 数 >5 时 conversation
  heading 提供原生「跳到当前」anchor，目标是 pending question/error/generating/composer 中当前
  可操作项；不是第二个提交按钮。

### 5.6 Intent turn 的统一 Session 执行视图

本节落实用户新增要求：Intent agent turn必须能展开与任务节点 Session相同的执行过程。复用边界
是已经稳定的 shared projection与 renderer，不是把 task-only 外壳整体复制过来：

```text
runtime stdout / private session store
  └─ RuntimeDriver.parseEvent + shared capture adapters
     └─ SessionEventSink
        ├─ NodeRunSessionEventSink   → node_run_events (既有)
        └─ IntentTurnSessionEventSink → intent_turn_events (新增)
           └─ parseSessionTree (既有 shared pure parser)
              └─ SessionViewResponseSchema (既有 shared DTO，收紧 strict)
                 └─ SessionConversationPanel (抽取 query/loading/error 外壳)
                    └─ ConversationFlow + SubagentBlock (原样复用 renderer)
```

`SessionTab`不是通用 renderer：它还拥有 task/node attempts、fanout grouping、
`InjectedMemoriesCard`与`RuntimeInventorySection`。这些概念在 Intent turn不存在，不能为了“看起来
一样”伪造 attempt或 inventory。实施时只把当前私有 `SessionBody`抽成：

```ts
interface SessionConversationPanelProps {
  readonly queryKey: readonly unknown[]
  readonly load: (signal: AbortSignal) => Promise<unknown>
  readonly pollMs?: number | false
  readonly className?: string
}
```

`SessionConversationPanel`必须对 `unknown`运行
`SessionViewResponseSchema.safeParse`，统一呈现 compact loading、`session.loadError`与
`ConversationFlow`；不接 task id、node run id、intent turn id等业务标识。Task `SessionTab`继续
在外层组装 attempts/inventory，Intent只在自己的 turn card里组装 disclosure。

#### 5.6.1 持久事件与 capture state

不能把 Intent event塞进`node_run_events`：该表的`node_run_id`是 required FK，伪造 node run会
污染 task生命周期、归档、stuck detector与metrics。next ordered migration新增：

```text
intent_turn_events
  id                    INTEGER PRIMARY KEY AUTOINCREMENT
  turn_id               TEXT NOT NULL FK intent_turns(id) ON DELETE CASCADE
  event_seq             INTEGER NOT NULL
  ts                    INTEGER NOT NULL
  kind                  TEXT NOT NULL
  payload               TEXT NOT NULL
  session_id            TEXT NULL
  parent_session_id     TEXT NULL
  source                TEXT NOT NULL  -- stream | live-child | post-run-child
  external_event_id     TEXT NULL      -- runtime part id for exact dedupe
  UNIQUE(turn_id,event_seq)
  UNIQUE(turn_id,source,external_event_id) WHERE external_event_id IS NOT NULL
  INDEX(turn_id,event_seq)
```

`intent_turns`增加：

```ts
interface IntentTurnExecutionProjectionV1 {
  readonly captureState: 'live' | 'complete' | 'truncated' | 'incomplete'
  readonly lastEventSeq: number
  readonly eventBytes: number
  readonly rootSessionId: string | null
  readonly incompleteReason:
    | null
    | 'stream-persist-failed'
    | 'child-capture-failed'
    | 'post-exit-flush-timeout'
}
```

非 agent turn投影为`execution:null`；agent turn从 reservation开始为
`{captureState:'live',lastEventSeq:0,...}`，不能等首个 runtime event后才让 UI知道入口存在。
`IntentTurnDtoSchema`加入 strict nullable execution summary，但 detail仍不内嵌 event payload，
避免每次 session refetch重复搬运全部日志。

每 turn硬上限为`10_000` rows与`8 MiB` UTF-8 payload（两者先到者生效）。写下一条将超限时，
在同一 transaction把`captureState='truncated'`及最后成功 seq持久化，之后停止观测写入但继续
system agent的 envelope accumulator与业务 settlement；UI显示“执行过程已截断”，不能把它显示成
agent失败。payload继续沿 runtime event原始格式存储，DB writer按 UTF-8 bytes而非 JS char计数。

#### 5.6.2 `runSystemAgent` event/capture seam

`SystemAgentRunOptions`新增仅负责观测的 sink：

```ts
interface SystemAgentEventSinkV1 {
  append(event: {
    readonly ts: number
    readonly kind: NormalizedEventKind | 'text' | 'stderr'
    readonly payload: string
    readonly sessionId: string | null
    readonly parentSessionId: string | null
    readonly source: 'stream' | 'live-child' | 'post-run-child'
    readonly externalEventId?: string
  }): Promise<void>
  setRootSessionId(sessionId: string): Promise<void>
  markTerminal(
    state: 'complete' | 'truncated' | 'incomplete',
    reason?: IntentTurnExecutionProjectionV1['incompleteReason'],
  ): Promise<void>
}
```

stdout line仍只由 exact runtime driver的`parseEvent`解释。`readStream`改为 awaited async line
consumer，与现有 task runner逐行 await DB insert的顺序一致；recognized event写其 normalized
kind/raw line/session id，non-JSON fallback写`text`，stderr只写 credential-masked line。sink内部
用 per-turn short transaction分配`event_seq=last+1`并更新 summary；同一 turn只允许一个有序
writer，live/post-run child通过同一 queue串行，不能各自计算 seq。

现有 OpenCode/Claude capture实现把“读 runtime store + 翻译成 session event”从
“写`node_run_events`”中抽开，接 generic sink；node adapter维持现有行为，Intent adapter写新表。
OpenCode `startLiveCapture?`同样只依赖 sink/getRootSessionId/onInsert，Intent可在 root session id
出现后显示 live child，Claude无 live capability时走 post-run capture。不得复制一套
Intent-specific OpenCode/Claude parser。

退出顺序固定为：

```text
child reaped
→ stdout/stderr bounded flush
→ driver.captureSessions(rootSessionId, generic sink)
→ sink mark complete/truncated/incomplete
→ plan.cleanup / private session store release
→ Intent envelope parse and business settle
```

post-run capture必须发生在`plan.cleanup`删除 private store之前；unreaped路径不得读取可能仍被
writer持有的 store，直接标`incomplete`。stream/capture sink异常被 allowlisted、mask后写
`incompleteReason`（若 DB本身不可写则记录日志并由后续 detail根据未终结 live state显示
incomplete）；它不改变`SystemAgentRunStatus`、questions/changeset/error选择或 draft。反过来，
业务 envelope invalid也不删除已经捕获的执行证据。

#### 5.6.3 Read API、授权与实时刷新

新增：

```http
GET /api/intent-sessions/:sessionId/turns/:turnId/session
```

route先以现有 Intent detail read scope解析 session：creator owner可读；只有现有明确允许的
system-admin audit actor可只读审计；普通 foreign、manager与不存在都返回同形
`intent-session-not-found`。授权完成后再验证`turn.id=turnId AND
turn.sessionId=sessionId AND turn.role='agent'`；foreign/cross-session turn不形成 oracle。user turn
或无 execution projection返回 typed 410 `intent-turn-session-not-applicable`。

service按`event_seq`读取 rows，映射成既有`ParseSessionInputEvent`并调用`parseSessionTree`。
outer Intent timeline已经显示触发它的用户消息，所以这里`promptText=null`，不伪造
`Read INTENT.md`为人类输入；`startedAt=turn.createdAt`，
`primaryAgentName=aw-intent-builder`。response先过收紧后的 strict
`SessionViewResponseSchema`；capture meta只来自 turn summary，用于显示 live/truncated/incomplete，
不把 scratch path、runtime store path或 credential诊断带上 wire。

WS新增`intent.turn.execution.updated {sessionId,turnId,eventSeq}`，只发 locator与单调 seq，
不广播 raw payload。backend对同 turn最多500ms一次 leading+trailing通知；frontend只 invalidate
exact session query key。展开的 running turn在WS断线或没有新帧时以1.5s polling兜底，terminal后
停止；collapsed turn不发 query。out-of-order/duplicate seq只触发幂等 refetch，客户端不拼 event。

#### 5.6.4 Turn card交互与响应式

每个 agent turn在既有 summary正文后提供“执行过程” disclosure：

- 最新`running` turn首次出现时默认展开；历史/terminal turn默认折叠。展开状态按`turnId`保留，
  用户手动收起后普通 refetch不得强行打开；新的 running turn才获得一次默认展开资格。
- summary同时显示 live/complete/truncated/incomplete chip与 event count；只用状态色不够，
  必须有文字/icon。`incomplete`显示“业务结果不受影响，执行记录不完整”。
- toggle用原生`button` + `aria-expanded/aria-controls`，Enter/Space可操作；内容加载失败只留在该
  disclosure内，不替换 questions/changeset/commit workspace。
- `ConversationFlow`内 reasoning/tool/subagent默认行为、i18n与CSS全部复用。Intent只新增
  `.intent-turn-session`外间距、边界与max-width；不得复制`.session-block*`样式或 message switch。
- 390px下 disclosure与 nested subagent允许正文`overflow-wrap:anywhere`，tool input/output在自身
  `<pre>`内横向滚动，整页`scrollWidth===clientWidth`；最新执行流不能把 Continue composer或
  Review CTA推入第二个页面滚动容器。

## 6. Review workspace

### 6.1 Current draft

`IntentDraftDto.changeset` 在 wire 上是 `unknown`。route 先以
`IntentChangesetSchema.safeParse(draft.changeset)` 建 `IntentDraftView`；只有成功后的 typed
ops 能进入 `IntentOpPreview`、bundleNames、commit op view 与 Stepper。解析失败显示
NoticeBanner「草稿数据不可读取」+ revision/draftHash 技术摘要，commit disabled；禁止继续当前
的 `(draft.changeset as {ops...})` cast。

draft header 固定呈现：

- `Draft revision N`
- op count
- Valid / Stale / N blocking errors chip
- created relative time（现 DTO 已有）

错误顺序：parse failure → stale NoticeBanner → validation NoticeBanner → op cards。
`IntentOpPreview` props 与内部实现不变；op card header 改用 `Card title/actions/header`：

- ResourceIcon + actor-safe proposed name 为 title；
- Create/Update 为 StatusChip；
- raw opId 只作次级 technical detail/slot correlation，不作主要 label；
- `opErrors` 仍按 `${opId}:` 过滤。

无 currentDraft 时右栏按 journey 显示上下文 EmptyState：

- generating：正在生成；
- clarifying：回答左侧问题后继续；
- applied：显示最新 receipt 摘要；
- error：到左侧错误卡重试；
- idle-active：描述下一步调整。

### 6.2 Review action bar

`.intent-review__action-bar` 在 DOM 中紧随 draft summary、先于 op cards。桌面
`position:sticky; top:var(--space-3); z-index:2`，只在 review rail 内停靠；≤1080px 恢复
`position:static`。不保留“顶部/底部实施时再选”的开放决策。语义内容：

- 左：`N changes` + validation summary。
- 右：`Review & commit…` primary。
- disabled 条件：
  `!canAdvanceIntent || draftParseFailed || draft.stale || errors.length>0`。
- disabled 时同栏显示精确原因和可用动作（audit/archived → 只读；parse/validation → 查看错误；
  draft.stale → 聚焦 Composer 生成新版；inFlight → 等待/取消；unsettled apply → 等待当前
  journal settlement；pending mount decision → 跳到左栏裁决），不依赖 tooltip。
- 390px action 在 summary 后 normal flow、按钮可换行/全宽且不横向溢出。

### 6.3 Commit history

保留 prepared/applying/compensating/repair-required/committed/failed 六态；只接受 server
`attemptSeq ASC` 且唯一的顺序。
latest 按 attemptSeq，绝不按数组位置、createdAt 或 journal ULID 猜。最新记录默认完整，较旧
记录使用紧凑 `Card`，不引入折叠状态：

- receipt applied 项显示 ResourceIcon、type、name、copy 标记；
- 可按 `resourceType/resourceId` 构造现有详情 route 的才渲染 Link；若某类没有稳定现有 route，
  保留文本，禁止猜 URL；
- failed 显示 allowlisted `errorCode` + sanitized error（mono + wrap）；compensating显示
  “正在撤销未完成安装”，repair-required显示 allowlisted `recoveryCode`与管理员修复提示。
  prepared/applying/compensating/repair-required都不冒充成功或已清理；
- v3 failed必须有 `artifactCleanupVerifiedAt`；v1 failed没有该证明时显示 legacy cleanup
  unverified，不把历史行重写成 repair-required，也不宣称 all-or-nothing cleanup已验证；
- 每项显示 `attemptSeq`、draft revision/hash 摘要与时间；clientMutationId 只在 technical
  details。只有 committed receipt 有权威 `commitSeq`，不能混用两个 sequence。

## 7. Commit Dialog

### 7.1 View-model

从 `CommitDialog` 提取：

```ts
type CommitStepKey = 'strategy' | 'inputs' | 'review'

function buildCommitSteps(args: {
  updateOps: IntentCommitOpView[]
  slots: IntentSlotDto[]
}): CommitStepKey[] {
  return [
    ...(args.updateOps.length > 0 ? (['strategy'] as const) : []),
    ...(args.slots.length > 0 ? (['inputs'] as const) : []),
    'review',
  ]
}
```

使用者点击 `Review & commit` 时，route 从已 safe-parsed view 建立一次
`PinnedIntentDraft`，再打开 Dialog：

```ts
interface PinnedIntentDraft {
  id: string
  revision: number
  draftHash: string
  ops: IntentCommitOpView[]
  slots: IntentSlotDto[]
}
```

Dialog 不持续接收 live draft props。`ops` 的
`{opId,resourceType,displayName,action}` 与 `id/revision/draftHash/slots` 全来自该 snapshot，
使步骤和最终摘要都以用户实际打开复核的版本为准。helper 对空 slots 保持健壮，但当前
`deriveIntentSlots` 会为每个合法 op 签发 optional `finalName`，所以真实产品路径是
`details → review` 或 `strategy → details → review`，不把 review-only 当现行场景。

route 同时观察 live `currentDraft?.id/revision/draftHash`：

- identity 与 pinned 不同且 attempt 仍 editing：立即禁用 controls、同步擦除所有 secret/
  waiver value、关闭 Dialog，显示「草稿已更新，请重新复核」并聚焦新 draft summary；
- identity 变化发生在 submitting/outcome-unknown：先按该 attempt 的 clientMutationId 查
  journal；无论变化来自本 attempt commit 还是另一 tab，都禁止用旧 request 作用于新 draft，
  擦除 secret request/ref并关闭，结果由 journal receipt/新 detail 投影；
- 组件 unmount、明确 discard、definitive terminal settlement 同样调用集中
  `eraseCommitSecrets()`。测试必须使用复用相同 deterministic slot id 的 D1/D2，证明旧值不会
  留给新 draft。

每个 step body 是带可聚焦 heading 的 `<section aria-labelledby>`。Next/Back/header 导航后，
`IntentCommitDialog` 把焦点移到新 step heading（或首个 invalid required input），避免原 footer
button 卸载后焦点掉到 body；缺 secret/waiver 时 Next 附近显示文字原因，不只 disabled。

### 7.2 Strategy

每个 update op 用 `Card + Segmented(modify/copy)`。默认仍是 `modify`；UI 不根据 owner 猜测
copy-only，服务端仍是最终 choke point。若 RFC-234 DTO 将来提供 copy-only hint，本组件才消费。

### 7.3 Details & required inputs

按资源/op 分组 server-issued slots，而不是按 slot kind 形成四段跨资源长列表。每张资源卡内按
固定顺序：

1. finalName
2. humanBinding
3. secret
4. secretWaiver

控件继续复用 `TextInput(type=password, autoComplete="new-password")`、`UserPicker`、
checkbox 与 `Field`。`requiredInputsMissing` 精确镜像 backend：

- 每个 `secret` 必须为非空；
- 每个 `secretWaiver` 必须显式勾选 `waived`，否则 server 会
  `intent-secret-value-forbidden`；用户不愿 waiver 时应返回对话要求 Builder 改稿；
- `humanBinding` 留空按现 backend 丢弃 placeholder，UI 标「可选」；
- `finalName` 留空沿用 proposed name，UI 标「可选」。

只有前两类阻断 Next/Apply；不能把 waiver 留给一次可预防的 422。

### 7.4 Review

显示：

- draft revision + op count；
- 每个资源的 create/update + modify/copy；
- 已补槽位的种类与数量，**绝不回显 secret value**；
- all-or-nothing 与 private/owner 安全说明；
- Cancel + Apply changes。

最终请求构造抽为 `buildIntentCommitRequest` 纯函数；mutation id 在调用前生成并作为显式参数
传入，函数本身不读随机源，draft identity 只来自 pinned snapshot：

```ts
const request: CommitIntent = buildIntentCommitRequest({
  clientMutationId,
  draftRevision: pinned.revision,
  draftHash: pinned.draftHash,
  decisions,
})
```

每次用户点击最终 Apply 只生成一次 mutation id；transport 重试必须复用同一 request 对象。
pending 时 Stepper、关闭与所有输入锁定；error 留在 Review step，不清非敏感选择。

提交 attempt 的 React state 只保存不敏感 locator；含 secret 的完整 request 放组件私有
`requestRef`，不放 state/devtools-friendly cache：

```ts
interface IntentCommitAttemptLocator {
  sessionId: string
  clientMutationId: string
  draftId: string
  draftRevision: number
  draftHash: string
}

type CommitAttempt =
  | { phase: 'editing' }
  | { phase: 'submitting'; locator: IntentCommitAttemptLocator }
  | { phase: 'outcome-unknown'; locator: IntentCommitAttemptLocator; errorCode?: string }
```

- 点击 Apply 时从 pinned draft + 当前 decisions 生成 request并赋给 `requestRef.current`。
  feature hook 用 direct `api.post` + reducer 管理状态，禁止
  `useMutation<...,CommitIntent>` / `commit.mutate(request)`；MutationCache 中不存在含 secret
  variables，最多只有无敏感 locator/`void`。
- frozen request/decision/secret value 不得进入 localStorage/sessionStorage、MutationCache、
  QueryCache、URL、analytics、日志或 error 文本。`sessionStorage` 只可保存上述
  `IntentCommitAttemptLocator`，且在 attempt 开始时先写、terminal settlement 后删；locator
  没有 slot/decision/value，供刷新后按 clientMutationId 查 journal。
- `requestRef` 存在时关闭按钮、ESC、overlay 与 Stepper navigation 全锁；outcome-unknown 不用
  Dialog close/reopen 维持 secret，而是在当前 Dialog 内持续核对。
- 第一次 attempt 的 definitive 4xx 按 `ApiError.code` 分型；任何 definitive settlement先擦除
  request/ref/locator 与 secret input，非敏感 apply mode/finalName/human pick可保留：
  - `intent-name-conflict` / slot validation → 回 Inputs 定位字段并要求重输 secret；
  - `intent-foreign-modify-forbidden` → 回 Strategy，提示改为 copy并要求重输 secret；
  - `intent-draft-superseded` → erase secret/ref、invalidate、关闭旧 wizard；
  - `intent-baseline-stale` → erase secret/ref，进入 §4.2 refresh-context recovery；
  - archived/inFlight/apply-in-flight → refetch 后按 server state只读/等待；若 exact journal
    已存在则按 journal state；
  - 其它 definitive 4xx 回 editing，保留非敏感选择并让修正后创建新 id。
- exact replay 的 `intent-apply-unsettled` 表示同一 journal仍
  prepared/applying/compensating/repair-required，继续 outcome-unknown；repair-required同时
  显示非敏感管理员修复提示。`intent-apply-failed-replay` 才证明该 frozen attempt在 artifacts
  已被证明清理后 settled failed。
- transport/5xx/未知结果保留 exact request/id，锁住 back/input，invalidate 后按
  `commits.find(clientMutationId===locator.clientMutationId)` 精确分流：
  - exact journal `prepared|applying|compensating`：只等待 WS/poll，不重发；
  - exact journal `repair-required`：保持全会话写锁，擦除 secret request/ref但保留 safe
    locator，以低频 poll等待管理员收口；不能开新 attempt；
  - exact journal `committed`：采纳 receipt，erase secret/ref/locator并关闭；
  - exact journal `failed`：显示结构化 `errorCode`，erase request/locator/secret input，只保留
    非敏感决定；回 editing 后新 attempt 用新 id；
  - 无 exact journal、pinned draft 仍 current：仅当前页面仍有 `requestRef` 时提供
    「重试同一次提交」，逐字重放；别的 journal不能代替 exact identity；
  - current draft 已不再等于 pinned identity：禁止重放，erase并关闭，以 exact journal或新
    detail 为准；
  - detail 不可读：保持 outcome-unknown，只提供重新核对，不生成新 id。
- 页面 reload 后只有 safe locator，没有 request/secret：先 poll exact journal。terminal
  投影结果，unsettled 等待；若 grace window 后仍没有 exact journal，只能让用户“放弃本地
  attempt 并重新输入”，不能声称原请求失败或执行 exact replay。只有 detail证明无 unsettled且
  pinned draft仍 current才启用新 attempt；若迟到的旧请求随后到达，per-session apply lock +
  final current-draft/active CAS确保新旧至多一个能提交，另一条返回 superseded/failed。

详情 route 接 `UnsavedChangesGuard`：

- editing 且有 slot/apply-mode 改动时 `dirtyRef` 非空；允许 Stay 或明确 Discard，Discard
  同步 erase并关闭；
- Dialog 自身的 ×/ESC/overlay close 在 dirty editing 时也走同一 Stay/Discard confirm；不能因
  它不是 route navigation 就绕过 erase contract；
- submitting/outcome-unknown 时 `busyRef=true`，router link、browser Back/forward 与
  beforeunload 均阻断。共享 guard 增 backward-compatible 可选 copy keys；
- stalled 后若用户明确 Force leave，safe locator 已持久化，先 abort client fetch并 erase
  secret/ref，再放行；原请求结果保持 unknown，回来只按 journal核对；
- settlement 后清 refs；若已有 blocked resolver则 reset，不继续陈旧导航。

这让 RFC-234 journal idempotency 到达前端，同时不把 OCC fence、MutationCache 或 live props
误当成 secret-safe attempt identity。

## 8. CSS 与响应式

新增单一 `.intent-*` 命名空间，禁止新写 modal overlay/panel chrome：

- `.intent-create`
- `.intent-create__examples`
- `.intent-create__types`
- `.intent-create__guardrail`
- `.intent-session-list`
- `.intent-journey`
- `.intent-session__workspace`
- `.intent-conversation`
- `.intent-turn`
- `.intent-mounts`
- `.intent-review`
- `.intent-commit`

断点：

| 可用内容宽度 | 行为                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| `>1080px`    | session 0.9fr/1.1fr 双栏，review action sticky top                                     |
| `721–1080px` | session 单栏；type cards 4 列（能容纳时）或 auto-fit                                   |
| `≤720px`     | type cards 2 列；Dialog 12px safe margin、近全高；footer 可换行                        |
| `≤420px`     | page padding/卡片 padding 使用现有 mobile token；按钮组全宽但不强制所有按钮 full width |

Dialog scoped mobile：

```css
@media (max-width: 720px) {
  .dialog__overlay:has(> .intent-create-dialog) {
    padding: 12px;
    align-items: stretch;
  }
  .dialog__panel.intent-create-dialog {
    height: calc(100dvh - 24px);
    max-height: calc(100dvh - 24px);
  }
}
```

实际 selector 需与 `Dialog` portal DOM 核对并加 source/DOM test；不得覆盖所有 Dialog。

Commit Dialog 不把 `Stepper` 的 actions 留在长 body 末尾：scoped
`.intent-commit-dialog .dialog__body` 设为 `overflow:hidden; min-height:0`，
`.intent-commit.stepper` 为纵向 flex，只有 `.stepper__body` 成为滚动区，header/actions
`flex-shrink:0`；actions 加 safe-area bottom padding。这样每步的 Back/Next/Apply 始终可达，
且一个 modal 仍只有一个内容滚动区，不修改公共 Stepper 默认布局。

短视口/touch不是从 `100dvh`推断正确，而是独立合同：

- create/commit Dialog都以 `max-height: calc(100dvh - 24px)`响应 dynamic viewport；overlay不把
  panel垂直居中到 visual viewport之外；
- 聚焦 textarea/input后从 390×844动态 resize到390×568，header/footer不 shrink，只有声明的
  body/Stepper body可滚；当前 field可 `scrollIntoView({block:'nearest'})`且 CTA仍能滚动/固定到
  visual viewport内；
- footer bottom padding为 `max(12px, env(safe-area-inset-bottom))`；任何 sticky action不能覆盖
  caret、最后一行或 CTA；
- ChoiceCard、示例、question/mount choices、Dialog/Stepper actions在 coarse pointer下最小
  hit target 44×44 CSS px；相邻 target保留至少8px gap；
- Playwright `hasTouch:true` scene以真实 pointer tap完成 create和 commit step navigation，并用
  `elementFromPoint`/bounding rect断言 CTA未被 overlay、footer或 safe-area伪元素遮挡。另断言
  `scrollWidth===clientWidth`、只有预期容器发生 scroll、focus仍在当前 field。

颜色只使用现有 tokens / `color-mix`，dark mode 无硬编码浅色。focus ring 复用公共控件，新增
link/card/button 必有 `:focus-visible`。所有 motion 尊重 `prefers-reduced-motion`。

## 9. 文件与组件边界

预计新增：

- `packages/frontend/src/components/intent/IntentCreateComposer.tsx`
- `packages/frontend/src/components/intent/IntentSessionList.tsx`
- `packages/frontend/src/components/intent/IntentJourneyProgress.tsx`
- `packages/frontend/src/components/intent/IntentConversation.tsx`
- `packages/frontend/src/components/intent/IntentMountApprovalCard.tsx`
- `packages/frontend/src/components/intent/IntentQuestionOptions.tsx`
- `packages/frontend/src/components/intent/IntentTurnSession.tsx`
- `packages/frontend/src/components/intent/IntentReviewWorkspace.tsx`
- `packages/frontend/src/components/intent/IntentCommitDialog.tsx`
- `packages/frontend/src/components/node-session/SessionConversationPanel.tsx`
- `packages/frontend/src/lib/intent-journey.ts`
- `packages/frontend/src/lib/intent-api.ts`
- `packages/shared/src/intentModelContract.ts`
- next ordered migration for unified Intent mutation ledger、runner claim/disclosure admission、
  apply identities + immutable session artifact hint，以及`intent_turn_events`与turn capture summary

预计修改：

- `routes/intent.tsx`：query + inline/dialog composition。
- `routes/intent.detail.tsx`：query/mutations orchestration，删除巨型展示 JSX，并按 turn lazy
  组装`IntentTurnSession`。
- `components/node-session/SessionTab.tsx`：仅把现有`SessionBody`替换为共享
  `SessionConversationPanel`；attempt picker/memory/inventory结构不变。
- `components/IntentMountDialog.tsx`：单项 picker + parent-owned submit/gate/reconcile。
- `components/split/UnsavedChangesGuard.tsx`：可选 feature copy，默认行为不变。
- `components/IntentEntryButton.tsx`：收紧 hint type；仅在 focus contract 需要时最小扩展。
- `components/Card.tsx`：向后兼容转发 link `params`。
- `components/icons/resourceIcons.tsx`：新增 intent icon。
- `lib/nav.ts`：Intent Builder 使用 intent icon，不再借 workflow icon。
- `styles.css`：`.intent-*`。
- `i18n/zh-CN.ts`、`i18n/en-US.ts`。
- `packages/shared/src/schemas/intentSession.ts`、`packages/shared/src/schemas/ws.ts`：mutation
  envelope/receipt、strict `IntentMountApprovalReceiptSchema`、source identity、ordered journal、
  actor-safe mount、`IntentArtifactHintSchema/IntentComposerCapabilitiesDtoV3/
IntentArtifactCapabilitiesDtoV3/IntentPreSessionSourceGrantV1`、strict
  package-vs-mounted-file Plugin source union、`IntentTurnExecutionProjectionV1`、execution
  locator WS、pending stage/cancel receipt与 apply WS。
- `packages/shared/src/schemas/sessionView.ts`、`packages/shared/src/sessionView.ts`：保留同一
  `SessionTree`/parser语义，将 response/nested objects收紧 strict并增加 Intent generic-row
  regression；不加 Intent-specific message kind。
- `packages/backend/src/db/schema.ts`、migration registry。
- `packages/backend/src/auth/secretBox.ts`（或同目录 companion）：从现有 `secret.key` 派生
  domain-separated Intent HMAC fingerprinter；不暴露 key/raw input。
- `packages/backend/src/routes/intentSessions.ts`：parsed V2 body/response、actor-safe DTO、ordered
  commits、context-aware strict Composer capabilities resolve endpoint、pre-session grant、
  session model capabilities、turn session owner/audit endpoint与 apply invalidation。
- `packages/backend/src/services/intent/mutations.ts`：唯一
  `normalizeIntentMutationV1` branded object、ledger claim/replay、HMAC fingerprint、typed
  anchor与 legacy tombstone；`authorizeIntentMutationScopeV1` 在 private source hydration前
  产出 branded owner scope，executor/source loader禁止接 raw wire/route id；commit existing
  anchor先于 capability，absent路径用 `ArtifactAdmissionLeaseV1`围住 probe→claim race。
- `packages/backend/src/services/intent/session.ts`：idempotent reservation、source-bound atomic
  approvals、create/manual in-tx ACL、pre-session grant revalidation→session handle交换与
  expected revision/status transaction。
- `packages/backend/src/services/intent/runActor.ts`：current-session-owner-v1 principal
  hydration、active/permission gate与禁止普通 owner system fallback。
- `packages/backend/src/services/intent/disclosureAdmission.ts`：单 transaction visible catalog
  snapshot/token、snapshot-only dump input、final digest revalidation与 exact turn admission CAS。
- `packages/backend/src/services/intent/applyAuthorization.ts`：journal current-owner actor
  hydration、authorization fence、Intent copy-only与 bundle reference final in-tx oracle。
- `packages/backend/src/services/intent/applyArtifacts.ts`：v3 receipt/revision strict parser、
  record-before-act append、writer phase CAS、compensation claim/live owner、reverse cleanup与
  repair-required verifier；`ArtifactWriterObligationLedgerV3` DB/external merger；唯一允许把
  compensating terminalize为 failed的 coordinator。
- `packages/backend/src/services/intent/artifactFsCapability.ts`：Plugin/Skill canonical id
  validator、root dirfd、V3 dir/temp/entry/sealed-tree/restore/stage/backup capabilities、
  `openat/openat2/mkdirat/fstatat/linkat/unlinkat/renameat*` broker与
  `ArtifactTreeWriterV3`、`ArtifactBackupCapabilityV3`、broker-owned non-restored
  `ArtifactPublicationLedgerV3/PendingRestoreControlLedgerV3`、
  `ArtifactPublicationReceiptV3`、published/displaced exchange result；Linux anonymous temp、
  Darwin unique private staging、no-XDEV/fsid traversal；所有 public signatures拒绝裸 path，
  receipt不持久化 absolute path。
- `packages/backend/src/services/intent/artifactContainment.ts`、`packages/backend/src/main.ts`：
  READY/GO/signed EMPTY、supervisor-owned Ed25519、daemon/supervisor no-dump/no-core、
  filesystem view、per-spawn exact qualification与 broker-owned non-restored obligation
  ledger；Linux private PID namespace anchor为 help-hidden verified-self path，Darwin provider
  显式 unavailable。既有 RFC-224 API/测试语义不变，不把 PGID helper冒充新 containment。
- `packages/backend/src/native/artifact-fs/` 与 binary build/package scripts：提供最小
  cross-platform dirfd broker（Linux openat2/O_TMPFILE/linkat/renameat2、macOS
  openat/renameatx_np）；Linux embedded bytes经 sealed memfd+execveat，Darwin child在任何
  `SCM_RIGHTS`前验证 audit token/designated requirement/CDHash。缺失、unsigned/unpinned、
  digest错或 adversarial self-test失败时 filesystem capability unavailable。Linux containment
  继续复用/扩展现有 bwrap verified-self能力；Darwin npm/git Intent apply无 helper fallback。
- `packages/backend/src/services/intent/intentDoc.ts`、`turnEngine.ts`、`maintenance.ts`：shared
  model contract renderer、session artifact hint/host capability/concrete file handles进入
  trusted INTENT section，mounted file dump不投影 raw path，
  dispatcher
  principal+claim/live owner、run/settle reserved turn与 daemon-alive orphan reconcile。
- `packages/backend/src/services/intent/turnSession.ts`：`IntentTurnSessionEventSink`、有界 row/byte
  claim、capture summary CAS、owner/audit read projection与`parseSessionTree`适配。
- `packages/backend/src/services/systemAgentRun.ts`、`sessionCapture.ts`、
  `subagentLiveCapture.ts`、`runtime/claudeCode/sessionCapture.ts`及runtime driver types：抽 generic
  `SystemAgentEventSinkV1/SessionCaptureSink`，parent stream与child capture都可写 node或Intent
  target；system agent在 private-store cleanup前完成 post-run capture。现有 task Session输出与
  dedupe语义必须零变化。
- `packages/backend/src/services/intent/applyChangeset.ts`：ledger-bound claim、attemptSeq/errorCode/
  apply run-as、events、final active/target authority CAS；失败只转 compensating并委托
  `applyArtifacts.ts`。
- `packages/backend/src/services/pluginInstaller.ts`：export caller-owned
  `installPluginGeneration`，只能在 v3 authority + persisted containment release下执行；保留通用
  `installPlugin`兼容 caller-owned/mint wrapper，但所有 npm/git generation writer、manifest
  publication与 cleanup均走同一 filesystem capability/child containment。
- `packages/backend/src/services/skill.ts`、`skillReserveOp.ts`、`skillOperations.ts`、
  `skillVersion.ts`、`skillFsPublish.ts`及 import/ZIP/fusion/recovery writers：
  caller-id `beginOperation`兼容扩展、pre-minted reserve transaction/materialize拆分与 strict
  compensation；producer改接 `ArtifactTreeWriterV3`，canonical Skill root下不得再出现 path
  callback或裸 recursive FS writer；文件删除失败不得先删 row/op。
- `packages/backend/src/services/pluginGenerationGc.ts`、doctor/reporting：legacy repair
  verifier只消费 GC的安全 inventory/proof，不把 `pluginId`当 generation selector；GC与
  cleanup同走 stable plugin coordinator。
- `packages/backend/src/services/restore.ts`、`pendingRestore.ts`、Skill identity/recovery与
  backup writers：cold/pending同走 `ArtifactRestoreCapabilityV3` generation marker/swap/resume；
  config保留 regular-file `sealTemp/commitFile*`合同、Skill走 sealed tree；HTTP/CLI/pending
  ingress先 seal `ReadOnlyBackupCapabilityV3`；live stage/cancel/status/mutation lookup消费
  strict shared wire、`PendingRestoreStageCapabilityV3`与 non-restored control-ledger exact
  receipt。legacy pending/failed quarantine只经 adoption/typed repair。
- `packages/backend/src/services/backup.ts`、`rawDbSnapshot.ts`、`backupScheduler.ts`、
  `worktreeBackup.ts`及 archive/retention helper：manual/scheduled/auto/pre-migration/pre-restore都走
  `ArtifactBackupCapabilityV3`；healthy SQLite branded adapter、corrupt exact-copy、packer
  sandbox、archive publication、legacy adoption与 retention分别使用 closed operation/slot；
  worktree capture/reconstruction以 ordered `task_repos[]`和真实 Git registration adapter为
  authority，canonical/backup/repo-admin roots无裸 recursive path例外。
- `packages/shared/src/schemas/restore.ts`、`packages/backend/src/routes/restore.ts`与
  `packages/frontend/src/routes/settings.tsx`：raw-stream stage path/query、status/mutation lookup/
  cancel与 repair summary strict schema；Settings safe locator/reload reconcile替代 multipart
  arrayBuffer、无 body DELETE、raw failed dir展示。
- `packages/backend/src/cli/restore.ts`、local admin control：live daemon时通过 peer-credential +
  boot-nonce authenticated socket传 archive fd/digest；stopped时持 singleton lock启动同一 broker，
  effect前持久化+打印 mutation id，并提供 replay/status入口；绝不直接调用 path-based
  `stagePendingRestore`。
- `packages/backend/src/cli/start.ts`：singleton lock后、DB/config/restore前先建立 verified V3 FS
  broker；non-restored writer obligations先 quiesce，pending restore完成后才 open DB；restored
  DB与 obligation merger、Intent artifact recovery仍早于 HTTP、Plugin GC与所有 worker；
  daemon-alive periodic与 live staging control只在 barrier完成后启动。
- Intent/Card/nav frontend tests、`e2e/intent-builder.spec.ts` 与 intent stub fixture。

`IntentOpPreview` 的四类富预览、核心 changeset/slot/commit body、ACL/OCC/all-or-nothing 语义
不改。通用 `api` transport 不接 schema generic 魔法；Intent 业务 wrapper负责 runtime parse。

## 10. 错误、并发与恢复

统一按 server capability 区分 durable receipt 与 OCC/effect-equivalent action；组件不得为方便
把两类都叫“重试”：

```ts
type IntentWriteAttempt<I, B, R> =
  | { phase: 'editing' }
  | { phase: 'submitting'; input: I; baseline: B; receiptKey?: R }
  | { phase: 'outcome-unknown'; input: I; baseline: B; receiptKey?: R; error: unknown }
```

- definitive 4xx：服务端 transaction 明确拒绝，回 editing；除 documented exact replay code 外，
  修正后是新 id/新动作。
- pre-accept capability 422是零服务端状态：**只有客户端确实收到该 422**才销毁 id。若 response
  loss，仍属 outcome-unknown并重放同一 frozen id/body；环境恢复后它可被首次 accepted，之后才
  转入 durable receipt规则。每次 replay都先查 ledger；existing exact即使当前 capability已 red也
  返回原 anchor，只有 absent的新 id才可能得到422。
- durable receipt action 的 transport/5xx：只重放同一 id + frozen semantic body，由 server
  ledger fingerprint证明 exact；或从 DTO 按 exact id读取 receipt。不得按文本/seq/时间认领。
- OCC/effect action 的 transport/5xx：refetch 后只描述当前目标状态；若继续，重放同一
  expected revision/turn fence，使旧请求即使迟到也至多一个生效。

| 写动作           | 服务端 fence/receipt                                             | response-loss UX                                                      |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| create           | unified ledger owner/id + HMAC(endpoint/body) → session          | exact replay 同 body/id，返回原 session                               |
| message          | ledger fingerprint + expectedTurnSeq → generation receipt        | exact replay；相同文本 turn 不是证据                                  |
| answers          | ledger fingerprint + sourceTurnId/expectedTurnSeq                | exact replay；迟到 source definitive conflict                         |
| retry generation | ledger fingerprint + source error turn                           | exact replay 原 generation receipt                                    |
| mount approvals  | ledger fingerprint + source/seq + atomic decision receipt        | exact replay整批；没有部分副作用猜测                                  |
| add one mount    | in-tx active/ACL + expectedContextRevision + concrete type/id    | exact root 表示目标满足但不宣称 attempt；同 fence replay 至多生效一次 |
| unmount          | in-tx active + expectedContextRevision + exact root handle       | exact root absent 表示目标满足；不得只看 revision                     |
| rebase           | in-tx active + expectedContextRevision                           | same fence replay 至多 bump 一次；任何其它 epoch 变化 supersede       |
| cancel           | expectedInFlightTurnId + matching runner claim                   | 只取消 exact turn；新 turn 返回 superseded，不误杀                    |
| commit           | ledger HMAC(draft+decisions) + journal attemptSeq + pinned draft | §7.4 exact journal/request                                            |

| 状态                           | UX                                                | 权威                                      |
| ------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| generation reserved/inFlight   | timeline running + cancel；draft CTA disabled     | exact running turn / inFlightTurnId       |
| generation launch failure      | terminal error card + structured code/retry       | reserved turn settlement                  |
| runner principal unavailable   | terminal error；提示 owner/权限已变化             | exact run-as policy + current user        |
| disclosure admission stale     | terminal error；丢弃 seed并要求重试               | final visible-set/token digest CAS        |
| mounted root ACL revoked       | terminal error；先移除/恢复上下文再 retry         | final disclosure admission                |
| stale draft                    | warning + 聚焦 Composer 生成新版；commit disabled | `draft.stale` / server OCC                |
| commit baseline stale          | 按 `errorCode` 提供 rebase；成功后仍需生成新版    | exact journal/local ApiError              |
| apply principal unavailable    | journal failed；提示 owner账户/权限已变化         | journal run-as + final current user       |
| apply target became foreign    | journal failed；要求刷新草稿并重新选择 copy       | final Intent copy-only authority          |
| plugin containment unavailable | Composer/model前置禁用；Review drift仍禁 Apply    | strict host capability + preflight        |
| apply artifact compensating    | 全会话写锁；显示正在撤销并 WS/1.5s poll           | v3 receipt + containment/fs/cleanup proof |
| apply artifact repair needed   | 全会话写锁；显示管理员修复提示并 30s poll         | legacy/corrupt identity proof             |
| legacy terminal failed         | 历史失败 + cleanup unverified，不声称已清理       | v1 protocol + null verified timestamp     |
| validation errors              | op error + summary + commit disabled              | `draft.validation.errors`                 |
| commit unsettled               | wizard/全会话写锁；WS + state-aware poll          | ordered journal                           |
| commit response loss           | private request ref + exact journal lookup        | clientMutationId                          |
| archived / admin audit         | 全页只读，无写控件                                | status / ownerUserId                      |
| malformed outer DTO            | contract error，零 journey/gate/操作控件          | shared response schema                    |
| turn session live              | 展开统一执行流；WS/1.5s poll只作 invalidation     | durable event seq + HTTP session DTO      |
| turn session truncated         | 显示有界截断，不改 Intent业务结果                 | captureState + lastEventSeq               |
| turn session incomplete        | 显示观测不完整，questions/draft仍按业务事实呈现   | allowlisted capture reason                |
| WS/refetch                     | invalidation 后由纯函数重投影                     | WS 仅 signal，HTTP 是 source              |

UI 不做 optimistic draft/commit 成功。只有服务端 response + invalidated detail 可以让 receipt 显示
committed。任何「进度」颜色都不能放宽按钮的原 disabled 判据。

## 11. 测试策略

### 11.1 Shared/backend/DB contracts

- migration：旧 session/turn/journal fixture 升级；每 session 回填 attemptSeq 稳定、唯一、连续，
  再把 `session.applyAttemptSeq` 置为 MAX；0/1/N、committed+failed、同毫秒/墙钟回拨后实际
  next claim=`max+1`。SQLite rebuild/NOT NULL、legacy-unverifiable ledger、owner/id 跨 session
  collision tombstone、旧 running null run-as只 terminal不 resume、新 `dumpAdmission*`
  null兼容与 downstream schema snapshot均锁定。旧 apply exact Skill receipt转 v3后严格补偿；
  v1 Plugin identity进入 repair-required且不得猜 generation；历史 terminal只读保留。
- mutation normalization：每个 endpoint strict parse 后只产出一个
  `NormalizedIntentMutationV1`；source guard证明 ledger/session/turn/journal/apply resolver都不
  接 raw wire type。锁 create message/hint trim+omit与 ordered-first mount dedup、answers
  duplicate/missing/extra及 source question/option order、approval source order、commit duplicate
  `opId/(opId,slotId)`拒绝与 sorted decisions/slots。duplicate/reversed
  secret/human/waiver、distinct create mount换序和 picked换序分别断言 normalized-equal replay或
  changed-body conflict；property-based test在固定 endpoint/scope/key 下断言 fingerprint相等时
  executor canonical normalized bytes相等。
- generation reservation：create/message/answers/retry 的 user+running 同 transaction；
  running 同时写 exact owner `runAsUserId` 与 `current-session-owner-v1`，不含 credential/scope
  snapshot；
  runtime resolution/loadConfig unsupported、budget exhausted、spawn preflight error 均落 exact
  terminal turn并发 finished；reservation commit→dispatcher claim、claim→live register、
  register→started/run 各注入 fault且 daemon 保持存活，周期 reconcile最终释放 exact slot。
  live registry 中超过 orphan grace 的合法长任务不得被回收；reserve/claim 后 daemon restart由
  boot recovery收口。
- dispatcher principal：wake故障后销毁 route actor，periodic poll仍从 current session owner
  claim；missing/disabled/无 `intent:write` 在 short transaction settle
  `intent-runner-principal-unavailable`。PAT/session credential撤销不影响已接受动作，但 user
  status/role变更即时生效；role升降、普通 admin owner与 exact system-owned session均按 policy
  构造。disclosure snapshot必须在一个 `dbTxSync`读取完整 visible set/tokens；dump只能消费 frozen
  rows/Skill immutable version，final admission重算 exact digest并 CAS
  `dumpAdmissionDigest/At`。在 catalog ACL read后、六类 serialization/Skill file read后、final
  admission前注入 grant revoke、owner transfer、visibility/content change、delete、rename、
  role downgrade，均须丢弃 seed并 terminal；admission后同样变化不追溯取消 live run。非 admin
  owner的 foreign-private canary不进模型，普通 admin只按 final current role取得既有
  resource-admin visibility。spy断言 ordinary owner从未被 `SYSTEM_USER_ID`替代，restart/cancel
  仍校验 exact turn/claim，合法长 run不被 sweep。
- idempotency：create/message/answers/retry/approval/commit 共用 owner-scoped ledger；同
  clientMutationId + 同 endpoint/scope/HMAC replay返回原 typed anchor且只 fire/apply一次；全部
  cross-endpoint pair、跨 session、changed body 409。commit 另覆盖 changed
  draft/applyMode/slot/human/waiver/secret；DB/log/error/DTO 不含 raw secret或普通 hash。模拟
  response loss 后 exact replay；另在 green capability下先 accepted、隐藏 response、再翻 red，
  同 frozen id/body仍返回原 anchor且不跑 capability 422。absent→probe→claim间注入并发 exact/
  mismatch ledger与 provider revision漂移，transaction二次 lookup/lease验证必须分别 replay、
  conflict或零状态拒绝。两个 tab发送相同文本不能互相认领。
- model contract/hint：migration对旧 session `artifactHint=null`；新 create只接受 shared enum并
  与 session原子持久，后续 turn不可改。六类
  `INTENT_MODEL_CONTRACT_VERSION=3` examples逐个通过 strict changeset parser、resolver与 canonical
  validator；Plugin package source/mounted-file handle、required description/`optionsJson`、
  Workflow output ports/bind/matching edge有 golden，source guard阻止旧 `options?` prose与 raw
  file path。`buildIntentDoc`把
  hint/capability放 trusted section且不落在 untrusted fence内；Auto/modify/null、显式用户目标覆盖
  weak hint、Darwin unsupported Plugin问回、Linux admitted六类均锁定。
- source owner/fence：wire-valid answers/approvals先以 exact session owner同形404授权，spy锁
  foreign/manager/admin auditor对正确/错误 question/option/type/name均零 source read/parse、
  零 ledger/turn；cross-session source不能被读取。owner的 missing/corrupt source typed fail
  closed；迟到 answers、T2 后 T3/T4 再答、同 question id 跨轮、approval 后答、unrelated turn
  插入、expected seq stale均回结构化 conflict且零新 generation；推进/归档后的 exact owner
  replay仍能重建原 normalized bytes，changed body conflict。
- mount approvals：同名多 owner需 exact resource；transaction 内 ACL/资源 name 变化重查；
  多 decision 中任一失败整批 rollback；reject-only/already-mounted不 bump，多个新 approve只
  bump一次。strict shared receipt锁 missing/wrong/extra fields、source-order results、
  approve resourceId/handle、reject字段闭集、outer turn id/seq一致；same id replay逐字段相同；
  不同 tab/source和响应丢失回归。
- create/manual mount/rebase/cancel：create/add 的资源查询与 `canViewResourceInTx` 同
  transaction；add/remove/rebase fresh owner/active/context/inFlight/unsettled + conditional
  changes。覆盖 archive-before-tx、grant revoke、visibility change、delete、response loss；
  expected context/turn fence使迟到 replay至多一次 epoch变更，cancel不得杀后来 turn/claim。
- apply DTO：attemptSeq claim原子单调；乱序 insertion、同毫秒、墙钟回拨仍按 attemptSeq；
  draftId/hash/clientMutationId/errorCode/updatedAt投影准确，prepared/terminal WS frame与
  reconnect reconcile。
- archive/apply：prepared→archive、archive→claim、archive 发生于 prestage→final tx、
  reopen交错；status transaction与 final active CAS均拒绝非法落地。
- apply final authority：journal claim写 exact owner run-as；preflight 后销毁/改变 route actor，
  final transaction必须重读 current user并重绑所有 prepared principals。分别在
  preflight→plugin install、plugin→Skill stage、stage→final tx注入 Workflow/Workgroup owner
  transfer、builtin flip、manager/admin/user role变化、user disable与 final bundle reference
  grant revoke；断言零资源/target/provenance/session变化、journal先 compensating、artifact
  逆序补偿成功后才 typed failed、exact replay不重做。MCP full operation hash拒绝 ACL
  transfer作为对照。
- artifact recovery：新 journal严格 parse `preparedArtifactsVersion=3`与单调
  `preparedArtifactsRevision`。fake npm generation由 caller mint；supervisor READY后先持久化
  exact nonce/start identity/containment kind/public key/release digest，DB CAS成功前 GO/npm不得
  发生。Linux fixture在
  private PID namespace内启动
  `setsid + double-fork + closed-pipe` delayed writer；分别于 receipt→capability、READY→persist、
  persist→GO、npm child运行、direct exit→descendant alive、EMPTY→CAS、manifest publish与
  InstallResult返回前真实杀 daemon。normal/timeout/cancel/restart都只有 valid Ed25519 EMPTY
  signature才可 quiesced；wrong public key/signature、old release replay、tracker error、
  supervisor identity mismatch不得 signal猜测或 terminal。daemon/supervisor no-dump/no-core、
  signer memory lock/zeroize均以 OS probe断言；same-UID sibling的 ptrace/process_vm_readv、
  `/proc/pid/mem|fd`与 control injection必须失败。terminal后等待超过延迟写窗口，
  generation/marker仍 absent。
- filesystem capability：V3 API contract test证明 file
  `createTemp → writeTemp → sealTemp → commitFile*`与 directory
  `createTree → mkdir/writeFile → seal → commitTree*`均产生并消费 exact branded authority；
  tree writer拒绝 canonical/general dir capability，operation/slot不匹配零写；replace必须返回
  角色固定的 `{published,displaced}`，broker publication ledger在 syscall前 durable，receipt在
  displaced absent前不能 complete，无 unproducible entry/tree capability。在 root open、每段
  `openat`、exclusive mkdir、temp/tree write/link、
  最后 `fstat`返回与 `openat/write/linkat/renameat/unlinkat` syscall之间逐点注入 parent/leaf
  replacement。Linux `O_TMPFILE`在 write阶段 nlink=0，攻击者无法先 hardlink再获 bytes；Darwin
  contained child对 private named temp植入 hardlink时在下一 write前 fail closed。两平台另注入
  bind/volume mount与 fsid/dev变化，Linux要求 `RESOLVE_NO_XDEV`。Linux/macOS host Skill
  create/version/publish/import/ZIP/fusion/recovery及 Plugin manifest/cleanup/GC/doctor全矩阵必须
  只写 original fd-bound inode或零写 fail closed；外部 sentinel始终零 bytes。Skill live tree在
  publication prepared→exchange、exchange→receipt、displaced cleanup各断点真 kill，restart只按
  staged/expected/published/displaced identities exact resume。fake npm lifecycle
  另主动 rename leaf、植入 sentinel symlink并写，Linux mount view必须拒绝 leaf外写；
  capability/self-test unavailable在 GO前返回 typed error且 npm/producer零调用。helper
  open→exec swap、digest/build mismatch测试中 Linux sealed memfd exec与Darwin
  audit-token/code-sign/CDHash必须在 root dirfd transfer前拒绝 wrong child。macOS
  npm/git Plugin case必须更早在 preflight返回同一 typed capability error，并断言零 ledger/
  journal、零 generation leaf、零 child；managed Skill与 mounted file control case仍成功。
  source guard禁止 canonical roots的裸 path writer回归。
- restore generation：cold CLI与 pending startup共用同一 V3 broker。对
  staging/safety-snapshot/DB-swap/FS-swap/migrate/identity-barrier/old-generation-cleanup每个 durable
  phase真杀进程，重启从 marker exact resume或 fail closed；empty incoming Skill tree必须替换 live
  tree。七态 marker每态都以 `dev/ino > Number.MAX_SAFE_INTEGER`执行 decoded→explicit
  encoder→canonical frame→全新进程 raw loader→decoded exact round trip；分别交换任一 staged/
  safety/published/displaced identity、operation/digest/config disposition/publication ref都必须在
  DB open与 filesystem effect前拒绝。至少两个非 mock real kill固定为
  `safety-snapshotted` fsync后、DB exchange前，以及 `db-swapped` fsync后、config/skills
  exchange前；cold CLI与 pending startup各跑一次，前者只能从 exact safety generation继续，后者
  只能从 exact DB publication继续，effect至多一次。incoming config present/absent × live config
  present/absent锁
  `replace/preserve`矩阵，config始终是 regular file并由 `loadConfig(Paths.config)`读取；
  file↔directory、symlink/hardlink、digest/identity mismatch零交换。config file publication与
  Skill tree publication分别在 prepared/syscall/receipt/displaced-cleanup断点真 kill。
  parent/entry/mount/digest ambiguity零删除；source guard证明
  restore/pendingRestore/Skill identity migration没有 canonical root裸
  `rm/cp/rename`。另在 backup B之后启动 released delayed writer、杀 daemon并 restore到 B：
  external obligation必须在 DB swap前 quiesce，swap后仍可用同一 public key/identity与 restored
  refs做 exact cleanup/repair；non-restored publication receipt也必须与 restored business
  row/marker及 current tree inventory合并后才 cleanup displaced，HTTP/GC不得提前开放。
  obligation/publication-only、DB-only、两边 phase不同的 crash断点均保守合并。live daemon下
  CLI default plan/`--dry-run`只走 local-control `inspect-backup`，CLI `--stage`与 admin HTTP才
  走 daemon-owned ingress/stage capability；live与stopped inspection逐字段返回同一
  `RestorePlanDtoV3`。inspect的 peer/fd/digest/frame错误、response loss与 daemon kill均断言
  ingress/fd exact cleanup且 pending/control/publication/locator/DB/FS零写。HTTP raw stream在
  content-length有/无、chunk cap/backpressure/disconnect、seal/fsync各点真 kill，live/stopped CLI
  fd与 pending marker同样只产出 `ReadOnlyBackupCapabilityV3`。peer/boot nonce/fd digest错、并发
  stage/cancel、stop/start竞态与 response loss有 exact receipt。Settings在 effect前保存
  actor-bound locator，隐藏 response后执行 A→B→reload/restart→A：B不查不删A key，A沿 mutation
  lookup收敛；explicit clear必须确认且只删 exact local key，storage无 path/name/archive数据。
  CLI mutation id在 effect前 fsync+打印，replay/status与未 seal
  同 id重传均真实跑。cancel在 control-record前、record→archive delete、archive→marker delete与
  effect→terminal receipt每点真 kill；相同 caller/id/body在 marker absent/restart后返回相同
  canceled receipt，同 id换 body/caller或后来 stage identity不得被误删。v1 control ledger无
  GC。用旧 binary实际生成
  `restore-pending.json` active-pair、mkdir-before-copy empty-active、copy-before-marker
  archive-only、archive-delete-before-cleanup marker-only，以及 quarantine rename前/后、
  `error.txt`写前/后 fixtures；另在 released DB swap后、config/skills/migration/worktree与 catch
  进入后/rename前逐点真 kill，证明它们均留下同形 active-pair。新 binary adoption在
  discover/classify/operator-record/decision/reapply-V3/quarantine/cleanup每点真 kill；
  reapply hold与quarantine另在 move declaration/moving/rename/source-parent fsync/
  target-parent fsync/moved receipt，以及 hold cleaning/remove/cleanup-observation/
  target-parent re-fsync/cleaned逐点真 kill。rename phases的source-only/target-only exact收敛；
  `cleaning`在 remove后与 fsync后 kill均以 exact neither roll forward。`moved` neither、source
  reappear、both/replacement只 repair，terminal receipt必须引用同一 move publication。
  nested publication/parent/slot/role/fence/fsync/removed identity逐字段替换为另一合法值的
  negative codec fixtures全部在 descriptor open前 fail。
  active-pair无论来源都先以 `legacy-active-pair-ambiguous`在 DB open前停止；stopped CLI exact
  inspect后显式 reapply/quarantine，response loss只沿 operator receipt收敛，绝不信任
  `stagedTarball`。marker-only只 consumed cleanup，archive-only只 quarantine，
  failed/invalid/identity替换转 typed repair且不伪造 caller receipt。stopped CLI持锁走同一 broker；
  source guard证明 upload/pending root也无裸 writer。
  verified broker早于 obligation/pending restore/DB/config，Intent recovery早于HTTP/GC。
- backup authority：manual/API/scheduler/auto/pre-migration/pre-restore与 healthy/corrupt DB fixture都只
  mint exact `backup-export` operation；config/skills/worktrees、workflow YAML与manifest进入 closed
  logical names。healthy SQLite adapter不能取得 sink path，corrupt DB/WAL/SHM只消费 locked
  read-only identities。packer sandbox看不到 app-home/root fd，publish前后真 crash只沿
  publication receipt收敛。`backup-retention`不能调用 create/publish，export不能 remove；
  active/protected/last-good不可删。用升级前 binary生成 scheduled/auto/manual/pre-_ archives，
  adoption在 scan/digest/manifest/receipt各点 crash后重试，scheduled/auto继续 count/days/size
  轮转，manual/pre-_/统一 last-good保护；symlink/hardlink/partial/corrupt/unknown manifest只进
  repair、不删除。new v2 worktree capture必须从 ordered `task_repos[]`全量复制，任一 repo失败
  task级 skip且零半 payload；single/multi-repo真实 Git reconstruction对 root/namespace/
  task-container/target分别在 declaration、private mkdir、identity checkpoint、publishing、
  no-replace rename、parent fsync、publication receipt，以及后续 adding/add result/effect-ledger
  fsync/overlay/postcondition每点 kill后 exact resume/compensate。另覆盖 declaration后
  ENOSPC/EIO/cancel且双 absent写 `closed-absent`、reservation尚未形成仍 terminal compensated、
  Git非零且 true `not-started`写 no-effect proof、single-existing container preflight typed skip；
  operation-created root/namespace在 Git not-started与 multi第 N repo失败后写
  `created-infrastructure-retained`。unique-stale在 stale-removing前后、Git调用前、Git非零与
  response loss逐点kill，effective baseline只在 stale cleanup receipt后变 absent。另注入
  branch-only、registration-only、expected-target partial admin directory/target delta并验证逐项
  逆序 compensation first-fail/second-success。
  覆盖 whole parent absent、
  parent-only、partial child、duplicate basename、private-only/canonical-only/both/replacement、
  add-before-result、result-before-ledger fsync、target/registration/branch replacement与 multi第 N
  repo失败；existing parent永不误删，operation-created empty task container只在所有 child收口后
  exact删除，shared root/namespace按 strict retention receipt保留，未发布 private slot也沿 ledger
  exact收口。已有 target零覆盖、missing repo/foreign infrastructure/ambiguous or unrelated Git
  delta/stale registration cleanup
  first-fail保持 repair，legacy v1 single可恢复、v1 multi typed skip，archive path/meta篡改不能
  改变 repo/target/argv。source guard覆盖 backup/raw
  snapshot/scheduler/worktree/archive/Git adapter且没有 canonical、archive或 repo-admin root裸
  writer。
- pre-accept id：static/dynamic capability红时断言零 ledger/journal/leaf/child；客户端看见
  definitive 422才销毁 id。隐藏该 response、随后把 capability翻绿并 replay frozen body/id，允许
  它被第一次 accepted；之后同 id exact replay返回一个 ledger anchor且副作用总计一次。不得测试
  或实现无状态的“旧 id永久红”。
- Skill另在 mkdir/materialize/version archive断点真退出；generic Skill recovery先/后于 Intent
  coordinator都幂等。Plugin/Skill strict cleanup第一次确定失败、第二次成功：第一次仍
  compensating并保留 receipt/row/op/containment/fs authority，第二次 empty proof有效且全部
  absent后才 failed。另锁同 plugin多 generation/current ref/其它 attempt、mounted file源绝不删除、
  claim loss、live长 cleanup、boot barrier早于HTTP/GC；v1/unknown codec进入 repair-required，
  保守 GC/doctor proof后才 terminal，损坏 receipt永不猜删。
- mounted file source：create transaction对 actor-safe Plugin mount分配 handle并保存
  source-kind/config/spec HMAC fence；model DTO/dump只含 handle/display/binding digest。raw
  `spec/path`、未列 handle、cross-session handle、source kind/ACL/config/spec drift均在
  `realpath/open`前 typed fail closed，external-read spy为零；exact handle由 final row mint
  read-only capability并成功 copy，cleanup/GC绝不删除或改写 source。
- pre-session source grant：generic create与exact modify context strict parse；Darwin generic
  Plugin disabled，actor-visible file Plugin modify先用 frozen create id resolve opaque grant。
  invisible/deleted/non-file、跨 actor/attempt、token篡改、issuer/key/expiry与 config/spec fence
  drift均在 ledger/session/turn/external read前拒绝；valid grant在 create transaction换成 session
  handle，grant本身不进 `INTENT.md`。accepted create隐藏 response后让 grant过期并改变 source，
  exact body/id仍先从 ledger返回原 session；changed token/body conflict。
- actor-safe mount：重复名称、长 Owner、system owner、删除/不可见资源 `display=null`；
  admin audit不越过既有资源 visibility合同。
- publication lineage/projection/repair：artifact三 phase与SQLite七 prefix分别构造 immutable
  revision chain，marker固定旧 anchor后在每个 inner frame fsync→outer marker checkpoint窗口杀
  进程；restart验真旧 anchor并走到唯一 latest descendant。注入 missing revision、fork、previous
  digest漂移、old frame overwrite、same id跨 role、alternate receipt、prepared-as-exchanged、
  wrong phase/mode/staged digest/staged/published/displaced identity，全部在 effect spy前失败。
  safety/barrier/cleanup三组 verifier用真实 receipt chain跑正例。artifact每 phase、SQLite每
  prefix转 repair后完整 canonical round trip；drop/null/rewrite已知 publication、sidecar
  intent revision、cleanup evidence或从 repair继续推进均失败。legacy active-pair fixture另锁
  operator-confirmation/reapply request/control/receipt/new operation的 exact options authority，
  current-default回填为负例。
- Intent session events：migration fixture验证旧 turn得到`execution=null`、新 agent reservation
  原子`live/seq=0`、FK cascade、`(turn,event_seq)`唯一、external part id dedupe与 row/byte cap。
  `runSystemAgent`用 OpenCode/Claude normalized fixtures覆盖 parent text/reasoning/tool/error、
  non-JSON fallback、masked stderr、root session id、live child及post-run child；fault注入
  stream insert、post-run capture、flush timeout与unreaped，分别得到
  complete/truncated/incomplete且不改变相同 envelope的 Intent questions/changeset/error结果。
  spy锁 post-run capture在 private-store cleanup之前，generic capture adapter对 node sink的既有
  rows/ordering/dedupe逐字段零变化。
- Intent turn session route：owner、explicit system-admin audit、manager/普通foreign、
  cross-session turn、user turn、deleted turn完整矩阵；授权前零 event read，foreign/missing同形
  404，不适用410。rows按 event seq进入同一`parseSessionTree`，strict response覆盖 nested
  subagent、malformed payload/captureComplete；DTO/snapshot不含 scratch/store path。WS
  500ms节流只带 locator/seq，raw payload sentinel零广播。

### 11.2 纯函数

- `normalizeIntentArtifactHint/buildIntentCreatePayload`：未知 URL hint 回 auto、trim、auto 省略、
  shared allowlisted hint、modify mount 且 hint 省略、message max；unsupported URL/entry hint不
  静默回 Auto而进入 disabled reason。
- `projectIntentComposerCapabilities`：strict create/modify context与 DTO v3、
  Linux/Darwin矩阵、unknown reason/shape fail-closed、Auto始终可选、Plugin roving selection跳过
  disabled；generic Darwin无 grant disabled，exact file-Plugin grant才启用。
- `deriveIntentJourneyState`：proposal AC-8 全矩阵 + 优先级反例（inFlight+old draft、
  currentDraft+old error、archived+inFlight、failed commit same/other draft、
  compensating/repair-required + current draft）+ invalid/non-monotonic attemptSeq fail closed、
  answers 后再 mount-approval 不复活旧 questions。
- `projectIntentTimeline`：七 kind、answers 只使用 preceding questions label、question id
  跨轮复用、未知 answers/mount-approval shape 不 raw JSON；invalid mountRequests 不渲染操作
  控件。
- `buildCommitSteps`：0/1/2 optional steps。
- `buildIntentCommitRequest`：apply modes/slots/human/waiver、secret 不进 review view、mutation id
  单次生成、只读 pinned draft、locator 不含 decisions、frozen request 不进 cache/storage。
- journal recovery：exact clientMutationId 的
  prepared/applying/compensating/repair-required/committed/failed/no-row；other journal不误关联；
  draft identity change；非终态都不开放新 attempt。
- OCC/effect reconciliation：manual mount concrete target、revision-only不认领，rebase expected
  revision、cancel exact turn、detail unreachable。
- `IntentSessionSummary/Detail/GenerationReceipt/MountApprovalReceipt` outer schema parse：
  missing/wrong/extra fields、approval result order/closed discriminants、unordered/duplicate
  attemptSeq与 raw payload redaction。编译期锁
  `z.output<typeof IntentMountApprovalReceiptSchema> === IntentMountApprovalReceipt`；合法
  approve/reject receipt逐字段不变，不得转换成 artifact identity。
- `ArtifactEntryIdentityV3` codec：wire `0`、uint64 max与跨 JS safe-integer的大值 decode后实际是
  `bigint`；`+1`、`01`、`-1`、空串、uint64 overflow及 mode/nlink/fsid unsafe number均拒绝；
  decoded→canonical wire→decoded逐字段 round trip。所有 nested recovery identity只消费统一
  decoded output，类型合法但 identity替换及 live bigint observation不等必须在 descriptor/
  filesystem/DB effect前失败。
- durable root codec registry：对 §0.5.1.1a 的 16个 root（含 restore generation marker与
  restore SQLite publication）及所有
  identity-bearing union branch注入
  `dev/ino > Number.MAX_SAFE_INTEGER`，执行 decoded root → explicit root encoder → strict
  `*WireSchema` → canonical payload/frame → raw loader → `*Schema` decode → exact nested comparator。
  每个 root的 wire/decoded input/output equality、registry key/kind equality与 encoder
  `assertNeverDurableBranch`必须由 repo typecheck真实编译。source guard拒绝
  `JSON.stringify(decodedRoot)`、bigint replacer、root `toJSON`、decoded object spread/cast及
  partial identity mapper；新增 branch未进入 encoder时 fixture与 typecheck同时失败。
- durable writer/kill：storage spy只接受与 ledger匹配的
  `CanonicalDurableRootBytesV3<exact-kind>`，任何 decoded object或 foreign kind在 append/fsync前
  失败。每个 root由进程 A写真实 frame到 disk、进程 B只从 raw `Uint8Array`与 expected codec
  load；wrong expected kind、digest bit flip、outer/inner key-order或 whitespace变化、duplicate
  key、BOM/trailing byte、valid foreign payload、oversize与 invalid UTF-8均在返回 runtime
  WeakSet-backed instance前拒绝。source guard禁止 public raw lookup/rebrand、brand cast及绕过
  `loadCanonicalDurableRootV3()`直接 decode。legacy move在 `moving` canonical bytes fsync后、
  rename前杀进程，restart decode同一
  publication并使 rename至多一次；worktree directory在 `declared` canonical bytes fsync后、
  private mkdir前杀进程，restart继续 prepare或写合法 `closed-absent`。missing/extra/swapped
  nested identity wire在 descriptor/filesystem/DB effect前拒绝。
- restore normative appendix：strict typecheck并直接运行
  `restore-generation-v3.normative.ts`；逐态覆盖14个 marker schema、7个 explicit encoder、wire/
  decoded full refiners、options/digest、storage-key membership与 same-kind foreign publication
  lookup。真实 file-based SQLite fixture构造 incoming WAL-only committed rows与 live stale
  WAL/SHM；验证 private consolidation、captured/skipped safety、sidecar record-before-unlink+
  parent-fsync、DB no-replace/replace、migration disposition与 present/absent cleanup。cold/pending在
  safety、WAL、SHM、DB、FS、migration每个 checkpoint/syscall窗口真 kill。

### 11.3 DOM/component

- Composer inline/dialog 两形态、真实 form、message max/count、示例填入不提交/不覆盖、
  ChoiceCards键盘/disabled reason/`aria-describedby`、Darwin generic Plugin不可选、Auto不绕过、
  modify context先冻结 attempt id再 resolve grant、grant error/re-resolve、pending dismiss lock、
  Cmd/Ctrl+Enter IME guard、error 保留、create transport loss exact id/body replay、
  different-hash error。
- search 驱动 Dialog：close/success replace 清 query、back-forward、focus fallback。
- session list semantics：一个 card 一个带 params 的 link、长 title、running/archived、scoped
  loading/error、mobile 无 table。
- journey `aria-current`、非颜色 icon、durable running/runtime-error/budget-error。
- conversation：语义 ol、角色顺序、answers 不含 `{` JSON、latest questions 可答、historical
  questions 只读、source turn 切换清 state、长选项 radio/checkbox、single/multi picked、同轮
  mount request 去重、审批前 source refetch、strict approval receipt逐项/outer-turn identity
  match→只用 `resultingTurnSeq`发 answers；malformed/mismatched receipt零 answers POST，source/seq
  409清旧 state、receipt注入 identity字段或缺失/额外/乱序字段同样零 answers POST、
  transport/5xx exact batch replay、第一步成功第二步只 replay answers、
  message/answers/retry exact receipt、rebase/cancel OCC fence、error retry、running cancel。
- turn session：`SessionConversationPanel`在 task与Intent两 caller使用同一 strict parse/loading/
  error/renderer；Intent最新 running首次默认展开、手动折叠不被refetch覆盖、历史默认折叠，
  expanded running按WS/poll刷新且terminal停止。parent user/assistant/reasoning/tool、nested
  subagent、complete/truncated/incomplete chip、isolated load error与390px tool/pre overflow均锁；
  task `SessionTab`的attempt picker/memory/inventory DOM snapshot不变，Intent DOM不存在伪
  attempt/inventory。raw WS payload sentinel、duplicate/out-of-order eventSeq与malformed
  `SessionViewResponse`分别零payload exposure、幂等refetch与局部 contract error。
- `IntentMountDialog`：单项选择、parent gate、打开后 generation/apply transition锁定、
  response loss exact target satisfied/unknown、没有 partial multi loop。
- review：draft changeset safeParse、rich preview wiring 不变、disabled reason、stale 聚焦生成/
  baseline-stale rebase 分型、sticky top action、no-draft states、commit history。
- read-only：archived、admin audit 下每个 mutation 控件的 negative DOM 锁。
- outer malformed list/detail/create：contract error且零 journey/owner gate/写控件/raw JSON。
- mount context：name/type/完整 owner、重复名称、长 owner wrap、display null fallback、handle
  仅次级；modify target typed fetch failure禁创建。
- commit wizard：step skip/backtrack/no state loss/secret gating/pending lock/request equality；
  D1 打开后 D2 到达（相同 slot id）立即 erase/close，request只用 pinned identity；
  普通 4xx 新 attempt、`intent-apply-unsettled` 保持等待、
  `intent-apply-failed-replay` 才开新 attempt、transport/5xx exact request replay、
  exact journal changed/same/unsettled/unreachable 分支。
- compensation status：prepared→compensating WS后立即全页锁；compensating显示撤销中且不显示
  terminal failure；repair-required擦除 secret request、保留 safe locator与管理员提示，30s
  reconcile；failed到达后才允许新 attempt。
- secret/navigation negative proof：MutationCache/QueryCache/localStorage/sessionStorage
  decisions/URL/log/error均不含 sentinel secret；sessionStorage locator only；router link、
  browser Back/forward、beforeunload、force leave、reload locator recovery与 erase on every
  terminal/unmount/discard/draft-change。
- short viewport/touch：390×568 coarse pointer下 create/commit只有一个 scroll owner；打开、
  聚焦并从844动态缩高到568后，focused field与CTA bounding rect/`elementFromPoint`可达，
  44×44 targets、safe-area、footer/Stepper actions、tap提交与无横向 overflow均锁定。

### 11.4 回归

更新而不删除：

- `intent-list-inline.test.tsx`
- `intent-detail-inline.test.tsx`
- `intent-op-preview.test.tsx`
- `intent-entry-badge.test.tsx`

既有关键 testid 保留：

- `intent-create-message`
- `intent-modify-target`
- `intent-turn-${kind}`
- `intent-questions`
- `intent-add-mount`
- `intent-draft`
- `intent-op-card`
- `intent-open-commit`
- `intent-composer`
- `intent-commit-submit`

可新增 anchor，但禁止仅为绕过测试把语义控件包在无意义 testid wrapper。

### 11.5 E2E/视觉

扩展 `e2e/intent-builder.spec.ts` 的隔离 daemon + stub runtime：

1. inline create → draft → commit → provenance（原 US-1）。
2. resource modify → context card → pre-session grant → create transaction session handle →
   pre-mount（原 US-6）；Darwin exact file Plugin成功，grant bytes/raw path不进 `INTENT.md`。
3. inline 示例只填充、type radiogroup payload；Darwin strict Composer capability DTO让 generic
   Plugin可见但 disabled，Auto/URL hint不能绕过，Linux admitted fixture保持六类可选。
4. 新/扩 intent stub fixture必须读取 `INTENT.md`，按
   `INTENT_MODEL_CONTRACT_VERSION/requestedArtifactHint/artifactCapabilities`分支：六类 hint各返回
   对应 strict-valid example；另覆盖 question single/multi + mount request approve/reject +
   source receipt + 下一轮顺序。不能继续用永远返回 Agent changeset的固定桩假装覆盖。
5. Playwright route 让首个 commit request 真正到 daemon、隐藏 response；UI refetch 后采纳
   committed receipt，不生成第二 id/request。
6. 双 page/tab：open D1 wizard后生成 D2；另 tab claim apply 后本 tab由 prepared WS锁全页；
   compensating/repair-required中保持锁，只有 failed/committed terminal恢复。
7. manual mount gate变化、source-turn late answer与 atomic approval response loss：丢弃第一步
   HTTP response，refetch exact strict receipt后仅以 `resultingTurnSeq`提交一次 answers；
   malformed/mismatched receipt或 receipt→artifact identity错型零 answers request；approval
   transaction commit后、HTTP response前杀 daemon，重启后从 detail receipt恢复且 answers只提交
   一次。
8. 至少一条完整 create→periodic dispatcher→draft路径使用真实 active、非-system、非 admin
   user session；wake 后丢弃 route actor，并用 private grant/foreign-private canary证明
   current-owner actor与 persisted disclosure admission，不能只用 daemon/admin token覆盖
   happy path。
9. commit secret 输入后 browser Back/refresh原生/应用内 guard；route instrumentation证明 payload
   secret不进入 cache/storage/log，locator可恢复 journal。
10. stub分别输出parent reasoning/tool与child subagent events；创建后保持run pending，断言最新
    Intent turn自动展开且WS节流刷新统一`ConversationFlow`，断开WS后poll继续。结束、刷新页面后
    tree与顺序不变；再造第二 turn后旧 turn折叠可重开。另注入capture failure与byte cap，业务
    changeset仍可Review/commit且disclosure分别显示incomplete/truncated。task node Session
    smoke对比同一message/tool/subagent结构，证明没有第二套 renderer。
11. desktop 1280×800 light/dark：双栏、CTA可见、长 owner、展开的turn session、无 horizontal
    overflow。
12. 390×844 light/dark：create Dialog、session单列、turn session disclosure、footer/CTA、安全区、
    无 overflow。
13. 390×568 `hasTouch:true` light/dark：create/commit Dialog；打开并聚焦后再从844缩到568模拟软
    键盘，tap完成主要动作；field/CTA hit-test可达、44px target、单滚动、safe-area、无 overflow。
14. keyboard：Dialog focus trap/restore、radio/checkbox、turn session disclosure、
    Cmd/Ctrl+Enter、commit Stepper/guard。
15. axe list/create/detail/turn session/commit/guard dialog；reduced-motion。

CSS 变更按 `docs/dev-gotchas.md`：构建最新 binary 后截图；与 `/agents`、`/workflows`、
`/workgroups` side-by-side。若触及 nightly 既有 scene，Linux 基线只取 CI artifact。

## 12. 发布与兼容

- 同一 binary 协调发布 migration + shared + backend + embedded frontend；不支持把 RFC-235
  frontend 单独放到旧 daemon。migration 对旧 rows 可读且不可丢历史；旧 Intent turns的
  `execution=null`，不从历史`runMeta`伪造 session tree。`intent_turn_events`只随 owning turn
  cascade，不进入 task event archive/auto-kill/stuck detector。
- changeset/commit request核心语义与既有资源 API不 breaking；Intent mutation bodies升级为
  source/attempt-bound contract，旧 frontend 必须与 backend 同步升级。
- 六类 changeset schema保持跨平台；create→apply capability不再伪造 parity。当前 admitted Linux
  可完成六类，Darwin npm/git Plugin在 Composer/model阶段disabled，managed Skill与其余 DTO
  enabled路径保持；两平台 Plugin in-place update继续 unsupported。Darwin exact file-Plugin
  modify由 pre-session grant在 create transaction换成 opaque session handle；generic Composer
  grant与session model capability是不同 strict DTO，raw spec/path不进入任一 wire/model surface。
  同一 binary前后端按 DTO/model contract协调。
- 旧 apply journal 的 client id 因缺 request body只能迁为 `legacy-unverifiable`；新 frontend
  通过 detail/history reconcile，不能 POST 冒充 exact replay。异机恢复因 backup 本就不含
  `secret.key`，旧 HMAC 同样 fail closed；需在 disaster-recovery/doctor 文案中说明，但历史
  journal/receipt 保持可读，新 client id正常工作。
- containment EMPTY不复用 `secret.key`：每个 released receipt自带一次性 Ed25519 public key，
  private key仅存活于 non-dumpable supervisor。旧 HMAC containment draft codec从未由 released
  binary产生；若发现手工/部分构建 row按 unknown codec进入 repair-required。
- `ArtifactWriterObligationLedgerV3`故意不进入 backup/restore；升级第一次启动需先建 strict empty
  ledger，之后 DB released receipt与 external obligation必须成对。doctor可报告 mismatch但不得
  删除/伪造 obligation。异机恢复没有旧 host writer，因此从空 ledger开始；同机回滚 DB仍保留
  restore前 obligation并先收口。
- `ArtifactPublicationLedgerV3`同样属于 broker control state且不进入 backup/restore；boot在 DB
  open/swap前先把 syscall歧义分类为 prepared/exchanged或 repair-required，但保留 displaced
  authority；读取对应业务 row/marker及其 barrier后才 cleanup-verified。异机恢复从空 ledger
  开始，同机 DB回滚不能擦除尚未 cleanup的 displaced authority。
- `PendingRestoreControlLedgerV3`也属于 non-restored broker control state；v1不做 TTL/数量 GC。
  同机 restore/rollback后 stage/cancel exact replay继续有效；异机恢复从空 ledger开始，只表示没有
  旧 host pending-control receipt，不允许从 archive文件名合成 receipt。升级前 legacy pending
  通过独立 `legacy-unverifiable` evidence record分型：active-pair无论是未开始还是 released
  post-swap failure都先 operator-confirmation-required并阻断自动 boot，只有 stopped CLI exact
  inspect后以新 mutation显式 reapply/quarantine；marker-only只 consumed cleanup、archive-only只
  quarantine、failed/ambiguous typed repair。永不信任 `stagedTarball`或伪造 caller scope/id。
- `LegacyPendingOperatorLedgerV3`同样不进入 backup/restore且在 V3 control/DB前扫描；它按 stable
  local caller scope/id持有 active-pair显式决定与
  V3-private-stage/legacy-move-publication/adoption-hold/V3-marker handoff phases。move
  publication在 rename前保存 opaque target slot与 absent proof，settled receipt仍引用它。异机恢复从空 ledger开始，只能把当地
  legacy bytes重新投影为 operator gate；不得从 partially restored DB猜已授权决定。
- `ArtifactLegacyArchiveAdoptionLedgerV3`同属 non-restored broker control state。升级第一次
  retention前 descriptor-verify既有 archive并写 adoption receipt；它与 publication receipt是
  不可互换的 discriminated authority。旧 scheduled/auto仍受 count/days/size策略，旧
  manual/pre-\*与统一 last-good保持保护；malformed/ambiguous旧 entry只进入 repair。
- `WorktreeReconstructionLedgerV3`同属 non-restored broker control state；DB restore不能擦除
  partial Git registration/target的 cleanup authority。它保存 operation/task/container/repo
  fences、root/namespace/container/target directory publication state、每 repo target reservation、
  registration preparation、bounded admin inventory、target identities、
  `none|partial|registered` effect与 branch/ref before-after；零目录effect以 `closed-absent`
  终结，shared operation-created infrastructure以 `created-infrastructure-retained`闭合，不保存
  absolute path，也不存在
  completed-index平行数组；restored DB open后先收敛 private/canonical publication再合并
  `task_repos[]`才可继续。
- backup archive不包含上述 broker control/adoption ledger，也不包含 `secret.key`。restore保持当前
  regular-file `config.json` ABI：archive无 config是 explicit preserve，archive有 config是
  file exchange；没有 config目录 migration。所有新 backup writer同 release切换到
  `ArtifactBackupCapabilityV3`，不保留兼容 raw-path fallback。新 worktree payload使用完整
  `task_repos[]`的 v2 layout；旧 v1仅允许 single-repo reconstruction，multi-repo明确 skip而不
  生成半工作区。
- restore HTTP同版本切换为 raw-stream PUT + strict status/mutation/cancel schema；旧 multipart
  POST与无 body DELETE不保留 raw-path compatibility。Settings与 CLI在 effect前建立 safe
  locator；Settings按 actor prefix保留 foreign locator并只在原 actor terminal或显式确认时删除。
  local-control同版本切换为
  `inspect-backup | stage | lookup | cancel` strict union，default plan/dry-run不再直接读取 caller
  path或复用 stage side effect。same-binary frontend/daemon/CLI必须协调发布。
- WS 新 frame 是 additive；旧 handler忽略未知 frame的兼容性由 schema/consumer test证明。
  execution frame只带 locator/seq；session payload始终通过HTTP strict DTO读取。
- i18n 同 commit 对称落地。
- 实施完成前跑 Codex 实现门；本 RFC 设计门 findings 记录在同目录。
- 提交/推送另需用户明确授权；共享 `main` 只精确处理本 RFC 路径。
