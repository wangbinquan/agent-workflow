# 原始分页的持久 owner

本批实现已批准 v2 合同中的原始分页持久化，不启动新 producer。原 daemon 继续使用已有统计链路；完整 numeric emission、baseline 历史修订、seal 与生产替换尚待后继接线，两个 RFC 仍在进行。

## 本批实际实现

Task owner 使用原 claim、原 accepted invocation 和原 node aggregate。Task fence 在 node lock 之前；收到正回执前原数据库事务必须已提交。嵌在尚未提交的外层事务内不能返回 durable ACK；异常、回滚或 absent node 都不会返回成功回执。before-spawn 操作在 root 尚未出生时也能持久 fresh 的明确 null，resume 则冻结实际旧 root。

原 read-only SQLite reader 在同一个 BEGIN 快照里读取 root 的 `time_created`，经原 Worker 的 opened 消息传递给 owner。字段缺失或不是精确时间则明确 null，仍继续读取实际 Token；不能补当前时间。根创建时间在 admission 中冻结，不在 final 时重新读取文件来证明空 before。

八个原 Task 关系保留 prepare、pass、当前 pass 指针、每个原 page、父关系与 step membership，以及后继 emission／revision 的原 ledger 映射位置。数字仍由原 observation source 与唯一 usage ledger 计账；这些关系不再贡献第二份 Token 或费用汇总。

首轮 matching metadata 检视发现根 schema re-export 子文件、子文件反向读取根 tasks 造成新增值级循环。原 no-circular 规则保持，该候选不发布。后继由原 schema 根把真实 Task table 交给八表工厂，子文件仅保留擦除的 Task 类型引用；页 owner 与测试继续消费原 schema 根。新增双 provider 实际删除回归核对原 Task 的级联关系；已有 SQL 与 PG immutable artifact 不变。首轮 SOURCE、原静态输出和 metadata 失败各自保留，不将 implementation SCC 与全仓值级 SCC 混为一谈。

owner 校验原 reader 的 payload／previous／cumulative digest、原 cursor、每页 ordinal、扫描位置、全部 cumulative counts 和原 session／step 身份。使用原始字段顺序计算与冻结，Zod 校验不替代原字节。完整 parent 索引按已存在父关系逐页建立，step 必须指向对应原 session；没有 64 层或总人口上限。lost ACK 的同字节重送返回原冻结回执；lost snapshot 保留旧页并需要新的 passId 和明确 supersedes。baseline 排除只认真实 baseline EOF，steps 输出按原身份持续分页到 EOF。

实际双 provider 回归覆盖：原 before-spawn、丢回复与重新构造 owner、未提交外层事务、10001 个 step、1025 个 session、80 层父关系、37 条输出续页到 EOF、明确新 pass 替代中断快照、改变 scope page 拒绝、已投影 source 的实际 row watermark。原真实 Worker 回归新增 root birth 传递与原快照保持；缺该列的原文件仍保留全部已知数字。测试只写入 GitHub 原双 provider 流程，本机未运行 AW tests／typecheck／build／新服务。

## 迁移与已保留的生成失败

原 Drizzle generator 的最新已提交 snapshot 只有完整报告的五表 delta，journal idx 与文件数字前缀也不同。直接 generate 因此试图重复创建全库并覆写同名 immutable snapshot。该未发布尝试保留在私有生成回执；只反向恢复本次 generator 造成的旧 snapshot 变更，完整原历史和并行内容保持。新 `0238_rfc371_native_owner_pages.sql` 只含 generator 的八个新表与三个索引，并另存新的全 schema snapshot；journal 只追加一条，旧 SQLite migration checksum 不变。

PG 通过原 append-only generator 创建 `0014_rfc371_native_owner_pages` SQL 与 immutable upgrade metadata。原 schema roster 精确增加这八个实际 Task 关系，Task owner 与其他原表的归属判据保持。没有修改 PG baseline、旧 journal、既存 upgrade 或业务数据。

## 接线边界

本批的 class 只实现 `NativeUsagePersistence` 的页与 membership 部分，没有 stub emit／seal 或伪 ACK。旧 v1 文档继续读取，原 invocation 合同新增可接受的 v2 标识，但正式 runtime 尚不选择它。独立有限 SOURCE、匹配的原静态生成和 exact-SHA CI 必须确认此候选后，才能继续原 source allocation、baseline 对照和实际 runner 替换。100K Task／10M usage 实际规模验收尚未完成，本批 10001-row 原始读取测试不能当作该验收。
