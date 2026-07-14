# RFC-185 — 技术设计：leader fan-out（同 agent 并发多实例派单）

状态：Draft
定位：**「解锁 + 呈现」型改动**——引擎控制流零改动、无 schema 迁移、无新 REST 端点。改动集中在①leader 协议块（backend 一处纯文案函数）②前端花名册并发呈现（一个纯函数 + 一个徽标）③并发语义记档与测试锁定。

## 0. 总览与关键抉择

用户已拍板的四个产品决策（2026-07-14）：

| 决策点 | 结论 |
|---|---|
| 实例形态 | **轻量并发派单**——不进花名册、无实体身份，实例 = 同成员名下的并发 assignment |
| 候选池 | **花名册即池**——只能对花名册内 agent 成员起实例（ACL 启动闭包不变） |
| 生命周期 | **做完即退场**——assignment 终态即实例结束（现有 assignment 生命周期，零新增状态） |
| 确认门 | **免确认**——派单即生效，dispatch 消息 + DispatchCard 即公示 |

这四个决策共同把本 RFC 收束为最小改动：多实例并发的**全部运行时机制复用现状**（§1 逐条盘点），新增面只有协议文案与前端计数。

## 1. 现状机制盘点（fan-out 所需能力的存在性证明）

以下九条均为 HEAD 已有行为，本 RFC 不改动它们，只在 §5 测试策略里**锁定**其中与 fan-out 相关的行为：

1. **解析层放行**：`parseWgAssignmentsPort`（`packages/shared/src/schemas/workgroupRuntime.ts:294-308`）仅校验 member 为花名册 displayName + 数组 ≤ `WG_MAX_ASSIGNMENTS_PER_TURN`(=16, `:199`)。同一 member 出现多条**不被去重、不被拒绝**。
2. **逐条落库**：leader 轮对每条 dispatch 独立建 assignment 行（status='dispatched'）+ 独立 dispatch 消息（@member + title，mentionMemberIds=[member]）——`packages/backend/src/services/workgroupRunner.ts:1074-1101`。
3. **全量并发唤醒**：`deriveWakeSet` 第 1 步唤醒**所有** dispatched agent assignment，无 per-member busy 检查（`packages/backend/src/services/workgroupWake.ts:136-146`）；`busyMemberIds` 只 gate message_turn（`:149-161`），不影响 assignment 并发。
4. **实例隔离执行**：每 assignment turn mint 独立 node_run（`shardKey`=assignment id、`agentOverrideName` 借壳共享节点 `__wg_member__`，`workgroupRunner.ts:1162-1171`），在**独立 iso worktree** 中执行、完成后 merge-back 回 canonical（`scheduler.ts` createNodeIso/mergeBackNodeIso；并发 merge 冲突走 merge agent，失败以 `merge-back-conflict` 单独 fail 该 run）。
5. **聚合 barrier**：leader 批量唤醒条件 = 无 agent assignment 处于 dispatched/running（`workgroupWake.ts:167-172`）→ fan-out 全部终态后 leader 才聚合；ledger 逐 assignment 一行含 result summary（`composeLeaderPrompt` `workgroupRunner.ts:405-436` + `renderLeaderLedger` `workgroupContext.ts:230-247`）。
6. **失败独立**：单实例 failed → 该 assignment CAS 成 failed + 系统消息（`workgroupRunner.ts:1226-1233`），兄弟实例不受影响；lw 模式无自动重开，由 leader 聚合轮决定重派。
7. **反问隔离**：RFC-172 使 clarify 全链路 shardKey 作用域化——每个实例可独立 `<workflow-clarify>`，答案回到**自己的** assignment shard，无交叉污染（`workgroupContext.ts:272-279` 注释）。
8. **回合经济**：lw 模式 `countRoundsUsed` 只数 leader 轮（`workgroupRunner.ts:386-395`）——N 路 fan-out 不消耗 maxRounds 预算。
9. **prompt 组装**：每实例的 prompt = charter + roster + **自己的** `## Your assignment`（title + brief）+ 消息切片（`composeMemberPrompt` `workgroupRunner.ts:438-481`）——实例间靠 brief 区分工作，天然无串扰。

## 2. 差距（本 RFC 的改动面）

- **G1 协议未解锁**：`renderWgProtocolBlock('leader')` 的 `wg_assignments` 条目只写 `member = an AGENT displayName from the roster`（`workgroupContext.ts:313-318`），未说明同成员可多条、brief 须自包含、聚合时机——模型默认「一人一单」自我设限，fan-out 能力实际不可达。
- **G2 前端并发不可见**：`memberRuns` 为每成员**单值**投影（running wins → 多 running 时取最新 mint，`workgroupRoom.ts:130-136`；wire 类型 `WorkgroupMemberCurrentRun` `workgroupRuntime.ts:151-157`）。花名册行（`WorkgroupRoom.tsx:546-608`）presence chip 与点击目标都只挂这一个 run——12 路并发时 UI 只显示一个「执行中」，规模不可见。
- **G3 并发语义无记档**：cursor 共享消费、实例消息归属、awaiting_human 与 barrier 的关系等语义散落在代码里，从未成文（→ §4）。

## 3. 改动设计

### D1 leader 协议块 fan-out 指引（backend，唯一生产代码改动点·后端）

`packages/backend/src/services/workgroupContext.ts` `renderWgProtocolBlock` leader 分支，`wg_assignments` port 说明扩为：

```
- <port name="wg_assignments">JSON array of {"member","title","brief"}.
  member = an AGENT displayName from the roster. Empty array = no new work.
  FAN-OUT: the SAME member may appear in MULTIPLE entries — each entry runs as
  an independent CONCURRENT INSTANCE of that agent in its own isolated
  worktree. Use this to parallelize divisible work (per-file / per-module
  shards, alternative approaches to compare). Instances share NOTHING at
  runtime and cannot see each other's work-in-progress, so make every brief
  fully self-contained and keep shards non-overlapping to avoid merge
  conflicts. You are woken to verify and aggregate only after ALL dispatched
  assignments reach a terminal state. At most 16 entries per turn; dispatch
  further waves in later turns if needed.</port>
```

**实现门修订（Codex P2-1 折入）**：barrier 句「only after ALL … terminal state」与 §D3-3（awaiting_human 不阻塞唤醒）自相矛盾——leader 被唤醒时 clarify-park 的单可能仍在 ledger 里，原句会诱导 leader 把 park 单当完成、提前聚合/收尾。终版改为：

```
  merge conflicts. You are woken to verify and aggregate once no dispatched
  assignment is still executing. CAUTION: an instance parked on a human
  ask-back may still appear as awaiting_human in your ledger at that point
  — treat it as IN PROGRESS (message, dispatch other work, or wait), never
  as done. At most 16 entries per turn; dispatch further waves in
  later turns if needed.</port>
```

要点与既有约定的对齐：

- 协议块是平台英文协议（同 `shared/src/prompt.ts` 约定），不走 i18n。
- 「16」与 `WG_MAX_ASSIGNMENTS_PER_TURN` 保持一致——文案中不硬编码引用常量值的来源，测试锁定二者一致性（§5-T1）。
- 不改 worker 协议：实例无需知道自己是 N 分之一（brief 自包含原则下无此必要；避免注入面膨胀）。
- 不改 `parseWgAssignmentsPort`：行为已满足（§1-1）。

### D2 花名册在途计数徽标（frontend，唯一生产代码改动点·前端）

**数据**：零 wire 变更。房间聚合已带 `runHistory`（RFC-182 G5 单源）与 `assignments`，前端本地派生即可。

**纯函数**（`packages/frontend/src/lib/workgroup-room.ts` 新增；签名为实现门 Codex P2-2 折入后的双源终版）：

```ts
export function countMemberActiveRuns(
  runHistory: readonly WorkgroupRunEntry[],
  assignments: readonly Pick<WorkgroupRoomAssignment, 'assigneeMemberId' | 'status'>[],
  memberId: string,
): number {
  let n = 0
  for (const a of assignments) {
    if (a.assigneeMemberId !== memberId) continue
    if (a.status === 'dispatched' || a.status === 'running' || a.status === 'awaiting_human') n++
  }
  for (const e of runHistory) {
    if (e.memberId !== memberId) continue
    if (e.kind === 'assignment') continue // counted via its assignment row
    if (e.status === 'pending' || e.status === 'running' || e.status === 'awaiting_human') n++
  }
  return n
}
```

**为什么双源（Codex P2-2）**：只看 run 会在 **merge-back 窗口漏计**——`runNode` 在 merge-back 之前就把 node_runs 行落 `done`（merge 经 `writeSem` 串行排队 + 冲突走 merge agent，N 路并发时窗口可能很长），而 `driveAssignmentTurn` 要等 `runHostNode` 归来（含 merge-back，`scheduler.ts:940-953`）才 CAS assignment `running→done`。因此：**assignment 实例以 assignment 行为计数权威**（`dispatched|running|awaiting_human`——顺带覆盖「已派发未 mint」的排队窗口）；leader 轮/被 @ 轮无 assignment 行，按非终态 run 计（`pending|running|awaiting_human`——clarify-park 的假 `done` 已被投影层改写为 `awaiting_human`，RFC-182 impl-gate P1，`workgroupRoom.ts:172-178,222`）；assignment 类 run 跳过防双计。

**渲染**（`WorkgroupRoom.tsx` 花名册行，`:546-608` 区域）：presence chip 之后，当 `countMemberActiveRuns(...) >= 2` 时追加一个 `.chip.chip--tight`（与既有成员类型 chip 同款公共样式，零新 CSS）：`×{count} 在途`。i18n key 新增 `workgroups.room.activeRunsBadge`（zh：`×{{count}} 在途`；en：`×{{count}} active`）。单路/空闲不渲染（A6，避免常态噪音）。

**不改**：presence 四态派生（`deriveMemberPresence` 保持单 currentRun 语义——多 running 时它已正确报 working）；成员名/chip 点击目标（仍开最新实例 run，其余实例经 DispatchCard 与执行记录逐一可达，`WorkgroupRoom.tsx:626-659` runLog 已逐 run 呈现）。

### D3 并发语义记档（随本文档落地，不改代码）

1. **cursor 共享消费**：`workgroup_member_cursors` 是 per-(task, member) 的（`schema.ts:641-655`）。同一引擎 pass 内并发启动的 N 个实例共享同一 state 快照 → 看到**相同**的消息切片；`advanceMemberCursor` 以 `max(现值, 新值)` 单调推进、天然防回退（`workgroupLifecycle.ts:118-134`——protocol-retry 用旧 state 快照重推也不会倒退 sibling 已推进的 cursor）；跨 pass 补派的实例只见增量。设计立场：fan-out 实例以 brief 为工作依据、切片仅为补充上下文，成员级共享消费语义**可接受且保持不变**。
2. **实例产物归属**：`wg_result` 经 `assignmentId` 精确归属到单（result 消息 + DispatchCard + ledger 行）；`wg_messages` 的 author 只有成员身份（同 displayName），**无法区分出自哪个实例**——v1 已知限制，接受（实例应把交付写进 wg_result 而非闲聊）。
3. **awaiting_human 不阻塞 barrier**：leader 批量唤醒只检查 dispatched/running（`workgroupWake.ts:167-172`）——某实例 clarify park（assignment=awaiting_human）而兄弟全部终态时，leader 会先醒，ledger 可见 `[awaiting_human]` 行，由 leader 决策等待或另派。这是现有单实例语义的自然延伸，不改。
4. **写合并顺序**：并发实例 merge-back 按完成顺序串行合并；重叠写产生冲突时走 merge agent，仍失败则该 run 以 merge-back-conflict fail（§1-4/6）。协议文案已要求 leader 分片不重叠（D1）。
5. **上限**：单轮 fan-out ≤16（`WG_MAX_ASSIGNMENTS_PER_TURN`）；进程并发受调度器 `globalSem` 全局约束（超出即排队，不失败）。**不新增** per-member 上限。

### D4 fan-out 开关（修订，2026-07-14 用户验收反馈）——opt-in，默认关，原有固定模式零改动

首版把 FAN-OUT 指引**无条件**注入所有 leader_worker 组，等于改变了存量工作组「每个 agent 一个实体、一人一单」的固定模式默认行为。用户明确要求：**fan-out 是新增功能，必须不影响原有模式**。修订为 opt-in 开关，全链对齐 `autonomous` 的成熟先例（RFC-180/181）：

| 层 | 改动（与 autonomous 同款接线） |
|---|---|
| DB | migration `0094_rfc185_workgroup_fan_out.sql`：`ALTER TABLE workgroups ADD COLUMN fan_out integer DEFAULT false NOT NULL`（纯增量，存量行为 at rest 逐字节不变）；journal 登记 idx 93；`upgrade-rolling` 计数锁 93→94 |
| schema.ts | `fanOut: integer('fan_out',{mode:'boolean'}).notNull().default(false)`（对齐 `:496` autonomous） |
| shared | `workgroup.ts` create/update 输入 `fanOut: z.boolean().optional()`；`workgroupRuntime.ts` 运行时 config `fanOut: z.boolean().optional()`（读点 `?? false`，旧 `workgroupConfigJson` 快照零回归） |
| backend | `workgroups.ts` create 默认 **`?? false`**（与 autonomous 的 `?? true` 不同——用户要求默认关）/ update coalesce `?? existing` / rowTo 投影；`workgroupLaunch.ts` 冻结进任务 config；`renderWgProtocolBlock` **仅当 `config.fanOut === true` 才推 FAN-OUT 段**（关=首版之前的协议逐字节还原）；`workgroupTasks.ts` `ConfigPatchSchema` + patch 落库 + 审计 changes（运行期可中途切换，下一引擎 pass 生效；翻转无需补偿动作——关闭后在途实例照常跑完，只是 leader 下一轮不再被邀请） |
| frontend | `workgroup-form.ts` draft/serialize/prefill；`WorkgroupForm` Switch（autonomous Switch 同款同区）；`WorkgroupTaskConfigDialog` Switch（RFC-181 A 同通道）；i18n zh/en |
| 前端徽标 | **不 gate**——×N 徽标是纯呈现（human 手动多派单也会产生并发），照常保留 |

**测试增补**：默认/显式关 → 协议块不含 `FAN-OUT`（原模式回归锁）；开 → 含；CRUD roundtrip（create 默认 false / update 保持 / 显式开）；launch 冻结；per-task PATCH 切换；journal 计数锁 bump。既有 rfc185 协议/引擎用例的 cfg fixture 补 `fanOut: true`。

## 4. 失败模式

| 场景 | 行为（全部为现状机制，测试锁定） |
|---|---|
| leader 单轮派 >16 | zod max 拒绝整个 port → malformed-retry（错误清单注入重试，`workgroupRunner.ts:1056-1062`），耗尽则 leader protocol violation fail |
| 某实例失败 | 该 assignment failed + 系统消息；兄弟实例继续；全部终态后 leader 在 ledger 看到 failed 行并决策重派 |
| 实例间写冲突 | merge-back 冲突 → merge agent → 仍失败则该 run fail（merge-back-conflict），不波及兄弟 |
| 全部实例失败 | leader 聚合轮 ledger 全 failed → 重派或 done；maxRounds 兜底防死循环 |
| 实例反问（非全自动） | 该单 park awaiting_human，答案回自己的 shard（RFC-172）；兄弟不受影响 |
| 全自动组实例反问 | RFC-181 C 硬压制：软驳回重试 → 耗尽 drop-and-continue，绝不 park |
| leader 疯狂 fan-out | 16/轮 + maxRounds + globalSem 三重约束 |

## 5. 测试策略（随改动必落，缺一不交付）

**T1 协议锁（backend）**——`rfc185-leader-fanout.test.ts`：
- `renderWgProtocolBlock('leader', cfg)` 包含 `FAN-OUT`、`SAME member may appear in MULTIPLE entries`、`self-contained` 关键句；worker/fc_member 协议**不含** FAN-OUT 段。
- 文案中的单轮上限数字与 `WG_MAX_ASSIGNMENTS_PER_TURN` 一致（防常量与文案漂移）。

**T2 解析/唤醒行为锁（backend/shared 侧断言）**：
- `parseWgAssignmentsPort`：同成员 3 条 → ok 且保序不去重；17 条 → 拒绝。
- `deriveWakeSet`：同成员 3 个 dispatched → 3 个 assignment wake item；2 running + 1 done → leader 不醒；3 全终态 + leader 有未消费内容 → leader 醒；1 awaiting_human + 2 done → leader 醒（D3-3 语义锁定）。

**T3 引擎集成（backend，fake-hooks 风格，参照 `rfc164-workgroup-engine.test.ts`）**：
- leader 第 1 轮输出 `wg_assignments` 同成员 3 条 → 3 行 assignment + 3 条 dispatch 消息 + 3 个 `__wg_member__` run（shardKey 互异、agentOverrideName 相同）并发驱动；
- 3 个实例各自 `wg_result` 后：3 单 done、leader 第 2 轮 prompt 的 ledger 含 3 行结果；
- 其中 1 个实例 failed：兄弟 2 单照常 done，leader 聚合轮 ledger 呈现 1 failed + 2 done。

**T4 前端（vitest）**：
- `countMemberActiveRuns` 表测：0/1/3 在途；终态不计；他人 run 不计；awaiting_human 计入。
- `WorkgroupRoom` 渲染：构造某成员 3 路在途 runHistory → 花名册行出现 `×3` 徽标（role/testid 断言）；1 路在途 → 无徽标。

**回归门**：`bun run typecheck && bun run lint && bun run test && bun run format:check` + frontend vitest 全绿；不触碰 e2e 视觉基线（settings 默认页无涉）。

## 6. 设计门记录（对抗自审，2026-07-14）

Codex 设计门未能运行：shared broker busy（并发 RFC-184 评审在途）+ `sessionRuntime.mode='shared'` 恒审主 workspace working-tree（RFC-176 记录的 wedge；主树含 RFC-183/184 两拨并发 WIP，纯文档 RFC 无法干净入 diff）。按 RFC-176 先例以**逐项源码核对的对抗自审**替代；实现门阶段再跑 Codex（detached-worktree 审实现 commit）。自审逐项：

| # | 质疑 | 核对结论 |
|---|---|---|
| 1 | D1 文案会不会踩红既有协议测试？ | 既有断言是 `toContain` 关键句锚点而非快照（`rfc164-workgroup-core.test.ts:768-790`）；worker 分支 `not.toContain('wg_assignments')`（`:782`）反向锁定 FAN-OUT 段只能进 leader 分支——与 D1 设计一致，追加不致红。 |
| 2 | 并发实例 protocol-retry 用旧 state 快照重推 cursor，会不会回退 sibling 已推进的水位？ | 不会：`advanceMemberCursor` upsert 用 `max(现值, 新值)` 单调合并（`workgroupLifecycle.ts:118-134`），显式防回退。D3-1 措辞已按此修正。 |
| 3 | clarify-park 实例的 DB run 行假 `done`，`countMemberActiveRuns` 会不会漏计？ | 不会：RFC-182 impl-gate P1 已在 `deriveWorkgroupRunHistory` 投影层把 open-clarify run 修正为 `awaiting_human`（`workgroupRoom.ts:172-178,222`），本函数消费投影后 status。 |
| 4 | 「awaiting_human 不阻塞 leader barrier」是否属实？ | 属实：leader 批量唤醒的 blocking 谓词只查 `dispatched\|\|running`（`workgroupWake.ts:168-170`）；park 单在 ledger 以 `[awaiting_human]` 可见，leader 自行决策——现有单实例语义，D3-3 如实记档。 |
| 5 | 「引擎无 per-member 并发限制」是否属实？ | 属实：`busyMemberIds` 只 gate message_turn（`workgroupWake.ts:149-161`），assignment 唤醒环节无 busy 检查（`:136-146`）。 |
| 6 | 存量运行中任务能否即刻获得新协议？ | 能：协议块每轮由 `renderWgProtocolBlock` 实时渲染（调用点 `workgroupRunner.ts:995/:1200/:1354`），不在 `workgroupConfigJson` 冻结范围。 |
| 7 | 多 running 时前端点击成员开哪个实例？ | 投影 `isBetter` 挑最新 mint 的 running（`workgroupRoom.ts:130-136`）；其余实例经 DispatchCard 与执行记录逐一可达（`WorkgroupRoom.tsx:626-659`）——保持不动，D2 已记。 |

### 6.1 实现门（Codex review，2026-07-14，`review --base 95dd6314^`）

首版实现推送后 shared broker 空闲、且主树已跟踪文件恰好全部干净（并发 WIP 仅剩 untracked 文档），实现门 Codex 得以干净运行。产出 **2 P2、零 P0/P1，全部折入**：

| # | Finding | 折入 |
|---|---|---|
| P2-1 | 协议 barrier 句「aggregate only after ALL … terminal state」与 awaiting_human 不阻塞唤醒（§D3-3）矛盾——leader 可能把 park 单当完成、提前聚合/收尾 | D1 终版文案：明示唤醒时 ledger 可能仍有 `awaiting_human` 单、按进行中对待（消息/另派/等待），协议锁测试同步换锚点 |
| P2-2 | `countMemberActiveRuns` 只看 run 行，merge-back 窗口（run 已 `done`、assignment 仍 `running`，writeSem 串行 + merge agent 冲突期可能很长）徽标漏计/消失 | D2 终版双源：assignment 实例以 assignment 行为计数权威（顺带覆盖 dispatched 未 mint 窗口），非 assignment 轮按非终态 run，assignment 类 run 跳过防双计；lib 表测 + 渲染测试补 merge-back 窗口 case |

## 7. 兼容性

- 无 DB 迁移、无 wire schema 变更（`WorkgroupRunEntry`/`WorkgroupMemberCurrentRun` 原样）、无 REST 变更。
- 旧任务/进行中任务：协议块按轮实时渲染（引擎每轮重载 config 并重新渲染协议），改动即刻对存量运行中工作组的下一 leader 轮生效——无冻结快照问题（协议块不在 `workgroupConfigJson` 冻结范围内）。
- 对 `free_collab` / `dynamic_workflow`：零改动（worker/fc 协议不变；dw 不走回合引擎）。
