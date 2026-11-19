# RFC-505 实施计划

依赖：RFC-504（Done）；与 S12 共用模块 composition 文件（本 RFC 改 digital-employee 的 `composition/builtinJobTemplates.ts`、
system-operations 的 `composition/maintenanceDisk.ts` 与 runtime-management 的 `composition/runtimeSelection.ts`；三个装配入口不变）。按
CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-505-T1 用例归 application、方言读归 platform/persistence、拼装归 infrastructure**：内建作业模板的确保迁入 digital-employee
  `application/builtinEmployeeJobs.ts`（时钟传入），运行时快照表迁入 runtime-management `application/runtimeSelection.ts`，PostgreSQL 磁盘
  报告的那次读迁入 platform `persistence/postgresqlStorageFootprint.ts`、拼装迁入 system-operations
  `infrastructure/local/systemMaintenanceDisk.ts`（design D2）。
- **RFC-505-T2 composition 只装配**：三个组合文件的装配入口改为从新位置取实现（design D3）。
- **RFC-505-T3 账本**：`counts.json` 三项收紧；guard-manifest 登记（design D4）。
- **RFC-505-T4 用例**：新增 RFC-505 用例（design §4）。
- **RFC-505-T5 集中验证**：backend `tsc`、eslint；RFC-505 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-505-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新位置声明；三个组合文件没有控制流、从新位置取实现；装配入口不变
- [x] AC-2 同样输入下三组行为的结果、错误与端口调用和此前一致；时钟仍在调用时取、每处一次
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；三项 `composition-control-flow-*` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`490d75e04` 主 CI run 44382772167 的 70 个 job 第 1 次全部通过（见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 33～75，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库
与 `9628d5590` 的树相同。验证期间 HEAD 没有前进。集中验证查出本 RFC 的一处缺陷，修正后复验了相关范围：

- **缺陷与修正**：候选 1（`9628d5590` 的树加最初的 9 个代码与账本路径）把 PostgreSQL 磁盘报告整个迁进 system-operations 的
  `infrastructure/postgresqlMaintenanceDisk.ts`，全量与首批里 `architecture/rfc359-w5-t17-provider-file-location` 都红：
  `platform/persistence/` 之外的 provider 命名文件比账本 `PROVIDER_NAMED_FILE_DEBT` 多出这一个。该守卫要求写成“中立端口 +
  `platform/persistence/` 里的方言实现”，于是改为：方言读进 platform 的 `persistence/postgresqlStorageFootprint.ts`，拼装进 infrastructure
  `local/systemMaintenanceDisk.ts` 的中立名字 `reportMeasuredDiskReclaimable`（design D1、D2、§6 第 4 条）。没有选给账本加一行（没有必须留在
  模块里的理由），也没有选把整份报告放进 platform（platform 不得取模块，RFC-399）。用例、`counts.json` 的说明与 guard-manifest 的行数随之
  更新。候选 2 是 `9628d5590` 的树加 15 个路径（10 个代码与账本路径、三件套、`STATE.md` 与 RFC 索引；同步时删掉候选 1 的那个新文件）。
  修正只动 PostgreSQL 那条报告路径，另两组迁移逐字未变：取到改动文件的用例与全部源码扫描在候选 2 上重跑（见“复验”），其余结果沿用候选 1
  的（全量只跑 SQLite，走不到这条路径）。
- **静态**（两版候选各一遍）：
  - backend `tsc` 退出码 0、无输出。
  - eslint `--max-warnings 0`：候选 2 改动与新增的 8 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 7 个生产文件同样无告警
    （候选 1 是 7 个与 6 个）。
  - prettier：改动的 TS 与本 RFC 的三件套通过。`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md` 与 `design/plan.md` 按
    约定不跑。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：384 个文件。其中
  `tests/architecture/` 全部 140 个，另 244 个相关用例：
  - 直接或经用例侧的辅助与夹具取到三个组合文件、两个新文件或扩充的 `application/runtimeSelection.ts` 的用例；
  - 按名字与路径扫出的用例；
  - 直接取 bootstrap 的 `daemonModules/digitalEmployee.ts`、`daemonModules/adapters.ts`、`daemonModules/taskExecution.ts`、
    `daemonHttpComposition.ts` 或 `daemonApplication.ts` 的用例，以及取它们的用例侧辅助的用例；
  - 本 RFC 用例。

  结果：候选 3,543 条通过、475 条红（119 个文件）；对照（少本 RFC 用例）3,530 条通过、501 条红（114 个文件）。
  - 本 RFC 用例 7 / 7。走迁出代码的用例两边相同：
    - 内建作业：`rfc396-mr-job` 7 / 7；
    - 运行时选择快照：`rfc349-runtime-registry-provider` 6 / 6；
    - PostgreSQL 磁盘报告：`rfc349-maintenance-disk-provider` 3 / 3；
    - 装配面：`architecture/rfc380-daemon-module-bundles` 9 / 9、`architecture/rfc386-drive-factory` 7 / 7、
      `rfc359-w12-digital-employee-execution` 4 / 4、`rfc310-pr4-execution-host` 8 / 8。
  - 逐文件比失败名，候选多出 37 条：
    - T17 1 条（上面的缺陷）；
    - 撞默认的 5 秒 21 条；
    - 撞用例自带的时限 9 条：20 秒 3 条、30 秒 2 条，`rfc359-w14-legacy-mission-execution` 等终态回调的 25 秒、40 秒、60 秒与 4 秒各 1 条；
    - PostgreSQL 一段的钩子撞时限 4 条：`admin-only-gate` 3 条（一个 60 秒的钩子与两例的 `beforeEach`，日志里随之有库的世代围栏拒写）、
      `scheduler-port-validation-followup-integration` 1 条（60 秒）；
    - 前一例撞时限后同一文件的连带 2 条：`rfc381-daemon-integration-bundles` 一例 `signal.aborted`、`scheduler-default-retries` 一例
      “Unhandled error between tests”。

    对照多出 63 条，同样是这几类。

- **全量 SQLite**（候选 1；导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的
  时限照旧；清单按耗时从慢到快排，3 个 worker；与首批同时）：2,950 个文件，2,937 个通过（23,996 条通过、127 条按环境跳过），其余 13 个
  文件 15 条红：
  - T17 一条（上面的缺陷）；
  - 两个报告类用例撞自带时限：`rfc294-architecture-preflight` 两例（60 秒与 180 秒）、`rfc376-report`（300 秒），见下文放宽副本；
  - 发布账本 `rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里；
  - `rfc167-dynamic-workflow-engine` 的 approve 一条：`settleTask` 等满 5 秒时任务仍是 running；
  - 撞自带时限的 9 条：`rfc098-wrapper-stale-redispatch` 两例（各 20 秒）；`rfc300-webhook-workspace-cleanup-e2e`、
    `rfc321-repository-publication-system-mock-e2e` 与 `rfc354-nested-frames-closure`（各 30 秒）；`lifecycle-property`（15 秒）；
    `rfc354-nested-loop-frames`（20 秒）；`rfc359-w9-retry-rollback-parity`（10 秒）；`rfc395-v3-content-inventory` 的六万五千行一例（30 秒）。

  静态 import 闭包（含按路径起的夹具）取到本 RFC 改动的生产文件的有 409 个文件，其中 402 个通过。按改动文件分：
  - 数字员工的两个文件：各 260 个，258 个通过；
  - 系统运维组合文件：272 / 270；本机盘点文件与 platform 新文件：各 273 / 271；
  - runtime-management 的两个文件：各 405 / 398。

  红的 7 个（`rfc098`、`rfc300`、`rfc354` 的两个、`rfc167`、`lifecycle-property`、`rfc359-w9`）都撞时限，进下文的复跑与放宽副本。

- **复验**（候选 2，修正之后）：
  - **改动文件的行为用例** 25 个：直接或经用例侧辅助取到系统运维组合文件、本机盘点文件、platform 新文件或 `routes/maintenanceDisk.ts` 的
    用例，直接取 bootstrap `daemonModules/adapters.ts` 的用例，按名字、路径与 `/api/maintenance/disk`、报错文案扫出的用例，以及本 RFC
    用例。按首批的跑法跑：候选 229 条通过、20 条红（9 个文件），都撞时限。
    - 首批没有收的 5 个文件在对照上同时跑：`api-contract`、`api-contract-coverage`、`rfc311-maintenance-disk`、
      `rfc370-committed-architecture-source`、`rfc480-te-collaboration-public-lock`。
    - 与首批的对照比，只红在候选的一条：`rfc386-task-drive-coordinator-factory` 的 “former PostgreSQL session wiring”，撞默认的 5 秒
      （7.6 秒；对照 5.0 秒过；下面的复跑里这个文件两边 56 / 56）。
    - 两边都过：`rfc349-maintenance-disk-provider` 3 / 3、`rfc311-maintenance-disk` 3 / 3、`api-contract` 525 / 525、`api-contract-coverage`
      7 / 7、`rfc480` 13 / 13；本 RFC 用例 7 / 7。
    - `rfc370-committed-architecture-source` 两边都撞自带的 150 秒，见放宽副本。
  - **源码扫描** 342 个：`tests/architecture/` 全部 140 个，以及按源码读生产文件、不经 import 的根目录扫描 202 个（SQLite，单条 60 秒，
    3 个 worker）。337 个通过（3,608 条通过、12 条跳过），T17 通过。红的 5 个：
    - 撞自带时限：`rfc376-report`（300 秒）、`rfc294-architecture-preflight` 的能力归属一例（180 秒）、`architecture/rfc400-collaboration-task-participants`
      的一例负对照（自带 30 秒，用了 62 秒；首批两边都过，42.6 / 37.7 秒）、`rfc321-repository-publication-system-mock-e2e`（30 秒）；
    - 发布账本 `rfc321-repository-publication-ratchet`：同上，导出仓库的历史。
- **红文件放宽默认时限复跑**（候选 2；按首批的跑法，默认时限放宽到 60 秒、看门狗 3,000 秒，各 2 个 worker，与对照同时）：123 个文件，即首批
  任一边红过的 121 个与全量里红的 13 个合起来，去掉 T17（已在扫描里复验）与报告类的 `rfc376-report`。候选 1,840 条通过、63 条红（25 个
  文件）；对照 1,843 条通过、61 条红（26 个文件）。
  - 首批候选多出的 36 条（T17 之外）：
    - 26 条两边都过；
    - 9 条所在的文件两边全过：`admin-only-gate` 44 / 44、`tasks-multipart` 20 / 20、`runtime-freeze` 33 / 33，以及
      `rfc354-nested-depth3-frames`、`rfc354-nested-loop-frames`、`scheduler-boundary-fanout-shardkey-collision`、`scheduler-node-overrides`、
      `scheduler-port-validation-followup-integration`；
    - `clarify-review-combination-scenarios` 的 S-RFC074 一例两边仍红（自带 20 秒），进放宽副本。
  - 这一轮只红在候选的 6 条：
    - 撞自带时限 4 条：`lifecycle-property` 的 SQLite 一例（15 秒）、`rfc294-architecture-preflight` 的 public surface 一例（60 秒）、
      `rfc384-daemon-intent-bundle` 的维护增量一例（15 秒）、`scheduler-clarify-dispatch` 一例（20 秒）。对照这四例过。
    - `rfc395-v3-content-inventory`：PostgreSQL 一段的钩子撞 90 秒（辅助 `rfc395V3Harness.ts` 的预算）。对照同样撞在同一文件的 V3-F 一段；
      这个文件不取本 RFC 的代码。
    - `scheduler` 的 PostgreSQL “loop exhausted when exit condition never satisfied”：46.0 秒，没有撞 60 秒。任务驱动释放时
      `resolveQuiescedManagedProcesses` 以 `task-execution-stale-owner`（“managed-process recovery was fenced”）被拒，随后读到的任务行不是
      预期的 `failed`。
      - 按代码看最可能的原因：释放序列（`taskDriverRelease.ts`）先 `stopHeartbeat` 再读 owner 行，而 `stopHeartbeat` 只做 `clearInterval`。
        15 秒一次的 owner 心跳（`taskDriverLifecycle.ts` 的 `startOwnerHeartbeat`，每次 revision + 1）若已在途，可能在这次读之后、清算事务
        加锁复核之前提交，期望的 revision 对不上，于是被围栏拒绝。负载高时 PostgreSQL 事务慢，这个窗口更宽。
      - 这是 task-execution 既有的时序，本 RFC 不改 task-execution 的任何代码。同一例在首批（候选 1）52.3 秒通过；两版候选的运行时选择
        代码逐字相同。
  - 只红在对照的 4 条都撞时限：`rfc321-repository-publication-system-mock-e2e`、`rfc359-w9-retry-rollback-parity` 的 SQLite 一例、
    `scheduler-audit-gap4-loop-exit-out-of-scope-port`、`scheduler-audit-s02-multirepo-retry-rollback-noop`。
  - 两边同样红的非时限项：`rfc167` 的 approve 一例（`settleTask` 5 秒）；发布账本（导出仓库的历史）；`scheduler-rfc040-wrapper-await` 与
    `scheduler-clarify-inline` 的断言（同一文件前几例撞自带的 15 秒之后）。
  - 这一轮红的 27 个文件里，23 个取到本 RFC 的代码：都经 runtime-management 的 `runtimeSelection`，其中 19 个也经数字员工与系统运维的
    改动文件。不取的 4 个是 `rfc294-architecture-preflight`（按源码读文件）、两个发布用例与 `rfc395-v3`。取到的 23 个里，在候选上红的
    21 个都带自带时限，全部进放宽副本；另外两个只在对照上红。
- **放宽副本**（候选与对照同时，按首批的跑法、各 3 个 worker；默认时限放宽到 1,500 秒，用例自带的时限改在副本里，其余逐字）：25 个文件。
  - 收的是：报告类三个（`rfc376-report`、`rfc294-architecture-preflight`、`rfc370-committed-architecture-source`）；扫描里红的
    `architecture/rfc400-collaboration-task-participants`；全量里红而取到本 RFC 代码的 5 个（`rfc300`、`rfc354-nested-frames-closure`、
    `rfc167`、`lifecycle-property`、`rfc359-w9`；另两个 `rfc098` 与 `rfc354-nested-loop-frames` 在复跑里两边已过，不再做副本）；复跑里在
    候选上红、取到本 RFC 代码的其余 16 个。
  - 副本里的改动：用例与钩子的自带时限放宽到 1,500 秒；另有 `rfc167` 的 `settleTask` 等待 5 → 50 秒、`rfc300` 的轮询 15 → 150 秒、
    `clarify-review-combination-scenarios` 的流程看门狗 20 → 600 秒（git 与节点 10 → 100 秒）、`scheduler-default-retries` 的单次预算
    4 → 250 秒、`scheduler-wrapper-scope-dependencies` 等上游标记的四处 5 秒等待 → 500 秒（期望“尚未出现”的 1 秒等待不动）。
  - 结果：两边都是 283 条通过、0 条红，25 个文件全过。
    - 报告类与扫描：`rfc376-report` 16 / 16（byte-identical 那一例候选与对照 572 / 809 秒，超出自带的 300 秒）；
      `rfc294-architecture-preflight` 14 / 14（public surface 一例 138 / 97 秒、能力归属一例 686 / 730 秒，超出自带的 60 秒与 180 秒）；
      `rfc370-committed-architecture-source` 2 / 2（那一例 271 / 272 秒，超出自带的 150 秒）；`rfc400` 6 / 6（负对照一例 45 / 47 秒，超出
      自带的 30 秒）。
    - 复跑里只红在候选的：`lifecycle-property` 6 / 6、`rfc384-daemon-intent-bundle` 12 / 12（维护增量一例的 PostgreSQL 版 29 / 32 秒）、
      `scheduler-clarify-dispatch` 16 / 16（PostgreSQL 一例 40 / 39 秒）、`scheduler` 43 / 43（PostgreSQL 的 “loop exhausted” 一例
      70 / 40 秒；这只是又一次结果，归因依据见上）。
    - 其余：`clarify-review-combination-scenarios` 18 / 18（S-RFC074 一例 17 / 18 秒）、`rfc359-w9` 26 / 26（PostgreSQL 一例 55 / 106 秒）、
      `rfc167` 29 / 29（approve 一例 13 / 14 秒）、`rfc300` 2 / 2（35 / 34 秒）、`scheduler-cross-clarify-dispatch` 17 / 17、
      `scheduler-wrapper-scope-dependencies` 18 / 18、`scheduler-rfc040-wrapper-await` 10 / 10、`scheduler-clarify-inline` 10 / 10、
      `scheduler-default-retries` 9 / 9 等。
  - 跑完删除副本，两个导出仓库恢复干净（候选 `181ac3c`、对照 `f710d29`，工作区无改动）。
- **架构报告**（`scripts/architecture-report.ts`，候选 2 与对照各出一份；候选 1 的那份三项计数与之相同）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差三项（= 新的 `max`）：
    - `composition-control-flow-digital-employee` 19 → 13；
    - `composition-control-flow-runtime-management` 23 → 22；
    - `composition-control-flow-system-operations` 28 → 26。

    少掉的 9 条正是迁走的控制流（对照的 `builtinJobTemplates.ts` 第 17、18、22、43、47、48 行，`runtimeSelection.ts` 第 34 行，
    `maintenanceDisk.ts` 第 13、14 行），没有新增。

  - 生产文件 4,110 → 4,112（backend 3,246 → 3,248：数字员工的 application 新文件与 platform 的新文件）。
  - 跨 context import 7,503 → 7,504：多一条值边，是系统运维组合文件从 `@/platform/persistence/postgresqlStorageFootprint` 取
    `readPostgresqlStorageFootprint`，与模块取 platform 的每条边同类。
  - public surface 不变。
  - 模块符号归属 32,380 → 32,387：组合层的 `nonNegativeInteger` 移出；新增数字员工新文件 3 项、platform 新文件 3 项（与
    `databaseOperationalAdapter.ts` 同类），`createRuntimeSelectionSnapshotsInTx` 与 `reportMeasuredDiskReclaimable` 各 1 项。
  - 变更入口 2,365 → 2,367：`createBuiltinEmployeeJobs` 与 `createRuntimeSelectionSnapshotsInTx` 在 application 记为入口，组合层此前不计。
  - 其余各节逐项相同。

- **旧位置全仓扫描**（工作树，候选 2；对全部包、`e2e`、`scripts`、`.github` 与 `architecture/`，全部文件类型，已跟踪与未跟踪）：
  - 候选 1 的位置与名字（`postgresqlMaintenanceDisk`、`reportPostgresqlDiskReclaimable`）只剩 design §6 第 4 条记修正经过的叙述。
  - 新名字只出现在各自的新位置、三个组合文件、本 RFC 用例与本 RFC 的文档里。
  - 按路径或名字钉三个组合文件与装配入口的锁都不改，也都通过：
    - `architecture/rfc359-w5-same-file-provider-pairs` 的成对账本（`composition/maintenanceDisk.ts` 的两个组合入口）；
    - `architecture/rfc380-daemon-module-bundles` 的名字表；
    - `rfc349-runtime-registry-provider` 读 bootstrap `daemonModules/taskExecution.ts` 的接线文本；
    - `rfc310-digital-employee-os-architecture` 的 bootstrap → 组合文件边。
  - `rfc396-mr-job`、`rfc396-registration`、`rfc349-maintenance-disk-provider` 与用例辅助 `helpers/nodeRunRuntime.ts` 仍从组合入口取。
  - PostgreSQL 报告的 SQL（`pg_database_size`、`pg_stat_user_tables`）在仓内别处出现的，都是不相关的读与注释；没有按文件路径钉这段 SQL
    的账本。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `9628d5590` 的树加本 RFC 的 16 个路径（10 个代码与账本路径，以及
  三件套、`STATE.md`、RFC 索引与 RFC-504 的 plan）。读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、
  `docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、
  `rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `490d75e04`（实现，父提交是 `9628d5590`）：exact SHA 主 CI run 44382772167 的 70 个 job 第 1 次全部通过（含「Static scans」与
  `CI required`），未重跑。
- 本 RFC 的落档提交 `9628d5590`（只改文档，同一提交补记 RFC-504 转 Done 提交的 CI）：主 CI run 44288340179 共 70 个 job，68 个通过；红的
  两格与提交无关：「Static scans」的 dependency audit gate（high+critical）（依赖面没有变化，按用户规则不分析、只记录）与随之红的
  `CI required`。没有重跑。
- 转 Done 的 `7f0e056c3`（只改文档）：主 CI run 44391326397 的 70 个 job 第 1 次全部通过（补记于 RFC-506 的实现提交），未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **内建作业**：`createBuiltinEmployeeJobs` 的两个方法是 HEAD `composition/builtinJobTemplates.ts` 第 14～64 行逐字，只把三处 `Date.now()`
  改为 `deps.now()`（`ensureDraft` 建草稿前一处，`ensure` 建行时 `createdAt` 与 `updatedAt` 各一处，次数与位置不变）。作者面持久化仍随每次
  装配建一份，`publish` 原样交入。组合入口的签名不变，交出的仍是 `{ ensureDraft, ensure }`，时钟是调用时才取的 `() => Date.now()`。
- **PostgreSQL 磁盘报告**：
  - platform 的 `readPostgresqlStorageFootprint`：查询是 HEAD 组合文件第 44～53 行（SQL 文本逐字，`runtime` 改由参数交入）；两处校验是
    第 56～60 行，先 reclaimable、后 database，次序与文案不变；`nonNegativeInteger` 是第 11～17 行逐字；JSDoc 是第 33～37 行逐字。
  - infrastructure 的 `reportMeasuredDiskReclaimable`：是第 54～61 行的形状，退役目录仍在本机量，报告与 `items` 数组的两层 freeze
    不变，两个数改从入参取。
  - 组合入口的 `report` 先读后拼，参数仍是同一个 `runtime` 与 `appHome`；`cleanupRetiredStores` 与 SQLite 版不变。
  - 唯一的先后差别（design §5）：HEAD 先量退役目录再校验，现在先校验再量。量目录只读、不抛错（`dirSize` 吞掉读错，`existsSync` 不抛），
    所以成功时报告逐字段相同，校验失败时抛同一条错误。
- **运行时快照**：`createRuntimeSelectionSnapshotsInTx` 的表与两个方法是 HEAD `composition/runtimeSelection.ts` 第 18、24～26、31～36 行逐字
  （`retain` 由箭头函数改为不用 `this` 的方法，作为函数值交给参与者）。组合入口里读端口、注册表、快照表、能力与参与者的建立次序不变，
  返回值仍是 `{ capability, participant, readSnapshot }`；`readSnapshot` 仍先核对任务范围，取不到就抛同一个错误，交出副本。
- **账本与用例**：`counts.json` 三项收紧到实测（与架构报告一致），系统运维一项的说明随修正改写；guard-manifest 登记新用例（563 行）；既有的
  锁与用例都不改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-504 转 Done 提交 `a1a5b70a1` 的 CI 当时仍排队，
结果补记于实现提交）；实现与验证后再提交 `refactor(backend): RFC-505 数字员工的内建作业、PostgreSQL 磁盘报告与运行时选择快照迁出
composition（RFC-294 S10 第十二步）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
