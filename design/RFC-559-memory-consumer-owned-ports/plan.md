# RFC-559 实施计划

依赖：RFC-558。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-559-T1**：三个 consumer 自有端口，九个文件改用；撤出失去消费方的 memory public 符号（design §1）。
- **RFC-559-T2 门与用例**：两份精确清单与 `counts.json` 降低；读撤出符号的用例随改；新增 RFC-559 用例并登记 guard-manifest。
- **RFC-559-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-559-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 task-execution 与 collaboration 的生产文件不再取 memory；三个端口由它们自己声明
- [x] AC-2 行为不变；memory 的对象满足端口由编译器检查
- [x] AC-3 DAG 外 offered 边 44 → 35；清单与减速带随之更新；失去消费方的 memory public 符号撤出；新增 RFC-559 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `aee8de63c` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。

- **本人缺陷两处（已修复并复验）**：① 调研时只按 `memoryDistillEnqueuer.enqueue` 搜调用点，漏了 clarify 自动分派里以别的变量名调的那一次
  （`sourceKind: 'clarify'`），`tsc` 报错；collaboration 的端口改为接受 `'feedback' | 'clarify'`。② bootstrap 的 task-execution 装配把 memory 的蒸馏命令
  按 collaboration 的参数类型标注，再交给 task-execution，端口收窄后两边不相容；改按 memory 自己的合同 `MemoryDistillEnqueuer` 标注（两边的端口都接受
  它）。两处修完 `tsc` 0 错。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 18 个 TS 文件（14 个生产文件、4 个用例、助手与架构文件）
  无告警，生产文件另过 promises 配置；prettier：改动的代码、architecture 清单与三件套通过。
- **撤出的 public 符号**：候选导出的架构报告里只有 memory 的 `ScopeBudget`（`public/types`）失去外部消费方——撤出，读它的测试助手改用
  task-execution 的 `TaskMemoryInjectionBudget`；注入查询仍经 memory 的 public 操作合同被消费，不动。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 531 个（语义层 388、经夹具与测试助手补 143），
  全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：四种变异各自让 RFC-559 用例红——agent 运行蒸馏观察者重新取 memory 的 public
  （`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 同红）、collaboration 的任务反馈重新取 memory 的 public（`rfc294-review-offered-edge-dag`
  同红）、注入端口取 memory 的 domain 类型、memory 的 public/types 重新转出 `ScopeBudget`（`rfc376-structural-guards` 的未消费计数同红）。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 44 → 35；public 面 1026 → 1025（`ScopeBudget`）；生产文件 +3（三个端口）；
  未消费的 public 符号仍为 0；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `83b179ac0`（实现，父提交是 `aee8de63c`）：exact SHA 主 CI run 45320530953 70 / 70 通过；同一提交触发的 windows-platform（run 45320530877）与
  integration-opencode（run 45320530873）通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：九个文件只换了类型的出处；bootstrap 交给 task-execution 与 collaboration 的仍是 memory 的注入查询与蒸馏命令本身，记忆注入、首轮快照、
  agent 运行蒸馏、任务反馈与 clarify 自轮蒸馏的调用一字未动。
- **端口覆盖面**：注入端口含 task-execution 用到的两个方法；collaboration 的蒸馏端口覆盖它的两种来源（任务反馈、clarify 自轮）；task-execution 的蒸馏
  端口覆盖 agent 运行。三者的入参都是 memory 合同的子集、返回是其超集，编译器在交接处与用例里检查。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-554 的转 Done 同批；RFC-555～558 的 CI 仍未跑完，它们的转 Done 随下一个 RFC 的提交。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
