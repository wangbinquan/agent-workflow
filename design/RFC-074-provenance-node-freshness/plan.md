# RFC-074 Plan — Provenance-Based Node Freshness

> 状态：Draft（2026-05-27）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)

## 1. PR 拆分（3 PR 强序，决策 D7）

- **PR-A**：baseline 锁定，零生产改动。CI 全绿 + 用户验收 → 启 PR-B。
- **PR-B**：provenance + 删两层 cascade + 修 bug + review refresh。cci 列暂留只做排序。**真正的 bug fix 在此落地，独立可发**。上线稳定 → 启 PR-C。
- **PR-C**：cci 彻底退役（id 排序 + 删 bump 机械 + DROP 列 + 24 文件清理 + UI 派生 + lifecycleInvariants U1 迁 consumed-by 戳）。**可缓**。

不引入 feature flag（与 RFC-064 / RFC-070 同模式）。

## 2. 任务分解

### PR-A：baseline 加固

| ID | 说明 | 范围 |
|---|---|---|
| **T-A1** | 新建 `isfresher-noderun-baseline.test.ts`：A1-A6 锁 `isFresherNodeRun` 现有 `(cci,retryIndex,id)` 排序逐 case（为 PR-C 切 id 排序做等价基线） | backend/tests |
| **T-A1b** | **新建 `resolve-upstream-inputs-picker-baseline.test.ts`（D10）**：锁 `resolveUpstreamInputs` 现有 `(iteration,retryIndex)` 选行结果，含"多代 done 行并存时选哪行"——为 PR-B picker 统一做翻转审计基线（含已知潜伏 bug 行为，PR-B 改期望时逐条标注是"修正" | backend/tests |
| **T-A2** | 扩 `scheduler-cross-clarify-freshness-invariant.test.ts` + cross-clarify cascade 套件：A7-A12 锁 Layer A/B 可观察结果（上游 rerun→下游重跑 / **多跳纯-agent 链 mid-loop 逐层传播** / 幂等）——这组是 §4.3 critical 的等价基线 | backend/tests |
| **T-A3** | 扩 review iterate/reject/approve 套件：A13-A17 + 再评合同 | backend/tests |
| **T-A4** | 新建 `provenance-incident-replay.test.ts`：A18-A20 事故 task `01KSHVXCH6RQ5F5P64MZ4FZVN6` 快照回放 | backend/tests |
| **T-A5** | push 后查 GH Actions CI 全绿（[feedback_post_commit_ci_check]）+ 用户验收 | — |

### PR-B：provenance + bug fix

| ID | 说明 | 文件 |
|---|---|---|
| **T-B1** | migration：`node_runs` 加 `consumed_upstream_runs_json`（历史行 NULL）；docVersions.decision 加 'superseded'；journal +1；drizzle schema 同步 | backend/db |
| **T-B2** | 新增 `isNodeRunFresh(run, freshestDonePerUpstream)` 纯函数 + `parseConsumedJson` | backend/src/services/scheduler.ts（或 freshness.ts） |
| **T-B3** | `resolveUpstreamInputs` 返回 `{inputs, consumed}`；dispatch 时落 consumed 到新 node_run；picker 与 freshestDone 统一（AC-7） | backend/src/services/scheduler.ts |
| **T-B4** | review dispatch 记 `consumed={sourceNodeId: sourceRun.id}` | backend/src/services/review.ts |
| **T-B5** | `runScope` 入口 completed 收紧为「latest done AND isNodeRunFresh」；删 `applyClarifyFreshnessInvariant` 入口调用 | backend/src/services/scheduler.ts |
| **T-B6** | **⚠️ §4.3 critical / D9：每-batch fixed-point freshness 重算（替代 Layer A 预 mint 的职责）**。新增 demote 能力：每 batch 后 + ready-empty 分支重读 DB、重建 latestPerNode+freshestDonePerUpstream（含 iteration 作用域 §3.2）、对 completed 节点重算 isNodeRunFresh、stale→remaining（不 mint）、有变化则 while-loop 再跑一轮；safety cap=scope 节点数。**这是本 RFC 最易写漏点**，独立任务、独立强测 | backend/src/services/scheduler.ts |
| **T-B6b** | freshestDone 的 iteration 作用域实现（key=`(upstreamNodeId, consumed 行 iteration)`，loop-wrapper + 跨边界输入正确）（§3.2） | backend/src/services/scheduler.ts |
| **T-B7** | 删 `applyClarifyFreshnessInvariant` 函数 | backend/src/services/scheduler.ts |
| **T-B8** | 删 `cascadeDownstreamFromDesigner` + `triggerDesignerRerun` 内调用 | backend/src/services/crossClarify.ts |
| **T-B9** | 删 `isReviewClarifyAlignedWithUpstream` + `dispatchReviewNode` alignment 短路 | backend/src/services/review.ts |
| **T-B10** | review awaiting 上游变 → 事务化 mint v(n+1) + v(n) superseded + 作废 v(n) review_comments + broadcast | backend/src/services/review.ts |
| **T-B11** | 前端 review supersede banner +「旧版批注已失效」提示 + 自动切 v(n+1) | frontend/src/components |
| **T-B12** | i18n（zh+en） | frontend/src/i18n |
| **T-B13** | B 组 ≥ 18 case（§11.2）：isNodeRunFresh 单元 / consumed 记录 / completed+**每-batch fixed-point 重算** / 多跳纯-agent 链 mid-loop 逐层 demote（B8-B10，§4.3）/ 事故修复 / review refresh / crash recovery / null=fresh / **B17 clarify-only-no-output 上游** / **B18 review resume 幂等（删短路后）** | backend/tests |
| **T-B14** | 前端 review banner 渲染测试 | frontend/tests |
| **T-B15** | 3-trio gate + Playwright e2e + GH Actions CI 全绿 | — |

### PR-C：cci 退役

| ID | 说明 | 文件 |
|---|---|---|
| **T-C1** | `isFresherNodeRun` 改 id 排序（或 (retryIndex,id)）；与 PR-A baseline 等价验证 | backend/src/services/scheduler.ts |
| **T-C2** | 删 cci-bump max+1 机械（triggerDesignerRerun / mintQuestionerRerun / clarify rerun） | backend/src/services/crossClarify.ts、clarify.ts |
| **T-C3** | lifecycleInvariants U1 dedup key 去 cci + designer-run 检查迁 RFC-070 consumed-by 戳（D8） | backend/src/services/lifecycleInvariants.ts |
| **T-C4a** | **⚠️ D11 身份键替换（非 grep-删，逐项单测，§6.4.1）**：`memoryInject.ts` 代际身份从 `(...,cci,retry=0)` 七元组改 id-based（同代最早 retry=0 行 / generation 锚点）——**memoryInject 必须单测代际取对** | backend/src/services/memoryInject.ts |
| **T-C4b** | D11 身份键替换：lifecycleRepair T2（cci 分组选最新代→id）/ S3（dedup key→id）/ U1（去 cci 维度）；sessionView prompt 历史排序 `(cci,retryIndex)`→`(retryIndex,id)` 须与迁移前顺序一致 | backend/src/services/lifecycleRepair/*、sessionView.ts |
| **T-C4c** | 其余纯读写/注释去 cci（runner、clarifyRounds、lifecycle、task mapper、workflow.validator 注释、lifecycleRepair helpers/types） | backend/src |
| **T-C5** | shared `NodeRunSchema` 删 cci 字段；ws / clarify schema 清理 | shared/src/schemas |
| **T-C6** | 前端 5 文件「第 N 轮」改 row 序号派生（NodeDetailDrawer / SessionTab / node-history / injected-memories-card / rfc026-events） | frontend/src |
| **T-C7** | migration 12-step rebuild DROP `node_runs.clarify_iteration`；journal +1 | backend/db |
| **T-C8** | C 组 ≥ 12 case（§11.3）：id 排序等价 / U1 守恒 / UI 派生显示一致 / DROP 列序列化 / grep guard | backend+frontend/tests |
| **T-C9** | 3-trio gate + Playwright e2e + GH Actions CI 全绿 | — |

## 3. 任务依赖

```
PR-A：T-A1..T-A4 并行 → T-A5（最后）
PR-B 前置：T-A5 用户验收
PR-B 内部：
  T-B1（migration）→ T-B2/T-B3/T-B4（记录+判定）→ T-B5/T-B6（scheduler 集成）
  T-B7/T-B8/T-B9（三处删除）依赖 T-B5 完成
  T-B10 → T-B11 → T-B12（review refresh 前后端）
  T-B13/T-B14 测试与实现并行；T-B15 gate 最后
PR-C 前置：PR-B 上线稳定
PR-C 内部：
  T-C1 依赖 PR-A baseline；T-C2 依赖 T-C1
  T-C3 依赖 RFC-070 consumed-by 戳就绪（已 Done）
  T-C4/T-C5/T-C6 去 cci（C5 shared 改后 C6 前端类型同步）
  T-C7（DROP 列）必须在 C1-C6 全部不再读 cci 后
  T-C8/T-C9 最后
```

## 4. 验收清单

PR-A 合并：
- [ ] A 组 ≥ 20 case 全绿（含事故快照）
- [ ] 现有套件零退化；3-trio + e2e + CI 全绿
- [ ] 用户确认行为零退化 → 启 PR-B

PR-B 合并：
- [ ] B 组 ≥ 18 case 全绿（含 §4.3 多跳 agent 链 mid-loop demote + B17 clarify-only + B18 review resume 幂等）
- [ ] AC-1~AC-7 + AC-9 + AC-10 逐条人工验证
- [ ] 事故 task 回放：approve 后无 spurious 评审
- [ ] 3-trio + e2e + CI 全绿
- [ ] STATE.md「进行中 RFC」更新；plan.md 索引保持 Draft（PR-C 未完）

PR-C 合并：
- [ ] C 组 ≥ 12 case 全绿；AC-8 + AC-11 验证
- [ ] grep guard：cci 三 package 0 命中；三个删除函数 0 命中
- [ ] UI「第 N 轮」显示与迁移前一致
- [ ] 3-trio + e2e + CI 全绿
- [ ] STATE.md「进行中」→「已完工」；plan.md 索引 Draft → Done

## 5. 估算

| 阶段 | 工作日 |
|---|---|
| PR-A baseline | 2-3 |
| PR-B provenance + bug fix + review refresh | 4-6 |
| PR-C cci 退役（24 文件 × 3 package） | 4-6 |
| **总计** | **10-15** |

PR-B 单独即修复用户事故，可优先交付；PR-C 是结构性清理，可在 PR-B 稳定后排期。

## 6. 风险点与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **删 Layer A 后多跳 agent 链 mid-loop 传播漏拉齐**（§4.3/D9，本 RFC 最易写漏点：每-batch fixed-point 重算替代的是 Layer A 预 mint，不只是 Layer B） | 🔴 | T-B6 独立任务实现 demote 重算；A2 baseline 锁多跳传播可观察结果；B8-B10 必须含 A→B→C 全 agent、A 重跑→B/C 逐 batch demote 的强测；漏则 silent 错（下游基于 stale 上游跑完） |
| `resolveUpstreamInputs` picker 统一是行为变更（修 `(iteration,retryIndex)` 选错旧行潜伏 bug，§5.1/D10） | 🟠 | T-A1b baseline 锁现有选行；PR-B 统一后逐条审计翻转断言、每个标注"修正 vs 回归" |
| memoryInject/lifecycleRepair/sessionView 的 cci 是身份/分组/排序键非显示（§6.4.1/D11） | 🟠 | T-C4a/b 用 id 做代际身份替换、逐项单测；memoryInject 代际取对必须单测 |
| 纯 id 排序未必总选对最新行（Phase 2 核心） | 🟠 | T-A1 baseline 逐 case 锁 `isFresherNodeRun`；T-C1 切 id 后全绿才算等价；不确定保留 `(retryIndex,id)` 双层 |
| loop-wrapper iteration 作用域错配（freshestDone 拿错代） | 🟡 | T-B6b 按 `(nodeId, consumed 行 iteration)` 取 freshestDone；B 组含 loop 内 + 跨边界输入 case |
| Phase 1→2 freshestDone 选行漂移 | 🟡 | proposal §4.2 论证 cci-order 与 id-order 选同一行；T-C1 显式对拍 |
| review refresh 事务边界 | 🟡 | T-B10 三步包同一事务；B14-B15 断回滚一致 |
| legacy in-flight task null=fresh 漏一个本应 stale 节点（AC-10 边界） | 🟢 | 有意偏向"不乱重评"；重新 launch 修复；新 task 不受影响 |
| 全删 cci 波及 24 文件 | 🟢 | 3 PR 强序，PR-C 独立可缓；grep guard 锁 0 残留 |
| lifecycleInvariants U1 迁戳依赖 RFC-070 | 🟢 | RFC-070 已 Done，consumed-by 戳就绪；T-C3 直接复用 |
| 多人并发树冲突 | 🟢 | 改动集中 scheduler/crossClarify/review/clarify + provenance 新列，遵循 CLAUDE.md 并发改动保留原则，按路径精确 git add |
