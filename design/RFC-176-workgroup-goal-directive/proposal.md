# RFC-176 工作组目标下发——goal 作为 leader 开工指令（脱离全员章程块）+ 启动即开工 —— proposal

## 1. 背景与问题

用户 2026-07-13 反馈两点（同一根因）：

> 「在启动工作组的时候，任务目标应该是直接给到 leader 就开始执行了，为什么还需要人在对话框里再输入一次？并且任务目标不需要注入给所有 agent 啊，只有工作组章程才会注入给所有 agent。」

拆成两个诉求：

- **P1 启动即开工**：启动向导已收了 `goal`（`routes/tasks.new.tsx:394`，必填 `:336`），期望它**直达 leader、leader 立刻开跑**，不该还要人在聊天室输入框里再喂一句才动起来。
- **P2 注入范围**：`goal` 是**具体任务目标**，只有分解它的角色需要看到；而**工作组章程 `instructions`**（组内规范）才是全员每轮注入的东西。现状把两者混在一起注入给了所有 agent。

### 1.1 根因链（均带出处，已核对源码）

1. **goal 现在是「全员被动上下文」**：`renderCharterBlock` 把 `Group / Goal / Group charter` 三样打进一个块（`services/workgroupContext.ts:178-189`，goal 在 `:183`），而这个块在 `composeLeaderPrompt`（`services/workgroupRunner.ts:385`）**和** `composeMemberPrompt`（`:418`）里都被调用 → `goal` 进了每个 worker 的 prompt。这正是 P2 要砍的。当年是 RFC-164 §6.1 / schema 注释「拍板 #18」有意把 `instructions(全员)+goal+花名册` 打包成一个 mission 块（`design/RFC-164-workgroup/design.md:30`、`:298`）。

2. **initial 唤醒其实触发、leader 首轮确实跑**：`deriveWakeSet` 在 `roundsUsed===0` 无条件产出 `leader / reason:'initial'`（`services/workgroupWake.ts:144-156`）；引擎经 `startTask → runTask`（`services/task.ts:1296` kick）分支到 `runWorkgroupEngine`（`services/scheduler.ts:533`），中间无工作组专属 park（`scheduler.ts:375-539` 顺跑）。所以 leader 第一轮**是跑了的**——「initial 唤醒没生效」这个描述并不准确。

3. **但首轮可以「空转成不可见」**：若 leader 首轮输出 `wg_decision:{action:"continue"}` + 空 `wg_assignments` + 空 `wg_messages`，则**一条房间消息都不落**——`continue` 分支根本不写 decision 消息（`services/workgroupRunner.ts:1013-1033`，只有 `action:"done"` 才落），空派单/空消息同样不落。房间保持空。

4. **空转 → 泊住**：下一趟 `decideWorkgroupOutcome` 判 `awaiting_human / reason:'leader-idle'`（`services/workgroupWake.ts:229`，"leader 消费完、没派活、没宣告"）。

5. **人打字才「复活」**：`POST …/messages` 里 `if (task.status === 'awaiting_human') kickResume(taskId)`（`routes/workgroupTasks.ts:365`）→ 引擎重跑 → leader 这次把人类消息当「新活动」→ 才开始派活。

**为什么 leader 首轮爱空转**：它拿到的是「## Workgroup mission」里一行被动的 `Goal:`，加上一个**空的**「New activity since your last turn」块——读起来像"暂时没事干"，而不是"这是第一轮、按目标马上开工"。**把 goal 从"全员被动上下文"改成"下发给 leader 的可执行开工指令"，P1 与 P2 一并解决。**

## 2. 目标

- **G1（P2）注入范围收窄**：`renderCharterBlock` 只注入组名 + 章程 `instructions`（全员）；`goal` 从中移除。`leader_worker` 下 worker 的 prompt **不再包含 goal 原文**，只看 leader 派下来的任务书。
- **G2（P1）启动即开工**：goal 作为 leader 的开工指令下发，leader 首轮据此直接派活；房间不再"看着是空的"、不需要人再输入一次。
- **G3 按模式分流**：`leader_worker` → goal 仅 leader；`free_collab`（无 leader，全员共同拆解共享清单）→ goal 全员。章程恒全员。
- **G4 跨轮记得住目标**：goal 以**持久注入块**形式每轮下发给应看到它的成员（不是仅靠 session 续接这个 token 优化）。
- **G5 房间可见 + 首轮有触发**：启动时平台自动往房间播一条 system「目标」消息（`leader_worker` 定向 leader、`free_collab` 黑板），既让 goal 在房间里可见，又给 leader 首轮一个具体的「新活动」触发。
- **G6 零迁移、零回归**：纯注入器 + 引擎播种改动；`free_collab` 现状（全员见 goal）不回归；`dynamic_workflow` 生成/执行路径不受影响；prompt 隔离（RFC-099）不破。

## 3. 非目标

- **不改启动向导的 goal 输入**：goal 仍在 `/tasks/new` 向导收一次（`tasks.new.tsx`）——那**不是**重复输入，是任务目标的唯一来源。本 RFC 只改「收到之后怎么下发」。
- **不改 `dynamic_workflow` 模式**：该模式不走聊天室回合引擎（`scheduler.ts:505-539` 分流到 `runDynamicWorkflowGenerate`），goal 由编排 agent 使用（`services/orchestratorAgent.ts:132`），不在本 RFC 触及。
- **不新增「leader 首轮空转 → 强制重试/nudge」的引擎兜底**：G2/G5 已让首轮有可执行触发 + 房间非空，本 RFC 不引入"检测 leader 首轮零派单就重问一遍"的新状态机（列为潜在后续，见 design §7 失败模式）。
- **不改成员机制 / 开关语义 / max_rounds / 确认门**：全部沿用 RFC-164。
- **不改房间 UI 结构**：kickoff 消息复用既有 `RoomMessage` 渲染；侧栏 goal 展示（`WorkgroupRoom.tsx:548`）保持。

## 4. 用户故事

- 作为用户，我启动一个 `leader_worker` 工作组、填了目标，落到房间就能看到一条「目标」消息、leader 已经开始拆解派活——我**不用**再在输入框里打一遍目标。
- 作为一个 worker agent，我的 prompt 里只有组章程 + leader 派给我的**任务书**，看不到冗余的整组目标原文；我照任务书干活即可。
- 作为一个 `free_collab` 成员，我仍能看到整组目标（没有 leader 替我拆解），据此认领 / 新增共享清单里的任务——和现状一致。
- 作为 leader，即使跑到第 5 轮，我的 prompt 里仍持续带着「## Group goal」块，不会"忘了"当初的目标。

## 5. 决策记录（2026-07-13，用户两问拍板）

- **D1 注入范围（P2）**：按模式分流——`leader_worker` goal 仅 leader；`free_collab` goal 全员；章程 `instructions` 恒全员。worker 靠 leader 任务书，不见 goal 原文。
- **D2 下发形态（P1）**：**持久块 + 启动播一条**——① 应看到 goal 的成员每轮 prompt 带独立「## Group goal」注入块（G4）；② 启动时平台自动往房间发一条 system「目标」消息（`leader_worker` 定向 leader、`free_collab` 黑板），房间可见 + 首轮可执行触发（G5）。

由设计推导、随本 RFC 定稿的从属决策（详见 `design.md`，设计门可挑战）：

- **D3 kickoff 播种点 = 引擎入口幂等播种**：在 `runWorkgroupEngine` 主循环前播种（守卫：`mode∈{leader_worker,free_collab}` ∧ `roundsUsed===0` ∧ 该任务**尚无任何 workgroup_message**），单实例（runTask CAS 独占）故无竞态、崩溃重启幂等；首个 `loadDbState`（`workgroupRunner.ts:489`）即带上它，leader 首轮 prompt 含之。
- **D4 kickoff 消息形态**：`{ authorKind:'system', kind:'chat', bodyMd:goal, mentionMemberIds: leader_worker?[leaderId]:[] }`。`leader_worker` 定向 leader（`kind:'chat'` 且有 mention ⇒ 非公共 `isPublicRoomMessage`（`workgroupContext.ts:112-117`）⇒ worker 拿不到）；`free_collab` 无 mention ⇒ 公共黑板 ⇒ 全员可见。leader 恒见所有 fresh 消息（`composeLeaderPrompt` 用全量 fresh，不按 mention 过滤），故定向不影响 leader 消费。
- **D5 持久块与消息并存的理由**：kickoff 消息被消费后落在游标之后（`advanceMemberCursor`），后续轮不再重注入；持久「## Group goal」块保证 leader/fc 成员**每轮**都带着目标（G4）。二者职责不同、互补，非重复。
- **D6 prompt 隔离不破**：kickoff `authorKind:'system'`、mention 是 memberId（非 userId），`renderMessagesBlock` 按 displayName 渲染作者（`workgroupContext.ts:357-364`）；worker 侧既不注入该消息、goal 也不在其持久块——双重不泄漏。

## 6. 验收标准

- `renderCharterBlock` 输出**不含** goal，含组名 + 章程；新增 `renderGoalBlock` 输出 goal。
- `leader_worker`：leader prompt 含「## Group goal」；**worker（指派轮 / 消息轮）prompt 不含 goal 原文**。
- `free_collab`：每个成员 prompt 含「## Group goal」（不回归）。
- 新鲜 `leader_worker` 启动：引擎首轮前落一条定向 leader 的 system goal 消息；leader 首轮 prompt 的「新活动」块含该 goal；worker 指派轮 prompt 不含之。
- 新鲜 `free_collab` 启动：落一条公共 goal 消息，全员可见。
- 幂等：引擎二次进入（重启 / 重跑）不重复播种 kickoff。
- 回归防护：新鲜 `leader_worker` 启动、leader 正常派活时，**无需任何人类消息**，房间即出现 goal 消息 + 派单卡（锁死 P1）。
- 门禁：`bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过；Codex 实现门 findings 全折。
