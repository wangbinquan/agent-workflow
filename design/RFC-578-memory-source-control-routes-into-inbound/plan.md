# RFC-578 实施计划

依赖：RFC-577。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-578-T1 搬迁与连接**：五个绑定迁入各自模块的 `inbound/http/`，两个 composition 转出挂载函数，13 个 public 转出撤回，`server.ts` 与
  用例改指（design §1）。
- **RFC-578-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例与账本；新增 RFC-578 用例并登记 guard-manifest；`docs/dev-gotchas.md`
  补一条（design §2）。
- **RFC-578-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-578-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 五个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 89 → 84；未消费 public 符号保持 0；归属表删去五行；新增 RFC-578 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `f21fd1ced` 加本 RFC 的 41 个路径，含五个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 里补记的钉点与普查两段、`STATE.md`、RFC 索引与 RFC-577 转 Done 的两处记录）；代码、用例、工作流与
账本逐个文件比对，与候选相同。

- **撤回的推算与实测一致**：动手前按架构报告的消费者表与 public 类型引用模拟撤回（design §3），算出 memory 两层 4 个、source-control 两层 9 个；
  候选的报告里消失的正是这 13 个，未消费 public 符号保持 0，不可达生产文件的清单不变。
- **本人缺陷（已修复并复验）**：① `tsc` 报三个用例（`rfc370-v4`、`rfc446`、`rfc447`）从 source-control public 取 `RepositoryMirrors`——检索撤回符号
  的读者时漏写了这两个名字，改取端口。② 选用例跑下来四条红：`rfc349-repository-workspace-provider` 的三条路由路径列进了设计却忘了改；`rfc305` 账本
  里那一条插错了位置（只按旧位置附近的一段排序）；`rfc440` 按路由名拼路径；`rfc559` 的非空对照只数 `export { … }`。均已修复，四个文件 33 / 33。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **五个绑定**：与原文件相比，记忆路由改了候选收窄判据那一处 import（五行合为两行），三个仓库路由各改一行 import 的来源，蒸馏任务路由逐字节不变。
  生产代码的其余改动：`server.ts` 的 import（memory 两条合为一条，source-control 三条并进已有的一条）、两个 `composition.ts` 的转出、两个 public 文件
  的撤回与 memory 那份的文件头，以及 `repositoryBatchImport.ts` 改取 `RepositoryRegistration` 的一行 import。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 26 个 TS 文件无告警，生产文件（11 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 567 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到五个
  挂载函数、对应 HTTP 端点、撤回的 13 个符号与两个维护 worker 入口的、读两个模块 public / composition 与 public 面账本的——4873 条通过、4 条红（上面
  ②），修后 4877 条全部通过；`route-error-code-coverage` 按上一条在候选导出里跑。选择时按全路径与有区分度的路径片段匹配（`server`、`types`、
  `composition` 这类通名不按裸文件名匹配，否则会把几乎所有用例都选进来）。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576 / RFC-577 的清单），共 228 个文件、2155 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、
  RFC-578 用例 9 / 9、`rfc294-architecture-preflight` 15 / 15、`rfc305-architecture-lock` 15 / 15、`rfc317-module-boundary` 23 / 23、
  `rfc352-memory-candidate-visibility` 7 / 7、`rfc550-public-unconsumed-sweep-lock` 11 / 11、`route-error-code-coverage` 4 / 4、`routes-inventory`
  11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：九种都被认出——旧路径上重新出现一跳转出（RFC-578 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取仓库路由的
  挂载函数（用例 ④）；蒸馏任务路由取未登记的别的模块 public（用例 ②）；仓库路由取本模块 infrastructure（用例 ②）；候选收窄判据又从 memory public
  转出（用例 ③ 与未消费 public 符号计数同红）；连带撤回的仓库组类型又转出（同上）；迁走的记忆路由里重新出现手写的候选收窄（`rfc352` 红，证明它
  改指新路径后仍有效）；蒸馏任务路由多取 identity-access 的 participants（用例 ② 与 `rfc305` 的消费者账本同红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，89 → 84（少的正是这五个文件）；未消费 public 符号保持 0；
  public 面 978 → 965（撤回的 13 个）；public 类型偏差 32 不变；不可达生产文件 15 不变；变更入口普查 2393 → 2391（design §2 最后一条）。跨 context
  import 7553 → 7577：legacy → memory 的类型边 10 → 5、legacy → source-control 的类型边 51 → 48、legacy → identity-access 的类型边 40 → 38、
  legacy → resource-catalog 的值边 98 → 97，都是旧路由那几条随绑定进模块记到模块名下（memory → identity-access 的 `authority-type-only` 8 → 10、
  memory → resource-catalog 的 offered-consumption 1 → 2，DAG 都有这两项）；legacy → source-control 的值边 73 → 76 是 `server.ts` 改从 composition
  取三个挂载函数；绑定对 `platform`、`routes/registry`、`routes/operationAuthority` 与 `@/auth/actor` 的边记到模块名下（memory → legacy 48 → 61、
  source-control → legacy 290 → 306）。DAG 之外的 context 值对仍为 0，DAG 之外的已提供文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：五个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变；改的 import 取到的是同一个函数、同一个类型（public 原先就是从
  `domain/candidateVisibility` 与 `application/ports/` 转出的）；`server.ts` 的挂载调用与先后顺序不变，只改 import；路由清单（`routes-inventory`）、
  记忆与仓库的路由用例照旧通过。
- **候选收窄**：记忆路由的列表、审批队列、facets 与详情仍经同一份 `narrowCandidateRows` / `isMemoryHiddenCandidate` 判据，`rfc352` 的手写收窄
  守卫读新路径、变异 m8 证明它仍有效。
- **经 composition 挂载**：两个 composition 只多几条转出；取它们的只有 `server.ts` 与 `bootstrap/` 的装配文件（含两个维护 worker 入口），绑定取的
  `routes/registry`、`routes/operationAuthority`、`@/auth/actor` 与 `platform` 都不回指它们，不成环；R2 的业务层围栏不含 `inbound`，维护 worker 的
  入口用例照旧通过。
- **撤回的 13 个转出**：都确认过模块外没有消费者（架构报告的消费者表与全文检索），`tsc` 检查连接处；本模块里经 public 取它们的
  `repositoryBatchImport.ts` 改取声明处。
- **钉着旧路径的地方都随改**：归属表五行、`rfc305` 的消费者账本、读源码与按路径扫描的九个用例、按名字拼路径的 `rfc440`、两个用例的对照；e2e 里
  那三处过时的行号锚点按 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
