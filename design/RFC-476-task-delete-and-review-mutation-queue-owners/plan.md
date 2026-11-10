# RFC-476 实施计划

**前置**：RFC-475 落地。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，
开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                               | 依据        |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| RFC-476-T1 | task-execution `infrastructure/taskDelete.ts`（迁入、改取定义处）；`composition/bootRecovery.ts` 转出启动恢复      | design §1   |
| RFC-476-T2 | task-execution 合同 `application/ports/taskReviewMutationQueue.ts`、队列 `infrastructure/reviewMutationQueue.ts`   | design §2   |
| RFC-476-T3 | collaboration 适配器 `infrastructure/reviewMutationLock.ts`；两边调用方改取新位置                                  | design §2.3 |
| RFC-476-T4 | task-execution public 收口（按计数复核撤出失去模块外消费方的符号）                                                 | design §3   |
| RFC-476-T5 | 用例与账本：受影响用例、新增 RFC-476 用例、`R1` 账本、owner 表、void-promise 账本、减速带（C13）、注释             | design §4   |
| RFC-476-T6 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §6   |

## 验收清单

- [x] AC-1 两个 `services/` 文件不在、零引用；`R1` 里没有它们
- [x] AC-2 行为不变（删除的门、事务、清理与恢复；评审 / 取消的排队次序）
- [x] AC-3 架构计数按实测（`R1` 34 → 30），偏差、未被消费的 public 符号与越界类计数不升；触及的两项减速带收紧到实测
- [x] AC-4 受影响用例与新增用例全部通过（四个包）
- [ ] AC-5 exact SHA CI 全绿

## 集中验证（2026-11-09，候选基于 `361945023`）

本机全程高负载（采样到的 1 分钟负载 28～85，本机另有常驻负载）。验证都在候选导出仓库里跑（HEAD 的 `git archive` 加候选路径，提交后运行；
修复后重新同步，核对与 HEAD 加候选逐字相同）。验证期间 `origin/main` 前进到 `e6ab732f5`（他人的纯文档提交：RFC-294 四个文档与 `STATE.md`，
其中带上了本 RFC 的 In Progress 条目），生产代码与用例未变，下面的代码与用例结果沿用；文档定稿后另在 `e6ab732f5` 加候选上复验（见「定稿后的
复验」）。集中验证查出本 RFC 的三处落位问题，都由计数复核报出，已修复并复验：

1. 初版把整份队列放进 collaboration（task-execution 的四个调用方经 collaboration public 取值），删除实现照原样取 collaboration 的事务内参与方：
   `context-value-sccs` 0 → 1、`context-value-pairs-off-dag` 0 → 1（task-execution → collaboration 的值依赖与 offered 方向成环），未被消费的
   public 符号也多一个。队列按任务串行化写入，键与取消都是 task-execution 的，改为队列归 task-execution、经 task-execution 的 public 交给
   collaboration，collaboration 只留作用域解析与 `review-not-found` 的适配器（调用方只改 import）。
2. 队列改后复采，两项值环计数仍是 1，`off-dag-offered-file-context-pairs` 55 → 56：删除实现迁进 task-execution 后仍从 collaboration public 取
   事务内参与方的值（原在 legacy 文件里不算模块间的边）。改为 `deleteTask` 选项与路由依赖上的必填注入，由 bootstrap 交 collaboration 的实现。
3. 再采：值环归零，`off-dag-offered-file-context-pairs` 仍 55 → 56：注入的类型仍取自 collaboration public（类型边也计入 off-DAG 的 offered
   文件对）。改为 task-execution 自有端口 `TaskDeletionCollaborationPort`（consumer 拥有 required SPI，RFC-294 design §3.3），collaboration 现有的
   事务内参与方结构上满足它。复采 21 项闸门计数里只剩两项 legacy 计数各 −2（见计数复核）。

- **静态**（最终候选）：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加
  `eslint.promises.config.js` 覆盖的 src 文件）；`depcheck` 分层门通过（4432 个模块）；改动的 TS 与 RFC-476 三件套 prettier 检查通过。
- **逐项比对**：见实现门。
- **全量 SQLite**（最终候选；导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 7877 / 8214 / 8648 / 8870 s 全部跑完，合计
  23574 pass / 127 skip / 109 fail，另有 60 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。109 条 fail 里 106 条是超时：
  92 条撞默认 5 秒、5 条撞 30 秒、2 条撞 20 秒、2 条撞 40 秒，10 / 15 / 60 / 180 / 300 秒各 1 条；余下 3 条：导出仓库只有候选提交所致的
  `rfc321` 发布账本，`clarify-review-combination-scenarios` 的 S-RFC074 撞用例自带的 20 秒流程时限（到点即取消任务，断言读到 `canceled`），
  `lifecycle-property` 的 stress 一例是同文件前一例 15 秒到点后的夹具撞名（`agents_owner_name_unique`）。
  - 复跑 55 个文件（全量里有失败的 52 个文件，加集中验证首轮里到点的 3 个架构测试；30 秒时限）：49 个全过，合计 514 pass / 6 fail，包括
    `clarify-review-combination-scenarios`、`lifecycle-property`、`rfc294-architecture-preflight`（含 public surface 偏差清单逐条相等一例）与
    RFC-400 / RFC-395 的几个架构测试。余下 6 个文件各一例：导出里恒红的 `rfc321`（工作树结果见下）、RFC-376 报告「同一提交读两遍」（用例自带
    300 秒）、RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）、`rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`
    与 `rfc363` 目录分页（三例撞 30 秒；`rfc300` 那例到点后 afterEach 收走临时目录，仍在跑的用例体再报一条启动失败）。对照：同一时刻在与
    HEAD 逐字相同的导出仓库里跑后 5 个文件（两边各两路，负载 63 / 50 / 50）：两边逐文件相同——同一例失败、pass / fail 数相同、耗时相近
    （RFC-376 664.8 s 与 666.6 s，`approve` 6.75 s 与 6.97 s，`rfc300` 30.07 s 与 30.08 s，`rfc354` 30.8 s 与 31.0 s，`rfc363` 30.5 s 与
    30.7 s）。`rfc300` 走任务删除，再单独跑一次（180 秒时限）：2 / 2，删除那例 23.4 s。
  - 集中验证首轮（167 个文件：全部架构测试与改到、新增的用例，与全量同时跑）：1744 pass / 4 skip / 7 fail，7 例都是撞时限（上面复跑的范围内），
    新增的 RFC-476 用例 18 / 18。
- **导出仓库接 PostgreSQL 真库**（最终候选，30 秒时限，`RUN_GIT_NETWORK=1`、`RUN_CHAOS=1`）：清单 720 个文件（经用例 helper 的 import
  闭包取到改动的生产文件的 592 个用例、其余 123 个架构测试，与 5 个改到或按路径读改动文件的用例），其中 import 闭包能到 PostgreSQL 引擎
  选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量的 432 个文件都跑；其余 288 个文件不碰
  PostgreSQL，由 SQLite 覆盖。432 个文件里 395 个全过，合计 7465 pass / 78 fail / 4 skip（多路并行，与其他验证同时跑）。78 例里 61 例
  撞时限（31 例 30 秒默认、12 例 15 秒、10 例 20 秒、3 例 60 秒，用例自带的 4 / 8 / 10 / 16 / 24 秒各 1 例），12 例是钩子到点；余下
  5 例：`tasks` 两例是用例 helper 等仓库准备落定的 5 秒期限，RFC-167 `approve` 是用例自带 5 秒的 `settleTask`（读到 `running`），
  RFC-238 一例是 helper 等会话的 2 秒期限，`rfc370-m3-hosted-database-restore` 一例在库恢复里收到 Bun SQL 的
  `connection must be a PostgresSQLConnection`。对照：同一时刻在与 HEAD 逐字相同的导出仓库里跑这 37 个文件（两边各两路、各用两个库、
  同一顺序，负载 33～44）：36 个文件两边失败的用例逐一相同——15 个文件两边都全过（含 `rfc370-m3-hosted-database-restore`），21 个文件
  两边是同样的用例失败，失败分类两边逐项相同（时限、钩子到点，`tasks` 两例、RFC-167 `approve`、RFC-238 的会话期限与
  `scheduler-wrapper-scope-dependencies` 一例断言）；两边合计 572 pass / 54 fail 与 573 / 53。差的一例在 `scheduler.test`：
  `node runner failure halts task at that node [postgresql]`（用例自带 60 秒）本 RFC 一侧到点、对照一侧通过，两边耗时 69.7 s 与 71.8 s
  （报告的耗时含钩子，时限只计用例体）。这例让单节点的 mock 运行时以退出码 5 失败、默认重试后任务失败，不走删除与评审；同一文件的
  其余 42 例与它的 SQLite 一例两边都通过。同一时刻再跑一对 `scheduler.test`（两边各一路、各用一个库，负载 28～35）：两边都是 43 / 43，
  这例 56.4 s 与 60.8 s，lane 里同文件到点的另一例（`loop continuation policy does not swallow an inner failure [postgresql]`）77.0 s 与
  74.7 s 两边都通过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，候选导出，两引擎分开跑；这份导出不同时跑别的用例）：SQLite 17 个阶段全部符合预期
  （0 failures），前后 127 个受保护源文件的哈希一致、工作树干净。PostgreSQL 三次都停在第一阶段：变异前的正向运行先有几例撞 bun 默认 5 秒，
  随后整条命令撞脚本的整进程看门狗（300 秒，SIGTERM、exit 143），lane 判失败，变异阶段没有跑到；三次前后受保护源文件的哈希一致、工作树干净。
  第一次（负载 30.0 / 39.9 放行，随即 frontend gate 开跑）：RFC-359 T2a 问题派发 7.46 s、T7e 工作组反问许可 5.55 s 到点。同一时刻在候选导出
  与与 HEAD 逐字相同的导出仓库里各跑一次同一条正向命令（同一组用例、默认时限、不设看门狗，各用一个库，负载 61 / 55 / 55）：两边都是
  17 pass / 9 fail，失败的 9 例逐一相同（T1、T2b、P0-9 legacy mission 各两例，T2a、T2c `approve`、T7e 各一例；7 例撞 5 秒），耗时 784.8 s
  与 783.8 s——本机这个负载下正向运行本身就超过看门狗。第二次（frontend gate 跑完、负载 29.5 / 31.8 放行，PostgreSQL lane 四路仍在跑）：
  T2a 5.37 s、T1 5.64 s、T2b 5.77 s、T7e 两例 5.58 s 到点；第三次（PostgreSQL lane 与对照都跑完后，连续三次采样 1 分钟负载 < 28、5 分钟 < 34
  才放行，开跑时 40.1 / 33.8）：T2a 5.78 s、T1 5.88 s 到点。三次到点的用例都在上面同一时刻对照两边一起失败的范围内。PostgreSQL 一半的
  正向与变异阶段以 CI 的同一条 lane（`ci.yml` 的 RFC-359 P0 步骤，两引擎）为准。
- **其他包**（最终候选）：shared 209 个文件 2344 pass；system-mocks 30 秒时限 21 个文件 111 / 111 全过；frontend（`test:frontend:gate`）
  871 个文件 7361 pass。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **定稿后的复验**：`composition.ts` 一行注释改指直接构造（集中验证之后的改动），重新同步导出仓库后跑读它文本的三个守卫
  （`rfc328-architecture-guards`、`rfc359-w5-t19b-composition-placeholders-removed`、`architecture/rfc385-execution-generation-guard`）与
  RFC-476 用例：32 / 32。按 RFC-294 C13 收紧两项减速带、文档定稿后，导出仓库同步到 HEAD `e6ab732f5`（他人的纯文档提交）加候选、逐字核对后：
  减速带用例 `architecture/rfc376-structural-guards` 221 / 221（实测 `legacy-horizontal-files` 173、`legacy-service-implementations` 54，
  与新上限相等；仍低于上限的四项——`cross-context-internal-file-pairs` 43 / 48、`export-star-barrels` 1 / 21、`legacy-thin-facades` 0 / 42、
  `unreachable-production-files` 18 / 27——本 RFC 未触及，留给 S11）；文档用例（RFC 索引状态漂移、RFC-294 设计对齐与两个 review 守卫、
  docs-implementation-parity、test-suite-policy、stale-assertion 等 11 个文件，含 RFC-476 用例）接库 92 / 92（先跑的一轮没接库，
  `rfc128-p5-a-pre-refactor-net` 的 PostgreSQL 一半按设计「缺库即红」，其余 91 例通过）。
- **结构锁的覆盖范围**（RFC-294 C12）：RFC-476 用例里两个文件不在、零 import 与零路径字面量覆盖全仓（四个包的 src / tests / scripts、e2e、
  仓根脚本与 workflow），Markdown 链接覆盖 `design/` 与 `docs/`，`R1` 里没有它们按全仓 census；依赖方向锁只覆盖指定文件——task-execution
  的 `infrastructure/reviewMutationQueue.ts` 与 `infrastructure/taskDelete.ts`、collaboration 的 `infrastructure/reviewMutationLock.ts`、
  `review.ts` 与 `taskCollab.ts`、bootstrap 的 `daemonModules/taskExecution.ts` 与 `daemonApplication.ts`；public 收口锁覆盖 task-execution
  的 `public/participants` 与 `public/queries`。上下文值环、off-DAG 值对与 `backend-value-scc` 是既有的全仓闸门。
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，最终候选，HEAD → c476）：`R1-inbound-module-internals` 34 → 30、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 175 → 173、`legacy-service-implementations` 56 → 54
  （两个 `services/` 文件），其余 19 项闸门计数逐项不变（含 `context-value-sccs` 0、`context-value-pairs-off-dag` 0、
  `off-dag-offered-file-context-pairs` 55、`backend-value-scc` 0）；后端生产文件 3188 → 3191（新增五个、删两个）；跨 context import 记录
  7746 → 7733、模块符号归属 32253 → 32260、facade 56 → 54、变更入口清单 2348 → 2346（两个 `services/` 文件的三条换到 task-execution 的
  删除与队列文件，task-execution public 上终态维护认领的两条随撤出消失）；public surface 1505 → 1497（撤出 9 个：`public/participants` 的
  `ActiveTaskExecutionParticipant`、`TaskDeletionParticipant`、`createTaskDeletionParticipantInTx`、`TerminalMaintenanceStore`、
  `createTerminalMaintenanceStore`、`assertTerminalMaintenanceClaimTx`、`transitionTerminalMaintenanceClaimTx`，`public/queries` 的
  `TaskDeletionQueries`、`createTaskDeletionQueries`；新增 1 个：`taskReviewMutationQueue`）；偏差 94 → 91（挂在撤出的三个根上的三条），未被
  消费的 public 符号 322 不变；task-owned effect、authority 与 gateway 清单不变；模块级可变状态清单（`ambientWiring`）79 条逐条相同。
  收口时按 RFC-294 C13 把触及的两项减速带收紧到实测：`legacy-horizontal-files` max 381 → 173、`legacy-service-implementations`
  max 213 → 54（其余计数实测不变，不收紧）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 删除实现与原文件逐行比对：差异只有 import 改取定义处、终态维护 store 直接构造（即原 public 工厂的函数体）、事务里 collaboration 的一半改为
  `options.collaboration(tx)`（同一位置、同一事务）、文件末尾的转出删除；前置门、错误码与文案、事务边界、清理与广播逐字不变。bootstrap 与
  用例 helper 都交 collaboration 原来的 `createTaskDeletionCollaborationParticipantInTx`；两格都是必填，`tsc` 证明所有构造点都接上了。
- 队列与原文件逐行比对：两张进程内表、`reserveTaskReviewMutationSlot`、`withTaskReviewMutationLock`、`claimTaskQueueSlot`、`enterTaskQueue`
  逐字不变。`serializeAfterTaskLookup` 与原 `withReviewNodeMutationLock` 的后半同序：先在 lookup 上挂 `tracked` 并同步登记，再挂入队回调，于是
  lookup 解析后入队先于等它的 task 键入口继续；collaboration 适配器在同一个同步调用里发出 lookup 并交给队列，中间没有 await。找不到任务时
  `missing` 在同一个 `then` 回调里同步抛出 `NotFoundError('review-not-found', …)`，与原来同一个拒绝；lookup 自身的拒绝原样传出。闭合接口包一层
  `{ run: fn }` 不新增异步边界。
- public 收口：撤出的九个符号在 backend、shared、frontend、system-mocks、e2e 与脚本里都已无取用方（`rg` 复核，只剩替换注释）；
  `RecoverableTerminalMaintenanceClaim` 仍有消费方，保留。
- 用例与账本：e2e 注释里的行号改指 `deleteTask` 的 409 抛出处（原 `:76` 已过期）；`guard-manifest` 改动的三个登记守卫行数与文件一致；
  `scheduler-audit-s14` 的历史注释保留原路径（叙述来由）。

## PR / 提交

单个提交：`refactor(backend): RFC-476 任务删除与评审变更队列归 task-execution（RFC-294 W9-D 第二十三步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
