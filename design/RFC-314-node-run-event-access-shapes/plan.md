# RFC-314：任务分解

## 1. 子任务

| # | 任务 | 依赖 | 落点 |
|---|---|---|---|
| T1 | **D1 autoKill**：`findStalledRunningChildren` 拆成「窄候选查询 + 逐 run 有界窗口 `max(ts)`」；新增常量 `STALL_TS_WINDOW_ROWS = 200` 并写明为什么是窗口而不是最后一行（后果是杀进程） | — | `services/autoKill.ts` |
| T2 | **D1 测试**：窗口内/窗口外乱序两个方向、无事件回落 `startedAt`、语句数不随事件量增长、EXPLAIN 无 SCAN/无 TEMP B-TREE | T1 | `tests/rfc314-*.test.ts` |
| T3 | **D2 sessionView**：两段窗口改按 `id` 取 + 按 node_run 逐个查询后合并；JS 排序与去重一字不改 | — | `services/sessionView.ts` |
| T4 | **D2 测试**：oracle 逐行等价、定根不回归、归档 JSONL 合并顺序不变、lineage 语句数 O(run 数)、EXPLAIN 无 TEMP B-TREE | T3 | `tests/rfc314-*.test.ts` + 扩展 `rfc311-session-view-bounded` |
| T5 | **D3 pump 边界**：`pump()` 增加可选 `onChunkEnd`，内层行循环耗尽后与 EOF 收尾行之后各调一次；四个既有调用方不传即行为不变 | — | `services/execution/managedProcess.ts` |
| T6 | **D3 runner 缓冲**：stdout/stderr 事件改为缓冲 + `onChunkEnd` 冲刷；按 `EVENT_INSERT_MAX_ROWS = 100` 切块多行 INSERT；抛错前冲刷；收尾路径冲刷；`broadcastParentRunning` 改为每次冲刷后调用一次 | T5 | `services/runner.ts` |
| T7 | **D3 测试**：语句数 = `ceil(N/100)`、内容/顺序/id 单调性等价、单行/空/EOF 三边界、第 k 行抛错前 k-1 行已落库（带变异检验）、绑定参数 ≤900、四个调用方行为不变 | T6 | `tests/rfc314-*.test.ts` |
| T8 | **防回归注册**：三条读路径进 `rfc311-perf-guards` 的 `GUARDED` 注册表 | T1,T3 | `tests/rfc311-perf-guards.test.ts` |
| T9 | **基准复跑**：在 78.6 万行 / 单 run 10.8 万事件的同形库上复跑 §6 全部验收数字，把前后对照写回 `design.md §2.2` | T1–T8 | 文档 |

## 2. PR 拆分建议

单 RFC 单 PR（直接在 `main` 上小步提交，按仓规不开分支）。三批可独立提交、互不依赖：

- **批 A（T1+T2）**：autoKill。最小、最独立，先落。
- **批 B（T3+T4）**：sessionView。改动面同样小，但 oracle 等价测试是重点。
- **批 C（T5+T6+T7）**：写入批量化。触及全仓唯一流泵，风险最高，最后落；T5 与 T6 必须同一提交
  （单独落 T5 是一个没有调用方的死参数）。
- **收口（T8+T9）**：防护网注册 + 基准复跑出账。

每批各自 `gate:local` 全绿再推，推完按 exact SHA 查 CI。

## 3. 验收清单

- [ ] AC-1 `findStalledRunningChildren`（20 running run，10.8 万事件/run）单条语句 < 50ms，语句数 O(并发度)
- [ ] AC-2 `getSessionTree`（10.8 万事件的 run）每条语句 < 50ms，EXPLAIN 无 TEMP B-TREE
- [ ] AC-3 会话树 oracle 在常规数据上逐行等价（含定根与归档合并）
- [ ] AC-4 单 chunk N 行 ⇒ 落库语句数 `ceil(N/100)`，单条绑定参数 ≤900
- [ ] AC-5 第 k 行抛错时前 k-1 行已落库（变异检验：去掉冲刷必须转红）
- [ ] AC-6 写入路径 p50 与 WAL 页写不劣化于落地前（同形库对照）
- [ ] AC-7 `node_run_events` 索引数量**不变**（零新增）
- [ ] AC-8 三条读路径在 `rfc311-perf-guards` 注册表内跑绿
- [ ] AC-9 全部既有测试绿；`gate:local` 全绿；CI 按 exact SHA 绿

## 4. 与前一笔修复的边界

`b2321179`（RFC-311 余项：归档器/终态 sweeper 的 boot 首拍 + checkpoint 配置热读）解决的是
**"清理器根本没机会跑"**；本 RFC 解决的是**"跑起来之后仍然存在、只是被水位掩住的形状"**。
两者正交：前者让 per-run 行数有上界，后者让单条语句的成本不再与 per-run 行数挂钩。
只做前者的话，任何一个 agent 在两次归档之间攒够事件，三条症状就会回来。
