# RFC-363 实施台账

2026-09-20：用户已批准实现和代码上库。首批 T1/T2 候选，尚待托管 CI；T3–T8 未完成。

## T1 基线

已对 `source-baseline.json` 的 25 个生产文件重新计算 SHA-256：24 个与设计基线一致，仅 `db/schema.ts` 因本批四表 expand 改动。
入口、54 字段、两 lane、reader/rollback oracle 继承 RFC-362 `implementation-ledger.md` 的逐项清单；本批不修改任何入口的准备/建任务顺序。

## T2 expand 与兼容恢复

- SQLite `0227_rfc363_workspace_preparation_journals`：SC source、snapshot、operation 与 Task preparation 四表；不改旧表、不创建占位 Task。
- PostgreSQL `0003_rfc363_workspace_preparation_journals`：V2 additive edge 支持完整新 KEEP 表；V1 索引边、baseline、旧 journal/SQL 字节保持不变。旧列、codec、key、disposition 的变更仍不能冒充 additive。
- 旧备份经已验证的 additive history 恢复：旧行按原合同解码，新表为空，并进入目标完整 census。原 index-only bridge API 仍拒绝表变更。
- SC 私有 repository 提供幂等 source、不可变 snapshot、operation 状态/version CAS；首次 commits 在物化前记录，prepared receipt 在后续 cleanup 保留。Task 私有 repository 提供 admission key、artifact、原 owner fence 与状态/version CAS；不得清理已 admitted 记录。
- 本批 factory 是持久化基础；尚未接入生产 seal/snapshot/effect/reader，不领取 RFC-362 declared seam 或 E1/W5 完成信用。跨进程 Git/上传恢复仍待 T3–T5。

新增 `rfc363-preparation-journal.test.ts` 与 `rfc363-additive-schema.test.ts`，覆盖双库原子回滚、并发 CAS、请求复用、receipt 持久化和历史回放。扩展既有真实 PostgreSQL 旧备份恢复断言，确认四张新表为空；原行/归档/生成记录断言保留。

本地仅执行 schema/canonical generator 与 Node Prettier/ESLint，不运行 Bun tests、服务或全仓 gate。验收以本批发布 SHA 的 GitHub Actions 为准。
