# 原 v2 source 到唯一用量账本与完整报告

本片落实已批准的 `native-owner-pages-v2.md` 正式解析／投影部分；producer 激活、历史修订 writer、CS 原 journal 接线和 100K Task／10M usage 实机规模验收仍开放，不能标记 RFC 完成。

## 实际来源与事务

Task 的现有原 accepted invocation／prepare／immutable page／parent membership／emission／frozen ACK 是唯一 v2 来源。新的 `observationNativeScopes` 通过现有 Task facts 和 observation usage source public seam 提供原 reader；没有另开连接、生成 claim 或从界面猜父关系。每个 v2 source frame 的原 row、Task／node／nativeSource、冻结 payload 和 ACK、真实 source watermark 与全部 measurement 必须逐字段匹配。ledger cursor 只能沿原 node-event 水位前进；重放沿原 event/revision 幂等，无法把旧页退回为当前水位。

唯一账本仍是现有 `createUsageIngestion` 的 source/root lock 与 transaction。核对原 source 后，全部 measurement 的 v2 scope 在原完整父索引上验证，存下实际 depth／path digest／source generation；不把页引用转换成 64 项数组。后续页的真实 ACK 可以前进，语义 session、parent、root、turn、level、实际完整父链及原 binding 保持时不产生虚假的 identity-conflict。缺原索引、父链冲突或 source 变化均不能确认 delivery；已经提交的数字不由 completion 是否完整决定。

原 source 的入账前核对沿原 reader；入账 transaction 内的 scope／父链读取必须由 infrastructure 绑定到同一真实 transaction handle，按 transaction 缓存该 reader。不能在持有 PostgreSQL 唯一连接时再从 root pool 取连接。新增真实 PostgreSQL `poolMax: 1` 投影回归沿原 Task／accepted source／page／冻结 ACK，完成实际 ledger transaction、delivery ACK 与完整报告四桶；SQLite 同用例保持原数据库路径。

原 SDK/v1 `ObservationMeasurementSchema.shape` 保持，用量帧另接受严格 v2 measurement／completion／process union。损坏的可选 trace 元数据仍隔离，不影响合法数字；原 numeric parser 同时核对 outer invocation 和 mutually exclusive capture 合同，不能借 trace 损坏绕过 rollback。纯过程帧即使没有数字也沿原持久 cursor 投影和确认，process queue processed 不代替 source ACK。

## 原完整报告与分类

完整报告沿现有原 snapshot、全部 usage/capture 页到 EOF。v2 capture 由 Task 原 qualification 核对其真实 completion source／冻结 ACK／prepare，以及所有 before/final 原 page／membership／count／digest。new records 是完整 final 与实际完整 baseline 的逐条差集计数，不是 emissions 修订行数，也不是传入的扫描总数。partial 仍保留全部已收到四桶及人民币；缺费率独立 unpriced，不隐藏已收到用量，未知桶不补零。完整零步骤原 EOF 可明确 known zero。

持久 complete usage workspace 仍执行完整原输入和四桶覆盖选择。v2 父链逐条走到 root、depth 用 decimal／BigInt，不设路径长度上限。v1 与 v2 的同一实际 parent/path 采用相同 path digest 归一，冲突仍拒绝。只有完整输入证明某个 source/invocation/root 组没有任何 self/tree summary，才省略该组的覆盖区间查询；含 summary 的组仍执行原模型、四桶、turn 范围与重叠判据。4096 缓存只是有磁盘／原索引回退的工作缓存，不能限制统计人口。

页面的原生采集详情读取 v2 最后实际 ACK 的 sessions／steps decimal，保留 partial 状态；不引用已移除的 whole-array 字段，不显示 undefined，也不产生不存在的历史修订列表。原 v1 历史显示与公共卡片、间隔、泳道、分类 Token／人民币保持。

## 防护与尚未启用部分

新增真实双 provider 用例从原 Task claim、原 SQLite 81 session／80 深度与1001 step、同事务 source／ACK、原投影和独立 report snapshot核对全链；包括全数四桶、纯 process 帧、空 EOF、未知输出与后续 partial、后续真实页引用、错误 source／倒退水位和缺父链接。原 contract 测试增加 numeric parser／trace 隔离与 outer binding 负例；双语页面保留超过旧人口上限的原 ACK decimal。旧断言与预算不减，AW 本机不运行 tests／typecheck／build／新服务，最终以确切提交 SHA 的 GitHub CI 为准。

本机真实页面发现首候选把 `nativeScopes` 误放入无数据库绑定的 attempt 字段选择器，原报告失败为 `db is not defined`；原失败回执保留。读取入口现只装入拥有原 snapshot 数据库参数的 Task facts 返回对象，attempt SQL 字段保持原形。GET status 返回实际 failed 终态，不能自动改回 building 造成无限轮询；用户显式 request／刷新仍可重试。双 provider 原 Worker 回归核对三次失败读取不再启动构建，再沿显式重试读取同一原 legacy Task／attempt／四桶与人民币，不能用隐藏错误替代修复。

本片不能在旧 producer 仍有 whole-array、128／5000／20000／32／400ms、prior100等总量分支时声称完整采集已经切换。numericPages 生产默认仍 OFF；历史修订另需原有完整 baseline/final/source/唯一 meter 的持久分页 writer。CS journal／Pod 原 owner 的肯定 ACK、真实模型及人民币验收费率和全量规模证据继续按两个 RFC 落地。
