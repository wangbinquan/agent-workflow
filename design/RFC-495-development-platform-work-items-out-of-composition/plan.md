# RFC-495 实施计划

依赖：RFC-494（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/digitalEmployeePlatformWorkItems.ts`）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-495-T1 用例迁入 application**：第 52～440 行与第 704～2306 行的用例原样迁入 `application/employeePlatformWorkItems.ts`，组合输入接口
  迁为 `DevelopmentEmployeePlatformWorkItemsInput`（design D2）。
- **RFC-495-T2 四处 infrastructure 改为注入**：选定的工作区效果、证据存储的懒取函数、业务树摘要、基线读取；默认时钟交给 composition
  （design D2、D3）。
- **RFC-495-T3 composition 只留装配**：组合输入类型（形状不变）与两个装配函数（design D3）。
- **RFC-495-T4 锁、账本与清单**：读用例源码的锁改指新文件；基线读取一条改实参名；`counts.json` 收紧；`commons-debt.json` 锚点按内容改指；
  OS 依赖清单改指（design D4）。
- **RFC-495-T5 用例**：新增 RFC-495 用例并登记 guard-manifest（design §4）。
- **RFC-495-T6 集中验证**：backend `tsc`、eslint；RFC-495 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-495-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新的 application 文件声明；composition 只声明、只交出组合输入类型与两个装配函数，没有控制流语句；没有文件从
      composition 取迁出的名字
- [x] AC-2 同样输入下各工作项的输出、上下文补丁、外部调用的次序与参数和此前一致；选定、懒建、基线读取与业务树摘要的时机不变
- [x] AC-3 新文件的依赖面是闭集（不取 infrastructure、composition、IO 包与进程全局）；跨 context 边、public surface 不升；组合层控制流
      收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`c08c4db2e` 主 CI run 43594357375 的 70 个 job 全部通过（见 §CI）

## 集中验证（2026-11-13～14，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载 26～57，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加本 RFC 的 12 个路径，核对与
工作树逐字相同；对照导出仓库与 HEAD 的树相同。HEAD 在整个验证期间停在 `89d0a8087`（本 RFC 的落档提交）。集中验证没有查出本 RFC 的问题，
候选 1 即定稿。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 8 个 TS 文件无告警；prettier：改动的 TS、JSON、
  本 RFC 的三件套与 RFC-494 plan 通过（`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：442 个文件
  （`tests/architecture/` 全部 140 个，以及按名字与内容取的 302 个相关用例：本 RFC 改动与改指的用例、装配平台工作项的用例、取
  development-automation / digital-employee / RFC-310 / RFC-396 的用例与文档对账用例）。候选 4,219 条通过、5 条跳过、294 条红（54 个
  文件），对照（少本 RFC 用例）4,211 条通过、5 条跳过、294 条红（55 个文件）。
  - RFC-495 用例 8 / 8；改指的五个锁全过，只有 `rfc321-repository-publication-ratchet` 的发布账本一条两边都红（账本记的提交不在导出仓库的
    历史里）。
  - 装配平台工作项的 10 个用例里 9 个两边都过（含冲突一支的系统模拟 E2E、员工工作区交付、平台流水线收集、冲突工作区绑定、证据产物与存储的
    根绑定、目的流水线落地、MR 生命周期、daemon 模块包）；系统模拟 E2E 的 SQLite 两例两边都过、PostgreSQL 两例两边都撞自带的 180 秒，见下文
    放宽副本。
  - 逐文件比失败名，候选有对照之外失败名的 9 个文件（含候选红而对照不红的 2 个）：多出的失败都是撞时限（默认 5 秒或用例自带的时限）。其中
    8 个文件的静态 import 闭包不含本 RFC 的路径；`rfc370-evidence-document-write-root-bindings` 起整个应用（闭包 2,974 个文件），候选红在
    PostgreSQL 的一例撞自带的 20 秒（21.2 秒），对照同一例 21.5 秒通过，同文件另一例两边 18.1 / 17.6 秒，SQLite 两例两边都在 1.2 秒内通过。
- **红文件放宽默认时限复跑**（首批任一边红的 57 个文件里除两个报告类用例外的 55 个，候选与对照同时，默认 60 秒，其余同首批）：候选 957 条
  通过、22 条红（12 个文件），对照 953 条通过、26 条红（13 个文件）；候选没有对照之外的失败名。候选余下的红两边相同：
  - 撞用例自带时限的 7 个：`rfc257-webhook-ingress` 30 秒、系统模拟 E2E 的 PostgreSQL 两例 180 秒（候选 SQLite 两例通过）、
    `rfc310-employee-case-runtime` 与 `rfc396-mr-bridge` 的 PostgreSQL 各一例 30 秒、`rfc311-perf-guards` 的 PostgreSQL 各路径 180 秒（连带
    跨引擎对比的汇总一条）、`rfc370-evidence-document-write-root-bindings` 的 PostgreSQL 两例 20 秒、`rfc384-daemon-intent-bundle` 15 秒；
  - 钩子超时的 2 个：`rfc359-w6-t26-postgresql-plan-audit`（600 / 60 秒）、`rfc395-retired-runtime-shapes`（90 秒）；
  - 环境 2 个：上面的发布账本一条；`rfc471-development-delivery-code-host-bridge` 的负对照一条（这个跑法的 cwd 是 `packages/backend`，探针的
    相对路径按 cwd 解析，CI 在仓根跑）；
  - `rfc099-acl-endpoints-matrix` 两边都被跑法的 1,500 秒看门狗结束（被结束前候选 98 条、对照 61 条通过，都没有红）；
  - 这 12 个文件里，静态 import 闭包取到本 RFC 路径的是 `rfc099-acl-endpoints-matrix`、系统模拟 E2E、
    `rfc370-evidence-document-write-root-bindings` 与 `rfc384-daemon-intent-bundle`（都起整个应用），其中只有系统模拟 E2E 走平台工作项。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  清单按耗时从慢到快排，3 个 worker）：2,939 个文件、2,924 个通过（23,884 条通过、127 条按环境跳过）；其余 15 个文件 17 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight` 180 秒、`rfc376-report` 300 秒、`rfc370-committed-architecture-source` 150 秒，
    见下文放宽副本。
  - 余下 12 个与对照同时、同样跑法 A/B（各 2 个 worker；候选 95 条通过、9 条红，对照 95 条通过、9 条红）：
    - 2 个两边都过：`release-upgrade-matrix-21-v0_14_1-sqlite`（全量红在当前源码起的 daemon 启动时拒绝启动：`git --version` 在启动后 0.4 秒
      就失败，探针时限 20 秒；这一步在宿主探测里、早于模块装配；A/B 两边 87.8 秒、86.5 秒）与 `rfc098-wrapper-stale-redispatch`（全量红在
      自带的 20 秒）。
    - 7 个两边红在同样的用例：发布账本一条；撞自带时限的 `rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、
      `rfc363-workspace-content`（各 30 秒）与 `lifecycle-property`（15 秒）；`rfc167-dynamic-workflow-engine` 的 `settleTask` 等满 5 秒时
      任务仍是 running；`tasks` 的仓库准备没有在等待内落定（候选一条、对照两条）。
    - 1 个只有对照红：`rfc321-repository-publication-system-mock-e2e`（撞自带的 30 秒；全量里候选也红在这一条）。
    - 2 个候选多红一条：`rfc363-preparation-process-recovery`（真进程恢复没等到检查点，全量与 A/B 停在不同的检查点）与
      `rfc370-execution-effect`（“real direct system target exists before receipt ACK”：等新起的 `bun -e` 子进程写出启动标记，10 秒没等到）。
      两个文件的静态 import 闭包（含崩溃 worker 脚本 863 个与 712 个文件）不含本 RFC 的任何路径，两边导出仓库里逐字相同。两边同时各跑 3 轮：
      前两轮两个文件两边都过；第 3 轮 `rfc370-execution-effect` 两边都红同一条（同一个 10 秒等待），`rfc363` 两边都过。这两个文件不经过本 RFC
      的代码（候选的绿不作通过依据）。
  - 平台工作项相关的用例在全量里全过：系统模拟 E2E 2 / 2、冲突一支 1 / 1、MR 生命周期 12 / 12、员工工作区交付 4 / 4、平台流水线收集 9 / 9、
    目的流水线落地 1 / 1、冲突工作区绑定 4 / 4、证据产物根绑定 5 / 5、存储根绑定 10 / 10、daemon 模块包 9 / 9、文档写入根绑定 2 / 2、
    `rfc310-pr3-upload-security` 10 / 10、`rfc349-digital-employee-platform-tools-wiring` 4 / 4；RFC-495 用例 8 / 8。
- **放宽副本**（候选与对照同时，按首批的跑法、默认 60 秒，各 2 个 worker）：系统模拟 E2E、`rfc370-evidence-document-write-root-bindings` 与
  三个报告类用例各做一份只放宽时限的副本（用例自带的时限 → 1,500 秒）。候选全过（40 / 40）：系统模拟 E2E 4 / 4（PostgreSQL 两例 380 秒、
  434 秒，SQLite 两例 141 秒、147 秒）、文档写入根绑定 4 / 4、`rfc376-report` 16 / 16（523 秒）、`rfc294-architecture-preflight` 14 / 14
  （600 秒）、`rfc370-committed-architecture-source` 2 / 2（72 秒）；对照 39 / 40（系统模拟 E2E 的 PostgreSQL 一例在 7 秒时 fetch 连接被重置，
  ECONNRESET）。跑完删除副本。`rfc376-structural-guards` 在首批与全量里都在自带的 20 秒内通过，不另做副本。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差
  `composition-control-flow-development-automation` 491 → 371（= 新的 `max`；减少的 120 行都在迁出的内容里）；生产文件 4,091 → 4,092（backend
  3,227 → 3,228，即新的 application 文件）；跨 context import 7,504 → 7,504（3 条随文件迁到 application，context 对与符号相同）；模块符号归属
  32,348 → 32,351（22 个模块内私有名字随文件迁到 application，另加新文件本身与它交出的两个名字）；变更入口 2,340 → 2,341（多出 application 的
  `createDevelopmentEmployeePlatformWorkItems`，只进清单、没有钉住的计数；graph 侧对应的 `createGraphPlatformWorkItems` 本已在清单里）；其余
  各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 17 处，都是预期的：
  取 composition 文件的 import 7 处（bootstrap 1、用例 6，只取三个组合名字，RFC-495 用例 ③ 钉住）与 composition 文件取新文件的 1 处；锁里
  指向新文件的 5 处；按 D4 仍读 composition 文件的 2 处（`rfc359-w4-d13-adapters` 的 `PersistenceDb`、存储根绑定的基线读取一条）；RFC-495
  用例的两个负对照。`design/`、`docs/` 与 `STATE.md` 里没有指向这个文件的链接（正文提到它的都是历史记述，文件仍在、只剩装配）。
- **收口文档**：本 plan、`STATE.md` 与 RFC-494 plan 定稿后重新同步到候选导出仓库，读这几处文档与 RFC 索引的 6 个用例
  （`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、
  `review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `c08c4db2e`（实现，父提交是本 RFC 的落档提交 `89d0a8087`）：exact SHA 主 CI run 43594357375 的 70 个 job 全部通过；这次推送没有按路径
  触发其他 workflow。
- 本 RFC 的落档提交 `89d0a8087`（只改文档）：主 CI run 43567345143 的 70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **用例正文**：脚本比对 `application/employeePlatformWorkItems.ts` 的正文（import 之后）与 HEAD 原文件，差异只有 design D2 列出的几处：
  上传计划解析的两个入参（已选定的工厂、基线读取器）与其中的三行，输入接口改名并换成五个已选定 / 已绑定的输入，用例函数改名，闭包开头的
  `factory`、`now`、`evidenceStore` 三处取值，调用上传计划的一个实参，冲突复验的一处调用；原文件末尾给 bootstrap 的装配函数与它的输入类型
  逐字留在 composition；其余（schema、辅助函数、按 `plan.workItemRef` 分派的全部分支与注释）逐字不变。
- **选定与校验**：`selectedAutomationWorkspaceEffects` 对已给出的工厂只校验三个方法、原样返回同一个对象，不完整时抛
  `automation-workspace-effects-factory-incomplete`；`withAutomationWorkspaceEffects(f, …)` 就是
  `withSelectedAutomationWorkspaceEffects(selectedAutomationWorkspaceEffects(f), …)`。原来上传计划里的两次选定都作用在装配时已选定的同一个
  工厂上，改为直接用 `withSelectedAutomationWorkspaceEffects` 后作用域与结果相同；未注入或注入不完整的工厂仍在装配时选定 / 报错。
- **注入的时机**：证据存储的懒取函数原样迁到 composition（注入了 `evidenceArtifacts` 就用它，否则首次用到时建一次）；基线读取器仍在原位置、
  只在有仓库上传时建；业务树摘要仍在冲突复验处、用同一个选定工厂；默认时钟 `input.now ?? Date.now` 原样留在 composition。新文件不再读
  `repositoryBaselines`、`evidenceArtifacts`（装配用 `...input` 交过去的这两个字段在新文件里没有读取处）。
- **使用方与类型**：组合输入类型由 application 的输入类型推出，字段与可选性与此前逐个相同；bootstrap 与 6 个用例的 import 不变，`tsc` 0 错。
- **public 与装配**：public 不变；composition 文件没有控制流语句；跨 context 引用 3 条原样随文件迁到 application（同样的 context 对与符号）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（已提交，`89d0a8087`；当时 RFC-494 收口两个提交的 CI 还在跑，补记改随
实现提交）；实现与验证后再提交 `refactor(backend): RFC-495 开发自动化的平台工作项用例迁出 composition（RFC-294 S10 第二步）`，同一提交在
`STATE.md` 与 RFC-494 plan 补记那两次 CI。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
