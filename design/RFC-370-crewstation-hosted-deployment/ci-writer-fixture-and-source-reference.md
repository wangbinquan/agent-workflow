# RFC-370 CI：原 writer 持锁夹具与跨仓源码引用

## 实际失败与范围

精确 `a9d60588ef735f9b1d406f1ab88a550f338ea358` 的主 CI `38023183230` 尚未结束。Ubuntu 3/32 作业 `114128377511` 已正式失败：原 `rfc351-sqlite-write-transaction-immediate.test.ts` 的工具发布 case 在 `BEGIN IMMEDIATE` 遇到 `SQLITE_BUSY`，原三次事务尝试分别耗尽等待；该 case 实际为 4221.33ms。嵌套提交／回滚 case 通过。失败不是 `SQLITE_BUSY_SNAPSHOT`，不据此声称生产事务仍在使用 deferred。

原 Worker 在真实 WAL 写事务中更新同一工具行，发送 `locked` 后，通过下一个 `setTimeout` 回调在默认 100ms 后提交。日志证明 writer 未在原三次 BEGIN 等待内释放；日志未记录 Worker 回调执行时间，不能将具体调度原因视为已证实。

同 SHA 的 Markdown 作业 `114128377268` 因 `remaining-work.md:39` 的 CrewStation 验收文档外链返回 HTTP 503 而失败。原被引用文档存在，已只读核对本机 CS `b79253b2702c84e0bc017455a33248e23b608196` 中 `proposal/rfc/RFC-034-runtime-observability/native-real-validation-20261008.md:7–47` 的原提交、六 CI、部署和数值记录。这是原来源核对，不是新的 CS 部署验收。

默认完整 Windows `38023368643` 已全部成功，四工作区类型检查实际 exit 0、生命周期文件 53/53 通过；这些部分成功不代签主流水线或 211 次生命周期全平台执行。

## 有限修正设计

仅将原 Worker 的定时回调换为当前 Worker handler 内的 `Atomics.wait`，继续按原 `event.data.holdMs ?? 100` 持有真实 WAL writer，再执行完整原 COMMIT、close 和 `released` 消息。等待不消耗忙循环 CPU，也不依赖 Worker 下一轮定时回调；仓内 `rfc338-blocking-maintenance-worker.ts` 与 `rfc322-cpu-probe.ts` 已使用同一机制。

原父测试仍等待真实 `locked`、调用真实 `store.publishTool`、等待原 `released`，并断言原 Promise 成功、发布 revision 为 1、全过程小于 1000ms。保留 1000ms busy timeout、默认测试预算、原两个 case、全部旧 matcher、发布载荷、真实 SQL 和清理；不重跑失败测试来代替修复、不延长预算、不改生产重试次数或事务算法。父测试只补本次失败与夹具修正的说明。

共享 RFC-371 文档仅将这一跨仓外链改为带仓名、路径和已核对 CS 源码版本的文本引用。原七次调用、四桶、人民币、部署事实和所有未完成边界保持；不修改 Lychee 规则、排除项、可接受状态码或其他链接。该共享文件保留并行会话的全部当前内容。

## 验收与开放项

先完成有限独立功能设计门，再改两份原测试源码和一个原引用；保留完整旧文件快照，以精确逆变换验证未触及的原内容。实现门只审这批测试与文档、格式和静态 lint；不执行本机 AW tests、typecheck、build、services 或 E2E，无新 census。

精确发布后的主 CI 和默认完整 Windows 必须重新验收。旧失败保留；主 CI 总绿前不开始 HumanGate 实现。生命周期 211 次实际执行、完整 H7／十九 owner／三个启动根、A-T7／A-G、各层 CS adapter 与 M0～M4 部署仍开放；AW 尚未部署 CS，RFC 未完成。
