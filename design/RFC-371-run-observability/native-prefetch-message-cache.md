# RFC-371 原生预读窗口的消息缓存标记

状态：设计候选，属于已批准的完整统计性能修复范围。2026-10-10。仅减少同一原始快照中的重复 TEMP 写入，统计人口与全部数值保持。

最新标记任务完整报告为 13,066 ms；原 Worker 的 native.next 累计 3,110.23 ms，原生全段 4,345.83 ms。正式总览首次仍为 14,129 ms，普通保留报告返回的 193 ms 不能代签首次构建性能。JSONB 的另一次只读原库研究比较全部 49,527 条 part 的完整字段、类型和顺序，冷／已填消息缓存都一致；SQLite 3.53.1 下原批量 SQL 400.72／427.05 ms，而 JSONB materialized SQL 486.51／481.77 ms，未改善，故不采用。首个 Python SQLite 3.37.2 因无 jsonb 函数失败，原失败保留；以上研究不证明 Bun SQLite 兼容或正式报告性能。

现行 `opencodePartProjection.ts` 把当前最多 200 条原始键的字段与 `cache_message` 标记一起预读。若一个消息尚未入 TEMP 缓存，其同一预读窗口的每行都保存空标记；`opencodeUsagePass.ts` 每成功消费一行后写入原 TEMP 消息缓存，但后续预读行的标记仍空，从而重复执行同一 `INSERT ... ON CONFLICT DO NOTHING`。标记只用于内部写入控制，原读取器已在 fingerprint 前删去它。点读回退始终重新 JOIN 原 TEMP 表，仍使用原有判断。

拟在当前 `PartWindow` 中保留已成功写入原 TEMP 的消息键集合，键为完整 `[session_id,message_id]`。仅当前预读 `rows` 存在时使用该集合；新 session、下一原键窗口或 reset 丢弃。集合只包含当前最多 200 原始行涉及的消息，没有跨 root／报告／连接／快照缓存，也不构成任务、调用或总人口上限。新的窗口继续原 SQL 与完整原始模型字段投影。

读取器保留原字段检查、measurement、字节容量、delta、fingerprint、计数、part_after、advance 的顺序。只有原消息缓存 INSERT 实际成功返回后，才调用投影器的 `rememberCachedMessage(session,message)`；写入抛错仍走原关闭及异常路径，不提前标记成功。后续返回行仍复制原 row，只将内部 `cache_message` 补为已确认的同一 message_id，所有原字段、模型、数值、顺序、root tree、ACK、成功前缀、重放和 EOF 不变。没有预先填充模型，也不把未知值变成零。

复用现有真实 SQLite 夹具及独立原 scalar SQL 预言。记录实际原 TEMP INSERT 次数，原超过 200 行／byte 重试的三种遍历保留全部断言及预算，并验证 603 个原 part／201 个 step／三条消息只成功填缓存三次。新增后段原缓存 INSERT 故障的完整 ACK 前缀与原错误、工厂清理和新原 pass 恢复，证明失败没有被标成已缓存。现有四种预读失败回退、损坏子树、连接复用和旧成功／失败回归保持。

先完成有限独立功能设计门，再实施与独立实现门。生产仅 RuntimeManagement infrastructure 两文件，原回归及 fixture 仅追加相关观测和断言；没有新增 public 接口、数据库表／迁移、配置或缓存族。必要的原架构配套只按这批固定候选生成一次，所有旧人口／规则／理由保留。静态格式／lint与发布精确 SHA 的 hosted CI 分别验收，不运行本机 AW 产品测试、类型检查、构建、服务或 scale CI。

同一已授权标记任务随后以原正式 API 重建完整报告，逐项对照 summary、全部物理明细和分组、原 native／historical 回执、正规化派生身份后的回执、四桶 Token、人民币与全部 EOF，并测实际生成耗时。没有足够实际收益则保留失败，不据源码或 SQL 研究宣称首次性能已解决。CS 发布／部署、16 Agent／Git、全类型、规模及两个 RFC 其它退出项继续开放。
