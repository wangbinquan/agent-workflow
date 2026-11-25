# RFC-579 实施计划

依赖：RFC-578。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-579-T1 搬迁与连接**：七个绑定迁入各自模块的 `inbound/http/`，两个 composition 转出挂载函数，47 个 public 转出撤回（含删除
  development-automation 的 `public/operations.ts`），`server.ts` 与读者改指（design §1）。
- **RFC-579-T2 门、用例与文档**：归属表、`counts.json` 两项、偏差清单、`rfc552` / `rfc550` 两个账本、钉着旧路径的用例；新增 RFC-579 用例并登记
  guard-manifest（design §2）。
- **RFC-579-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-579-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 七个旧路径不存在、没有说明符再解析到它们；新文件只差说明符
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 84 → 77、`public-surface-deviations` 上限 32 → 29；未消费 public 符号保持 0；归属表删去七行；新增
      RFC-579 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（实现 `58ab43d1f` 的三格红由 `ad64ba6e5` 补正；以后继 `8a0d8516e` 的主 CI 70 / 70 为证据）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `0a5bf21f1` 加本 RFC 的 62 个路径，含八个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件、design 里补记的两段、`STATE.md`、RFC 索引与 RFC-578 转 Done 的两处记录）；
代码、用例、工作流与账本逐个文件比对，与候选相同。

- **撤回的推算与实测一致**：动手前在 `0a5bf21f1` 的报告上模拟撤回（RFC-578 design §3），算出 collaboration 四层 25 个、development-automation 四层
  22 个；候选的报告里消失的正是这 47 个，三条 public 类型偏差随之消失，未消费 public 符号保持 0，不可达生产文件的清单不变。
- **本人缺陷（已修复并复验）**：选用例跑下来两条红，都是没预先查到的账本：`rfc294-architecture-preflight` 的 capability 名称账本里
  `ReviewActor leaks through public/types` 一条随撤回不再成立，`rfc439` 的 `routes/` 非空下限是 30（design §2）。修后两个文件 23 / 23。
  这次按 RFC-578 的教训用全名单检索读者，`tsc` 第一次就是 0 错。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **七个绑定**：与原文件相比各只改了取撤回符号的那几行 import 的来源（`developmentConfig` 两行，`reviews`、`taskQuestions` 各两行，其余各一行），
  取到的是同一份定义。生产代码的其余改动：`server.ts` 的 import（collaboration 四条合为一条，development-automation 三条并进已有的一条）、两个
  `composition.ts` 的转出、三个 collaboration public 文件与 development-automation `public/commands.ts` 的撤回、`public/operations.ts` 的删除，以及
  五个本模块读者各改一行 import。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 47 个 TS 文件无告警，生产文件（19 个）另过 promises
  配置；prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 653 个用例文件——直接 import 或按路径读改动文件的、按目录扫 `routes/` 或模块 `inbound/` 的、提到七个
  挂载函数、对应 HTTP 端点与撤回的符号的、读两个模块 public / composition 与 public 面账本的——6370 条通过、2 条红（上面那两处），修后 6372 条全部
  通过；`route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-578 的清单），共 249 个文件、2422 条全部通过。其中 `rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221、
  RFC-579 用例 9 / 9、`rfc294-architecture-preflight` 15 / 15、`rfc305-architecture-lock` 15 / 15、`rfc317-module-boundary` 23 / 23、
  `rfc317-acl-write-gate-guard` 13 / 13、`rfc442` 9 / 9、`rfc550` 11 / 11、`rfc552` 13 / 13、`route-error-code-coverage` 4 / 4、`routes-inventory`
  11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：十种里九种被认出——旧路径上重新出现一跳转出（RFC-579 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取挂载函数
  （用例 ④）；绑定取未登记的别的模块 public（用例 ②）；绑定取本模块 infrastructure（用例 ②）；路由操作端口又从 collaboration public 转出（用例 ③ 与
  未消费 public 符号计数同红）；development-automation 的 `public/operations.ts` 带一个描述工厂重建（用例 ③、未消费计数与 `rfc552` 的入口清单三处
  同红）；连带撤回的人工门类型又转出（用例 ③ 与未消费计数同红）；仍在 `routes/` 的 `taskFeedback` 取 collaboration 内部（`rfc442` 的严格一半红）。
  第十种（把 ACL 写门守卫委托表的键改回旧路径）没红——在对照的 HEAD 上把这个键改成不存在的路径也照样通过，说明这个条目本来就用不到，它不能
  当见证；改它只是让条目指向存在的文件。迁走的配置路由仍在这个守卫的语料里（它扫各模块的 `inbound/`）。
- **架构报告**（候选与对照各出一份）：60 个计数里只有两项变了：`legacy-horizontal-files` 84 → 77（少的正是这七个文件）、`public-surface-deviations`
  32 → 29（销账的正是那三条）；未消费 public 符号保持 0；public 面 965 → 918（撤回的 47 个）；不可达生产文件 15 不变；变更入口普查 2391 → 2390
  （design §2）。跨 context import 7577 → 7611：legacy → collaboration 的类型边 10 → 6、legacy → development-automation 的类型边 20 → 15、
  legacy → identity-access 的类型边 38 → 36、legacy → task-execution 的类型边 64 → 63，都是旧路由那几条随绑定进模块记到模块名下
  （development-automation → identity-access 的 `authority-type-only` 5 → 7、collaboration → task-execution 的 offered-consumption 65 → 66，DAG 都有）；
  legacy → collaboration 的值边 48 → 50、legacy → development-automation 的值边 70 → 68，是 `server.ts` 改从 composition 取挂载函数、旧路由取
  public 值的边随之消失；绑定对 `platform`、`routes/` 传输工具与 `@/auth/actor` 的边记到模块名下。DAG 之外的 context 值对仍为 0，DAG 之外的已提供
  文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `58ab43d1f`（实现）：exact SHA 主 CI run 45570161148 三格红（后端分片 11/44、前端分片 1/3 的 ubuntu 与 windows），windows-platform
  run 45570161411 红，都归因于本 RFC 漏改的两个按路径读路由源码的用例（`rfc143` 读 `routes/clarify.ts`、前端的 `code-config-api-base` 读
  `routes/developmentConfig.ts`），由 `ad64ba6e5` 补正（同一组红也出现在其后的发布注册表补正 `d6a26069b` 上，不由它引起）。
- `ad64ba6e5`（补正）：主 CI run 45574363157 收尾为 cancelled——macOS e2e 分片 3/4 的 141 条用例全部通过、作业在收尾时撞上 20 分钟时限，其余
  68 格通过；windows-platform（run 45574363127）与 visual-regression-nightly（run 45574363167）通过。
- 后继证据（CLAUDE.md：被取消的 run 以包含它的后继提交的 CI 为证据）：`8a0d8516e`（RFC-580）以 `ad64ba6e5` 为祖先、补正的三个文件原样保留，它的
  exact SHA 主 CI run 45578856280 70 / 70 全绿（含 macOS e2e 分片 3/4），windows-platform run 45578856368 通过。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：七个绑定的路由、方法、鉴权声明与处理逻辑逐字节不变；改的 import 取到的是同一份定义（public 原先就是从这些 application /
  domain 文件转出的）；`server.ts` 的挂载调用与先后顺序不变，只改 import；路由清单（`routes-inventory`）与审查、澄清、提问、开发配置 / 任务、上传
  的路由用例照旧通过。
- **经 composition 挂载**：两个 composition 只多几条转出；取它们的只有 `server.ts` 与 `bootstrap/` 的装配文件，绑定取的 `routes/` 传输工具、
  `@/auth/actor` 与 `platform` 都不回指它们，不成环；R2 的业务层围栏不含 `inbound`。
- **撤回的 47 个转出与删掉的入口**：都确认过模块外没有消费者（架构报告的消费者表与全文检索），`tsc` 检查连接处；本模块里经 public 取它们的五个
  读者改取声明处；`rfc552` 的入口清单、`rfc550` 的冻结夹具（按“后来删掉的入口什么都不交出”处理）随之调整。
- **钉着旧路径的地方都随改**：归属表七行、`rfc305` 的消费者账本两条、`rfc331` 的 legacy 消费者清单、读源码或按路径扫描的十余个用例、`rfc442`
  的方向用例（拆成仍在 `routes/` 的一个严格、迁进模块的两个取本模块内部）与几处对照；e2e 注释里的行号锚点按 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
