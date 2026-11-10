# RFC-478 实施计划

**前置**：RFC-477 落地（Done，`802a4033b`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后集中验证一次；
不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                          | 依据         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| RFC-478-T1 | domain：`domain/builtinWorkflowLayout.ts`；`domain/workflowSyncPreview.ts` 并入运行摘要与快照解析                                                                                                             | design §1    |
| RFC-478-T2 | 同步预览：`application/ports/workflowSyncPreviewReads.ts`、`application/workflowSyncPreviewQuery.ts`、`infrastructure/workflowSyncPreviewReads.ts`；回滚目标选择器并入 `application/resumeRollbackTargets.ts` | design §3    |
| RFC-478-T3 | 延后仓库准备：`infrastructure/deferredRepositoryPreparation.ts`；绑定必填并加 `groupCachedRepoIds`（task-execution 端口与 source-control 实现）；composition 装配                                             | design §2    |
| RFC-478-T4 | 任务详情读投影 `infrastructure/taskDetailRead.ts`；运行时选项 `composition/taskDriveRuntimeOptions.ts`；全部生产消费方改取                                                                                    | design §4–§5 |
| RFC-478-T5 | 测试专用出口进 `tests/helpers/`；`shutdownActiveTaskExecutions` 与 `services/task.ts` 删除                                                                                                                    | design §5    |
| RFC-478-T6 | public 收口（撤出失去模块外生产消费方的符号；用例改取定义处）                                                                                                                                                 | design §6    |
| RFC-478-T7 | 用例与账本：45 个 import 方、41 个源码守卫、新增 RFC-478 用例、`R1` 账本、owner 表、减速带（C13）、注释与文档链接                                                                                             | design §7    |
| RFC-478-T8 | 集中验证（含 shared / system-mocks / frontend）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                                                            | design §10   |

## 验收清单

- [ ] AC-1 `services/task.ts` 不在、零引用；`R1` 里没有它；测试专用出口只在 `tests/helpers/`
- [ ] AC-2 行为不变（延后仓库准备、同步预览、任务详情与失败码、运行时选项）
- [ ] AC-3 架构计数按实测（`R1` 27 → 18），越界、偏差与未消费 public 符号不升，新文件按内容分层；触及的减速带收紧到实测
- [ ] AC-4 受影响用例与新增用例全部通过（四个包）
- [ ] AC-5 exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（目录入库，索引链接不断）；实现与验证后再提交
`refactor(backend): RFC-478 services/task.ts 按内容分层归 task-execution（RFC-294 W9-D，task-execution 一族收尾）`。走私有 index、
按路径清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
