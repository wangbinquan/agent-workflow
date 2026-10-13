# RFC-370 资源服务启动与原执行恢复入口

2026-10-14，阶段 A 候选。此次沿真实 `startCommand → session.resume → serveDaemon` 查到：执行恢复失败会在 listener 创建前退出，使恢复 API 不可访问。此处补完整接线；新用例只编写，未执行功能/类型/CI 验收。

## 实际行为

- 两 daemon 根返回自己的 `hostExecution`，共同启动入口通过 `resumeDaemonResourcesForServing` 调用同一 session。资源会话已 running，且 selected host 确认为执行启动失败后的 standby/draining，才允许继续创建唯一 listener。原错误留在执行控制与启动日志；不把执行标 active。
- native、资源初始化失败、closed 及不属于执行启动的失败仍抛原错误。embedded 增加显式 `resumeForServing`；原严格 `resume` 保留。没有为 embedded 添加 daemon timer/owner。
- SO 独立 `HostExecutionRecoveryCommands` 只重试原 authority lifecycle.start。HTTP `POST /api/execution/recover` 在原 settings:write/tasks:execute 功能权限下调用它，并返回实际状态。GET 不调用恢复；resource-only/native 对该控制返回未选择。
- 宿主重试不替业务执行 kill、settlement 或 readyGroups。原物理/材料/业务回执未完成时仍失败；实际 owner drain 之后才能创建新 epoch。普通资源查询/编辑可继续。
- Memory running 行在宿主不可用时提供恢复原执行，成功只提示原恢复确认，仍以刷新后的 job 状态为准；随后通过顶部重试启动继续。正常 selected tick 有自己的在途标记，cold recovery 不能接管它；不消耗原尝试预算或重跑已完成模型。
- UI 复用 NoticeBanner/ErrorBanner/原按钮样式，Pending 禁止重复点击；实际启动成功才刷新就绪状态，资源草稿保持挂载。失败仍显示原状态和明确恢复次序。

## 同次调用者清理

Intent 的旧 application maintenance helper 直接访问 FS，而真实维护已使用 IntentScratchStore。现在 helper 消费同一 port，提前捕获原方法与 receiver；旧双 provider 文件用例明确选择本地 fileIntentScratchStore，运行中 turn、过期/新目录、失败日志及计数规则保留。新增延迟非文件 owner 用例，不把 fixture 当远端运行证明。

## 用例与后续门

新增/扩展了双 provider 的真实 SO/session/resource HTTP、原执行 ACK 前后激活、实际 embedded HTTP 资源/任务/恢复入口，native/资源初始化失败透传，原 recovery receiver，活跃 Memory 拒绝冷接管，前端 startup pending/failure/draft 与行级恢复/不跳页用例。原 root source oracle 同步核对唯一启动 helper 与 listener 的次序。

阶段 A 继续按 [调用者账本](stage-a-caller-ledger.md) 和 [退出清单](stage-a-exit-checklist.md) 收口剩余实现/完整用例/A-T7。完整写作后集中验收、完整提交、确切 SHA GitHub 总 CI 全绿，再进入 B；本候选未发布或部署，RFC/CS 部署未完成。
