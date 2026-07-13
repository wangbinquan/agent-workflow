# RFC-179 工作组房间运行态可见性——点成员看当前 session + 被 @ 执行中标签 —— proposal

## 1. 背景与问题

用户 2026-07-13/14 走查工作组运行态时两点反馈（同一主题：房间里看不到 agent 的执行态）：

> 「当前正在执行的 agent 也没有地方显示，点击正在执行的 agent 要能在右边栏看到该 agent 的执行 session。」
>
> 「在聊天室里，如果一个 agent 被 @ 了并在执行，那就要在聊天室里显示该 agent 的标签和正在执行的状态。」

拆成两个诉求：

- **P1 点成员看 session**：房间里每个 agent（含 leader）应可点，右栏展示它**当前会话**（正在跑的那一回合的 opencode 对话 / node_run 详情）。
- **P2 执行中可见**：被 @ 唤醒并在执行的 agent，要在聊天室里显示它的标签 + 「执行中」状态。

### 1.1 根因链（均带出处，已核对源码）

1. **成员维度只有二元「忙/闲」点、且整行不可点**：房间右栏花名册逐成员渲染 working/idle 脉冲芯片（`WorkgroupRoom.tsx:445-472`，判据 `memberIsWorking` 见 `lib/workgroup-room.ts:111-118`＝该成员名下有 `running`/`dispatched` assignment），但成员 `<li>` **没有任何 onClick / button / Link**（`WorkgroupRoom.tsx:449-469`）——点头像 / 名字 / 整行都不会打开任何东西。

2. **完整实时查看器早已存在，但入口是「每张派发卡」而非「每个成员」**：派发卡上的「查看运行」按钮（`WorkgroupRoom.tsx:829-838`，仅 `assignment.nodeRunId !== null` 时渲染）打开 `NodeDetailDrawer`（`WorkgroupRoom.tsx:615-631`），四个 tab——**Session（opencode 对话流）/ Events / Output / Stats**（`NodeDetailDrawer.tsx:115-120`），卡一进 running 就有 run id、能边跑边看、WS `node.event` 实时刷新。右栏第三列布局也已就绪（`styles.css:12142-12144`）。缺的**只是**「点成员 → 打开它当前 run 的 drawer」这个入口。

3. **leader 自身回合无入口**：leader 的收敛 / 决策产出的是**消息**（`kind='decision'`），消息级别没有「查看运行」按钮（只有 dispatch 消息下的派发卡才有）；leader 本回合的 opencode session 无从房间进入。

4. **三类回合都落 node_run，但只有 assignment run 与成员建立了映射**：
   - leader 轮 → `__wg_leader__`，`cause='wg-leader-round'`，无 shardKey（`workgroupRunner.ts:927-933`）。
   - 成员指派轮 → `__wg_member__`，`shardKey=assignment.id`，runId 写进 `assignment.nodeRunId`（`workgroupRunner.ts:1100-1110`、`:1116`），**房间聚合已暴露**（`routes/workgroupTasks.ts:283-292`）。
   - 消息轮（被 @ 唤醒、无 assignment）→ `__wg_member__`，`shardKey=msg:${memberId}:${maxMsgId}`（`workgroupRunner.ts:1244-1254`），**未写进任何 assignment → 房间聚合不暴露**。
     前端其实已整包 fetch 全部 node_runs（`WorkgroupRoom.tsx:79-83`，`GET /api/tasks/:id/node-runs`），缺口只是 **member↔run 映射**（leader-round / assignment / message-turn 三类统一到成员）+ 交互接线 + P2 呈现。

**结论**：查看器不缺、第三列布局不缺、run 数据不缺；缺的是「逐成员当前 run」这一层单一映射 + 花名册可点 + leader 对等 + P2 的房间内执行中呈现。本 RFC 补齐这四点。

## 2. 目标

- **G1 逐成员当前 run 单一映射**：新增单一事实源，把 `__wg_leader__`（leader-round）/ `__wg_member__`（wg-assignment / wg-message-turn）三类 host run 归并到「该成员的当前 run」（running 优先，否则最近一次终态 run）。message-turn 的 `msg:${memberId}:*` shardKey 解析封装在这一处，**前端不解析后端内部格式**。
- **G2 花名册成员可点 → 右栏当前会话**：房间右栏花名册每个 agent 成员可点，复用现成 `setDrawerRunId` + `NodeDetailDrawer`，右栏第三列展示**被点那个的当前会话**（决策 D1）。
- **G3 leader 对等**：leader 在花名册同样可点、可看其 host run 的 Session（补上目前缺失的 leader 入口，决策 D2）。
- **G4 P2 执行中呈现（两者结合，决策 D3）**：① 被 @ 唤醒并在执行的成员，在**触发它的那条提及消息**上内联一个「执行中」pill；② 消息流内一行合成「@X 执行中…」活跃指示，落 result / 回合结束后消失或替换为结果卡。
- **G5 复用公共原语、零视觉孤岛**：drawer / 第三列 / 状态芯片 / StatusChip 等一律复用；新交互挂在公共组件上，测试优先 role/testid。
- **G6 prompt 隔离不破 + 最小后端面**：只读运行态、绝不入 prompt；member↔run 映射走既有 node-runs 数据，尽量零 migration。

## 3. 非目标

- **不做「成员多回合历史列表」切换**：用户明确「只显示点击的那个的当前会话」，房间消息流本身即历史。design §7 记录 shardKey 反解可支撑逐成员历史（`__wg_member__` 按 shardKey 分组），留作潜在后续，本 RFC 不做（避免 `NodeDetailDrawer` 自带 history 按 nodeId 归并把不同成员回合串台）。
- **不改回合 / 唤醒 / run 引擎模型**：leader-round / assignment / message-turn 三类 run 的铸造与 shardKey 规则不动，本 RFC 只**读**它们。
- **不改单 agent / workflow 任务的 run 详情入口**：那条链（`NodeDetailDrawer`）已有，本 RFC 复用不改。
- **不改 human 成员卡**：human 成员没有 agent run，保持「无查看运行、只有交付按钮」现状。

## 4. 用户故事

- 作为用户，我在房间里看到 @backend 成员的状态点在跳「working」，点它名字，右栏第三列就打开它当前正在跑的那一回合的 opencode 对话（Session tab），边跑边刷新。
- 作为用户，leader 正在拆解派活，我点花名册里的 leader，同样能看到它这一回合的 host session——leader 和普通成员一样对等可点。
- 作为用户，@reviewer 被别人 @ 了、正在执行，我在聊天室里那条提及消息上看到一个「执行中」pill，消息流里也有一行「@reviewer 执行中…」，它跑完落下 result 卡后那行消失。
- 作为用户，一个已经跑完、当前空闲的成员，我点它仍能打开它最近一次 run 的 session 复盘；从没跑过的成员点了不炸（灰显 / 无操作）。

## 5. 决策记录（2026-07-13/14，用户拍板）

- **D1 粒度＝当前会话**：点成员只打开「它当前那一回合」的 session（running 优先，空闲则最近一次终态 run）；不做多回合历史列表，房间流即历史。
- **D2 leader 对等**：leader 在聊天室里是一个对等 agent，花名册可点、看其 `__wg_leader__` host session，与普通成员同一交互。
- **D3 P2＝两者结合**：提及消息内联「执行中」pill + 消息流内合成活跃行，双重可见。

由设计推导、随本 RFC 定稿的从属决策（详见 `design.md`，设计门可挑战）：

- **D4 member↔run 后端派生**：在房间聚合（`GET workgroup room`）里给每个成员派生 `currentRun: { nodeRunId, status } | null`，message-turn 的 `msg:${memberId}:*` shardKey 解析 + leader-round 归并 leader 一处收敛（单一事实源，table 可测），前端只消费不解析。
- **D5 执行中判据**：成员「执行中」＝其 `currentRun.status === 'running'`（含 assignment 轮与 message-turn 轮）；P2 的提及-pill 进一步要求该 running run 的 shardKey 属 message-turn 且由某条提及消息唤醒（design §5 给出对应关系）。
- **D6 空闲/无 run 的点击**：`currentRun` 为终态 run → 点开复盘；为 null（从未跑过 / human 成员）→ 成员不可点（灰显）。

## 6. 验收标准

- 房间聚合对每个 agent 成员返回 `currentRun`（running 优先 / 否则最近终态 / 否则 null）；leader 归并 `__wg_leader__`、成员归并其 assignment + message-turn run；纯函数 table 测试覆盖三类 run + 空闲 + 无 run。
- 花名册 agent 成员行可点（有 `button`/role），点击调用 `setDrawerRunId(currentRun.nodeRunId)`、右栏第三列打开 `NodeDetailDrawer`；`currentRun` 为 null 的成员不可点。
- leader 行可点、打开其 `__wg_leader__` 当前 run 的 drawer（源级断言 leader 行接线）。
- P2：某成员 `currentRun.status==='running'` 且由提及消息唤醒时，① 该提及消息渲染「执行中」pill、② 消息流出现合成「@X 执行中…」活跃行；run 落终态后二者消失（集成断言 + 纯判据 table）。
- 回归防护：源级断言「成员 `<li>` 具备点击接线」「P2 判据不出现在运行时巨组件外的重复实现」。
- 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过；明暗 + 窄屏视觉核验（第三列开合、pill/活跃行样式）；Codex 设计门 findings 全折。
