# RFC-275 · 数据库迁移历史与物理 schema 启动准入

状态：Done（2026-08-10）

## 1. 背景

本机 `mcp_runtime_test_turns` 缺 `raw_command_digest`，而当前 migration 0125 和从空库完整 migrate
得到的表都有该列。该 daemon 曾在 0125 SQL 尚在共享工作树中编辑时启动；Drizzle 按 migration
`created_at` 只看最后一条已应用记录，认为该序号已经完成，后续不会重跑被修改过的文件。结果是
daemon 正常启动，直到 MCP runtime test 首次查询该列才返回 500。

仓库现有保护能抓 migration journal 的 `when` 非单调，也能证明 fresh snapshot 与 fresh replay
一致，却不会拿某台真实数据库的 `__drizzle_migrations` hash/物理结构与当前 binary 所带 migration
链比较。多 session 共享工作树、当前 migration 尚在编辑、daemon 自动重启的组合使该漂移不是
罕见手工事故，而是可复现开发常态。

本 RFC 把“数据库确实是当前 binary 所声明的 schema”提升为 HTTP/scheduler 之前的启动准入。

## 2. 目标

1. migration 前验证 DB 已应用历史是当前 migration 文件链的精确前缀：时间戳和 SHA-256 都匹配。
2. 应用 pending migrations 后，验证历史是完整精确链。
3. 把真实 DB 的物理 schema 与同一进程中 fresh in-memory full migrate 参考做结构对比。
4. 漂移时 fail closed、关闭连接、输出有界精确差异；绝不等到某功能路径 500。
5. 不读取/输出业务行数据，不自动 ALTER/补列/重写 migration history。
6. fresh DB、正常 rolling upgrade、幂等 reopen 的启动时间保持轻量。

## 3. 非目标

- 不做自动修复，不把缺列“猜着补上”，不修改 `__drizzle_migrations` 伪造已应用历史。
- 不替代 RFC-213 `PRAGMA quick_check`；页损坏与 schema 漂移是两道独立准入。
- 不比较业务数据、row count、sequence 当前值、SQLite page layout 或 WAL 内容。
- 不要求 Drizzle ORM TS schema 与 migration 链逐字段反射一致；物理权威是 full migration replay。
- 不在生产提供跳过 schema drift 的环境变量；测试可显式 `skipMigrations` 时沿原契约跳过。
- 不把历史 migration 文件“可编辑”合法化。已应用 migration bytes 必须视为 immutable。

## 4. 产品决策

### D1 · preflight 精确前缀

用 Drizzle 正式导出的 `readMigrationFiles` 读取 `_journal.json` 与每个 SQL 的当前 hash。若真实 DB
不存在 `__drizzle_migrations`，视作空前缀；否则按 `created_at,id` 读取全部行，逐位置要求：

- DB 行数 ≤ bundled migration 数；
- `created_at === folderMillis`；
- `hash === current file hash`；
- 无重复 timestamp、乱序、空 hash 或链中间缺口。

任一不符在调用 `migrate()` 前失败，因此不会在不可信历史上继续写。

### D2 · postflight 完整历史

pending migration 成功提交后重跑同一比较，并要求 DB 行数等于 bundled chain。这样能抓 migrator
静默跳过、非单调 timestamp、插入 receipt 失败等情况。

### D3 · fresh reference 物理对比

同一 Bun/SQLite 进程创建 `:memory:`，FK OFF 重放全部 migrations、再 FK ON。采集 reference 与
真实 DB 的 canonical schema manifest：

- `sqlite_schema` 中非 `sqlite_%` 的 table/index/view/trigger name、type、normalized SQL；
- 每张表 `PRAGMA table_xinfo`（name/type/notnull/default/pk/hidden）；
- `PRAGMA foreign_key_list`；
- `PRAGMA index_list` + `index_xinfo`。

排除数据相关 `sqlite_sequence` 当前值和 migration receipt rows；schema 对象本身仍比较。

### D4 · 明确错误而非 500

新增 `DbSchemaDriftError`：stage 为 `migration-history-preflight`、
`migration-history-postflight` 或 `physical-schema`，differences 是 closed、安全、最多 50 项的
结构差异，例如：

```text
physical-schema: table mcp_runtime_test_turns missing column raw_command_digest
migration-history-preflight: 0125 hash differs (db abcd… / bundle ef01…)
```

`start.ts` 在 `db ready` 前捕获，释放 daemon lock，向 stderr 输出恢复指导并 exit nonzero。日志
不得含 SQL 文件正文、业务值或凭据。

### D5 · 不自动修复

提示只给安全动作：从已验证 backup 恢复、对开发空库重新创建、或编写一个新的 forward migration。
不得建议编辑旧 `__drizzle_migrations` 行或在生产手工补列后继续。用户本机已备份并手工补列是
本次现场处置，不成为产品自动策略。

### D6 · 启动顺序

顺序为：pre-migration backup 决策 → open/quick_check → history preflight → migrate pending → FK check
→ history postflight → physical reference compare → foreign_keys ON → 返回 db → 后续 skill/fusion/HTTP
barriers。任何 drift 都发生在业务服务启动前。

## 5. 能力与兼容性影响清单（需确认）

- **C1（启动收紧）**：过去会启动、随后某功能 500 的 drifted DB 现在 daemon 直接拒绝启动。
  这是显式运维中断，换取不对外服务错误 schema。
- **C2（历史 migration immutable）**：只改注释/空白也会改变已应用 migration hash并拒绝启动；
  已发布 migration 的任何修正必须新增 forward migration。开发者可重建无价值的本地空库。
- **C3（降级拒绝）**：DB 已应用的 migration 比当前 binary 更新时明确拒绝，不能用旧 binary 对新
  schema 继续服务。
- **C4（无自动数据改写）**：准入只读检查；失败不会补列、删列、改 receipt。若本次有 pending
  migration，现有 pre-migration backup 仍先执行。
- **C5（启动开销）**：每次 daemon 启动增加一次 migration 文件 hash（本来 migrate 也读取）和
  一次约几十毫秒的 in-memory replay/schema manifest；不进入请求热路径。

## 6. 用户故事

- 作为开发者，我在 migration 仍编辑时重启过 daemon；下一次启动直接告诉我“0125 hash 不同”，
  而不是几小时后 MCP 试跑 500。
- 作为管理员，我的 DB receipt 看似完整但缺一列时，daemon 点名表/列并停止，不运行 scheduler。
- 作为维护者，我能区分页损坏、migration history 漂移和物理 schema 漂移，选择正确 backup/forward
  migration 方案。
- 作为测试作者，fresh/rolling upgrade 的 reference 与真实 DB 同源，不维护一份手写列清单。

## 7. 验收标准

- **AC-1** fresh empty DB 通过，receipt 数等于 SQL 文件数，物理 manifest 等于 reference。
- **AC-2** 正常历史版本 rolling upgrade 通过，第二次 reopen 幂等。
- **AC-3** 已应用 SQL 改一个字节后，preflight 报精确 tag/hash mismatch，pending SQL 执行数 0。
- **AC-4** receipt 缺中间项、重复/乱序、未知新项、DB 比 binary 新分别 fail closed。
- **AC-5** receipt hash 全对但真实表缺 `raw_command_digest` 时，physical stage 点名表/列。
- **AC-6** extra column/table/index/trigger、FK/index 定义变化均被识别；业务数据差异不影响结果。
- **AC-7** drift error 关闭 SQLite、释放 daemon lock、发生在 `db ready`/skill barrier/HTTP 前。
- **AC-8** `AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK` 不跳过 drift；测试显式 skipMigrations 保持旧 seam。
- **AC-9** error/difference 不含 SQL 正文或任意业务 row；差异超过 50 项有总数/截断标记。
- **AC-10** 有 pending migration 时 backup 仍早于任何 DB 写；preflight 失败且无 pending 时零写。
- **AC-11** 当前 migration 数量规模下新增检查有独立基准，目标本机 p95 < 150 ms。
- **AC-12** macOS/Linux/Windows CI 均通过；SQL normalization 不依赖平台路径或 locale。
