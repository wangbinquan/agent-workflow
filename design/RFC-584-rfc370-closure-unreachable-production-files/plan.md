# RFC-584 实施计划

依赖：RFC-583。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-584-T1 迁移与删除**：五个兼容入口迁入 `T/helpers/`，MCP 诊断旧地址与 Intent 维护副本删除，用例改取新位置或生产命令（design §1）。
- **RFC-584-T2 门、用例与文档**：`rfc376` 的基线与后继表、`rfc521`、`rfc282`、`counts.json`；新增 RFC-584 用例并登记 guard-manifest（design §2）。
- **RFC-584-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-584-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 七个旧路径不存在、没有说明符再解析到它们；迁走的五个只差 import 与头注；生产源码不取 `tests/`
- [x] AC-2 生产行为不变；改取新位置的用例与 `rfc234` 的四条维护用例通过
- [x] AC-3 `unreachable-production-files` 上限 15 → 8、`application-direct-effect-files` 上限 1 → 0；其余计数不升；账本随改；新增 RFC-584 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `1e6e2a282` 加本 RFC 的 35 个路径，含 `src` 下的七个删除，用本地提交固化，树哈希与“HEAD 加这些
路径”的树哈希相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md`、RFC-579～RFC-581 的收口记录与
`docs/dev-gotchas.md`）；代码、用例、工作流与账本逐个文件比对，与候选相同。

- **不可达的判定**：架构报告的可达性与按语法树解析全部说明符的扫描一致——七个文件在生产源码里没有任何 import 方，只有用例在用。
- **本人缺陷（已修复并复验）**：① 候选导出里 `rfc473`、`rfc474` 与 `test-suite-policy` 红：`windows-platform.yml` 的两份路径过滤仍列着三个迁走或
  删除的文件——本 RFC 的钉点检索漏了 `.github/`。过滤改列迁到 `tests/helpers/` 的新位置，删除的旧地址去掉（它指向的本机实现本来就列着），复跑
  分别 12 / 12、17 / 17、12 / 12。② `docs/env-flags.md` 里 `AW_EVENT_INPUT_FILE` 一行指向事件中心的兼容入口，而读这个变量的是
  `infrastructure/local/customObserverProgram.ts`，改指它（`rfc284-env-flags-registry` 只核对变量名，3 / 3）。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 20 个 TS 文件无告警（`src` 下只有删除，没有生产 TS 文件
  要过 promises 配置）；prettier：改动的代码、两份 JSON、workflow 与三件套通过（`docs/env-flags.md` 在 HEAD 上就不是 prettier 格式，只改了那一格）。
- **选择与语义层**（60 秒；4 个 worker）：选出 200 个用例文件，1757 条全部通过；其中 `rfc234-turn-engine` 31 / 31（四条维护用例对生产命令通过），
  改取 `tests/helpers/` 的 `rfc310-pr3` / `pr4` / `pr5` / `pr6`、`rfc370-conflict-workspace-effects`、`rfc370-evidence-artifact-effects`、
  `rfc370-verification-command-family` 照旧通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本与 workflow 的用例与
  钉着本次改动位置的用例（并上 RFC-576～RFC-583 的清单），共 309 个文件、3080 条全部通过。其中 `rfc376-structural-guards` 221 / 221、RFC-584
  用例 6 / 6、`rfc521-composition-adapter-fallbacks` 2 / 2、`rfc282-c0c2-runtime-fence` 9 / 9、`rfc370-mcp-diagnostics-configuration` 4 / 4、
  `rfc370-system-agent-selected` 14 / 14、`rfc370-custom-observer-program-family` 43 / 43、`route-error-code-coverage` 4 / 4。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：五种都被认出——MCP 诊断的一跳旧地址回到生产树（RFC-584 用例 ① 与
  `rfc376-structural-guards` 的不可达计数同红）；测试辅助文件用 import 类型取已删的 Intent 副本（用例 ①）；生产文件取 `tests/helpers/` 的文件
  （用例 ②）；维护用例又出现副本的函数名（用例 ③）；application 文件又直接做文件系统效果（`rfc376-structural-guards` 的
  `application-direct-effect-files`）。第三种的锚点起初写错了文件里的 import，改正后重跑。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `unreachable-production-files` 15 → 8 与 `application-direct-effect-files` 1 → 0 变了；
  `legacy-service-implementations` 实测 4，上限 6 → 4 按实测收紧；public 面 855、public 类型偏差 28 不变。跨 context import 7636 → 7633：
  intent → legacy 的类型边与值边各少一条（删除的副本取 platform 的日志），task-execution → legacy 的值边少一条（迁走的 composition 取日志）。
  变更入口普查 2389 → 2385（迁走的四个入口函数）。DAG 之外的 context 值对仍为 0，DAG 之外的已提供文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `dcbb373c3`（实现）：主 CI run 45598535599 的 `Markdown link check (design/)` 红——`design/RFC-294-backend-layered-target-architecture/review-2026-10-14.md:120`
  的链接指向本 RFC 删除的 `intent/application/maintenance.ts`。**本 RFC 引入**：钉点检索没有查 `design/` 的 Markdown 链接（RFC-574 的教训，
  再犯）。补正提交把那条链接改成反引号里的纯文本并注明删除（那段是 2026-10-14 评审的历史陈述，说的正是这份副本，不改指别的文件）；本地扫
  `design/`、`docs/` 与根目录全部指向 `packages/` 的链接，再没有指向本 RFC 或 RFC-581～RFC-583 迁走、删除文件的链接（余下 4 条是既有的占位
  写法与 `STATE.md` 的旧记录，不在这个 job 的检查面内）。其余 job 的结果见补正提交的记录。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **生产行为不变**：七个文件在生产里没有任何 import 方；生产的正式路径（development-automation composition 选定的效果族、事件中心的 application、
  task-execution 的运行族、resource-catalog 的本机 MCP 诊断效果、Intent 的 `maintenanceCommands`）一行未动。
- **迁走的入口逐字不变**：五个文件只改 import 说明符（相对路径换成指向同一文件的别名）与头注；用它们的用例只改 import 路径并照旧通过。
- **维护用例测的是生产命令**：四条用例断言的业务结果不变——孤儿轮次被置为 `intent-run-daemon-restart` 错误、按启动快照恢复不碰新守护进程准入的轮次、
  已定的捕获状态保留、草稿目录清掉终态旧目录与未知旧目录而保留运行中与新近的目录；生产命令给出同样结果（31 / 31）。
- **MCP 诊断用例**：直接构造本机实现，与删除的旧地址转出的是同一个工厂；`rfc282` 的两处检查改查真正的实现，照旧通过。
- **Windows 触发不变**：路径过滤改列迁到 `tests/helpers/` 的文件，Windows 套件用到它们时照旧触发。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
