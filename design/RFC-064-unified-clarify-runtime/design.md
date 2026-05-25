# RFC-064 Design — Clarify Runtime 合一：技术设计

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-023](../RFC-023-agent-clarify/design.md)、[RFC-026](../RFC-026-clarify-inline-session/design.md)、[RFC-039](../RFC-039-clarify-ask-bias/design.md)、[RFC-042](../RFC-042-in-attempt-retry/design.md)、[RFC-053](../RFC-053-node-run-lifecycle-hardening/design.md)、[RFC-056](../RFC-056-clarify-cross-agent/design.md) + 9 patch、[RFC-058](../RFC-058-clarify-sessions-unification/design.md)、[RFC-059](../RFC-059-cross-clarify-question-scope/design.md)

## 1. 概览

把 `node_runs.cross_clarify_iteration` 列折入 `clarify_iteration`、`services/crossClarify.ts` 物理删除并入 `services/clarify.ts`、scheduler 4 处 cci 派生改读 clarifyIteration / 新查询。所有 RFC-023 + RFC-056（含 9 patch）+ RFC-058 + RFC-059 用户可观察行为字节级守恒。

技术上分 7 块（依赖顺序）：

1. **shared/schemas**：`NodeRunSchema` 删 `crossClarifyIteration` 字段。
2. **backend db schema**：drizzle `nodeRuns` 表 删 `crossClarifyIteration` 列；schema.ts:386 这一行删除。
3. **backend migration 0033**：max-merge `clarify_iteration ← MAX(...)` + DROP 旧列（12-step bun:sqlite rebuild）。
4. **backend services**：`services/clarify.ts` 吸收 `services/crossClarify.ts` 内容；删 cci 引用统一切 clarifyIteration；删 crossClarify.ts 物理文件。
5. **backend services/clarifyRounds.ts**：`computeHistoryCutoff` 删 `iterationField` 参数；`isFresherForCutoff` 排序键删 cci 中间档。
6. **backend scheduler.ts**：4 处 cci 派生 / gate 改读 clarifyIteration + 新 DB 查询；`applyCrossClarifyFreshnessInvariant` 改名 `applyClarifyFreshnessInvariant`。
7. **frontend**：`node-history.ts` 排序 / `SessionTab.tsx` attempts picker label / 12 处 callsite 切到 clarifyIteration。

数据流（cross-clarify happy path 重构后）：

```
[Q questioner] ──emit envelope──▶ [INSERT clarify_rounds(kind='cross', asking=Q,
                                   target_consumer=D, iteration=N)]
                                   ▼
                            awaiting_human
                                   ▼
                  [user POST /api/clarify/:id/answers]
                                   ▼
       submitClarifyAnswers({kind: 'cross', directive: 'continue'})
                                   ▼
             readiness scan + triggerDesignerRerun(D)
                                   ▼
             mint D' node_run: clarifyIteration = max(maxAsking, maxConsumer, N) + 1
                                   ▼
        D' dispatch → buildExternalFeedbackContext (函数保留)
                                   ▼
              ## External Feedback + ## Prior Output + ## Update Directive
                                   ▼
                       D' rerun output → cascade Q' (clarifyIteration += 1)
                       ▼
           buildPromptContext({consumerKind: 'cross-questioner', ...})
                       ▼
              ## Clarify Q&A 块（全量 Q&A）
                       ▼
                  Q' rerun output → done
```

字段层差异：每条 node_run 行只有 `clarify_iteration` 一列；不再有 `cross_clarify_iteration`。

## 2. shared 层增量

### 2.1 `NodeRunSchema` 删字段

`packages/shared/src/schemas/task.ts`：

```ts
export const NodeRunSchema = z.object({
  // ... 既有字段
  clarifyIteration: z.number().int().nonnegative(),
  // crossClarifyIteration: z.number().int().nonnegative(), ❌ 删除
  reviewIteration: z.number().int().nonnegative(),
  // ...
})
```

类型导出 `NodeRun` 自动收缩。引用方（frontend `node-history.ts` / `SessionTab.tsx` / backend `services/task.ts` mapper）一并刷掉。

### 2.2 shared 既有 helper 不动

`clarify.ts` / `clarify-aging.ts` / `prompt.ts` 中的纯函数（envelope parse / `buildClarifyPromptBlock` / `extractDesignerScopedSubset` / `applyAgingCutoff` / `summariseCrossAnswer` 等）签名与行为字节级保留——本 RFC 只动 backend / frontend，不改 shared 纯函数。

### 2.3 prompt.ts 守门

`packages/shared/src/prompt.ts` 当前如包含 `crossClarifyIteration` 引用（grep 命中 1 行），切到 `clarifyIteration`；如该处只是 dump-debug 字段不影响输出契约则一并删。

## 3. 计数器统一算法（核心）

### 3.1 字段语义重定义

**`node_runs.clarify_iteration`**（合并后唯一）：本节点在 RFC-058 `clarify_rounds` 维度上"参与过的最高 round 计数"。

- self-clarify：asking_node == 本节点 → 每次 round answered，下一次 mint 的 node_run 行 clarifyIteration += 1。
- cross-clarify questioner：asking_node == 本节点 → 同上，answer 后 mint 时 += 1。
- cross-clarify designer：target_consumer_node == 本节点 → answer 后 mint 时 += 1（仅当 round 含至少 1 题 designer-scoped；all-questioner 路径 designer 不参与本轮，clarifyIteration 不变）。
- 不参与的节点：clarifyIteration 不变（继承自 latestExisting）。

**`clarify_rounds.iteration`** 不动：仍是 per-(intermediary_node, loop_iter) 的单调 round 计数，由 RFC-058 / 059 维护。

### 3.2 bump 算法（mint 新 node_run 行时）

下游 mint helper（`triggerDesignerRerun` / `mintQuestionerRerun` / `triggerQuestionerContinueRerun` / `cascadeDownstreamFromDesigner`）统一：

```ts
function computeNewClarifyIteration(args: {
  db: DbClient
  taskId: string
  nodeId: string  // 即将 mint 的目标节点
  triggerRound: ClarifyRound  // 触发这次 mint 的 clarify_rounds 行
}): number {
  // 1. 本节点之前最高的 clarifyIteration
  const ownMax = await selectMaxClarifyIterationForNode(args.db, args.taskId, args.nodeId)
  // 2. 触发轮的 round.iteration（保证至少跟得上当前 round）
  const roundIteration = args.triggerRound.iteration
  // 3. 触发轮 asking 节点的最高 clarifyIteration（保证 cascade 同步）
  const askingMax = await selectMaxClarifyIterationForNode(
    args.db, args.taskId, args.triggerRound.askingNodeId,
  )
  return Math.max(ownMax, roundIteration, askingMax) + 1
}
```

**与旧 cci 算法的对应**：
- `triggerDesignerRerun` newCci = `max(designer.cci, questioner.cci, session.iteration) + 1`
  → 新 newClarifyIteration = `max(designer.clarify, asking.clarify, round.iteration) + 1`
- `mintQuestionerRerun`（patch-2026-05-25 算法）走同一公式，target = questioner（即 asking）

**self-clarify 退化**：asking == target_consumer，三参数中两个相同；算法仍正确（max 取最大）。

### 3.3 freshness 简化

`packages/backend/src/services/clarifyRounds.ts:141` `isFresherForCutoff` 排序键变化：

**改前**（4 层）：
1. `clarifyIteration` desc
2. `crossClarifyIteration` desc
3. `retryIndex` desc
4. `id` desc

**改后**（3 层）：
1. `clarifyIteration` desc
2. `retryIndex` desc
3. `id` desc

`isFresherNodeRun`（scheduler.ts 中的同等函数）同样简化。

### 3.4 cutoff 简化

`computeHistoryCutoff` 删除 `iterationField` 参数：

**改前**：
```ts
return args.iterationField === 'clarifyIteration'
  ? priorCompleted.clarifyIteration
  : priorCompleted.crossClarifyIteration
```

**改后**：
```ts
return priorCompleted.clarifyIteration
```

scheduler 调用方删除 `iterationField: isQuestionerCrossClarifyRerun ? 'crossClarifyIteration' : 'clarifyIteration'`（patch-2026-05-27 引入的分支）→ 统一传 clarifyIteration 隐含语义。

### 3.5 freshness invariant 简化

`scheduler.ts` 的 `applyCrossClarifyFreshnessInvariant`（patch-2026-05-22 引入）改名 `applyClarifyFreshnessInvariant`，扫描时只比较 clarifyIteration：

```ts
function applyClarifyFreshnessInvariant(args: { ... }) {
  // 对每个 clarify-channel 边 (upstream, downstream)：
  // 如果 upstream 某行的 clarifyIteration > 任何 downstream 行的 clarifyIteration，
  // mint 一行 downstream pending（继承 clarifyIteration = upstream.clarifyIteration）
}
```

`isClarifyChannelEdge`（shared/clarify.ts）继续表达 self-clarify 与 cross-clarify channel 边（含 to_designer 出边）。

## 4. backend services 层

### 4.1 文件合并

`services/crossClarify.ts`（1789 行）→ 全部 export 搬入 `services/clarify.ts`（1169 行）；合并后约 ~2400 行（部分重复 import / helper 合并瘦身）。物理删 `crossClarify.ts`。

**`services/clarifyRounds.ts` 处理**（RFC-058 T12 引入的 unified service helper 模块，4 个 export：`computeHistoryCutoff` / `selectAnsweredRoundsForConsumer` / `buildPromptContext` / `listClarifyRoundSummaries+getClarifyRoundDetail`）：**保持独立模块、不并入 clarify.ts**。理由：

- 职责清晰边界——`clarifyRounds.ts` = 读路径 + prompt context 构造（infrastructure helper）；`clarify.ts`（合并后）= 写路径 + lifecycle（session 创建 / submit / cascade / mint / WS broadcast）
- scheduler.ts:63 已经 `import { buildPromptContext, computeHistoryCutoff } from '@/services/clarifyRounds'`——保留这个 import 路径稳定
- 合并入 clarify.ts 会把 ~2400 行进一步推到 ~3000 行，可读性下降，IDE 文件跳转代价增加
- 如未来 RFC-065 决定彻底统一，再单独评估

**legacy `buildClarifyPromptContext` + `buildQuestionerCrossClarifyContext` 处理**：

- 当前状态：`services/clarify.ts:615` 仍 export `buildClarifyPromptContext`（RFC-058 T13 已不再调用，scheduler 改用 `clarifyRounds.buildPromptContext`）；`services/crossClarify.ts:1427` 仍 export `buildQuestionerCrossClarifyContext`（同样不再调用）
- 6+ baseline test 仍 import 这两个函数做断言锁定：`clarify-stop-directive-scoped-to-clarify-rerun.test.ts` (4 case) + `cross-clarify-retry-preserves-iteration.test.ts` (2 case) + `cross-clarify-questioner-context.test.ts` (4 case) + 其他 doc 引用
- **PR-B 决策**（2 选 1）：
  - **A（推荐）**：保留这两个 legacy export 作为 thin alias，delegate 到 `clarifyRounds.buildPromptContext({consumerKind: 'self' | 'cross-questioner', ...})`。Test 不动；PR-B byte-level 守恒最大化。alias 在 RFC-065 真正清理 legacy 时一起删
  - **B**：删除两个 export + 重写 10 个 callsite 用 `buildPromptContext`。新增 D 类 must-modify。PR-B work +0.5d
- **默认选 A**——与 §4.3 legacy types 处理保持一致（推迟到 RFC-065）；PR-B scope 收紧

保留的 export：
- `createCrossClarifySession`
- `submitCrossClarifyAnswers`（与 `submitClarifyAnswers` 共享内部 routing）
- `triggerDesignerRerun`
- `cascadeDownstreamFromDesigner`
- `mintQuestionerRerun`
- `triggerQuestionerContinueRerun`
- `evaluateDesignerRerunReadiness`
- `buildExternalFeedbackContext`（**保留独立函数**——用户决定 §1.2.2）
- `buildExternalFeedbackSources`
- `cleanupCrossClarifySessionsForTask`
- 常量：`CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE` 等

合并后所有 export 路径切：

```ts
// 改前
import { triggerDesignerRerun } from '@/services/crossClarify'
// 改后
import { triggerDesignerRerun } from '@/services/clarify'
```

### 4.2 cci 引用切 clarifyIteration（精确 call-site map）

下表枚举合并后 `services/clarify.ts` 内部 cci 引用的**所有 call site**——PR-B 实施者必须按表逐条改、跑测试。
行号基于 RFC-064 草稿时的 main HEAD（commit `7975d25`）：

| 文件:行 | 当前 | 改后 |
|---|---|---|
| `clarify.ts:188` (patch-2026-05-25 §2.3 audit) | insert `crossClarifyIteration: sourceForCci?.crossClarifyIteration ?? 0` 在 createClarifySession（self-clarify session 创建 propagate 源 agent 的 cci） | 删字段；clarifyIteration 由 sourceForCci.clarifyIteration 通过 insertNodeRun inherit 自然继承（已存在的 inheritedClarifyIteration 路径） |
| `clarify.ts:483` (patch-2026-05-25 §2.3 audit) | insert `crossClarifyIteration: sourceRunRow.crossClarifyIteration ?? 0` 在 clarify-rerun 源 agent mint（patch-2026-05-25 §2.3 audit） | 删字段；clarifyIteration 自然继承 |
| `crossClarify.ts:215` | insert `crossClarifyIteration: iteration` 在 createCrossClarifySession | 删除字段；clarifyIteration 由 §3.2 mint 算法在调用方计算 |
| `crossClarify.ts:809` | SELECT `c: nodeRuns.crossClarifyIteration` 取 max | SELECT `c: nodeRuns.clarifyIteration` |
| `crossClarify.ts:839` | insert `crossClarifyIteration: newCrossClarifyIteration` 在 triggerDesignerRerun | 删字段；clarifyIteration 由 §3.2 计算 |
| `crossClarify.ts:905,914,962,979,997,1025` | cascadeDownstreamFromDesigner 内 `newCrossClarifyIteration` 比较 / insert / idempotency 检查 | 全部改 clarifyIteration；§3.2 算法保持 cascade 幂等性 |
| `crossClarify.ts:1117-1140` | mintQuestionerRerun docstring + 算法描述 | 改名 doc 引用为 clarifyIteration；patch-2026-05-25-questioner-rerun-bumps-cci 行为通过 §3.2 公共 helper 在统一字段下保持 |
| `crossClarify.ts:1161` | SELECT `c: nodeRuns.crossClarifyIteration` 取 max（mintQuestionerRerun） | SELECT `c: nodeRuns.clarifyIteration` |
| `crossClarify.ts:1192` | insert `crossClarifyIteration: newCrossClarifyIteration` (questioner 行) | 删字段；clarifyIteration 由 §3.2 计算 |
| `crossClarify.ts:1290,1403` | `buildExternalFeedbackContext` / `buildQuestionerCrossClarifyContext` doc 中 cci 引用 | 改 doc 引用为 clarifyIteration；函数本身在 §5 重构、doc 同步刷 |
| `clarify.ts`（合并后） `triggerDesignerRerun` / `cascadeDownstreamFromDesigner` / `mintQuestionerRerun` / `triggerQuestionerContinueRerun` 调用方 | 各自计算 newCrossClarifyIteration → 传 insert | 各自计算 newClarifyIteration via §3.2 公共 helper（去重） → 传 insert |
| `scheduler.ts:1099` | `inheritedCrossClarifyIteration = latestExisting?.crossClarifyIteration ?? 0` | 删除该变量；`inheritedClarifyIteration` 已存在 |
| `scheduler.ts:1114,1197` | `insertNodeRun(... crossClarifyIteration: inheritedCrossClarifyIteration ...)` | 删字段（`insertNodeRun` typedef 签名已删 `crossClarifyIteration?: number`） |
| `scheduler.ts:1055` | `clarifyMode: 'self' \| 'cross'` 派生（questioner 拓扑） | 保留不动——这是 questioner 侧 envelope cap 拓扑判断，与 cci 错位无关；runner.ts:935 消费方也不动 |
| `scheduler.ts:317-339` | 大段 doc 注释解释 (cli, cci, retry, id) 4 层排序 | PR-B 改写为 (clarifyIteration, retryIndex, id) 3 层；保留 patch-2026-05-25-fresher-noderun-includes-cci 历史链接说明"该 patch 描述的行为通过统一字段在新排序下天然满足" |
| `scheduler.ts:1414,1425,1464` | cci-references 注释（指向 patch 文件） | 改 doc 引用为 clarifyIteration；patch 链接仍保留作 audit trail |
| `review.ts:308,310,314-322,469,504,517` | doc + insert `crossClarifyIteration: sourceRun.crossClarifyIteration ?? 0`（review row 继承上游 cci） | doc 改 clarifyIteration；insert 字段删除（clarifyIteration 已自然继承上游 sourceRun.clarifyIteration via insertNodeRun inherit pattern） |
| `review.ts:1411` | "preserve crossClarifyIteration on review iterate retry placeholder" 注释 | 改 clarifyIteration；逻辑通过 §3.2 mint 算法自然保持 |
| `review.ts:308 isReviewCciAlignedWithUpstream` | 函数名 + 比较 4 层 cci | 改名 `isReviewClarifyAlignedWithUpstream` + 比较只 clarifyIteration（删 cci 中间档） |
| `lifecycleInvariants.ts:485,524` | doc + `gt(nodeRuns.crossClarifyIteration, s.iteration)` CR-1 abandoned 升级 invariant 比较 | doc 改 clarifyIteration；`gt` 比较改 `gt(nodeRuns.clarifyIteration, r.iteration)`（`r` 即 clarify_rounds 行）。**语义保持**：designer 节点参与新一轮 cross-clarify round 时，其 clarifyIteration 通过 §3.2 mint 算法 ≥ round.iteration，invariant 触发条件不变 |
| `task.ts:690` 单节点 retry placeholder | `crossClarifyIteration: lastRun.crossClarifyIteration ?? 0` insert | 删字段；clarifyIteration 自然继承 |
| `task.ts` `getTaskNodeRuns` mapper | 映射 `crossClarifyIteration` 字段到 NodeRun wire shape | 删字段映射；新 `api-task-clarify-iteration-only.test.ts` 锁字段集 |

**新约束**：PR-B 完工时 `grep -n "crossClarifyIteration\|cross_clarify_iteration" packages/backend/src/services/` 必须为 0（migration 0033 sql 文件除外）；目标 100% 覆盖上表所有 call site。

### 4.3 RFC-058 PR-B T18 遗留的 legacy shared 类型（明确不动）

`shared/src/schemas/clarify.ts` 当前仍 export 以下"legacy"类型（RFC-058 PR-B T18 / migration 0032 一同延后）：

- `ClarifySession` / `ClarifySessionSummary`（RFC-023 老 wire shape）
- `CrossClarifySession` / `CrossClarifySessionSummary`（RFC-056 老 wire shape）
- `ClarifyInboxEntry`（discriminated union of 两 Summary）
- `ClarifySessionSchema` / `CrossClarifySessionSchema` / 各 Summary Schema（zod 定义）

**`shared/src/schemas/ws.ts:9, 127`** WS 事件 `clarify.created` payload **仍引用 legacy `ClarifySessionSummarySchema`**——RFC-058 PR-B T14 只切了 REST 响应 body 到 `ClarifyRoundSummary`，WS payload 没切，是 RFC-058 落档时的故意 scope 收敛（"不动 WS event 名 / payload"）。

**RFC-064 处理决定**：**不动 legacy 类型 + 不切 WS payload schema**——理由：

- 与本 RFC 的"删 cci 列 + 合 service"重构正交（删 cci 列不要求改 WS schema）
- RFC-058 PR-B T18 已经为此延后留了 [pending cleanup PR] 入口；RFC-064 PR-C 不扩张这块 scope
- 切 WS payload 是 wire 契约破坏性改动（影响所有现有 WS 客户端 + frontend invalidation 路径 + 监控工具），属于独立产品决策
- 切 legacy 类型需要同步刷掉 ~20+ 个仍引用它们的 callsite（含 ws.ts 本身、frontend useClarifyWs.ts、部分 PR-A baseline 测试） + 额外 1-2 d 工作

**如未来某独立 RFC 决定收尾**：建议同时做（a）legacy types 删除、（b）WS payload 切 ClarifyRound、（c）migration DROP legacy `clarify_sessions` / `cross_clarify_sessions` 两表（若 RFC-064 PR-C 没做）；本 RFC 文档化此 follow-up 路径但**不实施**。（注：RFC-065 / RFC-066 / RFC-067 / RFC-068 编号已被并发 task / repo 相关 RFC 占用，未来若启动 legacy cleanup 用下一个空闲编号。）

### 4.4 shared 层 + WS 事件 + 公开 prompt token 文档同步

| 文件:行 | 当前 | 改后 |
|---|---|---|
| `shared/src/prompt.ts:130` | `{{__external_feedback_iteration__}}` token doc：`(string form of designer's crossClarifyIteration)` | 改文档：`(string form of designer's clarifyIteration when triggered by external feedback)` |
| `shared/src/prompt.ts:143` | `CrossClarifyPromptContext.iteration` 字段 doc：`Designer's current cross_clarify_iteration as string` | 改文档：`Designer's current clarifyIteration as string (when triggered by external feedback round)`；字段名 `iteration` 不动（runtime API 保留） |
| `shared/src/prompt.ts:444` | comment：`Two iteration counters (clarifyIteration / crossClarifyIteration) run` | 改 single-counter 描述：`A single clarifyIteration counter covers both self-clarify and cross-clarify rounds via RFC-064 unification` |
| `shared/src/schemas/ws.ts:181` | `cross-clarify.designer-rerun-batched` event doc：`Freshly minted designer rerun row at cross_clarify_iteration + 1` | 改文档：`Freshly minted designer rerun row at clarifyIteration + 1`；event 名 / payload shape 保留 |
| `shared/src/schemas/task.ts:232` | `NodeRunSchema.crossClarifyIteration` 字段 | 删字段（T10 已规划） |

**公开 prompt token 决策——`{{__external_feedback_iteration__}}` 保留**：

该 token 是 agent.md 模板可引用的公开变量（例如 `"This is your iteration #{{__external_feedback_iteration__}} based on external feedback"`）。
RFC-064 PR-B **保留 token 名不变**——理由：
- token 名表达"被 external feedback 触发时的 iteration 数值"语义，与底层字段名无强耦合
- 重命名 token 会破坏所有引用它的 agent.md 模板（破坏性变更，与本 RFC 的"零产品行为变更"承诺冲突）
- token 仍由 `buildExternalFeedbackContext.iteration` 字段填充（数值来自 designer node_run 的 clarifyIteration——内部字段名变了，token 暴露的数值语义不变）

如未来 RFC 想暴露统一 clarifyIteration 给所有 agent.md（不限于 designer），可新增 `{{__clarify_iteration__}}` token 并存，本 RFC 不做。

### 4.5 `services/task.ts` 单节点 retry placeholder

patch-2026-05-25 修过的 `task.ts:690` 单节点 retry placeholder 当前已显式继承 `crossClarifyIteration` → 切到 clarifyIteration 即可（实际行为不变）。

## 5. backend scheduler 层

### 5.1 cci 派生变量删除

`scheduler.ts` 当前 4 处派生：
- `currentCrossClarifyIteration = currentRunRow?.crossClarifyIteration ?? 0` → 删除
- `inheritedCrossClarifyIteration = latestExisting?.crossClarifyIteration ?? 0` → 删除（直接用 `inheritedClarifyIteration`）
- `isCrossClarifyTriggeredRerun = (...) && currentCrossClarifyIteration > 0` → 改读 DB
- `isQuestionerCrossClarifyRerun = clarifyMode === 'cross' && currentCrossClarifyIteration > 0` → 改读 DB

### 5.2 `isCrossClarifyTriggeredRerun` 新算法

旧：cci > 0 + hasExternalFeedbackChannel。
新：

```ts
async function isCrossClarifyTriggeredRerun(args: {
  db: DbClient
  taskId: string
  designerNodeId: string
  currentRunRow: typeof nodeRuns.$inferSelect
  hasExternalFeedbackChannel: boolean
}): Promise<boolean> {
  if (!args.hasExternalFeedbackChannel) return false
  // 找最近一条 kind='cross' target_consumer=designerNodeId status='answered' directive='continue'
  // 的 round，其 iteration > currentRunRow 之前的最近 done designer 行的 clarifyIteration
  const latestRound = await db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.targetConsumerNodeId, args.designerNodeId),
        eq(clarifyRounds.status, 'answered'),
        eq(clarifyRounds.directive, 'continue'),
      ),
    )
    .orderBy(desc(clarifyRounds.iteration))
    .limit(1)
  if (latestRound.length === 0) return false
  // 如果 currentRunRow.clarifyIteration < latestRound[0].iteration → 这个 rerun 是为响应该 round 触发的
  return args.currentRunRow.clarifyIteration < latestRound[0].iteration
}
```

性能：`clarify_rounds` 已有索引 `(taskId, kind, status)`（RFC-058 migration 0031），加 target_consumer + directive 走二次过滤；单次成本 < 1ms。如未来 benchmark 退化，可在 `currentRunRow` 上挂一个派生 `lastClarifyTriggerKind: 'self' | 'cross-questioner' | 'cross-designer' | null` 列做 O(1)；本 RFC 不做。

### 5.3 `isQuestionerCrossClarifyRerun` 新算法

类似，但 SELECT `kind='cross' AND asking_node_id = node.id`：

```ts
async function isQuestionerCrossClarifyRerun(args: {
  db: DbClient
  taskId: string
  questionerNodeId: string
  currentRunRow: typeof nodeRuns.$inferSelect
}): Promise<boolean> {
  const latestRound = await db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.askingNodeId, args.questionerNodeId),
        eq(clarifyRounds.status, 'answered'),
      ),
    )
    .orderBy(desc(clarifyRounds.iteration))
    .limit(1)
  if (latestRound.length === 0) return false
  return args.currentRunRow.clarifyIteration < latestRound[0].iteration
}
```

### 5.4 retry inherit 简化

`scheduler.ts:1099` 当前：
```ts
const inheritedCrossClarifyIteration = latestExisting?.crossClarifyIteration ?? 0
```

删除。`insertNodeRun` 两处调用（:1114 + :1197）的 `crossClarifyIteration: inheritedCrossClarifyIteration` 字段同步删除——`inheritedClarifyIteration` 已存在且统一表达 retry 继承。

`insertNodeRun` typedef 签名删 `crossClarifyIteration?: number` 字段（patch-2026-05-24 引入的）。

### 5.5 dispatch 调用切

`buildPromptContext` 调用：

**改前**：
```ts
isQuestionerCrossClarifyRerun
  ? await buildPromptContext({ consumerKind: 'cross-questioner', targetIteration: currentCrossClarifyIteration, ... })
  : await buildPromptContext({ consumerKind: 'self', targetIteration: currentClarifyIteration, ... })
```

**改后**：
```ts
const isCrossQuestioner = await isQuestionerCrossClarifyRerun({ db, taskId, questionerNodeId: node.id, currentRunRow })
isCrossQuestioner
  ? await buildPromptContext({ consumerKind: 'cross-questioner', targetIteration: currentRunRow.clarifyIteration, ... })
  : await buildPromptContext({ consumerKind: 'self', targetIteration: currentRunRow.clarifyIteration, ... })
```

`buildExternalFeedbackContext` 调用类似——gate 改读新 `isCrossClarifyTriggeredRerun`，参数中的 `designerCrossClarifyIteration` 改名 `designerClarifyIteration`。

## 6. migration 0033 脚本

`packages/backend/db/migrations/0033_rfc064_unify_clarify_iteration.sql`：

```sql
-- RFC-064: 把 node_runs.cross_clarify_iteration 折入 clarify_iteration
-- 并 DROP 旧列。走 bun:sqlite 12-step rebuild 因不支持 DROP COLUMN。

-- Step 1: max-merge cci → clarify_iteration（数据迁移）
UPDATE node_runs
SET clarify_iteration = MAX(clarify_iteration, cross_clarify_iteration)
WHERE cross_clarify_iteration > clarify_iteration;

-- Step 2-12: DROP COLUMN cross_clarify_iteration 走 SQLite rebuild
-- （drizzle-kit 自动生成或手写 12-step 模板）
CREATE TABLE node_runs_new (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  -- ... 其它字段
  clarify_iteration INTEGER NOT NULL DEFAULT 0,
  -- cross_clarify_iteration ❌ 不出现
  review_iteration INTEGER NOT NULL DEFAULT 0,
  -- ...
);

INSERT INTO node_runs_new
SELECT
  id, task_id, /* 其它字段 */,
  clarify_iteration,
  /* 跳过 cross_clarify_iteration */
  review_iteration,
  /* 其它字段 */
FROM node_runs;

DROP TABLE node_runs;
ALTER TABLE node_runs_new RENAME TO node_runs;

-- 重建索引（与原 node_runs 表一致，从 schema.ts:nodeRuns 抄）
CREATE INDEX idx_node_runs_task_id ON node_runs(task_id);
-- ... 其它索引
```

**注意**：如本 RFC §5.6 选择"顺手清 RFC-058 PR-B T18 延后的 legacy clarify_sessions / cross_clarify_sessions"，
则同一 migration 0033 文件内 step 13+ 顺序执行：
```sql
DROP TABLE clarify_sessions;
DROP TABLE cross_clarify_sessions;
```

migration test `migration-0033-clarify-iteration-unify.test.ts`：

- empty DB 上跑 → 无 op；schema 验证 cross_clarify_iteration 列不存在
- 1 行 cci=0 clarify=0 → 跑后 clarify=0
- 1 行 cci=0 clarify=3 → 跑后 clarify=3
- 1 行 cci=2 clarify=0 → 跑后 clarify=2
- 1 行 cci=5 clarify=3 → 跑后 clarify=5
- 1 行 cci=3 clarify=5 → 跑后 clarify=5
- mixed 5 行 → 各行符合 max 规则
- 索引重建 → 查询性能不退化（spot check）
- 旧列查询应抛错（drizzle ORM 类型 + raw SQL 验证）

## 7. 测试策略

### 7.1 PR-A baseline（必须先 push CI 全绿）

**目标**：在 PR-B 重构前，把 RFC-023 + RFC-056 + 9 patch + RFC-058 + RFC-059 全部用户可观察行为
锁住，作为 PR-B refactor 的回归参照。

**估算 80+ case**：

- shared 6：existing schemas / envelope parse 已锁定，本 RFC 复用；新增 NodeRunSchema 字段集 spot check 2 case + applyAgingCutoff edge case 锁 4 case。
- backend 60：
  - clarify-rfc064-bytelevel.test.ts（self-clarify 全 path）20 case
  - cross-clarify-rfc064-bytelevel.test.ts（cross-clarify 全 path + 9 patch）30 case
  - clarify-iteration-bump-rules.test.ts（新 §3.2 算法）5 case
  - clarify-iteration-freshness-cutoff.test.ts（新 §3.3 / 3.4 / 3.5）5 case
- frontend 14：
  - node-history-clarify-iteration.test.ts（attempts picker label / 排序）4 case
  - clarify-detail-counter-display.test.ts（详情页显示统一名）3 case
  - 既有 fixture refresh 7 case（node-drawer-session-tab / prompt-history-sort 等）

### 7.2 PR-B 重构后回归判据

- PR-A 80+ case 在 PR-B 后**面向用户层字节级 diff = 0**
- 内部实现细节允许变（删 cci 列后 SQL projection 变化、内部变量名）
- 全 backend / shared / frontend 套件零退化（除 PR-A 锁住的"残留 corner case fix"明示 case）

### 7.3 PR-B 新增 grep 守门

- `clarify-iteration-single-source.test.ts`：源代码层 grep `crossClarifyIteration` / `cross_clarify_iteration` 在 src/ 共 0 处
- `clarify-service-singleton.test.ts`：`services/crossClarify.ts` 文件不存在 + `buildExternalFeedbackContext` 在 `services/clarify.ts` 内 export
- `clarify-freshness-no-cci.test.ts`：排序键只有 3 层（无 cci 中间档）

### 7.4 e2e

`e2e/cross-clarify.spec.ts`（RFC-056 PR-D 已落地）继续守门——重构后跑全绿即 PR-B 回归判据之一。
不新增 e2e（RFC-058 / 059 路径已经覆盖 cci 错位类风险）。

## 8. 失败模式 / 边界条件

| 场景 | 期望行为 |
|---|---|
| migration 0033 中途断电 | 走 SQLite atomic transaction；不完成则全 rollback，daemon 启动失败提示 |
| `isCrossClarifyTriggeredRerun` 新 DB 查询返回 0 行（罕见） | 返回 false；后续等同于 self-clarify 路径（与旧逻辑 cci=0 时一致） |
| `clarify_rounds.iteration` 与 `node_runs.clarifyIteration` 不一致（罕见 race） | freshness invariant fixed-point 兜底（§3.5）会在下一次 scheduler 循环对齐 |
| 单节点 retry 时 latestExisting=null（首次 mint） | `inheritedClarifyIteration ?? 0` 走默认 0，与旧行为一致 |
| Q 多源 cross-clarify 节点指向同一 D（RFC-056 §6） | submit 第一个不触发 D rerun（readiness 未满）；submit 第二个触发 D rerun，clarifyIteration bump 一次 |
| wrapper-loop 内 cross-clarify（RFC-056 §5）loop iter 2 | clarifyIteration 与 RFC-058 已锁定 loop_iter 过滤逻辑一致，每 iter 内独立计数 |
| 反问者 reject 持久 directive='stop' | 节点 mint 时 clarifyIteration 仍 +1（按 §3.2）；stop 行为通过 `applyLatestDirective` 表达不变 |
| **`isClarifyRerun` gate 语义扩展（scheduler.ts:1292）** | **改前**：`isClarifyRerun = currentClarifyIteration > 0 && retryIndex === 0`——cross-clarify questioner rerun（clarifyIteration 停在 0、cci 上升）这条 gate 为 false。**改后**（统一计数器）：cross-clarify questioner rerun clarifyIteration > 0 → gate 为 true。下游 `priorSessionId = isClarifyRerun ? readPriorAgentSessionId(...) : null`（:1293）开始计算 prior session id。**实际安全**：`clarifyNodeObjForGate` 用 `findClarifyNode(definition, ...)` 过滤 `n.kind === 'clarify'`（RFC-023 self-clarify 才匹配，cross-clarify NodeKind 不匹配）→ `sessionMode='isolated'` → `decideResumeSessionId` 不 resume。**底层 invariant 保证**：现有 validator `clarify-multiple-clarify-on-same-agent` 规则（`workflow.validator.ts:875-893`，predicate `e.source.portName === '__clarify__' && e.target.nodeId !== node.id`）**已阻断 agent 同挂 self+cross-clarify**——`__clarify__` 是两种 NodeKind 共用源端口、predicate 不看 target kind 所以两种组合都通杀。**单 envelope 端口、无 destination 字段**这一硬约束保证 agent 永远只有一种 clarify 形态。PR-B 无需特殊 mitigation；既有 sessionMode='isolated' 兜底已足够 |
| **scheduler.ts:1056 `clarifyMode` 拓扑判断保留** | `clarifyMode: 'self' \| 'cross' = findCrossClarifyNodeForQuestioner(...) !== undefined ? 'cross' : 'self'`——这是 questioner 侧 envelope `maxQuestions` cap 解除（cross-clarify 没有 5 题上限）的拓扑判断，**与 cci 错位无关**，PR-B 保留不动。runner.ts:935 消费 `clarifyMode === 'cross' ? { maxQuestions: Infinity } : {}` 也不动 |
| **agent 同挂 self-clarify + cross-clarify 节点的混合 attachment** | **不可能存在**——既有 validator `clarify-multiple-clarify-on-same-agent` 规则在保存时阻断；envelope 层也无法区分目的地。是 RFC-023+RFC-056 的设计 invariant，不是 RFC-064 引入的风险 |

## 9. 与 patch chain 对齐

下表确认每个 clarify / cross-clarify patch 在本 RFC 后的形态。**分两类**：
- **A 组**：9 个 dated patch（design/RFC-056-clarify-cross-agent/patch-*.md 文件直接落档的）—— RFC-064 直接重构对象
- **B 组**：6 个早期 fix（pre-RFC-058 时代 + 跨 RFC，散在 commit log，每个有自己专属测试文件）—— RFC-064 PR-A baseline 必须**复用既有测试文件作为回归锚点**，PR-B 不得退化

### A 组（9 个 dated patch）

| Patch | 旧实现 | RFC-064 后 |
|---|---|---|
| 2026-05-22 downstream cascade | 真正 BFS 下游 mint pending；isFresherNodeRun 不看 cci | BFS 不变；isFresherNodeRun 只看 clarifyIteration，已统一 |
| 2026-05-22 questioner Q&A injection | `buildQuestionerCrossClarifyContext` 独立函数 | RFC-058 已合并到 `buildPromptContext`；本 RFC 删旧 helper export |
| 2026-05-22 freshness invariant | `applyCrossClarifyFreshnessInvariant` | 改名 `applyClarifyFreshnessInvariant`，比较 clarifyIteration |
| 2026-05-23 designer retry-index | 抬掉 retry_index=0 sub-gate | 行为不变；cci 引用切 clarifyIteration |
| 2026-05-24 retry preserves cci | `inheritedCrossClarifyIteration` 显式继承 | 删除该变量；`inheritedClarifyIteration` 统一表达 |
| 2026-05-25 fresher-noderun-includes-cci | 排序键 4 层 | 简化为 3 层（无 cci 中间档） |
| 2026-05-25 history-label-includes-cci | 前端 attempts picker 含 cci 列 | label 改用 clarifyIteration 单值；行为不变 |
| 2026-05-25 questioner-cascade-no-skip | cascade 幂等检查不只看 cci 数值 | 行为不变；DB 查询切 clarifyIteration |
| 2026-05-25 questioner-rerun-bumps-cci | mintQuestionerRerun max+1 算法 | 算法搬入 §3.2 公共 helper；行为不变 |
| 2026-05-26 review-dispatch-respects-cci | `isReviewCciAlignedWithUpstream` | 改名 `isReviewClarifyAlignedWithUpstream`；比较 clarifyIteration |
| 2026-05-27 questioner-cutoff-uses-cci | `iterationField` 参数切 cci | 删 `iterationField` 参数；统一 clarifyIteration |

### B 组（6 个早期 fix——专属测试文件复用为 PR-A baseline 回归锚点）

| Commit | Fix 内容 | 既有测试文件（PR-A 必复用） | RFC-064 后 |
|---|---|---|---|
| `3105e9f` | cross-clarify 不再每 tick 生成 orphan pending：`buildScopeUpstreams` 不再把 cross-clarify questioner→cross.questions 边一刀切跳过 + `runOneNode case 'clarify-cross-agent'` 先查 live (pending/awaiting_human) 行再 mint | `scheduler-cross-clarify-no-runaway.test.ts`（~11 case） | scheduler 重构必须保持 idempotence guards 与 questions edge 处理；不得退化 |
| `2d8fc29` | designer rerun retry_index = max(existing retry_index)+1 而非简单 +1，避免历史 retry 行盖过新 designer 行 | `cross-clarify-designer-retry-index.test.ts`（~10 case） | retry_index 计算逻辑搬入 §3.2 mint helper；行为不变；cci 引用切 clarifyIteration |
| `6385633` | shared/prompt.ts 过滤系统端口（`__external_feedback__` 等 `__xxx__` 名）的 auto-append section header，消除 `## __external_feedback__` 空标题 | `prompt-system-port-no-empty-header.test.ts`（~5 case） | 不动 shared/prompt.ts 此逻辑；PR-A baseline cross-clarify byte-level 覆盖 |
| `a88cffe` | review 节点 dispatch 用 scheduler 的 `isFresherNodeRun` 比较器解析最新 upstream run（clarifyIteration → retryIndex → ulid），替代原前一个简陋实现 | `review-dispatch-prefers-clarify-rerun.test.ts`（~6 case） | review.ts T14 已计划用统一比较器；本 patch 既有测试套件提供 byte-level baseline |
| `ec14a85` | review iterate / reject 重跑应继承 clarifyIteration（supersede 标记落在 clarify-rerun 行、新 pending 行 clarifyIteration=1+retry_index=1） | `review-iterate-inherits-clarify-iteration.test.ts`（~8 case） | review.ts mint 行为不动；继承机制本 RFC §3.2 mint helper 内一致 |
| `7b20185` | clarify directive='stop' 仅在 clarify-rerun 生效（`applyLatestDirective: isClarifyRerun` 参数），不再污染 review-iterate 重跑 | `clarify-stop-directive-scoped-to-clarify-rerun.test.ts`（~9 case）+ `clarify-prompt-wire-up.test.ts` grep guard | `applyLatestDirective` 参数已在 RFC-058 `buildPromptContext` 中保留；本 RFC 不动 |

**所有 A + B 组 patch 描述的行为在 RFC-064 后保持，但其实现已不再依赖独立 cci 列**——cci 错位类 bug 在
源代码层从根上消除（C3 grep 守门锁）。**B 组 6 个测试文件作为 PR-A baseline 的固化锚点直接复用、不重写**——这是
RFC-058 PR-A 已经证明的可行模式（RFC-058 也是直接复用 RFC-023 / RFC-056 既有测试套件作为字节级 baseline）。

## 10. 源代码层 grep 守门

PR-B 完工时以下 grep 必须为 0（除 migration 0033 sql 文件 + design/RFC-* 文档）：

```bash
grep -rn "crossClarifyIteration" packages/backend/src/ packages/shared/src/ packages/frontend/src/
grep -rn "cross_clarify_iteration" packages/backend/src/ packages/shared/src/ packages/frontend/src/
grep -rn "isCrossClarifyTriggeredRerun\|isQuestionerCrossClarifyRerun" packages/backend/src/services/clarify.ts # 函数定义点保留，外部引用全切
grep -rn "from.*services/crossClarify" packages/  # 0 命中：文件已删
ls packages/backend/src/services/crossClarify.ts  # 应抛错：文件不存在
```

以下 grep 必须 ≥ 1：

```bash
grep -n "clarifyIteration" packages/backend/src/services/clarify.ts  # 合并后唯一 service
grep -n "applyClarifyFreshnessInvariant" packages/backend/src/services/scheduler.ts  # 改名后
```

## 10.5 i18n / UX label 决策点（需用户拍板）

**问题**：当前 `node-history.ts:54-66` 的 `formatIterationLabel` + `SessionTab.tsx:269-270` 的 attempts picker
label 通过**两个独立计数器**（clarifyIteration / crossClarifyIteration）渲染出"反问#1 · 跨反问#2"这种
**自/跨双标签复合形态**，用户能一眼看出某次 attempt 属于 self-clarify 还是 cross-clarify 周期。

RFC-064 删除 crossClarifyIteration 列后，该 UX 信号丢失——所有 clarify-driven 重跑都只能渲染为
"反问#N"，无法在 attempts 列表 / 时间线中区分自/跨。

**3 个选项**（需用户拍板）：

| 选项 | 实现 | 优 | 劣 |
|---|---|---|---|
| **D1 单标签** | i18n key `iterCrossClarify` 删除；所有 clarify attempt 渲染为 `iterClarify`（"反问#N"） | 最简单，与 §3 计数器单一化彻底一致 | 用户无法在 attempts picker 看出某次 attempt 属于 cross-clarify 周期；UX 信息损失 |
| **D2 API mapper 派生 `lastClarifyKind`** | `getTaskNodeRuns` mapper 在返回 NodeRun 时 join `clarify_rounds` 找该 node_run 对应轮次的 kind（asking_node==node 且 iteration==node_run.clarifyIteration），返回 `lastClarifyKind: 'self' \| 'cross' \| null` 衍生字段；frontend 用此字段选择 `iterClarify` vs `iterCrossClarify` | UX 行为完全字节级守恒；零 schema 改动；保持 RFC-064 unification 精神 | mapper 多一次 join 查询；wire shape 加 1 个派生字段；frontend 改 `formatIterationLabel` 取派生字段而非 cci 数值 |
| **D3 持久化 `clarifyTrigger` 列** | node_runs 表新增 `clarify_trigger: 'self' \| 'cross-questioner' \| 'cross-designer' \| null` 列，mint helpers 写入；scheduler.ts:1428 的 `isQuestionerCrossClarifyRerun` 改读此列；UX label 直接读此字段 | 性能最好；显式不依赖派生；3 个 cci predicate（§5.2/5.3）也能改成 O(1) 列读 | 加回部分"kind"字段；schema 改动；migration 复杂度上升 |

**默认推荐 D2**：在 unification 精神下保留 UX 区分能力，无 schema 改动；mapper join 成本可控（clarify_rounds 已有索引）。
PR-A baseline 锁定"attempts picker UX 维持双标签 / 跨反问 chip 出现条件不变"；PR-B 实现 mapper 派生 + frontend
切换；C8 守门复用既有 5 case 测试。

**如选 D1**：proposal.md §1.2 加"不动 → 改为'attempts picker label 简化为 反问#N'"；既有 i18n 测试断言 `跨反问#N` 标签的 case 改断言 `反问#N`；用户 UX 上失去自/跨区分。

**如选 D3**：design.md §3 + §5 算法可改用列读替代 DB 查询（性能更优）；migration 0033 加新列 + 数据迁移；新增"何时写入此列"在 4 个 mint helper 内显式标注。

**待用户拍板**：选 D1 / D2 / D3 哪个？默认 D2，与 NodeKind / `buildExternalFeedbackContext` 保留独立的设计倾向一致（保留 UX 区分能力但不引入新 schema）。

## 11. Frontend 零改动清单（与 RFC-063 patch-2026-05-26 commit `7975d25` 协同）

本 RFC 是 runtime / 计数器 / service 重构，与画布连接逻辑**完全正交**。以下 frontend 文件在 PR-B
完工后必须保持**面向用户层 0 字节改动**（DOM testid + 文案 + ARIA 标签字节守恒；唯一允许的内部
改动是 `crossClarifyIteration` 字段引用切到 `clarifyIteration`——但 grep 结果显示这些 canvas 文件
当前 0 命中 cci，所以预期 git diff 也是 0）：

| 文件 | 当前内容（commit `7975d25` 后） | RFC-064 接触面 |
|---|---|---|
| `packages/frontend/src/components/canvas/clarifyDragHelper.ts` | `hasExistingClarifyChannel(def, agentNodeId)` + `clarifyHasAttachedAgent(def, clarifyNodeId)`（patch-2026-05-26 新增）+ `applyClarifyReverseDrag(def, args)`（3 道 short-circuit：existing channel / answer-only edge / multi-agent attached） | 0（不引用 cci） |
| `packages/frontend/src/components/canvas/crossClarifyDragHelper.ts` | `crossClarifyHasDesignerEdge(def, crossClarifyNodeId)` + `crossClarifyHasAttachedQuestioner(def, crossClarifyNodeId)`（patch-2026-05-26 新增）+ `applyCrossClarifyQuestionerReverseDrag(def, args)` + `applyCrossClarifyDesignerDrag(def, args)` | 0（不引用 cci） |
| `packages/frontend/src/components/canvas/WorkflowCanvas.tsx` `isValidConnection` 接线（lines :545 / :549 / :571 / :579） | 4 处 `xxxxxx(definition, ...) ? return false : continue` 防误连——画布层 G1/G2/G3 视觉镜像 | 0（不引用 cci） |
| `packages/frontend/src/components/canvas/nodePalette.ts` clarify / cross-clarify palette item | RFC-056 / RFC-063 引入的 palette label / icon | 0 |

C8 守门测试（proposal.md §4 C8）通过对这三个文件做"PR-A snapshot vs PR-B HEAD diff"断言 / 既有 5
case 测试（canvas-clarify-drag.test.ts +3 / cross-clarify-drag-helper.test.ts +2）零退化双重保护。

**如 PR-B 实施期发现 cross-clarify drag helper 内部确有需要协同的细节**（极不可能——drag helper
只读 `definition.edges[]` 静态拓扑，不涉及 node_run 计数器），需停下来与用户对齐再继续。

## 12. 估算工作量

PR-A baseline：5-7 工作日（80+ case 写作 + 跑 CI 验证 + 用户验证）
PR-B 重构：7-10 工作日（migration + scheduler + services 合并 + grep 守门 + 全套回归）
PR-C 清理（可选，与 PR-B 合）：1-2 工作日（frontend callsite + legacy DROP，如选 §5.6 顺手清）

合计 ≈ 13-19 工作日。RFC-058 / 059 实际花了 ~15 工作日，本 RFC 量级类似（数据 schema 改动小，但 scheduler 调用面广）。
