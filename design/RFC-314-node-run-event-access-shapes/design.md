# RFC-314：技术设计

## 1. 范围

三处改动，全部在 `packages/backend/src/services/` 内就地修，**零 migration、零新索引、零 wire 形状变化**：

| 代号 | 文件 | 改什么 |
|---|---|---|
| D1 | `services/autoKill.ts` | `findStalledRunningChildren` 的 `max(ts)` join 改为逐 run 的有界反向窗口 |
| D2 | `services/sessionView.ts` | 两段窗口的取法由 `ORDER BY ts` 改为 `ORDER BY id`，并按 node_run 逐个查询后合并 |
| D3 | `services/runner.ts` + `services/execution/managedProcess.ts` | 事件落库按 chunk 合并成多行 INSERT；pump 增加 chunk 边界回调 |

## 2. 现状实测（可复跑）

### 2.1 基准库

把开发库的 `node_run_events` 按同形放大到生产量级（payload 分布原样保留）：

```
786,000 行 / payload 1959 MiB / 文件 2.65GB
1019 个 node_run，平均 771 事件/run，最大 108,133 事件/run
```

### 2.2 三处的归档前后计时（单条语句）

| 路径 | 归档前 | 归档收敛后（204,444 行 / per-run ≤6388） |
|---|---|---|
| `findStalledRunningChildren`（20 个 running run） | **194.9ms** | 34.6ms |
| `getSessionTree` tail（20000 行窗口） | **461.5ms** | <50ms |
| `getSessionTree` prefix（500 行窗口） | **122.0ms** | <50ms |
| `getNodeRunStdout`（50001 行，形状已正确，非本 RFC 范围） | 81.9ms | 11.0ms |

对照组（同一份库、同一轮）：`/api/overview` 13 条语句最大 0.1ms、`/api/tasks/page` 4 条最大 2.8ms、
两个徽章各 1 条 ≤2.4ms、1Hz limits 1 条 0.0ms、stuck 巡检 425 条最大 2.8ms、分页事件读 500 行 1.0ms
——**读面整体是健康的，问题精确落在上面三处**。

### 2.2b 修复后复测（AC-1 / AC-2，2026-08-21）

同形基准库重建（672,848 行 / payload 1674 MiB / 2.12GB / 单 run 最大 96,112 事件 / 20 个 running run），
跑**修复后**的代码逐语句计时：

| 路径 | 修复前 | 修复后 |
|---|---|---|
| `findStalledRunningChildren` | **194.9ms** 单条 | 21 条语句、最慢 **0.4ms**（每条取 200 行），0 条超阈 |
| `getSessionTree`（mega run） | **461.5ms + 122.0ms** 两条 | 5 条语句、最慢 **48.8ms**，0 条超阈 |

AC-2 达标但**余量不大，如实记下**：剩下的 48.8ms 已经不是排序开销，而是尾窗 20000 行 × payload
的纯搬运（≈50MB）。关键差别是它现在是 **O(窗口上限)** 而不是 O(run 事件数)——96,112 事件与
500,000 事件取回的行数相同。要再降是调 `SESSION_TAIL_CAP` 的事，属另一个决定，不在本 RFC 范围。

### 2.3 EXPLAIN 事实（决定改法的四条）

```
① 现状 tail（ORDER BY ts，单 run）   → SEARCH … USING INDEX idx_events_node + USE TEMP B-TREE FOR ORDER BY
② 改按 id 排（单 run）               → SEARCH … USING INDEX idx_events_node          ← 排序器消失
③ 改按 id 排（IN 多值，3 个 run）    → SEARCH … + USE TEMP B-TREE FOR ORDER BY        ← 排序器仍在
④ max(ts) over (最后 200 行子查询)   → CO-ROUTINE + SEARCH … USING INDEX idx_events_node（无排序器）
```

③ 是本设计里最容易踩空的一条：`idx_events_node` 是 `(node_run_id, id)`，多值 `IN` 之后 SQLite 无法
沿单一索引顺序产出全局有序结果，只能再排一次。**因此 D2 必须按 node_run 逐个查询再在 JS 合并**，
不能只把 `ORDER BY ts` 换成 `ORDER BY id` 了事。

### 2.4 复跑方式

放大：`INSERT INTO node_run_events (…) SELECT … FROM node_run_events` 连续倍增到目标行数；
计时：包住 `bun:sqlite` 的 `prepare`/`query` 记录每条语句耗时（形状同
`tests/helpers/statementRecorder.ts`，加一个 `performance.now()` 差值）；
被测入口直接调 service 函数，不经 HTTP。

## 3. D1 —— autoKill 的僵死判据

### 3.1 现状

```ts
// services/autoKill.ts:53-66
.select({ …, lastTs: max(nodeRunEvents.ts) })
.from(nodeRuns)
.leftJoin(nodeRunEvents, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
.where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRuns.pid)))
.groupBy(nodeRuns.id)
```

一条语句要把**每个 running run 的全部事件**走一遍索引求 max，再走 TEMP B-TREE 分组。
消费者只用它做一次比较：`(lastTs ?? startedAt ?? 0) < now - stallMs`（`autoKill.ts:67`），
而 `stallMs` 是分钟～小时级。

### 3.2 改法

拆成「一条窄查询取候选 run」+「每个候选一条有界窗口查询」：

```ts
const runs = await db.select({ id, taskId, pid, startedAt, spawnBinaryPath })
  .from(nodeRuns)
  .where(and(eq(nodeRuns.status, 'running'), isNotNull(nodeRuns.pid)))   // idx_node_runs_status_active

// 每个候选一条（EXPLAIN ④：co-routine + 索引 seek，无排序器）
const lastTs = await db.get(sql`
  SELECT max(ts) AS ts FROM (
    SELECT ts FROM node_run_events WHERE node_run_id = ${run.id}
    ORDER BY id DESC LIMIT ${STALL_TS_WINDOW_ROWS}   // 200
  )`)
```

**为什么是窗口而不是最后一行**：子代理事件由 `subagentLiveCapture` 回灌，携带 opencode 的**原始 ts**，
可能早于插入序。只取最后一行会低估活跃度，而这里的后果是**杀掉一个真实进程**，不是误报一条告警
（`stuckTaskDetector.ts:184-196` 用的是「只取最后一行」，那边的后果只是一条 lifecycle alert，
两处判据不同是刻意的，各自在注释里写明）。窗口 200 行足以吸收一个轮询间隔的回灌量。

**为什么不加 `(node_run_id, ts)` 索引**：见 proposal §1 的写放大实测；且窗口法已把误差压到远小于
分钟级阈值。

**语句数**：O(running run 数)，上界是 `maxConcurrentNodes`（默认 10），与事件量无关。这是刻意接受的
N+1——它的 N 是并发度而不是数据量，形态与 `stuckTaskDetector` 已有的逐 run 查询一致。

## 4. D2 —— 会话树的两段窗口

### 4.1 现状与约束

`sessionView.ts:133-147` 取两段：**最早 PREFIX(500) 条**（`deriveRootSessionId` 定根用，缺了会把整棵树
渲染成以子代理为根）+ **最新 TAIL(20000) 条**（近期内容），两条都 `ORDER BY ts`，合并后再在 JS 里
按 `(ts, id)` 排序去重（`sessionView.ts:150`）。

### 4.2 改法

1. 两段窗口改按 `id` 取：prefix `ORDER BY id ASC LIMIT 500`、tail `ORDER BY id DESC LIMIT 20000`。
2. `where` 由 `inArray(nodeRunId, targetNodeRunIds)` 拆成**逐 node_run 一条**（EXPLAIN ③），
   每个 run 各取自己的两段窗口，然后合并。
3. 合并后的 JS 排序**一字不改**——输出顺序仍是 `(ts, id)`。

窗口上限的语义随之从「全局最早/最新 N 条」变成「每个 run 最早/最新 N 条」。lineage 的 run 数是
同一节点的重试/迭代代次（个位数），总量仍然有界；且定根只需要**第一个 run 的**最早若干条，
按 run 切分反而更贴合它的用途。

### 4.3 与归档 JSONL 的关系

归档侧本来就按 node_run 逐个读（`sessionView.ts:159` `readArchivedEvents(logsDir, taskId, id, 0, CAP)`），
D2 把 DB 侧也改成逐 run，两边形状因此一致。合并顺序与去重逻辑不变。

## 5. D3 —— 事件落库按 chunk 合并

### 5.1 现状

`services/execution/managedProcess.ts:145-205` 的 `pump()` 是全仓**唯一**的流泵（RFC-282 E1a 收口）：
每读到一个 chunk，就在内层循环里逐行 `await onLine(line)`。runner 的 `onStdoutLine`
（`runner.ts:1391`）对每一行做一次 `persistRunnerWrite('node-run-event/stdout', () => insert(...))`。
即：**一行 stdout = 一条 autocommit INSERT + 一次重试包装**。

### 5.2 改法

给 `pump()` 增加可选的 `onChunkEnd?: () => Promise<void> | void`，在内层行循环耗尽后（以及 EOF 的
收尾行之后）调用一次。runner 侧：

- `onStdoutLine` / `onStderrLine` 不再直接 INSERT，而是把行推进一个**每 nodeRun 的缓冲**；
- `onChunkEnd` 冲刷缓冲：按 `EVENT_INSERT_MAX_ROWS`（100 行 × 6 列 = 600 绑定参数，
  低于仓内 900 护栏线）切块，每块一条多行 INSERT，仍整体包在 `persistRunnerWrite` 里；
- **任一行处理抛错**（协议非法 / 会话租约失败等既有抛点）时，先冲刷缓冲再抛——取证事件恰恰在失败
  时最重要；
- 进程收尾（`drainFinalEvents` / 正常结束 / 取消）路径同样先冲刷。

选 chunk 作为边界的理由：它是**唯一一个既天然存在、又不引入新的持久化延迟**的边界。缓冲在同一个
`await onChunkEnd()` 内写完才让出事件循环，pump 的下一次 `reader.read()` 之前一定已经落库，
因此不存在「读点看到未落库事件」的窗口，也不需要给 `countAgentTextEvents` / `getNodeRunEvents` /
会话租约 retag / WS 回放加任何 flush 屏障。

其余四个 `pump()` 调用方（scriptRun / systemAgentRun / runtimeSmoke / scheduler）不传 `onChunkEnd`，
行为逐字不变。

### 5.3 不变量

- **id 单调**：多行 INSERT 按值顺序分配 rowid。
- **ts 逐行保留**：每行仍带自己在解析时算出的 `ts`，不是批时间。
- **WS 不变**：`broadcastParentRunning()` 是节流的 `node.status` 提示（`runner.ts:1302-1313`），
  不是逐事件帧。**实现时的修正**（记账见 plan §5.2）：保持**逐行**调用而不是改成按批——它不写 DB，
  逐行调用等于零行为变化，改成按批反而是一次没有收益的行为改动。
- **重试语义**：整块 INSERT 失败即整块重试（`retrySqliteWrite`），不会出现半块落库——多行 INSERT
  是单条语句，天然原子。

## 6. 与 RFC-294 目标架构的对齐

三个文件在目标架构里都归 **`task-execution` bounded context**：`autoKill.ts` 与 `sessionView.ts` 属
application 层的恢复 worker 与读模型，`runner.ts` / `managedProcess.ts` 属 execution kernel 一侧的
运行时适配。本 RFC **不做结构搬迁**，理由与 RFC-311 相同（横切形状修复，搬迁会把一个可验证的性能
改动混进大规模移动），债显式记账：

- 债 1：三处仍平铺在 `services/`，未落入 `modules/task-execution/{application,infrastructure}`；
  随该 context 的下一个搬迁波次一起迁（迁移时保留同名 facade 保 import 路径稳定）。
- 债 2：`autoKill` 是 RFC-294 §2 计数的 28 处 production `setInterval` 之一，本 RFC 只改它读什么，
  不改它由谁调度；job/worker 归一仍归 W0-R。
- 本 RFC **不新增**任何 cross-context 内部 import、facade 或全局单例；`pump()` 的新参数是既有
  execution 层公共原语的最小扩展（可选参数、默认无行为）。

## 7. 失败模式

| 场景 | 行为 |
|---|---|
| 某 run 的最后 200 行全部是回灌的旧 ts | D1 低估活跃度 ⇒ 可能提前判僵死。缓解见 proposal §4 B1；`autoKillStalledChild` 默认关 |
| lineage 有很多代次（如 8 次重试） | D2 的语句数 = 2 × run 数，仍是个位数条；每条有界 |
| 一个 chunk 里有上千行 | D3 按 100 行切块，多条语句但每条 ≤600 绑定参数；总语句数仍远少于逐行 |
| 冲刷时 DB 忙 | 走既有 `persistRunnerWrite` 重试；重试失败的处置路径与现状逐字相同 |
| 进程被硬杀（SIGKILL） | 与现状一致：pump 的当前 chunk 若尚未冲刷则该批丢失——但 pump 在 `await onLine` 期间不读下一个 chunk，丢失窗口就是「当前 chunk 已解析未落库的那几行」，与现状「当前行已解析未落库」同量级 |

## 8. 测试策略（必写）

**D1**
1. 窗口内乱序：最后 200 行里混入一条更新的 ts ⇒ 新旧实现给出**相同** lastTs。
2. 窗口外乱序：第 300 行才是最大 ts ⇒ 断言新实现返回窗口内的值，并在注释写明这是 §4 B1 的取舍。
3. 无事件的 running run ⇒ 回落到 `startedAt`（既有行为）。
4. 语句数不随事件量增长：同一路径在 2 种事件规模上执行的语句数**完全相等**（沿用
   `statementRecorder`）。
5. EXPLAIN 断言：无 `SCAN node_run_events`、无 `USE TEMP B-TREE`。

**D2**
6. oracle 等价：常规数据（ts 与 id 同序）上新旧实现输出**逐行相等**。
7. 定根不回归：超限长会话仍以 root 会话为根（复用/扩展 `rfc311-session-view-bounded.test.ts` 的判据）。
8. 归档 JSONL 合并后的顺序不变。
9. lineage 多 run：语句数 = O(run 数)，且每条 EXPLAIN 无 TEMP B-TREE。

**D3**
10. 一个 chunk 含 N 行 ⇒ 事件落库语句数 = `ceil(N / 100)`（`statementRecorder` 数语句），且行内容、
    顺序、id 单调性与逐行写入逐字相同。
11. 单行 chunk / 空 chunk / EOF 收尾行三条边界。
12. 中途抛错：第 k 行抛 ⇒ 前 k-1 行已落库（红→绿变异：去掉抛错前的冲刷，这条必须转红）。
13. 绑定参数 ≤900（沿用 `rfc311-perf-guards` 的判据）。
14. 其余四个 `pump()` 调用方不传 `onChunkEnd` 时行为不变（既有测试覆盖 + 一条显式断言）。

**共同**
15. 三条读路径加进 `tests/rfc311-perf-guards.test.ts` 的 `GUARDED` 注册表（`kind: 'detail'` / `'sweep'`
    按各自性质），由既有五条不变量自动看住。
