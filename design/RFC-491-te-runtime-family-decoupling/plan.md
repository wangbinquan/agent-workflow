# RFC-491 实施计划

**前置**：RFC-489（Done，`3c9da0a0c`，Done 文档 `87cd1228f`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                    | 依据              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| RFC-491-T1 | runtime-management：`public/queries` 交出三个静态事实查询；启动清单读取与插件加载失败识别迁入 `infrastructure/local/` 并经 composition 交出；交出本机驱动的选择；材料定义的材料引用增来源计划；探测夹具缝改用自己的类型 | design D2、D4～D6 |
| RFC-491-T2 | shared：声明清单的四个纯构造迁入 `declaredInjection.ts`；一族、runtime-management、task-execution 与用例的导入改指 shared                                                                                               | design D3         |
| RFC-491-T3 | task-execution：类型改取 owner 的出处，本机计划改用自有类型；节点运行持久化、续会话判据、诊断读端与托管准备改取 public 查询；本机任务代理族收插件加载失败识别；启动清单读取的 composition 转出删除                      | design D1、D2、D4 |
| RFC-491-T4 | task-execution：`services/systemAgentRun.ts` 迁为 `infrastructure/local/nativeSystemAgentRun.ts`，驱动、材料工作区与材料定义作为提供者交入；MCP 诊断的本机执行体收同一组提供者                                          | design D5         |
| RFC-491-T5 | bootstrap：本机系统代理运行的提供者与 MCP 诊断的选择、插件加载失败识别与启动清单读取的绑定；`services/runtimeSmoke.ts` 与两个只供契约用例的本机任务运行文件迁入 `tests/helpers/`                                        | design D4～D6     |
| RFC-491-T6 | 新增 RFC-491 用例并登记 guard-manifest；三份精确账本、`commons-debt.json`、不可达清单、`counts.json`、design §3.1 与 `rfc294Target.ts`、两份 workflow 路径过滤随之更新；既有用例改指                                    | design §3、§4     |
| RFC-491-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                   | design §5         |

## 验收清单

- [x] AC-1 task-execution 的生产文件不 import 一族；一族不 import task-execution；两个一族运行器与两个本机任务运行文件不在生产树里
- [x] AC-2 同样输入下行为一致（三个静态事实、声明清单的构造、启动清单读取、插件加载失败识别、本机系统代理运行与 MCP 诊断的本机执行体、
      探测夹具缝）
- [x] AC-3 跨 context 内部文件对 22 → 21；R1 18 → 9；不可达生产文件 18 → 16；越 DAG 的值边与 offered 文件对不升；public 类型污染不升；
      减速带不升、触及的收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证（2026-11-12～13，候选 1～5 基于 `33661e100`，最终候选基于 `aff2c86e3`）

本机全程高负载（10 核；采样到的 1 分钟负载 40～117，主要是本机其他进程：Docker 的虚拟机、另一会话的 node 进程与三个结束不了的
残留 mock 进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后重新同步，核对与工作树逐字相同。对照导出仓库与 HEAD 的
树相同。验证期间 `origin/main` 前进三次，都是另一会话的 RFC-490：实现 `aff2c86e3`（70 个文件：前端、e2e、collaboration 的澄清、
shared 的澄清 schema 等）与本 RFC 的路径无交集，也不引用本 RFC 迁走或新增的任何符号与路径；之后的 `cf948fd5c`、`65e57fab7` 只改文档，
其中 `STATE.md`、`docs/audit-backlog.md`、`docs/dev-gotchas.md` 本 RFC 也改，段落互不重叠（按 hunk 核对，本 RFC 的改动只含自己的段落）。
候选内容未变，此前的结果沿用；最终候选（候选 6）落在 `aff2c86e3` 之上，静态检查、架构报告与按 CI 跑法的批次在它上面重跑，文档对账
用例在 `65e57fab7` 上重跑（见末项）。

集中验证查出本 RFC 的一处问题：

1. **两个 public 符号没了生产读者**（首批即红）：`rfc376-structural-guards` 报未消费 public 符号越过上限，source-control 10 > 9
   （`resolveBoundaryMounts`）、task-execution 1 > 0（`SystemAgentObservationRun`）。前者唯一的生产读者是只供契约用例的本机任务运行，
   后者唯一的读者是 `services/systemAgentRun.ts`，两者移出后就成了未消费符号。按 RFC-294 design §3.3 撤下这两个出口（design §6
   细化 7），修复批全过。`docs/dev-gotchas.md` 已有这条教训（RFC-466），补上本次的情形与迁出前的查法。

另有一处测试耗时的调整：本 RFC 用例 ④ 逐个名字重读全部后端生产文件（6 个名字 × 约 3,200 个文件），负载下最慢 3.1 秒，离 CI 的
默认 5 秒不远；改为与 ①～③ 共用同一份文本缓存（只改用例，断言不变），guard-manifest 的行数随之 453 → 454。

- **静态**：
  - backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）。候选 1 报的 17 处都在用例：跟新签名（MCP 诊断的本机执行体收提供者、两个纯函数
    收 `drivers`）与一处已删文件的 import；改后候选 2 与候选 5 各跑一次都是 0。shared `tsc` 0 错。
  - eslint `--max-warnings 0`：改动的 129 个 TS 文件无告警；promises 规则集（只管 backend 的 `src`）：改动的 42 个源码文件无告警。
  - prettier 检查通过：改动的 TS、两份 workflow、本 RFC 的 design 与 plan。按仓库约定，`architecture/*.json`、`STATE.md`、
    RFC-294 design 与 `docs/` 不跑 prettier。
- **RFC-491 用例**：候选上 18 / 18。对 HEAD 的代码，整个文件在加载处报错（它 import 了候选才有的 runtime-management 出口与 bootstrap
  的提供者）。去掉这些 import 与 ⑦ 的对拍后另存副本对 HEAD 跑：13 条里红 10 条（① 列出 16 个文件的 24 条边；② 的两个运行器与四个
  文件仍在 `src/`；③～⑥ 的声明、落位与绑定都不成立），两个负对照绿；② 的一族扫描也绿，它扫的一族清单本就不含两个运行器（由同组
  「不在 src」一条钉住）。
- **首批**（候选 3，168 个文件：`tests/architecture/` 全部 140 个、读源码文本的改动用例 19 个、读文档与账本的 9 个）：165 个通过
  （1,687 条通过、4 条按环境跳过），其余 3 个：
  - 本 RFC 的问题 1 个：`rfc376-structural-guards`，即上面 1；
  - 撞用例自带时限 2 个：`rfc376-report` 的子进程 300 秒、`rfc400` 一条 30 秒。与 HEAD 的代码同时、同样跑法 A/B，两边都红（候选
    458 秒、76 秒，HEAD 438 秒、78 秒）。
- **修复批**（候选 4）：5 个文件 305 条全过（`rfc376-structural-guards`、`rfc487`、`rfc281`、本 RFC 用例、
  `rfc370-task-agent-native-compatibility`）。
- **全量 SQLite**（候选 5）：导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒（用例
  自带时限的照旧）。清单按 RFC-489 的耗时从慢到快排；先以 5 个 worker 跑完 149 个文件后由本会话中止（当时误以为整体过慢，其实这
  149 个占全量耗时的 58%），余下 2,783 个以 4 个 worker 续跑。合计 2,932 个文件、2,908 个通过（23,798 条通过、127 条按环境跳过）。
  其余 24 个都不归本 RFC：
  - 发布账本一条（`rfc321-repository-publication-ratchet`「…reproducible from reachable history」）：导出仓库没有真实历史，HEAD 的
    对照导出仓库上同样红（与 RFC-483～489 相同）。
  - 撞用例自带时限、内部等待或看门狗的 23 个：`rfc376-report` 子进程 300 秒；`rfc398-auto-upgrade-resume-refused` 就绪屏障 240 秒；
    `rfc370-committed-architecture-source` 150 秒；`rfc294-architecture-preflight` 180 秒与 60 秒；
    `clarify-review-combination-scenarios` 流程 20 秒（看门狗取消任务）；两个 `rfc363` 进程恢复的检查点 30 秒；`rfc395` 七个
    （30～60 秒）；`rfc400`、`rfc300`、`rfc354-nested-frames-closure`、`rfc321-repository-publication-system-mock-e2e` 各一条 30 秒；
    `rfc359-t19h` 60 秒；`cli` 三条等守护进程就绪 10 秒（日志是正常启动的进度，同文件给 15 秒的一条就绪并通过）；`rfc167` 的
    `settleTask` 5 秒；`rfc135-runtimes-status` 版本探测 5 秒、2 秒；`rfc370-execution-effect` 等本机目标启动 10 秒；
    `rfc395-ii-pre-architecture-lock` 扫描 20 秒。
  - 与 HEAD 的代码同时、同样跑法 A/B：前段 8 个候选 72 条通过、21 条红，HEAD 69 条、24 条；续跑段 9 个候选 72 条、9 条，HEAD 71 条、
    10 条，逐文件形状相同；`rfc395-ii-pre-architecture-lock` 两边都过，发布账本那条两边同红。`rfc376-report`、`rfc400` 在首批 A/B
    过，`rfc294-architecture-preflight`、`rfc395-v3-content-inventory` 在 PostgreSQL 一节的 A/B 里两边同形。
    `rfc370-committed-architecture-source` 在最终候选与 HEAD（`aff2c86e3`）上同时跑，两边都撞默认的 150 秒（421 秒、482 秒）；只
    放宽时限（150 秒 → 1,500 秒）的副本在最终候选上 2 / 2 通过（439 秒）。
  - 唯一不同的一处：`rfc135-runtimes-status` 那一轮候选红 1 条（「hung binary …」一例里 opencode 一行的版本探测在测试给的 2 秒内没
    返回）、HEAD 全过；全量里红的却是另外两例（默认 5 秒的版本探测）。随后两边同时各跑 4 轮：候选 4 轮全过，HEAD 有 2 轮红同一例。
    是负载下探测时限的形态；本 RFC 在这条路径上只改了一处类型标注（探测夹具缝入参），不归本 RFC（候选的绿不作通过依据）。
- **PostgreSQL lane**（候选 5）：52 个文件接 PostgreSQL 跑（本 RFC 改动的双引擎用例 33 个，加改动的 helper 与启动清单读取、托管
  准备、本机系统代理运行的双引擎使用方 19 个），两种 provider 同进程、`--randomize`、单条 60 秒，2 个 worker，负载约 117：1,046 条里
  1,004 条通过；34 个文件全过。红的 42 条分在 18 个文件里，40 条在 PostgreSQL 一侧，同进程的 SQLite 一侧全过；另 2 条与 provider
  无关（`rfc294-architecture-preflight` 撞用例自己的 180 秒，`rfc395-v3-content-inventory` 一条撞 30 秒）。PostgreSQL 一侧：
  - `beforeEach` 撞 60 秒（`rfc395` 两个是 90 秒）的 11 个文件：`change-narrative`、`inventory-in-flight-fallback`、两个
    `memory-distill-*`、`routes-memory-distill-job-detail`、`runner-inventory-integration`、`rfc370-m1-hosted-execution`、
    `rfc370-m2-task-startup-inventory`、`rfc395-v3-content-inventory`、`rfc395-v3-hosted-job` 与 `scheduler-cross-clarify-dispatch`
    的 A16 一例；后者另有 4 条撞 60 秒，`rfc384-daemon-intent-bundle` 一条撞 15 秒。
  - MCP 诊断与试验场 5 个文件：`rfc238-mcp-runtime-test-service` 7 条「condition timed out」（日志是租约更新的查询失败与
    `Connection closed`）、`rfc238-mcp-runtime-test-http` 会话超时、`rfc238-mcp-runtime-test-real-e2e` 的 PostgreSQL 一例（子进程退出
    后 stdout 收尾超时、会话随之结束，下一轮 409）、`rfc349-mcp-runtime-test-daemon-identity` 撞 20 秒、`rfc370-mcp-diagnostics-family`
    一条「did not settle」。这几处走本 RFC 改过装配的 MCP 诊断执行体，同文件的 SQLite 一侧全过。
  - 18 个文件与 HEAD 的代码同时、同样跑法 A/B（各 2 个 worker、各用两个库）：两边各 326 条，候选 285 条通过、HEAD 284 条通过，
    逐文件红的形状相同（`change-narrative` 2 对 1、`rfc238-mcp-runtime-test-service` 11 对 13，其余逐个相等）；首轮红的其中 5 个
    文件这一轮两边都全过（`rfc370-m1-hosted-execution` 66 条、`memory-distill-timeout-config`、`routes-memory-distill-job-detail`、
    `rfc370-m2-task-startup-inventory`、`runner-inventory-integration`）。不归本 RFC。MCP 诊断路径在 PostgreSQL 上的正向证据取
    exact SHA 的 CI（两种 provider 同进程）：本 RFC 只改它的装配，同文件 SQLite 一侧走的是同一段装配，全过。
- **架构报告**（`scripts/architecture-report.ts`，候选 5 vs HEAD 的代码出的报告）：
  - 60 项实测都在 `counts.json` 的 `max` 内。变的 5 项正好是收紧后的 `max`：`cross-context-internal-file-pairs` 22 → 21（本机任务
    运行 → source-control 的 composition 一对）、`unreachable-production-files` 18 → 16（两个本机任务运行文件）、
    `off-dag-offered-file-context-pairs` 46 → 45（本机任务运行入参 → memory）、`legacy-horizontal-files` 167 → 165 与
    `legacy-service-implementations` 48 → 46（两个一族运行器）。各 context 的未消费 public 符号不变（合计 91），public 类型偏差 57、
    其余各项与对照逐项相同。
  - public surface 1,208 → 1,209：增 runtime-management `public/queries` 的三个查询，撤 source-control 的 `resolveBoundaryMounts`
    与 task-execution 的 `SystemAgentObservationRun`。目标边 104 → 105（runtime-management 实现 task-execution 的
    `TaskRuntimeInventoryContent`，虚线）。facade 48 → 46（两个一族运行器）。
  - 生产文件 4,082 → 4,083：backend 3,222 不变（新增 6 个、删除 6 个），shared 多 `declaredInjection.ts`。
  - 跨 context import 7,656 → 7,620，删 71 条、增 35 条：
    - 删去的 71 条：task-execution 指向一族的 38 条；两个一族运行器指向 task-execution 与 runtime-management 的 15 条；
      runtime-management 取一族的声明清单构造与探测类型的 7 条；两个本机任务运行文件取其他 context 的 9 条；bootstrap 取
      task-execution 两个旧出口的 2 条。
    - 增加的 35 条：task-execution 指向 runtime-management `public/` 的 14 条、resource-catalog `public/` 的 3 条与 `@/util/log` 的
      3 条（都是查询与类型）；runtime-management 新文件取一族（驱动注册表、运行目录、插件定位）的 6 条与 resource-catalog
      `public/` 的 1 条；bootstrap 指向两边 composition 的 8 条（装配根的允许形状）。
  - 变更入口清单 2,337 → 2,338：删 4 条（本机任务运行、它的入参、task-execution 的启动清单读取、`runSystemAgent`），增 5 条（探测
    夹具缝入参、runtime-management 的启动清单读取、驱动能力查询、本机系统代理运行的两个函数）。
  - 一族之外 import 一族的生产文件 30 → 18：task-execution 16 → 0；runtime-management 12 → 16（新落位的四个文件：三个静态事实、
    本机驱动的选择、插件加载失败识别、启动清单读取）；bootstrap 2 不变。一族指向 task-execution 的文件 2 → 0。
- **全仓旧路径扫描**（`git ls-files`）：删掉与迁走的六个文件在仓内只剩已完工 RFC 的历史记录、`architectureReport.ts` 有意保留的
  遗留路径目标表（design §6 细化 1）与 RFC-487、RFC-488 用例里的一族集合和合成夹具；改动文档里的相对链接都有效。两份 workflow 的
  路径过滤改指新位置。
- **最终候选（候选 6：`aff2c86e3` 加 146 个候选路径）**：候选 5 之后只改了本 RFC 用例 ④ 的文本缓存与 guard-manifest 的行数、本
  plan、`STATE.md` 与 `docs/dev-gotchas.md`，基底换成 `aff2c86e3`。导出仓库与 `aff2c86e3` 加这 146 个路径逐字相同（同步后逐个路径
  核对，0 处不符）。
  - backend 与 shared `tsc` 0 错。
  - 架构报告对 `aff2c86e3` 重采：60 项实测都在 `max` 内，变化与上面逐项相同（`aff2c86e3` 本身不改任何计数，只让两边的变更入口多
    2 条、生产文件多 3 个）。
  - 按 CI 的跑法（两种 provider 同进程、默认 5 秒、`--randomize`，2 个 worker）跑 86 个文件：本 RFC 与 RFC-487～489 用例、本 RFC
    改动的用例与它们的双引擎使用方、读 guard-manifest 与 `counts.json` 的四个架构用例、文档对账用例。1,458 条里 1,371 条通过；本
    RFC 用例 18 / 18，最慢一条 1.1 秒（④ 0.6 秒）；读 guard-manifest、`counts.json`、三份精确账本与文档的用例全过。红的 87 条在 18 个
    文件里，都在 PostgreSQL 一侧（撞默认 5 秒或钩子撞时限），同进程的 SQLite 一侧全过。
  - 与 HEAD 的代码同时、同样跑法 A/B（HEAD 一侧少本 RFC 用例）：HEAD 1,439 条里 1,351 条通过，红 88 条在 20 个文件里，逐文件形状
    相同。出入只有 ±1 条：候选多红 `memory-distill-scheduler` 一条（PostgreSQL 一侧 6.9 秒），HEAD 多红 `rfc376-structural-guards`
    （20 秒）、`rfc370-execution-effect`、`rfc370-m1-hosted-execution` 各一条。不归本 RFC。
  - HEAD 随后前进到只改文档的 `cf948fd5c`、`65e57fab7`。导出仓库同步为 `65e57fab7` 加 146 个候选路径（0 处不符）后，按同样跑法重跑
    文档对账用例（`docs-implementation-parity`、`rfc-index-status-drift`、`test-suite-policy`、`rfc294-design-parity`）与本 RFC 用例，
    全过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS。逐项与 HEAD 比对，未发现行为差别：

- **三个静态事实**：`isKnownRuntimeKind` 就是一族的同一个函数；`runtimeDriverCapabilities(kind)` 即 `getRuntimeDriver(kind).capabilities`，
  `detectRuntimeSessionNotFound(kind, stderr)` 即 `getRuntimeDriver(kind).detectSessionNotFound?.(stderr)`，读同一个驱动单例，种类未知时
  在同一时点抛同一条错。四个使用方逐处替换，读取时点不变：托管准备仍在原来取驱动的那一行取能力、随后展开；节点执行的续会话判据
  仍在回调里取；诊断读端仍在种类回落之后取。用例 ⑦ 与驱动直取对拍。
- **声明清单的构造**：四个函数与错误类逐行迁入 shared（`DeclaredManifestV1` 本就是 `DeclaredInjectionManifest` 的别名）；
  `AgentInjectionError` 只有一处定义，抛出的与识别的是同一个类。
- **启动清单读取与插件加载失败识别**：逐行迁入 runtime-management，只改类型的出处（启动清单读取的返回类型写成与 task-execution
  端口逐字段相同的结构）；bootstrap 绑的就是这两个函数（用例 ⑤、⑦ 钉住同一引用），本机任务代理族在原来的调用处经提供者调用，
  入参与次序不变。
- **本机系统代理运行**（`services/systemAgentRun.ts` → task-execution `infrastructure/local/nativeSystemAgentRun.ts`）：逐行比对，其余逻辑
  （种子文件、封装钩子、超时、事件上限、取证、清理）逐字未改，计划与驱动窗口改用 task-execution 自有的类型（只是类型）；改的只有
  驱动、材料工作区与材料定义的来源：
  - 驱动：`providers.drivers(protocol)` 即 `getRuntimeDriver`，同一单例、同一时点，种类未知时仍先在这里抛错；
  - 协议：`definition.protocol` 即 `bindNativeAgentProtocol(driver)`，是同一驱动上的惰性视图（getter 与按原接收者调用的方法）。它
    提前到运行开头建、整次运行共用一个，视图无状态，外部看不出；
  - 运行证据：`definition.evidence(scope)` 与原来的 `bindNativeAgentMaterialEvidence(driver, scope)` 都是
    `createLocalAgentMaterialEvidence({ hooks: driver, scope })`，仍在 getter 里惰性构造，scope 原样；
  - 材料引用：`definition.materialReference(composed, base)`、`definition.materialReference(prepared)` 与原来的
    `getNativeAgentMaterialReference(...)` 是同一个函数（`bindNativeAgentMaterialReference`，同一张 WeakMap），包裹后的计划照旧沿用
    原计划的引用；
  - 材料工作区：`providers.materialWorkspaces` 即原来的 `bindNativeAgentMaterialWorkspace`，请求原样。
- **MCP 诊断的本机执行体**：五处取驱动（会话支持、本机会话 id、默认可执行文件、运行选项、回合后的核验）改经 `drivers(protocol)`，
  同一单例、同一时点，方法照旧在驱动对象上调用。没有夹具时运行器是 `createNativeSystemAgentRun(providers)`（`??` 短路，只在不用
  夹具时建，建时无副作用）。观测模块经 bootstrap 的选择拿到执行体，收到的夹具入参与原来相同。
- **bootstrap**：两组提供者都是 runtime-management 的同一组函数（用例 ⑦ 对拍引用相等）；独立部署的启动清单读取改取
  runtime-management 的 composition，函数原样。
- **移出生产的三个文件**（`services/runtimeSmoke.ts` 与两个本机任务运行文件）逐行迁入 `tests/helpers/`，只把相对 import 改成别名、
  挂载规则改取 source-control 的 domain 声明、插件加载失败识别改取 runtime-management 的新位置；探测运行器去掉一处转出
  （`MODEL_FAIL_SIGNATURES`，唯一的读者改取 task-execution 的 application）。读它们的契约用例照常通过。探测夹具缝的入参改用 runtime-management 自有的
  `RuntimeSmokeFixtureOptions`（字段就是效果实际构造的那几项），返回改用 public 的 `RuntimeSmokeResult`，都只是类型。
- **装配**：提供者都是必填，`tsc` 保证每个装配点都传了（bootstrap 与用例各处）。改动的生产代码没有新增 `as never` /
  `as unknown as`（本机系统代理运行里那一处是原文件就有的）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-491 task-execution 与运行时驱动一族互不 import（RFC-294 §4.7 运行时驱动一族第四步）`。走私有 index、按路径清单
提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响用例；
删除或搬迁文件后按 `git ls-files` 扫全仓旧路径（含 workflow 的 `paths:` 过滤与账本锚点）。
