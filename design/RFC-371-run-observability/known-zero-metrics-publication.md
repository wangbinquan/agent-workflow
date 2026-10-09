# RFC-371 零消耗证明的配套发布

## 固定候选与已消费功能门

本片修复范围见 `known-zero-recorded-metrics.md`，原批次验收见 `known-zero-metrics-acceptance.md`。12 个源／原测试／设计文件已通过有限独立设计门和实现门；设计材料 14 项、实现材料 35 项全部稳定读取到 EOF，根会话完整消费各功能判据、证据、原断言逆向和限制。原 11 项对照、68 个原 expect 及原测试人口、时间预算保持；新增 SQLite／PostgreSQL EOF 回归和中英文零值／未知回归交由 hosted CI 执行。

源候选的基准为 `40a0d70518f31d18321ae7680bf946a733b74d91`。设计门 manifest SHA-256 为 `b720efaec102cf246788c459f82145df93a16b576501bd2737326d52c91a483b`，实现门 manifest 为 `81e9f12eeef99cfea5edb7c3023872e18c0567aa7690dfcae252fee1a4c3029e`。两项有效 PASS 不代签下一配套门或 CI。

## 原架构生成与完整保留

对这项新的生产内容仅运行一次原官方 assertion-free 生成命令：

```text
bun run scripts/architecture-census.ts --write --snapshot-sha 40a0d70518f31d18321ae7680bf946a733b74d91 --seed-ref 40a0d70518f31d18321ae7680bf946a733b74d91
```

原 13 份产物完整保存后生成；命令正常完成。八份 canonical 的 sourceDigest 均为 `sha256:1291ac2d6f99a91c7ee56c31cae6097f1df078422c57fee4f9c6f8eaec735ec4`。四份 governance 只跟进 canonicalProjection 与原 provenance，保留其 legacy sourceDigest；生成 status 只跟进同一摘要。没有第二个 AST／scanner／census、没有本机 AW 产品 tests／typecheck／build／services／E2E。

129 个 ledger 有序原行、全部 why、库存与数值保持，不新增增长许可。完整 mutation／effect／background／cross-context／facade／owners 等人口保持；1259 个 public symbols、1339 个 consumers、1750 个 methods、71 个原入口文件保持。只有原三项 run-observability public 响应的递归 fields 随可选零值证明增加，29864→29954，其余 entries、合同字段和边不变。原 implementation SCC 为 0，27720 个 owner 条目保持；这不代表整个 backend 值级 SCC 为 0。

## 发布与后继验收

配套独立门只审完整原 13 份输出、已冻结源码与原控制、本文／验收登记、STATE 前缀及原实际回执，不运行新的产品命令或生成器。共享 STATE 只追加本片前缀，旧全文和并行输出完整保持；任务相关共享文件按完整文件发布。

共享 main 的短发布区需两把既有锁、空共享索引、精确路径及完整 staged diff；发布前后 fetch 并核对 main／origin，保留 concurrent 内容。提交含 `Co-Authored-By: Codex <noreply@openai.com>`，上库后只认新 exact-SHA 的 hosted 终态。原失败、取消、排队或部分成功不记为通过，也不重启 observability-scale。两个 RFC 与原全类型验收未完成。
