# RFC-561 实施计划

依赖：RFC-560。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-561-T1**：两份聚合方自有端口，两个聚合改用；五个来源 context 把失去模块外读者的类型从 public 撤回模块内（design §1）。
- **RFC-561-T2 门与用例**：两份精确清单与 `counts.json` 降低；钉着旧位置的用例与清单随改；新增 RFC-561 用例并登记 guard-manifest。
- **RFC-561-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-561-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个聚合不再取来源 context；七个来源端口由聚合方自己声明
- [x] AC-2 行为不变；各 owner 的对象满足端口由编译器检查
- [x] AC-3 DAG 外 offered 边 33 → 26；清单与减速带随之更新；失去模块外读者的 public 类型撤回模块内；新增 RFC-561 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里只有本 RFC 的改动，共享 index 为空）；
读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `c974e28eb` 加本 RFC 的路径，用本地提交固化，核对与工作树逐字相同），对照是同一 HEAD
的另一份导出。

- **本人缺陷两处（已修复并复验）**：两处都是没查到的精确清单，选集运行里红。① `rfc305-architecture-lock` 钉着取 identity-access 合同的文件清单：
  两个类型随声明搬了家（digital-employee 的清单类型、task-execution 的任务计数查询），两份新端口各取一次 authority 类型——清单按实测改了六行。
  ② RFC-310 的 `os-architecture-manifest.json` 钉着 digital-employee 的外部依赖，intent 平台清单那一条已不存在——销去（RFC-558 犯过同一类漏查，
  这次调研仍只搜了用例目录，没搜 `design/` 下的清单）。修完后这两个用例、读 guard-manifest 的 20 个用例与 RFC-561 用例共 23 个文件全部通过。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 26 个 TS 文件（17 个生产文件、9 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、architecture 清单、RFC-310 清单与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 650 个（语义层 458、经夹具与测试助手补 192）。首轮
  647 个通过，3 个红：上面两处本人缺陷，以及 `rfc167-dynamic-workflow-engine` 的 `settleTask` 在 5 秒结算期限处到点（任务仍是 running）——与
  `docs/audit-backlog.md` 记过的两次同形，当时本机 1 分钟负载约 85（10 核，另有一台虚拟机占着约三个半核），同文件单独再跑 3 次都通过
  （29 / 29），记为第三次；本 RFC 不碰动态工作流。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221；RFC-561 用例 8 / 8、
  `rfc294-review-offered-edge-dag` 8 / 8、`rfc317-guard-corpus-floor` 24 / 24。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：七种变异各自让 RFC-561 用例红——总览聚合重新取 memory 的 public、intent 平台清单重新取
  digital-employee 的 public（`rfc503` 的依赖面同红）、intent 的端口取 development-automation 的 public（这三种 `rfc376-structural-guards` 与
  `rfc294-review-offered-edge-dag` 同红）、总览端口取 task-execution 的内部文件（`rfc376-structural-guards` 的跨 context 内部文件对同红）、
  task-execution 的 public 重新转出任务计数查询、integration 的 `public/queries.ts` 回来（这两种 `rfc376-structural-guards` 的未消费计数同红）、
  总览聚合按值取 identity-access 的装配。另做一组类型层变异（仓库数来源改成返回字符串、数字员工来源多要一个方法）：候选导出里 `tsc` 报 10 处，
  落在 bootstrap 的两个交接处、RFC-561 用例的两条编译期断言、测试助手与三个用例的假实现。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 33 → 26；public 面 1018 → 1010（正好是撤出的 8 个）；跨 context import
  7559 → 7554；生产文件 +3（新增四个、删去一个）；未消费的 public 符号仍为 0（撤出一次到位，没有连带）；其余门与计数不变，目标边仍是 110 条。
  报告的 required 端口普查 66 → 71：总览的五个来源端口按命名被列入 system-operations 一栏，状态与该模块其余由 bootstrap 绑定的端口相同（只是报告，
  不是门）。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：`composeSystemOverviewQuery` 与 `createIntentPlatformInventoryParticipant` 的函数体只换了入参与行的类型出处，调用、次序、七天窗口、
  同请求合并与各处 `permissions.has` 判断一字未动；bootstrap 交给它们的仍是原来那七个对象。
- **端口覆盖面**：总览的五个端口正好是聚合调用的六个方法（记忆来源两个）；平台清单的两个端口覆盖它读的五种开发配置与三种数字员工清单。入参都是
  owner 合同的子集、返回是其超集，编译器在交接处与用例里检查（类型层变异验证过会报错）。
- **撤出只挪声明**：八个类型逐字挪到模块内（resource-catalog 的两个在用例旁、task-execution 的进 `application/ports`、digital-employee 的三个进
  `application/ports`、source-control 的写在装配输出上、integration 的本来就在端口文件里），各 owner 的实现与装配没有改一行逻辑。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
