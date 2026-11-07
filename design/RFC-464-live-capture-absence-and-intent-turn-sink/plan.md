# RFC-464 实施计划

**前置**：RFC-463 落地（`21968c3e3`，Done 文档 `2796fd6d0`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                            | 依据      |
| ---------- | --------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-464-T1 | `taskAgentRun` 无实时捕获按缺席处理；`services/runtime/index` 删去 `NOOP_HANDLE` 再导出；注释改写               | design §1 |
| RFC-464-T2 | intent 系统代理运行端口声明 `IntentTurnEventSink` 与三个形状；轮次 sink 实现它、端口不再反取 application 层的类 | design §2 |
| RFC-464-T3 | `commons-debt`、改指的源码锁（RFC-143、RFC-048）、`rfc454` 的消费方精确清单、guard-manifest；新增 RFC-464 用例  | design §3 |
| RFC-464-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                           | design §6 |
| RFC-464-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                 | —         |

## 验收清单

- [x] AC-1 `taskAgentRun` 不取 `services/runtime`、无 `NOOP_HANDLE`，无实时捕获时不起、不停、不带去重表；intent application 零取 `@/services/`，端口不反取 application 层的 sink 类
- [x] AC-2 架构计数按实测（`R2` 3 → 1、`R1` 不变），public surface 偏差与越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-07，候选基于 `21968c3e3`，文档基于 `2796fd6d0`）

本机全程高负载（采样到的负载 23～84；本机另有常驻负载：一个本地 Kubernetes 控制面容器约 5 核、三个挂起的测试夹具进程各约 1 核）。验证都在
候选导出仓库里跑（`21968c3e3` 的 `git archive` 加候选路径，提交后运行；RFC-463 的 Done 文档提交 `2796fd6d0` 只改 5 个文档文件，文档用例前
同步进导出仓库并核对与 HEAD 加候选逐字相同）。**集中验证没有查出本 RFC 的问题**。开发期的静态自查查出两处本 RFC 用例自身的写法问题并已
改正：编译期合同锁把函数类型的值放进 `toEqual([null, …])`，backend `tsc` 报 TS2769，改为逐个判 `null`；prettier 把起捕获的调用并成一行后，
用例的源码锚点随之改为一行的写法。

- **静态**：backend `tsc` 0 错（本 RFC 只改 backend 与它的用例）；eslint `--max-warnings 0` 无告警（backend 与 `eslint.promises.config.js`）；
  `depcheck` 分层门通过；改动的 TS 与 JSON 已按 prettier 格式化。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5568～6073 s 全部跑完，合计 23488 pass / 127 skip /
  63 fail，另有 38 条测试间未处理错误。61 条是超时（28 个文件；56 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc363` 目录分页、
  `rfc395` 内联行流式暂存与 `rfc400` 协作参与方的别名探测各一条撞自带的 30 秒，`rfc370-committed-architecture-source` 的已提交报告撞自带的
  150 秒），38 条未处理错误全出在其中 13 个超时文件里；其余 2 条：导出仓库只有候选提交所致的 `rfc321`，与
  `clarify-review-combination-scenarios` 的 S-RFC074 撞用例自带的 20 秒流程看门狗（看门狗到点取消全部活动任务，断言读到 `canceled`）。
  - 复跑 30 个文件（29 个失败文件——导出里恒红的 `rfc321` 除外——加 RFC-464 用例；30 秒时限）：28 个全过，合计 286 pass / 2 fail（负载 24～69），余下 RFC-167 dw-confirm 的 `approve`（自带 5 秒 `settleTask`，读到
    `running`）与 `rfc363` 目录分页（撞自带的 30 秒）——与 RFC-462、RFC-463 复跑后余下的两例相同。对照：同一时刻在 RFC-463 的导出仓库里
    跑同一文件（负载 42～50），`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.70 s 与 5.66 s），`rfc363` 两边都是 3 pass / 1 fail、
    同一例到点（30.69 s 与 30.69 s）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 217 个文件（全部 139 个架构测试；改动的用例与 RFC-454、RFC-460～463 用例；实时子会话捕获与
  会话捕获、intent 轮次会话、turn engine、系统代理运行与其调用方、意图路由与配置、守护进程的 intent / task-execution 装配、记忆蒸馏的会话事件
  sink、MCP 测试台等取改动件或其消费方的用例）：198 个文件全过，合计 2365 pass / 58 fail / 4 skip（与全量 SQLite 同时跑）。RFC-464 用例
  6 / 6 通过。19 个文件失败，都在 PostgreSQL 一侧、同文件的 SQLite 一侧全过：18 个只有超时（`rfc234-intent-routes` 14 条与
  `rfc355-intent-session-event-callsites` 3 条都是 beforeEach / afterEach 钩子超时；`rfc355` 的 SQLite 一侧「dispatcher 的轮次事件真的到达
  广播器」正走本 RFC 改动的 intent 轮次 sink），另 1 个是 MCP 测试台 `rfc238-mcp-runtime-test-service`：9 例失败，4 例撞默认 5 秒、4 例撞用例
  自带的 2 秒等待，1 例（启动时保留已证实的原生会话）读到 `ended`——MCP 测试台走自己的事件 sink，不经过本 RFC 改动的代码。
  - 复跑 19 个文件（30 秒时限，接在 SQLite 复跑之后）：全过，合计 302 pass / 0 fail——MCP 测试台那 2 个文件（含读到 `ended` 的那例）这一轮也全过。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等负载降到 25.2 / 38.9 才放行，此后本会话不再起别的负载，17 个阶段全部符合预期（0 failures）。两次运行前后
  127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-464
  用例）：12 个文件全过，合计 95 pass / 0 fail（负载 28～31，`rfc376-report` 63 s）。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c463 → c464）：`R1-inbound-module-internals` 99 不变、
  `R2-outbound-module-to-legacy` 3 → 1（账本与实测相等，余下 runtime-management `agentMaterialEvidence` → `services/runtime/types`）；
  `services/` 75、`legacy-service-implementations` 70、`legacy-horizontal-files` 196、facade 记录 76、public surface 1496 与偏差 96 都不变；
  跨 context import 记录 7957 → 7953（intent `turnSession` 取 `services/sessionEventSink` 的 3 个类型与 `taskAgentRun` 取的 `NOOP_HANDLE`），
  模块符号归属 32274 → 32278（intent 端口新增的 4 个类型）；其余 counts 与 gates 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context
  内部文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 26、写入口清单 2353。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 声明逐个比对（TypeScript AST 取顶层声明，`21968c3e3` 对工作树）：改动的 5 个生产文件里 50 个顶层声明逐字未变；4 处差异都是预期的：
  `runNode` 的实时捕获改为可选（`?? NOOP_HANDLE` 删去后 prettier 把起捕获的调用并成一行，参数对象整体少缩进一级、内容不变；两处
  `stop()` 改为可选调用；会话捕获的去重表改为只在有句柄时带上）、`IntentSystemAgentRunRequest.eventSink` 改取端口自己的
  `IntentTurnEventSink`、`IntentTurnSessionEventSink` 改为实现它（参数与终态记忆的类型换成端口声明的同名形状，落库字段与终态排序逐字
  不变）、`RuntimeDriver.startLiveCapture?` 的注释；新增的只有 intent 端口的四个类型；`services/runtime/index` 删去 `NOOP_HANDLE` 的
  再导出（唯一的使用者就是 `runNode`）；
- 行为：有 `startLiveCapture` 的材料证据（opencode，含 `pollMs === 0` 时它自己返回的关停句柄）路径不变；没有的（claude、托管执行）原先
  stop 一个 no-op 句柄、给会话捕获一张空去重表，现在不 stop、不带——去重表唯一的读者是 opencode 的会话捕获，缺席与空表等价，
  runtime-management 本地材料证据只在请求带了该键时转发；intent 的 sink 合同与 runtime-management 的会话事件 sink 按严格函数类型逐项
  可互换、三个联合类型双向相等（RFC-464 用例的编译期断言，tsc 通过）；
- 账本：`R2` 3 → 1（实测，`R1` 99 不变）；public surface 偏差实测 96、与精确清单逐条相等；guard-manifest 不变（改到的用例都不是登记的守卫
  文件）；`rfc454` 钉的 `services/sessionEventSink` 生产消费方精确清单删去 intent `turnSession`，RFC-143 与 RFC-048 的源码锁改到新的形状
  （起捕获仍只此一处、仍可选；stop 仍在子进程退出之后、会话捕获之前；去重表转发锚点不变）。

## PR / 提交

单个提交：`refactor(backend): RFC-464 无实时捕获按缺席处理、intent 自持轮次事件 sink 合同（RFC-294 W9-D 第十一步）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
