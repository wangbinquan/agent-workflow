# RFC-120 技术设计 — 任务问题清单 / 任务中心

> 读法：先 `proposal.md` 再本文。本文给接口契约、数据流、耦合点、失败模式、测试策略，并把「灵活改派」与「打回」两块最高风险机制讲透。证据 file:line 基于 2026-06-28 HEAD（行号以**符号名为锚**，RFC 并发改动后可能漂移）。

## 1. 现状回源（证据）

### 1.1 反问的单一历史台账 `clarify_rounds`

- `clarify_rounds`（`schema.ts:1127`）每轮一行、`kind ∈ {self,cross}`、`status ∈ {awaiting_human,answered,canceled,abandoned}`；`questions_json` 整批问题 blob、`answers_json` 整批答案 blob、每题只有轮内 `id`（≤64）。**无 per-question 行、无 per-question 状态**。REST 按 `intermediary_node_run_id`（clarify 表单节点的 node_run）定位一轮（`routes/clarify.ts` `getClarifyRoundDetail`）。
- 跨节点 scope（RFC-059）：`question_scopes_json` 是 `Record<questionId,'designer'|'questioner'>`、默认 `designer`（`shared/clarify.ts` `resolveQuestionScope`/`CLARIFY_QUESTION_SCOPE_DEFAULT`）。`scope=designer` 答案喂**设计者 External Feedback + 反问者级联**两方；`scope=questioner` 只喂反问者。反问者**永远**收全量答案（与 scope 无关）。
- RFC-099 协作列：`submitted_by_role`/`answer_attributions_json`/`draft_answers_json`（`schema.ts:1188`）——**只入审计/UI、从不进 prompt**（`buildPromptContext`/`buildClarifyPromptBlock` 不读，rfc099 测试锁）。

### 1.2 承接者两类角色的代码事实（决定改派可行性）

- **阻塞-产出型**：self 提问节点（`createClarifySession` `clarify.ts:128`，答后 `submitClarifyAnswers` `clarify.ts:335` 在 `clarify.ts:472` mint 一条 `cause='clarify-answer'` 的 rerun 续跑提问节点本身产出）；cross 反问者（`crossClarify.ts:952` mint `cause='cross-clarify-questioner-rerun'`）。**它们用提问代替了产出**，必须自我重跑、否则下游阻塞。
- **修订型**：cross 设计者。`triggerDesignerRerun`（`crossClarify.ts:772`）mint `cause='cross-clarify-answer'`、**无 worktree 回滚**（就地修订）、把答案经 `buildExternalFeedbackContext`（`crossClarify.ts:1089`）→ `buildExternalFeedbackBlock`（`shared/clarify.ts:441`）注入设计者 prompt。设计者节点经图边 `to_designer→__external_feedback__`（`shared/schemas/workflow.ts` `CROSS_CLARIFY_OUT_TO_DESIGNER_PORT`/`CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT`）解析（`findDesignerNodeForCrossClarify` `shared/clarify.ts:655`）。多源批处理：`evaluateDesignerRerunReadiness`（`crossClarify.ts:673`）——所有指向同一设计者的兄弟 cross 节点都 resolve 后才批量重跑设计者、合并各源 designer-scoped 子集。

**→ 改派的本质** = 把 `triggerDesignerRerun` 的「目标节点从 `findDesignerNodeForCrossClarify` 解析值」换成「人选的 `override_target_node_id`」，注入与级联完全复用。**只对修订型成立**（阻塞-产出型换节点=死锁）。

### 1.3 node_run 生命周期与 freshness（派生态的信号源）

- `node_runs`（`schema.ts:591`）：`status ∈ {pending,running,done,failed,canceled,interrupted,skipped,exhausted,awaiting_review,awaiting_human}`（`:612`）；`rerun_cause`（`:781`）记 mint 缘由；产出在 `node_run_outputs`（`schema.ts:792`，`(nodeRunId,portName)`）。
- 生命周期信号：mint pending（`nodeRunMint.ts:115`，`startedAt:null`）→ `mark-running` 置 `startedAt`（`runner.ts:773`）→ 解析信封落 `node_run_outputs`（`runner.ts:1390`）+ `mark-done`（`runner.ts:1483`）/ `mark-failed`。
- freshness 单一收口：`pickFreshestRun(rows,{topLevelOnly,statusIn})`（`freshness.ts:290`，按 ULID 取最大）、`isFresherNodeRun`（`freshness.ts:156`）。**问题条目派生态据此取承接节点的 freshest rerun，无需自建状态列。**

### 1.4 权限与前端接入点

- 答题权边界：`requireTaskMember`（`taskCollab.ts:67`，返回 `owner|user|admin` 角色快照或 403），路由经 `ensureClarifyMember`（`routes/clarify.ts:63`）。本 RFC 复用同一函数。
- 任务详情页 tab：`lib/task-detail-tabs.ts`（`TaskDetailTab` 联合 + `TAB_ORDER` + `availableTabs`）+ `tasks.detail.tsx`（每 pane `hidden` 切换、always-mounted）。`feedback` 页签是「列表面板升页签」的现成范例。clarify 跳转 `<Link to="/clarify/$nodeRunId">`。实时 `useTaskSync`（已在任务页订阅 `/ws/tasks/{taskId}`，收 `clarify.*`/`node.status` 失效 query）。

## 2. 接口契约

### 2.1 数据模型：`task_questions`（migration 0060）

每行 = 一个**承接条目**（问题 × 承接角色）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | ULID |
| `task_id` | TEXT notNull | FK tasks（删任务级联） |
| `origin_node_run_id` | TEXT notNull | 来源反问轮的 `intermediary_node_run_id`（定位 `clarify_rounds`）。**条目恒锚定原轮**——打回采就地改答（§3.3），不再开「再答轮」、无 active 轮指针。 |
| `question_id` | TEXT notNull | 轮内问题 id |
| `question_title` | TEXT notNull | 问题标题快照（题面不随打回变，快照安全） |
| `source_kind` | TEXT notNull | `self` \| `cross` |
| `role_kind` | TEXT notNull | `self` \| `questioner` \| `designer`（仅 `designer` 可改派） |
| `iteration` / `loop_iter` | INTEGER notNull | 原轮 iteration / loopIter 快照（派生态按节点+迭代精确框定承接 lineage，**Codex F1**） |
| `default_target_node_id` | TEXT | 图解析的承接节点（设计者/反问者/提问节点；解析不到为 NULL） |
| `override_target_node_id` | TEXT | 改派目标（仅 `designer`；NULL=用 default） |
| `trigger_run_id` | TEXT | 本条目承接执行的**锚点 rerun** node_run id（未答为 NULL；打回时前移到新 re-fire run）。派生态据此 + lineage 框定（§2.2），**非**「freshest≥anchor」裸比较。 |
| `confirmation` | TEXT notNull default `'open'` | `open` \| `confirmed` |
| `confirmed_by` / `confirmed_by_role` / `confirmed_at` | TEXT/TEXT/INTEGER | 确认审计 |
| `last_reassigned_by` / `last_reassigned_at` | TEXT/INTEGER | 改派审计 |
| `reopen_count` | INTEGER notNull default 0 | 打回次数审计 |
| `prior_answer_snapshot_json` | TEXT | 打回就地改答前，原答案的快照（审计；保留「解冻前」历史，**Codex F2**） |
| `created_at` / `updated_at` | INTEGER notNull | |

唯一键 `UNIQUE(origin_node_run_id, question_id, role_kind)` = 条目天然身份。**有效承接节点** = `override_target_node_id ?? default_target_node_id`。**执行三态不落库**（派生）；落库的只有人工覆盖层（confirmation + override + 审计）。**仅新建 `task_questions` 一张表**——打回就地改 `clarify_rounds.answers_json`、不给 `clarify_rounds` 加列（migration 轻量、不动既有反问表结构）。

### 2.2 纯函数（可断言核心，独立单测）

放 `packages/shared/src/task-questions.ts`：

```ts
// 一轮 clarify_round → 该轮应有的条目身份集合（幂等、确定）
type DesiredEntry = { questionId; questionTitle; sourceKind; roleKind; defaultTargetNodeId }
reconcileDesiredEntries(round: {
  kind:'self'|'cross', questions: ClarifyQuestion[],
  scopes: Record<string,'designer'|'questioner'>,        // 未答时空 → 无 designer 条目
  graph: { askingNodeId; questionerNodeId?; designerNodeId? },
}): DesiredEntry[]
//  self  → [{q, roleKind:'self', default:askingNodeId}]
//  cross → 每题 [{q,'questioner',questionerNodeId}] ∪ (scope==='designer' ? [{q,'designer',designerNodeId}] : [])

// 条目当前展示态（纯、无 IO）
type Phase = 'pending'|'processing'|'awaiting_confirm'|'done'|'closed'
deriveQuestionPhase(input: {
  roundStatus:'awaiting_human'|'answered'|'canceled'|'abandoned',
  confirmation:'open'|'confirmed',
  handlerRun: { status: NodeRunStatus; startedAt: number|null; hasOutput: boolean } | null,
}): Phase
//  canceled|abandoned → 'closed'
//  confirmation==='confirmed' → 'done'
//  handlerRun==null || startedAt==null → 'pending'
//  status==='done' && hasOutput → 'awaiting_confirm'
//  else（running/failed/done-without-output 兜底）→ 'processing'   // 失败仍处理中（D3）

// 改派合法性（纯，Codex F5）
canReassign(entry: { roleKind }, targetNodeId, agentNodeIds: Set<string>): boolean
//  roleKind==='designer' && agentNodeIds.has(targetNodeId)
//  agentNodeIds = 工作流里 kind 为 agent（single/multi）的节点 id 集合——
//  **排除** input/output/review/clarify/cross-clarify/git/loop 等非 agent / wrapper 节点
//  （它们无可跑 prompt / 无产出契约，改派过去必 runtime 失败）。
```

`hasOutput` 由调用方按 `node_run_outputs` 行数预言（与 `runner.ts:1346` 的「有输出行=成功产出」同口径）。`agentNodeIds` 由调用方按任务冻结快照的节点 kind 过滤（`NODE_KIND_BEHAVIORS` / `kind==='agent'`）。

### 2.3 服务层 `services/taskQuestions.ts`

- `reconcileTaskQuestionsForRound(db, originNodeRunId, deps)`：读该轮 + scopes + 冻结工作流图解析角色节点 → `reconcileDesiredEntries` → upsert（按唯一键；**已存在的条目只补 default/快照、保留 confirmation/override/审计**——幂等）。在三处被调用（§3）。
- `resolveHandlerRun(entry, runs)`（**精确 lineage，Codex F1——非裸 `id≥anchor`**）：在 `runs` 里筛 `nodeId === 有效承接节点 && iteration === entry.iteration && loopIter === entry.loop_iter`；以 `entry.trigger_run_id` 为下界、以**下一条 clarify-cause rerun**（id> anchor 且 `rerun_cause ∈ {clarify-answer, cross-clarify-answer, cross-clarify-questioner-rerun}`）的 id 为**上界**（默认 +∞）框出本条目的承接 lineage（= 该 trigger run + 其 process-retry/级联子代，**排除**后续不相关反问轮在同节点的新 rerun）；窗内取 freshest（`pickFreshestRun`）。承接节点为多进程（fanout）时取 parent run + 聚合子 run 终态（全子 done→done）。`trigger_run_id` 为 NULL→未派发→null。
- `listTaskQuestions(db, taskId)`：取条目 + 原轮 status + 各有效承接节点 runs，逐条 `resolveHandlerRun`→`deriveQuestionPhase` 组装 DTO（含答复摘要、跳转用 origin nodeRunId、effectiveTargetNodeId、可改派候选 agent 节点列表、失效节点标注）。条目数 = Σ(轮问题数×角色) 有限，读时计算无虑。
- `confirmTaskQuestion(db, entryId, actor)`：CAS `confirmation open→confirmed`（仅当派生态 `awaiting_confirm`）；写 confirmed_by/role/at；纯收尾。
- `reassignTaskQuestion(db, entryId, targetNodeId, actor)`：`canReassign(entry, targetNodeId, agentNodeIds)` 守卫（agentNodeIds 取任务冻结快照 agent 节点）→写 `override_target_node_id`+审计。**仅改下次/本次承接目标**，不立即重跑（重跑在回答/打回时发生）。
- `reopenTaskQuestion(db, entryId, {editedAnswer, newOverrideTargetNodeId?}, actor)`（打回，**就地改答轻量版，Codex F2**）：见 §3.3。

### 2.4 改派注入：以**条目**为单位渲染反馈与消费（Codex F3）

`triggerDesignerRerun`（`crossClarify.ts:772`）/ `buildExternalFeedbackContext`（`:1089`）今天**以 session(轮) 为单位**——硬解析图设计者、把该 session 的全部 designer-scoped 子集聚合渲染、按 session 打消费/触发戳。**per-question 改派必须把这套下沉到「条目」粒度**，否则一题改派会污染同轮另一题（F3 的核心风险：session 级消费戳误抑、session 级 prompt builder 把 Q2 漏进 Q1 的 override run）。契约：

- **目标解析（per 条目）**：`effectiveTargetNodeId = entry.override ?? findDesignerNodeForCrossClarify(...)`。
- **反馈渲染（per 条目，不再 per session）**：override 命中的条目，其承接节点只收到**该条目对应问题**的 External Feedback 块（`buildExternalFeedbackBlock` 输入收窄到 `{thisQuestion, thisAnswer}`，**不**含同轮其他题）；默认设计者批次的 `buildExternalFeedbackContext` **排除所有已改派题**（按 `task_questions.override IS NOT NULL` 过滤后再聚合），保证 Q2 不漏进 Q1 的 override run、也不在默认批次里重复。
- **批处理就绪（per 条目剔除）**：默认设计者批次 `evaluateDesignerRerunReadiness` / `countDesignerScopedAcrossSources` 把**已改派题**从 designer-scoped 计数里剔除；override 题**单独 mint** 一条 rerun（`cause='cross-clarify-answer'`、`runtime` 冻结同设计者路径）、不参与就绪等待。
- **消费/触发戳（per 条目，不再 per session）**：`trigger_run_id` stamp 到**具体条目**（不是 session 级 `consumed_by_*`）；override 题的单独 rerun 只 stamp 它自己的条目；默认批次的设计者 rerun stamp 它聚合的那批默认条目。session 级 `consumed_by_consumer_run_id`/aging 仍服务既有反问 prompt 续跑（不被本 RFC 改写），但**条目派生态只读 `task_questions.trigger_run_id` + node_run**，与 session 消费戳解耦——避免一题改派的消费误伤另一题。
- **反问者条目零改动**：永远自我续跑，不受任何改派影响（改派只对 designer 角色）。

> 落地顺序硬约束：**先**把 designer 反馈/批处理改成读 `task_questions`（条目过滤），**再**接 override——否则 override 与 session 聚合并存期窗口会 cross-contaminate（测试须含「Q1 改派 + Q2 默认」同轮正反例）。

### 2.5 路由 `routes/taskQuestions.ts`（或并入 `routes/tasks.ts`）

全部经 `requireTaskMember` + 任务可见性中间件：

- `GET /api/tasks/:id/questions` → `listTaskQuestions`（支持 `?phase=` 过滤，服务端派生后过滤）。
- `POST /api/tasks/:id/questions/:entryId/confirm` → `confirmTaskQuestion`（非 `awaiting_confirm`→409）。
- `POST /api/tasks/:id/questions/:entryId/reassign` `{targetNodeId}` → `reassignTaskQuestion`（非 designer / 非工作流节点→422）。
- `POST /api/tasks/:id/questions/:entryId/reopen` → `reopenTaskQuestion`，返回 `{ reanswerNodeRunId }` 供前端跳 `/clarify/$id`（非 `awaiting_confirm`→409）。

## 3. 数据流

### 3.1 新反问 → 收录

`createClarifySession`/`createCrossClarifySession`（`clarify.ts:128`/`crossClarify.ts:185`）成功后 → `reconcileTaskQuestionsForRound`。此刻 cross 无 scopes → 仅出 questioner 条目（+ self 出 self 条目），均 `trigger_run_id=NULL` → 派生 `待处理`。

### 3.2 回答 → 派生推进 + 补 designer 条目

`submitClarifyAnswers`/`submitCrossClarifyAnswers`（`clarify.ts:335`/`crossClarify.ts:362`）在 mint 承接 rerun 后：① 把 rerun id stamp 进对应条目 `trigger_run_id`（self→提问节点 rerun；questioner→反问者 rerun）；② cross 按提交 scopes 重 `reconcile` 补出 designer 条目（默认承接=图设计者，`trigger_run_id` 待 `triggerDesignerRerun` 实际 mint 时回填——批处理可能延后到兄弟源齐备）。承接 rerun `running`→派生 `处理中`；`done`+输出→`已处理待确认`。**派生纯读 node_run，无需在调度热路径插钩子**（仅 mint 点 stamp `trigger_run_id` 一次）。

### 3.3 打回（reopen，就地改答轻量版，决策 D5 / Codex F2）

放弃「append-only 再答轮」（其 submit 路由 / 与 legacy session 表 dual-write / 单条目定位的契约都未定、风险高）。改为**就地改答 + 只 re-fire 本条目承接**——一个端点原子完成，**不开新 clarify 轮、不动 legacy session 表的 submit 路径**：

`已处理待确认` → `POST .../reopen {editedAnswer, newOverrideTargetNodeId?}`（同事务）：
1. 校验条目派生态 `awaiting_confirm`（否则 409）；`canReassign` 校验 newOverrideTarget（仅 designer）。
2. 把原答案存入 `prior_answer_snapshot_json`（审计「解冻前」），再就地改写 `clarify_rounds.answers_json[questionId]` = `editedAnswer`（重新 seal 这一题、`sealAnswersServerSide` 同口径防注入）；**只改这一题、不 re-park 整轮、不扰兄弟条目**（轮仍 `answered`）。
3. designer 条目可同时写 `override_target_node_id = newOverrideTarget`。
4. **只 re-fire 本条目有效承接节点**：mint 一条 fresh rerun（self→提问节点 / designer→effectiveTarget；`cause` 同各自原 cause），把「问题 + editedAnswer」按 §2.4 的**条目级**反馈注入；**绝不重跑兄弟反问者**（它早已续跑、不在打回范围）。
5. 条目 `confirmation→open`、`trigger_run_id→新 re-fire run`、`reopen_count++`。

CAS：以 `confirmation` + `trigger_run_id` 做乐观锁，保证并发打回恰一胜、re-fire 不重复 mint。派生态自然流转：re-fire run pending→`待处理`、running→`处理中`、done→`已处理待确认`。**UI 不跳 `/clarify`**——问题清单内弹 `Dialog` + 复用 `QuestionForm`（初值=当前答案）就地改，提交即 `POST reopen`。

> 取舍：就地改 `answers_json` 会让该题历史答案前移到编辑值（兄弟反问者早已消费旧值、不回放）——这是「解冻原答案再改」的字面落地；原值留 `prior_answer_snapshot_json` 可审计。比起「再答轮」省掉一整套轮/session 路由，且天然「只影响本条目」。

## 4. 数据模型变更

- migration `0060_rfc120_task_questions.sql`：`CREATE TABLE task_questions(...)`（多语句须 `--> statement-breakpoint`，CREATE TABLE 单起一行——见 [reference_migration_statement_breakpoint]）+ 索引 `(task_id)`、`UNIQUE(origin_node_run_id,question_id,role_kind)`。
- **回填**（Codex F4——**从既有消费戳解析、不靠 cause+节点+iteration 猜**）：遍历全部 `clarify_rounds` 调 `reconcileTaskQuestionsForRound` 建条目；`trigger_run_id` 优先取**既有持久消费戳**——questioner 条目读 `consumed_by_questioner_run_id`、self 条目读 `consumed_by_consumer_run_id`、designer 条目读 `designer_run_triggered_at` 对应的设计者 rerun（`cross_clarify_sessions`/`clarify_rounds` 上的 RFC-070 aging 戳是「哪个 run 消费了这一轮」的权威链）。**戳缺失 / 不可唯一证明**（如多源设计者批处理无法定位单题、老库无戳）→ `trigger_run_id` 留 NULL、派生**保守态**（轮 answered 但无可证承接 → `处理中`「执行态未知」而非乐观判 `已处理待确认`；轮 canceled/abandoned → `已关闭`）。回填幂等（唯一键），可重跑。fixtures 须覆盖：同节点多次 self 轮、多源设计者批、failed/pending 承接、canceled/abandoned 关闭行、戳缺失的歧义行。
- `schema.ts` 加 `taskQuestions` 表定义；`_journal.json` +1；`upgrade-rolling.test.ts` journal 断言 +1；binary smoke 验 0060 嵌入、无模块环（见 [reference_binary_build_module_cycle]）。
- **无新增 shared 导出环**：纯函数置 `packages/shared/src/task-questions.ts`，被 backend service + frontend 复用。

## 5. 与现有模块的耦合点

- `services/clarify.ts` / `services/crossClarify.ts`：create/submit 后加 reconcile + `trigger_run_id` stamp（加性、不改既有反问语义）；`triggerDesignerRerun`/`buildExternalFeedbackContext` 接受 override 目标（向后兼容，override 空 = 原行为字节不变，黄金回归锁）。
- `services/scheduler.ts`：**不碰**。派生态纯读 node_run，调度热路径零侵入。
- RFC-099 ACL：复用 `requireTaskMember`/任务可见性；新审计字段（confirmed_by/reassigned_by）同受 prompt-isolation 约束。
- RFC-108 lifecycle / RFC-109 sync：task 状态机不动；工作流 sync 改图后，条目的 `default_target_node_id`/override 可能指向已删节点——`listTaskQuestions` 对失效节点降级显示（标注「节点已不在当前工作流」），改派/打回时校验目标节点仍存在（否则 422/409）。
- 前端 `lib/task-detail-tabs.ts` + `tasks.detail.tsx` + i18n（zh-CN 类型字面 + 值、en-US 值，parity 测试锁）。

## 6. 失败模式

- **图解析不到承接节点**（边缺失/工作流畸形）：`default_target_node_id=NULL` → 条目仍收录、派生 `待处理`、改派/打回前端提示「无默认承接节点，请改派」（仅 designer 可救；阻塞-产出型无解则标错误态）。
- **改派目标非 agent / 被 RFC-109 sync 删除**（F5）：`canReassign` 的 `agentNodeIds` 取**任务当前冻结快照里 kind=agent 的节点**；指向 io/review/clarify/wrapper 或已删节点均命中失败→422。
- **派生 lineage 越界**（F1）：`resolveHandlerRun` 以「下一条 clarify-cause rerun」为上界框窗，**后续不相关反问轮在同节点的新 rerun 不会把本条目从 `awaiting_confirm` 误拉回 `处理中`**；fanout 承接取 parent + 子聚合，shard 子 run 不被 topLevel 过滤误删——测试含「同节点后续新轮」「fanout 承接」两类反例。
- **打回就地改答并发**：以 `confirmation`+`trigger_run_id` 乐观锁，原轮恒 `answered`、只改 `answers_json` 单题，并发打回恰一胜、re-fire 不重复 mint；兄弟反问者条目零扰动。
- **多源 designer 批处理 vs 改派**（F3）：反馈渲染 / 就绪 / 消费戳全下沉到**条目**粒度——override 题单独 mint 且只收自身问题反馈、默认批次按 `override IS NOT NULL` 剔除已改派题；同轮「Q1 改派 + Q2 默认」不交叉污染——测试正反例锁。**落地先改 session→条目过滤、再接 override**。
- **承接 rerun 失败**：派生 `处理中`（D3），不阻塞清单；UI 可在「处理中」内显失败子标记（红点 + 错误摘要），但不单立态、不自动打回。
- **条目与轮的 race**：reconcile 幂等（唯一键 upsert）；create 与首次 submit 间隔内 list 调用只见 questioner/self 条目，designer 条目答后才现——符合预期（未定 scope 前 designer 承接未知）。
- **task 删除**：FK 级联删 `task_questions`。

## 7. 测试策略（先红后绿）

**纯函数（shared，首选断言面）**
- `task-questions-reconcile.test.ts`：self→1 self 条目；cross 无 scope→仅 questioner；cross designer-scope→questioner+designer；幂等（重跑不增不改、保 override/confirmation）；scope 改变（designer→questioner）下 reconcile 收敛。
- `task-questions-phase.test.ts`：`deriveQuestionPhase` 全分支——canceled/abandoned→closed、confirmed→done、null/pending(startedAt null)→pending、running→processing、**failed→processing**（D3 回归锁）、done+output→awaiting_confirm、done 无 output→processing 兜底。
- `task-questions-reassign.test.ts`：`canReassign` 仅 designer + 工作流节点。

**服务（backend）**
- `rfc120-collect.test.ts`：create/submit 后条目收录、`trigger_run_id` stamp、designer 条目按 scope 补出。
- `rfc120-reassign-rerun.test.ts`：改派 designer→override 节点重跑、注入「问题+答案」、级联下游；绕过批处理；未改派题批处理仍成立（正反例）；阻塞-产出型改派 422。
- `rfc120-confirm-reopen.test.ts`：confirm 仅 awaiting_confirm、并发 CAS；reopen 开再答轮、active 前移、只重激本条目不扰兄弟、再答提交重跑。
- `rfc120-backfill.test.ts`：存量轮回填条目、状态按真实执行态派生、幂等可重跑。
- `rfc120-prompt-isolation.test.ts`（**双层锁，仿 rfc099**）：承接 rerun `promptText` 永不含 confirmed_by/reassigned_by/角色快照；源码层断言 prompt 构造不读这些字段。
- `rfc120-route-acl.test.ts`：非成员/不可见任务 404/403；confirm/reassign/reopen 非法态错误码。

**前端（vitest）**
- 页签显隐 + 表格渲染（`findByRole`）、状态 `StatusChip`、改派 `Select`（仅 designer 行可选）、确认 `ConfirmButton`、打回跳转 mutation；源码层断言无原生 modal/原生 select chrome；i18n parity。
- e2e（Playwright）：launch 带 cross-clarify 的工作流 → 回答 → 清单见条目 → 改派 designer 条目到另一节点 → 该节点重跑 → 确认关闭。

## 8. 已知限制（v1）

- 改派仅修订型（设计者域）；self / 反问者**永不可改派**（结构死锁）——按设计而非缺陷。
- 改派目标限**本任务工作流已有节点**；不支持图外任意 agent / 临时执行原语（用户明确）。
- 打回采 append-only 再答轮，原答案保留为初值；非「物理改写原行」（保审计；与「解冻」语义观感一致）。
- 派生态 best-effort 依赖 node_run 真实性；承接 rerun 被 GC / 跨任务异常时降级显示。
- 不做改派目标胜任度校验 / 推荐；由人判断。
- 失败的承接 rerun 留「处理中」，无自动打回 / 自动重派（沿用既有重试机制）。

## 9. 反问澄清记录（2026-06-28，落码前 4 轮）

- **轮1**：收录=全量自动（叠加层概念，后撤）；失败=保持处理中（4 态不增）；确认=纯关闭+可打回；历史=按真实执行态派生。
- **轮2**：撤销「重点/优先级标记」（用户「我什么时候要求标记重点了」——原话「标记进清单」指**收录**本身，既已全量自动则**无标记动作**）；打回=解冻原答案再改。
- **轮3（核心反转）**：用户澄清「任务中心目标=让问题的最终修改方灵活化」——① 取代式（非叠加）；② 限本工作流用到的 agent；③ 被选中节点触发重跑、和反问流程一致。
- **轮4**：仅**修订型**可取代（阻塞-产出型取代会死锁，照常自我继续）；被指定节点重跑=注入问题+答案、照常级联下游。

## 10. Codex 设计 gate fold（2026-06-28，落码前）

Codex adversarial 设计 gate（聚焦本三件套、显式忽略并发 RFC-119 工作树代码）= **needs-attention，6 findings（4 high + 2 medium）全采纳**：

- **F1 [high] 派生 lineage 不精确**（design.md:95-97 原文）：`freshest≥anchor` 会被同节点后续不相关 rerun 拉走、被 fanout 子 run 的 topLevel 过滤误删 → 错误生命周期态、误阻确认/打回。**Fold**：`resolveHandlerRun` 改为精确 lineage——按 `节点+iteration+loopIter`、以「下一条 clarify-cause rerun」为上界框窗、fanout 取 parent+子聚合（§2.2/§2.3/§6）；条目加 `iteration`/`loop_iter` 列（§2.1）。
- **F2 [high] 打回再答轮链路未定义**（design.md:130-134）：`reopen_of_entry_id` 落库位置 / submit 路由 / legacy dual-write / 单条目定位 / CAS 均缺。**Fold**：**放弃再答轮**，改「就地改答 + 只 re-fire 本条目承接」单端点（§3.3）；删 `active_node_run_id`、加 `prior_answer_snapshot_json`（§2.1）；不动 legacy session submit。
- **F3 [high] 改派与轮级批处理/消费不兼容**（design.md:104-108）：session 级消费戳/prompt builder 会让同轮「Q1 改派 + Q2 默认」互相抑制 / 泄漏。**Fold**：反馈渲染 / 就绪 / 消费戳 / trigger 全下沉**条目**粒度；override 题单独 mint 且只收自身问题反馈、默认批次按 `override IS NOT NULL` 剔除；**先改 session→条目过滤再接 override**（§2.4）。
- **F4 [high] 历史回填 trigger_run_id 不可证**（design.md:140-142）：cause+节点+iteration 猜测会把老条目指向新 run。**Fold**：改从既有消费戳（`consumed_by_questioner_run_id`/`consumed_by_consumer_run_id`/`designer_run_triggered_at`）解析；不可唯一证明 → NULL + 保守态；补 5 类 fixtures（§4）。
- **F5 [medium] 改派守卫接受非 agent 节点**（design.md:86-89）：io/review/clarify/wrapper 无 prompt/产出契约。**Fold**：`canReassign` 收窄到 `kind=agent` 节点集合（§2.2/§6）。
- **F6 [medium] plan 缺 RFC-119 协调栅栏**（plan.md:44-55）：并发 RFC-119 改 `shared/clarify.ts`（`CROSS_CLARIFY_*` 改名 + `composePriorOutputBlock`）、与 RFC-120 PR-B 要扩展的 `triggerDesignerRerun`/`buildExternalFeedbackContext` 同面。**Fold**：plan.md 风险段加显式栅栏——PR-A（新文件+schema，零 cross-clarify 改动）独立先行；**PR-B 在 RFC-119 合并后 rebase / 按落码当时真实符号名编码**，prompt-isolation 源码 grep 对齐改名后路径。

> 第二轮 Codex 复核留实现期（实现 gate，§见 plan 验收清单）。本轮的「native code review」误命中并发 RFC-119 代码（非本 RFC）已忽略、不代修。

## 11. 任务中心 v2 — 看板 / 任务状态联动 / 两并存处理面（2026-06-28 设计讨论收敛）

> 本节是落码前与用户多轮设计讨论的收敛结论，**升级**了 §1–§8 把问题清单当「纯观察层」的早期设定：问题清单从被动台账升级为**主动的问题处理面（看板）**、并与任务生命周期联动。冲突处**以本节为准**。

### 11.1 为什么需要 gate（不再是纯观察）

「灵活指定修改方」要真能用，就必须有个**停顿窗口**让人在 handler 自动跑掉之前介入选择——否则图默认 handler 一被答题触发就抢跑、改派来不及。所以"还没决定/还没下发"的问题必须**把任务 hold 住**。又因为提问节点（self 提问节点 / cross 反问者）是「阻塞-产出型」（用提问代替了产出、下游在等它），只要它的问题没下发，任务**本就过不去**——这是真实的「等人」。

### 11.2 任务状态联动（gate，决策 D10）

- **复用 `awaiting_human`、不新开状态**：反问页 / 公共收件箱 / 问题看板都是同一个 `awaiting_human` 的不同 UI（用户洞察："状态只有一个，UI 可以有多张"）。新开状态要牵动 RFC-097 转移表 / RFC-108 恢复 / `TaskStatusChip` / i18n 一整圈，性价比低。
- **gate 条件**：只要还有问题处于 `待指派` 或 `待下发`（=**未下发**），任务停 `awaiting_human`。
- **放行点 = 下发（model A）**：「下发 = mint handler rerun」。反问页提交 / 看板批量下发都是下发动作，把问题推进 `处理中`、任务转 `running`。
- **确认非 gate（D5 保留）**：`已处理待确认 → 完成` 仍是事后台账、不二次挡下游；结果不满意走打回重跑。
- 结构边角：cross 反问者续跑只要答案、答完即可推进它那条 branch；真正被挂起的是设计者/修改方那条。任务可能"反问者已推进、设计者还 hold"的混合态，对外仍统一显示 `awaiting_human`。

### 11.3 问题看板（v1-A，决策 D11）

- **列**：`待指派 → 待下发 → 处理中 → 已处理待确认 → 完成`（+ `已关闭`）。multica 式问题流转看板是北极星。
- **卡片正面**：标 **来源节点**（谁提的）+ **目标处理节点**（谁来修）。
- **交互**：`待指派`（handler 未定/待答）→ 卡片详情答题 + 指定处理节点 → **拖到 `待下发`**（暂存·已批准未下发）→ 攒一批点 **批量提交执行** → 一起下发、转 `处理中`。
- **v1-A 边界**：看板雏形 + **复用现有 `QuestionForm`**（嵌卡片详情 Dialog）；全局跨任务看板 / 退役 `/clarify` / 拖拽流转留 **Phase 2**。

### 11.4 两并存处理面（决策 D11）

反问页与问题看板是**两个对等版本的处理面、同一套后端状态**：
- **反问页（`/clarify`，复用不重写）**：答题 → 确认 → 提交 → 该节点这批问题（默认 handler）**立即下发**。快路径、行为不变。
- **看板（新）**：跨任务看全部问题；**指定 agent（改派）+ 答题 → 拖 `待下发` → 批量下发**。控制路径。
- 两面动同一批 `task_questions`/`clarify_rounds`、最终都走同一个「下发」。**反问页现有自动下发不改**（避开 RFC-119 后端），看板只**新增**「答而不立即下发 + 暂存 + 批量下发 + 改派」路径——**加性、低风险**。

### 11.5 handler 单一事实源 + 两面对等选择器（决策 D12）

- **唯一事实源 = `task_questions.override_target_node_id`**；**有效 handler = `override ?? 默认（线上连着的图 agent）`**。
- **两面对等**：反问页**每个问题也挂一个和看板同款的处理 agent 选择器**（不是只读回显）；两边都只对**可改派的 designer/修订型**问题开放选择、对 self/反问者固定只读（与 F5 一致）。
- 实现：抽一个**共享 handler 选择器组件**，反问页（`clarify.detail.tsx`，纯前端）+ 看板卡都用它、都调 RFC-120 `reassign` 端点 → 写同一 `override`。**不动 clarify 后端**。改派后两面都显示最新 handler。

### 11.6 数据模型 / 状态机 delta（对已提交 PR-A 的小扩展）

- `task_questions` 加 **`待下发` 暂存**字段：`staged_at INTEGER` + `staged_by TEXT`（谁批准进待下发）。
- `TaskQuestionPhase` 枚举 **+1**：`'staged'`（待下发，已批准·未下发），夹在 `pending` 与 `processing` 之间。`deriveQuestionPhase` 增分支：`confirmation≠confirmed && handlerRun==null && staged_at!=null → 'staged'`（已批准但 trigger 还没 mint）。
- **新迁移 `0061`**（**不动已提交的 0060**，避免 shared `.git` amend 风险）。
- gate 判定：`待下发` = phase ∈ {`pending`, `staged`} 且 round 未取消（即"未下发"集合）。

### 11.7 实现影响（PR 调整）

- **PR-B（仍待 RFC-119 真正稳定落库）**：在「下发」backend 路径上加 ① `answer-without-immediate-dispatch`（看板路径）② `stage`（拖待下发）③ `batch-dispatch`（批量 mint handler rerun）④ task `awaiting_human` gate 联动（未下发即 hold、批量下发即放行）⑤ `reassign → override`。**反问页现有 submit-自动下发不变**（加性）。
- **PR-C**：问题看板（替代 §AC-14 的 table）+ **共享 handler 选择器**（反问页 + 看板卡）+ 反问页 handler 回显/可改 + 批量下发交互。
- **Phase 2（非 v1）**：全局跨任务看板（统一收件箱）、彻底退役 `/clarify`、multica 式拖拽流转。

> **实现状态（2026-06-28）**：
> - ✅ **已落地 + 全绿 + 已提交**（10 commit，本地领先 origin/main）：数据层（migration 0060/0061 + `task_questions` 表）+ shared 纯 oracle（reconcile/derive/canReassign/resolveHandlerRun，33 测）+ 读侧 service（lazy reconcile + 派生 + list，**全 read-time 派生、零碰 clarify/crossClarify**）+ 写侧（confirm/reassign/stage）+ 路由（`/api/tasks/:id/questions{,/confirm,/reassign,/stage}` + ACL）+ 前端看板页签（`TaskQuestionList`，列=phase、卡片标来源+目标、confirm/stage/reassign 接端点）+ i18n + api-contract 注册。backend 全量 4248 pass。
> - ✅ **D12 + D13 已落（15 commit）**：反问页 per-question handler 回显 + 选择器（`ClarifyQuestionHandler`，写同一 `override` 事实源、自包含·数据缺失即 null·不破 flaky clarify 页〔cross-clarify-scope-control 复跑 3/3 绿〕）+ 看板**来源节点过滤**（每来源节点一枚 chip 显待处理计数、点击收敛看板到该节点——交付 D13「节点级计数 + 点击查看该节点列表」功能于看板面）。各带组件测试。
> - 🔜 **唯一无冲突遗留（纯视觉占位）**：把 D13 的计数从看板 chip **搬到画布节点本体**（需 xyflow 自定义节点 CanvasNodeData 透传），功能已在看板交付、仅差画布位置。
> - ⛔ **RFC-119 门控（待其代码真正落库后做）**：派发执行半——批量下发 mint 承接 rerun、override 注入（推广 External Feedback 到任意节点）、`awaiting_human` gate（答非即时下发）、打回 re-fire。这些必须改 `crossClarify.ts`/`scheduler.ts`（当前被并发 RFC-119 未提交 WIP 占用，`d843036` 孤立）。**v1 现状**：reassign/stage 记录意图（override/staged 落库），执行仍走既有反问自动下发；override 暂"记录不执行"，待门控解除接入。

### 11.8 节点级待处理徽标（决策 D13）

- 任务详情画布（`TaskStatusCanvas`/`WorkflowCanvas` readOnly）上每个节点标一个**待处理问题数徽标**——计数 = 以该节点为**来源节点**、且**需人处理**的问题（phase ∈ `待指派`/`待下发`/`已处理待确认`；具体集合可在实现时收口）。
- **点徽标数字 → 打开问题看板/列表，过滤条件 = 该来源节点**（复用同一看板界面，仅给筛选加一个 **source-node 维度**，可与 phase 过滤叠加）。
- 数据来自 `GET /api/tasks/:id/questions`（按 source node 分组计数；列表/看板支持 `?sourceNodeId=` 过滤）；画布徽标复用既有节点渲染 + 角标，点击 `navigate` 到看板 tab 并预置 source-node 过滤。**纯前端 + 复用**，归 **PR-C**。

## 12. Codex 实现 gate fold（2026-06-28，落码后）

实现核心后经 Codex adversarial 实现 gate（聚焦本 RFC committed diff、忽略并发 RFC-119 工作树代码）= **needs-attention，4 findings（3 high + 1 medium）全采纳并修复（commit `78bb888`）**：

- **F1 [high] in-flight 条目绑到「freshest later rerun」而非自己的下发**：消费戳为 NULL 时旧实现按 cause+节点+iteration 取 freshest，多轮同节点会把老条目绑到**后一轮**的 rerun。**Fold**：`resolveTriggerForEntry` 只认 RFC-070 消费戳 id（不猜）；答而无戳=in-flight → `deriveQuestionPhase` 新增 `dispatchedInFlight` 分支判「处理中」（不绑具体 run）。
- **F2 [high] fanout 子 run 被 top-level 过滤丢掉**：承接 rerun 可能是 `parentNodeRunId` 非空的子行（含产出），旧 `resolveHandlerRun` 只留 top-level → 返回 null → 误判 pending。**Fold**：service 改按**消费戳 id 直取**承接 run（含子行），不再走 `resolveHandlerRun` 的 top-level 窗口（该纯函数保留为「未来 stamped-dispatch」oracle）。
- **F3 [high] reassign 可改派已下发/终态条目、破坏 lineage**：旧 reassign 只校验 role/节点、不看 phase。**Fold**：`reassignTaskQuestion` 拒 `done`/`closed` 终态（`task-question-terminal` 409）；前端终态卡隐藏改派 `Select`。
- **F4 [medium] 看板不随 node/clarify 事件刷新**：`['task-questions']` 未接 `useTaskSync`。**Fold**：`node.status` + `clarify.created/answered` 失效 `['task-questions', taskId]`，看板实时刷新。

回归：+3 backend（in-flight 不绑后轮 / fanout 子 run 承接 / reassign 拒终态）+ 2 phase 测；30 测全绿、typecheck×3/eslint/format 净。

## 13. PR-B 派发执行半 — RFC-119 落库后实现计划（2026-06-28）

RFC-119 已落库（HEAD `880dc4a`，代码 `4656fba` 单进程 + `f249855` 多进程聚合；`crossClarify.ts`/`scheduler.ts`/`runner.ts`/`shared/clarify.ts` 均干净）。F6 fence 条件满足，PR-B 解锁。

**已确认的流与键（前置调研，file:line）**：
- 双写两表同一 run id：`createCrossClarifySession` 把 `crossClarifyNodeRunId` 同时写入 `cross_clarify_sessions.crossClarifyNodeRunId`（dispatch 读）**和** `clarify_rounds.intermediaryNodeRunId`（reconcile 读）。⟹ **`task_questions.originNodeRunId === cross_clarify_sessions.crossClarifyNodeRunId`**，override 读可由 session 直接定位 task_questions。
- 派发链：`submitCrossClarifyAnswers`（crossClarify.ts:584 触发 `triggerDesignerRerun(designerNodeId=row.targetDesignerNodeId)`）→ 调度期 `buildExternalFeedbackContext(designerNodeId=node.id)`（:1089，按**图** `findCrossClarifyNodesPointingToDesigner` 找 sibling）→ done 时 `markClarifyRoundsConsumedBy`（clarifyRounds.ts:146，按 `targetDesignerNodeId==run.nodeId` 盖消费戳）。
- 消费戳 + 调度 dispatch 已是 **node-id 灵活**（盖谁/派谁都按实际 node.id）；唯两处**图查找**把承接钉死在图设计者。

**T7 改点（4 处，全部「golden-lock」结构——无 override 即逐字同原行为，保护现有 4248 测）**：
1. **override 读** helper（crossClarify.ts）：`resolveDesignerOverrides(db, crossClarifyNodeRunId)` → `Map<questionId, overrideNodeId>`（查 `task_questions` `roleKind='designer'` 且 `overrideTargetNodeId!=null`）。给 `DesignerRerunReadinessSource` 加 `crossClarifyNodeRunId` 字段（readiness 构造 source 时从 session 行带出）。
2. **submit 分组重跑**（crossClarify.ts:584）：用 `partitionDesignerQuestionsByTarget`（已落 oracle）把本批 designer 域问题按有效承接分组 → **逐有效目标** `triggerDesignerRerun`。默认目标（=图设计者、无 override）= 原单次调用。`readiness` **不动**（它定 sibling 是否齐、给 sources；override 只改「派给谁重跑」不改 source 集）。
3. **`buildExternalFeedbackContext` override 感知**（crossClarify.ts:1089）：候选 session = `targetDesignerNodeId==dispatchedNode`（原图路径）∪「有 designer 域问题 override 到 dispatchedNode 的 session」（新 DB 查 task_questions）；每个 session 内**只纳入有效承接==dispatchedNode 的问题**（被 override 走的从图设计者反馈里剔除）。无 override → 候选集 == 原图路径、逐字一致。
4. **消费戳 override 感知**（clarifyRounds.ts:146）：`markClarifyRoundsConsumedBy` 的 `targetDesignerNodeId==run.nodeId` 过滤补上「OR 该 session 有 designer 域问题 override 到 run.nodeId」，让 override 节点重跑 done 也能盖戳老化 session。

**测试（design §测试策略 + plan T7）**：`rfc120-reassign-rerun.test.ts` —— ① override 空 = 原行为黄金锁；② 同轮 Q1 改派 X + Q2 默认 Y → 两 rerun 不交叉污染（X 反馈无 Q2）；③ override 重跑 + 注入 + 级联下游；④ 未改派题批处理仍成立。**纪律**：每改一处跑全 cross-clarify 套（数百测）当护栏，红即回退该步。

**纯核心已交付**：`partitionDesignerQuestionsByTarget` + `isOverrideTarget`（commit 已上，8 测）。**T8（打回 reopen）/ T9（批量下发 + `awaiting_human` gate）在 T7 之后**，按 §11.7 / plan PR-B。

### 13.1 修正 — at-submit T7 经 Codex 实现 gate 判定**架构错位、已 revert**（2026-06-28）

§13 上面的「submit 分组重跑」做法（commit `ff5e1c8`，已 `git reset --hard` 回退、reflog 可取）经 Codex adversarial 实现 gate = **needs-attention，3 high，no-ship**：

- **F1（根因·致命）**：designer `task_questions` 条目**只在轮 `answered` 后由 reconcile 生成**（`reconcileDesiredEntries` 仅 `roundAnswered=true` 出 designer 条目），`reassign` 只改**既有**条目。⟹ **submit（=答的那一刻）时根本不存在 override 行**，at-submit 分组恒读到空 → 永远只 mint 图设计者。override 本质是**答后**的人工决策，at-submit 路径**结构上无法**承载它。更糟：若答后 reassign，graph run 已 mint、`buildExternalFeedbackContext` 后续按新 override 把该题从图设计者批次剔除、却**无 override run** → 该题被丢。
- **F2**：CP4 session 级消费戳——同会话 Q1→X + Q2→图设计者，谁先 done 就把**整会话**盖 consumed，饿死另一目标；且 `listTaskQuestions` 把这唯一戳当**所有** designer 条目的权威承接 run → 误归属。须 **per-(题×有效目标) 消费戳**。
- **F3**：`triggerDesignerRerun` 要求目标有既往 node_run；reassign 守卫放行任意 agent 节点（含尚未跑过的下游）→ override 到无既往 run 的节点会**抛错**，而 submit 已持久化答案 + cross-clarify 节点已 done → 用户卡死。须「答前校验目标可跑」或「dispatch 安全 mint 首跑」。

**正确架构（T9，本应如此）**：override 执行 = **答后 `reassign` → 显式批量下发**（model A 的延迟下发），**不是** at-submit 自动下发。难点「supersede 语义」：图设计者在答时已 mint 处理**全部** designer 问题；事后把某题改派给 X，需让 X 的 run **接管/取代**图设计者对该题的处理（图设计者已做的部分如何作废/共存）。这是 PR-B 真正的核心难度，需独立设计（建议先补一轮设计反问 + Codex 设计 gate 再编码）。

**仍有效的复用件**：纯 oracle `partitionDesignerQuestionsByTarget`（正确）；`buildExternalFeedbackContext` 的 override 感知 + per-target 消费 + 闸门放宽逻辑（在 `ff5e1c8` reflog 可取，待 T9 以正确触发点重新接入）。**教训**：写派发执行前应先确认 override 在生命周期中**何时存在**——这条 reconcile-post-answer 的时序本可在编码前的设计反问里问出来。

## 14. T9 — model A 延迟下发 + override 执行（设计，2026-06-28；用户拍板「延迟下发/干净分区」）

用户已定 supersede 语义 = **延迟下发、干净分区、零重做**（§11 model A）。这是 override 执行的**正确触发点**——批量下发发生在「答 → 改派」**之后**，override 此刻已存在（解 F1）；每题只派给其有效目标（解 F2 的交叉与误归属）；批量下发前校验目标可跑（解 F3）。

### 14.1 生命周期（designer 域 cross-clarify 问题）
1. **答（不立即下发）**：cross-clarify submit 记录 `answersJson` + 轮 `answered`，但对**含 ≥1 designer 域问题**的轮**不触发** designer rerun；任务停 `awaiting_human`（model A gate：有「待下发」问题即 park）。纯 questioner 域轮维持即时续跑（无 override 可能，不变）。
2. **看板/反问页管理**：问题进看板「待指派/待下发」；人工改派（override 落 `task_questions.override_target_node_id`）、`stage` 进「待下发」。
3. **批量下发**：人工点「批量下发」→ `dispatchTaskQuestions(taskId, entryIds)`：按有效承接 `override ?? 图设计者` 分组（`partitionDesignerQuestionsByTarget`），**逐目标** mint rerun（cause `cross-clarify-answer`）+ 该目标 Q&A 子集注入（复用 `ff5e1c8` 的 override-aware `buildExternalFeedbackContext` + scheduler 闸门放宽）。释放 gate（task → `running`）。

### 14.2 三个 Codex 发现的解法
- **F1（触发点）**：✅ 批量下发在改派之后，override 必存在。
- **F2（per-target 消费）**：弃用 session 级单戳。**每个 `task_questions` 条目带自己的承接 run + 消费**——条目的有效目标 rerun done+产出即「该条目」消费（非整 session）。`buildExternalFeedbackContext(目标 T)` 只纳入「有效目标==T 且其条目未被 T 消费」的题。这同时让读侧 `resolveTriggerForEntry` 从「session 级 stamp」升级为「条目级承接 run」（每条目解析到自己目标的 run，不再共享 session 戳）——更准且与 v2 看板每条目语义一致。
- **F3（无既往 run 目标）**：批量下发前对每个 override 目标校验「工作流里可跑」（有既往 node_run，或 DAG 可达可安全 mint 首跑）；`reassign` 守卫从「任意 agent 节点」收窄到「可跑 agent 节点」。答案持久化与各 mint 须在一个原子/幂等单元，部分失败可恢复。

### 14.3 待 Codex 设计 gate 复核的开放点
- **延迟范围**：designer 域轮**默认延迟**（override 需要）；这**改写**了 §13 时声称的「反问页 submit-自动下发不变」——designer 域的反问页 submit 也改成「记录答案 + 进待下发」，反问页与看板都给「下发」动作（即 §11「两并存处理面」）。纯 questioner 域不变。
- **gate 与 RFC-097 lifecycle CAS**：park/release 走 `setTaskStatus` 转移表，确认 `awaiting_human ↔ running` 合法且不与既有 review/clarify gate 抢。
- **条目级消费的回填**：历史 session 级 stamp 行如何与新条目级共存（读侧兼容）。

**实现顺序**：14 设计 →（本次教训）**Codex 设计 gate** → 编码（defer 机制 / `dispatchTaskQuestions` / 条目级消费 / F3 守卫 / 前端「批量下发」+ gate 回显）→ Codex 实现 gate → CI。**T8 打回**在 T9 之后（reopen 复用条目级承接 + 单题 re-fire）。
