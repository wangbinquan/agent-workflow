# RFC-553 实施计划

依赖：RFC-552。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-553-T1 合同**：task-execution `public/types` 交出 `DirectTaskInitiator`，composition 转出投影函数（design §1）。
- **RFC-553-T2 改取**：融合编排改取 public 类型；融合路由多 `directTaskInitiator` 依赖并改调；bootstrap 绑定。
- **RFC-553-T3 门与用例**：两份精确清单、模块分层违规清单与 `counts.json` 降低；新增 RFC-553 用例并登记 guard-manifest。
- **RFC-553-T4 集中验证**：backend `tsc`、eslint（含 promises）、prettier；读已提交源码的用例在候选导出里跑；选用例；架构报告对照；变异验证。
- **RFC-553-T5 实现门**（本会话自审，只审功能）与收口文档；RFC-294 plan 记 S9 第九步。

## 验收清单

- [x] AC-1 knowledge-evolution 不再 import task-execution 的 domain / inbound；类型经 `public/types`，投影经路由依赖交入
- [x] AC-2 融合任务的启动人与原先相同
- [x] AC-3 跨 context 内部文件对 17 → 15、模块分层违规 1 → 0；清单与减速带随之更新；新增 RFC-553 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

本机 Docker 仍未起（本地没有 PostgreSQL）：本地只跑 SQLite 一支，PostgreSQL 一支以 exact SHA CI 的真实 PostgreSQL 分片为准。用例在主树里跑（工作树里
只有本 RFC 的改动，共享 index 为空）；读已提交源码的用例、架构报告与变异在候选导出仓库里跑（HEAD `f9c709afa` 加本 RFC 的路径，用本地提交固化，
核对与工作树逐字相同），对照是同一 HEAD 的另一份导出。集中验证查出四处本人缺陷，已改并复验。

- **静态**（最终的树）：backend `tsc` 退出码 0、无输出；eslint `--max-warnings 0`：改动的 11 个 TS 文件（5 个生产文件、6 个用例）无告警，生产文件另过
  promises 配置；prettier：改动的代码、两个 architecture 清单与三件套通过。
- **选择与语义层**（SQLite；60 秒；主树 5 个 worker）：按 RFC-533 的口径与 RFC-550 的选法选出 1162 个（语义层 588；task-execution 的 composition 与
  `public/types` 被大量测试助手取用，经夹具与测试助手补 574 个），1156 个通过。红的六个都是**本人遗漏**：新用例的文件名里没有守卫关键词，
  guard-manifest 的三条两向对账看不见它（改名为 `…-boundary.test.ts`）；新用例的语料下限 30 高于 knowledge-evolution 的实际文件数 27（改为 20，
  guard-manifest 同步）；`rfc390` 钉着融合路由依赖的成员清单、`rfc301` 钉着投影函数的调用分布（融合路由两处），随改为多 `directTaskInitiator`
  与 bootstrap 一处。改后这四个用例与读 guard-manifest 的全部用例文件（共 24 个）复跑全部通过。
- **读已提交源码的用例**（候选导出，HEAD 即候选）：`rfc376-report` 16 / 16、`rfc376-structural-guards` 221 / 221。
- **变异验证**（候选导出仓库里，复原后与工作树逐字相同）：五种变异各自让 RFC-553 用例红——融合路由重新 import task-execution 的 inbound
  （`rfc376-structural-guards` 的分层与文件对计数同时红）、融合编排改回从 domain 取类型、bootstrap 绑定别的投影、融合路由改回自己调投影、投影把
  session 映成 api。
- **架构报告**（候选与对照各出一份）：跨 context 内部文件对 17 → 15、模块分层违规 1 → 0；public 面多 1 个（`DirectTaskInitiator`）；未消费 public
  符号仍为 0；其余门与计数不变。
- **收口文档**：plan 与 `STATE.md` 定稿后，在工作树里重跑读这几处文档与 RFC 索引的用例文件，见提交说明。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。逐项与 HEAD 比对，结论 PASS：

- **结局不变**：融合路由的两处启动人原先是 `directTaskInitiatorFromActorSource(actor.source)`，现在是 `deps.directTaskInitiator(actor)`，bootstrap 把它
  绑成同一个函数作用于同一个 `actor.source`，所以创建与驳回融合时记下的启动人与原先相同；投影函数本身与 task-execution 根启动的绑定不动。
- **装配**：依赖字段必填，漏传由 `tsc` 认出；bootstrap 只多一行绑定，取 task-execution composition 的转出。
- **分层**：knowledge-evolution 取 task-execution 只经 `public/types`；投影仍只在 task-execution 的 inbound 观察认证来源（RFC-301）。

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（与 RFC-552 转 Done 同一提交）；实现与验证后再提交
`refactor(backend): RFC-553 knowledge-evolution 不再取 task-execution 的内部（RFC-294 S9 第九步）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
