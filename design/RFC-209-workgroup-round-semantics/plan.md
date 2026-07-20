# RFC-209 任务分解

> **v2（2026-07-20）** —— 折入对抗设计门 1 P0 + 3 P1 + 4 P2（design.md §9）。
> 相对 v1：新增 T0（既有测试锁必改）、T9（`leaderRoundOf` 退役，P0 处置）；
> T2 保护名单扩到三处；T3 改用必填行构造器；T7（rider）方案整体重做。

单 PR（改动面互相咬合：账本抽取 → 写入闸口 → 卡片锚定 → 前端消费；拆开会留中间态房间显示不自洽）。
零 migration。

## 依赖图

```
T0 (既有测试锁必改，先做 —— 否则 T1 一落地就 CI 红)
 └─► T1 (账本单一事实源 + 被取代行排除)
       ├─► T2 (引擎写入归一)
       ├─► T3 (行构造器 + 路由写入归一)
       ├─► T4 (房间聚合 roundsUsed + select 补 wgRound)
       │     └─► T9 (leaderRoundOf 退役，改读 wgRound)   ← P0 处置
       │     └─► T6 (右栏 fc 预算表)
       └─► T7 (rider：被重铸续跑双计，两模式)
T5 (前端分隔线单调 + 锚定解耦 + fc 关闭) ── 独立于后端
T8 (新测试) 覆盖 T1–T9
```

---

## T0 —— 既有测试锁必改（先做）

对抗门产出的清单，见 design §7.1。逐项：

1. `backend/tests/rfc187-rounds-accounting.test.ts:34-40` —— `RUNNER.split(...)` 计数改指向
   `workgroupRounds.ts`（**本机已复核 `workgroupRunner.ts` 当前计数 = 2，T1 后为 0，必红**）。
2. `backend/tests/rfc186-phase3.test.ts:29` —— 有意放宽 `postMessage`→`nextMessageId()` 的距离锁
   （今 72、上限 120，解析行前置后必超），并补注释写明「解析 round → 铸 id → 插入」是不变式。
3. `frontend/tests/workgroup-room-lib.test.ts:87` 改名（标题描述的规则已废，输入单调 ⇒ 仍绿但失真）；
   `frontend/src/lib/workgroup-room.ts:104-108` 文档注释同步重写。
4. `WorkgroupRoomResponse` 字面量补 `roundsUsed`：`workgroup-room.test.tsx:66`、
   `workgroup-room-side-rail.test.tsx:77`、`dynamic-workflow-panel.test.tsx:35`（否则 TS2739），
   以及 **`task-detail-route-history.test.tsx:182/193`**（`as unknown as`，**不报错但静默 undefined**，
   最易漏过门）。
5. `e2e/visual-regression.spec.ts:412-415` 房间桩补 `roundsUsed: 0`（e2e 在 workspace typecheck 之外）。
6. `db/migrations/0095_rfc189_wg_round.sql:5` 的「countRoundsUsed derivation frozen here」注释更新指针。

**开工前**：`grep -rn "countRoundsUsed\|currentRound\|buildRoomTimeline\|persistWgMessages" packages/*/src packages/*/tests`
盘全量源码级文本锁，命中集即定向套件。

---

## T1 —— 回合账本单一事实源

新建 `packages/backend/src/services/workgroupRounds.ts`：

- `RoundLedgerRow`（id / nodeId / shardKey / status / rerunCause / wgRound）
- `RoundedWorkgroupMode = 'leader_worker' | 'free_collab'`（**窄化**，dynamic_workflow 不落 fc 分支）
- `deriveRoundsUsed(mode, rows)` —— 搬 `countRoundsUsed` 函数体 + **T7 的被取代行排除**
- `resolveMessageRound(db, taskId, mode)` —— lw 读账本；**fc 恒 0 且不查库**

改 `workgroupRunner.countRoundsUsed(state)` → `deriveRoundsUsed(state.config.mode, state.hostRuns)`。

⚠️ **模块环**：本仓已存在 `workgroupRunner → workgroupLaunch → services/task → scheduler →
workgroupRunner`，且 `.dependency-cruiser.cjs` 无 `no-circular`。新模块**不得**有从被导入常量派生的
顶层 const（会静默求值成 `undefined` 并把账本清零）；节点 id 只在函数体内引用。

**验收**：typecheck 绿；既有 max_rounds / 宽限轮 / fc 死锁测试零改动通过。

---

## T2 —— 引擎侧写入归一

`services/workgroupRunner.ts`：

1. `postMessage` 增位置参数 `mode`，`PostMessageArgs.round` 改可选（省略 = 解析）。
   **顺序固定「解析 round → `nextMessageId()` → insert」**（不得在铸 id 与插入之间新增 await）。
2. `persistWgMessages` 的 `round` **不可选**（中间位参，`round?` 后跟必填参 = TS1016）：
   在函数顶部解析一次，再以显式 number 传给内部三个 `postMessage`（`:2163/2181/2191`）。
3. 新增 `postAssignmentMessage(db, taskId, assignment, m)` —— 派单卡族专用，`round` 恒取
   `assignment.round`、**不接受省略**；`:1731/1845/1891/1904/1911` 改走它。
4. 下列 14 处删掉显式 round 实参：
   `:773, :1106, :1157, :1188, :1279, :1360, :1448, :2007, :2024, :2034, :2083, :2127, :2138`
   + assignment 插入 `:2116`（fc self_claim 卡，fc ⇒ 恒 0）。
5. **保留显式值**：leader 轮 `:1630/1645/1656/1669/1688` → `wgRound`；goal seed `:950` → 显式 `0`。
6. **保护名单（不动）**：`:1269` / `:1953` / `:1963` —— 这三处是 `node_runs.wgRound` 打戳，不是消息 round。
7. `openCompletionGate` 顶部解析一次，`:1269` 与 `:1279` 共用（消除快照 vs 实时不自洽）。

---

## T3 —— 行构造器 + 路由写入归一

1. 新增共享 `buildRoomMessageRow({ …, round })` —— **`round` 必填、无默认**，关闭
   `db/schema.ts:617` 的 `.default(0)` 坑（路由四处是裸 insert，省略即静默写 0）。
2. 引擎 `:631` 与路由五处 `:453/521/634/1244/1289` 全部改经它。
3. 四处硬编码 `round: 0` 改解析：

| 行 | 目标 | 备注 |
|---|---|---|
| `:432` | 人 @ 派单的 assignment 行 | 连带修好该卡后续结果消息归属 |
| `:456` | 人类房间消息 | |
| `:638` | 确认门决定 | 该 insert 在 `resumeTaskWithAtomicSideEffects` 的 **sync** tx 回调内（**非** `dbTxSync`，v1 写错）；在事务**外** await 解析、值捕获进闭包 |
| `:1247` | 中途改配置 | |

四处的 `config` 均已在作用域内（`:410` / `:896` / confirm handler 经 `loadVisibleWorkgroupTask`）。

**验收**：该文件 `round: 0` 字面量归零；`insert(workgroupMessages)` 全集 ⊆ 白名单（T8 表锁）。

---

## T4 —— 房间聚合 `roundsUsed`

1. `routes/workgroupTasks.ts:303-313` 的 host-run select 补 `wgRound: nodeRuns.wgRound`
   （**T9 也需要这一列**，一次补齐）。
2. 响应体新增 `roundsUsed: deriveRoundsUsed(config.mode, hostRuns)`（**零新查询**；该 select 的过滤条件
   与引擎 `:538-547` 逐字相同）。
3. 前端 `lib/workgroup-room.ts` 的 `WorkgroupRoomResponse` 增 `roundsUsed: number`。

契约面已核实无需注册（design §2.6）。

---

## T5 —— 前端分隔线单调化 + 锚定解耦 + fc 关闭

1. `roomShowsRoundDividers(mode)` 放进**既有** `packages/frontend/src/lib/workgroup-mode.ts`
   （不另开模式派生点——本仓 flag 审计把「kind 散射」列 P0）。
2. `buildRoomTimeline` 增第三参 `opts: { dividers?: boolean } = {}`（缺省 true ⇒ 既有 2-参调用零改动）。
3. 判据改**单调水位线** `m.round > maxRound`（`maxRound` 从 0 起 ⇒ 同时吸收原 `round > 0` 前奏特例）。
4. **锚定与渲染解耦**：round 边界始终产生内部锚点（供 `byRound` 冲刷），锚点带 `visible` 位，
   返回前过滤不可见锚点。
5. `dividers === false` 时所有 standalone turn 走 ULID 交织（`byRound` 保持空）——
   这**真承重**（`workgroupLaunchReadiness` 不强制 fc 的 `leaderMemberId` 置 null，
   lw→fc 改过的组可能冒出 `leader-round` 条目）。

调用处 `WorkgroupRoom.tsx:187-190` 传 `{ dividers: roomShowsRoundDividers(data.config.mode) }`。

---

## T6 —— 右栏 fc 预算表

`WorkgroupRoom.tsx:778-779` 的 dt/dd 按模式分支（**复用现有 `workgroup-room__info`，零新 CSS、零新组件**）：

- lw：`infoMaxRounds` / `{maxRounds}`（原样）
- fc：`infoMemberTurnBudget` / `{roundsUsed} / {maxRounds}` + **批量准入 hint**
  （fc 的门是 `roundsUsed + items.length >= maxRounds`，5 成员 / 上限 20 时 16 就触顶；
  不把「已用/上限」谎报成「还能跑多少」）

i18n **3 处编辑**：`zh-CN.ts` 类型声明（`infoMaxRounds: string` 旁）+ zh 值 + `en-US.ts` 值。

**验收**：明暗双主题视觉自查（最小复现 HTML + 本地 http server + chrome 截图，不靠肉眼跳过）。

---

## T7 —— rider：被重铸的反问续跑双计（**v2 重做**）

在 `deriveRoundsUsed` 中排除**已被取代**的被杀反问续跑行：
`status === 'interrupted'` ∧ `isClarifyRerunCause(rerunCause)` ∧ 同 `(nodeId, shardKey)` 组内存在 id 更大的行。

- 零写入 ⇒ 不违反 RFC-189「fc 成员行 `wgRound` 恒 NULL」契约；
- lw 与 **fc 同时**修好（v1 的打戳方案对 fc 是 no-op —— fc 分支根本不读 `wgRound`）；
- k≥2（多条 NULL 尾巴）天然正确；
- `reviveKilledClarifyContinuations` **本身不改** ⇒ 保住
  `rfc187-clarify-continuation-revival.test.ts:165/167` 的 arity 锁与距离锁。

---

## T9 —— `leaderRoundOf` 退役，卡片轮号改读 `wg_round`（**P0 处置，不可省**）

`services/workgroupRoom.ts:207-213` 今天用 `1 + max(m.round | m.id < runId)` 从**消息 round 反推**
leader 卡片轮号。这是 RFC-182 时代的必要 hack（当时没有 stamped ordinal）；RFC-189 之后
`node_runs.wg_round` 才是权威。

**为什么 T3 会引爆它**：`driveLeaderTurn` 在 `runHostNode`（`:1512`）**之前**就把本轮的行连
`overrides: { wgRound }` 落库（`:1481-1492`），所以账本返回的是**在飞轮**；而路由只挡
done/failed/canceled（`:616-618`），人在 leader 跑动中可以发言。于是「leader 轮 2 在飞 → 人发言写
round 2 → attempt 1 重试行 ULID 晚于它 → `leaderRoundOf` 得 3（正确是 2）→ 卡进不存在的 round 3 桶
→ 走尾部兜底渲染到房间最底部」。这正是 `workgroupRoom.ts:201-206` 注释与
`rfc179-member-current-run.test.ts:263-285`（`[1,1,2,null]`「重试共享轮号」）锁住的回归。

**改法**：

1. `RunLite` 增可选列 `wgRound?: number | null`（RFC-179 期 fixture 缺列 ⇒ 走回退）。
2. leader 条目轮号取 `run.wgRound ?? leaderRoundOfLegacy(run.id)` —— 回退只服务 0095 回填之前
   / 引擎外 mint 的历史行。
3. 数据来源即 T4 补的那一列，零额外查询。

**验收**：`rfc209-leader-card-anchor.test.ts`（T8）；既有
`rfc179-member-current-run.test.ts:263-285` 零改动通过。

---

## T8 —— 新测试

按 design §7.2–§7.6：

- `backend/tests/rfc209-round-ledger.test.ts` —— 互 oracle / 路由归属（lw 账本读数 vs **fc 恒 0**）/
  引擎实时解析 / 前奏 / **rider 红→绿 lw + fc 各一条** / 表级源码锁
- `backend/tests/rfc209-leader-card-anchor.test.ts` —— **P0 回归网**：卡片轮号读 `wgRound`、
  重试与本轮共享轮号、§1.8 失败场景直测（改动前必红）、`wgRound === null` 回退
- `frontend/tests/rfc209-room-round-dividers.test.ts` —— 单调水位线表测（含 `[3,1]` + leader turn
  的**锚定不依赖可见性**用例、`[5,0,5]` 的 React key 唯一性）+ fc 关闭 + `roomShowsRoundDividers` 表测
- `frontend/tests/rfc209-room-budget.test.tsx` —— **fc fixture 必须带非零 round 的消息**
  （既有 `fcRoom()` 是 `messages: []` ⇒ AC-1 今天零覆盖）+ 预算表 + hint；lw 单调

每个测试文件顶部注释写明「这条测试锁的是哪类回归」并链回本 RFC。

---

## 验收清单

| # | 项 | 对应 AC |
|---|---|---|
| 1 | fc 房间零 `wg-round-*`（fixture 带非零 round 消息） | AC-1 |
| 2 | fc 右栏「成员发言预算 N / M」+ 批量准入 hint，N 与触顶判据同源 | AC-2 |
| 3 | lw 分隔线单调、回退不画线、无重复 React key | AC-3 |
| 4 | lw 四处路由消息 round == 写入时刻账本读数；fc 恒 0 | AC-4 |
| 5 | 人 @ 派单 assignment.round 同上，结果消息随之归位 | AC-5 |
| 6 | `deriveRoundsUsed` 与旧口径互 oracle（除被取代行排除外逐值相同） | AC-6 |
| 7 | 触顶 / 宽限轮 / fc 死锁既有测试零改动通过 | AC-7 |
| 7b | 派单卡族 round 仍恒等于 `assignment.round`（长跑 worker 跨轮收工不脱钩） | AC-8 |
| 8 | goal seed 仍 round 0 且不画线 | AC-9 |
| 9 | leader 卡片轮号读 `wg_round`，重试共享轮号；§1.8 场景不再把卡冲到房间底部 | AC-10 |
| 10 | 被重铸的反问续跑在 **lw 与 fc** 都不多计 | AC-11 |
| 11 | 五门全绿 + **`build:binary`**（新模块 + 已知初始化环） | 门禁 |
| 12 | Codex 门：配额恢复（2026-07-25）后补跑设计门与实现门，findings 全折 | 仓库规矩 |

---

## PR 拆分建议

**单 PR**：`fix(workgroup): RFC-209 自由协作房间回合语义归位（不再假装有回合 + 回合号单一事实源）`

T7（rider）与 T9（`leaderRoundOf` 退役）各自可独立成 commit；若实现期发现 T9 波及面超预期，
它是**唯一**可以摘出的（但摘出则 T3 必须同时降级为「人类消息取最后一个已完成轮」，否则复现 P0）。
