# RFC-138 改派给提问节点只跑一遍（designer 条目退化为反问者 scope）

状态：Draft（待用户批准）
触发：2026-07-03 用户「我怕把跨节点反问的问题指定给提问题的节点后，提问题的节点收到了 2 遍问题」→ 机制核查确认成立 → 用户「走 RFC：改派给提问节点时只跑一遍」。

## 背景

跨节点反问（cross 轮）的每个问题在回答后产生两类承接条目（`reconcileDesiredEntries`，
`packages/shared/src/task-questions.ts`）：

- **questioner 行**（恒有）：目标 = 提问节点。「阻塞-产出型」续跑——提问节点因反问而中断，
  答案回来后必须 mint 一条真实 rerun（cause `cross-clarify-questioner-rerun`）把它复活。
  stop 轮 / 全「反问者」scope 轮没有任何 cascade 兜底，这条 mint 是唯一复活通道。
- **designer 行**（该题 seal 后且 scope=designer 时）：目标 = 设计节点。「修订型」，可改派
  （RFC-120/127/131），下发 mint cause `cross-clarify-answer` 的修订 rerun。

RFC-134 定义了改派不变量的一半：**有效承接 ≠ 提问节点 → echo 回执补投递**；并把 designer
行显式豁免出 echo（「designer 由既有 questioner 条目天然满足不变量」）。**另一半——有效承接
== 提问节点时的去重合并——从未被任何 RFC 定义**。于是把 designer 行改派给该轮提问节点时：

1. questioner 行照常 mint 续跑（cause `cross-clarify-questioner-rerun`）；
2. designer 行也要在同一节点 mint 改派 rerun（cause `cross-clarify-answer`）；
3. 一条 node_run 只能带一个 rerun_cause——auto-split（`taskQuestionDispatch.ts` §4b）+
   in-flight 门 + 双账本守卫（`task-question-borrow-ledger-conflict`）强制两批**串行成两条
   rerun**。

结果：提问节点把**逐字相同的 Q&A 处理两遍**。注入层其实早已就绪（`selectAgentQueue` 按
effectiveTarget 全量选取 + RFC-134 D9 同题去重渲染，`clarifyQueue.ts`），缺的只是 dispatch
层的合并规则。

叠加 RFC-137 把集中回答面板的逐题 scope 选择器移除（跨节点默认 designer、面板不发
`questionScopes`），「这题让提问节点自己消化」在面板路径上**只剩改派 designer 条目这一条
通路**——缺口因此暴露。三个 RFC（127/131 move 改派、134 designer 豁免、137 面板去 scope）
各自边界内自洽，问题落在缝里。

## 目标

1. 把跨节点反问 designer 条目改派给**该轮提问节点**时，提问节点**只跑一遍**、同一题 Q&A
   只投递一份。
2. 集中面板用户经「处理节点 = 提问节点」获得与 `/clarify` 详情页 scope=「反问者」**完全等价**
   的表达力（RFC-137 D4 的兜底通路补完）。
3. 改派后该题脱离「整轮单处理节点」约束：同轮其余题照常发给设计节点，不再整轮 409
   `task-question-round-multi-target`。

## 非目标

- **默认流程的两次运行不动**：designer 修订完成后 cascade 使提问节点按新上游重跑——那是修订
  传播，不是重复投递，不在本 RFC 范围。
- **已下发条目不追溯**：dispatched 后重定向仍是 reopen 的职责（现状边界，`task-question-already-dispatched` 不变）。
- **不恢复集中面板 scope 选择器**（不回滚 RFC-137）；`/clarify` 详情页 scope UI 不动。
- **不改 echo 机制**（RFC-134 规则、designer 豁免、序列化豁免全保留）。
- self 轮条目、manual 条目、questioner 行的改派语义不变（仍走 RFC-127/131 move + RFC-134
  echo 补投）。
- 改派给提问节点**以外**节点的 designer 行为逐字不变（golden-lock）。

## 方案（选定机制：退化为反问者 scope）

改派请求满足「条目是 cross 轮 designer 行 **且** targetNodeId == 该轮提问节点
（`clarify_rounds.asking_node_id`）」时，不写 `override_target_node_id`，而是**语义等价于
把该题 scope 事后改为 `questioner`**，单事务完成：

1. `clarify_rounds.question_scopes_json[qid] = 'questioner'`（merge-write，保留其他题），
   并按 RFC-058 lockstep 双写 `cross_clarify_sessions.question_scopes_json`；
2. 删除该题**未下发**的 designer 行（含其 staged 覆盖层——用户显式操作，丢弃是本意）；
3. 该题的 questioner 行（恒有、目标=提问节点）成为唯一承接——天然只有一条续跑 rerun，
   Q&A 恰好一份。

reconcile 因 scope=questioner 不再 desire 该题 designer 行（不复活）；重答（RFC-136）reseal
按 D6 忽略客户端 scope，翻转值保持。

### 已否决的替代方案（留档）

- **A′ designer 行并入 questioner 批共用一条 rerun**：保留独立 designer 卡（可单独确认），
  但需改 `causeClassForEntry`、双账本守卫、整轮单目标守卫三处高危并发面；渲染面与本方案
  等价（D9 已去重）。复杂度/回归面显著更高，收益仅是多一张看板卡。
- **C′ 禁止改派给提问节点 + 引导去详情页选 scope**：改动最小，但集中面板路径体验最差、
  答完后（scope 已定）无法补救。

## 用户故事

1. 我在问题看板 / 反问页把某跨节点问题的处理节点选成提问节点：该题的 designer 卡消失、
   questioner 卡照常；下发后提问节点只出现一条带该题 Q&A 的续跑，不再有第二条同内容 rerun。
2. 我在集中面板答完题后想让提问节点自己消化某题：改处理节点为提问节点即可，效果与详情页
   选「反问者」一致。
3. 同轮 q1 改给提问节点、q2/q3 留设计节点：下发不 409；设计节点的修订 rerun 只含 q2/q3 的
   Q&A（q1 不进设计者反馈——与 scope=questioner 既有语义一致）。

## 验收标准

- AC-1 collapse 正路径：cross designer 行改派到提问节点 → 该 designer 行删除、两表 scope
  翻转一致、questioner 行零变化；响应 `action='collapsed-to-questioner'`。
- AC-2 单次投递：collapse 后走完「答→下发」，提问节点仅 mint 一条续跑 rerun；
  `buildClarifyQueueContext` 对该题恰渲染一次。
- AC-3 混轮下发：q1 collapse、q2 留设计节点 → 下发成功无 multi-target 409；设计节点注入
  只含 q2。
- AC-4 golden-lock：改派到第三节点（非提问节点）仍写 override、不删行、不碰 scope，
  行为逐字不变；echo 机制不受影响。
- AC-5 边界拒绝：已下发 designer 行改派仍 409 already-dispatched；self 轮 / manual 条目
  不触发 collapse 分支。
- AC-6 不复活：collapse 后任意次 reconcile / 重答（RFC-136 reseal）不再生成该题 designer
  行，scope 保持 `questioner`。
- AC-7 前端：处理节点选择器选提问节点 → 成功反馈明确告知「该题改由提问节点承接」；
  看板 / 反问页失效刷新后该题 designer 卡消失。

## 决策记录（待批准时可整体否决或逐项改）

- **D1 机制 = scope 退化**（推荐方案；用户确认前本 RFC 不进入实现。替代 A′/C′ 见上）。
- **D2 适用边界 = 仅未下发**：dispatched 后走既有 reopen 语义，本 RFC 不扩展。
- **D3 一次性操作**：collapse 后该题不提供「翻回 designer」入口（questioner 行本身仍可按
  RFC-127 move 改派；如需重新给设计节点，走 reopen / 手动问题）。
- **D4 审计走日志 + 响应字段**：designer 行被删除，不在残留行上伪造 lastReassignedBy；
  `log.info` + WS 失效 + 响应 `action` 字段承载可见性。
- **D5 与 questioner 行 override 的组合不特判**：若该题 questioner 行已被 move 改派到第三
  节点 X，collapse 后该题由 X 承接 + echo 补投提问节点（RFC-134 既有语义），仍是单份投递；
  「由提问节点处理」的最终解释权归用户的后续操作。
