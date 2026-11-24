# RFC-556 实施计划

依赖：RFC-555。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-556-T1**：两个 required-ports 交出端口类型；三个指定 adapter 转出或声明 provider 用的类型，四个 provider 文件改从 adapter 取；删去
  `webhookDispatch.ts` 的死转出；目标 DAG 与 design 的 Mermaid 同批登记两条虚线边（design §1）。
- **RFC-556-T2 门与用例**：精确清单、`rfc328` 债务、`counts.json`、design 边总数与 `rfc423` 归属随之更新；新增 RFC-556 用例并登记 guard-manifest。
- **RFC-556-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-556-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 四个 provider 文件不再取 consumer 的内部；指定 adapter 是唯一取 consumer required-ports 的文件，且只按类型
- [x] AC-2 行为与装配不变
- [x] AC-3 目标 DAG 与 Mermaid 同批登记；跨 context 内部文件对 14 → 10；各清单与减速带随之更新；新增 RFC-556 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `2263968b9` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷两处（已修复并复验）**：① `webhookDispatch.ts` 那条同名类型转出并非没有读者——测试助手 `tests/helpers/webhookTaskExecution.ts` 取它
  （调研时搜索结果被截断，漏看了这一行），`tsc` 报错；助手改从 required-ports 取，三件套随之更正。② RFC-556 用例里一条源码断言的正则只认
  `type TaskCatalogSource,`，而 `taskExecutionCatalogSources.ts` 是整条 `import type { … }`，选集运行里红；改成按 AST 读该 import 的名字后，
  RFC-556 用例与 `rfc317-guard-corpus-floor` 合跑 30 / 30。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 19 个 TS 文件（11 个生产文件、8 个用例、助手与架构
  文件）无告警，生产文件另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过（RFC-294 design 只按精确替换加两行）。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 253 个（经夹具与测试助手补 13 个），252 个通过；
  红的一个即上面 ② 的断言，修复只动了这个用例文件，其余结果沿用。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：五种变异各自让 RFC-556 用例红，另有一个既有门同时红——目录源文件重新直取
  task-catalog 的 required-ports、触发器重新取 integration 的 application/ports、运行时档案参与者重新取 runtime-management 的 application/ports、
  resource-catalog 的非 adapter 文件按类型取 required-ports（这四种 `rfc376-structural-guards` 同红）、目标 DAG 删去 webhook 参与者那条边
  （`rfc294-design-parity` 同红）。
- **架构报告**（候选与对照各出一份）：`cross-context-internal-file-pairs` 14 → 10；`targetEdges` 106 → 108；生产文件 +1（task-execution 的
  integration adapter）；其余门与计数不变。原先四条 `temporary-internal-debt` 边消失，新增的 adapter 边记为 `required-implementation`。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：四个 provider 文件只换了类型的取处（同一个端口类型经 adapter 转出或声明），实现代码、bootstrap 与 composition 的装配都没动；
  `TaskExecutionTriggerParticipant` 的实例化参数与原先相同。
- **一处交出**：integration 的 webhook 参与者端口只经 required-ports 交出；删去的分发装配转出在生产代码里没有读者，唯一的测试读者已改取。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交，RFC-554 / RFC-555 的 CI 仍在等 runner，它们的转 Done 随下一个 RFC 的提交。走
私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
