# RFC-338 候选验证报告（2026-08-28）

## 1. 候选与结论

- 候选标签：`rfc338-local-candidate`（发布前 shared-main 工作树；实现提交 SHA 在发布临界区产生）。
- 起始 committed baseline：`5128efad55ba55fc95205c6dfd9b148916a181d1`；RFC 设计实施 baseline：
  `f5f573a533e8527857f47b9cf74023e3629985b1`。
- 本地 50-client/full-seed 结论：**PASS**。
- 尚未在本报告中冒充完成的门：包含提交的 exact-SHA GitHub 主 CI、手动 100-client hosted soak、remote ancestry。

## 2. 正式大库并发门

命令：

```sh
RFC338_TARGET_SHA=rfc338-local-candidate bun run soak:maintenance \
  --scale full --clients 50 --duration-seconds 60 \
  --report /tmp/rfc338-soak-50-final.json
```

固定 seed：100,000 tasks、3,000,000 node runs、10,000,000 events、100,000 webhook
deliveries、500 cached repos；SQLite 文件 4,533,911,552 bytes。为避免无关 RFC-311 synthetic
running rows触发恢复链，压测启动 daemon 前离线终态化 28,570 tasks / 600,000 node runs；不删除或缩小任何
seed 表。

| 指标                   |  control | maintenance |       硬门 |
| ---------------------- | -------: | ----------: | ---------: |
| API p50                | 223.7 ms |    236.5 ms |     报告项 |
| API p95                | 326.4 ms |    324.2 ms |     报告项 |
| API max                | 415.6 ms |    385.2 ms | < 1,000 ms |
| foreground write max   | 366.1 ms |    359.0 ms | < 1,000 ms |
| WebSocket max gap      | 553.8 ms |    573.6 ms | < 1,000 ms |
| event-loop max gap     | 366.5 ms |    371.5 ms |   < 500 ms |
| HTTP errors / timeouts |    0 / 0 |       0 / 0 |          0 |
| WebSocket errors       |        0 |           0 |          0 |

Worker 自有 SQLite 连接共观测 50,636 条 statement：99.978% 在 50ms 内，p95 上界为 50ms，max
78.2ms，全部低于 250ms。维护窗口内 events archive 归档 400,000 行（约 6,886 work units/s）；webhook
GC 在固定 60 秒窗口清掉 90,000 个 body（约 1,523/s）并以 durable cursor 保留剩余 backlog。窗口结束时无
failed job；`running` / `deferred` 是刻意保留的可续跑状态，不是把 backlog 隐藏成成功。

性能修复的反例证据：第一次 full-seed 候选中，events archive 每个 5,000 行 continuation 都重复全表
`COUNT`，同时空 plugin storage 仍扫描 3M node runs，最慢 statement 为 445.3ms。改为 1,000,000-ID
有界计数 cursor，并在无 plugin generation 时先做文件系统空集快路径后，同一量级正式门的 statement max
降为 78.2ms；没有放宽 50/250ms 阈值。

## 3. 自动化证据

| 范围                     | 命令/结果                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| backend type             | `bun run --filter @agent-workflow/backend typecheck`，通过                                                                                             |
| RFC338 + owner/perf 回归 | 15 files，109 pass / 0 fail / 548 expects                                                                                                              |
| shared schedule schema   | 3 pass / 0 fail                                                                                                                                        |
| frontend Settings        | 2 pass / 0 fail                                                                                                                                        |
| compiled binary          | `bun run build:binary:e2e`，daemon/Worker/backup Worker/system mocks build + smoke 通过                                                                |
| compiled Settings E2E    | Chromium 1 pass；Worker=`Ready`，390px、键盘切换、time/tz 字段错误通过                                                                                 |
| 2s isolation             | 真实 loopback HTTP/WS/主 loop tick 在同步 Worker block 中持续通过                                                                                      |
| fault / recovery         | Worker crash/heartbeat/late event、lease/CAS、running+queued、SQLite BUSY、archive 四个 journal fault point通过                                        |
| mutation                 | Worker hop、main timer、row/count budget、BUSY backoff、lease fence、unique slot、recovery class、timezone、foreground transaction mutation 全部被杀死 |
| RFC-294 R1               | RFC338 新增的 4 条 infrastructure inbound edge 已归零；当时唯一差额为 RFC339 已清债但账本待同步的 5 条                                                 |

## 4. AC 对账

- AC-1～AC-6：Worker 隔离、前台写优先、closed catalog、正确分类、IANA/DST 日程、hot apply/catch-up/
  coalescing 均有行为测试。
- AC-7：Worker/ledger/SQLite/archive prepare→append→delete→finalize fault corpus通过。
- AC-8：events/readback、retention、webhook、workspace、upload/input、token、checkpoint 与恢复 owner回归通过。
- AC-9：active workspace durable fence race通过。
- AC-10：component + compiled-binary 390px/keyboard E2E通过。
- AC-11：本地 50-client/full-seed通过；100-client hosted tier保留为发布后阻塞门。
- AC-12：完整 mutation receipts通过。
- AC-13：需在提交产生后记录 exact SHA、remote ancestry、主 CI 与 100-client hosted soak terminal success。
