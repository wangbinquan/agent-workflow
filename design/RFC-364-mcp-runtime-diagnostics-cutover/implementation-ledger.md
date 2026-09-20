# RFC-364 实施台账

## T1 基线与本批边界

基线 `4a3b3c5ae05ef93182329bb40a2930eebd48f79b`，本批不增加表/迁移，不改变七个 HTTP endpoint 的状态码、payload、锁范围或 lifecycle 注册次序。完整 root/public 切换仍待 T4/T5/T6；临时 service 构造转发与 `SERVICE_INSTANCES` 的退出责任明确归 T6，不能以移文件领取 E6 完成信用。

## T2/T3 application 与 effects 候选

- `domain/mcps/runtimeDiagnostics.ts` 持有原预算、request digest、native continuation 与 turn verdict 判据。
- `application/mcps/runtimeDiagnostics.ts` 保持唯一 session/turn persistence 编排、队列、spawn 前后 CAS、boot recovery、cancel/invalidation 与冷生命周期；没有 FS/process/configPath/appHome 的实现依赖。
- `application/mcps/runtimeTestEventSink.ts` 保持同一 stream 序列化、event limit、native lease 交互和 final flush。
- `infrastructure/mcpDiagnosticsEffects.ts` 绑定 process、driver、配置、工作目录、WS 与 clock。计时器数量、60 秒 reconcile 间隔与 deadline ref/unref 规则不变，管理注册仍留 W9。
- 原 `mcpRuntimeTestLease` 五个转发调用改为直接消费 RC 唯一 lease participant，原参数/await 顺序不变；旧 forwarding 文件的其他 consumer 留 T6 清零。
- RM 驱动资格判据归 `runtime-management/infrastructure/mcpTestEligibility.ts`，RC 经 RM public query 出口消费；RM/config 只依赖 `McpRuntimeTestReconciliationParticipant`，不再引用完整旧 service 类型。

[extraction-evidence.json](./extraction-evidence.json) 记录基线原文 hash 与 AST 对拍：event sink class、8 个纯函数体、28 个 application 方法体一致；actor 判据仅改为闭合主体投影，17 个 effect/clock 绑定方法逐项列为 adapted，没有声称字节等价。

沿用 RFC238 service/http/real-process、RFC349 provider lifecycle、RFC359 W29 和 RFC360 participants suites；源码守卫迁到真实 owner 并保留原断言。新增 RFC364 policy/layer oracle，验证 UTF-8 边界、原预算、timeout/shutdown/cancel 优先级和 terminal flush/verification 顺序。只做 Node format/lint/AST 对拍，行为验收仍由最终 hosted SHA 完成。

## 剩余工作

T4/T5：四 commands + 三 queries 使用 IA context；锁内 fresh MCP lookup、同 coordinator、三 root 单实例和 lifecycle 注入；T6 删除临时 service/lease facade 与 WeakMap、精确 debt/canonical 出账、完整 AC/最终 CI。RFC363 Task 两 lane/admission/取消 owner 接线和 RFC365 T1 后续边界保持原状态。

## T4/T5/T6 生产接线候选（2026-09-20）

基线 `cb2ce5b566b754683505338c1e1979963e894051`。四个 public commands 与三个 queries 消费 IA command/query context；application 保留共享 MCP coordinator、create/message 锁外解析和锁内 fresh lookup。七个 HTTP handler 保留解析、权限、状态码和 DTO，只调用窄合同。

三个 root 均一次冷构造，HTTP、catalog lifecycle、RM/config reconciliation 与 daemon/provider background 显式共享同一 application。server 的 bootstrap 注入优先和 unstarted scope factory 保留，W29 全量图 digest 只随明确装配变更更新，并新增 exact coordinator/IA/eligibility/projection 断言。生产 `services/mcpRuntimeTest.ts`、`services/mcpRuntimeTestLease.ts` 和实例 WeakMap 删除；原真实双库、进程和生命周期测试直接导入真实 owner。

上一批 Main `35503125522` 暴露 application 反向 legacy 类型和 RC→RM offered DAG 边。本批移除这些边：运行结果/stream 是 application 自有合同；启动验证回调限定在同一 turn，仍在 final capture flush 后执行。Runtime Management inspection/eligibility 由 root 经现 public surface 注入 RC 所需事实，RC 不反向依赖 RM；RM→RC 的同事务失效和窄 reconciliation 保持。没有新增 allowed DAG 边或豁免。RT-13 method-presence 债只是更新实际 owner 锚点，不宣称驱动能力政策已改变。

新增真实 IA context + ResourceOperationCoordinator 并发 oracle，覆盖 start/message 等待 catalog 修改后使用新行、其余五操作共享锁、缺失仍404。原 RFC303 macOS fixture 的 registry 比较在 /var 与 /private/var 别名下会漏掉残留，现从 realpath 临时根构造，保留原三项 cleanup 结果断言和所有生产实现。

本批只完成可上库候选；E6/AC-7 仍等待本批最终 SHA Main 与原生进程证据。RFC363 Task 两 lane 与生产 fence/admission 接线仍需继续，RFC365 后续范围不变。

## T6 公开面清理

`a8b9202085a16ece282958b0cf6c1862c02477e5` Main `35504112617` 报 C2：诊断 owner 切换后 MCP lease error/operations 与 RM inspection interface 仅剩本模块使用。它们现收回 application 私有端口；没有新增零 consumer 豁免或伪造调用。lease 参数、错误码及所有权算法不变，补反向公开面回归断言。最终 hosted 仍待本修复 SHA。

## T6 后续守卫修正

`ec5fe2e8b` Main `35504767291` 的失败链已归因：C2 再揭示两个仅私有使用的叶类型（McpRuntimeProtocol / RuntimeProfileInspection），本批将前者归 lease 私有 port，后者收为 config 所需 enabled 投影；RFC305 import inventory 按真实 IA context consumer 更新；RFC201 锁守卫改为精确 3 个 probe route locks + 7 个 diagnostics application locks，并保留 aggregate 3 锁、create/message 两次 fresh recheck 与原其余断言。没有降低锁覆盖或放宽入口行为。
