# RFC-370 原系统执行恢复候选

2026-10-13；阶段 A 的 A-T5/A-T6 生产候选与用例写作记录。本文不构成实现门、CI 或完整 RFC 验收。

## 实际缺口与接线

原执行端口只有 submit。System 在 unreaped 时不返回恢复能力，Memory 抛出不带原结果的错误，并在 finally 遗忘 retained reference。原 scratch 虽未删除，后续无法通过原对象确认/清理和结算。

执行 owner 现提供独立 ExecutionRecoveryPort，每个完整 ExecutionEffectPort 都具有 recoverOriginal。输入/回执只含原 executionRef 与 reaped/unknown；PID、argv、OS 留在 native adapter。原 binding 保留原物理能力和启动/终态身份，只处理同一个已提交 attempt，并发恢复共享原 promise。未知不生成业务成功、exit code 或替代 submit。

managedProcess 的原 unconfirmed child 保留 process-tree recovery。direct system/smoke 不为恢复改成 pre-activation launcher；使用原 child/树的真实事实。Windows 没有可确认 job 时不能签 reaped。没有原能力的 native 注入结果须有完整 PID/时间/nonce/终态配对及实际树消失证据；缺身份、过期、命令不符保持未知。

System 的原 unreaped result 附完整 recovery participant，捕获原 effect/cleanup 方法和 receiver。先确认物理执行，再等原 usage/incomplete terminal capture ACK，再清理原材料。清理失败可重试，物理确认复用，原结果仍 unreaped。start receipt 失败和 unreaped 同时发生时，unreaped 优先，避免过早清理。

Memory 未知结果保留协议链全部 retained references。显式恢复使用原 participant，随后释放原 scope/ref，再原序遗忘引用。调度器保留原 bundle、固定失败时刻、attempt/backoff 和结算 callback，不跑新模型、不领替代 bundle；结算 ACK 丢失只重试原回执。缺失/替代记录不能确认或覆盖。

同一 Memory composition 保留 pending execution，阻止 tick/recoverRunning 把它重新入队。公开 recoverIssued 与 POST /api/memory-distill-jobs/:id/recover 使用原实例、既有管理/执行权限，不获取新执行准入。原 owner drain 只检查显式恢复的真实 ACK，不借 pause/loss 发强杀。

## 已编写、未执行的用例

- 原 executionRef 未提交/不匹配、无物理回执、重 submit 拒绝、并发共享 ACK。
- 原真实 Bun 子进程和 process tree 的物理退出；Windows ownership 不可确认保持 unknown。
- 真实活进程缺 nonce、nonce/终态不配对、过期身份：拒绝恢复且原子进程仍活。
- 原 System capture/cleanup ACK、receiver 保持、恢复后仍 unreaped；失败 start receipt 不覆盖物理未知。
- 双 provider 的原 Memory 回执/固定时间/backoff、丢 ACK、替代 job 拒绝；同 composition 的 scratch 保留/释放、旧 running 不重排、显式恢复幂等。
- Memory pause/loss drain 不发物理恢复，仅在显式恢复和结算确认后通过；HTTP 权限、未证明恢复 409 及原耐久行保持。

25 份本轮 TS 仅限定格式、parseDiagnostics=0 和 diff 静态自查。新测试未执行，未运行 AW 本机 typecheck/build/services/E2E/实现门，未发布本批候选或部署 CS。

## 仍需完成

当前 capability 仅保留在原 process/composition 实例，不能宣告跨进程/重启恢复完成。原 Memory 启动策略仍需与耐久执行身份和材料恢复接线，不能将重建后 Map 不存在当作旧执行未发。恢复后 SO 继续/新 epoch、其它 H1～H8 调用者、三根/十九 owner 完整覆盖、架构配套和 A-G 仍待收口。

用户最新阶段 A 完整提交/GitHub 总绿要求见 [阶段 A 退出清单](stage-a-exit-checklist.md)。阶段 B 尚未开始，之后仍先 M0 实际部署再 M1～M4。
