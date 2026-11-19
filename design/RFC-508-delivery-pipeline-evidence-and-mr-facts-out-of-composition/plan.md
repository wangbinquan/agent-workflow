# RFC-508 实施计划

依赖：RFC-507（Done）；与 S12 共用模块 composition 文件（本 RFC 只改 development-automation 的 `composition/pipelineEvidence.ts` 与
`composition/developmentDelivery.ts`；装配入口不变）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与
格式的静态自查。

## 任务

- **RFC-508-T1 端口**：`application/ports/reconcilerPorts.ts` 增 `SelectedPipelineEvidenceRunnerPort`（design D2）。
- **RFC-508-T2 实现归 application**：流水线证据端口的选定实现迁入 `application/selectedPipelineEvidence.ts`，MR 事实的读取与采集迁入
  `application/developmentMrFacts.ts`（design D3）。
- **RFC-508-T3 composition 只装配**：四个装配入口改为从新位置取实现，采集的时钟由装配传入，删去不再用的 import（design D4）。
- **RFC-508-T4 账本**：`counts.json` 一项收紧；guard-manifest 登记（`assertsAbsence: true`；design D5）。
- **RFC-508-T5 用例**：新增 RFC-508 用例（design §4）。
- **RFC-508-T6 集中验证**：backend `tsc`、eslint；RFC-508 与受影响用例按 CI 的跑法与 HEAD 同时 A/B；全量 SQLite；架构报告对照；全仓旧位置
  扫描（名字、路径片段、代码里的字符串字面量，另按全部文件类型扫，含 e2e、其他包与 `design/` 的 JSON 与 markdown）。
- **RFC-508-T7 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；两个组合文件没有控制流、从新位置取实现；四个装配入口与交出的对象不变
- [x] AC-2 同样输入下流水线证据端口、MR 事实读取与采集的结果、错误与端口调用和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；`composition-control-flow-development-automation` 收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`f07489c9c` 的 run 44546732110 70 个 job 里 68 个通过，两格红是 runner 分配失败（环境，见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 61～174，主要是本机其他进程）。验证在候选导出仓库里跑（`1e2af4f0c` 的树加本 RFC 的 8 个代码与
账本路径，核对与工作树逐字相同）；对照导出仓库与 `1e2af4f0c` 的树相同。验证期间 HEAD 没有前进。没有查出本 RFC 的缺陷：

- **静态**：
  - backend `tsc` 退出码 0、无输出。
  - eslint `--max-warnings 0`：改动与新增的 6 个 TS 文件无告警，`eslint.promises.config.js` 的规则对其中 5 个生产文件同样无告警。
  - prettier：改动的 TS 与本 RFC 的三件套通过。`architecture/` 的账本按 `.prettierignore` 不进 prettier，`STATE.md` 与 `design/plan.md` 按约定
    不跑。
- **首批**（按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 2 个 worker；与对照同时、同样跑法）：215 个文件。其中
  `tests/architecture/` 全部 140 个，另 75 个相关用例：
  - 直接或经用例侧的辅助与夹具取到两个组合文件或两个新文件的用例；
  - 按名字、路径与 MR 事实采集的错误串扫出的用例；
  - 本 RFC 用例。

  结果：候选 2,178 条通过、305 条红（53 个文件；通过的含本 RFC 用例 18 条）；对照（少本 RFC 用例）2,159 条通过、306 条红（54 个文件）。
  - 本 RFC 用例 18 / 18。钉着这两个文件、装配入口或交付桥的用例两边相同、全过：`rfc471-development-delivery-code-host-bridge` 17 / 17、
    `rfc502` 11 / 11、`rfc349-development-integration-composition` 2 / 2、`rfc370-purpose-published-bindings` 2 / 2、
    `rfc370-purpose-staging-lifecycle` 8 / 8、`rfc310-t109-full-journey-e2e` 4 / 4、`architecture/rfc380-daemon-module-bundles` 9 / 9。
  - 逐文件比失败名，两边共同红的失败名相同。候选多出 5 条，都撞时限，对照同一条在时限内通过：默认的 5 秒 4 条（`cached-repos-http` 1 条、
    `reviews-comment-patch` 2 条、`rfc311-mission-page` 1 条），`rfc395-q1-clarify-history` 自带的 20 秒 1 条。对照多出 6 条，同样都撞
    时限：`architecture/rfc400-collaboration-task-participants` 的负对照（30 秒）、`architecture/rfc425-execution-authority-deployment`
    （5 秒）、`reviews-comment-patch`（5 秒）、`rfc395-af2-daemon-wiring`、`rfc396-registration` 与 `tasks-multipart` 的 PostgreSQL 一段
    （各 30 秒）。
  - `rfc321-repository-publication-ratchet` 读 `developmentDelivery.ts` 的一例（个人凭据只留在 Git 发布与它的身份探测里）两边都通过，
    共 9 例通过；发布账本一例两边都红（账本记的提交不在导出仓库的历史里）。`rfc294-architecture-preflight` 的 symbol-root 允许清单记着
    暂存命名空间的开放 `object` 字段首先经 `assertEvidenceStagingFactory` 到达：做这项比对的一例与另一例全语料扫描两边都撞自带的 60 与
    180 秒，其余 12 例两边都通过，见下文放宽副本。

- **全量 SQLite**（导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例自带的时限
  照旧；清单按耗时从慢到快排，3 个 worker；与首批同时）：负载升到 174 后进度很慢，为加快推进跑完较慢的 1,441 个文件后停下，余下的
  1,512 个文件里取到改动代码的另跑（见“补跑”）。1,441 个文件里 1,431 个通过（12,837 条通过、10 条按环境跳过），其余 10 个文件 12 条红：
  - 发布账本 `rfc321-repository-publication-ratchet`：账本记的提交不在导出仓库的历史里；
  - 报告类撞自带时限 3 条：`rfc294-architecture-preflight` 两例（60 与 180 秒）、`architecture/rfc376-report`（300 秒）；
  - 撞用例自带时限 5 条：`rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`、
    `rfc354-nested-frames-closure`、`rfc363-workspace-content` 与 `rfc395-v3-content-inventory`（各 30 秒）；
  - 等待到点 3 条：`rfc167-dynamic-workflow-engine` 的 approve（等满 5 秒时任务仍是 running）、`tasks` 的 diff 两例（仓库准备在 5 秒内
    没有落定）。

  静态 import 闭包（含按路径起的夹具）取到本 RFC 改动的文件的有 308 个文件，其中 305 个通过；取到两个组合文件或两个新文件的 248 个文件里
  245 个通过（其余 60 个只经 `reconcilerPorts.ts` 取到，这个文件只多一个类型）。红的 3 个（`rfc167`、`rfc300`、`tasks`）都是撞时限或
  等待到点，见下文放宽副本；其余 7 个不取改动的代码。

- **补跑**（全量清单里没跑的 1,512 个文件中，静态 import 闭包取到改动的有 63 个，去掉首批已跑的 6 个；按首批的跑法与对照同时，各 3 个
  worker）：57 个文件，其中 9 个取到两个组合文件或两个新文件，48 个只经 `reconcilerPorts.ts`（只多一个类型）取到。结果：候选 431 条通
  过、11 条红（9 个文件），对照 433 条通过、9 条红（7 个文件）。两边共同红的 9 条失败名相同：撞默认的 5 秒 7 条（`repos-path-allowlist` 与
  `rfc338-maintenance-status` 各 2 条，`rfc310-pr7-webhook-order-matrix`、`rfc398-health-database` 与 `rfc436-module-inbound-http-bindings`
  各 1 条），`rfc349-mcp-runtime-test-daemon-identity` 撞自带的 20 秒 1 条，`rfc370-m3-hosted-database-restore` 的恢复一例两边都在本机的测试
  环境里报同一条连接类型错误（`connection must be a PostgresSQLConnection`；只经端口文件取到）。候选多出 2 条，对照同一条通
  过：`rfc370-m0-database-skill-content` 的 PostgreSQL 一例撞自带的 30 秒（对照 29.8 秒）；`rfc370-v3-hosted-write-window` 的“fenced 写互不
  等待”一例没在 400 ms 的落定窗口内完成（只经端口文件取到）。两条都见下文放宽副本。
- **放宽副本**（候选与对照各一份、同时跑，单条 1,500 秒）：副本只放宽用例自带的时限与等待，断言不动；跑完删掉，两个导出仓库回到原提交、没有
  未跟踪文件。
  - 全量里取到改动代码、撞时限或等待到点的 3 个（SQLite）：`rfc167` 的状态等待（5 → 50 秒）、`rfc300`（30 秒，等待 15 → 150 秒）与 `tasks`
    的仓库准备等待（5 → 50 秒）。结果两边相同、全过：`rfc167` 29 / 29、`rfc300` 2 / 2、`tasks` 29 / 29。另按原样同时重跑 `tasks` 一次，两边
    也都通过（只作参考）。
  - 补跑里候选多出的 2 个（按首批的跑法）：`rfc370-m0-database-skill-content` 的 30 秒与 `rfc370-v3-hosted-write-window` 的落定窗口（400 →
    4,000 ms）。两边都全过：12 / 12 与 7 / 7。
  - 报告类的 `rfc294-architecture-preflight`（SQLite；60、180 与 30 秒都放宽）：两边都 14 / 14，首批里撞时限的两例分别用了 231 与 1,145 秒
    （对照 227 与 1,110 秒）。
- **RFC-349 的交付 provider 边界**：`rfc349-digital-development-provider-boundary` 点名这两个文件，在全量清单里排在未跑的一半，按首批的
  跑法单独跑，两边都是 5 / 5。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差一项（= 新的 `max`）：`composition-control-flow-development-automation` 119 → 102。
    少掉的 17 条正是迁走的控制流：对照 `pipelineEvidence.ts` 第 24、33、35、50、52、61、68、70、79 行，`developmentDelivery.ts` 第 84、
    129、136、140、142 行（分支）与第 130、143、145 行（`throw`）；没有新增。
  - 生产文件 4,115 → 4,117（backend 3,251 → 3,253：两个新文件）。
  - 跨 context import 7,506 不变：MR 事实采集取 `@/util/hash` 的那条边从 `developmentDelivery.ts` 移到 `developmentMrFacts.ts`。
    `off-dag-offered-file-context-pairs` 仍是 45（application 不取 integration）。public surface 1,195 不变，各面的使用记账逐项相同。
  - 模块符号归属 32,398 → 32,406：两个新文件本身、它们交出的 5 个名字与端口类型 `SelectedPipelineEvidenceRunnerPort`，都在 application。
  - 变更入口 2,371 → 2,374：`createSelectedPipelineEvidence`、`createDevelopmentMrFacts` 与 `createDevelopmentMrFactsCollector` 在
    application 记为入口，组合层此前不计。
  - 其余各节逐项相同。
- **旧位置全仓扫描**（工作树；对全部包、`e2e`、`scripts`、`.github`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，全部文件类型，已跟踪
  与未跟踪；按词边界）：
  - 新名字（`createSelectedPipelineEvidence`、`SelectedPipelineEvidenceRunnerPort`、`createDevelopmentMrFacts`、
    `createDevelopmentMrFactsCollector` 与两个依赖类型）只出现在两个新文件、端口文件、两个组合文件、本 RFC 用例与本 RFC 的文档（含 RFC
    索引与 `STATE.md`）里。只按前缀才会撞上的是 integration 自己的 `createDevelopmentMrFactsSource`、`createSelectedPipelineEvidenceAdapter`
    与 integration 的 `composition/pipelineEvidence.ts`，与本 RFC 无关。
  - MR 事实采集的四条错误串除新位置外，只在按错误串断言的 `rfc471`、`rfc310-t109-full-journey-e2e`、integration 的
    `developmentCodeHostDelivery.ts`（它自己的文案）与 RFC-471、RFC-508 的文档里。
  - 两个组合文件的路径出现在 bootstrap 的 `daemonModules/developmentAutomation.ts` 与 `digitalEmployee.ts`（取装配入口）、本模块
    `public/participants.ts` 的注释、development-automation 组合层内的
    `./pipelineEvidence`、`rfc321`、`rfc349-digital-development-provider-boundary`（按文件名读）、两个 `rfc370`、`rfc471` 与本 RFC 用
    例、`counts.json` 的说明，以及 RFC-310、RFC-370、RFC-471、RFC-502 的历史记述里。它们取的装配入口与所述事实不变，都不改。integration 自己
    的 `composition/pipelineEvidence.ts` 另有取用方，与本 RFC 无关；`.agent-workflow/` 与 `.architecture-report/` 下是 git 忽略的本机产物。
- **收口文档**：plan 与 `STATE.md` 定稿后，候选导出仓库同步到 HEAD `1e2af4f0c` 的树加本 RFC 的 11 个路径（8 个代码与账本路径，以及 plan、
  `STATE.md` 与 RFC-507 的 plan）。读这几处文档与 RFC 索引的 6 个用例（`docs-implementation-parity`、`docs-runbook-command-guard`、
  `rfc-index-status-drift`、`rfc310-ac-evidence-index`、`review-iterate-sibling-cascade`、`rfc317-stale-assertion-invariants`）重跑
  全过（33 / 33）。

## CI（AC-4）

- `f07489c9c`（实现，父提交是 `1e2af4f0c`）：exact SHA 主 CI run 44546732110 的 70 个 job 里 68 个通过（含「Static scans」与 backend 全部分
  片）。没通过的两格：`Playwright e2e (macos-latest shard 2/4)` 没有分到 GitHub 托管的 macOS runner（注记“The job was not acquired by Runner
  of type hosted even after multiple attempts”，另有 macOS arm64 容量不足的提示；一步也没跑）而被取消，`CI required` 随之红。归因：托管
  runner 的容量，与本提交的内容无关；未重跑。这一分片在同一棵 backend / 前端树上的结果由后继提交（本 RFC 转 Done 的提交，只改文档）的 CI 给
  出，补记于 RFC-509 的实现提交（后继证据）。
- 本 RFC 的落档提交 `1e2af4f0c`（只改文档，同一提交记下 RFC-507 转 Done 提交 `155d8c0fc` 的 CI 当时仍排队）：主 CI run 44511189599
  共 70 个 job，第一次运行全部通过。没有重跑。
- 补记（RFC-509 的实现提交）：后继证据：转 Done 的 `afd425c00`（父提交是 `f07489c9c`，只改 `STATE.md` 与 `design/`）的主 CI run
  44555911052 共 70 个 job，第一次运行全部通过（含 `Playwright e2e (macos-latest shard 2/4)` 与 `CI required`）。没有重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：用脚本按词法单元比对迁走的函数体与 HEAD 的原行（注释也比，只忽略换行与缩进：两个端口对象离开外层包装后整体少缩进两格），
  除下列替换外逐个相同：
  - 流水线证据：HEAD `composition/pipelineEvidence.ts` 第 19～25 行（失败类型、`failed` 与三个暂存工厂的核对）对
    `selectedPipelineEvidence.ts` 第 16～22 行（69 个词法单元）；第 28～81 行（collect、trigger、rerun）对第 24～77 行（374 个），没有替换。
  - MR 事实读取：HEAD `composition/developmentDelivery.ts` 第 81～110 行对 `developmentMrFacts.ts` 第 18～47 行（215 个），没有替换。
  - MR 事实采集：第 125 行（`provider`）对第 67 行（6 个），第 128～168 行对第 69～109 行（250 个）。替换 1 处：`Date.now()` → `deps.now()`。
- **端口类型**：`SelectedPipelineEvidenceRunnerPort` 只写实现读到的字段：collect 的 envelope 是 `PipelineCollectEnvelopeDto`、另带输出预算，
  trigger 与 rerun 的 envelope 只写交出的三个字段，失败是 `OperationFailureReceipt`。integration 的执行面在装配处按结构满足它（`tsc` 0 错），
  组合文件仍取 integration 的类型。`RunnerFailure` 由端口推出，与原来一样是 collect 失败分支的 `failure`。
- **时机与接收者**：三个暂存工厂仍在装配入口被调用时核对（新函数在装配入口里同步调用）。端口方法的接收者与调用次序不变；新文件不用 `this`。
  `deps.mrFacts` 改为装配时取出交入：两个装配入口的入参在 bootstrap 与用例里都是现写的对象字面量，取出时机不同不可观察。采集的时钟在
  `collect` 里调用，与原来读 `Date.now()` 的位置相同；装配交入的是 `() => Date.now()`，每次调用都读当前时刻。
- **装配与交出的对象**：四个装配入口的名字、入参与返回类型不变；`pipelineEvidence`、`mrFacts`、`mergeRequestFacts` 取自新位
  置，`repoRemote`、`mrEffects` 与 `composeDevelopmentPipelineDeps` 不变。`developmentDelivery.ts` 删去 `canonicalDigest`、`projectMrCells`
  与 `sha256Hex` 的 import，`pipelineEvidence.ts` 删去两个暂存核对函数的 import；文件头注释指向新位置。
- **账本与锁**：`counts.json` 一项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（975 行，`assertsAbsence: true`）；钉着这两个文件与
  装配根的 RFC-471、RFC-321、RFC-349 与 RFC-370 用例不改，读这两个文件的各例都通过（RFC-321 的发布账本一例在导出仓库里因历史不全而红，
  与对照相同，留给 CI）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-507 转 Done 提交 `155d8c0fc` 的 CI 当时仍排队，
结果补记于实现提交）；实现与验证后再提交
`refactor(backend): RFC-508 开发自动化的流水线证据端口与 MR 事实采集迁出 composition（RFC-294 S10 第十五步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
