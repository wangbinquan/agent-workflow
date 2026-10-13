# RFC-370 Intent 实际 turn owner 收口

2026-10-14：本项生产实现与用例已写齐，等待阶段 A 集中验收；不据候选代码记 PASS。

HTTP、queued 和 working-set/graph continuation 使用同一个 Intent turn execution lifecycle，daemon 仍是既有十九 owner，embedded 新增它实际暴露的 HTTP Intent owner。准入捕获原 grant；已发原 Promise 覆盖结果、材料与完整写入尾部。失权不自动取消，不开始下一模型调用。

原 Intent turn 的 runMeta 保存版本化主 execution checkpoint，独立于辅助 session capture。准备/启动 ACK 前控制实际 submit/activation；结果先保存，再进行原信封/草稿/预算处理。最终 outcome 和图修复预约同事务保存，ACK 重试返回原 outcome，不再铸草稿、预约或消耗预算。对外仅投影阶段和原 turn ID，不把恢复快照当运行指标。

未知执行保留原物理与材料引用。原同实例 capability 或重建 reference owner 确认 reaped，原 capture/材料和业务结算 ACK 后才闭合。已知冷输出复用原 manifest/runtime/nonce/budget，不调用模型。未激活 helper 的原回执归档于同一 turn，原预约/预算等待下一次激活；旧 boot cleanup 不把 selected checkpoint 改成普通 daemon-restart 错误。

恢复操作位于原 session/turn 路径：POST /api/intent-sessions/:id/turns/:turnId/recover。UI 保留原草稿和编辑文本，正常 active 与 audit view 不提供原恢复行动；该控制回执不表示模型任务成功。SO 激活重试仍独立，失败 prepare 只有在实际原 owner 确认完整尾部 ACK 后才能退役。

已写的用例覆盖实际 queue owner drain、连续 primary ACK、未发/激活/未知、双 provider primary journal、实际 dispatcher 未激活原预约、重建原执行/已知输出、同事务图修复、原 HTTP receiver 和前端 pending/拒绝/错误/文本保留。System 原准入失权回归同步验证 executionNotActivated。所有功能证据以集中验收和确切 SHA hosted CI 记录为准。

本项属已批准 H7 的真实消费者收口；阶段 B 仍等待完整 A 上库及 GitHub 总绿，不包含 CS 生产 adapter。
