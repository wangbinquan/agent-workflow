# RFC-581 实施计划

依赖：RFC-580。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-581-T1 搬迁与连接**：三个绑定迁入 `RC/inbound/http/`，composition 转出挂载函数，`server.ts` 改指（design §1）。
- **RFC-581-T2 声明落位**：36 个 public 声明逐字移到 design §1 的落位，6 个转出删去，public 文件清理 import，读者改指。
- **RFC-581-T3 门、用例与文档**：归属表、`counts.json`、`rfc552` / `rfc305` 账本、ACL 写门守卫的委托表、钉着旧路径的用例；新增 RFC-581 用例并登记
  guard-manifest（design §2）。
- **RFC-581-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-581-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 三个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过；36 个声明逐字移动
- [x] AC-3 `legacy-horizontal-files` 上限 74 → 71；未消费 public 符号保持 0；public 类型偏差不变；DAG 之外的边不增加；归属表删去三行；新增 RFC-581
      用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `8a0d8516e` 加本 RFC 的 47 个路径，含三个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 里补记的一条、`STATE.md`）；代码、用例、工作流与账本逐个文件比对，
与候选相同。

- **撤回与实测一致**：动手前在 `8a0d8516e` 的报告上推算（边的角色一起核对），算出 42 个；候选的报告里消失的正是这 42 个，没有新增的 public 符号。
- **本人缺陷（已修复并复验）**：① `tsc` 报技能合同用到的 `SkillJsonSubmission` 在 public 里只是局部声明——它别处不用，随同移进技能合同文件
  （design §1）。② 选用例一条红：`rfc305` 的 identity-access 消费者账本里，移出的 MCP 诊断端口带走了 `public/commands.ts` 对 identity-access 的那条
  依赖、新文件多了一条，账本按实际改（15 / 15）。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **三个绑定**：与原文件相比只改了取移走声明与删去的转出的那几行 import 的来源。生产代码的其余改动：`server.ts` 的三条 import 并进已有的一条、
  `composition.ts` 的转出、三个新的合同文件（36 个声明与一个局部形状逐字移入）、public 文件删去声明与转出并清掉不再用的 import，以及本模块里 13 个
  读者文件的 import。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 38 个 TS 文件无告警，生产文件（22 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 484 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到
  三个挂载函数、对应 HTTP 端点与撤回的 42 个名字的、读 resource-catalog public / composition 与 public 面账本的——4394 条通过、1 条红（上面 ②），修后
  4395 条全部通过；`route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-580 的清单），共 279 个文件、2767 条全部通过。其中 `rfc376-structural-guards` 221 / 221、RFC-581 用例 9 / 9、
  `rfc294-review-offered-edge-dag` 8 / 8、`rfc305-architecture-lock` 15 / 15、`rfc317-acl-write-gate-guard` 13 / 13、`rfc345-resource-catalog-contracts`
  18 / 18、`rfc448` 12 / 12、`rfc552` 13 / 13、发布注册表的 HTTP 面回归用例 5 / 5、`route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：八种都被认出——旧路径上重新出现一跳转出（RFC-581 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取 MCP 路由的
  挂载函数（用例 ④ 与 `rfc448` 的“只经 composition”同红）；绑定取未登记的别的模块 public（用例 ②）；绑定取本模块 infrastructure（用例 ②）；移走的
  插件输入又从 public 转出（用例 ③ 与未消费计数同红）；删去的 MCP 探测转出又加回来（同上）；技能描述合同又从 `public/operations` 转出（用例 ③、
  未消费计数与 `rfc552` 三处同红）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，74 → 71；未消费 public 符号保持 0；public 面 898 → 856（撤回的
  42 个）；public 类型偏差 29、不可达生产文件 15 不变；变更入口普查 2390 不变（18 个同名条目随声明改到新文件）。跨 context import 总数 7618 不变：
  legacy → resource-catalog 的类型边 96 → 58、legacy → identity-access 的类型边 34 → 32 随绑定进模块记到模块名下（resource-catalog → identity-access 的
  `authority-type-only` 34 → 37，DAG 有）；legacy → resource-catalog 的值边 100 → 103 是 `server.ts` 改从 composition 取三个挂载函数。DAG 之外的
  context 值对仍为 0，DAG 之外的已提供文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：三个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变；改的 import 取到的是同一份声明（逐字移动，或删去的转出原本指向的
  声明处）；`server.ts` 的挂载调用与先后顺序不变，只改 import；路由清单与 MCP、技能、插件的路由用例照旧通过。
- **声明形状不变**：36 个声明与一个局部形状逐字移动，`tsc` 检查全部连接处；发布注册表的 `mcps` / `skillId` 探测经 HTTP 面读法照旧认得出（回归
  用例 5 / 5）。
- **经 composition 挂载**：composition 只多三条转出；取它的只有 `server.ts` 与 `bootstrap/` 的装配文件，不成环；`rfc448` 的“装配根不取路由”改为
  “只经 composition 转出”，变异 m3 证明它仍有效。
- **钉着旧路径的地方都随改**：归属表三行、`rfc305` 的消费者账本两条、`rfc552` 的入口账本、ACL 写门守卫的委托表、`rfc222` 的删除确认清单、`rfc345`
  的两张路由表与十余个读源码的用例；e2e 注释里的行号锚点按 RFC-579 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
