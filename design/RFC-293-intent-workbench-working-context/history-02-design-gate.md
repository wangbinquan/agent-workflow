# RFC-293 Codex 设计门记录（2026-08-12）

## 1. 范围与基线

- 审查对象：RFC-293 `proposal.md` / `design.md` / `plan.md`，不含生产实现。
- pinned Git 基线：`90602fc81347ed7a6cef6893a3d79cbbad813b85`，与审查时 `origin/main` 一致。
- 隔离 worktree：`/private/tmp/agent-workflow-rfc293-design-gate-019ff60c`。
- 方法：Codex `gpt-5.6-sol` / `max` / read-only source-backed adversarial review；逐项要求具体输入、
  时序、错误结果与 live source seam，不接受只数 happy paths。
- 第一轮结论：**FAIL（12 P1 + 1 P2）**。因此未请求用户批准，也未修改生产代码。

## 2. 第一轮 findings 与修订

### F1 — P1：高度链不能形成两个真实滚动 owner

- 复现：1536×960 的 3000px timeline + 2000px review；原设计 pane grid item仍为
  `min-height:auto`，内容撑高后被 `.content{overflow:hidden}` 裁切。390×568再压低可视高度时 Composer
  不可达。
- source：`packages/frontend/src/styles.css:251-270,3026-3038`。
- 修订：`design.md` §2.2/§2.3 明确 page/workbench/pane/scroll完整高度链、
  `auto minmax(0,1fr)` pane rows、short visual viewport chrome折叠；browser验收同时断言真实 overflow、
  review rect 与约 300px可视高度下 Composer/submit可达。

### F2 — P1：ledger 在 freshness 后查询会破坏 exact replay

- 复现：revision 7 的 M1已 applied到 8但 HTTP response丢失；同 body重试先撞 revision/archive/apply门，
  无法返回原 receipt。
- source：`packages/backend/src/services/intent/applyChangeset.ts:346-374` 已有正确先例。
- 修订：`design.md` §6.1 固定 owner-scope → canonical hash → ledger-before-freshness；只有新 mutation走
  writable/OCC/in-flight/apply/budget。applied/no-op/failed/superseded/canceled/dismissed及后来 archive/
  apply状态都纳入 replay tests。

### F3 — P1：failed change 无法放弃或被可靠收口

- 复现：queued addition在 terminal前被删/撤权，row failed；原 cancel/replace只接受 queued，journey可
  永久卡在历史 failed。
- 修订：schema增加 `dismissed/stateVersion/resolvedByChangeId`；failed可 exact dismiss或被新 change
  supersede。Detail先取 latest row再判断是否显示，dismiss后 clean旧 draft允许提交。

### F4 — P1：queued 的异步 terminal 状态不可对账

- 复现：queued→no-op 或 cancel response丢失；detail过滤 terminal row后提示消失，客户端无法区分成功、
  取消与丢失。
- 修订：按 change id / client mutation id提供 actor-safe current receipt查询；cancel/dismiss重复返回原
  receipt，其它 terminal返回 typed current state；POST same-body replay也返回 row当前状态。

### F5 — P1：“刚 terminal 的旧 id”没有 exact 定义

- 复现：Tab A pin T1/revision4；Tab B又完成 T2/T3但不 bump context；A提交旧 T1仍可能被接受。
- 修订：working-set request增加 `expectedTurnSeq`；running与 idle-race都校验 exact session/role/kind/
  id/seq。idle-race只接受 session latest terminal agent turn且其后无任何 user/agent turn；覆盖跨 session。

### F6 — P1：claim→controller 与 semaphore wait 存在取消黑洞

- source：`packages/backend/src/services/intent/turnEngine.ts:362-364,622-646`、
  `packages/backend/src/util/semaphore.ts:41-49`。
- 修订：cancel先写 exact durable DB flag；registry绑定 turn+claim；claim后每个 await与 spawn前复验；
  semaphore acquire接受 AbortSignal并移除 waiter。barrier tests覆盖 pre-controller/config/waiting/spawned。

### F7 — P1：daemon存活时 lost wake / owner registration failure不会收敛

- 复现：reservation commit后 wake丢失，或 claim commit后构造 actor抛错；boot不再运行，hourly tick不足以
  担任核心活性。
- 修订：`design.md` §7.3新增 fake-clock短周期 reconciler：unclaimed past grace重派，claimed且连续
  scan无 exact live owner则在 process fence后 typed settle；真实 live owner不按墙钟回收。

### F8 — P1：shutdown/boot只围栏 DB，detached child可与 successor双跑

- source：`packages/backend/src/services/execution/managedProcess.ts:248-260`、
  `packages/backend/src/cli/start.ts:925-981`、`packages/backend/src/services/shutdown.ts:24-34`。
- 修订：dispatcher shutdown停止 claim并 TERM/KILL/reap exact process group；持久化防 PID reuse身份；
  boot在 listener前完成 process fence。另补 launch-token + supervisor control-pipe handshake：DB identity
  commit前模型不 exec，parent EOF/timeout时 supervisor自杀，关闭 spawn→DB无身份窗口。

### F9 — P1：generation budget 缺 authoritative 时点

- source：`packages/backend/src/services/intent/turnEngine.ts:304-335` reserved path不会用 current max复验。
- 修订：immediate apply与每个 terminal handoff都在 manifest transaction前 fresh resolve canonical
  generation policy，持久绑定 fingerprint/max并在同 tx查 budget；失败时 manifest/epoch/turn零变化。
  Dispatcher只接受 exact fingerprint；apply后配置变化走 typed start failure与 Retry，不换配置运行。

### F10 — P1：dump 后、模型 seed释放前缺最终授权

- source：`packages/backend/src/services/intent/turnEngine.ts:485-547,622-652`；相邻完整合同见
  `design/RFC-235-intent-builder-ux/design.md:691-718`。
- 修订：claim-bound frozen disclosure snapshot覆盖 current principal、visible set、ACL revision与 content
  fence；紧邻 model release前重算 digest并 exact claim CAS admission。disable/role/ACL/owner/content变化
  均丢 held seed、typed settle、spawn=0。

### F11 — P1：combined action会把 mount receipt raw id写进下一轮 prompt

- source：`packages/shared/src/schemas/intentSession.ts:348-365`、
  `packages/backend/src/services/intent/session.ts:645-674`、
  `packages/backend/src/services/intent/turnEngine.ts:145-152,535-547`。
- 修订：持久审计 receipt与 `turnModelText` 分离；模型只得到 type/name/handle/decision/answer，禁止
  candidate/session/change/owner id。测试捕获真实 `INTENT.md` 并对具体 ULID负断言。

### F12 — P1：remove non-root 在三件套中语义冲突

- source：`packages/backend/src/services/intent/session.ts:887-913` 现行 legacy返回 404。
- 修订：唯一合同为 remove必须 exact current root；known non-root/unknown/mixed invalid整批失败。只有
  empty或 all-add-satisfied且无 remove才 no-op；legacy adapter锁住 add-existing 409与 remove 404。

### F13 — P2：pinned-scroll漏掉 same-turn terminal refetch

- 复现：T1 id与 event count不变，但 running→大 changeset/error；原 hook不触发，底部内容落到 fold下。
- 修订：DOM更新前持续缓存 pin状态；render signature增加 kind/captureState/updatedAt/draft/error身份。
  pinned跟随，unpinned保位并增加 unseen；覆盖零新 event的 start failure。

## 3. 第二轮复审

- session：`019ff643-b977-7802-bd6c-c4645f89c300`。
- 取证基线仍固定 `90602fc81347ed7a6cef6893a3d79cbbad813b85`；复审期间共享 `origin/main` 被并发
  推进到 `f4ef23b12c8ee9e2fcafea4ab492c124dfd29327`，新增路径不涉及 Intent/RFC-293，未混入源码锚点。
- 结论：**FAIL（6 P1）**。第二轮读取的是开始时复制的修订快照；期间主工作树继续做自审修订，以下
  finding仍逐条按输入/时序重新核对，不以“主树后来写过”跳过。

### F14 — P1：no-op 绕过 exact causal turn fence

- 复现：session `turnSeq=9/inFlight=T9`，请求 seq正确但 turn id为空、古老或来自另一 session，delta仅
  add already-root；旧顺序先分类 no-op并写 receipt，未进入 effectful分支的 exact id gate。
- 修订：`design.md` §6.1把 running/idle/just-terminal exact session/id/seq/role/kind admission移到所有新
  mutation的 no-op分类前；stale/foreign失败时 ledger零 row。tests把三类 turn mismatch分别与 empty/
  all-root no-op交叉。

### F15 — P1：no-op 绕过 already-root addition 的最终存在/ACL复验

- 复现：RFC-291保留的 unavailable root已删除/撤权，旧客户端仍以 machine id提交 add；纯函数按 manifest
  判 satisfied，错误返回 no-op。
- 修订：每个 requested addition（含 already-root）都在同一 final transaction查询 canonical row并调用
  `canViewResourceInTx`，通过后才运行纯函数/no-op分类；删除/不可见同形404且 ledger零 row。已失效 root
  仍可按 handle remove，不可借 raw id重新 add。

### F16 — P1：interrupt journal 与 durable cancel 有两事务丢失窗口

- 复现：interrupt queued row已提交，第二个 cancel transaction遇到 DB busy；same-body replay只返回 queued，
  当前轮继续，动作静默退化为 after-current。
- 修订：effectful interrupt的 journal insert/replace、`interruptCommittedAt` 与 exact old turn
  `cancelRequestedAt`改为同一 transaction；commit后只做 DB-confirmed best-effort内存 abort/wake。
  unclaimed cancel由 dispatcher/reconciler/boot共用可重入两阶段 convergence：事务外准备 typed policy、
  事务内 exact settle+drain。

### F17 — P1：普通 terminal 未等待 whole process tree 退出证明

- source：现行 `managedProcess.ts:459-498` 的 post-exit pipe drain deadline可返回
  `exited+drainTimedOut`，`child-unkillable`更明确表示仍可能存活。
- 修订：Intent supervisor把语义 outcome/capture evidence与 whole-tree proof分离；POSIX group除 reporting
  supervisor外为空、Windows Job active count为0后，endpoint关闭且 supervisor被 daemon reap，四条件全真
  才允许 terminal wrapper。否则 CAS `reap-pending`并保留 claim/session/semaphore/lease；禁止 drain与
  successor。旧 managed-process outcome不能单独充当 proof。

### F18 — P1：legacy running 无 identity 时会被误判无进程

- source：旧 shutdown不处理 Intent `liveTurnAborts`，detached child可能越过旧 daemon退出；absence of
  identity不能证明 absence of runtime。
- 修订：migration把升级瞬间的 legacy running标 `legacy-unfenced`；boot在 listener前 fail closed，不自动
  settle/resume。正常升级先等旧版 idle；历史 crash row仅能在 daemon停止、doctor取得 daemon lock且操作员
  对 exact turn显式 `--confirm-no-live-process` 后审计收口，不自动 drain/start successor。

### F19 — P1：daemon-alive reconciler 会过早收口 launching token-only

- 复现：phase=launching/token已写、supervisor已建立 lease但 DB identity尚未提交，live registry丢失；旧
  reconciler只见 identity为空便 settle/drain。
- 修订：phase-aware收敛：只有 `claimed|waiting`且 token/identity/endpoint全空才能直接 settle；
  `launching`即使 identity为空也要关闭 control pipe、challenge endpoint或等待 handshake deadline证明
  supervisor未 release且已退出；`spawned|reap-pending`必须完整 whole-tree fence。不能证明就保留 claim。

## 4. 最新修订版复审

- 状态：**Pending**。
- 进入条件：把含 F14–F19 修订的三件套格式化、链接/diff检查通过，复制到当前
  `f4ef23b12c8ee9e2fcafea4ab492c124dfd29327` pinned worktree后重新运行独立 read-only gate。
- 通过条件：无 P0/P1/P2阻断；若仍有 finding，继续修订并再次复审，不把 FAIL降格成用户自行承担。
