# RFC-486 实施计划

**前置**：RFC-483（Done，`8f7463f57`，Done 文档 `f6a7fadea`）。由本会话实施（用户 2026-10-31 指示不再派 Codex）。全部实现与用例完成后
集中验证一次；不在实施中途做功能验证，开发期只做必要的读码与语法 / 类型静态自查。

## 任务

| 编号       | 内容                                                                                                                                                                                                                     | 依据      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| RFC-486-T1 | application 端口：工作区参与者三件与工作组资源投影、准入端口与准入请求、上传落地端口、`TaskLaunchGuard`；`public/types` 交出 `TaskLaunchGuard`，integration 的 `ProtectedMrLaunchGuard` 改为扩展它，`launchTask.ts` 改取 | design §2 |
| RFC-486-T2 | domain：工作组运行时配置的三个构建函数迁入 `domain/workgroupRuntimeConfig.ts`，`childExecutionLaunchOperations.ts` 改取                                                                                                  | design §2 |
| RFC-486-T3 | infrastructure：`rootTaskAdmission.ts`（准入事务、`projectLaunchedTask`、活跃成员查询、提交后发布）与 `taskAutomationReceipts.ts`；工作区参与者的实现方改取端口类型                                                      | design §2 |
| RFC-486-T4 | application/launch：根启动内核、两条启动臂、路由启动操作与启动参与者四个文件；删除 `infrastructure/taskRouteLaunchOperations.ts`                                                                                         | design §2 |
| RFC-486-T5 | composition：`providerRuntime.ts` 装配准入、上传落地、授权查询、上传上限与直接启动人；`composition/taskRouteLaunch.ts` 的转出改指新位置                                                                                  | design §2 |
| RFC-486-T6 | 账本与用例：表归属债两条改键并补后继身份；越 DAG 清单销一对；文本账本与读源码的用例改指新文件（断言意图不变）；helper 补传端口；新增 RFC-486 用例并登记 guard-manifest；`counts.json` 收紧                               | design §3 |
| RFC-486-T7 | 集中验证（静态、读源码文本的用例先行、受影响用例、全量 SQLite 与 PostgreSQL lane、架构报告对账）；实现门（本会话自审，只审功能）；提交、推送、跟 exact SHA CI；收尾                                                      | design §5 |

## 验收清单

- [ ] AC-1 `infrastructure/taskRouteLaunchOperations.ts` 删除；启动编排在 `application/launch/`，不 import `infrastructure/**`、不收裸 `db`
- [ ] AC-2 准入事务由一个 infrastructure 适配器实现，语句与次序不变；两条表归属债按后继身份改键，账本条数不变
- [ ] AC-3 越 DAG 的 offered 文件对 47 → 46；减速带不升、触及的收紧到实测；task-execution 的 public 只增 `TaskLaunchGuard`
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## 集中验证

（实施后补。）

## 实现门（本会话自审，只审功能）

（实施后补。）

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目（同时补 RFC-483 plan §CI 的后继证据）；实现与验证后再提交
`refactor(backend): RFC-486 任务启动用例归 task-execution 的 application（RFC-294 W4-E1 余项）`。走私有 index、按路径清单提交，在共享发布锁下
fetch / ff / push。推送后按 exact SHA 跟 CI。
