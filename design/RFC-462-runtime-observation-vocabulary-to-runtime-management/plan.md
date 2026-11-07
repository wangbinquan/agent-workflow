# RFC-462 实施计划

**前置**：RFC-461 落地（`bf61fc4a6`，Done 文档 `1c4bd3f30`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证
一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-462-T1 | 七个观测词汇迁入 runtime-management 的两个端口文件，`public/participants` 导出；`services/runtime/types` 改为再导出 | design §1 |
| RFC-462-T2 | task-execution 两处与 runtime-management 两个端口改取 owner                                                         | design §2 |
| RFC-462-T3 | `commons-debt`、public surface 偏差精确清单、guard-manifest；新增 RFC-462 用例                                      | design §3 |
| RFC-462-T4 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                               | design §6 |
| RFC-462-T5 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                     | —         |

## 验收清单

- [x] AC-1 七个观测词汇只在 runtime-management 定义一次；四处不再为它们取 `services/`
- [x] AC-2 架构计数按实测（`R2` 11 → 7、`R1` 不变），public surface 偏差与越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [x] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06～07，候选基于 `1c4bd3f30`）

本机全程高负载（采样到的负载 28～68；本机另有常驻负载：一个本地 Kubernetes 控制面容器约 5 核、三个挂起的测试夹具进程各约 1 核）。验证都在
候选导出仓库里跑（`1c4bd3f30` 的 `git archive` 加候选路径，提交后运行）。**集中验证没有查出本 RFC 的问题**。

- **静态**：backend `tsc` 0 错（shared 与前端未改动）；eslint `--max-warnings 0` 无告警（含 `eslint.promises.config.js`；起初
  `services/runtime/types.ts` 留着三个随迁移不用的 shared 类型 import，删去）；`depcheck` 分层门通过；改动的 TS 与 JSON 已按 prettier 格式化。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5486～6219 s 全部跑完，合计 23471 pass / 127 skip /
  64 fail，另有 42 条测试间未处理错误。62 条是超时（28 个文件；57 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc354` 嵌套帧闭包、
  `rfc363` 目录分页各一条撞自带的 30 秒，`rfc294-architecture-preflight` 的模块能力归属与 `rfc370-committed-architecture-source` 的已提交
  报告各撞自带的 180 / 150 秒），42 条未处理错误全出在其中 15 个超时文件里；其余 2 条：导出仓库只有候选提交所致的 `rfc321`，与
  `scheduler-envelope-followup-integration` 的 `retries=0`——紧跟同文件一条超时用例，那条用例没收尾的驱动在它运行时关了库，argv 日志
  读到 0 条。新增的 RFC-462 用例通过。
  - 复跑 30 个文件（28 个超时文件、`rfc321` 与 RFC-462 用例；30 秒时限，负载 32～45）：27 个全过，合计 260 pass / 3 fail，余下 RFC-167
    dw-confirm 的 `approve`（自带 5 秒 `settleTask`，到点时任务仍是 `running`）、`rfc363` 目录分页（撞自带的 30 秒）与导出仓库里恒红的
    `rfc321`。对照：同一时刻在 RFC-461 的导出仓库里跑同一文件，`rfc167`（负载 49）两边都是 28 pass / 1 fail、同一例到点（5.64 s 与
    5.79 s），`rfc363`（负载 63）两边都是 3 pass / 1 fail、同一例到点（30.61 s 与 30.60 s）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 172 个文件（全部 139 个架构测试；改动的 2 个用例文件与 RFC-460 / RFC-461 用例；驱动事件
  解析、能力声明自检、spawn 与配置目录、agent 运行与调用绑定、运行时观测与启动清单、系统代理运行等取观测词汇或其消费方的用例）：167 个
  文件全过，合计 1783 pass / 10 fail / 4 skip。5 个文件只有超时（与全量 SQLite 同时跑）。
  - 复跑 5 个超时文件（30 秒时限，接在 SQLite 复跑之后）：全过，合计 48 pass / 0 fail。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期
  （0 failures）；PostgreSQL 等负载降到 27.8 / 37.8 才放行，此后本会话不再起别的负载，17 个阶段全部符合预期（0 failures）。两次运行
  前后 127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，加 RFC-462
  用例）：在与 HEAD 加候选逐字相同的导出仓库上 95 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c461 → c462）：`R1-inbound-module-internals` 99 不变、
  `R2-outbound-module-to-legacy` 11 → 7（账本与实测相等）；public surface 1488 → 1495、偏差 101 → 96（见实现门）；跨 context import 记录
  7960 → 7965（按符号计：task-execution 与 runtime-management 端口取 `services/runtime/types` 的记录换成取 runtime-management public，
  `services/runtime/types` 的再导出多出 7 个名字）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context 内部文件对 48、
  off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 26、写入口清单 2353、`services/` 与 `legacy-service-implementations`
  不变（本 RFC 不删文件）。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`1c4bd3f30` 的 `services/runtime/types.ts` 对工作树的两个端口文件）：七个里六个逐字相同，
  `DeclarationFace` 只把右边的 `keyof DeclaredManifestV1` 写成 `keyof DeclaredInjectionManifest`（前者是 `services/execution/agentInjection`
  里后者的别名，同一个类型）；迁移按各声明自己附着的 JSDoc 切，`DeclarationFace` 上方错位的 `RuntimeDriver` 文档注释留在原处；
- 留在原处的 7 个生产文件里 59 个顶层声明逐字未变（`services/runtime/types.ts` 只删去七个声明、调整 import / 再导出与三个随之不用的
  shared 类型 import）；
- `services/runtime/types` 的再导出与 runtime-management `public/participants` 指向同一批声明，驱动一族与 `services/execution/*` 的 import
  不变；task-execution 的两处与 runtime-management 的两个端口取到的就是定义处；
- public surface：+7（新导出的七个闭合类型）；偏差 101 → 96——六条「forbidden type import `@/services/runtime/types`」消失，新出现一条
  `AgentInvocationProtocol: unsafe/open type MappedType`：能力声明进模块后，表面遍历第一次走进 `declarationFaces` 的
  `Readonly<Record<DeclarationFace, FaceSupport>>`（闭合面集上的映射类型，正是「新增清单面在每个驱动里编译期报错」的那道棘轮），
  登记进 `rfc294-architecture-preflight` 的精确清单并写明来由。

## CI（AC-4）

- `3229bcabb`：exact SHA 主 CI run 42350015904 首轮全绿（70 个 job）；同 SHA 的 windows-platform run 42350015919 与 integration-opencode run 42350015862 通过。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 5 个 Done 文档文件）的导出仓库上重跑上述文档用例：12 个文件合计 94 pass / 1 fail——
  `rfc376-report` 的「同一已提交源两次读出逐字相同的报告」两次都撞自带的 300 秒（306.8 s；单独复跑 409.4 s；负载 35～50，本会话
  RFC-463 的全量 SQLite 与 PostgreSQL lane 同时在跑）。该用例只对已提交源生成两次报告、不读文档，RFC-462 候选上 71 s 通过；其余
  11 个文件全过。负载降下来后的复跑记在 RFC-463。

## PR / 提交

单个提交：`refactor(backend): RFC-462 运行时观测词汇归 runtime-management（RFC-294 W9-D 第九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
