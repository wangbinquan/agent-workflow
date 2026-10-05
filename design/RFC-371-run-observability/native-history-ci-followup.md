# 原生历史 writer 与 CI 接续

原 SOURCE23 v1 保留 FAIL 和三个 P2。后继使用原 Zod 3 refined schema 的 innerType().shape，并继续严格校验原 capture/Task/invocation 关联。SQLite 测试由同一原 harness 明确提供 original-native-history-harness generation；实际文件 Worker 仍使用其原 fixture generation，PG 仍使用原 runtime generation 和 max1 连接。

原 coverage 水位是 native turn，不能等同修订序号。未知输出回归继续保持旧收到输出及其旧水位，输入按原 coveredThroughTurn/turnIndex 验证；另断言 observedRevision 恰增加一次。完整/partial、原归属和重扫幂等预言均保留。

精确主 CI 37276736493 返回失败，Windows 37276917286 成功。主 CI 的原观测数字双修订回归以结构相等比较全部四桶，避免 JSON 属性顺序误判。历史评审回归明确定位只读横幅的 status，允许正文同时加载；原按钮/评论/只读预言保留。原拒绝 receipt 回归保留拒绝前 stdin 不可读、拒绝后 aborted 与排水断言，并检验 EOF 产生的文件为空，证明原 supplied stdin 未送达。

公共 native source 不再导入数据库类型；只把原事务作为 opaque object 交还 adapter。Task infrastructure 验证原 reader 接口并使用同一 transaction，既有 ledger 的 WeakMap 绑定、原读快照释放顺序和 poolMax1 不变。没有类型重导出或公共 query builder。正式 producer 仍未启用。

本机只做 26 个文件的精确格式和 lint，退出码均为 0；未执行 AW 测试、typecheck、构建或新服务。新 SOURCE、匹配 canonical、远端自身 CI、producer、CS journal 与全规模验收继续。原失败与已收到正式数字完整保留，本记录不关闭任何 RFC。

## Windows 原事件与 bootstrap 回归接续

历史 writer 已以 c29b128852b6e9934d3597fc6dcdeda268b5a8fa 发布，正常 matching 许可退休后主干为 057e1c6d51be26505c9d55e1abee9f7700ed57c0。该 SHA 的 Windows 37287891770 实际失败两项；visual-regression-nightly 37287891768、maintenance-soak-nightly 37287891769 成功，主 CI 37287891777 尚未终态。

Windows 的目录创建事件可能在 Bun.write 写入 started 内容之前到达。测试现在等待原文件内容恰为 started，再触发拒绝 receipt；保留 aborted、拒绝前未消费输出／stdin、拒绝后没有 supplied stdin、原排水和 raw stdout 相等断言，不增加睡眠或重试。

bootstrap AST 原先只允许 composeObservationUsageSource 的单个 db 参数，未跟随原历史 Worker 接线。现在逐入口验证原 db、实际 SQLite 文件 generation 和 PostgreSQL runtime 的 nativeHistoryRead 第二参数；server 既有 fallback 仍为单参。共享测试内并行调用绑定检验完整保留，原 material/effect 与新 invocation 两种受理方式分别执行相同环境和 requireSpawnReceipt 断言，不收编其未提交生产文件。

本片只改测试、本文和共享 STATE 登记。无生产源码改动、无新增内存数据库 fixture 或架构预算许可；13 个 canonical 与129项 inventory 沿用原 matching。仅两测试文件格式／lint 已通过；未运行本机 AW 测试、类型、构建或新服务。新有限功能门与确切 SHA CI 继续，producer／全规模／两 RFC 均未关闭。

## 首次 capture 空值与原静态入口补齐

主 CI 37287891777 的已终态失败作业还指出：首次 v1 capture 没有旧记录和 v2 valueFingerprint，两个 undefined 相等时进入了 previous.history 分支。这是本会话历史 writer 引入的回归；后继保留比较与所有原数字，只把实际读取改为 previous?.history。原双 provider 完整 capture 回归额外核对首次空页、没有伪造 history，以及同一原101条证据重送后逐字段相同；其他原统计、修订和 runNode 用例全部保留。

原 TypeScript 的完整 parent 读取需明确 parentKey 和 parent 行类型；追加实际 schema 的类型标注，不改完整父链遍历或4096缓存淘汰语义。移除没有实际外部 consumer 的 NativeHistoryStep public 类型转出口，原内部定义、实际公共 source 的方法形状、NativeHistoryPreparation 与全部消费保留。

原 nativeHistoryRead 在平台的两个明确 provider 分支逐项登记为 fenced-dispatch，既有语料计数及未知 provider 的 never 汇断言保留。PG bootstrap 全相位快照沿已实际取得的9130fad6更新，仍核对原语句总数、排序和全部组合句；独立入口 AST继续精确验证原DB/generation/runtime，不用摘要变更遮住入口丢失。未改变 provider classifier、fixture债、测试筛选、断言预算或超时。

本增量只做六个精确文件的format／lint。实际用例与类型交确切SHA hosted CI；原失败日志全部留存。必要的 matching 产物在共享发布窗口结束后按已提交基线和本批精确候选由原生成器计算，不覆盖其他会话的13份在制产物。正式页面已记录123,238分类Token／¥0.16583并可完成刷新，该页面事实不代替新的首次写入/重送验收，producer/全规模/RFC仍开放。

## 059a845f 确切 CI 的后继修复

原 CI 37298075490 的 lint/types/format、生产二进制构建、前端与静态作业已通过，整次运行仍 failure；原报告和7个后端失败日志保持。后继3cade06f已修正编译材料绑定后的 cwd/env文本预言和原offered DAG登记，但不能代替其尚未结束的CI。

本批修复真实原direct receipt拒绝中的 stdin 时序：agentProcess 原callback捕获异常后会abort原signal，managedProcess 在await回来时仍按activationFailure=null投递stdin，CI实际收到must-not-deliver。现在同一原进程在投递前核对实际signal，拒绝后的TERM/KILL/reap/输出drain保持；原红用例原样保留，增加真实direct callback期间取消的回归。正常ACK与ownerless运行、Task launcher的原收据语义不变。

另两处修正保留原断言：原spawn binary/PID文本预言跟随已提交调用recordTaskReceipt，仍核对实际native/projection字段；40K行归档原PG用例明确按id升序查询留存尾部首行，原35000归档/5000留存/JSONL边界与原数值预言全部保持，不能依赖PG无ORDER BY的任意物理行顺序。

本机只运行这些自有文件的format/lint，测试/类型/构建继续只由hosted确切SHA CI验证；不会用重跑或删除断言把原失败当绿。完整原生v2 producer/before/final/platform/seal和100KTask/10Musage继续，两个RFC不关闭。
