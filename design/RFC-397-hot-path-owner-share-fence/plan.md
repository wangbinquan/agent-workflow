# RFC-397 实施计划

单 PR / 单提交交付（`fix(task-execution): RFC-397 …`）。按仓规先完成全部实现与用例，再集中验证。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                        | 依赖   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| RFC-397-T1 | `ownedTaskExecution.ts` 新增 `holdTaskOwnerTx` / `holdTaskWrite`（design §2.1）：条件与错误同 `assertTaskOwnerTx`，经 `stableReadLockClause` 加共享锁，不改写 owner 行；无上下文分支复用 `assertTaskOwnerlessTx`                                            | —      |
| RFC-397-T2 | 选用（design §2.2）：`nodeExecutionPersistence.ts` 的 `fencedTaskId` 增加围栏方式参数，只有 `appendEvents` 用共享方式；`runtimeSessionCapturePersistence.ts` 的 `appendEvents` 改用 `holdTaskWrite`；其余写手不动                                           | T1     |
| RFC-397-T3 | 用例（design §3）：新增 `rfc397-hot-path-owner-share-fence.test.ts`（1–5，含 PostgreSQL 回归与接管等待）；扩展 `rfc349-task-aggregate-transaction.test.ts` 源码锁；按 policy 重新审阅并更新 `fixtures/rfc395-serialized-insert-source-locks.json` 的 sha256 | T2     |
| RFC-397-T4 | 文档：`docs/dev-gotchas.md`（热行上的 SERIALIZABLE 与 40001、`FOR SHARE` vs `FOR KEY SHARE`、只去 `+1` 不够）；design §3 写回压测数字；`design/plan.md` 索引与 `STATE.md` 状态                                                                              | T2     |
| RFC-397-T5 | 集中验证：受影响后端用例两种 provider（本机一次性 PostgreSQL 容器）；8 路 × 8 次扇出写分片压测前后对比与服务端 40001 计数；变异检查（追加换回推进式围栏 → 回归用例红）；Codex 实现门（只审功能）；主 CI 全绿                                                | T3、T4 |

v0.19.3 在 T5 全部完成后发布（用户 2026-10-30 决定先根治再发版），不属于本 RFC 的任务。

## 冲突面

- `ownedTaskExecution.ts`、`nodeExecutionPersistence.ts`、`runtimeSessionCapturePersistence.ts` 是 RFC-395 / RFC-370 的高频文件；
  开工前查看工作树与 `origin/main` 有无并发改动，有则先合入再动手，按路径提交。
- `fixtures/rfc395-serialized-insert-source-locks.json` 是共享账本，只改这两项的 sha256，不动其它条目。
- 不改 `postgresqlSerializationRetry.ts`（RFC-349 证据门槛）。

## 验收清单

- [ ] proposal §5.1：共享围栏对四种过期 token 的拒绝与推进式围栏一致，两种 provider。
- [ ] proposal §5.2：两处追加不推进 revision、不改 `updated_at`；同文件其余写手仍 +1。
- [ ] proposal §5.3：PostgreSQL 上撤权 UPDATE 等待在途共享围栏写入，之后旧 token 的追加被拒。
- [ ] proposal §5.4：PostgreSQL 确定性回归用例改后绿；变异检查红。
- [ ] proposal §5.5：8×8 压测 0/64 失败，40001 次数记入 design §3。
- [ ] proposal §5.6：既有用例与源码锁、sha256 账本按新语义更新并说明；主 CI 全绿。
- [ ] design §2.4 的语义放宽已获用户确认。
