# RFC-560 实施计划

依赖：RFC-559。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-560-T1**：端口归位、required-ports、指定 adapter、值类型归 domain 与删去空的 public/types；目标 DAG 与 design 的 Mermaid 同批登记（design §1）。
- **RFC-560-T2 门与用例**：精确清单、`counts.json`、design 边总数与开放 Record 账随之更新；新增 RFC-560 用例并登记 guard-manifest。
- **RFC-560-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-560-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 task-execution 取 knowledge-evolution 的只剩指定 adapter；端口归 knowledge-evolution 的 application/ports
- [x] AC-2 行为与装配不变
- [x] AC-3 目标 DAG 与 Mermaid 同批登记；DAG 外 offered 边 35 → 33；各清单与减速带随之更新；值类型撤出 public；新增 RFC-560 用例并登记
- [x] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `83b179ac0` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。没有查出本人缺陷。

- **撤出顺序**（候选导出的架构报告逐层确认）：端口离开 `public/participants.ts` 后，`public/types` 的种子树与提案结果失去外部消费方，挪进端口
  文件；再跑一次，树文件与结果清单也失去了，挪进 `domain/fusionTree.ts`，空出来的 `public/types.ts` 删除；第三次报告未消费的 public 符号为 0。
- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 18 个 TS 文件（12 个生产文件、6 个用例与架构文件）无告警，
  生产文件另过 promises 配置；prettier：改动的代码、architecture 清单与三件套通过（RFC-294 design 只按精确替换加一行）。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 347 个（经夹具补 17 个），全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：四种变异各自让 RFC-560 用例红——实现文件重新取 knowledge-evolution 的 public
  （`rfc376-structural-guards` 与 `rfc294-review-offered-edge-dag` 同红）、装配文件改取 knowledge-evolution 的 application/ports（`rfc376-structural-guards`
  同红）、public 重新转出启动命令、目标 DAG 删去这条边（`rfc294-design-parity` 同红）。
- **架构报告**（候选与对照各出一份）：`off-dag-offered-file-context-pairs` 35 → 33；public 面 1025 → 1018（端口三个、值类型四个）；`targetEdges`
  109 → 110；生产文件 +3（新增四个、删去一个）；未消费的 public 符号仍为 0；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- `c640d1132`（实现，父提交是 `83b179ac0`）：exact SHA 主 CI run 45323075393 70 / 70 通过；同一提交触发的 windows-platform（run 45323075455）
  通过。

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：七个类型逐字挪动（端口三个进端口文件，种子树与提案结果进端口文件，树文件与结果清单进 domain），没有改任何字段；task-execution 的实现
  与 bootstrap 的装配都没动，fusion 任务的启动、读取、收集、释放与取消不变。
- **knowledge-evolution 的 public 剩余**：技能回滚成员关系协调照旧在 `public/participants.ts`。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交；RFC-555～559 的 CI 仍未跑完，它们的转 Done 随下一个 RFC 的提交。
走私有 index、按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
