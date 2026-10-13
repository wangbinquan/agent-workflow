# RFC-370 耐久原执行引用与日志候选

2026-10-13；A-T5/A-T6 开发记录。上轮只有原实例内回调，本轮增加可持久化的原执行/材料引用和数据库原回执日志基础。功能、重启流程与阶段 A 退出门尚未验收。

## 原执行与材料

task-execution 增加独立 ExecutionRecoveryReferencePort。native 启动回执包含不透明 recoveryRef，包装原 executionRef、主机/平台、PID、启动时刻、binary、nonce；这些字段只由 local adapter 解析。重建后的 recovery 直接处理原回执，不构造新的 execution binding 或 submit。引用错误、主机/平台不符和身份不配对保持 unknown。

Windows 原进程在实际 adopt 到 kill-on-close job 后才记录 jobOwnerPid；旧 daemon 已退出时，该原 kernel job 的关闭提供物理退休证明。没有实际归属则保持 unknown，不凭当前机器宣称 job 能力可用。原 direct/native 路径和其 launcher 选择不变。

runtime-management 的原 System workspace 生成耐久 retained reference，并在原准备操作中标记材料 generation。新 owner 必须匹配同一安装、namespace、name、原标记才能释放；同路径的替代材料版本、错 scope、缺 marker 均拒绝。原 native 路径和目录布局保留，fixture 的明确原映射保留。Memory 原未知恢复现在检查实际 removed ACK，不能将 removed=false 当作释放成功。

SystemAgentRunFamily 增加完整 recovery 合同，composition 捕获原方法和 receiver，缺失合同在产生执行效果前拒绝。System core 增加完整 executionReceipts 合同，捕获 prepared/started 两个原方法；prepared ACK 在 submit 前，started ACK 在原 owner/stream 激活前。原结果保留 plain executionReceipt，供业务 owner 的耐久日志保存。

## Memory 原日志基础

新增 MemoryDistillExecutionJournal 和独立 Drizzle 实现，原 WorkStore 绑定同一个数据库 session。它不借用允许丢失的辅助会话 sink，也不把日志 marker 当执行权。

memory_distill_execution_receipts 保存原 context/bundle/scope/prompt/nonce、准备时刻、启动/恢复引用、原终态和关闭回执。状态为 prepared/started/terminal/reaped/closed；prepared、start、terminal 和 close 可按同一原值幂等确认。事务锁定原 row，核对身份和结果，未知物理状态阻止关闭；多回执关闭全部核对后统一提交。无 job cascade，删除 job 不会擦掉未确定执行事实。错误 context、替代 start/terminal/settlement 不能覆盖原记录。

生成 SQLite 0254 及 snapshot/journal append、PG 0030 及 immutable upgrade 元数据，并更新 RFC-349 roster/合同报告。DDL 只增加本表和两个索引；既有 RFC-371 schema、迁移和共享合同输出保留。当前生成合同为 275 source / 269 active / 6 archive-only。此处是生产配套生成，没有执行迁移、provider 功能测试或整仓门。

## 已编写、未执行的用例

- 两个实际 Bun 进程：原 daemon 发原真实启动回执、target 实际写 issued 标记后 daemon 崩溃，新进程按该回执恢复；无真实 Windows job 则保留 unknown。
- 新材料 owner 释放原 generation；同路径替代、错安装/name/namespace、缺 marker 拒绝且文件保留。
- Source 主机/引用/字段不匹配不产生恢复权限；prepared/started ACK 的实际顺序、准备失败无 submit、start 失败无 owner/stream 激活。
- 双 provider 的重建后原记录读取、固定时刻/原字节/幂等 ACK、未确定状态拒绝关闭、多回执关闭原子性、错误 context 与替代 terminal 拒绝。

31 份 TS 仅格式/语法（parseDiagnostics=0）和 diff 静态自查。新用例未执行，未运行 AW 本机 tests/typecheck/build/services/E2E/实现门；本轮未提交/推送/部署，也无跨 session 信息。

## 下一步仍是阶段 A 开发

本轮已完成上述实际 Memory 接线：prepare/started/terminal 和候选写入的 primary ACK 失败保留原异步位置；并发 drain 共用原重试并等完整业务尾部，连续失败不能提前确认。业务结果的 ID、时间、attempt/退避固定；同一 bundle 原子结算，替代领取拒绝，后续取消及人审候选保留。冷恢复复用已知输出，未知物理事实只由显式 recoverIssued 处理；辅助会话 sink 仍不能确认执行。

协议链保存原 session、scope、nonce、runtime 引用、system prompt 和总 deadline。已完成轮只回读，未激活 prepared helper 经原物理确认后才允许新 active owner 继续该轮；其回执仍参与最终结算。原 daemon 未退出或 native 事实无法确认时保持 unknown。准备中的首轮未执行，恢复归还同一 claim，不消费 retry budget。新增 native 准备引用不提前读取 plan 的 binary/cwd/env，原 gated launcher 使用同一保留 nonce。

Memory 冷启动恢复失败时返回持有原错误的未就绪 handle；session 先登记 handle 再等待启动确认。全局 readyGroups 不会开放，旧 write context 保持待退役；原物理回收和业务写入 ACK 完成后才能 drain 并进入新 epoch。新增两 Bun 进程的未激活窗口、primary ACK 连续失败、业务/候选重建、原 claim 原子结算、未激活补问继续、双 provider 的实际 SO epoch 回归均只编写未执行。

本轮 43 份 TS 仅格式、语法解析和 diff 自查；功能、类型、平台流程、实现门及 CI 仍须在阶段 A 全部开发和用例完成后集中验证。不能以此关闭 H7 或 A-G。

全调用者清单、三根/十九 owner 完整覆盖、A-T7 及 A-G 仍未闭合。仍按 [阶段 A 退出清单](stage-a-exit-checklist.md) 完整开发/用例写作、集中验证、完整上库、确切 SHA GitHub 总绿后进入 B；之后先 M0 实际部署，再 M1～M4。
