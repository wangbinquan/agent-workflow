# v2 原生历史修订：原账本与可恢复分页

本增量属于已经批准的 RFC-371 原生 owner v2 范围。当前正式观测页已恢复已收到的分类 Token 与人民币数字，但 `nativeUsageRevisions` 和 `repairCapture` 对 v2 仍直接退出；原 producer 尚未启用。本文设计下一项历史 writer，不把设计、有限门或旧页面验收当成采集完成。

## 原事实与归属

历史输入只来自 Task 已持久的原 preparation、before/final pass、原有序页、membership、完整 parent 索引、completion source 行和冻结 ACK。由 task-execution infrastructure 提供独立的 `ObservationNativeHistorySource` public participant；它与现有 scope source 各自保留准确的职责，不将 native 数据库或 Task 私有表交给 run-observability application。

开启一项历史修订前，核对原 accepted invocation、Task/node、nativeSource、sourceGeneration、lineage/epoch、root、before-spawn 回执、completion source 水位和完整原 payload/ACK。完整 before 与 final 必须来自同一原 generation，各原 pass 的全部页、计数、摘要、membership 和父链沿现有 verifier 到 EOF。此验证在实际原读快照中进行，关闭该快照后才进入 writer 事务；不能从修订 writer 持有的 PostgreSQL 唯一连接再取得根连接。其后保存的准备回执引用这些原事实；它不是新原生证据，也不贡献 Token。第一页写入时重新核对该原 immutable source/pass/ACK 仍是同一事实，不能把关闭的读快照伪装成还在持有。

before 缺失、final 尚无原 EOF或人口证据有缺口时，不启动整项历史修订，不用当前 native 文件事后重造 before。它们继续显示全部已收到数字和真实缺口。root、新文件 generation、原页或 ACK 改变时，已准备的历史进度失效，不能把旧计数接到新 pass 上。

全量初始验证不能在 SQLite 服务线程同步扫完十百万条。生产文件部署复用平台已有 observation read Worker 的生命周期与真实文件绑定，增加专用 native-history 准备消息；不能制造 report、复制数据库或把真实 snapshot 变成普通根查询。PostgreSQL 复用原 snapshot 的实际 read channel，完成验证后关闭并释放原连接；只读 Worker 返回有限的原事实引用。`:memory:` 仅用于现有真实小规模夹具的原 snapshot，不能冒充生产规模路径。bootstrap 用现有 provider generation 和原绑定选择这些路径，不在 application 猜测 provider 或连接池。取消必须结束实际原读取并释放连接，重试仍核对当前原 source。

## 每页事务与全人口

历史 writer 在现有 `observation_usage_captures` 的持久 document 中保存精确进度：原 proof/source fingerprint、两个原 pass/ACK 引用、实际水位、最后 stepId、examined/resolved/unresolved 的十进制计数、链摘要与运行状态。它不创建第二套 Token 账本，不保存全人口 resolutions 数组。

每个事务按原 before stepId 取一个传输页，使用实际 ledger transaction 句柄读取 final membership、原页中的真实记录、完整 parent/path 与唯一历史 owner。每页结束后提交本页所有修订事件以及该项精确进度。进度不能在数字提交前前进；丢回执重试只沿原事件/revision 幂等，不重复加 Token。每页可以退出事务并让出事件循环，避免长 SQLite 显式事务阻塞本机页面，也避免在该事务内等待非数据库操作。

400 是一次 membership/owner 查询的包大小，不能作为总步骤、任务、调用、页或深度上限。下一次继续原 stepId，只有原空查询且总 examined 等于 before 原 EOF steps 计数、最后摘要闭合时才结束。少一行、游标不前进、原页缺失、generation 改变或计数不符都保持未完成；前面已正确入账的数字保留。后台 sweep 轮转所有待处理 capture，单次工作量不构成统计人口上限。

达到真 EOF 但 unresolved 不为零只是本轮遍历结束，不能关闭待修订状态。进度另保留十进制 scanCycle 与上轮已闭合计数；下一轮在同一原 source/pass/ACK 未变时把 step cursor、当前轮计数和链摘要原子重置，再从 before 第一个真实成员遍历到 EOF。原历史 capture 或唯一 owner 晚到后，后续轮必须能重新检查此前 unresolved 成员；每个 capture 每次 sweep 仍仅处理一个传输页并轮转。全部数字 correction 保留原确定事件身份，重复遍历不重复入账；已应用事件按当前原 meter 再判断确认或 superseded。只有本轮真正 EOF、exact examined 闭合且 unresolved 为零才把 history 进度置为 resolved。它不能清除原 frozen completion 自己的缺口，仍需有效 producer 重新 seal。新实际 completion 水位改变时，用新原事实重新准备，不接旧 cursor/计数。中间行缺失导致人口不闭合时也保留待处理，重新核验原事实后才允许新轮；不能以已有 subtotal 抵扣缺失成员。

每一页重新核对实际原 source/ACK 和准备回执引用的 pass 头；逐条原 membership 必须在它所指的原页中存在，原 session/parent/path 必须一致。缓存只能复用本传输页已经验证的原页，不能凭持久 prepared 标记相信任意新索引。没有真实 index 和原页对应记录时，不发肯定修订回执。

## 修订仍属于原调用

以原 nativeSource/root/stable stepId 查询全部历史 owner，排除当前 resumed invocation，实际遍历到空页 EOF。只允许恰好一个原 owner、已提交原 capture/source 与确定的原调用归属。v2 meter 必须有实际原 nodeRunId 和已验证的 source generation/path；缺这些事实保持 unresolved。v1 meter 原四桶与完整父链可以核对，但不能凭相同文件路径制造 generation，不能将它自动升级成 v2。无法证明的历史修订不重分给当前 Agent。

原 owner 的 request/delta/self、session/parent/root/turn 与完整 path 保持。模型相矛盾、步骤移除、未知归属和缺原 capture 均记录真实 unresolved。更高实际 native 水位保留后来的版本；其余变更在原 source scope 分配高于已观察版本的 correction，事件身份由修订来源 invocation、水位和 stepId 决定。时间、Task/Agent、原报价与费用 authority 保持原调用归属，人民币按原受理价目计算。未知桶保持未知，不补零、不抹掉已收到数值。

准备、每页 cursor 和结果只有在原事务实际提交后返回。完成 writer 不直接改写或美化冻结的 Task completion；Task producer 必须在原有效 claim 中重新检查原 meter/修订，再生成其真正完整的 completion 与 ACK。原 invocation 已结束、claim 丢失或采集已不可恢复时，保持已记录统计和准确缺口，不制造新 claim 或补造 complete。

## 接线与验收

1. 增加原历史 source 公共合同与 Task adapter；原 `onReader` 绑定全部事务内读取到同一 ledger 事务。初始完整原验证在持有 ledger 写事务之前使用已有原 snapshot，并在验证后关闭；Pg 单连接部署同样可顺序完成，不依赖扩大连接池或新开根连接。
2. 在原 capture persistence 增加有限进度头；保留旧 v1 evidence/resolutions、全部旧 schema/oracles。v2 初始投影保存待修订状态，后台按页恢复；单次调用原补齐命令返回准确进度，producer 持原 claim 循环直到真正终态。
3. 用真实 SQLite/PostgreSQL Task/accepted invocation、before/final pass/ACK、唯一 ledger/source 做跨多页修订、丢回执与重启。确认人民币、四桶和归属；PG `poolMax:1` 必须实际完成，禁止新增根连接自等待。
4. 负例覆盖缺/改原页、缺父链、计数少一条、generation 不同、多个历史 owner、null nodeRunId、模型冲突、更高水位和已退出 owner。断言未知与已有数字并存，原 frozen completion 不被 writer 修改。
   另有实际晚到用例：首轮真 EOF 仍 unresolved，原历史 capture 后提交，后台继续轮转并重扫，最终正确修订为 resolved；跨重启保留 scanCycle/cursor，重扫已提交 correction 不增加 Token，也不能略过第一轮没有 owner 的成员。
5. 规模验收验证总人口到 EOF、每页内存、恢复与正式页响应，不把 1001 步夹具、10000001 文案或有限静态门当成十百万条实测。AW 本机不执行测试/typecheck/build/新服务，实际功能用例交精确 SHA hosted CI；页面只复用原本机服务。

该片不激活 producer，不替代 CS 原 journal writer，不关闭 RFC。实现前需有限功能设计门；实现和 matching metadata 分别检视，先发布可以独立验证的修订链，再接正式 producer。

## 原 writer 候选与有限人口验收

v2 设计门 PASS 后，本片实现原捕获头的持久 scanCycle/续读位置、真实页/parent/member 验核、原唯一 owner 的 correction 与同事务进度。SQLite 全读使用原文件 Worker，PG 全读沿原 reserved channel，并在 writer 前释放；后台按传输包轮转，原 public participant 增加只处理明确受理 invocation 的 `reconcileNativeHistory`，不把其他 Task 扫描结果当成这次进度。真实 EOF 的 examined 少于原 before counts 时保持 pending；重新完整核验原关系以后再重扫，不能消掉缺失行或误记 resolved。

新增双 provider 原事务回归覆盖405条/80层跨包、实际文件/单连接PG Worker释放再写、丢回复后的持久续读、晚到 capture 第二轮全扫、缺中间 membership 后恢复、改原页的整页回滚、真实模型矛盾和未知输出。原 Task/Agent/时刻/basis/报价归属不重分；未知输出仍保持旧收到数字和旧 coverage 水位，同时 incomplete。所有旧用例与预算保持；新大深度用例单独明确预算。原外部 OpenCode SQLite 格式只有一个实际建库调用登记，AW ledger和进度仍实际双 provider。

这是源码候选和已写回归，不是测试通过。仅目标 format/lint；源码功能门、matching metadata、精确上库及 hosted CI 待分别验收。新 producer/有效 claim内重新 seal、CS 原 journal owner和真实100K Task/10M usage仍开放，两个RFC仍在进行。
