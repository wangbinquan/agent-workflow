# RFC-120 任务分解 — 任务问题清单 / 任务中心

> 读法：先 `proposal.md` → `design.md` → 本文。子任务编号 `RFC-120-T*`。

## PR 拆分建议（强序 A→B→C）

- **PR-A（数据层 + 收录 + 派生 + 回填）**：migration 0060、`task_questions` 表、shared 纯函数（reconcile/derive/canReassign）、`services/taskQuestions.ts`（reconcile/resolveHandlerRun/list）、在 clarify/crossClarify create·submit 后接 reconcile + stamp `trigger_run_id`、历史回填 + 全部 backend/shared 测试。**独立可交付**：上线即得「只读问题清单台账 + 四态显示」，无改派/确认/打回也有完整价值。
- **PR-B（确认 + 改派 + 打回 + 路由）**：confirm/reassign/reopen 服务、`triggerDesignerRerun` override + External Feedback 注入推广、append-only 再答轮、路由 + ACL + prompt-isolation。依赖 PR-A。
- **PR-C（前端）**：问题清单页签 + 表格 + 改派下拉 + 确认/打回 + 导航 + i18n + 前端测试 + e2e。依赖 PR-A/B。

> 前端与后端等粒度（[feedback_audit_fanout_frontend_parity]）：PR-C 含独立的「公共组件复用 / 视觉对齐」自查环节（改派下拉走 `Select`、状态走 `StatusChip`、确认走 `ConfirmButton`、空/错/载入走 `EmptyState`/`ErrorBanner`/`LoadingState`，禁原生 chrome）。

## v2 设计讨论调整（2026-06-28，详见 design.md §11）

问题清单升级为「任务中心」主动处理面后，PR-B/PR-C 范围相应扩展（北极星 = multica 问题流转看板）。**已交付的 PR-A 数据层 + 纯 oracle 不受影响**（加性），新增：

- **新增 RFC-120-T1b｜migration 0061 + staged 字段**：`task_questions` 加 `staged_at INTEGER` + `staged_by TEXT`（`待下发` 暂存态）；`TaskQuestionPhase` 枚举加 `'staged'`、`deriveQuestionPhase` 加分支（pure，补单测）。**不动已提交 0060**（避 shared `.git` amend 风险）。可并入 PR-A 收尾或 PR-B 起头。
- **PR-B 扩展（仍待 RFC-119 稳定）**：在「下发」backend 路径加 ① answer-without-immediate-dispatch（看板路径）② stage（拖待下发）③ batch-dispatch（批量 mint handler rerun）④ task `awaiting_human` gate 联动（未下发 hold、批量下发放行，model A，确认非 gate）⑤ reassign→override。**反问页现有 submit-自动下发不变**（加性）。
- **PR-C 改为看板**：问题看板（替代 AC-14 的 table，列 `待指派→待下发→处理中→已处理待确认→完成`+已关闭、卡片标来源+目标）+ **共享 handler 选择器**（反问页 `clarify.detail.tsx` + 看板卡，designer 可改/self·questioner 只读、写同一 `override`、互相回显）+ 批量下发交互 + **节点级待处理徽标**（画布节点角标计数 + 点击跳看板按 `sourceNodeId` 过滤，列表/看板端点支持 `?sourceNodeId=`）。v1-A 复用 `QuestionForm`；全局看板/退役 `/clarify` 留 Phase 2。

## 子任务

### PR-A — 只读台账

- **RFC-120-T1｜migration 0060 + schema + journal**
  - `db/migrations/0060_rfc120_task_questions.sql`：`CREATE TABLE task_questions(...)`（列见 design §2.1；`--> statement-breakpoint` 分隔、CREATE TABLE 单起一行——[reference_migration_statement_breakpoint]）+ `INDEX(task_id)` + `UNIQUE(origin_node_run_id,question_id,role_kind)`。
  - `schema.ts` 加 `taskQuestions` 定义；`_journal.json` +1；`upgrade-rolling.test.ts` journal 断言 +1；binary smoke 验 0060 嵌入无模块环。
  - 验收：AC-1。依赖：无。**编号防撞**：若并发 RFC（如 RFC-119）先占 0060，本档顺延 0061（多人树原则）。
- **RFC-120-T2｜shared 纯函数 + 单测**
  - `packages/shared/src/task-questions.ts`：`reconcileDesiredEntries` / `deriveQuestionPhase` / `canReassign`（签名见 design §2.2）。
  - 测试 `task-questions-reconcile.test.ts` + `task-questions-phase.test.ts` + `task-questions-reassign.test.ts`（全分支，含 failed→processing 回归锁）。
  - 验收：AC-2/5/7（纯函数部分）。依赖：无（被 service + 前端共用）。
- **RFC-120-T3｜`services/taskQuestions.ts` 读侧**
  - `reconcileTaskQuestionsForRound`（幂等 upsert、保覆盖层）、`resolveHandlerRun`（**精确 lineage**：节点+iteration+loopIter、以「下一条 clarify-cause rerun」为上界框窗、fanout 取 parent+子聚合，**F1**——非裸 freshest≥anchor）、`listTaskQuestions`（逐条 derive 组 DTO + 候选 agent 节点 + 失效节点标注）。
  - 测试 `rfc120-collect.test.ts` 的 list/derive 部分 + **lineage 越界反例**（同节点后续新轮不污染、fanout 聚合）。
  - 验收：AC-6。依赖：T1/T2。
- **RFC-120-T4｜接 clarify/crossClarify 收录钩子（加性）**
  - `clarify.ts`/`crossClarify.ts` 的 create/submit 成功后调 `reconcileTaskQuestionsForRound` + 对承接 rerun stamp `trigger_run_id`；既有反问语义字节不变（黄金回归锁）。
  - 测试：`rfc120-collect.test.ts`（新轮→待处理；回答→stamp→处理中；cross 按 scope 补 designer 条目）。
  - 验收：AC-3。依赖：T3。
- **RFC-120-T5｜历史回填**
  - 遍历存量 `clarify_rounds` 调 reconcile；`trigger_run_id` **从既有消费戳解析**（`consumed_by_questioner_run_id`/`consumed_by_consumer_run_id`/`designer_run_triggered_at`，**F4**——不靠 cause+节点+iteration 猜）；不可唯一证明→NULL+保守态；幂等可重跑。
  - 测试 `rfc120-backfill.test.ts`（回填 + 消费戳解析 + 保守态 + 重跑幂等；fixtures：同节点多 self 轮 / 多源设计者批 / failed-pending / canceled-abandoned / 戳缺失歧义）。
  - 验收：AC-4。依赖：T3/T4。

### PR-B — 改派 / 确认 / 打回

- **RFC-120-T6｜confirm + reassign 服务**
  - `confirmTaskQuestion`（CAS open→confirmed，仅 awaiting_confirm）、`reassignTaskQuestion`（`canReassign` 守卫、写 override + 审计、不立即重跑）。
  - 测试 `rfc120-confirm-reopen.test.ts`（confirm 段）+ `rfc120-reassign-rerun.test.ts`（reassign 段、422 非 designer/非工作流节点）。
  - 验收：AC-10、AC-7（服务）。依赖：PR-A。
- **RFC-120-T7｜改派注入下沉到条目粒度（最高风险，F3）**
  - **先**把 designer 反馈渲染 / 就绪 / 消费戳 / trigger 从 session 级改成读 `task_questions` 条目级（override 题按 `override IS NOT NULL` 从默认批次剔除），**再**接 override：`effectiveTarget = override ?? 图设计者`；override 题单独 mint、只收**自身问题**的 External Feedback 块、绕过 `evaluateDesignerRerunReadiness`。
  - 测试 `rfc120-reassign-rerun.test.ts`（**同轮「Q1 改派 + Q2 默认」不交叉污染**正反例；override 重跑 + 注入 + 级联下游；未改派题批处理仍成立；override 空 = 原行为黄金锁）。
  - 验收：AC-8/9。依赖：T6。**最高风险**：动 cross-clarify 反馈/消费路径，**先条目过滤再接 override**、逐字保 override 空旧路径。
- **RFC-120-T8｜reopen（就地改答轻量版，F2）**
  - `reopenTaskQuestion({editedAnswer, newOverrideTargetNodeId?})`：校验 awaiting_confirm → 存 `prior_answer_snapshot_json` → 就地改 `clarify_rounds.answers_json[questionId]`（重 seal 单题、不 re-park 整轮）→ designer 可写 override → **只 re-fire 本条目承接节点**（按 §2.4 条目级注入、不重跑兄弟反问者）→ confirmation 复位 + trigger 前移 + reopen_count++。CAS 乐观锁。
  - 测试 `rfc120-confirm-reopen.test.ts`（reopen 段：就地改答只动单题、只 re-fire 本条目、兄弟反问者零扰动、修订型带新 override、并发恰一胜）。
  - 验收：AC-11。依赖：T6/T7。
- **RFC-120-T9｜路由 + ACL + prompt-isolation**
  - `routes`：`GET /questions`、`POST .../confirm|reassign|reopen`，全经 `requireTaskMember` + 可见性；`api-contract-coverage` 登记新端点。
  - 测试 `rfc120-route-acl.test.ts`（成员/非成员/不可见、非法态错误码）+ `rfc120-prompt-isolation.test.ts`（双层锁：承接 rerun promptText 不含归属字段 + 源码层 prompt 构造不读这些字段）。
  - 验收：AC-12/13。依赖：T6/T7/T8。

### PR-C — 前端

- **RFC-120-T10｜问题清单页签 + 表格**
  - `lib/task-detail-tabs.ts` 加 `task-questions` 键 + `TAB_ORDER` 槽 + label；`tasks.detail.tsx` always-mounted pane；`components/tasks/TaskQuestionList.tsx`（`.data-table` 列：标题/来源/承接节点/状态 chip/答复摘要/操作）；按 `phase` 过滤（`.tabs` 或 `.segmented`）；空/错/载入走公共态。
  - query `['task-questions',taskId]`；实时复用 `useTaskSync`（clarify.*/node.status 失效）。
  - 测试：页签显隐 + 表格渲染（`findByRole`）+ 状态 chip。
  - 验收：AC-14（列表）。依赖：PR-A/B。
- **RFC-120-T11｜改派 / 确认 / 打回 交互**
  - 改派 `Select`（仅 designer 行可选、候选=工作流节点、默认=设计者）→ `POST reassign`；确认 `ConfirmButton`→`POST confirm`；打回按钮→`POST reopen`→跳 `/clarify/$reanswerNodeRunId`；mutation 失效相关 query。
  - 测试：改派下拉仅 designer 行、确认/打回 mutation、跳转；源码层断言无原生 modal/select chrome。
  - 验收：AC-14（操作）。依赖：T10。
- **RFC-120-T12｜i18n + e2e + 收尾**
  - `zh-CN.ts`（类型字面 + 值）/`en-US.ts`（值）加 `taskQuestions.*` 命名空间 + `tasks.tabQuestions` 标签，parity 测试绿。
  - Playwright e2e：launch cross-clarify 工作流 → 回答 → 清单见条目 → 改派 designer 条目 → 重跑 → 确认。
  - 视觉对齐自查（与 /tasks、/workflows、/clarify side-by-side）；STATE.md 落档、plan.md RFC 索引登记 RFC-120 = Done。
  - 依赖：T1–T11。

## 验收清单（汇总）

- [ ] AC-1 migration 0060 + schema + journal
- [ ] AC-2 `reconcileDesiredEntries` 纯函数（self/cross/scope/幂等）
- [ ] AC-3 create/submit 后收录 + stamp + designer 条目按 scope 补
- [ ] AC-4 历史回填（真实态派生、幂等）
- [ ] AC-5 `deriveQuestionPhase` 全分支（failed→处理中）
- [ ] AC-6 执行三态派生不落库、freshest 锚点
- [ ] AC-7 改派仅 designer + 工作流节点（422 守卫）
- [ ] AC-8 改派后注入「问题+答案」重跑 override 节点、级联下游
- [ ] AC-9 改派绕批处理、未改派题批处理仍成立、反问者不受影响
- [ ] AC-10 confirm 仅 awaiting_confirm、纯收尾、CAS
- [ ] AC-11 reopen append-only 再答轮、只重激本条目
- [ ] AC-12 路由 ACL（成员边界、错误码）
- [ ] AC-13 prompt-isolation 双层锁
- [ ] AC-14 前端页签 + 表格 + 改派/确认/打回 + i18n + 视觉对齐
- [ ] 门禁：`bun run typecheck && bun run test && bun run format:check` 全绿 + CI（lint + test×2OS + binary smoke×2OS + Playwright e2e + 静态扫描）
- [ ] Codex 双 gate：设计 gate（本三件套）+ 实现 gate（代码）各 fold
- [ ] STATE.md / plan.md RFC 索引同步

## 风险与缓解

- **改派注入下沉条目（T7，最高风险，F3）**：动 cross-clarify 反馈/就绪/消费路径，把 session 级聚合改成条目级过滤。缓解：**先**改 session→条目过滤（默认批次按 `override IS NOT NULL` 剔除）跑绿、**再**接 override；override 命中独立单题 mint、只收自身问题反馈；override 为空逐字保旧路径（黄金回归锁）；同轮「Q1 改派 + Q2 默认」交叉污染正反例锁。
- **就地改答打回（T8，F2）**：就地改 `answers_json` 单题 + 只 re-fire 本条目，不开新轮、不动 legacy submit。缓解：先把派生/收录（PR-A）跑稳；`prior_answer_snapshot_json` 留审计；CAS 乐观锁防并发双 re-fire；显式断言兄弟反问者不被重跑、原轮恒 answered。
- **派生 lineage 精度（F1）**：执行三态派生而非落库（避免状态漂移），但「freshest≥anchor」会被同节点后续新轮污染。缓解：`resolveHandlerRun` 按节点+iteration、下一 clarify-cause 上界框窗、fanout 聚合；`pickFreshestRun` 单一收口、不自造 freshest（[project_hotspot_fortify_refactor]「freshest-run 别 fork」缝）；越界反例锁。
- **历史回填可证性（F4）**：trigger_run_id 从既有消费戳解析、不可证→NULL+保守态；5 类 fixtures 覆盖歧义。
- **prompt 泄漏归属**：新增 confirmed_by/reassigned_by 字段。缓解：双层 prompt-isolation 测试锁（仿 rfc099）。
- **RFC-119 协调栅栏（F6，硬约束）**：并发 RFC-119 改 `shared/clarify.ts`（`CROSS_CLARIFY_*` 改名 + `composePriorOutputBlock`）与 PR-B 要扩展的 `triggerDesignerRerun`/`buildExternalFeedbackContext` 同面。缓解：**PR-A（新文件 + schema、零 cross-clarify 改动）独立先行**；**PR-B 待 RFC-119 合并后 rebase / 按落码当时真实符号名编码**，prompt-isolation 源码 grep 对齐改名后路径；编码前先 `git status` 确认 RFC-119 是否已落、避免对着 stale 符号写测试。
- **多人树并发**：migration 号 / STATE.md / plan.md 索引可能撞他人。缓解：号顺延、按路径精确 `git add`、commit message 只述本 RFC（[feedback_shared_index_commit_race]）。
