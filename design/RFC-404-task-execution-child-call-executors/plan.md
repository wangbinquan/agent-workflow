# RFC-404 实施计划

**前置**：RFC-403 实现提交 `2874dd182`。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；不在实施中途做
功能验证。

## 任务

| 编号 | 内容 | 依据 |
| --- | --- | --- |
| RFC-404-T1 | 窄合同与共享实现：`application/ports/childCallNodeExecution.ts`；`domain/isoSubmodules.ts`（`W`、`executionMergeRecovery.ts` 改指）；`resourceLimitUsage.ts` 补 `encodeCallHumanWait`；`application/childCallErrors.ts` | design §1.2、§2 |
| RFC-404-T2 | 共享主体迁入 `engine/node/shared/child-call/`：`runChildCallNode.ts`（含 `failCallRow`）、`launchChildCall.ts`、`childCallWatch.ts`；门、领养、发起、等待、终态、输出与合并的顺序、错误码与消息文本不变 | design §1.1、§3 |
| RFC-404-T3 | 绑定 `composition/childCallNodeExecution.ts`：`buildChildRuntime`、`delegatedCallActor` 与 NULL owner 投影迁入；闭包改从 `infrastructure/legacyCallClosure.ts` 取；领养后 iso 重建顺序原样封装 | design §1.2 |
| RFC-404-T4 | 两个执行器 `engine/node/{call-workflow,call-workgroup}/`；`E` 以显式端口直接构造；删除 `engine/node/childCallNodeExecutors.ts` 与 `N` 中 calls 主体和 helper | design §1.1 |
| RFC-404-T5 | 守卫与用例：新结构锁 `rfc404-child-call-executors`（含负例）、端口绑定用例、共享实现用例；design §4 所列守卫改指；RFC-317 偏离账本与新站点用例、RFC-376 setInterval 账本；Windows 两份 `paths:` 与 suite；账本只准备改法，按 T6 实测填值 | design §4、§5 |
| RFC-404-T6 | 集中验证：静态检查、后端全量（含根目录守卫）、相关两 provider 用例、P0 变异 lane；按实测更新账本；实现门（本会话自审，只审功能）；推送后跟 CI | design §3 |

## 冲突面

- `TE/composition/{nodeMechanics,nodeExecution,wrapperMechanics,executionMergeRecovery}.ts`、`TE/engine/node/*`、`TE/domain/resourceLimitUsage.ts`；
- 守卫与账本：见 design §4。

并发会话 RFC-398 当前的改动面（epoch migration / auto-upgrade、`platform/persistence/**`、`modules/system-operations/**`、
`application/buildNodeRunMintRecord.ts`、`collaboration/infrastructure/review.ts` 等）与本 RFC 没有必需的同文件交集；实施前与提交前按路径
核对工作树。

## 验收清单

- [ ] proposal AC-1～AC-5
- [ ] 推送后 exact SHA 的 CI 全绿（AC-6）
