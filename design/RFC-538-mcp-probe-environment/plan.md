# RFC-538 实施计划

依赖：RFC-537。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-538-T1 探测环境**：`mcpProbeOperations.ts` 删去模块级变量、测试接缝函数与 `mcpProbeNow`，改为 `createMcpProbeEnvironment(options?)`、
  `createInProcessMcpProbeRunner(environment)` 与带 `clock` 的 `composeMcpProbeOperations`；`composition.ts` 的转出随改（design D1）。
- **RFC-538-T2 组合根**：`daemonApplication.ts` 每份应用建一份环境（选项来自 `testSeams.mcpProbeOptions`），交给 observation 模块的 MCP 诊断、
  资源目录模块的写入时钟与 HTTP 组装的探测用例（design D2）。
- **RFC-538-T3 用例与锁**：新增 RFC-538 用例并登记 guard-manifest；provider HTTP 测试助手、四个用例与两处锁随改（design D3）。
- **RFC-538-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例，红的与 HEAD 同时 A/B（两边都撞写死时限的用例在两边副本里放大时限跑到底）；架构报告对照；变异验证。
- **RFC-538-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第六步。

## 验收清单

- [x] AC-1 `mcpProbeOperations.ts` 没有模块级状态与测试接缝函数；组合根为每份应用建一份探测环境，三处用同一份
- [x] AC-2 探测与写入的结局不变；两份环境各用各的选项与时钟，选项在每次探测时读取
- [x] AC-3 模块级可变单例 56 → 55、计数不升；锁随改；新增 RFC-538 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载约 19～29，另有会话在跑）。验证在候选导出仓库里跑（HEAD `c06e6adab` 加本 RFC 的 19 个路径，核对与
工作树逐字相同），对照是同一 HEAD 的另一份导出；其后的 `6f51e236a` 只改文档（本 RFC 的落档与 RFC-537 转 Done）。集中验证查出两处本人缺陷，
都已修复并复验：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 18 个 TS 文件无告警（新用例一处 `prefer-const` 已改），
  改动的 7 个生产文件另过 promises 配置；prettier：19 个路径与三件套通过。
- **选择**：按 RFC-533 的口径从 2,983 个用例文件里选出 883 个，绝大多数经 `daemonApplication.ts`（provider HTTP 测试助手的 import 闭包）入选。
  语义层 382 个：改动的 8 个用例、全部 `tests/architecture/`（142 个）、语料守卫、在 import 之外点名被改文件的 138 个（读源码的锁）、点名探测
  接缝 / MCP 路由 / 两组模块装配的 60 个、直接导入 MCP 相关被改文件的 34 个、经读源码的测试助手（`daemonGraphSource`、
  `deploymentSelectionSource`、`census`、`architectureReport`、`rfc359-p0-mutations`）到达被改文件的 201 个；`tests/fixtures/` 里没有钉被改文件的
  摘要锁。其余 561 个只经 import 闭包入选，交给 CI 的全量分片。
- **缺陷一**：`rfc392-unified-test-entry` 按成员名钉 `DaemonApplicationTestSeams` 的清单，本 RFC 加了 `mcpProbeOptions` 而没有随改；补进清单后
  3 / 3（guard-manifest 里它的行数随改）。
- **缺陷二**：候选的架构报告比对照多两条公开面字段的消费边——环境的时钟成员叫 `now`，HTTP 组装与资源目录模块里的 `mcpProbe.now` 被报告按
  整词匹配记成 identity-access `CommandContext.now` 与 knowledge-evolution 一个参与者参数 `now` 的消费。成员改名为 `clock`（`composeMcpProbeOperations`
  的入参随改）后公开面与对照相同。
- **语义层**（60 秒；候选 5 个 worker）：382 个文件 376 个通过；改过的用例文件全过（RFC-538 用例、`routes/mcps-probe`、`rfc201`、`rfc223-pr9`、
  `rfc448`、`rfc370-hosted-mcp-probe`、`rfc380`、`rfc525`）；红的 6 个：上面的 `rfc392`、`rfc321`（导出仓库没有真实的 git 历史，在工作树里
  10 / 10）、三个长扫描用例（`rfc294-architecture-preflight`、`rfc376-report`、`rfc370-committed-architecture-source`）撞写死的时限、
  `rfc238-mcp-runtime-test-service` 两条 2 秒的等待到点。
- **A/B**（候选与对照同时、各用各的库；在两边的副本里临时放大写死的时限跑到底）：三个长扫描用例两边都全过（14 / 14、16 / 16、2 / 2）；
  `rfc238` 两边都红、红的用例名不同（候选 1 条、对照 2 条），把它的 2 秒等待放到 60 秒后两边都 52 / 52（它直接建诊断应用，不经探测环境）。
  没有只在候选上红的用例。
- **改名之后的复跑**（最终的候选，4 个 worker）：RFC-538 用例、探测相关的 HTTP 与装配用例（`routes/mcps-probe`、`rfc201`、`rfc223-pr9`、
  `rfc448`、`rfc380`）、两处锁（`rfc525`、`rfc370-hosted-mcp-probe`）与全部 `tests/architecture/`（两个只测报告自身的长扫描用例除外，
  `rfc294-architecture-preflight` 放大时限）共 150 个，149 个通过；`rfc400-collaboration-task-participants` 一条撞 30 秒（语义层里 27 秒通过），
  两边放大时限后都 6 / 6。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：选项挪回模块级（每份环境读最后建的那份），RFC-538 用例红两条（真实语料、两份环境
  各用各的）；进程内执行器不读环境的选项，红两条（两条行为用例）；探测用例不取交进来的时钟，`rfc448` 的装配用例红（改名后复验同样红）；
  组合根不取应用的测试接缝，RFC-538 的真实语料红、`routes/mcps-probe` 两个引擎各红 4 条（探测没用上用例的假客户端）。
- **架构报告**（候选与对照各出一份）：模块级可变单例 56 → 55（删去的正是 `probeOptionsOverride`）；跨上下文导入 7,533 → 7,536（bootstrap 对
  探测环境的按符号导入：组合根的工厂与选项类型、observation 的环境类型；资源目录模块的 `mcpProbeNow` 换成环境类型，数目不变）；模块符号属主
  32,470 → 32,470（删去三个名字、新增三个）；写入入口清单 2,392 → 2,393（环境工厂一条）；公开面与其余计数、门、指标没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **探测的结局不变**：`createInProcessMcpProbeRunner(environment)` 每次探测把 `{ ...environment.options(), startedAt }` 交给 `probeMcp`，与此前每次
  读进程级接缝同义；生产没有测试接缝，选项为空，客户端工厂、总时限与时钟都取 `probeMcp` 的默认。托管部署仍选 `createHostedMcpProbe`，不读选项。
- **时钟**：`createMcpProbeEnvironment(options).clock()` 取选项里的时钟、否则 `Date.now`，与此前的 `mcpProbeNow()` 同义；探测用例
  （`composeMcpProbeOperations` 的 `clock`，交给探测用例的 `now`）与资源目录模块的 MCP 写入时钟（`nextMutationTimestamp`）取同一份环境的
  `clock`，探测与写入仍在同一条时间线上。
- **组合根**：每份应用在 `daemonApplication.ts` 建一份环境（选项取 `testSeams.mcpProbeOptions`），交给 observation 模块（MCP 诊断选择的输入
  `probe`，单机以它建进程内执行器）、资源目录模块（写入时钟，并把同一份交出）与 HTTP 组装（探测用例）。两份应用不再共用选项。
- **用例与锁**：provider HTTP 测试助手的选项多一项 `mcpProbeOptions`、经 `testSeams` 交给应用；`routes/mcps-probe`、`rfc201`、`rfc223-pr9` 把选项
  放在用例自己的作用域里交给各自的应用，每个用例后清空；`rfc448` 直接给环境与时钟；`rfc380` 与 `daemonTaskExecutionBundle` 测试助手给两组
  模块交同一份环境，`rfc380` 的模块成员清单多 `mcpProbe`；`rfc370-hosted-mcp-probe`、`rfc525` 改钉新的原文与实参；`rfc392` 的测试接缝清单
  多 `mcpProbeOptions`；guard-manifest 登记 RFC-538 用例，`rfc525` 与 `rfc392` 条目行数随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同一提交记下 RFC-537 转 Done）；实现与验证后再提交
`refactor(backend): RFC-538 MCP 探测的选项与时钟随应用走（RFC-294 S12 第十九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
