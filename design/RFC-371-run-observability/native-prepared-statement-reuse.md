# RFC-371：报告内复用原生 SQL 语句

接续已批准的加载性能工作与 native-traversal-state-reuse.md。真实原服务的 `3d34879b-b2bc-4730-b4ee-858c8dd2584f` 在固定时间范围完整生成 137 个任务、595 次尝试和 446 次调用；采集／封存 10,437.32 ms、创建至可读 13,670 ms，尚未达到页面目标。原生 next 1,849 次共 3,166.53 ms，整个原生阶段 4,263.32 ms。此前失败、未就绪的来源缺口及所有原完整统计保留。

本机 Bun 是 1.3.13。该版官方 sqlite.ts 的 query 第 519–560 行只缓存最初 20 种 SQL，之后新 SQL 每次 prepare，未缓存的 Statement 返回给调用方仍可重复绑定执行。本 reader 的根／子节点／游标／step／模型／投影及 TEMP 初始化包含更多 SQL 形态。此前保留 TEMP schema 仍不足以保留这部分编译结果。来源：`oven-sh/bun` 标签 `bun-v1.3.13`，`src/js/bun/sqlite.ts:470–560`；官方文档 `bun.sh/docs/runtime/sqlite` 的 query 段亦区分编译缓存与结果缓存。这里只提出减少已识别的编译开销，不预签实际页面提速。

## 复用范围

在既有 OriginalNativeConnection 内保存按完整 SQL 文本索引的原 ReadonlySqliteStatement 对象；只能来自该同一原只读物理连接。query 首次成功返回后保存，后续返回同一个原 Statement。每次原 get／all 仍以本次参数实际执行，不保留返回行、数值、模型、JSON 资格、查询错误或 EOF，不共享至别的连接、工厂或报告。动态参数仍由原语绑定，数据遍历和输入总量没有新上限。缓存大小由本 reader 的有限 SQL 形态决定，不按任务、调用、part 或 session 增长。

BEGIN／COMMIT／ROLLBACK 的 lease 包装每次仍新建，保留成功执行之后才更新的原 transaction／committed 状态；缓存的只有底层 Statement，不能缓存包装或别的借用者状态。准备 SQL 抛错时不登记缓存，原错误继续传播。

## 清理与新快照

成功 EOF、最终 ACK、COMMIT 后仍执行原三表 DELETE 并保留 schema 和该连接的编译结果；下一根仍原 BEGIN，全部实际查询重新执行。未成功 BEGIN、初始化失败、提前关闭、读取失败仍采用已批准的原 ROLLBACK＋DROP IF EXISTS；不成功提交的 lease 必须清空 Statement 引用，包括一次故障夹具返回的 Statement，避免原故障状态延续至下一根。清理失败、文件 generation 改变、多余闲置及工厂关闭仍走原 discard；discard 先释放全部缓存引用，再调用原 database.close。闭合工厂仍传播原物理关闭错误，不能替换原根／解析失败。

缓存只保留原 .query 返回的对象，Bun 仍拥有其数据库原语生命周期。释放引用不增加一个新的 finalize 公共接口、不改变其它数据库或全局 MAX_QUERY_CACHE_SIZE；实际资源随原只读句柄／原 Worker 结束释放。并发 reader 使用原独立物理连接，各自缓存和快照隔离。

## 回归与验收

保留六个原连接回归、此次四个遍历／初始化回归的原正文、数字、EOF 和预算。可观察夹具分别记录真实 query 调用（准备）及真实 get／all 执行，原 queue SELECT 次数必须按实际执行计数，不能通过缓存后减少 query 调用伪造队列优化。新增真实 SQLite 原根＋分叉完整回归，准备数量必须在同一连接重复读取后不再增长，所有四桶／模型／时间／counts／issues／独立 scalar EOF／pending 回放保持，另一根使用新参数且返回自己的真实数值。已有同 generation 下 WAL 修改与 BEGIN 失败后的同句柄恢复继续覆盖不缓存结果／错误。

有限设计门通过后实施，再做独立有限功能门；最终源候选只执行一次原架构 census／配套，不为移动 HEAD 重跑。精确提交及新 SHA hosted CI 分别验收，不运行本机 AW tests／typecheck／build、新服务或 observability-scale。随后在原正式服务同一固定时间范围重新生成完整报告，根集合和维度明细全部到 EOF，全部 staged rows／counts／原始 receipts 和四桶／人民币逐条对拍，并记录真实阶段和可读耗时。未达到页面目标则继续保持性能工作开放。
