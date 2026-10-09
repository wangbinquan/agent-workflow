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

## 2026-10-09 精确发布与终态

28 个明确候选路径已提交推送为 `83c6b76f545fc26e314a0e98dd23ff1025d81eef`。两把发布锁、空原共享索引、全部 staged 路径与 blob、提交路径与 co-author、发布前后 fetch 和远端完整 SHA 均已核对；发布后的 main/origin 相同，索引为空。该源码提交的完整 STATE 包含并行追加且原输出完整保持，其他 WIP 未收编。

配套 R1 因 STATE 在冻结后增加 1195 字节并行正文而不能绑定完整候选，其无功能 findings 不记为本次整体有效 PASS。R2 保留原 74 项未变材料，独立核对完整新 STATE 与追加控制，81 项材料逐字节到 EOF；manifest 为 `96d7c7eb35a4be266345b0f9c0fbe7d69733243e1b85380671fd975323571737`，功能门 VALID/PASS、零 P0/P1/P2。根会话已完整消费判据、原逆向、控制和限制，没有重启原源码门、生成器或本机 AW 产品套件。

| 同一源码 SHA 的 hosted 运行                                                                    | 精确终态                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------ |
| [主 CI 37879858796](https://github.com/wangbinquan/agent-workflow/actions/runs/37879858796)    | 72 / 72 作业 completed/success |
| [视觉回归 37879858803](https://github.com/wangbinquan/agent-workflow/actions/runs/37879858803) | 1 / 1 作业 completed/success   |

完整作业分页及原 watch 回执均保留于 `/private/tmp/observability-aw-known-zero-exact-ci-watch-20261009-v1`。主 CI JSON 的 SHA-256 为 `739e91d219a5565557b9f2696e5d86b46ad315b1fdcb467c46c390977b46562a`，视觉回归为 `7f8b7cae2fad60d70b5d0156f12e0c1ea0bb375f7ac48080a165219d210391ce`；两运行所有作业已消费，合并终态回执为 `4332157e119cea9fdf2d51c9c8825354f89199c56ccec38414f95f50f04d70e2`。没有再次 dispatch 规模工作流，旧失败和取消继续保留。

原定时正值与新原记忆作业的数值/页面回归见[批次验收后继](./known-zero-metrics-acceptance.md#2026-10-09-发布后正值回归)和[记忆提取验收](./memory-distill-real-validation-20261009.md)。源码提交绿色 CI 不代签后继文档提交，也不关闭 System 时间口径、所有内置 Agent/Git、CS 新发布/部署及两个 RFC 的完整退出项。
