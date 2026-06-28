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
