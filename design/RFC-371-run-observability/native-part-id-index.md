# RFC-371：在原快照内索引原生 part ID

正式操作计时显示 native.next 为6262.77ms，原 native.open 659.46ms；所有 TEMP workspace 方法合计约2842ms，开连接不是主因。原库 `part_session_idx` 只有session_id，逐条 `session_id=? AND id>? ORDER BY id LIMIT 1` 的真实 EXPLAIN 为扫描session索引并临时排序。代码原“composite-index range”注释不能代替原库能力。

1730个直接根、37113个part、8717个消息的同快照原字段只读对拍：原读法5161.95ms，临时ID索引读法2264.03ms（建索引309.24ms）；13个原字段完整EOF摘要均为 `7dfd4c65a13dd76f2cb37146a8d67c7d52563d98080cd080999d876b63311a1c`。此处仍不是正式整页提速或子树协议验收。

首版实际报告 c458c44e-b25b-4a37-8e33-5a18f657e1e4 为22128.40ms，native.next7406.61ms，未优于操作计时前态20687.39ms／6262.77ms；全部37533明细／16259组／12集合31页EOF与四桶、人民币逐条一致。整session语法资格与额外TEMP生命周期抵消了索引收益，首版不能作为提速交付。

## 实现边界

只扩展RuntimeManagement infrastructure已有报告historical factory的私有读选项，报告启用该路径，baseline/final/独立历史公开旧入口继续原查询。每个根仍在原BEGIN中读取同一原native文件。原文件、原表和索引不改；新增三个FILE TEMP表：part IDs、session是否可使用索引的标记、按message/session缓存的JSON语法资格。索引只含session和原id；语法资格仅true/false，不含body或预先提取的数值/模型。连接释放时完整删除这三表，再遵守既有回滚/3表清理/闲置复用生命周期。

仅实际 part.id 为原单列TEXT主键、原投影所需原列仍存在时启用。无法证明此结构则沿用原WHERE/order/LIMIT读法，不将不同schema或无PK夹具变成不可用。缓存ID列不设转换类型或NOT NULL约束，保留原异常ID；标记只约束重复建索引，无根数/行数/深度/任务/调用上限。

每个原session在首次读part时，先做完整语法资格判断：所有原part ID均为非空text，所有非NULL原part.data可由原SQLite的json_valid确认；原session实际匹配的各distinct message/session正文也均为NULL或json_valid确认。消息语法按原双键缓存且每个不同原消息只检查一次；不提取或缓存任何后续Token、type、模型、时间或步骤。存在任何坏JSON/异常ID、不同schema或资格查询自身无法完成时，该session永久沿用原字段/WHERE/order/LIMIT查询，不把“未知”当有效，不伪造完整性。

后继只调整读法选择的成本：每个session首次读part，以原快照内完整COUNT判断是否至少64条；不足64条直接沿用原逐行查询，全部记录仍读至原EOF。64仅选择算法，不限制读取、页面、人口或贡献。使用一个报告根内的当前session/读法标记避免每条重新COUNT；session的part遍历在child发现之前连续完成。只有达到此条件的session才延迟检查原schema、建立三个TEMP表并执行上述完整语法资格；大session、异常输入与未知资格的所有原语义保持。无需为1730个小根预先建/清理未用的三表。schema无法证明原BINARY单列TEXT主键/单消息主键则原查询；不改变原collation或多消息匹配行为。后继正式报告仍必须单独测量，不能用前态对拍预测收益。

仅已证明无投影JSON异常的session完整复制其ID到TEMP索引并标记；随后以原顺序、原after从索引取一个ID，再用原字段/CASE/message与model-cache joins及原session/id取这一条main原行。空ID集合仍执行原字段查询以保留投影/schema错误。不提前累计步数或fingerprint，不新增ACK或跳过原part。原ID由同一个冻结main快照产生，实际回取仍是main原行。

初版设计门P2-01指出旧TEMP排序可能先投影未来候选。明确反例：先插id=b坏JSON，再插id=a合法step，pageRows=1，session页ACK后旧next会在b投影报错，未返回a。修订以整session语法资格关闭这类fast路径，实际回归须以旧查询错误和全部已ACK页作oracle，证明此输入没有额外a页。同样覆盖坏message及已有已知前缀的后续坏JSON；缺口、失败页、ACK与部分已知事实不变。资格检查仅决定读法，失败不是报告的新issue，也不推进游标。

## 正确性与验证

原root/session/part/child fingerprint、所有4桶与模型/time/issue、part/start/finish计数、row/byte边界、pending重放、ACK与EOF判据保持。原每session复制ID只是派生索引，不贡献报告字段或完整性资格。复用6套真实SQLite/WAL生命周期回归及独立完整原字段oracle，新增单session2501part全文EOF、后续坏JSON必须在原页/扫描位置失败、无PK异常ID旧fallback、多个session相同message、不完整step与分页byte边界回归。覆盖默认旧入口和新报告入口相同输出/原EOF摘要，并核对SQL真实使用TEMP复合范围与main原主键查询；不只检查helper自己的计数。

按既有已批准性能修复做限定设计/实现双门，保存原正式操作计时与只读SQL对拍。对新候选在原后台发起一次同范围正式报告，再核对37533原明细、16259组、全部12集合31页EOF、分类Token及人民币完全相等后才报告实际收益。本机不跑AW产品测试/typecheck/build/新服务/规模CI；最终hosted CI、正式页面与两个RFC仍单独验收。

R3实际完整生成20662.24ms，native.next6536.35ms，与操作计时基线20687.39ms/6262.77ms接近，未证明整页性能改善；同范围37533明细、16259组、12集合31页EOF与原四桶及CNY全部一致。实现门P2-01发现part引用列NOCASE时JOIN前DISTINCT可合并M/m、漏检实际匹配的坏消息。先执行原双键JOIN的修正及64条原part/M/m/后继坏JSON对拍仅保存在私有实验归档，未取得新实现门通过，不能视为正式代码。

本次发布不采用该索引实验，已仅撤下本会话的索引 helper、读法和新增实验用例，并按完整冻结字节恢复通过独立功能门的v16原读取/连接生命周期与6个用例。原日志、失败门、实验代码与全部对账保留；没有改动供应商原库索引。首屏恢复和连接复用另行发布，本文件仅记录未采用的性能方案，不能作为已落地或提速证明。
