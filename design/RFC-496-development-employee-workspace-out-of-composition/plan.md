# RFC-496 实施计划

依赖：RFC-495（Done）；与 S12 共用模块 composition 文件（本 RFC 只动 development-automation 的 `composition/digitalEmployeeWorkspace.ts`，
另动 infrastructure 的 `protectedSnapshot.ts`、`workspaceValidator.ts`、`attemptSupport.ts` 与 `graph-development/employeeWorkspace.ts` 的 import）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-496-T1 用例迁入 application**：第 34～588 行、组合输入接口与第 674～1402 行的用例原样迁入 `application/employeeWorkspace.ts`；
  读侧改名交出（design D2）。
- **RFC-496-T2 快照与校验迁入 application**：两个文件原样迁入 application，三个开作用域的函数取已选定的工厂；infrastructure 只留三个包装与
  三个转出；使用方按 D3 改取（design D3）。
- **RFC-496-T3 常量迁入 domain**：三组 git 元数据前缀迁入 `domain/gitMetadataOwnership.ts`，使用方改取（design D4）。
- **RFC-496-T4 composition 只留装配**：组合输入类型（形状不变）、装配函数与读侧的数据库绑定（design D5）。
- **RFC-496-T5 锁、账本与清单**：读用例源码的锁改指新文件；RFC-494 / RFC-495 用例钉住的同名声明改指；`counts.json` 收紧；
  `commons-debt.json` 锚点按内容改指；OS 依赖清单改指（design D6）。
- **RFC-496-T6 用例**：新增 RFC-496 用例并登记 guard-manifest（design §4）。
- **RFC-496-T7 集中验证**：backend `tsc`、eslint；RFC-496 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（文件名本身、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-496-T8 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在新的 application / domain 文件声明（infrastructure 的三个包装除外）；composition 只声明、只交出组合输入类型与
      装配函数，没有控制流语句；没有文件从旧位置取迁出的名字（三个包装与三个转出除外）
- [x] AC-2 同样输入下工作区的准备、快照、校验与回退的结果、外部调用的次序与参数和此前一致；选定时机不变，未给实现的调用方仍选本机实现，
      远端树操作照旧优先
- [x] AC-3 新文件的依赖面是闭集（application 不取 infrastructure、composition、IO 包与进程全局；domain 不取任何模块）；跨 context 边、
      public surface 不升；组合层控制流收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`9688abfd3` 主 CI run 43749130381 的 70 个 job 全部通过（见 §CI）

## 集中验证（2026-11-15，候选 1）

本机全程高负载（10 核；采样到的 1 分钟负载 37～93，主要是本机其他进程：Docker 虚拟机约 300% CPU、fseventsd 约 88%）。验证在候选导出仓库里
跑：HEAD 的树加本 RFC 的 26 个路径，核对与工作树逐字相同；对照导出仓库与 HEAD 的树相同（两个导出仓库都是当天从 HEAD 新导出的）。HEAD 在
整个验证期间停在 `0b601e52e`（本 RFC 的落档提交）。集中验证没有查出本 RFC 的问题，候选 1 即定稿。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动的 21 个 TS 文件无告警；prettier：改动的 TS、
  JSON 账本与本 RFC 的三件套通过（`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：443 个文件
  （`tests/architecture/` 全部 140 个，以及 303 个相关用例：RFC-495 首批的相关用例，加上按员工工作区、快照、校验与常量的名字与内容扫出的
  用例——除本 RFC 用例外都已在内）。候选 4,187 条通过、5 条跳过、337 条红（70 个文件），对照（少本 RFC 用例）4,176 条通过、5 条跳过、
  334 条红（70 个文件）。
  - RFC-496 用例 14 / 14。
  - 逐文件比失败名，候选有对照之外失败名的 13 个文件（含候选红而对照不红的 4 个）共 16 条，都是撞时限：14 条撞默认的 5 秒（5.2～9.2 秒），
    `rfc370-employee-input-root-bindings` 与 `rfc370-employee-program-root-bindings` 的 PostgreSQL 各一条撞自带的 20 秒（21.3 / 21.1 秒）。其中
    走员工工作区的 `rfc310-employee-workspace-repository-freshness`，候选在 PostgreSQL、对照在 SQLite 撞同一条的 5 秒；
    `rfc294-architecture-preflight` 的跨 context 内部 import 白名单一条撞 5 秒（5.19 秒），全量 SQLite 里同一条在 60 秒内通过。
- **红文件放宽默认时限复跑**（首批任一边红的 74 个文件里除两个报告类用例外的 72 个，候选与对照同时，默认 60 秒、看门狗 3,000 秒，其余同
  首批）：候选 1,285 条通过、20 条红（10 个文件），对照 1,283 条通过、22 条红（11 个文件）；候选没有对照之外的失败名。首批候选多出失败名的
  13 个文件，除报告类的 `rfc294-architecture-preflight`（见下文放宽副本）外，12 个在这里两边都过。候选余下的红两边相同：
  - 撞用例自带时限的 6 个：`rfc257-webhook-ingress` 30 秒、系统模拟 E2E 的 PostgreSQL 两例 180 秒（SQLite 两例通过）、
    `rfc310-employee-case-runtime` 与 `rfc396-mr-bridge` 的 PostgreSQL 各一例 30 秒、`rfc311-perf-guards` 的 PostgreSQL 各路径 180 / 30 秒
    （连带跨引擎对比的汇总一条）、`rfc384-daemon-intent-bundle` 15 秒；
  - 钩子超时的 2 个：`rfc359-w6-t26-postgresql-plan-audit`（600 秒）、`rfc395-retired-runtime-shapes`（90 秒）；
  - 环境 2 个：发布账本一条（`rfc321-repository-publication-ratchet`，见下文全量）；`rfc471-development-delivery-code-host-bridge` 的负对照一条
    （这个跑法的 cwd 是 `packages/backend`，探针的相对路径按 cwd 解析，CI 在仓根跑）。
  - 对照多红的两条也是撞自带时限：`rfc370-mission-input-capture-roots` 的 PostgreSQL 一例 20 秒、`rfc396-mr-bridge` 的另一例 30 秒。
    `rfc099-acl-endpoints-matrix` 两边都过（158 / 158）。
  - 这 10 个文件里，静态 import 闭包取到本 RFC 路径的是系统模拟 E2E、`rfc310-employee-case-runtime`、起整个应用的
    `rfc384-daemon-intent-bundle` 与 `rfc471-development-delivery-code-host-bridge`（红的是源码扫描判据的负对照）；走员工工作区的是前两个，
    放宽副本见下文。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带时限的照旧；
  清单按耗时从慢到快排，3 个 worker）：2,940 个文件、2,922 个通过（23,894 条通过、127 条按环境跳过）；其余 18 个文件 21 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight` 60 / 180 秒、`rfc376-report` 300 秒、`rfc370-committed-architecture-source`
    150 秒，见下文放宽副本。
  - 余下 15 个与对照同时、同样跑法 A/B（各 2 个 worker）：候选 104 条通过、17 条红，对照 104 条通过、17 条红。
    - 2 个两边都过：`rfc395-v3-old-epoch-unpack`（全量红在自带的 25 秒）与 `rfc396-verification-environment`（全量红在 node 版本探针的 2 秒
      时限，`infrastructure/local/verificationEnvironment.ts:19`，探针返回空）。
    - 11 个两边红在同样的用例：发布账本一条（账本记的提交不在导出仓库的历史里）；撞自带时限的 `rfc395-v1-source-readers` 40 秒、
      `rfc400-collaboration-task-participants` 30 秒、`rfc300-webhook-workspace-cleanup-e2e`、`rfc354-nested-frames-closure`、
      `rfc321-repository-publication-system-mock-e2e`、`rfc363-workspace-content`（各 30 秒）、`rfc354-nested-loop-frames` 20 秒与
      `lifecycle-property` 15 秒；`rfc167-dynamic-workflow-engine` 的 `settleTask` 等满 5 秒时任务仍是 running；`tasks` 的仓库准备没有在
      等待内落定。
    - 2 个两边红的用例不同：`rfc363-task-workspace-process-recovery`（真进程恢复没等到检查点，候选 4 条、对照 5 条，停在不同的检查点）与
      `rfc370-execution-effect`（等新起的子进程写出启动标记，10 秒没等到；候选 2 条、对照 1 条）。两个文件的静态 import 闭包（909 个与 712 个
      文件）不含本 RFC 的任何路径，两边导出仓库里逐字相同。两边同时各跑 3 轮：第 1 轮 `rfc370-execution-effect` 两边红同样的两条、`rfc363`
      两边都过；第 2、3 轮两个文件两边都过。这两个文件不经过本 RFC 的代码（候选的绿不作通过依据）。
    - 这 15 个文件里，静态 import 闭包取到本 RFC 路径的只有起整个应用的 `tasks`、`rfc300-webhook-workspace-cleanup-e2e` 与
      `rfc167-dynamic-workflow-engine`，三个都两边红在同样的用例。
  - 员工工作区相关的用例在全量里全过：系统模拟 E2E 2 / 2、冲突一支 1 / 1、Case 运行 8 / 8、工作区交付 4 / 4、仓库新鲜度 2 / 2、冲突工作区
    绑定 4 / 4、工作区效果 8 / 8、`rfc310-pr4-workspace-validator` 9 / 9、MR 生命周期 12 / 12、开发树操作 5 / 5、运行时 git 缓存受保护根
    3 / 3、改指的三个锁（6 / 6、5 / 5、10 / 10）、RFC-494 / RFC-495 / RFC-496 用例 7 / 7、8 / 8、14 / 14、取 `attemptSupport` 的五个链路用例
    （10 / 10、3 / 3、4 / 4、4 / 4、2 / 2）、`rfc359-w4-d13-adapters` 6 / 6、文档写入根绑定 2 / 2、`rfc310-architecture-lock` 12 / 12、
    `rfc294-review-module-layer-rules` 11 / 11。
- **放宽副本**（候选与对照同时，按首批的跑法、默认 60 秒，各 2 个 worker）：系统模拟 E2E、`rfc370-evidence-document-write-root-bindings` 与
  三个报告类用例各做一份只放宽时限的副本（用例自带的时限 → 1,500 秒）。两边都全过（40 / 40）：候选的系统模拟 E2E 4 / 4（SQLite 两例 137 秒、
  158 秒，PostgreSQL 两例 329 秒、417 秒，超出自带的 180 秒）、文档写入根绑定 4 / 4、`rfc376-report` 16 / 16（580 秒）、
  `rfc294-architecture-preflight` 14 / 14（416 秒）、`rfc370-committed-architecture-source` 2 / 2（111 秒）。60 秒复跑之后，走员工工作区的
  `rfc310-employee-case-runtime`（PostgreSQL 一例两边都撞自带的 30 秒）另做一份同样的副本：两边都 11 / 11，候选那一例 107.5 秒（对照
  124.5 秒）。跑完删除副本。
  `rfc376-structural-guards` 在首批与全量里都在自带的 20 秒内通过（221 / 221），不另做副本。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差
  `composition-control-flow-development-automation` 371 → 274（= 新的 `max`；少掉的 97 条都在 `composition/digitalEmployeeWorkspace.ts`，
  没有新增）；生产文件 4,092 → 4,096（backend 3,228 → 3,232，即三个 application 文件与一个 domain 文件）；跨 context import 7,504 → 7,504
  （6 条随内容迁到 application，context 对与符号相同）；模块符号归属 32,351 → 32,360（58 个名字随内容迁到 application / domain，
  `detailReader` 改名交出为 `createEmployeeCaseWorkspaceDetailReader`；另加 4 个新文件本身、`DevelopmentEmployeeWorkspaceInput`、
  `createDevelopmentEmployeeWorkspace`，以及 application 里与 infrastructure 包装同名的 3 个函数）；变更入口 2,341 → 2,343（多出 application
  的 `createDevelopmentEmployeeWorkspace` 与 `createEmployeeCaseWorkspaceDetailReader`，`RUNTIME_OWNED_GIT_METADATA_PREFIXES` 一条随常量迁到
  domain；只进清单、没有钉住的计数）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 56 处，都是预期的：
  import 51 处，都只取各自位置留下的名字（RFC-496 用例 ④ 逐个名字钉住）；其余 5 处是 RFC-496 用例的 4 个负对照与按 D6 仍读 composition
  文件的 `rfc359-w4-d13-adapters`（装配文件的 `PersistenceDb`）。`design/`、`docs/` 与 `STATE.md` 里没有指向这几个文件的链接；带行号提到它们的
  只有 RFC-317 `findings.md` 的三条审计记述（当时的锚点；RFC-494 迁走的 `employeeTypePackage.ts` 的锚点同样留在原文），不改。
- **收口文档**：plan、design、`STATE.md` 与 `docs/dev-gotchas.md` 定稿后重新同步到候选导出仓库，读这几处文档与 RFC 索引的 6 个用例
  （`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、
  `review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `9688abfd3`（实现，父提交是本 RFC 的落档提交 `0b601e52e`）：exact SHA 主 CI run 43749130381 的 70 个 job 全部通过；这次推送没有按路径
  触发其他 workflow。
- 本 RFC 的落档提交 `0b601e52e`（只改文档）：主 CI run 43717139271 的 70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **用例正文**：脚本比对 `application/employeeWorkspace.ts` 的正文（import 之后）与 HEAD 原文件第 34～588、597～1402 行，差异只有 design D2
  列出的几处：参与方接口交出；`detailReader` 改名 `createEmployeeCaseWorkspaceDetailReader` 并交出；输入接口改名
  `DevelopmentEmployeeWorkspaceInput`，`automationWorkspaceEffects`（加一行注释）与 `now` 改为必填；用例函数改名
  `createDevelopmentEmployeeWorkspace`，闭包开头的 `factory`、`now` 改取输入；6 处 `withAutomationWorkspaceEffects` 换成
  `withSelectedAutomationWorkspaceEffects`。其余（schema、辅助函数、全部分支与注释）逐字不变；读侧的数据库绑定与给 bootstrap 的装配函数
  逐字留在 composition。
- **快照与校验**：两个 application 文件与 HEAD 的 infrastructure 原文件相比，只多了文件头注释、改了两行 import（端口类型改取同层路径，
  `withAutomationWorkspaceEffects` 换成 application 的 `withSelectedAutomationWorkspaceEffects`），三个开作用域的函数工厂参数改为必填、
  `factory?.treeOperations` 相应改为 `factory.treeOperations`。
- **选定与校验**：`withAutomationWorkspaceEffects(f, …)` 就是 `withSelectedAutomationWorkspaceEffects(selectedAutomationWorkspaceEffects(f), …)`；
  `selectedAutomationWorkspaceEffects` 对已给出的工厂只校验三个方法、原样返回同一个对象，未给时选本机文件实现，不完整时抛
  `automation-workspace-effects-factory-incomplete`。用例作用域里只有 `input.automationWorkspaceEffects` 这一个工厂（装配时选定），6 处开作用域
  与快照、校验的调用都作用在它上面，去掉再次选定后作用域与结果相同。infrastructure 的三个包装：有 `treeOperations` 时把工厂原样交给
  application（远端优先、不校验，与此前相同）；没有时先选定再交（本机文件实现没有 `treeOperations`，走本机一支；不完整的工厂在 async 函数里
  抛错，调用方同样得到 rejection）。
- **常量**：`domain/gitMetadataOwnership.ts` 的 40 行与 HEAD `attemptSupport.ts` 第 43～82 行逐字相同（三组前缀与注释），`attemptSupport.ts`
  不再声明它们；`attemptSupport.ts` 与 `graph-development/employeeWorkspace.ts` 只改 import。
- **使用方与类型**：组合输入类型由 application 的输入类型推出，字段与可选性与此前逐个相同；bootstrap、`graphDevelopment.ts` 与取组合名字的
  用例的 import 不变，`tsc` 0 错。
- **public 与装配**：public 不变；composition 文件没有控制流语句；跨 context 引用 6 条原样随内容迁到 application（同样的 context 对与符号）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-495 转 Done 提交 `a8e04f58f` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-496 开发自动化的员工工作区用例迁出 composition（RFC-294 S10 第三步）`。走私有 index、按路径清单提交，在
共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
