# RFC-481 实施计划

**前置**：RFC-480 落地（Done，`bb7da0e8d` + `489526d4a`，Done 文档 `c28b1a8d8`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现
与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                             | 依据         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-481-T1 | `PreparedHumanGateRef` 与两个端口（连同输入输出类型）挪进 task-execution，从 `public/types` 交出；collaboration 改取，删除自己的两个端口文件                                     | design §2    |
| RFC-481-T2 | task-execution 路由依赖删去 `collaboration` 字段；bootstrap 直接持有协作上下文                                                                                                   | design §2    |
| RFC-481-T3 | 两个帧函数的回调参数改为闭合接口；collaboration 的使用处随之改                                                                                                                   | design §2    |
| RFC-481-T4 | collaboration 的删除参与者工厂改由 `composition.ts` 交给 bootstrap，撤出 public                                                                                                  | design §2    |
| RFC-481-T5 | 新增 RFC-481 用例；两本账销账、`counts.json` 收紧、guard-manifest 登记；搜 `tests/` 与 `scripts/` 的文本断言随之改写                                                             | design §3–§4 |
| RFC-481-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane 按受影响范围、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5    |

## 验收清单

- [x] AC-1 task-execution 不取 collaboration 的 public（只剩 required-SPI 车道一条）；越 DAG 的 8 条销账
- [x] AC-2 三组端口类型声明在 task-execution，collaboration 改取，collaboration 的 public 不再交出
- [x] AC-3 两个开放类型与 collaboration 的一条类型污染销账；两项减速带收紧到实测；两个模块未消费符号仍为 0
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`fdc78adf8`，见 CI 一节）

## 集中验证（2026-11-11，候选基于 `ae835a25d`）

本机全程高负载（10 核；一台外部 VM 约 3.9 核、fseventsd 约 1 核、三个残留的 bun 进程约 2 核；采样到的 1 分钟负载 37～80）。验证在候选
导出仓库里跑（HEAD 的树加候选路径，提交后运行；修复后重新同步，核对与 HEAD 加候选逐字相同）；对照导出仓库的代码与 HEAD 相同（`c28b1a8d8`
的树，`ae835a25d` 只改文档）。验证期间 `origin/main` 未前进。集中验证查出本 RFC 的一处问题，已修复并复验：

1. **结构门的逐条基线漏改**：越 DAG 边除了 `counts.json` 与 `OFF_DAG_OFFERED_EDGE_DEBT`，还逐条登记在 `rfc376-structural-guards` 的
   committed baselines（`KNOWN`）里，销账时只改了前两处，`KNOWN` 留下 8 条 stale（全量里 6 毫秒就红）。删去后整个文件 221 / 221 通过；
   design §3 补上这一处，`docs/dev-gotchas.md` 的减速带一节补一条。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 52 个 TS 文件）；改动的 TS 与 RFC-481
  三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；`docs/dev-gotchas.md`、`STATE.md` 与 RFC-294 plan 不跑 prettier）。
- **RFC-481 用例**：默认 5 秒、`--randomize` 下 10 / 10；对 HEAD 的代码 8 / 10 红（只判 fixture 的两条负对照两边都绿）。
- **全量 SQLite**（导出仓库逐文件跑：每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  6 个 worker）：2,931 个文件里 2,913 个通过。失败的 18 个：
  - 1 个是上面第 1 处；
  - `rfc321-repository-publication-ratchet`：导出仓库没有真实历史，`merge-base --is-ancestor` 找不到发布账本记录的提交；对照同样失败。在
    真实仓库上直接算这条判据通过（记录的 `f11a46d28` 是 HEAD 的祖先），本 RFC 不碰这本账；
  - 其余 16 个撞的都是用例自带的时限（25～300 秒）或内部等待（检查点 30 秒、worker 45 秒、任务收敛 5 秒、流程 20 秒）。按「两边都超时
    等于没跑」拿候选的真结果：单独再跑一遍，`rfc363-preparation-process-recovery`、`rfc321-repository-publication-system-mock-e2e`、
    `rfc395-v3-content-inventory` 通过；仍撞时限的在导出仓库另存一份只放宽时限常量的副本跑完——`rfc354-nested-frames-closure` 1 / 1、
    `clarify-review-combination-scenarios` 18 / 18、`rfc167-dynamic-workflow-engine` 29 / 29、`rfc300-webhook-workspace-cleanup-e2e` 2 / 2、
    `rfc363-workspace-content` 4 / 4、`rfc363-task-workspace-process-recovery` 8 / 8、`rfc395-v3-old-epoch-unpack` 4 / 4、
    `rfc395-v1-source-readers` 8 / 8、`rfc395-v1-source-evidence` 23 / 23、`architecture/rfc376-report` 16 / 16、
    `architecture/rfc400-collaboration-task-participants` 6 / 6、`rfc370-committed-architecture-source` 2 / 2；`rfc294-architecture-preflight` 的两条（偏差账本 60 秒、capability 账本 180 秒）在
    preflight 的同一份语料上直接调同一个判据函数：偏差 74 = 74、capability 18 = 18（顺序一致），其余 12 条通过。
- **PostgreSQL**：本 RFC 不改 SQL 与持久化；以 CI 的双引擎分片为证据。最终候选上另把文档对账 13 个、本 RFC 改写或新增的 17 个、用到改动
  helper 的 16 个与读 guard-manifest 的 3 个用例接 PostgreSQL 跑（两种 provider 同进程、`--randomize`、单条 60 秒，4 个 worker）：48 个文件
  1,010 条通过、0 失败（PostgreSQL 一侧 352 条）。45 个文件一次通过；`single-nonroot-member-workspace` 被单文件 25 分钟的上限截断（截断前
  184 条全过），单独跑完 226 / 226；`rfc359-w14-legacy-mission-execution` 的 PostgreSQL 一条撞 25 秒内部等待，单独重跑 4 / 4；
  `rfc359-w9-retry-rollback-parity` 的 PostgreSQL「kind 矩阵」一条两次撞文件的 10 秒预算，放宽预算的副本 26 / 26（那条 62 秒）。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选的提交 vs HEAD 的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等，门里只有
  `off-dag-offered-file-context-pairs` 55 → 47 与 `public-surface-deviations` 77 → 74 两项变化；偏差少的 3 条正是两个 `FunctionType` 与删除
  工厂的 `PersistenceTx`；public surface 1,230 → 1,216（task-execution 232 → 239、collaboration 61 → 40）；未消费 91 不变（两个模块为 0）；
  跨 context import 7,679 → 7,678：撤掉 13 条（task-execution → collaboration 的 11 条 type 边、collaboration 被删端口文件取
  task-execution `public/commands` 的 1 条、bootstrap 取 collaboration `public/participants` 的 1 条），新增 12 条（collaboration 11 个文件
  取 task-execution `public/types`，在目标 DAG 内；bootstrap 取 collaboration composition 1 条）；跨 context 内部文件对 43、mutation 入口
  2,336 不变，task-execution 执行权一节只差行号。

## CI（AC-4）

- `fdc78adf8`：exact SHA 主 CI run 43000966622 的 70 个 job 全部通过（「CI required」绿），windows-platform run 43000966488 绿；同一 SHA 没有其他 push workflow。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 Done 文档文件）的导出仓库上重跑文档用例：文档对账 13 个与读 guard-manifest 的 3 个用例共 167 条全过（两种 provider 同进程、默认 5 秒、`--randomize`）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS：

- 挪进 task-execution 的两个端口文件与 collaboration 的原文件除头注释与 import 路径外逐字相同；`TaskExecutionContextRef` 改取定义处，与
  原先经 `public/commands` 取到的是同一个声明；`PreparedHumanGateRef` 的门种类换成 `TaskExecutionHumanGateKind`，与 collaboration 的
  `HumanGateKind` 取值相同（`review` / `clarify` / `questions`），collaboration 的 `preparedHumanGateRef()` 构造的值不变。
- 帧链：`FrameChain.lookup` 原本就是 `(id) => rows.get(id)`，调用方改传 `rows`（或 `(id) => chain.rows.get(id)`），`loadFrameChain` 的读取
  只换成 `reader.read`，遍历与去重不变。
- 转手字段：task-execution 从不读 `TaskRouteOperationsDependencies.collaboration`；bootstrap 返回的模块对象里显式放的是它自己造的协作上下文
  （`daemonApplication.ts`、`daemonHttpComposition.ts` 两处读它），与此前 provider 转手的是同一个对象。
- 删除参与者工厂：composition 转出的与此前 `public/participants` 转出的是同一个函数。
- 账本：`counts.json` 60 项，`reason` 都含与 `max` 相同的 `max=N`；`PUBLIC_SURFACE_DEBT` 销 3 条，按 preflight 的语料核对精确相等；
  guard-manifest 新增一条的字段取自 census 的实测，改到的几条只刷新行数。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-481 task-execution 自有人工门端口——反向越 DAG 类型边清零与开放类型收口（RFC-294 S9 第二步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
