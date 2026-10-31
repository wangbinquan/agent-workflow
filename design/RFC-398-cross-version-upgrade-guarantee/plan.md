# RFC-398 实施计划

- 按仓规先完成全部实现与用例，再集中验证；直接在 `main` 上按路径提交（不建分支）。
- 执行方式（用户 2026-10-30 许可）：编码由 Codex 按本 RFC 执行，本会话负责拆分派活、审核 diff、补跑整树守卫、集中验证与提交。
  Codex 不提交、不在任务中途提问（有歧义按本 RFC 取舍并记入「偏离」）。
- 提交建议三笔（同一 RFC，同一 CI 收口）：①修复、桥接与自动切换（T1–T6）；②登记表、种子账本、映射预言与 L1 矩阵（T7–T9）；
  ③L2 工具、工作流、文档与既有用例调整（T10–T12）。

## 任务

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-398-T1 | 只读打开（design §5）：`platform/persistence/sqlite/openForRead.ts`；迁移 §5 所列全部读路径；`quickCheckDbFile` 默认判据对齐；文本守卫与白名单；`rfc398-wal-sidecar-open.test.ts` | — |
| RFC-398-T2 | profileRef（design §3.6）：`platform/persistence/postgresqlProfileRef.ts`；替换 `model.ts:199/212/235`、`supportMatrix.ts:19-23`、`databaseProviderRuntime.ts:102`、`postgresqlDatabases.ts:20` 与复用的文档 schema；`EpochSwitchTargetInput` / `EpochSwitchPlanInput` 增加 `profileRef` / `scratchProfileRef`；`PostgresqlDatabaseConfigSchema.databaseName` 与 `safeUrl` 路径替换；`rfc398-profile-ref.test.ts`（含整链） | — |
| RFC-398-T3 | PG 准备（design §3.1–§3.5、§3.7）：`PostgresqlProvisioningPort` 与 `infrastructure/epochSwitch/postgresqlProvisioning.ts`（跨会话分配账本、按 provider 生成建库语句并回读核对、复用 / 拒绝判定、退休目标与 scratch 保留、供 §2.4 F 注入的 `nextTargetLocation`）；原生建在 PG 上的判定；`rfc398-postgresql-provisioning.test.ts`（真实 PG，含 ICU 源、受限角色与同环境 `--retry`） | T2 |
| RFC-398-T3b | v0.18.18 / v0.18.19 PG 桥接（design §3.8）：两版原始基线按 tag 原字节入库；`logical-bridge` 读取模式（按该版本合同读回、按真实收据构建 SQLite@0223 副本、逐表行数与逻辑摘要判据）；登记为支持源；`rfc398-postgresql-bridge.test.ts` | — |
| RFC-398-T4 | RFC-349 收尾（design §4）：`infrastructure/epochSwitch/legacyMigrationFinalize.ts` 按 v0.19.2 `finalize` 逐步移植（状态刷新、finalized 重放分支、收尾分支、v1 指针写入器）；`main.ts` 对 epoch-1 安装的 `db migration status / finalize <dbm_…>` 改走适配器；`rfc398-rfc349-finalize.test.ts`（含逐步中断重放）。等价夹具：本会话先用 v0.19.2 / v0.18.19 二进制手工录制（与 T10 `record.ts` 输出同格式），T10 完成后改由工具重录 | T3b |
| RFC-398-T5 | 自动会话（design §2.3–§2.7）：`AutoUpgradeRecordPort` 与记录文件；`discoverEpochOperation` 接受请求的操作 ID；编排状态机（待批计划的重新评估、按结构化失败分类的 `--new-run`、先记决定再撤回、`--retry`）；`SessionLockPort` 与 quiesce 借用模式；`db migration auto` 动词；`migrate` 进程内接入；`status` 显示 `mode: auto`；忽略会话目录的用例；`rfc398-auto-upgrade-policy.test.ts` | T1–T4 |
| RFC-398-T6 | `start` 接入（design §2.1、§2.2、§6）：`autoEpochMigration` 配置项；domain 触发判定与 `bootAdmission` 读会话状态；子进程拉起、stderr 与信号转发、退出码映射、重新分类；锁委托；父进程消失时子进程接管锁；启动租约先读 `active.json` 再回收死锁；`doctor` 与拒绝文本；`rfc398-start-auto-upgrade.test.ts`（含屏障用例）、`rfc398-auto-upgrade-resume.test.ts`、`rfc398-doctor-epoch1.test.ts`；确认 `rfc395-v3-dormancy` 无需放宽 | T5 |
| RFC-398-T7 | 发布版登记表（design §7.1）：`scripts/release-upgrade/registry.ts`（逐条收据、发布字节差异、PG 收据含 v0.18.18 / v0.18.19 原始基线、epoch-2 版本、产物来源与 SHA-256、`buildKey`、L2 档位）；`releases.json` 覆盖 v0.1.0～v0.19.3 全部 tag；`released-sql/`；`rfc398-release-registry.test.ts` | T3b |
| RFC-398-T8 | 种子账本与映射预言（design §7.2）：`scripts/release-upgrade/seed-ledger.ts`（`derive` / `check`）；epoch-1 每条建表 / 改表迁移的种子与内容文件、`expect` 投影；epoch-2 各 history 版本种子；依据 RFC-395 `table-mapping.md` 编写 `mapping-oracle.json`；豁免清单草案（**提交用户确认**） | T7 |
| RFC-398-T9 | L1 矩阵（design §7.3–§7.5、§7.8）：`buildReleaseHome`（epoch-1 SQLite、epoch-1 PG 原生含 v0.18.18 / v0.18.19 原始基线、epoch-2 SQLite / PG）；按区间分片的 `release-upgrade-matrix-*.test.ts`；写入前的严格核对 S1–S3 / E1–E2 与启动后的 A1；覆盖、映射守卫与五条反证 | T3b、T5、T6、T7、T8 |
| RFC-398-T10 | L2 工具（design §7.7）：`scripts/release-upgrade/{scenario,verify,record}.ts` 与 `lib/`；按版本族的场景；变体（SQLite、去 sidecar、PG 一键迁移未 finalize、v0.18.18 / v0.18.19 PG、受限角色、逐级链）；产物取得与 SHA-256 校验（`release-asset` / `retained-asset` / `ci-artifact` / `tag-build`）；经用户确认后把 v0.19.3 产物复制到不公开的草稿 release | T6、T7 |
| RFC-398-T11 | 工作流（design §7.7）：`release.yml` 改为 `build` 只产出 workflow artifact、新增 `upgrade-gate`、`publish` 过门后上传资产并取消草稿（含已公开 release 重跑的分支验证）；登记检查；`release-upgrade-nightly.yml`（全版本分片）；纳入既有格式与 lint 检查 | T10 |
| RFC-398-T12 | 文档与既有用例（design §7.9、§9）：OPS-015 改人工模式并新增自动模式 e2e；`upgrade-rolling.test.ts` 改走编排；`docs/release-upgrade-rollback.md`、README、`docs/dev-gotchas.md`、`CLAUDE.md` §发版；`design/plan.md` 索引与 `STATE.md` | T1–T11 |
| RFC-398-T13 | 集中验证：受影响后端用例两种 provider（本机一次性 PostgreSQL 容器）；`tests/architecture/` 全量与根级守卫；L1 全量；本机按 L2 跑一遍（macOS SQLite + 本机 PG，含用户生产形态与 v0.18.19 PG）；以 v0.19.3 产物作候选的反证；Codex 实现门（只审功能）；主 CI 全绿；手动触发一次夜间工作流 | T1–T12 |

## 冲突面

- `bootstrap/daemonStart.ts`、`bootstrap/epochMigration.ts`、`databaseProviderRuntime.ts`、`main.ts`、`application/epochSwitch/planner.ts`、
  `supportedSources.ts` 是高频文件；开工前查看工作树与 `origin/main` 有无并发改动，有则先合入再动手，按路径提交。
- `.github/workflows/release.yml` 的上传步骤从 `build` 移到 `publish`（过门后才上传），其余构建步骤不变。
- 不改转换器规则（`platform/persistence/migration/conversion/**`）与校验判据；若种子账本揭示真实形态在现有规则下被阻塞，停下并在本会话
  向用户说明，不擅自放宽规则。

## 后续（不属于本 RFC）

- 修复版（建议 v0.19.4）的发布时机由用户决定；发布后按新流程登记该版本。
- v0.19.3 的 GitHub Release 页面已不存在（tag 仍在）；其产物的长期留存方式见 design §7.7（草稿 release 需用户确认）。

## 验收清单

- [ ] AC-1：S1～S6 与 S8 只换二进制即可启动，历史可见、挂起评审批准后 `done`、新任务 `done`、重启正常（L2 + L1）
- [ ] AC-2：无建库权限时输出可执行的建库语句，建库后自动完成
- [ ] AC-3：阻塞时拒绝且源不变；人工模式与 RFC-395 一致
- [ ] AC-4：子进程 / 父进程 / 两者被杀后续做，只有一个操作、不重复建库；activated 后中断仍补做校验与回执
- [ ] AC-5：WAL 无 sidecar 的全部读路径通过，源字节不变
- [ ] AC-6：L1 矩阵每个发布版带全表数据并全绿；豁免清单经用户确认
- [ ] AC-7：发版门三平台通过才公开；夜间覆盖全部有产物版本；v0.19.3 反证按签名失败
- [ ] AC-8：上一个发布版未登记或缺种子覆盖时发版门失败
- [ ] AC-9：`doctor` 与 RFC-349 `status / finalize` 输出正确且不写 v2 指针
- [ ] AC-10：校验失败自动撤回并拒绝重试，`--retry` 可重新开始
- [ ] AC-11：既有用例、架构守卫与主 CI 全绿；Codex 设计门与实现门已处置
