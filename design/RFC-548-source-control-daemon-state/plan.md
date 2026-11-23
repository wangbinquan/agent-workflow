# RFC-548 实施计划

依赖：RFC-547。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-548-T1 批量导入**：新增实例类型与构造函数，删去模块级状态与重置，各函数收下实例；daemon 应用的组合构造一份交给三处（design D1）。
- **RFC-548-T2 读缓存状态**：句柄上下文的按键模块状态；SQL 存储的按库代次与在途合并；删去模块级代次、合并表与失效函数，写路径改调存储
  （design D2）。
- **RFC-548-T3 用例**：新增 RFC-548 用例并登记 guard-manifest；随改 design D3 所列用例与测试助手。
- **RFC-548-T4 集中验证**：backend `tsc`、eslint、prettier；按 RFC-533 的口径、被改名字的字符串形态、读被改源码的测试助手与 `tests/fixtures/`
  里的摘要锁选用例；红的与 HEAD 同时 A/B；架构报告对照（含公开面）；变异验证。
- **RFC-548-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S12 第 4 项第十四步。

## 验收清单

- [x] AC-1 三个文件没有模块级可变状态与重置函数；批量导入由组合构造并交入；读缓存状态挂在句柄上下文上
- [x] AC-2 批量导入、切面缓存与在途页合并的结局不变
- [x] AC-3 模块级可变单例 43 → 39、计数不升；新增 RFC-548 用例并登记；读旧接口的用例随改
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。验证在候选导出仓库
里跑（HEAD `d60586a26` 加本 RFC 的 28 个路径，核对与工作树逐字相同，与对照导出的差异恰是这 28 个路径），对照是同一 HEAD 的另一份导出。
集中验证没有查出本人缺陷：

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 27 个 TS 文件无告警，改动的 12 个生产文件另过 promises
  配置；prettier：改动的代码、guard-manifest 与三件套通过。
- **选择**：按 RFC-533 的口径从 2,991 个用例文件里选出语义层 1,290 个：改动的 12 个用例、全部 `tests/architecture/`（142 个）、在 import 之外以路径
  点名被改文件的 188 个、点名被改 API 的 59 个、直接导入被改文件的 1,000 个、经 8 个读被改源码的测试助手的 212 个；`tests/fixtures/` 里没有钉
  被改文件的摘要锁（`rfc395` 的表归属债务清单列着 SQL 存储对 `memories` 的依赖，本 RFC 不动它，读它的用例在选择里）。另按
  `docs/dev-gotchas.md`（RFC-527 那条）补经子进程夹具与测试助手 import 到达行为变了的 8 个生产文件的用例 78 个（多是经
  `providerHttpApplication` 装配 daemon 应用的 HTTP 用例，另有 `rfc363` 的准备崩溃 Worker）。
- **语义层**（SQLite；90 秒；候选 4 个 worker）：1,290 个文件里 1,289 个通过；红的 `rfc321-repository-publication-ratchet` 要求从可达历史复现发布
  账本，导出仓库只有几笔本地提交——它在对照导出里同样红，在主树（真实历史、内容即候选）里通过，不是候选的问题。补跑的 78 个全部通过。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：HTTP 组合另建一份批量导入、各实例共用一个信号量、各库共用一张按库状态表、
  存储失效不加按库代次、页读取的合并键不去掉检索词首尾空白，各自让 RFC-548 用例红。
- **架构报告**（候选与对照各出一份）：模块级可变单例 43 → 39（删去的正是 `globalConcurrency`、`globalInFlight`、`repoPageFlights` 与
  `repositoryFacetCacheEpoch`）；source-control 的公开面少 1（`invalidateRepositoryWorkspaceFacetCaches`，原本只有用例用；未被生产消费的公开符号
  随之 9 → 8）；跨上下文 import 清单多 5 条（bootstrap 取 source-control 组合的批量导入 3 条、SQL 存储取 platform 的按库状态与 util 的在途合并
  4 条、镜像缓存不再取在途合并少 2 条，都是向下的依赖）；写入入口清单里 `setGlobalConcurrency` 换成 `createRepositoryBatchImports`（按名字认，
  如实记录）；组合层控制流门里 `cachedRepositoryOperations.ts` 那一处分支随上方新增的 3 行下移（50 → 53 行，同一分支）；模块符号属主
  32,465 → 32,462；其余计数与门没有变化。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `9612c16e6`（实现，父提交是 `d60586a26`）：exact SHA 主 CI run 45233526348 的 70 个 job 里 67 个通过，包括 ubuntu 的其余后端分片（含真实
  PostgreSQL）、Linux / Windows / macOS 的生产二进制构建与四个 macOS e2e 分片。红的两格都不是本 RFC：`Markdown link check (design/)` 红在
  `design/RFC-378-mindmap-decision-review/research.md` 的两条外站链接返回 503（他人文档，待用户决定的那一项）；后端分片 41/44 红在
  `rfc398-start-auto-upgrade-takeover`「…acquires after takeover」——`docs/audit-backlog.md` 已登记的多进程接管偶发到点，第五次、同形（184.7 秒后
  barrier / readiness 到点，子进程输出 `JSON Parse error`），同文件另两例同次通过，父提交的同一分片通过，本 RFC 不碰启动升级与接管路径。
  `CI required` 随之红。同一提交触发的 windows-platform、git-protocols-e2e 与 maintenance-soak-nightly 通过。都未重跑。
- 落档提交 `d60586a26`（RFC-547 转 Done、RFC-548 落档，只改文档）：主 CI run 45227791845 的 70 个 job 里 68 个通过（含 macOS 的构建与四个
  e2e 分片），红的只有 Markdown 链接检查（同上 503）与 `CI required`；未重跑。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **批量导入**：原先 daemon 里只有一份模块级的批次表与信号量；现在 `composeDaemonApplication` 在实时策略之前建一份，实时策略的发起者查询、
  HTTP 组合（经 `ProviderAppOwnerInput.repositoryBatchImports` 交给 `composeCachedRepositoryOperations`）与会话的回收计时器（经应用运行期）用的
  都是这一份，所以三处仍在同一份状态上碰面。各函数的逻辑逐字不变，只是批次表与信号量改从交入的实例取：起批次时按配置调整名额并唤醒
  等待者、取名额与归还名额、泵与单行执行、重试时重启泵、回收只扫已完成且过了保留期的批次。
- **读缓存状态**：切面缓存仍是实例字段、5 秒有效期不变；命中条件里的全进程代次换成按库代次，存储的失效把按库代次加一，所以同一个库上
  任一存储（含事务上的）写缓存仓库，其余存储的切面缓存照旧随之作废。在途页读取的合并从镜像缓存按句柄的表移进存储：合并键与原先相同
  （去掉首尾空白的检索词、三个筛选、游标、条数；游标在进存储前解码，坏游标照旧报 `invalid_cursor`），按库共用；镜像缓存的四条写路径与镜像
  组合的切面失效改调存储的失效，效果与原先的“删合并器 + 存储失效”相同。存储自己的写方法现在也换合并器（原先只清切面缓存）——写后的读
  不再并入写前已在途的读，结果只会更新。原先全进程一个代次，一个库的写会作废另一个库的切面缓存；现在只作废自己的。
- **句柄上下文**：多一格按键的模块状态，在 `bindDatabaseHandle` 建上下文时建空表，事务（`inheritDatabaseHandle`）与原生会话共用；没有 provider
  绑定过的对象照旧报 “no session table set”。其余字段不变。
- **用例**：新增 RFC-548 用例并登记 guard-manifest；随改批量导入的用例（每例一份实例代替重置）、`ws-repo-imports`（种批次的实例交给
  WebSocket 夹具的发起者查询）、`cached-repos-http-batch`（去掉重置）、测试助手 `realtimeRuntime`（发起者查询默认查不到）、`providerHttpComposition`
  与 `productionPerformanceApplication`（交一份实例）、`rfc451`、`rfc527`（直接组合交一份实例）、`rfc311`、`rfc349`、`rfc359`（失效改调存储）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-547 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-548 source-control 的守护进程级状态归实例（RFC-294 S12 第二十七步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
