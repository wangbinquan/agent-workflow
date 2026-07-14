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
- **T4a**：`rerunCause` 枚举增 `'wg-protocol-retry'`；过 RFC-183 `clarifyDispositionFor` never 锁（归「非 clarify 技术延续」）。
- **T4b**：leader 重试铸 run（`:1146-1152`）`attempt>0` 打 `wg-protocol-retry`；`countRoundsUsed`（`:545-553`）排除集加它。member 侧同理（`:1364-1375`）。
- **依赖**：无（但 T2 复用其豁免）。**风险**：R6。
- **验收**：`countRoundsUsed` 锁（1base+3retry=1轮）+ 枚举分类器 golden。

### RFC-187-T5｜§4-2/3 fan-out 合并硬化（AC-5）
- **T5a（§4-2）**：`mergeBackNodeIso` 返回 `{merged, conflicted}`；干净路径落地、仅冲突路径 park + 结构化「丢 N 文件」note（`nodeIsolation.ts:295-322`）。
- **T5b（§4-3）**：merge agent 移出 `writeSem`——锁外算解、仅 materialize 夺锁 + 乐观 re-check（`scheduler.ts:963-976`）。
- **依赖**：无。**风险**：R7（**最高**——合并核心 + 锁语义）。**设计门重点对抗**；风险过高则 T5b 降级 PR-3、PR-2 只做 T5a。
- **验收**：`mergeBackNodeIso` 返回结构单测 + 两成员同文件冲突 e2e（各写自己 iso）+ writeSem 不长持锁。

### RFC-187-T6｜TRAP-1 启动护栏（AC-6）
- `workgroupLaunchReadiness`（`shared/schemas/workgroup.ts:270-284`）增 `no-producer`/`no-non-leader-worker`/`fc-insufficient-writers`（warning 级）；create/launch/房间 banner 三处同源。
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

## 依赖图

```
PR-1: T1(F3) ──┬─ T7(F8, 同类型并入)
               └─ 独立: T2(§3-7, 软依赖 T4 豁免) · T3(§4零delta)
PR-2: T4(§3-3) · T5(fan-out, R7 高危可拆) · T6(TRAP-1)
PR-3: T8 · T9 · T10 · T11 · T12
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
