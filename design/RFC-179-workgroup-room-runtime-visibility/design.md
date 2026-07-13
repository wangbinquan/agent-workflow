# RFC-179 工作组房间运行态可见性 —— design

## 0. 范围

纯运行态**只读**可见性：逐成员当前 run 映射（后端派生）+ 花名册可点 + leader 对等 + P2 执行中呈现。零回合/唤醒/引擎语义改动。

## 1. 现状锚点（已核对源码）

| 事项                                                                         | 出处                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 花名册成员状态芯片 working/idle（脉冲点）                                    | `WorkgroupRoom.tsx:445-472`                                 |
| 成员 `<li>` 无 onClick / button / Link                                       | `WorkgroupRoom.tsx:449-469`                                 |
| `memberIsWorking`（有 running/dispatched assignment）                        | `lib/workgroup-room.ts:111-118`                             |
| 派发卡「查看运行」按钮（`assignment.nodeRunId!==null`）                      | `WorkgroupRoom.tsx:829-838`                                 |
| `onViewRun = setDrawerRunId`                                                 | `WorkgroupRoom.tsx:287`                                     |
| `NodeDetailDrawer` 渲染（四 tab）                                            | `WorkgroupRoom.tsx:615-631`、`NodeDetailDrawer.tsx:115-120` |
| 前端整包 fetch node-runs                                                     | `WorkgroupRoom.tsx:79-83`（`GET /api/tasks/:id/node-runs`） |
| 房间聚合 assignments（含 nodeRunId/status/assigneeMemberId）                 | `routes/workgroupTasks.ts:283-292`                          |
| leader-round mint（`__wg_leader__`，无 shardKey）                            | `workgroupRunner.ts:927-933`                                |
| assignment mint（`__wg_member__`，shardKey=assignment.id）                   | `workgroupRunner.ts:1100-1110`、`:1116`                     |
| message-turn mint（`__wg_member__`，shardKey=`msg:${memberId}:${maxMsgId}`） | `workgroupRunner.ts:1244-1254`                              |
| 第三列布局（开 drawer 变三列）                                               | `styles.css:12142-12144`                                    |

## 2. 接口契约

### 2.1 后端：房间聚合新增 `members[].currentRun`（单一事实源，D4）

`GET /api/workgroup-tasks/:taskId/room`（现有房间聚合端点）响应里，为每个成员补一个派生字段：

```ts
// shared 类型
interface WorkgroupMemberCurrentRun {
  nodeRunId: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'canceled' | ...
  kind: 'leader-round' | 'assignment' | 'message-turn'
}
// room 聚合 member 行新增：
currentRun: WorkgroupMemberCurrentRun | null
```

派生规则用**一个纯函数**（`services/workgroupRoom.ts` 或 `lib` 共享，table 测试）：

```ts
function deriveMemberCurrentRun(
  member: { id; memberType; isLeader },
  hostRuns: ReadonlyArray<{ nodeRunId; nodeId; shardKey; status; startedAt }>,
): WorkgroupMemberCurrentRun | null
```

映射：

- **leader**（`member.id === config.leaderMemberId`）：取 `nodeId===__wg_leader__` 的 run，排除 `rerunCause==='wg-gate'`（gate 持有 run，非 leader 思考回合——对齐 `workgroupRunner.ts:361` 既有过滤）。
- **agent 成员**：取 `nodeId===__wg_member__` 且 shardKey 归属该成员的 run：
  - assignment 轮：`shardKey === <该成员某 assignment.id>`（用聚合已有 assignments 的 `assigneeMemberId` 反查该成员的 assignment id 集合）。
  - message-turn 轮：`shardKey` 匹配 `^msg:${member.id}:` 前缀。
- **human 成员**：恒 `null`（无 agent run）。
- **同一成员多 run 选取**：先 `running`（按 startedAt 取最新）；无 running 则取最近一次终态 run；都无则 `null`。

> **D4 关键**：message-turn 的 `msg:${memberId}:*` 是后端内部 shardKey 格式，解析封装在此后端纯函数里，**前端只读 `currentRun`，不 parse shardKey**（避免前后端耦合内部格式）。

聚合需能拿到 host runs：房间聚合当前已 join node_runs 供 assignments.nodeRunId 用（`workgroupTasks.ts:283-292` 上游）；若尚未整体加载 `__wg_leader__`/`__wg_member__` 全 run，则补一条 `inArray(nodeRuns.nodeId, [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID])` 查询（与引擎 `workgroupRunner.ts:289` 同款过滤），本任务作用域、无 migration。

### 2.2 前端：花名册可点 + drawer 接线（G2/G3）

- `WorkgroupRoom.tsx:449-469` 的成员 `<li>` 内层加一个 `<button>`（复用现有名字 span 作 label），`onClick={() => currentRun && setDrawerRunId(currentRun.nodeRunId)}`；`currentRun===null` → `disabled`（灰显，D6）。
- leader 行同款（D2）——leader 也是花名册一员，`currentRun` 由聚合给出，无需特判。
- drawer 复用 `WorkgroupRoom.tsx:615-631` 现有 `NodeDetailDrawer`（`workflowNodeKind="agent-single"`），第三列 CSS 已就绪。
- a11y：button `aria-label` = `@displayName 的执行会话`；testid `wg-member-open-session-${displayName}`。

### 2.3 前端：P2 执行中呈现（G4，两者结合）

两个纯派生 + 两处渲染：

- **判据纯函数**（`lib/workgroup-room.ts`，table 测试）：
  - `memberExecuting(member, currentRun)` = `currentRun?.status === 'running'`（D5）。
  - `mentionTriggeredExecutions(messages, members, currentRuns)` → 返回 `{ messageId, memberId }[]`：某成员正 running 且其 running run 为 message-turn（`kind==='message-turn'`），对应「唤醒它的那条提及消息」＝该成员游标之后、@ 了它的最新 chat 消息（对齐 `selectMemberSlices` 的 mention 语义 `workgroupContext.ts:138-147`；这里是 UI 只读镜像，不复用后端 slice）。
- **渲染①（提及消息内联 pill）**：消息流渲染提及消息时，若该消息命中 `mentionTriggeredExecutions`，在消息行内联一个「执行中」pill（复用 `StatusChip`/`info` 语义 + 脉冲点样式，与花名册 working 芯片同源）。
- **渲染②（流内合成活跃行）**：消息流末尾（或对应提及消息之后）合成一行 `@X 执行中…`（非真实 message，纯 UI 派生行），`memberExecuting` 为真时出现；run 落终态（WS 刷新后 `currentRun` 变终态/清空）即消失或被真实 result 卡替换。

> 合成行是**纯前端派生**、不落 `workgroup_message`、不入 prompt（G6）。

## 3. 数据流

```
引擎跑回合 → mintNodeRun(__wg_leader__/__wg_member__) → node_run status pending→running→done
        └─ WS node.event ─┐
前端 ['tasks',taskId,'node-runs'] 失效（useTaskSync.ts） ┘
房间聚合刷新 → members[].currentRun 重算（deriveMemberCurrentRun）
   ├─ 花名册：currentRun!=null → 行可点；status==='running' → working 芯片
   ├─ 点击 → setDrawerRunId(currentRun.nodeRunId) → 第三列 NodeDetailDrawer（Session 实时）
   └─ P2：memberExecuting / mentionTriggeredExecutions → pill + 合成活跃行
run 落终态 → currentRun 变终态 → 芯片 idle、活跃行消失、result 卡出现
```

WS 实时性沿用既有前缀模糊失效（`node.event` 使 `['tasks',taskId,'node-runs']` 失效级联命中子键），drawer Session/Events 随执行刷新——本 RFC 不新增 WS 机制。

## 4. 与现有模块耦合点

| 模块                                           | 改动                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `routes/workgroupTasks.ts`（房间聚合）         | +host runs 加载（若缺）+ `members[].currentRun` 派生字段   |
| `services/workgroupRoom.ts`（新/既有聚合服务） | +`deriveMemberCurrentRun` 纯函数                           |
| `shared/schemas/workgroupRuntime.ts`           | +`WorkgroupMemberCurrentRun` 类型 + room 响应字段          |
| `lib/workgroup-room.ts`（前端）                | +`memberExecuting` / `mentionTriggeredExecutions` 纯函数   |
| `WorkgroupRoom.tsx`                            | 花名册行可点 + drawer 接线 + P2 pill + 合成活跃行          |
| i18n                                           | 「执行中」pill / 合成行 / 会话按钮 aria 文案（zh+en 对称） |

**零 migration**（纯派生 + 前端接线）。**prompt 隔离**：新数据只走房间聚合渲染，绝不进入任何 `compose*Prompt`。

## 5. 提及-执行 对应关系（P2 精度）

message-turn run 的 shardKey `msg:${memberId}:${maxMsgId}`（`workgroupRunner.ts:1251`）里的 `maxMsgId` = 唤醒该成员时房间最大 message id。因此「唤醒它的那条提及消息」≈ id ≤ maxMsgId 且 @ 了该成员的最新 chat 消息。后端 `currentRun.kind='message-turn'` 已足以驱动**成员级**「执行中」（渲染②）；**消息级** pill（渲染①）需把 run 关联到具体消息——可由后端在 `currentRun` 里附 `triggerMessageId`（从 shardKey 的 maxMsgId 反查该成员最近被 @ 的 chat 消息，后端算一次），前端只读。设计门可挑选：`triggerMessageId` 后端派生（推荐，精确、单源） vs 前端 `mentionTriggeredExecutions` 近似（免后端字段，但把 mention 语义复制到前端）。

## 6. 失败模式

- **空闲成员点击**：`currentRun` 为终态 run → 打开复盘；为 null → 行 `disabled` 不可点（D6），不炸。
- **human 成员**：`currentRun` 恒 null → 不可点，保持交付按钮现状。
- **message-turn shardKey 解析失败 / 格式漂移**：`deriveMemberCurrentRun` 匹配不到 → 回退不映射（该成员 currentRun 由 assignment run 决定或 null），不抛。加一条「shardKey 前缀契约」测试锁死 `msg:${memberId}:` 格式，engine 侧一旦改格式即红。
- **共享 `__wg_member__` 节点 history 串台**：本 RFC 只用「当前会话」单条，不用 `NodeDetailDrawer` 自带按 nodeId 归并的 history（那会把不同成员回合混一起）——drawer 打开单 run 即可；逐成员历史留 §7 后续。
- **leader gate 持有 run 误当思考回合**：派生排除 `rerunCause==='wg-gate'`（对齐 `workgroupRunner.ts:361`）。

## 7. 潜在后续（本 RFC 非目标）

- 逐成员多回合历史列表：`__wg_member__` 按 shardKey（assignment.id / `msg:*`）分组给单成员历轮 run 列表——需改 `NodeDetailDrawer` history 归并从 nodeId 到 (nodeId, shardKey)。单独 RFC。

## 8. 测试策略（§测试策略）

必写 case：

1. `deriveMemberCurrentRun` table：leader-round / assignment / message-turn 三类映射 · running 优先 · 无 running 取最近终态 · human/null · 排除 wg-gate · 多 assignment 同成员选取。
2. shardKey 前缀契约锁：`msg:${memberId}:` 格式测试（engine 改格式即红，附注释链接本 RFC）。
3. `memberExecuting` / `mentionTriggeredExecutions` table：running=执行中 · message-turn+提及→命中消息 · assignment 轮不产生 pill · run 终态→清空。
4. 集成（`WorkgroupRoom`）：成员行 `button` 可点 + 点击 `setDrawerRunId` 调用（用现有 drawer mock）· `currentRun===null` 行 disabled · leader 行可点 · P2 pill + 合成活跃行渲染。
5. 源级断言（回归）：成员 `<li>` 具备点击接线；P2 判据不在 `WorkgroupRoom` 外重复实现（单源纯函数）。
6. i18n：新 key zh/en 对称（`i18n-keys-symmetry`）。

Codex 设计门：批准前跑，findings 全折再请用户批准。
