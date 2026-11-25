# RFC-582 实施计划

依赖：RFC-581。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-582-T1 搬迁与连接**：两个绑定迁入 `TE/inbound/http/`，composition 转出挂载函数，`server.ts` 改指（design §1）。
- **RFC-582-T2 门、用例与文档**：归属表、`counts.json`、钉着旧路径的用例；新增 RFC-582 用例并登记 guard-manifest（design §2）。
- **RFC-582-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例；读已提交源码的用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-582-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个旧路径不存在、没有说明符再解析到它们；新文件与原文件逐字节相同
- [x] AC-2 行为不变：挂载调用与顺序不变，路由用例通过
- [x] AC-3 `legacy-horizontal-files` 上限 71 → 69；未消费 public 符号保持 0；DAG 之外的边不增加；归属表删去两行；新增 RFC-582 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（`1c5d5947e`，主 CI 70 / 70）

## 集中验证

本地只跑 SQLite 一支，PostgreSQL 与 Windows 以 exact SHA CI 为准。用例在主树里跑（工作树里只有本会话的改动，共享 index 为空）；读已提交源码的
用例、架构报告与变异在候选导出仓库里跑（HEAD `2f5dcbe3f` 加本 RFC 的 20 个路径，含两个删除，用本地提交固化，树哈希与“HEAD 加这些路径”的树哈希
相同），对照是同一 HEAD 的另一份导出。导出之后只改了收口文档（本文件与 `STATE.md`）；代码、用例、工作流与账本逐个文件比对，与候选相同。

- **推算与实测一致**：动手前在 `2f5dcbe3f` 的报告上逐个路由推算（边的角色一起核对），这两个撤回 0 个；候选的报告里 public 面 856 不变。
- **工作树里跑不了的两条**：`route-error-code-coverage` 用 `git ls-files` 列路由文件，`rfc376-structural-guards` 的计数读已提交源码；两条都在候选
  导出里跑，分别 4 / 4 与 221 / 221。
- **两个绑定**：迁移前后逐字节相同（只用别名 import）。生产代码的其余改动：`server.ts` 的两条 import 合为一条、`composition.ts` 的两条转出。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 12 个 TS 文件无告警，生产文件（4 个）另过 promises 配置；
  prettier：改动的代码、两份 JSON 与三件套通过。
- **选择与语义层**（60 秒；4 个 worker）：选出 649 个用例文件（按 `/api/tasks/:task` 匹配会把任务相关的用例都选进来，宁多勿少），5718 条全部通过；
  `route-error-code-coverage` 按上一条在候选导出里跑。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`tests/architecture/` 的全部用例文件、`rfc317-*` / `rfc294-*`、读架构账本的用例与钉着本次改动
  位置的用例（并上 RFC-576～RFC-581 的清单），共 287 个文件、2829 条全部通过。其中 `rfc376-structural-guards` 221 / 221、RFC-582 用例 7 / 7、
  `rfc294-review-offered-edge-dag` 8 / 8、`rfc193-port-artifacts-api` 8 / 8、`route-error-code-coverage` 4 / 4、`routes-inventory` 11 / 11。
- **变异验证**（候选导出里，每种复原后导出仓库无改动、树哈希不变）：五种都被认出——旧路径上重新出现一跳转出（RFC-582 用例 ① 与
  `rfc376-structural-guards` 的 legacy 计数同红）；测试辅助文件用相对路径的 import 类型取旧路径（用例 ①）；`server.ts` 直接从 inbound 取挂载函数
  （用例 ③）；迁走的绑定取 DAG 之外的模块 public（用例 ② 与 `rfc294-review-offered-edge-dag` 同红，证明那道门也看着 task-execution 的 inbound）；
  绑定取本模块 infrastructure（用例 ②）。m3 的锚点第一次写成单行（`server.ts` 那条 import 被 prettier 折成多行），改正后重跑。
- **架构报告**（候选与对照各出一份）：60 个计数里只有 `legacy-horizontal-files` 变了，71 → 69；未消费 public 符号保持 0；public 面 856、public 类型偏差
  29、不可达生产文件 15、变更入口普查 2390 都不变。跨 context import 7618 → 7624：legacy → task-execution 的类型边 63 → 59、legacy → source-control 的
  类型边 48 → 46 随绑定进模块记到模块名下（task-execution → source-control 的 offered-consumption 74 → 76，DAG 有）；legacy → task-execution 的值边
  148 → 149 是 `server.ts` 改从 composition 取。DAG 之外的 context 值对仍为 0，DAG 之外的已提供文件对 2 条与对照相同。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的 7 个用例文件，见提交说明。

## CI（AC-4）

- `1c5d5947e`（实现）：exact SHA 主 CI run 45585966466 的 70 个 job 全部成功——全部后端分片、真实 PostgreSQL、前端、三个平台的构建与检查、
  ubuntu / windows / macOS 的全部 e2e 分片；按路径触发的 windows-platform（run 45585966454）通过。2026-11-25 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

- **路由行为不变**：两个绑定逐字节不变；`server.ts` 的挂载调用与先后顺序不变，只改 import；路由清单与端口产物、工作树文件的路由用例照旧通过。
- **经 composition 挂载**：composition 只多两条转出；取它的只有 `server.ts` 与 `bootstrap/` 的装配文件，不成环。
- **钉着旧路径的地方都随改**：归属表两行与五个读源码或列清单的用例；两个工作树文件用例开头的说明与 e2e 注释里的行号锚点按 design §2 不改。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
