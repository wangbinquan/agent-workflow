# RFC-480 实施计划

**前置**：RFC-479 落地（Done，`0d591604b` / `673b1b53b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                       | 依据         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-480-T1 | 136 个转出撤掉；经 public 取用它们的本模块文件与用例改取定义处（codemod，按符号解析定义处）                                                                | design §1    |
| RFC-480-T2 | 直接声明在 public 的：31 个无使用方的删除；38 个有使用方的按内容挪进模块内部（落位表），使用方改取新位置                                                   | design §1–§2 |
| RFC-480-T3 | task-execution `public/operations` 退役：三处模块外使用改取平台定义处 / `public/types` / composition，文件删除                                             | design §3    |
| RFC-480-T4 | 撤出 → 复采 → 再撤，迭代到两个模块的未消费计数为 0                                                                                                         | design §1    |
| RFC-480-T5 | 未消费符号按 context 分项入带（`publicContractGateSets`、`counts.json`、报告与 RFC-479 用例的口径断言）                                                    | design §4    |
| RFC-480-T6 | 新增 RFC-480 用例；用例改指；guard-manifest 与减速带收紧                                                                                                   | design §5    |
| RFC-480-T7 | 集中验证（静态、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §8    |

## 验收清单

- [x] AC-1 两个模块的未消费 public 符号为 0；声明按内容落位
- [x] AC-2 task-execution `public/operations.ts` 不在、零引用；三处使用改取新位置
- [x] AC-3 未消费符号按 context 分项入带，上限 = 实测，两个模块为 0
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`bb7da0e8d` 的两处缺陷由 `489526d4a` 修复，见 CI 一节）

## 集中验证（2026-11-10，候选基于 `71202c92a`）

本机全程高负载（10 核；一台外部 VM 约 3.8 核、fseventsd 约 1.1 核、三个残留的 `mock-mcp-stdio` 进程约 1.7 核；采样到的 1 分钟负载
31～57）。验证在候选导出仓库里跑（HEAD 的树加候选路径，提交后运行；修复后重新同步，核对与 HEAD 加候选逐字相同）；对照导出仓库是 HEAD
`71202c92a`。验证期间 `origin/main` 未前进。集中验证查出本 RFC 的 五 处问题，都已修复并复验：

1. **偏差账本误删一条**：判定 `PUBLIC_SURFACE_DEBT` 哪些条目失效时，用的语料少了 shared 包，把 `AgentInvocationProtocol` 的 `MappedType`
   一条误删；按 preflight 的同一份语料（`typeResolutionCorpus()`）重算后恢复，`public-surface-deviations` 的上限是 77（不是 76）。
2. **一个生产文件变得不可达**：`createProcessEffectAttemptObserver` 别名撤出后，`composition/processEffectObserver.ts` 只剩两个用例在用，
   `unreachable-production-files` 18 → 19；按 design §1 挪到 `tests/helpers/localProcessEffectObserver.ts`，Windows workflow 的路径过滤随之
   改指，计数回到 18。
3. **别的 RFC 用例里断言源码文本的账本随撤出失效**（`tsc` 看不到；全量里都在 1 秒内失败，与负载无关）：`rfc345-workgroup-turns-provider-neutral`、`rfc349-provider-cutover`、`rfc359-converged-twins`、
   `rfc473-execution-outcome-and-resource-sessions`、`rfc317-module-boundary`、`rfc310-digital-employee-os-architecture`、
   `rfc333-human-gate-source-locks` 七个文件，改法见 design §5。
4. **报告判据修正缺回归用例**：§2 末段那处类型形状遍历的修正原先只有真实语料上的计数；补了 fixture 回归（RFC-480 用例 ⑥），对修正前的报告
   代码跑红（五种形式各漏一个类型），修正后绿。
5. fixture 的说明里写错了读它的用例文件名，已改。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 TS 文件）；改动的 TS 与 RFC-480 三件套
  prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；`docs/dev-gotchas.md`、`STATE.md` 与 RFC-294 plan 不跑 prettier）。
- **全量 SQLite**（导出仓库，`bun run test:backend`：4 分片、`--isolate --randomize`、默认 5 秒、`AW_TEST_PROVIDERS=sqlite`；默认 15 分钟分片
  时限下第一次 4 片都被杀，第二次放到 3 小时、无输出 15 分钟）：分片 1（5,730 pass / 15 fail）与分片 3（6,381 pass / 41 fail）跑完；分片 2
  在一个 189 秒的架构用例之后 15 分钟无输出被杀，分片 4 撞 3 小时上限。1 秒内失败的就是上面第 3 处；其余是负载下的超时，以及超时后拆掉
  夹具引起的 `Unhandled error between tests`（库已关闭、临时目录已删）。
- **成对复跑归因**（只为归因放宽到 60 秒，每边 3 个 worker）：全量里有失败或输出的 69 个文件在候选与对照上各跑一遍，两边失败的是同样 12 个
  文件，逐条失败形态相同——超时；`rfc167` 同一行同一断言；`rfc363` 两边各 5 条在 30 秒内部等待后报 `checkpoint was not reached`；
  `daemon-start` 约 10 秒的内部等待（对照多 2 条）——不归本 RFC。
- **补跑没跑到的**：按 bun 的分片规则（路径排序后第 i 个文件进第 `i mod 4 + 1` 片，先用四片日志里的失败文件核对规则）重建分片 2、4 的文件
  清单，去掉上面两组后 1,430 个文件在候选上跑（60 秒，4 个 worker）：1,426 个通过；失败的 4 个里 3 个是上面第 3 处
  （`rfc317-module-boundary`、`rfc310`、`rfc333`），`epoch1-permission-text-backup` 的同一条用例在候选与对照上都撞 60 秒超时，不归本 RFC。
- **默认预算**：新增的 RFC-480 用例与改写的用例按 CI 的跑法（默认 5 秒、`--randomize`）单独跑过；RFC-480 用例里扫全量源码的那条有显式 60 秒
  预算（负载 30～40 时 5.8 秒）。
- **PostgreSQL**：本 RFC 不改 SQL 与持久化，改到的双引擎用例只改 import；以 CI 的双引擎分片（两种 provider 同进程）为证据。文档用例与本阶段
  改写的用例在最终候选上接 PostgreSQL 跑（两种 provider 同进程、默认 5 秒、`--randomize`）：文档对账 12 个、本阶段改写或新增的
  8 个、读 guard-manifest 的 3 个与计数门，共 24 个文件 482 pass / 0 fail。
- **架构报告**（`scripts/architecture-report.ts --gates`，最终候选的提交 vs HEAD 的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等；
  public surface 里 task-execution 450 → 232、collaboration 90 → 61，其他 context 的 937 个条目逐个相同；偏差 88 → 77；未消费 322 → 91
  （两个模块为 0，其他 context 117 → 91 来自遍历修正）；跨 context import 7,678 → 7,679：5 条随三处模块外使用与事件 ref 改指，多出的 1 条是
  挪进 `application/ports/workgroupTurnsOperations.ts` 的类型取 `@/platform/runSelectionProjection`（`public/commands` 保留的类型取的同一个）；
  mutation 入口 2,347 → 2,336（collaboration 4 个用例函数换了位置，`composition/processEffectObserver.ts` 的 1 个挪到 tests/helpers，10 个
  `export const X = XInternal` 别名撤掉）；事务内外部效应与 task-execution 执行权两节只差行号。

## CI（AC-4）

- `bb7da0e8d` 主 CI run 42958471515：70 个 job 里 3 个未通过（其余 push workflow：windows-platform、integration-opencode、
  maintenance-soak-nightly 全绿）。2 个是本 RFC 的缺陷，本地集中验证漏掉了，在下一个提交修复：
  1. `rfc294-architecture-preflight` 的「module capability ownership cannot be structurally forged or serialized」：`WorkerIdentity` /
     `OwnedTaskTx`（连同 brand）挪进 `domain/ownership.ts` 后，`capabilityForgeViolations` 只认声明在 `public/participants`（与 RFC-363 的
     两处私有端口）里的 capability owner，两个工厂被当成 owner 外的伪造，账本多出 4 条。本地这条用例在全量与成对复跑里候选、对照两边都超时
     （负载下超过 180 秒预算），没有拿到结果，被当成「两边一样」归给了负载。修法照 RFC-363 的先例在 owner 登记里写明这个私有 owner 文件，
     brand、readonly、唯一工厂、冻结与私有登记表规则照旧作用；加 fixture（合规时为空、去掉 brand 仍报、同样的声明与工厂放到别的 domain 文件
     仍报 owner 外工厂）。
  2. real-PostgreSQL lane 的「Verify RFC-359 original P0 mutations on both databases」：p0-8 的证据要求栈帧落在
     `collaboration/public/commands.ts`，三个命令入口已进了 `application/commandEntries.ts`。`scripts/rfc359-p0-mutations.ts` 的三条栈帧正则
     与指纹清单改指，`rfc359-w14-p0-mutation-verdict` 的历史转录与「换成无关路径必拒」的负对照随之改指。这个脚本只在 real-PostgreSQL 那个
     job 里跑，本地集中验证没有覆盖。
- 第三个是 Playwright e2e（windows-latest shard 2/4）被 20 分钟的 job 时限取消：同一 run 里另三片 Windows 装依赖 30～43 秒，这一片 10 分 46 秒
  （上一个 run 同一片 36 秒），被取消前跑到的 e2e 用例都通过——不归本 RFC，没有为它重跑。
- 修复的本地复验：capability 判据在 preflight 的同一份语料上与账本逐条相等（18 / 18）；preflight 的 scanner contract 与 capability 两组、
  P0 判决用例共 22 条在导出仓库通过（默认 5 秒、`--randomize`；capability 那条负载下 172.6 秒，预算 180 秒）；P0 变异门本地接库跑两种
  provider：sqlite 的 17 个阶段全部有效（含 p0-8）；PostgreSQL 一半在本机负载下第一个阶段（不带变异的 current-before）就撞
  脚本的 300 秒阶段时限（CI 上 32 秒），本机放不下，以修复提交的 CI 为证据。
- `489526d4a`：主 CI run 42965912792 的 70 个 job 全部通过（「CI required」绿）；该提交只改用例、脚本与文档，没有命中其余 push workflow 的路径过滤，同一 SHA 只有主 CI 一个 run。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 Done 文档文件）的导出仓库上重跑文档用例（接 PostgreSQL、默认 5 秒、`--randomize`）：13 个文件 111 / 111。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 挪走的 49 个声明与原文逐字一致（逐个比对声明文本，只差 import 路径）；两个被删的声明，使用方改取的 engine / domain 自有定义与原声明结构同构
  （`WrapperScopeReadModel`）或就是它包的那个函数（`wrapperInnerDescendants`）。
- 三处模块外使用：collaboration review 取的 `assertNodeRunSourceTerminationAdmission`、integration 取的 `TerminalWorkspacePrunePolicy`、
  bootstrap 取的 `registerTerminalWorkspacePrunePolicy`，与此前经 `public/operations` 取到的是同一个实现（同一个定义、同一个注册表）。
- 其余删除的声明撤出前全仓零使用方；撤出的转出只改了取用路径，定义未动。
- 报告判据：`collectTypeShape` 只多记引用，不改字段与形状统计；分项计数与报告章节同一个函数、同一份 inventory（`rfc376-report` 逐 context
  断言相等），新 context 会以 `missing count` 报出。
- 账本：`counts.json` 60 项，`reason` 都含与 `max` 相同的 `max=N`；`PUBLIC_SURFACE_DEBT` 删 12 条、加 1 条，按 preflight 的语料核对精确相等；
  guard-manifest 新增一条的字段取自 census 的实测，改到的几条只刷新行数。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-480 task-execution 与 collaboration 的 public 收口——未消费符号清零、public/operations 退役（RFC-294 S9 第一步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
