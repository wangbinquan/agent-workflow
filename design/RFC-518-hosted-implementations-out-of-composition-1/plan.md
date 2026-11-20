# RFC-518 实施计划

依赖：RFC-517。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-518-T1 原样迁移**：23 个文件迁入各模块的 `infrastructure/crewstation/`，按新位置重算相对 import（design D1）；由脚本按 HEAD 原文生
  成。
- **RFC-518-T2 消费方**：模块根转出 bootstrap 用到的名字；bootstrap 的 20 条 import 改经模块根；模块内 import 改指新位置（design D2）。
- **RFC-518-T3 锁与计数**：RFC-515 门的例外清单删 23 条；`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 改钉新路
  径、forbidden-import 清单清空；`counts.json` 收紧；18 个 import 旧路径的用例与两个读原文的用例改指新路径；guard-manifest 登记新用例
  （design D3）。
- **RFC-518-T4 用例**：新增 RFC-518 用例（design §4）。
- **RFC-518-T5 集中验证**：backend `tsc`、eslint、prettier；直接取改动文件的用例、按旧路径与名字扫出的用例与全部 `tests/architecture/`，按
  CI 的跑法与 HEAD 同时 A/B；红的按时限放宽复核；架构报告对照。全量语料交给 CI 的 backend 分片。
- **RFC-518-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 23 个文件只在新位置；门的例外清单只剩余下的 4 个且仍绿；forbidden-import 实测 0
- [x] AC-2 迁移的代码逐字不变，导出与消费方拿到的对象不变
- [x] AC-3 新位置不取组合层（两处 required-ports 类型除外）；bootstrap 不深引用 infrastructure；账本只改名不增；计数收紧到实测
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机全程高负载（10 核；1 分钟负载大多在 20 以上，主要是本机其他进程）。验证在候选导出仓库里跑，核对与工作树逐字相同；对照导出仓库与
HEAD（`8a28fe34d`）的树相同。集中验证查出本 RFC 的缺陷都已修正并复验：

- **开发期静态自查已拦下的**：生成脚本按原位置插入 import，在 `bootstrap/crewstationMaintenance.ts` 里插进了另一条多行 import 的中间
  （prettier 报语法错）、在 `bootstrap/crewstation.ts` 里插进了函数体（eslint 报未用），都改回文件头；按旧路径改写 import 时误改了
  `rfc416` / `rfc417` 两处伪造的负对照字符串（它们要证明“取组合层”会被认出），已还原。三件套里“组合层只剩 4 个托管文件”的说法不对（组合层另
  有 26 个只做装配、本就不在例外清单里的 `crewstation*` / `taskImage*` 文件），AC-1 与 design §3、§4 改为“23 个旧路径不存在、例外清单恰是余
  下的 4 个”。
- **集中验证查出的（漏改的锁，三处）**：RFC-515 门的组合层语料下限 350（迁走 23 个后实测 335，改为 330）；`rfc376-structural-guards` 的“名单
  变异”用例要求名单非空（forbidden-import 名单清零后改用一条伪造项证明两个方向，门本身仍要求实测为空）；`rfc310-architecture-lock` 的
  development-automation 模块根消费方账本（bootstrap 的 `crewstation.ts` 与 `workspaceTaskImage.ts` 改经模块根后补入）。复验时三条两边全过。
- **静态**：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：38 个生产文件与 23 个改动的用例无告警；prettier：改动的
  TS、`counts.json`、guard-manifest 与本 RFC 的三件套通过。
- **首批**（候选 = `8a28fe34d` 的树加本 RFC 的代码路径；按 CI 的跑法：两种 provider 同进程、默认 5 秒、`--randomize`，各 3 个 worker；与对照
  同时、同样跑法）：212 个文件。其中 `tests/architecture/` 全部 141 个，另 71 个：按 23 个文件的名字、导出名与五个 bootstrap 文件扫出的用
  例，`rfc294-architecture-preflight` 与本 RFC 用例。
  - 两边都跑完：候选 1,935 条通过、30 条红，对照 1,934 条通过、25 条红；本 RFC 用例 6 / 6（只在候选一边）。候选多出的红：上述三条漏改的
    锁；`rfc370-m3-hosted-database-restore.integration`（报 `connection must be a PostgresSQLConnection`，复验时对照同样红）与
    `rfc238-mcp-runtime-test-real-e2e`（复验时两边全过）；其余都是时限（`rfc425`、`change-narrative`、`rfc396-unborn-candidate` 撞
    5 秒，`rfc294-architecture-preflight` 的跨 context 一条撞 5 秒）。
- **复验**（锁改定后；默认时限放宽到 60 秒、与对照同时，各 2 个 worker）：24 个文件——首批里任一边红的文件、首批没扫到的 8 个模块根消费
  方 / 装配锁用例（`rfc487` 与 `rfc370-verification-command-family`，`rfc370-attempt-context-root-wiring` 与
  `rfc471`，`rfc370-conflict-workspace-bindings` 与 `rfc370-port-artifact-bindings`，`rfc370-employee-input-root-bindings` 与 `rfc266`）、本
  RFC 用例与 3 个守卫普查。候选 517 条通过、6 条红，对照 512 条通过、5 条红（对照没有本 RFC 用例）。两边都红
  的：`rfc294-architecture-preflight` 自带 60 秒与 180 秒时限的两条（本机两边都跑不进，交给 CI；判据不分层、只沿 `public/*` 走，见 RFC-517
  plan）、`rfc400` 自带 30 秒的一条、`rfc370-m3-hosted-database-restore.integration`（两边同一条断言）、`rfc238-mcp-runtime-test-service` 的
  PostgreSQL 一半（两次运行里两边各红不同的子集）。preflight 的跨 context 一条在候选上通过。
- **架构报告**（`scripts/architecture-report.ts`，候选与对照各出一份）：60 项实测里只有本 RFC 收紧的 10 项变化，数值与 `counts.json` 写入的
  新上限逐项相等（development-automation 82 → 2、digital-employee 13 → 0、event-center 5 → 0、integration 17 → 1、intent 4 →
  3、resource-catalog 75 → 28、runtime-management 22 → 11、source-control 110 → 9、system-operations 26 →
  14、`composition-forbidden-import-files` 12 → 0）；跨 context import 7,509 → 7,512，其余边按角色逐类同数改名，新增的 3 条是两处本模块
  `required-ports` 的类型 import（记为 required-implementation）；intent `crewstationScratch` 对持久化模块的那条边由 external-layer-debt 变
  为 infrastructure-external；public surface 1,195、required ports 66、mutation 入口 2,386、模块符号归属 32,464 与 facade 6 个都不变（一个
  facade 的边 id 随路径改名）；门的结果只在上述 10 项与 `off-dag-offered-file-context-pairs` 的三条改名上不同。
- **旧路径全仓扫描**（工作树；全部包、`e2e`、`scripts`、`architecture/`、`design/`、`docs/` 与 `STATE.md`，按文件名与导出名）：生产代码里没
  有 import 指向 23 个旧路径（本 RFC 用例另钉）；用例里旧路径只剩 `rfc416` / `rfc417` 的伪造负对照。
- **收口文档**：plan、design 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 6 个用例，全过（33 / 33）。

## CI（AC-4）

- 【待补：实现提交】
- 本 RFC 的落档提交 `8a28fe34d`（只改文档）：主 CI run 44676059620 的 70 个 job 第 1 次运行 68 个通过；红的是 design/ 的链接检查遇 GitHub
  503（`design/RFC-371-run-observability/native-real-validation-20261007.md` 第 7 行的提交链接，外部服务暂时不可用，该文件不在本提交
  里），`CI required` 只因它红；backend 分片全过，未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对未发现行为差别，结论 PASS：

- **逐字迁移**：23 个文件由脚本按 HEAD 原文生成，再用脚本按词法单元比对（注释也比，只忽略换行、缩进与 prettier 随折行增删的尾逗
  号）：22,581 个词法单元逐个相同，只有 103 个相对 import 字符串不同，且每一个按新位置解析出的目标与按旧位置解析出的目标（或同批迁走的兄弟的
  新位置）相同。
- **消费方**：bootstrap 五个文件的 20 条 import 改经模块根，名字不变、拿到同一个对象（本 RFC 用例逐名比对）；模块根新增的转出与原导出同
  名；digital-employee、event-center 模块根与留下的 `crewstationDeployment.ts` 只改路径。
- **账本与锁**：RFC-515 门的例外清单 27 → 4、语料下限随实测调整；`rfc376-structural-guards` 三条改名、forbidden-import 名单清
  空；`rfc294-review-offered-edge-dag` 三条改名；`rfc310-architecture-lock` 的模块根消费方补两条；18 个用例改从新路径 import、两个读原文的用
  例改读新路径；`counts.json` 10 项收紧到实测；guard-manifest 登记新用例、改动过的条目行数按实测随改。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-518 托管实现迁出组合层（一）（RFC-294 S10 第二十五步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
