# RFC-489 实施计划

**前置**：RFC-488（Done，`9ff1274b0`，Done 文档 `ca08a9365`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                                                          | 依据              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-489-T1 | runtime-management：composition 增本机与托管的运行时管理装配（迁自 task-execution 的两个根，探测族经效果自有的探测端口注入）；材料定义以 `evidence(scope)`、`materialReference(plan)` 取代 `evidenceHooks`                                                                    | design D1、D4     |
| RFC-489-T2 | task-execution：本机探测族改用材料定义的协议与运行证据，删 `NativeProtocolBinding`；本机调用改收 `evidence` 与 `materialReference`；只供契约用例的本机任务运行收材料定义                                                                                                      | design D2、D4     |
| RFC-489-T3 | task-execution：系统代理（本机、托管）、任务代理（本机）与探测（本机、托管）的根改为「输入 + 提供者」，不再 import 其他模块的 composition 与 infrastructure；`composeLocalTaskRunSelection` 收任务代理族的提供者；`crewstationExecution` 不再产出运行时管理与系统代理族的选择 | design D1、D3     |
| RFC-489-T4 | bootstrap：运行族的提供者绑定（一个文件）；standalone 与 CrewStation 的选择改取它；部署档案的选择签名在 bootstrap 声明；一族的两个运行器改用一族自己的包装                                                                                                                    | design D1、D3、D4 |
| RFC-489-T5 | 新增 RFC-489 用例并登记 guard-manifest；三份精确账本销去 21 对、`counts.json` 收紧；既有用例按新装配改指                                                                                                                                                                      | design §3、§4     |
| RFC-489-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                                         | design §5         |

## 验收清单

- [x] AC-1 task-execution 的生产文件对 runtime-management 只取 `public/`；21 个跨 context 内部文件对销账；运行族的提供者与运行时管理的
      装配由 bootstrap 绑定
- [x] AC-2 同样输入下行为一致（运行时管理装配与探测回执钩子、探测族的协议与运行证据、各运行族的提供者、本机调用的材料引用与运行证据、
      夹具）；协议未知这一走不到的输入除外（design §6 细化 5）
- [x] AC-3 跨 context 内部文件对 43 → 22；越 DAG 的值边与 offered 文件对不升；public surface 不增；减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-12，候选基于 `ccc856852`）

本机全程高负载（10 核；采样到的 1 分钟负载 26～75，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后
重新同步，核对与工作树逐字相同。对照导出仓库与 HEAD 相同。验证期间 `origin/main` 只前进一次：另一会话的 `0df2df21e`（17:38）只改
前端 10 个文件，与本 RFC 的路径无交集，后端也没有用例读这些文件；候选内容未变，结果沿用，提交落在它之上。

开发期按 RFC-482 的做法，用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言。差异 110 条（HEAD 命中、候选不命中 70 条；候选
新命中 40 条），逐条核对都无害：

- 「HEAD 命中、候选不命中」：本 RFC 用例自己的反向断言；扫描用例里的正则（`rfc328`、`rfc421`、`rfc422`）；用例自己 import 的说明符
  （本机任务代理根原来也有同样的 import，现在移到 bootstrap）；`commons-debt.json` 的 R1 条目出自 `services/runtime/index.ts`（仍在）；
  `join()` 里的 `infrastructure` 路径段。
- 「候选新命中」：`rfc380` 新登记的两个工厂名（只查调用）、泛型参数 `configuration`、后继元数据的 `/RFC-\d+/` 正则、`rfc370` 准备夹具
  的字段名也出现在 `NativeAgentEvidenceScope`。

集中验证与实现门查出本 RFC 的两处问题：

1. **新 bootstrap 文件没登记**（首批即红）：`bootstrap/runFamilyProviders.ts` 是新的装配文件，没进 `tests/architecture/census.ts` 的
   `BOOTSTRAP_FILES`（允许 import 模块 composition 的 bootstrap 文件清单），`rfc317-module-boundary` 的 R1「legacy → module
   composition」多出 17 条边。登记后修复批全过。教训记入 `docs/dev-gotchas.md`。
2. **本机探测族不再在打开时取驱动**（实现门自审）：协议未知时原来打开即抛错，现在编译时抛同一条错、收成 `spawn-failed`。这条路走
   不到，`rfc422-port-bindings` 又钉住「编译前不选材料」，不改代码（design §6 细化 5）。同一用例第二例的探测夹具还留着已删的
   `bindProtocol` 提供者，删去。

- **静态**：
  - backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`；候选 1 与最终候选各跑一次）；
  - eslint `--max-warnings 0`：改动的 60 个 TS 文件无告警；promises 规则集：改动的 23 个源码文件无告警；
  - prettier 检查通过：改动的 TS、本 RFC 三件套与 `windows-platform.yml`。按仓库约定，`architecture/*.json` 不进 prettier，`STATE.md`
    等不跑 prettier。
- **RFC-489 用例**：
  - 候选上 10 / 10，最慢一条 0.9 秒；
  - 对 HEAD 的代码，整个文件在加载处报错（它 import 了候选才有的 runtime-management 装配）。①～⑤ 去掉这些 import 与 ⑥ 的对拍后另存
    副本对 HEAD 跑：红 6 条，负对照绿。
- **首批**（候选 1，636 个文件：`tests/architecture/` 全部、本 RFC 改动的用例、按改动的模块与 helper 名找出的读者、字面量扫描命中的
  用例，去重后）：626 个通过（5,878 条通过、46 条按环境跳过），其余 10 个：
  - 本 RFC 的问题 1 个：`rfc317-module-boundary`，即上面 1；
  - 发布账本 1 个：`rfc321-repository-publication-ratchet`（导出仓库没有真实历史，见下）；
  - 撞用例自带时限的 8 个：`rfc376-report` 的子进程 300 秒（被杀后报「architecture source revision is unavailable」）、`rfc400` 30 秒、
    `clarify-review-combination-scenarios` 的流程 20 秒、`rfc167-dynamic-workflow-engine` 的 `settleTask` 5 秒、
    `rfc300-webhook-workspace-cleanup-e2e` 30 秒、`rfc354` 两个（30 秒、20 秒）、`rfc363-preparation-process-recovery` 的检查点 30 秒。
- **修复批**（候选 2）：11 个文件 339 条全过（rfc317 四个守卫账本用例、`rfc389`、本 RFC 用例、`rfc376-structural-guards`、`rfc328`、
  `rfc294-design-parity`、`rfc422-run-family-openers`、`rfc380`）。
- **全量 SQLite**（候选 2）：导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例
  自带时限的照旧，5 个 worker。2,931 个文件、2,917 个通过（23,799 条通过）。其余 14 个都不归本 RFC：
  - 发布账本一条（`rfc321-repository-publication-ratchet`「…reproducible from reachable history」）：导出仓库没有真实历史，HEAD 的对照
    导出仓库上同样红（与 RFC-483～488 相同）。
  - 撞用例自带时限或内部等待的 12 个：`rfc376-report` 的子进程 300 秒；`rfc370-committed-architecture-source` 的默认 150 秒；
    `clarify-review-combination-scenarios` 的流程 20 秒；`rfc363-task-workspace-process-recovery` 与 `rfc363-preparation-process-recovery`
    的检查点 30 秒（1 条、2 条）；`rfc400`、`rfc300`、`rfc354-nested-frames-closure`、`rfc363-workspace-content` 各一条 30 秒；
    `rfc354-nested-loop-frames` 一条 20 秒；`rfc167` 的 `settleTask` 5 秒；`rfc370-execution-effect` 一条等本机目标启动 10 秒。
  - `rfc310-digital-employee-system-mock-e2e` 一条：托管一例开头给 system mock 播种时连接被对端重置（`ECONNRESET`），还没进任务执行；
    直连一例 99 秒通过。原样重跑 2 / 2。
- **放宽时限的副本**（候选 2）：只改时限常量；两个 `rfc363` 进程恢复照 RFC-486 另加 `ready.json` 的轮询兜底（负载下 FSEvents 会丢
  改名事件），`rfc370-execution-effect` 照 RFC-482 另加标记文件的轮询兜底。范围是上面撞时限的 12 个文件，12 个副本全过：`rfc167`
  29 条、`clarify-review-combination-scenarios` 18 条、`rfc376-report` 16 条（623 秒）、`rfc370-execution-effect` 13 条、
  `rfc363-task-workspace-process-recovery` 8 条、`rfc363-preparation-process-recovery` 7 条、`rfc400` 6 条、`rfc363-workspace-content`
  4 条、`rfc370-committed-architecture-source` 2 条（381 秒）、`rfc300` 2 条、`rfc354` 两个各 1 条。
- **PostgreSQL**（候选 2；下面的 A/B 与副本在最终候选上）：102 个文件接 PostgreSQL 跑：本 RFC 改动的双引擎用例；`memoryDistill`、`intentResourceCatalogBinding`、
  `daemonEmployeeAutomationBundle`、`daemonTaskExecutionBundle`、`changeNarrativeSystemAgents` 五个改动 helper 的全部双引擎使用方；
  `eachProviderTaskExecution`、`taskExecutionTestTopology`、`runner` 三个 helper 各 6 个使用方；`rfc380`、`rfc391` 两个守护进程图用例。
  两种 provider 同进程、`--randomize`、单条 60 秒，3 个 worker：1,873 条里 1,859 条通过（PostgreSQL 一侧 872 条里 858 条）。红的 14 条
  都在 PostgreSQL 一侧，同进程的 SQLite 一侧全过：
  - `scheduler-clarify-inline`、`scheduler-rfc040-wrapper-await` 各 5 条：先是 `beforeEach` 撞用例文件的默认 15 秒，随后的 generation
    围栏、`Connection closed` 与 `graph-builtin-implementer-missing` 是超时后拆库的连带；`scheduler-cross-clarify-dispatch` 3 条撞 60 秒。
  - `rfc366-execution-end-enqueue` 一条：两次入队之间只留 200 毫秒余量（`nextRunAt <= before + 5_000 + 200`），整条跑了 4.9 秒；这是
    memory 的去抖，本 RFC 未触及。
  - 这四个文件与 HEAD 的代码同时、同样跑法 A/B：候选的 PostgreSQL 一侧红 15 条（三个 scheduler 文件 5、5、5），HEAD 红 14 条（5、4、5），
    形状相同（钩子撞 15 秒、用例撞 60 秒）；`rfc366` 两边都过。
  - 三个 scheduler 文件放宽时限（15 秒、60 秒 → 900 秒）的副本在候选上：`scheduler-clarify-inline`、`scheduler-rfc040-wrapper-await` 各
    10 / 10（PostgreSQL 一侧各 5 / 5）；`scheduler-cross-clarify-dispatch` 17 条里 16 条通过。另一条在 119.6 秒处撞
    `task-execution-stale-owner`（「managed-process recovery was fenced」：效果静默后的进程恢复加锁时 owner 已变）。它不经本 RFC 改动的
    代码；同一副本随后在候选与 HEAD 的代码上同时、同样跑法各跑一轮，都是 17 / 17。按 CLAUDE.md 不以重跑为据，登记进
    `docs/audit-backlog.md`（第十三条）。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选 2 vs HEAD 的代码出的报告）：
  - 门通过；60 项实测都在 `counts.json` 的 `max` 内。唯一变化是 `cross-context-internal-file-pairs` 43 → 22，`max` 已收紧到实测
    （C13）。`composition-control-flow-runtime-management` 23、`composition-control-flow-task-execution` 43 不变（发现只随行号重新
    编键）。越 DAG 的 offered 文件对 46、context 值级越 DAG 对 0、类型偏差 57、`module-layer` 1、application 直接副作用 2、legacy 横向
    文件 167、legacy 服务实现 48 不变，各 context 的未消费 public 符号不变（合计 91）。
  - public surface 1,208 不变；目标边 100 → 104（4 条虚线，design §6 细化 1）。
  - 后端生产文件 3,221 → 3,222（新增 3 个、删除 2 个）。
  - 跨 context import 7,668 → 7,656，删 33 条、增 21 条：
    - 删去的 33 条：task-execution 指向 runtime-management、resource-catalog、source-control 内部的边（含探测族的 `getRuntimeDriver`
      与提供者类型里的 `RuntimeDriver`），以及 bootstrap 指向删掉的 task-execution 两个根的边。
    - 增加的 21 条：`bootstrap/runFamilyProviders.ts` 指向 runtime-management、resource-catalog、source-control、task-execution
      composition 的 19 条（装配根的允许形状）；task-execution 指向 runtime-management `public/` 的 `AgentMaterialEvidence` 类型 2 条。
  - 变更入口清单 2,337 条不变：删 task-execution 的 `createCrewStationRuntimeManagement`，增 bootstrap 的
    `RuntimeManagementSelectionInput`。
  - 一族之外 import 一族的生产文件 31 → 30：task-execution 17 → 16（本机探测族不再取驱动），runtime-management 12、bootstrap 2 不变。
- **全仓旧路径扫描**（`git ls-files`）：删掉的两个 task-execution 根在仓内只剩已完工 RFC（416、421、422）的历史记录；
  `windows-platform.yml` 两份路径过滤改指新位置。
- **最终候选（候选 3）**：候选 2 之后只改了 `rfc422-port-bindings` 第二例的探测夹具（删去已不存在的 `bindProtocol`）与文档：本 plan、
  design（细化 5）、`STATE.md`、`docs/dev-gotchas.md`、`docs/audit-backlog.md`。生产代码自候选 2 未变，全量 SQLite、全量那一批放宽时限的副本、PostgreSQL 一节
  与架构报告沿用候选 2 的结果。
  - 按 CI 的跑法（两种 provider 同进程、默认 5 秒、`--randomize`）跑本 RFC 与 RFC-487、RFC-488 用例，本 RFC 改动的用例，读
    guard-manifest、`counts.json`、三份精确账本与 RFC-294 登记的用例，两个扫 `tests/` 的用例与文档对账用例：48 个文件 730 条里 721 条
    通过。RFC-489 用例最慢一条 1.3 秒。
  - 红的 9 条都是撞时限。PostgreSQL 一侧 7 条：`change-narrative`、`rfc370-task-agent-family-drive` 各 2 条与
    `rfc359-w8-runtime-participants-conformance` 1 条撞默认 5 秒，`rfc384-daemon-intent-bundle` 2 条撞默认 5 秒与用例自己的 15 秒。另有
    `rfc294-architecture-preflight` 2 条撞用例自己的 180 秒与 60 秒（负载下扫全仓）。同样的文件在 PostgreSQL 一节（单条 60 秒）或全量
    SQLite 里全过。
  - 这五个文件与 HEAD 的代码同时、同样跑法 A/B：候选红 17 条（`change-narrative` 10、`rfc294-architecture-preflight` 2、`rfc359-w8` 1、
    `rfc370-task-agent-family-drive` 2、`rfc384` 2），HEAD 红 16 条（9、2、1、2、2）。分布相同，不归本 RFC。
  - 导出仓库与 HEAD 加 72 个候选路径逐字相同（同步后逐个路径核对，0 处不符）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS。自审查出一处行为差别，走不到，见集中验证第 2 条。逐项比对：

- **材料定义的运行证据与材料引用**：`evidence(scope)` 即原来的 `createLocalAgentMaterialEvidence({ hooks: driver, scope })`，驱动是同一个
  单例；`materialReference(plan)` 即 `bindNativeAgentMaterialReference(plan)`，读的是编译器登记引用的同一张 WeakMap。用例 ⑥ 与原构造
  对拍。
- **本机调用**（`bindNativeAgentInvocation`）：在原来读驱动钩子的时点读一次 `input.evidence`。准备阶段在 getter 里构造与原来相同的
  scope（`environment` 取计划的环境，`runContent`、`sessionLocation`、`liveLocation` 原样），`onTaskSnapshot` 的立即执行函数仍先跑；
  材料引用仍惰性取。
- **本机探测族**：协议与运行证据取自材料定义，与原来手工构造的 `bindProtocol(driver)` 与驱动钩子出自同一个驱动；编译时对请求的读取
  次序不变（协议、目标、模型、额外参数、沙箱标记）。协议未知时的差别见上。
- **只供契约用例的本机任务运行**：协议改为每次选材料时取一个包装（原来每次绑定取一个）；包装只有无状态的 getter，外部看不出。
- **运行族的根**：提供者的调用次序与原来相同（系统代理：先 `runtimes()`、再 `contents(input)`；任务代理：先运行时绑定、再材料引用）。
  task-execution 自己的逻辑（绑定适配、配置冻结、产出校验、夹具选择）留在根里，未改。
- **运行时管理的装配**：`composeLocalRuntimeManagement` 原样迁自 task-execution 的根：先建诊断目标，在同一时点建探测族；效果的三个输入
  经 getter 惰性转读；探测回执钩子照旧恢复到应用的依赖上。bootstrap 的选择对观测模块交来的对象逐项转读。
- **托管形态**：执行装配的 `hostedAgents` 去掉两项能力读取后，与原来托管系统代理族收的输入相同（原来就没有这两项；浅拷贝）。托管运行时
  管理收到与原来相同的能力读取（同一个缓存读取器）与 `initialCapabilities`，只有键序不同；托管探测照旧收完整的输入。
- **一族的两个运行器**（`services/systemAgentRun.ts`、`services/runtimeSmoke.ts`）：改用 `bindNativeAgentMaterialEvidence(driver, scope)`
  与 `getNativeAgentMaterialReference(plan)`，与原来的构造相同。
- **装配**：提供者是必填，`tsc` 保证每个装配点都传了（bootstrap 一个文件、用例各处）。改动的生产代码没有 `as never` /
  `as unknown as`；用例里的 `as never` 只用于桩。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-489 task-execution 的运行族不再取 runtime-management 内部（RFC-294 §4.7 运行时驱动一族第三步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响
用例；删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径（含 workflow 的 `paths:` 过滤与账本锚点）。
