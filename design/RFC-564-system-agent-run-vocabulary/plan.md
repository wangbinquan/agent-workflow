# RFC-564 实施计划

依赖：RFC-563。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-564-T1**：resource-catalog 的托管诊断端口与托管诊断改用本模块的形状；memory 的蒸馏端口从 task-execution 的运行合同上取词汇（design §1）。
- **RFC-564-T2 门与用例**：两份精确清单与 `counts.json` 降低；钉着旧位置的三个用例随改；新增 RFC-564 用例并登记 guard-manifest。
- **RFC-564-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-564-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 memory 与 resource-catalog 不再按 public 取 runtime-management；按名字取它的只属于目标 DAG 上的消费方与 resource-catalog 的指定 adapter
- [x] AC-2 行为不变；形状与 runtime-management 的合同对得上，由编译器检查
- [x] AC-3 DAG 外 offered 边 7 → 4；清单与减速带随之更新；新增 RFC-564 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本 RFC 的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `b2a26ea9b` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷三处（已修复并复验）**：① 漏查三个钉着旧位置的用例——`rfc469-thin-services-facade-retirement` 钉着“memory 的端口从 runtime-management
  转出三个会话类型”，`rfc519-hosted-implementations-out-of-composition-boundary` 钉着托管诊断文件的声明名单，RFC-563 的边界用例钉着
  resource-catalog 还剩 MCP 诊断两处——选集运行里红，逐个改成新的事实。② RFC-564 用例的 guard-manifest 条目照抄了“断言不存在”，而它当时没有这类
  断言（`rfc317-guard-negative-fixture` 红）；补上“memory 全部源码不取 runtime-management”这条显式断言，条目与事实一致。③ memory 端口里的文件内
  别名沿用了 `RuntimeKind` / `RuntimeObservationIdentity` 这两个名字，架构报告按名字开头的动词（含 `run`）普查“变更入口”，多记了两条；改名
  `DistillRuntime*` 后报告的这一节与对照相同。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 9 个 TS 文件（3 个生产文件、6 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 270 个（语义层 179、经夹具与测试助手补 91）。首轮
  266 个通过，4 个红就是上面 ① ② 两处；修正后这四个用例连同读 guard-manifest 的用例共 28 个文件全部通过。之后的改名只动类型别名（运行期不
  存在），以 `tsc` 与候选导出里的用例复验。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-564 用例 7 / 7、RFC-563 用例
  6 / 6、`rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24、`rfc317-guard-negative-fixture` 17 / 17、
  `rfc294-architecture-preflight` 15 / 15、`rfc469-thin-services-facade-retirement` 8 / 8、`rfc519-hosted-implementations-out-of-composition-boundary` 9 / 9。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：六种变异各自让 RFC-564 用例红——memory 的端口重新点名 runtime-management 的事件接收、
  诊断端口重新用材料意图、托管诊断重新点名托管能力类型、另一个 context 开始取 runtime-management 的 public（这四种都与
  `rfc376-structural-guards`、`rfc294-review-offered-edge-dag` 同红），memory 的协议别名不再取自运行合同，诊断端口的事件接收不再是本模块的类型。
  另做一组类型层变异（用量里一个字段改类型、诊断意图的提示词改类型）：候选导出里 `tsc` 报 15 处，落在 bootstrap 的运行器绑定与观察器绑定、
  resource-catalog 的托管诊断、RFC-564 用例的三条编译期断言与七个既有诊断用例的假实现。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 7 → 4；跨 context import 7546 → 7536；public 面（1000）、public 类型偏差
  （56，条目相同）、目标边（111）、生产文件数、变更入口普查（2392）与未消费的 public 符号（0）不变；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **只换类型的出处**：三个生产文件里没有一行可执行代码变化——resource-catalog 组装的诊断请求（一个 MCP、六个运行参数、提示词与人设、续接会话）、
  传给运行器的事件接收与观察器、读托管能力时用到的字段，memory 蒸馏运行的协议、观察身份、运行时绑定与事件接收，值都与原来相同。
- **形状与合同对得上**：诊断意图是材料意图八个字段的子集，本模块的事件接收比 runtime-management 的更宽，用量快照同形，memory 的六个类型就是运行
  合同上的字段类型；十条编译期断言与类型层变异验证过。
- **改名不影响调用方**：`DistillRuntime*` 三个别名不导出，端口里用到它们的三个字段类型不变；导出的事件接收与两个状态类型名字不变，memory 的
  infrastructure 照旧从端口取。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-562 的转 Done（CI 已全绿）同批。RFC-563 的主 CI
仍在跑，转 Done 随后续提交。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
