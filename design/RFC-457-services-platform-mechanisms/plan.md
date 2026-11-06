# RFC-457 实施计划

**前置**：RFC-456 落地（`fe9618337`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施
中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                       | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-457-T1 | `daemonCadence` / `maintenanceTicker` 进 `platform/background`，`configAppliedListeners` 进 `platform/configuration`                       | design §1、§2 |
| RFC-457-T2 | 备份一族四个文件进 `platform/persistence`（含 `sqlite/`）；Worker 的二进制入口、编译态 / 源码态路径与 `BINARY_ENTRIES` 同步                | design §1、§3 |
| RFC-457-T3 | `gitVersion` 进 `platform/workspace/local`；启动器兼容入口删除，`main.ts` 直取平台，直跑用例改起生产入口                                   | design §1、§3 |
| RFC-457-T4 | 消费方改指；按路径读源码的锁、架构报告归属表、`commons-manifest`、Windows workflow 路径过滤、入口根白名单；新增 RFC-457 用例；文档现状路径 | design §2～§4 |
| RFC-457-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI（含 build smoke）                                                    | design §7     |
| RFC-457-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                            | —             |

## 验收清单

- [x] AC-1 9 个文件迁出 `services/`、零引用；`platform/` 只余 3 条取 `services/` 的 import
- [x] AC-2 架构计数按实测（`services/` 93 → 84、`R1` / `R2` 不变），越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿（含单二进制 build smoke）（环境性红格如实记录：macOS e2e 分片 1/4 没拿到托管 runner，见 §CI）

## 集中验证（2026-11-06，候选基于 `fe9618337`，文档基于 `bed86db80`）

本机全程高负载（负载 32～98）。验证都在候选导出仓库里跑（`fe9618337` 的 `git archive` 加候选路径，提交后运行；RFC-456 的 Done 文档提交
`bed86db80` 只改 5 个文档文件，随后同步进导出仓库）。

- **静态**：`tsc`（backend）0 错；eslint `--max-warnings 0` 无告警（70 个 TS 文件）；改动的 TS 与 JSON 已按 prettier 格式化；
  `guard-manifest.json` 刷新受影响的 7 个守卫的行数（4 个有变化）。迁移前按 `docs/dev-gotchas.md` 的三种形态（字面量路径、分段拼接、只提
  文件名）全仓搜 9 个文件名，按路径读源码的锁全部改指（集中验证没有查出漏网的读法）。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4802～5498 s 全部跑完，合计 23452 pass / 127 skip /
  44 fail，另有 29 条测试间未处理错误。43 条是超时（22 个文件；40 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc354` 嵌套帧闭包与
  `rfc363` 目录分页各一条撞自带的 30 秒），29 条未处理错误全出在其中 13 个超时文件里，是超时用例被拆除后仍在跑的异步尾巴；另 1 条是导出
  仓库只有候选提交所致的 `rfc321`。备份 Worker 的 off-thread 校验、Worker 回退、原始快照、启动器直跑与位置、RFC-457 用例都通过。
  - 失败的 22 个文件逐个复跑（30 秒时限）：20 个全过，合计 213 pass / 2 fail。余下两例都撞用例自带的墙钟等待：
    RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）与 RFC-363 目录分页（自带 30 秒）。对照：同一时刻在 RFC-456 的导出仓库里跑
    同一文件，失败的是同一例（两边 28 / 1、3 / 1；5.5 s 与 5.7 s，30.56 s 与 30.49 s），这两例 RFC-455、RFC-456 集中验证时也是如此。
- **导出仓库接 PostgreSQL 真库**：第一条 lane 274 个文件（全部 139 个架构测试；改动的 33 个用例文件；提及 9 个文件、其导出名或其消费方
  文件的用例）：250 个文件全过，合计 2494 pass / 65 fail / 6 skip。24 个文件失败：23 个只有超时（负载 74～82）；`rfc321`（同上）。
  - 复跑 23 个超时文件（30 秒时限）：19 个全过，合计 224 pass / 6 fail，6 例都撞时限：`epoch1-permission-text-backup`（自带 60 秒）、
    `rfc398-postgresql-provisioning`（自带 300 秒）、`rfc384-daemon-intent-bundle`（自带 15 秒）各一例，`rfc370-selected-task-root-configuration`
    三例（30 秒）。对照：同一时刻在 RFC-456 的导出仓库里跑同一文件（负载 41～98），四个文件两边结果相同——`rfc370` 两边都是 10 pass / 4 fail
    （同样四例到点）、其余三个两边都是同一例到点（`epoch1-permission-text-backup` 5 / 1、`rfc384` 11 / 1、`rfc398` 10 / 1）。其中 `epoch1-permission-text-backup` 经 `createBackup` /
    `restoreBackup` 走到迁移的备份 Worker 与原始快照，两边耗时相同（362 s / 362 s）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures），
  运行前后 127 个受保护源文件的哈希一致、导出仓库工作树干净。PostgreSQL 第一次在基线阶段（`current-before`）就有两例撞默认 5 秒
  （`rfc359-t2` 问题派发命令、`rfc359-t1` 延迟提问派发；起跑时 1 分钟负载 33.6、5 分钟 53），同一时刻在两份导出仓库里单跑这两个文件都过
  （两边 2 / 2、8 / 8）；等 1 分钟负载降到 30 以下、5 分钟降到 40 以下重跑，17 个阶段全部符合预期（0 failures），前后哈希一致、工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-457 用例）：在最终文档上 97 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c456 → c457）：`services/` 93 → 84 个 TS 文件；
  `legacy-horizontal-files` 214 → 205、`legacy-service-implementations` 88 → 79、facade 清单 94 → 85、后端生产文件 3200 → 3199；
  `R1-inbound-module-internals` 108、`R2-outbound-module-to-legacy` 27 都不变（账本不动）；其余 counts 都不变：off-DAG 值边 0、值环 0、
  平台 → 模块 0、跨 context 内部文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 27、直接 `setInterval`
  站点 14、没有跨 context 消费方的 public 符号不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`fe9618337` 的原位置对工作树的新位置）：8 个文件的 54 个顶层声明逐字相同，新旧两边都
  没有多出或少掉的声明；留在原处、只改了 import 的 20 个生产文件的 216 个顶层声明逐字未变，唯一的差异是 `systemProviderBackup.ts` 的
  `BACKUP_VACUUM_WORKER_ENTRY`（编译态 `'./platform/persistence/sqlite/backupVacuumWorker.ts'`、源码态 `new URL('./backupVacuumWorker.ts', …)`）；
- 删除的启动器兼容入口：它导出的每个名字都是 `platform/execution/local/managedProcessLauncher` 的再导出，`main.ts` 改取平台模块后取到的是
  同一份；它的源码直跑块与生产的 `managedProcessLauncherEntry.ts` 做同一件事（`runManagedProcessLauncher(Bun.argv)`），直跑用例改起后者；
  `main.ts` 不再取任何带顶层 await 的模块；
- 进程级登记表（配置生效监听、git 能力缓存）仍只有一份：旧文件删除后全仓只剩一条 import 路径；
- 备份 Worker：构建脚本的额外入口、编译态与源码态路径、架构门的二进制入口四处指向同一个存在的文件（新用例锁定）；源码态的
  `epoch1-permission-text-backup` 等经 `createBackup` 走到 Worker 的用例在两份导出里结果与耗时相同，日志里没有回退到同线程的告警；
- Windows workflow 的路径过滤：`gitVersion` 两处改指新位置，启动器兼容入口两处删除（`platform/execution/local/**` 已覆盖启动器本体与入口）；
- 集中验证没有查出本 RFC 的问题。

## CI（AC-4）

- `390ab1228`：exact SHA 主 CI run 42247835916：70 个 job 里 68 个通过，三个 OS 的单二进制 build smoke 都过；Playwright e2e（macos-latest 分片 1/4）
  没有拿到托管 runner（GitHub 注记「The job was not acquired by Runner of type hosted even after multiple attempts」，macOS arm64 容量
  不足），一步都没跑，汇总的 `CI required` 随之记红——托管 runner 容量所致，与本 RFC 改动无关。未重跑；以包含本候选、内容不变的后继
  提交（本 RFC 的 Done 文档提交）的 CI 作后继证据，结果记在下一条目。同 SHA 的 windows-platform run 42247836059 通过。

## PR / 提交

单个提交：`refactor(backend): RFC-457 services/ 的平台机制归 platform（RFC-294 W9-D 第四步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
