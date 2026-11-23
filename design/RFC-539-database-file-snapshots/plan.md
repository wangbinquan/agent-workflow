# RFC-539 实施计划

依赖：RFC-538。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-539-T1 计数器与句柄上下文**：新增 `platform/persistence/fileSnapshots.ts`；`DatabaseHandleContext` 加 `fileSnapshots`，`fileSnapshotTrackerOf(handle)`
  取回（design D1）。
- **RFC-539-T2 快照方与读者**：`systemProviderBackup.ts` 删去模块级计数与 `isDbSnapshotInProgress`，两个离线程函数与 checkpoint 一拍收计数器，
  `createBackup` 取所快照库的那一份（design D1）。
- **RFC-539-T3 会话**：SQLite 维护适配器取会话库的计数器；迁移模块、迁移协调器与迁移安全备份收会话交来的那一份，命令行各建一份（design D2）。
- **RFC-539-T4 用例与锁**：新增 RFC-539 用例并登记 guard-manifest；读旧形状的三个用例随改（design D3）。
- **RFC-539-T5 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照（含公开面）；变异验证。
- **RFC-539-T6 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第七步。

## 验收清单

- [x] AC-1 `systemProviderBackup.ts` 没有模块级计数；在途计数挂在句柄上下文上，会话把自己库的那一份交给迁移安全备份与维护服务
- [x] AC-2 快照期间 checkpoint 跳过、结束后执行；两个库的快照互不挡对方；worker 回退与校验失败的结局不变
- [x] AC-3 模块级可变单例 55 → 54、计数不升；锁随改；新增 RFC-539 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 22～29，另有会话在跑）。验证在候选导出仓库里跑（HEAD `7e4a7f826` 加本 RFC 的 29 个路径，核对与
工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证没有查出本人缺陷；准备变异时发现 RFC-539 用例的语料锁只查备份文件、不查新的计数器
文件（把计数挪回 `fileSnapshots.ts` 的模块级会漏网），已补上并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 28 个 TS 文件无告警，改动的 12 个生产文件另过
  promises 配置；prettier：29 个路径与三件套通过。
- **选择**：按 RFC-533 的口径从 2,984 个用例文件里选出 1,996 个，绝大多数经 `sessionTables.ts`（几乎每个用例都间接导入）的 import 闭包入选。
  语义层 309 个：改动的 12 个用例、全部 `tests/architecture/`（142 个）、语料守卫、在 import 之外以路径（带目录的主干、末两段或带扩展名的文件名）
  点名被改文件的 54 个、点名快照 API / 迁移装配 / checkpoint 的 44 个、直接导入 `sessionTables.ts` 以外被改文件的 29 个、经读源码的测试助手
  （`daemonGraphSource`、`deploymentSelectionSource`、`census`、`architectureReport`）到达被改文件的 202 个；`tests/fixtures/` 里没有钉被改文件的
  摘要锁。其余 1,749 个只经 import 闭包入选，交给 CI 的全量分片。
- **语义层**（60 秒；候选 5 个 worker）：309 个文件 303 个通过；改过的用例文件全过（RFC-539 用例、`rfc311` 两个、`rfc349-safety-backup-off-thread-verify`、
  迁移相关的 `rfc349` 三个与 `rfc398-wal-sidecar-open` 等）；红的 6 个：`rfc321`（导出仓库没有真实的 git 历史，在工作树里 10 / 10）、两个长扫描用例
  （`rfc294-architecture-preflight`、`rfc376-report`）撞写死的时限，`epoch1-permission-text-backup`、`rfc384-daemon-intent-bundle` 与
  `rfc395-provider-move-recovery` 的 PostgreSQL 一支撞写死的时限。
- **A/B**（候选与对照同时、各用各的库；在两边的副本里临时放大写死的时限跑到底）：`rfc294-architecture-preflight` 14 / 14、`rfc376-report` 16 / 16、
  `epoch1-permission-text-backup` 6 / 6、`rfc384-daemon-intent-bundle` 12 / 12，两边都全过；`rfc395-provider-move-recovery` 放大用例时限后两边红在
  同一处——测试助手里编译全部受支持的 epoch-1 PostgreSQL 源目录的 `beforeAll` 撞 90 秒，再放大它之后两边都 13 / 13。没有只在候选上红的用例。
- **复跑**：补强 RFC-539 用例与 guard-manifest 随改之后，在最终的候选上复跑 RFC-539 用例（9 / 9）与读 guard-manifest 的 4 个架构用例，全过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：计数挪回 `fileSnapshots.ts` 的模块级（所有计数器共用一份），RFC-539 用例红六条（真实
  语料、三条行为用例与两个引擎上的真库）；抛错时不撤销，红“抛错也撤销”一条；备份改用一份自建的计数器、SQLite 的 checkpoint 门恒为“无在途”，
  各红真实语料一条；派生句柄另建一份，红两条——派生句柄与客户端共用、PostgreSQL 真事务句柄与客户端共用同一份（SQLite 的事务句柄经原生会话
  的客户端取到同一份上下文、不经派生，与 RFC-537 同理）。`rfc311` 的两个用例只用一份计数器，前两种变异下照常通过。
- **架构报告**（候选与对照各出一份）：模块级可变单例 55 → 54（删去的正是 `activeDbSnapshots`）；跨上下文导入 7,536 → 7,542（system-operations 对
  `platform/persistence/fileSnapshots` 的 6 条 legacy-outbound 按符号导入：三个文件取计数器类型、三个非 daemon 入口取工厂）；模块符号属主
  32,470 → 32,472（删去两个名字、新增四个，含新文件本身）；写入入口清单 2,393 → 2,394（计数器工厂一条）；后端生产文件 3,282 → 3,283（新文件）；
  公开面与减速带计数、门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `bf1ed4716`（实现，父提交是 `7e4a7f826`）：exact SHA 主 CI run 45106253299 的 70 个 job 第 1 次全部通过；同一提交触发的 windows-platform
  （run 45106253320）与 maintenance-soak-nightly（run 45106253330）通过。
- 本 RFC 的落档提交 `7e4a7f826`（只改 8 个 Markdown 文件；同一提交记下 RFC-538 转 Done）：主 CI run 45101367963 的 70 个 job 第 1 次全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **计数与结局不变**：`createFileSnapshotTracker().track(run)` 在 `run` 期间计一次、`finally` 里撤销（抛错也撤），`inFlight()` 与此前的
  `isDbSnapshotInProgress()` 同义；两个离线程快照函数把原来的函数体整个包进 `track`，worker 起不来时的同线程回退与
  `backup quick-check failed:` 的直接上抛逐字不变；`createBackup` 里内存库走同线程 `VACUUM INTO`、不计数，与此前相同。
- **哪个库的计数**：句柄上下文多一个计数器（`bindDatabaseHandle` 建，派生句柄与原生会话共用），`fileSnapshotTrackerOf(handle)` 取回、未绑定抛
  `file-snapshot-handle-unbound`。备份对 `opts.db` 做快照，计在 `opts.db` 的那一份；SQLite daemon 会话的维护适配器把会话库的 `inFlight` 交给
  维护服务的 checkpoint 门；会话的迁移模块把会话库的那一份经迁移协调器交给安全备份——三处是同一个库的同一份，checkpoint 在快照期间照旧
  跳过。PostgreSQL 的门照旧 `() => false`。
- **非 daemon 的入口**：命令行的本机迁移操作、启动时的 provider 迁移恢复与安装恢复各建一份（都持有 daemon 锁，没有 checkpoint 时钟在读），结局
  与此前相同。
- **用例与锁**：`rfc311-backup-concurrency` 按库的计数器、`rfc311-backup-worker-fallback` 按自建的计数器断言在途与 checkpoint；
  `rfc349-safety-backup-off-thread-verify`、迁移相关的用例与三个测试助手给计数器实参；`maintenanceService.ts` 的注释随改；guard-manifest 登记
  RFC-539 用例，改过的守卫条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-538 转 Done）；实现与验证后再提交
`refactor(backend): RFC-539 SQLite 文件快照的在途计数随数据库句柄走（RFC-294 S12 第二十步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
