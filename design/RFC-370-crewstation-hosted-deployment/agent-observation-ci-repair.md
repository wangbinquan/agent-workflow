# A-T5／A-T7：运行观测类型归属与 CI 后继

状态：实施中。沿用已批准的 `agent-invocation-factory.md`，本片只修已发布 System 增量暴露的实际 CI 失败。

ad446763 的主 CI 37333383574 中，原 RFC-317 检查发现 RM `public/participants.ts` 直接导出了 legacy `services/runtime/types.ts` 的 `StartupInventory` 与 `SystemAgentOutputEvidence`，令 outbound 债落入 public 层。原规则要求存量反向边只能在 application；不能为此次变化扩大允许层次。

将这两份完整声明及其纯类型闭包 `DeclaredRuntimeCapabilities`、`NormalizedEventKind`、`TerminalResultObservation` 整体归到 RM application ports。保留每个原成员、字面量、可选性和注释；旧 runtime types 保持所有原名称的 type-only 兼容出口，内部既有类型仍消费同一声明。RM public 只从自己的 application offered 合同导出正常消费者与旧 API 兼容出口实际需要的五项；旧文件本地仍使用 NormalizedEventKind 和 TerminalResultObservation，其余原名称继续 re-export。原 System、协议解析、捕获和材料算法不改动。

原 session 事件声明已整体归 RM，因此 `services/sessionEventSink.ts` 实际成为 thin facade。RFC-294 的 exact facade 清单应补这一个真实地址，原列表、分类器、等式、其他断言和预算保持。完整原源码与声明逆向对拍、独立有限功能门、一次与改变候选匹配的原静态登记、确切 SHA hosted CI 分别验核；不以类型迁移或本地静态证据代替运行通过。

本片不处理并行 RFC-371 producer、分页、fixture 或未提交源码。全部并行内容保持。实际 Task／启动根、retention、脚本与恢复、完整 A-G、CS adapters 及 M0～M4 继续，尚无 AW-in-CS 部署，不关闭 RFC。
