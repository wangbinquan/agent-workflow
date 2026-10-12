# 共享 source revision 恢复修复的有限功能核对

范围仅为 v394 manifest 的两处 fixture 恢复、logical-copy 初始化分流及对应两测试。只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

候选与 manifest 的四条路径逐字节相同：

| 路径                                                          | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `tests/helpers/eachProvider.ts`                               | `92ed3169548fa59c37bfe437228f5f79b13eca2917fccb109f49f1b577aa5901` |
| `src/platform/persistence/postgresqlLogicalTarget.ts`         | `9b2cc33857735522970d8552229886a1561f1f2d9af342847cb77032966a1b46` |
| `tests/rfc371-source-revision-snapshot-provider.test.ts`      | `397d094712df22d73b2104790d57046d49ec4d41f8a4cb57dd2d0bdba86b24c1` |
| `tests/rfc349-postgresql-logical-target-finalization.test.ts` | `e0258f20987768b1744524bb7dd3bef27ec8c9a4d9154152b55288da48e6722c` |

## 结论：需要修正测试顺序依赖

**[P1] `rfc371-source-revision-snapshot-provider.test.ts:36` 依赖另一测试先运行。** `original` 只在第 18 行测试中赋值，第 35 行测试先执行时仍为 undefined。仓库 backend 命令和 GitHub Actions 使用 `--randomize`；不是保证声明顺序的运行环境。Bun 1.4.0 实际运行 `AW_TEST_PROVIDERS=sqlite bun test --randomize --seed=1 tests/rfc371-source-revision-snapshot-provider.test.ts`，得到 1 pass / 1 fail，第 36 行完整 revision 比较失败（expected undefined），稳定重现。不能以未随机化的通过结果代替此判据。

应让真实写入与完整恢复验证不依赖两个测试的先后，同时保留全部 55 项原 revision 相等、业务写入被移除，以及实际业务写入仅改变对应 source 的断言。修复可以有限扩展 fixture 的显式恢复接点，但不能关闭 randomize 或放宽完整 revision 比较。本会话没有修改这四条共享候选路径。

## 生产差分核对

`resetToSnapshot` 将 source revision 的完整原始 seed 放到业务 seed 后，恢复时先清除触发器产生的 revision，再写回原值。`seedFromSqliteSnapshot` 同样保留完整 revision seed，完成业务表的依赖排序写入后清除再完整写回。没有关闭业务触发器、漏列、重新生成原 revision 或改写源快照。

Logical target 的排除集合来自带 `sourceRevisionProjection` 的精确合同表 id，仅排除对应 `<id>:initial-revisions` 初始化语句；普通 metadata 保留。源表完整内容继续由 logical copy 写入，约束、函数及触发器仍在复制验证后安装。没有更改 cold migration、旧原生 revision 的断言数量或旧 provider 选择规则。

当前未发现上述生产差分的功能阻断。本会话自己的真实 PostgreSQL 存储、开图、完成回归分别通过 14、6、12 个双 provider 用例，证明 fixture 恢复修复已支持这些实际事务路径；这些结果不代表生产 logical-copy 端到端验收。新增恢复测试的顺序依赖修正前，本有限核对不签 PASS。

证据：`/private/tmp/observability-aw-source-revision-restore-fix-20261012-v394/manifest.json`，`/private/tmp/rfc372-peer-restore-randomized-sqlite.log`，`/private/tmp/rfc372-dual-provider-latest.log`，`/private/tmp/rfc372-completion-dual-fixed.log`。

## R2 有限复核：PASS

v396 的四候选与 live 逐字节相同。新增 `restoreFixture()` 在 SQLite 使用原 `createInMemoryDb(MIGRATIONS)` 完整恢复入口，在 PG 使用同一个 `resetToSnapshot`，并同步更新 harness 绑定；状态销毁同步移除恢复能力。两个测试各自捕获完整 55 项，不再共享初始化变量；写入、完整恢复、业务行删除都在同一个测试内验证。原 logical-copy 差分及其测试逐字节未变化。

实际以 Bun 1.4.0、同一 `--randomize --seed=1` 在 SQLite 与本任务独立 PostgreSQL 16 库运行两个限定文件，**14 pass / 0 fail，71 次断言，10.21 秒**。这关闭 R1 唯一 P1；有限功能复核 PASS，不是生产 logical-copy 端到端验收。日志 `/private/tmp/rfc372-peer-restore-r2-dual.log`。

R2 helper SHA-256 `9d1779e38b1b397e370d38ac60fb45bbd7882509b60acec430509b4211280098`；恢复测试 SHA-256 `34042b3048cec8b02e8193308ad8542f9d6241bc11ee8b5c2e5e99c40a742dd3`；另两候选 hash 保持上表。对应 manifest `/private/tmp/observability-aw-source-revision-restore-r2-20261012-v396/manifest.json`。
