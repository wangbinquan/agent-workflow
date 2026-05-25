# RFC-064 Proposal — Clarify Runtime 合一（Unified Clarify Runtime）

> 状态：Draft（2026-05-26）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-026 clarify-inline-session](../RFC-026-clarify-inline-session/proposal.md)、[RFC-039 clarify-ask-bias](../RFC-039-clarify-ask-bias/proposal.md)、[RFC-042 in-attempt retry](../RFC-042-in-attempt-retry/proposal.md)、[RFC-053 lifecycle hardening](../RFC-053-node-run-lifecycle-hardening/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)（含 patch-2026-05-22..27 共 9 个 patch）、[RFC-058 clarify sessions unification](../RFC-058-clarify-sessions-unification/proposal.md)、[RFC-059 cross-clarify per-question scope](../RFC-059-cross-clarify-question-scope/proposal.md)

## 1. 背景

**RFC-058 / RFC-059 已经把 self-clarify 与 cross-clarify 在数据 / Q&A / 失效语义上统一了**：
单一 `clarify_rounds` 表 + `kind` discriminator；单一 `buildPromptContext` 三 consumerKind 分支；
单一 `computeHistoryCutoff` + `applyAgingCutoff` 失效入口；per-question `scope` 让"哪些题给设计者、
哪些题只回反问者"在一套数据流里统一表达。

**但运行时调度层、节点迭代计数器、service 文件仍是两套并行**。这条没合的边带来了
最近 10 天 7 个连环 patch（2026-05-22 ~ 2026-05-27），其中 **6 个根因相同**：
`clarifyIteration` 与 `crossClarifyIteration` 两个独立计数器互相错位、
任一 codepath（mint / inherit / freshness / cutoff / dispatch / cascade）漏镜像就漏一处行为。

| Patch 日期 | 根因 | 体现 |
|---|---|---|
| 2026-05-22 downstream cascade | freshness 不看 cci | `isFresherNodeRun` 漏 cci 列 → 下游 done 行盖过新一轮 |
| 2026-05-22 questioner Q&A injection | 两套 prompt 入口 | `buildClarifyPromptContext` 只读 `clarify_sessions`，反问者重跑空 prompt |
| 2026-05-23 designer retry-index | retry 子门 | retry_index=0 sub-gate 在 cci 维度下错误短路 |
| 2026-05-24 retry preserves cci | `insertNodeRun` inherit 类型 | RFC-042 in-attempt retry 漏继承 cci 字段，所有 External Feedback 块消失 |
| 2026-05-25 fresher-noderun-includes-cci | 同 22 号 | `isFresherForCutoff` 排序漏 cci 列 → cutoff 不正确 |
| 2026-05-25 history-label-includes-cci | 前端 attempts picker 漏 cci 维度 | run-history 行同 ri 不同 cci 被折叠 |
| 2026-05-25 questioner-cascade-no-skip | cascade 幂等 | cascade 只看 cci 数值，clarify-only done 行被错误 skip |
| 2026-05-25 questioner-rerun-bumps-cci | mint 不 bump | `mintQuestionerRerun` 写 cci=lastRun.cci 漏 +1 |
| 2026-05-26 review-dispatch-respects-cci | dispatch 短路 | `dispatchReviewNode` `alreadyDone` 不看 cci，cascade pending 在更高 cci 永不 dispatch |
| 2026-05-27 questioner-cutoff-uses-cci | cutoff 用错 field | `iterationField: 'clarifyIteration'` 永远不切到 `'crossClarifyIteration'` |

**唯一不属于 cci/clarifyIteration 错位的是 22 号的"反问者 Q&A 注入"**——那也是同根：两套 prompt 构建函数
（`buildClarifyPromptContext` vs `buildQuestionerCrossClarifyContext`）历史上是 RFC-023 / RFC-056 并行写的，
RFC-058 已经把它合并成 `buildPromptContext`，本 RFC 完成 service / scheduler / 字段层的同样合并。

**B 组早期 fix（pre-dated-patch 时代散落 commit）**——同样属于 clarify / cross-clarify 健壮性维护，每个有自己专属
测试文件、PR-A baseline 直接复用做回归锚点（design.md §9 详列）：

| Commit | Fix 内容 | 专属测试文件 |
|---|---|---|
| `3105e9f` | cross-clarify 不再每 tick 生成 orphan pending 行 —— `buildScopeUpstreams` 不一刀切跳 cross.questions 边 + `runOneNode case 'clarify-cross-agent'` 先查 live 行再 mint | `scheduler-cross-clarify-no-runaway.test.ts` |
| `2d8fc29` | designer rerun `retry_index = max(existing)+1` 而非简单 +1，避免历史 retry 行盖过新 designer 行 | `cross-clarify-designer-retry-index.test.ts` |
| `6385633` | shared/prompt.ts 过滤系统端口（`__xxx__` 名）的 auto-append section header，消除 `## __external_feedback__` 空标题 | `prompt-system-port-no-empty-header.test.ts` |
| `a88cffe` | review 节点 dispatch 用 scheduler 的 `isFresherNodeRun` 比较器解析最新 upstream run | `review-dispatch-prefers-clarify-rerun.test.ts` |
| `ec14a85` | review iterate / reject 重跑应继承 clarifyIteration（supersede 标记落 clarify-rerun 行、新 pending 行 clarifyIteration=1+retry_index=1） | `review-iterate-inherits-clarify-iteration.test.ts` |
| `7b20185` | clarify directive='stop' 仅在 clarify-rerun 生效（`applyLatestDirective: isClarifyRerun` 参数），不再污染 review-iterate 重跑 | `clarify-stop-directive-scoped-to-clarify-rerun.test.ts` |

**反复出血率说明问题**：现在每次新加一个 codepath（不论是 retry / cascade / freshness / cutoff / dispatch / mint）
都得**手工把同样的逻辑在 cci 维度镜像一次**——任何一个开发者漏镜像就漏一处行为，回归捕捉率
完全靠测试覆盖。即使 RFC-058 已经把 Q&A 注入合一，"两个计数器"这条主轴还在持续生产 bug。

## 1.1 为什么现在做

- 平台**未上生产**，DB 里的 cci 数据均为开发期 / 测试期。一次性 migration 0033 把 cci 列折入 clarifyIteration
  可行（用户明示走"迁移脚本迁"路径）。
- RFC-058 / RFC-059 已落地，clarify_rounds 单表 + per-question scope 提供了稳定地基；本 RFC 只重构
  运行时调度 + 字段，不再动 DB Q&A schema。
- RFC-060 fanout-as-wrapper 6 PR 全部落地（PR-A `0b01149` ~ PR-F），不再与本 RFC 抢同一批文件改动面；
  现在做错峰风险最低。
- 推迟成本：每加一个 cci 相关 codepath 都得手工镜像 → 出血率 = O(新增 codepath 数)。RFC-058 之后
  仍有 4 个 patch 验证了"合 service 层 + 合 prompt 层"不足以阻止漏镜像，只有合**字段层**才能从根上消除。

## 1.2 不动哪些地方（用户对齐结果）

按 2026-05-26 与用户对齐结论：

1. **NodeKind 不合**——画布上 `clarify` 与 `clarify-cross-agent` 仍是两类节点。
   - 理由：用户希望在画布上明确看到"自反问 vs 跨节点反馈"两种数据流；validator 规则
     RFC-063 G1/G2/G3 继续分开锁；前端 NodeInspector 继续按 NodeKind 分支。
   - 影响范围：只合 runtime（scheduler / service / 字段），画布契约 / NodeKind / validator 零改动。

2. **`buildExternalFeedbackContext` 不合并**——designer 侧"External Feedback + Prior Output + Update Directive"
   prompt 块逻辑保留独立函数。
   - 理由：External Feedback 是"用 Q&A 答案 + Prior Output 让 designer **更新输出**"的语义；
     self-clarify 与 cross-questioner 都是"用 Q&A 补充信息 / 让 agent 重新作答"。两者 prompt 渲染流程根本不同
     （External Feedback 要带 prior output 引用 + update directive trailer；其它两路只是注入 Clarify Q&A
     块）。强行合并会让单一函数内部分支爆炸、可读性反而劣化。
   - 影响范围：scheduler dispatch 仍然有"读 External Feedback 之时 / 注入 Clarify Q&A 之时"两个调用点，
     不强求收一处。

3. **统一计数器用 `clarifyIteration`**（用户选 (a)）——`crossClarifyIteration` 列删除、所有 cci 引用切到
   `clarifyIteration`，按 **asking_agent 与 target_consumer 双锚点 bump**。
   - 理由：统一计数器名后所有 patch 系列的"漏镜像"类 bug 在源头消除；用 clarifyIteration 而非 cci
     是因为 self-clarify 是更早 / 更广泛使用的概念，迁移影响面对 RFC-023 既有套件最小。
   - bump 规则（详见 design.md §3）：当一条 `clarify_rounds` 行从 awaiting_human → answered 时，
     这一轮 round 的 **asking 节点**与**target_consumer 节点**各自下一次重跑的 node_run 行 `clarifyIteration`
     都 +1。self-clarify 时 asking == target_consumer 退化为单 bump；cross-clarify 是双方一起 bump。

4. **迁移走脚本**（用户选）——migration 0033 把 `node_runs.cross_clarify_iteration` 列折入
   `clarify_iteration`（取 max）并 DROP 旧列；`clarify_rounds.iteration` 列保持不动（RFC-058 已是
   per-(intermediary_node, loop_iter) 单调，与本 RFC 字段语义一致）。
   - 理由：未上生产、开发期数据合并简单；硬切代码 / 回滚清晰。

## 2. 目标

### 2.1 做

1. **删字段** `node_runs.cross_clarify_iteration`：migration 0033 把每行 `clarify_iteration ← max(clarify_iteration, cross_clarify_iteration)` 后 DROP 旧列。Drizzle schema 同步删字段；shared `NodeRunSchema` 删字段；frontend `node-history.ts` / `SessionTab.tsx` 等 12 处引用切到 `clarifyIteration`。

2. **合 service 文件** `services/crossClarify.ts` → `services/clarify.ts`：把 cross-clarify 路径的
   helper（`triggerDesignerRerun` / `cascadeDownstreamFromDesigner` / `mintQuestionerRerun` /
   `triggerQuestionerContinueRerun` / `evaluateDesignerRerunReadiness` / `buildExternalFeedbackContext` /
   `buildExternalFeedbackSources` 等）原地搬入合并后的 `services/clarify.ts`，外部 import 路径切。
   `buildExternalFeedbackContext` 作为内部函数保留（不合并到 `buildPromptContext`）。删
   `services/crossClarify.ts` 物理文件。

3. **统一 scheduler dispatch**：scheduler.ts 当前 4 处 cci 派生 / gate（`currentCrossClarifyIteration` /
   `isCrossClarifyTriggeredRerun` / `isQuestionerCrossClarifyRerun` / `inheritedCrossClarifyIteration`）
   切到对应 `clarifyIteration` 形态：
   - `isCrossClarifyTriggeredRerun` → 改为读"当前 node_run 是否对应一条 kind='cross' target_consumer=node 的
     answered round 且该轮 iteration > 上一次 done 行的 clarifyIteration"
   - `isQuestionerCrossClarifyRerun` → 改为读"当前 node_run 是否对应一条 kind='cross' asking=node 的
     answered round"
   - `inheritedCrossClarifyIteration` → 直接复用 `inheritedClarifyIteration`（已存在），删除独立变量
   - `currentCrossClarifyIteration` → 删除，所有用 cci 数值的判断改读 clarifyIteration

4. **统一 freshness / cutoff / cascade 算法**：
   - `isFresherForCutoff`（clarifyRounds.ts:141）排序键改 `clarifyIteration desc → retryIndex desc → id desc`（删 cci 中间档）
   - `isFresherNodeRun`（scheduler.ts）同步简化
   - `computeHistoryCutoff` 删 `iterationField` 参数——永远用 clarifyIteration
   - `cascadeDownstreamFromDesigner` 幂等检查 `crossClarify.ts:799` 改用 clarifyIteration（patch-2026-05-25 已修
     clarify-only skip 缺陷的逻辑保留：检查 `node_run_outputs` 行而非单看计数器）
   - `applyCrossClarifyFreshnessInvariant`（scheduler 的 fixed-point 兜底）改名 `applyClarifyFreshnessInvariant`
     + 算法用 clarifyIteration

5. **统一 mint helper**：`triggerDesignerRerun` / `mintQuestionerRerun` / `triggerQuestionerContinueRerun` 等
   insert node_run 行时不再 set `crossClarifyIteration`；统一通过 `clarifyIteration` 表达。
   bump 算法：`newClarifyIteration = max(askingMaxClarify, targetConsumerMaxClarify, round.iteration) + 1`（详 design.md §3）。

6. **migration 0033 脚本** + 数据迁移：
   ```sql
   -- 0033_rfc064_unify_clarify_iteration.sql
   UPDATE node_runs
   SET clarify_iteration = MAX(clarify_iteration, cross_clarify_iteration)
   WHERE cross_clarify_iteration > clarify_iteration;
   ALTER TABLE node_runs DROP COLUMN cross_clarify_iteration;
   ```
   `bun:sqlite` 不支持 DROP COLUMN → 走 12-step `CREATE TABLE _new + INSERT + DROP + RENAME` 重建。
   migration test：空库 / 仅 cci=0 行 / 仅 cci>0 行 / 混合 / max 取值正确性 / 旧列查询应抛错 / 索引保留。

7. **PR-A baseline 锁定**（PR-B 前置必须）：把 RFC-023 / RFC-056 / RFC-059 全部用户可观察行为 +
   7 个 RFC-056 patch + RFC-058 / 059 既有锁定行为**字节级（面向用户）+ 行为级（内部）** 重新锁一遍：
   - envelope 解析（self / cross 两路径）
   - session 创建 + lifecycle（mint / cascade / freshness / cutoff / aging / abandoned）
   - submit / reject + scope filter（all-designer / all-questioner / mixed）
   - prompt 注入（self / cross-designer External Feedback / cross-questioner Q&A 三路径）
   - REST + WS event payload
   - 估算 ≥ 80 case（shared 6 + backend 60 + frontend 14）

8. **PR-B 回归判据**：PR-A 的 80+ case 在 PR-B 重构完后**零字节 diff**（面向用户层）。
   允许变的是内部实现细节（删 cci 列后 SQL 列计数变化、内部变量名）；不允许变的是 prompt 文本 / REST body /
   WS event / 错误码 / DOM testid。

9. **frontend 12 处 callsite 更新**：`node-history.ts` 排序 / `SessionTab.tsx` attempts picker label /
   fixture 等 12 处 `crossClarifyIteration` 引用切到 `clarifyIteration`；testid / DOM 文本字节级守恒。

10. **STATE.md / design/plan.md 索引**：登记 RFC-064 Draft；完工后改 Done。

### 2.2 不做

- **不合 NodeKind**——画布契约 `clarify` 与 `clarify-cross-agent` 保留。
- **不合 `buildExternalFeedbackContext`**——designer 侧 prompt 渲染流程保持独立函数。
- **不改 `clarify_rounds` 表结构**——RFC-058 / RFC-059 schema 字节级守恒（含 kind / scope / loop_iter / iteration 字段）。
- **不动 Q&A 注入 / scope filter / aging 任何用户可观察行为**——唯一例外：彻底消除 7 个 patch 系列残留的极端情形（譬如 retry_index 与 cci 联动错位），这些已经是 fix 而非新特性。
- **不动 NodeKind validator 规则**——RFC-063 G1/G2/G3 保留并行实现。
- **不动 frontend NodeInspector / Palette UI**——self-clarify 与 cross-clarify 节点视觉零差异。
- **不动 WS event 名**——`clarify.*` / `cross-clarify.*` 4+ event 保留前端订阅契约。
- **不动 REST 路由路径**——`/api/clarify` 系列 URL 不变。
- **不动 YAML 导入 / 导出**——clarify_rounds 数据继续不进 workflow definition。
- **不动 RFC-053 lifecycle invariant / 转移函数**——CR-1 abandoned 升级仍扫 `clarify_rounds WHERE kind='cross'`。
- **不动 canvas 连接 / 拖拽逻辑**——RFC-056 引入 + RFC-063 patch-2026-05-26（commit `7975d25`）补齐的 4 个 attachment guard（`clarifyDragHelper.hasExistingClarifyChannel` / `clarifyDragHelper.clarifyHasAttachedAgent` / `crossClarifyDragHelper.crossClarifyHasDesignerEdge` / `crossClarifyDragHelper.crossClarifyHasAttachedQuestioner`）+ `WorkflowCanvas.isValidConnection` 4 处接线 + `applyClarifyReverseDrag` / `applyCrossClarifyQuestionerReverseDrag` / `applyCrossClarifyDesignerDrag` 3 个 drag apply helper 全部字节级守恒。这些是 G1/G2/G3 在画布层的视觉镜像（红色 dashed 拒收线 + drop short-circuit）；与本 RFC 的"runtime 计数器统一"完全正交，PR-B 不得修改。

## 3. 用户故事

> 全部用户故事的核心断言：**与 RFC-064 上线前面向用户层行为字节级守恒**。本 RFC 唯一允许的可观察行为
> 变化是消除 7 patch 系列的残留 corner case（已属 fix），其余 RFC-023 / RFC-056 / RFC-058 / RFC-059
> 用户故事字节级一致。

**S1（self-clarify happy path，byte-level 守恒）**

`input → agent A → review`。agent A 第一次 run emit clarify envelope 3 题 → awaiting_human → 用户答题 + submit →
A 第二次 run prompt 含 `## Clarify Q&A`（与 RFC-064 上线前字节完全一致）→ output → review approve → done。
node_runs.clarifyIteration 从 0 → 1（行为不变，只是底层不再消耗 cci 列）。

**S2（cross-clarify happy path，byte-level 守恒）**

`input → D(designer) → Q(questioner) → cross → review`。Q 第一次 run emit cross envelope → awaiting_human →
用户 submit → cascade：D 第二次 run prompt 含 `## External Feedback + Prior Output + Update Directive`
（字节完全一致）+ Q 第二次 run prompt 含 `## Clarify Q&A`（字节完全一致）→ output → review approve → done。
**计数器变化**：所有相关 node_run 行的 clarifyIteration 从 0 → 1；cross_clarify_iteration 列已不存在。

**S3（cross-clarify reject 持久，byte-level 守恒）**

reject → directive='stop' 持久 → questioner cascade rerun prompt 含 `## User directive: STOP CLARIFYING` +
全量历史 Q&A（与 RFC-064 上线前字节完全一致）→ 后续 cross-clarify 节点 cascade reset 仍走 stop。

**S4（per-question scope all-questioner fast path，byte-level 守恒）**

用户对所有题打 scope=questioner → submit → designer **不重跑**（outcome `designer-skipped-all-questioner-scope`）→
questioner 直接 cascade rerun → prompt 含全量 Q&A。计数器：questioner.clarifyIteration += 1；designer.clarifyIteration **不变**（这正是"designer 不参与本轮"的语义）。

**S5（per-question scope mixed，byte-level 守恒）**

部分 designer + 部分 questioner → designer prompt 仅含 designer-scoped 子集（`extractDesignerScopedSubset` 行为
不变）→ 计数器双方都 +1。

**S6（wrapper-loop 部分持久，byte-level 守恒）**

loop iter 1 reject → iter 2 questioner 仍带 STOP CLARIFYING；iter 2 起始时 Q&A 历史按 loop_iter 复位、
clarifyIteration（前 cci）重计——所有边界条件与 RFC-064 上线前字节完全一致。

**S7（review iterate cascade 后 cci 不再错位）**

工作流 `D → Q → cross → review`。第 1 轮：Q.clarifyIteration=1（cross 轮）→ review approve → done。
用户点击 review iterate（reject）→ cascade reset → 全链路重跑。

- **RFC-064 上线前**：review-iterate-cascade 会先 mint pending 行（patch-2026-05-26 / patch-2026-05-23
  互联现场），cci 与 clarifyIteration 错位风险在 7+1 个 codepath 上分散控制。
- **RFC-064 上线后**：单计数器 + 单字段，错位类 bug 结构性消除——所有 patch 描述的"在某 codepath 漏镜像
  cci"情形已经无从发生（grep 守门 `crossClarifyIteration` 0 命中）。

**S8（migration 0033 硬切）**

启动 daemon 跑过 RFC-058 / 059 / 7 个 patch 的开发期数据集 → daemon 关 → 跑 migration 0033 →
所有 node_runs 行 `clarify_iteration ← max(self, cross)` + cross 列 DROP → 重启 daemon → 任意 clarify
inbox / 详情 / submit / agent rerun 行为字节级一致。migration test 覆盖 7 case。

## 4. 验收标准

### 功能

- **A1（self-clarify byte-level）**：RFC-023 happy / reject / multi-round / inline / cutoff / ask-bias 完整 path 字节级与 PR-A baseline 一致。
- **A2（cross-clarify byte-level）**：RFC-056 happy / reject / multi-source / wrapper-loop / abandoned 完整 path + 7 个 patch 行为字节级一致。
- **A3（per-question scope byte-level）**：RFC-059 fast path / mixed / 设计者过滤字节级一致。
- **A4（计数器单一）**：源代码层 grep 守门——`crossClarifyIteration` / `cross_clarify_iteration` 在 `packages/backend/src/` + `packages/shared/src/` + `packages/frontend/src/` 共**0 处**命中（除 migration 0033 文件 + 文档外）。
- **A5（service 文件合一）**：`packages/backend/src/services/crossClarify.ts` 物理删除；`services/clarify.ts` 接管全部 cross 路径 helper；`buildExternalFeedbackContext` 在合并后的 clarify.ts 内独立 export。
- **A6（scheduler dispatch 简化）**：scheduler.ts 不再有 cci 派生变量；scheduler 内文件大小行数下降（指标性而非硬性）。
- **A7（freshness 简化）**：`isFresherForCutoff` 排序键只有 clarifyIteration + retryIndex + id（删 cci 中间档）；测试覆盖。
- **A8（migration 0033 硬切）**：旧 cci 列 DROP 后 schema 字段查询应抛错；max-merge 算法测试覆盖空 / cci=0 / cci>0 三类行。
- **A9（PR-A baseline 全绿 + PR-B 零回归）**：PR-A 80+ case 在 PR-B 后面向用户层字节 diff = 0；允许内部实现差异。
- **A10（RFC-053 invariant 适配）**：CR-1 abandoned 升级 invariant 在 `clarify_rounds WHERE kind='cross'` 上仍正确扫；测试覆盖。
- **A11（前端 12 callsite）**：`node-history.ts` / `SessionTab.tsx` / `prompt-history-sort.test.ts` 等 fixture 切到 clarifyIteration；vitest 全绿、DOM testid 字节守恒。
- **A12（WS event 不动）**：`clarify.created` / `clarify.answered` / `cross-clarify.*` 4+ event 名保留；前端订阅 / invalidation 路径零改动。
- **A13（NodeKind 不动）**：画布 `clarify` / `clarify-cross-agent` NodeKind 仍是两类节点；validator G1/G2/G3 仍并行实现；前端 NodeInspector 不动。
- **A14（canvas drag helpers 字节级守恒）**：`clarifyDragHelper.ts` + `crossClarifyDragHelper.ts` + `WorkflowCanvas.tsx` 三个文件 `git diff` 在 PR-B 后**面向用户层 0 字节改动**——4 个 attachment guard 函数 + 3 个 drag apply helper + `isValidConnection` 4 处接线行为不变；C8 grep 守门 + 既有 5 case（canvas-clarify-drag.test.ts +3 / cross-clarify-drag-helper.test.ts +2，commit `7975d25` 引入）作为回归锚点。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** PR-A baseline 80+ case 单独 push CI 全绿；PR-B 后字节级 diff = 0。
- **B3** backend tests ≥ +60（baseline 50 + migration 0033 + grep 守门 + mint/cascade 单元 5+）；shared ≥ +6；frontend ≥ +14（callsite 切换 + DOM 守恒）。
- **B4** Playwright e2e 不增量：已有 RFC-056 `cross-clarify.spec.ts` + RFC-023 self-clarify e2e（如存在）继续守门；PR-B 后保持全绿。
- **B5** 单二进制构建包体积下降（旧 crossClarify.ts 1789 行 + cci 列 + scheduler cci 派生估算净 -120KB）；启动时间不退化。

### 回归防护（C 守门）

- **C1（self-clarify byte-level 字节守门，面向用户层）**：`packages/backend/tests/clarify-rfc064-bytelevel.test.ts`——构造 RFC-023 happy / reject / multi-round / inline / cutoff / ask-bias 各场景，字节级守门面向用户层（prompt 文本 / REST body / WS payload / error code）；行为级守门允许 PR-B refactor 微调。
- **C2（cross-clarify byte-level 字节守门，面向用户层）**：`packages/backend/tests/cross-clarify-rfc064-bytelevel.test.ts`——构造 RFC-056 完整 happy + reject + multi-source + wrapper-loop + abandoned + 7 个 patch 各场景；与 C1 同分层规则。
- **C3（计数器单一 grep 守门）**：`packages/backend/tests/clarify-iteration-single-source.test.ts`——源代码层 grep：`crossClarifyIteration` / `cross_clarify_iteration` 在 `packages/backend/src/` + `packages/shared/src/` + `packages/frontend/src/` 共 0 处（除 migration 文件 + design 文档）；`clarifyIteration` 在 services / scheduler / shared 共 ≥ 10 处。
- **C4（service 合一 grep 守门）**：`packages/backend/tests/clarify-service-singleton.test.ts`——`services/crossClarify.ts` 文件不存在；`buildExternalFeedbackContext` 仍在 `services/clarify.ts` 内 export 且签名不变。
- **C5（migration 0033 hard-cut 守门）**：`packages/backend/tests/migration-0033-clarify-iteration-unify.test.ts`——空库 / 仅 cci=0 行 / 仅 cci>0 行 / mixed 四类 case + max-merge 算法 + 旧列 DROP 确认 + 索引保留。
- **C6（freshness 排序简化）**：`packages/backend/tests/clarify-freshness-no-cci.test.ts`——`isFresherForCutoff` 测试矩阵确认只有 clarifyIteration → retryIndex → id 三层、删除 cci 中间档；patch-2026-05-25-fresher-noderun-includes-cci 行为通过新统一字段继续守恒（更高 clarifyIteration 优先）。
- **C7（per-question scope 隔离不退化）**：复用 RFC-059 `cross-clarify-fast-path-isolation.test.ts` + `cross-clarify-question-scope.test.ts` 套件；新增 1 case：scope=questioner 全路径下 questioner.clarifyIteration += 1 / designer.clarifyIteration 不变。
- **C8（canvas drag helpers 零改动守门）**：`packages/frontend/tests/canvas-drag-zero-touch-rfc064.test.ts`（新）——`packages/frontend/src/components/canvas/clarifyDragHelper.ts` + `crossClarifyDragHelper.ts` + `WorkflowCanvas.tsx` 三个文件相对 PR-A snapshot 在 PR-B 后只允许"内部 cci 名 → clarify 名"重命名（**实际上这些文件未引用 cci**——RFC-063 patch-2026-05-26 已确认）；A14 + 既有 5 case 测试零退化（canvas-clarify-drag.test.ts 3 + cross-clarify-drag-helper.test.ts 2）。复用既有源代码层 grep：`grep -n "crossClarifyIteration\|cross_clarify_iteration" packages/frontend/src/components/canvas/*` 在 PR-A / PR-B 都应 0 命中（已是 0）。

## 5. 关键技术选型理由

1. **NodeKind 不合 vs 合**：选**不合**（用户决定）。理由：画布契约是产品语义层；用户在画布上明确看
   "自反问 vs 跨节点反馈"两种数据流；合 NodeKind 影响 validator / frontend / e2e 大量代码、收益小。
2. **`buildExternalFeedbackContext` 不合 vs 合入 `buildPromptContext`**：选**不合**（用户决定）。
   理由：External Feedback 是"更新输出"语义（要带 Prior Output + Update Directive），
   self-clarify / cross-questioner 是"补充信息"语义（Clarify Q&A 块）；两者 prompt 渲染流程根本不同，
   合并后单一函数内部分支爆炸、可读性反劣化。
3. **统一计数器名用 `clarifyIteration` vs `crossClarifyIteration`**：选 (a) **clarifyIteration**（用户决定）。
   理由：self-clarify 是更广泛 / 更早使用的语义；RFC-023 既有套件以 clarifyIteration 为名，迁移面对其影响最小；
   "self vs cross" 维度由 `clarify_rounds.kind` 表达、不必在 node_runs 计数器上重复编码。
4. **迁移走脚本 vs 双写双读期**：选**脚本硬切**（用户决定）。理由：未上生产、开发期数据合并简单；
   脚本 max-merge 算法清晰；回滚直接 revert migration commit。
5. **PR 拆分：baseline 先 + 重构后 vs 一锅炖**：选**两 PR 强序**（沿用 RFC-058 / RFC-053 成功模式）。
   理由：PR-A baseline 单独 push CI 全绿 + 用户验证再启 PR-B；PR-B 任何意外退化能从 PR-A 锁住的 case 立刻发现 + 定位精准。
6. **是否在本 RFC 顺手清理 RFC-058 PR-B T18 / migration 0032 延后的 legacy `clarify_sessions` / `cross_clarify_sessions` 两表 DROP**：选**顺手清**。理由：本 RFC 重构涉及全部 cci 调用面，已有强 baseline 锁定（PR-A）；legacy 表 DROP 在同一 PR 内做的额外回归面小（service 已经在 RFC-058 PR-B 阶段切走、legacy 表无 src/ 调用者）；只需移走 PR-A baseline 中直接调 `services/crossClarify.ts.listCrossClarify*` 的 5 case 改读 `clarify_rounds`。如时间紧可保留 RFC-058 延后状态、放到后续独立 PR。

## 6. 与其它 RFC 的关系

- **RFC-023 self-clarify**：本 RFC 通过 PR-A baseline 字节级守恒；clarifyIteration 字段语义略加宽（覆盖 cross-clarify 路径），但 RFC-023 路径在新语义下 self == both anchor 退化为单 bump 行为不变。
- **RFC-026 inline session mode**：sessionMode 字段不动；inline fallback path 字节级保留；inline 路径不引入 cross-clarify，新计数器对此路径影响为 0。
- **RFC-039 ask-bias + STOP CLARIFYING**：anchor 文案 / appendTrailer 字节级保留。
- **RFC-042 in-attempt retry**：patch-2026-05-24 引入的 `inheritedCrossClarifyIteration` 在本 RFC 删除；统一通过 `inheritedClarifyIteration` 表达，retry 路径字节级守恒。
- **RFC-053 lifecycle hardening**：CR-1 abandoned 升级 invariant 查询条件不动；转移函数 / 7+1 条规则零改动。
- **RFC-056 cross-clarify + 9 patch**：本 RFC 的直接重构对象。所有 cross-clarify 功能（cascade / freshness / aging / multi-source / abandoned / wrapper-loop / cci 继承）行为字节级守恒；patch chain 已合入主干、cci 错位类 bug 在本 RFC 后从源代码消除。
- **RFC-058 clarify sessions unification**：本 RFC 的直接基础。RFC-058 的 `clarify_rounds` 表 / `kind` discriminator / `buildPromptContext` / `computeHistoryCutoff` 全部保留；本 RFC 仅在 RFC-058 留下的"两计数器并行 + 两 service 并行"上做最后合一。
- **RFC-059 per-question scope**：本 RFC 通过 PR-A baseline 字节级守恒；scope 行为完全独立于计数器命名，重构零影响。
- **RFC-060 fanout-as-wrapper**：6 PR 全部落地，与本 RFC 文件改动面错峰，并行不冲突。
- **RFC-063 single-agent attachment**：validator G1/G2/G3 规则不动；NodeKind 仍是两类。

## 7. 风险

| 风险 | 评估 | 缓解 |
|---|---|---|
| PR-A baseline 没覆盖到某个 patch 隐含行为 → PR-B 退化但 PR-A 没抓到 | 高：9 个 patch 累积行为细节繁多 | 逐 patch 抽 1-2 case 入 baseline（C2 含 7 patch 各案）；PR-B push 时跑全 baseline + RFC-056 + RFC-058 + RFC-059 全套并行防护 |
| migration 0033 max-merge 算法在某种 dev 数据上写错 → 计数器跳变 | 中：max-merge 简单但需要测试覆盖空 / cci 单独大 / clarify 单独大 / 等值多种组合 | C5 5 case 覆盖；migration 前后 dump cci + clarify 两列对比 |
| bun:sqlite 不支持 DROP COLUMN，12-step rebuild 在已落数据上失败 | 中：bun:sqlite 历史有 schema 重建踩坑 | 走 drizzle-kit `--break` 路径或手写 rebuild 脚本；migration test 覆盖空库与含数据库两类 |
| frontend 12 callsite 改动遗漏 1 处 → typescript 编译过但运行时 undefined access | 低：TS strict + 类型字段删除后引用立即报错 | 删除 NodeRunSchema.crossClarifyIteration 后 typecheck 不绿不能 merge |
| `isCrossClarifyTriggeredRerun` 改读 DB 查询 → 性能退化（每次 scheduler 循环加一次 SELECT） | 低：SELECT 已 indexed（intermediary + status + iteration），单次成本 < 1ms | 加入 cache hint；如果 benchmark 退化则在 currentRunRow 上挂"派生 kind" 列 |
| `services/crossClarify.ts` 删除时漏删某个 export 被外部引用 | 低：grep 守门 + typecheck | 删前 grep `from.*services/crossClarify` 应只有内部引用；C4 守门 + 跑全套 |
| 用户在并发 task 上跑 migration 0033 → cci → clarifyIteration 折叠时 race | 极低：migration 0033 走启动期单 task 串行（与现有 RFC-058 / RFC-059 migration 一致） | migration 在 daemon 启动期前完成；无运行期影响 |
| RFC-058 PR-B T18 / migration 0032 延后的 legacy clarify_sessions / cross_clarify_sessions 表 DROP 与本 RFC 同窗口操作冲突 | 中：若选 §5.6 顺手清方案，0033 migration 同时处理 cci 折叠 + legacy 表 DROP | 拆成两步在 migration 0033 文件内顺序执行：step 1 cci 折叠、step 2 legacy 表 DROP；test 矩阵分别覆盖 |
| **RFC-061 `refact` 分支风险**（projection rebuilder + 12 services + 7 表 DROP，含 clarify + review + retry UX rebuild on suspensions projection）已在 `refact` 分支累计 ~20 commits，但 main 上 `fc26678` Revert + `d4d0acf` 文档删除即 main 当前不含 RFC-061 | 高：若 `refact` 分支在 RFC-064 PR-B 期间合并 main，二者动同一批文件（scheduler / clarify / review / clarifyRounds），冲突面爆炸 | (a) RFC-064 设计基于 main 当前状态，PR-A baseline 在当前 main HEAD 锁定；(b) PR-B 启动前用 `git fetch && git log main..refact` 确认 refact 是否准备 land，**如准备 land 则停下与用户对齐先后顺序**；(c) RFC-061 若先 land，RFC-064 需重新评估 cci 列在 projection 中的角色（很可能 RFC-061 已隐式消除 cci）；RFC-064 若先 land，refact 分支需 rebase 吸收本 RFC 改动 |
| 历史早期 fix（B 组 6 个 commit）某条隐含行为未在 PR-A baseline 显式锁、PR-B 退化但未被 既有 dedicated 测试文件抓到 | 中：每个 B 组测试有自己的覆盖度，可能未覆盖 RFC-064 重构边缘 | T2-T3 baseline 直接复用 B 组 6 个 dedicated 文件 + 新写的 `clarify-rfc064-bytelevel.test.ts` 在它们之上补 RFC-064 重构关注点（DB 查询版 vs 列读取版等价 / mint helper 公共算法在三路径等价）；PR-B 每个 commit 跑既有 + 新测试双重防护 |

## 7.1 顺手发现的 RFC-063 漏网（不在本 RFC 修，记 follow-up）

sweep 阶段顺手发现 RFC-063 G1/G2/G3 三条 multiplicity 规则有一处**反向漏网**：

- 现状：`clarify-multiple-clarify-on-same-agent` 规则（workflow.validator.ts:875-893）阻断"agent → 多 clarify 节点"，predicate 用 `__clarify__` 源端口覆盖了 self+self、self+cross、self+cross+cross 等组合
- 漏网：该规则**只在 `case 'clarify':` (§4c) 块内触发**——意味着如果工作流**完全没有 self-clarify 节点**、agent 只挂到 2+ cross-clarify 节点，规则不触发、validator 不报错
- 现实影响：agent emit 单条 `<workflow-clarify>` envelope 时 framework 无法区分送哪个 cross-clarify 目的地，行为未定义（runtime 取第一条 `__clarify__` 出边，余下静默丢弃）
- 修法：workflow.validator.ts §4d (case 'clarify-cross-agent') 加 G4 `cross-clarify-multiple-cross-on-same-agent`——predicate 等价 G1/G2/G3 风格，扫一遍 cross-clarify questions 入边的 agent set + 检查这些 agent 是否还有别的 `__clarify__` 出边
- 工作量：≤ 0.5d（1 个新 validator 规则 + 1-2 case test + enum 守门 8→11 / 10→13 同步）

**本 RFC 不实施**——这是 RFC-063 范畴的补丁、与 cci 错位 / 计数器统一无关；落档为独立 RFC：[RFC-069 Multiplicity Validation Pre-pass](../RFC-069-multiplicity-validation-prepass/proposal.md) 用 W3 路线（NodeKind 无关 pre-pass + 3 条 multiplicity 规则统一搬入），顺便堵此处漏网。RFC-069 与本 RFC 文件改动面零重叠、串行落地无返工。

## 8. 后续可能的延展（v1 不做）

- 把 `node_runs` 上 clarifyIteration / reviewIteration / 未来其他迭代计数器抽出独立表 `node_iteration_counters`（避免 ALTER TABLE）。
- `clarify_rounds.iteration` 与 `node_runs.clarifyIteration` 双向一致性 invariant（runtime 启动期扫描）。
- 把 `isFresherForCutoff` 与 `isFresherNodeRun` 合并为单一公共 helper。
- 引入 `clarify_rounds.kind = 'inline-self'` 第三类替代 sessionMode 字段（更彻底的 schema 合一）——需独立 RFC 评估 inline fallback 兼容性。
- 把 `buildExternalFeedbackContext` 与 `buildPromptContext` 合并为 4 consumerKind 分支（self / cross-questioner / cross-designer-feedback / cross-designer-update-mode）——本 RFC 不做，留待用户反馈是否真的有合并需求。
