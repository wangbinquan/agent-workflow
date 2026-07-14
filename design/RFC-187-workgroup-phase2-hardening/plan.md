# RFC-187 任务分解

> 读法：先 `proposal.md` → `design.md`。子任务编号 `RFC-187-Tn`；每项标 PR 归属、依赖、验收。

## PR-1 — 探针实锤三项（P0/P1）

### RFC-187-T1｜F3 leader 反问收口（AC-1，头等）
- **T1a**：`loadDbState` 的 `inArray` 增 `WG_CLARIFY_NODE_ID`（`workgroupRunner.ts:448`）；新增 `state.clarifyRuns` 字段（独立于 `hostRuns`，避免污染 `countRoundsUsed`/`retryIndex`）。
- **T1b**：纯函数 `deriveLeaderClarifyPark(clarifyRuns, leaderRunIds)`；`leaderParked`（`:765`）改用它。
- **T1c**：`WakeOutcome.awaiting_human.reason` 增 `'leader-clarify'`；`decideWorkgroupOutcome`（`workgroupWake.ts`）在 leader-clarify-park 时返回该 reason → 任务 `awaiting_human`（`workgroupRunner.ts:871-881`）。
- **T1d**：接通答复续跑——验证 leader clarify 的 answer 触发 adoption/kickResume（复用 RFC-181 A2 clarify 恢复），**不新建**恢复机制。
- **依赖**：无（起点）。**风险**：R1（parent 链）、R2（autonomous 不变式）——设计门先核实。
- **验收**：纯函数 golden + 真实 e2e（非自治 leader clarify→awaiting_human→答→done，`__wg_leader__` run 数=1）+ 源码锁。

### RFC-187-T2｜§3-7 maxRounds 优雅收尾（AC-2）
- **T2a**：`decideWorkgroupOutcome` 增 `{kind:'wrap-up'}`：capExceeded 且有未聚合 done assignment/canonical delta → wrap-up；纯空转→failed(`max-rounds-no-output`)/park(`max-rounds-needs-human`)。
- **T2b**：`workgroupRunner.ts:801` switch 增 `wrap-up` case：postMessage 强制收尾指令 + 驱一轮 leader（计数豁免，借 T4 的 rerunCause）。
- **依赖**：T4（计数豁免）软依赖——可先用临时豁免、T4 落地后收敛。**风险**：R3、R4。
- **验收**：`maxRounds:1`+单派单 e2e 断言任务 ∈{done,awaiting_review}（非 failed）+ canonical 有产出；纯函数 golden。

### RFC-187-T3｜§4 零 delta done 显式信号（AC-3）
- **T3a**：纯函数 `detectZeroDeltaDone(diffStat, assignments)`（gate 在非只读 done assignment）。
- **T3b**：lw done 收尾（`workgroupRunner.ts:808`）接入：suspect→`errorSummary` 前缀 `[warn]` + 房间 system decision 告警；**不改** done 状态。
- **T3c**：`renderWgProtocolBlock`（`workgroupContext.ts`）brief 指引加「相对路径、不写绝对路径」。
- **依赖**：无。**风险**：R5（只读组误报）。
- **验收**：纯函数 golden（含只读 gate）+ e2e 复现探针 A→done+warn。

## PR-2 — P1 硬化

### RFC-187-T4｜§3-3 协议重试不膨胀 maxRounds（AC-4）
- **T4a**（Codex P1-8 修正）：`rerunCause` 枚举增 `'wg-protocol-retry'`；过的是 **`isClarifyRerunCause` + `RerunCause` enum 真值表**（**不是** `clarifyDispositionFor`——那管 `ClarifyChannelDirective`），显式归「非 clarify 技术延续」。
- **T4b**：leader 重试铸 run（`attempt>0`）打 `wg-protocol-retry`；`countRoundsUsed` 排除集加它。**member/fc 侧同理必须一起改**（fc 计 member 轮，不能只改 leader 分支）。
- **T4c**（Codex P1-8 深层）：clarify-answer host 首返「envelope 合法但 wg JSON 畸形」经 `clarifyRerunLedger:300` 老化掉 Q&A → 后续 protocol retry 拿不到答案。专用 cause 不够——须让 retry 显式携带回答上下文（或阻止该 done host run 老化 clarify）。
- **依赖**：无（T2 已用 counted 方式，**不**依赖 T4）。**验收**：`countRoundsUsed` 锁（1base+3retry=1轮，leader+fc 两路）+ enum 真值表 golden + answered-clarify-retry 上下文保留测试。

### RFC-187-T5｜§4-2 fan-out 逐路径 salvage（AC-5，仅 T5a）
- **T5a（§4-2）**（Codex P1-9 加强）：`mergeBackNodeIso` 逐路径 salvage——不只改返回类型，须定义安全 partial tree 构造 + partial materialize 前后崩溃的**幂等重放** + 单一 `merge_state` 表达剩余冲突；**先修** human-replay 把「无 resolve-iso 的已干净 repo」误判 unresolved 的恢复契约。
- **merge agent 保持在 `writeSem` 内**（不做出锁）。
- **依赖**：无。**验收**：`mergeBackNodeIso` 返回结构单测 + 两成员同文件冲突 e2e（各写自己 iso）+ 崩溃重放幂等测试。
- **~~T5b（§4-3 merge agent 出 writeSem）已从本 RFC 拆出~~**（Codex P0-4）：锁外方案沿用「重 snapshot 后 materialize」会覆盖锁外落地的兄弟改动；正解＝两阶段 pin（钉 `oursAtConflict`、重夺锁 `merge(base=oursAtConflict, ours=currentCanonical, theirs=resolvedTree)`，human-resume 已有此算法）+ 冲突重现/重试上限/多 repo 原子边界 + 并发/重启测试。**另立独立 RFC**。

### RFC-187-T6｜TRAP-1 启动护栏（AC-6，Codex P1-5 修正）
- `workgroupLaunchReadiness` 增 **`no-non-leader-worker`** / `fc-insufficient-writers`（结构性可查，warning 级）；create/launch/房间 banner 三处同源。
- **去掉 `no-producer`**——`readonly` 已被 RFC-130 删、assignment 无 `claimsFileOutput`，无数据源判「producer」；若确需，另议持久 assignment 级 `expectsWorktreeChanges` 契约。
- **依赖**：无。**验收**：readiness 三态 golden + 前端 banner 渲染断言。

### RFC-187-T7｜F8 park 原因标注（AC-7）
- 随 T1c 的 `WakeOutcome` reason 扩展落地：`leader-clarify` vs `leader-idle` 正确标注 + 房间/遥测显示。
- **依赖**：T1c（同一类型改动，**建议并入 PR-1**）。**验收**：reason 枚举 golden。

## PR-3 — P2 潜伏

### RFC-187-T8｜§4-4 conflict-human iso 不孤儿（AC-8）
工作组 conflict-human 保 iso/refs（比照 DAG keepIso）或显式 abandon + 状态对齐；评估是否需一列。**风险**：触 restart replay。

### RFC-187-T9｜§4-6 同波共享 base（AC-9）
同 leader 派单波成员共享单次 base 快照（派发时刻 pin canonical commit）。

### RFC-187-T10｜F2 残留 kickResume（AC-10）
消息/deliver/patch 的 kickResume 放宽到任何可恢复态（走 `resumeTask` 绕 builtin-403）。

### RFC-187-T11｜TRAP-3 Playwright 收紧（AC-11）
`task-wizard.spec.ts:159` 禁 failed 当过；`stub-opencode.sh` 加 wg-aware 合法信封分支。

### RFC-187-T12｜§3-2 continue-no-dispatch 收口（AC-12）
非自治 continue 须带阻塞说明/park + autonomous nudge 不回归源码锁。低优先。

### RFC-187-T13｜F3 恢复缝对账（Codex P1-7，随 T10）
两个崩溃窗须 boot/engine-entry reconciliation（非仅 assert impossible）：① answer 事务提交后、`resumeTask` 接管前 daemon 退出 → pending clarify-answer run 被 reap 成 interrupted、任务仍 `awaiting_human`（auto-resume 不扫、adoption 只认 pending）→ wedge；② autonomous 提交（事务内）与 open-session dismissal（事务外）之间崩 → 留「autonomous+open clarify」。**验收**：两条 crash→recover e2e。

## 状态

- **PR-1（T1/T2/T3/T7）已实现**（`c0957f7f` + Codex 折入 `0b6c502b`）：F3 session-keyed 反问收口 + §3-7 counted grace wrap-up（含禁派活/强制收尾）+ §4 zero-delta 房间告警 + F8 标注；三探针各一条真实子进程 e2e。全后端 5478 pass 0 fail。
- **PR-2（T4/T5a/T6）· PR-3（T8-T13）** 待做，按 §9 Codex 修正范围。

## 依赖图

```
PR-1 ✅: T1(F3, session-keyed) + T7(F8) + T2(§3-7 counted, 不依赖 T4) + T3(§4零delta)
PR-2   : T4(§3-3, isClarifyRerunCause+fc+answered-ctx) · T5a(fan-out 逐路径+崩溃重放) · T6(TRAP-1 去 no-producer)
PR-3   : T8 · T9 · T10 · T11 · T12 · T13(F3 恢复缝)
拆出   : T5b(merge agent 出锁) → 独立 RFC
```

## 验收清单（交付前逐项勾）

- [ ] PR-1 三真实 e2e 全绿（F3 / §3-7 / §4零delta），把三探针实测锁进 CI。
- [ ] 每 AC 有纯函数预言 + 源码锁（见 design §6 表）。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿。
- [ ] CI 五门 + binary smoke + Playwright 绿（按 sha 查、注意 shared-ref 归属）。
- [ ] Codex 设计门（批准前跑）+ 实现门（每 PR 后跑）findings 全折。
- [ ] R7（merge agent 出锁）经设计门对抗审查；过高则拆分记档。
- [ ] STATE.md 顶部「进行中 RFC」→ 完工改 Done + 已完成表加行。
- [ ] 不触碰并发 frontend session 的 `WorkflowCanvas.tsx`/`DynamicWorkflowPanel.tsx`/`styles.css`。

## PR / commit 约定

- commit 前缀 `feat(workgroup): RFC-187 ...` / `fix(workgroup): RFC-187 ...`。
- 精确 pathspec 提交（多人树）；backend-only，避开 frontend session 文件。
- 每 PR 后按 [feedback_post_commit_ci_check] 立即查 CI（本人 sha）。
