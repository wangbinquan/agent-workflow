# 原生历史 writer 与 CI 接续

原 SOURCE23 v1 保留 FAIL 和三个 P2。后继使用原 Zod 3 refined schema 的 innerType().shape，并继续严格校验原 capture/Task/invocation 关联。SQLite 测试由同一原 harness 明确提供 original-native-history-harness generation；实际文件 Worker 仍使用其原 fixture generation，PG 仍使用原 runtime generation 和 max1 连接。

原 coverage 水位是 native turn，不能等同修订序号。未知输出回归继续保持旧收到输出及其旧水位，输入按原 coveredThroughTurn/turnIndex 验证；另断言 observedRevision 恰增加一次。完整/partial、原归属和重扫幂等预言均保留。

精确主 CI 37276736493 返回失败，Windows 37276917286 成功。主 CI 的原观测数字双修订回归以结构相等比较全部四桶，避免 JSON 属性顺序误判。历史评审回归明确定位只读横幅的 status，允许正文同时加载；原按钮/评论/只读预言保留。原拒绝 receipt 回归保留拒绝前 stdin 不可读、拒绝后 aborted 与排水断言，并检验 EOF 产生的文件为空，证明原 supplied stdin 未送达。

公共 native source 不再导入数据库类型；只把原事务作为 opaque object 交还 adapter。Task infrastructure 验证原 reader 接口并使用同一 transaction，既有 ledger 的 WeakMap 绑定、原读快照释放顺序和 poolMax1 不变。没有类型重导出或公共 query builder。正式 producer 仍未启用。

本机只做 26 个文件的精确格式和 lint，退出码均为 0；未执行 AW 测试、typecheck、构建或新服务。新 SOURCE、匹配 canonical、远端自身 CI、producer、CS journal 与全规模验收继续。原失败与已收到正式数字完整保留，本记录不关闭任何 RFC。
