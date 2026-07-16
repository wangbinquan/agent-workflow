# RFC-202 任务生命周期出口与终态清场（design）

> 阅读顺序：先读 `proposal.md`。本文所有 file:line 锚点核对于 2026-07-16 工作树（commit `122a1eaa` 附近）；实现时如有 ±10 行漂移以符号为准。

## 0. 现状机制盘点（调研结论，设计的事实基础）

1. **空轮 park 是"半建成"的自动通过**：`dispatchReviewNode` 多文档分支在 `itemCount=0` 时铸 0 条 doc_versions 仍返回 `awaiting_review`（`review.ts:701, 749-761`，注释自述"approve emits an empty accepted"）；但 `submitReviewDecision` 对零 pending 行抛 409 `review-doc-version-missing`（`review.ts:2065-2070`），且空轮的评审模式无法从 doc 行反推（`resolveReviewRoundMode([])` 返回 `'single'`，`review.ts:1049-1056`）——自动通过必须发生在 **dispatch 时刻**（那里有上游端口 kind：`isMultiDocReviewInput`/`isInlineMarkdownListReviewInput`，`review.ts:486/508`）。`approveMultiDocReview`（`review.ts:1930-2025`）已容忍空子集：inline → `''` + `list<markdown>`，path → `''` + `list<path<md>>`，写 `accepted` + `approval_meta` 两端口、`transitionNodeRunStatus({approve-review})` → done。
2. **取消封存有现成模式**：`dismissOpenClarifyParksForAutonomous`（`workgroupLifecycle.ts:185-286`）在单个 `dbTxSync` 里封 clarify_sessions → node_run → clarify_rounds 三层，但只接在 workgroup 自治链路上，从未接进 `cancelTask`。`clarify_rounds` 已有 `canceled`/`abandoned` 终态与 `abandonedAt` 列；`clarifySeal.ts:172-177` 已把终态轮当 inert 处理。
3. **cancelTask 服务门窄于共享转移表**：`task.ts:1896-1901` 只放行 pending/running；`shared/src/lifecycle.ts:313-314` 的 cancel 事件 allowedFrom 含 awaiting_review/awaiting_human。前端 `cancelable` 判定与后端同窄（`tasks.detail.tsx:337`）。
4. **关停链路无 reason 通道**：`abortAllActiveTasks()`（`task.ts:123-127`）不带参数；调度器 abort 检查点（`scheduler.ts:592-594, 601-604, 629-632, 655-658`）统一走 `cancelTaskRow(db, taskId, failedNodeId?)`（`scheduler.ts:6094-6118`）硬编码 `'canceled by user'`。幸存者盖 `'daemon-shutdown'`（`shutdown.ts:42-53`），而 `autoResume.ts:61-70` 只认 `DAEMON_RESTART_ERROR_SUMMARY = 'daemon-restart'`（`shared/src/lifecycle.ts:224`）——优雅关停中断的任务**没有任何一类**会被 boot 自动恢复。
5. **待办口径不看任务状态**：clarify 实际生效的列表是 `listClarifyRoundSummaries`（`clarifyRounds.ts:169-190`，全表拉出内存过滤，不 join tasks）；review 是 `listReviewSummaries`（`review.ts:1133-1202`，pending 判定 = run `awaiting_review` && dv `pending`，`review.ts:1189`）。徽标三源（`InboxFooterButton.tsx:31-57`）与抽屉/首页预览全部只信这两个后端口径。`clarify.ts` 的 `listClarifySummaries` 已是死代码；admin 徽标分支 `countPendingClarifications`（`clarify.ts:384-390`）查的还是遗留 `clarify_sessions` 表（仅 self 轮）——与非 admin 分支（clarify_rounds，self+cross）口径不一致。
6. **终态无源头钩子**：`setTaskStatus`（`lifecycle.ts:264-360`）是唯一 allowlisted 状态写入器（s14 grep 守卫），刻意纯 CAS 无副作用；现状是 `task.ts:3012-3046` 用 `clarifyTaskDead` 在个别视图逐处压制孤儿（只盖 canceled/failed，不含收件箱）。
7. **修复弹窗**：`RepairResponse`（`shared/src/diagnose-repair.ts:114-123`）已有 `ok:false / outcome:'apply-failed' / outcomeMessage` 通道（`lifecycleRepair.ts:336-343`），前端 `RepairConfirmModal.tsx:48` 无条件 `onApplied(result)`。`ErrorBanner` 支持 `message?: string` 覆盖（`ErrorBanner.tsx:8-18`）。
8. **可恢复性约束（关键）**：`TERMINAL_TASK_STATUSES = ['done','failed','canceled','interrupted']`（`shared/src/lifecycle.ts:203-208`），但 resume 事件允许 from failed/interrupted/awaiting\_\*——**failed/interrupted 是可复活态**。对它们做不可逆封存会破坏恢复语义。

## 1. 设计总则

- **封存（不可逆）与过滤（可逆）分离**：open 反问/评审轮的硬封存只发生在不可复活的 `done`/`canceled`；`failed`/`interrupted` 任务的轮次靠**查询口径过滤**移出待办——任务一旦被 resume 回到非终态，轮次自动重新出现。这同时解决历史滞留数据（过滤对存量行立即生效，无需迁移）。
- **单一咽喉 + 注册解耦**：终态封存挂在 `setTaskStatus` CAS 成功之后，但为了不让底层 `lifecycle.ts` 反向依赖 clarify/review 服务（模块环 → binary smoke 风险），采用**回调注册**：`lifecycle.ts` 暴露 `registerTerminalTaskHook(fn)`，由 `cli/start.ts`（或 `startTaskDeps.ts`）在启动装配时注册实际的封存器。钩子失败只 `log.warn`，不影响状态转移本身。
- **200 = 动作全部生效**：凡"主动作成功、附带续跑失败"的路径，响应内必须带结构化的失败字段并由前端强制呈现（本 RFC 落 repair 弹窗与反问/评审提交两处）。

## 2. 各任务技术设计

### T1（P0）空列表评审轮 dispatch 时自动通过

**改动点**：`review.ts` `dispatchReviewNode` 多文档分支 `itemCount === 0` 时（`review.ts:749-761` 现 park 分支）：

1. 仍复用/铸 review node_run（保留审计痕迹），随后在同一流程内：
   - 按 dispatch 时刻的上游端口 kind 决定 accepted 的 wire 形状：inline → `('', 'list<markdown>')`，path → `('', 'list<path<md>>')`——直接复用 `approveMultiDocReview` 的空子集写法（`review.ts:1948-1966`）；
   - upsert `accepted` + `approval_meta` 到 `node_run_outputs`（复用 `review.ts:1991-2010` 的写入函数/形状；`approval_meta` 中加 `auto: 'empty-list'` 标记字段，**不含任何用户归属**——遵守 RFC-099 prompt 隔离）；
   - `transitionNodeRunStatus({ kind: 'approve-review' })` → done。【设计门修正】dispatch 返回的 summary 会被 runScope 丢弃、`node_runs` 也没有 summary 列——A1 的"可见审计记录"改为**落一条 `node_run_events` 事件**（kind `review-auto-approved`，detail 注明 `0 documents (empty list)`，节点抽屉「事件」页签可见）+ 依赖已持久化的 `approval_meta.auto='empty-list'` 标记；不再依赖 summary 字符串。
2. 返回值改为调度器"节点已完成"的分支形状（与 approve 后 resume 重入 dispatch 时的完成路径一致；实现时以 `dispatchReviewNode` 现有 union 返回类型中的完成变体为准），使调度器不再把任务翻 `awaiting_review`（`scheduler.ts:605-620` 不触发），直接续跑下游。
3. 下游兼容性：空 `accepted` 交给 fanout 时走"空列表 → 包装器瞬时完成"的既有行为（`scheduler.ts:4332`，审计 P3 已确认该路径存在且可用）；单消费方拿到空串继续，与人工"空子集通过"完全同语义。

**存量解卡**：已卡死的历史任务无需迁移——stuckTaskDetector S1 的两个修复选项本来就重入 `dispatchReviewNode`（调研确认），修复后重入即自动通过解卡。在 design 层面把这一点写进测试（构造 wedged 行 → 重入 dispatch → 任务续跑）。

**不改** `submitReviewDecision` 的零行 409 守卫（自动通过后空轮不再存在于 awaiting 态，守卫退化为防御性断言）。

### T2 awaiting\_\* 可取消 + 取消/终态封存

1. `cancelTask`（`task.ts:1891-1938`）allowedFrom 放宽为 `['pending','running','awaiting_review','awaiting_human']`（与共享转移表一致）：
   - awaiting\_\* 无活跃 AbortController → 直接走既有 CAS fallback 分支（`task.ts:1923-1934`），其 `allowedFrom` 同步放宽；`errorSummary` 维持 `'canceled by user'`。
   - 守卫拒绝文案：`task-not-cancelable` 保留（针对真正终态），中英词条更正为「该任务已处于终态（{status}），无法取消。」/ 对应英文（`zh-CN.ts:6151`、`en-US.ts:2950`）。
2. **封存器** `sealOpenHumanGatesForTask(db, taskId, cause, scope)`（新文件 `services/terminalSweep.ts`）：泛化 `dismissOpenClarifyParksForAutonomous` 的三层事务（`workgroupLifecycle.ts:185-286`），扩展到 review 侧。四条设计门修正一并落进规格：
   - **按 kind 分支封存 clarify 轮**：`kind='self'` → `clarify_rounds.status='canceled'`；`kind='cross'` **不能写 canceled**（migration 0031 的 `cross != canceled` CHECK 会回滚整个 sweep）→ 写 `abandoned` + `abandonedAt`，并同步封存 legacy `cross_clarify_sessions` 与 unified 两表；`clarify_sessions`(awaiting_human→canceled) 与 clarify node_runs 照旧。
   - review：review node_runs(awaiting_review→canceled, errorMessage=cause)；`doc_versions.decision` 保持 pending 不动（`listReviewSummaries` 的 pending 判定绑定 run 状态，run 离开 awaiting_review 即出列）。
   - **事务内同步转移原语**：`transitionNodeRunStatus` 是 async，进不了 `dbTxSync`（会被类型与运行时双拒；workgroup 封存器正因此用事务内同步 CAS）——新增 tx-aware 同步变体 `transitionNodeRunStatusInTx(tx, …)`（同一张共享转移表校验，仅执行器同步化），封存器全程走它；awaiting_review→canceled 如共享 node_run 转移表缺此边，单点补上并带注释。
   - **scope 参数**：`scope: 'all' | 'clarify-only'`。workgroup 自治切换（活态任务上撤反问 park）委托新封存器时**必须传 `clarify-only`**——否则会把同任务并行的普通 review / completion gate 一并取消，绕过审批或卡死活任务；终态钩子传 `all`。workgroup 侧保留其 assignment requeue 尾巴。
3. **接线**：`lifecycle.ts` 增加 `registerTerminalTaskHook(fn: (taskId, to) => void)`；`setTaskStatus` CAS 成功且 `to ∈ {'done','canceled'}` 时同步调用（try/catch + log.warn）。`cli/start.ts` 启动装配处注册 `sealOpenHumanGatesForTask`。**不**对 failed/interrupted 封存（可复活态，见 §1）。
4. **写路径护栏（设计门修正）**：查询过滤与钩子都挡不住直接写入（钩子失败即残留 awaiting 的 round/run，旧链接/直接请求仍可把答案与决策写进终态任务）——在写事务内补 owning-task 终态校验：`sealRoundQuestions`（答案提交）、`submitReviewDecision`（评审决策）、问题下发三处于**同一事务内**读任务状态，`done/canceled` 即 409 `task-terminal`，拒绝先于任何落库。failed/interrupted 不拦（可恢复语义，见 §1）。
5. 前端：`tasks.detail.tsx:337` `cancelable` 加两个 awaiting 态（取消按钮已是 ConfirmButton 两击确认，无需新确认 UI）。

### T3 优雅关停写 interrupted + daemon-restart

1. `abortAllActiveTasks(reason?: string)`（`task.ts:123-127`）→ `controller.abort(reason)`；`shutdown.ts:24` 传 `'daemon-shutdown'`。
2. 调度器四个 abort 检查点（`scheduler.ts:592/601/629/655`）改为读取 `signal.reason`：reason 为 `'daemon-shutdown'` 时不走 `cancelTaskRow`，改走新的 `interruptTaskRow(db, taskId)`——CAS `to:'interrupted', allowedFrom:['running']`，`errorSummary: DAEMON_RESTART_ERROR_SUMMARY`，`errorMessage:'daemon shutdown interrupted this task; auto-resume will pick it up on next boot'`。用户手动取消（reason 为空）路径字节不变。
3. `shutdown.ts:42-53` 幸存者分支的 `errorSummary` 从 `'daemon-shutdown'` 改为 `DAEMON_RESTART_ERROR_SUMMARY`（`recovery_events` 的 `shutdown-flip` 审计保留，audit detail 里保留 shutdown 字样以区分来源）。
4. `autoResume` 不改（匹配面自然覆盖）；`orphanReconcile` 的 `'orphan-reconcile'` 语义不同（daemon 存活期间的孤儿）**不并入**。
5. **node_run 同语义（设计门修正）**：SIGTERM 落在 agent 子进程运行期间时，runner 的 abort 分支现在把 node_run 固定写成 `canceled` + `'aborted by signal'`——详情页会把该节点归类为手动取消，与任务行的 interrupted 语义矛盾。runner 层同样按 `signal.reason` 分流：shutdown → node_run `interrupted`（errorMessage 注明 daemon shutdown），与 boot reaper 的 interrupted 写法对齐。
6. 兼容性：无 DB 迁移；历史 `'daemon-shutdown'` 行保持原样（数量极少且本来就要手动 resume，不做 backfill）。

### T4 修复失败可见 + resume 失败上浮

1. **修复弹窗**：`RepairConfirmModal.tsx:48` 的 onSuccess 分流——`result.ok === false` 时不调 `onApplied`，本地 state 持有 result 并渲染 `<ErrorBanner message={…} />`：文案 = 新词条 `tasks.repair.applyFailedBanner`（zh:「状态修复已生效，但任务续跑失败。可关闭后重新诊断，或到任务详情页手动继续。」）+ 折叠原文 `outcomeMessage`；弹窗保持打开，确认按钮变为「关闭」。`RepairChoiceDialog.tsx:163-167` 的关窗链路因只在 onApplied 时触发而自然只走成功路径，无需改。
2. **反问/评审提交的 resume 上浮**：`routes/reviews.ts:229-259`、`routes/clarify.ts`（answers 快通道）、`routes/taskQuestions.ts`（下发）三处 fire-and-forget 改为 await + catch：
   - `task-not-resumable` 维持静默（良性：活跃派发环会接手，调研确认）；
   - 其余错误不改变 2xx 主结果（答案/决策确实已生效），在响应体加 `resume: { ok: false, code, message }`；
   - 前端在 `reviews.detail.tsx`、`clarify.detail.tsx`、`TaskQuestionList.tsx` 的提交成功回调里检查 `resume?.ok === false` → 顶部 NoticeBanner（warning tone）：新词条 `common.resumeFailedAfterSubmit`（zh:「已提交成功，但任务续跑失败（{code}）。请到任务详情页点「继续执行」或诊断修复。」）。
   - shared 的响应 schema（`SubmitClarifyAnswers*` / review decision response）加可选 `resume` 字段，向后兼容（旧前端忽略）。

### T5 deleteWorkflow 定时任务引用守卫

1. `services/workflow.ts` 新 helper `scheduledRowsReferencingWorkflow(rows, workflowId)`：`launchKind==='workflow'` && `JSON.parse(launchPayload).workflowId === workflowId`（镜像 `agent.ts:455-470`，malformed JSON 同样吞掉）。
2. `deleteWorkflow` 的 `dbTxSync` 内、`countReferencingTasksInTx` 之后：命中即抛 `ConflictError('workflow-scheduled-referenced', "workflow '<name>' is the launch target of N scheduled task(s); delete or repoint them first", details)`。**details 遵守 RFC-099 隐藏语义（设计门修正）**：他人创建的**私有**定时任务对当前 principal 应保持 404 同形不可见——details 只列 principal 可见的 `{ id, name }` 清单 + `hiddenCount` 聚合数（对齐 `workflow-in-use` 只回 aggregate 的既有先例），绝不泄露不可见 schedule 的名字/存在性明细。
3. i18n 与渲染（设计门修正）：`describeApiError` 不做 interpolation 也不读 details——词条**不带占位符**（zh:「该工作流仍被定时任务引用，请先删除或改指向这些定时任务。」）；`workflows.edit.tsx` 的删除错误横幅在该错误码命中时**就地读取 `ApiError.details`** 渲染可见清单 +「另有 N 个你不可见的定时任务」聚合行（调用点局部渲染，不等 RFC-A 的通用 details 机制）。A5 的"展示清单"以此为准。

### T6 待办口径过滤（对历史行立即生效）

1. `listClarifyRoundSummaries`（`clarifyRounds.ts:169-190`）：status 过滤为 `awaiting_human`（默认待办口径）时排除 `TERMINAL_TASK_STATUSES` 的任务。**过滤必须发生在分页窗口之前（设计门修正）**：现实现先 `slice(limit)` 再取任务名——若最新 limit 条都是终态僵尸轮，后处理过滤会返回空列表并把更旧但可操作的轮次挤出窗口。改为：候选轮次先批量取任务状态、按终态过滤，**然后**再 slice。显式传 `status` 查历史（如 answered/全部）不过滤。
2. `listReviewSummaries`（`review.ts:1133-1202`）：同口径——`status:'pending'` 请求时排除终态任务的轮次。**同样的分页顺序要求**：现实现对 doc_versions 先做 SQL limit——把任务状态谓词并进 SQL（doc_versions→node_runs→tasks 的既有拼接里加状态条件）或先过滤后 limit。
3. 徽标：`routes/clarify.ts:164-173` pending-count 的 **admin 分支改用与非 admin 相同的 `listClarifyRoundSummaries` 路径**（顺带修复审计 P2「admin 徽标漏跨 agent 反问」与 sessions/rounds 双口径不一致）；**计数不得受列表 limit 截断（设计门修正）**——pending-count 用不带 limit 的精确计数（clarify 与 review 侧都是），不能复用截断后的列表长度。
4. 反问详情页对已封存/被过滤轮次：`clarify.detail.tsx` 已有只读态渲染；补状态说明条并**按封存原因分文案（设计门修正）**——self 轮的 canceled 不只来自任务终态（workgroup 自治切换会在活态任务上撤 round）：详情响应携带任务当前状态，任务终态 → `clarify.roundSealedByTaskTerminal`（zh:「所属任务已结束，本轮反问已封存，无需回答。」）；任务活态 → `clarify.roundDismissedByAutonomous`（zh:「工作组已切换为全自动模式，本轮反问已撤销，无需回答。」）。两种都替换「草稿已保存」误导页脚（`clarify.detail.tsx:875` 附近）。
5. 对已封存轮提交答案：`clarifySeal.ts:172-177` 既有 409 `clarify-round-terminal` 在落库前拒绝（叠加 T2-4 写路径护栏，答案不落库，满足 A6）；补 zh/en 词条：「本轮反问已封存，答案未保存。」
6. **评审侧同等契约（设计门修正）**：任务终态后 review run 被封为 canceled 而 doc_version 保持 pending——review 详情页会进入 disabled 的 `decided` 模式却仍显示 pending 决策，旧请求只得到未翻译的 `review-not-awaiting`。补齐：review 详情响应携带任务状态与封存原因 → 页面顶部状态说明条（`reviews.roundSealedByTaskTerminal`）；决策端点对终态任务返回 409 + 中文词条（`task-terminal`/`review-not-awaiting` 补 zh/en 文案）；两条都有回归测试。

### 不做的事（防蔓延）

- 不动 `QUESTION_DISPATCH_CLOSED_TASK_STATUSES` 窄集（failed/interrupted 上答题→派发属于可恢复语义，保留）。
- 不做收件箱条目的任务状态徽标（展示增强，非本 RFC）。
- 不动 `clarify.ts:listClarifySummaries` 死代码之外的遗留双表问题（`clarify_sessions` 的其余读写面不迁移；仅 admin 计数分支改道）。

## 3. 接口契约变化汇总

| 面                                                                                                                                      | 变化                                                                                          | 兼容性                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| `POST /api/tasks/:id/cancel`                                                                                                            | awaiting_review/awaiting_human 从 409 变为成功取消                                            | 放宽，无破坏           |
| `POST /api/reviews/...decision`、`POST /api/clarify/:id/answers`、问题下发                                                              | 响应体新增可选 `resume?: {ok,code,message}`                                                   | 追加字段，旧客户端忽略 |
| `DELETE /api/workflows/:id`                                                                                                             | 新 409 `workflow-scheduled-referenced`（details=可见清单+hiddenCount，遵守 RFC-099 隐藏语义） | 新错误码，前端补词条   |
| `GET /api/clarify?status=awaiting_human`、`/api/clarify/pending-count`、`GET /api/reviews?status=pending`、`/api/reviews/pending-count` | 排除终态任务的轮次（分页前过滤、计数不受 limit 截断）；admin clarify 计数改道 rounds 口径     | 行为收窄=清场目标本身  |
| clarify/review 详情响应                                                                                                                 | 携带任务状态/封存原因（前端分文案）；答案/决策/下发写事务内终态校验 → 409 `task-terminal`     | 追加字段 + 写路径收紧  |
| shared `lifecycle.ts`                                                                                                                   | node_run 转移表补 awaiting_review→canceled（如缺）；无任务级状态机变化                        | 单点扩边               |
| DB                                                                                                                                      | **无 migration**                                                                              | —                      |

## 4. 失败模式

- 终态钩子封存失败（DB 竞争/坏行）：log.warn + 状态转移照常完成；下一次进入终态或手动重跑触发时重试。查询口径过滤兜底保证待办不漏出。
- T1 自动通过写端口失败：dispatch 抛错走节点失败既有路径（任务 failed 可 resume 重入），不会再产出"不可见的 awaiting_review"。
- T3 reason 通道：非 shutdown 的 abort（用户取消）reason 为 undefined，行为与现状逐字节一致；防御性处理未知 reason 值（当作用户取消）。
- T4 resume 上浮：resume 失败不回滚主动作（语义上主动作独立成立）；前端未升级时字段被忽略，行为与现状相同。

## 5. 测试策略（随改动落地，缺一不可）

**backend（bun test）**

1. T1：inline/path 两种 kind 的空列表 → node_run done + 空 accepted/approval_meta 端口 + `review-auto-approved` 事件落库 + 任务跑到终态；非空列表回归不变；wedged 存量行重入 dispatch 解卡；`approval_meta` 无用户归属字段（对齐 rfc099-prompt-isolation 锁）。
2. T2：awaiting_human/awaiting_review 任务 cancel 成功且轮次封存；**cross 轮封存走 abandoned 且不触发 0031 CHECK（self+cross 混合任务一次 sweep 全成功）**；pending/running 取消回归；终态任务取消仍 409 且文案新词条；**workgroup 自治切换（活态任务）只撤 clarify、并行 review/completion gate 不受影响**；封存全程在单 `dbTxSync` 内（同步转移原语，无 thenable）。
3. T2-4 写路径护栏：钩子被人为打失败后，对残留 awaiting 轮提交答案/决策/下发 → 409 `task-terminal` 且零落库。
4. T3：abort(reason='daemon-shutdown') → 任务 interrupted + daemon-restart **且活动 node_run 同为 interrupted（非 canceled）**；无 reason abort → canceled by user（逐字节）；幸存者盖 daemon-restart；autoResume 对两类都拾取。
5. T5：有/无 schedule 引用的删除；**details 只含 principal 可见 schedule + hiddenCount（他人私有 schedule 名不泄露）**；agent 守卫回归。
6. T6：终态任务的轮次从 list/count 双面消失（含 failed——过滤不封存）；**最新 limit 条全是终态僵尸时，更旧的活跃轮仍返回（分页前过滤）**；pending-count 不受 limit 截断；resume 后重新出现；done/canceled 触发硬封存；封存轮提交答案 409 且 answers 表零新行；admin 与非 admin pending-count 口径一致（含 cross 轮）；**review 决策端点对终态任务 409 + 中文词条**。
7. 源级锁：`registerTerminalTaskHook` 仅在装配处注册一次；`setTaskStatus` 仍无直接跨服务 import（防模块环回归，binary smoke 前置跑）。

**frontend（vitest）** 8. T4：RepairConfirmModal ok:false → 弹窗不关 + banner 文案；ok:true 回归关窗。提交后 `resume.ok===false` → 三个页面 warning banner。9. T2：awaiting 态渲染取消按钮并走 ConfirmButton 流；`task-not-cancelable` 新文案词条断言。10. T5：删除被引用工作流时横幅渲染可见 schedule 清单 + hiddenCount 聚合行。11. T6：clarify.detail 封存轮按原因分文案（终态 vs 自治撤销）、不显示「草稿已保存」页脚；reviews.detail 终态说明条。

**门槛**：`bun run typecheck && bun run test && bun run format:check` + frontend vitest + `bun run build:binary` smoke（涉及 shared 导出与注册模式，按 [reference_binary_build_module_cycle] 前置验证）。
