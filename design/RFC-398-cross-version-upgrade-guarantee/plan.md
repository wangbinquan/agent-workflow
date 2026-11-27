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

## 发布 v0.20.0 之前在真实数据上的实测（2026-11-27）

用户准备发布 v0.20.0，现网大量实例在 v0.19.2，要求确认“新版本启动时数据迁移能否很快完成，不要迁移几个小时”，并问迁移时能否打印进度。本机留有一份真实的旧实例（2026-10-28 归档，用了五个月）：库文件 23 GB，其中有效数据 1.07 GB、60.9 万行，`runs/` 下 82.8 万个文件。它是 v0.19.2 的结构外加 14 条从未发布的开发期迁移，转换器按设计拒绝未知指纹；在一份克隆上删掉那 26 张开发期的表和 14 条登记、把 `tasks` 表名的引号改成发布版的写法之后，指纹与 v0.19.2（迁移到 0258）一致，数据原样保留。发布版的 v0.19.2 二进制另建了一个空库作对照。全程只动克隆，归档本身只读。

**结果一：有未结束的旧任务时，升级在 20 分钟后被拒绝。** 第一次运行在计划阶段跑完（1206 秒）之后以 `plan-blocked` 拒绝：296 条阻断，全部指向 37 个仍未结束的任务（中断 11、等待人工 20、等待评审 6，创建于 2026-05 至 07），它们名下有 RFC-200 之前没有信封随机数的运行。这是 RFC-395 的既定规则，2026-10-24 的试算已经见过；新的信息是：一条只读查询（未结束且名下有空随机数运行的任务）给出的 37 个任务与计划给出的完全相同，可以让运维在升级前先查。查询与处置写进了 `docs/release-upgrade-rollback.md`。

**结果二：处理掉这 37 个任务后，升级成功，全程约 71 分钟。** 在克隆上把这 37 个任务置为已取消（与 2026-10-24 试算的做法相同）后重跑：4250 秒，退出码 0，目标库 1.28 GB、269 张表、`quick_check` 通过，任务、节点运行、事件等各表的行数与源库一致，920 条历史限制逐条以 WARN 打印。回执里的阶段耗时：计划 1207 秒；执行阶段再冻结并清点 669 秒，备份后第三次冻结并清点 668 秒，转换 898 秒，装载 800 秒，校验、激活与复核合计不到 5 秒。峰值常驻内存 10.7 GB；完成后 `database-migrations/` 留有 6.5 GB，过程中峰值约 15 GB。后 30 分钟本机同时有别的负载（负载均值一度超过 100），空闲机器上估计在 60 分钟上下。空库的对照：83 秒（当时负载同样很高，CPU 时间 22 秒）。

**耗时的构成。** 自动模式下源库从头到尾没有别的写入者（daemon 未启动、锁一直持有），但流程仍按人工流程的顺序走：计划冻结一遍、清点一遍、转换试算一遍；执行时先在线冻结并清点一遍，备份后再冻结并清点一遍，然后转换一遍，装载时又转换一遍。冻结里反复出现的是整库内容摘要——逐表按全部列排序、逐行规范化后计算摘要：单独计时，1.07 GB 的库上一次 12.5 秒；按代码数（没有逐次打点），带离线升级的一次冻结至少做十二次（源库预检三次，离线升级里三处“源未变化”检查各两次，升级后的副本预检三次）。按回执的阶段耗时粗算，只做一遍所必需的工作（冻结 5.5、清点 3.6、备份 2.8、转换并装载 13.3）约 25 分钟，其余约 45 分钟、也就是六成左右，是同一份没有变化的数据被重复冻结、清点和转换。

**进度输出。** 进度行是有的（循环内每阶段至多 3 秒一行），但摘要、快照拷贝、完整性检查这些单条语句内部无法报告：这次实测到 47 秒、176 秒、115 秒、120 秒等多段完全没有输出。已在 `start` 等待子进程的那一侧补了开始说明和存活提示（`71d08e5ec`、`3aa7b0364`），转换流程本身没有改。

**功能上的复核。** 用当前 main（`c91fc614a`）构建的二进制跑了仓内的发布升级校验（`scripts/release-upgrade/verify.ts`，本机 macOS，`--tags v0.19.2`，`sqlite` 与 `sqlite-no-sidecar` 两个变体）：已发布的 v0.19.2 二进制经接口造数并停止，候选版本直接 `start`，升级后接口投影与升级前一致，迁移过来的待评审与待回答各一项可以继续完成，新任务可以执行，重启后仍在，`doctor` 通过。两个变体都通过。同一个二进制在真实的 v0.19.2 库上用 `start` 启动，开始说明与存活提示按预期打印。

**没有做、留给用户决定的。** 一是把拒绝提前：现在要等 20 分钟的计划跑完才知道被哪些任务挡住，可以在会话开始时先做上面那条查询等价的检查。二是在自动模式下复用计划阶段的结果、去掉重复的冻结与清点和多出来的转换；按上面的粗算全程可以降到 25 分钟上下（这是由阶段耗时推出来的估计，没有实现和实测）。这动的是 RFC-395 的转换流程与 RFC-398 的编排，需要单独立项。三是内存：10.7 GB 对小规格的主机是硬门槛。

## 验收清单

- [x] AC-1：S1～S6 与 S8 只换二进制即可启动，历史可见、挂起评审批准后 `done`、新任务 `done`、重启正常（L2 + L1）
  ——L1 SQLite 57/57、PG 6/6 随主 CI 每次运行；L2 本机（macOS + PG 17）全部变体；夜间 41374764084（`595418fc5`）三平台 gate 集合与
  Linux 全部有产物版本（80 个版本作业）全绿
- [x] AC-2：无建库权限时输出可执行的建库语句，建库后自动完成——`rfc398-postgresql-provisioning`；夜间 linux `postgresql-restricted-role`
- [x] AC-3：阻塞时拒绝且源不变；人工模式与 RFC-395 一致——`rfc398-auto-upgrade-policy`、`rfc398-start-auto-upgrade*`
- [x] AC-4：子进程 / 父进程 / 两者被杀后续做，只有一个操作、不重复建库；activated 后中断仍补做校验与回执——`rfc398-auto-upgrade-resume-*`
  （按中断点拆分，`rfc398-split-test-coverage` 守住覆盖不减）、`rfc398-start-auto-upgrade-takeover` / `-signals`
- [x] AC-5：WAL 无 sidecar 的全部读路径通过，源字节不变——`rfc398-wal-sidecar-open`；L2 `sqlite-no-sidecar` 三平台
- [x] AC-6：L1 矩阵每个发布版带全表数据并全绿；豁免清单经用户确认——18 项豁免、14 个 L2 排除（用户 2026-10-31 批准）
- [x] AC-7：发版门三平台通过才公开；夜间覆盖全部有产物版本；v0.19.3 反证按签名失败——`release.yml` 的 build → upgrade-gate → publish
  由 `.github/scripts/release-upgrade.test.ts` 锁定（首次真实执行在下一次发版）；夜间 41374764084 87 个作业全绿（Windows 上没有产物的
  v0.1.0 / v0.10.0 / v0.16.3 由 tag 构建）；CI 反证 41330885658 三平台全部变体按签名失败
- [x] AC-8：上一个发布版未登记或缺种子覆盖时发版门失败——`rfc398-release-registry`
- [x] AC-9：`doctor` 与 RFC-349 `status / finalize` 输出正确且不写 v2 指针——`rfc398-doctor-epoch1`、`rfc398-rfc349-finalize`
- [x] AC-10：校验失败自动撤回并拒绝重试，`--retry` 可重新开始——`rfc398-auto-upgrade-resume-verify-failed`、`rfc398-start-auto-upgrade-retry`
- [x] AC-11：既有用例、架构守卫与主 CI 全绿；Codex 设计门与实现门已处置——主 CI `57103c231`（41312990481）69 个作业全绿；`52daa5569`
  （41320966543）唯一的红是并发 RFC-408 删文件后前端跨包源码锁（`a06fcae26` 修复），后继 `a06fcae26`（41323035687，两提交之间本 RFC 文件未变）
  70 个作业全绿；夜间工具修复 `f33e6b19f`（41367321464）、`595418fc5`（41374751384）的主 CI 全绿；设计门 r6 PASS；实现门 r1～r3 Codex、r4 起本会话自审
  （用户 2026-10-31 要求不再派 Codex）
