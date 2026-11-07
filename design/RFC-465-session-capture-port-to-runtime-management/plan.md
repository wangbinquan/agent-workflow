# RFC-465 实施计划

**前置**：RFC-464 落地（`aad1b4a76`，Done 文档 `22350f436`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                              | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-465-T1 | 会话捕获持久化端口迁入 runtime-management（kind 用观测词汇）、`public/participants` 导出；实时捕获请求、task-execution 与驱动改取 | design §1 |
| RFC-465-T2 | `agentMaterialEvidence` 直接定义捕获请求与清扫合同并按名导出；`services/runtime/types` 的三个驱动侧形状改取它们                   | design §2 |
| RFC-465-T3 | `commons-debt`、preflight / RFC-376 结构守卫 / public surface 偏差精确清单、`rfc462` 精确清单、改指的用例；新增 RFC-465 用例      | design §3 |
| RFC-465-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                             | design §6 |
| RFC-465-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                                   | —         |

## 验收清单

- [x] AC-1 端口只在 runtime-management 定义、旧文件不在、零引用旧路径；runtime-management 的 application / domain / engine / public 零取 `@/services/` 与 task-execution；驱动侧三个形状由 runtime-management 合同给出
- [x] AC-2 架构计数按实测（`R2` 1 → 0、`R1` 99 → 96、跨 context 内部文件对 48 → 47），public surface 偏差与越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `aad1b4a76`，文档基于 `22350f436`）

本机全程高负载（采样到的负载 16～83；本机另有常驻负载：一个本地 Kubernetes 控制面容器约 5 核、三个挂起的测试夹具进程各约 1 核）。验证都在
候选导出仓库里跑（`aad1b4a76` 的 `git archive` 加候选路径，提交后运行；RFC-464 的 Done 文档提交 `22350f436` 只改 5 个文档文件，文档用例前
同步进导出仓库并核对与 HEAD 加候选逐字相同）。**集中验证查出一处本 RFC 的缺陷，已修正并复验**：`architecture/rfc317-module-boundary` 的
「R2 债务全部落在 application 层」写成 `expect(layers).toEqual(['application'])`，把「R2 非空」也一并钉了，本 RFC 销掉最后一条 `R2` 后
它在 SQLite 与 PostgreSQL 两边都红；改为「application 之外为空」（R2 存在时约束不变、清零后照样成立），guard-manifest 随之刷新它的行数，
教训记入 `docs/dev-gotchas.md`。

- **静态**：backend `tsc` 0 错（本 RFC 只改 backend 与它的用例；修正后复跑仍 0 错）；eslint `--max-warnings 0` 无告警（backend 与
  `eslint.promises.config.js`，后者只覆盖 src）；`depcheck` 分层门通过；改动的 TS 与 RFC-465 文档已按 prettier 格式化。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5568～6217 s 全部跑完，合计 23494 pass / 127 skip /
  64 fail，另有 45 条测试间未处理错误。62 条是超时（29 个文件；58 条撞默认 5 秒，`rfc354` 嵌套帧闭包、`rfc363` 目录分页与 `rfc395` 内联行
  流式暂存各一条撞自带的 30 秒，`rfc363` 任务准备准入一条撞自带的 60 秒），45 条未处理错误全出在其中 17 个超时文件里；其余 2 条：上面那处
  缺陷，与导出仓库只有候选提交所致的 `rfc321`。新增的 RFC-465 用例通过。
  - 复跑 34 个文件（30 个失败文件——导出里恒红的 `rfc321` 除外，`rfc317-module-boundary` 用修正后的版本——加 RFC-465 用例与读
    guard-manifest 的三个账本用例；30 秒时限）：32 个全过（含修正后的 `rfc317-module-boundary`、三个账本用例与 RFC-465 用例），合计 368 pass / 2 fail（负载 21～54），余下
    RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到 `running`）与 `rfc363` 目录分页（撞自带的 30 秒）——与 RFC-462～464 复跑后
    余下的两例相同。对照：同一时刻在 RFC-464 的导出仓库里跑同一文件（负载 46～51），`rfc167` 两边都是 28 pass / 1 fail、同一例到点
    （5.51 s 与 5.41 s），`rfc363` 两边都是 3 pass / 1 fail、同一例到点（30.57 s 与 30.62 s）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 220 个文件（全部 139 个架构测试；改动的用例与 RFC-454、RFC-460～464 用例；两个驱动的会话捕获、
  实时捕获、材料证据、系统代理运行与其调用方、agent 运行、写原子性、intent 轮次会话与 turn engine、守护进程装配、记忆蒸馏的会话事件 sink、
  MCP 测试台等取改动件或其消费方的用例）：198 个文件全过，合计 2431 pass / 60 fail / 4 skip（与全量 SQLite 同时跑）。RFC-465 用例 7 / 7
  通过。22 个文件失败，都在 PostgreSQL 一侧、同文件的 SQLite 一侧全过：20 个只有超时（`rfc234-intent-routes` 14 条与
  `rfc355-intent-session-event-callsites` 3 条是 beforeEach / afterEach 钩子超时）；另 2 个是上面那处缺陷（修正前的版本）与 MCP 测试台
  `rfc238-mcp-runtime-test-service`（8 例：4 例撞默认 5 秒、4 例撞用例自带的 2 秒等待）。
  - 复跑 25 个文件（22 个失败文件，`rfc317-module-boundary` 用修正后的版本，加读 guard-manifest 的三个账本用例；30 秒时限，接在 SQLite 复跑
    之后）：全过，合计 436 pass / 0 fail（含修正后的 `rfc317-module-boundary` 与 MCP 测试台那个文件）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等负载降到 26.9 / 37.8 才放行，此后本会话不再起别的负载，17 个阶段全部符合预期（0 failures）。两次运行前后 127 个受保护源文件
  的哈希一致、导出仓库工作树干净。P0 跑在上面那处修正之前；修正只改那个用例文件与 guard-manifest 的行数，二者都不在 P0 的受保护文件之内。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-465
  用例）：12 个文件全过，合计 96 pass / 0 fail（负载 25～30，`rfc376-report` 65 s）。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c464 → c465）：`R1-inbound-module-internals` 99 → 96、
  `R2-outbound-module-to-legacy` 1 → 0（账本与实测相等）；跨 context 内部文件对 48 → 47（`agentLiveCapture` → task-execution 端口那一对），
  public surface 1496 → 1501（本 RFC 按名导出的 5 个类型）、偏差 96 → 94；跨 context import 记录 7953 不变（删去 9 条：驱动与
  `services/runtime/types` 取 task-execution 端口 4 条、`agentLiveCapture` 取它 1 条、`agentMaterialEvidence` 取 `services/runtime/types` 3 条、
  `services/runtime/types` 本地取 `NormalizedEventKind` 1 条；新增 9 条：驱动与 `services/runtime/types` 取 runtime-management
  `public/participants` 6 条、task-execution 的端口与实现取它 2 条、`agentMaterialEvidence` 取 `@/util/log` 的日志器 1 条），
  模块符号归属 32278 → 32279；`services/` 75、`legacy-service-implementations` 70、facade 记录 76 与其余 counts、gates 都不变：off-DAG 值边 0、
  值环 0、平台 → 模块 0、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 26、写入口清单 2353。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`aad1b4a76` 对工作树）：迁移的端口文件里 `RuntimeSessionCapturePersistence` 逐字未变，
  `RuntimeSessionCaptureEvent` 只差 kind 一行（`NodeExecutionEventSnapshot['kind']` → `PersistedEventKind | 'stderr' | 'subagent_capture_failed'`，
  RFC-465 用例编译期锁双向相等）；改动的 8 个生产文件里 61 个顶层声明逐字未变，4 处差异都是预期的：`AgentSessionCaptureRequest` 由
  `Omit<SessionCaptureContext, …>` 改为逐字段写出（字段、可选性、可写性与注释与原来相同，编译期锁双向相等）、`AgentMaterialEvidence`
  的清扫参数改取 `SystemAgentSessionSweepRequest`、`SessionCaptureContext` 改为扩展捕获请求（只留四个位置字段）、
  `SystemAgentSessionSweepContext` 改为清扫请求的别名（sink 由结构副本改为 `SystemAgentEventSinkV1`）；`SystemAgentSessionSweepOutcome`
  原样迁入 runtime-management，由 `services/runtime/types` 再导出。
- 行为：改动全在类型层（改到的 import / export 都是 `import type` / `export type`，被删的端口文件只有类型），生成的运行时代码不变；清扫 sink
  的类型变宽不改变行为——调用方传入的本就是完整的 `SystemAgentEventSinkV1`，opencode 的清扫实现收的也是它。
- 账本：`R2` 1 → 0、`R1` 99 → 96（实测，与账本逐条相等）；public surface 偏差实测 94、与精确清单逐条相等（删 3 条、增 1 条）；跨 context
  内部文件对的两份精确清单删去 `agentLiveCapture` 那一对；guard-manifest 刷新三个改到的守卫文件的行数（`rfc294-architecture-preflight`
  534 → 533、`rfc376-structural-guards` 1120 → 1119，以及集中验证后修正的 `rfc317-module-boundary` 498 → 502）。

## CI（AC-4）

- `27ac7027a`：exact SHA 主 CI run 42382117801 首轮全绿（70 个 job）；同 SHA 的 windows-platform run 42382117811 与 integration-opencode run 42382117799 通过（后者由本 RFC 改动的 `services/runtime/opencode/sessionCapture.ts` 触发，两个 job 各 5 pass / 10 skip，跳过的是按 `RUN_OPENCODE_INTEGRATION` 与凭据门控的真实 opencode 用例）；同 SHA 上定时的 git-protocols-e2e run 42382230522 与 evidence-soak-nightly run 42384309640 也通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件全过，合计 96 pass / 0 fail（负载 14～22，`rfc376-report` 64 s），读文档的两个用例在最终文本上复跑通过。

## PR / 提交

单个提交：`refactor(backend): RFC-465 会话捕获的持久化端口与请求合同归 runtime-management（RFC-294 W9-D 第十二步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
