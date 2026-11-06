# RFC-459 实施计划

**前置**：RFC-458 落地（`67229b932`，修复 `8c715b39c`，Done 文档 `3354e7573`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与
用例完成后集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                       | 依据          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-459-T1 | owner 作用域名的谓词、冲突判定与两个兼容名迁入 resource-catalog；identity-access 删去实现与再导出                          | design §1     |
| RFC-459-T2 | 代理启动保留迁入 resource-catalog application，`public/participants` 再导出 acquire / release                              | design §1     |
| RFC-459-T3 | 身份门面迁入用例 helper；删除三个 `services/` 文件                                                                         | design §1     |
| RFC-459-T4 | 消费方与用例改指；按路径读源码的锁、架构报告归属表、`commons-manifest` / `commons-debt`、guard-manifest；新增 RFC-459 用例 | design §2、§3 |
| RFC-459-T5 | 集中验证；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI                                                      | design §6     |
| RFC-459-T6 | 收尾：proposal 状态、RFC 索引、`STATE.md`、RFC-294 plan（W9-D）                                                            | —             |

## 验收清单

- [x] AC-1 三个旧文件不在、零引用；owner 名实现只在 resource-catalog；保留表只有一份
- [x] AC-2 架构计数按实测（`services/` 82 → 79、`R1` 101 → 99、`R2` 不变），越界类计数与 public surface 偏差不升
- [x] AC-3 受影响用例与新增用例全部通过
- [ ] AC-4 exact SHA CI 全绿

## 集中验证（2026-11-06，候选基于 `3354e7573`）

本机全程高负载（负载 40～70）。验证都在候选导出仓库里跑（`3354e7573` 的 `git archive` 加候选路径，提交后运行）。

- **静态**：`tsc`（backend）0 错；eslint `--max-warnings 0` 无告警（31 个 TS 文件）；改动的 TS 与 JSON 已按 prettier 格式化；
  `guard-manifest.json` 刷新两个登记守卫（`rfc376-structural-guards`、`rfc305-architecture-lock`）的摘要。迁移前按 `docs/dev-gotchas.md`
  的三种形态全仓搜 5 个旧文件名与它们的导出名（含仓库根 `tests/` 与 `.github`）。
- **全量 SQLite**（导出仓库里 `bun run test:backend`，四分片，分片时限 2 小时）：4763～5746 s 全部跑完，合计 23467 pass / 127 skip /
  45 fail，另有 33 条测试间未处理错误。44 条是超时（21 个文件；42 条撞默认 5 秒，`rfc354` 嵌套帧闭包与 `rfc363` 目录分页各一条撞自带的
  30 秒），33 条未处理错误全出在其中 13 个超时文件里；另 1 条是导出仓库只有候选提交所致的 `rfc321`。
  - 失败的 21 个文件逐个复跑（30 秒时限）：19 个全过，合计 207 pass / 2 fail，余下两例仍是 RFC-167 dw-confirm 的 `approve`（自带 5 秒
    `settleTask`）与 RFC-363 目录分页（自带 30 秒）——与 RFC-458 集中验证时余下的两例相同。对照：同一时刻在 RFC-458 的导出仓库里跑同一
    文件，`rfc167` 两边都是 28 pass / 1 fail、同一例到点（5.67 s 与 5.66 s，负载 56～61）；`rfc363` 两边都是 4 pass / 0 fail（各 29 s，
    负载 59～62）。
- **导出仓库接 PostgreSQL 真库**：一条 lane 276 个文件（全部架构测试；改动的 18 个用例文件；提及 owner 名或启动保留的导出名、身份门面
  helper 或这些消费方文件的用例；live opencode 集成用例只在 integration-opencode workflow 里跑）：247 个文件全过，合计 3199 pass /
  104 fail / 5 skip。29 个文件失败，全是超时（负载 50～70；多数撞默认 5 秒，`rfc370` 技能内容根绑定两条撞自带的 20 秒、`rfc395-v3` 两条
  撞自带的 30 秒、`rfc376-report` 一条撞自带的 300 秒）。
  - 复跑这 29 个文件（30 秒时限）：全过，合计 412 pass / 0 fail。
- **P0 变异 lane**（`scripts/rfc359-p0-mutations.ts`，另一份同内容的导出仓库，两引擎分开跑）：SQLite 17 个阶段全部符合预期（0 failures）；
  PostgreSQL 等 1 分钟负载降到 30 以下、5 分钟降到 40 以下再跑（开跑时 20 / 39），17 个阶段全部符合预期（0 failures）；两次运行前后
  127 个受保护源文件的哈希一致、导出仓库工作树干净。
- **RFC-321 发布账本**：工作树里 10 / 10（导出仓库只有候选提交，该用例在导出里恒红）。
- **文档用例**（RFC 索引状态、设计与实现对齐、RFC-294 设计对齐与两条评审规则、测试套件策略、`rfc376-report` 等 11 个文件，
  加 RFC-459 用例）：在最终文档上 97 pass / 0 fail。
- **计数复核**（`scripts/architecture-report.ts` 在两份导出仓库的提交上采数，c458 → c459）：`services/` 82 → 79 个 TS 文件；
  `legacy-horizontal-files` 203 → 200、`legacy-service-implementations` 77 → 74、facade 清单 83 → 80、不可达生产文件 27 → 26（身份门面
  出了生产代码）、后端生产文件 3198 → 3196（新增 3 个、删去 5 个）、跨 context import 7983 → 7974、写入口 2360 → 2355（身份门面的 5 个
  写函数随之出了生产代码）；`R1-inbound-module-internals` 101 → 99、`R2-outbound-module-to-legacy` 23 不变（账本与实测相等）；public
  surface 1487 → 1488（identity-access −1、resource-catalog +2），偏差数不变；没有跨 context 消费方的 public 符号 322 → 323——identity-access
  `public/operations` 的 `OidcIdentityProfileAccess`（`composeOidcIdentityOperations` 的可选入参类型）唯一的跨 context 消费方是迁出的
  身份门面，该计数不设门，记为债（随 identity-access public 面收口）；其余 counts 都不变：off-DAG 值边 0、值环 0、平台 → 模块 0、跨 context
  内部文件对 48、off-DAG offered 文件对 55、`module-layer-violations` 1。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- 迁移的声明逐个比对（TypeScript AST 取顶层声明，`3354e7573` 的原位置对工作树的新位置）：owner 名一族 7 个（谓词、两个兼容名、冲突判定
  及其 2 个私有助手与错误形状接口）、保留表 4 个、身份门面 14 个，共 25 个逐字相同；留在原处、只改 import / 再导出的 7 个生产文件的
  128 个顶层声明逐字未变；
- 两个兼容名改取同文件的谓词与同模块 application 的冲突判定，取到的是同一份（此前经 `services/` 转手取 identity-access 的 composition
  与 public）；
- 保留表：resource-catalog 的删除守卫（`agentPersistenceSemantics`）取 application 那一份，task-execution 的单代理启动经 resource-catalog
  `public/participants` 取 acquire / release；新用例断言两边是同一个函数、读写同一张表，引用计数行为不变；
- identity-access 删去的两条再导出在 identity-access 之外只有已删的 `services/ownerScopedName.ts` 与改指的用例在用（tsc 兜底）；
- 身份门面迁入用例 helper 后 7 个用例改取 helper，`rfc212` 的锚点随之改指，断言内容不变。

## PR / 提交

单个提交：`refactor(backend): RFC-459 owner 作用域名与代理启动保留归 resource-catalog（RFC-294 W9-D 第六步）`。走私有 index、按路径清单提交，
在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
