# RFC-463 实施计划

**前置**：RFC-462 落地（`3229bcabb`，Done 文档 `0f8f03c2e`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                 | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| RFC-463-T1 | 两个判定文件迁入 shared（相对 import、能力参数收窄到 shared 命名的两个字段），shared 入口导出；runtime-management 能力声明改用同一联合类型 | design §1 |
| RFC-463-T2 | `EMPTY_RUNTIME_PROFILE` 迁入 runtime-management `public/types`；`agentInjection` 改取                                               | design §1 |
| RFC-463-T3 | 消费方改指（task-execution 两处、resource-catalog 两处、用例）；删除两个 `services/execution/` 文件                                 | design §2 |
| RFC-463-T4 | `commons-debt`、legacy 归属表、钉住余项的用例与精确清单、guard-manifest；新增 RFC-463 用例                                           | design §3 |
| RFC-463-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                               | design §6 |
| RFC-463-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                     | —         |

## 验收清单

- [x] AC-1 两个判定文件只在 shared 定义一次、`services/execution/` 下不再有它们；`EMPTY_RUNTIME_PROFILE` 只在 runtime-management `public/types`；`taskAgentRun` 不再取 `services/execution/`
- [x] AC-2 架构计数按实测（`R2` 7 → 3、`R1` 不变），public surface 偏差与越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `3229bcabb`，文档基于 `0f8f03c2e`）

本机全程高负载（采样到的负载 23～67；本机另有常驻负载：一个本地 Kubernetes 控制面容器约 5 核、三个挂起的测试夹具进程各约 1 核）。验证都在
候选导出仓库里跑（`3229bcabb` 的 `git archive` 加候选路径，提交后运行；RFC-462 的 Done 文档提交 `0f8f03c2e` 只改 5 个文档文件，文档用例前
同步进导出仓库并核对与 HEAD 加候选逐字相同）。**集中验证没有查出本 RFC 的问题**。开发期的静态自查（backend `tsc`）查出一处遗漏：
opencode 集成用例（`tests/integration-opencode/rfc281-boundary.integration.test.ts`，只在 integration-opencode workflow 里跑）也取
`EMPTY_RUNTIME_PROFILE`，一并改指——起初清点消费方的 grep 被 `head` 截断，漏看了这个文件（已记入 `docs/dev-gotchas.md`）。

- **静态**：backend、shared、frontend、system-mocks 的 `tsc` 均 0 错（上面那处遗漏修复后）；eslint `--max-warnings 0` 无告警（backend、shared
  与 `eslint.promises.config.js`）；`depcheck` 分层门通过；改动的 TS 与 JSON 已按 prettier 格式化。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5848～6782 s 全部跑完，合计 23472 pass / 127 skip /
  73 fail，另有 41 条测试间未处理错误。70 条是超时（34 个文件；63 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc354` 嵌套帧闭包、
  `rfc363` 目录分页各一条撞自带的 30 秒，`rfc354` 嵌套 loop 帧撞自带的 20 秒，`rfc294-architecture-preflight` 的 public surface 偏差精确清单
  撞自带的 60 秒，`rfc370-committed-architecture-source` 与 `rfc376-report` 的已提交报告各撞自带的 150 / 300 秒），41 条未处理错误全出在其中
  16 个超时文件里；其余 3 条：导出仓库只有候选提交所致的 `rfc321`、`cli` 的真实守护进程端到端等就绪撞自带的 10 秒、
  `scheduler-envelope-followup-integration` 里紧跟一条超时用例的一例（那条用例没收尾的驱动在它运行时关了库，argv 日志读到 0 条）。
  新增的 RFC-463 用例通过。
  - 复跑 37 个文件（34 个超时文件、`rfc321`、`cli` 与 RFC-463 用例；30 秒时限，负载 24～40）：34 个全过，合计 324 pass /
    3 fail，余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）、`rfc363` 目录分页（撞自带的 30 秒）与导出仓库里恒红的
    `rfc321`——与 RFC-462 复跑后余下的三例相同。对照：同一时刻在 RFC-462 的导出仓库里跑同一文件（负载 36～37），`rfc167` 两边都是
    28 pass / 1 fail、同一例到点（5.53 s 与 5.55 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点（30.89 s 与 30.90 s）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 238 个文件（全部 139 个架构测试；改动的用例文件与 RFC-460～462 用例；启动核验、清单观测与读回、
  MCP 测试台与诊断、注入装配、驱动能力自检与 spawn、agent 运行与材料、守护进程装配等取迁移件或其消费方的用例）：218 个文件全过，合计
  2546 pass / 55 fail / 4 skip（与全量 SQLite 同时跑）。20 个文件失败：17 个只有超时；另 3 个在 MCP 测试台与诊断的 PostgreSQL 一侧：
  `rfc238-mcp-runtime-test-service` 两例与 `rfc370-mcp-diagnostics-family` 一例撞用例自带的 2 秒等待，`rfc238-mcp-runtime-test-real-e2e`
  的 Claude 多轮夹具里首轮 system agent 的退出后冲刷超时（stdout 迟迟不到 EOF）让会话以 incomplete 收场，第二条消息被拒（SQLite 一侧
  同一用例 2.3 s 通过）。
  - 复跑 20 个文件（30 秒时限，接在 SQLite 复跑之后）：全过，合计 320 pass / 0 fail——MCP 测试台与诊断那 3 个文件（两个撞用例
    自带的 2 秒等待、一个是退出后冲刷超时，30 秒时限都不放宽）这一轮也全过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等负载降到 28.1 / 39.1 才放行，此后本会话不再起别的负载，17 个阶段全部符合预期（0 failures）。两次运行前后
  127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-463
  用例）：在与 HEAD 加候选逐字相同的导出仓库上 99 pass / 0 fail——其中 `rfc376-report` 在负载 28 下 63 s 通过（RFC-462 的 Done
  文档提交前它在负载 35～50 下两次撞自带的 300 秒；本导出仓库已含那 5 个 Done 文档文件，即 RFC-462 记下的「负载降下来后的复跑」）。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c462 → c463）：`R1-inbound-module-internals` 99 不变、
  `R2-outbound-module-to-legacy` 7 → 3（账本与实测相等）；`services/` 77 → 75、`legacy-service-implementations` 72 → 70、
  `legacy-horizontal-files` 198 → 196、facade 记录 78 → 76、后端生产文件 3195 → 3193；public surface 1495 → 1496（`EMPTY_RUNTIME_PROFILE`），
  偏差 96 不变；跨 context import 记录 7965 → 7957；其余 counts 与 gates 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部
  文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 26、写入口清单 2353。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`3229bcabb` 的旧文件对工作树的新位置）：两个判定文件与 `EMPTY_RUNTIME_PROFILE` 的
  12 个顶层声明里 9 个逐字相同，3 个只差预期的参数类型行——`observationForVerification` 的能力参数写成
  `Pick<StartupObservationCapabilities, 'startupObservation'>`，`buildRuntimeInventoryObservation` 与私有 `observedFacesOf` 写成
  `StartupObservationCapabilities`（`buildRuntimeInventoryObservation` 的声明清单另由 `DeclaredManifestV1` 写成它所别名的
  `DeclaredInjectionManifest`）；新增的只有 shared 的 `StartupObservationSource` 与 `StartupObservationCapabilities`；
- 判定读到的能力就是这两个字段：`observationForVerification` 只 switch `startupObservation`，`buildRuntimeInventoryObservation` 另读
  `observationRequiresFreshRun`，私有 `observedFacesOf` 不读能力；调用方传入的 `RuntimeDriverCapabilities` 结构上满足（tsc 与
  RFC-463 用例的编译期断言）；
- 留在原处的 8 个生产文件里 56 个顶层声明逐字未变；3 处差异都是预期的：`RuntimeDriverCapabilities.startupObservation` 改用 shared 的
  同一联合类型、`runNode` 与 MCP 测试台各一行注释改写判据单点的现址；`agentInjection.ts` 只删去 `EMPTY_RUNTIME_PROFILE`（默认参数改取
  runtime-management `public/types`，该文件零 import，不成环）；
- 账本：`R2` 7 → 3（实测，`R1` 99 不变）；public surface 偏差实测 96、与精确清单逐条相等（`EMPTY_RUNTIME_PROFILE` 是闭合接口的值，不添
  偏差）；公共内核清单与 RFC-317 登记的两条 P3 的锚点改指迁入后的同一段代码（按内容重新定位行号）；guard-manifest 不变。

## PR / 提交

单个提交：`refactor(backend): RFC-463 启动核验与清单观测的判定进 shared、空运行参数归 runtime-management（RFC-294 W9-D 第十步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
