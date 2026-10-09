# RFC-371：同一原生快照内复用消息模型字段

本片接续已批准的完整统计加载优化。正式固定范围生成仍约25秒，原生完整遍历约9.75秒；不缩减任何任务、调用、原生节点、part、step、回执或历史歧义人口。

## 实测与边界

原库只读 SQL 对照1730个已完成根的直接 part：37113行，原始完整字段读取3873.30ms；同一读取事务内复用已经成功解析的同一消息模型字段后1930.81ms。所有原字段顺序的完整摘要都为`7dfd4c65a13dd76f2cb37146a8d67c7d52563d98080cd080999d876b63311a1c`。这只是原库读法诊断，不代签正式完整子树、原协议或整页性能。

## 实现设计

只在 RuntimeManagement infrastructure 的既有`opencodeUsagePass.ts`内部，给每个原 reader 的独立只读连接增加磁盘 TEMP 表`native_pass_message_models`。键为原`message_id/session_id`，provider和model两列不设类型亲和，保留原SQLite JSON标量。它只缓存本次同一BEGIN快照中已经成功读取的字段，随原连接关闭一起消失；不跨root/reader/报告复用，不配置供应商、当前模型或新费率，不修改原文件、索引、公有端口或持久表。

原 part SELECT、完整字段表达式、原 LEFT JOIN message、session限定、ORDER BY id/非空游标/LIMIT1保持。在原消息关联之后增加按完整双键的TEMP LEFT JOIN。命中已读取缓存时直接取原provider/model标量；未命中仍在同一原SELECT位置执行原两个CASE/json_extract表达式。所有part的原字段都照常读取并参与fingerprint，不跳过非step记录，不提前批量解析下一条消息。缓存存在的标志独立于值是否NULL，缺失消息、非assistant、非法模型标量的原NULL或值也保持。

查询额外返回一个内部命中标志，必须在组装原PartRow和fingerprint前剥离：原字段名、字段顺序与JSON对象不变。只有原part已经完成数值处理、fingerprint/人口更新及原part_after写回后，才把未缓存消息的原provider/model插入TEMP；身份非空字符串的原检查只决定能否缓存，不改变原字段读取或错误判定。后续part同键仍沿用同一个源快照。TEMP按原session/message主键查询，全部消息落磁盘，没有人口上限，SQLite页缓存仍可淘汰。

保留原各root的BEGIN、COMMIT、close和异常finally、TEMP树/未完成step计数、遍历顺序、所有issues、session/part/step人口、fingerprint、页面byte/row容量、ordinal、pending重放、原ACK、EOF和异常处理。包的row上限只约束一次传输工作，不限制完整人口。该优化同时用于既有baseline/final与historical reader，原两身份合同及所有读者全文回归保持。

## 回归与验收

新增原真实SQLite reader回归：按未改的原字段SQL独立构造完整fingerprint，核对超过1200个part、重复消息、缺失消息、不同session同message、非法模型标量、NULL、非assistant、非step及四桶；核对小packet/byte边界、pending原重放和ACK、完整多层子树及所有人口。原writer在reader打开快照后更新模型并写新part，reader仍只观察原快照；新reader观察新值。损坏消息JSON仍在首次原字段消费的位置失败，损坏子会话不被前一正常会话的缓存掩盖。原已存在的native reader/worker/owner/历史共享归属断言和预算逐字保留。

只跑精确格式/lint和静态独立功能设计/实现门，本机不跑AW产品tests/typecheck/build/新服务。新增回归登记现有Windows精确触发和原测试命令；正常上库的确切SHA CI实际执行。正式原后台固定范围重新生成，全部37533物理行、16259分组、全部集合至EOF、四桶、CNY和原缺口逐条对账，再给出整页耗时；没有实测提速不能宣称加载慢闭合。两个RFC的剩余工作不由这个局部优化代签完成。

## 正式固定范围实测

当前候选在原后台生成报告`b13eb1db-a4aa-40f2-b26d-98639842001f`，相同时间范围、相同验收身份，一次标记请求正式终态22118.66ms，首个已写发布页16605.61ms。对比最初原报告30045.44ms，以及此前VALUES候选25052.50ms，首次生成有改善，仍不能写成加载问题完全解决。

独立只读完整核对37533条物理明细与16259个分组，包含范围外历史关联/版本；12个顶层集合31个显示页全至EOF，全部身份、字段及分组计数逐条相同。137任务/595尝试/446调用/198历史引用、非缓存输入1189241、缓存读1255680、缓存写0、输出186002、总2630923及已记录人民币4.078952、全部原缺口保持。完整接口响应与所有分页也未丢数。原探针和正式验收材料只读保存在本机`observability-aw-load-diagnosis-20261009-v1/same-scope-api-native-model-cache-v14`，不提交账号凭据或真实任务数据。

四个新增真实reader回归、精确静态检查、独立有限实现门及新SHA hosted CI分别记账。旧两份native原回归全文和全部预算保持；Windows只增加本次source/test精确触发及一个原命令参数，完整并行RFC-370的17引用保留。不重新触发规模CI。
