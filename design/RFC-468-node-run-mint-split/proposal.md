# RFC-468 拆分 nodeRunMint：冻结运行时归 runtime-management、铸行入口归 task-execution（RFC-294 W9-D 第十五步）

- **状态**：In Progress（2026-11-07）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.6 W9-D（`services/` 实现文件按 owner 归位）
- **前序**：[RFC-465](../RFC-465-session-capture-port-to-runtime-management/proposal.md)（端口由消费方拥有、实现方依赖消费方）；
  [RFC-454](../RFC-454-services-one-hop-facade-sweep/proposal.md)（遗留调用方改取 task-execution `public/operations` 的生命周期原子）；
  [RFC-467](../RFC-467-injection-oracle-relocation/proposal.md)。
- **落位**：runtime-management `application/ports/taskRuntimeFreezePersistence.ts`、`infrastructure/local/frozenTaskRuntime.ts`；task-execution
  `domain/clarifyRules.ts`、`infrastructure/legacyNodeRunMint.ts`、`public/operations.ts`。

## 1. 背景

`services/nodeRunMint.ts`（573 行）记 8 条 `R1`（全部取 task-execution 内部文件），是 `R1` 第二多的文件。它是四块拼在一起的：

1. **冻结运行时**：`FrozenRuntime`、`resolveFrozenRuntimeWith`、`frozenRuntimeOfSessionWith` 与三个解析函数、`configBackedBinary`。生产只有
   runtime-management 的任务运行时绑定（`infrastructure/local/taskAgentRuntimeBindings.ts`）在调；它取 task-execution 的
   `application/ports/nodeRunRuntimePersistence` 作参数类型——这是 runtime-management → task-execution 唯一的跨 context 内部文件对。
2. **铸行入口** `mintNodeRun`：生产只有 `services/task.ts` 的延迟仓库准备在调（铸合成的 `__repo_prep__` 行）；其余铸点早已走
   task-execution 自己的铸行程序。
3. **判定与转出**：`continuesClarifyLineage`（task-execution 组合层 `agentNodeExecution` 在用）；`nextRetryIndex` 与
   `isClarifyRerunCause` / `CLARIFY_RERUN_CAUSES` 的转出（定义分别在 task-execution 与 shared）；`schedulerMintCause` 的一份副本（生产用的是
   task-execution `application/resolveSchedulerRunRow.ts` 里那份私有函数，这份只剩一个用例在测）。
4. **零调用方**：`loadRunEnvelopeNonce`、`mintNodeRunWith`、`resolveSchedulerRunRow` 的旧包装与它的三个类型；只剩一个用例的
   `buildMintNodeRunValues`；`MintNodeRunArgs` 一族类型（task-execution 端口 `NodeRunMintInput` 的可变副本）。

## 2. 目标

- **G1 冻结运行时归 runtime-management**：原样迁入 `infrastructure/local/frozenTaskRuntime.ts`；它要的持久化由 runtime-management 自己拥有一个
  窄端口（`application/ports/taskRuntimeFreezePersistence.ts`，只含冻结算法实际调用的 `withSelection`——会话的 `load` / `select` / `freeze`——与
  `findBySessionId`），task-execution 现有的实现按结构满足它。runtime-management → task-execution 的跨 context 内部文件对随之消失。
- **G2 铸行入口归 task-execution**：`mintNodeRun` 迁入 `infrastructure/legacyNodeRunMint.ts`（参数改用端口的 `NodeRunMintInput`），经
  `public/operations` 转出给 `services/task.ts`（与它已在取的 `setNodeRunStatus` 同处）；`nextRetryIndex` 改取 `public/queries`。
- **G3 判定归位，副本与死代码删除**：`continuesClarifyLineage` 迁入 task-execution `domain/clarifyRules.ts`（与它所服务的
  `resolveEffectiveClarifyChannel` 同处）；两个澄清 cause 判定改取 shared；`schedulerMintCause` 只留生产那份（导出给用例）；零调用方的导出删除，
  `services/nodeRunMint.ts` 删除。
- **G4 账本下降**：`R1` 79 → 71；`services/` 68 → 67；跨 context 内部文件对 47 → 46；RFC-349 provider 切换债务清单销账一条；legacy 计数按实测
  下降；不新增 public surface 偏差、capability 归属条目、off-DAG 边与 `module-layer-violations`，未被消费的 public 符号不升。

## 3. 非目标

- `services/task.ts` 本身的去处（它的 9 条 `R1` 随后继 RFC）。
- task-execution 的 `NodeRunRuntimePersistence` 端口：task-execution 组合层与运行时参与者仍按它装配，不动。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/nodeRunMint.ts` 不在，src / 用例 / 脚本零 import；冻结运行时在 runtime-management，绑定与冻结算法只取 runtime-management
  自己的窄端口、零取 task-execution；`mintNodeRun` 经 task-execution `public/operations` 给 `services/task.ts`；`continuesClarifyLineage` 在
  `domain/clarifyRules.ts`；`schedulerMintCause` 只有一份。
- **AC-2**：架构计数按实测（`R1` 79 → 71，账本逐条相等；跨 context 内部文件对 47 → 46）；越界类计数、public surface 偏差与未被消费的 public
  符号不升。
- **AC-3**：受影响用例（铸行、冻结运行时与运行时绑定、澄清血缘与 rerun cause、延迟仓库准备、启动与执行宿主）与新增 RFC-468 用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿（环境性红格如实记录）。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **窄端口由 runtime-management 拥有，留在 `application/ports`、不经 public 导出**：冻结算法要一个事务内会话回调
   （`withSelection(nodeRunId, body)`），函数类型经 public 入口导出会多记一条 public surface 偏差；task-execution 的实现本来就满足这个形状，
   task-execution 组合层把它交给 runtime-management 的工厂时由编译器按结构检查，task-execution 不必反向 import。与 RFC-465 的区别：那个端口
   没有回调，经 `public/participants` 导出、由 task-execution 显式实现。
2. **铸行入口经 `public/operations`**：那里是 task-execution 留给遗留调用方的生命周期原子（`services/task.ts` 已在取 `setNodeRunStatus`），
   合同检查对 operations 只看文件名与导出形状（RFC-344）；不让 `services/task.ts` 为此多一条取 task-execution 内部的 `R1`。
3. **删除优于保留**：零调用方的导出与只剩用例的包装直接删除，用例改取定义处（`buildNodeRunMintRecord`、生产的 `schedulerMintCause`、shared
   的两个判定）。
