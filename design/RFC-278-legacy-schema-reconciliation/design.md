# RFC-278 · 技术设计

状态：In Progress（用户已批准，并要求 live schema 精简）。先读 [`proposal.md`](./proposal.md) 的边界与 C1–C7。

## 1. 已验证现场

| 检查               | 结果                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| 当前 source probe  | `opencode`、`zhipuai/glm-5.2` → `conforms=true`，session/nonce captured |
| 旧错误来源         | pre-RFC-276 daemon 生成隐藏 launcher argv，升级后 CLI 已删除入口        |
| DB history         | 8 个 exact legacy hash；最新已应用为 0141                               |
| 副本应用 0142–0144 | 成功，但 physical manifest 仍 8 differences                             |
| 保留数据           | recovery 19 rows                                                        |
| cutover 状态       | MCP create receipt 1 row 尚未过期，但指向 0144 将 reset 的旧 session    |
| 退役数据           | `recent_repos` 3 rows；legacy runtime archive 只服务一次性回滚          |

所有数字只用于现场验收；migration 本身不按 row count 写分支，也不把行内容写入日志。

## 2. History compatibility 数据模型

在 `schemaAdmission.ts` 邻近链读取处维护 closed constant：

```ts
const LEGACY_MIGRATION_HASHES: Readonly<Record<string, readonly string[]>> = {
  '0052_rfc108_recovery_events': ['<full sha256>'],
  // proposal D1 的其余 7 项
}

function migrationHashMatches(expected: ExpectedMigration, actualHash: string): boolean {
  return (
    actualHash === expected.hash ||
    LEGACY_MIGRATION_HASHES[expected.tag]?.includes(actualHash) === true
  )
}
```

调用仍先验证 `created_at === folderMillis` 与 64 位 lowercase hex。alias 以 expected chain 当前索引的
tag 为 key，因此不能跨 migration 搬用；不改变 `ExpectedMigration.hash`，fresh-reference cache key 与
canonical full replay 仍只认当前 SQL bytes。

## 3. 0145 migration

文件：`packages/backend/db/migrations/0145_rfc278_legacy_schema_reconciliation.sql`，journal
`idx=144`、`when=1788278400019`。

### 3.1 recovery_events 无损收敛

真实备份副本进一步证明 legacy 0052 不只缺两个索引：`sqlite_schema.sql` 还保留了旧版行内注释，
列、PK 与数据语义虽然相同，但 RFC-275 的 canonical physical manifest 会指出定义不一致。0145
因此在同一 migration transaction 内按 9 个显式列复制到 canonical 临时表，替换旧表后重建两个
索引。升级测试在前后读取完整 recovery rows 并逐列比较；任何复制失败都会回滚整个 migration。

### 3.2 mcp_runtime_test_create_receipts

先删除旧表，再按当前 0125 定稿形态创建空表，恢复：

- `(mcp_id, owner_user_id, client_create_id)` composite PK；
- `mcp_id → mcps.id ON DELETE RESTRICT`；
- `owner_user_id → users.id ON DELETE RESTRICT`；
- 64 位 lowercase digest、非负 created、expires > created CHECK；
- expiry index。

不复制旧 receipt。它是 24 小时幂等 cutover 状态，不是业务历史；0144 已明确终止旧 native
session，保留 receipt 会把客户端 replay 指回已结束会话。升级后服务仍按原契约写入新 receipt，
并由现有 reconcile 过期清理。

### 3.3 recent_repos

`DROP TABLE IF EXISTS recent_repos`。当前 schema、service、route 均无该表；RFC-165 测试已锁定
`cached_repos` 是产品表。0145 不把三条 path 搬到 `cached_repos`，避免把已退役、无权威 repo id 的
机器历史重新解释为用户资源。

### 3.4 rfc276_legacy_runtime_archive

`DROP TABLE IF EXISTS rfc276_legacy_runtime_archive`。0144 先把被删除的 hardening 状态归档以便一次性
回滚；0145 运行前已有完整 pre-migration backup，live product 零读取该表。保留它只会让已废弃的
identity/network/store 数据继续占据当前 schema。

## 4. 启动序列

```text
pre-migration backup
  → quick_check
  → exact prefix history (canonical OR exact legacy alias)
  → Drizzle transaction applies 0142…0145
  → foreign_key_check
  → complete history (canonical OR exact legacy alias)
  → canonical full-replay physical manifest
  → HTTP / scheduler
```

任一箭头失败均不启动业务服务。旧 daemon 先通过现有 `stop` 控制面优雅退出；没有 active business
run 才进行现场切换。Vite 与 daemon 从同一 checkout 同时重启。

## 5. 测试设计

### 5.1 History alias polarity

- canonical hash 通过；
- proposal D1 八项逐项通过；
- 每项最后一个 nibble mutation 拒绝；
- legacy hash 放到相邻 tag 拒绝；
- when 改一毫秒拒绝；
- 原 RFC-275 “append comment after applied” case 继续拒绝。

### 5.2 Legacy physical fixture

测试从真实 migration 文件截断 journal 到 0141，建立 DB 后构造已观测历史形态：legacy receipt
hashes、带行内注释且缺 indexes 的 recovery DDL、无 FK/CHECK 的 create receipts、额外
recent_repos。种入带 sentinel 字段的 recovery 行与一个旧 create receipt，再用 production
`openDb` + full folder 升级。

断言：

- full migration receipt count 与 journal 一致；
- recovery 每列值与升级前快照一致；
- create receipt row 清零，table_xinfo/FK/index/check 与 fresh replay 相同；
- `recent_repos` 与 `rfc276_legacy_runtime_archive` 均不存在；
- `assertPhysicalSchema` 与第二次 `openDb` 均通过。

### 5.3 Mutation

- migration 未收敛 recovery definition、少建任一 recovery index / receipt FK 或保留任一 retired
  table：physical oracle 必红；
- 升级后新 receipt 的 invalid digest/time 与 missing user/MCP 继续被 CHECK/FK 拒绝；
- 把 alias 改成宽前缀/任意 hash 时，history polarity 测试必红。

### 5.4 Runtime regression

保留 RFC-276 reverse guard；当前 `runtimeSmoke` mock 与一次 operator real probe 证明 argv 从
registered binary 直接进入 `opencode run`。测试不得重新出现 retired hidden subcommand 字面量。

## 6. 发布与回滚

1. exact-path commit/push；等待 exact/containing SHA CI 终态。
2. 确认全局 DB 无 running/queued task。
3. 优雅停止旧 daemon；保留启动自动生成的 pre-migration backup 路径。
4. 从含 RFC-278 的 main 启动；核对 quick/FK/schema admission。
5. UI 重试 OpenCode probe，并用直接 smoke 结果交叉验证。

若 0145 失败，不编辑 receipt 或手工删行；daemon 保持关闭，使用刚生成的 verified backup 回滚后分析
具体 invalid/orphan 证据。旧 binary 不能对已经应用 0145 的 DB 继续运行。
