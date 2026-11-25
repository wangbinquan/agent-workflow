# RFC-599 实施计划

依赖：RFC-598。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-599-T1 装配入参**：两个装配的三个效果选择必填（design §1）。
- **RFC-599-T2 用例**：9 个用例文件里没给的调用点显式给本机实现（design §1）。
- **RFC-599-T3 门与文档**：新增 RFC-599 用例并登记（design §2）。
- **RFC-599-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-599-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 两个装配入参的效果选择必填；装配不按“给没给”分支
- [x] AC-2 daemon 装配不变；用例显式给本机实现，行为不变
- [x] AC-3 计数都不升；新增 RFC-599 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `e98136958`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含 RFC-599 用例的编译期断言与 11 个调用点）；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**（候选导出，含本 RFC 的 RFC 索引、`STATE.md` 与 RFC-294 plan 条目）：按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` /
  RFC 文档 / RFC-294 的全部用例与遍历 development-automation 目录的扫描，共 503 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红；主树里 10 / 10）；
  读 STATE / RFC 索引 / RFC 文档的 7 个文件在主树 46 / 46。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：三种都被认出——员工工作区装配的自动化效果改回可选、平台工作项装配对基线效果加回本机回落（两种都是 RFC-599
  用例红）；用例给出不完整的自动化效果（`rfc310-employee-workspace-delivery` 红 2 条：装配照旧核对给它的选择）。另做一种类型检查变异（平台工作项的
  `repositoryBaselines` 改回可选）：`tsc` 在 RFC-599 用例的编译期断言处报错。复原后导出无残留。
- **架构报告**（候选对照 `e98136958`）：除来源与时间外完全相同（60 个计数、public 面、类型偏差、跨 context import 都不变）。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **生产装配不变**：daemon 本来就给两个装配的效果选择（部署选择里的自动化效果与基线效果）；装配的函数体一字未改，照旧核对后交给用例。
2. **用例**：显式给的本机实现与此前 `select*` 的回落相同（自动化效果 `createFileAutomationWorkspaceEffectsFactory()`、基线效果
   `createFileRepositoryBaselineEffectsFactory()`）；此前每次读基线都新建一份无状态的本机基线效果，现在一个用例共用一份，与 daemon 的做法相同。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
