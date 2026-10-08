# CI：开发 watcher 原交接用例的等待预算

`5b8c7b320d89bb694a872282455e021e8b777463` 的主 CI `37761392727`，Ubuntu backend shard 2/32 作业 `113258383572` 只有原 `dev watcher replacement drains the previous generation before taking its lock` 失败；作业其余 756 条通过。完整日志保留：旧实例的关闭请求已 accepted 并记录 `requested previous dev daemon shutdown`，替换实例随后仍因旧 PID 的锁而退出。

现有 local startup adapter 在第一次锁探测前开始计算交接 deadline。关闭请求 accepted 后，后续同 PID 的 `DaemonLockHeldError` 只有交接 deadline 用尽才会由该循环向外抛出。日志中 ACK 后约 0.5 秒的间隔不能代表整个交接预算；不据此认定锁提前释放或其他生产 bug。

原用例将交接窗口缩为 3000 ms，与当前 `packages/backend/package.json` 的真实开发命令 `AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS=35000` 不同。正常 drain 的既有 graceful shutdown 也有 30000 ms 预算。本批只将这一原替换用例的环境值对齐现有 35000 ms；第一实例的 readiness 保持 10000 ms，替换实例的 readiness 从 10000 改为 45000 ms，包含 35000 ms 交接与原有 10000 ms 启动窗口；该用例总预算从 15000 调到 60000 ms，覆盖第一实例、替换实例与 cleanup。

原 first exit=0、替换后的 health=200、并行等待与 finally 回收完整保留；普通 daemon 不可被 dev daemon 替换的用例仍用原 3000 ms。所有生产交接、控制监听、退出、锁及超时算法保持，未新增重跑、跳过、条件放行或修改 CI 规则。这不是 3 秒交接性能保证；用例继续检验真实的有界正常 drain 与接班。

纯解析／完整字节逆向比较、定向格式／lint 和独立有限功能门不能代签 GitHub 全绿。没有本机 AW 产品测试、typecheck、build、服务或 census。发布后的完整主流水线与 Windows 另验；总 CI 全绿前继续暂停 runtime／Node／CS 新实施，RFC-370、H7／A-G 和 AW-in-CS 部署继续未完成。

首轮有限功能复核发现：第二个 readiness 的 deadline 在 second spawn 后立即开始，原 10000 ms 窗口已经包含交接；只调整 handoff 与外层预算仍可能拒绝 10～35 秒内正常完成的 drain。本后继将该次 readiness 明确衔接为 45000 ms，保留首轮失败记录。原 helper 的 pending read 不被当作延长预算的保证，没有扩改该 helper。
