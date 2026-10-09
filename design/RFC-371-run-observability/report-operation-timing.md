# RFC-371：完整报告逐类操作计时

相同正式范围的连接复用候选仍为22195.27ms；所有37533明细、16259组、12集合31页EOF及分类Token/人民币与原报告一致，但没有明显提速。不能用原SQL诊断的收益代替产品结果。下一步只测量原调用链的实际开销，再选择优化，不修改统计人口或失败语义。

## 范围与接线

沿用已存在的 `load-performance-` refreshKey 开关。在 RunObservability infrastructure 的既有 performance observer 文件增加独立的操作累计计时器，由原 `composeCompleteObservationSnapshot` 包装它收到的原 TEMP workspace 和 historical native query。只转发原方法、参数、返回对象与异常，executor、原文件/快照、分页、ACK/EOF、费用、汇总、所有记录保持。常规请求不创建计时器、包装器或额外日志。

累计记录 workspace 各方法、native 的 open/next/acknowledge/generation/close 的调用次数及耗时；方法名集合由接线固定，计数用BigInt字符串，不记录参数或文档。同步next/ack仍同步，异步读写仍await其原操作。原操作放在try/finally中，失败也累计其时间，原抛出的任意值继续原样抛出。测时/记录/输出自己的失败一律只丢弃诊断，不能让原操作消失、重新执行或转换失败。同步/异步调用都恰好执行一次。

collector原phase observer保留。累计日志在原composition的finally一次性输出每个已调用方法的摘要，不逐记录写日志；不开新服务、任务、数据缓存、事务或公开端口。报告发布段继续依据已经取得的原数据库stage进度测量，暂不修改其事务和lease协议。

## 验证

新增有限测试锁定：无开关时不启用；真实同步返回/异步返回与原拒绝值透传且只调用一次；失败操作也计时；坏clock/emit不能影响原操作；完整方法累计不丢次数，flush幂等；既有phase observer断言和预算保持。静态检查与hosted CI分开记录，不运行本机AW产品测试或构建。原后台同范围仅发起一次明确标记的正式报告，记录实际累计时长，并继续与全部原明细/分组/分类Token/人民币核对。计时本身不记为性能修复完成。

设计与实现分别做限定功能复核。此片属于已批准的完整统计性能排障，不扩大两RFC的功能范围。
