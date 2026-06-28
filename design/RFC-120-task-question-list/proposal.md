# RFC-120 — 任务问题清单 / 任务中心（Task Question List & Flexible Fixer）

> 状态：Draft（待用户批准进入实现）
> 触发：2026-06-28 用户「给任务增加问题列表能力，反问的问题自动进清单、按 multica 那样管理（待处理/处理中/已处理待确认/完成）；这次任务中心的目标是**让问题的最终修改方灵活化**——除了现状把问题交给编排图固定的 agent 重跑，还可以由人指定本工作流里的另一个节点来重跑修改」。
> 调研：四路并行回源（① self+cross 反问的数据模型/服务 `clarify_rounds` 单一历史台账、无 per-question 身份与状态；② 前端任务详情页 tab 体系与公共原语；③ node_run 生命周期与调度派发的可观测信号；④ 参考仓 multica 的 issue 生命周期与「执行单元解耦」骨架）。证据 file:line 见 `design.md §1`。四轮反问澄清记录见 `design.md §9`。

## 1. 背景

### 1.1 现状：反问问题没有「身份」，更没有「谁来修改」的选择权

平台的「反问」（agent 向人提问、人回答、agent 据答案重跑）有两套同源机制——`同节点反问`（self-clarify，RFC-023）与 `跨节点反问`（cross-clarify，RFC-056/058/059）。两者统一持久化在 `clarify_rounds` 表（`schema.ts:1127`），**每轮一行、是跨节点跨 run 的完整历史、永不删除**。但今天有两个根本缺口：

1. **没有「单个问题」的身份与生命周期**：一轮 1–5 个问题以 JSON blob（`questions_json`）整体存，每题只有轮内唯一的 `id`；状态是**轮级**的（`awaiting_human→answered/canceled/abandoned`）。无法对「某一个问题」单独追踪「它现在处理到哪一步了」。
2. **「谁来修改」被编排图焊死**：反问答案由**谁**承接重跑，完全由工作流图的边决定——`同节点反问`回到提问节点自己、`跨节点反问`按 `to_designer`/`to_questioner` 边回到设计者 / 反问者（`shared/clarify.ts:655/693`）。用户**没有任何选择权**：哪怕人明知「这个修订该换个更合适的 agent 来做」，也只能眼睁睁看着图里那个固定节点重跑。

用户要的「任务中心」正是补这两块：**给任务一个问题清单（台账 + 生命周期），并让问题的「最终修改方」从『编排死，固定』变成『人可灵活指定』。**

### 1.2 反问承接者的两类角色（决定「改派」可行性的结构约束）

回源发现承接反问答案的节点天然分两类，性质截然不同（`design.md §1.3`）：

- **阻塞-产出型**：`同节点反问`的提问节点、`跨节点反问`的反问者。它们**用「提问」代替了「产出」**（吐的是 `<workflow-clarify>` 而非 `<workflow-output>`），下游正等它们的输出——**必须由它们自己重跑产出**，否则下游永久阻塞。把它们「改派」给别的节点 = 原节点永不产出 = **死锁**。
- **修订型（纯修改方）**：`跨节点反问`的设计者。它**已经产出过**（如设计稿 / 代码），反问答案只是 `## External Feedback` 反馈让它去**修订**；不重跑它也不卡（原产出仍在）。这种才能被自由「改派」。

用户说的「让**最终修改方**灵活化」精确对应**修订型**——这正是 Code→Audit→Fix 里的 **Fix 步**：审计方（反问者）提问、答案作为反馈交给「修改方」（设计者/代码作者）去修。本 RFC 把这个「修改方」从固定的设计者节点，放开成**本工作流里任意人选节点**。

### 1.3 引擎已具备的地基

- **承接 = 节点重跑**，无需新执行原语：所有 agent 执行都走 `node_runs`（`node_id` 非空 `schema.ts:598`）→ `runNode`（`runner.ts:444`），跑在任务 worktree、产出经 `node_run_outputs`（`schema.ts:792`）流向下游。`跨节点反问`的设计者重跑（`triggerDesignerRerun` `crossClarify.ts:772`）已经是「把答案作为反馈注入某节点 prompt、重跑、级联下游」——**改派只是把这个『某节点』从图固定值放开为人选值**。
- **生命周期可观测**：node_run 的 `mint(pending)→mark-running→mark-done/failed` 在 `nodeRunMint.ts:115`/`runner.ts:773`/`runner.ts:1483` 有确定信号；freshness 由 `pickFreshestRun`（`freshness.ts:290`）单一收口。问题条目的三个执行态（待处理/处理中/已处理待确认）可**派生**自承接节点的 rerun，无需自建易漂移的状态列。
- **multica 骨架可借**：multica 把 issue 生命周期（`backlog/todo/in_progress/in_review/done`）与「执行单元 `agent_task_queue`」**解耦**，中间态由 agent 自报、终态人工确认。本平台 agent 只吐 envelope、**无法自报**，故改为**框架观测 node_run 自动推进**；但「issue（产品台账）与执行单元（node_run）解耦」「已处理（in_review）= 交付待人确认」「人工拖到 done」这套骨架直接借鉴。

## 2. 目标 / 非目标

### 2.1 目标（v1）

1. **任务级问题清单（完整自动台账）**：任务详情页新增「问题清单」页签。**全部反问问题（self + cross、历史 + 新增、含未回答）自动收录**，归属当前任务；无任何「标记/勾选才进」动作（决策 D1）。
2. **per-question × per-承接者 的条目身份**（决策 D2）：每个反问问题按图派生 1+ 条目，每条目对应一个承接节点：`self`→1（提问节点）；`cross 反问者域`→1（反问者）；`cross 设计者域`→2（反问者 + 设计者）。「设计者+反问者两条」是用户原述场景的精确落地。
3. **四态生命周期 + 人工兜底**（决策 D3）：每条目走 `待处理 → 处理中 → 已处理待确认 → 完成`；执行三态**派生**自承接 rerun（`mint/run/done`）；承接 agent 执行**失败仍归「处理中」**（系统自动重试 / 等人重跑，不单立失败态）；`已处理待确认 → 完成` 须**人工确认**（纯收尾、无工作流副作用）。来源轮 `canceled/abandoned` 的条目落终态 `已关闭`。
4. **灵活指定修改方（本 RFC 核心，决策 D4）**：**仅修订型条目（cross 设计者域）**可被人工**改派**——从本任务工作流的节点里另选一个，由它接收该反问的「问题 + 人工答案」作为反馈、重跑修订，产出**照常级联下游**（与现有反问流程一致）。默认承接者 = 图里的设计者节点。阻塞-产出型条目（反问者 / self 提问节点）**不可改派**（避免死锁），照常按图自我继续。
5. **打回重处理**（决策 D5）：`已处理待确认` 态可「打回」——解冻该问题的原答案、人工改答案（修订型还可改派目标节点），重新提交驱动承接节点重跑。打回采用 **append-only「再答」轮**实现，原答案作为可编辑初值保留、不就地改写历史（保审计）。
6. **历史回填**（决策 D6）：上线迁移把全部存量 `clarify_rounds` 炸开回填为条目，状态**按真实执行态派生**（已答且已产出→已处理待确认、运行中→处理中、未答→待处理、已取消→已关闭），与新条目同规则。
7. **权限与隔离**：可见 / 确认 / 打回 / 改派均沿用 RFC-099 任务成员（owner + collaborator）+ admin 边界（决策 D7）。归属记录（user id + 关系角色快照、谁确认 / 谁改派）只入审计列与 UI，**绝不进入任何 agent prompt**（沿用 RFC-099 prompt-isolation 铁律，决策 D8）。
8. **复用公共原语**：清单 UI 全程复用既有 tab 体系 + `StatusChip`/`AttributionChip`/`.data-table`/`Select`/`ConfirmButton`/`Dialog`/`EmptyState`，无原生 chrome（强制 UI 一致性）。

### 2.2 非目标（本 RFC 不做 / 推后续）

- **不放开阻塞-产出型的改派**：self 提问节点、cross 反问者**永远在自己节点继续**；不提供「替换它们」的能力（结构性死锁，见 §1.2）。
- **不新增 DAG 外的临时执行原语**：改派是「换一个**工作流内已有节点**重跑」，**不是**凭空起一个脱离图的 agent（用户明确「仅本工作流用到的 agent / 被选中的节点触发重跑」）。
- **不跨工作流 / 跨任务的全局问题中心**：清单严格**按任务归属**，v1 不做跨任务聚合视图（既有 `/clarify` 全局收件箱另在）。
- **不支持手工新建任意问题**：v1 问题来源**仅反问**（self + cross），不做 multica 式「人手开 issue 派给 agent」。
- **不改反问的 envelope / scope / 注入协议本身**：scope（designer/questioner）仍是人在回答时的逐题选择（RFC-059 不变）；本 RFC 只在其上加台账 + 改派目标节点。
- **不引入优先级 / 重点标记**：用户明确否定；清单是全量自动台账，无标记/分级（如后续需要再开 RFC）。
- **不做改派目标的自动推荐 / 校验智能**：v1 只给「从工作流节点里选」的下拉，由人判断该节点是否胜任。

## 3. 用户故事

1. **作为审计闭环的负责人**：代码 agent 写完、审计 agent（反问者）跨节点反问提了 3 个问题。我在「问题清单」里看到这 3 个问题各自的条目（反问者继续 + 设计者修订）。其中一个问题我认为原设计者 agent 不擅长修，于是把那条**设计者域**条目**改派**给工作流里的「安全修复」节点；回答后该节点带着「问题+我的答案」重跑、产出修订并级联下游——反问者那条照常由反问者自己继续。
2. **作为追踪进度的人**：每个问题的条目清楚显示 `待处理 / 处理中 / 已处理待确认 / 完成`。承接节点跑起来→处理中；跑完产出→已处理待确认；我看过产出满意→点「确认」关闭。
3. **作为质量把关者**：某条目已处理待确认，但我看产出不对，点「打回」——原答案被解冻、我补充/修正答案（必要时再改派目标节点），重新提交，承接节点用新答案重跑。
4. **作为上线第一天的用户**：历史所有反问问题已自动出现在清单里，状态按它们真实跑到哪了显示——已经跑完的落「已处理待确认」等我逐条确认，没答的还在「待处理」。
5. **作为协作者**：我是任务成员就能看清单、能确认 / 打回 / 改派；非成员看不见这个任务也看不见清单。
6. **作为安全合规视角**：谁改派了、谁确认了、谁打回了都有审计记录可查，但这些「人」的信息**从不**出现在任何重跑 agent 的 prompt 里（沿用 RFC-099）。

## 4. 验收标准

> 每条带测试（先红后绿）；门槛 `bun run typecheck && bun run test && bun run format:check` 全绿 + CI（lint + test×2OS + binary smoke×2OS + Playwright e2e + 静态扫描）；按 [feedback_post_commit_ci_check] push 后查 CI；按 [feedback_codex_review_after_changes] 设计 gate + 实现 gate 各跑 Codex。

**数据模型与收录**
- AC-1：migration 0060 新建 `task_questions` 表（per-question×per-承接者 条目，列见 `design.md §2`）+ 升级滚动 journal +1。
- AC-2：纯函数 `reconcileTaskQuestionsForRound(round, scopes, graph)` 给一轮 `clarify_round` 推导出**确定的条目集合**：self→{self}；cross→{questioner} ∪ {designer | 该题 scope=designer}；幂等（重复调用不增不改身份、保留人工覆盖层）。
- AC-3：新轮在 `createClarifySession` / `createCrossClarifySession` 后即 reconcile 出条目（未答→待处理）；回答 `submit*Answers` 后按 scope 补出 designer 条目并 reconcile。
- AC-4：上线迁移把全部存量 `clarify_rounds` reconcile 回填为条目，`trigger_run_id` **从既有消费戳解析**（`consumed_by_questioner_run_id`/`consumed_by_consumer_run_id`/`designer_run_triggered_at`），不可唯一证明→NULL+保守态；状态派生反映真实执行态（AC-6 同口径）。

**生命周期（派生）**
- AC-5：纯函数 `deriveQuestionPhase(entry, round, handlerRun)` 正确映射：来源轮 canceled/abandoned→`已关闭`；`confirmation=confirmed`→`完成`；承接 run 不存在或仍 `pending`(未 `startedAt`)→`待处理`；run `running`/`failed`→`处理中`（失败仍处理中）；run `done` 且有 `node_run_outputs`→`已处理待确认`。
- AC-6：执行三态**不落库**、读时由 `resolveHandlerRun` **精确 lineage**（节点+iteration、以下一条 clarify-cause rerun 为上界框窗、fanout 聚合——**非**裸 `freshest≥anchor`）取承接 run 后 `deriveQuestionPhase`；只持久化人工覆盖层（confirmation + 改派目标 + 审计）。承接 run 重试 / 级联 / 后续不相关新轮均不需也不会错动条目侧态。

**灵活改派（核心）**
- AC-7：仅 `role_kind=designer` 条目可写 `override_target_node_id`，且目标须是工作流里 `kind=agent` 的节点；写入非 agent 节点（io/review/clarify/wrapper）/ 非工作流节点 / 给 `self`/`questioner` 条目改派 → 422 拒。
- AC-8：改派后承接派发到**override 目标节点**而非图设计者；该节点重跑时经**条目级 External Feedback 注入**只拿到**本条目对应问题 + 答案**（不含同轮其他题），产出照常级联下游。
- AC-9：改派把该题从默认设计者**批次**中剔除（反馈渲染 / 就绪 / 消费戳全条目级）；同轮「Q1 改派 + Q2 默认」互不污染、未改派题批处理仍成立；反问者条目不受改派影响、照常继续。

**确认 / 打回**
- AC-10：`POST /api/tasks/:id/questions/:entryId/confirm` 仅在 `已处理待确认` 可调、置 `confirmation=confirmed`→`完成`；纯状态、无工作流副作用；并发经 CAS 恰一胜。
- AC-11：`POST /api/tasks/:id/questions/:entryId/reopen {editedAnswer, newOverrideTargetNodeId?}`（打回）仅在 `已处理待确认` 可调：原答案存 `prior_answer_snapshot_json` 后**就地改** `clarify_rounds.answers_json[questionId]`（重 seal 单题、不 re-park 整轮、不扰兄弟条目）、`confirmation` 复位、**只 re-fire 本条目承接节点**、`trigger_run_id` 前移；修订型可携带新 `override_target_node_id`。CAS 保并发恰一胜。

**权限 / 隔离**
- AC-12：清单读、confirm、reopen、改派均经 `requireTaskMember`（owner/collaborator/admin）；非成员 / 不可见任务 404/403（镜像既有任务路由）。
- AC-13：prompt-isolation——双层断言锁：①任何承接 rerun 的 `promptText` 永不含确认人 / 改派人 / 角色快照等归属字段；②源码层断言 `deriveQuestionPhase`/reconcile 的归属字段不被 prompt 构造读取（仿 rfc099-prompt-isolation）。

**前端**
- AC-14：任务详情页新增「问题清单」页签（接入 `lib/task-detail-tabs.ts` + `tasks.detail.tsx` always-mounted pane），表格列出条目：问题标题 / 来源（self·cross + 来源节点）/ 承接节点（修订型可改派下拉，默认=设计者）/ 状态 `StatusChip` / 答复摘要 / 操作（确认·打回·跳转反问轮·跳转产出）；按状态过滤；空/错/载入走 `EmptyState`/`ErrorBanner`/`LoadingState`；改派下拉走 `Select`、确认走 `ConfirmButton`、打回跳 `/clarify/$nodeRunId`；实时复用 `useTaskSync` 失效 `['task-questions',taskId]`；i18n 中英对称；视觉对齐自查。

## 5. 决策登记

- **D1（收录）= 全量自动、无标记**：所有反问问题（self+cross、历史+新、含未答）自动进清单做完整台账。用户回合①选「全量自动」并明确否定「重点/优先级标记」。
- **D2（身份）= per-question × per-承接者**：条目 = (任务, 反问轮, 问题id, 承接角色/节点)。设计者域问题→2 条（设计者 + 反问者），questioner 域 / self→1 条。对齐用户「每个待处理问题的目标 agent 不同」。
- **D3（生命周期）= 4 态、执行三态派生、失败归处理中**：`待处理/处理中/已处理待确认/完成`(+`已关闭`)；执行三态派生自承接 node_run（agent 无法自报，区别 multica；避免状态列漂移——契合本仓「不重算他处权威态」）；失败仍处理中（用户回合①）；确认人工、纯收尾（用户回合①）。
- **D4（改派）= 仅修订型可取代，限工作流节点，注入+级联**：用户四答收敛——「取代式」「仅本工作流用到的 agent」「选中节点触发重跑、和反问流程一致」「仅修订型可取代」「注入问题+答案、照常级联下游」。阻塞-产出型不可改派（结构死锁）。
- **D5（打回）= 解冻原答案再改、就地改答轻量实现**：用户回合②选「解冻原答案再改」；Codex 设计 gate F2 指出「append-only 再答轮」的 submit 路由/legacy dual-write/单条目定位未定且高风险，改为**就地改 `answers_json` 单题 + 只 re-fire 本条目承接**（原值留 `prior_answer_snapshot_json` 审计），字面落地「解冻原答案」、省掉整套再答轮链路、天然只影响本条目。
- **D6（历史回填）= 按真实执行态派生**：用户回合①选此项；回填即对存量轮跑同一 reconcile + derive。
- **D7（权限）= RFC-099 任务成员边界**：可见/确认/打回/改派权 = 任务成员（owner+collaborator）+ admin，沿用反问答题权同一边界。
- **D8（隔离）= 归属只入审计与 UI、绝不进 prompt**：沿用 RFC-099 prompt-isolation 铁律；新增确认人/改派人字段同等约束，测试双层锁。
- **D9（UI）= 新任务页签、复用公共原语**：不落原生 chrome；改派下拉/确认按钮/状态 chip 全用既有组件。

> **2026-06-28 设计讨论新增 D10–D12（问题清单升级为「任务中心」主动处理面，详见 design.md §11）**：

- **D10（任务状态联动）= `awaiting_human` gate on 未下发、下发即放行(A)、确认非 gate**：问题处于 `待指派`/`待下发`（=未下发）时任务停 `awaiting_human`；下发（反问页提交 / 看板批量）放行到 `处理中`→`running`；确认（已处理待确认→完成）仍非 gate（D5 保留）。**复用 `awaiting_human`、不新开状态**（反问页/收件箱/看板都是它的不同 UI）。
- **D11（看板 v1-A + 两并存处理面）**：问题清单升级为 multica 式看板（列 `待指派→待下发→处理中→已处理待确认→完成`(+已关闭)、卡片标来源+目标节点、拖 `待下发` 后批量下发）。反问页与看板是**两个对等处理面、同一后端**——反问页快路径（默认 handler 立即下发、行为不变）、看板控制路径（指定 agent + 暂存 + 批量下发）。v1-A 复用 `QuestionForm`；全局跨任务看板 / 退役 `/clarify` / 拖拽流转留 **Phase 2**。
- **D12（handler 单一事实源 + 两面对等选择器）**：有效 handler = `override_target_node_id ?? 图默认（线上连着的）agent`；反问页与看板**都挂同款 handler 选择器**（仅 designer/修订型可改、self/questioner 固定只读），写同一 `override`、互相回显最新值。新增 `待下发`（已批准·未下发）暂存态 → `task_questions` 加 `staged_at/staged_by`、phase 枚举 +1、新迁移 **0061**（不动已提交 0060）。
- **D13（节点级待处理徽标）**：任务详情画布每个节点标该节点**来源**的待处理问题数；点数字 → 跳问题看板并**按该来源节点过滤**（复用看板、加 `sourceNodeId` 过滤维度）。纯前端 + 复用，归 PR-C。详见 design §11.8。

> **Codex 设计 gate fold（2026-06-28，落码前）**：原始三件套经 Codex adversarial 设计 gate 核读源码，**6 findings（4 high + 2 medium）全采纳**，折叠记录于 `design.md §10`。D10–D12 的看板/gate 升级为本轮设计讨论后追加，留实现 gate 再过 Codex。
