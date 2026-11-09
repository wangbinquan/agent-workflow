# RFC-474 实施计划

**前置**：RFC-473 落地。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，
开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                 | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-474-T1 | knowledge-evolution `composition/routes.ts`，`server.ts` 改取                                                        | design §1     |
| RFC-474-T2 | config：bootstrap 组装文件存储、`main.ts` 注入，CLI 只收注入的存储                                                   | design §2     |
| RFC-474-T3 | doctor：Doctor composition 转出 `formatDoctor`、bootstrap `runDoctorCommand()`、`cli/doctor.ts` 删除、用例改取定义处 | design §3     |
| RFC-474-T4 | migration-report：development-automation `composition/migrationReport.ts`、bootstrap 依赖、CLI 改收注入              | design §4     |
| RFC-474-T5 | 首启示例：code-capability `public/types.ts`、`completion` 必填并由 bootstrap 启动步骤组装                            | design §5     |
| RFC-474-T6 | 用例与账本：受影响用例、新增 RFC-474 用例、`R1` 账本、owner 表、guard-manifest、workflow 路径过滤                    | design §6、§8 |
| RFC-474-T7 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾   | design §8     |

## 验收清单

- [x] AC-1 五个入口文件不在 `R1` 里；`cli/doctor.ts` 不在、零引用
- [x] AC-2 行为不变（路由同一函数、config / doctor / migration-report 输出与错误同原、完成标记每次启动时选）
- [x] AC-3 架构计数按实测（`R1` 49 → 38），偏差、未被消费的 public 符号与越界类计数不升
- [x] AC-4 受影响用例与新增用例全部通过（四个包）
- [ ] AC-5 exact SHA CI 全绿

## 集中验证（2026-11-08～09，候选基于 `7e7711fbf`，修复后的候选基于 `5343645f1`）

本机全程高负载（采样到的负载 28～100；本机另有常驻负载：一个本地虚拟机与三个挂起的测试夹具进程）。验证都在候选导出仓库里跑（HEAD 的
`git archive` 加候选路径，提交后运行；修复与文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证查出本 RFC 的一处问题，已修复并复验：

1. 全量 SQLite：`rfc453-workspace-insight-module` 报 `modules/code-capability/public/participants` 仍在——RFC-453 把 code-capability 的
   `public/participants.ts`（连同它装的代码评审产物参与方）迁去 workspace-insight，并在退役清单里锁住该路径不复活，而本 RFC 为首启示例的
   参与方类型新建了同名文件。改为放进 code-capability `public/types.ts`（同为 RFC-294 的 exact public 入口），`services/demoSeed.ts` 改取它，
   RFC-474 用例补锁 `public/participants.ts` 仍不在。

- **静态**（修复后的候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src 文件）；`depcheck` 分层门通过（4425 个模块）；改动的 TS、workflow 与 RFC-474 三件套 prettier 检查通过。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（修复前的候选，基于 `7e7711fbf`；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 7967 / 7934 / 7939 /
  7256 s 全部跑完，合计 23561 pass / 127 skip / 92 fail，另有 55 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。92 条 fail
  里 89 条是超时：76 条撞默认 5 秒、4 条撞 30 秒、2 条撞 20 秒、2 条撞 40 秒、15 / 60 / 150 秒各 1 条、`rfc376-report` 撞 300 秒，另 1 条是
  `rfc359-t19h-postgresql-upgrade` 的 `beforeEach` 钩子撞 5 秒；余下 3 条：上面那处问题、导出仓库只有候选提交所致的 `rfc321` 发布账本，以及
  `clarify-review-combination-scenarios` 撞用例自带的 20 秒流程时限。
  - 复跑 209 个文件（全量里失败的 47 个文件、全部 139 个架构测试、改到的 14 个用例与新增的 RFC-474 用例、修复的 import 闭包 11 个用例；修复后
    的候选；30 秒时限）：206 个全过（含新增的 RFC-474 用例 17 / 17、修复后的 `rfc453-workspace-insight-module` 12 / 12、改到的用例、全部
    139 个架构测试与修复的闭包），合计 1912 pass / 3 fail / 4 skip（与 PostgreSQL lane、各包同时跑，负载 40～50），余下 3 个文件各一例：导出里
    恒红的 `rfc321` 发布账本（工作树结果见下）、RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）与 `rfc363` 目录分页（用例自带的
    30 秒）。对照：同一时刻在 RFC-473 的导出仓库（树与 `7e7711fbf` 逐字相同）里跑同一文件（负载 42～45）：`rfc167` 两边都是 28 pass / 1 fail、
    同一例到点（6.24 s 与 6.35 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点（30.86 s 与 30.83 s）。
- **导出仓库接 PostgreSQL 真库**（修复后的候选，30 秒时限）：清单 473 个文件（经用例 helper 的 import 闭包取到改动的生产文件的 350 个用例——
  其中 254 个只经应用根 `bootstrap/daemonApplication.ts` 取到——、全部 139 个架构测试与改到的用例），其中 import 闭包能到 PostgreSQL 引擎选择
  （`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量的 285 个文件都跑；其余 188 个文件不碰 PostgreSQL，由
  SQLite 覆盖。修复的闭包都在这份清单或 SQLite 复跑里。285 个文件里 276 个全过，合计 4910 pass / 18 fail / 4 skip（三路并行，与 SQLite 复跑、各包同时跑，负载 40～110）。
  余下 9 个文件 18 例都是撞时限：用例自带的计时到点（`scheduler-audit-s04-git-wrapper-cumulative-diff` 2 例、
  `scheduler-audit-s17-readonly-starved-by-writer-queue` 与 `scheduler-clarify-dispatch` 各 1 例 20 秒，`scheduler-clarify-inline` 4 例与
  `scheduler-rfc040-wrapper-await` 3 例 15 秒，`scheduler-default-retries` 4 例 4～24 秒，`rfc310-employee-case-runtime` 的 `[postgresql]` 一例
  30 秒，RFC-167 `approve` 自带 5 秒 `settleTask`）与 `api-tasks-repair` 一例撞 30 秒。对照：同一时刻在 RFC-473 的导出仓库（树与 `7e7711fbf`
  逐字相同）里逐个跑这 9 个文件（本 RFC 一侧用同一份候选导出的干净克隆，因为 P0 正占用导出仓库；每对两边各用一个库，负载 77～140）：
  `rfc167`、`s04`、`s17`、`clarify-inline`、`default-retries`、`rfc040` 两边失败的用例逐一相同（依次 1 / 2 / 1 / 1 / 1 / 2 例）；`api-tasks-repair`
  与 `scheduler-clarify-dispatch` 两边都全过（26 / 26、16 / 16）；`rfc310-employee-case-runtime` 第一对本 RFC 一侧全过、对照一侧同一例到点，
  120 秒时限再跑一对两边同样 10 / 1、同一例（30.31 s 与 30.21 s，该例的 30 秒是用例自己设的）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，同一份导出仓库，等上面两条 lane 跑完后两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 23.3 / 39.0 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希一致、
  导出仓库工作树干净。
- **其他包**（修复后的候选）：shared 209 个文件 2344 pass；frontend（`test:frontend:gate`）871 个文件 7361 pass；system-mocks 30 秒时限
  21 个文件 111 / 111 全过。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等，加 RFC-474 用例）：12 个文件全过（106 pass；导出仓库与 HEAD 加候选逐字相同）。
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，修复后的候选，c473 → c474）：`R1-inbound-module-internals` 49 → 38、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；21 项闸门计数逐项不变（`legacy-horizontal-files` 177——`cli/` 不在其列——、
  `legacy-service-implementations` 58、跨 context 内部文件对 43、off-DAG offered 文件对 55、不可达生产文件 18、`module-layer-violations` 1、
  `composition-forbidden-import-files` 14 等）；后端生产文件 3181 → 3183（新增三个、删一个）；跨 context import 记录 7769 → 7753（五个入口取
  模块内部的 24 条消失；新增 bootstrap 取 composition 的 4 条、`server.ts` 取 knowledge-evolution `composition/routes` 的 2 条、development-automation
  新 composition 文件取平台 `PersistenceDb` 类型 1 条、首启示例取 code-capability public 1 条）、模块符号归属 32231 → 32238、public surface
  1493 → 1495（code-capability 的两个示例类型，都有消费方）；偏差 94、未被消费的 public 符号 322 逐条相等。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 路由：knowledge-evolution `composition/routes` 只转出，`server.ts` 挂的是同两个函数（RFC-474 用例 `toBe` 锁住），挂载点与依赖不变。
- config：`main.ts` 注入的是 `composeFileCliConfiguration(Paths.config)`，就是原默认路径自己组装的同一个文件存储；处理器的函数体就是原
  selected 路径（先读再校验键、先解析参数再写），以存储为 `this` 调用；原默认路径的同步抛出变为拒绝，`main()` 的 `.catch` 对两者同样打印
  `message`、退出 1，输出与错误文本不变。
- doctor：`runDoctorCommand()` 组装与运行的是原 `runDoctorDiagnostics()` 的同一个 application，`output` 是 domain 的同一个 `formatDoctor` 对
  结果的渲染、`ok` 就是 `result.ok`；`main.ts` 写同一段文本、按同一个布尔退出。`cli/doctor.ts` 的生产消费方只有 `main.ts`，其余都是用例。
- migration-report：provider 解析、两处「未安装」拒绝的报文、开客户端参数与 `finally` 里关运行时逐字不变；分析仍是
  `analyzeLegacyAssets(await collectLegacyAssets(db), now())`（时间在读完行之后取，与原求值顺序相同），人读渲染就是 `printMigrationReport`，
  `--json` 原样输出。
- 首启示例：完成标记仍在每次启动调用时选（`composeInstallationSeedCompletion()` 在 `demo-seed` 步骤体内调用，单机文件标记，与原默认同一个
  路径），`seedDemoContent` 把它交给函数体不变的 `offerDemoContent`；参与方类型换取 public 入口，运行时无痕迹。
- 用例：11 个 doctor 用例只改 import 路径；`rfc370-doctor-diagnostic-family` 的兼容值锁改锁 composition 交出的 `formatDoctor`，主分支锁改认
  `runDoctorCommand()` 与其中的 `formatDoctor(result)`；config、migration-report、首启示例的用例改为走注入，断言的输出与错误文本不变。
- 账本：`R1` 49 → 38（实测与账本逐条相等，`R2` 0）；owner 表删 `cli/doctor.ts`；两份 Windows 路径过滤里的 `cli/doctor.ts` 换成
  `bootstrap/commandBootstraps.ts`；本 RFC 没有改到登记的守卫文件，guard-manifest 不变。

## PR / 提交

单个提交：`refactor(backend): RFC-474 入口适配器经 bootstrap 装配：CLI 命令、路由挂载与首启示例不再直取模块内部（RFC-294 W9-D 第二十一步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
