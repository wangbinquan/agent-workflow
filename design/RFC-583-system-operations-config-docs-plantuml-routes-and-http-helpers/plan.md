# RFC-583 实施计划

依赖：RFC-582。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-583-T1 搬迁与连接**：三个绑定迁入 `SO/inbound/http/`，两个传输工具迁入 `platform/http/`；`publicOrigin` 换中性形状；`config` 删去旧路径的
  类型转出、装配根改取 public；撤回 `ApplicationConfigurationCommands`；composition 转出挂载函数，`server.ts` 改指（design §1）。
- **RFC-583-T2 门、用例与文档**：归属表、`counts.json`、偏差账本、RFC-576 用例、钉着旧路径的用例与注释；新增 RFC-583 用例并登记 guard-manifest
  （design §2）。
- **RFC-583-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-583-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 五个旧路径不存在、没有说明符再解析到它们；三个绑定只改 import（`config` 另删两个旧路径的类型转出），两个传输工具只改 import 与注释
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 69 → 64；public 类型偏差上限 29 → 28；未消费 public 符号保持 0；DAG 之外的边不增加；归属表删去五行；新增
      RFC-583 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `1c5d5947e` 加本 RFC 的 39 个路径，含五个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 里修正的两处、`STATE.md`）；代码、用例、工作流与账本逐个文件比对，
与候选相同。

- **推算与实测一致**：动手前在 `1c5d5947e` 的报告上推算，三个候选里两个经装配根的直取留在 public，实际撤回 1 个（`ApplicationConfigurationCommands`）；
  候选的报告里 public 面 856 → 855，消失的正是它。
- **本人缺陷（已修复并复验）**：① 开发期的 `tsc` 报中性形状不接受配置查询——它的 `read()` 可能同步返回，形状改为同步或异步都收（design §1）。
  ② 选用例一条红：`rfc441` 按名字表 `['auth', 'docs', 'plantuml']` 拼 `routes/` 下的路径，钉点检索只认表头位置的名字，漏了它；用例改指新位置（7 / 7），
  检索改为认表里任意位置。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **改动面**：三个绑定只改 import（`config` 另删两个旧路径的类型转出）；`publicOrigin` 换中性形状并改说明注释，`verifiedBodyLimit` 只改说明注释；
  其余生产改动是 `server.ts` 的 import 合并、`composition/routes.ts` 的转出、撤回的声明（public 删、application 加、composition 改取）、装配根改从 public
  取热应用命令、`verifiedBodyLimit` 的两个使用方与 `oidc-auth.ts` 的 import 各一行、两处源码注释。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 27 个 TS 文件无告警，生产文件（15 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 1365 个用例文件（`/api/config` 端点与 `server.ts`、装配根的 import 会把大量用例选进来，宁多勿少），
  11279 条通过、1 条红（上面 ②），修后复跑通过；`route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-582 的清单），共 295 个文件、2888 条全部通过。其中 `rfc376-structural-guards` 221 / 221、RFC-583 用例 10 / 10、
  `rfc294-review-offered-edge-dag` 8 / 8、RFC-576 用例 7 / 7、`rfc294-architecture-preflight` 15 / 15、`rfc441` 7 / 7、`rfc305-architecture-lock` 15 / 15、
  `rfc247-public-origin` 12 / 12、`rfc370-route-configuration-query` 6 / 6、`route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：七种都被认出——旧路径上重新出现一跳转出（RFC-583 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取挂载函数
  （用例 ⑤ 与 RFC-576 用例同红）；`publicOrigin` 又取 system-operations 的配置查询（用例 ③ 与 `rfc376-structural-guards` 的层规则同红）；迁走的绑定取
  DAG 之外的模块 public（用例 ② 与 `rfc294-review-offered-edge-dag` 同红）；撤回的端口又从 public 转出（用例 ④ 与未消费计数同红）；绑定取本模块
  infrastructure（用例 ②）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 69 → 64 与 `public-surface-deviations` 29 → 28 变了（撤回的端口带走了
  它的 open-type 记录，`counts.json` 的两个上限按实测收紧）；未消费 public 符号保持 0；不可达生产文件 15 不变；变更入口普查 2390 → 2389——
  `verifiedBodyLimit` 里删 `Content-Length` 头的 `headers.delete(…)` 被按文本记成一个入口，普查只扫 `routes` / `mcp` / `ws`，文件进 platform 后不再计入
  （普查只报告、不设门）。跨 context import 7624 → 7636：legacy → system-operations 的类型边 87 → 82（迁走的绑定取本模块 public 改记为模块内），值边
  125 → 129（`server.ts` 改从 composition 取四个挂载函数）；system-operations → legacy 的值边 429 → 442 是三个绑定对 `routes/registry`、`@/auth/actor`
  与 platform 的 import（报告把这一对里的 platform 也记在 legacy 名下，与前几批一样）。DAG 之外的 context 值对仍为 0，DAG 之外的已提供文件对 2 条与
  对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：三个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变；`server.ts` 的挂载调用与先后顺序不变，只改 import；配置读写、API 文档、
  `/.well-known/mcp` 与 PlantUML 的路由用例与路由清单照旧通过。
- **公共来源推导不变**：`publicOrigin` 的推导与读配置的逻辑逐字不变，只换参数的类型名；它对同步与异步的配置读取都照旧 `await`；两个调用方传的是同一个
  配置查询对象（`rfc247-public-origin` 12 / 12、`rfc370-route-configuration-query` 6 / 6）。
- **撤回不改形状**：`ApplicationConfigurationCommands` 逐字移动，工厂、composition 与绑定经 `tsc` 连接；装配根取的热应用命令仍是 public 里的同一个
  声明。
- **钉着旧路径的地方都随改**：归属表五行、`counts.json` 两个上限、偏差账本一行、RFC-576 用例的两处名单、六个按路径读源码或列清单的用例与两处源码
  注释；`oidc-auth.ts` 只改一行 import（其中一句说明注释仍写旧文件名，按凭据相邻文件的约定不动）；e2e 注释里的行号锚点与 `commons-debt.json` 的
  审计锚点按 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
