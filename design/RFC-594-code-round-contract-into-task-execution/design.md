# RFC-594 技术设计

记号：`S/` = `packages/backend/src/`，`TE/` = `S/modules/task-execution/`，`T/` = `packages/backend/tests/`。数字取 HEAD `f48df41c2`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：`CODE_ROUND_NODE_ID` 是历史 code-round 任务的快照事实，读者是 task-execution 的执行结果投影；它进
  `TE/domain/codeRoundHistory.ts`，与 `agentHostWorkflow.ts`（`AGENT_HOST_AGENT_NODE_ID`）、`digitalEmployeeHost.ts` 同层。domain 文件零 import，正是原文件
  顶注要的“叶子”（当年为了避开 `execution/outcome.ts → codeRoundLaunch.ts → task.ts → …` 的环）。
- **归属更正（偏离 W4-E8 的标注）**：RFC-294 plan 的 `services/` 余项表把原文件记在 W4-E8（development-automation）名下，架构报告的归属表同样记为
  development-automation——那是 RFC-304 写入方的归属。RFC-310 删掉写入方之后，development-automation 不再读它。按目标 DAG，task-execution 与
  development-automation 之间只有一条 required-implementation 边（task-execution 实现 development-automation 的 `AgentActionExecutionPort`），
  task-execution 不消费 development-automation；节点 id 若放进 development-automation，唯一的读者就要新增一条 DAG 外的边。所以归属随唯一读者落到
  task-execution（同 RFC-544 偏离 W4-E9 标注的处理）。W4-E8 的其余内容（能力模板写入与历史查询并入 development-automation、可选袋拆成端口）不受影响。
- **只有用例用的部分**：合成函数与输入类型移到 `T/helpers/codeRoundHistory.ts`（先例：RFC-491 把 `services/runtimeSmoke.ts` 移到 `tests/helpers/`）。两个用例
  拿它造历史 round 的快照：`builtin-workflow-auto-layout`（内置快照的布局覆盖每一种平台 host 形状）与 `api-task-output-kind`（历史 round 的任务、节点与结果投影）。
  迁过去的函数逐字保留，节点 id 从 domain 取，夹具与生产读取看的是同一个值。
- **删除**：`CODE_ROUND_SUMMARY_PORT` 与 `StartCodeRoundInput` 没有读者（写入方退役时漏删），直接删除。
- **偏离项**：只偏离 RFC-294 plan 的 W4-E8 标注（见上），不偏离目标架构与目标 DAG。

## 1. 改动

- 新建 `TE/domain/codeRoundHistory.ts`：`CODE_ROUND_NODE_ID` 与它的文档注释逐字迁入，文件头写明来历与历史兼容的用途。
- `TE/infrastructure/executionOutcome.ts` 改从 `../domain/codeRoundHistory` 取。
- 新建 `T/helpers/codeRoundHistory.ts`：`CodeRoundSnapshotInput` 与 `synthesizeCodeRoundSnapshot` 逐字迁入（含文档注释）。
- 两个用例改取 helper（节点 id 取 domain）。
- 删除 `S/services/codeRoundContract.ts`。
- `TE/domain/digitalEmployeeHost.ts` 顶注里“镜像 codeRoundContract”的指针改指新位置（只改注释）。

## 2. 门、用例与文档

- 归属表删 `services/codeRoundContract.ts` 一行；`counts.json` 的 `legacy-service-implementations` 2 → 1、`legacy-horizontal-files` 54 → 53。
- 新增 `T/rfc594-code-round-contract-into-task-execution-boundary.test.ts`，登记 guard-manifest：① 旧路径不存在，全部说明符不再解析到它（带负对照）；② 生产
  代码里 `'__code_round__'` 只在 `TE/domain/codeRoundHistory.ts` 出现一次，执行结果投影从那里取；③ domain 文件零 import；④ 生产代码里不再定义
  `synthesizeCodeRoundSnapshot`，也不再有 `CODE_ROUND_SUMMARY_PORT`、`StartCodeRoundInput`。

## 3. 失败模式

- **有人在 `services/` 下再放回合同叶**：用例 ① 与两项 legacy 计数红。
- **节点 id 在别处再定义一份**（例如夹具里写字面量、生产代码里抄一份）：用例 ② 红。

## 4. 对 RFC-294 刷新后规则的对账

- **C10**：历史事实进唯一读者的 domain；只有用例用的部分进 `tests/helpers/`。**C12**：RFC-594 用例 ① ② ④ 覆盖全部说明符与生产文件，③ 只读一个文件。
  **C13**：两项 legacy 计数各降 1。
- 本 RFC 之后 `services/` 只剩暂缓的 `repoCredentials.ts`。
