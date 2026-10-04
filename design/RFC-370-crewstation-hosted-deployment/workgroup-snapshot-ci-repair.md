# RFC-370 CI 接续：工作组账本快照读取

2c474 的 Ubuntu9 job111336216603 原完整日志保留。RFC185 的三个同成员并发分片只有 A 被调用，B/C 在 mint 与 running 账本事务中拒绝；PostgreSQL 容器原日志在同一时段显示49次 `could not serialize access due to read/write dependencies among transactions`，最终两次拒绝对应 running/node_run_id 更新。现有 DatabaseSession.serializable 已对 cause 链的40001/40P01实施10次满抖动重试；不增大预算、重跑整条工作组或串行化 Agent 执行。

源码显示 RC persistence.load 把只读的多表 loadSnapshot 也放入 serializable。其 Task hostLedger.load 和 clarify.loadProjection 均只查询；所有改变状态的操作留在 persistence.commit。只读图必须是同一一致快照，不能改为逐表普通读。所选更改只使用既有 DatabaseSession.snapshotRead：PG在同一事务建立 REPEATABLE READ READ ONLY，SQLite仍沿原transaction；嵌套调用仍复用原live frame。加载全部字段、排序、首次goal、CAS、节点铸造和最后聚合不变。

实现仅 workgroupTurnsOperations 的原 platform import 加 databaseSessionFor，并让原 load 的事务入口调用同一db的snapshotRead；原commit继续runResourceCatalogTransaction.serializable。不存在新的端口、队列、后台轮询、运行重试或拆分的Task事务。原RC loadSnapshot、Task hostLedger和clarify查询函数的全文作为控制保持，旧3成员并发、每卡独立run/result、brief隔离和聚合全部断言与预算保留。

回归直接调用真实 createWorkgroupTurnsPersistence 和 DatabaseSession，在有品牌PG客户夹具记录实际事务/SQL，host participant拿到同一tx。覆盖null和合法多表snapshot、提交仍SERIALIZABLE、读取/提交失败原样及读取ACK之前不交付。真实双provider的原RFC185及D19c套件继续作为最终行为验收。只读选择能消除该读取参与SSI的额外冲突，不能凭源码断言所有写冲突已解决；确切SHA hosted CI仍须通过，若三并发写仍失败继续取实际证据，不以retry pass验收。

这项有限设计和修复不关闭完整A1–A8/AC00/A-G，不提前开始CS adapter。本机不运行AW test/typecheck/build/service；原normalizer/scanner/预算/错误断言不改变。

## R2：上传 CI 序列化错误计数说明

META4首轮 5453d2fd946e26f1e0339e646df40de1d98468ab428617672543bae2a838c4a5 的数量文案P2/FAIL保留。上一记录的49属于宽字符串 `could not serialize access`：精确SSI `read/write dependencies among transactions` 为41行（原log4167至4331），另8行为 `concurrent update`（4114/4116/4118/4120/4122/4124/4126/4128），不是49条同一种错误，也不是重复诊断。源码、guard与原SOURCE3-META1 PASS不重开。

这些原服务端记录只证明工作组该时段存在两类序列化冲突，末两UPDATE没有参数且时间晚于首个失败输出，不能唯一映射B/C最终失败。原failed member与全测试诊断仍保留，不将读取snapshot修复当作已经解决全部写问题。a752五路径发布回执和旧WindowsFAIL/maintenancePASS已独立确认；正式新CI、完整A-G/RFC及部署仍开放。原四文档全部全文和首轮失败文字保持，只以此段限定数量与证据范围。
