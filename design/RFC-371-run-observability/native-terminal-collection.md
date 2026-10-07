# RFC-371 原生采集在取消后收尾

这是已批准观测实现的漏计修复，不改变 Task 取消、所有权移交、模型启动或原执行写入判据。

## 实际失败

2026-10-07 验收任务 `01M4AA646EQERECVAAK24GGFMK` 首轮已正确采集 12,662 Token / ¥0.040948。第二轮使用同一 OpenCode 根会话，before-spawn ACK 为 resume、epoch 2，基线页真实 EOF。模型返回并完成两条原生子会话后，CLI 未自动退出；原运行时间预算取消任务。04:56:13Z 原日志显示 `native-process-observation-write-failed` 与 `node-run-observation-native-final-failed ... mutation was fenced`。原第二轮 preparation 仍 open，只有 spawned 事实，final root result/usage capture 均未入账。不得把这次验收记为通过，或删除此任务和原失败。

## 边界

`withNativeUsageOwner` 属 task-execution.infrastructure，目前所有页、数值、原进程与完成证明写入都使用执行面的 claimed 围栏。取消保持原先先 revoke、再停止/回收的流程；普通 Task 写入和原 native API 的严格围栏全部保持。只给启动前已接收、启用 v3 的本轮采集，发放模块内的原生收尾引用：引用不序列化、不出公共 REST，不是执行上下文，不允许启动、修改 Task/Node 状态或取得新 epoch。

引用只在本轮真实 prepare ACK 已接收且真实 runtime callback 按同一 PID/launchNonce 报告 reaped/drained 后激活。保存 before-spawn 的 invocation/nativeSource/lineage/epoch，和原 spawned/reaped/drained 顺序。未知、unreaped、没有启动事实、未 prepare、身份或时序不一致不激活；不得用 Task.finishedAt 或进程不在 ps 中推定回收。prepare/baseline 的原执行写入始终保留 claimed 围栏。

收尾写入继续使用原事务及 owner→node 锁顺序、原节点/接受调用/intent/source/准备收据/页 EOF/数值与历史修订校验。若 claimed 围栏成功，沿用原分支。若仅因本任务已 revoke/release 而拒绝，只有上述引用仍匹配本轮、当前 owner 的 taskId/ownerId/daemonGeneration/epoch 与原 token 全部相同、且原准备收据完整匹配，才允许本轮原生证据表与 source outbox 的收尾写入。新 owner/epoch、仍 claimed 但不匹配、无引用和其他失败保持原错误。任何 Task 执行权限不恢复；默认 OFF 与确切 runtime tuple admission 不变。

原生收尾引用在 task-execution 的 application port 只作为 opaque object；模块内 infrastructure 持有真实记录，composition 只连接 prepare ACK 和原回收 callback。原 runtime driver、baseline Worker、原引用与数值账本复用，禁止第二套数字、手工补造源、隐藏漏项或给未知量补 0。

## 验证

保留原 owner epoch 改变不得产生数值 ACK 的用例及全部原预算、源人口和断言。增加 SQLite/PostgreSQL 对称验收：真实原准备/启动/回收事实后 revoke/release，本轮 final pages、数值 source、completion、原消费与人民币估值正常提交且重放无重复；Task 状态不变、其他执行写入继续拒绝。未 prepare、未回收、源/PID/nonce/时序不同、已换 owner/epoch、基线新写入不借用收尾引用，均维持拒绝。事务失败无 ACK、回滚与原历史步骤归属保持。AW 本机不执行测试/类型检查/构建；只做确切源码格式/lint、parse-only和有限独立功能审查，以 hosted CI 为整仓门槛。

重新运行正常续接与取消验收，用真实 CLI step-finish 原始行逐条核对四类 Token、历史基线排除、Task/Agent/调用汇总及人民币值。原失败任务继续显示既有量和缺口；只有取得原真实回收证明并通过同样源协议的修复采集，才能补交其缺失步骤，不能通过直接改账本消除缺口。历史恢复是明确待验项，不因新任务通过而完成。
