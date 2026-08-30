# RFC-338 最终验证报告（2026-08-30）

## 1. 发布候选与结论

- 设计实施 baseline：`f5f573a533e8527857f47b9cf74023e3629985b1`。
- 主实现：`a6d97ccf4870a64730e7f3d8a88531fad2f56577`；最后一笔 RFC-338 专属 source fix：
  `e3433b76b0495a69dd9ab1b5d78994afe00763ca`。
- final functional exact SHA：`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68`。上述两笔实现提交均已用
  `git merge-base --is-ancestor` 核验为该 SHA 的祖先；该 SHA 也为发布后 `main` 的祖先。
- 本地 50-client/full-seed：**PASS**。
- 同一 final exact SHA 的 Main CI 与 100-client/full-seed hosted soak：**PASS**。
- 同一 SHA 的 8 个适用 scheduled workflows：全部 `completed/success`。

因此 AC-1～AC-13 全部闭合，RFC-338 为 Done。该结论只覆盖 maintenance-induced freeze，不声明 PostgreSQL、
普通 query pool、多实例或水平扩展已经完成。

## 2. 本地 50-client/full-seed 门

命令：

```sh
RFC338_TARGET_SHA=rfc338-local-candidate bun run soak:maintenance \
  --scale full --clients 50 --duration-seconds 60 \
  --report /tmp/rfc338-soak-50-final.json
```

固定 seed：100,000 tasks、3,000,000 node runs、10,000,000 events、100,000 webhook deliveries、
500 cached repos；SQLite 文件 4,533,911,552 bytes。为避免无关 RFC-311 synthetic running rows 触发恢复链，
压测启动 daemon 前离线终态化 28,570 tasks / 600,000 node runs；不删除或缩小任何 seed 表。

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
failed job；`running` / `deferred` 是可续跑状态，不把 backlog 隐藏成成功。

第一次 full-seed 候选中，events archive 每个 5,000 行 continuation 都重复全表 `COUNT`，同时空 plugin storage
仍扫描 3M node runs，最慢 statement 为 445.3ms。改为 1,000,000-ID 有界计数 cursor，并在无 plugin
generation 时先做文件系统空集快路径后，同量级正式门的 statement max 降为 78.2ms；没有放宽 50/250ms 阈值。

## 3. final exact-SHA 100-client hosted soak

- workflow/run：`maintenance-soak-nightly` / `33298851934`。
- job：`Maintenance large-seed gate` / `99223104145`，`completed/success`。
- target SHA：`c5c4faafc91ad3cb8c5a3c10f5187a9a69f96c68`。
- tier：100 clients、full seed、control/maintenance 各 180 秒。
- dataset：100,000 tasks / 3,000,000 node runs / 10,000,000 events / 100,000 webhook deliveries /
  500 repos。
- fixture prep：28,570 synthetic tasks + 600,000 synthetic node runs 在 9,747.4ms 内离线终态化。
- cold start 到 authenticated ready：25,061.3ms。
- daemon RSS：control max 891.5 MiB；maintenance max 763.5 MiB。
- daemon 终态：`code=running`、`signal=none`；verdict：**PASS**。

| phase       | API p50 |  API p95 |  API max | write max | WS max gap | event-loop max gap | errors |
| ----------- | ------: | -------: | -------: | --------: | ---------: | -----------------: | -----: |
| control     | 45.0 ms |  97.9 ms | 158.9 ms |  147.1 ms |   343.2 ms |           124.7 ms |      0 |
| maintenance | 58.7 ms | 127.1 ms | 250.0 ms |  203.5 ms |   357.9 ms |           151.9 ms |      0 |

SQLite 共观测 123,996 条 statement，p95≤50ms、max 131.1ms；显式 transaction count 为 0。backlog：events
10,000,000→9,055,000，webhook deliveries 100,000→0。主要吞吐：`webhookDeliveryGc` 200,000 work units /
1,861.5 per second，`eventsArchive` 960,990 work units / 5,353.3 per second；events 在固定窗口结束时保持
durable `running` cursor，后续继续 drain。所有 job 的 busy deferrals 均为 0。

报告 artifact：

- ID：`9728401544`
- name：`rfc338-maintenance-soak-33298851934`
- size：7,124 bytes
- digest：`sha256:66d8b49f4f3a98c329645c98cf1bdd92aff0af5a21bd783f3209040e41e77ee0`

## 4. final exact-SHA hosted workflow 账本

Main CI `33298828254` 为 35/35 jobs `completed/success`，failed/unfinished 均为空；覆盖 lint/typecheck/format、
shared/system mocks、backend 8 shards、frontend 9 shards、三平台 binary smoke、三平台 Playwright、静态扫描、
Markdown link check 与 perf microbenchmark。

| workflow                  | run ID        | status              |
| ------------------------- | ------------- | ------------------- |
| CI                        | `33298828254` | completed / success |
| e2e-full-nightly          | `33298851279` | completed / success |
| e2e-webkit-nightly        | `33298852761` | completed / success |
| evidence-soak-nightly     | `33298851076` | completed / success |
| git-protocols-e2e         | `33298851691` | completed / success |
| integration-opencode      | `33298851086` | completed / success |
| maintenance-soak-nightly  | `33298851934` | completed / success |
| visual-regression-nightly | `33298851050` | completed / success |
| windows-platform          | `33298851033` | completed / success |

## 5. 自动化与 AC 对账

| 范围                     | 结果                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| RFC338 + owner/perf 回归 | 15 files，109 pass / 0 fail / 548 expects                                                                                                 |
| shared schedule schema   | 3 pass / 0 fail                                                                                                                           |
| frontend Settings        | 2 pass / 0 fail                                                                                                                           |
| compiled binary          | daemon/Worker/backup Worker/system mocks build + smoke 通过；compiled Settings Chromium E2E 通过                                          |
| 2s isolation             | 真实 loopback HTTP/WS/主 loop tick 在同步 Worker block 中持续通过                                                                         |
| fault / recovery         | Worker crash/heartbeat/late event、lease/CAS、running+queued、SQLite BUSY、archive 四个 journal fault point 通过                          |
| mutation                 | Worker hop、main timer、row/count budget、BUSY backoff、lease fence、unique slot、recovery class、timezone、foreground transaction 全杀死 |
| RFC-294 R1               | RFC338 新增的 4 条 infrastructure inbound edge 已归零；public contract 与 canonical/provenance 后续账本已随发布链闭合                     |

- AC-1～AC-6：Worker 隔离、前台写优先、closed catalog、正确分类、IANA/DST 日程、hot apply/catch-up/
  coalescing 均有行为与 hosted 响应证据。
- AC-7～AC-9：Worker/ledger/SQLite/archive fault corpus、owner parity 与 active workspace durable fence race 通过。
- AC-10：component、390px/keyboard、compiled-binary E2E 以及 final visual/webkit/windows workflows 通过。
- AC-11：本地 50-client 与 final exact-SHA 100-client hosted tier 均 PASS；无 ≥1s 全站停顿，错误率 0。
- AC-12：完整 mutation receipts 通过。
- AC-13：实现 ancestry、remote containing SHA、Main CI、maintenance artifact 与 8 个 scheduled workflows 均为终态成功。
