# 原单区间 TEMP 与完整统计验收

2026-10-06，原 source `45c9cb462b64edef611a2c20e3208e0f6db0fa62` 的[原尺度验收](https://github.com/wangbinquan/agent-workflow/actions/runs/37429500802)完整报表作业 PASS。真实物理输入 100,000 Task 与 10,000,000 usage，每一原 Task、allocation 逐页读到实际 EOF；Token 输入10M、cacheRead30M、cacheWrite50M、output70M，总160M。CNY500只来自明确标记的验收费率，supplierInvoice=false，不代表真实账单。该结果包含 100K 原 attempts/invocations/captures，首末页各100次实际延迟与全EOF核验。

同 run 的原 self-total 作业在原240分钟预算内超时；10M原输入已经结束，原选择未到输出EOF，TEMP采样81,226,448,896 bytes。取消和失败证据保留，不能称整个尺度run通过。旧5/10M与100K/10M人口、四桶、原模型分区、实际读写源以及原预算均保留。

本批只在原 completeCoverageWorkspace 内将单叶AVL的原start/end保留于同一roots行的point tuple；原tree/id字节不变，高度1、左右空、maximum=end由原端点精确还原。首次叶保持在dirty中直到原setRoot，若此前已有499个原full节点，先通过原flushRows持久化全部499条再加新第一叶，避免重复持久化；一次500上限仍是原传输/dirty大小。多节点生长先移除point，按原nodes关系完整保留原字段，再由原AVL进行插入与旋转。没有人口、深度、总量、总体积或遍历预算，没有第二份数字账本。

point保留原AVL接受的全部safe integer端点对，不引入新的start<=end限制。原root肯定空EOF、await期间revision、4096缓存、500getMany包及其signal/异步迭代器均保持。原selection、coverage keys、order、完整报告、CNY、原native工作区实现未修改。

独立设计门R1 VALID/FAIL发现混合499节点边界和新增端点限制两项P2，原失败保留；R2分别修正，VALID/PASS、0 findings。新增实际originalReportSnapshotSession的SQLite+PostgreSQL回归涵盖5205树的全部原键/节点/端点到EOF、缓存淘汰与重开、同一writer逐次生长/两向旋转/区间重叠、499原full节点混合新叶边界、原5/2端点对、损坏tuple显式失败。原全部回归和预算保持。本机仅目标格式/lint与官方纯AST census，不执行AW本机测试、类型、构建、E2E或规模任务。

新源码的独立实现门、exact-SHA真实双provider CI以及原尺度验收须分别取得终态；本节不把静态证明或原45c9完整报表PASS代签本批。原生分页归属/基线/修订、CS开发数值消费者、真实托管联动与剩余工作继续，两个RFC仍为In Progress。

## 原规模完整通过（2026-10-07）

源码 9fa8c3d44bb9316388831833319165adf09e4a89 的[原尺度 run 37465488198](https://github.com/wangbinquan/agent-workflow/actions/runs/37465488198)正式 success，两个原作业均 PASS，原 240 分钟预算和人口未改。self-total 实际选择 10,000,000 条，排除 0、歧义 0、未知桶 0；allocation 完整 EOF 为 10,000,000。full-report 原 Task／attempt／invocation／capture 各 100,000，usage 和 allocation 各 10,000,000，任务末页 EOF 为 100,000。两路四桶均为输入10M、缓存读30M、缓存写50M、输出70M；报告总量160M、CNY500，与原明确标记的合成验收费率一致，不代表供应商账单。

实际 self-total 用时 12,740.785 秒，采样磁盘峰值 69,483,520,000 bytes、GNU time maxRSS 370,192 KiB；完整报告用时 13,731.688 秒，采样磁盘峰值 82,448,285,696 bytes、maxRSS 552,240 KiB。完整报告首次构建 4,546,947.667 ms；首／末页 p95 160.620／161.613 ms，状态查询 p95 81.084 ms，但 max 104,294.969 ms。人口与金额完整资格已满足，首次构建和状态最长阻塞仍需继续改进；不把该结果宣称为交互性能全部完成。

此前 45c9 的 self-total 超时和完整 run 取消、其他旧失败及原证据保持。此 success 仅签 9fa8 的原规模候选，不代签 f69 的 partial 估值回归、CS 规模或原生生产接线；原生消费者、真实托管联动与 RFC 剩余工作继续。
