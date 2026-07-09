# RFC-162 反问机制完全归一（一条问题挂一组处理节点 · 最前节点起跑 + 级联）

状态：Draft

## 背景

用户 2026-07-09 一路追问「跨节点反问和同节点反问在问题列表里的表现为什么还是不一致」，逐步逼出
一个更根本的诉求：**「这次一定要完全归一掉，不要再还是两套逻辑了。」**

在澄清过程中，用户提出并逐步精确化了一个统一模型（本 RFC 的核心）。中途我一度以为「完全归一」
与「保留上游修订能力」互斥，被用户纠正——两个并行调研（见 `design.md §调研依据`）验证了用户是
对的：

1. **self 与 cross 早已共用绝大半骨架**：同一条 raise、同一提交入口、同一 `reconcile`、同一
   `dispatch`、同一注入器。`roleKind='self'` 与 `'questioner'` 就是同一个角色（都 home=提问节点、
   都「带答案重跑产出」）。**唯一真分叉**是 cross 会额外按 `scope=designer` 造一条 designer 条目。
2. **注入层已经是归一的**：`selectAgentQueue`（`clarifyQueue.ts:82-109`）已是「任何节点重跑时一把
   query 出所有 target==本节点的问题条目、不分角色」（源码原话：*"Every role selected in ONE
   query… no per-role SELECT fork"*）。
3. **提问节点必然重跑不是问题、是自解**：用户指出「下发时按下发问题列表在图里找最前节点起跑、级联
   往下」——提问节点要么本身最前、要么在最前节点下游，级联一定重跑到它，**不存在 strand**（这否定
   了我先前「改派上游会 strand 提问节点」的担心）。

## 核心模型（用户拍板）

- 一条问题 = 挂在一组**处理节点**上；默认这组只有一个 = **提问节点自己**。
- 「让上游修订」= 把上游节点**加进这组**（提问节点仍留在组里、保留自己那份 Q&A）。改派下游同理。
- **下发时**：看这组处理节点、在工作流图里找**最前（最上游）那个**，从它起跑；级联（RFC-074
  freshness）自然往下重跑其余处理节点（含提问节点）。起跑点按当前下发列表**实时算**。
- 每个被重跑的处理节点，自动领到它那份「问题 + 答案」（= 现有 `selectAgentQueue`，不分角色）。

一句话：**self 就是「这组只有提问节点自己」的 cross。** 两者不再有任何机制/表现差异。

## 目标

1. **一套 clarify 逻辑**：self / cross 会师到一套 `reconcile`（一条问题一组处理节点）+ 一套
   `dispatch`（最前节点起跑 + 级联）+ 已经统一的注入器。
2. **删除「两套逻辑」的全部 cruft**：`scope` 枚举、`self/questioner/designer/echo` 角色动物园、
   echo（RFC-134）、两个 collapse（RFC-138/140）、`crossClarifySessions` 的 scope 分叉。
3. **上游修订能力不丢**：由「把上游加进处理组」表达；dataflow 上下游顺序由「最前起跑 + 级联」天然
   解决。**N:1 多源就绪（多反问者→同设计者）仍需保留**——它是 `to_designer` **相关性**关系（非
   dataflow，级联看不见），`evaluateDesignerRerunReadiness` 保留并 reframe 为「相关性就绪 barrier」
   （详见 `design.md`），**只删 scope/role 驱动的 designer 控流，不删 barrier 本身**。
4. **看板归一**：问题清单对 self/cross 一视同仁——一条问题一张卡、卡上一组处理节点（默认提问节点、
   可增删）。

## 非目标

- 不改 `<workflow-clarify>` 的 raise 协议本身（runner 对两者本就一视同仁）。
- 「未答问题错误显示『加入待下发』」是独立 bug（`collapseDesignerEntryToQuestioner` seal 归一化缺
  answered 守卫），**已单独修复**（`rfc138` 回归用例），不属本 RFC；本 RFC 删掉 collapse 后该修复点
  随之消失（其回归意图迁移到新一套 dispatch 的测试里）。
- RFC-160（cross 默认翻 questioner）被本 RFC **取代**（其目标由归一后的「默认组只有提问节点」自然
  达成）。
- 保留「改派」入口（用户 Q1 维持现状）——但其语义在归一模型里变为「增/减/移处理节点」，见
  `design.md §改派语义`。

## 用户故事

1. 工作流 `B 写代码 → A 审代码`。A 审到一半提问（`<workflow-clarify>` 代替产出）→ A 卡住、下游等
   A。人答完 → 默认这条问题只挂 A → 从 A 起跑、A 带答案重跑出审查结论。与 self 逐字一致。
2. 人认为该答案意味着「B 的代码要改」→ 把 B 加进这条问题的处理组 → 下发时最前是 B → 从 B 起跑、
   B 带答案改自己的产出 → 级联重跑 A（A 领到自己那份 Q&A、审查改后的代码）。这就是「上游修订」，
   无需 scope/designer 概念。
3. 看板上，self 和 cross 的卡片长得完全一样：问题标题、一组处理节点（可点开增删）、答案回显、
   下发按钮——无任何 self/cross 特异 UI。

## 验收标准

- **AC-1**：一条 self 反问与一条「处理组只有提问节点」的 cross 反问，`reconcile` 产出的条目结构、
  `dispatch` 行为、注入内容**逐字一致**（同一套代码路径）。
- **AC-2**：把上游节点加进处理组 → 下发从上游起跑、上游带答案重跑改产出、级联重跑提问节点并注入其
  Q&A、提问节点产出（= 旧 `scope=designer` 的效果，无 scope/designer 条目）。
- **AC-3**：改派到下游节点 → 起跑点仍是提问节点（它最前）、级联重跑下游处理节点并注入其 Q&A。
- **AC-4**：起跑点由「当前下发处理组在图中的最前节点」实时计算；多个互不依赖的处理节点 → 各自为
  起跑点、都重跑、都注入（无 strand、无漏注入）。
- **AC-5**：删除后全仓无 `scope`（clarify 语境）、无 `roleKind` 的 self/questioner/designer/echo 分
  支、无 echo/collapse 代码路径、无 `crossClarifySessions` 的 scope 列消费。**但相关性就绪 barrier
  （`evaluateDesignerRerunReadiness` reframe）保留**——AC-5 只删 scope/role 驱动的 designer 控流，
  不删就绪 barrier 本身。
- **AC-6**：迁移——存量 cross 轮的 questioner/designer/echo 条目与 scope 无损映射到「处理组」模型；
  存量看板不丢问题、不丢答案、不误触发。
- **AC-7**：门禁四项 + binary smoke + 前端 vitest 全绿；Codex 设计门 + 各 PR 实现门。
