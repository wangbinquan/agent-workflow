# RFC-275 · 技术设计

状态：Done（2026-08-10）。本文定义 migration-chain 与 physical-schema 两级准入。

## 1. 当前锚点

| 事实                    | 当前源码                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| DB open/migrate         | `packages/backend/src/db/client.ts#openDb`                                               |
| integrity gate          | 同文件 `DbCorruptionError` + `PRAGMA quick_check`                                        |
| fresh snapshot          | 同文件 `migratedSnapshot`，full replay 约 18 ms                                          |
| boot handling           | `packages/backend/src/cli/start.ts`：pre-migration backup → openDb → `db ready`          |
| migration reader        | `drizzle-orm/migrator#readMigrationFiles` 正式 export，返回 hash/folderMillis/sql        |
| migrator gap            | SQLite dialect 只读最后一行 created_at，不校验历史 hash                                  |
| schema parity precedent | `packages/backend/tests/createindb-snapshot-parity.test.ts` 的 sqlite_master fingerprint |
| timestamp guard         | `packages/backend/tests/upgrade-rolling.test.ts` 的 journal when 单调测试                |

## 2. 数据结构

```ts
type SchemaDriftStage =
  | 'migration-history-preflight'
  | 'migration-history-postflight'
  | 'physical-schema'

type SchemaDifference =
  | {kind:'migration-missing'|'migration-extra'|'migration-hash'|'migration-order'; tag:string; ...}
  | {kind:'object-missing'|'object-extra'|'object-changed'; objectType:string; name:string}
  | {kind:'column-missing'|'column-extra'|'column-changed'; table:string; column:string}
  | {kind:'foreign-key-changed'|'index-changed'; table:string; name:string}

class DbSchemaDriftError extends Error {
  dbPath: string
  stage: SchemaDriftStage
  differences: readonly SchemaDifference[] // capped projection
  totalDifferences: number
}
```

Error message 由 difference formatter 生成，不接收 arbitrary SQL/error body。hash 只显示前 12 hex；
dbPath 只在 daemon-local stderr guidance 中显示，不进入 HTTP（HTTP 尚未启动）。

## 3. Migration history pre/postflight

### 3.1 Expected chain

```ts
const expected = readMigrationFiles({ migrationsFolder }).map((m, index) => ({
  index,
  folderMillis: m.folderMillis,
  hash: m.hash,
  tag: journal.entries[index].tag,
}))
```

`readMigrationFiles` 不返回 tag，故同一次读取 `_journal.json` 只取 tag/idx 并与返回长度、when
逐位对拍；journal parse/文件缺失沿配置启动错误失败，不归为 DB drift。

### 3.2 Actual chain

先查 `sqlite_schema` 是否有 `__drizzle_migrations`。无表 ⇒ `[]`；有表则：

```sql
SELECT id, hash, created_at
FROM __drizzle_migrations
ORDER BY created_at ASC, id ASC
```

每行要求 id/hash/created_at 类型可解析、hash 64 lowercase hex。比较 exact prefix，不用 set：中间
缺口或重复必须可见。preflight 允许短前缀；postflight 要 exact full length。

### 3.3 Fresh DB nuance

fresh DB 在 migrator 调用前没有 receipt table，合法。若 receipt table 存在但为空而业务表已存在，
preflight 仍允许空前缀，随后 migration 很可能撞 table exists；该异常转成普通 migration failure。
physical compare 不掩盖 migration SQL 错误。

## 4. Canonical physical manifest

### 4.1 Object inventory

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type, name
```

normalize SQL 仅统一 SQLite 在同一进程可产生的首尾空白/连续空白和标识符 quote，不做语义 SQL
parser 重写；同一 binary fresh replay 是对照，过度 normalize 会漏 check/default 差异。

### 4.2 Per-table details

对每个 user table（含 `__drizzle_migrations`）收集：

- `PRAGMA table_xinfo(quotedName)`；
- `PRAGMA foreign_key_list(quotedName)`；
- `PRAGMA index_list(quotedName)`，再对每个 index `PRAGMA index_xinfo`；

每组转换为 plain JSON record、只保留 schema 字段、按稳定复合 key 排序，再用现有
`canonicalizeIdentity/identityDigest`。identifier 必须由从 sqlite_schema 读到的 name 经安全 quote
helper 处理，绝不拼用户请求。

manifest 不读 table rows、row count、sqlite_sequence value、page/WAL metadata。

### 4.3 Reference lifecycle

每次 production `openDb` postflight 创建 raw `Database(':memory:')`：FK OFF → full migrate → FK ON →
collect manifest → close in finally。不要直接复用进程级 `migratedSnapshotCache`：若开发进程中 migration
folder bytes 改变，旧 cache key 只有 path、会拿过期 reference。可新增以完整 expected-chain digest
为 key 的 cache，但首版优先每 boot 重放，先用 benchmark 决定。

### 4.4 Diff

先按 object key 找 missing/extra，再对共同 table 逐 column/FK/index diff；共同非 table object 比
normalized SQL digest。输出按 kind/table/name 排序，保留前 50 + total。对 table SQL changed 且已有
更细 column/FK/index 差异时不重复大段 generic changed，只保留无法细分的 table option 差异。

## 5. `openDb` integration

```text
open SQLite
set WAL/synchronous/busy_timeout
quick_check (unless existing integrity escape hatch)
read expected migration chain
compare history prefix                       <-- no migration writes yet
foreign_keys OFF
migrate
foreign_key_check (existing warning semantics)
compare history exact full
foreign_keys ON
build fresh reference + compare physical
return drizzle db
```

任何步骤 throw：close raw SQLite in catch/finally；`DbCorruptionError` 与 `DbSchemaDriftError` 保持不同
类型。`skipMigrations:true` 完全跳过 history/reference，因测试可能注入自定义 schema；production
调用不设。`skipIntegrityCheck` 只跳 quick_check。

注意 pre-migration backup 在 `start.ts` 调 openDb 之前，维持现有顺序。physical drift 如果发生在
pending migration 后，backup 已存在；没有 pending 时所有 drift 检查只读。

## 6. Boot guidance

`formatDbSchemaDriftGuidance` 输出：stage、最多 10 条人类可读差异、剩余数量、DB path、三个安全
选项：restore verified backup / disposable dev DB recreate / add forward migration。明确“不要编辑 receipt
或旧 migration”。捕获后 release daemon lock、stderr write、exit 1，与 corruption 路径对齐。

不得 catch 后继续 degraded mode：schema 不可信时任何 ORM query 都可能 500 或更坏地误写。

## 7. 测试策略

### History

- fresh、完整、每个 freeze target rolling upgrade；
- applied SQL 后改注释/DDL：hash mismatch 且 spy 证明 migrate 未执行；
- missing middle、duplicate timestamp/hash、reordered、unknown newer、binary downgrade；
- postflight 用 stub migrator 漏 receipt/漏 migration，必须抓。

### Physical

- 复现 0125：保持 receipt/hash，重建 `mcp_runtime_test_turns` 少 `raw_command_digest`；
- extra/missing/changed column default/notnull/pk/hidden；
- explicit index、partial index SQL、FK action、view/trigger；
- 同 schema 不同业务 rows/sequence 值通过；
- > 50 diffs 截断且 deterministic。

### Lifecycle

- error 后文件可重新 exclusive open（证明 connection close）；
- start ordering source/DI test：drift 在 db-ready/skill barrier/server 前，lock release；
- backup ordering；skip seam polarity；跨 OS identifier/quote fixtures；
- benchmark fresh/full reopen/rolling upgrade，多次采样报告 p50/p95。

## 8. 安全与兼容

检查只读取 schema metadata 和 migration receipts，不触碰业务 rows。历史 hash 不是秘密。错误不会
进入 HTTP，因为 daemon 未启动；日志仍有最大长度。新 binary 拒绝 drift，旧 binary 回滚仍可能
继续服务错误 DB，因此运维文档必须把“不要靠回滚绕过”写清楚。

本 RFC 无 DB migration：它检查已有链，不靠新增 receipt 表自证。实现新增源文件可放
`packages/backend/src/db/schemaAdmission.ts`，让 `client.ts` 只保留顺序编排。
