# RFC-370 记忆蒸馏原结算候选

2026-10-13，阶段 A 完整开发中的续推。新增生产接线和测试用例尚未功能验证，本文不构成 A-G 或完整 RFC 验收。

## 具体缺陷和改动

原 `distillTick` 将 `runDistill` 和后续 `markDone` 放在同一个业务失败 catch 中。因此 runtime 已成功而落库 ACK 失败时，原代码会进入 `markFailed`，增加 attempts 并重新排队。host 模式现将原结算与业务失败分开；明确保留原 runtime 结果、原 bundle ID、原完成时间、原失败次数和 backoff。standalone 路径保留原策略。

新增 `MemoryDistillSettlementPendingError`，只保存原落库/通知 callback。`retryOriginalSettlement` 在调用 callback 前保留共享 promise，并发排空只执行一次原重试；确认后再次调用复用已确认结果。它不能调用 runtime、领取下一 bundle、增加一次新的 attempt 或把 unreaped 错误改成成功。

WorkStore 增加按原 ID 批量读取的完整 `loadJobs` 端口。host 在原写入前后核对原记录身份及结算状态，不扫描全表；缺失/替换记录和未确认状态继续阻止 ACK。三个原结算方法和 receiver 在 queue I/O 前捕获。Memory owner 的普通暂停与失权排空都等待原结算 callback 的实际确认；原物理进程不确定错误仍向上返回。

## 已编写、未执行的用例

- 原成功写入后丢 ACK：不进入失败分支，不再运行 runtime，完成时间和 attempts 保留，重复排空只重试原回执。
- 原业务失败回执丢 ACK：保留相同 attempts/时间/backoff，实际耐久状态经双 provider 原 store 查询确认。
- 原记录缺失、随后同 ID 被替换：仍不可确认，不覆盖替代记录，不重新执行原 runtime。
- Memory 原真实 polling handle 的 pause/loss 排空：原 tick 只发出一次，未确认继续拒绝，原 callback 可确认后排空成功；并发排空共享原 ACK。
- 原 unreaped 传播用例完整保留，不能用结算重试代签物理回收。

## 尚未闭合

host 的未发领取恢复、物理进程未确认的显式恢复，以及 owner 致命失败后整体/分组状态反馈仍需继续沿实际链路收口。完整三根/十九 owner、所有 H1～H8 调用者和架构配套、A-G 均未完成；CS production adapters 尚未开始。仍按 AC00/AC00B 先完成阶段 A 集中验收，再首次 M0 实际部署，随后 M1～M4。

本轮八份 TS 仅限定格式/语法/diff 自查；累计 130 份 TS/TSX 的 `parseDiagnostics=0` 不等于类型、功能、CI 或部署通过。没有执行 AW 本机测试、typecheck、build、服务、E2E 或实现门；本会话未发布这些生产候选，也没有跨 session 信息。最近主干核对 `main=origin/main=6ac89a7c5a6d2754e79e34cd41c7d2f56f2721b2`、差异 0/0、index 空；并发内容保留。
