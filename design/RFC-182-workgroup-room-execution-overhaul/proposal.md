# RFC-182 聊天室执行体验总体重设计——统一回合卡 + 会话历史 + 状态一致 —— proposal

## 1. 背景与问题

用户 2026-07-14 走查聊天室（工作组任务主视图 `WorkgroupRoom`）三点反馈：

> 1. 「运行中的标签不可以点进去显示详细 session 执行记录，并且 session 执行完之后就从聊天室消失了，这体验太差劲了。」
> 2. 「为什么 agent 在执行的时候，agent 还是显示空闲的标签？」
> 3. 「重新审视聊天室的交互设计，让聊天室的执行、session 历史、显示体验、交互都达到完美水平。」

### 1.0 与 RFC-179 的关系（状态勘误 + supersession 声明）

RFC-179 的文档/索引仍标 Draft，但其代码已**全部落库**（PR-2 `c8f095c5` 花名册成员可点看当前 session、PR-3 `7ba1c0c6` 提及 pill + 流内活跃行；实时刷新补丁 `f55ede4b`）。本 RFC 站在其落地代码之上继续演进：

- **推翻 RFC-179 D1 与 render②**（用户本次拍板）：「只看当前会话、房间流即历史、不做多回合历史列表」「活跃行跑完即消失」→ 由统一回合卡 + 双历史入口取代。RFC-179 §7 自己预留的「逐成员多回合历史」后续项即本 RFC。
- **保留复用其全部其余交付**：成员/leader 可点（`WorkgroupRoom.tsx:482-493`）、`memberRuns` 后端单源派生（`services/workgroupRoom.ts:114`）、提及「执行中」pill（`:743-747`）、shardKey 解析封装后端的边界（前端不 parse）。

### 1.1 根因链（已核对 HEAD=`f55ede4b` 源码）

1. **运行中标签不可点**：流内活跃行（`WorkgroupRoom.tsx:306-320`）与提及 pill（`:743-747`）都是 `StatusChip`——纯 `<span>`、无 onClick（`components/StatusChip.tsx`）。而查看器与接线机制齐备：`NodeDetailDrawer`（Session/Events/Output/Stats 四 tab）挂载在 `:661-677`、`setDrawerRunId` 打开第三列。缺的只是把指示器变成入口。
2. **跑完即消失**：`streamActiveExecutions`（`lib/workgroup-room.ts:142-154`）与 `mentionExecutingPills`（`:161-180`）都只认 `status==='running'`；被 @ 轮（wg-message-turn）与 leader 轮（wg-leader-round）**不产生任何持久卡片**（只有 assignment 轮有 `DispatchCard`，`WorkgroupRoom.tsx:883-892` 的「查看执行现场」）→ 跑完后流内零入口。后端 `memberRuns` 每成员只保留一条（running 优先否则最新终态，`services/workgroupRoom.ts:86-92`）→ 成员再跑一轮，上一轮从房间**彻底不可达**。而 `node_runs` 行与事件数据本身**永久保留**（后端无任何归档/清理；transcript/events/stdout API 俱在）——数据都在，纯 UI 触达缺失。
3. **执行中显示空闲**：花名册忙/闲芯片用 `memberIsWorking`（`lib/workgroup-room.ts:115-122`，只统计 running/dispatched 的 **assignment**）（`WorkgroupRoom.tsx:476`），而同屏三行之下 `:479` 的 `currentRun` 来自另一数据源 `memberRuns`——leader 轮 / 被 @ 轮执行时芯片恒显示「空闲」，与执行中 pill **同屏自相矛盾**。`f55ede4b` 只修了 `node.status`→房间失效的刷新延迟，没有修这个数据源错配。
4. **次级（后端）pending 盲区**：`mintNodeRun` 只插行不发帧（`services/nodeRunMint.ts`），首帧是 `runner.ts:706-712` 的 `node.status{running}`；成员 run 在信号量（`scheduler.ts:666-677`）后排队的 pending 期间，房间收不到任何帧 → 「已唤醒但仍显示空闲」的残窗。
5. **打磨面（全面重审抽样，均已核对）**：消息流每次新消息都强制贴底（`WorkgroupRoom.tsx:183-188`），用户上翻阅读历史会被拽回底部；消息时间戳只有 `toLocaleTimeString()`（`:757`），跨天房间丢失日期；drawer 传入全量 runs（`:672`），其内部按 nodeId 归并的历史（`NodeDetailDrawer.tsx:113`）会把不同成员的 `__wg_member__` 回合**跨成员串台**。

## 2. 目标

- **G1 统一回合卡**：被 @ 轮与 leader 轮在消息流内有**持久回合卡**：pending「排队中」→ running 脉冲 + 实时耗时 → 终态**原地定格**（状态 / 总耗时 / 「查看会话」按钮），永不消失。assignment 轮维持 `DispatchCard`（不重复出卡）。
- **G2 一切运行中指示可点**：回合卡、提及 pill、花名册 presence 芯片，点击一律打开右栏 `NodeDetailDrawer` 实时会话。
- **G3 成员状态单一真相**：花名册三态 presence（执行中 / 排队中 / 空闲）由 assignments ∪ memberRuns 的**统一纯函数**派生；后端补 pending 铸造广播，排队即可见，消灭「执行中显示空闲」。
- **G4 双历史入口**：① 右栏「执行记录」时间线卡（全成员历次执行、倒序、状态 / 耗时、点击回放）；② 点成员 → drawer 内**该成员历轮**切换（成员作用域 runs，顺带修掉跨成员串台）。
- **G5 runHistory 单一事实源**：房间聚合新增全量回合列表派生 `runHistory`，`memberRuns` 改为它的投影（同源、消 drift）；shardKey 解析仍封装后端，前端只消费。
- **G6 显示与交互打磨**：滚动锚定 +「回到最新」浮标、消息时间戳跨天带日期、回合卡 / 派发卡同族视觉、a11y（新入口全部可键盘触达）。
- **G7 复用公共原语零视觉孤岛**：Card / StatusChip（最小扩展 optional onClick）/ EmptyState / 既有 drawer 与第三列布局；测试优先 role / testid。
- **G8 prompt 隔离不破 + 零 migration**：运行态数据只读展示、绝不进入任何 `compose*Prompt`；全部为派生 + 前端接线 + 一处广播，零 schema 变更。

## 3. 非目标

- **composer 键盘 / 发送快捷键**：RFC-174（Draft）承接，不吸收不重复。
- **autonomous 行为本体**：RFC-180 已落地；RFC-181（**同 owner 接管、先行单 PR 落地**）负责中途切换 / 反问硬压制 / 新建默认全自动——本 RFC 不重复其引擎语义，只负责把其收场**可视化**（D11：`clarify-suppressed` 派生标注、`awaiting_human` 等待回答态、A2 遣散后的 canceled 历史卡留痕）。`WorkgroupRoom.tsx` 触点错开（181＝mid-run 配置弹窗 Switch；本 RFC 不碰弹窗）。
- **引擎回合 / 唤醒 / mint 语义**：三类回合的铸造、shardKey 规则、assignment 状态机全部不动；本 RFC 只**读**它们 + 在 mint 后补一条广播。
- **运行中回合的取消**（running 卡取消现为 409）：引擎级能力，列入潜在后续。
- **daemon 重启 workgroup re-entry**（任务停 `interrupted`）：RFC-164 既有遗留，另议。
- **wg.\* 帧 `?since` 重放 / 未读回执 / node.event token 级房间活跃度**：现状可接受（重连靠 query 重取；`f55ede4b` 刻意不让 node.event 打房间）。
- **dynamic_workflow 模式**：无聊天室回合引擎，天然不涉。

## 4. 用户故事

- 我 @ 了 @backend 让它查一个 bug：提及消息下方立即出现一张回合卡「@backend · 被 @ 轮 · 排队中」，几秒后变「执行中 · 00:47」并脉冲；我点卡上「查看会话」，右栏实时滚动它的 opencode 对话。跑完后卡原地定格为「完成 · 3 分 12 秒 · 查看会话」——明天回来它还在那。
- leader 正在拆解任务：消息流里有一张「@leader · 领导轮 · 执行中」的回合卡；我不用去花名册找，点卡就能看它此刻的思考现场。
- @reviewer 已经跑过 4 轮：我点花名册里它的名字，右栏打开它当前会话，顶部历轮列表能切到之前任何一轮回放。
- 我想复盘今天整个房间干了什么：右栏「执行记录」卡按时间倒序列出全部 17 次执行（谁、哪类轮、状态、耗时），点任何一行直接回放。
- 一个成员被唤醒但还在排队（并发信号量占满）：花名册芯片显示「排队中」，回合卡也是「排队中」——不再是骗人的「空闲」。
- 我上翻阅读一小时前的讨论，此时新消息进来：视图不再把我拽回底部，右下角出现「回到最新」浮标，点击才回去。

## 5. 决策记录（2026-07-14 用户拍板）

- **D1 统一回合卡**（三案选 A）：被 @ 轮 / leader 轮以持久回合卡呈现，实时→定格、永不消失；提及消息上保留小 pill。（否决「轻量脚注链接」与「维持 RFC-179 原案」。）
- **D2 历史入口＝两个都要**：成员历轮列表（drawer 内切换） + 房间级「执行记录」时间线**都做**。
- **D3 全面重审＝是**：P0/P1 打磨项入本 RFC（批准时可勾掉），P2 列为后续（见 §6）。

由设计推导、随本 RFC 定稿的从属决策（设计门可挑战）：

- **D4 assignment 轮不出回合卡**：`DispatchCard` 已覆盖派发轮（实时状态 + 查看执行现场），再出回合卡＝双卡噪音；对齐既有「assignment 轮不重复出 active row / pill」的测试原则。两卡族做视觉统一。
- **D5 presence 四态判据（设计门修订：currentRun 状态优先）**：`currentRun` 存在时以其生命周期为准（running→执行中 / awaiting_human→等待回答 / pending→排队中），assignment 只在 currentRun 为空或终态时兜底（running→执行中、awaiting_human→等待回答、dispatched→排队中）；否则空闲。原因：派发轮在 run 等信号量前 assignment 已被 CAS 成 running——"排队中"场景恰是 run=pending+assignment=running，assignment 优先会误报执行中。单一纯函数 `deriveMemberPresence`（分层优先级表测锁死），取代花名册直用 `memberIsWorking`。
- **D6 pending 可见性＝mint 后补发 `node.status{pending}`**：复用 `runner.ts:706-712` 同款帧形；`f55ede4b` 已让 node.status 失效房间 key，无需新 WS 机制。
- **D7 drawer 成员历轮＝房间侧传成员作用域 runs**：复用 drawer 既有 history 归并 + `onSelectRun`（已接线，`WorkgroupRoom.tsx:675`），零 drawer 结构改动；顺带修掉现状跨成员串台。
- **D8 supersede RFC-179 D1 / render②**：用户本次拍板推翻；`streamActiveExecutions` 及其渲染块 / 测试由回合卡取代（测试注释注明 supersession 链路）；提及 pill（render①）保留并升级为可点。
- **D9 可点芯片＝StatusChip 最小扩展**：加 optional `onClick`（有则渲染 `<button class="status-chip …">`，无则维持 `<span>` 逐字节不变），全仓调用方零回归、一次扩展全局受益（遵循前台一致性条例第 2 条）。
- **D10 时间 / 耗时格式复用既有 helper**：实现时以 `lib/` 现存为准（drawer Stats 已有耗时格式），无则新增纯函数 + 测试；消息时间戳跨天带日期。
- **D11 与 RFC-181 协同呈现**：`runHistory` 条目带后端派生 `note:'clarify-suppressed'|null`（解析 `clarify-suppressed:*` errorMessage 前缀，协议串留在服务端，与 shardKey 同一边界原则）；回合卡 / 执行记录以「反问已压制」辅注呈现。回合卡与 presence 的状态映射覆盖全部 node_run 状态（含 `awaiting_human`＝等待回答、`canceled`、`interrupted`），复用 `lib/noderun-status.ts` 既有公共映射（`displayNoderunStatusKey` / `nodeRunStatusToKind`），不另造一套。前缀契约测试与 RFC-181 共享互链。

## 6. 全面重审清单（D3 拍板的范围界定）

**P0（本 RFC 核心，不可裁）**

| # | 项 | 对应目标 |
| --- | --- | --- |
| P0-1 | 统一回合卡（被 @ 轮 / leader 轮持久卡，实时→定格） | G1 |
| P0-2 | 全部运行中指示可点进 session | G2 |
| P0-3 | 花名册 presence 三态单源（修「执行中显示空闲」）+ pending 广播 | G3 |
| P0-4 | 双历史入口（执行记录卡 + 成员历轮切换） | G4 |
| P0-5 | 后端 runHistory 单一事实源（memberRuns 改投影） | G5 |

**P1（本 RFC 一并做，批准时可勾掉）**

| # | 项 | 现状锚点 |
| --- | --- | --- |
| P1-1 | 滚动锚定：仅贴底时自动跟随；上翻不打断 +「回到最新」浮标 | `WorkgroupRoom.tsx:183-188` 强制贴底 |
| P1-2 | 消息时间戳跨天带日期（统一格式 helper） | `:757` 仅 `toLocaleTimeString()` |
| P1-3 | drawer 历轮条目 wg 化标签（派发轮 / 被 @ 轮 / 领导轮）——wire `NodeRun` 补 `rerunCause` 字段（零 migration，列已存在） | shared `task.ts` 无 rerunCause |
| P1-4 | 回合卡 / 派发卡同族视觉统一（同 `.workgroup-room__card` 家族） | — |
| P1-5 | a11y：新入口 button 语义 + aria-label + 键盘可达；pill / 芯片可点后焦点样式 | — |
| P1-6 | 执行记录 / 回合卡空态、drawer 打开失败态复用公共组件 | — |
| P1-7 | RFC-181 收场可视化：「反问已压制」辅注 + 等待回答态 + 遣散留痕（D11） | 181 侧无 UI，房间无痕 |

**P2（明确不做，列为潜在后续）**：运行中回合取消（引擎级）；daemon 重启 re-entry（RFC-164 遗留）；wg.\* `?since` 重放；composer 键盘（RFC-174）；未读分割线 / 已读回执（RFC-164 非目标维持）；node.event token 级房间活跃度（f55ede4b 刻意排除）。

## 7. 验收标准

- 房间聚合返回 `runHistory`（升序全量回合：nodeRunId / memberId / displayName / kind / status / round / startedAt / finishedAt / triggerMessageId / assignmentId / note），`memberRuns` 与其同源（投影）；kind 按 nodeId+shardKey 形状判定（**clarify-answer 续跑 run 归类入历史与 memberRuns**——修复现存"答完反问续跑仍显示空闲"的 latent 缺口）；三类回合 + wg-gate 排除 + 排序 + note 派生纯函数 table 测试全绿。
- 被 @ 轮 / leader 轮各自出现回合卡：pending「排队中」→ running 脉冲 + 实时耗时 → 终态定格且**刷新 / 重进房间后仍在**；assignment 轮不出回合卡（防双卡断言）。
- 回合卡「查看会话」、提及 pill、花名册 presence 芯片点击均打开对应 run 的 `NodeDetailDrawer`（集成断言）。
- 花名册芯片：leader 轮 / 被 @ 轮 running 时显示「执行中」（修复同屏矛盾的回归断言）、`awaiting_human` 显示「等待回答」、pending / dispatched 显示「排队中」、否则「空闲」；`deriveMemberPresence` table 测试覆盖四态 × 优先级全分支。
- mint 后广播 `node.status{pending}`（后端断言 workgroupRunner 三处 + clarify-answer 续跑 mint 点均发帧、adopted 分支不重发）；前端无需新 WS 规则（`task-sync-rules` 既有规则不变）。
- 「执行记录」卡：倒序全量、逐行可点回放、空态 EmptyState；点成员打开 drawer 后历轮列表仅含该成员回合（跨成员串台回归断言）。
- 滚动锚定：贴底时新消息自动跟随、上翻时不跳动且出现「回到最新」浮标（P1-1 集成断言）。
- StatusChip 扩展后：无 onClick 调用方渲染保持 `<span>`（源级 / 快照断言），有 onClick 渲染 button 且可键盘触达。
- prompt 隔离：runHistory / presence 数据不出现在任何 `compose*Prompt`（沿用 rfc099 双层锁定模式）。
- i18n 新 key zh/en 对称；门禁 `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿 + 单二进制 build smoke + 明暗 / 窄屏视觉核验 + Codex 设计门 / 实现门 findings 全折 + push 后查 CI。
