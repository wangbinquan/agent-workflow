# RFC-370：原 driver 清算后验证不附着结果

精确提交 `102919a46507a78ac3b119e077eb87c30248a7ba` 的完整默认 Windows run `38017304465` 已终态 failure。原九个 reporter 的 not-attached case 均触及原 `30_000ms` 预算；上一片修复未建立正确前置条件，该失败和原功能门结论分别保留，不用功能门 PASS 替代 hosted CI。

## 原因与修复

`taskDriverLifecycle.ts:156-159` 在读取 Task status 前先等待 `host.finalizations.pendingForTask(taskId)`。原测试直接附着了首个 driver；即使将 Task 停在 `awaiting_human`，首个 host lifetime 仍未完成。第二次提交会等待这个 lifetime，而原夹具只在第二次提交返回后的 `finally` 清算首个 driver，形成测试自身的等待环。

只调整 `rfc370-task-host-runtime-lifecycle.test.ts` 中同一个循环内的 not-attached 夹具：保留原真实 attach 与 controller，先停 Task、确认真实 pending lifetime 存在，再调用原 `releaseAndFinalize` 并确认 pending 已清除。此后取完整 Task／owner／event 快照和 ACK 计数，再执行原真实 coordinator 提交。首个 driver 的清算 ACK 属于前置操作；目标提交的新增 ACK 必须仍为零，计数用原累计值的差额测量，不清零或隐藏清算结果。

原 `not-attached` 结果、reporter 为零、engine drive 为零、目标提交新增 ACK 为零、完整快照逐项相等及 `finally` 的原幂等清理全部保留。前置清算也放入 `try/finally`，避免前置失败遗留 driver。新增两个 pending lifetime 断言，未改生产实现或任何原事务／状态转移规则。

## 有限验证与交付边界

纯 TypeScript AST 比较原 25 个注册节点、全部原标题、suite、九个 reporter 和预算；原每 provider 52 个 case 与一个全量原调用者 case 保持，期望 Ubuntu 105／macOS 53／Windows 53，共 211 次实际执行。计数仅是登记，新执行结果由后继精确提交的完整主 CI 和默认 Windows 原始日志另验。原 Windows 中九个 timeout 的日志保留。

14 个生命周期生产文件、原调用者 fixture、根逆变换、Windows 注册、四个原架构生成规则及原架构产物均保持；本次没有新 census，也没有本机 AW 测试、类型检查、构建、E2E 或服务。仅对改动测试做 format/lint，自带有限独立功能门，按精确四路径发布。

同 SHA 主 CI 有一个 PostgreSQL 服务初始化失败：ECR Public 三次拉取均返回 `toomanyrequests: Rate exceeded`，该分片尚未执行测试。这个基础设施失败独立保留并处理，不能作为跳过该分片或降低总绿门槛的理由。

本片不签收 HumanGate 实现、完整 H7／A-T7／A-G、各层 CS adapter 或 M0～M4。总主 CI 与完整 Windows 全绿前不恢复新适配实施；AW 未部署到 CS，RFC 仍进行中。
