# RFC-293 实施计划：Intent Workbench 与 Working Context

- 状态：Draft（设计完成后待用户批准；未批准前不得修改生产代码）
- 依赖：RFC-235 Done、RFC-273 Done、RFC-291 Done
- 并发边界：共享 `main`；只精确处理本 RFC 路径；开工前重新检查 RFC 编号、migration journal、
  `intent.detail.tsx` / `styles.css` / `schema.ts` / i18n / `STATE.md` 的并发 diff。

## 0. 交付顺序

```text
设计门
  ↓
批 A：shared contract + migration + working-set纯函数
  ↓
批 B：journal / terminal drain / dispatcher / boot recovery
  ↓
批 C：HTTP + current-action convergence + write gates
  ↓
批 D：frontend workbench + working context + scroll controller
  ↓
批 E：E2E / visual / a11y / 实现门 / 全门禁
```

每批均先写能稳定复现问题的测试，再写实现；每批形成能 typecheck 的最小自洽 commit，不让
“定义在 A、消费在 B”的半成品留在共享工作树。

## 1. 设计门（RFC-293-T0）

- [ ] T0.1 用户确认 proposal 的 D1–D16，特别是默认 after-current、interrupt 次动作、legacy API
      保持与 combined current action。
- [ ] T0.2 在 live `main` 重新核对：
  - `styles.css` Intent 与 `.content` scroll contracts；
  - `intent.detail.tsx` 所有挂载/问题/提交 gate；
  - `session.ts` add/remove/reserve；
  - `turnEngine.ts` cancel/settle/live abort map；
  - `maintenance.ts` boot recovery；
  - `routes/intentSessions.ts` route-local `fireTurn`；
  - `schema.ts` / latest migration journal；
  - RFC-291 manifest/high-water helpers；
  - RFC-284/286 是否已有同面改动。
- [ ] T0.3 按仓库 Codex 设计门要求做 source-backed adversarial review；逐条核实 finding，记录到
      `design-gate-YYYY-MM-DD.md`。第一轮 12 P1 + 1 P2、第二轮 6 P1全部修入三件套；必须以最新版
      再复审，无阻断项才再次请批。
- [ ] T0.4 用户批准后把三件套与 RFC index 状态从 Draft 改为 In Progress；STATE 标明批准范围。

## 2. 批 A：Wire、DB 与纯函数

### RFC-293-T1 Shared schemas

- [ ] T1.1 在 `packages/shared/src/schemas/intentSession.ts` 增加：
  - `IntentWorkingSetDeltaSchema`；
  - `PostIntentWorkingSetChangeSchema`；
  - `IntentWorkingSetChangeDtoSchema`；
  - `PostIntentCurrentActionSchema` / receipt；
  - `IntentWorkingSetErrorCodeSchema`；
  - `expectedTurnSeq`、supersedes/transition stateVersion、完整 terminal state/receipt、cancel/dismiss receipt；
  - detail 的 `inFlightTurnId/latestWorkingSetChangeId/workingSetChange/ownerDisplayName`；
  - journey reasons。
- [ ] T1.2 canonical delta / request fingerprint helper 只放 shared 一处；add/remove order 不改变 hash。
- [ ] T1.3 扩 Intent WS union仅做 session invalidation；断言任何 WS frame不含 delta/resource id。
- [ ] T1.4 中英文 i18n 类型与 key 同 commit 对称落地。
- [ ] T1.5 shared tests：strict/unknown/duplicate/contradiction/order/fingerprint/detail/journey/WS。

### RFC-293-T2 Migration / schema

- [ ] T2.1 开工时读取 `packages/backend/db/migrations/meta/_journal.json` 与磁盘最后 migration，分配
      连续编号；不得把当前观察的 0151 写死。
- [ ] T2.2 新建 `intent_working_set_changes`、run-as/expected seq/state version/resolution columns、
      unique/partial unique/index/check。
- [ ] T2.3 新建 `intent_generation_requests` ledger。
- [ ] T2.4 `intent_turns` 加 run-as、generation-policy、claim/cancel/phase（含 reap-pending）、runtime
      lease start/token/process identity与 disclosure admission columns；migration把升级瞬间 legacy running
      row标 `legacy-unfenced`，避免 boot重跑
      可能已 spawn 的 turn；boot fail closed，nullable legacy row不能
      自动 terminal/resume。
- [ ] T2.4a 增 daemon-offline doctor exact recovery：取得 daemon lock + 显式
      `--confirm-no-live-process` 才 settle legacy-unfenced row，写审计且不自动 drain/start successor。
- [ ] T2.5 更新 Drizzle schema、schema admission allowlist / expected metadata。
- [ ] T2.6 migration tests：fresh、upgrade with idle、upgrade with live legacy row、rollback on malformed
      duplicate queued fixture、journal/file 连续性。

### RFC-293-T3 Working-set pure function

- [ ] T3.1 新增 `services/intent/workingSet.ts`；复用 RFC-291 manifest allocator/watermark helpers。
- [ ] T3.2 add existing root/closure/new、remove exact root、known non-root/unknown/mixed invalid rollback、
      仅 empty/all-add-satisfied-no-remove no-op、contradiction、immutable input。
- [ ] T3.3 unavailable root removal、六类型、超 64 roots（证明不引入数量上限）、ordinal 不回退。
- [ ] T3.4 legacy `addIntentMount/removeIntentMount` 改为单项 wrapper + response adapter；锁住
      add-existing 409、remove non-root/unknown 404 与旧 body/response。
- [ ] T3.5 变异实证：去掉 high-water seed、先 add 后 remove、允许 remove non-root、每 add bump一次都
      必须被测试抓红。

### 批 A 验证

- [ ] shared 定向测试、backend migration/workingSet定向测试。
- [ ] shared/backend typecheck、ESLint、Prettier、schema drift test。
- [ ] 精确路径 commit；不得带 `runner.ts`、RFC-284/285/286 或其他并发 WIP。

## 3. 批 B：Journal、Terminal Handoff 与 Dispatcher

### RFC-293-T4 Journal service

- [ ] T4.1 新增 `services/intent/workingSetChanges.ts`：owner scope、create/replay/replace/cancel/dismiss/
      exact receipt/project DTO。
- [ ] T4.2 固定 owner授权→canonical hash→ledger-before-freshness；same mutation same hash在任意后来
      session状态下返回 current receipt；changed hash 409、cross-owner 404、partial unique处理两标签页。
- [ ] T4.3 projection fresh resolve name/owner；不可见/删除显示 null。machine `resourceId`仅供 authorized
      picker重建且 source/DOM/log/WS守卫不渲染。
- [ ] T4.4 先取 latest row再决定是否投影 queued/failed；任意 terminal可按 change/mutation id查询，
      历史 failed不能复活。
- [ ] T4.5 latest failed→dismiss或supersede、latest mutable queued→cancel/supersede exact stateVersion CAS；
      interruptCommitted queued拒绝变化；重复动作返回原 receipt，其它 terminal返回 typed current state。
- [ ] T4.6 日志 scrub测试：payload、resource id、owner id不进入普通 log。
- [ ] T4.7 所有新 mutation在 no-op分类前完成 exact running/idle/just-terminal causal turn admission；每个
      addition（含 already-root）final查 canonical row + ACL。古老/跨 session id与 unavailable root失败时
      ledger零 row，合法 no-op才写 receipt。

### RFC-293-T5 Terminal drain

- [ ] T5.1 抽 `settleIntentTurnInTx` / `drainQueuedWorkingSetChangeInTx`，统一所有清 slot 路径。
- [ ] T5.2 每条 terminal path在事务前 fresh resolve canonical generation policy；用 `secret.key` 的独立
      domain HMAC绑定完整执行语义、DB只存 fingerprint/max；apply前以 current-session owner session
      actor复验 principal/session/permission/ACL/OCC/apply，并用绑定 max查 budget；失败 row terminal、
      manifest/epoch/turn零变化。
- [ ] T5.2a policy prepare+reservation/drain tx复用 `withRuntimeProbeConfigFence` 与 config PUT串行，tx内
      复验 runtime profile fence；config CLI取得同一 cross-process lock，不能并发绕过 daemon fence。
- [ ] T5.3 effectful：context+watermark+context-change user turn+new running reservation+journal receipt
      同 transaction。
- [ ] T5.4 no-op：不 bump、不 turn、不 budget。
- [ ] T5.5 normal changeset settle先安装 old draft，再同 tx bump使其 stale并占住 new running slot。
- [ ] T5.6 questions/error/start-failure/unclaimed cancel/boot recovery五条 caller全部接同一 async
      policy-prepare + terminal transaction；曾 launch的 caller必须先携 whole-tree exit proof；覆盖“预读无
      queue后竞态插入 queue”。
- [ ] T5.7 事务注入失败点：manifest write 后、user turn 后、running turn 后、journal receipt 前；每处
      全 rollback。
- [ ] T5.8 main exited、drainTimedOut、unreaped/child-unkillable 与 tree-empty proof正反测试：proof前
      保留 slot/claim且 queued不drain；proof后才原子 settle+drain。daemon在 reap-pending崩溃时允许丢未
      commit candidate，但 boot必须先 fence再 typed restart settle。

### RFC-293-T6 Exact cancel

- [ ] T6.1 DB增加 exact cancel request；registry按 `turnId+claimId`持 controller/phase，abort/delete compare
      两者。
- [ ] T6.2 effectful interrupt以 latest supersedes id/stateVersion + turn id/seq，在**创建/替换 journal的
      同一 tx**写 interrupt marker与 durable cancel；区分 unclaimed、claimed-pre-controller、waiting、
      launching、spawned、reap-pending；每个 claim后 await与 spawn前复验 durable flag。
- [ ] T6.3 semaphore实现 abortable acquire，abort时从 waiter queue移除；interrupt先 journal commit后
      只做 DB-confirmed best-effort abort/wake，durable cancel不得另开第二个 transaction。
- [ ] T6.4 cross-tab replace-vs-interrupt CAS两种顺序、claim/pre-controller、config await、semaphore wait、
      spawned process、later-turn mismatch、old finally delete-new-owner、双 click/response loss barrier tests；
      cancel flag commit→unclaimed terminal之间杀 daemon也由 boot收敛；未 spawn路径启动次数为0。

### RFC-293-T7 Dispatcher

- [ ] T7.1 新增 `services/intent/dispatcher.ts`，搬走 route-local `fireTurn`、broadcast throttle；`wake()`
      non-throwing且 route只 reserve+wake。
- [ ] T7.2 unclaimed current turn CAS claim；绑定 daemon/claim/run-as/policy，fresh owner普通用户构造
      `source:'session'` actor，只有 exact system owner可 daemon；不允许 fallback。
- [ ] T7.3 reservation前持久化 generation policy HMAC fingerprint/max；DB不存 extra instructions、
      credential/env正文；dispatcher fresh resolve + timing-safe exact match，policy changed typed settle，
      不换配置运行。
- [ ] T7.4 实现 claim-bound `prepareIntentDisclosureSnapshotInTx` / `admitIntentDisclosureInTx`；held seed
      仅 final admission后交给模型；initial-unavailable root冻结 tombstone并沿 RFC-291 safe skip，
      snapshot窗口内 availability变化才 abort。
- [ ] T7.5 短周期 fake-clock reconciler：lost wake、unclaimed grace、claimed-without-live-owner连续 scan；
      `claimed|waiting`且无任何 lease才能直接 settle；`launching` token-only须 handshake-deadline fence，
      `spawned|reap-pending`须 whole-tree fence。exact live owner不按墙钟回收，hourly maintenance只诊断。
- [ ] T7.6 managed process实现 launch-token + supervisor control-pipe + POSIX 0600 Unix socket / Windows
      current-SID named-pipe handshake：
      DB identity commit前模型不 exec，parent EOF/timeout自杀；supervisor在模型全生命周期保持
      challenge server以防 PID reuse并负责 TERM/KILL/reap。graceful shutdown停止 claim、abort
      semaphore/controller并收口 exact Intent process tree。
- [ ] T7.6a supervisor byte-for-byte relay stdin/stdout/stderr、backpressure/EOF/pump-error/line truncation与
      exit/drain outcome；另产出 challenge matched + containment empty + endpoint closed + supervisor reaped
      的 whole-tree proof。drainTimedOut/unreaped本身不得 terminal。生产 path不可被 runFn绕过，测试使用
      fake-launch-lease adapter。回归现有 system-agent capture golden与 managed-process pump/reap族。
- [ ] T7.7 boot在 listener前先 fence带可验证 RFC-293 lease的旧 claimed runtime；无法证明死亡则 fail
      closed。随后若仍有 legacy-unfenced直接拒绝 boot；只 recover已证明无 runtime的 RFC-293 claimed turn，
      unclaimed留给 dispatcher，recovery drain queued。
- [ ] T7.8 route create/message/answers/retry与新 refresh reservation统一 dispatcher；terminal后wake next。
- [ ] T7.9 tests：double wake、cross-session concurrency、same-session singleflight、lost wake、claim-owner
      窗口、launching token-only owner loss、runFn/config error、policy降额/改变、disclosure TOCTOU、
      graceful/hard kill、broadcast cursor。
- [ ] T7.10 platform tests：POSIX Unix socket/process-group与 Windows current-SID named pipe/Job Object真实
      helper；POSIX证明 group除 reporting supervisor外无成员再关闭 endpoint/reap supervisor，Windows不得用
      taskkill tree snapshot替代 durable Job live-count证明。

### 批 B 验证

- [ ] backend intent turn-engine/routes/maintenance/dispatcher定向全量。
- [ ] backend typecheck/lint/format；现有 RFC-234/235/273/291 tests 全跑。
- [ ] pin到本批 commit的隔离 worktree再跑定向，排除共享树中途写入。

## 4. 批 C：HTTP、Current Action 与写门

### RFC-293-T8 Working-set routes

- [ ] T8.1 `POST /working-set-changes` parse→owner scope→ledger/fresh service→dispatcher wake→shared parse。
- [ ] T8.2 exact change/mutation GET receipt、cancel queued与dismiss failed routes；重复/其它 terminal typed
      response，archived owner replay仍可对账，audit/stranger 404同形。
- [ ] T8.3 idle/running/race-to-idle、expectedTurnSeq、same-session old/cross-session turn、replace/replay/
      cancel/dismiss/error route integration tests；古老/跨-session turn与 unavailable already-root addition各自
      与 no-op交叉，断言零 ledger row。
- [ ] T8.4 token/PAT/daemon auth矩阵按现有 `intent:write`合同回归。

### RFC-293-T9 Combined current action

- [ ] T9.1 新增 `intent_generation_requests` service；source questions/request safe parse与完整覆盖。
- [ ] T9.2 一个 tx写 audit mount-approval（如有）→ answers（如有）→ one running reservation；run-as与
      generation policy同 working-set reservation合同。
- [ ] T9.3 approved mounts复用 working-set pure fn，只 bump一次；reject-only仍 reserve。
- [ ] T9.4 owner scope→strict wire hash→ledger-before-source/freshness；same request在 source损坏/删除及后来
      archive后仍 replay；changed body/source superseded/candidate ACL changed/one invalid decision全 rollback。
- [ ] T9.5 `turnModelText` 区分审计 receipt与 model-safe semantics；真实 `INTENT.md` 对 approve/
      already-mounted/reject/questions测试具体候选 ULID不出现。
- [ ] T9.6 新 `/current-action` route；legacy endpoints 保留，frontend source guard稍后锁定不再调用。

### RFC-293-T10 Gates / journey / detail

- [ ] T10.1 `assertNoUnresolvedWorkingSetChange` 接 commit/message/answers/retry/rebase/legacy mounts/archive
      与 apply start最早事务；failed dismiss后 clean old draft可提交。
- [ ] T10.2 journey reasons与优先级；pending + old draft / failed + current draft / apply unsettled反例。
- [ ] T10.3 detail投影 exact inFlight id、latest change id、仅 latest unresolved change、owner display；
      admin audit actor-safe，历史 failed不复活。
- [ ] T10.4 context-change turn semantic DTO/prompt；raw id/queue id/hash负向守卫。
- [ ] T10.5 WS invalidate queued/applied/failed/replace/cancel，不传 delta。
- [ ] T10.6 error code allowlist与前端可恢复映射。

### 批 C 验证

- [ ] backend route + service + journey + prompt isolation定向。
- [ ] shared/backend full intent test family。
- [ ] API compatibility：legacy add/remove/answers/approvals现有 tests不改语义通过。

## 5. 批 D：Frontend Workbench 与 Working Context

### RFC-293-T11 Route decomposition

- [ ] T11.1 从 `intent.detail.tsx` 抽 `IntentWorkbench/ConversationPane/ReviewPane`，先做零行为 component
      extraction并保持测试绿。
- [ ] T11.2 抽 `deriveIntentActionAvailability`，message/context/current-action/commit共用。
- [ ] T11.3 保留 commit Dialog pinned draft identity、IntentTurnSession、IntentOpPreview现有合同。

### RFC-293-T12 Viewport workbench

- [ ] T12.1 `.content:has(.intent-session-page)` 与 page/workbench/pane完整 height chain；page column+hidden、
      workbench `minmax(0,1fr)`、pane `auto minmax(0,1fr)`、每层 `min-height:0;overflow:hidden`，scroll child
      才 `overflow:auto`。
- [ ] T12.2 移除 `max-width:1400px`；列宽 clamp + right remainder；container query compact断点。
- [ ] T12.3 左右命名 scroll region、focus gutter/outline、overscroll containment。
- [ ] T12.4 op outline取消嵌套纵向滚动；canvas width/height与expanded Dialog不回归。
- [ ] T12.5 mobile keep-mounted tabs、390px context summary、visualViewport short-height chrome折叠、
      Composer flow/scrollIntoView且不抢未聚焦位置。
- [ ] T12.6 source-level layout guards不能替代 browser geometry，但要锁滚动 owner与width contract。

### RFC-293-T13 Pinned timeline

- [ ] T13.1 `usePinnedScroll` 在 DOM更新前缓存 pin判据；signature覆盖 kind/captureState/updatedAt/draft/error/
      event count；near-bottom、unseen count、session reset、ordinary refetch preserve。
- [ ] T13.2 “回到最新” role/name/count、keyboard、reduced motion。
- [ ] T13.3 expanded Session live event与same-id/same-event-count的 terminal final refetch/start-failure均走
      同一 pin判据；pinned跟随、unpinned保位+unseen。

### RFC-293-T14 Working context UI

- [ ] T14.1 `IntentWorkingContextBar` applied/queued/interrupting不可逆/refresh/failed/no mount/read-only状态。
- [ ] T14.2 actor-safe chips最多3+N；unavailable显示type+handle，不渲 raw id。
- [ ] T14.3 `IntentWorkingContextDialog` 复用 Dialog/Segmented/ResourcePicker/Field/Banner；一次 staged
      delta提交，不循环 legacy请求。
- [ ] T14.4 idle/running CTA、queued replace/cancel、failed replace/dismiss、terminal receipt查询、pending
      mutation lock、dirty remote update、response-loss reconcile。
- [ ] T14.5 apply-running/archive/audit精确 disabled reason。
- [ ] T14.6 `IntentMountDialog` 仅保留 legacy；depcheck若确认零生产调用，按独立明确删除清单处理。

### RFC-293-T15 Current action / review

- [ ] T15.1 questions + mount requests合并 current action，完整决策后一次 POST。
- [ ] T15.2 audit只读语义、source superseded清 state、receipt后聚焦新 running/live region。
- [ ] T15.3 review action bar展示 queued/refresh/stale/failed/validation reason与可行动 CTA。
- [ ] T15.4 new draft identity才更新 selected op；左右 scroll/pan不因poll/WS refetch重置。

### RFC-293-T16 Frontend tests / i18n

- [ ] T16.1 action availability全矩阵。
- [ ] T16.2 work context bar/Dialog/component API calls与legacy route负向断言。
- [ ] T16.3 pinned scroll hook + integration。
- [ ] T16.4 current action一次提交、error/replay/cross-tab。
- [ ] T16.5 read-only/archive/unavailable/no-op/long names/all six types。
- [ ] T16.6 role/focus/ARIA/i18n parity/390px source guard。

### 批 D 验证

- [ ] `bun run --filter @agent-workflow/frontend test` 全量。
- [ ] frontend typecheck/lint/format/depcheck。
- [ ] 真实本地浏览器 1536/2560/1100/390×844/390×568，light+dark。

## 6. 批 E：系统 E2E、视觉与收尾

### RFC-293-T17 E2E fixtures

- [ ] T17.1 Intent stub增加可控制 long-running/release/abort/second-draft variant，保留现有 nonce合同。
- [ ] T17.2 runtime overlap probe记录每次启动/结束、supervisor PID/tree identity/lease endpoint与max concurrent；interrupt/boot
      必须max=1。
- [ ] T17.3 barrier hooks覆盖 claim commit/pre-controller/config/semaphore/dump/final-admission、launch token、
      supervisor lease、identity commit、release；daemon alive lost-wake与只杀 daemon PID的 hard-kill hooks。

### RFC-293-T18 Browser acceptance

- [ ] T18.1 1536/2560 geometry；两栏真实 overflow、独立scroll、右artifact rect始终在viewport。
- [ ] T18.2 live pinned/up-reading + same-turn terminal refetch。
- [ ] T18.3 running after-current自动第二轮、fresh draft commit，无人工message。
- [ ] T18.4 interrupt在四个 phase exact cancel + no overlap。
- [ ] T18.5 idle mixed delta、精确 no-op、failed adjust/dismiss、terminal receipt recovery。
- [ ] T18.6 combined current action。
- [ ] T18.7 two-tab replace conflict。
- [ ] T18.8 390 touch/short viewport/soft-keyboard压至约300px，Composer/submit可达。
- [ ] T18.9 axe、focus-ring clip、reduced motion。
- [ ] T18.10 daemon-alive lost wake自愈；token-only launching owner loss不早 settle；hard kill只杀 daemon
      PID，旧 child/process tree消失后才 successor。
- [ ] T18.11 dump后撤权/disable/owner transfer/content change，模型调用次数为0。

### RFC-293-T19 Visual

- [ ] T19.1 新增 Intent desktop workbench light/dark scene与390px scene；截图前等待font/theme/query稳定。
- [ ] T19.2 本地只更新 Darwin目标基线；Linux从hosted artifact取权威actual，逐张审阅。
- [ ] T19.3 intentional diff清单：page width、context bar、independent pane、review canvas；不得顺带刷新
      无关基线。

### RFC-293-T20 Implementation gate / full gate

- [ ] T20.1 从本 RFC最终 commit直接父提交圈定精确diff，在分离worktree跑Codex implementation gate。
- [ ] T20.2 findings逐条实读源码核实；修复与反向/变异测试同commit，记录
      `implementation-gate-YYYY-MM-DD.md`。
- [ ] T20.3 `bun run gate:local`；若共享机器满载，按 dev-gotchas保留失败全集并在pin worktree复跑，
      不以重跑即过掩盖。
- [ ] T20.4 build single e2e binary、Intent E2E、visual、a11y。
- [ ] T20.5 更新 proposal/design/plan实际偏差、design/plan RFC状态、STATE Done。

## 7. Commit 建议

仓库硬规则是在 shared `main` 小步提交，不建分支、不提 PR。建议至少五个自洽 commit：

1. `feat(intent): RFC-293 working-set contract and journal schema`
2. `feat(intent): RFC-293 durable handoff and turn dispatcher`
3. `feat(intent): RFC-293 working-set and current-action APIs`
4. `feat(frontend): RFC-293 viewport workbench and working context`
5. `test(intent): RFC-293 system acceptance and visual coverage`

每个 materially contributed 的 commit 都按仓库 `AGENTS.md` 使用当次真实 agent/model 与 provider
noreply 邮箱追加非重复 `Co-Authored-By` trailer，不预填未知身份。

提交后、push 前用 `git show -s --format=%B HEAD` 验证真实 trailer；不得 amend 已推共享历史。每次仅
精确 pathspec commit，禁止 `git add .` / `git add -A`。

## 8. 完成判据

- [ ] proposal AC-1～AC-23 逐项有可复跑证据。
- [ ] 新 working-context path 没有 frontend legacy mount请求。
- [ ] running queue/interrupt/boot/replay/cross-tab/lost-wake/process-fence/disclosure TOCTOU均有 backend + E2E。
- [ ] old draft没有可提交窗口，new draft生成后自动恢复提交。
- [ ] 左右独立scroll与宽屏利用由真实 geometry证明，不只靠CSS文本测试。
- [ ] shared/frontend/backend tests、typecheck、lint、format、depcheck、gate:local全绿。
- [ ] hosted exact-SHA CI / Intent E2E / visual terminal green；环境失败与产品失败分开归属。
- [ ] RFC状态 Done、STATE/索引/实现门记录同步。
