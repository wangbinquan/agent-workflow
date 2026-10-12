# RFC-372 五表/schema 交接增量独立源码复核

复核人：Codex，独立审阅代理 `/root/rfc372_design_review`。复核日期：2026-10-12，证据采集始于 05:04 UTC（13:04 Asia/Shanghai）。本报告由本次重新读取源码、迁移和冻结证据后独立撰写。

**结论：PASS，限定为下列十个文件中 RFC-372 五表、双 provider 迁移、schema 导出、owner 和数量断言的静态功能复核。未发现阻断该增量交接的功能问题。** 该结论以保留现有 RFC-371 的 SQLite 0245 / PostgreSQL 0021 前序及共享内容为前提，不能解释为可以跳过前序迁移单独应用 0246 / 0022。

## 范围与候选指纹

范围依据为 [schema-publication.md](/Users/wangbinquan/dev/proj/agent-workflow/design/RFC-372-mindmap-clarify/schema-publication.md) 中五个新增文件和五个共享文件。本次只检视 RFC-372 的功能增量；RFC-371 文件仅作为前序身份和保全证据读取，未扩审其业务功能。SHA-256 均为当前文件原始字节的哈希，非 Git blob 哈希，也非 JSON 内部的语义 digest。

| 文件                                                                                                                                                                               | 属性 | 字节数 | 文件 SHA-256                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -----: | ------------------------------------------------------------------ |
| [clarifyMindmap.ts](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/db/clarifyMindmap.ts)                                                                          | 新增 |   4370 | `3b3ea11f992e76e420e291f419557d5342a06d29ab60b962f96a48af903ee7b8` |
| [0246_rfc372_mindmap_workspace.sql](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/migrations/0246_rfc372_mindmap_workspace.sql)                                   | 新增 |   2806 | `9278ad7ffcca681f047a49d3efedbcd837950c0e5e5944ba5d84e7ce2e9863c3` |
| [0246_snapshot.json](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/migrations/meta/0246_snapshot.json)                                                            | 新增 | 816731 | `ca34223ca8ac348964c7ee94d34f3460a1067096195b3a2bf202cb9ffc1c6550` |
| [0022_rfc372_mindmap_workspace.sql](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/postgresql-migrations/0022_rfc372_mindmap_workspace.sql)                        | 新增 |   5856 | `0e9cf77342f8f66b5726ec6e3f2c381b75d8fbf9544eee870feff65f6990001a` |
| [0022_rfc372_mindmap_workspace.upgrade.json](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/postgresql-migrations/meta/0022_rfc372_mindmap_workspace.upgrade.json) | 新增 |  49278 | `5b9039da96642a59cd357d08466cfdebdeb793df3097a666a94de3fb01fe5008` |
| [schema.ts](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/db/schema.ts)                                                                                          | 共享 | 389161 | `2646669aab28ac2cda39cdc90a8feae2b2d9bdeb8077d1b25325b179e088de13` |
| [schemaContract.ts](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/platform/persistence/schemaContract.ts)                                                        | 共享 |  30845 | `80f022fe6137c049bb6a99c65b3b57395941420b22e52bba6c6a6ba5899200c6` |
| [\_journal.json](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/migrations/meta/_journal.json)                                                                     | 共享 |  38284 | `dd7bbbb04994ffd11692e65aaab3060e1c0097aeb839c0b514e28a3f9dcec270` |
| [rfc349-postgresql-schema.test.ts](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/tests/rfc349-postgresql-schema.test.ts)                                             | 共享 |   8050 | `21b6a59b1867ed1b2ff1daaf6cc2155a22776b9fbc35dc676148dd37f8d9ec01` |
| [upgrade-rolling.test.ts](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/tests/upgrade-rolling.test.ts)                                                               | 共享 |  45939 | `b1ccd026cccd3deafd1ef4b00a57ec29dea2e613de5a3f108c8907807b0fd392` |

## 复核证据

### 1. SQLite 快照保留原有 244 表，0246 只增加五表

本次以只读 Python JSON 比较重新核对了 0244、0245、0246 的表对象、非表 metadata 和 UUID 链：

| 快照 | 表数 | id                                     | prevId                                 |
| ---- | ---: | -------------------------------------- | -------------------------------------- |
| 0244 |  241 | `ea94625c-6c85-442d-b488-88644e9a33a5` | `d908f672-bd17-4148-9f58-0c8cfa275782` |
| 0245 |  244 | `ed42e055-0425-4940-a293-e688514ddb29` | `ea94625c-6c85-442d-b488-88644e9a33a5` |
| 0246 |  249 | `83c17389-93b0-4fb9-807b-8a713d573d11` | `ed42e055-0425-4940-a293-e688514ddb29` |

0244→0245 的差集仍只有 `observation_calculation_rows`、`observation_calculation_versions`、`observation_source_revisions`，无旧表删除或修改。0245→0246 的差集只有以下五表；全部 244 个原表 JSON 对象逐个相等，无删除或修改，除 `id`、`prevId`、`tables` 外的快照 metadata 也完全相等：

- `clarify_mindmap_command_receipts`
- `clarify_mindmap_node_revisions`
- `clarify_mindmap_nodes`
- `clarify_mindmap_sessions`
- `clarify_mindmap_snapshots`

当前 0245 文件为 **804661 字节**，SHA-256 为 `dc23ba56b994173a4aa10e91458cf3516285343b4d91c52c2f42a8e71e0e0372`，与协调方提供的冻结原文件指纹一致。实际找到的 [v385 保全记录](/private/tmp/observability-aw-task-calculation-source-20261012-v385/shared-0245-preservation-live.json) 亦记录相同 before/after 字节数与 SHA、`fullSemanticEqual: true`、空 `allDifferences`；该记录自身为 270 字节，SHA-256 为 `6c276668ed07d82367f0ce85a20ca7015140e915b7303c97cd53425cf8270b69`。本次核实的是当前文件与提供的冻结指纹及保全记录一致，未重新执行保全操作。

同时重新核对：0246 的完整 JSON 对象等于 `/private/tmp/rfc372-migration-number-collision/generated-0245_snapshot.json` 中保全的生成结果；当前 journal 相对同目录 `generated-journal.json` 的唯一条目差异，是 idx 245 的本次 tag 从 `0245_rfc372_mindmap_workspace` 改为 `0246_rfc372_mindmap_workspace`，此前全部条目保持一致。

### 2. 五表声明、SQLite SQL、PostgreSQL SQL 与逻辑 metadata 一致

[clarifyMindmap.ts:7](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/db/clarifyMindmap.ts:7) 使用现有 `providerAwareSqliteTable` 工厂；[schema.ts:8608](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/db/schema.ts:8608) 导出全部五表并传入已有 `tasks` 与 `clarifyRounds`。原 observation 导出仍存在。

五表共 38 列、五个主键、五个索引和六个外键。人工逐项阅读工厂与两份 SQL，并将 0246 快照与 0022 `logicalTables` 逐表比较：列名、SQLite 类型、可空性、主键、索引的列序和唯一性、外键目标及级联规则均相符。具体包括 session 的 `round_id` 唯一键和 `(task_id, entry_ref)` 唯一键、revision 的 `(node_id, session_revision)` 主键、receipt 的 `(session_id, request_id)` 主键。

0246 SQL 只创建这五张表及五个索引，六个外键随建表声明；没有修改已有表的语句。0022 对应五条建表、五条索引、六条外键和一条 contract metadata 更新，整数列映射为 `BIGINT`，文本列映射为 `TEXT COLLATE "C"`；其 `executableStatements` 中全部 SQL 均在对应 SQL 文件中存在。

### 3. PostgreSQL 0022 明确继承 0021，并绑定 SQLite 0246

0022 的 `sequence` 为 22，`previousEntryDigest` 为 `sha256:e9c182d3acd1e14c87595806fe4b363b047cb4121961a9bcb22f8f1dd27ab9d5`，等于当前 0021 的 `digest`；0022 的完整 `from` 对象等于 0021 的 `to` 对象。其 SQLite `from` 是 245 条、末项 idx 244 / `0245_rfc371_observation_calculations`；`to` 是 246 条、末项 idx 245 / `0246_rfc372_mindmap_workspace`，`appended` 仅含本次 0246。

独立计算原始 SQL SHA-256，结果与 metadata 绑定一致：

- SQLite 0245：`d8c1df1f76babbeb745d8bc9c46a25c87d3cbde9474f17cfd627ab92c420f59d`。
- SQLite 0246：`9278ad7ffcca681f047a49d3efedbcd837950c0e5e5944ba5d84e7ce2e9863c3`。
- PostgreSQL 0021：`18f05d02382a8fdc59ab8b0631a02ff93c6c110cd8b2aa6626fa100f333043fb`。
- PostgreSQL 0022：`0e9cf77342f8f66b5726ec6e3f2c381b75d8fbf9544eee870feff65f6990001a`。

按当前源码的 canonical JSON 规则，使用只读 Python 对移除自身 `digest` 的 metadata 静态重算，0021 和 0022 均与声明相符；0022 语义 digest 为 `sha256:ccd76bc82796d4a2836e35fcae3632d866a2128228f77a89124355ca62dc3721`。该值与上表 upgrade JSON 的整文件 SHA-256 含义不同。

[0022 SQL:98](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/db/postgresql-migrations/0022_rfc372_mindmap_workspace.sql:98) 将 contract 从 `sha256:75bf736d0ce25c25e293ba78e82d378ccca540edc2807fa27345d4f8c33dcd27` 推进至 `sha256:f093173a29f7875afcbd167fae1d2687cc3118431348a2f3a848acb8cb929d49`，与 0022 metadata 的 `from` / `to` 一致；active 为 243、archive-only 为 6。

### 4. owner、总表数和断言配套

[schemaContract.ts:38](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/platform/persistence/schemaContract.ts:38) 列出精确五表，[schemaContract.ts:497](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/src/platform/persistence/schemaContract.ts:497) 将其归属到 `collaboration`，0022 的五个逻辑表均为该 owner、`KEEP` disposition。原 observation 三表列表和 `run-observability` owner 规则仍在。

静态解析当前 `RFC349_SOURCE_TABLES` 得到 249 个唯一名称，其集合与 0246 快照完全相等；原 archive-only 列表仍为六表，因此 active 为 **249 − 6 = 243**。当前 journal 含 **246** 条，末两项仍按顺序是 idx 244 / 0245 和 idx 245 / 0246。

[rfc349-postgresql-schema.test.ts:25](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/tests/rfc349-postgresql-schema.test.ts:25) 的总数和唯一数均为 243，并精确断言五个 `clarify_mindmap_` 表名；原 observation 集合断言保留。[upgrade-rolling.test.ts:285](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/tests/upgrade-rolling.test.ts:285) 的用例标题和 [同文件:572](/Users/wangbinquan/dev/proj/agent-workflow/packages/backend/tests/upgrade-rolling.test.ts:572) 的数量断言均为 246，前面的注释分别保留 0245 与 0246 的增量。这里确认的是用例源码配套，未将这些用例记为通过。

## 结论边界

本次实际执行的是源码阅读、JSON 对象差分、原始文件字节数与 SHA-256 计算，以及既有 metadata 的静态摘要比对。**未运行 AW tests、typecheck、build、服务、浏览器或 E2E，未导入执行产品模块，未应用 SQLite / PostgreSQL 迁移，也未查看或宣称任何 CI 结果。** 未进行 Git 写入。唯一写入的仓库产物是本报告。

PASS 仅覆盖上表指纹对应的五表/schema 交接增量及其既有前序关系；不构成实际迁移执行成功、持久化业务行为、runtime opening、Finish、宿主 continuation、M1 或 RFC-372 全量完成的证据。后续候选内容改变时，应按实际差分重新判断本报告是否仍适用。
