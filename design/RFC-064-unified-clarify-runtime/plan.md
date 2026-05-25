# RFC-064 Plan — Clarify Runtime 合一：任务分解

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)
> 估算：≈ 14-21 工作日 / 2-3 PR 强序（含 T0 pre-PR-A 用户对齐 0.5d + T15.5 机械式 TS-fix sweep 1.5d）

## 1. PR 拆分总览

**2 PR 强序（沿用 RFC-058 / RFC-053 成功模式）**：

| PR | 范围 | 估算 | 命中场景 | 必须先 |
|---|---|---|---|---|
| PR-A | baseline 加固——80+ case 锁住 RFC-023 / RFC-056 / 9 patch / RFC-058 / RFC-059 全部用户可观察行为 | 5-7 d | T1-T8 | — |
| PR-B | 重构合一——migration 0033 + scheduler + services 合并 + grep 守门 + 前端 callsite + ~150 处 TS-fix 机械 sweep | 8.5-12 d | T9-T18（含 T15.5 typed-field sweep + T17.5 fixup script deprecate） | PR-A push CI 全绿 + 用户验证 |

可选 **PR-C**（与 PR-B 合并或独立）：

| PR | 范围 | 估算 | 命中 |
|---|---|---|---|
| PR-C | 顺手清——legacy `clarify_sessions` + `cross_clarify_sessions` 表 DROP（RFC-058 PR-B T18 延后项） | 1-2 d | T19-T20 |

如时间紧 / 用户偏好稳，PR-C 可独立拆为 RFC-058 follow-up（与 RFC-064 解耦）。本 plan 默认 PR-C 与 PR-B 合并。

## 2. 任务清单

### T0 用户对齐（pre-PR-A blocker，0.5 d）

**design.md §10.5 i18n / UX label 决策**——RFC-064 删除 cci 列后 attempts picker 失去"反问 vs 跨反问"
区分能力。3 个选项（D1 单标签 / D2 API mapper 派生 lastClarifyKind / D3 持久化 clarifyTrigger 列），
**默认推荐 D2**。**未拍板不启 PR-A**——选项影响 T6 frontend baseline 写法、T11 mapper / T15 mapper 字段、
T16 frontend callsite 切换数量、C8 守门是否覆盖 SessionTab.tsx + node-history.ts。

如选 D2（默认）：
- T11 backend mapper 加 `lastClarifyKind` 派生（clarify_rounds join）+ shared schema 加字段
- T15 mapper test 锁字段
- T16 frontend `formatIterationLabel` / SessionTab.tsx 切到 `lastClarifyKind` 字段而非 cci 数值
- §11 Frontend 零改动清单**不含** `node-history.ts` / `SessionTab.tsx`——这两个文件 PR-B 会改

如选 D1：
- T11 / T15 mapper 无新字段
- T16 frontend `formatIterationLabel` 删 cci 分支；`iterCrossClarify` i18n key 删
- 既有 i18n 测试 `跨反问#N` 断言改 `反问#N`
- §11 Frontend 零改动清单**不含** `node-history.ts` / `SessionTab.tsx`（虽然改动 trivial）

如选 D3：
- 加 migration 0033 step 13+ 建 `clarify_trigger` 列 + 默认值 + 4 个 mint helper 写入
- §5.2 / §5.3 `isCrossClarifyTriggeredRerun` / `isQuestionerCrossClarifyRerun` DB 查询版可简化为列读 (O(1))
- 整体重构复杂度上升 +1d
- §11 Frontend 零改动清单**不含** `node-history.ts` / `SessionTab.tsx`

### PR-A — baseline 加固（5-7 d）

**T1 shared baseline**（0.5 d）
- 给 `NodeRunSchema` 当前字段集（含 crossClarifyIteration）写 spot check 2 case
- `applyAgingCutoff` edge case 锁 4 case（empty rows / cutoff=0 / cutoff=undefined / all filtered）
- 文件：`packages/shared/tests/clarify-rfc064-baseline.test.ts`（新）
- 命中行：≥ 6 case

**T2 self-clarify byte-level baseline**（1.5 d）
- **复用既有测试文件作为回归锚点**（不重写）：
  - `clarify-stop-directive-scoped-to-clarify-rerun.test.ts`（commit `7b20185`，~9 case，directive='stop' applyLatestDirective gate）
  - `clarify-prompt-wire-up.test.ts`（grep guard + applyLatestDirective wire-up）
  - `review-iterate-inherits-clarify-iteration.test.ts`（commit `ec14a85`，~8 case，clarifyIteration 继承）
  - 既有 RFC-023 self-clarify 套件（`clarify-*.test.ts` 系列）
- 新文件：`packages/backend/tests/clarify-rfc064-bytelevel.test.ts`（补充上面未覆盖的 RFC-064 重构关注点）
- 场景：
  - happy path 5 题答完 → prompt 字节级 + REST body + WS payload
  - reject 持久 directive='stop' → STOP CLARIFYING anchor 字节级（既有测试已覆盖、本文件 spot check 确认）
  - multi-round 3 轮累积 → Q&A 块完整渲染
  - inline session mode → sessionMode='inline' fallback to 'isolated' 字节级
  - cutoff 触发 → 已 baked round 不再注入 prompt
  - ask-bias preamble → trailer 字节级
  - agent-multi shard 多 shard 各自独立 round → 每 shard prompt 独立
- 估算：新增 ≥ 20 case + 复用既有 ~50 case 共同守门

**T3 cross-clarify byte-level baseline**（2 d）
- **复用既有测试文件作为回归锚点**（A 组 9 patch + B 组 5 patch 各自专属文件，design.md §9 详列）：
  - A 组：`cross-clarify-questioner-cutoff-cci.test.ts`（patch 05-27）/ `review-dispatch-cci.test.ts`（patch 05-26）/ `cross-clarify-fast-path-isolation.test.ts`（patch 05-25 questioner-rerun-bumps）/ `cross-clarify-update-mode-injection.test.ts`（patch 05-23 retry-index gate）/ `cross-clarify-retry-preserves-iteration.test.ts`（patch 05-24）/ RFC-056 PR-A-D 既有套件（`cross-clarify-{service,update-mode,abandoned-invariant,...}.test.ts`）
  - B 组：`scheduler-cross-clarify-no-runaway.test.ts`（commit `3105e9f`，~11 case，orphan pending guard）/ `cross-clarify-designer-retry-index.test.ts`（commit `2d8fc29`，~10 case，retry_index max+1）/ `prompt-system-port-no-empty-header.test.ts`（commit `6385633`，~5 case，prompt formatter）/ `review-dispatch-prefers-clarify-rerun.test.ts`（commit `a88cffe`，~6 case，review.ts isFresherNodeRun comparator）
  - shared：RFC-058 PR-A baseline `clarify-baseline-{envelope,prompt-render}.test.ts` / `cross-clarify-baseline-{service,patches}.test.ts`（~70 case，已锁住 RFC-023 + RFC-056 完整 happy/reject 路径）
- 新文件：`packages/backend/tests/cross-clarify-rfc064-bytelevel.test.ts`（补充重构关注点 + 与既有 fixture 共同 spot check）
- 场景：
  - happy path designer → questioner → cross → submit → 双方重跑字节级（spot check，主体已被既有套件覆盖）
  - reject 持久 stop → questioner cascade STOP 字节级（既有 `cross-clarify-reject-persistence*` 覆盖）
  - multi-source 2 个 cross 节点指向同一 designer → 多源等待 banner + External Feedback 拼接顺序
  - wrapper-loop 内 cross → loop iter 2 起始 cci 重计 / Q&A 复位（RFC-058 缺口 2 锁定）
  - abandoned 升级 CR-1 invariant → status 转移字节级（既有 `cross-clarify-abandoned-invariant.test.ts` 覆盖）
  - RFC-064 重构特有断言：scheduler `isCrossClarifyTriggeredRerun` 新 DB 查询版与旧 cci 列读取行为等价；mint helper §3.2 max(asking, target, round) + 1 算法在 designer / questioner / scope=questioner fast-path 三路径下 byte-level 等价
- 估算：新增 ≥ 30 case + 复用既有 ~120 case（B 组 4 文件 ~32 case + A 组 7 文件 ~50 case + RFC-058 baseline ~70 case）共同守门

**T4 计数器 bump 规则 baseline**（1 d）
- 文件：`packages/backend/tests/clarify-iteration-bump-rules.test.ts`（新）
- 场景：
  - self-clarify mint → asking == consumer 单 bump
  - cross-clarify mint → asking + target_consumer 双 bump
  - max-merge：asking.max=2 / target.max=3 / round.iteration=5 → newClarify=6
  - latestExisting=null → 默认 0
  - in-attempt retry → 继承 clarifyIteration（RFC-042 路径）
- 估算：≥ 5 case

**T5 freshness / cutoff baseline**（1 d）
- 文件：`packages/backend/tests/clarify-iteration-freshness-cutoff.test.ts`（新）
- 场景：
  - `isFresherForCutoff` 排序键当前 4 层（含 cci）行为锁——本测试在 PR-B 后调整为 3 层
  - `computeHistoryCutoff` 当前 `iterationField` 分支行为锁——本测试在 PR-B 后无分支
  - patch-2026-05-22 freshness invariant 多 hop 链 fixed-point 行为
  - cascade 幂等检查 clarify-only skip 防御
  - aging cutoff 对 cross 路径生效（RFC-058 缺口 1 修复后行为）
- 估算：≥ 5 case

**T6 frontend baseline**（1.5 d）
- 文件：
  - `packages/frontend/tests/node-history-clarify-iteration.test.ts`（新，attempts picker label / 排序）
  - `packages/frontend/tests/clarify-detail-counter-display.test.ts`（新，详情页显示）
  - `packages/frontend/tests/canvas-drag-zero-touch-rfc064.test.ts`（新，C8 守门——canvas drag helper 三个文件在 PR-A 时点的 snapshot）
- 场景：
  - attempts picker 同 ri 不同 cci 不被折叠（patch-2026-05-25-history-label）
  - 排序键当前含 cci 行为锁
  - DOM testid 字节守恒（PR-B 后必须维持）
  - **既有 canvas drag 5 case 锁定**（commit `7975d25` 引入）：`canvas-clarify-drag.test.ts` 3 case（`clarifyHasAttachedAgent` 正向 / 第二 agent 拒收 / answer-only edge 不计为 attached）+ `cross-clarify-drag-helper.test.ts` 2 case（`crossClarifyHasAttachedQuestioner` 正向 / 第二 questioner 拒收）
  - C8 守门：grep `crossClarifyIteration` 在 `packages/frontend/src/components/canvas/*` 0 命中（当前已成立，PR-B 完工时仍 0）
- 估算：≥ 12 case + 7 既有 fixture 守恒 spot check（其中 5 case 复用 commit `7975d25` 已落地测试 + 7 case 新增 + 5 既有 RFC-063 canvas drag 锁定）

**T7 PR-A 提交准备**（0.5 d）
- typecheck / test / format:check 三件套全绿
- commit + push + CI 全绿 + 用户验证
- 期望落到 main 后再启 T9

**T8 STATE.md 进行中标记**（0.1 d）
- 顶部加 "进行中 RFC-064 PR-A baseline 加固"
- 与 RFC-064/* 目录链接

---

### PR-B — 重构合一（7-10 d）

**T9 migration 0033 落地**（1.5 d）
- 文件：`packages/backend/db/migrations/0033_rfc064_unify_clarify_iteration.sql`（新）
- 内容：max-merge `clarify_iteration ← MAX(...)` + SQLite 12-step rebuild DROP cross_clarify_iteration 列
- 新增测试：`packages/backend/tests/migration-0033-clarify-iteration-unify.test.ts`（≥ 8 case）
- drizzle schema：`packages/backend/src/db/schema.ts:386` 删 `crossClarifyIteration: integer(...)` 那一行
- upgrade-rolling.test.ts journal idx 32 → 33

**T10 shared schemas 收口**（0.5 d）
- `packages/shared/src/schemas/task.ts` `NodeRunSchema` 删 `crossClarifyIteration` 字段
- typescript 立刻报错 → 反向追踪所有引用方
- T1 baseline schema spot check 已锁字段集

**T11 services/clarify.ts 吸收 crossClarify.ts**（2 d）
- 把 `packages/backend/src/services/crossClarify.ts` 全部 export 搬入 `services/clarify.ts`
  - `createCrossClarifySession` / `submitCrossClarifyAnswers` / `triggerDesignerRerun` /
    `cascadeDownstreamFromDesigner` / `mintQuestionerRerun` / `triggerQuestionerContinueRerun` /
    `evaluateDesignerRerunReadiness` / `buildExternalFeedbackContext`（**保留独立函数**）/
    `buildExternalFeedbackSources` / `cleanupCrossClarifySessionsForTask` / 常量
- 内部 cci 引用全切到 clarifyIteration
- 删 `services/crossClarify.ts` 物理文件
- 修所有 `from '@/services/crossClarify'` import → `from '@/services/clarify'`（~10 处）

**T12 scheduler.ts cci 派生切**（1.5 d）
- 4 处变量删除：`currentCrossClarifyIteration` / `inheritedCrossClarifyIteration` / 旧 `isCrossClarifyTriggeredRerun` / 旧 `isQuestionerCrossClarifyRerun`
- 新算法（design.md §5.2 / 5.3）实现 `isCrossClarifyTriggeredRerun` / `isQuestionerCrossClarifyRerun` DB 查询版
- `applyCrossClarifyFreshnessInvariant` 改名 `applyClarifyFreshnessInvariant`，扫描 clarifyIteration
- `buildPromptContext` / `buildExternalFeedbackContext` 调用方参数切
- **`isClarifyRerun` gate 不需 mitigation**——既有 validator `clarify-multiple-clarify-on-same-agent` 已阻断"agent 同挂 self + cross-clarify"拓扑（design.md §8 已更新说明），sessionMode='isolated' 兜底足够；scheduler.ts:1293 不动

**T13 services/clarifyRounds.ts 简化**（0.5 d）
- `isFresherForCutoff`（clarifyRounds.ts:141）排序键删 cci 中间档 → 3 层
- `computeHistoryCutoff` 删 `iterationField` 参数
- `selectAnsweredRoundsForConsumer` 行为不变（已通过 RFC-058 与 cci 解耦）

**T14 services/review.ts cci 切**（0.5 d）
- `isReviewCciAlignedWithUpstream` 改名 `isReviewClarifyAlignedWithUpstream`
- `pickFreshestReviewRun` 排序键删 cci 中间档
- 测试 `review-dispatch-cci.test.ts` 改名 `review-dispatch-clarify.test.ts`，断言对齐新字段名

**T15 services/task.ts + lifecycleInvariants.ts cci 切**（0.5 d）
- `getTaskNodeRuns` mapper 删 `crossClarifyIteration` 字段
- `task.ts:690` 单节点 retry placeholder cci 切 clarifyIteration
- `lifecycleInvariants.ts` CR-1 SELECT projection 删 cci 列
- 新 baseline test `api-task-clarify-iteration-only.test.ts` 锁字段集
- **必须修改既有测试**（不是零退化）——分两类：

**A 类：wire shape / 字段名锁**（PR-B 改字段名即可）

  - `api-task-cross-clarify-iteration.test.ts`（4 case，commit `f8853a5` 引入，锁 REST response 含 `crossClarifyIteration` 字段）→ 重命名 `api-task-clarify-iteration.test.ts` + 字段断言改 `clarifyIteration` 单字段；语义不变（仍锁 mapper 不漏映关键字段）
  - `clarify-rounds-fresher-for-cutoff-cci.test.ts`（锁 `isFresherForCutoff` 4 层排序键含 cci 中间档）→ 改 3 层断言（删 cci 中间档），保留对 patch-2026-05-25-fresher-noderun-includes-cci 行为的等价覆盖
  - `cross-clarify-questioner-cutoff-cci.test.ts`（commit `4a06170` 引入，锁 `iterationField` 切换分支）→ 改"统一 clarifyIteration 字段"断言；patch-2026-05-27 描述行为由 §3 算法天然保持
  - `e2e/cross-clarify.spec.ts`（commit `6ccb5cf` 引入，5 处 cci 引用：line 21 / 345 / 355 / 360 / 362）→ TypeScript 接口字段重命名（`crossClarifyIteration: number` → `clarifyIteration: number`）+ filter `r.crossClarifyIteration === 1` → `r.clarifyIteration === N`（N 由 §3 mint 算法在 e2e fixture 中实测计算，可能仍是 1，但 source 字段名改）+ expect 文案 `'designer reran with crossClarifyIteration=1'` 改 `clarifyIteration`

**B 类：源代码结构锁**（PR-B 必须**主动 rewrite** —— 这些测试 grep 源码字符串 / 函数名，PR-B 重命名后会 fail）

  - `cross-clarify-retry-preserves-iteration.test.ts:439-466`（3 case 用 regex `/const\s+inheritedCrossClarifyIteration\s*=\s*latestExisting\?\.crossClarifyIteration\s*\?\?\s*0/` + `/crossClarifyIteration:\s*inheritedCrossClarifyIteration/` 锁 scheduler.ts 源码变量名 + insert 模式）→ 改 regex 锁 `inheritedClarifyIteration` 派生 + 删 cci 字段断言；保留 patch-2026-05-24 retry 继承语义锁（通过 clarifyIteration 单字段）
  - `cross-clarify-baseline-patches.test.ts:282`（regex 计数 `inheritedCrossClarifyIteration` 在源码出现次数 ≥ 1）→ 改 regex 锁 `inheritedClarifyIteration`（已存在）；删 cci 计数断言
  - `scheduler-fresher-noderun-cci.test.ts`（整个文件锁 `isFresherNodeRun` 4 层排序行为，commit `653efc8` 引入）→ 改 3 层断言；测试名 / describe block 改"isFresherNodeRun preserves rank under unified clarifyIteration"
  - `scheduler-cross-clarify-freshness-invariant.test.ts`（import `applyCrossClarifyFreshnessInvariant`，commit `036e0e6` 引入）→ import 改名 `applyClarifyFreshnessInvariant` + describe block 同步
  - `cross-clarify-update-mode-injection.test.ts:571-575`（source-text regex `/const isCrossClarifyTriggeredRerun =[^;]+;?\s*\n\s*let priorDoneDesigner/` 锁 scheduler.ts 行级模式）→ 改 regex 锁新 async DB 查询版（design.md §5.2）；保留 patch-2026-05-23 "retry_index sub-gate 已抬掉" 语义锁
  - `cross-clarify-questioner-cutoff-cci.test.ts:235`（source-text regex `/iterationField:\s*isQuestionerCrossClarifyRerun\s*\?\s*'crossClarifyIteration'\s*:\s*'clarifyIteration'/` 锁 scheduler.ts 三元 iterationField pattern，commit `4a06170` 引入）→ 改 regex 锁"无 iterationField 三元（统一传 clarifyIteration）"；patch-2026-05-27 描述行为通过 §3 算法天然保持

**C 类：migration / schema 守门**（特殊处理）

  - `migration-0029-rfc056-cross-clarify.test.ts:108-123`（commit `5d430b8`，断言 migration 0029 后 `cols.find((c) => c.name === 'cross_clarify_iteration')` 列存在）→ migration 0033 之后此列已 DROP，该断言会 fail。**推荐方案**：改测试为"截至 migration 0029 时点的 schema 快照"——用 `runMigrationsUpTo('0029')` helper（如不存在则写）只跑到 0029；断言保留——让 migration test 维持"逐 migration 状态快照"语义

**D 类：iterationField 参数移除 + 局部 typedef**

  - `clarify-rounds-service.test.ts:194-229`（测试 `'iterationField=crossClarifyIteration returns cci of prior cross-clarify done run'` + 直接调用 `computeHistoryCutoff({iterationField: 'crossClarifyIteration', ...})`，5 处 iterationField 使用）→ 该 case **整段 obsoletes**：iterationField 参数已删；删该 case 并新增 1 case `'unified clarifyIteration covers both kinds via §3 algorithm'` 验证统一字段下行为等价
  - `cross-clarify-service.test.ts:170`（local typedef `opts: { id?: string; nodeId?: string; crossClarifyIteration?: number; status?: string }` + 12+ fixture cci usages，commit `7b566e8` 引入）→ 删 typedef cci 字段 + 删 fixture cci 字段（T15.5 sweep 顺手做）
  - `cross-clarify-cascade-isolation.test.ts`（local typedef `crossClarifyIteration: number` 字段）→ 删 typedef cci 字段（T15.5 sweep 顺手做）

**总计 13 个测试文件必须修改**：A 类 4（含 e2e 1）+ B 类 6 + C 类 1 + D 类 3。这些不是 PR-B "零退化" 范畴——是 PR-B "重构副作用必须主动同步修复"。漏改任何 1 个 → CI 红线。

**重要原则**：B 类测试在 PR-A baseline 阶段**不重写**（保持原状作为 RFC-064 重构前的状态快照证据）；
PR-B 提交时与重构同 commit / 同 PR 一起修改，commit message 标注"refactor + 测试同步重写"。
这样 git log 上看到的是"删除一个变量 + 改重命名 + 同时改对应测试"，行为可追溯。

**T16 frontend callsite 12 处切**（1 d）
- `node-history.ts` 排序键切 clarifyIteration
- `SessionTab.tsx` attempts picker label 切 clarifyIteration（DOM testid 字节守恒）
- `lib/node-history.ts` 等模块
- 既有 fixture refresh：`node-drawer-session-tab` / `node-history-split` / `noderun-status-display` / `prompt-history-sort` / `session-attempts-picker` / `task-detail-resolve-node` / `task-detail-tabs` 等 7 处
- **canvas drag helpers 零改动验证**：`packages/frontend/src/components/canvas/clarifyDragHelper.ts` + `crossClarifyDragHelper.ts` + `WorkflowCanvas.tsx` 三个文件 PR-B git diff = 0（C8 守门 + design.md §11）。如发现需改动，**停下与用户对齐**——drag helper 读 `definition.edges[]` 静态拓扑、不涉及 node_run 计数器，理论上 0 改动。
- typecheck 全绿；vitest 全绿

**T15.5 typed-field 机械式 TS-fix sweep**（1.5 d）

T10 删 `NodeRunSchema.crossClarifyIteration` + scheduler.ts insertNodeRun typedef 删 `crossClarifyIteration?: number` 之后，TypeScript 会在 **~36 个测试文件 + 4 处局部 typedef 上**报 ~150 处类型错误。这些是机械式删除，不涉及测试 SEMANTICS 改动（语义改动在 T15 must-modify）。但量大、不能漏，独立列一个 sweep 任务保证可追踪。

**统计**（基于 commit `7975d25` 时点 grep）：
- 29 个 backend 测试文件含 `crossClarifyIteration: N` 字面量（fixtures + helper 调用），共 139 处
- 7 个 frontend 测试文件同上，共 8 处
- 4 个局部 typedef 定义 `crossClarifyIteration?: number` 字段：
  - `scheduler-fresher-noderun-cci.test.ts`（B-class 已列）
  - `api-task-cross-clarify-iteration.test.ts`（A-class 已列）
  - `cross-clarify-service.test.ts`（**新增**——seedDesignerRun fixture 定义）
  - `cross-clarify-cascade-isolation.test.ts`（**新增**——本地 helper 定义）
- 1 处 src 代码 typedef：`scheduler.ts:2890-2904` insertNodeRun inherit 参数（T12 已规划）

**实施手段**：
1. PR-B 先做 T10（schema 字段删）+ T12（insertNodeRun typedef 删）→ TS 立刻报全量错误清单
2. 用 `bun run typecheck 2>&1 | grep crossClarifyIteration` 拉错误清单
3. 按文件批量删 `crossClarifyIteration: N,` 行（fixture 字面量 / 函数调用 / typedef 字段）
4. 局部 typedef 中的 `crossClarifyIteration?: number` 字段定义同步删
5. 跑 typecheck 验证 0 错误
6. 跑 vitest 验证 0 失败（注意：失败的就是 T15 must-modify 应主动 rewrite 的 case，不是 T15.5 漏改）

**T15.5 与 T15 must-modify 边界**：
- T15.5 = 机械删字段（语义不变，行为锁仍生效）
- T15 = 语义 rewrite（字段名变 / 函数名变 / 测试断言变 / regex 模式变）
- 同一文件可能两者都涉及：T15 先做 SEMANTICS 改写、T15.5 再扫剩余字面量字段；commit message 标注两阶段。

**T17 grep 守门测试**（0.5 d）
- 文件：`packages/backend/tests/clarify-iteration-single-source.test.ts`（新）+ `clarify-service-singleton.test.ts`（新）+ `clarify-freshness-no-cci.test.ts`（新）
- 守门：
  - `crossClarifyIteration` / `cross_clarify_iteration` 在 src/ 共 0 命中
  - `services/crossClarify.ts` 文件不存在
  - `buildExternalFeedbackContext` 在 `services/clarify.ts` 内 export + 签名稳定
  - `isFresherForCutoff` 排序键 3 层

**T17.5 fixup 脚本清理**（0.2 d）
- `packages/backend/scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts`（commit `07640c7` 引入的 one-shot live-task recovery script，6 处 `crossClarifyIteration` 引用）：
  - migration 0033 DROP cci 列后此脚本无法再运行（column 已不存在）
  - 该脚本已经在生产 task `01KS86DPCSERV7S41GQA5Y81RN` 上跑过、目的已达成（STATE.md 备注）
  - **决策**：在 commit message 中标记 deprecation 删除该文件；如未来 RFC-057 S5 follow-up 需要类似 recovery 工具，在新表 schema 上重写
  - 与 RFC-057 STATE.md 备注（"`scripts/fixup-rfc052-stuck-review.ts` 标 deprecated"）一致处理

**T18 PR-B 提交 + 回归判据**（1 d）
- 跑 PR-A 80+ case → 面向用户层字节 diff = 0
- 跑全 backend / shared / frontend 套件零退化
- typecheck / test / format:check 三件套全绿
- commit + push + CI 全绿 + 用户验证
- STATE.md 顶部更新

### PR-C 可选——legacy 表 DROP（1-2 d）

**T19 migration 0033 step 13+ 加 legacy 表 DROP**（与 T9 同文件 / 同 PR；或独立 migration 0034）
- 内容：
  ```sql
  DROP TABLE clarify_sessions;
  DROP TABLE cross_clarify_sessions;
  ```
- drizzle schema 删 `clarifySessions` / `crossClarifySessions` 表对象
- PR-A baseline 测试中 5 处直接调 legacy `services/crossClarify.ts.listCrossClarify*` 或读 legacy 表的 case 改读 `clarify_rounds`

**T20 RFC-058 PR-B T18 状态收尾**（0.2 d）
- 与 RFC-058 plan.md T18 状态同步：标 Done
- STATE.md RFC-058 entry 更新

如选择 PR-C 独立拆出（不与 PR-B 合）：
- 独立 commit + 独立 PR + 独立 CI 验证
- STATE.md 加一行 "RFC-064 follow-up legacy 表 DROP" 占位

## 3. 跨 PR 守门（不可降级）

| 守门 | 来源 | 触发点 |
|---|---|---|
| typecheck | bun run typecheck | 每个 commit |
| test | bun run test（backend / shared / frontend） | 每个 commit |
| format:check | bun run format:check | 每个 commit |
| C1 self-clarify byte-level | clarify-rfc064-bytelevel.test.ts | PR-B 每个 commit |
| C2 cross-clarify byte-level | cross-clarify-rfc064-bytelevel.test.ts | PR-B 每个 commit |
| C3 grep crossClarifyIteration = 0 | clarify-iteration-single-source.test.ts | PR-B 完工 |
| C4 services/crossClarify.ts 不存在 | clarify-service-singleton.test.ts | PR-B 完工 |
| C5 migration 0033 | migration-0033-clarify-iteration-unify.test.ts | T9 完工 |
| C6 freshness 3 层 | clarify-freshness-no-cci.test.ts | T13 完工 |
| C7 per-question scope 不退化 | RFC-059 既有套件 + clarify-iteration scope 隔离扩展 case | PR-B 每个 commit |
| C8 canvas drag helpers 零改动 | canvas-drag-zero-touch-rfc064.test.ts + 既有 canvas-clarify-drag.test.ts + cross-clarify-drag-helper.test.ts | PR-B 每个 commit |
| C9 B 组 6 个早期 fix dedicated 测试零退化 | `scheduler-cross-clarify-no-runaway.test.ts` + `cross-clarify-designer-retry-index.test.ts` + `prompt-system-port-no-empty-header.test.ts` + `review-dispatch-prefers-clarify-rerun.test.ts` + `review-iterate-inherits-clarify-iteration.test.ts` + `clarify-stop-directive-scoped-to-clarify-rerun.test.ts`（commit `3105e9f` / `2d8fc29` / `6385633` / `a88cffe` / `ec14a85` / `7b20185`） | PR-B 每个 commit |
| C10 A 组 9 patch dedicated 测试零退化 | `cross-clarify-questioner-cutoff-cci.test.ts` + `review-dispatch-cci.test.ts` + `cross-clarify-fast-path-isolation.test.ts` + `cross-clarify-update-mode-injection.test.ts` + `cross-clarify-retry-preserves-iteration.test.ts` + RFC-056 PR-A-D 既有套件（`cross-clarify-*.test.ts` 系列） | PR-B 每个 commit |
| C11 RFC-058 / RFC-059 既有套件零退化 | `clarify-rounds-service.test.ts` + `clarify-baseline-*` + `cross-clarify-baseline-*` + RFC-059 scope 套件 | PR-B 每个 commit |
| e2e cross-clarify.spec.ts | playwright（RFC-056 PR-D commit `6ccb5cf`） | PR-B push CI |
| e2e clarify.spec.ts（如存在） | playwright（RFC-058 T16 follow-up commit `d8e1670`） | PR-B push CI |

## 4. 风险缓解检查表

- [ ] PR-A 完成后用户视察 baseline 测试覆盖度（特别是 9 patch 行为覆盖）→ 如有遗漏补 case 再启 PR-B
- [ ] PR-B 每个 task 完工跑一次 PR-A 全 baseline 确认零退化
- [ ] migration 0033 在 dev DB 上 dry-run + 数据 dump + 差异比对再 commit
- [ ] bun:sqlite 12-step rebuild 在含数据库 / 空库两类 fixture 上验证（C5 含两类 case）
- [ ] `services/crossClarify.ts` 删除前 grep 全仓库确认 0 外部引用（含 e2e / fixture / docs）
- [ ] frontend testid 字节守恒——T16 完工后 spot check 7 处 既有 fixture diff = 0
- [ ] PR-B push 完跑一次 Playwright e2e 全套（不只是 RFC-064 直接相关 spec）
- [ ] PR-B 启动前用 `git fetch && git log main..refact` 检查 RFC-061 `refact` 分支是否准备 land——如准备 land 则停下与用户对齐先后顺序（proposal.md §7 RFC-061 风险条目）
- [ ] T15 必须修改的 3 个既有测试文件改完后跑一次 PR-A baseline + B 组 + A 组 全套确认改动只影响列名 / 排序键、不退化任何行为断言
- [ ] PR-B 末尾确认 `grep -rln "crossClarifyIteration\|cross_clarify_iteration" packages/` 只在 `design/RFC-*` + `db/migrations/0033*.sql` 命中（其他 0 命中）

## 5. PR 提交模板

**PR-A commit message**：
```
test(backend): RFC-064 PR-A baseline 加固 — 锁 RFC-023/056/058/059/9 patch 行为

T1-T8 全部完工：
- shared T1 +6 / backend T2-T5 +60 / frontend T6 +14 = 80+ case
- 全部当前用户可观察行为（含 9 个 RFC-056 patch）字节级锁定
- PR-B 重构后回归判据：本 PR case 面向用户层字节 diff = 0

零生产代码改动；为 PR-B "删 crossClarifyIteration 列 + 合 crossClarify.ts" 重构铺路。
```

**PR-B commit message**：
```
refactor(backend): RFC-064 PR-B 重构合一 — 删 crossClarifyIteration 列 + 合 services/crossClarify.ts

T9-T18 全部完工：
- migration 0033：max-merge cci → clarify_iteration + DROP 旧列（bun:sqlite 12-step rebuild）
- services/crossClarify.ts (1789 行) 全部 export 搬入 services/clarify.ts，文件删除
- scheduler 4 处 cci 派生切 clarifyIteration / 新 DB 查询；applyCrossClarifyFreshnessInvariant 改名
- frontend 12 callsite 切 clarifyIteration；testid 字节守恒
- 3 个 grep 守门：crossClarifyIteration 在 src/ 共 0 处 / crossClarify.ts 文件不存在 / freshness 排序 3 层
- PR-A 80+ baseline 字节级 diff = 0（面向用户层）；零产品行为变更
- 与 9 patch 行为对齐（design.md §9）：cci 错位类 bug 在源代码层从根上消除
```

## 6. 完工 STATE.md 更新模板

```markdown
**RFC-064 Clarify Runtime 合一 完工**（PR-A commit `<sha>` + PR-B commit `<sha>`, CI run <id> 全 15 jobs 全绿）：[proposal.md](design/RFC-064-unified-clarify-runtime/proposal.md) / [design.md](design/RFC-064-unified-clarify-runtime/design.md) / [plan.md](design/RFC-064-unified-clarify-runtime/plan.md) — 把 RFC-058 / 059 半统一的 clarify 运行时收口完整：删除 `node_runs.cross_clarify_iteration` 列折入 `clarify_iteration`；删除 `services/crossClarify.ts` (1789 行) 全部 export 并入 `services/clarify.ts`；scheduler 4 处 cci 派生切到统一 clarifyIteration + 新 DB 查询；`buildExternalFeedbackContext` 作为独立函数保留（用户决定不与 buildPromptContext 合并，update mode 与 supplementary info prompt 语义不同）；NodeKind `clarify` / `clarify-cross-agent` 画布契约保留（用户决定）。9 个 RFC-056 patch 描述的行为字节级守恒、但 cci 错位类 bug 在源代码层从根上消除——`crossClarifyIteration` / `cross_clarify_iteration` 在 src/ 共 0 命中（grep 守门）。PR-A 80+ baseline 锁住 RFC-023 + RFC-056 + 9 patch + RFC-058 + RFC-059 全部用户可观察行为；PR-B 重构后面向用户层字节级 diff = 0。零产品行为变更。
```

## 7. 与 RFC-058 / 059 / 060 的窗口对齐

- **RFC-058 PR-B T18 / migration 0032 延后项**：本 RFC 顺手清（PR-C 路径）；如延后，留独立 follow-up PR
- **RFC-059** 已完工；本 RFC PR-A baseline 含 RFC-059 行为锁
- **RFC-060** 6 PR 全部落地；与本 RFC 文件改动面无重叠，可并行
- **RFC-063** 已完工；本 RFC 不动 validator 规则

无并发冲突 RFC。本 RFC 可在 main 当前状态下任意时刻启动。
