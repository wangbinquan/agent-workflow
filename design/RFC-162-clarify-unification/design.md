# RFC-162 技术设计

## 调研依据（两并行调研 + 自读，均 file:line 溯源）

- **raise/block（调研 A）**：runner 对 `<workflow-clarify>` 不分 self/cross——提问节点那次 run 恒
  `done` 且**零产出**（只有 `kind==='output'` 分支写 `node_run_outputs`，`runner.ts:1201-1215`）；
  `awaiting_human` 恒在**另一个中介节点**（self=clarify 节点，cross=CC 节点），不在提问节点。
  ⇒ 提问节点被卡住、必须自己补一次产出；这对 self / cross **一模一样**。
- **reconcile 是唯一真分叉（调研 A）**：`reconcileDesiredEntries`（`shared/src/task-questions.ts:99-138`）
  对 cross 恒产 `questioner`（home=提问节点）、仅 `scope==='designer'` 且已 seal 时**额外**产
  `designer`（home=图设计节点）。`self` 条目与 `questioner` 条目同义（都 home=提问节点、都
  `isClarifyRerun=TRUE`）。
- **注入已归一（自读 `clarifyQueue.ts:82-109`）**：`selectAgentQueue` 一把 query 出所有
  `dispatched_at IS NOT NULL` 且 `effectiveTarget==本节点` 的条目、**不分角色**，按 `sealed_at IS NOT
  NULL OR manual` 过滤后平铺注入。⇒「谁重跑谁领到自己那份 Q&A」已建好。
- **级联已存在（调研 B）**：RFC-074 freshness——某节点产出新 done run 后，其下游 consumer 的
  `consumed_json` 不再匹配上游 freshest ⇒ `isNodeRunFresh` 假 ⇒ 下游落 `remaining/ready` ⇒ 以
  `stale-redispatch` 重跑（`freshness.ts:54-65`、`scheduler.ts:1338-1348`、`nodeRunMint.ts:222-234`），
  且 `areTransitiveUpstreamsCompleted` 保证按依赖序（上游先 settle 才轮到下游）。
- **改派是 MOVE 非借壳（调研 B）**：RFC-131 T4 去借壳——改派到 X 在 X 自己位置、用 X 自己 agent、
  产 X 自己产出（`taskQuestionDispatch.ts:429-446, 1477-1490`，`agentOverrideName` 恒 null）。

## 统一数据模型：一条问题 → 一组处理节点

**取代** `roleKind ∈ {self, questioner, designer, echo}` + `scope ∈ {designer, questioner}` 这两个正交
枚举。改为：

- 一条 clarify 问题（由某提问节点 raise）对应**一组处理节点**（handler set）。
- **默认组 = { 提问节点自己 }**（对 self 与 cross 都一样；cross 的图设计节点**不再默认进组**——达成
  RFC-160 目标）。
- 每个处理节点 = 一条 `task_questions` 行。**⚠️ 身份键分三相迁移（Codex 设计门 critical-1 + R4/R5
  分阶段）**——现唯一键 `(origin_node_run_id, question_id, role_kind)`（`schema.ts:1878-1883`）+
  reconcile upsert 在该键（`taskQuestions.ts:213-241`）。**`role_kind` 收敛为单值** 与 **「提问节点
  + 增派上游」多 handler** **不能与旧键并存**（同键撞覆盖）。故**绝不在一步内既收敛 role_kind 又切
  键**，严格按三相：
  1. **准备相（T3）**：加**非唯一影子列** `handler_node_id` 并 populate（= 有效承接
     `override ?? default`）；旧 `role_kind` 唯一键与 role-based 发射**照旧、行为不变**（黄金锁）；
     reconcile/dispatch 分组**读** `handler_node_id`，但**不收敛 role_kind、不发多 handler**。
  2. **切换相（T5，原子）**：碰撞矩阵解决/park 存量后，**原子**把唯一键 old→`(origin_node_run_id,
     question_id, handler_node_id)`、`role_kind` 出键。
  3. **归一相（T5 之后）**：reconcile 切「一问一组处理节点」发射 + `role_kind` 收敛单值 + 删
     echo/collapse/scope + 前端处理组编辑——**均在切键之后**，此时多 handler 有新键承载、不再撞。

  `handler_node_id` = 该 handler 的**稳定节点**（默认=提问节点、增派=上游/下游）；原
  `override_target_node_id` 语义并入「handler 行的稳定节点」，改派/增派 = 增删 handler 行（见
  §改派语义）。
- **提问节点恒在组内**（它必须补产出，不可移除，见 §改派语义）。「增派上游」= 新增一行 handler，
  `handler_node_id = 上游节点`。

## reconcile 归一

`reconcileDesiredEntries` 从「self→1 条；cross→questioner 恒 + designer 条件」改为：

```
一条 seal 的问题 → 该问题当前处理组的每个节点各一条 desired 条目
默认组 = { askingNodeId }        // self 与 cross 同
额外处理节点（人工增派）= 从持久层（override/新增行）读回，不再从 scope 推导
```

- 删掉 `ReconcileRoundInput.scopes` 与 `CLARIFY_QUESTION_SCOPE_DEFAULT` 的 reconcile 消费。
- `directive='stop'` 语义保留（stop 轮不产设计者重跑）——归一后表达为「stop 轮处理组不含上游节点」。
- self/cross 走同一分支：`kind` 仅用于「默认组解析」（self 的 asking = cross 的 questioner = 提问
  节点），不再产生结构差异。

## dispatch：最前节点起跑 + 级联（本 RFC 的新机制）

**取代** 现「逐个处理节点直接 mint」+ 多源就绪 gating。新算法：

1. 收集这批被下发问题的处理组条目及其 `effectiveTarget` 节点。
2. **相关性就绪 barrier = 预-stamp 门（Codex 复评 H-2）**：过滤掉相关源未就绪的 handler（N:1
   designer 等其兄弟反问者答齐前）。**未就绪 handler 一律不 stamp `dispatched_at`、保持 queue-不可
   见**——否则即使不进前沿，上游级联触达它时 `selectAgentQueue`（只认 dispatched+sealed）仍会**提前
   注入、绕过 barrier**。只有过 barrier 的就绪 handler 集 R 才 stamp。
3. 对 R 标 `dispatched_at`（使 `selectAgentQueue` 可见）；收集 R 的 `effectiveTarget` 集合 S。
4. `computeDispatchFrontier(S, graph)` 取**最前沿子集** F（无被 S 中其它节点作祖先者，可多起跑点）。
5. **仅对 F mint 重跑**；F 的下游**就绪** handler 由 RFC-074 级联重跑（未就绪的没 stamp、不会被误
   注入，待其源就绪的后续下发再纳入）。
6. 每个重跑的 handler 经 `selectAgentQueue` 领到 target==自己的 Q&A。

好处：
- **提问节点必然重跑**：它要么 ∈ F（默认组仅它时，它就是起跑点），要么在某上游处理节点下游（增派
  上游时）→ 级联到它。**无 strand**（否定先前担心）。
- **顺序（dataflow 天然、相关性 barrier 保留）**：dataflow 上下游顺序由级联天然解决（上游先改、
  下游后跑）。**但 N:1 多源就绪不能删（Codex 设计门 high-3）**：多个反问者→同一设计节点的「等齐全
  部反问者答完再重跑设计者」是**相关性**关系——`to_designer` / `__external_feedback__` 是
  `dataflow='never'`（`systemChannelPorts.ts:72-80`）、scheduler 构 upstream 时**跳过**这些通道边
  （`scheduler.ts:6219-6228`），级联/前沿**看不见**它。故 `evaluateDesignerRerunReadiness`
  （`taskQuestionDispatch.ts:514-525` + `crossClarify.ts:339-345` 扫同 designer 的兄弟源）**不删、
  保留并 reframe 为「相关性就绪 barrier」**：一个 handler 节点在其全部相关源就绪前**不进起跑前沿**
  （`computeDispatchFrontier` 的输入 = 已过 barrier 的 handler 集）。N:1 测试（一源已答一源待答 →
  designer 不起跑）必写。
- **一批多问题多目标**：F 可含多个互不依赖起跑点，各自起跑、各自级联，`selectAgentQueue` 分别注入。

「最前节点」纯函数化为可断言 oracle（`computeDispatchFrontier(handlerNodeSet, graph) → startNodes`），
over 工作流 DAG 的祖先关系；单测覆盖上游/下游/并行/环防护。

## 注入（已归一，基本不动）

`selectAgentQueue` 已按 target 平铺、不分角色（`clarifyQueue.ts:82`）。归一后所有条目 `role_kind`
同值，天然通过。唯一收尾：删掉 `AgentQueueEntry.roleKind` 等下游对角色的读取（若有）。

## 改派语义（用户 Q1「维持现状」在归一模型下的落点）

- 「改派」入口保留，但语义从「移动唯一处理节点」变为**「编辑处理组」**：
  - **增派上游/其它节点**：往处理组加一个节点（新增一行，`default=该节点`）。
  - **提问节点不可移除**：它必须补产出；UI 上提问节点那一项固定在组内（可增派他者、不可删己）。
- 这消解了旧 echo/collapse 存在的根因：echo 是「承接移离提问节点后给它补 Q&A」——归一后提问节点
  **恒在组内、恒有自己那份**，无需补；collapse 是「designer↔questioner 双卡撞同节点去重」——归一后
  一条问题一组节点、同节点天然只一行，无双卡可撞。**echo/collapse 整体删除。**

## 重跑 cause 归一（Codex 设计门 high-4）

现 cause 由 `roleKind`/`sourceKind` 派生（`clarifyRerunLedger.ts:28-38`），scheduler inline 模式读
`node_runs.rerun_cause`（`scheduler.ts:2588-2595`）。roleKind 剔除控流后需一个**无角色 cause
oracle**，按 `(来源轮 kind, 该 handler 是否提问节点, 是否级联触达)` 派生：

- 提问节点 handler · self 轮 → `clarify-answer`（`isClarifyRerun=TRUE`，inline-resume）。
- 提问节点 handler · cross 轮 → `cross-clarify-questioner-rerun`（`isClarifyRerun=TRUE`）。
- 非提问节点 handler（增派上游/下游、作起跑前沿）→ `cross-clarify-answer`（update 模式改自己产出，
  `isClarifyRerun=FALSE`）。
- 被级联触达的下游 clarify handler（含提问节点被上游级联到）→ **专属 clarify cause（新增
  `cross-clarify-cascade`，纳入 `NEW_CLARIFY_TRIGGER_CAUSES`）**（`isClarifyRerun=FALSE`，全新
  session，见 §inline-resume）。**不可用泛型 `stale-redispatch`（Codex 复评 H-3）**——它不在
  `NEW_CLARIFY_TRIGGER_CAUSES`、ledger 无法据它给该 handler 的 lineage 封顶，后续同节点无关
  stale-redispatch 会被误并进同一 handler lineage（已处理题诈复活/阻塞后续下发）。机制：dispatch/
  scheduler 识别「本次 stale 级联重跑的节点带 pending clarify handler」→ stamp 该专属 cause 并纳入
  ledger lineage 上界集。

替换 `causeClassForEntry` 的 roleKind 读取；棘轮测试锁「default self→`clarify-answer` /
default cross（组只提问节点）→`cross-clarify-questioner-rerun`」逐字不变（AC-1），且注入器/账本
（`NEW_CLARIFY_TRIGGER_CAUSES`、`isDispatchedEntryConsumed`）对新 cause 集一致。

**相位（Codex 复评 R6）**：此无角色 oracle **只能在归一相（T5、role_kind 收敛之后）切换**——准备相
（T3）若替换它，存量**被改派**的 questioner/self 行会从 role 派生 cause 切成 handler 派生 cause
（inline-resume/ledger 上界/auto-split 全变），破坏 T3 黄金锁。故 T3 保持 `causeClassForEntry` 原样，
oracle 随 role 收敛在 T5 一并落地。

## inline-resume 细节（需实现门确认的行为微差）

- 现状：提问节点的 clarify 重跑 `isClarifyRerun=TRUE` → inline-resume 同一 opencode session
  （`scheduler.ts:2588`）。
- 归一后：提问节点**作为起跑点**（默认组）时仍是 clarify 重跑 → inline-resume 不变（self 与
  default-cross 逐字一致）。提问节点**被级联重跑**（增派了上游）时走 `cross-clarify-cascade`
  （`isClarifyRerun=FALSE`）→ 全新 session。
- 判定：这是**有意且更正确**——上游已改产出，提问节点应基于「改后的上游产出 + 该题 Q&A」重新评审，
  而非续接旧 session。design 明记；测试锁两态。

## 删除清单（AC-5）

- `scope`（`ClarifyQuestionScope`、`CLARIFY_QUESTION_SCOPE_DEFAULT`、`question_scopes_json` 的控流
  消费、详情页 scope picker）。
- `role_kind` 的控流分支（self/questioner/designer/echo 判定）；值收敛为单一展示标签。
- echo（RFC-134）：`planEchoEntries`、echo 物化、echo 专属守卫豁免。
- collapse（RFC-138/140）：`collapseDesignerEntryToQuestioner`、`collapseQuestionerEntryToDesigner`
  及其路由分支、专属错误码。
- ~~多源就绪 gating~~ —— **保留**（Codex 设计门 high-3 reframe 为「相关性就绪 barrier」；级联只看
  dataflow、看不见 `to_designer` 相关性边，不能取代它）。不在删除清单。
- `crossClarifySessions` 的 `question_scopes_json` 分叉；评估 `clarifySessions` /
  `crossClarifySessions` 两表能否合并为一张 clarify 轮表（RFC-058 lockstep 双写的存在理由随 scope
  消失而弱化——**留待实现门评估，非本 RFC 强承诺**，避免过度扩张）。

## 迁移（AC-6）

migration（journal +1）把存量映射进新模型：

- 每条存量非-echo 行 → 一条 handler 行、**`handler_node_id = override_target_node_id ??
  default_target_node_id`（有效承接，Codex 复评 C-1）**——存量 self/questioner/designer 行**可能已被
  改派**（`override` 非空），按 role→default 推会丢用户已提交的路由（甚至丢改派目标 B、双建提问
  节点 A）。以**有效承接**建 handler，`scope=questioner` 的问题自然只得提问节点这一组员。
- **同一 `handler_node_id` 多行折叠 = 「碰撞矩阵」（Codex 复评 C-1 + R3-H）**：多条存量行折叠到同
  一有效节点时（典型：questioner `override=B` 与 designer `default=B`），**它们可能是两条不同
  cause/`trigger_run_id` 的执行事实**（`cross-clarify-questioner-rerun` vs `cross-clarify-answer`，
  auto-split 本就按 cause 串行、不合并），一行 handler **表示不了两个执行事实**，硬合会丢一条
  在途/已完成 rerun 或诈标 resolved（违背「不改已下发/已完成事实」）。故按矩阵分治：
  - **至多一行已下发/已绑定** → 安全合并，保留该行 `dispatched_at`/`trigger_run_id`/`sealed_at`/
    `staged_at`/`confirmation`。
  - **多行已绑定但同 `trigger_run_id` + 兼容态** → 合并（等价执行）。**兼容态**定义：`sealed_at`
    空/非空一致、`staged_at` 一致、`confirmation` 一致。**字段优先级**（合并取值）：已下发/已绑定 >
    未下发；已 seal > 未 seal；`confirmed` > `open`（保最强已成事实，绝不回退）。
  - **多行异 `trigger_run_id`/cause 且均已下发** → **不合并**：暂留归档/兼容表示直到两执行 drain，
    或 park 迁移 + 显式补救路径（不静默丢）。
  迁移测试锁：questioner override=B + designer default=B 异 trigger、dispatched+staged 混态、
  awaiting_confirm、partial-seal 各一格。
- 存量 `echo` 行（**Codex 设计门 critical-2：不可当冗余删**）：collapse-to-designer 会删掉
  questioner 行、只留 designer + echo（`taskQuestions.ts:1349-1358, 1419-1439`），此时 **echo 就是
  提问节点的答案投递与重跑义务**。迁移把**每条 echo 转成一条提问节点 handler 行**
  （`handler_node_id = 提问节点`，保留其 `sealed_at`/`dispatched_at`/`trigger_run_id`/`confirmation`/
  `staged_at` 状态），再退役 echo 语义 —— 无 questioner 行的历史 collapsed 题据此复原提问节点
  handler，答案投递不丢。
- `question_scopes_json`：迁移后不再被读；列可保留（审计）或清理。
- **不改变存量已下发/已完成条目的执行事实**（已 mint 的 run 不动）；仅统一「未来 reconcile/dispatch
  怎么看这些问题」。存量看板不丢问题/答案（AC-6 回归锁）。

## 失败模式

- **F1 增派节点非提问节点的图上游也非下游（并行）**：F 含它与提问节点两个起跑点，各自跑、各自注入；
  它的产出若无边到提问节点则不级联到 A——但 A 自己已作为起跑点跑过、已注入、已产出，**不 strand**。
  「并行节点改后是否该让 A 再看一眼」不是 clarify 的职责（无 dataflow 边就无级联，符合 DAG 语义）。
- **F2 环/畸形图**：`computeDispatchFrontier` 有界防环（同 `partitionDesignerQuestionsByTarget` 纪律）。
- **F3 提问节点被级联重跑 = 全新 session**：见 §inline-resume，有意行为、测试锁。
- **F4 迁移把历史 echo 删了但用户以为还在**：echo 本是只读知会、其内容已由提问节点自身那份覆盖；
  迁移说明 + STATE 记录。

## 测试策略（必写）

- **shared**：`computeDispatchFrontier` 纯函数矩阵（上游/下游/并行/多起跑/环）；归一后
  `reconcileDesiredEntries`（self 与 default-cross 逐字同构；增派上游=处理组含上游）。
- **backend**：dispatch「最前起跑 + 级联」端到端（增派上游→从上游 mint→级联重跑提问节点→两处
  注入各含自己那份→提问节点产出）；改派下游→提问节点仍起跑；一批多目标多起跑；迁移映射（questioner/
  designer/echo/scope → 处理组，存量不丢）；删除后的棘轮源码锁（无 scope/role 控流/echo/collapse）。
- **frontend**：统一卡片（self/cross 同形、无 scope picker）；处理组增删（提问节点不可删己）。
- **门禁**：typecheck/lint/test/format + binary smoke + 前端 vitest；各 PR 独立门禁。
