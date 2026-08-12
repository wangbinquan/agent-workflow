# RFC-293 设计门记录（已由用户裁决取代）

2026-08-12 的外部复审把 RFC-293 扩张为 Intent-only sealed runtime、认证源证明、进程 containment、capture
quarantine 与历史数据库清洗。该方向偏离了用户要解决的工作台功能与 UX，并会收缩 Intent 原有能力。

2026-08-13 用户连续明确裁决：

1. 不再等待设计门，直接实现；
2. Intent 构建必须“什么都能做”，不能因复审收窄能力；
3. 只保留最纯粹的功能，不增加一堆安全机制，把功能与使用体验做对。

因此此前八轮 findings 及未完成的第九轮复审全部终止，不再作为 RFC-293 实施输入。有效设计以同目录当前
`proposal.md`、`design.md` 和 `plan.md` 为准：只实现工作台、Working Context 自动续跑、提交前后持续迭代、
废弃重跑与合并当前待办；runtime 完全复用既有普通 system-agent 路径。
