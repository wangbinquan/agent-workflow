# RFC-478 实施计划

**前置**：RFC-477 落地（Done，`802a4033b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                          | 依据         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-478-T1 | domain：`domain/builtinWorkflowLayout.ts`；`domain/workflowSyncPreview.ts` 并入运行摘要与快照解析                                                                                                             | design §1    |
| RFC-478-T2 | 同步预览：`application/ports/workflowSyncPreviewReads.ts`、`application/workflowSyncPreviewQuery.ts`、`infrastructure/workflowSyncPreviewReads.ts`；回滚目标选择器并入 `application/resumeRollbackTargets.ts` | design §3    |
| RFC-478-T3 | 延后仓库准备：`infrastructure/deferredRepositoryPreparation.ts`；绑定必填并加 `groupCachedRepoIds`（task-execution 端口与 source-control 实现）；composition 装配                                             | design §2    |
| RFC-478-T4 | 任务详情读投影 `infrastructure/taskDetailRead.ts`；运行时选项 `composition/taskDriveRuntimeOptions.ts`；全部生产消费方改取                                                                                    | design §4–§5 |
| RFC-478-T5 | 测试专用出口进 `tests/helpers/`；`shutdownActiveTaskExecutions` 与 `services/task.ts` 删除                                                                                                                    | design §5    |
| RFC-478-T6 | public 收口（撤出失去模块外生产消费方的符号；用例改取定义处）                                                                                                                                                 | design §6    |
| RFC-478-T7 | 用例与账本（实测）：63 个 import 方、43 个以路径读它的文件、两份 workflow 路径过滤、新增 RFC-478 用例、`R1` 账本、owner 表、`familyHistory` 站点账本、减速带（C13）、注释与文档链接                           | design §7    |
| RFC-478-T8 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                                                            | design §10   |

## 验收清单

- [x] AC-1 `services/task.ts` 不在、零引用；`R1` 里没有它；测试专用出口只在 `tests/helpers/`
- [x] AC-2 行为不变（延后仓库准备、同步预览、任务详情与失败码、运行时选项）
- [x] AC-3 架构计数按实测（`R1` 27 → 18），越界、偏差与未消费 public 符号不升，新文件按内容分层；触及的减速带收紧到实测
- [x] AC-4 受影响用例与新增用例全部通过（四个包）
- [ ] AC-5 exact SHA CI 全绿

## 集中验证（2026-11-10，候选基于 `aa36819e6`）

本机全程高负载（10 核；另有常驻负载：一台虚拟机约 5.7 核、三个常驻 bun 进程约 3 核；采样到的 1 分钟负载 36～99）。验证都在候选导出
仓库里跑（HEAD 的 `git archive` 加候选路径，提交后运行；修复后重新同步，核对与 HEAD 加候选逐字相同）；对照组是与 HEAD 逐字相同的导出仓库
（12104 个路径逐个相等）。验证期间 `origin/main` 未前进。集中验证查出本 RFC 的七处问题，都已修复并复验——前三处由计数复核报出，后四处由
全量 SQLite 报出（PostgreSQL lane 报出其中三个文件的同一批断言）：

1. `off-dag-offered-file-context-pairs` 55 → 56：运行时选项漏斗 `composition/taskDriveRuntimeOptions.ts` 为入参里的 `memoryDistillEnqueuer`
   取了 memory `public/participants` 的类型（原在 `services/task.ts`，legacy 文件不算 context 间的边），多出一条 task-execution → memory 的越 DAG
   offered 文件对。改为取它所喂的观察者的参数类型（`Parameters<typeof composeAgentRunDistillObserver>[0]`，同一个类型），复采回到 55。
2. 未被消费的 public 符号 322 → 326：撤出的三个工厂的返回类型——task-execution `public/queries` 的 `TaskDetailQueries`、`TaskPreparationQueries`
   与 `public/participants` 的 `TaskPreparationParticipant`——随工厂失去模块外读者；source-control `public/queries` 的 `resolveRepoGroupLayout`
   模块外唯一的读者是 `services/task.ts` 的重试回收（迁移后改经准备绑定）。四个一并撤出（`rfc395-a7-horizontal-participants` 改取定义处的
   类型，RFC-478 用例的撤出断言补上它们），复采回到 322。
3. public 类型偏差的白名单：`rfc294-architecture-preflight` 的 `PUBLIC_SURFACE_DEBT` 与实测逐条相等，挂在撤出的三个工厂
   （`createTaskDetailQueries`、`createTaskPreparationQueries`、`createTaskPreparationParticipantInTx`）上的三条随之失效（偏差 91 → 88），删去。
4. 按段拼路径读它的九个老守卫：落档时只按路径字面量清点读 `services/task.ts` 的用例（design §7 实测改写），漏了按段传给 `resolve` / `join`
   的写法（`resolve(dir, '..', 'src', 'services', 'task.ts')`）。五个在模块作用域读、加载即 `ENOENT`（`source-text-rfc066-guards`、
   `source-text-rfc066-pr-b-guards`、`source-text-rfc067-guards`、`scheduler-audit-s13`、`rfc248`），四个在用例体里读（`rfc287-t13-deferred-prep`
   六处、`rfc287-t13-preset-task-id`、`rfc359-w8-runtime-participants-conformance`、`scheduler-audit-s15`）；`test-suite-policy` 的「读的源码路径
   都在」也报出其中八个。负向锁改读继任文件并集，正向锁改指具体继任文件（`scheduler-audit-s13` 的准备行重试序读取与 `rfc287-t13-deferred-prep`
   的六处接线锁 → `infrastructure/deferredRepositoryPreparation.ts`，其中重试循环的锚点原写着旧转出命名空间 `taskDriveComposition.`，改成
   定义处的函数名）。`scheduler-audit-s15` 的「resume / retry 先杀树再回滚」在 HEAD 上只靠依赖袋里的注入字段与类型 import 凑够三处命中
   （`resumeTask` / `retryNode` 早已迁走），改锁两处生产现场：恢复参与者先收割、再真回滚，重试 / 同步先杀树、再回滚。`rfc468` 的匹配器负对照
   拿它当 importer 路径，换成合成路径。RFC-478 用例的路径锁补上按段拼写的判据（相邻的 `'services'` / `'task.ts'` 实参，带负对照）。
5. workflow 路径过滤：`git-protocols-e2e.yml` 与 `windows-platform.yml` 的 push / pull_request 两份过滤都登记着它（`ci-workflow-path-filters`、
   `test-suite-policy`、`rfc473`、`rfc474` 与 RFC-478 用例报出）。前者改登记接走那两处 `redactGitUrl`（`task_repos` 投影与准备后的回填）的
   `infrastructure/deferredRepositoryPreparation.ts`；后者删去（同一份过滤里的 `infrastructure/*Preparation*.ts` 已覆盖它）。
6. 两本账：RFC-395 `familyHistory` 站点账本的三条（`selectSyncRollbackTargets`、`computeWorkflowSyncPreview`、`loadTaskFailureCodes`）随函数
   换了文件（同步预览那条现在是读端口实现的 `freshestDoneTopLevelRunId`），按账本自己的抽取器重录站点与源码，`today` / `whyFrameless` 不变；
   RFC-359 W5-T19f 的 `sqlite-execution-engine` 机械理由认 `from 'services/task'` 这条拼法，`rfc300-workspace-prune` 只因 import 了它的
   `getTask`（读投影，不驱动执行引擎）被认领，改指定义处后失去理由——按该账本的先例迁到 `describeEachProvider`（open 名单不涨、总账销一行），
   那条拼法随文件退役从判据里删除。
7. 拿撤出或改了形状的东西作锚的断言：`rfc476` 的正对照 `createTaskPreparationParticipantInTx`（本 RFC 撤出）改用同族仍在的
   `createConsumedInputsParticipantInTx`；`rfc447` 的引用方清单去掉 source-control `public/queries`（`resolveRepoGroupLayout` 的转出已撤）；
   `rfc470` 锁的 `computeWorkflowSyncPreview(...)` 调用形改为第一个实参经读端口；RFC-478 用例自己的「延后准备不提 `repositoryWorkspace`」
   读到了说明删除的注释，改为只看代码。

- **静态**（最终候选，工作树里只有本 RFC 的改动）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS
  文件，加 `eslint.promises.config.js` 覆盖的 src 文件）；`depcheck` 分层门通过（4442 个模块）；改动的 TS、两份 workflow、JSON 账本与 RFC-478
  三件套 prettier 检查通过。
- **全量 SQLite**（首版候选，四片 2928 个文件次，6375 s）：四片（`AW_TEST_PROVIDERS=sqlite`）共 23808 个用例：23596 pass、127 skip、85 fail、35 个 error。fail 里 25 条（14 个文件）与另外
  五个文件的加载失败是上面第 4～7 处问题；53 条（29 个文件）撞时限（5～300 秒不等）；余下两条是导出仓库里恒红的 `rfc321`（见下）与
  `rfc370-execution-effect` 一例（见下）。修复后，修复所及与改动过的 22 个文件加 RFC-317 全部 22 个守卫（44 个文件）在最终候选上全过。
  撞时限的 29 个文件里 `rfc294-architecture-preflight` 与 `rfc317-transition-table-oracle` 在这次复跑里全过，其余 27 个连同
  `rfc370-execution-effect` 同一时刻对照 HEAD（两边各 3 个 worker，1 分钟负载 60～99）：23 个两边失败集合逐例相同（含两边都全过的 4 个），
  5 个只差哪几例撞时限；其中 4 个再跑一对后两边逐例相同，`rfc370-execution-effect` 在候选一侧 13 / 13 全过、HEAD 一侧另一例到点。
- **导出仓库接 PostgreSQL 真库**：`AW_TEST_POSTGRESQL_URL` 指本机临时容器（每个 worker 一个库，两个引擎都跑），在首版候选上跑取到改动文件的
  519 个用例里能到引擎选择的 233 个（两个 runner 认领同一份清单）：223 个全过。10 个失败文件里 3 个（`rfc359-w8`、`rfc470`、`rfc478`）是
  上面第 4、7 处问题的同一批断言，修复后连同迁到双引擎的 `rfc300-workspace-prune`（34 / 34）在最终候选上补跑全过；其余 7 个（6 个撞时限，
  `rfc167` 一例在 5 秒时限里等不到任务收场）同一时刻对照 HEAD（各两个 worker、各用各的库）：7 个两边失败集合逐例相同。不到引擎选择的
  286 个文件由全量 SQLite 覆盖。
- **其他包**：本 RFC 不改 shared、frontend 与 system-mocks（三个包也不取 backend 的源码），沿用 RFC-477 集中验证在同一内容上的结果：shared
  209 个文件 2344 pass；system-mocks 30 秒时限 21 个文件 111 / 111；frontend（`test:frontend:gate`）871 个文件 7361 pass。
- **RFC-321 发布账本**：导出仓库没有可达历史，按惯例在工作树里跑：10 / 10。
- **文档用例**（最终文档，接 PostgreSQL）：RFC 索引状态、文档与实现对账、RFC-294 设计对账、过期断言不变量、`test-suite-policy` 与
  RFC-477 / RFC-478 用例等 12 个文件 107 pass。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，候选导出，这份导出不同时跑别的用例）：SQLite 17 个阶段全部符合预期（0 failures），114 s，
  前后 127 个受保护源文件的哈希一致、工作树干净。PostgreSQL：本机 1 分钟负载约 50（外部的 kind 集群一家占 5～6 核）时，
  第一阶段（未变异基线）跑到 lane 自带的 300 s 阶段时限被终止——22 例通过、0 例失败，单例 18～21 s——不构成结论；PostgreSQL 一半以 exact SHA
  CI 的 P0 lane（`Backend tests (real PostgreSQL)` 的两个数据库）为准
- **结构锁的覆盖范围**（RFC-294 C12）：RFC-478 用例里文件不在与零 import 覆盖 backend 的 src / 用例 / 脚本（`preProcessFile` 取全部模块引用），
  零路径覆盖四个包的 src / tests / scripts、e2e 与仓根脚本——路径字面量与按段传给同一调用的 `'services', 'task.ts'` 两种写法（注释不算；两份
  有意拼写旧路径的 fixture——读历史语料的架构报告与 RFC-331 的匹配器自测——登记豁免，且断言它们仍在拼写），workflow 按完整路径扫，
  Markdown 相对链接覆盖 `design/` 与 `docs/`，`R1` 里没有它按全仓 census；分层锁只覆盖指定文件——十个新增或并入文件的导出清单，两个
  domain 文件不取 `node:` / `@/db` / `drizzle-orm`，三个 application 文件不取 infrastructure 与 legacy，
  `infrastructure/deferredRepositoryPreparation.ts` 不取 source-control 与 `services/`；绑定锁覆盖 task-execution 的
  `infrastructure/repositoryPreparationBinding.ts` 与 source-control 的 `composition/repositoryPreparation.ts`；public 收口锁覆盖 task-execution 的
  `public/queries`、`public/participants`、`public/operations` 与 source-control 的 `public/queries`。上下文值环、off-DAG 值对、跨 context 内部
  文件对与 `backend-value-scc` 是既有的全仓闸门。
- **计数复核**（`scripts/architecture-report.ts --gates` 在导出仓库的提交上采数，HEAD `aa36819e6` → 最终候选，首版与最终候选两次采数逐项相同）：`R1-inbound-module-internals`
  27 → 18、`R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 168 → 167、`legacy-service-implementations`
  49 → 48，其余 20 项闸门计数逐项不变（含 `context-value-sccs` 0、`context-value-pairs-off-dag` 0、`off-dag-offered-file-context-pairs` 55、
  `cross-context-internal-file-pairs` 43、`backend-value-scc` 0、`module-layer-violations` 1）；后端生产文件 3194 → 3200（新增七个、删一个）；
  跨 context import 记录 7718 → 7678、facade 49 → 48、变更入口清单 2347 不变（五条随文件换位置）；public surface 1495 → 1477（撤出 18 个：
  task-execution `public/queries` 的 `createRunHistoryBatchSnapshot`、`createTaskDetailQueries`、`createTaskPreparationQueries`、
  `resolveTaskLaunchRuntimeConfiguration`、`TaskLaunchConfigurationQueries`、`TaskDetailQueries`、`TaskPreparationQueries`，`public/participants` 的
  `taskExecutionModule`、`createLocalEffectAttemptObserver`、`builtinWorkflowSyncPreview`、`workflowSyncGateReason`、`setNodeRunStatusInTransaction`、
  `createTaskPreparationParticipantInTx`、`TaskPreparationParticipant`，`public/operations` 的 `mintNodeRun`、`setNodeRunStatus`、`setTaskStatus`，
  source-control `public/queries` 的 `resolveRepoGroupLayout`；不新增）；偏差 91 → 88（挂在撤出的三个收句柄工厂上的三条）；未被消费的
  public 符号 322 不变；模块级可变状态清单 79 条、task-owned effect 10 条（`workspace-prepare` 那条随文件换到
  `infrastructure/deferredRepositoryPreparation.ts`）、required port 66 条逐条不变。design §14 的不变量（plan §0 第 8 条的主口径）：值级环
  0 / 0、跨 context 内部 import 43（不升）、public 类型污染 88（降 3）、未消费 public 符号 322（不升）、`services/` 业务实现 48。收口时按
  RFC-294 C13 把触及的两项减速带收紧到实测：`legacy-horizontal-files` max 168 → 167、`legacy-service-implementations` max 49 → 48。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的函数体与原文件逐段比对：布局三件套、运行摘要与快照解析、同步回滚目标选择器、任务详情读投影、运行时选项漏斗、测试专用出口与
  依赖袋逐字相同；同步预览只有四处读改经端口（同四个查询，选择读取器同样每次预览只建一个）；延后准备的描述读取、围栏、窗口重试、三种
  收场与回填事务逐字相同，差异只有：绑定必填后删掉的「无绑定」分支（生产与全部用例装配都传绑定，`tsc` 为证）、日志化准备直接调定义处的
  `prepareDurableRepositoryWorkspace`（原经 `taskDriveLegacy` 的转出，同一个函数）、空清理账本就地构造（与 source-control 的构造逐字段相同，
  用例为证）、离开准备窗口时非日志化准备的清理改经绑定的 `legacy.cleanup`（即同一个租约清理，外加一次只对 scratch 有效的登记清除——延后
  准备的来源只有缓存仓 / 仓库组；生产上步骤与绑定都不传清理钩子）、重试回收的组成员改经绑定的 `groupCachedRepoIds`（与 `groupName` 同一段
  `resolveRepoGroupLayout`、同一个仓库工作区存储；解析失败照旧被吞）。日志器名仍是 `task`，日志行不变。
- 绑定的使用方：bootstrap、`composeDeferredRepositoryPreparation` 与全部用例 helper 都取 source-control 的 `composeRepositoryPreparation`（崩溃
  fixture 展开真绑定），新方法随之在场；没有手写的绑定替身。
- public 收口：撤出的 18 个符号在 backend、shared、frontend、system-mocks、e2e 与脚本里都已无模块外生产取用方（`tsc` 与计数复核为证），
  模块内部与用例改取定义处；`taskDriveLegacy.ts` 里只为 `services/task.ts` 留的转出一并删除。
- 用例侧：改指的守卫判据方向不变（负向锁读并集、正向锁读具体继任文件），唯一改了射程的是 `scheduler-audit-s15` 那条已经落空的锁（改锁真正
  的两处生产现场）；`rfc300-workspace-prune` 迁双引擎只换建库方式（`harness.db`），用例体不变。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（目录入库，索引链接不断）；实现与验证后再提交
`refactor(backend): RFC-478 services/task.ts 按内容分层归 task-execution（RFC-294 W9-D，task-execution 一族收尾）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
