# RFC-608 实施计划

依赖：RFC-600（工作区效果必填）。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-608-T1 选择迁入 infrastructure**：`repositoryFactsScanFor`；composition 改调，删去 `composition/repositoryFactsScanner.ts`（design §1）。
- **RFC-608-T2 门与文档**：钉住的调用名随之改；新增 RFC-608 用例并登记；计数 1 → 0；RFC 索引、`STATE.md`、RFC-294 plan 的 S10 注记（design §2）。
- **RFC-608-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-608-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 选择在 infrastructure，composition 无分支，`repositoryFactsScanner.ts` 删去
- [x] AC-2 `composition-control-flow-development-automation` 为 0，max 降到 0；新增 RFC-608 用例并登记
- [x] AC-3 受影响用例全部通过；exact SHA CI 全绿（后继证据，见下）

## 集中验证

基于 `e7fae1424`（RFC-607）；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS 与 RFC 文档 prettier 通过。
- **选出的用例**：在候选导出里，按改动路径与名字选出，再加上读 guard-manifest / 计数 / `STATE.md` / RFC 文档的用例与遍历 development-automation
  目录的扫描，共 543 个用例文件，只有 `rfc321` 红（要 git 历史，导出里照例红）。
- **变异**（候选导出里逐个施加、跑指定用例、复原；复原后导出无残留）：3 种都被认出。
  - 把选择放回 composition：RFC-608 用例与 `rfc376-structural-guards` 红（计数 1 超过 max 0）。
  - 本机选择不给扫描、卷内扫描运行错的操作：RFC-608 用例红。
- **架构报告**（候选对照干净的 `e7fae1424`）：`composition-control-flow-development-automation` 1 → 0，生产文件少 1 个，函数从 composition 移到 infrastructure；
  其余相同。

## CI（AC-3）

- `a3def727e`（实现）：exact SHA 主 CI run 45781401766 结论 cancelled——shard 10 跑完 1,304 pass / 0 fail 后被作业时限取消，其余各格全绿；Windows 平台
  run 45781401707 全绿。与本 RFC 无关、未重跑。
- 后继证据：包含本提交的 `03008a73a`（RFC-546）run 45785450678 70 / 70 全绿。2026-11-26 转 Done。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：选择的两支与此前相同——本机仍在进程内扫描（此前经采集器的默认，现在由选择函数直接给出同一个
函数），托管仍经树操作在卷内运行 `repository-facts-scan`；采集器的签名与投影不变。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
