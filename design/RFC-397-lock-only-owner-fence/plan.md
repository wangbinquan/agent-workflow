# RFC-397 实施计划

单提交交付（`fix(task-execution): RFC-397 …`）。按仓规先完成全部实现与用例，再集中验证。

## 任务

| 编号       | 内容                                                                                                                                                                                                                              | 依赖  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| RFC-397-T1 | `ownedTaskExecution.ts` 的 `assertTaskOwnerTx` 改为只加锁（design §2.1）：`lockAggregateRoot` 锁 owner 行后按同一五项条件读，0 行抛同码错误；不改写 owner 行；签名不变，`now` 形参改名 `_now`                                     | —     |
| RFC-397-T2 | 新用例 `rfc397-lock-only-owner-fence.test.ts`（design §3 第 1–6 项，含 PostgreSQL 首次尝试即成功与真实写手锁持有）                                                                                                                | T1    |
| RFC-397-T3 | 既有用例、SQL 形状断言、变异夹具与源码账本按新语义更新（design §3 清单），改动处注明 RFC-397；`design/RFC-328-…/design.md` §8.1 旁加注指向本 RFC                                                                                  | T1    |
| RFC-397-T4 | 文档：`docs/dev-gotchas.md`（热行上的 SERIALIZABLE 与 40001：只加锁不产生行版本；`FOR UPDATE` / `FOR SHARE` / `FOR KEY SHARE` 的取舍；按事务归因的语句日志做法）；design §3 写回压测数字；`design/plan.md` 索引与 `STATE.md` 状态 | T1    |
| RFC-397-T5 | 集中验证：受影响后端用例两种 provider（本机一次性 PostgreSQL 容器）；8 路 × 8 次用例 B 压测与服务端 40001 计数；变异检查（围栏换回改写式 → 第 5 项用例以 40001 红）；Codex 实现门（只审功能）；主 CI 全绿                         | T2–T4 |

v0.19.3 在 T5 全部完成后发布（用户 2026-10-30 决定先根治再发版），不属于本 RFC 的任务。

## 冲突面

- `ownedTaskExecution.ts` 被全部数据写手依赖；开工前查看工作树与 `origin/main` 有无并发改动，有则先合入再动手，按路径提交。
- 既有用例分布在 RFC-359 / 369 / 395 的测试文件中，只改与 revision 推进、owner 语句形状直接相关的断言，不动其它内容。
- `fixtures/rfc395-serialized-insert-source-locks.json` 是共享账本，只改受本改动影响的 sha256 / 行号。
- 不改 `postgresqlSerializationRetry.ts`（RFC-349 证据门槛）。

## 验收清单

- [ ] proposal §5.1：只加锁围栏对四种过期 token 的拒绝与现有一致，两种 provider。
- [ ] proposal §5.2：数据写入后 revision、`updated_at` 不变；所有权变更与任务状态迁移照旧推进。
- [ ] proposal §5.3：PostgreSQL 真实写手在途时，撤权等待其提交；撤权后旧 token 被拒。
- [ ] proposal §5.4：PostgreSQL 首次尝试即成功；变异检查红。
- [ ] proposal §5.5：停止证明正反对照，两种 provider。
- [ ] proposal §5.6：8×8 压测 0/64、0 次 40001，数字写入 design §3。
- [ ] proposal §5.7：既有用例、SQL 形状断言、变异夹具与源码账本已更新并说明；主 CI 全绿。
