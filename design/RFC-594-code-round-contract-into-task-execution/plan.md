# RFC-594 实施计划

依赖：RFC-593。按 CLAUDE.md 文首硬规则：先完成全部实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-594-T1 迁移**：`CODE_ROUND_NODE_ID` 进 `TE/domain/codeRoundHistory.ts`，合成函数与输入类型进 `T/helpers/codeRoundHistory.ts`，删掉两个没有读者的导出与
  原文件（design §1）。
- **RFC-594-T2 门、用例与文档**：归属表、`counts.json`；新增 RFC-594 用例并登记（design §2）。
- **RFC-594-T3 集中验证**：backend `tsc`、eslint（含 promises）、prettier；选用例在候选导出里跑；架构报告对照；变异验证。
- **RFC-594-T4 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [x] AC-1 旧路径不存在、没有说明符再解析到它；节点 id 只在 task-execution 的 domain 里定义、值不变；合成函数逐字迁到测试 helper
- [x] AC-2 历史 code-round 的执行结果投影与内置快照布局的用例通过
- [x] AC-3 `legacy-service-implementations` 上限 2 → 1、`legacy-horizontal-files` 上限 54 → 53；其余计数不升；新增 RFC-594 用例并登记
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

基于 `f48df41c2`；本地只跑 SQLite，PostgreSQL 与 Windows 以 CI 为准。

- **静态**：backend `tsc` 0 错；eslint 与 promises 配置无告警；改动的 TS、RFC 文档与两个 JSON 账本 prettier 通过。
- **逐字比对**（脚本）：domain 文件里的节点 id（连同文档注释）、helper 里的输入类型与合成函数（连同文档注释）都与 HEAD 的 `services/codeRoundContract.ts`
  逐字相同。删掉的 `CODE_ROUND_SUMMARY_PORT`、`StartCodeRoundInput` 在 backend、shared、frontend 与脚本里都没有读者。
- **选出的用例**（候选导出）：按改动路径与迁动的名字选出，再加上架构报告、结构守卫、DAG、分层、依赖与读 guard-manifest 的全部用例，共 206 个用例文件、
  2003 条全部通过——含 `api-task-output-kind`（历史 round 的任务、节点与结果投影）与 `builtin-workflow-auto-layout`（内置快照布局覆盖每一种 host 形状）；
  `rfc321`（要 git 历史）在主树里 10 / 10；读 STATE / RFC 索引 / RFC 文档的用例 46 / 46。
- **顺带修正（本人缺陷）**：RFC-593 用例的文件头与一条用例标题还写着“4 个名字”，实际转出的是 2 个（RFC-593 集中验证里改了设计，措辞没跟上）；已改，
  断言本身不变。
- **变异**（候选导出里逐个施加、跑指定用例、复原）：五种都被认出——旧文件以一跳转出重新出现（RFC-594 用例与 `rfc376-structural-guards` 都红）；执行结果投影
  自己写一份节点 id；domain 文件多一条 import；生产代码重新声明合成函数；节点 id 的值被改（历史 node_runs 会对不上）。复原后导出无残留。
- **架构报告**（候选对照 `f48df41c2`）：60 个计数里只有两项变了、都在下降——`legacy-horizontal-files` 54 → 53、`legacy-service-implementations` 2 → 1；
  未消费 public 符号 0；public 面 804 不变；public 类型偏差 27 不变；跨 context import 7603 → 7602（task-execution 不再取 legacy 的 `services/`）。

## CI（AC-4）

- 【待补：实现提交】

## 实现门（本会话自审，只审功能）

按路径限定在本 RFC 的改动，只审功能。结论 PASS：

1. **值不变**：`CODE_ROUND_NODE_ID` 仍是 `'__code_round__'`，执行结果投影读的是同一个常量，历史 round 的输出照旧挂在这个节点上。
2. **夹具不变**：helper 里的合成函数逐字相同，两个用例造出的历史快照与原来一致；节点 id 从 domain 取，夹具与生产读取看同一个值。
3. **删除无读者**：两个导出在全部包里都没有读者，删掉不影响任何调用方。
4. **只改注释**：`digitalEmployeeHost.ts` 只改了顶注里的指针；RFC-294 plan 的 `services/` 余项表两行只做记账。

## PR / 提交

一个提交（单个 RFC 对应单个提交）：三件套、RFC 索引与 `STATE.md` 条目与实现、用例一起提交。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
