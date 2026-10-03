# RFC-371：历史原生用量归属的完整读取

状态：修复候选；尚未发布或取得 hosted 行为验收，不认证正式原生 producer 已完整。

旧归属查询对一批最多 400 个原 step IDs 只取 801 行，留下前 800 行及 truncated 标记。一个原 step 具有很多归属时，会让同批其他唯一归属也被判为 budget 缺口。更危险的替代方案是直接把这个截断当 EOF：最后一页的冲突归属会被遗漏，错误修订原用量。本次不采用这种替代。

`nativeOwners` 仍在原 usage owner 的同一 SQL transaction 内，按原 current/native 索引主键 keyset 逐页读取，直到实际查询为空。500 行只是一批传输大小，400 IDs 只是原修订循环的参数批大小；它们都不限制整个历史记录、调用或任务。每个 ID 保留精确 decimal 归属计数，只有全部 EOF 后恰好一个归属才保留 candidate。两条及以上不保留任选候选，仍继续读完并给出完整计数。当前恢复 invocation 按原语义排除，不纳入旧归属计数。内存仅有这一批 ID 的归约和一页输入。

`nativeUsageRevisions` 使用这份完整唯一/冲突结果，移除 native-owner-budget 截断分支。原 root/source、owner completion、水位、scope/ancestry、模型兼容、幂等、原 revision 与合法 correction 判据保持。缺归属、冲突、未结束 owner、删除或 scope 改变仍按原具名原因拒绝数值修订，不伪造零或完整小计。

新增真实 SQLite/PostgreSQL 保留账本夹具：同一批 399 个唯一归属旁有 1,001 个冲突归属；另一个查询的最后原行在 1,000 多行之后才使 target 变成冲突。逐条验证全部 identity、完整计数、四桶及当前 invocation 排除，并核对不存在和其他 native source 不混入。这里是数据库归属验收夹具，不是实际模型任务或供应商计费证据。既有原来源/修订/捕获回归仍须同 SHA hosted CI。

仍待：AW/CS 正式 v2 的完整 baseline、持久 emission 与原 source ACK 接线，以及旧 native/span producer 的 session/part/step/depth 总量限制。不能以本查询修复宣称全部限制已去除。CS 开发 producer 保持 OFF，两个 RFC 保持 In Progress。
