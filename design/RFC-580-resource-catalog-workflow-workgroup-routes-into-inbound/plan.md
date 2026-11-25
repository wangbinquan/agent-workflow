# RFC-580 实施计划

依赖：RFC-579、`d6a26069b`（发布注册表补正）与 `ad64ba6e5`（RFC-579 的两个用例补正）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再
集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-580-T1 搬迁与连接**：三个绑定迁入 `RC/inbound/http/`，composition 转出挂载函数，`server.ts` 改指（design §1）。
- **RFC-580-T2 声明落位**：22 个 public 声明逐字移到 design §1 的落位，两个共用形状就地转出，public 文件清理 import，读者改指。
- **RFC-580-T3 门、用例与文档**：归属表、`counts.json`、`rfc552` / `rfc305` 账本、ACL 写门守卫的委托表、钉着旧路径的用例；新增 RFC-580 用例并登记
  guard-manifest（design §2）。
- **RFC-580-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-580-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 三个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过；22 个声明逐字移动
- [x] AC-3 `legacy-horizontal-files` 上限 77 → 74；未消费 public 符号保持 0；public 类型偏差不变；DAG 之外的边不增加；归属表删去三行；新增 RFC-580
      用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `ad64ba6e5` 加本 RFC 的 63 个路径，含三个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md` 与 RFC 索引）；代码、用例、工作流与账本逐个文件比对，与候选相同。

- **第一次实施退回重做**：第一次按四个路由、30 个声明实施，选出的 593 个用例文件里四条红。① `rfc294-review-offered-edge-dag`：迁进模块的
  `workgroups` 取 task-execution 的 offered public，DAG 里没有这条边——推算时只看了“这对 context 在 DAG 里有边”，没看边的角色（只有
  required-implementation）。这是设计问题，`workgroups` 退出本 RFC，等用户定（proposal §1）。② `rfc345-provider-neutral-classic-facades` 不许
  `public/operations` 取 application，第一次把两个共用形状挪进 `application/catalogOperationParts.ts` 撞上了，改为就地转出（design §5 第 3 条）。
  ③ ④ `rfc345` 里两处读 public 文本找房间封套、模块合同与工作流删除回执的断言，按意图改读落位文件。整个改动从干净的树按缩小后的计划重做
  （搬迁与落位都是脚本）。推算工具随之改为按边的角色判断。
- **撤回与实测一致**：候选的报告里消失的正是计划的 22 个；新出现的两个 public 符号是就地转出的两个共用形状（留在 public 的合同引用它们，不算未消费）。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **三个绑定**：与原文件相比只改了取移走声明的那几行 import 的来源。生产代码的其余改动：`server.ts` 的 import（三条合为一条）、`composition.ts` 的转出、
  两个新的合同文件（22 个声明逐字移入）、四个 public 文件删去声明并清掉不再用的 import、两个共用形状加 `export`、`PackageResourceRef` 改按共享合同
  约束，以及本模块里 17 个读者文件的 import。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 54 个 TS 文件无告警，生产文件（23 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：重做后选出 507 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到
  三个挂载函数、对应 HTTP 端点与移走的声明的、读 resource-catalog public / composition 与 public 面账本的——4800 条全部通过；
  `route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-579 的清单），共 272 个文件、2715 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、
  RFC-580 用例 9 / 9、`rfc294-architecture-preflight` 15 / 15、`rfc294-review-offered-edge-dag` 8 / 8、`rfc305-architecture-lock` 15 / 15、
  `rfc317-module-boundary` 23 / 23、`rfc317-acl-write-gate-guard` 13 / 13、`rfc345-resource-catalog-contracts` 18 / 18、`rfc552` 13 / 13、
  `route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：九种都被认出——旧路径上重新出现一跳转出（RFC-580 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取挂载函数
  （用例 ④）；绑定取未登记的别的模块 public（用例 ②）；绑定取本模块 infrastructure（用例 ②）；移走的房间类型又从 public 转出（用例 ③ 与未消费
  public 符号计数同红）；工作流描述合同又从 `public/operations` 转出（用例 ③、未消费计数与 `rfc552` 三处同红）；落位文件不再导出某个移入的声明
  （用例 ③）；迁走的工作流路由取 legacy 的数据库客户端（用例 ② 与 `rfc345-provider-neutral-classic-facades` 同红，证明它改读新路径后仍有效）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，77 → 74；未消费 public 符号保持 0；public 面 918 → 898（撤回 22
  个、就地转出 2 个）；public 类型偏差 29 不变；不可达生产文件 15 不变；变更入口普查 2390 不变（其中五个同名条目随声明改到新文件）。跨 context
  import 7611 → 7618：legacy → resource-catalog 的类型边 117 → 96、legacy → identity-access 的类型边 36 → 34，都是旧路由那几条随绑定进模块记到模块
  名下（resource-catalog → identity-access 的 `authority-type-only` 32 → 34，DAG 有）；legacy → resource-catalog 的值边 97 → 100 是 `server.ts` 改从
  composition 取三个挂载函数；绑定对 `platform`、`routes/` 传输工具与 `@/auth/actor` 的边记到模块名下。DAG 之外的 context 值对仍为 0，DAG 之外的已提供
  文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：三个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变；改的 import 取到的是同一份声明（逐字移动）；`server.ts` 的挂载调用与先后
  顺序不变，只改 import；路由清单（`routes-inventory`）与工作流、任务房间、资源包的路由用例照旧通过。
- **声明形状不变**：22 个声明逐字移动，`tsc` 检查全部连接处（含 `rfc345` 里按类型相等写的编译期断言）；`PackageResourceRef` 改按 `BundleResourceType`
  约束与原来的 `PackageResourceKind = BundleResourceType` 等价。
- **经 composition 挂载**：composition 只多三条转出；取它的只有 `server.ts` 与 `bootstrap/` 的装配文件，绑定取的 `routes/` 传输工具、`@/auth/actor` 与
  `platform` 都不回指它，不成环；R2 的业务层围栏不含 `inbound`。
- **钉着旧路径的地方都随改**：归属表三行、`rfc305` 的消费者账本、`rfc552` 的入口账本、ACL 写门守卫的委托表、`rfc345` 的两张路由表与十余个读源码的
  用例；`workgroups` 的钉点照旧（它没迁）；e2e 注释里的行号锚点按 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
