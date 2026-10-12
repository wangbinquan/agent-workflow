# RFC-371 原完整报告传输批次落库

本片承接已批准的持久用量与性能设计中“按实际慢点批量派生写入”的步骤。当前热报告 10,370.125 ms，原 stageBatch 事务合计约 2.97 秒；Task 数值复用不能代签周期性能完成。这里只减少同一原八页批次内的重复数据库往返，不改变来源、归属、人口、报告协议、原快照、统计限制或主服务创建方式。

## 原实现与有限改动

`completeObservationReportService.ts` 已把所有原 transfer pages 按八页送到一次 `stageBatch`；完整后续页持续至 EOF。`completeObservationReportStage.ts` 当前在这一次事务内仍逐页重新读取相同 report/progress、更新相同 group counts、分别写 pages 和 progress。`completeObservationReportStageCounts.ts` 的批量精确键及任意精度 text count 保持。

在原 `stageCompleteReportPages` 的同一事务中只读取一次原 owned report。逐页仍依原 ordinal、previousDigest、digest、全部 items 和 replay 规则校验；旧封闭页只验证后跳过，新页继续原 progress 链。同批已接受的新页也登记到原页身份集合，后续重复页按相同 replay 判据跳过。空批次保持原无读写行为。每个新 row 的 ordinal 仍为 page.ordinal \* 500 + 原 item index。所有 receipt、row identity、count declaration 和新的 pages 均保留，重复行或回执继续由原主键拒绝。

新页的 group 实际行数以 BigInt 在批次中按原 section/parent 合并；全部 count declaration 先对整批检查原 duplicate 判据，已有 declared 的拒绝仍交原 helper。每个聚合后的 group 只处理一次，原 declaration 和精确 group count 分成每包不超过 500 组的 I/O 包，逐包调用不变的原 helper，保留原单页 500 组的 lookup、insert/update 形状和预算；跨包重复声明不能被分包掩盖。原文本精度及原 undeclared/zero group 状态保持。行／回执／页按 200 条 I/O 包落库，旧页 lookup 亦按不超过 500 个 ordinal 的包执行。所有包留在同一原事务，包大小不限制总人口；任意较大的调用持续到全部完成。单个原页仍通过原同一入口。progress 只在全部成功后以原最后 digest 与完整 pages/rows/counts/receipts 写回一次；任一页校验、重复或落库失败仍回滚本次原全部事务，先前封闭页保持。

不削减原 `publishCompleteReport` 的完整物理 population、各 group 的 actual/declared/total、Task 成员与原封闭验证。无损源异常传播、原 owner 不匹配行为、完整 replay、取消与原 reader 释放次序保持。此处没有新的模型调用、后台服务、迁移、原数据改写或统计总量上限。

## 功能预言与交付

保持 `rfc371-report-stage-batch-provider.test.ts` 全部原用例、断言、数据和预算；新增真实 SQLite/PostgreSQL 多页一次批次：原行、全体 parents、零组、receipts、ordinal、progress、mixed replay/new pages 与同批 replay 的 EOF 内容逐项比较；跨页及跨包 duplicate declaration、末页坏 digest 或重复 receipt 拒绝时原事务完整回滚。追加超过八页、分组 SQL 原单条容量的完整大批次，核对全量声明、行、封闭页和精确 progress，不能新增总量上限。实际 SQL 记录核对一个批次只一次原 report 读取／progress 更新，每个精确 group 只进入一个相应 I/O 包，避免只比较最终汇总而漏测试重复往返。

有限设计功能门通过后才修改这一个原生产文件并追加原 provider 回归。代码不运行本机 AW test/typecheck/build/E2E；源码功能门、必要原 census/MATCHING、新确切 SHA 的主 CI／默认完整 Windows／新增实际用例，以及原验收报告的全字段 EOF 和实际耗时分别验收。性能未实测达标前保持开放；准备、关联、范围查询复用和重启内容指纹继续独立完成。
