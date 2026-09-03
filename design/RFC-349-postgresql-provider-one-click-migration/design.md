# RFC-349 设计 — 数据库 Provider、PostgreSQL 一键迁移与 Schema Contract

配套 [`proposal.md`](./proposal.md)。当前状态：**Approved / Closing（2026-09-03）**——exact SHA
`b3883154eb1cfe575e578ee3cf2664fbb57ce797` 上 Main CI terminal success、hosted
`postgresql-evidence` 取证 job 全绿；AC-15 的最终 exact-SHA 全门收口进行中，取证逐项见
[`verification.md`](./verification.md)。

## 1. 设计结论

本 RFC 不把 PostgreSQL 做成新的全局 `DbClient`。目标是同时建立：

1. provider-neutral 的 application contract；
2. SQLite 与 PostgreSQL 两套封闭 adapter、schema 和 migration history；
3. 一个可续跑、可验证、带明确回滚边界的一键迁移 operation；
4. 184 张 source table 的 machine-readable schema/consumer ledger；
5. 首批六张已证实零生产消费者的 legacy 表归档后从 PostgreSQL active schema 省略。

SQLite 继续零配置运行。PostgreSQL server 由部署环境提供，agent-workflow 单二进制只带客户端、连接池、schema assets 与迁移引擎。

## 2. 不变量

| ID  | 不变量                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| I1  | 未配置 provider 时继续使用 `~/.agent-workflow/db.sqlite`，现有用户升级不被迫安装 PostgreSQL。                                  |
| I2  | 二进制不内嵌、不下载、不安装、不启动 PostgreSQL server，也不依赖本机 `psql`/`pg_dump` 才能运行一键迁移。                       |
| I3  | business/domain/application/public surface 不出现 provider client、Drizzle table、raw SQL、connection 或 generic transaction。 |
| I4  | SQLite 的同步事务 callback 只存在于 SQLite infrastructure；公共 application command/query 统一 Promise 形状。                  |
| I5  | 一个 operation 只有一个 owner；重复 start、进程崩溃、网络闪断和手工 resume 不会制造第二次 copy/cutover。                       |
| I6  | source freeze 后只有 SQLite 或 PostgreSQL 其中一个 provider 可以承接业务写；V1 不双写。                                        |
| I7  | live provider pointer 只有在 target 数据和业务不变量全部验证通过后才切换。                                                     |
| I8  | provider 切换前的任一失败都不得损坏 source SQLite；旧文件、备份和 migration manifest 在 finalize 前保留。                      |
| I9  | PostgreSQL live generation 出现第一笔业务写后，旧 SQLite 不再是无损即时回滚目标。                                              |
| I10 | schema 收缩以 exact consumer/recovery/archive 证据为准；表数不是 KPI，未经批准不得顺手省略其他表。                             |
| I11 | 六张初始 legacy candidate 先完整归档并对账，再从 target active schema 省略；source SQLite 不原地 drop。                        |
| I12 | `KEEP`/`DEFER` 表的 key、row、codec、constraint、sequence 与跨表业务不变量任一不等价都阻断 cutover。                           |
| I13 | SQLite 与 PostgreSQL 各自使用正确的 health/backup/maintenance mechanism，不伪造一套最小公分母实现。                            |
| I14 | provider metadata、migration artifact 与业务表分开计数，最终报告不得用一个含糊的“总表数”掩盖新增或省略。                       |
| I15 | PostgreSQL V1 仍是单 daemon generation；可连接数据库不等于已经支持水平扩容或 HA。                                              |

## 3. Current-source 阻塞链

### 3.1 不是 URL 替换

当前执行链为：

```text
bootstrap
  -> Paths.db
  -> openDb(bun:sqlite)
  -> drizzle(bun-sqlite)
  -> one global DbClient type
  -> service/module code imports schema + dbTxSync
  -> synchronous SQLite statements and transactions
```

source pin 上约 343 个 production TS 文件提及 `DbClient`，约 93 个 production TS 文件提及 `dbTxSync`；schema 又集中在
7,506 行的单文件中。Drizzle 的 Bun SQLite 与 Bun SQL PostgreSQL driver 分属不同 dialect，事务分别是同步 callback 与 Promise API。
因此不能用 union type、conditional cast 或把 alias 改名来隐藏差异。

### 3.2 当前 physical operations 也绑定 SQLite

以下能力不能复用现实现状：

- boot migration：固定 SQLite migration folder；
- integrity/doctor：`quick_check`、PRAGMA、schema drift；
- backup：`VACUUM INTO db.sqlite`；
- restore：替换 SQLite 文件；
- maintenance：WAL checkpoint/VACUUM/SQLite busy；
- maintenance Worker：打开同一个 SQLite WAL 文件；
- slow-query telemetry：同步 statement recorder；
- CLI/start：在业务 bootstrap 之前按本地文件路径做备份与恢复提示。

这些都是 provider adapter 的职责，不得在公共 `DatabaseService` 中堆 `if (provider === ...)`。

## 4. 目标拓扑

```text
transport / scheduler / worker / MCP
                |
                v
module public command/query
                |
                v
module application-owned repository / atomic port
                |
        bootstrap composition
         /                \
        v                  v
SQLite module adapter   PostgreSQL module adapter
        |                  |
platform/persistence   platform/persistence
  /sqlite runtime       /postgresql runtime
        |                  |
  db.sqlite + WAL       external PostgreSQL

system-operations command/query
                |
                v
provider-aware backup / restore / doctor / migration coordinator
```

建议的 physical layout 是目标，不是本 RFC Draft 已创建的源码：

```text
packages/backend/src/platform/persistence/
  contracts/
    databaseRuntime.ts
    schemaContract.ts
    logicalArtifact.ts
    migrationOperation.ts
  runtime/
    selectDatabaseProvider.ts
    databaseGenerationPointer.ts
  sqlite/
    runtime.ts
    schema.ts
    migrations.ts
    logicalReader.ts
    logicalWriter.ts
  postgresql/
    runtime.ts
    schema.ts
    migrations.ts
    logicalReader.ts
    logicalWriter.ts
  migration/
    coordinator.ts
    stateStore.ts
    copyEngine.ts
    verifier.ts
    cutover.ts
```

每个 bounded context 的 adapter 仍放在该模块自己的 `infrastructure/sqlite` / `infrastructure/postgresql` slice；platform 只提供
connection、transaction、migration、logical codec 和 generation fence 等机制，不取得业务查询所有权。

## 5. Provider 配置与启动

### 5.1 判别联合

批准后共享配置新增类似以下合同；最终字段命名以 implementation gate 为准：

```ts
type DatabaseConfig =
  | {
      provider: 'sqlite'
      synchronous: 'off' | 'normal' | 'full' | 'extra'
      pageCacheMib: number
      mmapMib: number
      slowQueryMs: number
    }
  | {
      provider: 'postgresql'
      urlEnv: string
      poolMax: number
      connectTimeoutMs: number
      statementTimeoutMs: number
      idleTimeoutMs: number
    }
```

兼容规则：

- 缺少 `database` 时从现有 `sqlite*` 字段无损投影成 `provider: 'sqlite'`；
- 第一个兼容版本读取旧字段但写回新 shape；删除旧字段需独立 migration 与回归，不在同一 parser 里长期双源；
- `urlEnv` 保存环境变量**名称**，连接串值不进入 config GET、日志、operation manifest、receipt 或错误 message；
- PostgreSQL target database 由管理员预先提供；平台只创建/维护固定 application schema 与 metadata schema；
- 不要求 PostgreSQL 是本机进程，compiled binary smoke 必须证明远端连接路径。

### 5.2 live generation pointer

live provider 不直接由一次 Settings PUT 改写。`Paths.root` 下新增受控 pointer，例如：

```json
{
  "version": 1,
  "generationId": "dbg_...",
  "provider": "postgresql",
  "operationId": "dbm_...",
  "schemaDigest": "sha256:..."
}
```

pointer 使用 temp-file → durable flush → atomic replace → directory flush → read-back/digest verify。Windows/macOS/Linux 由同一个
filesystem adapter 实现并跑 crash oracle，不在调用点手写 rename。pointer 缺失等价于 legacy SQLite generation；pointer 存在但损坏、引用
不存在的 manifest 或 schema digest 不符时 fail closed，不能猜测 provider。

### 5.3 runtime contract

platform 可以暴露最窄 mechanism contract：

```ts
interface DatabaseRuntime {
  readonly provider: 'sqlite' | 'postgresql'
  readonly generationId: string
  health(): Promise<DatabaseHealth>
  close(): Promise<void>
}
```

它不暴露 `.select()`、`.execute()`、raw connection 或 transaction。业务 adapter 在 bootstrap 内取得 provider-specific capability，
application/transport 只能取得自己声明的 ports。

## 6. 跨 Provider 的 application 与事务形状

### 6.1 对 RFC-294 §4.3 的修订

RFC-294 当前 `TransactionPort.run(fn): TResult` 是正确的 SQLite 防逃逸设计，但不能成为 PostgreSQL 的公共合同。RFC-349 批准后改为：

- application command/query 总是 `Promise<Result>`；
- application 不取得 transaction scope；
- 每个原子用例定义 purpose-specific port；
- 事务内 decision 必须是同步、纯、无 I/O 的 domain function；
- adapter 负责 provider-specific load → decide → persist/audit/event；
- SQLite adapter 在 `dbTxSync` 内同步调用 decision，再把最终 receipt 包成 Promise；
- PostgreSQL adapter 在 pool transaction 中 await load/persist，但调用同一个纯 decision；
- 跨 context 原子操作由 consumer-owned named atomic port 组合最小 participants，不向业务暴露 service locator。

示意合同：

```ts
type Decide<TSnapshot, TDecision> = (snapshot: TSnapshot) => TDecision

interface ClaimTaskExecutionAtomicallyPort {
  execute(
    input: ClaimTaskExecutionInput,
    decide: Decide<ClaimTaskExecutionSnapshot, ClaimTaskExecutionDecision>,
  ): Promise<ClaimTaskExecutionReceipt>
}
```

SQLite adapter：

```text
Promise-returning port method
  -> dbTxSync(() => {
       snapshot = synchronous load
       decision = pure decide(snapshot)
       synchronous persist + event + audit
       return receipt
     })
  -> Promise.resolve(receipt)
```

PostgreSQL adapter：

```text
Promise-returning port method
  -> await pool transaction(async tx => {
       snapshot = await load
       decision = pure decide(snapshot)
       await persist + event + audit
       return receipt
     })
```

禁止事项：

- 在 SQLite transaction callback 内 `await`；
- 让 application 根据 provider 分支；
- 暴露 generic `withTransaction(tx => ...)`；
- 把 Drizzle query/result type 放进 port；
- 先提交一个 context，再提交另一个 context 来假装原子；
- 把网络、文件、进程或模型调用放进任一数据库事务。

### 6.2 迁移波次中的兼容边界

在所有 consumer 切完之前允许一个明确登记的 SQLite compatibility adapter，但它只能位于 infrastructure/composition，不能成为新调用
示例。每个 cohort 同时完成：characterization、application port、SQLite adapter、PostgreSQL adapter、caller cutover 与旧入口归零。
architecture gate 以 exact ledger 逐波降低全局 `DbClient`/schema/`dbTxSync` consumer 水位；最终只保留批准的 provider infrastructure 与测试。

## 7. Canonical Schema Contract

### 7.1 一张表一条账

machine-readable manifest 为每张逻辑表记录：

```ts
type TableDisposition = 'KEEP' | 'ARCHIVE_THEN_OMIT' | 'DEFER'

interface LogicalTableContract {
  id: string
  ownerContext: string
  disposition: TableDisposition
  sourceTable: string
  providerTables: { sqlite?: string; postgresql?: string }
  migrationKey: readonly string[]
  columns: readonly LogicalColumnContract[]
  primaryKey: readonly string[]
  unique: readonly LogicalConstraint[]
  foreignKeys: readonly LogicalForeignKey[]
  checks: readonly LogicalConstraint[]
  indexes: readonly LogicalIndex[]
  retention: RetentionContract
  consumers: ConsumerLedger
  archive?: ArchiveContract
  rationale: string
}
```

生成/校验 gate 必须证明：

- source schema 的 184 张表每张恰好出现一次；
- active provider schema 没有未登记 extra；
- `KEEP`/`DEFER` 两个 provider 都有 mapping；
- `ARCHIVE_THEN_OMIT` 只有 source mapping、archive codec 与批准记录；
- owner、key、codec、default、nullability、constraint、retention 不能为空；
- consumer ledger 与 current production import/query/route/job/restore/diagnostic 扫描一致；
- schema manifest、Drizzle declaration、migration baseline 与 generated report digest 一致。

### 7.2 不再用一个数字描述 schema

报告分开列：

1. logical active business tables；
2. archive-only legacy tables；
3. provider metadata tables；
4. ORM/tool-owned migration metadata；
5. 本次新增、删除、延期列表。

若只省略首批六张，source parity set 从 184 变为 178；但 PostgreSQL physical total 还会包含独立 metadata。不得把“178”宣传成
最终物理表总数，也不得为了追求更小数字合并 event、revision、lease、outbox 或 audit 表。

## 8. Logical codec 与 dialect mapping

每个 column 显式选择 codec，不从 TypeScript 静态类型猜测：

| logical codec                  | SQLite        | PostgreSQL V1                 | 校验                                                      |
| ------------------------------ | ------------- | ----------------------------- | --------------------------------------------------------- |
| `id-text` / enum / opaque ref  | `TEXT`        | `TEXT`                        | byte equality + domain validator                          |
| `integer` / epoch milliseconds | `INTEGER`     | `BIGINT`                      | canonical signed decimal string；禁止 JS float 丢精度     |
| boolean                        | `INTEGER 0/1` | `BOOLEAN`                     | only 0/1 accepted；round-trip equality                    |
| arbitrary JSON text            | `TEXT`        | `TEXT`                        | V1 保留原始 bytes；parseability/shape 另验                |
| explicitly canonical JSON      | `TEXT`        | `JSONB` 或 `TEXT`（逐列裁决） | canonical encode 后 digest；不得静默重排改变 wire/history |
| blob                           | `BLOB`        | `BYTEA`                       | length + digest                                           |
| nullable                       | `NULL`        | `NULL`                        | tagged canonical value，不能与空串/零混淆                 |

其他规则：

- SQLite autoincrement 映射到 PostgreSQL identity/sequence；copy 后按最大合法 key 设置 next value，并做一次不提交的 collision oracle；
- string comparison、case-fold、unique 与排序必须逐字段登记 collation/normalization，不能继承部署数据库 locale；
- 默认值分为 application default 与 database default，两边语义必须相同；时间默认不能因数据库 server timezone 漂移；
- 无 stable primary/unique migration key 的 active 表先阻断，补 key 的前置 migration 需独立回归；
- SQLite dynamic typing 中不符合 declared codec 的脏行在 preflight 报 exact table/key，不在 copy 中隐式强转。

## 9. Schema 收缩协议

### 9.1 三态

- `KEEP`：当前业务、审计、恢复或 operator 能力需要；完整迁移并在线保留。
- `ARCHIVE_THEN_OMIT`：所有 live consumer 已归零，数据仍可能有审计价值；先归档对账，再不创建 target active table。
- `DEFER`：看似 legacy/重复但证据不足；V1 按 active table 完整迁移。

### 9.2 drop-proof

一张表只有同时满足以下门才可进入 `ARCHIVE_THEN_OMIT`：

1. production reader=0；
2. production writer=0；
3. background/recovery/maintenance consumer=0；
4. backup/restore/import/export consumer=0；
5. migration/cutover/compatibility consumer=0；
6. admin/doctor/MCP/CLI/diagnostic consumer=0；
7. FK、trigger、dynamic SQL 与 provider-native dependency=0；
8. 用户可观察能力和历史查询有明确替代或正式退役裁决；
9. 全量 archive codec、row count、key bounds、chunk digest 与读取工具已验证；
10. proposal allowlist 明确批准该表。

测试本身不算生产 consumer，但若它锁住仍承诺的兼容行为，该承诺必须先被替代或显式退役。

### 9.3 首批六表

初始 `ARCHIVE_THEN_OMIT` allowlist 只有：

- `code_mr_leases`
- `code_produced_mrs`
- `code_artifacts`
- `code_work_observations`
- `code_fix_attempts`
- `code_publish_intents`

每张表导出独立 chunk 与 manifest entry；archive 支持离线 inspect/export，不会被普通 restore 重新导入 active PostgreSQL。源 SQLite
generation 与 raw safety backup 原样保留。若 implementation census 发现任一 live consumer、FK 或 recovery dependency，候选自动退回
`DEFER` 并重新呈批，不能降级 gate。

`node_run_events`、`committed_events`、`event_records` 等只因名字相似不能合表。它们分别承载执行流、已提交生命周期 delivery 与
source-neutral Event Center 记录，事务/retention/query 热点不同。

本 RFC 的自动收缩发生在 PostgreSQL target logical active schema。默认/存量 SQLite 仍保留 immutable migration history 和这些 physical
legacy tables，避免升级时无归档地破坏历史；未来若要压缩仍在使用的 SQLite 文件，必须使用同等级 archive/verify/rollback 合同并另行批准。
迁移 finalize 后，旧 SQLite generation 可按明确保留策略封存或删除，不能把删除旧文件与“在线 schema drop”混为一谈。

## 10. Durable migration operation

### 10.1 控制面不依赖待迁业务库

operation authoritative manifest 放在：

```text
~/.agent-workflow/database-migrations/<operation-id>/
  manifest.json
  checkpoints/
  chunks/
  legacy-archive/
  verification.json
  receipt.json
```

每次状态推进使用 version、previous digest、idempotency key、owner lease/fence 与 durable atomic write。source/target 可以保存只读 mirror
receipt 便于审计，但不能在两库冲突时靠“时间更新较晚”猜 winner。boot resolver 以外部 manifest + live pointer digest 为准，异常 fail closed。

manifest 不含 PostgreSQL secret，只记录 `connectionProfileId/urlEnv`、target fingerprint 的非秘密部分、source/target generation、schema
digest、phase、cursor、counts、digests、timestamps 与 error category。

### 10.2 closed phases

```text
planned
  -> preflighted
  -> source-frozen
  -> backed-up
  -> target-prepared
  -> copying
  -> verifying
  -> cutover-prepared
  -> switched
  -> health-checked
  -> accepting-writes
  -> finalized
```

任一 phase 失败写 `failedAtPhase`，但 resume 仍从最后一个已提交 checkpoint 进入同一 operation。不得通过新建 operation 绕过错误 target。

### 10.3 ownership 与锁

- appHome 内 acquisition file/lease 防同一安装双进程；
- source generation fence 防第二个 migration 与 restore/backup/maintenance 同时改变数据；
- target 使用 operation-derived PostgreSQL advisory lock；
- target metadata 记录 source generation/schema digest，非空且非同 operation 的 schema fail closed；
- owner heartbeat 过期只能由同一 operation 经过 stale-fence CAS 接管；旧 owner 的 late checkpoint 被拒绝。

PostgreSQL advisory lock 只是一层 target 互斥，不替代外部 manifest、daemon lock 或业务 admission。

## 11. 一键流程

### 11.1 `planned -> preflighted`

在线且只读地验证：

- source integrity、schema digest、184-table ledger、codec dirty rows；
- source size、row estimates、可用磁盘与 archive/backup 空间；
- target reachable、supported version、UTF-8、timezone/collation contract；
- target application/meta schema 为空或属于同一 resumable operation；
- create schema/table/index/constraint、DML、sequence 与 advisory-lock 所需能力；
- pool/timeout 可用，连接串未进入输出；
- 没有 active restore、backup、migration、schema upgrade 或不可 fence 的 writer。

preflight 只生成 estimate，不冻结业务，也不修改 provider pointer。权限 probe 在 operation-owned临时对象内执行并清理；失败必须可重试。

### 11.2 `source-frozen -> backed-up`

进入 migration maintenance mode：

1. 停止新业务 command admission；
2. drain HTTP/MCP/worker/scheduler/outbox/apply/maintenance 当前写；
3. fence 新 background run，等待 provider write counter 稳定；
4. 保留只读 status/diagnostic 能力；
5. 记录 source high-water generation；
6. 创建完整 raw SQLite safety backup 与 provider-neutral logical manifest header；
7. backup digest/read-back 通过后才继续。

超时不强杀未知 writer 后继续 copy；operation 停在 `source-frozen` 前或失败并重新开放 SQLite admission。

### 11.3 `target-prepared`

PostgreSQL 使用独立 immutable migration history，不执行 SQLite `.sql`。空 target 的 bootstrap plan 从 schema contract 生成：

1. 创建固定 application/meta schema；
2. 创建 tables、columns、PK/identity 与 copy 所需最小索引；
3. 写 operation/schema digest；
4. 非必要 unique/FK/check/secondary indexes 在 copy 后创建并 validate；
5. `ARCHIVE_THEN_OMIT` table 不创建。

这样不依赖 superuser `session_replication_role`，也不会为了 bulk load 暂时关闭无法审计的数据库级约束。fresh PostgreSQL install 与
migration bootstrap 必须从同一个 contract projector 生成，防止两套 schema 漂移。

### 11.4 `copying`

copy engine 逐表、逐稳定 key chunk 执行：

```text
SQLite snapshot read -> canonical row codec -> chunk digest
  -> PostgreSQL COPY or bounded prepared batch inside target transaction
  -> target canonical re-read -> chunk digest
  -> durable checkpoint
```

规则：

- source freeze 后 row set 不变；读取可以分 transaction，但 source generation 必须始终匹配；
- 一次 target transaction 只提交完整 chunk；崩溃后按 operation/table/chunk id 幂等探测并重放；
- 大 blob/JSON 不在主事件循环构造无界数组，使用 bounded stream/Worker 与 backpressure；
- COPY 是 PostgreSQL infrastructure mechanism，application 不感知；不支持时可退到 bounded prepared batch，但 oracle 不变；
- 每个 `ARCHIVE_THEN_OMIT` table 走相同 canonical read/digest，只把 chunk 写 legacy archive；
- cancel 只在 phase 安全点生效；正在提交的 chunk 先 settle，再停止。

### 11.5 `verifying`

先创建/验证剩余 unique/check/FK/index，再执行两层 oracle：

**结构/逐表：**

- schema digest、column/default/nullability；
- row count、migration key coverage、canonical chunk/root digest；
- PK/unique duplicate=0、FK orphan=0、check violation=0；
- identity/sequence next value；
- archive-only row/count/key/digest 与 source 相等且 target table absent。

**业务不变量：**

- task ownership/fence/effect/maintenance；
- committed event 与每 consumer delivery；
- apply journal prepared/committed convergence；
- lease/outbox/idempotency/CAS revision；
- resource revision/current pointer；
- digital-employee/development saga/attempt/effect；
- auth/session/config references；
- RFC-294 canonical architecture/provenance-required stores。

verification report 带 source/target/schema/artifact digest。任一 mismatch 保持 SQLite live pointer、不开放 PostgreSQL，并给出 exact
table/key/invariant；没有 `--force` 跳过数据不一致。

### 11.6 `cutover-prepared -> accepting-writes`

1. target 建 read-only live runtime，跑 boot migration/readiness/representative queries；
2. 写 target generation receipt；
3. durable 替换 live pointer；
4. 重新打开 daemon composition，但业务 admission 仍 closed；
5. 跑 health + read-model/writer dry contract；
6. 标 `health-checked`；
7. 打开业务 admission，标 `accepting-writes`。

所有 live write adapter 在 target transaction 内先核对 generation fence。第一笔业务 mutation 与
`firstLiveWriteAt/generationId` marker 同事务提交；旧 generation、late worker、旧 connection pool 和旧 lease 的写全部拒绝。

## 12. 回滚、取消与 finalize

### 12.1 自动回退 horizon

| 状态                                               | 行为                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `planned`～`verifying` 失败                        | pointer 未切；清理/保留 resumable target，重新开放 SQLite。                     |
| `switched`/`health-checked` 且无 target live write | 关闭 admission，确认 marker 仍为空，pointer 原子切回 source generation。        |
| `accepting-writes` 后尚无业务 write                | 回滚命令先关闭/drain，再在 target lock 下复核 marker；为空才允许。              |
| `firstLiveWriteAt` 已存在                          | 禁止 instant rollback；只能修复 PostgreSQL 或启动另一个反向 logical migration。 |

UI 不显示一个永远可用的“回退”按钮；显示当前 rollback eligibility 和 horizon关闭原因。rollback 与新业务写竞争时，以 target transaction
内 generation gate/marker 为裁决，不靠进程内布尔值。

### 12.2 cancel

- preflight 可立即 cancel；
- source freeze 后 cancel 只能在 checkpoint 停止，验证 source pointer 未变后重新开放 SQLite；
- pointer 切换期间不接受 cancel；只能等待 cutover settle，再按 rollback eligibility 执行；
- cancel 不自动删除 target schema/artifact，避免破坏 resume/取证。

### 12.3 finalize

管理员只有在：PostgreSQL 已稳定运行、logical backup 成功、保留期满足、明确看到不可即时回滚警告后才能 finalize。finalize：

- 封存 operation receipt 与 legacy archive；
- 释放 source generation 的 rollback 身份；
- 按显式保留策略处理 raw SQLite/backup，不默认删除；
- 不把 source legacy 表原地 drop 后再声称“节省了空间”。

## 13. Backup、restore、doctor 与 maintenance

### 13.1 provider-neutral backup

现有 tarball 的 database payload 从固定 `db.sqlite` 升级为 versioned logical artifact：

```text
backup manifest
  database/provider/source-generation/schema-digest
  table chunks + canonical digests
  archive references
  filesystem/config/worktree metadata (沿用现有合同)
```

SQLite 可继续额外包含 raw `db.sqlite` 快速恢复；PostgreSQL operator 可另做 `pg_dump`/云 snapshot，但 Settings/CLI backup 的基本可移植
能力不能依赖这些外部工具。restore target 必须为空或是同一 operation，逐表验证后才切 live generation。

### 13.2 provider matrix

| capability     | SQLite                               | PostgreSQL                                                   |
| -------------- | ------------------------------------ | ------------------------------------------------------------ |
| readiness      | open/integrity/schema/WAL profile    | pool/connect/schema/timeout/read-write probe                 |
| integrity      | PRAGMA quick/integrity check         | contract/constraint/catalog + business invariant             |
| backup         | Worker `VACUUM INTO` + logical       | logical；native dump 为 operator extra                       |
| restore        | generation-safe file/logical restore | logical restore to empty schema                              |
| maintenance    | WAL checkpoint/VACUUM/busy telemetry | pool wait/lock/statement telemetry；数据库 vacuum 由 PG 管理 |
| retention      | owner application ports              | 同一 owner application ports                                 |
| migration lock | appHome/source generation fence      | 同前 + advisory lock                                         |

RFC-338 maintenance scheduler/Worker 继续负责何时运行，owner port 决定删什么。PostgreSQL 路径不得执行 PRAGMA/WAL checkpoint/VACUUM；
同时不能把 autovacuum 当成业务 retention/archive job。

## 14. Settings、CLI 与 operation API

### 14.1 Settings

“数据库”卡片至少显示：

- 当前 live provider/generation/schema version；
- SQLite 文件或 PostgreSQL target 的非秘密 fingerprint；
- target connection profile/env name 与 connection test；
- source size、184-table census、预计 copy/archive bytes；
- `KEEP`/`ARCHIVE_THEN_OMIT`/`DEFER` 数量和六表明细；
- maintenance window、当前 phase、table/chunk/row/bytes progress；
- last checkpoint、error、resume/cancel eligibility；
- rollback eligibility 与 first-live-write horizon；
- verification report、legacy archive、final receipt 下载入口。

“检测并迁移”是一次明确确认后的单 action。确认页必须写明：V1 有维护窗口、server 不由平台提供、六表只归档不进 target、何时无法即时
回滚。按钮不能在字段无效时只 disabled；所有约束和 field error 初始可见。

### 14.2 CLI（拟议合同）

```text
agent-workflow db status
agent-workflow db preflight --to postgresql --url-env AGENT_WORKFLOW_DATABASE_URL
agent-workflow db migrate --to postgresql --url-env AGENT_WORKFLOW_DATABASE_URL --auto
agent-workflow db migration status <operation-id>
agent-workflow db migration resume <operation-id>
agent-workflow db migration cancel <operation-id>
agent-workflow db migration rollback <operation-id>
agent-workflow db migration finalize <operation-id>
agent-workflow db legacy inspect <operation-id> <table>
```

Settings 与 CLI 调同一 system-operations command/query，不直接 import coordinator/store。human 与 JSON 输出从同一 DTO projector 派生。

## 15. 失败合同

| failure                              | phase/result             | 自动动作                                | operator next step                        |
| ------------------------------------ | ------------------------ | --------------------------------------- | ----------------------------------------- |
| target unreachable/permission        | preflight failed         | 不冻结 source                           | 修配置后 resume preflight                 |
| source integrity/codec dirty         | preflight failed         | 不写 target                             | 按 exact table/key 修复或恢复备份         |
| drain timeout                        | source-freeze failed     | 保持/恢复 SQLite admission              | 查 writer/lease 后 resume                 |
| backup/artifact space不足            | backup failed            | pointer 不变                            | 扩容/换目录后 resume                      |
| chunk network error                  | copying failed/retryable | rollback chunk transaction，保留 cursor | 自动 bounded retry 或 resume              |
| target constraint mismatch           | verifying failed         | pointer 不变                            | 查看 exact contract diff；不得 force      |
| process crash                        | 任意 phase               | lease 超时前不接管                      | 同 operation resume                       |
| crash after pointer replace          | switched                 | boot admission closed、解析 manifest    | 完成 health 或无 live write 时回切        |
| health check fails before live write | health-checked failed    | 关闭 target runtime并回切 source        | 修 target 后 resume                       |
| target fails after first live write  | live degraded            | 禁止 stale SQLite auto rollback         | 修复 PG/restore PG/反向迁移               |
| manifest/pointer corrupt             | boot fail closed         | 不猜 provider、不开放写                 | doctor + verified receipt/backup recovery |

所有可重试错误有 category、phase、retry count、next retry 和 last stable checkpoint；secret、SQL payload 与任意用户数据不进入 message。

## 16. 性能与并发边界

### 16.1 正常 PostgreSQL 运行

- pool 有 hard max、wait queue、connect/statement/idle timeout 与 shutdown drain；
- transaction duration、pool wait、lock wait、query latency 分开观测；
- long scan/retention 用 keyset/batch，不因 driver async 就允许无界查询；
- application CAS/retry 只对已分类 serialization/deadlock/transient error，validation/conflict 不盲重试；
- background job 与 foreground command 使用可观测的 admission/budget，不能让 maintenance 占满 pool。

### 16.2 一键迁移期间

业务写已关闭，但 status/UI 仍不能因 codec/hash/copy 阻塞 event loop。CPU-heavy encode/digest、SQLite 同步 scan 与大文件 archive 在 Worker 执行，
main 只处理 progress message。bounded chunk、memory ceiling 与 backpressure 是验收项。

### 16.3 不冒领 multi-daemon

PostgreSQL pool 解决单 daemon 内 query concurrency，不解决：

- 两个 daemon 的 scheduler/admission ownership；
- 本地 workspace/worktree/artifact 的跨主机归属；
- WS/presence/event fanout；
- distributed worker lease/failover；
- object storage 与 shared filesystem；
- schema migration leader election。

V1 daemon lock 继续生效；multi-daemon 另立 RFC。

## 17. 测试与交付证据

### 17.1 结构/架构门

- source 184-table census 与 schema manifest exact set；
- 双 dialect projection/constraint/default/index diff；
- provider client/raw SQL/schema import/`dbTxSync` allowlist；
- application public surface Promise + provider-neutral type gate；
- migration/backup/restore/maintenance provider dispatch exhaustiveness；
- 六表 consumer=0、archive codec 存在、PostgreSQL table absent mutation；
- extra drop/extra target table/ownerless table/stale source digest mutation。

### 17.2 behavior matrix

同一 application oracle 至少在 SQLite/PostgreSQL 跑：

- task create/claim/run/finalize/recovery；
- collaboration/review/human gate；
- scheduler/webhook/call/outbox/idempotency；
- Event Center/committed delivery；
- resource revision/apply/rollback；
- intent/memory/digital employee/development automation；
- backup/restore/doctor/maintenance；
- conflict/CAS/lease/fence/timeout/error mapping。

### 17.3 migration/fault matrix

- empty、minimal、full-seed、large production-shaped SQLite；
- every phase before/after durable checkpoint crash；
- duplicate start、stale owner、late checkpoint、cancel/resume；
- target disconnect/timeout/deadlock/disk-full-like failure；
- corrupted chunk/archive/manifest/pointer；
- row/JSON/blob/bigint/null/sequence/constraint mutations；
- pointer cutover crash、target health fail、first-live-write rollback fence；
- source raw backup 与 target logical restore。

### 17.4 hosted/compiled evidence

- Linux/macOS/Windows compiled single binary 对外部 PostgreSQL smoke；
- SQLite 与 PostgreSQL full backend/frontend/E2E；
- 100-client + full-seed request/maintenance soak；
- large migration report：source size/rows、duration、throughput、peak RSS、status p95/max、event-loop gap、retries、digest；
- exact-SHA Main CI 与全部适用 scheduled workflows terminal success；
- final verification report、schema manifest/provenance、RFC-294 status、STATE/index 同 SHA/ancestry。

本机装了 PostgreSQL 或单测 mock 绿都不能替代 compiled external-connection 与真实 migration evidence。

## 18. RFC-294 对齐与完成边界

本 RFC 延续 RFC-294：bounded-context owner、application-owned required ports、provider mechanism 在 platform/infrastructure、bootstrap 只组合。
批准后需要显式修订 RFC-294 §4.3 的“同步 TransactionPort 是公共形状”，改为 §6 的 Promise application + provider-private transaction。

RFC-349 即使 Done，也只关闭其登记的 database-provider/persistence 子波次。它不自动倒签 RFC-294 的全部 W9，也不证明 RFC-345 或其他
active wave 完成。最终状态必须由 RFC-294 canonical status/provenance 根据实际覆盖投影。

## 19. 被否决的替代方案

| 方案                                   | 否决理由                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| 二进制内嵌 PostgreSQL server           | 体积、升级、数据目录、端口、平台维护与安全责任完全不同；违背外置裁决。               |
| 把 `DbClient` alias 改成 union         | 同步/异步事务与 dialect type 不同，业务仍泄漏 provider。                             |
| 一份 Drizzle schema 同时喂两个 dialect | 类型、default、identity、index/check/collation 与 migration mechanism 无法诚实表达。 |
| 直接 replay SQLite SQL dump            | DDL/dialect 不兼容，也无法做 canonical codec、resume 与业务 invariant。              |
| V1 双写/CDC 零停机                     | 写顺序、冲突、outbox/lease/CAS 与回滚复杂度远超当前目标；需独立 RFC。                |
| 先在 source SQLite drop 六表           | 破坏 rollback generation 与审计证据；迁移只在 target omit。                          |
| 设定“必须降到 100 张表”                | 数量不表达 owner/事务/retention；会诱导错误合表和能力损失。                          |
| 把三类 event 表合并                    | 它们的 source、原子性、delivery、保留期和查询热点不同。                              |
| 依赖 `pg_dump` 做一键迁移              | compiled binary 不应依赖另一可执行文件；native dump 只做 operator extra。            |

## 20. 外部参考

- Bun SQL Promise/pool/transaction：<https://bun.sh/docs/runtime/sql>
- Drizzle Bun SQL PostgreSQL driver：<https://orm.drizzle.team/docs/get-started/bun-sql-new>
- PostgreSQL `COPY`：<https://www.postgresql.org/docs/current/sql-copy.html>
- PostgreSQL advisory lock：<https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS>
- PostgreSQL `pg_dump`：<https://www.postgresql.org/docs/current/app-pgdump.html>

这些文档只证明可用 mechanism；application contract、迁移状态机、schema 收缩和回滚语义由本 RFC定义。

## 21. 批准后才生效的边界

用户已批准 D1～D14。实施从 `plan.md` T1 live baseline/census 开始；如果 184、consumer counts、active RFC 或 current-source 已经变化，
先更新 source-lock 和 schema ledger，再写生产代码。批准授权完整实现、commit 与 push，但不授权降低 schema/data/fault/compiled/hosted
验收门，也不授权覆盖并行 owner 的在途内容。
