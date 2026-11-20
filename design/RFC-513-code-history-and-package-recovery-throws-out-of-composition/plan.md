# RFC-513 实施计划

依赖：RFC-512；与 S12 共用模块 composition 文件（本 RFC 只改 code-capability 与 resource-catalog 各一个组合文件；装配入口不变）。按 CLAUDE.md 文首
硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-513-T1 归 application**：新增 `code-capability/application/unboundHistoryReader.ts`，`resource-catalog/application/resourcePackageMaintenance.ts`
  增 `requireExclusiveRecoverySelection`（design D1）。
- **RFC-513-T2 composition 只装配**：两个装配入口改为取新位置（design D2）。
- **RFC-513-T3 账本**：`counts.json` 两项收紧；guard-manifest 登记（`assertsAbsence: true`）（design D3）。
- **RFC-513-T4 用例**：新增 RFC-513 用例（design §4）。
- **RFC-513-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按名字、路径与错误串扫出的用例与全部 `tests/architecture/`，按 CI
  的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照；全仓旧位置扫描。全量语料交给 CI 的 backend 分片。
- **RFC-513-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 清单里的名字只在各自的位置声明；两个组合文件不再有这 3 个 `throw`；装配入口的名字、入参与返回形状不变
- [x] AC-2 同样输入下读取器与核对的行为、错误与时机和此前一致
- [x] AC-3 新位置的依赖面是闭集；public surface 不升；两项计数收紧到实测
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（实现提交 70 / 70）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 29～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`fc19801d2`）的树相同。集中验证没有查出本 RFC 的缺陷：

- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：4 个生产文件（另过 promises 配置）与本 RFC 用例无告警；prettier：改动
  的 TS、两个 JSON 账本与本 RFC 的三件套通过。
- **首批**（候选 = `fc19801d2` 的树加本 RFC 的 7 个路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对
  照同时、同样跑法）：161 个文件。其中 `tests/architecture/` 全部 140 个，另 21 个：按名字、路径与错误串扫出的用例（取两个装配入口、读两个组
  合文件原文或按两条错误串断言的用例）、`rfc294-architecture-preflight` 与本 RFC 用例。
  - 两边都跑完：候选 1,624 条通过、9 条红，对照 1,613 条通过、11 条红；本 RFC 用例 9 / 9（只在候选一边）。逐文件比失败名，候选没有多出的红；
    对照多出 2 条，都是时限（`rfc317-table-ownership` 5 秒、`rfc395-history-response-parity` 自带的 120 秒）。
  - 两边相同的红都是时限：`rfc317-transition-table-oracle`
    3 条、`rfc359-w5-composition-root-route-surface`、`rfc359-w7-task-insert-lineage-completeness` 与
    `rfc359-w8-code-capability-read-conformance` 各 1 条（默认 5 秒），`rfc294-architecture-preflight` 的能力归属一例（自带 180 秒）与允许清
    单一例（自带 60 秒），`rfc376-report` 1 条（自带 300 秒）。
  - 直接覆盖两处的用例在候选一边全过：按错误串断言的 `rfc370-resource-package-recovery-effects` 27 / 27 与 `rfc395-history-response-parity`
    20 / 20；读组合文件原文的 `rfc349-resource-package-maintenance` 5 / 5 与 `architecture/rfc395-a6-atomic-apply`；算 import 闭包的
    `rfc395-history-readonly` 34 / 34；取装配入口的 `rfc304-code-metrics` 28 / 28、`rfc309-template-upstream-wiring`
    38 / 38、`rfc349-code-history-composition`、`rfc359-w8-resource-package-maintenance-conformance`
    22 / 22、`rfc370-resource-package-artifacts` 12 / 12 等。
- **复验**（默认时限放宽到 60 秒、与对照同时，其余同首批）：两边同样撞 5 秒的 4 个文件（`rfc359-w8-code-capability-read-conformance`
  12 / 12 与 3 个架构用例）两边各 33 / 33 全过。`rfc294-architecture-preflight` 两例的自带时限与 `rfc376-report` 两边相同，交给 CI 的
  backend 分片；架构报告的 public surface 偏差一项两边相同（见下）。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：
  - 60 项实测都在 `counts.json` 的 `max` 内，与对照只差两项（= 新的 `max`）：`composition-control-flow-code-capability` 2 →
    0、`composition-control-flow-resource-catalog` 77 → 75，少掉的正是迁走的 3 个 `throw` 与 1 个分支；没有新增。
  - 生产文件 4,126 → 4,127（一个新文件）；跨 context import 不变；模块符号归属 32,440 → 32,443；报告的变更入口一节多一条（新文件里的工厂，只
    是报告，没有计数或门以它为据）。
  - public surface 与偏差不变；其余各节逐项相同。
- **旧位置全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按词边界）：两个新名字只出现在新
  位置、两个组合文件、本 RFC 用例与本 RFC 的文档（另在 STATE 的本 RFC 条目）；两条错误串除新位置外只在按错误串断言的
  `rfc395-history-response-parity`、`rfc370-resource-package-recovery-effects` 与本 RFC 用例里。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例（与 RFC-512 相同），全过（33 / 33）。

## CI（AC-4）

- `57f755178`（实现，父提交是 `fc19801d2`）：exact SHA 主 CI run 44635079439 的 70 个 job 第 1 次全部通过（含 design/ 的链接检查与
  `CI required`），未重跑。
- 本 RFC 的落档提交 `fc19801d2`（只改文档）：主 CI run 44630876474 的 70 个 job 第 1 次运行 68 个通过；红的 2 格与本提交无关：backend 分片
  35/44 的 RFC-396 MR candidate bridge 用例（R24，PostgreSQL）撞 5 秒（5,209 ms），`CI required` 只因它红。这次提交只改文档，代码树与
  `b0fa6513a` 相同，那次运行的 backend 分片全过；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：由脚本按 HEAD 原行切片生成，再用脚本按词法单元比对（注释也比，只忽略换行与缩进）：3 段都在新位置连续出现、逐个相同：HEAD
  `historyQueries.ts` 第 46～51 行（34 个词法单元，两个操作）、`resourcePackageMaintenance.ts`（组合层）第 53～58 行（26 个，核
  对）；`application/resourcePackageMaintenance.ts` 原有的内容原样保留（341 个，import 只增恢复效果工厂的类型）。
- **时机与次序**：空读取器仍是 `history` 参数的缺省值，每次未给 `history` 的调用时新建；互斥核对仍在建活动登记与日志之后、选效果工厂之前调
  用，判据、短路次序与错误串不变。
- **装配入口**：`composeCodeHistoryQueries` 与 `composeResourcePackageApplyMaintenance` 的名字、入参与返回类型不变；bootstrap、维护进程图与
  用例的 import 不改；`historyQueries.ts` 不再取 `CodeHistoryReadError`。
- **账本与锁**：`counts.json` 两项收紧到实测（与架构报告一致）；guard-manifest 登记新用例（405 行，`assertsAbsence: true`，“不存在”写成
  `toEqual([])` 的字面形态）。读这两个组合文件原文的 `rfc349-resource-package-maintenance` 与 `architecture/rfc395-a6-atomic-apply` 不改、仍
  通过。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-513 代码能力与资源目录组合层余下的 throw 迁出 composition（RFC-294 S10 第二十步）`。走私有 index、按路径清单提交，在共享
发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
