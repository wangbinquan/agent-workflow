# RFC-402 实施计划

**前置**：RFC-400 Done。由 Codex 实施、本会话审核。全部实现与用例完成后集中验证一次；两部分分两次派发只是为了让单次实施的范围可控，
派发之间不做功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-402-T1 | 窄合同：`application/ports/executionKernel.ts`、`taskExecutionPermits.ts`；`platform/contracts/isolationWorkspace.ts` 抽出中立 DTO（只有一份定义） | design §1.1 |
| RFC-402-T2 | kernel 主体：assembly、isolation、merge、isolationCleanup、isolationEffectRequest、nodeRunLedger；kernel 不依赖 services / composition / infrastructure / platform 物理实现 | design §1.1 |
| RFC-402-T3 | 许可注册表 `createExecutionPermitRegistry()` 与工作区会话 `infrastructure/executionWorkspaceSession.ts`；bootstrap 按 daemon scope 构造一次并注入所有消费者；全部生产与测试 import 改指；删除七个 `services/` 文件与旧实现路径，TE public 收回隔离转导出，不留 facade | design §1.2、§1.3 |
| RFC-402-T4 | 共享 helper 归位：`application/nodeInputs.ts`、`engine/node/shared/resolveMergeConflicts.ts`、`infrastructure/nodeStatusEvents.ts`、诊断 adapter、ledger 绑定；node / wrapper / 合并恢复共用同一实现 | design §2.3 |
| RFC-402-T5 | script 试点：`engine/node/script/` 四个文件与 `application/ports/scriptNodeExecution.ts`；registry 绑定显式端口；删除旧 executor 与 `runScriptWithFamily` | design §2.1、§2.2 |
| RFC-402-T6 | 守卫与用例：新结构锁 `rfc402-task-execution-kernel`（含负例）、`rfc334-node-executor-boundary` 递归与嵌套负例、RFC-328 / 284 / 287 / 317 / 395 锁改指、许可注册表行为用例；账本只准备改法，按 T7 实测填值 | design §4、§5 |
| RFC-402-T7 | 集中验证：后端全量（含根目录守卫）、script 执行矩阵、隔离 / replay / 恢复、P0 变异 lane、编译版 worker 与二进制相关用例；按实测更新账本；实现门（只审功能）；推送后跟 CI | design §3 |

**派发**：第一次 T1～T3（Part A），第二次 T4～T6（Part B 与守卫收口），同一可写线程；T7 由本会话执行。

## 冲突面

- `TE/composition/nodeMechanics.ts`、`wrapperMechanics.ts`、`executionMergeRecovery.ts`、`nodeExecution.ts`、`taskEngineApplication.ts`；
- `TE/public/participants.ts`、`TE/composition.ts`；collaboration 的 `taskQuestions.ts`、`taskQuestionDispatch.ts`、`clarify/autoDispatch.ts`、
  `gateWorkspaceRollbackExecutor.ts`；`services/task.ts`、`taskDelete.ts`、`commitPushRunner.ts`、`codeHost/*`；
- `bootstrap/daemonHttpComposition.ts`、`bootstrap/daemonModules/taskExecution.ts`、`bootstrap/crossContextClosure.ts`；
- `platform/workspace/local/isolation.ts`（只改为 import 抽出的 DTO 定义）；
- 守卫与账本：见 design §4。

并发会话 RFC-398 的改动面（`main.ts`、`bootstrap/daemonStart.ts`、`bootstrap/epochMigration*`、`bootstrap/autoUpgradeChild.ts`、`platform/persistence/*`、
`modules/system-operations/**`、`scripts/release-upgrade/**`、`cli/epochMigration.ts`）与本 RFC 没有必需的同文件交集；实施前与提交前按路径核对工作树。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
