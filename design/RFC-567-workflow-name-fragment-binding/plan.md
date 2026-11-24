# RFC-567 实施计划

依赖：RFC-565。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-567-T1 owner 一侧**：`workflowNameExpression` 撤出 resource-catalog 的 public，装配根交出（design §1）。
- **RFC-567-T2 task-execution 与 bootstrap**：五处读模型从入参拿片段（列表页六个构造函数与两个装配函数、任务列表路由的投影、生命周期 WS 投影、
  徽标条件改由绑定函数造出）；provider runtime 的依赖多 `workflowName`；bootstrap 两处交入（design §2、§3）。
- **RFC-567-T3 门与用例**：`PUBLIC_SURFACE_DEBT` 与 `counts.json` 降低；钉着旧位置的用例随改；构造这些读模型的用例与脚本补入参；新增 RFC-567 用例并
  登记 guard-manifest；补徽标条件的行为断言。
- **RFC-567-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-567-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 `workflowNameExpression` 不再从任何 `public/*` 导出；全部模块的源码不从 resource-catalog 取它；装配根交出
- [x] AC-2 行为不变；片段与 task-execution 声明的类型对得上，由编译器检查；既有读模型用例通过
- [x] AC-3 `PUBLIC_SURFACE_DEBT` 删去 3 条，`public-surface-deviations` 45 → 42；新增 RFC-567 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `948d2353c` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷两处（已修复并复验）**：① 漏查三个钉着 `taskListPage/query.ts` 整份源码摘要的对拍用例（`rfc359-w25-task-page-bounded-prefix`、
  `rfc359-w27-task-prefix-lookup-conformance`、`rfc359-w39-task-page-fallback-gate-conformance`）：它们各自把源码还原到某次发布的形态后比对 SHA-256，
  本 RFC 给这份文件加了入参，摘要变了，选集运行里红。同一批用例里对 SQL 文本、绑定与行的比对全部照旧通过（渲染出的语句没变）；按这三个用例既有的
  做法更新摘要并写明“只多了片段入参，撤回这些改动即还原上一个摘要”。② 给一个装配函数的入参写的注释里用了“bootstrap”一词，架构报告按函数文本里的
  关键词给“变更入口”归类，那一条的归类因此从“未见权限来源”变成了“系统”；改写注释后报告的这一节与对照相同。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 63 个 TS 文件（15 个生产文件、40 个用例文件、7 个测试助手、
  1 个脚本）无告警，生产文件另过 promises 配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 4 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 654 个（语义层 466、经夹具与测试助手补 188；只加导出行
  的 resource-catalog 装配根、只撤一个名字的 public 文件、只改导出名的 task-execution 装配根与只加类型的 `taskRepositorySql.ts` 不按“被谁 import”
  扩选，改名与撤名没有残留读者由 `tsc` 保证）。首轮 651 个通过，3 个红就是上面 ①；更新摘要后这三个用例连同 RFC-567 用例、`rfc483` 的边界用例、
  `rfc395-a7-owner-queries` 与读 guard-manifest 的用例共 28 个文件全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-567 用例 7 / 7、
  `rfc294-architecture-preflight` 15 / 15、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、
  `rfc317-guard-negative-fixture` 17 / 17、`rfc483-human-gate-badge-read-model-boundary` 7 / 7、`rfc485-te-row-query-bindings-boundary` 7 / 7、
  RFC-565 用例 9 / 9、RFC-566 用例 8 / 8、`rfc317-table-ownership` 19 / 19。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：十种变异都被认出——resource-catalog 的 public 重新交出片段（与
  `rfc294-architecture-preflight` 同红）；列表页查询从 resource-catalog 的装配根 import 片段、徽标条件文件从它的 infrastructure 取类型（RFC-567 用例
  ②）；五处读模型各自不用入参里的片段：完整管线的行投影（`rfc311-task-page-fastpath` 红）、搜索快路径（`rfc311-task-page-filtered-fastpath` 红）、
  任务列表路由的行（`rfc359-w7-task-route-conformance` 红）、生命周期 WS 投影（`rfc395-a2-task-subject` 红）、绑定后的徽标条件
  （`rfc395-a7-owner-queries` 红）；bootstrap 用别的片段绑定徽标条件（`rfc483` 的边界用例同红）、不把片段交给任务目录源。其中两种起初配的行为用例
  不走那条路径（用例 ③ 的文本断言认出了它们），换成走那条路径的行为用例后同红。另做一组类型层变异（片段多一个必填入参）：候选导出里 `tsc` 报
  114 处，落在 bootstrap 的两处交接（`crossContextClosure.ts`、`daemonModules/taskExecution.ts`）、脚本、44 个用例与助手文件的构造处，以及
  RFC-567 用例的七条编译期断言。
- **架构报告**（候选与对照各出一份）：`public-surface-deviations` 45 → 42（删去的正是清单里那 3 条）；public 面 992 → 991；跨 context import
  7531 → 7529；未消费的 public 符号（0）、目标边（111）、生产文件数、变更入口普查（2394，逐条相同）与其余门、计数不变（任务执行权限一节只有行号后移）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **语句不变**：七处 `workflowNameExpression(db, x)` 逐一换成 `workflowName(db, x)`，传入的 `db` 与列表达式不变；`taskWorkflowNameSql` 的调用形态不变。
  列表页三个对拍用例对“当前函数渲染的 SQL、绑定与行”和发布时的原文逐字比对，全部通过；任务列表路由、WS 投影与徽标计数的结果用例通过。
- **每条路径都拿到了 owner 的片段**：provider runtime 的 `workflowName` 交给任务路由操作与生命周期投影；任务目录源的装配函数交给列表页；
  `crossContextClosure` 用它绑定 `taskGateOpenCondition`。四处入参都必填，bootstrap 交的都是 resource-catalog 装配根的同一个函数。
- **徽标条件的签名没变**：`bindTaskGateOpenCondition(fragment)` 返回的函数与原来的 `taskGateOpenCondition` 入参、默认值与返回相同，collaboration 的三处
  调用不用改；“任务有主体名”那一支用绑定时交入的片段（`rfc395-a7-owner-queries` 新增断言：用 resource-catalog 的片段时三个未结束任务都在，用一个
  取不到名字的片段时一个不剩）。
- **用例一侧**：构造处补上的都是 resource-catalog 的实现本身（取自它的 infrastructure），与 bootstrap 交的是同一个函数。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-565 的转 Done（两个 macOS e2e 分片没有分到 runner，
已归因）与 RFC-564 那格环境性红的后继证据同批。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
