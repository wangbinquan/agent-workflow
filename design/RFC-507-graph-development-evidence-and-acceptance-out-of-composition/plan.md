# RFC-507 实施计划

依赖：RFC-506（Done）；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation 的 `composition/graphDevelopment.ts`；装配入口不变）。
按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-507-T1 用例归 application**：设计执行端口的实现迁入 `application/graph-development/designExecution.ts`，证据、验收与两种档案列表迁入
  `application/graph-development/evidenceAcceptance.ts`（design D2）。
- **RFC-507-T2 composition 只装配**：`composeGraphDevelopment` 改为从新位置取实现，晚建的对象以转发函数交入，删去不再用的 import（design D3）。
- **RFC-507-T3 账本**：`counts.json` 一项收紧；guard-manifest 登记（design D4）。
- **RFC-507-T4 用例**：新增 RFC-507 用例（design §4）。
- **RFC-507-T5 集中验证**：backend `tsc`、eslint；RFC-507 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-507-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的新位置声明；`graphDevelopment.ts` 没有控制流、从新位置取实现；装配入口与交出的对象不变
- [x] AC-2 同样输入下执行端口、证据、验收、请求验证与档案列表的结果、错误与端口调用和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`fa4398837` 主 CI run 44504341206 的 70 个 job 第 1 次全部通过（见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 33～65，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库
与 `23d235187` 的树相同。验证期间 HEAD 没有前进。集中验证查出本 RFC 的一处缺陷，修正后复验了相关范围：

- **缺陷与修正**：候选 1（`23d235187` 的树加 6 个代码与账本路径）里，guard-manifest 给本 RFC 用例登记的条目漏了 `assertsAbsence: true`。
  本 RFC 用例断言清单里的名字不在别处声明、组合文件没有控制流，按 `tests/architecture/census.ts` 的判据属于断言“不存在”；
  `architecture/rfc317-guard-negative-fixture` 的“「谁在断言不存在」与账本 assertsAbsence 逐条相等”一例逐条比对，于是首批与全量里都红
  （RFC-505、506 的条目都标了这一项）。补上这一项（design §5 补记这一失败模式）。候选 2 只差账本里这一行；账本不改行为，所以只在候选 2 上
  重跑读 guard-manifest 的用例（见“复验”），行为用例的结果沿用候选 1 的，下文的复跑与放宽副本都在候选 2 上跑。
- **静态**：
  - backend `tsc` 退出码 0、无输出。
  - eslint `--max-warnings 0`：改动与新增的 4 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 3 个生产文件同样无告警。
  - prettier：改动的 TS 与本 RFC 的三件套通过。`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md`、`design/plan.md` 与
    `docs/audit-backlog.md` 按约定不跑。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：226 个文件。其中
  `tests/architecture/` 全部 140 个，另 86 个相关用例：
  - 直接或经用例侧的辅助与夹具取到组合文件或两个新文件的用例；
  - 按名字、路径与 `graph-material-unreadable`、`graph-acceptance-*` 错误串扫出的用例；
  - 直接取 bootstrap 的 `daemonModules/digitalEmployee.ts`、`daemonHttpComposition.ts` 或 `daemonApplication.ts` 的用例，以及取它们的
    用例侧辅助的用例；
  - 本 RFC 用例。

  结果：候选 2,349 条通过、344 条红（51 个文件；通过的含本 RFC 用例 13 条）；对照（少本 RFC 用例）2,341 条通过、339 条红（47 个文件）。
  - 本 RFC 用例 13 / 13。图开发的用例两边相同：
    - 经装配入口走证据与验收：`rfc396-current-evidence` 3 / 3、`rfc396-current-evidence-git` 2 / 2；
    - 图开发的其余用例：`rfc396-design-application` 16 / 16、`rfc396-execution-consumption` 20 / 20、
      `rfc396-graph-planning` 8 / 8、`rfc396-h6-reimplementation` 20 / 20、`rfc396-limitation-review` 32 / 32、`rfc396-review-regressions`
      16 / 16、`rfc396-registration` 10 / 10、`rfc396-workspace` 4 / 4、`rfc396-http` 2 / 2；
    - 钉交付桥字段的 `rfc498` 10 / 10；
    - `rfc396-verification` 与 `rfc396-mr-bridge` 两边都红一片（候选 24 与 29 条、对照 26 与 28 条），全部撞默认的 5 秒（`mr-bridge` 另有
      1 条撞自带的 30 秒），见下文复跑。
  - 逐文件比失败名，候选多出 10 条：
    - `rfc317-guard-negative-fixture` 1 条（上面的缺陷）；
    - 撞默认的 5 秒 6 条：`architecture/rfc359-w7-task-insert-lineage-completeness`、`rfc165-agent-launch`、`rfc311-mission-page`、
      `rfc370-port-artifact-bindings`、`rfc383-daemon-employee-automation-bundles` 与 `rfc396-mr-bridge` 各 1 条；
    - 撞用例自带的时限 3 条：`architecture/rfc400-collaboration-task-participants` 的负对照（30 秒）与 `tasks-multipart` 的 PostgreSQL
      一段 2 条（30 秒）。

    对照多出 5 条，都撞默认的 5 秒（`reviews-comment-patch`、`rfc370-port-artifact-bindings`、`rfc396-mr-runtime-wiring` 各 1 条，
    `rfc396-verification` 2 条）。

- **全量 SQLite**（候选 1；导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的
  时限照旧；清单按耗时从慢到快排，3 个 worker；与首批同时）：2,952 个文件，2,929 个通过（24,007 条通过、127 条按环境跳过），其余 23 个
  文件 28 条红：
  - `rfc317-guard-negative-fixture` 一条（上面的缺陷）；
  - 报告类用例撞自带时限 4 条：`rfc294-architecture-preflight` 两例（60 秒与 180 秒）、`rfc376-report`（300 秒）、
    `rfc370-committed-architecture-source`（150 秒），见下文放宽副本；
  - 发布账本 `rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里；
  - 等待或看门狗到点 4 条：`rfc167-dynamic-workflow-engine` 的 approve（`settleTask` 等满 5 秒时任务仍是 running）、`tasks` 的 diff 一例
    （仓库准备在等待时限内没有落定）、`rfc328-process-preactivation` 的业务时限一例（子进程没在业务时限内退出，读到 `timeout`）、
    `clarify-review-combination-scenarios` 的 S10 对照（用例自带的 20 秒流程看门狗取消了任务，读到 `canceled`）；
  - 撞用例自带时限 18 条：`architecture/rfc395-neutral-query-boundary`（60 秒）、`architecture/rfc400-collaboration-task-participants` 的
    负对照（30 秒）、`clarify-review-combination-scenarios` 的 S-RFC074（20 秒）、`lifecycle-property` 两例（15 秒）、
    `rfc098-wrapper-stale-redispatch` 两例（20 秒）、`rfc300-webhook-workspace-cleanup-e2e`（30 秒）、
    `rfc321-repository-publication-system-mock-e2e`（30 秒）、`rfc354` 的三个嵌套帧用例各一例（40、30 与 20 秒）、`rfc363-workspace-content`
    （30 秒）、`rfc395-v2-integration-restart`（35 秒）、`rfc395-v3-old-epoch-unpack`（25 秒）、`scheduler-audit-s04-git-wrapper-cumulative-diff`
    两例（20 秒）、`scheduler-rfc040-wrapper-await`（15 秒）。

  静态 import 闭包（含按路径起的夹具）取到本 RFC 改动的生产文件的有 262 个文件，其中 257 个通过。按改动文件分：`designExecution.ts`
  262 / 257、`evidenceAcceptance.ts` 262 / 257、组合文件 261 / 256。红的 5 个（`rfc167`、`rfc300`、`scheduler-audit-s04-git-wrapper-cumulative-diff`、
  `scheduler-rfc040-wrapper-await`、`tasks`）都是撞时限或等待到点，进下文的复跑。

- **复验**（候选 2，修正之后；账本不改行为，只重跑读 guard-manifest 的用例）：142 个文件，即直接读 `architecture/guard-manifest.json` 的
  用例，与经 `tests/architecture/census.ts` 或 `tests/architecture/rfc294Gates.ts` 读它的用例，加本 RFC 用例（SQLite，单条 60 秒，3 个
  worker）。139 个文件通过（1,473 条通过、4 条红），其中 `rfc317-guard-negative-fixture` 17 / 17、本 RFC 用例 13 / 13。红的 3 个都是
  报告类与负对照撞用例自带的时限：`rfc294-architecture-preflight` 两例（60 秒与 180 秒）、`rfc376-report`（300 秒）与
  `architecture/rfc400-collaboration-task-participants` 的负对照（30 秒），见下文放宽副本。
- **红文件放宽默认时限复跑**（候选 2；按首批的跑法，默认时限放宽到 60 秒、看门狗 3,000 秒，各 2 个 worker，与对照同时）：68 个文件，即首批
  任一边红过的 52 个与全量里红的 23 个合起来（70 个），去掉 `rfc317-guard-negative-fixture`（已在复验里重跑）与报告类的 `rfc376-report`。
  结果：候选 47 个通过、21 个红（1,073 条通过、33 条红），对照 48 个通过、20 个红（1,072 条通过、33 条红）。逐文件比失败名：
  - 两边共同红的 29 条失败名相同。24 条撞用例自带的时限：`lifecycle-property` 4 条（15 秒）、`scheduler-rfc040-wrapper-await` 5 条
    （15 秒，撞在 `beforeEach` 钩子上）、`scheduler-audit-s04-git-wrapper-cumulative-diff` 2 条（20 秒）、`rfc294-architecture-preflight`
    2 条（60 与 180 秒）、`rfc321-repository-publication-system-mock-e2e` 2 条（30 秒），`clarify-review-combination-scenarios`（20 秒）、
    `rfc300-webhook-workspace-cleanup-e2e`（30 秒）、`rfc354` 的两个嵌套帧用例（30 与 20 秒）、`rfc363-workspace-content`（30 秒）、
    `rfc370-committed-architecture-source`（150 秒）、`rfc384-daemon-intent-bundle`（15 秒）、`rfc395-v3-old-epoch-unpack` 的
    PostgreSQL 钩子（90 秒）与 `rfc396-mr-bridge` 的 PostgreSQL 一例（30 秒）各 1 条。另 5 条是等待到点或环境：`rfc167` 的 approve
    （`settleTask` 等满 5 秒时任务仍是 running）、`tasks` 的 diff 两例（仓库准备在 5 秒内没有落定）、`rfc395-v2-integration-restart` 的
    PostgreSQL 钩子（90 秒）与 `rfc321-repository-publication-ratchet`（账本记的提交不在导出仓库的历史里）。
  - 候选多出 4 条，都撞用例自带的时限，对照同一条在时限内通过：`architecture/rfc400-collaboration-task-participants` 的负对照（30 秒；
    对照 28.2 秒）、`rfc098-wrapper-stale-redispatch` 的 git wrapper 一例（20 秒；16.4 秒）、`rfc395-v3-old-epoch-unpack` 的 SQLite
    一例（25 秒；15.7 秒）、`tasks-multipart` 的 PostgreSQL 一例（30 秒；27.9 秒）。
  - 对照多出 4 条：`admin-only-gate` 的 PostgreSQL 钩子（放宽后的 60 秒）、`rfc098-wrapper-stale-redispatch` 的 loop wrapper 一例
    （20 秒）、`rfc396-mr-bridge` 的 SQLite 一例（30 秒）、`tasks` 的 diff 一例 SQLite（仓库准备在 5 秒内没有落定）。
  - 静态 import 闭包取到本 RFC 改动的生产文件的 48 个文件里，候选 41 个通过；红的 7 个（`rfc167`、`rfc300`、`rfc384`、
    `scheduler-audit-s04-git-wrapper-cumulative-diff`、`scheduler-rfc040-wrapper-await`、`tasks-multipart`、`tasks`）都是撞时限或等待
    到点，进下文的放宽副本。
- **放宽副本**（候选 2 与对照各一份、同时跑；按首批的跑法，3 个 worker，看门狗 6,000 秒）：副本只放宽用例自带的时限与等待，断言不动；
  跑完删掉，两个导出仓库回到原提交、没有未跟踪文件。13 个文件：
  - 报告类 3 个：`rfc294-architecture-preflight`（60、180 与 30 秒）、`architecture/rfc376-report`（300 秒）与
    `rfc370-committed-architecture-source`（150 秒），都放宽到 1,500 秒；
  - 取到本 RFC 改动的生产文件、在复跑里红的 7 个：`rfc167` 的 `settleTask`（5 → 50 秒）、`rfc300`（30 秒，等待 15 → 150 秒）、
    `rfc384`（15 秒）、`scheduler-audit-s04-git-wrapper-cumulative-diff`（两处 20 秒）、`scheduler-rfc040-wrapper-await`（15 秒）、`tasks`
    的仓库准备等待（5 → 50 秒）与 `tasks-multipart`（git、节点、流程看门狗与收尾等待四个时限）；
  - 候选在复跑里多出的另 3 个：`architecture/rfc400-collaboration-task-participants` 的负对照（两处 30 秒）、
    `rfc098-wrapper-stale-redispatch`（两处 20 秒）与 `rfc395-v3-old-epoch-unpack`（25 秒）。

  结果：两边各 181 条通过、1 条红；12 个文件两边全过（含 `rfc376-report` 16 / 16、`rfc294-architecture-preflight` 14 / 14、`tasks`
  58 / 58 与 `tasks-multipart` 20 / 20）。红的那条两边相同：`rfc395-v3-old-epoch-unpack` 的 PostgreSQL 一段撞测试辅助
  `rfc395V3Harness.ts` 自带的 90 秒钩子时限（副本没放宽辅助里的时限；复跑里两边也都红在这里）。候选在复跑里多出的 SQLite 一例，在副本里
  两边都通过（13.2 与 18.1 秒）。这个文件不取本 RFC 改动的代码。

- **架构报告**（`scripts/architecture-report.ts`，候选 2 与对照各出一份；候选 1 的那份除生成时间与源提交外与候选 2 相同）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-development-automation` 133 → 119。
    少掉的 14 条正是迁走的控制流：对照 `graphDevelopment.ts` 第 114、324、333 行的 `for`，第 115、258、325、335、404、412、429 行的
    `if`，第 250 行的 `try`，第 120、411、422 行的 `throw`；没有新增。
  - 生产文件 4,113 → 4,115（backend 3,249 → 3,251：两个新文件）。
  - 跨 context import 7,504 → 7,506：证据验收的新文件取 source-control public types 的 `CandidateDeliveryParticipant` 与
    `ChangeCandidateParticipant`，多两条类型边（`offered-consumption`）；组合文件为入参的类型留着自己的两条。
  - public surface 1,195 不变。四个面上的使用记账随代码移动：source-control 的 `CandidateDeliveryParticipant` 与
    `ChangeCandidateParticipant` 各多一个使用方（证据验收的新文件），部分字段与方法的使用改记到新文件的边上；source-control 的
    `RepositoryRevisionContentFactory` 有三个字段、digital-employee 的 `EmployeeCaseDetailProjectionInputV1` 的 `case.typeRef.revision`
    少记组合文件的边（按属性名记账，组合文件里不再有这些属性访问）。面的数目、方法、签名与预算都不变。
  - 模块符号归属 32,391 → 32,398：两个新文件本身与交出的 5 个名字，都在 application。
  - 变更入口 2,369 → 2,371：`createGraphDesignExecution` 与 `createGraphEvidenceAcceptance` 在 application 记为入口，组合层此前不计。
  - 其余各节逐项相同。
- **旧位置全仓扫描**（工作树，候选 2；对全部包、`e2e`、`scripts`、`.github`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，全部文件类型，
  已跟踪与未跟踪）：
  - 新名字（`createGraphDesignExecution`、`GraphDesignExecutionDependencies`、`createGraphEvidenceAcceptance`、
    `GraphEvidenceAcceptanceDependencies`、`listGraphVerificationProfileContents`）只出现在各自的新位置、组合文件、本 RFC 用例与本 RFC 的
    文档（含 RFC 索引）里。
  - 错误串 `graph-material-unreadable`、`graph-acceptance-candidate-mismatch`、`graph-acceptance-obligation-invalid` 除新位置、本 RFC 用例与
    文档外，只在按错误串断言的 `rfc396-current-evidence` 里。
  - 路径片段 `composition/graphDevelopment` 出现在 `counts.json` 的说明、bootstrap 的 `daemonModules/digitalEmployee.ts` 与 `integration.ts`
    （取装配入口与转出的名字）、`graphDesignRoutes.ts`（取 `GraphDevelopment` 类型）、两个 `rfc396-current-evidence` 用例（取装配入口）、
    `rfc498` 与本 RFC 用例，以及 `design/` 的历史记述（含 RFC-310 的 `os-architecture-manifest.json`：它记组合文件取 digital-employee 的
    public types，迁移后仍然成立，两个新文件不取 digital-employee，`rfc310-digital-employee-os-architecture` 在全量里通过）。它们取的装配
    入口、转出的名字与类型不变，都不改。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `23d235187` 的树加本 RFC 的 11 个路径（6 个代码与账本路径，以及
  design、plan、`STATE.md`、RFC-506 的 plan 与 `docs/audit-backlog.md`）。读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、
  `docs-runbook-command-guard`、`rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、
  `rfc317-stale-assertion-invariants`）重跑全过（33 / 33）。

## CI（AC-4）

- `fa4398837`（实现，父提交是 `23d235187`）：exact SHA 主 CI run 44504341206 的 70 个 job 第 1 次全部通过（含「Static scans」与
  `CI required`），未重跑。
- 本 RFC 的落档提交 `23d235187`（只改文档，同一提交记下 RFC-506 转 Done 提交 `0e8d143b9` 的 CI 当时仍排队）：主 CI run 44459633183
  共 70 个 job，第一次运行全部通过。没有重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：用脚本按词法单元比对五段函数体与 HEAD `composition/graphDevelopment.ts` 的原行（注释也比，只忽略换行与缩进），除下列替换外
  逐个相同：
  - 执行端口：第 98～138 行对 `designExecution.ts` 第 42～81 行（338 个词法单元）。替换 7 处，都是把装配里的取法换成依赖：
    `input.executions`、`input.readCase`、`artifacts.files`、`consumption.humanSources`、`consumption.reviewReceipt`、
    `workspace.resolveBaseline`、`care.continuationWorkspace` 改从 `deps` 取。`resolveRepositoryBaseline` 的返回式变短，prettier 把原来的
    两行并成一行。
  - 带内容的档案列表：第 158～171 行对 `evidenceAcceptance.ts` 第 29～42 行（102 个）。原来是箭头函数的表达式体，现在是 `return` 语句，
    只差这个关键字与原来末尾的逗号。
  - `latestVerification` 与 `currentEvidenceTarget`：第 223～260 行对第 65～102 行（245 个）。替换 4 处：`care.continuationWorkspace` →
    `deps.continuationWorkspace`，`workspace.state` → `deps.workspaceState`，`input.candidates` 与 `input.verification` 改从 `deps` 取。
  - `basis`、`evidence` 与交给路由的档案列表：第 311～379 行对第 106～174 行（549 个），没有替换：`store`、`artifacts`、`commands`、
    `queries` 与 `profiles` 从依赖解构，名字不变。
  - `accept`、`requestVerification` 与 `exportBasis`：第 389～481 行对第 175～267 行（555 个）。替换 2 处：`input.changed` 与
    `input.cases` 改从 `deps` 取。
- **接收者与晚绑定**：方法调用的接收者不变。`deps.candidates`、`deps.verification`、`deps.cases`、`deps.executions` 与 `deps.artifacts`
  就是原来的 `input.*` 与产物对象本身。`readCase` 与 `changed` 改从依赖对象调用；bootstrap 与两个 `rfc396-current-evidence` 用例交入的
  这两个函数都不用 `this`，新文件也不用 `this`。执行消费、员工工作区与交付桥仍在调用时才读：转发函数（如
  `(designId) => care.continuationWorkspace(designId)`）与原来闭包里的取法、时机相同。所以 `rfc396-current-evidence` 在装配之后给
  `graph.workspace.state`、`graph.care.continuationWorkspace` 与 `graph.commands` 装的替身照样生效（两个用例首批两边全过）。
- **装配与交出的对象**：`composeGraphDevelopment` 的入参与 `graph` 的字段名、次序不变。迁走的六个成员（`basis`、`evidence`、
  `verificationProfiles`、`accept`、`requestVerification`、`exportBasis`）取自证据验收用例的同名函数，它们不用 `this`，以函数值交出与原来
  的方法等价；`reviewLimitations` 收到的 `latestVerification` 与 `currentEvidenceTarget` 也是这组函数。员工工作区的 `verificationProfiles`
  改为 `() => listGraphVerificationProfileContents(profiles)`：与原来的 async 箭头函数一样，每次调用都重新读档案，出错时一样返回被拒的
  promise。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（984 行；`assertsAbsence` 见上文“缺陷与修正”）；
  钉交付桥字段的 RFC-498 用例不改，仍通过。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-506 转 Done 提交 `0e8d143b9` 的 CI 当时仍排队，
结果补记于实现提交）；实现与验证后再提交
`refactor(backend): RFC-507 开发自动化的图开发执行端口、证据与验收迁出 composition（RFC-294 S10 第十四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
