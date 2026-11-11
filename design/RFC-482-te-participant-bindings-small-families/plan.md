# RFC-482 实施计划

**前置**：RFC-481 落地（Done，`fdc78adf8`，Done 文档 `68086c6cd`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                             | 依据         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-482-T1 | `TaskExecutionParticipantBindings` 增五个工厂引用；task-execution 的 composition 转出它们；bootstrap 的绑定与用例 helper 补上                                                    | design §2    |
| RFC-482-T2 | collaboration 的 30 个调用点改用绑定，没有绑定的函数沿调用链接上；bootstrap 的五个装配点改收绑定                                                                                 | design §1–§2 |
| RFC-482-T3 | 指令存储直接交给指令路由操作适配器（命令上下文不再带它）；`createClarifyDirectiveStore` 改收实例；collaboration 的 `taskClarifyDirective.ts` 删除                                | design §2    |
| RFC-482-T4 | task-execution 持久化包增 `clarifyDirectives`，引擎两处端口改接；`CollaborationRuntimeMechanics` 去掉 `getNodeClarifyDirective`                                                  | design §2    |
| RFC-482-T5 | `reselectRunInTx` 与两处调用删除；`TaskRunSelectionReads` 声明并交出；task-execution 的 public 撤出六个符号                                                                      | design §2    |
| RFC-482-T6 | 新增 RFC-482 用例与行为用例；账本销账、`counts.json` 收紧、guard-manifest 登记；搜 `tests/` 与 `scripts/` 的文本断言随之改写；既有用例改取与补传绑定                             | design §3–§4 |
| RFC-482-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5    |

## 验收清单

- [x] AC-1 task-execution 的 public 不再导出六个符号；collaboration 改经绑定取五个工厂
- [x] AC-2 `reselectRunInTx` 不在；引擎的 clarify 指令读取不经 collaboration；collaboration 的 `taskClarifyDirective.ts` 不在
- [x] AC-3 `public-surface-deviations` 74 → 68 并收紧到实测；两个模块未消费符号仍为 0；跨 context 内部文件对与越 DAG 文件对不变
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-11，候选基于 `32b31b6a0`）

本机全程高负载（10 核；采样到的 1 分钟负载 38～92，主要是本机其他进程）。验证在候选导出仓库里跑（HEAD 的树加候选路径，提交后运行；修复后
重新同步，核对与 HEAD 加候选逐字相同）；对照导出仓库与 HEAD 相同（`32b31b6a0` 只改文档）。验证期间 `origin/main` 未前进。集中验证查出
本 RFC 的三类问题，均已修复并复验：

1. **组合根守卫回升**：指令存储起初做成命令上下文的可选能力，`rfc359-w5-t19b-composition-root-complete` 报「not composed」兜底 5 → 6
   （只降不升）。改为由 bootstrap 用绑定造好、直接交给指令路由操作适配器（design §6）。
2. **撤出的连锁**：表读取器工厂撤出后，只经它的返回类型可达的 `ShardSetView` 成为未消费符号（架构报告
   `unconsumed-public-symbols-task-execution` 0 → 1），随之撤出（design §6）。
3. **`tsc` 看不到的文本与哈希账本**：首批读源码的用例（`tests/architecture/` 全部加读 `src/` 文本的用例，154 个文件）查出
   `rfc395-selection-semantics-ledger` 的三条站点、`rfc395-serialized-insert-source-locks` 里 `seal.ts` 的 sha256、`rfc395-clarify-answer-boundary`、
   `rfc359-t7e` 与 RFC-442 用例；全量又查出 8 个文件（design §6 末条），改后连同 RFC-482 用例 9 个文件复跑全过。之后用字面量扫描对 HEAD
   与候选比了一遍（`tests/`、`scripts/` 与账本 JSON 的字符串、模板片段和正则，只比用例实际读的文件）：53 个文件有命中，逐条核对后余下的
   都是模块名一类的通用词或本 RFC 新写的断言；`rfc341` 的 guard-manifest 行数随之刷新。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 121 个 TS 文件），promises 规则集对改动的
  43 个源码文件无告警；改动的 TS、两个 fixture JSON 与 RFC-482 三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；
  `docs/dev-gotchas.md`、`STATE.md` 与 RFC-294 plan 不跑 prettier）。
- **RFC-482 用例**：默认 5 秒、`--randomize` 下全过（PostgreSQL lane 里两种 provider 同进程 10 / 10）；对 HEAD 的代码 9 条红 8 条（只判
  fixture 的负对照两边都绿）。
- **全量 SQLite**（导出仓库逐文件跑：每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  6 个 worker）：2,932 个文件里 2,911 个通过。失败的 21 个：
  - 8 个是上面第 3 处；
  - `rfc321-repository-publication-ratchet`：导出仓库没有真实历史，`merge-base --is-ancestor` 找不到发布账本记录的提交；对照同样失败，本 RFC
    不碰这本账；
  - 其余 12 个撞的都是用例自带的时限或内部等待。在导出仓库另存只放宽时限常量的副本跑完：`architecture/rfc376-report` 16 / 16、
    `architecture/rfc400-collaboration-task-participants` 6 / 6、`clarify-review-combination-scenarios` 18 / 18、`lifecycle-property` 3 / 3、
    `rfc167-dynamic-workflow-engine` 29 / 29、`rfc321-repository-publication-system-mock-e2e` 1 / 1、`rfc354-nested-frames-closure` 1 / 1、
    `rfc354-nested-loop-frames` 1 / 1、`rfc395-v1-source-evidence` 23 / 23、`rfc395-v1-source-readers` 8 / 8、`rfc395-v3-old-epoch-unpack` 4 / 4；
    `rfc363-task-workspace-process-recovery` 把检查点等待放宽到 300 秒仍有两条等不到——父进程只靠 `fs.watch` 的事件发现 worker 写下的
    `ready.json`，本机 fseventsd 忙时事件丢失，副本给等待加 250 毫秒的轮询兜底后 8 / 8（每条 4～10 秒，`docs/dev-gotchas.md` 补一条）。
    `rfc294-architecture-preflight` 在全量里 14 / 14（偏差账本 20 秒、capability 账本 138 秒）。
- **PostgreSQL**：本 RFC 不改 SQL 与持久化；以 CI 的双引擎分片为证据。另把文档对账与读 guard-manifest 的 16 个、本 RFC 改写或新增的、用到改动
  helper 的与改动调用链上的用例共 70 个文件接 PostgreSQL 跑（两种 provider 同进程、`--randomize`、单条 60 秒，4 个 worker）：1,198 条通过、
  12 条失败（PostgreSQL 一侧通过 444 条），64 个文件一次全过。失败的 6 个文件：3 个 rfc317 守卫账本用例是导出仓库里还放着上面那批只放宽
  时限的副本，被守卫普查当成未登记的守卫（删去副本后在最终候选上重跑，见下）；`review-detail-render-rfc158`、`rfc395-gate-open-v2`、
  `scheduler-clarify-dispatch` 的 PostgreSQL 一侧撞 20 秒的用例时限或 30 秒的清库钩子（`scheduler-clarify-dispatch` 另有两处报错是超时后
  正文继续跑、撞上清库的连带），只放宽用例时限的副本单独跑：6 / 6、25 / 25、16 / 16（rfc158 的 R2b 在 PostgreSQL 上跑了 104 秒）。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选的提交 vs HEAD 的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等，门里只有
  `public-surface-deviations` 74 → 68 一项变化（这一对 28 → 22）；public surface task-execution 239 → 233、collaboration 40 不变；未消费 91 不变
  （两个模块为 0）；跨 context import 7,678 → 7,671：撤掉 19 条（collaboration 取 task-execution public 工厂的 15 条、随死代码删除的
  `platform/contracts/taskArchive` 1 条、`persistenceDb` 类型 3 条），新增 12 条（collaboration 取 task-execution `public/participants` 与
  `public/types` 的类型 6 条，在目标 DAG 内；bootstrap 取 task-execution composition 5 条、collaboration composition 1 条）；mutation 入口
  2,336 → 2,332（转发文件的两个写函数与两处死代码）；越 DAG 的 offered 文件对 47、跨 context 内部文件对 43 不变。
- **最终候选**（导出仓库与 HEAD 加 131 个候选路径逐字相同，临时副本已删）：文档对账与读 guard-manifest 的 16 个用例 167 条全过（两种
  provider 同进程、默认 5 秒、`--randomize`，含上面那 3 个 rfc317 用例）；架构报告重出一遍，60 项实测 = `max`，门里仍只有偏差一项变化。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS：

- 五个工厂：bootstrap 交给绑定的与此前 `public/participants`、`public/queries` 转出的是同一个函数；每个调用点仍用原来的句柄构造（事务里的
  仍是事务句柄，`seal.ts` 的人工门参与者与 stop 指令写入都用 seal 事务的 `tx`），没有在装配期预绑实例。
- `reselectRunInTx`：原实现不读不写、返回空数组，评审决定的两处调用只丢弃返回值；删除后行为不变。
- 引擎读指令：此前经 collaboration 的运行时机制调 `getNodeClarifyDirective(db, taskId, nodeId, undefined)`（bootstrap 交给它的根 db）；改后
  调持久化包的 `clarifyDirectives.get(taskId, node.id)`，同一个根 db、同一个方法、同样不带 shardKey。跨澄清节点的短路读取同理。
- collaboration 侧：跨节点停问判定、反问抑制判定、指令路由操作与 seal 写入，改经绑定构造的指令持久化，句柄、方法与参数次序都与转发文件
  原来的实现相同；指令路由操作的存储仍建在根 db 上（此前由命令上下文用同一个 db 构造）。
- 账本：`counts.json` 60 项，`reason` 都含与 `max` 相同的 `max=N`；`PUBLIC_SURFACE_DEBT` 销 6 条，按 preflight 的语料核对精确相等；
  guard-manifest 新增一条的字段取自 census 的实测，改到的几条只刷新行数。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-482 collaboration 取 task-execution 的事务参与者与三个小查询改经装配期绑定（RFC-294 S9 第三步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
