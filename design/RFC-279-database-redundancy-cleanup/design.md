# RFC-279 · 技术设计

状态：Done（实现 `fa4fdcc3`；exact-SHA CI 全绿）。先读 [`proposal.md`](./proposal.md) 的能力影响清单与 AC-1～AC-9。

## 1. Migration 排序与并发边界

开工时共享工作树已有未提交的 `0146_gitlab_repository_url_prefixes`、journal idx 145 与计数锁 146。本 RFC 按多人迁移纪律等待其以 `ccdef839` 正式落库后重读 HEAD，再连续落为 `0147_rfc279_database_redundancy_cleanup`（journal idx 146，`when` 严格递增），未修改或暂存并发 RFC 的 0146 文件。

## 2. Forward migration

migration 全程由既有 Drizzle migration transaction 承载，顺序如下。

### 2.1 fail-closed guards

建立 migration-scoped guard table，以 `CHECK(ok = 1)` 断言：

- `skills.source_kind = 'managed'`；
- `task_questions.reopen_count = 0` 且 `prior_answer_snapshot_json IS NULL`；
- `task_questions.manual_title IS NULL OR manual_title = question_title`；
- `skill_operations.kind IN ('reserve','migrate','delete','version-write')` 且 `next_skill_id IS NULL`。

任一反例使整次 migration 回滚。guard table 在 DROP COLUMN 前删除，不进入终态 manifest。

### 2.2 cached repo legacy escrow

SQL 无 SecretBox，不能把旧 `url` 直接加密，也不能在 direct upgrade 中先等待 boot gate。故在删列前：

```sql
UPDATE cached_repos
SET url_enc = 'aw-legacy-url-hex-v1:' || hex(CAST(url AS BLOB))
WHERE length(url) > 0 AND (url_enc IS NULL OR length(url_enc) = 0);
```

closed prefix 只允许 `ensureCredentialsSealed` 解码。普通 `unsealRepoUrl` 遇到该前缀 fail closed，因此即使未来有人把业务读提前，也不会把 migration escrow 当作合法 ciphertext。成功启动会把它原子 UPDATE 为 `secretBox.seal(plain)` + `redactGitUrl(plain)`；崩溃则下次幂等重试。

### 2.3 物理删除与 operation rebuild

- `skills DROP COLUMN source_kind`、`DROP COLUMN migration_marker`；
- `task_questions DROP COLUMN reopen_count`、`prior_answer_snapshot_json`、`manual_title`；
- `cached_repos DROP COLUMN url`；
- `skill_operations` 采用显式列清单 rebuild，去掉 `next_skill_id` 并把物理 kind CHECK 收窄到当前四值，随后恢复 `uq_skill_operations_active` partial unique index。

显式 rebuild 避免留下仍允许 `replace/adopt-managed`、却已没有 second-id 表达面的矛盾 DDL。`skill_operation_locks` 不重建、不清空；active operation 与其单 ID lock 在同一 migration transaction 前后保持。

## 3. 启动密封顺序

`createSecretBox` 与 `ensureCredentialsSealed` 从当前 step 6c 前移到 `openDb` 成功后的第一个 credential 行为，并早于 skill migration barrier、repair、seeder、scheduler 与 HTTP。顺序为：

```text
pre-migration backup
  → openDb / apply migration (legacy URL → escrow; DROP url)
  → createSecretBox
  → ensureCredentialsSealed (escrow → real ciphertext + redacted display)
  → all recovery / seeder / scheduler / HTTP
```

push credential resolver 继续复用同一个 SecretBox，只选 `url_enc`；不再有 plaintext fallback。backup 命令同样先跑 sealing gate，所以 crash-left escrow 不会进入新 backup。

## 4. 生产代码收口

### 4.1 skills

- schema 删除两列；create/import INSERT 不再写 `sourceKind`；`rowToSkill` 继续固定返回 `sourceKind:'managed'`。
- boot verify 与 version reconcile 删除 `skills.sourceKind='managed'` SQL 条件；表内所有行已由 migration guard 证明 managed。
- 保留 runtime/project skill 的内存判别：`ResolvedSkill.sourceKind` 仍是 `'managed'|'project'`，不等于 DB 列。

### 4.2 task questions

- schema 删除三列；创建手工问题只写 `questionTitle/title`、`manualBody`、`manualCreatedBy`。
- queue/prompt 的 manual entry 改读 `questionTitle`，正文仍读 `manualBody`。
- `TaskQuestionListEntry.reopenCount` 暂返回 literal `0`，维持现有 JSON shape；不得从 DB 读取。
- `clarifySeal` 删除“未来 reopen”墓碑注释；历史 RFC 不改写。

### 4.3 cached repos

- 新 INSERT 总写 `urlRedacted`，有 SecretBox 时写 `urlEnc`，无 SecretBox 时为 NULL；绝不落原始 URL。
- list/repo-group/refresh/delete diagnostics 只读 `urlRedacted`，缺失时显示 closed placeholder，不尝试从 ciphertext 派生展示值。
- reuse-by-id、webhook hash collision verification、file:// legacy re-key 通过 `unsealRepoUrl({urlEnc}, secretBox)`；无法解封即维持各自既有 fail-closed/告警分支。无 SecretBox 的 embedding 只在当前 `DbClient` 生命周期持有 WeakMap URL capability，DB reopen 后明确不可恢复。
- `ensureCredentialsSealed` 只负责 escrow/缺 redaction 修复及其它 credential scrub，不再 blank 已删除的列。

### 4.4 skill operations

`BeginOperationSpec` 删除 `nextSkillId`，intent 永远只 acquire `[skillId]`。identity barrier 删除 second-id malformed/physical claim 分支；锁一致性仍核对每个 active op 的 primary skill ID。

## 5. 兼容与失败序列

| 序列                                   | 结果                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| 旧库 `url` 明文、`url_enc=NULL` → 直升 | migration 写 escrow；boot gate 真密封；URL 保留             |
| migration 提交后、boot gate 前崩溃     | 下次启动识别 escrow 并真密封；不重复 DROP                   |
| `url_enc` 已真密封、`url=''`           | migration 只删空列；boot gate no-op                         |
| escrow 解码损坏                        | fail closed，记录不含 secret 的错误；不把内容交给 Git       |
| SecretBox key 丢失                     | 与现状一致：按 id reuse 409，用户重新录入 URL               |
| reopen/second-id 异常数据              | migration CHECK 失败并整体回滚；pre-migration backup 可恢复 |
| manual title 与 question title 分歧    | migration 拒绝，避免猜谁是权威                              |

## 6. 测试策略

1. 新 migration fixture：每张表放保留字段与目标列，执行后断列缺失、数据/索引/CHECK 完整。
2. migration polarity：逐项 mutation guard，异常行均必失败且原 schema/data 回滚。
3. credential direct-upgrade：plaintext → escrow → sealing gate → real ciphertext；另测 crash-resume与已密封 no-op。
4. credential service：cold insert 不落明文；list/refresh/delete/repo-group 只显示 redacted；按 id、webhook 与 file legacy re-key 覆盖有 key/无 key/错 key。
5. skill service/version/boot tests：wire `sourceKind='managed'` 不变，SQL schema 无列。
6. task question manual/service/prompt tests：标题正文与 prompt golden 不变，`reopenCount===0`。
7. skill operation/recovery tests：四 kind + 单 ID lock；删除原 two-id synthetic case，补 migration 对 non-null next id 的反向锁。
8. source guard：当前 schema/生产代码不得再出现七个物理列名；历史 migrations/design/tests 允许。
9. `upgrade-rolling` journal count + frozen homes、full backend、workspace gate。
