# RFC-182 聊天室执行体验总体重设计 —— design

## 0. 范围

读侧派生 + 前端接线 + 一处 mint 后广播；**零 migration、零引擎语义改动**（三类回合的铸造 / shardKey / assignment 状态机全部只读）。与 RFC-181 同 owner 顺序落地：**181 先行单 PR，本 RFC 三 PR 随后**（触点错开见 §4）。

## 1. 现状锚点（已核对 HEAD=`f55ede4b` 源码）

| 事项 | 出处 |
| --- | --- |
| 花名册忙/闲 chip 数据源＝assignments（`memberIsWorking`） | `WorkgroupRoom.tsx:476,507-514`、`lib/workgroup-room.ts:115-122` |
| 同屏三行下的 `currentRun`（memberRuns，另一数据源） | `WorkgroupRoom.tsx:479-493` |
| 流内活跃行：running-only、`StatusChip` 不可点 | `WorkgroupRoom.tsx:306-320`、`lib/workgroup-room.ts:142-154` |
| 提及执行中 pill：running-only、不可点 | `WorkgroupRoom.tsx:743-747`、`lib/workgroup-room.ts:161-180` |
| `StatusChip` 是纯 `<span>` | `components/StatusChip.tsx` |
| `DispatchCard`「查看执行现场」（assignment 轮唯一持久入口） | `WorkgroupRoom.tsx:883-892` |
| drawer 挂载：全量 runs 传入 + `onSelectRun` 已接线 | `WorkgroupRoom.tsx:661-677` |
| drawer 内历史按 nodeId 归并（wg 跨成员串台源） | `NodeDetailDrawer.tsx:113`（`nodeRunHistory`） |
| 房间聚合 host-runs 查询列 `{id,nodeId,shardKey,status,rerunCause}` | `routes/workgroupTasks.ts:259-273` |
| `memberRuns` 派生（running 优先 / 否则 ULID 最新终态） | `services/workgroupRoom.ts:86-92,114` |
| mint 不发帧（pending 盲区） | `services/nodeRunMint.ts` |
| `node.status{running}` 帧构造形状 | `services/runner.ts:706-712` |
| 终态 `node.status` 广播 | `services/scheduler.ts:790` |
| `node.status` → 房间 key 失效（f55ede4b） | `hooks/useTaskSync.ts:89-94`、`task-sync-rules.test.ts` |
| 消息流强制贴底 | `WorkgroupRoom.tsx:183-188` |
| 消息时间戳仅 `toLocaleTimeString()` | `WorkgroupRoom.tsx:757` |
| 状态显示公共映射（10 态全覆盖） | `lib/noderun-status.ts:57`（`displayNoderunStatusKey`）`:87`（`nodeRunStatusToKind`） |
| timeline 构建（round 分隔） | `lib/workgroup-room.ts:86-97`（`buildRoomTimeline`） |
| 三类回合 mint 点 | `workgroupRunner.ts:927-933`（leader）`:1100-1116`（assignment）`:1244-1254` 一带（message-turn，含 adopted 分支） |
| message-turn 无重试、非 done 即 return、cursor 先推进 | `workgroupRunner.ts:1247-1300` |
| `NodeRun` wire 有 `shardKey` 无 `rerunCause` | `shared/src/schemas/task.ts:770` |

## 2. 接口契约

### 2.1 后端：房间聚合新增 `runHistory`（单一事实源，G5）

`shared/schemas/workgroupRuntime.ts`：

```ts
interface WorkgroupRunEntry {
  nodeRunId: string
  memberId: string                       // leader 轮 → config.leaderMemberId
  displayName: string | null             // 派生期冻结；成员已被中途移除 → null（UI 显「已移除成员」，设计门 P2）
  kind: 'leader-round' | 'assignment' | 'message-turn'
  status: NodeRunStatus                  // 快照值；前端展示优先 join 全量 node-runs（见 2.4）
  round: number | null                   // leader 轮＝该轮序号（非 gate 的第 n 个 leader run，对齐 countRoundsUsed 语义）；其余 null（设计门 P2：时间线 round-aware 定位用）
  startedAt: number | null
  finishedAt: number | null
  triggerMessageId: string | null        // message-turn：唤醒它的提及消息（RFC-179 既有派生复用）
  assignmentId: string | null            // assignment 轮 = shardKey（即 assignment.id）
  note: 'clarify-suppressed' | null      // RFC-181 协同：errorMessage 前缀后端派生（D11）
}
// room 响应新增：runHistory: WorkgroupRunEntry[]  —— 按 nodeRunId（ULID）升序 = 时间序
```

派生（`services/workgroupRoom.ts`）：

- 新纯函数 `deriveWorkgroupRunHistory(members, leaderMemberId, hostRuns, assignments, messages)`。**kind 判定改按「nodeId + shardKey 形状」，不按 `rerunCause`**（设计门 P1）：`__wg_leader__`（排除 `rerunCause==='wg-gate'`）→ leader-round；`__wg_member__` + shardKey ∈ assignments.id → assignment；`__wg_member__` + shardKey `msg:*` 前缀 → message-turn（前缀解析**仍封装在后端**）。原因：clarify 答案回流后 `taskQuestionDispatch` 会以 `rerunCause='clarify-answer'`、原 shard 血统重 mint 宿主续跑 run——按 cause 分类会把这些续跑 session 漏出历史**与 memberRuns**（后者是现存 latent 缺口：成员答完反问、续跑执行中，花名册又显示空闲——正是用户抱怨 #2 的又一实例，本 RFC 顺带修复）。
- `deriveMemberCurrentRuns` **重实现为 runHistory 的投影**（每成员 running 最新优先、否则 ULID 最新终态——选取规则逐字节不变，`rfc179-member-current-run.test.ts` 继续全绿并扩展），消除双份派生 drift。
- `note` 派生：`status==='failed' && errorMessage?.startsWith('clarify-suppressed')` → `'clarify-suppressed'`。`errorMessage` 本体**不透传 wire**（机器协议不出服务端——flag-audit 教训 + 与 shardKey 同边界原则）。
- 房间聚合 host-runs 查询（`workgroupTasks.ts:259-273`）补选 `startedAt / finishedAt / errorMessage` 三列——同一查询加列，无新查询、无 N+1。

### 2.2 后端：pending 可见性广播（G3 / D6）

**全部 wg 宿主 run 的 mint 点**在 `mintNodeRun` 返回**之后**（事务外）补发——`workgroupRunner.ts` 三处（leader / assignment / message-turn）**加** `taskQuestionDispatch` 的 clarify-answer 续跑 mint（守卫 `nodeId ∈ {__wg_leader__, __wg_member__}`；设计门 P2：续跑 run 经 `adoptedRunId` 进引擎、引擎侧不再发帧，而 `clarify.answered` 只失效 node-runs 不失效房间 key——不在外部 mint 点发帧，续跑在开跑前对房间不可见）：

```ts
taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
  id: -1, type: 'node.status', nodeRunId: runId, nodeId: WG_*_NODE_ID, status: 'pending',
})
```

- 帧形与 `runner.ts:706-712` 完全同款；同为 best-effort 提示帧、**不落 `node_run_events`**（`?since` 重放不受影响；重连一致性靠房间重取，现状约定不变）。
- message-turn 的 `adoptedRunId` 分支（行已存在）**不发帧**——帧已由外部 mint 点（taskQuestionDispatch）发过，只在真 mint 后发、恒一 run 一帧。
- 前端**零新 WS 规则**：`node.status` → `workgroupRoomKey` 失效已由 f55ede4b 建立（`task-sync-rules.test.ts` 不变）。
- import 面：`workgroupRunner` 新引 `ws/broadcaster`（与 `runner.ts` 同层引用先例）；按 memory 前科跑 `bun run build:binary` smoke 防 module-init cycle。

### 2.3 前端 lib 纯函数（G1 / G3，全部 table 测试）

`lib/workgroup-room.ts`：

- `deriveMemberPresence(memberId, assignments, currentRun) → 'working' | 'awaiting' | 'queued' | 'idle'`
  - **currentRun 状态优先**（设计门 P1）：`currentRun !== null` 时以其生命周期为准——`running`→working、`awaiting_human`→awaiting、`pending`→queued、终态→落入 fallback。原因：`driveAssignmentTurn` 在 `runHostNode` 等信号量**之前**就把 assignment CAS 成 running（`workgroupRunner.ts:1133`）——"排队中"场景恰是 run=pending + assignment=running，若 assignment 参与最高优先级会把 queued 误报成 working。
  - **assignment fallback**（currentRun 为 null 或终态时）：有 running assignment→working（防御性兜底）、awaiting_human assignment→awaiting（人工交付等待）、dispatched assignment→queued（已派发未 mint 窗口）；
  - `idle`：其余。优先级（每层内）working＞awaiting＞queued＞idle。
  - 花名册改用它；`memberIsWorking` 若再无消费者则**删除**（prefer-correct），其测试改写为 presence 表测（注释注明数据源错配修复链路）。
- `turnCardsForMessage(runHistory, messageId)`：`kind==='message-turn' && triggerMessageId===messageId` 的条目（挂卡）。
- `standaloneTurnEntries(runHistory)`：全部 leader-round + `triggerMessageId===null` 的 message-turn（降级为独立时序行，不丢卡）。
- `buildRoomTimeline(messages, standaloneTurns)` 扩展：新 entry 形态 `{type:'turn', entry}`。**定位规则（设计门 P2）**：leader 轮卡按 `entry.round` **round-aware 放置**（紧随第 N 轮 round 分隔之后）——leader run 先于其本轮产出消息 mint，纯 ULID 插入会把 round-1 的卡排到 round-1 分隔之前 / 前一轮之下；`round===null` 的降级 message-turn 条目按 ULID 时序插入。round 分隔本身的推导不变。
- **删除 `streamActiveExecutions`**（render② 被回合卡取代，RFC-182 D8；对应渲染块 `WorkgroupRoom.tsx:306-320` 移除，测试改写注明 supersession）。
- `mentionExecutingPills` 保留（pill 是"此刻"指示，running-only 正确；历史由卡承载）。
- `formatRoomTimestamp(ts, now)`：同日 → `HH:mm:ss`，跨日 → `M/D HH:mm`（P1-2）。

### 2.4 前端 UI（G1 / G2 / G4 / G6）

- **TurnCard**（`WorkgroupRoom.tsx` 内、与 `DispatchCard` 同族；样式复用 `.workgroup-room__card` 家族 + `--turn` 修饰，禁自造 chrome）：
  - 内容：`@displayName`（`entry.displayName===null` → 「已移除成员」占位 i18n，设计门 P2）+ 轮类标签（被 @ 轮 / 领导轮）+ 状态 chip + 耗时 + `note==='clarify-suppressed'` 时「反问已压制」辅 chip（D11）+「查看会话」按钮（`.btn .btn--xs`，`onClick={() => setDrawerRunId(entry.nodeRunId)}`）。
  - 状态 chip：join `nodeRuns.data.runs` 命中则用公共映射 `displayNoderunStatusKey` / `nodeRunStatusToKind`（10 态全覆盖，含 awaiting_human / canceled / interrupted），未命中 fallback `entry.status`——单一展示来源，不自造状态文案。
  - 耗时：running 时由**房间级单一 1s interval** 驱动实时增长（不是每卡一个 timer）；终态 `finishedAt - startedAt` 定格；缺 startedAt 显示 `—`。
  - 挂载：message-turn 卡随 `RoomMessage` 渲染在触发消息之下（`turnCardsForMessage`，位于 DispatchCard 之后）；leader / 降级卡为 timeline 独立 entry。
  - **assignment 轮不渲染 TurnCard**（D4 防双卡；集成断言）。
- **pill 可点（D9）**：`StatusChip` 加 optional `onClick?: () => void` —— 有则渲染 `<button type="button" className="status-chip …">`（可聚焦、Enter/Space 可触发），无则维持 `<span>` **逐字节不变**（全仓既有调用零回归，源级断言）。executing pill 传 onClick＝打开该成员 running run 的 drawer。
- **花名册 presence**：四态 chip（working=success+dot「忙碌」/ awaiting=warn「等待回答」/ queued=info「排队中」/ idle=neutral「空闲」）；`currentRun !== null` 时 chip 可点（同成员名按钮 handler）。卡内已有独立按钮的场景不给 chip 嵌套 onClick（防嵌套 button a11y 违规——TurnCard/DispatchCard 的状态 chip 保持纯展示）。
- **执行记录卡（G4-①）**：aside 内、成员卡之下 gate 卡之上新 `Card`：header「执行记录 · N」；条目倒序（`runHistory` 反转）：`@name`＋轮类＋状态 chip＋耗时＋`formatRoomTimestamp(startedAt)`；行为整行 `<button>` → `setDrawerRunId`；空态 `EmptyState size="compact"`；列表容器 `.workgroup-room__runlog` 限高 + `overflow-y:auto`。
- **drawer 成员历轮（G4-② / D7）**：打开 drawer 时由 runHistory 反查选中 run 的 memberId，`runsForDrawer = nodeRuns.runs.filter(r => memberRunIds.has(r.id)) ∪ {选中 run}`，传给 `NodeDetailDrawer` 的 `runs`——drawer 既有 history / attempts 归并即变成"该成员历轮"，`onSelectRun` 已接线（`WorkgroupRoom.tsx:675`）零 drawer 结构改动；跨成员串台随之修复（回归断言：A、B 各跑一轮时打开 A 的 drawer，历史不含 B 的 run）。runHistory 尚未含该 run（极窄竞态）→ 退回全量 runs，不白屏。
- **drawer 历轮标签 wg 化（P1-3，可裁；缝位设计门 P2 勘误）**：`shared/schemas/task.ts` `NodeRun` 补 `rerunCause`；wire 缝在 **`services/task.ts` 的 `getTaskNodeRuns` 手写响应 mapper**（`routes/tasks.ts` 只是薄委托、无 select 可加）——mapper 补字段 + 响应契约测试；零 migration。`lib/node-history.ts` 对 `__wg_leader__ / __wg_member__` 节点按 rerunCause 显示「领导轮 / 派发轮 / 被 @ 轮」，不再露 shardKey 原串。
- **滚动锚定（P1-1）**：log 容器 scroll 监听维护 `atBottom`（阈值 ~48px，初始 true）；贴底效果改为"**(timeline 长度 + runHistory 长度) 变化** 且 atBottom 时贴底"（设计门 P2：message-turn 卡挂在既有消息之下、不改 timeline 长度，只键 timeline 会漏跟随这类高度增长；现状 `:183-188` 无条件贴底废除）；`!atBottom` 时渲染「回到最新」浮标（`.btn .btn--sm`，绝对定位 log 右下），点击贴底并复位。
- **时间戳（P1-2）**：`:757` 改用 `formatRoomTimestamp`。

### 2.5 i18n

新 key（zh/en 对称，`i18n-keys-symmetry` 锁）：轮类标签 ×2、排队中 / 等待回答、执行记录标题 / 空态、查看会话、反问已压制、回到最新。复用既有：`workgroups.room.working` / `idle` / `openMemberSession`。

## 3. 数据流

```
mint(pending) ──[新增]── node.status{pending} ─→ useTaskSync 失效 room + node-runs
   → runHistory / presence / 回合卡 = 排队中
→ transitionNodeRunStatus(running)（runner.ts:696）── node.status{running}（既有）
   → 卡 = 执行中 + 实时耗时；pill 亮；presence = working
→ 终态 setNodeRunStatus + broadcastNodeStatus（既有 scheduler.ts:790）
   → 卡原地定格（状态 / 总耗时 / 查看会话）；pill 消失；presence 回落
clarify park → status = awaiting_human → presence / 卡 =「等待回答」
   （RFC-181 A2 遣散 → canceled 卡留痕；C 压制耗尽 → failed 卡 +「反问已压制」）
点击（卡 / pill / 花名册 chip / 执行记录行）→ setDrawerRunId → 第三列 NodeDetailDrawer
   （runs 按成员作用域 → 历轮切换 = drawer 既有 history + onSelectRun）
```

WS 面零新增：`node.status` → 房间失效沿用 f55ede4b 规则；`node.event` 依旧不打房间（token 级刷新维持排除）。

## 4. 与现有模块耦合点 + 顺序协调

| 模块 | 改动 |
| --- | --- |
| `shared/schemas/workgroupRuntime.ts` | +`WorkgroupRunEntry` + room 响应 `runHistory` |
| `shared/schemas/task.ts` | +`NodeRun.rerunCause`（P1-3，可裁） |
| `services/workgroupRoom.ts` | +`deriveWorkgroupRunHistory`；`deriveMemberCurrentRuns` 改投影；note 派生 |
| `routes/workgroupTasks.ts` | host-runs 查询补 3 列 + 响应 `runHistory` |
| `services/task.ts` | `getTaskNodeRuns` 响应 mapper 补 `rerunCause`（P1-3，设计门 P2 勘误缝位）+ 响应契约测试 |
| `services/workgroupRunner.ts` | 3 mint 点后 pending 广播 |
| `services/taskQuestionDispatch.ts`（clarify-answer 续跑 mint 处） | wg 宿主节点续跑 mint 后同帧广播（设计门 P2；实现期以实际 mint 落点为准） |
| `lib/workgroup-room.ts` | presence / turnCards / standalone / timeline 扩展 / formatRoomTimestamp；删 `streamActiveExecutions` |
| `lib/node-history.ts` | wg 轮标签（P1-3） |
| `components/StatusChip.tsx` | +optional `onClick`（span→button 条件渲染） |
| `components/workgroup/WorkgroupRoom.tsx` | TurnCard / 执行记录卡 / 花名册 presence / 滚动锚定 / 时间戳 / drawer runs 作用域 |
| `styles.css` | `.workgroup-room__runlog` / `--turn` 修饰 / 浮标（复用既有变量与卡片家族） |
| i18n zh/en | §2.5 新 key |

**顺序协调（同 owner）**：RFC-181 先行（配置弹窗 Switch + 引擎收场 + `clarify-suppressed` 前缀契约）；本 RFC 随后消费该前缀做 note 派生（共享契约锁互链）。`WorkgroupRoom.tsx` 触点错开：181＝仅 mid-run 配置弹窗；本 RFC＝消息流 / 花名册 / aside / drawer 接线，不碰弹窗。

## 5. 失败模式

- **runHistory 体量**：条目 ≈ 回合数（`max_rounds` 默认 20 量级 + message-turns + 重试），单房间百级以内；v1 不分页（执行记录卡限高滚动）；量级假设写入测试注释。
- **triggerMessageId 派生失败**：降级 `standaloneTurnEntries` 独立时序行——卡不丢，只是不挂在消息下。
- **pending 帧丢失 / 乱序**：帧只是失效提示，房间重取以 DB 为准；15s 轮询兜底不变；旧 daemon（无 pending 帧）UI 行为回落到现状（不劣化）。
- **历史任务回放**：runHistory 对既有 node_runs 全量派生即可用；老 run 缺 startedAt → 排序退回 nodeRunId ULID、耗时显示 `—`。
- **成员被中途移除（设计门 P2）**：mid-run config patch 删成员后，config 失去该 id→displayName 映射，而历史 run/assignment 只存 id——`entry.displayName` 派生期解析、解析不到落 `null`，回合卡 / 执行记录渲染「已移除成员」占位（i18n），历史卡永不因成员移除而丢名炸版。
- **StatusChip 扩展回归**：默认路径逐字节不变（`<span>`），源级断言 + 既有快照零抖动；button 变体不得嵌套于其它 button 内（TurnCard 状态 chip 纯展示）。
- **drawer 成员作用域竞态**：作用域集恒含 `drawerRunId` 自身；runHistory 缺该 run → 退全量 runs（现状行为），不白屏。
- **滚动锚定初态**：进房 `atBottom=true` 仍贴底；drawer 开合、presence 刷新不触发滚动（效果只依赖 timeline 长度 + atBottom）。
- **prompt 隔离**：runHistory / note / presence 只入房间聚合与 UI，绝不进任何 `compose*Prompt`（沿 rfc099 双层锁定模式加源级断言）。

## 6. 测试策略（§测试策略）

必写 case：

1. **后端 `deriveWorkgroupRunHistory` table**：三类 kind 归属**按 nodeId+shardKey 形状**（leader / assignment / message-turn）、**`rerunCause='clarify-answer'` 续跑 run 正确归类且进 memberRuns**（设计门 P1，latent 缺口回归锁）、升序、wg-gate 排除、triggerMessageId / assignmentId / round（leader 轮序号）/ displayName（含移除成员→null）回填、note 派生（`clarify-suppressed` 前缀——与 RFC-181 契约测试互链注释）、`deriveMemberCurrentRuns` 投影等价（对拍 rfc179 选取规则，原测试继续绿）。
2. **后端 pending 广播**：workgroupRunner 三 mint 点 + taskQuestionDispatch wg 续跑 mint 点各断言一帧 `{type:'node.status', status:'pending'}`；message-turn adopted 分支不发帧（一 run 一帧）。
3. **前端 lib table**：`deriveMemberPresence` **currentRun 状态优先 + assignment fallback** 全分支（关键 case：run=pending + assignment=running → `queued`，设计门 P1；awaiting_human 双来源；终态 currentRun 落 fallback）；`turnCardsForMessage` / `standaloneTurnEntries`（降级路径）；timeline interleave（leader 卡 round-aware 紧随本轮分隔、round=null 按 ULID；分隔推导不动）；`formatRoomTimestamp` 同日 / 跨日。
4. **组件集成（workgroup-room.test.tsx）**：message-turn 卡挂触发消息下、pending→running→done 文案流转、终态定格后仍渲染（"跑完不消失"回归锁）；leader 卡在其 round 分隔之后；assignment 轮不出 TurnCard（防双卡）；「查看会话」/ pill / 花名册 chip / 执行记录行点击各自打开 drawer（`setDrawerRunId` 断言）；执行记录倒序 + 空态；drawer runs 成员作用域（跨成员串台回归断言）；「反问已压制」辅 chip（note 驱动）；移除成员历史卡显「已移除成员」；滚动锚定（贴底跟随含"附着卡增高"路径 / 上翻不动 + 浮标出现与点击）。
5. **StatusChip**：无 onClick → `<span>`（渲染断言 + 源级断言）；有 onClick → `button` 且键盘可触发。
6. **源级断言（回归防护）**：`WorkgroupRoom.tsx` 不再引用 `streamActiveExecutions`；presence 判据单源于 `lib/workgroup-room.ts`；成员 `<li>` 点击接线既有锁维持。
7. **既有测试改写清单（注释注明 supersession 链路）**：`workgroup-room.test.tsx` active-row case（`:414` 一带）→ 回合卡 case；`workgroup-room-lib.test.ts:512-558` 对应改写；`memberIsWorking` 测试（lib `:206`、room `:749`）→ presence（注明 RFC-182 数据源错配修复）；`rfc179-member-current-run.test.ts` 扩展不删；`task-sync-rules.test.ts` 不动（断言零新 WS 规则）。
8. **i18n 对称** + **prompt 隔离源级断言** + P1-3 时 `getTaskNodeRuns` 响应契约测试（mapper 带出 `rerunCause`）与前端解析测试。

## 7. 潜在后续（非目标重申）

运行中回合取消（引擎级）；执行记录按成员 / 状态筛选；wg.\* `?since` 重放；RFC-174 composer 键盘；daemon 重启 re-entry。

## 8. 视觉核验

明暗 × 窄屏：回合卡三态（排队 / 执行中脉冲 / 定格）、「反问已压制」辅 chip、执行记录卡、浮标、第三列开合；与 /tasks 详情、/agents 等核心页 side-by-side 比按钮高度 / 圆角 / spacing；按 memory 用最小 repro + chrome 截图流程核验（settings 基线无涉）。

Codex 设计门：批准前跑（与 RFC-181 修订一并送审），findings 全折再请用户批准。
