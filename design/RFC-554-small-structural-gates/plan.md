# RFC-554 实施计划

依赖：RFC-553。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-554-T1**：删死的 `export *`；仓库端点发现挪进 integration 的 infrastructure，组合根与用例改取（design §1）。
- **RFC-554-T2 门与用例**：两份精确清单与 `counts.json` 降低；新增 RFC-554 用例并登记 guard-manifest。
- **RFC-554-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-554-T4 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记一行。

## 验收清单

- [x] AC-1 `runtimeRegistry.ts` 没有 `export *`；仓库端点发现在 integration 的 infrastructure
- [x] AC-2 行为不变
- [x] AC-3 清单与减速带随之降低；新增 RFC-554 用例并登记；读旧位置的用例随改
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `a4ea67ce9` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。没有查出本人缺陷。

- **实测前提**：指向 `application/runtimeRegistry` 的 import、转出与命名空间 import 取到的名字，与 `domain/runtimeProfile`、`public/types` 的导出都没有
  交集——两条通配转出（`export *` 与 `export type *`，后者 design 里漏记，一并删去）都没有读者；删除后 `tsc` 0 错。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 8 个 TS 文件（3 个生产文件、5 个用例）无告警，生产文件
  另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 470 个（语义层 371、经夹具与测试助手补 99），469 个
  通过。红的一个是 `rfc167-dynamic-workflow-engine` 在 `settleTask` 的 5 秒结算期限处到点——那一轮同时跑着文档用例与发布，1 分钟负载 24～42
  （10 核）；单独再跑 3 次都通过（29 / 29），与 RFC-550 复跑时那一次同形，记入 `docs/audit-backlog.md`，与本 RFC 无关（本 RFC 不碰动态工作流）。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：三种变异各自让 RFC-554 用例红——注册表文件重新整体转出 domain（`rfc376-structural-guards`
  的计数门同时红）、application 下重新出现端点发现、别的模块出现一条 `export type *`。
- **架构报告**（候选与对照各出一份）：`export-star-barrels` 1 → 0、`application-direct-effect-files` 2 → 1；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `a74820d0b`（实现，父提交是 `a4ea67ce9`）：exact SHA 主 CI run 45307552450 68 / 70 通过（含全部后端分片与真实 PostgreSQL、三个平台的构建与
  全部 e2e 分片）。红的两格都是环境性的：`Markdown link check (design/)` 是 7 条 raw.githubusercontent.com 链接回 503——都在 RFC-370 / RFC-371 /
  RFC-372 的既有文档里，本 RFC 不碰；`CI required` 是汇总 job，随前者红。没有重跑追绿；与 RFC-378 那类外部 503 同属等用户决定的链接项。
- 落档提交 `a4ea67ce9`（RFC-553 转 Done、RFC-554 落档，只改文档）：主 CI run 45306006668 70 / 70 通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：删去的两条通配转出没有读者（实测与 `tsc`）；端点发现原样挪动，组合根仍把同一个工厂交给 source-control 的端点发现端口，
  请求路径、鉴权头与超时不变。
- **分层**：HTTP 适配器归 integration 的 infrastructure，application 下不再直接调全局 `fetch`。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-553 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-554 两个小结构门（RFC-294 S9 余项）`。走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact
SHA 跟 CI。
