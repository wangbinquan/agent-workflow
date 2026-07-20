# RFC-209 任务分解

单 PR（改动面集中、互相咬合：账本抽取 → 写入归一 → 前端消费；拆开会留中间态房间显示不自洽）。
零 migration。

## 依赖图

```
RFC-209-T1 (账本单一事实源)
   ├─► T2 (引擎写入归一)
   ├─► T3 (路由写入归一)
   ├─► T4 (房间聚合 roundsUsed)
   └─► T7 (rider: wg_round 双计)
T4 ─► T6 (右栏预算表)
T5 (前端分隔线单调 + fc 关闭) ── 独立于后端
T8 (测试) 覆盖 T1–T7
```

---

## T1 —— 回合账本单一事实源

新建 `packages/backend/src/services/workgroupRounds.ts`：

- `RoundLedgerRow` 投影类型（nodeId / status / rerunCause / wgRound）
- `deriveRoundsUsed(mode, rows)` —— 搬 `workgroupRunner.countRoundsUsed` 的函数体，**逐字节等价**
  （lw：`max(wg_round)` + NULL 尾巴排除 `wg-gate`/`wg-protocol-retry`；fc：成员行计数排除
  canceled / `wg-protocol-retry`）
- `readRoundsUsed(db, taskId, mode)` —— 三列投影 SELECT + `deriveRoundsUsed`

改 `workgroupRunner.countRoundsUsed(state)` → `deriveRoundsUsed(state.config.mode, state.hostRuns)`；
`currentRound` 别名保持。

**开工前**：`grep -rn "countRoundsUsed" packages/backend/tests/` 盘清源码级测试锁，命中集即定向套件
（本仓三连事故教训）。

**验收**：`bun run typecheck` 绿；既有 max_rounds / 宽限轮 / fc 死锁测试零改动通过。

---

## T2 —— 引擎侧写入归一

`services/workgroupRunner.ts`：

1. `PostMessageArgs.round` 由 `number` 改 `number | undefined`（**省略 = 实时读账本**，极性见 design §2.2）；
   `postMessage` 增位置参数 `mode: WorkgroupMode`；`persistWgMessages` 的 `round` 参数同步可选化。
2. 下列 14 处删掉显式 round 实参（改为省略）：
   `:773, :1106, :1157, :1188, :1279, :1360, :1448, :2007, :2024, :2034, :2083, :2127, :2138`
   以及 assignment 插入 `:2116`（fc self_claim 卡）改 `await readRoundsUsed(...)`。
3. **保留显式值**（design §2.3 两族例外 + 前奏）：
   - leader 轮 `:1630/1645/1655/1669/1688` → `wgRound`
   - 派单卡族 `:1731/1845/1891/1904/1911` → `assignment.round`
   - goal seed `:950` → 显式 `0`
4. **明确不动** `:1269`（确认门 holder 的 `node_runs.wgRound` 打戳）。

**验收**：typecheck 绿（`mode` 是必填位参，漏传硬失败）；引擎测试全绿。

---

## T3 —— 路由侧写入归一

`routes/workgroupTasks.ts` 四处硬编码 `round: 0` 改实时读数：

| 行 | 目标 | 备注 |
|---|---|---|
| `:432` | 人 @ 派单的 assignment 行 | 连带修好该卡后续结果消息的归属 |
| `:456` | 人类房间消息 | |
| `:638` | 确认门决定 | 在 `dbTxSync` **外**先 await 读数，值捕获进事务闭包（design §6 TOCTOU 残余） |
| `:1247` | 中途改配置 | |

**验收**：该文件 `round: 0` 字面量归零（T8 表级源码锁）。

---

## T4 —— 房间聚合 `roundsUsed`

1. `routes/workgroupTasks.ts:303-320` 的 host-run select 补一列 `wgRound: nodeRuns.wgRound`。
2. 响应体新增 `roundsUsed: deriveRoundsUsed(config.mode, hostRuns)`（**零新查询**）。
3. 前端 `lib/workgroup-room.ts` 的 `WorkgroupRoomResponse` 增 `roundsUsed: number`。

**验收**：契约注册表 / wire 断言按既有惯例同步。

---

## T5 —— 前端分隔线单调化 + fc 关闭

`packages/frontend/src/lib/workgroup-room.ts`：

1. 新增 `roomShowsRoundDividers(mode)`（lw → true，其余 → false）。
2. `buildRoomTimeline` 增第三参 `opts: { dividers?: boolean } = {}`（缺省 true ⇒ 既有 2-参调用零改动）。
3. 分隔线判据由「变化」改为**单调水位线** `m.round > maxRound`（同时吸收原 `round > 0` 前奏特例，
   代码更短）。
4. `dividers === false` 时所有 standalone turn 走 ULID 交织（`byRound` 保持空）。

`components/workgroup/WorkgroupRoom.tsx:187-190` 调用处传
`{ dividers: roomShowsRoundDividers(data.config.mode) }`。

**验收**：`workgroup-room-lib.test.ts` 既有 case 全绿（审计已确认单调化不破坏任何现存断言）。

---

## T6 —— 右栏 fc 预算表

`WorkgroupRoom.tsx:778-779` 的 dt/dd 行按模式分支（**复用现有 `workgroup-room__info`，零新 CSS、零新组件**）：

- lw：`infoMaxRounds` / `{maxRounds}`（原样）
- fc：`infoMemberTurnBudget` / `{roundsUsed} / {maxRounds}`

i18n 新增 `workgroups.room.infoMemberTurnBudget`（zh：`成员发言预算`；en：`Member turn budget`）
+ zh-CN 类型声明。

**验收**：明暗双主题视觉自查（按仓库规矩用最小复现 HTML + 本地 http server + chrome 截图，
不靠肉眼跳过）。

---

## T7 —— rider：`wg_round` 双计修复

`services/workgroupRunner.ts` 的 `reviveKilledClarifyContinuations`（`:305-339`）：
重铸前算 `R = deriveRoundsUsed(mode, state.hostRuns)`，
`stampWgRound(db, latest.id, R)` + 重铸 `overrides: { …, wgRound: R }`。

**验收**：AC-8 红→绿回归测试。可单独摘除而不影响 T1–T6。

---

## T8 —— 测试

按 design §7 落三个新文件 + 一处 key ratchet：

- `packages/backend/tests/rfc209-round-ledger.test.ts`（互 oracle / 路由归属 / 引擎实时读 /
  前奏 / rider 红→绿 / 表级源码锁）
- `packages/frontend/tests/rfc209-room-round-dividers.test.ts`（单调水位线表测 + fc 关闭 +
  `roomShowsRoundDividers` 表测）
- `packages/frontend/tests/rfc209-room-budget.test.tsx`（fc 零分隔线 + 预算表渲染；lw 单调）
- `rfc164-workgroup-tabs.test.ts` key ratchet 追加 `infoMemberTurnBudget`

每个测试文件顶部注释写明「这条测试锁的是哪类回归」并链回本 RFC。

---

## 验收清单

| # | 项 | 对应 AC |
|---|---|---|
| 1 | fc 房间零 `wg-round-*` | AC-1 |
| 2 | fc 右栏「成员发言预算 N / M」，N 与触顶判据同源 | AC-2 |
| 3 | lw 分隔线单调、回退不画线 | AC-3 |
| 4 | 四处路由消息 round == 写入时刻账本读数 | AC-4 |
| 5 | 人 @ 派单 assignment.round 同上，结果消息随之归位 | AC-5 |
| 6 | `deriveRoundsUsed` 新旧互 oracle 逐值相同 | AC-6 |
| 7 | 触顶 / 宽限轮 / fc 死锁既有测试零改动通过 | AC-7 |
| 8 | 重铸反问续跑不再多计一轮 | AC-8 |
| 9 | goal seed 仍 round 0 且不画线 | AC-9 |
| 10 | 五门全绿（typecheck / lint / test / format / 前端 vitest）+ binary smoke | 门禁 |
| 11 | Codex 设计门（批准前）+ 实现门（宣告完成前）findings 全折 | 仓库规矩 |

---

## PR 拆分建议

**单 PR**：`fix(workgroup): RFC-209 自由协作房间回合语义归位（不再假装有回合 + 回合号单一事实源）`

拆分只在以下情形考虑：T7（rider）若在实现期发现波及面超预期，可摘出为独立后续 commit。
