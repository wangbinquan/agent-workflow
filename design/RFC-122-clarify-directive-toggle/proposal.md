# RFC-122 — 任务画布「继续反问 / 停止反问」开关

状态：In Progress（实现已落、Codex impl-gate 收敛中）
触发：2026-06-28 用户「在任务运行界面，给所有反问节点增加可点击的开关，显示当前反问是要求继续反问还是停止反问，可点击切换；agent 未执行则执行到时以开关为准；agent 错误重试则重试新启 run 也以最新状态为准」+「这个反问节点反问包括同节点反问和跨节点反问」+ AskUserQuestion 拍板「开关放在提问的 agent 节点上」。

## 背景
平台的「反问（clarify / ask-back）」有两条：**同节点反问**（RFC-023 self-clarify，agent 自带 `__clarify__` 通道，向人提问后据答续作）与**跨节点反问**（RFC-056 cross-clarify，反问者 agent 审计上游设计者产出、经人裁决）。二者都由**提问的 agent 节点**在 dispatch 时决定是否「强制 ask-back」。

现状下，「让某反问节点这一轮**别再反问、直接干**」只能作为**回答某反问 session 时附带 `directive='stop'`** 的副作用（RFC-056 `hasPersistentStop`）触发——没有一个**独立、运行期、可直接点的开关**让人在任务画布上对任意提问 agent 节点预设/切换「继续 vs 停止反问」。

## 目标
- 在**任务运行画布**上，给每个**提问的 agent 节点**（self-clarify 通道 OR cross-clarify 反问者）加一个**可点击的 `继续反问 / 停止反问` 开关**，显示当前态、点击切换。
- 覆盖**同节点 + 跨节点**两类反问（同一开关、同一 `__clarify__` 口）。
- **运行期生效**：节点**尚未执行**→ 执行到时以开关为准；agent **错误重试**→ 重试新启 run 以**最新**开关为准（调度器在 dispatch 时读，未跑节点与 retry 天然取最新）。
- `停止反问` = runner 不追加强制 ask-back 协议块、改注入 `### User directive: STOP CLARIFYING`，agent 直接产出。`继续反问`（默认）= 现行为。

## 非目标
- 不改反问本身的协议 / XML envelope / 裁决流程。
- 不做「跨 session 持久策略」或「agent 级默认开关」——本开关是**每(任务,节点)**粒度、运行期。
- 不删除既有 `hasPersistentStop`（回答 stop 仍持久停）——本开关与之**并行**、显式开关优先。

## 用户故事
1. 我启动了一个任务，看到画布上某 reviewer agent 会反问。我**提前**把它的开关点成「停止反问」——它执行到时就直接干、不再问我。
2. 某设计者 agent 反问了我、我答了，但下游又触发它重跑；我把它的开关点成「停止反问」——重跑不再反问。
3. 某 agent 执行报错、框架自动重试；我在重试前把开关切了——**重试这一 run 以我最新的开关为准**。

## 验收标准
- [ ] 提问 agent 节点（self 或 cross-questioner）画布上有可点击 continue/stop 开关；非提问节点无。
- [ ] 切「停止」后该节点 dispatch（首跑/重试）→ promptText **不含**强制 ask-back、**含** STOP CLARIFYING；切「继续」→ 含 ask-back。
- [ ] 同节点 + 跨节点两类都受控（单一 `effectiveHasClarifyChannel` 门）。
- [ ] retry 新 run 读**最新**开关（非缓存旧值）。
- [ ] **golden-lock**：无开关记录 ⇒ 与 RFC-122 前**逐字一致**（self + cross）。
- [ ] 归属（`set_by` 用户 id）只入审计/UI、**绝不进 prompt**。
- [ ] route 成员门控 + 仅提问 agent 节点可设。
