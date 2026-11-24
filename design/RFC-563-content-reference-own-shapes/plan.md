# RFC-563 实施计划

依赖：RFC-562。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-563-T1**：resource-catalog 与 source-control 用自己的形状声明内容引用与资源材料，四个文件不再取 runtime-management（design §1）。
- **RFC-563-T2 门与用例**：两份精确清单与 `counts.json` 降低；`PUBLIC_SURFACE_DEBT` 里那一条按新的归属登记；新增 RFC-563 用例并登记
  guard-manifest；三个边界用例的 import 判据补上类型位置的 `import('…')`。
- **RFC-563-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-563-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 source-control 的生产文件不取 runtime-management；resource-catalog 取它的只剩 MCP 诊断的两处与指定 adapter
- [x] AC-2 行为不变；两个 owner 的形状仍能交给材料意图与本机端口，由编译器检查
- [x] AC-3 DAG 外 offered 边 11 → 7；清单与减速带随之更新；`PUBLIC_SURFACE_DEBT` 那一条按新的归属登记；新增 RFC-563 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本 RFC 的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `b3850ff9a` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷一处（已修复并复验）**：以为 resource-catalog 不再够到意图后，`PUBLIC_SURFACE_DEBT` 里“意图的 `Logger`”那一条会消失，于是把它删了、
  把减速带降到 55。实测那一条按“第一个够到该声明的 public 根”记名：resource-catalog 让出后，同一处偏差由 runtime-management 自己的
  `AgentMaterialCompiler` 根够到——条目换名、条数仍是 56（`rfc294-architecture-preflight` 与 `rfc376-structural-guards` 的减速带在选集运行里红）。条目
  按实测登记、减速带改回 56 后两个用例通过。RFC-562 遇到过同一条规则（那次是靠把实现撤出 public 才真的销账），这次预判仍然错了。
- **判据补强**：三个边界用例（RFC-561 / 562 / 563）的 import 判据原先不认类型位置的 `import('…')`（全仓的 census 认，没有漏网，但用例自己的说法是
  “都认”）；补上并各加一条负对照，变异 m5 专门走这种写法。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 10 个 TS 文件（4 个生产文件、6 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 165 个（没有经夹具与测试助手补的）。首轮 163 个通过，
  2 个红就是上面那处账本缺陷；修正后连同三个边界用例与读 guard-manifest 的用例共 27 个文件全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-563 用例 6 / 6、RFC-561 用例
  8 / 8、RFC-562 的边界用例 8 / 8、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、`rfc294-architecture-preflight` 15 / 15。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：六种变异各自让 RFC-563 用例红——source-control 的工作区内容、resource-catalog 的托管插件
  读取、本机引用实现重新点名材料意图（三种都与 `rfc376-structural-guards`、`rfc294-review-offered-edge-dag` 同红），材料清单重新用意图的类型（语句
  import 一种，`rfc294-architecture-preflight` 同红；类型位置的 `import('…')` 一种），内容引用不再写明 owner。另做一组类型层变异（引用的 owner 改成
  别的字面量、工作区内容的入参多要一个字段）：候选导出里 `tsc` 报 12 处，落在 bootstrap 的绑定、task-execution 把材料放进意图与实现托管引用的
  地方、resource-catalog 的本机实现与 RFC-563 用例的五条编译期断言。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 11 → 7；`public-surface-deviations` 仍是 56（一条换名）；public 面 1000 不变；
  跨 context import 7550 → 7546；生产文件数、目标边（111）与未消费的 public 符号（0）不变；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `b2a26ea9b`（实现，父提交是 `b3850ff9a`）：exact SHA 主 CI run 45405881445 70 / 70 通过；同一提交触发的 windows-platform（run 45405881372）
  通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **只换类型的出处**：四个生产文件的函数体没有改动逻辑——resource-catalog 发出的引用与材料、托管插件读取对 owner 与版本的检查、source-control 的
  绑定与挂载引用，值与次序都与原来相同；改的是标注（WeakMap 的键从“意图的引用类型”换成 `object`，仍按对象身份查）。
- **绑定在严格方向上成立**：入参比材料意图宽、出参更具体，bootstrap 的两处绑定、task-execution 把材料放进意图与它的托管引用实现都照旧通过类型检查
  （类型层变异验证过会报错）。
- **用例判据的补强不放过原有情形**：三个边界用例在补上 `import('…')` 后各自的原有断言与负对照都还在、都通过。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。RFC-562 的 CI 仍在跑，它的转 Done 随后续提交。走私有
index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
