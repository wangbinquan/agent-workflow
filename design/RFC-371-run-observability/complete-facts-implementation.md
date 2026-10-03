# RFC-371：完整执行事实发布接线

这是事实展示实现记录，两个 RFC 继续 In Progress。原 native v2 未接入，不能据此声称统计数量限制已全部移除。

设计门已 PASS，回执 `observability-aw-complete-facts-design1-v1-review.json`，SHA256 `8f1c380eccd75745e7c16a83a3fe2428e8aed7aeb369cd84a04b7c270a216ee1`。只有原输入全 EOF、冻结来源收据与封存输出通过后，才沿同一 spool / hidden staging / CAS 发布 `not-ready.facts`。源查询未完成、失败或损坏都没有 facts。模型选择仍存在 dimension-unresolved 时不发布 facts，不将未知归属当成精确筛选人口。

facts 只包含完整 Task / attempt / accepted invocation、已保留执行 span、维度归属、状态、时间和质量。摘要 inventory 仅 Task / attempt / invocation；所有行与 root Task 的 metrics 统一为 not-ready，清除 span Token/CNY 引用；数字 allocations/capture/receipt 查询明确拒绝，不用空数组伪造零。仍保留原完整数值证据和原来源收据作后续原采集补全依据。

正式页面保留 Task、调用和泳道入口、完整事实总数及逐页导航。所有四类 Token 和人民币显示未知，错误提示持续可见；不请求不可用数字集合。损坏页使事实摘要也失效。真实已 ready 的原四桶/CNY 与完整定价可见性不变，明细费用在未定价或隐藏时也不显示部分金额。

新增真实 SQLite/PostgreSQL 202 Task 全事实分页、最后一页、完整子项数值清除、模型归属未知、非法数字集合与损坏 retained row 回归；前端增加事实页面、Task / attempt / call 与损坏页回归。前端 fixture 仅证明展示合同，不冒充真模型采集。AW 本机没有执行测试、类型检查、构建或服务；行为验收依赖发布后 exact-SHA hosted CI 与真实页面。

仍待原 native 完整 baseline 持久页、emission/原 source ACK、生产接线、历史不可恢复证明、AW/CS 真任务四桶及人民币逐原记录对拍、100K Task / 10M usage 和正式 browser/定时 CI。CS 开发 producer 保持 OFF。
