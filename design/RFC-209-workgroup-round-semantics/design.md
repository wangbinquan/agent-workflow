# RFC-209 技术设计

> **v2（2026-07-20）** —— 对抗设计门（Codex 配额耗尽，改用双路对抗自审，先例 RFC-185 / RFC-164）
> 发现 **1 P0 + 3 P1 + 4 P2**，v1 的两处论断被证伪、rider 方案被推翻。本文是折入后的版本，
> findings 与处置逐条记在 §9。

## 1. 根因（实证）

### 1.1 缺陷 ① —— fc 的「回合号」是预算计数器

`currentRound()` 是 `countRoundsUsed()` 的纯别名（`services/workgroupRunner.ts:787-789`）。
free_collab 分支（`:683-689`）：

```ts
return state.hostRuns.filter(
  (r) => r.nodeId === WG_MEMBER_NODE_ID && r.status !== 'canceled' && r.rerunCause !== 'wg-protocol-retry',
).length
```

即**该任务至今铸过的成员 run 总行数**（派单轮 + 被 @ 轮 + fc 首轮 + 领养的反问续跑）。
这正是 `max_rounds` 的预算表（`workgroupWake.ts:172/186/240/258` 逐项
`roundsUsed + items.length >= maxRounds`），与 `design/RFC-164-workgroup/design.md:262`
「硬顶 `成员 run 总数 > max_rounds`」逐字一致。

3 个成员并行发言 = +3；认领 5 张卡 = +5。它被写进 `workgroup_messages.round` 并渲染成
「第 X 回合」，用户看到的就是 0 → 3 → 5 → 8。

### 1.2 缺陷 ② —— 并发轮攥着过期快照

主循环每趟 `loadDbState` 一次（`:1005`），把这份 `state` 交给并发启动的每个 turn
（`driveWakeItem(args, state, item, …)` `:1080`；`driveAdoptedRun(args, state, row)` `:1025`），
随后阻塞在 `await Promise.race(inflight.values())`（`:1199`）——**只要有一个 turn 结束就往前走**，
仍在跑的 turn 继续持有自己那份旧 `state`（`EngineDbState` 永不原地修改）。

于是 fc 首轮全员规划（快照计数 = 0）产出的一切都写 round 0，无论多晚落地：成员消息
`:2024/2034`、它们建的卡 `:2116`、以及后来挂在这些卡下的每条消息 `assignment.round`
（`:1904/1911/1845/1891/1731`）。STALE 写点共 9 处：
`:1360, :1448, :2007, :2024, :2034, :2083, :2116, :2127, :2138`。

（代码已为**别的**数据承认过这份陈旧性——`:1852`「count LIVE, not the turn-start snapshot」、
`:2090-2093`「LIVE read (not the turn-start snapshot)」——紧挨着的 round 表达式却仍读快照。）

### 1.3 缺陷 ③ —— 路由硬编码 `round: 0`

| 位置 | 写什么 |
|---|---|
| `routes/workgroupTasks.ts:456` | 人类房间消息 |
| `routes/workgroupTasks.ts:432` | 人 @ 派单的 assignment 行（连带该卡后续结果/失败/交付/取消消息全落 0） |
| `routes/workgroupTasks.ts:638` | 确认门决定 |
| `routes/workgroupTasks.ts:1247` | 中途改配置 |

**两种模式都中**。注意这四处**不走** `postMessage`，是裸 `insert(workgroupMessages).values({...})`；
而 `db/schema.ts:617` 是 `integer('round').notNull().default(0)` ——**省略 `round` 会静默写 0**，
即本 RFC 要消灭的那个 bug 本身，且无任何类型信号（对抗门 P1，见 §2.6）。

### 1.4 放大器 —— 前端按「变化」画线

`packages/frontend/src/lib/workgroup-room.ts:109`：

```ts
const isTransition = prevRound === null ? m.round > 0 : m.round !== prevRound
```

`!==` 包含**回退**，所以 `[…, 5, 0, 5, …]` 画出「第 5 / 第 0 / 第 5」三条线。
这是全仓唯一编码「round 0 == 前奏」的地方。顺带：`WorkgroupRoom.tsx:354` 的
`key={`round-${entry.round}`}` 在 `[5,0,5]` 下会产生**重复 React key**，单调化一并消除。

### 1.5 附带缺陷 —— 被重铸的反问续跑双计

`reviveKilledClarifyContinuations`（`:305-339`）重铸被重启杀死的反问续跑时，`mintNodeRun`
的继承清单**不含 `wg_round`**（`services/nodeRunMint.ts:230` 恒 `o.wgRound ?? null`），
而被杀的前身行是 `interrupted`（**不是** `canceled`）、`rerunCause` 是 clarify 系。于是：

- **lw**：两行都落进 `countRoundsUsed` 的 NULL 尾巴（`:672-679`）⇒ 同一逻辑回合数两次。
- **fc**：`isKilledClarifyContinuation`（`:290-295`）与 nodeId 无关、`loadDbState:545` 同时加载
  `__wg_member__`，所以**成员**的被杀续跑同样被重铸；fc 分支按**行计数**，两行都计
  ⇒ 一个逻辑轮吃掉 **2 格 fc 预算**。fc 的 `max_rounds` 是硬杀（`decideWorkgroupOutcome:288-297`
  → `failed: max-rounds`），且 AC-2 要把这个数印在右栏——虚高值会被当成真相展示。

### 1.6 实证

本机 daemon 库 `probe-fc-test`（`01KXGAV9FH5RR90SHY63A60PWJ`）：goal seed 与两条成员消息全为
round 0，收敛系统消息为 round 1 —— 首轮快照计数 0 / 收尾时账本已 1，正是 §1.1+§1.2 的最小复现。

### 1.7 【v2 新增，对抗门 P1-4】lw 的账本**也**会跳、也会退

v1 说「lw 免疫、每轮 +1」是过度断言。lw 账本 = `max(wg_round)` + NULL 尾巴（`:670-680`），故：

- **跳**：引擎外 mint 的 host 续跑一律不带 `wgRound`（`nodeRunMint.ts:230`；
  `taskQuestionDispatch.ts:930-960` 就是这样 mint 的）。每个尚未被领养打戳的 NULL 行**立刻**给
  读数 +1，而下一轮序号是 `账本 + 1`（`:1463-1466`）⇒ 同时存在 ≥2 个 NULL 行时下一个标号一次跳 ≥2。
- **退**：`:673` 把 `status === 'canceled'` 的 leader 行从 `max` **和**尾巴里一并排除；
  在飞 leader 行被 cancel 后读数从 N 掉回 N−1。

结论：**账本读数不是单调的**。这直接约束了本 RFC 的目标措辞（proposal 目标 3 已收敛为
「lw 下可信」而非「处处单调」），也是 D4 前端单调守卫必须无条件存在的理由。

### 1.8 【v2 新增，对抗门 P0】账本返回的是**在飞轮**，不是已完成轮数

`driveLeaderTurn` 在 `hooks.runHostNode`（`:1512`）**之前**就把这一轮的行连
`overrides: { wgRound }` 落库（`:1481-1492`，`wgRound = countRoundsUsed(state) + 1`，`:1463-1466`）。
所以 leader 轮 N 一 mint，`readRoundsUsed` 立刻返回 **N**。
而 `routes/workgroupTasks.ts:616-618` 只挡 done/failed/canceled，人在 leader 跑动中完全可以发言。

**这使 v1 的 §4 论断（「人类消息不会抬高 max」）失效**，并会打断 RFC-182 impl-gate P2 的卡片锚定
——处置见 §2.5。

---

## 2. 接口契约

### 2.1 新模块 `packages/backend/src/services/workgroupRounds.ts`

**回合账本的单一事实源**。引擎、路由、房间聚合三方共用。

```ts
/** 账本所需的最小 node_runs 投影。 */
export interface RoundLedgerRow {
  id: string
  nodeId: string
  shardKey: string | null
  status: string
  rerunCause: string | null
  wgRound: number | null
}

/** 【P2-7】窄到两种回合制模式；dynamic_workflow 没有回合引擎，不该落进 fc 分支。 */
export type RoundedWorkgroupMode = 'leader_worker' | 'free_collab'

/**
 * 已用回合数 —— 与 max_rounds 触顶判据同源。
 * lw = max(wg_round) + NULL 尾巴；fc = 成员 run 行计数。
 * 除 §5 的被取代行排除外，逐值等价于改动前的 countRoundsUsed（AC-6 互 oracle 锁）。
 */
export function deriveRoundsUsed(mode: RoundedWorkgroupMode, rows: readonly RoundLedgerRow[]): number

/** 写入时刻的消息 round：lw = 账本读数；fc = 恒 0（该模式无回合，见 §2.4）。 */
export async function resolveMessageRound(
  db: DbClient, taskId: string, mode: RoundedWorkgroupMode,
): Promise<number>
```

`workgroupRunner.countRoundsUsed(state)` 收敛为 `deriveRoundsUsed(state.config.mode, state.hostRuns)`。

**【P1-5，模块环】** 本仓已存在 `workgroupRunner → workgroupLaunch → services/task → scheduler →
workgroupRunner` 的初始化环，而 `.dependency-cruiser.cjs` **没有** `no-circular` 规则。
故 `workgroupRounds.ts` **不得**有从被导入常量派生的顶层 const（例如
`const HOST_IDS = [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID]` 在不巧的初始化序下会求值成
`[undefined, undefined]` 并静默把账本清零）；节点 id 一律在函数体内引用。
门禁：`bun run build:binary`（RFC-079 先例，唯一能抓到的门）。

### 2.2 消息行构造器（唯一写入闸口）

**【P1，对抗门 §8.2】** 路由层的坑不是「传了 0」而是「**可以不传**」——schema 有 `.default(0)`。
故新增共享行构造器，`round` **必填**、无默认：

```ts
/** 全仓唯一的 workgroup_messages 行构造点。round 必填 —— 省略即 0 的默认值坑在此关闭。 */
export function buildRoomMessageRow(args: {
  id: string; taskId: string; round: number; authorKind: 'member' | 'human' | 'system'
  authorMemberId?: string | null; authorUserId?: string | null
  kind: WorkgroupMessage['kind']; bodyMd: string
  mentionMemberIds?: readonly string[]; assignmentId?: string | null; createdAt: number
}): typeof workgroupMessages.$inferInsert
```

引擎 `postMessage`（`:629`）与路由五处裸插入（`:453/521/634/1244/1289`）全部改经它。
同步事务里（确认门 `:634` 在 `resumeTaskWithAtomicSideEffects` 的 **sync** tx 回调内、
取消卡 `:1289`）照样可用——构造器是纯函数，round 在事务**外**先 `await` 解析后捕获进闭包。

源码级表锁：`insert(workgroupMessages)` 的出现点必须全部在白名单站点内且经构造器（§7.1）。

### 2.3 `postMessage` 的 round 极性翻转（仅限非派单卡族）

```ts
interface PostMessageArgs {
  /** 省略 = 写入时刻实时解析（默认正确）。 */
  round?: number
  …
}
async function postMessage(
  db: DbClient, taskId: string, mode: RoundedWorkgroupMode, m: PostMessageArgs,
): Promise<string>
```

**极性是关键**：默认（省略）就是正确行为，漏改点得到的是**对的**值。与 RFC-207 那种
「同签名反语义、必须用类型错误逼出漏改点」的高危改法方向相反。

三条实现约束：

1. **【P1-3】`persistWgMessages` 不能用可选参**。其签名
   `(db, taskId, config, round: number, authorMemberId, items, allow)` 的 `round` 是**中间位参**，
   `round?: number` 后跟必填参数 = **TS1016**。改为**在函数顶部解析一次**
   （`const round = explicit ?? await resolveMessageRound(...)`），再以显式 number 传给它内部的三个
   `postMessage`（`:2163/2181/2191`）。这同时兑现 §6 的「每次调用只读一次」，并保证同一轮产出的
   N 条消息 round 一致。
2. **【P1-8，对抗门攻击面 4】round 必须在 `nextMessageId()` **之前**解析**。今天
   `const id = nextMessageId()` 紧跟 `await db.insert`；在两者之间插入一个 `await` 会加宽
   「铸 id 与插入之间乱序」的窗口，而 RFC-186 §3-4 引入 `monotonicFactory` 正是为了消除它。
   顺序固定为 **解析 round → 铸 id → 插入**。（此改动会撞 `rfc186-phase3.test.ts:29` 的
   120 字符距离锁，须**有意识地**放宽并补注释，见 §7.1。）
3. **【P2，对抗门攻击面 7】派单卡族走独立入口，`round` 必填**：
   ```ts
   /** 派单卡族：round 恒取 assignment.round（它回答的是哪一轮的派单），不接受省略。 */
   async function postAssignmentMessage(
     db, taskId, assignment: Pick<WorkgroupAssignment, 'id' | 'round'>, m: Omit<PostMessageArgs, 'round'>,
   ): Promise<string>
   ```
   否则一次误删实参就会把「轮 2 派、轮 7 收工」的结果消息静默标成 round 7——与它的派单卡脱钩，
   并在单调线下抢在 leader 轮 7 自己的产出之前插一条「第 7 回合」。这一族的账本读数**定义上就是
   错答案**，不适用「省略即兜底」。

### 2.4 `workgroup_messages.round` 写入规则（归一后）

> **规则（lw）**：`round` = 该消息**写入时刻**账本读数。
> **规则（fc）**：`round` **恒 0** —— 该模式无回合语义（D10 / P2-5）。

**【D10，对抗门 P2-5】** v1 让 fc 消息继续携带预算计数器，与本 RFC 自己「那是类别错误」的论证
自相矛盾，也让 `round` 列在 fc 下变成「本行落地时已 mint 了多少成员 run」这种没人能用的数。
v2 统一：fc 下 `round`（消息与 assignment 两张表）恒 0。副作用是 fc 的 `assignment.round` 也恒 0
⇒ 派单卡族在 fc 下自动一致，无需额外分支。审计已确认没有任何行为读这两列。

例外**仅两族**，均显式传值：

| 例外 | 位置 | 值 |
|---|---|---|
| leader 轮自身产出 | `:1630/1656/1669/1688` + assignment `:1645` | 该轮 `wgRound`（这一轮由它定义） |
| 派单卡族 | `:1731/1845/1891/1904/1911`、路由 `:525/1292` | `assignment.round`（经 §2.3-3 的必填入口） |
| （前奏）开场目标消息 | `:950` | 显式 `0` |

其余改为解析：引擎 `:773, :1106, :1157, :1188, :1279, :1360, :1448, :2007, :2024, :2034,
:2083, :2116(assignment), :2127, :2138`，路由 `:432(assignment), :456, :638, :1247`。

**【P1-1，v2 新增的保护名单】** 以下三处是 **`node_runs.wgRound` 打戳**、不是消息 round，
一律**不动**（v1 只保护了第一处，机械清扫会伤到后两处）：

| 位置 | 作用 |
|---|---|
| `:1269` | 确认门 holder 的 `wgRound`（进 lw 账本的 `max()` 分支） |
| `:1953` | 被 @ 轮 mint 的成员 `wgRound`（lw 取账本 / fc 恒 NULL；显示用，`:673` 只看 leader 行） |
| `:1963` | 领养的被 @ 轮就地补戳，同上 |

**【P2-7】** `openCompletionGate`（`:1257-1283`）里 `:1269` 与 `:1279` 相隔 9 行、中间夹两个
`await`，注释却断言两者同轮。改为在函数顶部 `await resolveMessageRound` 一次、两处共用。

### 2.5 【v2 新增，P0 处置】`leaderRoundOf` 退役，卡片序数改读 `node_runs.wg_round`

`workgroupRoom.ts:207-213` 今天用 `1 + max(m.round | m.id < runId)` **从消息 round 反推** leader
卡片的轮序数。这在 RFC-182 时代是必要的 hack（当时没有 stamped ordinal）；RFC-189 之后
`node_runs.wg_round` 才是权威。而 §1.8 证明：T3 之后人类消息会带上**在飞轮**号，反推式序数必然漂移。

**具体失败场景（不修则必现）**：
1. leader 轮 2 mint（`wg_round=2`），账本 = 2；
2. 人发一句 → 写 `round = 2`；
3. attempt 0 协议违规 → attempt 1 mint 重试行 R2b（`wgRound` 仍 2，`:1489-1492`），ULID **晚于**那条人类消息；
4. `leaderRoundOf(R2b) = 1 + 2 = 3`（正确答案是 2）；
5. 卡进 `byRound[3]`，而不存在 round 3 分隔线 ⇒ 走尾部兜底（`workgroup-room.ts:149-153`）
   **渲染到房间最底部**，看起来像最新事件。

这正是 `workgroupRoom.ts:201-206` 注释与 `rfc179-member-current-run.test.ts:263-285`
（「重试共享轮号」，断言 `[1,1,2,null]`）专门锁住的回归。

**修法**：

```ts
// RunLite 增可选列（RFC-179 期 fixture 缺列 ⇒ 回退旧推导）
interface RunLite { …; wgRound?: number | null }

const roundOf = (run: RunLite): number =>
  run.wgRound ?? leaderRoundOfLegacy(run.id)   // 仅 0095 回填前/引擎外 mint 的历史行走回退
```

房间端点的 host-run select 补 `wgRound` 一列——**与 T4 的需求是同一列**，零额外成本。

### 2.6 房间聚合新增 `roundsUsed`

```ts
interface WorkgroupRoomResponse {
  …
  /** 已用回合数（= max_rounds 触顶判据读数）。上限走既有 config.maxRounds。 */
  roundsUsed: number
}
```

**零新查询**：该端点已加载 host runs（`routes/workgroupTasks.ts:303-313` 的 select，
`.from/.where` 至 `:320`），其过滤条件与引擎 `:538-547` **逐字相同**（task + `nodeId IN (leader, member)`），
故 `deriveRoundsUsed` 在房间侧得到与引擎完全一致的数。只需给 select 补 `wgRound`。

**契约面（对抗门已核实）**：`tests/contracts/registry.ts:302` 登记了该端点但**无 `happy` fixture**
⇒ 不施加 body schema；`WorkgroupRoomResponse` 是前端 interface、无 shared zod、无 `.strict()` 解析；
全仓无整体 `toEqual` / `Object.keys` 断言。**纯叠加，无需注册**。

### 2.7 前端 `buildRoomTimeline` 单调化 + 模式派生

**【P2-8】** 谓词放进既有单一事实源 `packages/frontend/src/lib/workgroup-mode.ts`
（该文件注释明写「future surfaces reuse this map so the colors can never drift」），
**不**在 `lib/workgroup-room.ts` 另开一个模式派生点（本仓 flag 审计把「kind 散射」列为 P0）：

```ts
/** fc 无全局回合（成员各自异步认领），房间不画回合分隔线。 */
export function roomShowsRoundDividers(mode: WorkgroupMode): boolean {
  return mode === 'leader_worker'
}
```

```ts
export function buildRoomTimeline(
  messages: readonly WorkgroupRoomMessage[],
  standaloneTurns: readonly WorkgroupRunEntry[] = [],
  opts: { dividers?: boolean } = {},   // 缺省 true ⇒ 既有 2-参调用零改动
): RoomTimelineEntry[]
```

分隔线判据由「变化」改为**单调水位线**，且**锚定与渲染解耦**：

```ts
let maxRound = 0                          // 0 = 前奏基线，永不为它画线
for (const m of sorted) {
  if (m.round !== prevRound) {            // 边界：始终产生锚点，供 byRound 冲刷
    base.push({ type: 'round', round: m.round, visible: dividers && m.round > maxRound })
  }
  if (m.round > maxRound) maxRound = m.round
  base.push({ type: 'message', message: m })
  prevRound = m.round
}
// 第二趟：遇 round 锚点一律冲刷 byRound；返回前过滤掉 visible === false 的锚点
```

- 水位线同时吸收了原来的 `round > 0` 前奏特例（`maxRound` 从 0 起步 ⇒ round 0 天然不画线）。
- **锚定不依赖分隔线是否可见**——对抗门确认「分隔线被抑制导致卡失锚」在当前数据下不可达
  （每张 round N 的卡都由 leader 轮产生，而该轮先写自己的 round N 消息 `:1630`，再插 assignment `:1645`），
  但 §2.5 的漂移一旦复发就会撞上；解耦是零成本的构造性保证。

`dividers === false`（fc）时，**所有** standalone turn 一律按 ULID 交织（`byRound` 保持空）。

**【对抗门攻击面 5 更正】** v1 说这是「防御性显式化」是错的，它**真承重**：`runKindOf`（`:76-86`）
对任何非 `wg-gate` 的 `__wg_leader__` 行都返回 `'leader-round'`；救 fc 的是 `classify`（`:104-107`）
的 `if (leaderMemberId === null) return null`，而 `shared/schemas/workgroup.ts:285-304` 的
`workgroupLaunchReadiness` **只在 lw 下校验 leaderMemberId、不强制 fc 置 null**
⇒ lw→fc 改过来的组可能留着陈旧 `leaderMemberId`，届时 fc 会冒出 `leader-round` 条目。

### 2.8 前端右栏预算表

复用现有 `<dl className="workgroup-room__info">`（`WorkgroupRoom.tsx:760-782`）的 dt/dd 行，
**零新 CSS、零新组件**：

| 模式 | dt | dd |
|---|---|---|
| leader_worker | `workgroups.room.infoMaxRounds`（不变） | `{maxRounds}`（不变） |
| free_collab | `workgroups.room.infoMemberTurnBudget`（新） | `{roundsUsed} / {maxRounds}` |

**【P2-6，如实标注】** fc 的门是 `roundsUsed + items.length >= maxRounds`（`workgroupWake.ts:172/186/240/258`），
**批量准入**：5 个成员 + `maxRounds=20` 时任务在 `roundsUsed = 16` 就 `failed: max-rounds`。
故 dd 后附一条 hint 文案说明「一批唤醒必须整批放得下才会启动」，不把「已用/上限」谎报成
「还能跑多少」。lw 的门是裸 `>= maxRounds`（`:215`），两模式不对称，文案分开写。

---

## 3. 数据流

```
node_runs(task) ──► deriveRoundsUsed(mode, rows)      ◄── 唯一推导（含 §5 的被取代行排除）
                        ├─► countRoundsUsed(state)     → 唤醒/触顶/宽限轮（除 §5 外行为不变）
                        ├─► resolveMessageRound()      → lw 消息 round；fc 恒 0
                        └─► GET /room 的 roundsUsed    → 右栏预算表

node_runs.wg_round ──► runHistory[].round（§2.5 新，替代 leaderRoundOf 反推）──┐
                                                                              ├─► buildRoomTimeline
workgroup_messages.round ─────────────────────────────────────────────────────┘        │
                                                          roomShowsRoundDividers(mode) ─┘
```

---

## 4. 与现有模块的耦合点

| 耦合点 | 分析 | 结论 |
|---|---|---|
| `workgroupWake.deriveWakeSet` / `decideWorkgroupOutcome` | 只吃 `roundsUsed: number`；除 §5 的被取代行排除外逐值不变 | AC-7 回归门把关 |
| `isLeaderWrapUpContinuation`（`:701-707`） | 同上 | 同上 |
| `workgroupRoom.leaderRoundOf`（`:207-213`） | **v1 分析错误（P0）**：账本返回在飞轮，人类消息会抬高 max ⇒ 反推序数漂移、卡片被冲到房间底部 | **退役**，改读 `wg_round`（§2.5）；NULL 回退旧推导 |
| prompt 组装 / 消费游标 / 上下文切片 | 审计确认**从不读** `.round`（`workgroupContext.ts` 里 `round` 只命中 5 处注释） | 零影响 |
| `node_runs.wg_round` 三处打戳 `:1269/:1953/:1963` | 保护名单（§2.4） | 不动 |
| `db/schema.ts:617` 的 `.default(0)` | 「省略即写 0」的默认值坑 | 由 §2.2 必填构造器关闭 |
| e2e | `visual-regression.spec.ts:330-416` 房间桩 `mode: dynamic_workflow` + 空 messages/runHistory，且**无 workgroup-room 基线 PNG** | 无需刷基线；补 `roundsUsed: 0` 保持契约诚实 |
| 并发改动 | RFC-206 触 `styles.css` / `task-detail-tabs.ts`；RFC-207 触 `autonomous`；本 RFC 触 `WorkgroupRoom.tsx` / `lib/workgroup-room.ts` / `workgroupRunner.ts` | 无重叠 |

---

## 5. 【v2 重做】Rider：被重铸的反问续跑双计

**v1 方案（给两行打同一个 `wgRound` 戳）已被推翻**，三条理由：

1. fc 分支**根本不读 `wgRound`** ⇒ 对 fc 是 no-op，而 fc 才是硬杀 + 要上 UI 的那个数；
2. 往 `__wg_member__` 行写非 NULL `wg_round` **违反 RFC-189 契约**（`:1740-1743` 明文「fc 恒 NULL」），
   并会经 `task.ts:3264` 流到 `NodeDetailDrawer.tsx:369-372` 显示出来；
3. 只在 NULL 尾巴 k=1 时成立；k≥2 时与不修等价。

**v2 方案 —— 派生层排除，零写入，两模式同时修**：

`deriveRoundsUsed` 排除**已被取代的**被杀反问续跑行，即同时满足：
`status === 'interrupted'` ∧ `isClarifyRerunCause(rerunCause)` ∧ 同 `(nodeId, shardKey)` 组内存在 id 更大的行。

- **lw**：`L3(wg_round=3)` + `C(NULL, interrupted)` + `C'(NULL, pending)` ⇒ C 被取代而排除
  ⇒ `max(3) + 1` = **4**（正确；与 revive 之前的读数一致，无跳变）。
- **fc**：被杀的成员行被排除 ⇒ 不再双烧预算。
- **k≥2**：逐行判定，天然正确。
- **未被取代的被杀行**（尚未 revive）仍计入——保持既有语义不变，不扩大改动面。

`reviveKilledClarifyContinuations` **本身不改**（保住
`rfc187-clarify-continuation-revival.test.ts:165` 的 arity 锁与 `:167` 的 1400 字符距离锁）。

---

## 6. 失败模式

| 失败模式 | 处置 |
|---|---|
| lw 每条引擎消息多一次 SELECT | 六列投影 + `(task_id, node_id)` 已有索引；`persistWgMessages` 每次调用只解析一次；fc 恒 0 不查库 |
| 解析与 INSERT 之间账本前进（TOCTOU） | 消息标签落在前一轮；由前端单调守卫吸收。**可接受残余** |
| 铸 id 与插入之间新增 await 加宽乱序窗口 | 顺序固定「解析 → 铸 id → 插入」（§2.3-2），并有意放宽 `rfc186-phase3.test.ts:29` 的距离锁 + 注释说明 |
| 同步事务内不能 await（确认门 `:634`、取消卡 `:1289`） | 事务**外**先解析，值捕获进闭包；构造器是纯函数 |
| `postMessage` 新增 `mode` 位置参数漏传 | typecheck 硬失败 |
| 派单卡族被误删 round 实参 | 独立入口 `postAssignmentMessage`，`round` 不接受省略（§2.3-3） |
| 路由新增写点忘了 round | 必填构造器 + `insert(workgroupMessages)` 白名单表锁（§7.1） |
| 新模块进初始化环、顶层 const 求值成 undefined | 节点 id 只在函数体内引用；`build:binary` 门禁（§2.1） |
| `deriveRoundsUsed('dynamic_workflow', …)` 落 fc 分支 | 入参窄化为 `RoundedWorkgroupMode`（§2.1） |
| fc 预算表被读成「还能跑多少轮」 | hint 文案说明批量准入（§2.8） |
| 将来给 fc 引入 leader 式卡片 | §2.7 的 `dividers=false ⇒ 全 ULID 交织` 会让它按时间落位；届时回看本节 |

---

## 7. 测试策略

> 本仓规矩：改动与测试同 commit；bug 修复先写红。

### 7.1 既有测试锁 —— **必改清单**（对抗门产出，不改则 CI 红或静默失真）

| 文件:行 | 现状 | 处置 |
|---|---|---|
| `backend/tests/rfc187-rounds-accounting.test.ts:34-40` | `RUNNER.split("r.rerunCause !== 'wg-protocol-retry'")` 计数 ≥2；两处都在 `countRoundsUsed` 体内 | **硬红**：T1 搬家后为 0。改指向 `workgroupRounds.ts`（本机已复核当前计数 = 2） |
| `backend/tests/rfc186-phase3.test.ts:29` | `postMessage` 到 `nextMessageId()` 距离 ≤120（今 72） | 解析行前置后必超；**有意**放宽并补注释说明顺序不变式 |
| `backend/tests/rfc187-clarify-continuation-revival.test.ts:165/167` | arity 锁 + 1400 距离锁 | v2 rider 不改该函数 ⇒ 两锁保持；作为回归网 |
| `frontend/tests/workgroup-room-lib.test.ts:87` | 标题「inserts a separator at **every round transition**」，输入 `[0,1,1,2]` 单调 ⇒ **仍绿但描述已废** | 改名 + 补非单调用例（否则静默失真） |
| `frontend/src/lib/workgroup-room.ts:104-108` | 文档注释描述旧规则 | 同步重写 |
| `frontend/tests/workgroup-room.test.tsx:66`、`workgroup-room-side-rail.test.tsx:77`、`dynamic-workflow-panel.test.tsx:35` | `WorkgroupRoomResponse` 字面量 | 加 `roundsUsed` 否则 TS2739 |
| `frontend/tests/task-detail-route-history.test.tsx:182/193` | `as unknown as WorkgroupRoomResponse` ⇒ **不报错、字段静默 undefined** | 显式补齐（这条最容易漏过门） |
| `backend/db/migrations/0095_rfc189_wg_round.sql:5` | 注释「exact countRoundsUsed derivation frozen at this migration」 | 更新指针（doc-only） |
| `e2e/visual-regression.spec.ts:412-415` | 房间桩无 `roundsUsed` | 补 `roundsUsed: 0` |

**开工前必做**：`grep -rn "countRoundsUsed\|currentRound\|buildRoomTimeline\|persistWgMessages" packages/*/src packages/*/tests`
盘全量源码级文本锁，命中集即定向套件（本仓三连事故教训）。

### 7.2 后端 `packages/backend/tests/rfc209-round-ledger.test.ts`（新）

- **互 oracle（AC-6）**：`deriveRoundsUsed` 与改动前口径的行内复刻在 lw / fc 各 fixture 上逐值相同
  （全 stamp / 全 NULL / 混合尾巴 / `wg-gate` 与 `wg-protocol-retry` 排除 / canceled 排除 / fc 计数制）。
  被取代行排除是**唯一**允许的差异，单独一组用例。
- **路由 round 归属（AC-4/5）**：lw 先驱一轮使账本 = 1 → `POST /messages` 消息 `round === 1`；
  带 @ 时 assignment 行同值；`POST /confirm`、`PUT /config` 同值。**fc 同场景恒 0**。
- **引擎不再写快照旧值**：假 hooks 制造「先启动的 fc 轮后落地」，断言其消息落地时刻读数。
- **前奏保持（AC-9）**：goal seed 仍 0 且 lw 下不被解析覆盖。
- **rider 红→绿（AC-11）**：lw **与 fc 各一条** —— 造 `interrupted` 反问续跑 + 重铸，
  断言 `deriveRoundsUsed` 不多计（改动前 fc 那条必红，v1 方案也修不好）。
- **触顶行为不变（AC-7）**：既有 `rfc164-workgroup-core` / `rfc187-maxrounds-wrapup` 零改动通过。
- **表级源码锁**：`insert(workgroupMessages)` 出现点全集 ⊆ 白名单，且 `routes/workgroupTasks.ts`
  的 `round: 0` 字面量为 0。

### 7.3 后端 `rfc209-leader-card-anchor.test.ts`（新，P0 回归网）

- `deriveWorkgroupRunHistory` 对 leader 条目返回 `run.wgRound`；重试行与其本轮**共享**轮号
  （对齐 `rfc179-member-current-run.test.ts:263-285` 的 `[1,1,2,null]` 语义）。
- **§1.8 的失败场景直测**：消息流含一条「leader 轮 2 在飞时写入的人类消息（round 2）」+ 晚于它的
  重试行 ⇒ 断言卡片轮号是 **2** 而非 3（改动前必红）。
- `wgRound === null`（RFC-179 期 fixture / 0095 回填前历史行）走回退推导。

### 7.4 前端 `rfc209-room-round-dividers.test.ts`（新，纯函数表测）

| case | 输入 rounds | 期望 dividers |
|---|---|---|
| 单调递增 | `[0,1,1,2]` | `[1,2]`（既有行为不回归） |
| 回退不画线 | `[1,2,1]` | `[1,2]` |
| 重复不画线 | `[1,1,1]` | `[1]` |
| 用户实测形态 | `[0,0,3,3,0,5,0,8,0,11]` | `[3,5,8,11]`，**零个 0** |
| 前奏（AC-9） | `[0,0]` | `[]` |
| **锚定不依赖可见性** | `[3,1]` + leader turn `round:1` | 卡仍锚在 round 1 处，**不落尾部** |
| fc 关闭（AC-1） | 任意 | `[]`，零 round 条目 |
| fc 全 ULID 交织 | 带 round 的 standalone turns | 按 nodeRunId 与消息 id 归并 |
| `roomShowsRoundDividers` | lw / free_collab / dynamic_workflow | `true / false / false` |
| React key 唯一 | `[5,0,5]` | 可见分隔线唯一 ⇒ 无重复 key |

### 7.5 前端渲染 `rfc209-room-budget.test.tsx`（新）

- **fc fixture 必须带非零 round 的消息**（对抗门指出既有 `fcRoom()` 是 `messages: []`
  ⇒ AC-1 今天零覆盖）：断言 `queryAllByTestId(/^wg-round-/)` 长度为 0。
- fc 右栏出现「成员发言预算」及 `7 / 20` + 批量准入 hint（AC-2）。
- lw fixture 含回退 round 的人类消息：分隔线序列单调（AC-3），`wg-round-0` 不存在。

### 7.6 i18n

**3 处编辑**（对抗门更正：v1 说 2 处）——`zh-CN.ts` 的**类型声明**（`infoMaxRounds: string` 旁）
+ zh 值 + `en-US.ts` 值；漏类型声明即 typecheck 红。
`i18n-keys-symmetry` / `i18n-batch-extraction` 是 zh↔en **集合**parity，无穷举计数，纯叠加安全。
`rfc164-workgroup-tabs.test.ts:166-171` 是抽查清单，追加为自愿项。

### 7.7 门禁

`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；前端 vitest 全绿；
**`bun run build:binary`**（新增 backend 服务模块 + 已知初始化环，§2.1）；零 migration ⇒ journal 计数锁不动。

---

## 8. 非目标（重申）

- 不改 `max_rounds` 预算语义（§5 的被取代行排除是**修正双计**，不是改口径）。
- 不给 fc 编造波次序数。
- 不做 migration / 不回填存量。
- 不动 `node_runs.wg_round` 的三处打戳（§2.4 保护名单）。
- 不统一 `workgroupLaunchReadiness` 在 fc 下的 `leaderMemberId` 校验（§2.7 提及的陈旧值问题）——
  独立缺陷，本 RFC 只在渲染侧构造性免疫，修它另立项。

---

## 9. 对抗设计门（v1 → v2）

Codex CLI 配额耗尽（提示 2026-07-25 恢复），按 RFC-185 / RFC-164 先例改用双路对抗自审
（正确性面 + 全仓回归面），findings 逐条处置：

| # | 级别 | finding | 处置 |
|---|---|---|---|
| 1 | **P0** | 账本返回**在飞轮**（`:1491` mint 早于 `:1512` run），v1「人类消息不会抬高 max」被证伪；leader 卡片会被冲到房间底部 | §1.8 + §2.5：`leaderRoundOf` 退役改读 `wg_round`；新增 §7.3 回归网 |
| 2 | P1 | rider 对 fc 是 no-op，且往成员行写 `wgRound` 违反 RFC-189 契约；k≥2 时等价于不修 | §5 整体重做为派生层排除（零写入、两模式、k 无关） |
| 3 | P1 | `persistWgMessages` 的 `round?` 是中间位参 ⇒ TS1016；且逐条转发会变成每条一次 SELECT | §2.3-1：顶部解析一次再显式下传 |
| 4 | P1 | 「lw 免疫、每轮 +1」过度断言：NULL 尾巴致跳、canceled 致退 | §1.7 新增；proposal 目标 3 收敛为 lw 可信 |
| 5 | P1 | 路由四处**不走** `postMessage`，schema `.default(0)` ⇒ 省略即写 0，表级字面量锁抓不到 | §2.2 必填行构造器 + 白名单表锁 |
| 6 | P1 | `rfc187-rounds-accounting.test.ts:34` 源码计数锁会因 T1 搬家归零（本机复核当前 = 2） | §7.1 必改清单 |
| 7 | P1 | `:1953/:1963` 两处 `wgRound` 打戳不在 v1 任何名单里，机械清扫会误伤 | §2.4 保护名单扩到三处 |
| 8 | P1 | 铸 id 与插入之间新增 await 加宽 RFC-186 §3-4 的乱序窗口 | §2.3-2 顺序不变式 + 有意放宽距离锁 |
| 9 | P2 | fc 下把「类别错误」的数写进 `round` 列，与 US-4 承诺矛盾 | D10：fc 下 `round` 恒 0 |
| 10 | P2 | fc 预算表高估余量（批量准入 `+items.length`） | §2.8 hint 文案 |
| 11 | P2 | `roomShowsRoundDividers` 另开模式派生点，与 `lib/workgroup-mode.ts` 单一事实源相冲 | §2.7 谓词放进既有文件 |
| 12 | P2 | `deriveRoundsUsed('dynamic_workflow')` 静默走 fc 分支 | §2.1 入参窄化 |
| 13 | P2 | `openCompletionGate` 的 `:1269`/`:1279` 快照 vs 实时不自洽 | §2.4 顶部解析一次共用 |
| 14 | P2 | fc「零 round 条目」结论对但**理由错**（真正承重的是 `classify` 的 `leaderMemberId === null`，而 readiness 不强制 fc 置 null） | §2.7 更正 |
| 15 | P2 | 锚点偏移 `:1655→:1656`、`:1856→:1852`、`:682-689→:683-689`、`:303-320→:303-313` | 全文订正 |
| 16 | P2 | 新模块可能进已存在的初始化环（`.dependency-cruiser.cjs` 无 `no-circular`） | §2.1 顶层 const 禁令 + `build:binary` |
| 17 | P2 | `task-detail-route-history.test.tsx` 用 `as unknown as` ⇒ 新字段静默 undefined 溜过类型门 | §7.1 必改清单 |
| 18 | P2 | fc AC-1 今天**零覆盖**（`fcRoom()` 是 `messages: []`） | §7.5 要求 fc fixture 带非零 round 消息 |
| — | — | 契约注册表无需注册 / e2e 无基线刷新 / 无 migration 影响 / i18n 集合 parity 安全 | 已核实，见 §2.6 §4 §7.6 |
