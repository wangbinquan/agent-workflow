# RFC-162 任务分解

> 这是对最延误子系统（clarify/scheduler，牵动 RFC-023/056/058/059/120/127/128/134/136/137/138/140）
> 的大重构。分多个 PR，每个 PR 独立门禁、独立可回滚；结构收口先行、删除殿后、迁移单独。

## 子任务 / PR 拆分

- **RFC-162-T1（shared：起跑前沿 oracle）**：`computeDispatchFrontier(handlerNodeSet, graph) →
  startNodes` 纯函数 + 矩阵单测（上游/下游/并行/多起跑/环防护）。零行为接线。依赖：无。
- **RFC-162-T2（backend：dispatch 改「最前起跑 + 级联」）**：dispatch **先过相关性就绪 barrier、
  只对就绪 handler stamp `dispatched_at`**（未就绪不 stamp、不给 queue 看见——Codex 复评 H-2，否则
  级联触达时 `selectAgentQueue` 会绕过 barrier 提前注入），收集就绪 handler 集、`computeDispatchFrontier`
  取 F、仅 mint F、级联兜就绪下游。**先与旧「逐个 mint」行为
  对拍**（default 组仅提问节点时逐字不变=黄金锁），再放开增派上游走级联。**保留
  `evaluateDesignerRerunReadiness` 并 reframe 为「相关性就绪 barrier」**（Codex high-3：级联只看
  dataflow、看不见 `to_designer` 相关性边，N:1 多源不能靠级联）——barrier 过滤后的 handler 集才喂
  `computeDispatchFrontier`。依赖：T1。
- **RFC-162-T3（准备相：影子键，行为逐字不变）**：加**非唯一影子列** `handler_node_id` 并 populate
  （= 有效承接 `override ?? default`）；reconcile/dispatch 分组/前端**读** `handler_node_id`。
  **旧 `role_kind` 唯一键、role-based 发射、以及 `causeClassForEntry(roleKind, sourceKind)` 的 cause
  派生全部照旧不动**（Codex 复评 R6：cause oracle 若在此相替换，存量**被改派**的 questioner/self 行
  会从 role 派生 cause 切成 handler 派生 cause，改掉 inline-resume/ledger 上界/auto-split，黄金锁不
  成立）；`role_kind` 不收敛、不发多 handler、不删任何东西——本相纯准备、行为逐字不变（黄金锁）。
  依赖：T2。
- **RFC-162-T4（切换相：迁移 + 原子换唯一键）**：backfill `handler_node_id`；**碰撞矩阵**解决/park
  存量同节点多行（Codex 复评 R3-H/R4：questioner override=B + designer default=B 异 cause/trigger 塞
  不进一行——仅「至多一行已下发/已绑定」或「同 trigger + 兼容态」才合并，否则暂留归档 / park + 补救，
  **绝不静默丢**）；**每条 echo 转成提问节点 handler 行**（Codex critical-2，保留 sealed/dispatched/
  trigger/confirmation/staged）；碰撞全解决后**原子**切唯一键 old→`(origin, question_id,
  handler_node_id)`、`role_kind` 出键。存量看板不丢问题/答案 + 混态（异 trigger / dispatched+staged /
  awaiting_confirm / partial-seal）迁移锁（journal +1）。依赖：T3。
- **RFC-162-T5（归一相：reconcile 处理组发射 + role 收敛 + 删 echo/collapse/scope）**——**均在 T4
  切键之后**（此时多 handler 有新键承载、不撞）：`reconcileDesiredEntries` 改「一问一组处理节点」
  发射（默认组只提问节点、增派=增 handler 行）、删 `scopes` 消费；`role_kind` 控流全收敛单值（展示/
  审计、棘轮禁新控流读）；**无角色 cause oracle 替 `causeClassForEntry` 的 roleKind 读取**（Codex
  high-4 + R6：在 role_kind 收敛后才切；AC-1 棘轮锁 default self→`clarify-answer` / default cross→
  `cross-clarify-questioner-rerun` 逐字不变）；删 `planEchoEntries`/echo 物化/echo 守卫豁免、两个
  collapse 及路由/错误码、
  `scope`/`CLARIFY_QUESTION_SCOPE_DEFAULT`/`question_scopes_json` 控流。**不删
  `evaluateDesignerRerunReadiness`**（T2 保留为相关性 barrier）。回归意图（RFC-134/138/140 的「同题
  一次投递/提问节点拿到答案」）迁移为新 dispatch 端到端锁。self/cross 走同分支。依赖：T4。
- **RFC-162-T6（frontend：卡片归一）**：删 scope picker、self/cross 同形卡、处理组增删（提问节点
  不可删己）；`/clarify` 详情页去 scope。依赖：T5（DTO 归一在归一相）。
- **RFC-162-T7（表合并·可选）**：评估 `clarifySessions` + `crossClarifySessions` 合表（scope 消失
  后 lockstep 双写理由弱化）。**非强承诺**——实现门按收益/风险决定，可留独立后续 RFC。依赖：T5。
- **RFC-162-T8（门禁 + 收尾）**：四项门禁 + binary smoke + 前端 vitest；各 PR Codex 实现门；
  `STATE.md` 收尾、`design/plan.md` 索引 Draft→Done、标 RFC-160 Superseded。

## 依赖序

T1 → T2 →（对拍绿）→ **T3 准备相**（加影子列 `handler_node_id`、行为不变）→ **T4 切换相**（碰撞
矩阵 + echo 转 handler + 原子切唯一键到新键、`role_kind` 出键）→ **T5 归一相**（reconcile 处理组
发射 + role 收敛 + 删 echo/collapse/scope）→（并行）T6、T7(可选) → T8。**三相严格串行、切键
（T4）居中**：准备相绝不收敛 role_kind / 不发多 handler（否则撞旧键）；归一相绝不早于切键（否则多
handler 无新键承载）——Codex 复评 R4/R5 的分阶段铁律。结构/dispatch 先收口（行为不变），
删除与迁移殿后，前端随 DTO 归一。

## 与既有工作的关系

- **取代 RFC-160**（cross 默认翻 questioner）：其目标由「默认处理组只含提问节点」自然达成；索引标
  RFC-160 Superseded-by-RFC-162。
- **吸收独立 bug 修复**：`collapseDesignerEntryToQuestioner` seal 守卫修复已单独落地（rfc138 回归
  用例）；T4 删 collapse 时，该回归意图（未答不误 seal / 提问节点拿到答案）迁移进新 dispatch 的
  端到端锁，rfc138 专属用例随 collapse 一并退役。
- **多人树纪律**：并行 session 已占 RFC-161；本 RFC 用 162。各 PR 按精确路径提交、不扫他人改动
  （[feedback_shared_index_commit_race] / [feedback_dont_delete_others_code_for_ci]）；`STATE.md` /
  `design/plan.md` 只增本 RFC 行。

## 验收清单

- [ ] AC-1 self 与 default-cross 逐字同构（同代码路径）
- [ ] AC-2 增派上游 → 从上游起跑 + 级联重跑提问节点 + 两处各注入自己那份 + 提问节点产出
- [ ] AC-3 改派下游 → 提问节点仍起跑 + 级联下游
- [ ] AC-4 起跑前沿实时计算；并行多起跑无 strand/无漏注入
- [ ] AC-5 全仓无 scope/role 控流、无 echo/collapse（**相关性就绪 barrier 保留、不删**）
- [ ] AC-6 迁移无损：存量不丢问题/答案/不误触发
- [ ] AC-7 门禁四项 + binary smoke + 前端 vitest + 各 PR 实现门
- [ ] Codex 设计门（本 RFC 落档后）
- [ ] `STATE.md` / `design/plan.md` 更新 + RFC-160 标 Superseded

## 风险与回滚

- 最高风险 = T2（dispatch 语义换血）与 T5（迁移）。缓解：T2 先与旧行为对拍黄金锁（default 组逐字
  不变）再放开；T5 只映射「未来怎么看」、不动已 mint 的执行事实。每 PR 独立可回滚（结构收口 PR 不
  删任何东西，删除 PR 在结构就位后才动）。
- inline-resume 微差（提问节点级联重跑=全新 session）为有意行为，测试锁双态；若用户反对，可加「提问
  节点级联重跑亦走 inline-resume」的兜底（后续微调，不阻塞主线）。
