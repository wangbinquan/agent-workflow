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
