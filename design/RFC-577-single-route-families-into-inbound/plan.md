# RFC-577 实施计划

依赖：RFC-576。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-577-T1 搬迁与连接**：两个绑定迁入各自模块的 `inbound/http/`，两个 composition 转出挂载函数，只被它们用的 public 转出撤回，
  `server.ts` 与用例改指（design §1）。
- **RFC-577-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例与指针；新增 RFC-577 用例并登记 guard-manifest（design §2）。
- **RFC-577-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-577-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 91 → 89；未消费 public 符号保持 0；归属表删去两行；新增 RFC-577 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`f21fd1ced`，主 CI 70 / 70）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `23bd6b03a` 加本 RFC 的 22 个路径，含两个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md`、RFC 索引与 RFC-576 转 Done 的两处记录）；代码、用例、工作流与
账本逐个文件比对，与候选相同。

- **本人缺陷三处与范围调整（已修复并复验）**：① 第一轮选用例两条红，都是检索时漏的：`rfc317-table-ownership` 的“非模块源文件多于 600 个”下限
  （路由迁走后这份语料按设计缩小，改成 500，理由见 design §2），与 `rfc310-digital-employee-os-architecture` 读的 OS 架构清单（execution-contract 的
  顶层目录多了 `inbound`，模块外依赖换了一条）。② 第一次出架构报告，integration 的未消费 public 符号 0 → 3、task-catalog 0 → 2：撤回第一层转出之后，
  它们引用的类型也只剩本模块在用（RFC-576 的同一种连带，设计时只算了第一层）。integration 那三个删去转出；task-catalog 的两个一撤，task-catalog 就
  整个没有 public 面了，又连带 `rfc317-module-boundary` 的 R3 账本与三处“有 public 面的 context 至少 19 个”的下限——这是结构决定，task-catalog 移出
  本 RFC（design §5 第 2 条），它的改动全部还原，相关文件与 HEAD 相同。第三次出报告为 0。③ integration `public/types.ts` 的文件头还写着“两个路由
  合同及其参数”，改成现状。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **两个绑定**：与原文件相比各只差一行 import（`parseExecutionContractRef` 改取 `../../domain/model`，`CodeHostConnectionAdministration` 改取
  `../../application/ports/codeHostConnections`），行数不变，e2e 里的行号指针照旧成立。生产代码的其余改动：`server.ts` 的两条 import、两个
  `composition.ts` 各一条转出、两个 public 文件的撤回与 integration 那份的文件头。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 13 个 TS 文件无告警，生产文件（7 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 198 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到两个
  挂载函数与对应 HTTP 端点的、读这两个模块 public / composition 与 public 面账本的、读 OS 架构清单与未消费计数的——修后 2018 条全部通过；
  `route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576 的那份清单），共 210 个文件、2002 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、
  RFC-577 用例 7 / 7、`rfc294-architecture-preflight` 15 / 15、`rfc305-architecture-lock` 15 / 15、`rfc317-module-boundary` 23 / 23、
  `rfc310-digital-employee-os-architecture` 11 / 11、`route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动）：九种都被认出——旧路径上重新出现一跳转出（RFC-577 用例 ① 与 `rfc376-structural-guards` 的
  legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取挂载函数（用例 ④）；绑定取别的模块的
  public（用例 ②）；绑定取本模块 infrastructure（用例 ②）；撤回的解析函数又从 public 转出（用例 ③ 与未消费 public 符号计数同红）；连带撤回的端口
  类型又转出（同上）；execution-contract 多一个顶层目录、模块外多一条依赖（`rfc310` 各红一次，证明 OS 架构清单的更新没让它失效）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，91 → 89（少的正是这两个文件）；未消费 public 符号保持 0；
  public 面 983 → 978（撤回的五个）；public 类型偏差 32 不变；变更入口普查 2393 不变。跨 context import 7546 → 7553：legacy → execution-contract 的
  类型边 1 → 0、legacy → integration 的类型边 19 → 18（旧路由取 public 的那两条）；legacy → integration 的值边多了 `server.ts` 取 composition 的
  一条，legacy → execution-contract 的值边由旧路由取解析函数换成 `server.ts` 取 composition；两个绑定对 `platform`、`routes/registry` 与
  `@/auth/actor` 的边随绑定进模块记到模块名下（execution-contract → legacy 3 → 5、integration → legacy 143 → 149）。DAG 之外的 context 值对仍为 0。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `f21fd1ced`（实现，父提交是 `23bd6b03a`；同一提交记 RFC-576 转 Done）：exact SHA 主 CI run 45548520359 的 70 个 job 全部成功——全部后端分片、真实
  PostgreSQL、前端、三个平台的构建与检查、ubuntu / windows / macOS 的全部 e2e 分片。同一提交按路径触发的 windows-platform（run 45548520358）也
  通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：两个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变，只各改一行 import 的来源，取到的是同一个函数、同一个类型（`public/types`
  原先就是从 `domain/model` 与 `application/ports/codeHostConnections` 转出的）；`server.ts` 的挂载调用与先后顺序不变，只改两条 import；路由清单
  （`routes-inventory`）、代码平台连接与执行合同的路由用例照旧通过。
- **经 composition 挂载**：两个 composition 只多一条转出；取它们的只有 `server.ts` 与 `bootstrap/` 的装配文件，绑定取的 `routes/registry`、
  `@/auth/actor` 与 `platform` 都不回指它们，不成环；`rfc393` 的 CLI 装配分离守卫照旧通过。
- **撤回的五个转出**：都确认过模块外没有消费者（架构报告的消费者表与全文检索），`tsc` 检查连接处；integration 仍转出模块外在用的
  `CodeHostConnectionProbe`（`routes/accountRepositoryTransportCredentials.ts` 取它）与它引用的 `CodeHostConnectionCredential`。
- **钉着旧路径的地方都随改**：归属表两行、`rfc450` / `rfc349` 读源码的路径、OS 架构清单与 e2e 的一处指针；`rfc317-table-ownership` 的非模块下限按
  design §2 改成 500。
- **task-catalog**：改动全部还原，与它相关的文件都与 HEAD 相同；留给单独的 RFC（design §5 第 2 条）。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
