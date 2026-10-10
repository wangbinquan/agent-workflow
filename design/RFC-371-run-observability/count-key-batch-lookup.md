# RFC-371：完整报告分组计数按复合键批量读取

本片接续已经批准的完整统计加载性能修复。当前正式总览首次完整生成约19秒，标记验收任务约12秒；返回已有、经原GET复核的报告约193ms。后端原生采集和历史归属仍是主要耗时，本片只压缩正式结果写入中的一项开销，不代签整页性能完成。

## 原始计时与诊断

原标记报告`f426d997-4539-4fa4-8d59-bfeb0b4d18f6`保留31826条物理明细、7798份回执和14997个计数组。Worker在08:40:42.204Z完成传输封存，原报告在08:40:45.711Z完成正式发布；这段约3.5秒包括接收、写入、原资格与发布，不归因于Worker启动或某个未测量的单一方法。

仅使用Bun内置SQLite和当前Drizzle依赖，在原数据库的一个只读事务中读取全部14997组，按原500项工作批次核对全部六列、类型及排序。原逐组重复reportId的OR写法分别395.39/325.18ms，保持原select映射的复合键`IN (VALUES …)`写法147.49/253.28ms；完整摘要同为`1152c8298b704d23a3798c8edb8f1118a4e577f6b9b1e5ff48c4cfb4cc0ec262`。同一reportId移到OR外层的另一个方案约5.3秒，未采用；TEMP表WITHOUT ROWID和直接替换全部写入也未采用。这些诊断没有AW源码导入、产品测试、持久库写入或服务/任务/配置变化，不证明PostgreSQL、事务回放或正式页面已经提速。

## 有限实现

只修改RunObservability infrastructure中`completeObservationReportStageCounts.ts`的私有`currentGroups`读取条件。仍通过原`tx.select().from(observationReportCounts).all()`映射全部原列；谓词为同一`reportId`与每个完整`(section,parent)`键组成的参数化`IN (VALUES …)`，不把section/parent拆成独立集合，不直接转换数据库布尔值，不产生跨分类或跨报表匹配。

删除仅为旧OR表达式服务的`scope`/`reportScope`私有构造函数，保留`identity`、声明/增加计数的原流程、BigInt加法、原值条件、受影响行数检查及全部错误文本。上游仍从原传输页形成工作批次，全部后续页继续到EOF；不添加任务、调用、分组、深度或结果人口上限。重复声明、零组、先行未声明组、跨页更新、回放、原事务和最终人口核对保持。

这是既有provider中立业务读取，没有新的端口、跨模块import、schema、migration、执行owner、Worker生命周期、费率或产品操作。SQLite及PostgreSQL必须通过原真实provider套件；SQLite原复合键索引计划断言保留，不能改成扫描计划通过。

## 回归与发布要求

完整保留`rfc371-report-stage-batch-provider.test.ts`的四个原声明、五个参数展开用例（其中两种重复声明参数）及所有既有断言/预算，新增一个真实双provider用例：两个独立原报告；250个相同parent各有attempts/invocations两种分类，共500个完整键；先对另一报告写不同计数，再对当前报告完整写入、声明、增加、回放与零组，逐个核对两边全部计数、行数及progress。实际录制每次查找只绑定一次当前reportId，且仍用完整复合键索引；这是构造开销的确定性回归，不能以墙钟波动代替功能断言。

只为复用既有原cache给测试staging返回值新增一个cache引用，其余原测试保持。先独立有限功能设计门，再实施、静态格式/ESLint、独立有限实现门、必要的一次候选metadata核对、精确路径发布和新SHA hosted CI；不跑本机AW产品测试/typecheck/build/规模CI。正式同一范围与标记任务须核对全部物理明细、分组、回执和原分类Token/CNY后再记录实测收益。旧已知部分数值及缺口不能改变；首次报告仍慢时继续报告实际限制，两个RFC保持未完成。
