# RFC-314：node_run_events 三处读写形状修复（proposal）

- 状态：Draft（待批）
- 日期：2026-08-21
- 前置：RFC-311（数据库性能治理，Done）+ 其收口后余项修复 `b2321179`（维护循环 boot 首拍 / checkpoint 热读）
- 证据：本目录 `design.md §2` 的生产量级实测（可复跑，脚本形态记在 §2.4）

## 1. 背景

2026-08-21 与生产对账（部署版本 **v0.18.11**，已含 RFC-311 的事件归档字节水位）：
`node_run_events` 长到 **78.6 万行 / 1.72GB**，库 3.1GB。定位分两半：

- **装配洞**（已修，`b2321179`）：归档器与终态任务 sweeper 只挂 `setInterval(1h)`、没有 boot 首拍，
  重启比周期更勤的部署一次都不会执行；checkpoint 循环读 boot 配置快照，改 `walCheckpointIntervalMs`
  不重启永不生效。
- **本 RFC 的三条**：把开发库按同形放大到 78.6 万行 / 2.6GB 后逐语句计时，暴露出三处**与表总行数无关、
  与「单个 run 的事件条数」成正比**的形状问题。归档水位把 per-run 行数压下去之后它们的**症状**会消失，
  但形状还在——任何一个 agent 在两次归档之间攒够事件，它们就再次出现。

| 位置 | 归档前（per-run 最大 10.8 万事件） | 归档收敛后（per-run ≤6388） | 形态 |
|---|---|---|---|
| `services/autoKill.ts:53-66` `findStalledRunningChildren` | **194.9ms** 单条 | 34.6ms | `LEFT JOIN node_run_events + max(ts) + GROUP BY`：把每个 running run 的**全部**事件扫一遍求 max，外加 TEMP B-TREE 分组 |
| `services/sessionView.ts:133-147` 会话树两段窗口 | **461.5ms + 122.0ms** 两条 | <50ms | `ORDER BY ts` 与索引 `(node_run_id, id)` 不匹配 ⇒ TEMP B-TREE：为了取 20000 条，先把该 run 的全部事件**连 payload** 灌进排序器 |
| `services/runner.ts:1536/1550/1610` 事件落库 | 每行 stdout 一条 autocommit INSERT | 同左 | 无批量合并；20 个 agent 并发猛吐时语句数与 -wal 帧数按行数线性增长 |

前两条的共同点值得单独点出：**它们都不是「缺索引」**。三条真慢语句全部走
`SEARCH … USING INDEX idx_events_node`，没有一条 `SCAN`——慢在**取回/排序的行量**。
实测加 `(session_id)` / `(kind)` / `(ts)` 三个索引会让 5000 条 INSERT 的 WAL 页写从 59 涨到 756（**×12.8**）、
p50 从 0.027ms 涨到 0.050ms，而对上面三条语句**一条都不起作用**。本 RFC 因此**不新增任何
`node_run_events` 索引**。

## 2. 目标

- **G1 与 run 体量解耦**：三处的单条语句耗时不再随「该 run 有多少事件」增长；在 10 万事件/run 的极端
  数据上，单条语句 < 50ms（即不再触发 RFC-311 的慢语句告警）。
- **G2 零索引新增**：不给最热的写表加任何索引，写入路径的 p50 / WAL 页写不劣化。
- **G3 可观察面不变**：会话树输出顺序、事件 id 单调性、WS 帧粒度与协议、崩溃时的取证完整性均不变；
  三处确有语义差异的地方逐条列在 §4 并各有测试锁定。
- **G4 防回归**：三处读路径进 RFC-311 的性能防护注册表（`tests/rfc311-perf-guards.test.ts`），
  由「录制实际执行语句 + EXPLAIN 逐条审计」的既有机制自动看住。

## 3. 非目标

- 不动归档水位、归档器装配、checkpoint 循环——那半边已由 `b2321179` 收口。
- 不做 RFC-294 的结构搬迁（三个文件都属 `task-execution` context，但本 RFC 是横切形状修复，就地修；
  债的记账见 `design.md §5`）。
- **不引入时间窗事件缓冲**（50ms/N 条那一档）。用户 2026-08-21 拍板取最小档：只在单次 chunk 内合并。
  理由是实测收益远小于风险——单条 INSERT p50 0.03ms、5000 条只脏 59 个 WAL 页，而时间窗要给所有读点
  加 flush 屏障，并把「硬杀丢掉最后一个窗口的取证事件」变成常态。
- 不改 `getNodeRunStdout` 的 50000 行上限。它的**形状已经是对的**（`ORDER BY id DESC` 纯反向 seek，
  无排序器），81.9ms 全部来自「50001 行 × payload」这个上限本身，归档收敛后为 11.0ms；要再降是调上限
  的事，与本 RFC 的三条形状无关。
- 不改 WS replay（`ws/registry.ts` 的 `?since=` 回放）：形状正确、按 task 有界，未在实测里超阈。

## 4. 行为影响清单（逐条呈确认）

本 RFC **不关闭任何能力**，因此不适用 RFC-224 的能力收缩门槛；但下面三处有可观察的语义差异，
按同样的纪律逐条列出：

| # | 变化 | 影响面 | 缓解 / 判据 |
|---|---|---|---|
| B1 | autoKill 的「最后活动时间」由**全量 `max(ts)`** 改为**最后 200 行内的 `max(ts)`** | 若某 run 有超过 200 行的 ts 乱序回灌，可能低估活跃度 ⇒ 更早判定僵死 | 乱序只来自子代理事件回灌（携带 opencode 原始 ts），量级是一个轮询间隔；而 stall 阈值是分钟～小时级（`heartbeatStallMs`）。窗口取 200 行而不是 1 行，正是为吸收这类乱序；`autoKillStalledChild` 默认关闭。测试用「窗口内乱序」与「窗口外乱序」两个方向锁定 |
| B2 | 会话树两段窗口由**按 `ts` 取**改为**按 `id` 取**（取回后仍按 `(ts,id)` 排序） | 输出顺序**不变**；仅「哪 500 / 20000 条进入窗口」在 ts/id 乱序时可能不同 | 取回后的 JS 排序本来就在（`sessionView.ts:150`）。定根用的 prefix 按 id 取反而更准：root 会话的事件本就是最先写入的。oracle 等价测试在常规（ts 与 id 同序）数据上要求新旧结果**逐行相等** |
| B3 | 单次 stdout/stderr chunk 内解析出的多行事件合并为**一条多行 INSERT** | 无：id 仍单调、ts 逐行保留、WS 帧粒度不变（`broadcastParentRunning` 本就是节流的 `node.status` 提示，不是逐事件帧） | 缓冲在**同一个 `await` 内**写完再让出事件循环，不引入额外的崩溃丢失窗口；任一行解析抛错时先冲刷已缓冲行再抛（取证事件恰恰在失败时最重要），有测试锁 |

## 5. 用户故事

- 运维开着一个长跑 agent 的会话树页面，daemon 不再为了渲染最近 2 万条而把这个 run 的十万条事件连 payload
  灌进排序器。
- 打开 `autoKillStalledChild` 的部署，每 5 分钟的僵死扫描不再随并发 agent 的产出量变慢。
- 20 个 agent 同时猛吐输出时，事件落库的语句数按 chunk 而不是按行增长。

## 6. 验收标准

以「78.6 万行 / 2.6GB / 单 run 最大 10.8 万事件」的同形基准库为准（构造方式见 `design.md §2.4`）：

1. `findStalledRunningChildren`（20 个 running run）：单条语句 < 50ms，**且**语句条数为 O(running run 数)
   而非 O(事件数)；EXPLAIN 无 `SCAN node_run_events`、无 `USE TEMP B-TREE`。
2. `getSessionTree`（10.8 万事件的 run）：每条语句 < 50ms；EXPLAIN 无 `USE TEMP B-TREE`。
3. 会话树 oracle：常规数据上新旧实现输出**逐行相等**（含定根结果与归档 JSONL 合并后的顺序）。
4. 单次 chunk 含 N 行时，事件落库语句数从 N 降为 `ceil(N / 每条最大行数)`；单条语句绑定参数 ≤900
   （仓内既有护栏线，离 SQLite 的 32766 足够远）。
5. 任一行解析抛错时，同一 chunk 内此前缓冲的事件行**全部已落库**。
6. 写入路径不劣化：同形库上 5000 条事件写入的 p50 与 WAL 页写不高于落地前。
7. 三条读路径进 `rfc311-perf-guards` 注册表并跑绿；全部既有测试绿；`gate:local` 全绿。

## 7. 决策记录

- 2026-08-21 用户三项拍板：①autoKill 取**最后 200 行内的 max(ts)**（而非只取最后一行，也不加索引）；
  ②会话树**窗口按 id 取、取回后仍按 (ts,id) 排**（而非加 `(node_run_id, ts, id)` 索引）；
  ③事件写入**只在单次 chunk 内合并**（而非时间窗缓冲，也不是只加遥测）。
- 待批：本三件套整体 + §4 行为影响清单逐条。
