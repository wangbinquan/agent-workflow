# RFC-560 knowledge-evolution 的 fusion 引擎任务端口经 required-ports 交给 task-execution（RFC-294 S9 第十五步）

- **状态**：Done（2026-11-23，落地 `c640d1132`）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2 / §3 / §3.5（consumer-owned required SPI 在 consumer 的
  `composition/required-ports.ts`，只由 bootstrap 与指定 provider adapter 取）与 design §14“DAG 外的 offered 边 → 0”；做法同
  [RFC-556](../RFC-556-provider-ports-through-designated-adapters/proposal.md)。

## 1. 背景

fusion 引擎任务端口（`FusionEngineTaskOperations` 及其启动命令、任务记录）是 knowledge-evolution 向 task-execution 要的启动面——consumer 是
knowledge-evolution，实现方是 task-execution。它却声明在 knowledge-evolution 的 `public/participants.ts`，task-execution 的两个文件从那里取，构成
DAG 外 offered 边（35 条中的 2 条；目标 DAG 只有 knowledge-evolution → task-execution 的 offered 边）。

## 2. 目标

- **G1**：端口挪进 knowledge-evolution 的 `application/ports/fusionEngineTasks.ts`，经新增的 `composition/required-ports.ts` 交出实现方要的两个类型
  （启动命令与操作端口）；knowledge-evolution 自己的使用方改从定义处取。
- **G2**：task-execution 新增指定 adapter `application/adapters/knowledge-evolution-adapter.ts` 按类型转出它们；两个实现文件改从 adapter 取。
- **G3**：目标 DAG 与 RFC-294 design §3.1 的 Mermaid 同批登记虚线边 task-execution implements `FusionEngineTaskOperations` → knowledge-evolution。
- **G4**：DAG 外 offered 边 35 → 33；随之失去外部消费方的 fusion 值类型撤出 public——端口专属的种子树与提案结果
  挪进端口文件，树文件与结果清单挪进 domain，空出来的 `public/types.ts` 删除（未消费的 public 符号保持 0）。
- **G5 结局不变**：同一个实现、同样的装配，fusion 任务的启动、读取、收集、释放与取消不变。

## 3. 非目标

- 其余 DAG 外 offered 边；knowledge-evolution 的技能回滚成员关系协调（仍在 `public/participants.ts`）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：task-execution 取 knowledge-evolution 的只剩指定 adapter 按类型取 required-ports；端口归 knowledge-evolution 的 application/ports。
- **AC-2**：行为与装配不变。
- **AC-3**：目标 DAG 与 design 的 Mermaid 同批登记新虚线边；DAG 外 offered 边减 2，精确清单、`counts.json`、design 边总数与 `rfc317` 的开放 Record 账
  随之更新；失去消费方的 fusion 值类型撤出 public；新增 RFC-560 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
