# RFC-370 maintenance：service 实际排空 deadline 补充

本补充仅扩展 [e8057 实际 CI 修复设计](maintenance-hosted-ci-repair.md) 的 cold actual drain deadline 范围。原 DESIGN-R1 冻结正文与失败证据保持，不重写此前有限结论。累计使用量仍归「设计运行观测统计全景」，新增适配实施继续等待完整主 CI 与默认完整 Windows 总绿。

`maintenanceService.ts` 的 cold `awaitDrained(lifetime, timeoutMs)` 在等待 frame.start／resume、实际 admission tail 及同一 supervisor drained ACK 时，也把自己的拒绝 timer unref。若已受理 enqueue 的 Promise 一直未结算、原执行 ticker 已在 loss 后全部关闭、当前没有其他 handle，supervisor 的 timer 尚未建立，此时只修 supervisor 的 deadline 不能保证 service 调用者收到超时拒绝。已有 in-process 手动 Promise 案例不能排除测试 runner 自身 handle 的干扰。

这次在原 service 的 cold awaitDrained 中仅删除 `timer.unref?.()` 一行，保留原 timeoutMs／10000ms 默认预算、原 `maintenance execution actual drain timed out` 错误、双参 then 的实际成功／拒绝传播及两处 clearTimeout；保留所有 start/resume/admission/supervisor 尾部、未 ACK 人口、超时后旧 owner 保留和迟到 ACK 责任。其余 native retry、sampling、boot、checkpoint 的 unref 与业务语义均保持。它与主设计的 supervisor 修改共同构成两个生产输入，不改变端口或 owner/root 接线。

只向原 cold service 测试末尾增加一条 fresh Bun 子进程回归。父进程使用现有冷夹具取得原完整 `Config`，将其值传给子进程；子进程导入实际 `createColdMaintenanceService`，用完整原 store／payload／supervisor 合同构造同一 service，不打开真实数据库或创建 Worker。显式 start 后调用原 runSoon，等待 store.enqueue 确实进入再保持它的 Promise 未完成；使原 current 为 false、quiesce 并调用 awaitDrained(lifetime,17)。原配置 ticker 和采样在 loss 时全部停止；剩余唯一存活 handle 必须是这个实际 deadline。准确输出原 service 超时拒绝标记、子进程正常退出及父进程 error／status／signal／stderr／stdout 五项断言共同区分旧 unref 假退出与新正确拒绝。父进程 3000ms 只限制故障子进程，不扩大产品预算；不在超时后伪造 admission 或 Worker ACK。

父进程原冷夹具以原 finish 关闭；原 service 17 案例／supervisor 14 案例、真实双 provider Worker 案例及原断言和预算继续保持。本补充使最终候选为 service 18、supervisor 16、真实 Worker 每 provider 一例：Ubuntu 双 provider 36、macOS SQLite 35、Windows SQLite 35，共 106 次预期目标执行。此数替代主设计 R1 的 103 次计划；实际仍未运行。三套既有登记不变。

补充的独立功能设计门与后续实现门实际绑定本设计、原 service、原冷夹具和母设计的 frozen 直接合同；完整母人口保持，补充人口分开记账，不冒称原 R1 已签此项。实现后才做唯一必要原 scoped census、MATCHING、精确路径发布和 hosted 实际验收，不运行本机 AW test、typecheck、build、service 或 E2E。

本补充仍不签完整 H7／十九 owner／三个启动根、A-T7／A-G、CS adapter／部署、M0～M4 或 RFC 完成。

## 2026-10-12 补充源码候选

原补充设计与完整 service 合同已单列通过 DESIGN-R1、由 root 实际消费，母人口不改。生产只有原 cold awaitDrained 中的一行 unref 删除，双参 then、两处 clearTimeout、默认 10000ms 和原错误字面量均保持。新增 fresh Bun 用例从原冷夹具传完整 Config，等待实际 backupPrune enqueue 进入后持住它的 Promise，失权、quiesce 后由原 17ms service deadline 输出精确拒绝标记；未完成的 admission 没有被伪造 ACK。父冷夹具继续原 finish，原 17 案例全正文与预算保持，service 新人口为 18。最终 106 是计划，实际 0；SOURCE／生成／MATCHING／发布及同 SHA 完整主 CI、默认 Windows 仍须分别验收。
