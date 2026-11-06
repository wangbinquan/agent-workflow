# RFC-458 实施计划

**前置**：RFC-457 落地（`390ab1228`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施
中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                          | 依据      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------- |
| RFC-458-T1 | 解析器迁入 `packages/shared/src/workflowOutputEnvelope.ts` 并从 shared 入口导出                                               | design §1 |
| RFC-458-T2 | 校验失败序列化 / 解析迁入 task-execution application，端口内容包装迁入 composition；`scriptPorts` 迁入 domain；删除两个旧文件 | design §1 |
| RFC-458-T3 | 消费方改指（intent、memory、task-execution、`services/commitPush`）与用例按导出名分流                                         | design §2 |
| RFC-458-T4 | 按路径读源码的锁、架构报告归属表、`commons-debt` 账本、guard-manifest；新增 RFC-458 用例；注释与文档现状路径                  | design §3 |
| RFC-458-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                         | design §6 |
| RFC-458-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                               | —         |

## 验收清单

- [x] AC-1 两个旧文件不在、零引用；解析器只在 shared 定义一份
- [x] AC-2 架构计数按实测（`services/` 84 → 82、`R1` 108 → 101、`R2` 27 → 23），越界类计数不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06，候选基于 `390ab1228`，文档基于 `f3540d4ea`）

本机全程高负载（负载 15～112）。验证都在候选导出仓库里跑（`390ab1228` 的 `git archive` 加候选路径，提交后运行；RFC-457 的 Done 文档提交
`f3540d4ea` 只改 5 个文档文件，随后同步进导出仓库）。

- **静态**：`tsc`（backend、shared、frontend）0 错；eslint `--max-warnings 0` 无告警（45 个 TS 文件）；改动的 TS 与 JSON 已按 prettier 格式化；
  没有触及登记的守卫文件，`guard-manifest.json` 不变。迁移前按 `docs/dev-gotchas.md` 的三种形态全仓搜两个文件名与 12 个导出名。
- **shared 包用例**（导出仓库里 `bun test`）：2344 pass / 0 fail。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：5032～5451 s 全部跑完，合计 23454 pass / 127 skip /
  50 fail，另有 30 条测试间未处理错误。49 条是超时（21 个文件；44 条撞默认 5 秒，`rfc300` Webhook 工作区清理、`rfc354` 嵌套帧闭包与
  `rfc363` 目录分页各一条撞自带的 30 秒，`rfc098` wrapper 判 stale 一条撞自带的 20 秒，`rfc376-report` 的「两次读同一提交出同一份报告」撞
  自带的 300 秒——它要连跑两遍架构报告），30 条未处理错误全出在其中 11 个超时文件里；另 1 条是导出仓库只有候选提交所致的 `rfc321`。
  - 失败的 21 个文件逐个复跑（30 秒时限）：19 个全过，合计 219 pass / 2 fail，余下两例仍是 RFC-167 dw-confirm 的 `approve`（自带 5 秒
    `settleTask`）与 RFC-363 目录分页（自带 30 秒）。对照：同一时刻在 RFC-457 的导出仓库里跑同一文件（负载 106～112），失败的是同一例（两边
    28 / 1、3 / 1；5.46 s 与 5.51 s，30.32 s 与 30.36 s）。
- **导出仓库接 PostgreSQL 真库**：第一条 lane 556 个文件（全部 139 个架构测试；改动的 27 个用例文件；提及信封导出名、端口内容 / 校验失败、
  脚本端口或这些消费方文件的用例；live opencode 集成用例只在 integration-opencode workflow 里跑）：514 个文件全过，合计 7375 pass / 158 fail /
  4 skip。42 个文件失败：40 个只有超时（负载 50～112，多数撞默认 5 秒）；`rfc311-perf-guards` 的 8 例跨引擎对比撞自带的 180 秒，afterAll
  随之报「0 / 8 条路径完成对比」；`rfc321`（同上）。
  - 复跑 41 个文件（30 秒时限）：40 个全过（`rfc311-perf-guards` 8 条路径的跨引擎对比都完成），合计 704 pass / 1 fail，余下一例是
    `review-detail-render-rfc158` 的 R2b（自带 20 秒）。对照：同一时刻在 RFC-457 的导出仓库里跑同一文件（负载 37），两边都是 5 pass / 1 fail、
    同一例到点（RFC-456 集中验证时也是这一例）。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等 1 分钟负载降到 30 以下、5 分钟降到 40 以下再跑，17 个阶段全部符合预期（0 failures）；两次运行前后 127 个受保护源文件的
  哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-458 用例）：在最终文档上 97 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c457 → c458）：`services/` 84 → 82 个 TS 文件；
  `legacy-horizontal-files` 205 → 203、`legacy-service-implementations` 79 → 77、facade 清单 85 → 83、后端生产文件 3199 → 3198（shared
  多一个，生产文件总数不变）、跨 context import 8010 → 7983；`R1-inbound-module-internals` 108 → 101、`R2-outbound-module-to-legacy`
  27 → 23（账本与实测相等）；public surface 不变（shared 的新导出不是模块 public 面）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 →
  模块 0、跨 context 内部文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1、不可达生产文件 27、没有跨 context 消费方的
  public 符号不变。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`390ab1228` 的原位置对工作树的新位置）：解析器的 21 个顶层声明（含私有正则助手）、
  task-execution 的 4 个函数与 `scriptPorts` 的 2 个声明逐字相同；留在原处、只改 import 的 15 个生产文件（含 shared 的入口与三处注释）的
  217 个顶层声明逐字未变，另两处差异只是函数体与接口成员注释里的路径；
- 消费方按导出名分流，名字不变：intent turn engine、memory 蒸馏输出、`services/commitPush` 只取解析器（→ shared）；task-execution
  `taskAgentRun` 取解析器与 `PortValidationError` / 校验失败序列化（同层 application），`agentNodeExecution`（composition）与
  `taskRouteOperations`（infrastructure）取 application 的 `parsePortValidationFailuresJson`——没有 application 取 composition 的新边；
- `envelope.ts` 原有的再导出（`PortValidationError`、`NODE_VALIDATE_IO`、两个类型）删除后，消费方改取声明处，取到的是同一份；
- 解析器只在 shared 定义一份，shared 入口导出的就是它（新用例断言）；`resolvePortContent{,Detailed}` 仍是 composition 原生解析的薄包装
  （新用例对同一输入比对）；
- 集中验证没有查出本 RFC 的问题。

## PR / 提交

单个提交：`refactor(backend): RFC-458 workflow-output 信封解析器归 shared（RFC-294 W9-D 第五步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
