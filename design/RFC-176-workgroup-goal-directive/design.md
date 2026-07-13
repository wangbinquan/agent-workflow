# RFC-176 工作组目标下发 —— design

> 读前置：`proposal.md`（背景 / 决策 D1–D6 / 验收）。本文只写技术。全部行号已核对当前源码。

## 0. 一句话

把 `goal` 从 `renderCharterBlock`（全员被动块）里剥出来，改成**按模式分流的持久注入块**（`renderGoalBlock`）+ **启动时引擎幂等播种的一条房间消息**；纯 `services/workgroupContext.ts` + `services/workgroupRunner.ts` 改动，零 migration。

## 1. 现状与根因（源码锚点）

| 事实 | 出处 |
|---|---|
| `renderCharterBlock` 把 `Group/Goal/Charter` 打一个块 | `services/workgroupContext.ts:178-189`（goal `:183`） |
| 该块注入 leader **和** worker | `composeLeaderPrompt` `workgroupRunner.ts:385` · `composeMemberPrompt` `:418` |
| `initial` leader 唤醒无条件产出（roundsUsed 0） | `services/workgroupWake.ts:144-156` |
| 引擎在 launch 被拉起、无工作组专属 park | `task.ts:1296` → `scheduler.ts:533`；`scheduler.ts:375-539` |
| `continue` 决策不落任何房间消息 | `workgroupRunner.ts:1013-1033`（仅 `done` 落 decision） |
| 空转后泊 `awaiting_human/leader-idle` | `workgroupWake.ts:229` |
| 人类消息在 `awaiting_human` 时 kickResume | `routes/workgroupTasks.ts:365` |
| 引擎主循环每轮开头 `loadDbState`、单实例 | `workgroupRunner.ts:477-489`（runTask CAS 独占 `scheduler.ts:375-389`） |
| `isPublicRoomMessage`：chat 仅当无 mention 才公共 | `workgroupContext.ts:112-117` |
| leader prompt 用全量 fresh（不按 mention 过滤） | `composeLeaderPrompt` `workgroupRunner.ts:382-383,391` |
| worker 切片按开关/ mention 过滤 | `selectMemberSlices` `workgroupContext.ts:119-171` |

## 2. 注入器改造（`services/workgroupContext.ts`）

### 2.1 拆 `renderCharterBlock`（去 goal）+ 新增 `renderGoalBlock`

```ts
// 章程块 —— 组身份 + 常驻章程(instructions)。全员每轮注入。
// RFC-176: goal 不再在此（目标是按模式分流的指令，不是全员共享上下文）。
export function renderCharterBlock(config: WorkgroupRuntimeConfig): string {
  const lines = ['## Workgroup', '', `Group: ${config.workgroupName}`]
  if (config.instructions.trim().length > 0) {
    lines.push('', 'Group charter:', config.instructions.trim())
  }
  return lines.join('\n')
}

// 目标块 —— 任务目标。只注入"负责拆解目标"的成员：leader(leader_worker)
// 或全体(free_collab)。leader_worker 的 worker 永不见，只据 leader 任务书行动。
export function renderGoalBlock(config: WorkgroupRuntimeConfig): string {
  return ['## Group goal', '', config.goal.trim() || '(not stated)'].join('\n')
}
```

> 备注：`renderCharterBlock` 头由 `## Workgroup mission` 改为 `## Workgroup`（去掉 goal 后 "mission" 名不副实）。这是纯文本头，非机器协议，无解析依赖。

### 2.2 组装点分流（`services/workgroupRunner.ts`）

`composeLeaderPrompt`（仅 `leader_worker`，`:375`）——在 charter 后插 goal 块：

```ts
const blocks = [
  renderCharterBlock(config),
  renderGoalBlock(config),          // ← 新增：leader 每轮带目标(G4)
  renderRosterBlock(config, { excludeMemberId: config.leaderMemberId ?? undefined, agentCards: state.agentCards }),
  renderLeaderLedger(config, ledger),
  renderMessagesBlock(config, 'New activity since your last turn', fresh),
]
```

`composeMemberPrompt`（lw worker + fc 成员共用，`:406`）——**按模式**决定是否插 goal 块：

```ts
const blocks = [renderCharterBlock(config)]
if (config.mode === 'free_collab') blocks.push(renderGoalBlock(config))   // ← fc 无 leader，全员见目标(G3)
blocks.push(renderRosterBlock(config, { excludeMemberId: memberId, agentCards: state.agentCards }))
// …（'## Your assignment' / '## Message turn' + 切片，保持不变）
```

净结果：goal 块出现于 `{lw-leader, fc-成员}`，**不出现于 lw-worker**（指派轮 / 消息轮）。精确匹配 D1。

## 3. 启动 kickoff 播种（`services/workgroupRunner.ts`）

### 3.1 播种点：主循环前，幂等

在 `runWorkgroupEngine` 的 `for(;;)`（`:477`）**之前**做一次性播种：

```ts
// RFC-176: 首次进入的新鲜聊天室任务 —— 把 goal 作为开工指令播进房间。
// 单实例(runTask CAS 独占)故无竞态；崩溃重启幂等(下面的 no-message 守卫)。
{
  const seed = await loadDbState(db, taskId)
  if (
    seed !== null &&
    seed.config.mode !== 'dynamic_workflow' &&     // 防御：该模式不入本引擎
    countRoundsUsed(seed) === 0 &&                  // 尚未有 leader/成员 run
    seed.messages.length === 0 &&                   // 尚无任何房间消息 ⇒ 幂等钥匙
    seed.config.goal.trim().length > 0
  ) {
    const leaderId = seed.config.leaderMemberId
    const directed = seed.config.mode === 'leader_worker' && leaderId !== null
    await postMessage(db, taskId, {
      round: 0,
      authorKind: 'system',
      kind: 'chat',
      bodyMd: seed.config.goal.trim(),
      mentionMemberIds: directed ? [leaderId] : [],
    })
  }
}
```

播种后，主循环首个 `loadDbState`（`:489`）读到它 → `deriveWakeSet` 仍产 `leader/initial` → `driveLeaderTurn` 的 `composeLeaderPrompt(state)` 里 `fresh` 含该消息 ⇒ leader 首轮「新活动」块出现 goal（G5）。

### 3.2 为何是引擎入口而非 `startTask`

- **单实例保证**：`runTask` 已 CAS 独占任务（`scheduler.ts:375-389`），引擎内播种天然无并发。
- **崩溃幂等**：`no-message` 守卫使重启后（消息已持久）不重播；leader 尚未跑（roundsUsed 仍 0）也照样从持久消息里读到 goal。
- **不污染通用 `startTask`**：沿 RFC-164「引擎独占房间消息写入、launch 只建行」的分层（`workgroupRunner.ts:3` 注释）。

### 3.3 消息形态与隔离（D4/D6）

| 模式 | mention | `isPublicRoomMessage` | worker 是否注入到 | leader 是否见 |
|---|---|---|---|---|
| leader_worker | `[leaderId]` | 否（chat 有 mention） | **否**（非公共、非其 mention、goal 也不在其持久块） | 是（全量 fresh） |
| free_collab | `[]` | 是（chat 无 mention） | 是（公共黑板，fc 开关恒全开） | —（无 leader） |

- lw 定向消息**不会**给 leader 触发多余 `message_turn`：`deriveWakeSet` 第 2 段对 lw leader 显式 `continue`（`workgroupWake.ts:123`）；leader 走 `initial` 唤醒。
- `renderMessagesBlock` 按 `displayName` 渲染作者（`workgroupContext.ts:357-364`）、`authorKind:'system'` 渲染为 `system`——无 userId、无 memberId 进 prompt（RFC-099 不破）。

## 4. 模式矩阵（最终注入面）

| 角色 | charter(instructions) | goal 块 | kickoff 消息可见 |
|---|---|---|---|
| lw leader | ✅ 全员 | ✅ 持久 | ✅ 定向 |
| lw worker（指派/消息轮） | ✅ 全员 | ❌ | ❌ |
| fc 成员 | ✅ 全员 | ✅ 持久 | ✅ 公共 |
| dynamic_workflow | 不入本引擎（`scheduler.ts:505-539`），goal 归 `orchestratorAgent.ts:132` | — | — |

## 5. 与现有模块耦合点

- **`WorkgroupRoom.tsx:548`**：侧栏 `data.config.goal` 展示不变。房间流现在**多一条** system goal 消息——由既有 `RoomMessage` 渲染（system 作者既有样式）；无新 UI、无新 i18n（body=goal 文本）。
- **游标 / 唤醒**：kickoff 落 `round:0`，被 leader 首轮消费后进游标之后（`advanceMemberCursor` `workgroupRunner.ts:908`），不再重注入——持久 goal 块接手跨轮记忆。
- **中途加成员**（RFC-164 msghub 语义，加入不补历史）：新成员首次注入的黑板尾窗从加入时刻起（`design/RFC-164-workgroup/design.md:387`）——lw 新 worker 本就不该见 goal（定向消息 + 无持久块），语义自洽；fc 新成员通过持久 goal 块见目标（不依赖历史 kickoff 消息）。
- **`dynamic_workflow`**：mode 守卫 + 引擎分流双保险，零触及。

## 6. 数据 / 契约变更

- **零 migration**、零 schema 变更、零 wire 变更。`WorkgroupRuntimeConfig.goal` 字段不动，只改"读它渲染"的纯函数与一处引擎播种。
- 新增导出纯函数 `renderGoalBlock`（供后端注入 + 测试；前端预览暂不需要）。

## 7. 失败模式与边界

1. **leader 首轮仍空转**（模型即便有 goal 块 + kickoff 仍输出 `continue` 空派单）：房间此时**已非空**（有 goal 消息），任务泊 `awaiting_human`，用户能看到目标已下发、可补一句引导。较现状（全空房间）已实质改善。**"检测首轮零派单即强制重问"** 属独立加固，本 RFC 非目标（proposal §3），如设计门认为必要可作为可选 T 扩。
2. **goal 为空串**：播种守卫 `goal.trim().length>0` 跳过；`renderGoalBlock` 渲 `(not stated)`（与旧 `renderCharterBlock` 空 goal 同措辞）。
3. **daemon 重启**：`no-message` 幂等钥匙防重播；已持久 kickoff + 持久 goal 块保证 leader 恢复后仍有目标。
4. **人类抢先发消息**（launch 与引擎首跑间隙，极窄）：`messages.length!==0` ⇒ 跳过 kickoff；leader 有人类消息作触发，goal 块照旧下发。可接受。
5. **prompt 隔离**：见 §3.3；新增测试锁 worker prompt 无 goal + 无 userId。

## 8. 测试策略（§必写）

**单元（`packages/backend/tests/rfc164-workgroup-core.test.ts`）**
- 改 `:359-361`：`renderCharterBlock(cfg())` **不含** `'fix payments'`(goal)、**含** `'be kind'`(charter)。
- 新增：`renderGoalBlock(cfg())` 含 `'fix payments'`；空 goal → `(not stated)`。
- 新增：`composeMemberPrompt` 对 lw worker **不含** goal；对 fc 成员 **含** goal（表驱动两 mode）。
- 新增：`composeLeaderPrompt` 含 `## Group goal`。

**引擎（`packages/backend/tests/rfc164-workgroup-engine.test.ts`，fake hooks）**
- 新鲜 lw 启动：`requests[0]`(leader)`.promptTemplate` 含 goal；随后 worker 指派轮 `requests[?].promptTemplate` **不含** goal 原文（隔离锁）。
- 房间存在一条 `authorKind:'system'`、mention=[leader]、body=goal 的消息，且 `isPublicRoomMessage`=false。
- **回归锁（P1）**：leader 脚本正常派活时，全程无人类消息 → 房间出现 goal 消息 + dispatch 卡（断言 messages 含 `chat`(goal)+`dispatch`）。
- fc 启动：kickoff 公共（mention=[]），fc_initial 成员 prompt 含 goal。
- 幂等：对已跑过一轮的任务再次 `runWorkgroupEngine` 不新增 kickoff（消息计数不因二次进入而 +1）。

**门禁**：`typecheck && test && format:check` + build:binary smoke + Codex 实现门。前端无逻辑改动；如需，补一条 `RoomMessage` 渲染 system goal 消息的轻断言（`workgroup-room.test.tsx`）。

## 9. 变更文件清单（预估）

- `packages/backend/src/services/workgroupContext.ts` —— 拆 `renderCharterBlock` + `renderGoalBlock`。
- `packages/backend/src/services/workgroupRunner.ts` —— `composeLeaderPrompt`/`composeMemberPrompt` 分流 + 引擎入口 kickoff 播种 + import `renderGoalBlock`。
- `packages/backend/tests/rfc164-workgroup-core.test.ts` —— 注入器断言。
- `packages/backend/tests/rfc164-workgroup-engine.test.ts` —— kickoff + 隔离 + 回归锁。
- （可选）`packages/frontend/tests/workgroup-room.test.tsx` —— system goal 消息渲染。

## 10. 设计门记录（Codex wedge + 对抗自审）

**Codex 设计门未能干净跑成**：本机 Codex companion 处于 `shared` runtime（broker socket 钉在主 workspace `/Users/.../agent-workflow`），`adversarial-review` 忽略 `--scope branch`、恒审「working tree diff」；而主工作树此刻混着并发 session 的 WIP（`packages/backend/routes/workgroupTasks.ts`、`WorkgroupForm.tsx`、`schemas/workgroup.ts` 等，疑 RFC-175/174 并行落地）。即便在钉 `bd9ea0bd` 的 detached worktree 里发起，评审仍落到主 workspace、grep 的是 `taskQuestions`/`cli/user` 等**他人未完成代码**——无法只审 RFC-176、也不该对他人 WIP 提 findings。属 [[reference_codex_review_plugin]] 记录的同类 CLI/共享树 wedge（RFC-173 亦遇）。已 cancel 该 job、清理 worktree。**改以严格对抗自审替代**，待工作树干净后可补跑 Codex 门。

**对抗自审 findings（均已核对源码）**：

- **SF1 测试审计广度**：全库仅 `rfc164-workgroup-core.test.ts:360-361` 锁「`renderCharterBlock` 含 goal」旧行为（plan T3 已覆盖）；grep 确认**无**任何测试断言 member/worker prompt 含 goal（`promptTemplate).toContain(goal)` 零命中），`## Workgroup mission` 头串仅存于源码（`workgroupContext.ts:180`）、无测试锁定 ⇒ 头改名安全。`engine.test.ts:780` 断言 `config.goal` 值、与注入无关，不受影响。
- **SF2 leader cursor 时序**：`driveLeaderTurn` 先 `composeLeaderPrompt(state)` 后 `advanceMemberCursor`（`workgroupRunner.ts:903-908`）；compose 用**旧** cursor 计 `fresh` ⇒ leader 首轮「新活动」块**确含** kickoff，消费后游标前移、后续轮不再重注入。持久 goal 块接手跨轮记忆。已验证正确。
- **SF3 kickoff 幂等/竞态**：runTask CAS 单实例（`scheduler.ts:375-389`）+ `messages.length===0` 钥匙 ⇒ 崩溃重启 / kickResume 重入 / 二次 `runWorkgroupEngine` 均不重播（重入时 roundsUsed≥1 或 messages≥1，双守卫任一即挡）。
- **SF4 隔离三路封死**（lw worker 拿不到 goal）：kickoff 是 `chat`+mention[leader] ⇒ 非 `isPublicRoomMessage`（不进 blackboard 切片）、非 worker 的 mention（不进 mentions 切片）、非 result/delivery（不进 peerResults 切片）；叠加 worker 持久块无 goal ⇒ 双重不泄漏。`renderMessagesBlock` 按 displayName 渲染作者、无 id 入 prompt。
- **SF5 fc 首轮 goal 双重曝光**（持久块 + 公共 kickoff 黑板切片）：刻意保留——房间可见性是 G5 目的，块保证跨轮记忆；非 bug。
- **SF6 残留**：leader 首轮仍可能 `continue` 空派单，但房间此时**已非空**（有目标消息），比现状实质改善；「首轮零派单强制重问」兜底列为非目标（§7），设计门若判定必要可加。
