# RFC-576 实施计划

依赖：RFC-575。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-576-T1 搬迁与连接**：七个绑定迁入 `SO/inbound/http/`，新增 `SO/composition/routes.ts`，`server.ts` 与用例改指（design §1、§2）。
- **RFC-576-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例与指针；新增 RFC-576 用例并登记 guard-manifest（design §3）。
- **RFC-576-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-576-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 七个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 98 → 91；归属表删去七行；新增 RFC-576 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `8f236d5bb` 加本 RFC 的 48 个路径，含七个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、`STATE.md` 与 RFC-575 转 Done 的三处记录）；代码、用例、工作流与账本逐个
文件比对，与候选相同。

- **本人缺陷三处（已修复并复验）**：① 第一次出架构报告，`unconsumed-public-symbols-system-operations` 0 → 3：`public/operations` 的两个描述合同与
  `public/queries` 的 `SystemOverviewQuery` 只有这七个绑定在用，绑定进模块后就没有模块外的消费者了——设计时没想到这一层。撤回 application 之后
  第二次出报告仍是 0 → 3：它们引用的 `SystemOverviewAuthority`、`CancelStagedRestoreResult`、`RecoveryStatusView` 随之只剩自己人用，一并撤回
  （design §0）。第三次出报告为 0。② `rfc305` 的 identity-access 消费者账本里 `public/operations.ts` 那一条随撤回失效，删去。③ `rfc561` 钉着
  `overview.ts` 一行 import 的原文，撤回后那一行多带了一个名字，改成按意图匹配。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件（工作树里还列着已删的旧路由、看不见新文件），
  `rfc376-structural-guards` 的计数读已提交源码；两条都在候选导出里跑，分别 4 / 4 与 221 / 221。
- **七个绑定**：迁移前后逐字节相同（它们只用别名 import）；撤回 public 之后，备份、还原、数据库迁移与系统总览四个绑定各改一行 import，改取本模块
  application 的合同。生产代码的其余改动：`server.ts` 的七条 import 合为一条、`composition/routes.ts` 新增、六个类型的落位（`public/operations`、
  `public/queries`、`public/types` 各删、`application/operationDescriptors.ts`、`overview.ts`、`ports/systemOverviewSources.ts`、
  `systemOperationContracts.ts` 各接收）与 `composition.ts`、`systemOperationPorts.ts` 的 import，以及 `migrationsFolder.ts` 一处注释。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 35 个 TS 文件无告警，生产文件（19 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 281 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到七个
  挂载函数与对应 HTTP 端点的、读 system-operations public / application / composition 与 public 面账本的——2910 条通过、1 条红（`rfc561`，即上面
  ③，修后 8 / 8）；`route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例，共 204 个文件、1947 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、RFC-576 用例 7 / 7、
  `rfc294-architecture-preflight` 15 / 15、`rfc305-architecture-lock` 15 / 15、`rfc552-public-operations-exemption-lock` 13 / 13、
  `route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11、`rfc317-acl-write-gate-guard` 13 / 13。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：七种都被认出——旧路径上重新出现一跳转出（RFC-576 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；`server.ts` 直接从 inbound 取一个挂载函数（用例 ④）；绑定值引用 public（用例 ②）；绑定取本模块
  infrastructure（用例 ②）；`composition/routes.ts` 多了代码（用例 ③）；撤回的合同又从 public 转出（`rfc376-structural-guards` 的
  未消费 public 符号计数红）；绑定多取 identity-access 的另一个 public 入口（用例 ② 与 `rfc305` 的消费者账本同红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，98 → 91（少的正是这七个文件）；未消费 public 符号保持 0；
  public 面 989 → 983（撤回的六个）；public 类型偏差 32 不变；变更入口普查 2393 不变。跨 context import 7530 → 7546：legacy → identity-access 的
  类型边 50 → 40、system-operations → identity-access 的 `authority-type-only` 边 11 → 19（DAG 已有这一项），system-operations → legacy（路由传输工具
  与 `@/auth/actor`）的边随绑定进模块而增加，legacy → system-operations 的值边多了 `server.ts` 取 `composition/routes` 的七条；没有新的跨 context
  内部 import，DAG 之外的 context 值对仍为 0。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：七个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变（撤回 public 之后改的只是四行 import 的来源）；`server.ts` 的挂载调用与
  先后顺序不变，`composition/routes.ts` 交出的是同一批函数；路由清单（`routes-inventory`）与 ACL 写门守卫（`rfc317-acl-write-gate-guard`）照旧通过。
- **撤回的六个类型**：只是换了声明位置，形状逐字不变；每个都确认过模块外没有消费者（架构报告的消费者表与全文检索），消费它们的本模块文件与用例都
  改取新位置，`tsc` 检查连接处。
- **钉着旧路径的地方都随改**：归属表七行、`rfc305` 的消费者账本（四条改指新位置、一条随撤回删去）、`rfc345` / `rfc346` / `rfc370` 读源码的路径、
  `rfc346` 对描述合同来源的断言、`rfc552` 的 public/operations 导出清单、`rfc561` 的 import 断言、`migrationsFolder.ts` 的一处现状注释与 e2e 里的
  五处指针。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
