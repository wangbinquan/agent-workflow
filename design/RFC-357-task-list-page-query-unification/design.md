# RFC-357：技术设计

## 1. RFC-294 对齐

- **bounded context**：`task-execution`（读模型的拥有者）；`task-catalog` 只消费 `TaskCatalogSource`。
- **落层**：查询构造与执行是 provider 细节，落 `modules/task-execution/infrastructure/taskListPage/`；
  投影出的 item 形状与页语义已由 shared 的 `TaskCatalogPageSchema` 定义，不新增 DTO。
- **本 RFC 承担的演进**：`services/taskOperations.ts`（1,196 行，SQLite 专属裸 SQL）**整文件删除**，
  归位进 `modules/task-execution`。它今天只有**一个**生产消费者
  （`sqliteTaskCatalogSources.ts:77`），其余引用全在测试里——这是 W4-E1 上少见的干净一刀。
- **留下的债**：`task-catalog` 仍收 full `Actor` + string filter、route 仍直取 composition
  （RFC-294 `design.md:181` 记的那条）。本 RFC **不**动它——typed query contract 是 task-catalog
  自己的一步，混进来会让这一刀同时改两个模块的公开面。写进 plan §5。
- **偏离项**：见 §10。

## 2. 使这一刀可行的既有基建（先说清楚，因为它决定了工作量）

「一份 SQL 跑两个 provider」不是本 RFC 要发明的东西，RFC-349 已经把地基铺完了：

1. **PostgreSQL 的业务客户端就是 drizzle 的 sqlite-proxy driver**：
   `PostgresqlDatabaseClient = SqliteRemoteDatabase<typeof schema> & {…}`
   （`platform/persistence/postgresqlDatabaseClient.ts:35`），语句在
   `:174` / `:209` 经 `compilePostgresqlSql` 把 `?` 编译成 `$n` 后交给连接执行。
   ⇒ **`db.all(sql\`…\`)` 在两个 provider 上是同一个调用**。
2. **表与列对象按 provider 切换**：`db/providerSchema.ts` 把同一份 `schema.ts` 声明投影成
   `pgTable`，所以 drizzle 查询构造器写一次即可。
3. **SQLite 函数在 PostgreSQL 上有 shim**：`json_valid` / `json_type` / `json_extract` /
   `instr` / `hex` / `max` / `unixepoch` 都在 PG 基线里建好
   （`db/postgresql-migrations/0000_rfc349_baseline.sql:8-29`）。
   ⇒ 列表页用到的 `json_valid` / `json_type` / `json_extract` 原样可跑。
4. **索引与物化列两侧都在**：`idx_tasks_branch_started_id` / `idx_tasks_list_started_id` /
   `idx_tasks_list_parent_started_id` / `idx_tasks_list_owner_started_id`
   （`0000_rfc349_baseline.sql:4003,4006,4027`），`branch_started_at` / `root_task_id`
   在 PostgreSQL 上有维护点。**本 RFC 零迁移**。

于是真正的工作量集中在 §6 那张**闭合的方言差异清单**，而不是「重写一遍查询」。

## 3. 目标形状

```
modules/task-execution/infrastructure/taskListPage/
  dialect.ts       —— SqlDialect：方言差异的唯一开关（§6）
  filters.ts       —— view / statuses / subject / origin / q / scope / catalogVisibility → SQL 条件
  authorization.ts —— 可见性与 scope 谓词（今天两侧各一份，见 §5）
  query.ts         —— 三种页形状：默认快路径 / 过滤快路径 / 子页；facets CTE
  projection.ts    —— OperationsSqlRow → TaskCatalogListItem（含 Number() 归一，§6-3）
  page.ts          —— 编排：parse → build → db.all → 富化（owner / childCount / failureCode）→ 页
  sqlite.ts        —— 绑定 DbClient + SQLite dialect + SQLite 富化查询
  postgresql.ts    —— 绑定 PostgresqlDatabaseClient + PG dialect + PG 富化查询
```

两个目录源退化成薄适配：`sqliteTaskCatalogSources.ts` / `postgresqlTaskCatalogSources.ts`
各自只剩「取 sourceId → 调 `page.list(...)` → 返回」。`services/taskOperations.ts` 删除。

## 4. 接口契约

```ts
export interface TaskListPageDeps {
  /** 两个 provider 的 drizzle 客户端都满足这一面（§2-1）。 */
  readonly all: (query: SQL) => Promise<readonly unknown[]>
  readonly dialect: SqlDialect
  /** 富化：三次批量查询，形状与今天 SQLite 侧逐字相同。 */
  readonly owners: OwnerIdentityQueries
  readonly childCounts: (
    ids: readonly string[],
    f: AuthorizedChildCountFilters,
  ) => Promise<Map<string, number>>
  readonly failureCodes: (rows: readonly FailureCodeProbe[]) => Promise<Map<string, string | null>>
  /** 可见性子查询：唯一的 provider 差异（§5）。 */
  readonly collaboratorTaskIds: (userId: string) => SQL
}

export function createTaskListPage(deps: TaskListPageDeps): {
  list(
    actor: Actor,
    raw: TaskOperationsRawQuery,
    options: TaskListPageOptions,
  ): Promise<TaskOperationsPage>
}
```

`TaskOperationsRawQuery` / `TaskOperationsPage` / cursor 编码**逐字沿用**今天 `services/taskOperations.ts`
的定义（它们已经是 `/api/task-catalog` 的实际 wire 形状），因此 AC-9 是「不变」而不是「兼容」。

## 5. 授权谓词：今天已经是两份，一并收掉

- SQLite：`modules/task-execution/infrastructure/legacySqliteTaskAuthorization.ts:17-51`
- PostgreSQL：`postgresqlTaskRouteOperations.ts:426-441`（`visibilityCondition`）

两者形状相同（`owner = me OR id IN (select task_id from task_collaborators where user_id = me)`，
`shared` 再加一条 `owner IS DISTINCT FROM me`），差异只在客户端类型。收成一份
`authorization.ts`，provider 通过 `collaboratorTaskIds(userId): SQL` 注入子查询——每侧一行。

> ⚠️ 两侧 `shared` 语义要逐字核对后再合并：SQLite 写的是
> `or(isNull(ownerUserId), ne(ownerUserId, me))`，PostgreSQL 写的是
> `owner_user_id IS DISTINCT FROM me`。这两个在 `owner_user_id IS NULL` 时**同为真**、
> 其余情况同值，可以合并；但这个结论必须由用例钉住而不是靠读代码，因为 `ne(NULL, x)`
> 在 SQL 里是 NULL 不是真——SQLite 侧靠 `isNull(...) OR` 补上了这一支。
> 合并后取 `IS DISTINCT FROM` 一种写法（两个方言都支持），并留一条三态用例
> （owner=me / owner=other / owner IS NULL）。

## 6. 方言差异清单（闭合；每条都有断言）

> **实现后修订（2026-09-04）**。落地时逐条核对，清单本身变了，都记在这里而不是悄悄改：
>
> - **没有引入 `dialect.ts` 抽象。** 原计划的 `SqlDialect` 每个方法核对下来都退化成恒等：
>   PostgreSQL 的业务客户端就是 drizzle 的 sqlite-proxy driver（`db.all(sql)` 两侧同一个调用、
>   同一种返回形状）；四个 SQLite 函数在 PG 基线里有同名 shim 且 `search_path` 让裸名解析；
>   `AS MATERIALIZED` / `WITH RECURSIVE` / 行值比较 / `NULLIF` / `||` 两方言同义；用户搜索两侧
>   本来就已经 `lower()` 了。抽一层什么都不做的间接层没有价值——依据逐条写在
>   `taskListPage/db.ts` 头注释里。
> - **真库 lane 抓到了清单里没有的两条**（下表 #10 / #11），而且是分两次抓到的。这正是它存在
>   的理由：两条在假 pool（只断言 SQL 文本）那一层完全看不见，症状也都不是报错，是**静默的
>   错值**——#10 让工作组名恒为 NULL，#11 让翻第二页 422。#11 那处正是 PR-2 的静态守卫逐字
>   列举字段时漏掉的一处，守卫因此改成从类型声明推导。

来源：`docs/dev-gotchas.md` §「SQL 长得一样」证明不了「两个 provider 行为一样」的六条实测，
加上本页自身的形状审计。**清单闭合**是这一刀敢做的前提——不闭合就等于在写一份没人验证过的 SQL。

| #   | 差异                                                                                                                                                                                         | 处置                                                                                                                                                                                                 | 断言                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `LIKE`：SQLite 对 ASCII 不敏感，PostgreSQL 敏感                                                                                                                                              | **在这一页不成立**：查询两侧本来就已 `lower(列) LIKE lower(模式)`。不动它，改成钉住这个前提                                                                                                          | 前提侧在 `bun:sqlite` 里可执行钉住；再断言每一处 `LIKE` 的左侧都裹在 `lower(` 里、且不存在裸 `LIKE`（变异：拿掉任意一处 `lower()` 立刻红） |
| 2   | 标量子查询里的 `COUNT(*)`：PostgreSQL 回 int8 ⇒ 驱动交回字符串                                                                                                                               | 不改 SQL：投影层统一归一（`numeric` / `nullableNumeric` / `numericOrZero`），非有限值直接抛                                                                                                          | 真库断言每个数值字段与四个 facets 的运行时类型都是 `number`                                                                                |
| 3   | 普通整数列（`started_at` / `running_ms` / `repo_count` / `invocation_depth` / `branch_started_at`）经**裸 SQL** 回读的运行时类型                                                             | 投影层逐列 `Number(...)`；`requiredRow` 把「不是有限数」当缺陷抛，而不是让它流进 zod 报一个看不懂的错                                                                                                | 真库逐列断言运行时类型                                                                                                                     |
| 4   | NULL 排序方向相反                                                                                                                                                                            | 排序键 `branch_started_at` 是 `NOT NULL DEFAULT 0`（`db/schema.ts:1195`），本页不受影响                                                                                                              | 加一条**前提断言**钉住该列的 NOT NULL；前提变了先红在前提上                                                                                |
| 5   | 行值比较 `(a, b) < (?, ?)` 的执行计划                                                                                                                                                        | 两侧都保留行值形式（RFC-311 实测：展开成 `OR` 会让 SQLite 落 TEMP B-TREE）                                                                                                                           | 两侧各一条真执行的翻页用例 + SQLite 侧保留既有 EXPLAIN 断言                                                                                |
| 6   | `json_extract` / `json_valid` / `json_type`                                                                                                                                                  | PG 基线已装 shim，原样使用                                                                                                                                                                           | 真库断言 `workgroup_name` 从 `workgroup_config_json` 正确取出，含非法 JSON 行退化为 NULL                                                   |
| 7   | 绑定参数 `?` → `$n`                                                                                                                                                                          | `compilePostgresqlSql` 已处理                                                                                                                                                                        | 由真库执行本身覆盖                                                                                                                         |
| 8   | `WITH RECURSIVE` / `LEFT JOIN … ON 1 = 1` / `NULLIF` / `CASE`                                                                                                                                | 两方言同义                                                                                                                                                                                           | 由真库执行本身覆盖                                                                                                                         |
| 9   | 未标类型的参数在比较里可能需要显式 cast（PostgreSQL 的 `$n` 无类型推断兜底时）                                                                                                               | 落地实测**没有出现**；不预先猜也不预留                                                                                                                                                               | 由真库 lane 的执行本身覆盖                                                                                                                 |
| 10  | **`json_type` 的返回词汇表不同**：SQLite 给 JSON 字符串返回 `'text'`，PG 的 shim 转发 `jsonb_typeof`、返回 `'string'`（数字 `integer`/`real` vs `number`，布尔 `true`/`false` vs `boolean`） | 查询同时接受两种拼法。**不改 shim**：bootstrap 语句进 schema plan digest，改动会让存量 PG 部署以 `postgresql-schema-drift` 起不来（`postgresqlMigrator.ts:97`），那需要一套 RFC-349 还没建的迁移故事 | 两头都钉：shim 现在确实还是 `jsonb_typeof`、查询确实四处都收两种拼法。通用教训进 `docs/dev-gotchas.md`                                     |
| 11  | **分页游标**也从裸行读数值                                                                                                                                                                   | `page.ts` 的 `branch_started_at` 同样走归一。判据从「逐字列举字段」升级成「从 `OperationsSqlRow` 的类型声明取全部数值列，每个都必须被 helper 包住」                                                  | `rfc357-provider-portability` 的类型驱动断言；变异（去掉游标归一）立刻红                                                                   |

## 7. 数据流

```
GET /api/task-catalog?type=&view=&q=&statuses=&scope=&origin=&parent_id=&cursor=&limit=
  → TaskCatalogQueryService.list：按权限挑源，逐源并发调用 source.list
      → (每个源) taskListPage.list(actor, raw + subject=sourceId)
          → parse（既有 parseTaskOperationsQuery，含 cursor 指纹校验）
          → build：facets CTE + 页 CTE（keyset，LIMIT limit+1）
          → db.all(sql)                                  ← 一次往返
          → 富化：owners / childCounts / failureCodes      ← 三次批量往返，只对本页 id
          → 投影 + cursor
  → 合并四个源的 items（按 branchStartedAt DESC, id DESC）+ 求和 facets
```

每源每页：**4 次往返，返回行数上界 `limit + 1`**（今天 PostgreSQL 是「1 万行 + N 个失败任务各一次」）。

## 8. 失败模式

| 模式                           | 现状                                      | 本 RFC 之后                             |
| ------------------------------ | ----------------------------------------- | --------------------------------------- |
| 库很大                         | PostgreSQL 上每次翻页搬 1 万行宽行 ×3     | 上界 `limit+1` 行窄投影 ×3              |
| 某个源没有行                   | 仍付全量代价                              | 索引上一次 seek，零行                   |
| 失败任务很多                   | N+1                                       | 一次批量（沿用 `loadTaskFailureCodes`） |
| PostgreSQL 特有的 SQL 语义差异 | 无人发现（假 pool 只断言 SQL 文本）       | §6 清单 + 真库 lane，红在 lane 上       |
| 两个 provider 语义漂移         | 已经漂了三处（facets / origin / 层级）    | 只有一份实现；oracle 两侧各跑一遍       |
| 游标跨 provider                | 指纹里已含 actor + filters，不含 provider | 不变（同一份实现 ⇒ 同一份语义）         |

## 9. 前端：WS 帧就地更新（G6）

诚实前提：§7 之后单次重取已降到 O(页)，所以这一节的收益是**额外的**，不是本 RFC 的主要收益。
按帧能patch 的就 patch，patch 不了的仍走失效——不假装全部能增量。

| 帧                                                       | 载荷                      | 处置                                                                                                                           | 理由                                                                                    |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `task.status`                                            | `taskId` + `status`       | **就地 patch**：改缓存里该行 `status`，按 `taskMatchesListView` 用「旧状态 / 新状态 + 该行 openAlertCount」增量修正四个 facets | 跑动中的任务持续产生这类帧，是唯一的高频面                                              |
| `task.deleted`                                           | `taskId`                  | **就地 patch**：移除该行并回退它对四个 facets 的贡献                                                                           | 精确可算                                                                                |
| `task.created`                                           | `TaskSummary`             | 仍失效                                                                                                                         | 该行是否命中当前 filters/scope/view、以及它的 owner / childCount / 层级，客户端算不出来 |
| `lifecycle.alert` / `.resolved`                          | `taskId` (+ new/promoted) | 仍失效                                                                                                                         | `resolved` 不携带剩余告警数，patch 只能是猜                                             |
| `task.members.changed` / `employee-case.members.changed` | id                        | 仍失效                                                                                                                         | 可见性变化只有服务端知道                                                                |

另加一条**低频对账**：即使只收到可 patch 的帧，也每 N 秒（默认 30s，可调）做一次
`invalidateQueries` 兜底，防止 patch 累积漂移。断线轮询与重连对账逻辑保持不变。

界面契约不变：不空屏、不回顶部、不折叠已展开分支（`useTaskOperationsSync` 现有注释里
记的那三条 2026-08-26 回归，测试继续锁）。

**行离开当前 view 时不就地移除**：`running → done` 在「进行中」页签下会让该行不再匹配，
但把它从屏幕上抽走会打断正在阅读的用户、并让游标与已加载页数对不上。就地更新状态 chip，
行的进出交给下一次对账重取——这与今天「失效后重取，行随之消失」的最终态一致，只是不再
在每一帧上立刻发生。

## 10. 偏离项（呈用户确认）

- **D-1**：`taskListPage/` 落在 `infrastructure/` 而不是 `application/`。理由：它构造并执行 SQL。
  代价：一段 provider-neutral 的代码住在 infrastructure 层。备选是把「查询形状」放 application、
  「执行」放 infrastructure，但那会把一份 SQL 拆成两个文件、且拆点不自然。
- **D-2**：本 RFC **不**把 task-catalog 的 full-Actor / string-filter 面改成 typed query contract
  （RFC-294 `design.md:629` 的目标），留给 task-catalog 自己的一步。
- **D-3**：cursor 编码不变（仍是 base64url JSON + 过滤指纹），不上 RFC-294 `design.md:819`
  设想的 HMAC 版本——那是 task-catalog 的合同变更，与本 RFC 的性能/归一目标正交。
- **D-4**：SQLite 侧的 `pipeline: 'exhaustive'` 逃生开关保留（oracle 依赖它做新旧对照）。
