# RFC-461 实施计划

**前置**：RFC-460 落地（`a4831eda5`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------- | --------- |
| RFC-461-T1 | task-execution 端口包加 `status`，`taskAgentRun` 三处 ping 改经它；各构造处接 `broadcastNodeStatus` | design §1 |
| RFC-461-T2 | memory 工作存储端口加 `events`，蒸馏与调度改经它；infrastructure 实现                               | design §1 |
| RFC-461-T3 | 三处类型改取 owner 的出口                                                                           | design §2 |
| RFC-461-T4 | 用例改接端口；`commons-debt`、guard-manifest；新增 RFC-461 用例                                     | design §3 |
| RFC-461-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                               | design §6 |
| RFC-461-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                     | —         |

## 验收清单

- [x] AC-1 三处 WS 推送经端口、三处类型改取 owner 的出口
- [x] AC-2 架构计数按实测（`R2` 17 → 11、`R1` 不变），越界类计数与 public surface 不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06～07，候选基于 `a4831eda5`，文档基于 `4d3189753`）

本机全程高负载（负载 16～148）。验证都在候选导出仓库里跑（`a4831eda5` 的 `git archive` 加候选路径，提交后运行；RFC-460 的 Done 文档提交
`4d3189753` 只改 5 个文档文件，随后同步进导出仓库）。**集中验证查出本 RFC 的三处问题**，修复后同步进导出仓库复验（见下）。

- **静态**：backend `tsc` 0 错（蒸馏工作存储的 `events` 起初包在 `Object.freeze` 里丢了上下文类型，改为直接的对象字面量）；eslint
  `--max-warnings 0` 无告警（含 `eslint.promises.config.js`）；`depcheck` 分层门通过；改动的 TS 与 JSON 已按 prettier 格式化。
- **本 RFC 的问题（三处，都是「钉住了还剩下的」的用例没随之更新；只在跑全量守卫时看得到，tsc / eslint 不报，已记入
  `docs/dev-gotchas.md`；修复后在导出仓库里两引擎复跑都通过）**：
  1. `rfc294-architecture-preflight` 的 public surface 偏差精确清单：`agentSessionEvents.ts` 改取同模块定义后，那条「forbidden type import
     `@/services/runtime/types#NormalizedEventKind`」偏差消失，清单报 stale——删去该条（guard-manifest 行数随之刷新）；
  2. `rfc454-services-one-hop-facade-sweep` 钉的 `services/sessionEventSink` 生产消费方精确清单：删去 memory `distillWorkStore.ts`；
  3. `rfc460-shared-ref-resolvers-and-envelope-nonce` 钉的「memory 蒸馏只剩 `services/runtime/types`」：改为零。
- **全量 SQLite**（修复前的导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4839～5449 s 全部跑完，合计 23468 pass /
  127 skip / 61 fail，另有 41 条测试间未处理错误。56 条是超时（23 个文件；53 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc354` 嵌套帧
  闭包、`rfc363` 目录分页各一条撞自带的 30 秒），41 条未处理错误全出在其中 14 个超时文件里；其余 5 条：上面三处本 RFC 的问题、导出仓库只有
  候选提交所致的 `rfc321`、`rfc398` 启动信号转发一例（轮询读到写了一半的 JSON，负载 140 下）。
  - 修复同步后复跑 28 个文件（23 个超时文件、`rfc398`、三处修好的守卫与 RFC-461 用例；30 秒时限，负载 85～148）：24 个全过，合计
    264 pass / 4 fail，余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`）、`rfc300`、`rfc354`、`rfc363`（各撞自带的 30 秒）。
    对照：同一时刻在 RFC-460 的导出仓库里跑同一文件（负载 37～77），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.63 s 与 5.69 s），
    `rfc363` 两边都是 3 pass / 1 fail、同一例到点（30.66 s 与 30.69 s），`rfc300`（2 / 0）与 `rfc354`（1 / 0）两边都过。
- **导出仓库接 PostgreSQL 真库**：一条 lane 214 个文件（全部架构测试；改动的 5 个用例文件；提及 agent 运行端口包、节点状态推送、蒸馏工作
  存储与 WS 频道、会话事件 sink 或这些消费方文件的用例；live opencode 集成用例只在 integration-opencode workflow 里跑）：191 个文件全过，合计
  2508 pass / 115 fail / 4 skip。23 个文件失败：21 个只有超时（负载 50～60；多数撞默认 5 秒，`scheduler-cross-clarify-dispatch` 两条撞自带的
  60 秒），另两个是上面本 RFC 的问题 1 与 3。
  - 复跑 21 个超时文件（30 秒时限）：19 个全过，合计 502 pass / 4 fail，余下 `scheduler-default-retries` 三例（各撞自带的 4 / 16 / 24 秒）与
    `rfc099-ws-acl-filter` 一例（`/ws/memories` 逐帧过滤里 owner 漏收一帧，该用例直接调 broadcaster、不经本 RFC 改的路径）。对照：同一时刻在
    RFC-460 的导出仓库里跑同一文件（负载 84～141），`rfc099` 两边都是 10 pass / 0 fail；`scheduler-default-retries` 本 RFC 8 pass / 1 fail、
    RFC-460 9 pass / 0 fail——同一例两边耗时相同（6.89 s 与 6.75 s，都超过它自带的 4 秒，超时回调与完成谁先到看负载），
    负载降到 30～49 后再对照一次：两边都是 9 pass / 0 fail，各例耗时相当（同一例 6.14 s 与 6.24 s）。
  - 修好的三处守卫与 RFC-461 用例在 PostgreSQL 下复跑：4 个文件全过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 第一次在负载门放行的同一分钟撞上本会话自己起的三路 SQLite 复跑（负载冲到 148），`current-before` 撞默认 5 秒超时、harness 以
  SIGTERM 收场——不是本 RFC 的问题，整轮作废；复跑结束、负载降到 16 / 40 后重跑，17 个阶段全部符合预期（0 failures）。两次运行前后
  127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-461 用例）：在最终文档上 96 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c460 → c461）：`R1-inbound-module-internals` 99 不变、
  `R2-outbound-module-to-legacy` 17 → 11（账本与实测相等）；public surface 偏差 102 → 101（见实现门）；跨 context import 7965 → 7960；
  写入口清单 2352 → 2353（命名启发式把蒸馏文件的本地类型别名 `RuntimeKind` 算进去，与已在清单里的 `RunDistillOptions` 同理，不设门）；
  `services/` 文件数、public surface 与其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对 48、off-DAG offered
  文件对 55、`module-layer-violations` 1、不可达生产文件 26。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`a4831eda5` 对工作树）：改动的 10 个生产文件里 97 个顶层声明逐字未变；12 处差异都是预期的：
  `runNode` 的三处 ping 换成 `purpose.status.broadcastNodeStatus(…, 'running')`、`TaskAgentRunPurpose` 加 `status`、三个端口包构造处各加
  `status: { broadcastNodeStatus }`；memory 的候选推送与五处作业推送换成 `store.events`（私有 `publish` 多一个工作存储入参）、
  `MemoryDistillWorkStore` 加 `events`、infrastructure 的工作存储实现它（两行就是原来 application 里的 broadcast）；新增的只有
  `MemoryDistillEvents` 与蒸馏文件里的两个本地类型别名；`agentSessionEvents.ts` 与 `distillWorkStore.ts` 只改 import；
- 推送的消息不变：infrastructure 的 `broadcastNodeStatus` 发出的对象与原字面量相同（同频道、`id: -1`、`type: 'node.status'`，
  字段 `nodeRunId` / `nodeId` / `status`），memory 两类消息原样转给原来的两个 broadcaster；时机不变（每处端口调用都在原 broadcast 的
  位置）；
- 类型取到的是同一个定义：`NormalizedEventKind` 的定义处就是 `agentObservations.ts`（`services/runtime/types` 原是再导出），
  `SystemAgentEventSinkV1` 是 runtime-management `public/participants` 导出的同一接口，memory 蒸馏的两个别名展开后与原类型相同
  （`SystemAgentRunRequest.protocol` 即 `RuntimeKind`，`PreparedSystemAgentRunResult.outputEvidence` 即 `SystemAgentOutputEvidence`）；
- 端口包构造仍不读选项（native 兼容用例的 Proxy 断言照旧），`status` 是普通成员，没有 getter；
- 架构报告顺带少了一条 public surface 偏差：runtime-management 的 `SystemAgentEventSinkV1` 原先因经 `services/runtime/types` 取
  `NormalizedEventKind` 记为「forbidden type import」，改取同模块定义后消失。

## PR / 提交

单个提交：`refactor(backend): RFC-461 application 层的 WS 推送改经端口、运行时类型改取 owner 的出口（RFC-294 W9-D 第八步）`。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
