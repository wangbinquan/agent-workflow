# RFC-349 — 数据库 Provider、PostgreSQL 一键迁移与 Schema Contract

- 状态：**Approved / Closing（2026-09-03）**；用户已于 2026-08-31 批准 D1～D14 并授权完整实现。T0–T10 全部落地、功能面已闭合：exact implementation SHA `b3883154eb1cfe575e578ee3cf2664fbb57ce797` 上 Main CI run `33722386454` terminal success，同 SHA hosted `postgresql-evidence`（run `33722869768`）取证 job 全绿（Verdict PASS、crash/resume 26/26、三平台 compiled 全绿）；该 run 整体因一条 lane 的拓扑缺陷未 terminal（已在 `adcea41bf` 修复，详见 [`verification.md`](./verification.md) §3）。AC-15 要求最终 exact SHA 的 Main CI 与全部适用 scheduled workflows terminal success 后才标 Done
- 开工 source pin：`3f6b854e33f8fd5c73fe2f9cde8032d179f32e13`
- 依赖：RFC-294 目标架构、RFC-310 legacy code-capability cutover、RFC-338 maintenance Worker、RFC-346 System Operations；实施时与仍在推进的 RFC-345 Resource Catalog owner 协调重叠 consumer
- 性质：数据库能力扩张 + 持久化架构迁移 + 显式 schema contract；不是 RFC-338 的补丁

## 1. 摘要

平台当前只支持本机 SQLite。RFC-338 已根治周期维护占用 HTTP/WS 主事件循环的问题，但明确没有实现 PostgreSQL、普通请求
query pool、多 daemon 或水平扩容。本 RFC 增加第二种数据库 provider：

- SQLite 继续作为零配置默认值；
- PostgreSQL 由用户、Docker/编排环境或云厂商在二进制之外提供；
- 单二进制携 PostgreSQL **客户端 adapter、连接池逻辑、schema/migration 与迁移引擎**，不内嵌、不安装、不启动 PostgreSQL server；
- 管理员只需提供 PostgreSQL 连接配置并触发一次“检测并迁移”，平台自动完成 preflight、维护模式、SQLite 安全备份、目标 schema 初始化、
  分批复制、校验、provider 切换、健康检查与可恢复回执；
- 迁移失败在 cutover horizon 内自动留在或退回 SQLite；一旦 PostgreSQL 已接收业务新写，禁止把旧 SQLite 当作无损回滚；
- 新增 canonical schema contract，把 184 张现存表逐张归入 `KEEP`、`ARCHIVE_THEN_OMIT` 或 `DEFER`，只删除能以生产消费者、
  恢复依赖、数据归档和校验共同证明已退役的表。

第一版“一键”表示**单次用户动作自动编排一个可续跑的迁移 operation**，不表示数据库 server 自动出现，也不承诺零停机。

## 2. Current-source 事实

### 2.1 SQLite 耦合

source pin 上：

- `packages/backend/src/db/client.ts` 直接使用 `bun:sqlite`、`drizzle-orm/bun-sqlite` 与 SQLite migrator；
- `packages/backend/src/db/txSync.ts` 明确要求同步 callback、同步 `.all()/.get()/.run()` 与 `BEGIN IMMEDIATE`；
- `packages/backend/drizzle.config.ts` 固定 `dialect: 'sqlite'`，migration 目录固定为 `packages/backend/db/migrations`；
- `packages/backend/src/cli/start.ts` 在启动时围绕 `Paths.db` 做 SQLite 备份、open/migrate/integrity、维护 Worker 装配；
- `packages/backend/src/services/backup.ts` 用 `VACUUM INTO` 产出 `db.sqlite`，restore/doctor/integrity 也读取 SQLite 文件和 PRAGMA；
- `packages/shared/src/schemas/config.ts` 只有 SQLite synchronous/WAL/cache/mmap/slow-query 配置，没有 database provider/URL/pool 配置；
- 当前源码扫描得到 184 个 `sqliteTable(...)`、222 个 SQLite `.sql` migration、343 个 production TS 文件提及 `DbClient`、
  93 个 production TS 文件提及 `dbTxSync`；`schema.ts` 为 7,506 行单文件。

这些事实意味着 PostgreSQL 不能通过“把 `Paths.db` 改成 URL”接入，也不能把 `DbClient` type alias 指向另一个 driver 后宣称完成。

### 2.2 184 张表是否合理

表数不是性能或架构质量的单一指标。当前最大命名前缀为：

| 前缀            | 表数 | 主要语义                                             |
| --------------- | ---: | ---------------------------------------------------- |
| `employee_*`    |   31 | 数字员工定义、Case、Context、reaction、channel、saga |
| `development_*` |   21 | Mission、决策、action、attempt、effect、approval     |
| `task_*`        |   15 | Task 输入、执行 ownership/effect/fence/maintenance   |
| `code_*`        |   13 | code-host connection + RFC-304 legacy history island |
| `webhook_*`     |    9 | endpoint、trigger、delivery、MR control ledger       |
| `intent_*`      |    8 | session、turn、draft、working set、apply/provenance  |
| `event_*`       |    7 | Event Center source-neutral record/delivery          |

revision、outbox、lease、idempotency、audit 与 external-event 表分开通常是正确建模，不得为了减少表数把不同原子性、保留期或热点
强行合并。真正需要治理的是：每张表是否有唯一 owner、真实生产读写者、保留期、恢复语义和 provider-neutral codec。

### 2.3 已确认的第一批收缩候选

RFC-310 T108 明确记录以下六张 legacy writer-private 表已经**零生产消费者**，并有
`rfc310-architecture-lock.test.ts` 负向守卫：

1. `code_mr_leases`
2. `code_produced_mrs`
3. `code_artifacts`
4. `code_work_observations`
5. `code_fix_attempts`
6. `code_publish_intents`

当时未 drop 的理由是其中部分行有审计价值，而不是仍有运行时语义。因此本 RFC把它们列为初始
`ARCHIVE_THEN_OMIT` candidate：迁移器先导出完整逻辑行、行数、主键范围与内容 digest，写进只读 legacy audit artifact 和 migration
receipt；验证后不在 PostgreSQL active schema 创建这六张表。源 SQLite 文件完整保留为 rollback generation，不在迁移过程中原地删表。

其余 `code_*` history、`legacy_code_work_item_links`、`committed_event_family_cutovers`、`employee_os_writer_state` 等表先列
`DEFER`；只有 production/test reader=0、writer=0、恢复/rollback dependency=0、归档可重放且用户能力无损时才能升级为
`ARCHIVE_THEN_OMIT`。`node_run_events`、`committed_events` 与 Event Center `event_records` 语义不同，不因都叫 event 合并。

### 2.4 外部能力事实

- Bun 的 `SQL` 是 Promise-based API，原生支持 PostgreSQL、连接池、事务、prepared statements 与 `LISTEN/NOTIFY`：
  <https://bun.sh/docs/runtime/sql>；
- Drizzle 的 Bun SQL driver 是 PostgreSQL dialect，现有 Bun SQLite driver 是同步 SQLite dialect，二者不是同一个 schema/transaction type：
  <https://orm.drizzle.team/docs/get-started/bun-sql-new>；
- PostgreSQL `COPY` 可作为目标 bulk-load mechanism：<https://www.postgresql.org/docs/current/sql-copy.html>；
- PostgreSQL 原生 backup 可由 operator 使用 `pg_dump`；本 RFC的一键迁移不依赖外部 `pg_dump`，避免把平台迁移能力绑定到另一套
  可执行文件：<https://www.postgresql.org/docs/current/app-pgdump.html>。

## 3. 目标

1. 提供 `sqlite` / `postgresql` 两种明确、封闭的 database provider；省略配置继续启动 SQLite。
2. 单二进制可直接连接外部 PostgreSQL，提供可配置 pool/connect/statement/idle timeout 与 readiness。
3. Settings 与 CLI 调同一个迁移 application：一次启动动作自动完成完整迁移，并可查询、取消安全阶段、崩溃后 resume。
4. 迁移进入受控维护模式：停止新业务 admission，drain/fence writer/background/outbox/apply，保留独立迁移状态页和安全诊断。
5. SQLite→PostgreSQL 采用 logical canonical codec，分批复制并逐表验证；不用 SQLite SQL dump 冒充跨 dialect migration。
6. provider 切换由 live generation 之外的 durable migration manifest/pointer 驱动；切换前失败不改变 live provider。
7. 建立双 dialect schema 与独立 immutable migration history；相同逻辑 table/column/constraint 由 machine-readable schema contract 对账。
8. 将全局 `DbClient` 泄漏逐域收进 application-owned repository/atomic ports；application 不 import Drizzle table 或 provider client。
9. 替换 RFC-294 只适用于 SQLite 的同步 transaction public contract：跨 provider public application 永远返回 Promise，SQLite
   adapter 内仍可使用 `dbTxSync`，PostgreSQL adapter 使用 async pool transaction；业务层不接 generic raw transaction。
10. backup/restore/doctor/maintenance/readiness 都按 provider 实现等价能力；SQLite PRAGMA/WAL/VACUUM 不进入 PostgreSQL 路径。
11. 用 schema contract 找出真实退役表；迁移时归档并省略已证明无运行语义的 legacy 表，而不是把 184 当成必须照搬的神圣数字。
12. 用真实大库、故障注入、三平台单二进制与并发负载证明数据等价和响应性。

## 4. 非目标

- 不在 agent-workflow 二进制中内嵌、安装、升级或管理 PostgreSQL server。
- 不替用户创建云数据库、Docker daemon、账号、网络或 provider snapshot；只验证并使用管理员给出的 target。
- V1 不做 SQLite↔PostgreSQL 双写、CDC 或零停机在线迁移；这些需要独立 RFC。
- 不因 PostgreSQL 可连接就宣称支持多 daemon、水平扩容或高可用。单实例锁、本地 worktree/artifact、跨实例 WS/pubsub、scheduler
  lease 与 execution worker ownership 仍需后续 RFC。
- 不把所有 repository 合并成一个 generic CRUD/SQL port，不把 `DbClient` 换名为 `DatabaseClient` 后继续泄漏。
- 不以“表越少越好”为目标；不合并不同 owner、生命周期、保留期、事务或查询热点的表。
- 不在没有 archive/reader/writer/recovery 证据时 drop 只读历史或 cutover 表。
- 不改变权限、认证、凭据或安全策略；本 RFC只定义数据库功能、迁移和运维行为。

## 5. 待用户批准的裁决

### D1 — SQLite 默认，PostgreSQL 外置

`database.provider` 缺省为 `sqlite`，保持现有零配置安装。`postgresql` 只接受外部连接；单二进制包含 client adapter 和 migration
assets，不包含 server。配置引用环境变量名，不把连接 secret 回显进 API、日志或 migration receipt。

### D2 — 一键是一个 durable operation

Settings 的“检测并迁移”与 CLI `db migrate --to postgresql --auto` 调同一 command。用户只提供 target connection 与可选 pool 参数；
系统自动 preflight、backup、maintenance admission、target schema、copy、verify、cutover、health、resume/receipt。不得让 UI 和 CLI
各拼一套流程。

### D3 — V1 采用自动维护窗口，不承诺零停机

preflight 可在线执行；进入 copy 前切到 migration maintenance mode，停止所有业务写入并 fence background worker。迁移状态 endpoint/page
由独立 operation state 提供，不依赖正在搬迁的业务 query。数据量大时允许计划到指定 maintenance window，但不使用双写偷换“零停机”。

### D4 — 状态机可续跑、可重入、单 owner

迁移 phases 固定为：

```text
planned -> preflighted -> source-frozen -> backed-up -> target-prepared
        -> copying -> verifying -> cutover-prepared -> switched -> health-checked
        -> accepting-writes -> finalized
```

失败进入 phase-specific `failed`，每个 phase 有幂等 key、checkpoint 与 resume rule。相同 source generation 同时最多一个 active
migration；PostgreSQL target 还使用 operation-scoped advisory lock，防止第二个进程并发写 target。

### D5 — 自动回退只覆盖明确 cutover horizon

- `accepting-writes` 前失败：provider pointer 仍为 SQLite或自动切回 SQLite，目标可 resume/清理；
- provider 健康检查通过后才开放新写；
- PostgreSQL 接收第一笔业务写后，旧 SQLite 已陈旧，按钮不得声称可无损自动回退；回 SQLite 必须走反向 logical migration；
- source SQLite、backup 和 manifest 在管理员显式 finalize 且保留期满足前不删除。

### D6 — 修订 RFC-294 的 SQLite-only transaction 形状

RFC-294 §4.3 的同步 `TransactionPort.run(...): TResult` 继续是 SQLite adapter 的内部事实，但不再是跨 provider application contract。
每个 bounded context 定义 purpose-specific async repository/atomic port；复杂原子用例向 adapter 提供已加载 snapshot 上的纯 decision，
adapter 在自己的事务中 load → decide → persist/audit/event。SQLite 使用 `dbTxSync`，PostgreSQL 使用 async transaction；application
command 统一 `Promise<Receipt>`。禁止 generic raw transaction、SQL builder、table 或 service locator 出现在 public surface。

### D7 — 双 dialect、双 migration history、一个逻辑 contract

保留 222 条 SQLite migration 为 immutable history；新增 PostgreSQL baseline + forward migrations，不翻译/重放 SQLite SQL。
SQLite `sqliteTable` 与 PostgreSQL `pgTable` 分开生成/维护；machine-readable contract 对每张 active table 锁 owner、logical columns、
null/default、key/FK/unique/check、codec、retention 和 provider mapping。任何 provider 漏表/字段/约束或出现未登记 extra 都使 gate 失败。

### D8 — Schema contract 三态，不设拍脑袋目标数

- `KEEP`：当前运行/恢复/历史能力需要，两个 provider 都实现；
- `ARCHIVE_THEN_OMIT`：生产 reader/writer/recovery consumer 全为零，导出可验证 artifact 后不进入 target active schema；
- `DEFER`：疑似 legacy/重复/过渡，但证据不足，先完整迁移。

每次状态变化必须有 exact consumer ledger、archive codec、row-count/digest oracle、能力影响与批准记录。表总数只是结果，不是 KPI。

### D9 — 首批仅批准六张零消费者 legacy 表归档省略

§2.3 六张 `code_*` 表是初始 `ARCHIVE_THEN_OMIT` allowlist。迁移器保存每行、schema version、row count、主键边界和 canonical
digest；PostgreSQL active target 不创建它们。其他表默认 `KEEP`/`DEFER`，实现过程中不得顺手追加 drop；新增候选必须先更新 RFC 呈批。

### D10 — provider-neutral 逻辑迁移/备份格式

迁移 artifact 使用 versioned manifest + per-table chunk，定义 integer/boolean/text/JSON/blob/null/timestamp 的 canonical codec；同一格式
支持 SQLite→PostgreSQL、PostgreSQL backup/restore 与未来明确批准的 PostgreSQL→SQLite reverse migration。PostgreSQL operator 可另用
`pg_dump`，但平台一键迁移和 Settings backup 不以其存在为前提。

### D11 — 数据验证是 cutover 阻断项

每个 `KEEP` table 必须验证：行数、稳定排序后的 chunk digest、主键/复合键、FK orphan=0、unique/check、sequence/identity 下一个值；
再验证 task ownership/effect、committed-event delivery、apply journal、lease/outbox、resource revision 等跨表业务不变量。任一 mismatch
阻断 `switched`，没有“忽略并继续”开关。

### D12 — provider-specific 运维，不伪造共同实现

SQLite 保留 PRAGMA/quick_check/WAL checkpoint/VACUUM/文件 backup；PostgreSQL 使用 pool health、statement/lock timeout、migration
advisory lock 与数据库侧 maintenance 语义。共享 retention/archive job 只调 owner ports；不得在 PostgreSQL 上运行 SQLite checkpoint/compact，
也不得把 PostgreSQL autovacuum 当成应用清理业务行的替代。

### D13 — 数据库迁移不冒领多实例

V1 PostgreSQL 仍由一个 daemon generation 提供业务服务。multi-daemon admission、distributed scheduler/worker lease、LISTEN/NOTIFY 或
外部 pubsub、对象存储/workspace ownership 与 failover 另立 RFC。PostgreSQL provider 的 API 不禁止后续扩展，但本 RFC验收不宣传水平扩容。

### D14 — 交付只认双 provider 与真实迁移证据

SQLite 全回归、PostgreSQL 全回归、SQLite→PostgreSQL data/fault/rollback、单二进制 Linux/macOS/Windows 外连 smoke、大库并发 soak、
backup/restore/maintenance provider matrix 和 exact-SHA hosted workflows 全部终态成功后才能 Done。仅“能连 PostgreSQL”不算完成。

## 6. 用户故事

- 作为现有单机用户，我不改配置就继续使用 SQLite，升级不要求安装 PostgreSQL。
- 作为平台管理员，我提供一个空 PostgreSQL target，点击一次即可完成检测、迁移、验证和切换，并持续看到阶段、进度和错误。
- 作为大库管理员，我可以在计划窗口启动，迁移中断后从 durable checkpoint 恢复，而不是清库重来。
- 作为值班人员，我知道系统何时仍可自动回 SQLite，何时 PostgreSQL 已产生新写必须走反向迁移。
- 作为审计人员，我能下载 legacy table archive 与 migration manifest，对账每张表为何保留、归档或延期。
- 作为开发者，我在业务模块只实现 application-owned port，不需要知道当前进程用 SQLite 还是 PostgreSQL。

## 7. 能力影响

| 能力                    | 变化                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| 默认安装                | 不变，仍是 SQLite                                                                      |
| PostgreSQL              | 新增外部 provider；server 不内嵌                                                       |
| 迁移操作                | 新增 Settings/CLI durable one-click operation                                          |
| 可用性                  | V1 有明确维护窗口；不是零停机                                                          |
| 回滚                    | 新增 pre-write 自动回退；post-write 必须反向迁移                                       |
| backup/restore          | 从 SQLite 文件包升级为 provider-aware versioned logical artifact                       |
| schema                  | 新增 owner/codec/retention contract；首批六张零消费者 legacy 表归档后不进入 PostgreSQL |
| legacy `/code` 审计历史 | 六张无消费者表内容保留在只读 artifact；仍有读者的 legacy history 表继续在线迁移        |
| 多实例/水平扩容         | 不由本 RFC开放                                                                         |
| 权限/认证/凭据/安全策略 | 不变                                                                                   |

## 8. 验收标准

- **AC-1**：未配置 `database.provider` 的 fresh/upgrade/restore 路径与 source pin SQLite 行为、配置默认、CLI/Settings wire 相同。
- **AC-2**：单二进制包含 PostgreSQL client adapter 与 migration assets；在没有本机 `psql/pg_dump/postgres` 时仍能完成连接、迁移和运行，
  且不会尝试启动数据库 server。
- **AC-3**：PostgreSQL provider 支持 boot migration、pool/readiness、所有 application command/query、事务、background、backup/restore 与
  orderly shutdown；无 runtime fallback 到 SQLite。
- **AC-4**：Settings 一次 start 与 CLI `--auto` 产生同一 operation id/state/receipt；duplicate start、cancel、crash/restart、resume、target
  transient failure 全有 deterministic 行为。
- **AC-5**：maintenance mode 阻止新业务写并 fence/drain writer；迁移 status 仍可读取；不存在 copy 期间 SQLite 与 PostgreSQL 双业务 writer。
- **AC-6**：184-table source census 有 machine-readable exact ledger；每张表恰有一个 `KEEP|ARCHIVE_THEN_OMIT|DEFER` 状态、owner、codec、
  dependency 与理由，unknown/stale/duplicate/ownerless 均红。
- **AC-7**：§2.3 六张表的生产 reader/writer/recovery consumer 保持零；archive 行数/digest 与 SQLite source 相等；PostgreSQL active schema
  不含六表。其余任何表未经批准不得省略。
- **AC-8**：所有 `KEEP/DEFER` table 的 row/chunk/key/FK/unique/check/sequence 与跨表业务不变量验证通过；任一 mutation/mismatch 阻断 cutover。
- **AC-9**：在 `accepting-writes` 前注入任一失败均保持/恢复 SQLite 且 source 无损；开放 PostgreSQL 新写后 UI/CLI 拒绝 stale SQLite instant rollback。
- **AC-10**：logical backup 能在 SQLite 和 PostgreSQL 产出同版 manifest/chunks，并在空 target 完整 restore；provider-native backup 只是额外选项。
- **AC-11**：production business/application/public 层不新增 provider client、Drizzle table、raw SQL 或 generic transaction；现有 343 `DbClient`
  与 93 `dbTxSync` consumer 以 exact cohort ledger 下降并最终只留批准的 SQLite infrastructure/test/compatibility allowlist。
- **AC-12**：SQLite 与 PostgreSQL 对关键 CAS、lease/fence、idempotency、outbox、committed event、apply recovery 运行相同 behavior oracle；
  PostgreSQL isolation/retry 不改变 wire error/status/event ordering。
- **AC-13**：SQLite PRAGMA/WAL/VACUUM 和 PostgreSQL pool/advisory-lock/database-maintenance 各走自己的 adapter；错误 provider mechanism
  mutation 必红。
- **AC-14**：100-client + full-seed maintenance/request soak、至少一次 large logical migration、每 phase crash matrix、三平台 compiled binary
  外连 PostgreSQL smoke 全绿，且记录数据量、时长、p95/max、event-loop gap、pool wait、错误数。
- **AC-15**：RFC 三件套获批后才实施；最终 exact SHA 的 Main CI 与所有适用 scheduled workflows terminal success，schema/migration manifest、
  RFC-294 provenance、STATE/index 与 verification report 指向同一事实后才标 Done。

## 9. 批准记录

用户于 2026-08-31 明确回复“批准实施，并提交上库”：D1～D14 全部批准，并授权完整生产实现、commit 与 push。实施仍须遵守
`plan.md` 的 live source-lock、双 provider/data/fault/compiled evidence 与 shared-main publication 规则；该授权不降低任何验收门。
