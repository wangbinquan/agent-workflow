# RFC-371 原生缺口文案的 canonical CI 修复

原 `d8c3a457c112118d362b2271384b7772530c1704` 主 CI `38151840667` 正式 failure。Ubuntu shard 24/32 与 macOS shard 12/12 各有两条 RFC-294 原 canonical 精确投影断言失败；原前端、类型、lint、格式及其他作业通过。失败是提交中的派生 `sourceDigest` 仍为 `sha256:550976584af0139b38d6b083c998f95e9be03a1a2218340b53bf195781986397`，原生成器对本次完整已提交源计算出 `sha256:ae971f0d1ac4f9dbfed313c020192a16790d5b39507f6b29226661678bc77084`。保留原失败，不重跑旧流水线代替修复。

第一份私有输入适配器 v331 使用全文替换重定向 `node:fs`，独立功能检视发现它也改变了原禁用包规则常量；该次生成无效，原证据完整保留，不能签作规则保持。后继 v334 只重定向原 import/export 声明中的 moduleSpecifier 范围，保留其他全部规则常量和函数正文。

在唯一 primary main 中，以原已提交 d8 的完整 Git 文件集合和原输入正文，对修正后的候选执行一次原 `scripts/architecture-census.ts --write --snapshot-sha d8c3a457c112118d362b2271384b7772530c1704 --seed-ref d8c3a457c112118d362b2271384b7772530c1704`。只读内存输入将未提交的两个并行候选排除；没有分支、worktree、临时 checkout、源文件移除或重写，没有本机 AW tests、typecheck、build、E2E 或规模流水线。原 scanner、四规则及 writer 逻辑保持原已提交正文，仅重定向文件输入／私有输出。

原十三份生成结果齐全。八份 canonical 仅修改上述源码摘要；四份 governance 沿原 projection/provenance helper 刷新，status 为同一原生成结果。完整有序 owner、import、public surface、mutation、transaction、background、facade、commons、guard 与 ledger 条目及数量保持；没有新增增长许可，没有改预算或断言。有限配套功能检视、原输出逐项对拍和根消费后才精确提交这些配套；后继确切 SHA 的 GitHub Actions 全绿另验。

本片不提交尚在实施的原生数值页缓存，也不代签全部增量聚合、warm P95、CS 原 B 环境释放或两个 RFC 完成。共享状态与并行候选完整保留，短发布临界区只包含上述原派生配套和本记录。
