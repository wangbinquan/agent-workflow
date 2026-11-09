# RFC-473 实施计划

**前置**：RFC-472 落地（`15af9f024`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                         | 依据          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| RFC-473-T1 | 结果投影迁为 `infrastructure/executionOutcome.ts`（含 `ExecutionOutcome`），三处 composition 改取；`types.ts` 删除                                           | design §1–2   |
| RFC-473-T2 | 资源会话迁为 `infrastructure/taskExecutionResources.ts`、去掉转出，模块内外消费方改取定义处或 `public/commands`                                              | design §3     |
| RFC-473-T3 | public 收回失去模块外消费方的转出（按迁移后的架构报告实测）                                                                                                  | design §4     |
| RFC-473-T4 | 用例改路径；公共内核清单、EK-07 锚点、选择语义账本、路径锁、负对照样例、owner 表、workflow 路径过滤与注释随迁；新增 RFC-473 用例；`R1` 账本与 guard-manifest | design §6、§8 |
| RFC-473-T5 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                 | design §8     |
| RFC-473-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                                              | —             |

## 验收清单

- [x] AC-1 三个旧文件不在、零引用；新位置函数体逐字相同；`server.ts` 与 `services/task.ts` 的两个类型取自 task-execution public
- [x] AC-2 架构计数按实测（`R1` 53 → 49），越界类计数、public surface 偏差与未被消费的 public 符号不升
- [x] AC-3 受影响用例与新增用例全部通过（四个包）
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-08，候选基于 `4a6878673`）

本机全程高负载（采样到的负载 35～100；本机另有常驻负载：一个本地虚拟机与三个挂起的测试夹具进程）。验证都在候选导出仓库里跑（HEAD 的
`git archive` 加候选路径，提交后运行；文档改动后重新同步，核对与 HEAD 加候选逐字相同）。集中验证没有查出本 RFC 的问题。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件，加 `eslint.promises.config.js`
  覆盖的 src 文件）；`depcheck` 分层门通过（4423 个模块）；改动的 TS、JSON、workflow 与 RFC-473 三件套 prettier 检查通过。
- **声明逐个比对**：见实现门。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 3 小时）：四片 7788 / 6745 / 7651 / 7040 s 全部跑完，合计 23562 pass /
  127 skip / 82 fail，另有 46 条测试间未处理错误（都在有失败的文件里，是超时用例残留的异步收尾）。82 条 fail 里 79 条是超时：69 条撞默认 5 秒、
  6 条撞 30 秒、2 条撞 20 秒、1 条撞 40 秒、`rfc376-report` 撞 300 秒；余下 3 条：导出仓库只有候选提交所致的 `rfc321` 发布账本、
  `rfc354-nested-failure-modes` 一例（同文件前一例撞 30 秒后，它残留的 `drive` 收尾删掉了下一例正在用的场景环境变量，假 opencode 报
  `SCENARIO_PLAN_FILE and SCENARIO_STATE_DIR required`），以及 `rfc310-digital-employee-system-mock-e2e` 一例连 system-mock 控制端口遇 `ECONNRESET`。
  - 复跑 183 个文件（全量里失败的 39 个文件、全部 139 个架构测试、改到的 13 个用例与新增的 RFC-473 用例；30 秒时限）：178 个全过（含新增的 RFC-473 用例、改到的用例与全部 139 个架构测试），合计 1747 pass / 5 fail /
    4 skip（与 PostgreSQL lane、各包同时跑，负载 35～50），余下 5 个文件各一例：导出里恒红的 `rfc321` 发布账本（工作树结果见下）、RFC-167
    dw-confirm 的 `approve`（自带 5 秒 `settleTask`），以及撞用例自带 30 秒时限的 `rfc300` Webhook 工作区清理 e2e、`rfc363` 目录分页与
    `rfc354-nested-frames-closure`。对照：同一时刻在 RFC-472 的导出仓库（树与 `4a6878673` 逐字相同）里跑同一文件（负载 42～48）：`rfc167`
    两边都是 28 pass / 1 fail、同一例到点（6.32 s 与 6.09 s）；`rfc354` 两边都过；`rfc300` 与 `rfc363` 第一对本 RFC 一侧到点（30.03 s、
    30.44 s）、对照一侧擦线通过（29.67 s、28.43 s），再跑一对两边同一例到点（30.03 s 与 30.04 s、30.69 s 与 30.74 s）——这两个 30 秒是用例
    自己设的（`setDefaultTimeout(30_000)` 与单例 `30_000`），放宽命令行时限不改变它们。
- **导出仓库接 PostgreSQL 真库**（30 秒时限）：清单 493 个文件（经用例 helper 的 import 闭包取到改动的生产文件的 365 个用例、全部 139 个架构测试
  与改到的用例），其中 import 闭包能到 PostgreSQL 引擎选择（`tests/helpers/eachProvider.ts` 与三个 PostgreSQL harness）或直接读 URL 环境变量的
  197 个文件都跑；其余 296 个文件不碰 PostgreSQL，由 SQLite 覆盖。另跑 import 闭包取到改动的用例 helper、却不在这份清单里的 27 个用例（都能到
  PostgreSQL 引擎选择；单路，单独一个库）。主清单 197 个文件里 187 个全过，合计 3092 pass / 31 fail / 4 skip（三路并行，与 SQLite 复跑、各包同时跑，负载 35～78）；
  另跑的 27 个里 26 个全过（379 pass / 2 fail）。余下 11 个文件 33 例都是撞时限：用例自带的计时到点（`lifecycle-property` 3 例 15 秒、
  `rfc359-w9-retry-rollback-parity` 1 例 10 秒、`scheduler-audit-s04-git-wrapper-cumulative-diff` 2 例与 `scheduler-audit-s17-readonly-starved-by-writer-queue`
  1 例 20 秒、`scheduler-clarify-inline` 3 例与 `scheduler-rfc040-wrapper-await` 4 例 15 秒、`scheduler-default-retries` 4 例 4～24 秒、
  `scheduler-wrapper-scope-dependencies` 8 例 30 秒、`rfc310-digital-employee-system-mock-e2e` 的 `[postgresql]` 半边 2 例 180 秒、RFC-167
  `approve` 自带 5 秒 `settleTask`），以及 `rfc359-w26-workgroup-empty-scan` 4 例撞 30 秒。对照：同一时刻在 RFC-472 的导出仓库（树与
  `4a6878673` 逐字相同）里逐个跑这 11 个文件（每对两边各用一个库，负载 37～79）：`lifecycle-property`、`rfc167`、`rfc359-w9`、`s04`、
  `clarify-inline`、`default-retries`、`rfc040` 两边失败的用例逐一相同（依次 3 / 1 / 1 / 2 / 1 / 1 / 2 例）；`rfc359-w26` 与
  `scheduler-wrapper-scope-dependencies` 两边都全过（14 / 14、18 / 18）；`s17` 第一对对照一侧到点、本 RFC 一侧通过，120 秒时限再跑一对两边
  同样 0 / 2、同一用例；`rfc310` 的两个 `[postgresql]` 用例两边都在 173～181 秒之间、擦着用例自带的 180 秒——第一对两边都到点，第二对对照
  一侧都过（176.6 s、173.2 s）、本 RFC 一侧一过一到点（172.7 s、180.7 s），只跑 PostgreSQL 半边的第三对（本 RFC 一侧用同一份候选的干净
  克隆，因为 P0 正占用导出仓库）两边又都到点（180.7 s / 180.7 s 与 180.8 s / 180.4 s）。该文件的 `[sqlite]` 半边在本 RFC 一侧两次各有一例
  连 system-mock 控制端口遇 `ECONNRESET`（种子数据阶段，在被测代码之前），30 秒 SQLite 复跑里全过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，同一份导出仓库，等上面两条 lane 跑完后两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 29.8 / 39.9 才放行，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件的哈希一致、
  导出仓库工作树干净。
- **其他包**：shared 209 个文件 2344 pass；frontend（`test:frontend:gate`）871 个文件 7361 pass；system-mocks 30 秒时限 21 个文件
  111 / 111 全过。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等，加 RFC-473 用例）：12 个文件全过（101 pass；导出仓库与 HEAD 加候选逐字相同）。
- **计数复核**（`scripts/architecture-report.ts` 在导出仓库的提交上采数，c472 → c473）：`R1-inbound-module-internals` 53 → 49、
  `R2-outbound-module-to-legacy` 0 → 0（账本与实测逐条相等）；`legacy-horizontal-files` 180 → 177、`legacy-service-implementations` 61 → 58、
  后端生产文件 3182 → 3181（删三个、新增两个）；跨 context import 记录 7788 → 7769（三个旧文件自身的 23 条与模块内取它们的 11 条消失；新增两个
  新文件取 legacy 的 6 条与取 resource-catalog public 的 7 条，`server.ts` 与 `services/task.ts` 取 `public/commands` 的 2 条）、模块符号归属
  32235 → 32231、mutation 入口 2348 → 2347（零消费的 `StartExecutionRequest` 随 `types.ts` 删除）、public surface 1494 → 1493（`workgroupLaunchMode`）；
  偏差 94、未被消费的 public 符号 322 逐条相等；跨 context 内部文件对 43、off-DAG offered 文件对 55、不可达生产文件 18、`module-layer-violations` 1、
  `composition-forbidden-import-files` 14、off-DAG 值边 0、平台 → 模块 0 不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（`4a6878673` 对工作树，脚本逐字比对）：两个新文件除 import 块与头注释外与旧文件逐字相同，`ExecutionOutcome` 的注释与类型体
  与 `types.ts` 里的逐字相同；资源会话文件只少了四个转出与它们的注释；十二个改到的生产文件只改了 import 来源（`public/queries` 只少
  `workgroupLaunchMode` 一个转出名）。
- 行为：三处投影调用方取到的是同一个函数（同一个读模型、同一个种类分派与警告），资源会话是同一个快照事务与同一组注入解析；`server.ts` 与
  `services/task.ts` 取的 `public/commands` 类型就是 `application/ports` 里那一个声明；删掉的 `types.ts` 只有类型，`StartExecutionRequest`
  （架构报告记作一个 mutation 入口）与另两个类型全仓零消费。
- 用例：17 个用例 / helper 只改 import 路径（逐个名字指向定义处），断言不动；路径锁、选择语义账本与公共内核清单只改路径；`rfc405` 负对照的
  legacy 样例换成仍在的 `triggerPreflight`（判据按 `services/` 前缀，不变）；EK-07 的锚点改指新文件里同一段代码。
- 账本：`R1` 53 → 49（实测与账本逐条相等，`R2` 0）；public surface 1494 → 1493（`workgroupLaunchMode`）；偏差 94、未被消费的 public 符号 322
  逐条相等；guard-manifest 只刷新 `rfc395-task-definition-boundary` 的登记行数（625 → 628，其余登记的守卫文件行数未变）。

## PR / 提交

单个提交：`refactor(backend): RFC-473 执行结果投影与资源会话归 task-execution：services/execution 的三个文件迁入（RFC-294 W9-D 第二十步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
