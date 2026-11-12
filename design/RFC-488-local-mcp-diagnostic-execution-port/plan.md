# RFC-488 实施计划

**前置**：RFC-487（Done，`76fcd805a`，Done 文档 `15f7a86d4`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。
全部实现与用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                                | 依据      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-488-T1 | resource-catalog：新增端口 `LocalMcpDiagnosticExecution`（`application/ports`，经 `required-ports` 转出）；本机执行体收 `execution`、删 `runFn` 与一族 import，运行时相关的工作调端口，启动校验移出                                 | design §2 |
| RFC-488-T2 | task-execution：本机实现 `infrastructure/local/mcpDiagnosticRunner.ts`（驱动知识、启动上下文与包裹、假运行、启动校验）与 `composition/localMcpDiagnosticRunner.ts`                                                                  | design §2 |
| RFC-488-T3 | bootstrap：观测模块建本机实现并交给部署档案选中的诊断装配；守护进程阶段给了夹具时由 `daemonApplication.ts` 选本机装配（unstarted scope 照旧）；测试接缝的类型改取 task-execution 的夹具类型；CrewStation 的诊断装配删去按夹具的分支 | design §2 |
| RFC-488-T4 | 登记：RFC-294 design §3.1 的虚线与 `rfc294Target.ts` 的 `REQUIRED_CONTEXT_EDGES`                                                                                                                                                    | design §2 |
| RFC-488-T5 | 新增 RFC-488 用例并登记 guard-manifest；RFC-487 用例 ① 的例外清单改为空；既有用例按新装配改指；`counts.json` 收紧                                                                                                                   | design §4 |
| RFC-488-T6 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、按 CI 跑法的批次、架构报告对账、全仓旧路径扫描）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                               | design §5 |

## 验收清单

- [x] AC-1 resource-catalog 的生产文件不 import 运行时驱动一族；RFC-487 用例的例外清单为空；本机执行体不含驱动、启动上下文、假运行与
      启动校验的逻辑
- [x] AC-2 本机 MCP 诊断在同样输入下与此前一致（启动上下文、包裹、假运行、观测与续会话、启动校验、四种运行时错误）
- [x] AC-3 越 DAG 的值边与 offered 文件对不升；public surface 不增；consumer 自有端口只增 1；减速带不升、触及的收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI：`9ff1274b0` 主 CI run 43287034076 的 70 个 job 里 68 个通过，红的一格是 `docs/audit-backlog.md`
      已登记的 RFC-398 多进程接管用例偶发到点（与本 RFC 无关，逐格归因见 §CI），windows-platform 与 maintenance-soak-nightly 通过

## 集中验证（2026-11-12，候选基于 `39c1d7c11`）

本机全程高负载（10 核；采样到的 1 分钟负载 38～101，主要是本机其他进程）。验证在候选导出仓库里跑：HEAD 的树加候选路径，每次修复后
重新同步，核对与工作树逐字相同。对照导出仓库与 HEAD 相同。验证期间 `origin/main` 未前进（一直是 `39c1d7c11`）。

开发期按 RFC-482 的做法，用字面量扫描对 HEAD 与候选核过 `tsc` 看不到的源码文本断言。差异 45 条，逐条核对都无害：

- 「HEAD 命中、候选不命中」：本 RFC 用例自己的反向断言；`rfc376` 两组合成用例里 `node:fs/promises` 的清单。
- 「候选新命中」：都是读观测模块文本的扫描——注释剥离、表归属的拼接只数登记的物理表、`rfc371` 的 CrewStation 范围只看运行观测、
  架构报告的对照分类器。

集中验证与实现门查出本 RFC 的四处问题，已修复并复验（4 见 design §6 细化 1）：

1. **用例 ④ 把 opencode 的原生会话号写错**：断言每个协议都会生成原生会话号，首批即红。opencode 不自己生成，返回 null。改为与驱动
   自己的方法对拍：有生成方法的给新号，没有的为 null。
2. **`rfc364` 钉住了观测模块的调用**：第一版在观测模块按夹具直接调本机装配，`rfc364-diagnostics-bindings` 钉的
   `input.adapters.mcpDiagnostics(` 调用不再出现，首批即红。4 修复后调用恢复原样，`rfc364` 不改。
3. **`rfc294-design-parity` 钉了虚线总数**：新增一条虚线后 99 → 100，首批即红；改计数并注明来由。
4. **按夹具选装配绕过了 unstarted scope 的工厂**（实现门自审）：第一版把选择放在观测模块。unstarted 阶段观测模块拿到的是 scope 的
   `createMcpRuntimeTests`，它组装本机装配并登记给 scope，应用释放时一并释放；直接调本机装配就漏了登记。`tsc` 与既有用例都看不出。
   选择改放 `daemonApplication.ts`，只在守护进程阶段生效。

第 4 条的教训记入 `docs/dev-gotchas.md`。全仓旧路径扫描另查出 RFC-317 RT-13 的两个锚点早已过期，它们锚定的判定又随本 RFC 移到
task-execution，锚点改指新位置（design §6 细化 2；dev-gotchas 补一句）。

- **静态**：
  - backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`；候选 1、2、3 各跑一次，之后只改注释、文档与账本）；
  - eslint `--max-warnings 0`：改动的 19 个 TS 文件无告警；promises 规则集：改动的 9 个源码文件无告警；
  - prettier 检查通过：改动的 TS、本 RFC 三件套与 `windows-platform.yml`。按仓库约定，`architecture/*.json` 不进 prettier，`STATE.md`
    等不跑 prettier。
- **RFC-488 用例**：
  - 候选上 13 / 13，最慢一条 0.8 秒；
  - 对 HEAD 的代码，整个文件在加载处报错（它 import 了候选才有的实现）。①～③ 去掉这些 import 与类型对拍后另存副本对 HEAD 跑：
    红 7 条，负对照绿。
- **首批**（候选 1，256 个文件：`tests/architecture/` 全部、本 RFC 改动的用例、读改动文件文本的用例）：250 个通过，其余 6 个：
  - 本 RFC 的问题 3 个：`rfc488`、`rfc364-diagnostics-bindings`、`rfc294-design-parity`，即上面 1～3；
  - 撞用例自带时限的 3 个：`rfc376-report` 的子进程 300 秒、`rfc294-architecture-preflight` 的 60 秒与 180 秒各一条、`rfc400` 一条
    30 秒。
- **修复批**（候选 2）：9 个文件 319 条全过（本 RFC 与 RFC-487 用例、`rfc364`、`rfc294-design-parity`、`rfc376-structural-guards`、
  `rfc479`、rfc317 三个守卫账本用例）。
- **全量 SQLite**（候选 2）：导出仓库逐文件跑，每个文件独立的 HOME 与 TMP、`--isolate`、`AW_TEST_PROVIDERS=sqlite`、单条 60 秒，用例
  自带时限的照旧，5 个 worker。2,930 个文件、2,920 个通过。其余 10 个都不归本 RFC，也都不经 MCP 诊断：
  - 发布账本一条（`rfc321-repository-publication-ratchet`）：导出仓库没有真实历史（与 RFC-483～487 相同），在真实仓库上 10 / 10。
  - 撞用例自带时限或内部等待的 9 个：
    - `rfc376-report` 的子进程在 300 秒处被杀；
    - `rfc363-task-workspace-process-recovery` 三条检查点 30 秒；
    - `rfc167-dynamic-workflow-engine` 的 `settleTask` 5 秒；
    - `rfc400`、`rfc300-webhook-workspace-cleanup-e2e`、`rfc321-repository-publication-system-mock-e2e`、`rfc354-nested-frames-closure`、
      `rfc363-workspace-content` 各一条 30 秒，`rfc354-nested-loop-frames` 一条 20 秒。
- **候选 3 复验**（修 4 之后）：经守护进程或 provider 应用图装配的用例、MCP 诊断的全部用例、读 bootstrap 或观测模块的用例，加上首批的
  文件，共 458 个。453 个通过（4,239 条通过、13 条按环境跳过）；其余 5 个同上：`rfc321`，以及撞时限的 `rfc376-report`、`rfc400`、
  `rfc300`、`rfc167`。
- **放宽时限的副本**（候选 4）：只改时限常量。范围是上面撞时限的 9 个文件，加上首批撞时限的 `rfc294-architecture-preflight`，10 个副本：
  - 9 个全过：`rfc167` 29 条、`rfc376-report` 16 条、`rfc294-architecture-preflight` 14 条、`rfc400` 6 条、`rfc363-workspace-content`
    4 条、`rfc300` 2 条，`rfc321` 托管发布、`rfc354` 两个各 1 条。
  - `rfc363-task-workspace-process-recovery` 8 条里，`scratch-root-before-artifact` 一条放宽到 300 秒仍等不到检查点，是 RFC-486 记过的
    形态（负载下 FSEvents 丢了改名事件）。照 RFC-486 另加 `ready.json` 的轮询兜底后 8 / 8，这一条 4.3 秒。
- **PostgreSQL**（候选 4）：14 个文件接 PostgreSQL 跑：MCP 诊断与 MCP 管理的双引擎用例（服务、HTTP、真运行、守护进程身份、家族用例
  等），加上两个守护进程图用例。两种 provider 同进程、`--randomize`、单条 60 秒，3 个 worker：227 条全过（PostgreSQL 一侧 111 条）。
  另两个扫 `tests/` 目录的用例（`test-suite-policy`、`rfc359-w5-t19f`）放进按 CI 跑法的批次，副本还在 `tests/` 下时不跑它们。
- **架构报告**（`scripts/architecture-report.ts --gates`，候选 4 vs HEAD 的代码出的报告）：
  - 门通过；60 项实测与 `counts.json` 的 `max` 逐项相等。唯一变化是 `composition-control-flow-resource-catalog` 93 → 92（CrewStation
    诊断装配删去按夹具的分支），已收紧到实测（C13）。越 DAG 的 offered 文件对 46、跨 context 内部文件对 43、context 值级越 DAG 对 0、
    类型偏差 57、`module-layer` 1、application 直接副作用 2、legacy 横向文件 167、legacy 服务实现 48 不变，各 context 的未消费 public
    符号不变（合计 91）。
  - public surface 1,208 不变；目标边 99 → 100（新虚线）。
  - 后端生产文件 3,218 → 3,221（新增 3 个）。
  - 跨 context import 7,664 → 7,668，删 9 条、增 13 条：
    - 删去的 9 条：本机执行体指向一族的 7 条（`getRuntimeDriver`、启动上下文与计划的 3 个类型、`runSystemAgent` 与它的 2 个类型）、
      指向 `util/log` 的 1 条；`daemonApplication.ts` 指向本机装配的类型边 1 条（改为值边，见下）。
    - 增加的 13 条：task-execution 本机实现指向一族的 7 条与指向 `util/log` 的 2 条（DAG 允许的方向，随 task-execution 那一步改走
      runtime-management）；bootstrap 的 4 条——观测模块指向 task-execution composition 的值、类型各 1 条，`daemonApplication.ts` 指向它的
      类型 1 条，以及指向 resource-catalog 本机装配的值边 1 条。
  - 变更入口清单多 1 条：本机实现的工厂，与托管形态的执行体同一终判据。
- **最终候选（候选 5）**：修 4 之后只改了注释、文档与账本：本 RFC 用例头注释的换行、`commons-debt.json` 的两个锚点、本 plan、design、
  `STATE.md` 与 `docs/dev-gotchas.md`。生产代码自候选 3 未变，架构报告与 PostgreSQL 一节沿用候选 4 的结果。
  - 按 CI 的跑法（两种 provider 同进程、默认 5 秒、`--randomize`）跑本机 MCP 诊断的用例、RFC-487 与本 RFC 用例、读 guard-manifest 或
    `commons-debt.json` 的用例、两个扫 `tests/` 的用例与文档对账用例：38 个文件 406 条里 402 条通过。RFC-488 用例最慢一条 1.1 秒。
  - 红的 4 条都在 PostgreSQL 一侧，都是负载下撞时限：`rfc238-mcp-runtime-test-http` 的两条应用生命周期用例撞默认 5 秒（随后的
    generation 围栏与 `Connection closed` 是超时后拆库的连带）；`rfc238-mcp-runtime-test-service` 与 `rfc370-mcp-diagnostics-family`
    各一条撞用例自己的 2 秒等待。同样的文件在 PostgreSQL 一节（单条 60 秒）全过。
  - 这三个文件与 HEAD 的代码同时、同样跑法 A/B 三轮：候选的 PostgreSQL 一侧每轮红 2、3、4 条，HEAD 红 5、2、2 条。HTTP 的两条每轮
    两边都红，service 与家族用例两边各红不同的几条。分布相同，不归本 RFC。
  - 导出仓库与 HEAD 加 28 个候选路径逐字相同（同步后逐个路径核对，0 处不符）。

## CI（AC-4）

- `9ff1274b0`（实现）：exact SHA 主 CI run 43287034076 的 70 个 job 里 68 个通过：
  - 红的一格是 `Backend tests (ubuntu-latest shard 41/44)`，「CI required」随之红。`rfc398-start-auto-upgrade-takeover` 的「N read no
    active; C registers; P dies; N acquires before takeover」184.6 秒后 barrier / readiness 到点，子进程（真 `src/main.ts`）的 stderr 是
    `JSON Parse error: Unable to parse JSON string`。
  - 归因：同一文件另两例（同样起真 daemon、走同一套装配）在这次 run 里通过，各约 28 秒；父提交 `39c1d7c11` 的主 CI run 43257929716
    同一分片三例全过；本地全量 SQLite 里该文件通过，最终候选上另跑两轮三例全过（「…before takeover」38.2 秒、35.6 秒）。本 RFC 改的是 MCP 诊断的装配，启动时只建闭包、不读
    JSON。这是 `docs/audit-backlog.md` 已登记的 RFC-398 多进程接管偶发红：第三次，前两次落在无关提交上（其中一次只改文档），本次红的是
    同组的另一例，登记已补。用例属 RFC-398，未改、未重跑；以本 RFC Done 文档提交的 CI 为后继证据。
  - 同一推送按路径触发的 windows-platform run 43287034082 通过，本机 MCP 诊断链新登记的位置在 Windows 上跑过；maintenance-soak-nightly
    run 43287034102 通过。
- 本 RFC 的落档提交 `39c1d7c11`（只改文档）：exact SHA 主 CI run 43257929716 的 70 个 job 里 68 个通过。
  `Playwright e2e (macos-latest shard 1/4)` 没有分到 runner（0 个 step、没有日志），「CI required」随之红。与该提交无关：它只改文档，同一
  run 的 macOS 其余三片通过，`15f7a86d4` 上 shard 4/4 同样没分到 runner。未重跑；实现提交的 CI 里 macOS e2e 四片全过，作为后继证据。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能，结论 PASS。自审查出的一处装配问题已修，见集中验证第 4 条。逐项比对：

- **一轮诊断的运行选项**（`localMcpDiagnosticRunOptions` 对原 `runTurn`）：
  - 驱动取 `runtime.row.protocol`；`configDir` 缺省取会话协议的 `DEFAULT_CONFIG_DIR_PROFILE`；提示词、诊断代理的人设、运行参数
    （`?? null`、`isSandbox === true`）、`freshAgentRun`、驱动的 `mcpTestSessionReference`、`nodeRunId` 取轮次号，逐字段相同。
  - 包裹只有两处：轮次结束删本轮的 `mcp-config.json`；启动前先过驱动的闸、再过诊断的闸。
  - 假运行的最小计划（可执行文件、空环境、`stdin` 忽略、过闸）相同。
  - 观测与续会话：此前给了夹具时不调 `observe`，现在本机执行体照调、由实现丢掉。`observe` 是两层函数，外层只构造闭包、没有副作用，
    也没有用例传带副作用的外层。
- **启动校验**：只对真运行的成功轮次做；文件型运行时惰性读 `<会话 root>/run/turns/<轮次号>` 下的清单；声明清单缺失时报同一条错；
  结果交 `verifyStartup`。与原 `verifyTurn` 相同。
- **运行时解析**（`resolveRuntime`）：未登记 → 已停用 → 不支持 → 没有可执行文件，错误码与文案不变。支持判定与可执行文件改经端口，
  取值与原来逐字相同：登记的 `binaryPath` 优先，缺省取驱动的 `defaultBinary(config)[0]`。
- **装配**：
  - 守护进程阶段没有夹具时，用部署档案的装配（standalone 是本机装配；CrewStation 是托管装配，不读 `execution`）。有夹具时用本机装配，
    与原来 CrewStation 装配内部的退回等价；standalone 本来就是本机装配。
  - unstarted 阶段（只有用例的 provider 应用图）照旧调 scope 的 `createMcpRuntimeTests`：它组装本机装配并登记释放，夹具随
    `execution` 进去。
  - `execution` 是必填，`tsc` 保证每个装配点都传了（bootstrap 一处、用例各处）。改动的装配点没有经 `as never` / `as unknown as` 交入
    的依赖；本 RFC 用例里的两处 `as unknown as` 只是纯函数的输入桩。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时记 RFC-487 Done 文档提交的 CI）；实现与验证后再提交
`refactor(backend): RFC-488 resource-catalog 本机 MCP 诊断的运行时工作改经自有端口（RFC-294 §4.7 运行时驱动一族第二步）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。按 CI 的跑法（两种 provider 同进程、默认 5 秒）跑一遍受影响
用例（RFC-487 教训）；删除或搬迁文件后按 `git ls-files` 扫全仓的旧路径。
