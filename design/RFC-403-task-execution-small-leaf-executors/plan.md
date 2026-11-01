# RFC-403 实施计划

**前置**：RFC-402 Done。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；不在实施中途做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-403-T1 | 窄合同与共享支撑：`codeHostNodeExecution.ts`、`virtualIoNodeExecution.ts`（input / output 分开）、`humanGateNodeExecution.ts`（COL 合同集中派生）、中立 `nodeExecutionSupport.ts`（状态事件 / 诊断，script 改指）；复用 `NodeStepRequest` / `NodeStepOutcome` 与具名 ledger | design §1、§2 |
| RFC-403-T2 | code-host 主体迁入 `engine/node/code-host-call/`：完整决策流程、恢复循环、输出与终态顺序与原错误码；绑定 transport / project / probe / effect | design §1.1、§3 |
| RFC-403-T3 | input / output 主体迁入；`readPortRowAtFrame` 归 `application/nodeInputs.ts`，`W` 只改 import；`pickString` 归 `domain/nodeFields.ts` | design §1.1、§2 |
| RFC-403-T4 | review / clarify / clarify-cross-agent 的 task 侧主体迁入；分支判定 / 跳过归 `application/nodeBranchActivation.ts`，gateway 经端口调用；`CollaborationNodeGatePort` 只留 `openAgentClarify` | design §1.1、§2、§3 |
| RFC-403-T5 | `E` 以显式端口直接构造六个新执行器；删除旧委托壳文件与 `N` 中六个主体；剩余 calls / agent / host、`W`、`executionMergeRecovery.ts` 改指真实 owner | design §1.1 |
| RFC-403-T6 | 守卫与用例：新结构锁 `rfc403-small-leaf-executors`（含负例）、RFC-328 code-host 站点识别与转发负例、RFC-317 / 334 / 287 / 292 / 395 / 370 / 376 / 294 改指、Windows 两份 `paths:` 与 suite、端口绑定用例；账本只准备改法，按 T7 实测填值 | design §4、§5 |
| RFC-403-T7 | 集中验证：静态检查、后端全量（含根目录守卫）、相关两 provider 矩阵、P0 变异 lane；按实测更新账本；实现门（只审功能）；推送后跟 CI | design §3 |

**派发**：T1～T6 一次派发给同一可写线程（主体合计约 800 行，守卫改动集中）；T7 由本会话执行。

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,wrapperMechanics,executionMergeRecovery}.ts`、`TE/engine/node/*`、
  `TE/application/ports/{collaborationNodeGate,scriptNodeExecution}.ts`；
- 守卫与账本：见 design §4。

并发会话 RFC-398 的改动面（epoch migration / auto-upgrade、`platform/persistence/**`、`modules/system-operations/**`、`main.ts`、
`bootstrap/{daemonStart,epochMigration*,autoUpgradeChild,migrate}.ts`、`cli/epochMigration.ts`）与本 RFC 没有必需的同文件交集；实施前与
提交前按路径核对工作树。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
