# RFC-485 实施计划

**前置**：RFC-482（Done，`42b52316d`）、RFC-484（Done，`067169518`，Done 文档 `86cad5f11`）。由本会话实施（用户 2026-10-31 指示不再派
Codex）。全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-485-T1 | 声明 `TaskNodeRunReads`、`TaskNodeOutputReads`，`NodeRunQueries` / `NodeOutputQueries` extends 它们；`public/types` 交出闭合接口                                    | design §2 |
| RFC-485-T2 | `TaskExecutionParticipantBindings` 增三个工厂；task-execution 的 composition 转出；bootstrap 的绑定与用例 helper 补上                                               | design §2 |
| RFC-485-T3 | collaboration 的调用点改用绑定，没有绑定的函数沿调用链接上；bootstrap 的装配点改交绑定                                                                              | design §2 |
| RFC-485-T4 | memory 的装配输入增两个读取端口，工作存储与注入读存储改收端口；bootstrap 的 memory 模块建好交入                                                                     | design §2 |
| RFC-485-T5 | `public/queries` 撤出三个工厂与三个类型名（`TaskGateQueries` 移到 `public/types`）；账本销账、`counts.json` 收紧、guard-manifest 登记                               | design §3 |
| RFC-485-T6 | 新增 RFC-485 用例与行为用例；字面量扫描找出的文本断言随改动改写；既有用例改取与补传                                                                                 | design §4 |
| RFC-485-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §5 |

## 验收清单

- [x] AC-1 task-execution 的 public 不再导出三个工厂；collaboration 经绑定、memory 经装配输入取得读取能力
- [x] AC-2 两个闭合读取接口只有方法签名、从 `public/types` 交出；task-execution 未消费符号仍为 0
- [x] AC-3 `public-surface-deviations` 68 → 65 并收紧到实测；跨 context 内部文件对与越 DAG 文件对不变
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-11，候选基于 `4c416ad75`）

本机全程高负载（10 核；采样到的 1 分钟负载 26～78，主要是本机其他进程）。验证在候选导出仓库里跑（HEAD 的树加候选路径，提交后运行；修复后
重新同步，核对与 HEAD 加候选逐字相同）；对照导出仓库与 HEAD 相同（`4c416ad75` 只改文档）。验证期间 `origin/main` 未前进。开发期已按
RFC-482 的做法用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言（`tests/`、`scripts/` 与账本 JSON 的字符串、模板片段和正则，只比
用例实际读的文件）：176 个文件 444 条命中，逐条核对后改了 4 个用例（`rfc395-clarify-answer-boundary`、`rfc395-task-definition-boundary`、
`rfc128-p5-d-autodispatch` 与 `rfc395-a3-site-regressions` 抠出执行的两个函数），余下的是模块名一类的通用词与本 RFC 新写的断言。集中验证又查出
本 RFC 的两处问题，均已修复并复验：

1. **哈希账本**：`rfc395-serialized-insert-source-locks.json` 钉着 `seal.ts` 的 sha256（RFC-482 也撞过），`rfc359-w8-t29` 报出；更新哈希，在
   `why` 里补一句 RFC-485 的评审说明（seal 事务里的 node-run 读取改经绑定构造，句柄仍是 seal 事务的 `tx`）。
2. **装配期急切求值**：`rfc461` 用假 db 装配整个 memory 模块；`createNodeOutputQueries` 构造时就调 `tablesOf(db)`，原来每次调用时才构造，
   改成装配期建一次后在装配处抛错。用例改交占位读取（它不走这两条读取），`docs/dev-gotchas.md` 补一条。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 162 个 TS 文件），promises 规则集对改动的
  53 个源码文件无告警；改动的 TS、fixture JSON 与 RFC-485 三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier；
  `docs/dev-gotchas.md`、`docs/audit-backlog.md`、`STATE.md` 不跑 prettier）。
- **RFC-485 用例**：默认 5 秒、`--randomize` 下全过（全量里 7 / 7；PostgreSQL lane 里两种 provider 同进程 8 / 8）；对 HEAD 的代码 7 条
  红 6 条（只判 fixture 的负对照两边都绿）。
- **首批**（`tests/architecture/` 全部、`tests/` 里读 `src/` 文本的用例与本 RFC 改动的用例，240 个文件）：234 个通过；2 个是上面两处（改后
  复跑通过）；其余 4 个撞用例自带的时限（`rfc376-report`、`rfc400`、`clarify-review-combination-scenarios`、`rfc294-architecture-preflight`），
  全量与放宽副本里拿到真结果（见下）。
- **全量 SQLite**（导出仓库逐文件跑：每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  6 个 worker）：2,926 个文件里 2,912 个通过（`tests/helpers/model/` 的 7 个 `*.spec.ts` 是 fixture 类型声明、没有用例，另跑一遍确认 0 条）。
  失败的 14 个：
  - `rfc321-repository-publication-ratchet`：导出仓库没有真实历史，`merge-base --is-ancestor` 找不到发布账本记录的提交；对照同样失败，在真实
    仓库里 10 / 10；
  - 其余 13 个撞的都是用例自带的时限或内部等待（与 RFC-482 全量里撞时限的是同一批）。在导出仓库另存只放宽时限常量的副本跑完：
    `architecture/rfc376-report` 16 / 16（同一份提交源两次出报告逐字节相同的那条跑了 553 秒）、
    `architecture/rfc400-collaboration-task-participants` 6 / 6、`clarify-review-combination-scenarios` 18 / 18、
    `rfc167-dynamic-workflow-engine` 29 / 29、`rfc300-webhook-workspace-cleanup-e2e` 2 / 2、`rfc321-repository-publication-system-mock-e2e`
    1 / 1、`rfc354-nested-frames-closure` 1 / 1、`rfc363-workspace-content` 4 / 4、`rfc370-committed-architecture-source` 2 / 2（按提交的
    语料计数那条 315 秒）、`rfc395-v1-source-evidence` 23 / 23、`rfc395-v1-source-readers` 8 / 8、`rfc395-v3-old-epoch-unpack` 4 / 4；
    `rfc363-task-workspace-process-recovery` 的副本照 RFC-482 给检查点等待加 250 毫秒的轮询兜底，8 / 8（每条 3～9 秒）。
    `rfc294-architecture-preflight` 在全量里 14 / 14（偏差账本 31 秒、capability 账本 149 秒）。
- **PostgreSQL**：本 RFC 不改 SQL 与持久化；以 CI 的双引擎分片为证据。另把本 RFC 改写或新增的、用到改动 helper 的与改动调用链上的用例共
  85 个文件接 PostgreSQL 跑（两种 provider 同进程、`--randomize`、单条 60 秒，3 个 worker）：85 个文件一次全过，1,628 条全部通过
  （PostgreSQL 一侧 760 条）。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选的提交 vs HEAD 的报告）：60 项实测与 `counts.json` 的 `max` 逐项相等，门里只有
  `public-surface-deviations` 68 → 65 一项变化（这一对 22 → 19）；public surface task-execution 233 → 229（`public/queries` 撤三个工厂与四个
  类型名，`public/types` 增 `TaskNodeRunReads`、`TaskNodeOutputReads` 与移来的 `TaskGateQueries`），collaboration 40、memory 31 不变；未消费 91
  不变（task-execution、collaboration 为 0，memory 3）；跨 context import 7,671 → 7,648：撤掉 39 条（collaboration 取 task-execution
  `public/queries` 的 35 条、memory 的 3 条、`public/queries` 取 `persistenceDb` 类型 1 条），新增 16 条（collaboration、memory 取 task-execution
  `public/types` 的类型 4 条、5 条，在目标 DAG 内；bootstrap 取 task-execution composition 7 条）；mutation 入口 2,332 不变（node-run 工厂从
  `public/queries` 移到 composition）；越 DAG 的 offered 文件对 47、跨 context 内部文件对 43 不变。候选 1 与最终候选的报告逐项相同。
- **最终候选**：导出仓库与 HEAD 加 170 个候选路径逐字相同，临时副本已删。文档对账与读 guard-manifest 的 16 个用例 167 条
  全过（两种 provider 同进程、默认 5 秒、`--randomize`，含 3 个 rfc317 守卫账本用例）；候选 4 之后只同步了 5 个文档文件，代码与用例的结果
  沿用，架构报告在候选 4 上重出（与上面逐项相同）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS：

- 三个工厂：bootstrap 交给绑定的与此前 `public/queries` 转出的是同一个函数（node-run 工厂仍用 owner 的数据库内容读取器）。按文件比对删去与
  新增的调用，collaboration 每个调用点的工厂与实参逐个相同——事务里的仍是事务句柄，没有在装配期预绑实例；只有下面两处是有意改成交入
  读取。
- 开门参与者：此前 4 处 `createNodeRunQueries(tx)` 用的是参与者自己的 `tx`；改后 task-execution 的生命周期持久化在 `gatesIn(tx)` 里用同一个
  `tx` 建好 `nodeRuns`，与 mint、lifecycle 参与者一起交入，同一个事务、同样的读取。
- memory：此前 5 处都在 `this.db`（装配时的根 db、事务外）上构造；改后 bootstrap 用同一个 `input.db` 建两个只读端口交给工作存储与注入读
  存储。两个工厂构造时不缓存结果（node-output 工厂构造时只取表对象），建一次与每次调用时建读到的相同。澄清答案查询改收 node-run 与
  task-gate 两个工厂，取自 task-execution 的 composition，与此前 public 转出的是同一函数。
- 绑定来源：生产里三个成员都取自 task-execution 的 composition（跨 context 闭包的整份绑定、数字员工的 node-output 切片、memory 的 node-run /
  task-gate 切片）；`daemonHttpComposition` 与 `daemonSession` 各造一份绑定、在本地共用（此前各装配点各造一份，内容相同）。
- 评审互斥锁：`withReviewNodeMutationLock` 的来源判据 `'findTaskId' in source` 不变——新的 `{ db, taskExecutionParticipants }` 没有该成员，照旧
  现造解析器，用同一个 db 查 `taskId`。
- 账本：`counts.json` 60 项，`reason` 都含与 `max` 相同的 `max=N`；`PUBLIC_SURFACE_DEBT` 销 3 条，按 preflight 的语料核对精确相等（65 = 65），
  capability 账本 18 = 18；guard-manifest 新增一条的字段取自 census 的实测，改到的几条只刷新行数。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-485 collaboration 与 memory 取 task-execution 的三个行形状查询工厂改经装配期注入（RFC-294 S9 第四步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
