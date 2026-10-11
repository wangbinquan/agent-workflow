# RFC-371：减少完整原生遍历的重复状态读取

接续已批准的完整统计与加载性能工作。2026-10-11 原正式报告 `30919d6d-f7d9-47c3-9975-de89518e2b42` 封存耗时 12,011.36 ms，其中原生采集 6,094.46 ms、原生 next 4,138.98 ms、历史归属 2,777.85 ms。新的时间范围仍未达到加载目标；已有报告的快速重入不能代替首次生成验收。

原库只读 EXPLAIN 确认 part/session/message 使用原索引。当前 reader 每处理一条 part 都再次 SELECT 同一 TEMP queue 行，尽管本 reader 刚写回了 entered、parts_done 或 part_after；报告工厂每个根释放时还 DROP 三张 TEMP 表，下一根重建表和索引。此次只减少这两类内部重复开销，修改限定 RuntimeManagement infrastructure 的已有 reader 和报告内连接工厂；不新增公共接口、数据来源、应用缓存或运行配置。

## 本包内的当前游标

每次 next 调用最多保留一条当前 queue 行，首次仍由原 `WHERE done=0 ORDER BY id LIMIT 1` 获取。原 entered、parts_done、part_after 的 UPDATE 仍在完全相同的成功位置执行；成功之后同步这一条本地行的相应字段。原数值投影、message cache、open_steps、计数、指纹、错误、页容量和 ACK 语句均保留。

当前会话结束、发现子会话后，必须立即丢弃本地行，下一次继续使用原 SQL 排序选择 queue。子会话 ID 可能排在父会话之前，不能把父会话整棵子树改为不同遍历顺序。next 返回之后本地行即释放；下一页从已写回的原 TEMP 游标重读。超过 pageBytes 的当前原行仍未消费，pending 回放仍返回冻结包。此优化不延后、合并或删掉任何原状态 UPDATE，不改变原数值投影的错误前缀或持久 ACK。

## 原报告连接的 TEMP schema

原独立 reader 仍创建自己的 TEMP schema，物理关闭时自然释放。报告工厂复用同一物理连接时，原三表和 queue 索引改用 `IF NOT EXISTS` 创建；每个根依然有原独立 BEGIN、快照、根读取、计数和 reader 私有状态。只有已完整 EOF、最终 ACK 和 COMMIT 成功的根才 DELETE 三表全部行并保留 schema。提前关闭、初始化失败和读取失败继续执行原 ROLLBACK 及 DROP IF EXISTS 三表的完整清理，避免首次事务内创建的表被 ROLLBACK 撤销后误复用；只有完整清理成功的连接才可复用。

初始化失败沿用原 ROLLBACK 和 DROP TABLE IF EXISTS，表不存在正常跳过，完整清理成功仍可复用原物理连接；只有清理失败、工厂关闭或多余闲置时关闭连接，不能把旧 root、模型、open_steps 或游标带给新根。文件 generation 变化仍丢弃旧连接；它不是 WAL 内容版本，不缓存或跳过新根的原数据。每个根实际读空的 TEMP 数据表；只保留同工厂、同物理连接的表定义和已准备语句。并行 reader 仍各用独立物理连接。

## 回归与发布验收

保留所有已有原 reader、连接复用、坏 JSON、message/字节预算、1201 根、60002 parts、10001 steps、1025 sessions、80 层深度、Worker 案例和超时。原真实连接清理失败夹具同时覆盖新的 DELETE 操作，原异常回归仍触发原 DROP 故障，保持原失败后的关闭、重新打开和数值断言；补充完整 EOF 后 DELETE 故障必须丢弃连接的回归。新增真实 SQLite 回归使用独立原 scalar SQL/EOF 指纹核对多页、重复根和子节点提前排序；以真实 SQL 次数验证 queue 不再逐 part SELECT，以 TEMP schema version 验证同连接未反复重建 schema。输入、缓存读取、缓存写入、输出、模型、时间、计数、issues、pending 回放和完整 EOF 均须保持。

先有限独立设计门，再实现、独立功能门、一次最终候选原架构配套、精确提交及 hosted CI。既有 RFC-371 工作授权覆盖这次性能修复；不运行本机 AW tests/typecheck/build、新服务或 observability-scale。正式原服务在固定时间范围重新生成完整报告，所有集合和明细遍历到实际 EOF，并与原四桶、冻结人民币费率、身份、缺口及完整计数逐条核对，再记录实际总耗时及原生阶段耗时。仅 SQL 次数下降不能写成页面加载已达标；首次生成仍开放，两个 RFC 仍 In Progress。
