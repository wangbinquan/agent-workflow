# RFC-370 CI 接续：同一 Task 的短账本提交

包含前批的 `fc688a54cc37c2ee4df747ae81ce0dec63188bcd` 主 CI37175515154 仍为 failure；Windows37176120945 为 success。Ubuntu9 job111357952119 的原 RFC185 第二个三分片用例收到 `done/failed/failed`，原合同要求 `done/done/failed`。完整日志的服务端同秒记录38条 read/write SSI，其中包含 running/node_run_id 和失败状态 UPDATE；日志未显示参数，不能把任一 PID 唯一归到某张卡。只读快照修复已经生效，原纯 snapshot 用例通过；这不能证明并发写已完成验收。

实际 persistence.commit 的原完整操作序列仍在一笔 Resource Catalog SERIALIZABLE 事务内。其三个同 Task 兄弟事务同时读写同一聚合，十次原平台重试也可能撞在相同索引页。此次只把**同一数据库 client、同一 taskId 的短 commit**排入已有 `KeyedSerialQueue`，从事务开始前直到原事务提交／回滚 ACK 完成为止；复用同一 client 的多个 persistence 实例共享队列。不同 taskId／client 独立，load 不进入队列，Agent 的运行和并发唤醒不进入队列。

队列归 RC infrastructure，用 WeakMap 持有数据库 client，复用现有 queue 的 FIFO、拒绝后续可继续及 idle key 清理；不新增公共合同或第二份实现。原 commit 的 try/catch、CAS、操作顺序、Task host participant、原 receipts、丢失 fence 的返回、任意错误值和平台 SERIALIZABLE／10次重试均保留。仅增加围住原完整事务的队列调用，不在重试中重跑 Agent，不新增事务、轮询或后台线程。数据库仍负责多进程事务语义；本队列只减少一个 daemon 自己产生的相同聚合写碰撞，不宣称消除一切外部冲突。

独立设计门通过后实现。新增用例经实际 persistence factory 和真实 DatabaseSession：持住第一次原 transaction ACK，证明同 client/task 的第二个实例不提前进入事务；不同 Task/client 仍能完成；拒绝、lost receipt 和原 SERIALIZABLE 重试后都放行后继。fixture 的受控 PG protocol 不冒充真实 PostgreSQL；原 RFC185 三分片并发和失败不影响兄弟／最后聚合的双 provider 用例保持名称、断言和预算，在确切 SHA hosted CI验收。完整原 commit body 的 AST 逆变换验证排队是唯一功能变化，原 snapshot load 与 Task／clarify owner全文保持。

不改重试预算、测试超时、scanner、normalizer、权限规则或原失败记录。本机不运行 AW tests/typecheck/build/services。这是已批准 RFC 的 CI 修复，不关闭 A4、完整 A1～A8／A-G，也不提前进入 CS adapter 或部署。

## 设计 R2：沿用已有事务帧的重入

R1 指纹 `87701ac96261c8169cf57a8fd9e246c499ba4e055140641774da30cfde3dc4dc` 的 FAIL/P2 保留；直接把全部入口排入非重入 FIFO 会让合法嵌套 commit 自等，也会让持有 SQLite writer lease 的外层事务等待队首的外部 commit。

RC 在进入 commit 时先用现有 `db/transactionScope.ts` 的 `holdsExplicitTransaction(db)` 判断**当前 async 上下文**是否持有该 client 的原显式事务帧。持有者直接进入原完整 commit body，由原 DatabaseSession 复用该帧；不持有者才进入同 client/task 的 FIFO。此规则也适用于不同 taskId 的原合法嵌套调用，不读取全局 openDepth 来跳过别人的排队。外层 commit 仍持有自己的队列位置直到完整事务 ACK／拒绝；内层不释放队尾，不新增平台 API 或第二份重入机制。

回归分别经真实 PG 和 SQLite DatabaseSession 覆盖 hostLedger.apply 内等待同 factory 及另一同 client factory 的嵌套 commit（内层为空 operations），证明只开一笔原事务且外部同 Task 调用仍等待 outer ACK。另经真实 SQLite writer lease：外层 session 已持有事务，外部同 Task commit 排入 FIFO 等待 lease；外层此时嵌套 commit 必须完成，随后外层释放，再由外部 commit 完成。原 PG SERIALIZABLE 重试、原任意错误值和 lost receipt 后的后继均继续覆盖。测试的 await barrier 用来定位该确定性等待环，原 RFC185 案例、名字、断言和预算不改；本机不执行测试。
