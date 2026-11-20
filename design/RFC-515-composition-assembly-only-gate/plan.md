# RFC-515 实施计划

依赖：RFC-514；与 S12 共用模块 composition 文件（本 RFC 只改 resource-catalog 的一个组合文件与一个基础设施文件）。按 CLAUDE.md 文首硬规则：先完成
全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-515-T1 全模块门**：新增 `architecture/rfc515-composition-assembly-only`（design D1），登记 guard-manifest。
- **RFC-515-T2 归位**：`loadSkillOperationState` 迁入 resource-catalog `infrastructure/skillOperationStateQuery.ts`，组合文件引用它（design D2）。
- **RFC-515-T3 旧锁并入**：`rfc414` 与 `rfc423` 删去与新门重复的形状检查，只留归属检查；guard-manifest 行数随改（design D3）。
- **RFC-515-T4 分支上限**：design D4 写明（与 `counts.json` 一致，不改数）。
- **RFC-515-T5 集中验证**：backend `tsc`、eslint、prettier；新门、两条旧锁、`tests/architecture/` 全部与经装配入口对拍 D2 的用例，按 CI 的跑法与 HEAD
  同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-515-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 新门覆盖全部模块的组合层、例外清单与实测逐文件相等、带负对照
- [x] AC-2 `loadSkillOperationState` 行为不变；组合文件不再取 `queryHelpers`
- [x] AC-3 两条旧锁只留归属检查、仍通过；public surface 与计数不升；分支上限与 `counts.json` 一致
- [x] AC-4 受影响用例全部通过；exact SHA CI 除外部服务的链接检查与 RFC-514 漏改的源码守卫外全绿（逐格归因见 §CI）

## 集中验证

本机全程高负载（10 核；采样到的 1 分钟负载约 24～42，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`3502d3875`）的树相同。集中验证查出本 RFC 的两处缺陷，修正后复验了相关范围：

- **缺陷与修正**（候选 1 = `3502d3875` 的树加本 RFC 的 6 个路径）：
  - backend `tsc` 在新门用例里报一处类型错（TS2769）：从 `Object.keys(…)` 解构出的首个例外是可能为空的类型，`toEqual([listed])` 不认；改为取
    下标并断言非空。
  - `architecture/rfc317-guard-negative-fixture` 只在候选一边红（2 例）：`rfc414` 与 `rfc423` 里只用伪造源码的负对照正是迁到新门的那几例，删
    去后两条锁只剩“活语料加一个伪造文件”的归属负对照，普查认不出，与 guard-manifest 的 `negativeFixture: true` 不符。两条锁各加一例只用伪造
    源码的归属负对照。
  - 候选 2 只差这三个用例文件与 guard-manifest 里两条的行数，复验见下文。
- **静态**：候选 2 的 backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：两个生产文件（另过 promises 配置）与三个用例无告
  警；prettier：改动的 TS、guard-manifest 与本 RFC 的三件套通过。
- **首批**（候选 1；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照同时、同样跑法）：150 个文件。其中
  `tests/architecture/` 全部 141 个（含新门），另 9 个：经装配入口与按名字扫出的 `loadSkillOperationState` 用例、读 `intentApply.ts` 原文的
  两个用例与 `rfc294-architecture-preflight`。
  - 两边都跑完：候选 1,525 条通过、13 条红，对照 1,528 条通过、9 条红；新门 3 / 3（只在候选一边）。候选多出的红除上面的缺陷外都是时限
    （`rfc400-collaboration-task-participants` 自带的 30 秒、`rfc294-architecture-preflight` 两例的 5 秒与自带 60 秒）；对照多出的 1 条
    （`rfc395-session-table-imports`）撞 5 秒。
  - 对拍 `loadSkillOperationState` 的用例两边全过：`rfc359-w36-skill-operation-state-query`
    7 / 7、`rfc359-w7-intent-apply-artifact-conformance` 22 / 22、`rfc370-intent-artifact-content`
    20 / 20、`rfc359-w7-catalog-composition-roots` 16 / 16、`rfc395-apply-target-recovery` 67 / 67，读 `intentApply.ts` 原文的
    `rfc345-resource-catalog-contracts` 18 / 18 与 `rfc349-resource-catalog-intent-apply-postgresql` 5 / 5；`rfc414` 与 `rfc423` 各 2 / 2。
- **复验**（候选 2；默认时限放宽到 60 秒、与对照同时，其余同首批）：读 guard-manifest 的三个普查用例、`rfc414` 3 / 3、`rfc423` 3 / 3、新门
  3 / 3 与首批里撞 5 秒的 5 个架构用例，共 11 个文件，候选 108 条、对照 105 条全过（对照没有新门）；`rfc294-architecture-preflight` 的跨
  context 一例单独放宽后两边都通过。`rfc294-architecture-preflight` 另两例的自带时限、`rfc376-report` 与
  `rfc400-collaboration-task-participants` 的自带时限交给 CI 的 backend 分片。
- **架构报告**（`scripts/architecture-report.ts`，候选 1 与对照各出一份；候选 2 只改用例与 guard-manifest）：60 项实测与对照逐项相同（本 RFC
  不改控制流计数）；跨 context import 7,508 → 7,507（组合文件少了对 `persistenceDb` 的类型 import 与对 `queryHelpers` 的值
  import，`infrastructure/skillOperationStateQuery.ts` 多了后者）；模块符号归属 32,449 → 32,450；public surface 与偏差不变；其余各节逐项相
  同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例（与 RFC-514 相同），全过（33 / 33）。

## CI（AC-4）

- `6c1d87747`（实现，父提交是 `3502d3875`）：exact SHA 主 CI run 44651659068 的 70 个 job 第 1 次运行 67 个通过；红的 3 格都不是本 RFC 引入
  的：design/ 的链接检查遇 GitHub 503（`design/RFC-371-run-observability/native-real-validation-20261007.md` 第 7 行的提交链接，外部服务暂时
  不可用，该文件不在本提交里）；backend 分片 10/44 是 RFC-514 漏改的`rfc098-write-lock-registry` 的源码守卫（`efdff656e` 补
  正）；`CI required` 只因它们红；未重跑。含本 RFC 代码与该补正的后继提交 `48dcc1cd0`：主 CI run 44658531942 的 70 个 job 全部通过（后继证
  据）。
- 本 RFC 的落档提交 `3502d3875`（只改文档）：主 CI run 44645578510 的 70 个 job 第 1 次运行 67 个通过；红的 3 格与本提交无关：backend 分片
  13/44 的 RFC-243 DB rebuild（PostgreSQL）撞 5 秒（6,649 ms），分片 10/44 是 RFC-514 漏改的源码守卫，`CI required` 只因它们红。这次提交只改
  文档；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项核对，结论 PASS：

- **门的判据**：禁用 import 的 7 个模式与 2 个禁用调用逐字取自 RFC-414；循环、switch、`try`、`throw` 的判据取自 RFC-423；扫描面是全部模块的
  `composition/` 目录与模块根 `composition.ts`，非组合层不在；例外清单 33 条与实测逐文件相等（清单外违反与陈旧例外都报红），每条写明后继，路
  径都存在、都在扫描面内、按字典序排列。
- **归位**：`loadSkillOperationState` 的函数体就是 HEAD `composition/intentApply.ts` 里那个箭头函数的函数体（同一条查询、同一个取首行），交
  给 intent 端口的仍是同一个函数形状；组合文件不再取 `queryHelpers` 与 `PersistenceDb`。
- **两条旧锁**：删去的只是与新门重复的形状部分（RFC-414 的禁用 import / 调用、RFC-423 的循环 / switch / `try` / `throw` 账本与它们的负对
  照）；归属检查与语料下限原样保留，各增一例只用伪造源码的归属负对照。
- **账本**：guard-manifest 登记新门（213 行，语料扫描、断言不存在、负对照）、两条旧锁的行数随改动更新；`counts.json` 不变（分支上限即现
  值，design D4）。

## PR / 提交

三个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-515 组合层只装配的全模块门（RFC-294 S10 第二十二步）`；RFC-511～515 的 CI 都有结果后，另起一个只改文档的提交把它们一
并转 Done。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
