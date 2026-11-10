# RFC-479 实施计划

**前置**：RFC-478 落地（Done，`0133385a8` / `27a42a3aa`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中
验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                  | 依据         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-479-T1 | `checkCounts` 低于上限判红、返回值只剩 `errors`；调用方随改；4 项 `max` 收紧到实测                                                                                                                    | design §2    |
| RFC-479-T2 | `publicContractGateSets`（未消费 public 符号、public 类型偏差）并进 `reportGateSets`；报告复用 surfaces；基线渲染去重                                                                                 | design §3    |
| RFC-479-T3 | `compositionControlFlowSets`（19 项 `composition-control-flow-<module>`）并进 `reportGateSets`                                                                                                        | design §4    |
| RFC-479-T4 | `architecture/counts.json` 登记 21 项新计数（`max` = 实测，`reason` 写口径）                                                                                                                          | design §2–§4 |
| RFC-479-T5 | 用例：`checkCounts` 的低于上限分支；新增 RFC-479 用例（两类新门的 fixture 变异与真实语料对账）；`rfc376-report` 项数；guard-manifest                                                                  | design §6    |
| RFC-479-T6 | RFC-294 plan §1.2 增列「结构锁 / 覆盖范围」并逐行填写；plan §3 S10 记一句「减速带接口」（经确认的上限直接改这些项，新门落地后取代）；`docs/dev-gotchas.md` 一条                                       | design §5    |
| RFC-479-T7 | 集中验证（`tests/architecture/**`、RFC-294 相关守卫、文档用例、`tsc` / eslint / prettier；改动只在用例与账本，全量按受影响范围定）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾 | design §6    |

## 验收清单

- [x] AC-1 `counts.json` 每项 `max` = 实测；低于上限即红（带负对照）
- [x] AC-2 `unconsumed-public-symbols`、`public-surface-deviations` 入带，与报告章节逐条相同，各有会红的变异用例
- [x] AC-3 19 项 `composition-control-flow-<module>` 入带，与 F13 口径的差异逐条说明，有会红的变异用例
- [x] AC-4 RFC-294 plan §1.2 新列没有空格、逐行可复核
- [x] AC-5 受影响用例全部通过；exact SHA CI 全绿：`0d591604b` 主 CI run 42901079116 的 70 个 job 全部通过

## 集中验证（2026-11-10，候选基于 `9334dc15f`）

本机全程高负载（10 核；外部的 kind 集群一家占 5～6 核，另有常驻 bun 进程约 2 核；采样到的 1 分钟负载 26～69）。验证在候选导出仓库里跑
（HEAD 的树加候选路径，提交后运行；修复后重新同步，核对与 HEAD 加候选逐字相同）。验证期间 `origin/main` 未前进。本 RFC 不改生产代码，
受影响的只有读这两个守卫模块与两本账的用例，所以不跑全量与 PostgreSQL lane（这些用例都是源码 / AST 判据，与引擎无关），按受影响范围跑。
集中验证查出本 RFC 的两处问题，都已修复并复验：

1. **类型**：新用例里 `publicContractGateSets(...)['public-surface-deviations']` 的下标结果按仓库的 `noUncheckedIndexedAccess` 可能是
   `undefined`，`tsc` 报 TS18048；改为可选链取第一条。
2. **减速带用例的预算**：public surfaces 的构造放在用例体里，本机 1 分钟负载 66 时超过 120 s 预算（负载 26 时 36.5 s）。改为与 `OBSERVED`
   一样在用例文件加载时构造一次，减速带用例只做计数比对，预算回到原来的 20 s（复跑整文件 40.6 s）。

- **静态**：backend `tsc` 0 错（`tsconfig` 覆盖 `tests/`）；eslint `--max-warnings 0` 无告警（改动的 5 个 TS 文件）；改动的 TS 与 RFC-479
  三件套 prettier 检查通过（`architecture/*.json` 按仓库约定不进 prettier）。
- **受影响用例**（SQLite，导出仓库，4 个 worker）：`tests/architecture/` 全部 140 个用例文件、取这两个守卫模块或两本账的另外 26 个用例
  文件与文档用例，去重后 172 个：165 个全过；7 个在负载 66～69 时撞时限（`rfc376-report` 300 s、`rfc376-structural-guards` 120 s——即上面
  第 2 处、`rfc395-neutral-query-boundary` 60 s、`rfc400-collaboration-task-participants` 30 / 5 s、`rfc425` 5 s、
  `rfc294-architecture-preflight` 60 / 180 s、`rfc370-committed-architecture-source` 150 s），2 个 worker、负载 31～56 时复跑 7 个全过；
  第 2 处修复后，减速带用例与读 guard-manifest 的四个用例（`rfc479`、`rfc317-guard-corpus-floor`、`rfc317-guard-negative-fixture`、
  `rfc317-architecture-ledgers`）在最终候选上复跑全过。
- **架构报告**（`scripts/architecture-report.ts --gates` 在导出仓库的提交上采数，对照 RFC-478 收口时同一生产代码的报告）：只多出 21 个
  门与计数（两项 public 合同 322 / 88、19 项 composition 控制流，合计 1,197 行），原有 21 项门、指标与全部章节（public surface 1477、偏差
  88、未被消费的 public 符号 322、跨 context import 7678 等）逐项相同；42 项实测与 `architecture/counts.json` 的 `max` 逐项相等。
- **F13 对账**：19 个模块里 18 个的语法树计数与 F13 的行首正则逐行相同；development-automation 语法树 660、正则 667，多出的 7 行都落在
  字符串 / 模板 / 注释里（用例逐行断言：正则多出的行只能落在字符串 / 模板 / 注释里，语法树计数的行都被正则认出）。
- **§1.2 新列的依据**：37 行按各锁的源码与 `architecture/guard-manifest.json` 逐行写成（四路并行检索，每行带文件与行号证据），本会话
  抽查 RFC-334 的语料下限、RFC-331 / 339 / 345 / 347 / 310 / 355 的 guard-manifest 登记、RFC-347 无语料下限、RFC-345 的 24 个退役 facade，
  与检索结果一致。
- **文档用例**：最终文档上接 PostgreSQL 跑 RFC 索引状态、文档与实现对账、RFC-294 设计对账、过期断言不变量、`test-suite-policy`
  与 RFC-478 用例等 11 个文件：90 pass。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，结论 PASS：

- `checkCounts`：低于上限与高于上限对称判红，消息给出应改成的值；等于上限通过；未知 / 缺失 id、非法数值、`reason` 不符的判据不变；唯一
  调用方随改，不再打印 `decreases`。
- public 合同两项：计数与报告章节同一个函数、同一份 inventory（报告里同一个 surfaces 值先交给门再写章节，`rfc376-report` 在提交的源码上
  断言逐条相同）；`renderGateBaselines` 只少了那行重复的常量，其余输出不变（报告逐字节确定性用例通过）。
- composition 控制流：只认 `modules/<module>/composition/`，模块根下的 `composition.ts` 与其他目录不计（与 F13 同）；每个有该目录的模块都有
  一项（含 7 个为 0 的模块），新增或删掉目录会以 `missing count` / `unknown count` 报出；fixture 覆盖七种语句、四类不计的写法与嵌套目录。
- 账本：`architecture/counts.json` 42 项，`reason` 都含与 `max` 相同的 `max=N`；guard-manifest 新增一条的字段取自 census 的实测
  （`corpusScanner`、`minCorpusFiles` 2000、`assertsAbsence`、`negativeFixture`），改到的两条只刷新行数。
- 开发中自查出并在测试前改掉一处：真实语料对账原来用「development-automation 那 7 行」作正对照，会随无关改动失效；改为在 fixture 上自测
  对账判据，真实语料只断言没有错配。

## CI（AC-5）

- `0d591604b` 主 CI run 42901079116：70 个 job 全部通过（「CI required」绿）。本提交只改用例、账本与文档，没有命中其余 push workflow 的路径过滤，同一 SHA 只有主 CI 一个 run。
- Done 文档提交前，在与 HEAD 逐字相同（加本次 Done 文档文件）的导出仓库上接库重跑文档用例：12 个文件 98 / 98。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`test(architecture): RFC-479 治理补洞——减速带上限 = 实测、public 合同两项计数与 composition 控制流入带（RFC-294 S11）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
