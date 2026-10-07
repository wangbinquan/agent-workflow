# RFC-371 原续接 baseline 的写事务与 Worker 收尾修复设计

属于已授权的 RFC-371 完整采集修复范围，沿用 Task 原权限、完整 EOF 与取消语义，不引入新统计能力或配置。

## 原问题

2e3b68b2 的两个真实续接取消案例 v2/v3 都已有每一条末尾数字的原 pass EOF ACK，却缺第二轮 root completion。v2 为 67,303 Token / 验收 ¥0.133460，v3 为 48,144 Token / 验收 ¥0.082620。v3 取消后没有重载仍未 seal，不能只把问题归因于开发重载。两例原 daemon 日志均出现 RFC-359 明确的 SQLite 写事务跨事件循环等待。

源码确定：`DrizzleNativeUsagePages.persist` 在 `withNativeUsageOwner` 的事务内调用 `emitNativeUsagePage`，后者对原 before index `await members()`，实际通过 Worker IPC 或独立 PG read channel 获取成员。该等待违反原事务只等待原 DB 操作的合同。收尾两个 host 在已得到 snapshot closed 回复后仍分别调用 terminate/cancel，再等待实际 close event；不能据此断言当前 seal 卡住的唯一原因，但这个多余的破坏动作应按正常 close ACK 与异常退出区分。

## 原边界内的修复

1. 原 native page schema、payload/cumulative digest 验证之后，在原 Task 写事务之前查询该一个完整 page 的所有 step ID 的 baseline membership。仅 numeric final page、原 resume before root 路径需要查询。成员来自原已经完整校验的独立 frozen snapshot，不重新扫描、不建立新基线、不限制总页/根/会话/步骤。
2. 只把原 completion identity 和新复制的私有 membership Set 传入写体，写体仍与原 preparation/before、source generation、lineage、epoch、invocation/root 一项项绑定；保留 null 不可用、undefined 原单连接 fallback 三态。不把不可用当空集合，不变更原 Task fence 或 finalization 的同 PID/nonce reap/drain 条件。验证以及页/数字/ACK 持久化继续在同一个原写事务内。等待期间原 owner 丢失仍被事务内的原 fence 拒绝。
3. Worker 的 closed 回复必须对应原 pending close request。成功正常收尾等待原实际 close event，不再发送 cancel/terminate；没有成功 close ACK 的异常/abort 仍由原 stop 路径终止并等待真实退出及已启动的 PG reads。没有超时伪造 exit、completion 或 EOF。
4. 既有全体断言不删除。增加实际 file Worker + 原 SQLite ledger 回归，成员查询真正跨事件循环时原 DB 不在事务且旁观读可成功，最终只产生新步骤的四类数字。增加正常 Worker 收尾回归，看到原 closed 回复后不再调用破坏性 cancel/terminate，实际 close event 仍发生。原跨 provider 和异常/abort 回归必须保持。

## 验证与退出

只运行 AW 格式/静态语法读取和有限源码双门，禁止本机 AW tests/typecheck/build/E2E/压测/新服务。用原 hosted exact-SHA CI 执行所有原断言及新回归；在原已授权 daemon 上再次跑同 native 会话续接、两实际子 Agent 与真实取消，只有完整 seal、原源每条记录/分类与人民币/全部 report sections 的实际 EOF 均相等才判通过。原失败案例和已知数字持续保留。

## 真实收尾诊断与 Worker 消息监听释放

v4 在上述事务修复之后仍缺实际第二次完成；v5 的临时生命周期日志进一步确定：final pass 的所有页、ACK 和真实关闭事件均已发生，原 baseline 已回复 `closed`，原 PG reads 为零，但 baseline Worker 没有关闭事件。阻塞位于 baseline host 等待真实退出，尚未进入 root seal。普通 pass Worker 还在成功 `closed` 回复之后发送了错误回复。保留这些失败，不据数字齐全宣称完成。

三个观测 Worker 当前都在关闭原快照/通道之后调用通过类型断言声明的 `globalThis.close()`。本机原 daemon 使用 Bun 1.3.13；这个调用并非 [Bun Workers 官方文档](https://bun.com/docs/runtime/workers) 给出的正常退出方式。官方说明全局消息监听使 Worker 保持存活；事件循环没有工作时 Worker 自然退出。

因此本次补充修复仅在 `nativeUsageBaselineWorker`、`nativeUsagePassWorker` 和 `observationReportWorker` 原有关闭位置解除 `scope.onmessage`，让原消息、快照与通道收尾之后自然退出，并删除并未验证的 `close` 类型声明。没有新增主进程退出、计时器或伪造关闭；host 仍等待原真实关闭事件以及启动过的 PG reads。异常/abort 保留原快照回滚、通道拒绝和 host 停止路径。

原真实 Worker 回归保留全部旧断言和 30 秒预算，增加成功关闭后没有失败回复/错误事件的断言。提交前移除本会话临时日志；新的真实续接取消案例必须达到实际两轮 seal 和完整报告，再与原 native 每一条记录核对。三种部署形态、完整人口及原执行预算均不收缩。
