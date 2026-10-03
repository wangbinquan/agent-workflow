# 全量报告正式入口与原连接运行设计

本页细化已批准的完整统计设计 v3 的 reader、派生传送和正式入口；任务、调用、数字记录、原生证据总数均不设上限。分页、TEMP 写批次、IPC 请求和 CPU 缓存只限制一次工作量，原 owner EOF 才决定完成。

## 数据与调用边界

正式入口请求一个 actor、数据库 generation、筛选条件和刷新 identity 绑定的报告。请求返回 building；同一请求合并为一个构建。报告在一个原数据库快照内选定全部可见历史 Task 与后代，逐页读取原 attempts、受理调用、原当前数字账本、平台投影与原生证明；每条原数据和每个 EOF 回执都保留到原连接的 TEMP 工作区。公开目录的软删除过滤不作为历史统计过滤。无法读取所选后代、缺数字记录或证明未闭合时，报告返回 not-ready，不能带 subtotal、Token 或金额。

原 Task owner 提供历史 population/keyset 原语。报告应用层只消费 owner 端口，不读取 Task 私有表。Agent 名字、受理时运行时名字、实际模型和价格版本来自同一原快照；母任务汇总覆盖全部后代，全局统计累加互不重叠的物理 Task 贡献，不重复相加母任务汇总。

报告的 Task、Agent、运行时、模型、用途、来源、趋势、质量与明细均先全量计算，再生成分页结果。Token、调用数、记录数、时间和人民币采用精确十进制字符串；柱形高度可用比例近似，标签始终显示原精确数值。没有价格时保留全部分类 Token 并显示未计价，金额不是零。

## SQLite 文件部署

平台为每个串行构建启动专用报告 Worker，只传原实际物理 filename、已受理 generation、actor/scope 与原 operations root。Worker 打开该原文件的只读 WAL 连接，在同一个连接内冻结原 snapshot、建立 TEMP、读取全部 owner 输入并计算。Worker 同步写入派生结果 spool；daemon 主线程不执行原文件全量扫描、BigInt 排序或 spool 编码。Worker 加入真实编译入口，丢入口、Worker 退出或取消返回 failed；没有主线程全量回退，也没有数据库副本、临时克隆或替代 SQL 引擎。

原内存 SQLite 的显式夹具保留原同一连接 snapshot；它不作为文件生产部署的回退。所有 TEMP 写入都针对固定 aw_report_workspace，原业务表只读。

## PostgreSQL 原池与 Worker

平台在实际 runtime 的原 pool 只 reserve 一条连接，先建立私有 TEMP，再开始 REPEATABLE READ READ ONLY，冻结真实 database OID、snapshot position、active generation 和 asOf。计算 Worker 不创建连接池、不接收数据库 URL，不建立第二连接；它通过窄 IPC 只读 channel 请求 SQL 编译后的原 reads，并通过固定 workspace 的 insert/upsert/get/page/clear 操作使用该同一 TEMP。主进程只异步执行原连接数据库操作；排序、覆盖、四桶/CNY fold、分页编码和物理 spool 写入在 Worker。

channel 每次验证 snapshot 仍有效、取消状态和 read-only statement。不存在任意原表写 IPC。TEMP 操作沿原 workspace 的 namespace、500 行批次和稳定游标判据，不把整个工作区或全部 Task 列表搬到主进程。Worker 返回 sealed manifest 后，平台验证原 snapshot position 未变并 COMMIT；随后释放原 reader，再进行报告缓存的短数据库事务。pool.max=1 不允许 reader 内再 reserve writer。

## 持有者与租约

构建持有者是报告记录中的 generation、id、owner 三元组。PG reader 在原 reserved connection 上先获得 observation-report/id 的 session advisory lock，验证该三元组仍为 building，才开始读取。其他进程的 expired claim 使用同一个 key 的非阻塞 transaction advisory lock；活 reader 存在时不能接管，即使耗时超过 45 秒。读完 COMMIT 后，仍在这条原连接上只刷新同一报告、owner、generation 的租约，再释放 session lock 和连接；不得为心跳新建 pool 或内层 reserve。

所有 Worker 异常退出、error、主动取消、COMMIT、租约交接及 TEMP 清理失败分支，必须先结束 IPC、撤销 active，在同一原 reserved connection 的 finally 显式释放并确认 session lock，然后才 release 归还可复用连接。正常 daemon 仍存活的 Worker 退出不能依赖进程崩溃来释锁。任一 rollback/drop/unlock 无法确认时，调用该原 reserved connection 的 close({timeout:0}) 物理关闭这一个 channel，保留原错误和清理错误；不调用 pool.close，不重开备用 pool，也不把未知持锁 session 作为可复用连接归还。若物理关闭也失败，保留异常且不 release，报告不得 ready 或宣称连接可正常恢复。原 Bun SQL reserved close 的实际单连接分支见[原运行时源码](https://raw.githubusercontent.com/oven-sh/bun/main/src/js/bun/sql.ts)；该行为还须实际原 PG pool.max=1 故障回归验证，不能以类型继承或 mock 代替。

进程崩溃会释放 session lock，旧短租约到期后可以正常重建完整报告。原快照失效、权限变化、主动取消或 generation 切换均销毁旧 TEMP；新 job 重新读取全部原源，不接续半份快照。旧 owner 的晚到 stage/publish 由数据库比较三元组拒绝。SQLite daemon 沿原单进程锁与应用 job 合并；正式 Worker 存活期间使用正常短租约续期，失去租约立即取消原 Worker。

## 完整发布与读取

spool 属于原配置的 operations/observation-reports/id/ownerHash，只有派生输出。每页最多 500 个传送 item；页序号、前页 digest、payload digest 和最后 sealed manifest 绑定完整 pages/rows/counts/receipts。原迁移正常新增五个派生报告表，不改任何原数字/采集/价格表的权威。

stage 对每一页验证连续性和重送幂等，写隐藏 rows/counts/receipts。publish 必须同时校验所有物理页、行、组数量、EOF 回执、摘要、actor/scope、generation、原 Task 可见性和平台 cost visibility；一项缺失便 failed，只有全部通过才在短事务中标记 ready。旧 ready 页不会被半份新报告替换。

页面、status 和每个 page 都重新核对当前原 actor 及保留 Task population 的可见性，并核对各平台来源的费用可见性 revision；失去任一 grant 后禁止读取旧页。页 cursor 绑定 report、snapshot、请求 scope、section、parent 和稳定 ordinal。展示一页 50/200 条不会重新选择统计 population，也不会减少 totals。时间范围或刷新改变后，旧报告数值/下钻保持失效状态直至新报告 ready。

正式统计页面及两个 bootstrap 全部切到此报告 API 后，旧同步截断接口不再作为正式统计入口。任务列表采用游标分页和完整总数，Agent 泳道、调用及贡献明细读取同一固定报告的分页输出，不用循环次数或累计行数判断 EOF。

## 有限验收

新增原双 provider 201 Task、软删除历史、窗口外子 Task、1001 attempts/calls、10001/20001 数字记录、2001 native proofs、原人民币和四桶精确核对。缺任意原行、spool 页、cache 行或声明组均不能 ready。实际原 pool.max=1 构建释放 reader 后才 stage；跨 45 秒活 reader 不可被接管，失效后重新完整恢复；取消、generation、grant、费用 visibility 和 compiled Worker 缺入口均有明确失败断言。

保留原完整 100K Task/10M usage 规模、响应性、时间/峰值内存/临时磁盘 gate，以及原 native v2 producer 的独立 EOF 完成门。本页不是这些验收的成功回执。AW 行为、类型和编译检查只由新精确 SHA hosted CI 执行；不降低已有预算、数量、断言或规则。两个 RFC 仍 In Progress，正式切换、真实任务、浏览器及 CS 本机部署完成前不得关闭。
