# RFC-612 实施计划

依赖：RFC-447、RFC-451、RFC-527（仓库组与缓存仓库操作的现形）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的
静态自查。

## 任务

- **RFC-612-T1 缓存仓库操作**：原样迁入 infrastructure，组合层文件删去，模块根转出改取 infrastructure（design §1）。
- **RFC-612-T2 URL 导入**：选择迁入 `infrastructure/repositoryUrlImport.ts`，`composeRepositoryGroups` 改调它（design §1）。
- **RFC-612-T3 门与文档**：计数 6 → 4；新增 RFC-612 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 S10 注记（design §2）。
- **RFC-612-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-612-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 组合层没有这两份实现，模块根转出不变
- [x] AC-2 行为不变
- [x] AC-3 计数 6 → 4；新增 RFC-612 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿（后继证据，见下）

## 集中验证

基于 `b90d7ee7c`（另一会话的 RFC-611 落地之后）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径的传递闭包与名字选出，再加上 `tests/architecture/` 全部、读 guard-manifest / 计数 / `STATE.md` / RFC 文档
  的用例与遍历 source-control 目录的扫描，共 559 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：4 种都被认出。
  - 仓库组的装配里放回一个分支、把缓存仓库操作放回组合层：RFC-612 用例与 `rfc376-structural-guards` 同时红（计数超过 max 4）。
  - 远端登记误走本机克隆、单机只在构造时读一次克隆预算：RFC-612 用例红。
- **架构报告**（候选对照干净的 `b90d7ee7c`）：`composition-control-flow-source-control` 6 → 4，生产文件净多 1 个（删一增二），符号从 composition
  移到 infrastructure；其余有门禁的计数不变。

## CI（AC-4）

- `1d4faeac5`（实现）：exact SHA 主 CI run 45799714886 结论 failure，红在 shard 41 一格：RFC-401 epoch-2 历史行桥的用例 5,387 ms 超过 5 秒上限
  （它对每个 epoch-2 历史版本建一座桥，RFC-602 的 `c37b675ff` 把版本从 3 个加到 13 个之后在 CI 上贴着上限跑，RFC-607 / RFC-610 的 run 里同一条也超时过）。
  与本 RFC 无关、未重跑。Windows 平台 run 45799714923 与快速反馈 run 45799715276 全绿。后继证据：包含本提交的 `6c92e2be2`（RFC-615）run 45846353277 第 2 次尝试 70 / 70 全绿（第 1 次尝试只有 macOS e2e 3/4 一格在 36 分钟后被取消、日志已不可取，没有失败的用例作业）。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **缓存仓库操作**：原样迁移，只改两条 import 的相对路径；刷新、删除、批量导入与重试的行为不变，模块根照旧转出同名函数与设置类型。
2. **URL 导入**：远端登记照旧走 `register`、返回登记的 id；单机照旧克隆（或复用）镜像，每次写入读一次克隆预算（预算为假值时用缓存默认）。按登记方式
   在构造时选一次，与此前每次写入检查等价（登记方式在装配时就已固定）。
3. **调用方**：bootstrap 与用例都经模块根取这几个名字，import 不变。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
