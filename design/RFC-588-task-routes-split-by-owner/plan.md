# RFC-588 实施计划

依赖：RFC-587。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-588-T1 拆分与搬迁**：任务路由迁入 `TE/inbound/http/taskRoutes.ts`，七个端点迁入 `WI/inbound/http/taskWorkspaceInsightRoutes.ts`（design §1）。
- **RFC-588-T2 连接**：两个 composition 转出挂载函数，`server.ts` 的 `tasks` 一步按序挂两个绑定。
- **RFC-588-T3 门、用例与文档**：归属表与锚点、`counts.json`、钉着旧路径的用例、按候选报告撤回的 public 符号；新增 RFC-588 用例并登记（design §2）。
- **RFC-588-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-588-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧路径不存在、没有说明符再解析到它；两个新文件合起来与原文件只差 import、依赖接口的拆分与端点的位置
- [x] AC-2 可见性中间件在七个端点之前；相关路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 59 → 58；未消费 public 符号保持 0（13 个符号随之撤回）；DAG 之外的边与跨 context 内部文件对不增加；新增
      RFC-588 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI（`7ff4408d4`）70 个 job 里 68 个成功，macOS e2e 第 3 片因 runner 慢在 20 分钟上限被取消（环境性，已归因，见「CI」）

## 集中验证

基于 `3469a00e1`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint（42 个 TS 文件）与 promises 配置（13 个 `src` 文件）无告警；改动的 TS、RFC 文档与两个 JSON 账本 prettier 通过。
- **逐字比对**（脚本）：七个端点（原文件里连续 194 行）逐字出现在工作区洞察绑定里，深度配置的小函数只改了一处形参类型；任务路由与“原文件减去迁走的
  部分”相比，只差 import、`TaskRouteDependencies` 的三项依赖、两项启动期检查与一行解构。
- **选出的用例**（主树）：646 个用例文件、5823 条，其中 5 个文件各红 1 条——
  - 两条是读已提交源码的用例（`rfc376-report`、`rfc370-committed-architecture-source`）：主树里新文件还没提交，治理字段的锚点找不到，在预期之内；
    候选导出里通过（见下）。
  - 三条是**本人缺陷**：`rfc143`（深度配置小函数的形参）、`rfc203`（调用目标的错误码）、`rfc349`（两项启动期检查）断言的内容随端点迁走了，用例还读
    任务路由。改为读工作区洞察绑定（`rfc349` 按检查项分读两个文件）。顺带：`rfc303`（任务 HTTP 的 wire schema 不暴露内部名）原来覆盖的文件包括这七个
    端点，读取范围扩到新绑定；RFC-588 用例加一条“工作区洞察绑定不直接 `app.use`”（`rfc344` 对任务路由的同一约束，迁走的部分由它接着锁）。另查了读
    任务路由的全部用例里的否定断言，其余都落在没有迁走的启动、删除、诊断路径上，不需要跟着改。
- **撤回推算**（design §2，在实现后的候选报告上算）：第一份候选报告里 task-execution 的未消费 public 符号 0 → 2、workspace-insight 0 → 1；按报告的
  public 类型引用算到不动点共 13 个（含 resource-catalog 的 `McpDiagnosticsTranscript`）。用语法树搬迁工具撤回之后复算，各模块的未消费计数都回到 0。
- **候选导出**（撤回之后，候选已提交）：462 个用例文件、4701 条全部通过——包括读已提交源码的用例、`rfc376-structural-guards`（221 条）、
  `route-error-code-coverage`、`rfc294-review-offered-edge-dag`（8 条），以及撤回之后按改动面另选的 266 个；`rfc321`（要 git 历史）在主树里 10 / 10。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——旧路径上重新出现一跳转出（RFC-588 用例与 `rfc376-structural-guards` 都红）；
  测试 helper 经 `import type` 取旧路径；任务路由重新取 workspace-insight 的 public（RFC-588 用例与 `rfc294-review-offered-edge-dag` 都红）；
  工作区洞察端点注册回任务路由；`server.ts` 把工作区洞察绑定挂到任务路由之前。复原后导出无残留。
- **架构报告**（候选对照 `3469a00e1`）：60 个计数里只有 `legacy-horizontal-files` 变了（59 → 58）；未消费 public 符号 0；public 面 850 → 837；
  跨 context import 7651 → 7637；DAG 之外的已提供边由 `rfc294-review-offered-edge-dag` 在候选导出里核对通过。

## CI（AC-4）

- `7ff4408d4`（实现）：exact SHA 主 CI run 45648695437 的 70 个 job 里 68 个成功——全部后端分片、真实 PostgreSQL、前端、三个平台的构建与检查（含
  Markdown link check）、ubuntu 的 3 片与 windows 的 4 片 e2e、macOS e2e 的第 1、2、4 片；按路径触发的 windows-platform（run 45648696009）通过。
- 没过的两格是同一件事：Playwright e2e（macos-latest 第 3/4 片，job 139330833380）跑到 job 的 20 分钟上限被取消（run 结论 cancelled），CI required 因它
  而红。归因：环境性（macOS runner 慢），不是本提交引入——那一片的日志里反复出现 `event loop stalled gapMs≈1.0–1.7s`，被取消时仍在逐条通过（99 条通过）；
  其间红的两条（`rfc372-recorded-mindmap.spec.ts:183` 的澄清追问状态、`rfc396-graph-care-repair.spec.ts:404` 的图谱修复，各跑 1.5～3.9 分钟）在同一次 run
  的 ubuntu（第 2/3 片）与 windows（第 3/4 片）上都通过，走的也不是本提交改动的代码；同一片在今天前几次 run 里用了 5～16.6 分钟。没有改测试、没有重跑。
  后继证据取 RFC-589 提交的 macOS e2e（它以本提交为祖先，本提交的内容原样保留）。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **端点逐字**：七个端点与深度配置的小函数逐字迁入（见集中验证的比对）；处理逻辑、权限声明、错误码与响应一行未改。
2. **挂载顺序**：`tasks` 一步先挂任务路由、再挂工作区洞察绑定。任务路由的 30 条注册（含两条中间件）里，能匹配七个端点的只有可见性中间件
   `/api/tasks/:id/*`——意图如此；没有别的任务路由会抢先匹配它们。与别的挂载步骤的相对顺序不变（`taskArchive` 照旧在 `tasks` 之前）。
3. **依赖**：两个绑定收同一个对象（`server.ts` 的输入类型是两个依赖接口的交集）；工作区洞察绑定只用 `operations` 的 `requireOperator` 与 `get`，配置
   只读四个字段，与原来读的相同。启动期检查：工作区洞察绑定两项（随端点搬来），任务路由余三项。
4. **撤回**：13 个符号只改类型的来源，读者改指模块内的定义处，运行时无变化。
5. **按方法 + 路径记账的清单**（`tests/contracts/registry.ts`、`rfc329McpSurfaceLedger.ts`）不记源文件，不受影响。
6. **留下的**：`routes/registry.ts` 里一条注释的旧指针（design §4，registry 暂缓，只动 import 行）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
