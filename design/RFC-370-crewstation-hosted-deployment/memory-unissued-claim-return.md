# RFC-370 记忆蒸馏未发领取归还候选

2026-10-13，阶段 A 完整开发中的续推；用例只编写、未执行。

## 实际缺口与边界

原 host tick 在 `markRunning` 的异步 ACK 之后没有重新检查执行权，因此该等待期间失权仍可能调用 runtime。领取 ACK 丢失也可能遗留 running 状态而尚未发出外部执行。当前候选捕获原领取/归还方法，在 ACK 和实际记录回读后重新检查原权限；未发 bundle 归还原队列，只有实际调用 runtime 后才进入原结果结算路径。

新增完整 `deferUnissued` WorkStore 端口和两个 provider 共用的实际事务实现。它按原 ID 锁定并核对整个 bundle 的身份、attempt、领取时间、冻结内容及执行回执字段，全部可确认后才归还自身 running 记录。原 pending 状态可幂等确认，原取消保留；缺失、替换、错误领取时间、已完成或执行回执变化不确认，不覆盖其它记录。保留原 ID、nextRunAt、attempts、内容和预算。按 ID 的批量查询与 Map 回读避免全表扫描和重复线性查找。

原领取已提交而 ACK 丢失时只结算原归还。归还自身丢 ACK 则交由原 `MemoryDistillSettlementPendingError` callback 重试；它不能重新领取或调用 runtime。standalone 的原领取策略保留。原“durably admitted”用例现在区分 DB 领取与真正外部 dispatch；补一条 runtime 已发出后失权仍完成原结果、下一 bundle 不发的用例，不能以全部停止替代已发结算。

## 已编写、未执行

- 领取 ACK 期间失权：两个原 bundle 都保持 pending、attempts 不变，runtime 零调用。
- 原领取提交后 ACK 丢失：只归还原 bundle，保留原错误和队列记录，不调用 runtime。
- 归还提交后 ACK 丢失：只重试同一原归还回执，领取一次、runtime 零调用、预算不变。
- 取消与领取竞争：原取消仍 canceled，其他未发 sibling pending，不运行整个不完整 bundle。
- 实际执行回执字段变化：拒绝归还，不清除 running 与原执行事实。
- 真正已发出的 runtime：失权后完成原结果，只发一次，不领取下一 bundle。

## 当前证据与剩余

四份 TS 完成限定格式/语法/diff 静态自查，累计 136 份 TS/TSX 的语法零错误不等于类型、功能、CI 或部署通过。没有执行本机 AW tests/typecheck/build/services/E2E/实现门，没有由本会话发布这些生产候选，也没有跨 session 信息；共享 main 和并发内容完整保留。

继续完成未知物理执行恢复与恢复后继续、完整三根/十九 owner、全调用者清单和架构配套，再集中 A-G。之后按批准的 AC00/AC00B 开始各层独立 CS adapter，先 M0 首次实际部署与持久性流程，再 M1～M4。RFC 和 CS 部署仍未完成。
