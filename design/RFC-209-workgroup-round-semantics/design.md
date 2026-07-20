# RFC-209 技术设计

## 1. 根因（实证）

### 1.1 缺陷 ① —— fc 的「回合号」是预算计数器

`currentRound()` 是 `countRoundsUsed()` 的纯别名（`services/workgroupRunner.ts:787-789`）。
free_collab 分支（`:682-689`）：

```ts
return state.hostRuns.filter(
  (r) => r.nodeId === WG_MEMBER_NODE_ID && r.status !== 'canceled' && r.rerunCause !== 'wg-protocol-retry',
).length
```

即**该任务至今铸过的成员 run 总行数**（派单轮 + 被 @ 轮 + fc 首轮 + 领养的反问续跑）。
这正是 `max_rounds` 的预算表（`workgroupWake.ts:172/186/240/258` 逐项 `roundsUsed + items.length >= maxRounds`），
与 `design/RFC-164-workgroup/design.md:262`「硬顶 `成员 run 总数 > max_rounds`」一致。

3 个成员并行发言 = +3；认领 5 张卡 = +5。当它被写进 `workgroup_messages.round` 并被
渲染成「第 X 回合」，用户看到的就是 0 → 3 → 5 → 8。

leader_worker 无此问题：RFC-189 给 leader 行打了真序数 `wg_round`，
`countRoundsUsed` lw 分支读 `max(wg_round)`（`:670-680`），每轮 +1。

### 1.2 缺陷 ② —— 并发轮攥着过期快照

引擎主循环每趟 `loadDbState` 一次（`:1005`），把这份 `state` 交给并发启动的每个 turn
（`driveWakeItem(args, state, item, …)` `:1080`；`driveAdoptedRun(args, state, row)` `:1025`），
随后阻塞在 `await Promise.race(inflight.values())`（`:1199`）——**只要有一个 turn 结束就往前走**，
而仍在跑的 turn 继续持有它自己那份旧 `state`（`EngineDbState` 永不原地修改，每次 `loadDbState`
产生新对象）。

于是 fc 首轮全员规划（快照计数 = 0）产出的一切都写 round 0，无论多晚落地：

- 成员消息 `:2024/2034`
- 它们建的卡 `:2116`（`workgroup_assignments.round`）
- 后来挂在这些卡下的每条消息 `assignment.round`（`:1904/1911/1845/1891/1731`）

审计标出的 STALE 写点共 9 处：`:1360, :1448, :2007, :2024, :2034, :2083, :2116, :2127, :2138`。
（代码里已经为**别的**数据承认过这份陈旧性——`:1856`「count LIVE, not the turn-start snapshot」、
`:2090-2093`「LIVE read (not the turn-start snapshot)」——紧挨着的 round 表达式却仍读快照。）

### 1.3 缺陷 ③ —— 路由硬编码 `round: 0`

| 位置 | 写什么 | 影响 |
|---|---|---|
| `routes/workgroupTasks.ts:456` | 人类房间消息 | 每说一句话插一条 round 0 |
| `routes/workgroupTasks.ts:432` | 人 @ 派单的 assignment 行 | 该卡的结果 / 失败 / 交付 / 取消消息全部随 `assignment.round` 落 0 |
| `routes/workgroupTasks.ts:638` | 确认门决定 | round 0 |
| `routes/workgroupTasks.ts:1247` | 中途改配置 | round 0 |

**两种模式都中**。

### 1.4 放大器 —— 前端按「变化」画线

`packages/frontend/src/lib/workgroup-room.ts:109`：

```ts
const isTransition = prevRound === null ? m.round > 0 : m.round !== prevRound
```

`!==` 包含**回退**。所以 `[…, 5, 0, 5, …]` 会画出「第 5 回合 / 第 0 回合 / 第 5 回合」三条线。
这是全仓唯一编码「round 0 == 前奏」的地方。

### 1.5 附带缺陷 —— `wg_round` 重铸漏继承导致双计

`reviveKilledClarifyContinuations`（`:305-339`）重铸被重启杀死的反问续跑时，`mintNodeRun`
的继承清单**不含 `wg_round`**（`services/nodeRunMint.ts:230` 恒 `o.wgRound ?? null`），
而被杀的前身行状态是 `interrupted`（**不是** `canceled`）、`rerunCause` 是 clarify 系
（既不是 `wg-gate` 也不是 `wg-protocol-retry`）——于是**两行都落进 `countRoundsUsed` lw 分支的
NULL 尾巴**（`:672-679`），同一个逻辑回合被数两次。后果：lw 回合号跳 1，且 `max_rounds`
预算多烧一格。

### 1.6 实证

本机 daemon 库 `probe-fc-test`（`01KXGAV9FH5RR90SHY63A60PWJ`）：goal seed 与两条成员消息全为
round 0，收敛系统消息为 round 1 —— 首轮快照计数 0 / 收尾时账本已 1，正是 §1.1+§1.2 的最小复现。

---

## 2. 接口契约

### 2.1 新模块 `packages/backend/src/services/workgroupRounds.ts`

**回合账本的单一事实源**。引擎、路由、房间聚合三方共用。

```ts
/** 账本所需的最小 node_runs 投影。 */
export interface RoundLedgerRow {
  nodeId: string
  status: string
  rerunCause: string | null
  wgRound: number | null
}

/**
 * 已用回合数 —— 与 max_rounds 触顶判据同源。
 * lw = max(wg_round) + NULL 尾巴；fc = 成员 run 行计数。
 * 逐值等价于改动前的 workgroupRunner.countRoundsUsed（AC-6 互 oracle 锁）。
 */
export function deriveRoundsUsed(mode: WorkgroupMode, rows: readonly RoundLedgerRow[]): number

/** 实时读一次账本（写入时刻口径）。三列投影 + (task_id, node_id) 索引命中。 */
export async function readRoundsUsed(
  db: DbClient, taskId: string, mode: WorkgroupMode,
): Promise<number>
```

`workgroupRunner.countRoundsUsed(state)` 收敛为
`deriveRoundsUsed(state.config.mode, state.hostRuns)`；`currentRound` 保持别名不动。

### 2.2 `postMessage` 的 round 极性翻转

```ts
interface PostMessageArgs {
  /** 省略 = 写入时刻实时读账本（默认正确）。仅两类例外显式传值，见 §2.3。 */
  round?: number
  …
}
async function postMessage(db, taskId, mode: WorkgroupMode, m: PostMessageArgs): Promise<string>
```

**极性是关键**：默认（省略）就是正确行为，显式传值才是例外。任何漏改点得到的是**对的**值，
不是错的值——与 RFC-207 那种「同签名反语义」的高危改法相反。`persistWgMessages` 的
`round: number` 参数同样变 `round?: number`。

### 2.3 `workgroup_messages.round` 写入规则（归一后）

> **规则**：`round` = 该消息**写入时刻**回合账本的读数。

例外**仅两族**，均显式传值：

| 例外 | 位置 | 值 | 理由 |
|---|---|---|---|
| leader 轮自身产出 | `:1630/1655/1669/1688` + assignment `:1645` | 该轮 `wgRound` | 这一轮**由它定义**，账本此刻尚未计入它 |
| 派单卡的结果 / 失败 / 交付 / 取消 | `:1731/1845/1891/1904/1911`、路由 `:525/1292` | `assignment.round` | 标注它回答的是**哪一轮的派单** |
| （前奏）开场目标消息 | `:950` | 显式 `0` | 先于任何回合；`countRoundsUsed(seed)===0` 已由 `:943` 保证同值 |

其余 18 处改为实时读数：引擎 `:773, :1106, :1157, :1188, :1279, :1360, :1448, :2007, :2024,
:2034, :2083, :2116(assignment), :2127, :2138`，路由 `:432(assignment), :456, :638, :1247`。

**明确不动**：`:1269` 的 `wgRound: currentRound(state)`（确认门 holder 的 **node_runs** 打戳）。
它进 lw 账本的 `max()` 分支，改它就是改 max_rounds 上限——非目标 §3。

### 2.4 房间聚合新增 `roundsUsed`

`GET /api/workgroup-tasks/:taskId/room` 响应增一个字段：

```ts
interface WorkgroupRoomResponse {
  …
  /** 已用回合数（= max_rounds 触顶判据读数）。上限走既有 config.maxRounds。 */
  roundsUsed: number
}
```

**零新查询**：该端点已经加载 host runs（`routes/workgroupTasks.ts:303-320`），只需给 select
补一列 `wgRound: nodeRuns.wgRound`，然后 `deriveRoundsUsed(config.mode, hostRuns)`。

### 2.5 前端 `buildRoomTimeline` 单调化 + 模式派生

```ts
/** fc 无全局回合（成员各自异步认领），房间不画回合分隔线。 */
export function roomShowsRoundDividers(mode: WorkgroupRuntimeConfig['mode']): boolean {
  return mode === 'leader_worker'
}

export function buildRoomTimeline(
  messages: readonly WorkgroupRoomMessage[],
  standaloneTurns: readonly WorkgroupRunEntry[] = [],
  opts: { dividers?: boolean } = {},   // 缺省 true —— 既有 2-参调用零改动
): RoomTimelineEntry[]
```

分隔线判据由「变化」改为**单调水位线**：

```ts
let maxRound = 0                       // 0 = 前奏基线，永不为它画线
for (const m of sorted) {
  if (dividers && m.round > maxRound) base.push({ type: 'round', round: m.round })
  if (m.round > maxRound) maxRound = m.round
  base.push({ type: 'message', message: m })
}
```

这条式子**同时**吸收了原来的 `round > 0` 前奏特例（`maxRound` 从 0 起步 ⇒ round 0 天然不画线），
比原逻辑更短。回退与重复一律并入上文。

`dividers === false`（fc）时，**所有** standalone turn 一律按 ULID 交织
（`byUlid = turns`、`byRound` 保持空），不依赖不存在的分隔线锚点。
fc 本就没有 `leader-round` 条目（`workgroupRoom.ts:78-79` 把 `wg-gate` 判 null，fc 又无 leader 轮），
此举是防御性的显式化，不是补丁。

### 2.6 前端右栏预算表

复用现有 `<dl className="workgroup-room__info">`（`WorkgroupRoom.tsx:760-782`）里已存在的
「最大轮数」dt/dd 行，**零新 CSS、零新组件**：

| 模式 | dt | dd |
|---|---|---|
| leader_worker | `workgroups.room.infoMaxRounds`（不变） | `{maxRounds}`（不变） |
| free_collab | `workgroups.room.infoMemberTurnBudget`（新） | `{roundsUsed} / {maxRounds}` |

（D7：后端字段两种模式都发；lw 的回合号已由分隔线传达，不给 lw 加新视觉元素。）

---

## 3. 数据流

```
node_runs(task) ──┐
                  ├─► deriveRoundsUsed(mode, rows)  ◄── 唯一推导
                  │        ├─► workgroupRunner.countRoundsUsed(state)  → 唤醒/触顶/宽限轮（行为不变）
                  │        ├─► readRoundsUsed(db, taskId, mode)        → postMessage 默认 round
                  │        └─► GET /room 的 roundsUsed                  → 右栏预算表
                  │
workgroup_messages.round ──► workgroupRoom.leaderRoundOf ──► runHistory[].round ──┐
                                                                                   ├─► buildRoomTimeline
workgroup_messages.round ──────────────────────────────────────────────────────────┘        │
                                                                     roomShowsRoundDividers(mode) ┘
```

---

## 4. 与现有模块的耦合点

| 耦合点 | 分析 | 结论 |
|---|---|---|
| `workgroupWake.deriveWakeSet` / `decideWorkgroupOutcome` | 只吃 `roundsUsed: number`，值由 `countRoundsUsed` 提供，逐值不变 | 零影响（AC-7） |
| `isLeaderWrapUpContinuation`（`:701-707`） | 同上 | 零影响 |
| `workgroupRoom.leaderRoundOf`（`:207-213`）＝ `1 + max(m.round where m.id < runId)` | 人类消息 round 从 0 变为账本读数。账本读数 = **已完成**轮数，而已完成轮的消息本就带该 round ⇒ 人类消息**不会抬高** max。唯一变化：leader 尚未写消息、但其 run 已 stamp `wgRound=N` 的窗口内，人类消息可带 N，使**下一轮**的 `leaderRoundOf` 由 `1+max` 得到正确的 N+1（原本因看不见 N 而少算一轮）——顺带**修正**一处漂移 | 行为改善；`rfc179-member-current-run.test.ts:263-285` 用的是合成消息、不含人类行，断言不变 |
| prompt 组装（`composeLeaderPrompt` / `composeMemberPrompt` / `renderMessagesBlock` / `renderLeaderLedger`） | 审计确认**从不读** `.round` | 零影响 |
| 消费游标 `workgroup_member_cursors` | 按 message **id**，与 round 无关 | 零影响 |
| `node_runs.wg_round`（lw 账本承重列） | 本 RFC 只在 §1.5 的 rider 里补一处打戳，其余不动 | 见 §5 rider |
| e2e | `e2e/visual-regression.spec.ts:330-416` 的房间桩返回空 messages/runHistory，零分隔线 | 零影响 |
| 并发改动 | 本 RFC 触及的 `WorkgroupRoom.tsx` / `workgroup-room.ts` 与工作树中 RFC-206（`styles.css`、`task-detail-tabs.ts`）、RFC-207（`autonomous` 删除）无重叠 | 无冲突 |

---

## 5. Rider：`wg_round` 双计修复（§1.5）

`reviveKilledClarifyContinuations` 在重铸前先算 `R = deriveRoundsUsed(mode, state.hostRuns)`
（此时 `hostRuns` 已含被杀行，故 `R` 就是该续跑本该占的轮序数，与 `driveLeaderTurn:1465`
「领养行取当前账本读数」的既有口径一致），然后：

1. `stampWgRound(db, latest.id, R)` —— 给**被杀的前身行**打戳（`WHERE wg_round IS NULL` 幂等）；
2. 重铸时 `overrides: { …, wgRound: R }`。

之后两行都带 `wgRound = R` ⇒ `max = R`、NULL 尾巴 = 0 ⇒ 账本读数 `R`，双计消除。
`driveLeaderTurn` 领养该行时 `adoptedRow.wgRound = R` 已非 null，走既有 `?? ` 短路，不再补戳。

**范围**：只按 (nodeId, shardKey) 分组的**最新**行操作（既有逻辑），不追溯更老的历史行。

---

## 6. 失败模式

| 失败模式 | 处置 |
|---|---|
| 每条引擎消息多一次 SELECT | 三列投影 + `(task_id, node_id)` 已有索引；消息量级为每轮个位数，且同一函数里本就要 INSERT。`persistWgMessages` 每次调用只读一次、不按条读 |
| 读账本与 INSERT 之间账本前进一格（TOCTOU） | 消息标签落在前一轮。显示层由单调守卫吸收，无用户可见后果。**记为可接受残余** |
| `dbTxSync` 事务内不能 await（确认门 `:638`） | 在事务**外**先 `await readRoundsUsed`，把值捕获进事务闭包。同上 TOCTOU 残余 |
| `postMessage` 新增 `mode` 位置参数漏传 | typecheck 硬失败（必填位置参数），不存在静默漏改 |
| `round` 由必填变可选后有人误省略例外族 | 例外族**已经**是显式传值的现状；省略得到的是「写入时刻账本读数」，即最接近正确的兜底，不会产生 round 0 那种硬错。测试对两族例外各有断言 |
| 将来给 fc 引入 leader 式卡片 | §2.5 的 `dividers=false ⇒ 全 ULID 交织` 会让它按时间落位而非锚定；届时需回看本节 |
| rider 改动了 `countRoundsUsed` 的输入分布 | AC-6 新旧口径互 oracle 测试 + 既有 max_rounds 测试全绿把关 |

---

## 7. 测试策略

> 本仓规矩：改动与测试同 commit；bug 修复先写红。

### 7.1 后端 `packages/backend/tests/rfc209-round-ledger.test.ts`（新）

- **互 oracle（AC-6）**：`deriveRoundsUsed` 与改动前 `countRoundsUsed` 的行内复刻在若干 lw / fc
  fixture 上逐值相同（含：全 stamp、全 NULL、混合尾巴、`wg-gate` / `wg-protocol-retry` 排除、
  canceled 排除、fc 计数制）。
- **路由 round 归属（AC-4/AC-5）**：先驱动一轮使账本 = 1，再
  `POST /messages` → 消息 `round === 1`；`POST /messages` 带 @ → assignment 行 `round === 1`；
  `POST /confirm` 与 `PUT /config` 的系统消息 `round === 1`。
- **引擎不再写快照旧值**：假 hooks 制造「先启动的 fc 轮后落地」，断言其消息 round 为落地时刻读数。
- **前奏保持（AC-9）**：goal seed 仍为 0。
- **rider 红→绿（AC-8）**：造一个 `interrupted` 反问续跑 + 重铸，断言 `deriveRoundsUsed` 不多计
  （改动前该断言必红）。
- **触顶行为不变（AC-7）**：既有 `rfc164-workgroup-core.test.ts` / `rfc187-maxrounds-wrapup.test.ts`
  零改动通过（回归门，不新增）。
- **表级源码锁**：断言 `routes/workgroupTasks.ts` 中 `round: 0` 字面量出现次数为 0
  （表形式登记 4 个原站点，按仓库教训用**表级**不用文件级）。

### 7.2 前端 `packages/frontend/tests/rfc209-room-round-dividers.test.ts`（新，纯函数表测）

| case | 输入 rounds | 期望 dividers |
|---|---|---|
| 单调递增 | `[0,1,1,2]` | `[1,2]`（既有行为不回归） |
| 回退不画线 | `[1,2,1]` | `[1,2]` |
| 重复不画线 | `[1,1,1]` | `[1]` |
| 混合（用户实测形态） | `[0,0,3,3,0,5,0,8,0,11]` | `[3,5,8,11]`，**零个 0** |
| 前奏（AC-9） | `[0,0]` | `[]` |
| fc 关闭（AC-1） | 任意 | `[]`，且 round 条目一个不产生 |
| fc 全 ULID 交织 | 带 round 的 standalone turns | 按 nodeRunId 与消息 id 归并 |
| `roomShowsRoundDividers` | lw / free_collab / dynamic_workflow | `true / false / false` |

leader 卡锚定的既有 case（`workgroup-room-lib.test.ts:696-711`）保持绿，作为回归网。

### 7.3 前端渲染 `packages/frontend/tests/rfc209-room-budget.test.tsx`（新）

- fc fixture：`queryAllByTestId(/^wg-round-/)` 长度为 0（AC-1）；右栏出现「成员发言预算」及
  `7 / 20`（AC-2），用 `findByRole`/文本断言而非 DOM 结构。
- lw fixture（含一条回退 round 的人类消息）：分隔线序列单调（AC-3），且 `wg-round-0` 不存在。

### 7.4 i18n

`rfc164-workgroup-tabs.test.ts:166-171` 的 key ratchet 追加 `infoMemberTurnBudget`（zh/en 双有）。

### 7.5 门禁

`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；
前端 vitest 全绿；migration 无改动（零 journal 计数影响）；单二进制 smoke（新增 backend 模块，
按仓库教训跑一次 `bun run build:binary` 防模块初始化环）。
