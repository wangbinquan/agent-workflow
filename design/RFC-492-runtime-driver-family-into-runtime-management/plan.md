# RFC-492 实施计划

依赖：RFC-491（Done，`18189b794`）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态
自查。

## 任务

- **RFC-492-T1 搬迁**：`services/runtime/**` → `modules/runtime-management/infrastructure/drivers/**`（结构不变）；
  `services/execution/{agentInjection,workspaceBoundary}.ts` → `drivers/`；插件入口改取 `@/embed.generated`；一族取本模块的 import 改为
  模块内相对路径、取声明处（design D1、D2）。
- **RFC-492-T2 public 撤下 14 个只供一族的出口**（design D2）。
- **RFC-492-T3 runtime-management 的 16 个使用方改取模块内路径**。
- **RFC-492-T4 bootstrap**：`composition/runtimeDrivers.ts`；`daemonApplication.ts` 的启动自检；资源策略束迁为
  `bootstrap/taskExecutionResourceDependencies.ts`，`daemonModules/taskExecution.ts` 改取（design D3）。
- **RFC-492-T5 驱动租约夹具**迁入 `tests/helpers/`，RFC-108 的四个用例改取（design D4）。
- **RFC-492-T6 守卫与配置**：eslint 围栏、`scripts/build-binary.ts` 的插件目录、三份 workflow 的路径过滤、`commons-debt.json`、
  `commons-manifest.json`、`counts.json`、`guard-manifest.json`；两份现行契约文档与描述现行位置的源码注释（design D5）。
- **RFC-492-T7 用例**：91 个测试文件的 import 说明符；43 个带路径字面量的逐条改指（发布账本夹具不改）；RFC-213 启动根逆变换；新增
  RFC-492 用例（design §4）。
- **RFC-492-T8 集中验证**：backend 与 shared `tsc`、eslint；RFC-492 与受影响用例；全量 SQLite 与 PostgreSQL lane（与 HEAD 同时 A/B）；
  按 CI 的跑法跑相关文件；架构报告对照；单二进制构建核对嵌入表；全仓旧路径扫描。
- **RFC-492-T9 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `services/runtime/`、`services/execution/` 不再有文件，`services/driverLease.ts` 不在生产树；一族在 runtime-management 的
      `infrastructure/drivers/`；生产代码只有 runtime-management 自己 import 它，bootstrap 经 composition
- [x] AC-2 同样输入下行为一致（插件嵌入、启动自检、资源策略束、按运行时围栏、workflow 触发）
- [x] AC-3 legacy 服务实现 46 → 6；legacy 横向文件 165 → 125；不可达生产文件 16 → 15；inbound 边 9 → 0；跨 context 内部文件对、越 DAG 的
      值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`1e732c7cc` 主 CI run 43457865029 的 70 个 job 里 65 个通过，红的四格逐格归因（链接检查归本
      RFC，`45735edf2` 修复；分片 43/44 一条 runner 时序、两个 macOS e2e 分片没分到 runner），后继 run 43459006078 补齐这四格；按路径触发的
      integration-opencode、windows-platform、visual-regression-nightly、maintenance-soak-nightly 通过（见 §CI）

## 集中验证（2026-11-13，候选 1～4 基于 `f12a8c45b`，候选 5、6 基于 `691cf408b`）

本机全程高负载（10 核；采样到的 1 分钟负载 35～79，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后
重新同步，核对与工作树逐字相同；对照导出仓库与 HEAD 的树相同。验证期间 `origin/main` 前进一次，是另一会话只改文档的 `691cf408b`
（RFC-490 的 plan、proposal、`STATE.md` 与 `docs/audit-backlog.md`），与本 RFC 的路径无交集；候选 5、6 与对照都同步到它之上（同步后
逐个路径核对，0 处不符）。

集中验证与实现门查出本 RFC 的问题，都在本 RFC 范围内修正（design §6 细化 1～6）：

1. backend `tsc` 5 处：`rfc370-agent-material-evidence`、`rfc465` 从 public 取撤下的类型，改取声明处（细化 5）。
2. 首批红在本 RFC 的 5 个文件：
   - `rfc317-module-boundary` 的 R1：新的 bootstrap 文件没有登记为装配根（细化 2）；
   - `rfc349-provider-cutover`：四条 provider 专属依赖债随一族进 `infrastructure/` 已不成立，销账（细化 3）；
   - `rfc376-structural-guards`：`export-star-barrels` 2 > 1（细化 1）；`counts.json` 的 public 类型偏差实测 56 低于上限 57，收紧
     （细化 4）；
   - `rfc294-architecture-preflight`：逐条清单里撤下的 `modelKey` 一条过期（细化 4）；
   - `rfc465`：public 交出的只剩持久化端口（细化 5）。
3. 实现门自审：发布登记的布局表认不出新位置（细化 6）。

另有两处开发期的遗漏在验证前补上：旧路径扫描漏了分段拼接的写法（`'services', 'runtime', …`，9 个文件）；正则批量改 import 连带改到
三处夹具字符串（细化 5）。两条都写进了 `docs/dev-gotchas.md`。

- **静态**：
  - backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）：候选 1 报的 5 处修正后为 0，候选 5 重跑仍为 0；shared `tsc` 0 错；
    `scripts/release-upgrade` 的 `tsc` 0 错（候选 5）。
  - eslint `--max-warnings 0`：backend 的 `src` 与 `tests` 全量、e2e、shared 无告警；promises 规则集（backend 的 `src`）无告警。候选
    5、6 改动的用例另跑无告警。
  - prettier 检查通过：改动的 TS、三份 workflow 与本 RFC 的 design、plan（候选 5、6 改动的 TS 另查）。按仓库约定，
    `architecture/*.json`、`STATE.md` 与 `docs/` 不跑 prettier。
- **首批**（候选 2，134 个文件：`tests/architecture/` 全部、本 RFC 改动的用例、读文档与账本的用例）：127 个通过，其余 7 个：
  - 本 RFC 的问题 5 个，即上面 2；
  - 撞用例自带时限或内部等待 2 个：`rfc376-report` 用例时限 300 秒；`rfc370-execution-effect` 两条（等本机目标启动 10 秒等），全量与
    A/B 里两边同形（见下）。
- **修复批**（候选 3）：10 个文件 152 条全过（本 RFC 用例、`rfc317-module-boundary`、`rfc349-provider-cutover`、`rfc465`、三个
  库存插件用例、RFC-317 的三个账本用例）；随后 `rfc376-structural-guards` 221 条（56.8 秒）与 `rfc294-architecture-preflight` 14 条
  （141.9 秒）在较轻的负载下全过。
- **全量 SQLite**（候选 4）：导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒（用例
  自带时限的照旧），4 个 worker。2,935 个文件、2,923 个通过（23,863 条通过、127 条按环境跳过）；其余 12 个都不归本 RFC：
  - 发布账本一条（`rfc321-repository-publication-ratchet`「…reproducible from reachable history」）：导出仓库没有真实历史，对照导出
    仓库上同样红（与 RFC-483～491 相同）。
  - 撞用例自带时限、内部等待或看门狗的 11 个：`rfc376-report` 300 秒；`rfc294-architecture-preflight` 180 秒与 60 秒；
    `rfc370-committed-architecture-source` 150 秒；`clarify-review-combination-scenarios` 流程 20 秒（看门狗取消任务）；`rfc400`、
    `rfc300`、`rfc354-nested-frames-closure`、`rfc363-workspace-content` 各一条 30 秒；`rfc354-nested-loop-frames` 20 秒；
    `rfc167` 的 `settleTask` 5 秒；`rfc370-execution-effect` 等本机目标启动 10 秒。
  - 与对照同时、同样跑法 A/B（各 3 个 worker）：9 个非报告类文件两边红的文件与条数逐个相同（通过 / 红：`rfc400` 5 / 1、`rfc167` 28 / 1、
    `rfc300` 1 / 1、`rfc354-nested-frames-closure` 0 / 1、`rfc370-execution-effect` 12 / 1、`rfc363-workspace-content` 3 / 1、发布账本
    9 / 1），耗时相近；`clarify-review-combination-scenarios` 与 `rfc354-nested-loop-frames` 这一轮两边都过。`rfc376-report` 在候选 3 上与对照
    A/B：两边都撞 300 秒（候选 640.7 秒、对照 662.3 秒）；`rfc294-architecture-preflight` 见修复批。
    `rfc370-committed-architecture-source` 在候选 6 与对照上同时跑，两边都撞默认的 150 秒（290 秒、292 秒）。两个报告类用例各做一份
    只放宽时限的副本（150 秒、300 秒 → 1,500 秒）在候选 6 上跑：`rfc370-committed-architecture-source` 2 / 2 通过（最慢 315 秒），
    `rfc376-report` 16 / 16 通过（最慢 366 秒）；跑完删除副本。
- **按 CI 的跑法**（候选 5，两种 provider 同进程、默认 5 秒、`--randomize`，2 个 worker，接 PostgreSQL；与对照同时、同样跑法）：132 个
  文件（本 RFC 与 RFC-487～491 用例、本 RFC 改动的用例与它们的双引擎使用方、读 guard-manifest 与 `counts.json` 的架构用例、文档对账
  用例、发布登记用例；PostgreSQL lane 的 30 个双引擎文件都在其中）。候选 1,733 条里 1,692 条通过、1 条按环境跳过（本 RFC 用例 17 / 17），对照（少本 RFC 用例）1,709 条里 1,667 条通过、1 条跳过。
  两边红的都是 9 个文件，其中 8 个相同，逐条比对：
  - 形状相同：`rfc376-report` 撞 300 秒；`rfc294-architecture-preflight` 撞 180 秒（对照另多一条 60 秒）；`rfc328-architecture-guards`
    同一条撞默认 5 秒；`inventory-in-flight-fallback` 11 条、`runtime-routes` 11 条、`rfc234-config-intent-runtime` 5 条都在
    PostgreSQL 一侧撞 5 秒；`rfc238-mcp-runtime-test-service` 候选 7 条、对照 8 条，共同 6 条，都在 PostgreSQL 一侧。
  - 只在对照红：`rfc370-execution-effect` 一条（内部等待）。
  - 只在候选红：`rfc223-pr6-injection-identity` 的 PostgreSQL 一侧多一条撞 5 秒（同进程 SQLite 一侧三条全过，走的是同一段托管注入同名
    冲突判定）；`rfc363-task-preparation-admission` 的 SQLite 一侧一条（本机 git HTTP 服务在负载下没列出 `main`，24.7 秒，走
    source-control 与 task-execution，本 RFC 没有改动这条路径）。这两个文件随后两边同时、同样跑法各跑
    3 轮：`rfc223-pr6` 候选每轮红 2、2、1 条，对照 2、2、2 条，都在 PostgreSQL 一侧，对照也红候选那一条；`rfc363` 候选 3 轮全过，对照
    第 2 轮红另一条。是负载下的时限形态，不归本 RFC（候选的绿不作通过依据）。
  - 本 RFC 用例在这一轮里最慢的一条 4.1 秒（② 读全部生产文件并解析），离默认 5 秒太近：改为 ② ③ 共用一次解析，读全部生产文件的三条
    给 30 秒（只改用例，断言不变），guard-manifest 的行数随之 498 → 522。
- **候选 6**（`691cf408b` 加 258 个候选路径，只比候选 5 多上面这处用例改动、guard-manifest 的行数与本 RFC 的 design）：backend `tsc` 0 错；
  本 RFC 用例与读 guard-manifest 的四个用例按 CI 的跑法全过（本 RFC 用例 17 / 17，冷读的那一条 4.0 秒，其余不超过 0.11 秒）。
- **最终候选**（候选 7，`691cf408b` 加 260 个路径）：只比候选 6 多本 plan、`STATE.md`、`docs/dev-gotchas.md` 与 design 的文档改动。文档
  对账用例（`docs-implementation-parity`、`rfc-index-status-drift`、`test-suite-policy`、`rfc294-design-parity`、
  `docs-runbook-command-guard`）与本 RFC 用例按 CI 的跑法全过。
- **架构报告**（`scripts/architecture-report.ts`，候选 6 与对照 `691cf408b` 各出一份；候选 2 对 `f12a8c45b` 先采过一次，那时还差细化 1
  与 4）：
  - 60 项实测都在 `counts.json` 的 `max` 内。变的 4 项正好是收紧后的 `max`：`legacy-horizontal-files` 165 → 125、
    `legacy-service-implementations` 46 → 6（一族 36 个、`services/execution` 的三个与驱动租约夹具）、`unreachable-production-files`
    16 → 15（驱动租约夹具移出；库存插件 `.mjs` 换了位置，仍按路径加载）、`public-surface-deviations` 57 → 56（`modelKey` 的开放类型）。
    `export-star-barrels` 保持 1；跨 context 内部文件对、越 DAG 的值边与 offered 文件对、未消费 public 符号不变；直接 `setInterval`
    点 14 个不变（一处换路径）。
  - public surface 1,209 → 1,195（撤下 14 个出口）；facade 46 → 6；生产文件 4,086 不变（backend 3,222：迁走 40 个、迁入 40 个）。
  - 跨 context import 7,620 → 7,503，删 166 条、增 49 条：runtime-management 取一族的 98 条与一族取 runtime-management 的 61 条成了
    模块内的边，一族取 resource-catalog `public/` 的 7 条改记在 runtime-management 名下（删 7 增 7）；一族取 `util/`、`platform/` 与嵌入表
    的 37 条（29、7、1）改记在 runtime-management 名下；bootstrap 取 composition 的 5 条。
- **全仓旧路径扫描**（`git ls-files` 加未追踪文件，按旧目录的全路径、分段拼接与尾段三种写法，含 `scripts/`、`.github/` 与
  `architecture/`）：迁走的文件在仓内只剩已完工 RFC 的历史记录与注释、`architectureReport.ts` 有意保留的遗留路径目标表、RFC-487～491
  与本 RFC 用例里的一族集合和负对照夹具，以及发布账本与 L2 批准清单里已发布 tag 的原因字符串（描述的是那些 tag 的布局）。开发期
  第一轮扫描漏了分段拼接（9 个文件），实现门自审查出按后缀认文件的发布登记（细化 6）。改动文档里的相对链接都有效（`dev-gotchas`
  里三处形似链接的代码文本 HEAD 上就有）。

## CI（AC-4）

- `1e732c7cc`（实现，父提交是另一会话只改文档的 `691cf408b`）：exact SHA 主 CI run 43457865029 的 70 个 job 里 65 个通过，「CI required」
  随下面四格红：
  - 「Markdown link check (design/)」红，归本 RFC：`design/RFC-370-crewstation-hosted-deployment/evidence.md` 第 14 行的 markdown 链接仍指
    迁走的 `services/runtime/types.ts`（Lychee：File not found，全部链接里唯一一处）。集中验证的旧路径扫描把 `design/` 当历史记录整个
    排除，漏了这条链接。`45735edf2`（只改文档）把它改指新文件的 `RuntimeDriver` 接口，教训写进 `docs/dev-gotchas.md`；后继 run
    43459006078 的这一格通过。
  - Backend tests（ubuntu-latest shard 43/44）红一条：`scheduler-clarify-dispatch` 的 PostgreSQL 一例「clarify rerun (retry=0,
    clarifyIter=N+1) beats a stale higher-retryIndex done row」撞默认 5 秒（5581 ms，第一轮任务停在澄清门之后、第二轮还没启动）。不归
    本 RFC：用例与它走的调度器澄清重跑路径本 RFC 都没改；父提交 `691cf408b` 与 `f12a8c45b` 的主 CI 同一分片同一例 1.1 秒、1.7 秒；本机按
    CI 的跑法与对照同时各跑 3 轮，这一例两边都红（负载下全文件两边各红 8～10 条），逐条平均耗时两边相同（合计 100.5 秒对 101.1 秒）；
    这个文件在这一分片上此前六次以同样形态到点（RFC-401、RFC-422、RFC-429、RFC-445、RFC-450、RFC-474 的 CI），其中三次随后给到点的那
    一例加了 20 秒显式预算（RFC-423、RFC-430、RFC-446）。未重跑；本 RFC 转 Done 时照先例给这一例加 20 秒显式预算。后继 run 43459006078
    的这一分片通过。
  - Playwright e2e（macos-latest shard 1/4、3/4）被取消：GitHub 注记「The job was not acquired by Runner of type hosted even after multiple
    attempts」与 macOS arm64 runner 容量受限，作业没有分到 runner、一步都没跑，不归本 RFC。同一 run 里 macOS 2/4、4/4，ubuntu 3 个与
    windows 4 个 e2e 分片都通过（e2e 跑在单二进制上，库存插件从新位置嵌入）；后继 run 43459006078 的 macOS 1/4、3/4 通过。
- 同一推送按路径触发的四个 run 都通过：
  - integration-opencode run 43457865369（`opencode latest (ubuntu)`、`opencode 1.18.3 (ubuntu)`）：本 RFC 改了它的路径过滤（一族整个
    换了位置）。两个 job 各 15 条：5 条门控用例通过，10 条要调真实 opencode 的用例因为 run 里没有模型凭据按门控跳过（与 RFC-491 相同），
    不算真实 opencode 的运行证据。
  - windows-platform run 43457865095：本 RFC 改了它的 14 处路径过滤，这个 job 在 Windows 上跑读一族的契约用例。
  - visual-regression-nightly run 43457865152：本 RFC 改了它的路径过滤（`opencode/util.ts`）。
  - maintenance-soak-nightly run 43457865137：按 `bootstrap/daemonApplication.ts` 的路径过滤触发（本 RFC 只改了那里启动自检的取处）。
- `45735edf2`（链接修复，只改文档）：主 CI run 43459006078 的 70 个 job 里 68 个通过，含实现的 run 里红的链接检查、backend 分片 43/44 与
  macOS e2e 1/4、3/4；Playwright e2e（macos-latest shard 4/4）同样因 runner 容量被取消（没有分到 runner，一步都没跑），这一格在实现的
  run 里通过；「CI required」随之红。
- 本 RFC 的落档提交 `f12a8c45b`（只改文档）：主 CI run 43413966880 通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。查出一处并已修正（design §6 细化 6，发布登记的布局表），其余逐项与 HEAD 比对未发现行为差别，
结论 PASS：

- **搬迁的 40 个文件**（一族 36 个、`agentInjection`、`workspaceBoundary`、资源策略束、驱动租约夹具）逐个与 HEAD 的原文件比对：改动只在
  import 说明符（模块内相对路径、取声明处）；注释改了三处描述旧位置的说明（`claudeCode/inject.ts`、`opencode/inlineConfig.ts`、
  `types.ts`），另在插件入口、资源策略束与驱动租约夹具加了 RFC-492 的说明。函数体逐字未变。`types.ts` 的转出按声明处拆成几段，转出的
  名字不变。runtime-management 的 16 个使用方与 bootstrap 两处只改 import，其余生产文件只改注释。
- **插件入口**：`export * from './transcoder'` 改为四个具名转出，`transcoder.ts` 只导出这四个函数。`PLUGIN_FILES` 改取
  `@/embed.generated`：`persistenceHead`、`grammars`、`managedProcessLauncher`、`gitCredentialLease` 已是同一写法，构建在
  `Bun.build({ files })` 里按绝对路径替换 `src/embed.generated.ts`，别名解析到同一路径，单二进制照旧从嵌入表取插件。构建的插件目录改指
  新位置，目录里有 `aw-inventory-dump.mjs`（用例 ⑥）。
- **public 撤下 14 个出口**：backend `tsc` 0 错，生产与用例里没有读者；同组仍有模块外读者的成员照旧交出（用例 ④ 正向对照）。
- **bootstrap**：`composition/runtimeDrivers.ts` 只转出；启动自检取的是一族的同一组函数，入参与调用时点不变；资源策略束三个字段与
  runtime-management、shared 的函数引用相等，字段与次序不变（用例 ⑤）。
- **驱动租约夹具**逐字迁入 `tests/helpers/`，只加头注；RFC-108 的四个用例改取。
- **配置**：eslint 围栏按深度列出新位置的别名与相对写法（RFC-282 的围栏用例逐深度探针，一族内部的 `./opencode/x` 照旧放行）；三份
  workflow 的路径过滤改指新位置；`scripts/record-opencode.ts` 的注释与两份现行契约文档改指新位置。
- **发布登记**（查出）：`scripts/release-upgrade/registry.ts` 按后缀找每个 tag 的 OpenCode 探测、按旧路径读驱动，本 RFC 之后切出的 tag
  在发布后的登记会停住。布局表移进 `lib/model.ts` 并追加新布局（细化 6）；已登记的 80 个 tag 的两种探测位置照旧认得，原因字符串与 L2
  批准清单不变（用例 ⑥）。另对本机的 80 个 release tag 逐个离线比对（读 Git 对象，不联网）：新布局表选出的探测与原写法、
  `releases.json` 的登记都相同，L2 判定读到的驱动内容逐字相同。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-492 运行时驱动一族整族迁入 runtime-management infrastructure（RFC-294 §4.7 运行时驱动一族第五步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。删除或搬迁文件后按 `git ls-files` 扫全仓旧路径（含
workflow 的 `paths:` 过滤、构建脚本与账本锚点）。
