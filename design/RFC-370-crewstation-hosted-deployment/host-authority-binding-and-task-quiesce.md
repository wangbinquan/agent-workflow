# RFC-370 执行权完整选择与 Task 停止派发切面

这是 H7 的实施增量，沿用已批准的 D1/D2。它补齐 SO 的完整装配选择和 Task 的 authority-loss 停止派发接口；三个实际 bootstrap、19 个 provider handles、SO 持久上下文与原 Task 事务的连接仍未完成，不关闭 H7、A-T7、A-G 或 RFC。没有 CS adapter，也没有 AW-in-CS 部署。

## 完整 binding

`system-operations/composition/hostExecutionAuthority.ts` 按 provider/generation 装配一个完整 authority、recovery、runtime 组合。显式 selected 必须提供完整 factory 和两组 owner family；缺少方法在 factory 创建与任何恢复效果前失败，不补 native。异步 factory 的实际创建 ACK 被等待，方法 receiver 保持；默认 native 返回继续同步，借用原 startup lease，不再次认领或提前释放 PID 锁。

binding 对外提供同一个生命周期、named admission 和 availability queries。子装配通过 `requireHostExecutionAuthorityBinding` 校验真实完整实例及 provider/generation，返回原实例。`resource-only` 保留原核心的零 claim、零恢复、零 runtime start 行为。

这层当前尚无实际 bootstrap 消费者。新增绑定回归覆盖两个 provider 标识、实际核心生命周期、异步 selected 创建 ACK、原 PID release 责任、资源模式、缺失 family 与错误 generation；使用可控 driver 证明装配合同，不作为 CS 平台验收。

## Task 专用停止派发

`TaskExecutionModule.quiesceAuthorityLoss()` 在首个 await 前关闭现有 claim gate，并等待已受理 claim/attach permits。它不调用 runtimeRegistry.abortAll，不取消、释放或改写已认领的 owner/intent，也不封死模块。原 pause、dispose、resume 的 native 业务政策保留。

provider background 的同名接口先同步关闭新 claim 和 loop dispatch，再等待原队列、各个 loop 与 startup read/recovery 的实际 ACK。五类 loop 在派发前检查状态；等待配置后的四条效果路径再次检查，迟到的 startup settings 不触发旧 auto-resume。已开始的 owner 工作仍按原责任 drain。

普通 provider pause/stop 继续使用原中止原因和原 drain。新的 loss 递增版本；已经排队的旧 resume 不能在较新 loss 之后重开 admission。后续由选定生命周期受理的新 resume 保持可恢复行为。

这个接口本身只排空 claim/attach 和本模块 loop/startup 工作。正在运行的任务及其 durable receipt、其他 owner 效果、原业务事务和整组 authority admission 的排空仍由完整 H7 接线承担，不能据此宣称已具备全安装交接。

## 验证与后续

新增双 provider 回归通过真实 intent/owner persistence 与 runtime registry 验证：loss 立即拒绝新 claim、等待旧 permit、保留未中止 runtime 和全部原 Task/owner/intent 行；普通 pause 仍中止原 runtime。另覆盖 startup query ACK、tick query ACK 和已排队旧 resume 的窗口。原 RFC-328、RFC-349 和 Task background 配置用例、断言、预算保持。

本机只做本批格式/lint、纯 AST/字节检查；不运行 AW tests/typecheck/build/service。有限独立源码门、原静态清单、精确提交与 hosted CI 分别留证。随后将完整 binding 与这些实际停止派发接口接入启动前恢复、19 个 handles、Task 事务和所有执行入口，再通过 A-G，才开始各层独立 CS adapter 和 M0 首次部署。

## 2026-10-07 provider 派生类型接续

SOURCE7-R1 的有效稳定 PASS、原 46 项 FP 与三个 Task 补充合同全文见证保持为历史结论。当前绑定的 provider 类型改用平台 DatabaseProvider，运行输入判定改读同一个 DATABASE_PROVIDERS 元组；当前两个 provider 的允许值、完整实例身份、generation、原 PID lease 责任与所有 lifecycle/quiesce 行为保持。端口的相同类型归一属于独立功能 CI 修复片，当前 R2 对实际新端口完整核对，不能继续用旧 R1 作为当前候选的发布门。

其余五条源码/测试完整保持，原文档完整前缀保持。本机只做该派生变更的格式/lint、纯 AST/全文对照；新有限源码门与唯一原 census/配套门/精确 CI 分别留证。实际 bootstrap 仍未消费 binding，19 handles、Task 同事务准入和完整 H7/A-G、CS部署继续开放。
