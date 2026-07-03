# RFC-140 技术设计：一次点击全下发

## 0. 改动一览

| # | Workstream | 位置 | 性质 |
|---|---|---|---|
| W1 | questioner→designer 对称塌缩 | `services/taskQuestions.ts`（`reassignTaskQuestion` + 新 `collapseQuestionerEntryToDesigner`） | 纯后端，零 migration |
| W2 | deferred 登记 + tick 自动补发 | `services/taskQuestionDispatch.ts`（defer 时盖列）+ `services/scheduler.ts`（tick 顶补发钩子）+ migration 新列 | 后端 + 1 列 migration |
| W3 | 前端知会 | 看板 deferred 徽标 + 塌缩 notice 对称扩展 + i18n | 前端 |

## 1. 现状机制（改动锚点）

- **auto-split**（`taskQuestionDispatch.ts:396-440`）：批量下发按 effective target 分组
  （`byHomeCause`），同 home 混 cause 时按 aging（`staged_at ?? created_at` 最老优先）+
  `CAUSE_PRIORITY`（clarify-answer 0 < questioner-rerun 1 < designer-answer 2）破平选一种
  cause 下发，其余 push 进 `deferredEntries`（**仅瞬时返回值，不落库**）。
- **cause 的运行时分叉**（保留不动）：`isClarifyRerunCause`（scheduler.ts:2568）→ inline
  session resume + review 下强制反问 gate；注入层 `buildClarifyQueueContext` 本就全角色统一、
  cause 无关。
- **runTask 主循环**（scheduler.ts:810）：`while(true)` tick——select runs → deriveFrontier
  → dispatch ready → `Promise.race(inFlight)` 等任一节点完成 → 回 tick 顶。**每个 node run
  完成后必然重入 tick 顶**；quiescent（无 in-flight 无 ready）时 `decideScopeOutcome` 收敛。
- **park 门**（scheduler.ts:835 `loadUndispatchedParkTargets`）：sealed-undispatched 条目
  park 其 home，frontier 不会在 deferred 条目悬置时误判 asking node 完成——deferred 批次的
  存在已被调度感知，本 RFC 只补「自动下发」这一步。
- **RFC-138 塌缩**（`taskQuestions.ts:1002-1021` + `collapseDesignerEntryToQuestioner`）：
  cross designer 行改派到 `round.askingNodeId` → 两表 scope 翻转 lockstep + 删未下发行 + 幸
  存行自足保证。本 RFC W1 是其镜像。
- **echo 物化**（`taskQuestionDispatch.ts:724-758`）：dispatch tx 内 insert
  `roleKind='echo'` 行，`dispatched_at=now` 即刻盖，唯一键 `(origin, question, roleKind)`
  `onConflictDoNothing` 幂等；echo 是 queued 回执、零 mint、不阻塞（RFC-134 D4 序列化豁免）。

## 2. W1 对称塌缩（questioner → designer）

### 2.1 触发条件（`reassignTaskQuestion` 新分支，紧邻 RFC-138 分支）

`entry.sourceKind === 'cross' && entry.roleKind === 'questioner'` 且 round（by
`originNodeRunId`）存在、`round.kind === 'cross'`、`targetNodeId ===
round.targetConsumerNodeId`（非 null）。任一不满足 ⇒ 回落常规 override 路径（golden-lock）。

### 2.2 塌缩 tx（新 `collapseQuestionerEntryToDesigner`，镜像 RFC-138 逐条对称）

单 `dbTxSync`：

1. **CAS**：questioner 行 `dispatched_at IS NULL`（已下发 ⇒ 409
   `task-question-already-dispatched`，同 override 路径；此时该题已在轨道、零新增动作——镜像
   RFC-138 D6）。
2. **两表 scope 翻转**：`question_scopes_json[qid] = 'designer'`——`clarify_rounds`（tx 内重
   读后 merge，绝不用 tx 外快照）+ `cross_clarify_sessions` lockstep 双写（镜像
   `sealRoundQuestions` 纪律）。
3. **删该题未下发的 questioner 行**（本行）。
4. **幸存 designer 行自足保证**：该题 designer 行 insert-if-missing + seal 行戳归一化（镜像
   RFC-138 Codex P2 fold：原 scope=questioner 时 reconcile 从未建 designer 行；懒建行无
   `sealed_at` 会被 park/渲染源滤掉）。`staged_at` 继承被删 questioner 行的值（若有）——用户
   的暂存意图随题转移，塌缩后无需重新 stage。
5. **echo 知会（与 RFC-138 的关键不对称）**：为提问节点物化 echo 行（insert
   `onConflictDoNothing`，`dispatched_at=now`，形态镜像 dispatch tx :731-757）。RFC-138 塌缩
   不产 echo 是因为幸存 questioner 行本就指向提问节点（信息自达）；本方向幸存的是 designer
   行（指向设计节点），提问节点失去该题投递，echo 是 RFC-134 不变量（「有效承接 ≠ 提问节点
   → 补投递」）在塌缩形态下的延续。echo 渲染走 round 的 `answers_json`（selectAgentQueue 读
   时取），答题前塌缩也安全——提问节点在答案下发前不会有新 rerun 来渲染它。
6. 路由响应 `action: 'collapsed-to-designer'`（`ReassignTaskQuestionAction` 三值化）。

### 2.3 塌缩后的下发形态（本 case 重演）

10 条 → 9 条（q1 questioner 没了）：home `agent_1k2ftd` 只有 questioner 类（q2-q5）、home
`agent_m7p3n1` 只有 designer 类（q1-q5）→ `byHomeCause` 每 home 单 cause → **无 auto-split、
一次全发**（frontier mint 设计节点修订 rerun；反问者节点非 frontier 走级联）。q1 的 Q&A 由
设计节点的一条修订 rerun 消化（注入层 RFC-134 D9 同题去重本就存在），提问节点续跑时经 echo
看到 q1 的 Q&A。

### 2.4 复活语义（不引入新边界）

塌缩删 questioner 行 = 该题不再为提问节点 mint 复活续跑。这与**既有** override-到-第三节点
的语义完全一致（RFC-127/134：mint 发生在改派目标，提问节点仅收 echo、零 mint；复活靠 q2-q5
等其余 questioner 行的 mint/级联，或设计节点 done+output 后的下游 stale-redispatch 级联）。
不新增图判定。

## 3. W2 deferred 登记 + tick 自动补发

### 3.1 登记（migration：`task_questions` 新列 `auto_dispatch_deferred_at INTEGER`）

- **盖**：`dispatchTaskQuestions` 的 stamp tx 内（:512-761），对 `deferredEntries` 的行
  `SET auto_dispatch_deferred_at = now`——与 dispatch 批的 `dispatched_at` stamp 同 tx 原子。
  语义 = **用户已对该条目表达过下发意图，仅因 cause 序列化被排队**。
- **读**：待补发集合 = `auto_dispatch_deferred_at IS NOT NULL AND dispatched_at IS NULL`。
  dispatched_at 盖上后登记自然失效（不清列——保留「曾被 defer」审计痕迹，零额外写）。
- **为什么不派生**：staged 未 dispatched 无法区分「用户点过下发被 defer」与「stage 后还在斟
  酌」——自动发后者是越权（proposal 非目标 5）。为什么不内存登记：daemon 重启即丢，违背验收 5。

### 3.2 自动补发钩子（runTask tick 顶，scheduler.ts:820 附近）

每轮 tick 在 deriveFrontier **之前**：

```
const deferredIds = SELECT id FROM task_questions
  WHERE task_id = ? AND auto_dispatch_deferred_at IS NOT NULL AND dispatched_at IS NULL
if (deferredIds.length > 0) {
  try { await dispatchTaskQuestions(db, taskId, deferredIds, SYSTEM_ACTOR) }
  catch (e) { if (e instanceof ConflictError) log.debug(...) else throw }
}
```

- **执行体 = 完整复用 `dispatchTaskQuestions`**：seal/readiness 检查、auto-split（三类 cause
  嵌套 defer 自动逐批收敛——本批又 defer 的行保持登记）、in-flight 门、mint、echo、审计 log
  全部原样；`actor = { userId: '__system__', ... }`（先例：`task.ts:202` daemon-token actor、
  QMGP5 历史行 `dispatched_by='__system__'`）。
- **为什么挂 tick 顶而非 run-done 事件点**：tick 在每个 node run 完成后必然重入（:876
  `Promise.race` → continue → :810），天然覆盖「第一条续跑 done」时刻；单线程串行（无并发
  dispatch 竞争）；daemon 重启 → 任务 revival → runTask 重入 → tick 顶补发（验收 5 零额外
  逻辑）；失败（409：该 home 或别的 home 仍 in-flight）静默 continue，下一 tick 幂等重试
  （验收 6）。事件点方案需要新事件管线 + 重启补扫，纯劣化。
- **quiescent 交互**：补发成功 → mint 的 pending 行进入下一轮 deriveFrontier → 继续跑；补发
  持续 409 且 scope 已 quiescent → `decideScopeOutcome` 照常收敛（awaiting_human 等），用户
  介入后 resume 重入 tick 再试——deferred 登记不丢。
- **补发时机的正确性**：in-flight 门（RFC-133）对 done（含 done-no-output）放行、对
  failed/interrupted 拒绝（revivable 保护）——自动补发**天然继承**这套门禁，无需自带状态判断。
  第一条续跑以再问一轮收场（done-no-output）时补发 designer 批 → mint 修订 rerun 与新一轮
  clarify 回答流交错——RFC-139 的双台账「done-no-output 关账 + 同锚合流」恰好保证守卫不误杀
  （rfc139 对称 case 已锁）。

### 3.3 与 park 门的一致性

deferred 条目本就在 `loadUndispatchedParkTargets` 的 park 集里（sealed-undispatched），任务
不会在补发前误判完成；补发把它们转为 dispatched 后 park 自然解除。零改动。

## 4. 失败模式分析

| 风险 | 分析 | 结论 |
|---|---|---|
| A. 塌缩误伤第三节点改派 | 触发条件含 `targetNodeId === round.targetConsumerNodeId` 精确匹配；第三节点走 override（golden-lock 测试） | 隔离 |
| B. 塌缩后该题 designer 行缺 seal → park/渲染丢失 | insert-if-missing + seal 归一化（镜像 RFC-138 P2 fold，测试锁） | 已防 |
| C. 塌缩后提问节点看不到该题 Q&A | echo 行塌缩 tx 内物化（幂等键）；渲染走 round answers_json，答题前塌缩安全（提问节点在答案下发前无新 rerun） | 已防（验收 1） |
| D. 自动补发越权（stage 未点发被发出） | 登记列仅在 dispatch defer 分支盖；tick 只读登记列 | 已防（验收 4） |
| E. 自动补发与用户手动下发并发 | `dispatchTaskQuestions` 既有并发网原样生效：question-write lock (B) 串行 + tx 内 CAS（`dispatched_at IS NULL`）→ `ConcurrentClaim` 一方静默让路 | 复用既有防线 |
| F. 补发风暴（每 tick 409 刷日志） | tick 仅在 node 完成时发生（低频）；409 → debug 级 log + continue | 可控 |
| G. 三类 cause 嵌套 defer 不收敛 | 每轮补发至少下发一类（auto-split 每 home 恒选一类）、deferred 集合严格缩小；`CAUSE_PRIORITY` 全序 → 至多 2 轮补发收敛 | 收敛有界 |
| H. migration 破坏滚动升级 | 单列 ADD COLUMN（可空、无 backfill）；`--> statement-breakpoint` 不需要（单语句）；**必须 bump `upgrade-rolling.test.ts` journal 计数断言**（reference_migration_bumps_journal_count_test） | 流程项 |
| I. 塌缩与并发 dispatch 竞争 | CAS 在 `dispatched_at` 同列（镜像 RFC-138）：dispatch 赢 → 塌缩 409；塌缩赢 → dispatch 的 `TargetChanged` 快照校验兜底 | 复用既有防线 |
| J. `__system__` 下发的归属审计 | `dispatched_by='__system__'` 已有先例（QMGP5 历史行）；RFC-099 prompt-isolation 不受影响（归属列绝不进 prompt） | 无新面 |

## 5. 测试策略（随改动落地）

新文件 `packages/backend/tests/rfc140-one-click-dispatch-all.test.ts`：

**W1 塌缩**（镜像 `rfc138-reassign-to-asker-collapse.test.ts` 的 case 族）：
1. cross questioner 行改派到 `targetConsumerNodeId` → `action='collapsed-to-designer'`、
   questioner 行删除、两表 scope=designer lockstep、echo 行物化（dispatched、幂等键）；
2. 该题原 scope=questioner（无 designer 行）→ insert-if-missing 补建 + seal 归一化 +
   staged_at 继承；
3. golden-lock：改派到第三节点 → `action='override'`、行保留、无 echo 新增、无 scope 翻转；
   self 轮 questioner？（不存在——self 轮无 questioner 行，防御断言触发条件不命中）；
4. questioner 行已 dispatched → 409 `task-question-already-dispatched`、零写入；
5. 塌缩后批量下发（QMGP5 形态 9 条）→ `deferredEntryCount=0`、两 home 各一条
   mint/级联、设计节点 rerun 注入含 q1（D9 去重单份）。

**W2 自动补发**：
6. 混批（self + designer 同 home 不同题）下发 → deferred 行盖 `auto_dispatch_deferred_at`；
   模拟第一条续跑 done → 触发 tick（或直接调抽出的 `autoDispatchDeferred` 纯入口）→ 第二批
   dispatched（`dispatched_by='__system__'`）、mint 修订 rerun；
7. 越权防护：同任务另一条 staged 未点发（登记列空）→ tick 不动它；
8. 409 自愈：第二批目标仍有 running rerun → tick 静默、登记保留 → run done 后下一 tick 成功；
9. 三类 cause 嵌套：第一轮 defer 两类 → 第二轮再 defer 一类 → 两轮 tick 后全部 dispatched
   （收敛断言）；
10. 重启韧性：登记列落库后重建 scheduler 状态（新 runTask 入口）→ tick 照常补发。

**W3 前端**（vitest）：
11. 看板 deferred 条目徽标（`auto_dispatch_deferred_at` 非空未 dispatched → 显示等待文案）；
12. 塌缩知会：`action='collapsed-to-designer'` 响应 → notice 渲染（镜像 RFC-138 前端 case）。

**migration**：13. `upgrade-rolling.test.ts` journal 计数 N→N+1（标题 + 断言 + 注释同步）。

## 6. 兼容与依赖

- migration：1 列（`task_questions.auto_dispatch_deferred_at INTEGER`，可空）；无 backfill、
  无索引（读取恒带 task_id 等值条件，走既有 `idx_task_questions_task`）。
- 存量行为：登记列全空 → tick 补发零命中 → 逐字现状；未塌缩的既有 override 行为 golden-lock。
- API：`ReassignTaskQuestionAction` 增 `'collapsed-to-designer'`（响应字段向后兼容，前端旧版
  按 override 渲染也无害）；task_questions 列表自动带出新列。
- 与 RFC-138/139 的关系：W1 是 RFC-138 的镜像补全（同题只跑一遍的另一半）；W2 依赖 RFC-139
  的守卫语义（done-no-output 关账 + 同锚合流）保证补发交错场景不误杀——RFC-139 已 Done。
