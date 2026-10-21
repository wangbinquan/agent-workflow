# RFC-385 实施计划

**前置**：RFC-384 已提交。由 Codex 实施、本会话审核。单批次交付：先完成全部实现与用例，再集中验证一次。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-385-T1 | 「旧接线」对照用例与修复后用例（双 provider，真实 PostgreSQL 上确认）：崩溃路径与正常关停路径 | design §3.1 |
| RFC-385-T2 | 执行世代唯一来源 `DAEMON_GENERATION`：PostgreSQL 执行模块、适配器条目与其他把数据库世代号当执行世代的位置；数据库写围栏不变 | design §2.1、§2.3 |
| RFC-385-T3 | 单机锁证明改用 `DAEMON_GENERATION`；托管证明不变 | design §2.2 |
| RFC-385-T4 | 结构锁与旧锁；`docs/dev-gotchas.md` 一条：执行世代与数据库世代是两件事 | design §3.3 |

**依赖**：T1 先写；T2、T3 → T4。

## 冲突面

`cli/daemonModules/adapters.ts`、`cli/postgresqlDaemonApplication.ts`：与 RFC-386～388 串行。

## 验收清单

- [x] proposal AC-1～AC-4
- [x] 推送后 exact SHA 的 CI 全绿（含 PostgreSQL 分片）：`f495e8e76` 主 CI `39545680585` success
