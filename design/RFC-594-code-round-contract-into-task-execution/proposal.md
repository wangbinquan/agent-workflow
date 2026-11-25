# RFC-594 code-round 的合同叶归 task-execution 的 domain（RFC-294 W9-D：`services/` 余项）

- **状态**：Done（2026-11-25，落地 `7dfc0423e`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话自行裁定落位（见
  design §0）；设计门免、不派 Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2（“`services/` 按 owner 迁入模块后删除”）与 §14 的
  终局判据“`services/` 下的业务实现 → 0”。

## 1. 背景

`services/` 只剩两个文件，`architecture/counts.json` 的 `legacy-service-implementations` 为 2。其中 `repoCredentials.ts` 是凭据一族，按既有约定暂缓；另一个是
`services/codeRoundContract.ts`（84 行）——RFC-304 为 code-round 写的合同叶：节点 id、摘要端口名、快照合成函数与启动输入类型。

RFC-310 PR-10 T104 已删掉 code-round 的写入方：新建 trigger 一律拒、存量 trigger 触发只记 `skipped-trigger-invalid`。`code-round` 只作为历史行的解码与读取兼容
留在 task-execution（RFC-294 归档设计：“decode/history compatibility row”）。这个文件因此只剩一个生产读者：task-execution 的执行结果投影
（`infrastructure/executionOutcome.ts`）用 `CODE_ROUND_NODE_ID` 找历史 round 的输出。快照合成函数只有两个用例在用（给历史 round 造夹具），摘要端口名与启动
输入类型没有任何读者。架构报告的归属表把它记在 development-automation 名下，那是 RFC-304 时写入方的归属；写入方退役之后，这个事实的读者只有 task-execution。

## 2. 目标

- **G1**：`CODE_ROUND_NODE_ID` 迁入 task-execution 的 `domain/codeRoundHistory.ts`，与 agent host（`domain/agentHostWorkflow.ts`）、digital-employee host
  （`domain/digitalEmployeeHost.ts`）的合同叶同层；执行结果投影从那里取。
- **G2**：只有用例在用的快照合成函数（连同它的输入类型）逐字迁到 `tests/helpers/codeRoundHistory.ts`，作为历史 round 的夹具；没有读者的摘要端口名与启动
  输入类型删除。`services/codeRoundContract.ts` 删除，不留转出。
- **G3**：`legacy-service-implementations` 2 → 1、`legacy-horizontal-files` 54 → 53；计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `services/repoCredentials.ts`（凭据一族，暂缓）。
- code-round 的历史读取本身（解码、列表、执行结果投影、退役执行器）——不动。

## 4. 能力影响清单

无：删掉的两个导出没有任何读者；合成函数在生产代码里没有调用方（写入方已由 RFC-310 删除）。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：`services/codeRoundContract.ts` 不存在，没有说明符再解析到它；`CODE_ROUND_NODE_ID` 只在 task-execution 的 domain 里定义，值不变；合成函数逐字
  迁到测试 helper，生产代码里不再有它。
- **AC-2**：历史 code-round 任务的执行结果投影与内置快照布局的用例通过。
- **AC-3**：`legacy-service-implementations` 上限 2 → 1、`legacy-horizontal-files` 上限 54 → 53；其余计数不升；新增 RFC-594 用例并登记。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
