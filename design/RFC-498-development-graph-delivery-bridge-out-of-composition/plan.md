# RFC-498 实施计划

依赖：RFC-497（Done）；与 S12 共用模块 composition 文件（本 RFC 只删 development-automation 的 `composition/graphDeliveryBridge.ts`，改
`composition/graphDevelopment.ts` 里取它的一条 import 与一处调用）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-498-T1 用例迁入 application**：第 29～153 行与第 155～702 行原样迁入 `application/graph-development/deliveryBridge.ts`；`now`
  必填，开作用域改用 `withSelectedAutomationWorkspaceEffects`，import 按新目录改写（design D2）。
- **RFC-498-T2 composition**：删除 `composition/graphDeliveryBridge.ts`；`graphDevelopment.ts` 改取新文件、调用加 `now: Date.now`
  （design D3）。
- **RFC-498-T3 锁、账本与清单**：`rfc396-mr-bridge` 改取新文件、两处直接建用例加 `now`；`counts.json` 收紧（design D4）。
- **RFC-498-T4 用例**：新增 RFC-498 用例并登记 guard-manifest（design §4）。
- **RFC-498-T5 集中验证**：backend `tsc`、eslint；RFC-498 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-498-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新文件声明；`composition/graphDeliveryBridge.ts` 不存在、没有文件从旧位置取名字；`graphDevelopment.ts` 从新
      文件取用例、恰好调用一次并交出默认时钟
- [x] AC-2 同样输入下交付四个方法与照看方法的返回、错误码、持久化与外部调用的次序和参数和此前一致；临时上传的搬运用的仍是装配时交来的
      同一个工厂
- [x] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-15，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载 25～59，主要是本机其他进程）。验证在候选导出仓库里跑：`b84ac06c2` 的树加本 RFC 的 7 个路径
（含删除的 `composition/graphDeliveryBridge.ts`），核对与工作树逐字相同；对照导出仓库与 `b84ac06c2` 的树相同。验证期间 HEAD 前进了两个
提交——本 RFC 的落档提交 `959b13557`（只改文档）与 `147ee35d1`（只给 `scheduler-clarify-dispatch` 两例加显式时限，见 §CI）——都不碰本 RFC
的路径；候选与对照同基于 `b84ac06c2`，两边只差本 RFC 的路径。集中验证没有查出本 RFC 的问题，候选 1 即定稿。

- **静态**：backend `tsc` 0 错（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 4 个 TS 文件无
  告警，`eslint.promises.config.js` 的规则对改动的两个生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过（`architecture/` 的
  账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：451 个文件
  （`tests/architecture/` 全部 140 个，以及 311 个相关用例：RFC-497 首批的相关用例，加上按图交付的名字与路径扫出、此前不在内的 2 个用例与
  本 RFC 用例）。候选 4,256 条通过、5 条跳过、345 条红（70 个文件），对照（少本 RFC 用例）4,251 条通过、5 条跳过、340 条红（67 个文件）。
  - RFC-498 用例 10 / 10；`rfc396-mr-lifecycle`、`rfc396-mr-job`、`rfc396-current-evidence`、`rfc396-current-evidence-git` 与 RFC-497 用例两边
    都过；`rfc396-mr-bridge` 两边红在同样的 30 条（SQLite 与 PostgreSQL 各 14 条撞默认的 5 秒，PostgreSQL 2 条撞自带的 30 秒），
    `rfc396-mr-runtime-wiring` 两边红在同样的一条（PostgreSQL，5 秒），见下文复跑。
  - 逐文件比失败名，候选有对照之外失败名的 14 个文件共 22 条，都是撞时限：19 条撞默认的 5 秒（5.0～14.8 秒），3 条撞自带的时限
    （`rfc396-case-intake` 30 秒，31.0 秒；两个 `rfc370` 根绑定用例 20 秒，20.7 / 21.0 秒）。静态 import 闭包取到本 RFC 路径的只有起整个应用的
    `rfc396-case-intake`、`rfc311-mission-page` 与两个 `rfc370` 根绑定用例，其余 10 个不经过本 RFC 的代码。
- **红文件放宽默认时限复跑**（首批任一边红过的 72 个文件里，除两个报告类用例（见下文放宽副本）外的 70 个；默认时限放宽到 60 秒、看门狗
  3,000 秒，其余同首批）：候选 1,245 条通过、19 条红（10 个文件），对照 1,249 条通过、18 条红（9 个文件）。首批候选多出失败名的 14 个文件
  在这里两边都过（含撞自带时限的 `rfc396-case-intake` 4 / 4 与两个 `rfc370` 根绑定用例 9 / 9、4 / 4）；`rfc396-mr-runtime-wiring` 13 / 13、
  `rfc396-verification` 54 / 54，两边都过。
  - 候选多出的失败名只有一条：`rfc395-retired-runtime-shapes` 的 PostgreSQL 钩子（empty target generation）撞自带的 90 秒，停在编译 epoch-1
    的 PostgreSQL 目录（`compileEpoch1PostgresqlCatalog`）。首批两边都红在这个钩子，RFC-497 的这一轮复跑是对照红；它的静态 import 闭包
    （1,031 个文件）不含本 RFC 的任何路径。
  - 候选余下的红两边相同：撞用例自带时限的 `rfc257-webhook-ingress` 30 秒、系统模拟 E2E 的 PostgreSQL 两例 180 秒、
    `rfc310-employee-case-runtime` 的 PostgreSQL 一例 30 秒、`rfc311-perf-guards` 的 PostgreSQL 7 条路径 180 秒与钩子 30 秒一条（连带跨引擎
    对比的汇总一条）、`rfc384-daemon-intent-bundle` 的 PostgreSQL 一例 15 秒（maintenance deltas，候选 15.8 秒、对照 16.2 秒）、
    `rfc396-mr-bridge` 的 PostgreSQL 一例 30 秒（接续中断的交付并在重建后保留已发布的候选）；钩子超时的
    `rfc359-w6-t26-postgresql-plan-audit`（600 秒）；环境两条：发布账本（`rfc321-repository-publication-ratchet`）与
    `rfc471-development-delivery-code-host-bridge` 的负对照（这个跑法的 cwd 是 `packages/backend`，判据把裸的 `probe.ts` 解析成
    `packages/backend/probe.ts`；全量 SQLite 在仓根跑，17 / 17）。
  - 两边红在同样用例的这些文件里，静态 import 闭包含本 RFC 路径的只有直接建用例的 `rfc396-mr-bridge` 与起整个应用的
    `rfc384-daemon-intent-bundle`，两者的放宽副本见下文；`rfc471` 是源码扫描判据（闭包不含本 RFC 路径），红的是负对照。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker）：2,942 个文件、2,926 个通过（23,920 条通过、127 条按环境跳过）；其余 16 个文件 18 条红，都不归本 RFC：
  - 两个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc376-report` 300 秒，见下文放宽副本。
  - 余下 14 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 96 条通过、9 条红，对照 95 条通过、10 条红。
    - 3 个两边都过：`release-upgrade-matrix-37-v0_18_2-sqlite`（全量里旧版 daemon 的 git 版本探测没拿到结果、启动即退出）、
      `scheduler-audit-s04-git-wrapper-cumulative-diff`（全量红在自带的 20 秒）与 `lifecycle-property`（15 秒）。
    - 8 个两边红在同样的用例：发布账本一条（`rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里）；撞自带时限的
      `rfc400-collaboration-task-participants`、`rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、`rfc363-workspace-content`
      （各 30 秒）与 `clarify-review-combination-scenarios` 的 S-RFC074（20 秒）；`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask`
      等满 5 秒时任务仍是 running）；`rfc370-execution-effect` 一条（等新起的子进程写出启动标记，10 秒没等到）。
    - 3 个两边红的用例不同：`rfc363-preparation-process-recovery`（候选红一条，对照通过）、`rfc363-task-workspace-process-recovery`
      （对照红一条，候选通过）与 `rfc354-nested-loop-frames`（对照撞自带的 20 秒，候选通过）。三个文件与 preparation 的 crash worker
      （`fixtures/rfc363-preparation-crash-worker.ts`，静态 import，没有动态加载）的静态 import 闭包都不含本 RFC 的任何路径，两边导出仓库里
      逐字相同。两边同时各跑 3 轮：preparation 候选第 2 轮红一条、其余两边都过；task-workspace 第 1 轮两边各红、对照第 3 轮又红一条；
      nested-loop-frames 候选第 1 轮红、第 2 轮两边都红、第 3 轮两边都过。红的都是等真进程到检查点（“checkpoint was not reached”，子进程
      经本机 HTTP 服务克隆）或撞自带时限，停在的检查点每次不同；preparation 一个合计候选 5 次红 3 次、对照 4 次红 0 次，task-workspace 一个
      反过来对照红得多。这三个文件不经过本 RFC 的代码（候选的绿不作通过依据）。
    - 这 14 个文件里，静态 import 闭包取到本 RFC 路径的只有起整个应用的 `rfc300-webhook-workspace-cleanup-e2e`、`rfc167-dynamic-workflow-engine`
      与 `scheduler-audit-s04-git-wrapper-cumulative-diff`：前两个两边红在同样的用例，后一个两边都过。
  - 图交付相关的用例在全量里全过（68 个文件）：RFC-498 用例 10 / 10；`rfc396-mr-bridge` 37 / 37、`rfc396-mr-job` 6 / 6、`rfc396-mr-lifecycle`
    12 / 12、`rfc396-mr-runtime-wiring` 9 / 9、经 `composeGraphDevelopment` 装配的 `rfc396-current-evidence` 2 / 2 与
    `rfc396-current-evidence-git` 1 / 1、`rfc396-verification` 27 / 27；daemon 模块包 9 / 9 与 2 / 2、员工自动化包 12 / 12；RFC-497 用例 13 / 13。
- **放宽副本**（候选与对照同时，按首批的跑法、默认 60 秒，各 2 个 worker；用例自带的时限 → 1,500 秒，其余逐字）：
  - 两个报告类用例两边都全过（30 / 30）：`rfc376-report` 16 / 16（候选 1,024 秒、对照 1,030 秒）、`rfc294-architecture-preflight` 14 / 14
    （1,060 / 1,057 秒）。
  - 复跑里两边红在同样用例、静态 import 闭包取到本 RFC 路径的两个文件，两边都全过（86 / 86）：`rfc396-mr-bridge` 74 / 74（自带的 23 处
    30 秒都放宽；接续中断的交付那一例 PostgreSQL 候选 36.7 秒、对照 34.8 秒，两边都超出自带的 30 秒）、`rfc384-daemon-intent-bundle` 12 / 12
    （maintenance deltas 那一例 PostgreSQL 候选 27.0 秒、对照 24.4 秒，两边都超出自带的 15 秒）。
  - 跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差
  `composition-control-flow-development-automation` 195 → 133（= 新的 `max`；少掉的 62 条正是删掉的 `graphDeliveryBridge.ts` 的全部，
  `graphDevelopment.ts` 14 → 14、种类与次序相同，只是行号随两处改动后移）；生产文件 4,099 → 4,099（backend 3,235 → 3,235：删一个、增一个）；
  跨 context import 7,504 → 7,504（5 条随内容迁到新文件：取 source-control `public/types` 的三个参与方类型与取 `@/util/gitRef` 的两个函数，
  context 对与符号相同）；public surface 1,195 → 1,195（source-control 的三个参与方类型各有一条使用方边随 import 换成新文件）；模块符号归属
  32,367 → 32,366（9 个名字随内容迁到 application，全仓零引用的 `GraphDeliveryBridge` 不随迁）；变更入口 3 项随内容换成新文件；其余各节
  逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 9 处，都是预期的：
  取新位置的 import 2 处（`graphDevelopment.ts`、`rfc396-mr-bridge`），其余 7 处是 RFC-498 用例 ③ 的负对照。`design/`、`docs/` 与 `STATE.md`
  里没有指向旧文件的链接；提到它的是 RFC-294、RFC-396 与 RFC-494～497 的记述（当时的锚点），不改。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `147ee35d1` 的树加本 RFC 的 9 个路径（7 个代码路径与这两份文档），
  读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、
  `rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `959b13557`（只改文档）：主 CI run 43791770971 的 70 个 job 里 68 个通过。Backend tests shard 42/44 红一条：
  `scheduler-clarify-dispatch` 的 PostgreSQL「rerun row after a manually-seeded answered session」撞 bun 默认的 5 秒（5,857 ms；超时后用例体
  继续跑到第 577 行，记为 1 error），连带 CI required 红。归因：这个提交只改文档，这个用例不读它们；代码相同的父提交 `b84ac06c2` 的
  run 43788244224 里同一分片同一例 1,215 ms 通过——runner 时序。按 flaky 的规则修用例：`147ee35d1` 给这一例与同文件余下没有显式时限的
  「agent-single emits clarify」一例各 20 秒（同文件其余 6 例早有，RFC-423、RFC-430、RFC-446 与 RFC-492 先后补上），断言不变；它的主 CI
  run 43796881045 的 70 个 job 全部通过，shard 42/44 里这个文件的 8 个 PostgreSQL 例 1.1～2.1 秒通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **用例正文**：脚本比对 `application/graph-development/deliveryBridge.ts` 的正文（import 之后）与 HEAD 原文件第 29～702 行，差异只有
  design D2 的 3 处——输入的 `now` 改为必填、`const now = deps.now`、开作用域改用 `withSelectedAutomationWorkspaceEffects`；第 704 行全仓零
  引用的 `GraphDeliveryBridge` 不随迁。其余（类型、两个辅助函数、四个方法的全部分支、错误码与注释）逐字不变。
- **import**：逐个名字解析到文件比对，22 个名字取自同样的文件（路径按新目录改写，type-only 照旧），唯一的差别是开作用域那一个：
  infrastructure 的 `withAutomationWorkspaceEffects` 换成 application 的 `withSelectedAutomationWorkspaceEffects`。
- **开作用域**：交来的工厂在生产里是 bootstrap 选定过的同一个对象（`selectDevelopmentWorkspaceEffectBinding`），用例里是完整的本机文件
  工厂；`prepareHandoff` 走到开作用域之前每条路径都先经 `deps.factory.resolve` 解析工作区路径；去掉的再次选定对这些工厂原样返回（手造残缺
  工厂的边界见 design D2）。
- **装配**：`graphDevelopment.ts` 只改一条 import、调用多交 `now: Date.now`（此前用例取缺省的 `Date.now`），其余 10 个字段与次序逐字；
  `composeGraphDevelopment` 的输入类型与交出不变。`rfc396-mr-bridge` 的两处直接建用例多交 `now: Date.now`，与此前的缺省相同。
- **public 与使用方**：public 不变；使用方只有 `graphDevelopment.ts` 与 `rfc396-mr-bridge`，`tsc` 0 错。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-497 转 Done 提交 `b84ac06c2` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-498 开发自动化的图交付桥用例迁出 composition（RFC-294 S10 第五步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
