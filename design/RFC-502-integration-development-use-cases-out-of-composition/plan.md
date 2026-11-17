# RFC-502 实施计划

依赖：RFC-501（Done）；与 S12 共用模块 composition 文件（本 RFC 改 integration 的 `composition/developmentAdapterConfigOperations.ts`、
`composition/codeHostEffects.ts`、`composition/approvalGateway.ts`、`composition/digitalEmployeeToolConnections.ts` 与
`infrastructure/developmentToolConnectionStore.ts`，不改 bootstrap 与 `composition.ts`）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-502-T1 用例归 application**：四组用例原样迁入 application 的四个新文件，工具连接 store 的接口迁入 `application/ports/`，工厂改名为
  `create…`（design D2）。
- **RFC-502-T2 composition 只装配**：四个组合文件只留装配入口，审批的两条装配共用一份投影；infrastructure 的工具连接 store 改取端口文件
  （design D3）。
- **RFC-502-T3 锁、账本与注释**：6 个用例改取新位置；`rfc344`、`rfc321`、`rfc471`、`rfc466`、`rfc497` 改读新文件或两处都读；
  development-automation 的两处注释改写；`counts.json` 收紧（design D4）。
- **RFC-502-T4 用例**：新增 RFC-502 用例并登记 guard-manifest（design §4）。
- **RFC-502-T5 集中验证**：backend `tsc`、eslint；RFC-502 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，含 e2e、其他包与 `design/` 的 markdown 链接）。
- **RFC-502-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新文件声明；四个组合文件只声明允许的装配入口、没有控制流；改名前的名字与私有投影、目录函数没有
      声明；store 接口只在端口文件声明
- [x] AC-2 同样输入下四组用例的结果、错误码与端口调用和此前一致；bootstrap 取到的装配入口不变；审批的两条装配共用一份投影
- [x] AC-3 新文件的依赖面是闭集；跨 context 边、public surface 不升；`composition-control-flow-integration` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`7953576df` 主 CI run 44159454316 的 70 个 job 里 68 个通过，两格红都与提交无关（逐格归因见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 36～94，主要是本机其他进程）。验证在候选导出仓库里跑：`4bd91e405` 的树加本 RFC 的 25 个
路径，核对与工作树逐字相同；对照导出仓库与 `4bd91e405` 的树相同。验证期间 HEAD 没有前进。集中验证没有查出本 RFC 的问题，候选 1 即
定稿。

- **静态**：backend `tsc` 退出码 0、无输出（工作树，代码与候选逐字相同；`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0`：改动与新增的
  23 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 12 个生产文件同样无告警；prettier：改动的 TS 与本 RFC 的三件套通过
  （`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与 `docs/` 按约定不跑）。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：236 个文件
  （`tests/architecture/` 全部 140 个，以及 96 个相关用例：直接或经用例侧的辅助取到四个组合文件、新文件或工具连接 store 的用例、按名字与
  路径扫出的用例、直接取 bootstrap 的 `daemonModules/integration.ts`、`resourceCatalog.ts`、`repositoryCredentials.ts` 或
  `daemonApplication.ts` 的用例与取四个 daemon 装配辅助的用例，含本 RFC 用例）。候选 2,419 条通过、330 条红（62 个文件），对照（少本 RFC
  用例）2,418 条通过、331 条红（59 个文件）。
  - RFC-502 用例 11 / 11。改取新位置或改读新文件的用例：`rfc344-operation-catalog` 两边 23 / 23、`rfc466-…` 11 / 11、`rfc497-…` 13 / 13、
    `rfc359-w4-d13-adapters` 11 / 11、`rfc310-digital-employee-conflict-system-mock-e2e` 2 / 2、`rfc310-pr5-e2e-java` 2 / 2、
    `rfc310-t109-full-journey-e2e` 4 / 4；`rfc471` 与 `rfc321-repository-publication-ratchet` 两边各红同一例（`rfc471` 的负对照把相对路径
    `probe.ts` 交给 `relative(REPO_ROOT, …)`，结果随工作目录变：验证在 `packages/backend` 下起 bun，算出 `packages/backend/probe.ts`，CI 在
    仓库根跑、算出 `probe.ts`；`rfc321` 的发布账本记的提交不在导出仓库的历史里；两例在 HEAD 的 CI 上都绿）；
    `rfc310-digital-employee-system-mock-e2e` 候选 2 / 4、对照 1 / 4（两边都是 PostgreSQL 的两条旅程撞自带的 180 秒，对照另红 SQLite 的
    crewstation 一条），放宽副本见下文。只取装配入口的用例两边相同：`rfc359-w7-module-composition-roots` 12 / 12、
    `rfc359-w7-integration-composition-roots` 23 / 23、`rfc370-purpose-published-bindings` 2 / 2、`rfc349-development-integration-composition`
    2 / 2、`architecture/rfc380-daemon-module-bundles` 9 / 9；`rfc359-w4-d6a-adapters` 候选 5 / 6（一例 8.0 秒撞默认的 5 秒，对照 2.9 秒通过）。
  - 逐文件比失败名，候选多出 13 条、对照多出 14 条。候选多出的都撞时限（12 条撞默认的 5 秒，1 条撞自带的 30 秒）；对照多出的 13 条撞时限、
    1 条是 system mock 的 ECONNRESET。
- **红文件放宽默认时限复跑**（首批任一边红过的 63 个文件里，除报告类的 `rfc376-report` 外的 62 个；默认时限放宽到 60 秒、看门狗 3,000 秒，
  其余同首批）：候选 1,038 条通过、11 条红，对照 1,038 条通过、11 条红。首批候选多出的 13 条：12 条两边都过、1 条候选过而对照红，没有一条
  仍只红在候选。这一轮候选多出 3 条（`rfc395-af2-daemon-wiring` 两例与 `tasks-multipart` 一例，都撞自带的 30 秒），对照多出 3 条
  （`plugins-http` 两例在 0.1 秒内失败、`rfc395-af2-daemon-wiring` 一例撞 30 秒）。两边都红的 8 条里，`rfc310-digital-employee-system-mock-e2e`
  两例（180 秒）、`rfc384-daemon-intent-bundle` 一例（自带的 15 秒）、`rfc300` 与 `rfc167` 各一例的文件取到本 RFC 路径；
  `architecture/rfc400-collaboration-task-participants` 的源码扫描（自带时限）与发布账本一条不取；`rfc471` 的负对照见首批。候选多出的与两边
  都红、取到本 RFC 路径的文件都做了放宽副本（见下文）。
- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限照旧；
  清单按耗时从慢到快排，3 个 worker；与首批、复跑同时）：2,947 个文件、2,933 个通过（23,969 条通过、127 条按环境跳过）；其余 14 个文件
  16 条红，都不归本 RFC：
  - 三个报告类用例撞自带时限：`rfc294-architecture-preflight`（两例，60 秒与 180 秒）、`rfc376-report`（300 秒）、
    `rfc370-committed-architecture-source`（150 秒），见下文放宽副本。
  - 余下 11 个与对照同时、同样跑法 A/B（各 2 个 worker）：两边都是 81 条通过、10 条红。失败名逐文件相同，只有两处不同：
    `rfc098-wrapper-stale-redispatch` 候选多红 loop wrapper 一例（撞自带的 20 秒；对照红的 git wrapper 一例同样撞 20 秒、候选也红；这个
    文件的静态 import 闭包不取本 RFC 的任何路径）；`tasks` 这一轮候选 29 / 29、对照红 `GET /:id/diff includes untracked files`（等仓库准备的
    5 秒截止）。其余两边红在同样的用例：发布账本一条；撞自带时限的 `rfc354-nested-failure-modes`、`rfc354-nested-frames-closure`、
    `rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`（各 30 秒）、`rfc354-nested-loop-frames`（20 秒）、
    `lifecycle-property`（15 秒）；`rfc167-dynamic-workflow-engine` 的 approve 一条（`settleTask` 等满 5 秒时任务仍是 running）。
    `rfc363-workspace-content` 这一轮两边都过（全量里撞自带的 30 秒）。
  - 静态 import 闭包（含按路径起的夹具）取到本 RFC 改动代码的 283 个文件里 280 个通过（取到五个新文件的 261～278 个、取到四个组合文件的
    261～274 个、取到工具连接 store 的 261 个，各自只差这 3 个）；红的 3 个是 `tasks`（全量里两例等仓库准备超过 5 秒：“repository
    preparation did not settle”）、`rfc300` 与 `rfc167`，它们的放宽副本见下文。
- **放宽副本**（候选与对照同时，按首批的跑法、各 2 个 worker；默认时限与用例自带的时限都放宽到 1,500 秒，`tasks` 等仓库准备的截止 5 → 500 秒、
  `rfc167` 的 `settleTask` 等待 5 → 50 秒、`tasks-multipart` 的流程时限 20 → 600 秒（git 与节点 10 → 100 秒、收尾 5 → 50 秒），其余逐字）：
  10 个文件两边都全过（各 175 / 175）。
  - 三个报告类用例：`rfc376-report` 16 / 16（byte-identical 那一例候选与对照都是 492 秒，超出自带的 300 秒）、
    `rfc294-architecture-preflight` 14 / 14（595 / 593 秒）、`rfc370-committed-architecture-source` 2 / 2（那一例 271 / 257 秒，超出自带的
    150 秒）。
  - 直接取本 RFC 新文件与旧审批装配的 `rfc310-digital-employee-system-mock-e2e` 4 / 4（两种 provider 的 crewstation 与 direct 旅程；最长的
    一条 314 / 356 秒，超出自带的 180 秒）。
  - 全量 SQLite 里红、取到本 RFC 路径的 3 个：`tasks` 58 / 58（两种 provider）、`rfc300-webhook-workspace-cleanup-e2e` 2 / 2、
    `rfc167-dynamic-workflow-engine` 29 / 29。
  - 复跑里候选多出或两边都红、取到本 RFC 路径的 3 个：`rfc395-af2-daemon-wiring` 18 / 18、`tasks-multipart` 20 / 20、
    `rfc384-daemon-intent-bundle` 12 / 12（超出自带 15 秒的那一例 17.3 / 25.0 秒）。
  - 跑完删除副本，两个导出仓库恢复干净。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的
  `max`）：
  - `composition-control-flow-integration` 57 → 17：少掉的 40 条正是四个组合文件的全部（12 + 11 + 10 + 7），没有新增；integration 其余组合
    文件逐个相同。
  - 生产文件 4,102 → 4,107（backend 3,238 → 3,243：application 的四个新文件与一个端口文件）。
  - 跨 context import 7,503 → 7,503：context 对 135 → 135，没有新的符号；6 条随内容迁到新文件（`@/auth/actor` 的类型、`@/util/errors`
    三条、`@/util/hash`、resource-catalog 的 `public/queries`）。
  - public surface 1,195 → 1,195（resource-catalog `public/queries` 的使用方边随 import 换成新文件）；模块符号归属 32,368 → 32,374（组合文件
    与 infrastructure 的 18 项迁成 application 的 19 项，另加 5 个新文件的文件条目；多出的是 `createDevelopmentAdapterConfigOperations` 与
    `DevelopmentAdapterConfigOperationsDeps`——组合文件仍留 `composeDevelopmentAdapterConfigOperationsFor`——两份私有投影合成一个工厂少
    一项）；变更入口 2,350 → 2,357（七个 `create…` 工厂在 application 记为七项，组合层此前不计）；其余各节逐项相同。
- **旧位置全仓扫描**（工作树）：代码里的字符串字面量（AST，排除注释）对全部包、`e2e`、`scripts` 与 `.github` 扫一遍，命中 64 处（import
  25 处、字面量 39 处），都是预期的：import 都取留下的装配入口或新文件；字面量里，按路径读文件的锁已改读新文件或两处都读（`rfc344`、
  `rfc321`、`rfc466`、`rfc471`、`rfc497`），`rfc349` 读的两个组合文件与 `rfc317-table-ownership` 记的工具连接 store 仍在；其余是同名的属性与
  变量名（`developmentApprovalGateway`、`approvalGateway`、`developmentAdapterConfigOperations`）、一个用例标题与 RFC-502 用例的常量与
  负对照（25 处）。没有文件从组合文件取迁走的名字；`design/`、`docs/` 与 `STATE.md` 里没有指向这四个文件的链接；`docs/env-flags.md` 第
  98 行说 `AW_APPROVAL_MOCK_URL` 由 `composition/approvalGateway.ts` 从进程环境透传，迁移后仍然成立（旧的审批装配留在那里）。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `4bd91e405` 的树加本 RFC 的 27 个路径（25 个代码与账本路径和这两份
  文档），读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、`rfc-index-status-drift`、
  `rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `7953576df`（实现，父提交是 `4bd91e405`）：exact SHA 主 CI run 44159454316 的 70 个 job 里 68 个通过，另两格红都与提交无关：
  - 「Static scans」的 dependency audit gate（high+critical）：本提交不改任何依赖清单与锁文件，同一步骤在父提交的 run 44109573487
    通过；依赖面相同，变化在外部的审计数据，按用户规则不分析、只记录。
  - backend 分片 42/44：`routes-inventory` 的 PostgreSQL 一例 5,255ms 撞默认的 5 秒（同文件其余 0.6～1.1 秒；随后一条 builtin 工作流的
    查询在清理之后报错）。它走 provider 应用的打开与清单路由，本 RFC 不改它们的运行时行为；本机高负载下这个文件 PostgreSQL 的 11 条
    在 HEAD 与改动后同样 5.7～6.1 秒撞 5 秒。不以重跑追绿：按 `docs/dev-gotchas.md` 给这个文件 30 秒预算的用例修正另行提交
    （`249e9f0b0`，同一提交让 `rfc471` 的负对照与工作目录无关）；它的主 CI run 44171615750 第 1 次 backend 分片全部通过（含 `routes-inventory` 与 `rfc471`），另三格红与它无关：同一项依赖审计、`design/` 的链接检查（RFC-378 的 `research.md` 里两个 github.com 外链回 503，文件未改动）、macOS 的 e2e 分片 4/4 没有分到 runner；只重跑失败的作业，第 2 次的结果记在下一个 RFC 的落档提交。
- 本 RFC 的落档提交 `4bd91e405`（只改文档）：主 CI run 44109573487 第 1 次 70 个 job 里 69 个通过，macOS 的 e2e 分片 4/4 没有分到 runner
  （0 个步骤，“The job was not acquired by Runner of type hosted even after multiple attempts”，同时有 macOS 容量受限的提示），与提交无关；
  只重跑这一个作业，第 2 次通过（17 个步骤），70 个 job 全部通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **配置操作**：脚本比对新文件与 HEAD 原文件，差异只有 design D2 列的几处——文件头、import 路径按新目录改写并加 `DevelopmentAdapterStore`
  类型、`DevelopmentAdapterConfigOperationsDeps` 接替组合输入（`store` 代替 `db`、`now` 必填）、工厂改名、函数体开头两行改为取传入的
  store 与时钟；操作对象逐字。组合文件按 `input.db` 建 store、`now` 缺省取进程时钟，与此前那两行相同，返回的就是工厂的结果。
- **代码托管桥**：四个工厂改名、import 路径按新目录改写，函数体逐字；`composeDevelopmentCodeHostDelivery` 留在组合文件，函数体只换四个
  工厂名。
- **审批网关**：新文件的投影与 HEAD 第 109～174 行逐字相同（迁移脚本先断言第 18～83 行与之逐字相同）；旧的那条装配把原 `gateway` 第
  11～17 行内联——进程环境快照、`approvalMockUrl` 缺省取 `AW_APPROVAL_MOCK_URL`、交给旧执行适配器的对象字面量键序不变；选定绑定的那条
  只把 `selectedGateway` 换成新工厂。两种执行适配器的接口结构相同（`tsc` 通过）。
- **工具连接目录**：函数体逐字；store 接口原样迁到端口文件，infrastructure 改取它，实现不变。
- **用例与注释**：用例只改 import、函数名与读的路径，断言不变或对两处都断言；development-automation 的两处注释只改名字与位置。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交补记 RFC-501 转 Done 提交 `183febdb9` 的 CI）；实现与验证后
再提交 `refactor(backend): RFC-502 集成的开发适配器配置、代码托管交付、审批网关与工具连接目录迁出 composition（RFC-294 S10 第九步）`。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
