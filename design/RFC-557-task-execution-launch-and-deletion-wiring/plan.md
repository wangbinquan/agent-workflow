# RFC-557 实施计划

依赖：RFC-556。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-557-T1**：工作组启动资源面迁入 resource-catalog（实现、composition、指定 adapter、task-execution 的 required-ports 交出端口），bootstrap 与用例改取；
  删除选择收参，standalone bootstrap 交 git 参与者，用例改走测试助手；目标 DAG 与 design 的 Mermaid 同批登记虚线边（design §1）。
- **RFC-557-T2 门与用例**：精确清单、`rfc328` 债务、`counts.json`、design 边总数与读旧路径的用例随之更新；新增 RFC-557 用例并登记 guard-manifest。
- **RFC-557-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-557-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 task-execution 不再取 resource-catalog 与 source-control 的非 public 文件（指定 adapter 按类型取 required-ports 除外）
- [x] AC-2 行为与装配结局不变
- [x] AC-3 目标 DAG 与 Mermaid 同批登记；跨 context 内部文件对 10 → 7；各清单、减速带与读旧路径的用例随之更新；新增 RFC-557 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `e11512bb1` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷一处（已修复并复验）**：`rfc328-architecture-guards` 的 provider-bridge 债务集合在 RFC-556 与本 RFC 之后清空，`new Set([])` 推成
  `Set<never>`，`tsc` 在 `.has(bridge)` 处报错；显式写成 `new Set<string>` 并注明已到目标态（空集），`tsc` 0 错。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 31 个 TS 文件（9 个生产文件、22 个用例与测试助手）
  无告警，生产文件另过 promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过（RFC-294 design 只按精确替换加一行）。
- **实测前提**：task-execution 全部源码取 resource-catalog / source-control 非 public 文件的，改动后只剩两个指定 adapter 取它们的 required-ports。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 599 个（语义层 295、经夹具与测试助手补 304——删除
  效果与工作组启动资源面都经共用测试助手），全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：五种变异各自让 RFC-557 用例红——task-execution 的文件重新取 resource-catalog 的
  `composition/resourceAcl`（`rfc376-structural-guards` 与 `rfc328-architecture-guards` 同红）、工作组启动资源面回到 task-execution、本地删除效果重新
  取 source-control 的 composition（`rfc376-structural-guards` 同红）、目标 DAG 删去这条边（`rfc294-design-parity` 同红）、standalone bootstrap 不再
  交 git 参与者。
- **架构报告**（候选与对照各出一份）：`cross-context-internal-file-pairs` 10 → 7；`targetEdges` 108 → 109；生产文件 +1（resource-catalog 的
  task-execution adapter）；变更入口随文件改到 resource-catalog 的路径（控制项不变）；resource-catalog 两个 public 面少了这个文件的消费边（各自仍有
  别的消费方，未消费的 public 符号仍为 0）；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：工作组启动资源面逐字迁移（读工作组行、按 ACL 判可见、名册成员存在性检查与 integrity 透传都不变），bootstrap 交给 task-execution 的仍是
  同一个对象；standalone 的删除效果仍是本地运行文件加 git 工作区 / 快照引用，只是 git 参与者由 bootstrap 交入。
- **测试助手**：`composeStandaloneTaskDeletionEffects()` 组合的就是 standalone bootstrap 交的那一对，原先 30 处调用点只改名。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-554～556 的 CI 仍在等 runner，它们的转 Done 随下一个 RFC 的提交。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
