# RFC-614 实施计划

依赖：RFC-603、RFC-607。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-614-T1 拆入口**：`MissionCommandDeps`、必填的 `LaunchDeps.uploadAdmission`、`launchMissionWithoutUploads` 与共用的 launch 链（design §1）。
- **RFC-614-T2 调用方**：子任务委派与三个夹具改走不收上传的入口；“未接线”用例改写（design §1）。
- **RFC-614-T3 门与文档**：新增 RFC-614 用例并登记；RFC 索引、`STATE.md`、RFC-294 plan 的 W4-E8 注记（design §2）。
- **RFC-614-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-614-T5 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 端口必填，无缺席判断与旧阻断码
- [x] AC-2 委派走不收上传的入口，遇到上传即拒绝
- [x] AC-3 原用例照旧通过；新增 RFC-614 用例并登记
- [ ] AC-4 exact SHA CI 全绿

## 集中验证

基于 `0339842ab`（RFC-613）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错（含编译期断言；只读命令改收 `MissionCommandDeps` 后，别处的调用方都不必改）；eslint 与 promises 配置无告警；改动的 TS
  与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径的传递闭包与名字选出，再加上 `tests/architecture/` 全部、读 guard-manifest / 计数 / `STATE.md` / RFC 文档
  的用例与遍历 development-automation 目录的扫描，共 390 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：4 种都被认出。
  - 端口改回可选、子任务委派改回经收上传的入口：RFC-614 用例红。
  - launch 链里加回缺席判断、不收上传的入口不再拒绝上传：RFC-614 用例与 `rfc310-pr2-admission` 同时红。
- **架构报告**（候选对照干净的 `0339842ab`）：有门禁的计数都不变；`launchMission.ts` 多出两个导出与一个内部函数，只报告的 `mutationEntrypoints`
  随之多两条。

## CI（AC-4）

- `5c7a72129`（实现）：exact SHA 主 CI run 45814242489 结论 failure，红在 shard 28 一格：`rfc395-staging-page-cost` 的“page insertion equals sequential
  insertion …”6,105 ms 超过 5 秒上限（这份用例自 2026-10-26 起没改过，与 Mission launch 无关），未重跑。快速反馈 run 45814242606 全绿。后继证据待包含本提交的
  run 全绿。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **Mission 操作的 launch 不变**：它一直给 upload admission，launch 链照旧读上传会话、解析 baseline、放置；预览照旧。
2. **子任务委派不变**：它的输入从来不带上传，走同一条 launch 链；不收上传的入口只多了一条它走不到的拒绝。
3. **删去的阻断**：`upload-admission-not-wired` 只在生产上走不到的组合（带上传却没接 admission）下出现，共享合同与前台都不认它；
   `baseline-reader-not-wired`（数据状态）保留。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交（另把 RFC-546、RFC-607、RFC-608 转 Done 的文档一并带上）。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
