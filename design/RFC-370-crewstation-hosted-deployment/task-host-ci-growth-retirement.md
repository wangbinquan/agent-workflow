# RFC-370 原 W5 一次性增长许可退役

`5bf9c109ce5285a176affd47e104c055127fbed0` 主 CI `37700768526` 的 Ubuntu6 job `113063408595` 与 macOS2 job `113063408440` 实际失败于 RFC-317 T17：`rfc359-w5-postgresql-fake-runtime` 在该提交没有增长，前继 `00ce2fea` 登记 68→70 时的一次性 allowGrowth 仍未删除。原失败保留；这不是新的生产功能缺陷。

按原已批准的“普通后继立即退役”设计，只从 `architecture/ledger-baselines.json` 的这一项移除已消费的 allowGrowth。129 项的原有序 ID、baseline、why 及全部其它字段保持；W5 的实际 70 保持，原 classifier、原真实 Driver 探针、预算、其余12份 matching 及生产源码不改。按原递归 localeCompare / JSON2spaces+LF、剔除 provenance 等记录字段的完整 payload 算法更新本文件的 contentDigest；sourceDigest、canonicalProjection 和其它 provenance 字段保持。

独立有限功能设计门与实现门验证完整前后正文、唯一删除字段、原规则和实际功能日志；不新运行架构采数，不执行本机 AW tests / typecheck / build / services，不放松判据、增长规则或任何原断言。此退役与 PG rollback cause 修复分别形成精确路径提交，在同一短发布临界区完成后推送并验实际新 SHA hosted CI。

既有 RFC 回顾两项 P2 尚待修复；后续 runtime / Node / CS 适配暂停。完整 H7 / A-G 和 CS M0～M4 未完成，AW 尚未部署 CS，有限门不代签整仓 CI 或 RFC Done。
