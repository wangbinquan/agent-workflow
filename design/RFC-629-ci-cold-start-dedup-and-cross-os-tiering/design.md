# RFC-629 技术设计

## 1. 架构总览

RFC-629 在 RFC-627 建立的三档分级（`docs-only` / `standard` / `full` + `backend-full-nightly`）之上，沿三条正交主线推进：

1. **后端冷启动与夹具准备加速（Track A1–A6）**：消除单隔离文件 ~2s DB 冷加载、Full PG 每文件 DDL/180 表快照、68+ 升级矩阵重复 `bun build --compile`、`rfc294Gates.ts` $O(N^3)$ 线性查找、非登录夹具 Argon2id 与 2 处 30s 硬编码睡眠。
2. **重复扫描与低效夹具合并（Track A7–A8）**：扩展 RFC-624 共享语料扫描、合并后端 `ts.createProgram` 守卫与 `rfc294`/`rfc376` 重复扫描、将纯 Node 前端守卫迁入 `source-guards`、合并 E2E 同配置 `startDaemon()` 并收紧过慢轮询与拆分超长 E2E 文件。
3. **CI 流水线缓存、路径感知与跨 OS 分层（Track A9 + B1–B2）**：去重 `ci-feedback.yml`、缓存非类型感知 ESLint / `.tsbuildinfo`、并行化 `depcheck` / `test-backend-postgresql` / `build-binary`、增量 `gitleaks` + 原生 `shellcheck`、路径感知前端契约快通道与纯后端测试跳过 E2E、跨 OS E2E 分层（Linux 121 全量 + macOS/Windows 19 `OS_CORE_E2E_SPECS` + 每日 `e2e-cross-os-nightly.yml`），并将 Windows 前端迁入 `e2e-cross-os-nightly.yml`（唯一 OS 测试 `e2e-harness.test.ts` 接入 `windows-platform.yml`）。

---

## 2. Track A1–A6：后端冷启动与慢测设计

### 2.1 `persistenceHead()` 仅加载 head 与按需加载 PG catalog

涉及文件：
- `packages/backend/src/platform/persistence/schema/history/artifacts.ts`
- `packages/backend/src/bootstrap/persistenceHead.ts`
- `scripts/schema-history.ts`

设计细节：
1. 抽取公共文件名集合校验函数 `validateSchemaHistoryFileNames(files)`：校验全部文件名均属于已知 `contract` / `sqlite-plan` / `postgresql-plan` / `postgresql-<N>-catalog` 集合（不放宽 `artifact-set` 报错），返回排序后的 `contracts` 列表与 `names`。
2. 抽取单版本 catalog 选择函数 `selectVersionPostgresqlCatalog(files, version, postgresqlMajor, metaTables)`：
   - 仅筛选匹配 `${historyArtifactStem(version)}.postgresql-<N>-catalog.json` 的文件名列表 `catalogNames`。
   - 当 `postgresqlMajor !== undefined`：定位精确文件名 `postgresqlCatalogArtifactName(version, postgresqlMajor)`；不存在即抛 `SchemaHistoryError('catalog-postgresql-major', String(postgresqlMajor))`；**仅读取、解析并 `verifyPostgresqlCatalogArtifact` 这 1 个文件**（不再读取其余 3 个版本）。
   - 当 `postgresqlMajor === undefined`：仅当 `catalogNames.length === 1` 时读取并校验该唯一文件；当 `catalogNames.length === 0 || catalogNames.length > 1` 时直接返回 `undefined`，**零磁盘读取、零 JSON 解析、零 SHA-256 计算**（彻底消除 60 个 / 61 MB catalog 读完即丢弃的问题）。
   - `readHistoryPostgresqlCatalogs()` 签名与全量校验行为保持不变，继续服务 `persistencePostgresqlCatalogs()`、`persistencePostgresqlMajors()` 与 `scripts/schema-history.ts --check`。
3. 新增导出 `readSchemaHeadFile(files, postgresqlMajor?, metaTables?)`：
   - 调用 `validateSchemaHistoryFileNames(files)`；若 `contracts.length === 0` 抛 `SchemaHistoryError('empty', ...)`。
   - 取最后一个合同文件 `contracts.at(-1)!`，仅读取并解析该 head 版本的 `contract` / `sqlite-plan` / `postgresql-plan`，校验 `historyArtifactStem(version) === stem`，按上述逻辑选择 catalog，调用 `verifyHistoryVersion(head)` 并深度 `Object.freeze(head)` 返回。
4. `readSchemaHistoryFiles` 同步改用 `validateSchemaHistoryFileNames` 与 `selectVersionPostgresqlCatalog`（保持对全历史链 `verifySchemaHistory(versions)` 的完整校验，同时消除 60 个被丢弃 catalog 的空读）。
5. **保留 `--check` 对全部 60 个 PG catalog 工件的完整校验（修订 P0-2、R2 P1-3）**：
   - `runSchemaHistoryCommand` 接受可选 `metaTables?: readonly MetaTableDeclaration[]`（默认 `undefined`，与 `readSchemaHistory` 一致，避免未显式传 `metaTables` 的直接调用方在真实 epoch-2 目录上被 `HISTORY_META_TABLES` 误报 `'catalog-artifact-identity'`）；在 `argv[0] === '--check'` 分支执行 `verifySchemaHistory(versions, input.registry)` 后，显式调用 `const files = schemaHistoryFiles(input.directory); for (const version of versions) readHistoryPostgresqlCatalogs(files, version, input.metaTables)`，确保逐份校验全部 60 个 PG catalog 文件的 JSON、SHA-256、`planDigest` 与文件名。
   - `scripts/schema-history.ts` 根据 `resolvedRegistryPath === liveRegistryPath ? EPOCH2_META_TABLES : HISTORY_META_TABLES` 向 `runSchemaHistoryCommand` 显式传入 `metaTables`，保证 `ci-work.yml:scans` 中 `bun run scripts/schema-history.ts --check` 同时校验全部 60 个 PG catalog 的精确 `metaDigest`。
6. `packages/backend/src/bootstrap/persistenceHead.ts`：
   - `artifactFiles()` 保留原有 `IS_EMBEDDED ? SCHEMA_HISTORY_FILES : schemaHistoryFiles(...)` 路径，对嵌入式单二进制与磁盘模式一视同仁；`persistenceSchema.ts` 的 `substitutePersistenceSchemaHistory()` 通过 `persistenceSchemaHistory` getter 覆写 `head`/`history` 来源不受模块内缓存影响。
   - `persistenceHistory(postgresqlMajor?)` 继续调用 `readSchemaHistoryFiles(...)`（保持 `architecture/rfc395-r2-history.test.ts` 对源码含 `'readSchemaHistoryFiles'` 的断言不变）。
   - 新增 `const heads = new Map<number | undefined, HistoryVersion>()`；`persistenceHead(postgresqlMajor?)` 先查 `heads.get(postgresqlMajor)`，次查 `histories.get(postgresqlMajor)?.at(-1)`，未命中时调用 `readSchemaHeadFile(artifactFiles(), postgresqlMajor, EPOCH2_META_TABLES)` 并缓存。

### 2.2 懒加载 `eachProvider.ts` / `testDatabase.ts` 与跨进程 SQLite 基线缓存

涉及文件：
- `packages/backend/src/platform/persistence/sqlite/baseline.ts`
- `packages/backend/tests/helpers/testFixtureCache.ts`
- `packages/backend/tests/helpers/testDatabase.ts`
- `packages/backend/tests/helpers/eachProvider.ts`

设计细节：
1. **`baseline.ts` 保持纯平台边界（零 `node:fs` / `process.env`）**：
   - 新增纯导出 `serializeSqliteBaseline(definition: BaselineDefinition): Uint8Array`（复用内部 `serializedBaseline` WeakMap 缓存）和 `hydrateSqliteBaseline(definition: BaselineDefinition, serialized: Uint8Array, options?: SqliteBaselineOptions): Database`（提取现有 `createSqliteBaseline` 第 117–159 行的 `Database.deserialize` + 写 `now`/`generationId`/timed install seeds/`bootstrap` 逻辑，`createSqliteBaseline` 直接委托给它）。
2. **`testFixtureCache.ts` 新增 `materializeTestFixtureBytes(options)`**：
   - 与 `materializeTestFixture` 共用完全相同的原子目录锁、SHA-256 摘要校验与 `manifest.json` 校验，但无需为每次调用创建目标文件副本：命中时直接从已校验的缓存 `artifact` 读入 `Uint8Array` 并校验 `fixtureDigest(bytes) === manifest.sha256`（~1ms 零文件复制）；未设 `AW_TEST_FIXTURE_CACHE_DIR` 或显式 `cacheRoot: null` 时直接调用 `buildBytes()` 返回。
3. **`testDatabase.ts` 跨进程复用序列化 SQLite 基线（修订 P0-3）**：
   - 进程内缓存 `let cachedBaselineBytes: { key: string; bytes: Uint8Array } | undefined`。
   - 完整无碰撞缓存键（覆盖 `baseline.ts:62-73` 写入 `aw_meta_schema_history.artifact_json` 与 DDL 的全部输入，同时天然隔离 `substitutePersistenceSchemaHistory()` 的合成 head）：
     ```ts
     {
       format: 1,
       contractArtifactDigest: head.contract.digest,
       contractDigest: head.contract.contract.digest,
       sqlitePlanDigest: head.sqlite.digest,
       postgresqlPlanDigest: head.postgresql.digest,
       metaDigest: digestSchemaContract(EPOCH2_META_TABLES),
       bunVersion: Bun.version,
       bunRevision: Bun.revision,
     }
     ```
   - 当 `AW_TEST_FIXTURE_CACHE_DIR` 已设置时，经 `materializeTestFixtureBytes({ kind: 'sqlite-baseline', inputs, buildBytes: async () => serializeSqliteBaseline({ head, metaTables: EPOCH2_META_TABLES }) })` 读取并交由 `hydrateSqliteBaseline` 反序列化；未设时退回内存 `serializeSqliteBaseline`。
   - 将 `testDatabase.ts` 中仅 PG 路径用到的 `postgresqlHistorySession`、`installHistoryHead`、`createPostgresqlDatabaseClient`、`resetPostgresqlGenerationWriteCache`、`createPostgresqlDatabaseRuntime`、`postgresqlHistoryConnection` 改为在 `createPostgresqlTestDatabase()` 内按需动态 `import()`（缓存模块 promise）。
4. **`eachProvider.ts` 懒加载并严格保持 `rfc359-w31` / `rfc359-w39` 边界（修订 P0-7）**：
   - 经核实：`rfc359-w39-provider-harness-lifecycle-diagnostics.test.ts:66-151` 抽取 `registerPostgresql` 并用固定绑定列表 `new Function(...)` 求值；`rfc359-w31-provider-fixture-registration.test.ts:92-126,150-161` 断言 `registerPostgresql` 的 `beforeEach` 同步调用 `resetPostgresqlGenerationWriteCache(database.applicationBinding.runtime)`；`rfc359-harness-hook-budgets.test.ts:139-147` 限制文件内 `*_TIMEOUT_MS` 常量集合。
   - 因此：
     - **保持 `registerPostgresql` 函数体及其自由变量签名与 `resetPostgresqlGenerationWriteCache(database.applicationBinding.runtime)` 同步调用原样不变**（仅保留极轻量的 `resetPostgresqlGenerationWriteCache` 同步导入，或从 `postgresqlDatabaseClient` 仅按需懒载其余重型 PG 模块）；
     - 将最重的 `../migration-freeze`（117.6ms，仅 8/1,255 文件用）、`@/platform/persistence/migration/epoch1/definitions`、`@/platform/persistence/migration/epoch1/contract`、`@/platform/persistence/migration/legacy/postgresqlMigrator` 与 `@/platform/persistence/postgresqlRuntime` 改为在 `registerSqlite`（仅 `options.sqliteMigrationsFolder !== undefined` 分支）与 `createPostgresqlHarnessDatabase` / `seedFromSqliteSnapshot` 内按需动态 `import()`；
     - 所有新增退避常量不得命名为 `*_TIMEOUT_MS`（改为 `POSTGRESQL_TEMPLATE_BUSY_MAX_ATTEMPTS`、`POSTGRESQL_TEMPLATE_BUSY_BASE_DELAY_MS`）。

### 2.3 PostgreSQL `CREATE DATABASE ... TEMPLATE` 与静态快照缓存（修订 P0-3、P0-7、R2 P0-1、R2 P0-2）

涉及文件：
- `packages/backend/tests/helpers/eachProvider.ts`

设计细节：
1. **严格启用条件**：仅当 `options.sqliteMigrationsFolder === undefined && process.env[TEST_FIXTURE_CACHE_ENV]` 已设置且 `sourceUrl !== undefined` 时启用模板克隆；历史 epoch-1 路径或未设缓存目录时完全走原路径。（注：`DescribeEachProviderOptions` 不含 `now` 字段，无需额外判 `options.now`。）
2. **精确 PG 模板键（修订 P0-3、R2 P0-2：不用 `URL.origin`，且去掉 `pathname` 共享集群级模板）**：
   - WHATWG `URL` 对非特殊协议 `postgresql://` 的 `.origin` 恒为字面量 `"null"`；且 `aw_tpl_<id>` 是 PG 集群级模板库，与维护连接 URL 中的数据库名（`pathname`）无关——去掉 `pathname` 可使 `run-postgresql-gate.ts` 的 3 个独立槽位库 worker 共享同一个集群模板而零重复构建：
     ```ts
     {
       format: 1,
       protocol: parsedUrl.protocol,
       host: parsedUrl.host,
       username: parsedUrl.username,
       search: parsedUrl.search,
       contractArtifactDigest: head.contract.digest,
       contractDigest: head.contract.contract.digest,
       sqlitePlanDigest: head.sqlite.digest,
       postgresqlPlanDigest: head.postgresql.digest,
       metaDigest: digestSchemaContract(EPOCH2_META_TABLES),
     }
     ```
   - 模板库名：`aw_tpl_${templateKey.slice(0, 16)}`（23 字符合法 PG 标识符）。
3. **模板克隆归位于 `createPostgresqlFileDatabase` 与 `createPostgresqlHarnessDatabase`（修订 P0-7、R2 P0-1）**：
   - **不修改 `registerPostgresql` 的外部自由变量集合**：在 `registerPostgresql` 覆写 `process.env[urlEnv]`（第 1513 行）之前先捕获 `const baseUrl = process.env[urlEnv]`，对 `index === 0` 与 `index >= 1`（`databaseCount > 1`）统一向 `createPostgresqlFileDatabase(baseUrl, ordinal, undefined, templateOptions)` 传入 `baseUrl`（绝不传入被覆写后的临时库 URL），并将所有额外库句柄收集到 `additionalFileDatabases`，在 `initializeDatabases` 的 `catch` 与 `cleanupDatabases` 的 `finally` 中位于 `closeAll()` 之后统一 `drop()`，杜绝多库 URL 污染与临时库泄露！
   - `createPostgresqlFileDatabase(sourceUrl, ordinal, connect, templateOptions?)` 返回 `{ url, drop, clonedFromTemplate?: { templateName, staticSnapshot } }`（未传 `templateOptions` 时行为 100% 向后兼容）。
   - 首次建模板在 `materializeTestFixtureBytes({ kind: 'pg-epoch2-snapshot', inputs })` 持锁回调中完成：连管理库清理任何残留 `aw_tpl_<id>` → `create database "aw_tpl_<id>"` → 用 **`generationId: GENERATION_ID`** 构造 `createPostgresqlDatabaseRuntime` 连入模板库（确保克隆库 `aw_meta_generations` 存在活跃 `GENERATION_ID`，防止写入触发 `PostgresqlGenerationFenceError`！）→ 执行 `createPostgresqlTestDatabase(runtime, { bootstrap: 'required' })` + `snapshotSchema(query)` → 彻底关闭模板库连接、执行 `pg_terminate_backend` 并**有界轮询 `pg_stat_activity` 直至模板库活跃连接数归零**（消除 `pg_terminate_backend` 异步退出导致的立即 `55006`）→ 将静态快照 JSON（附每条 seed 的 `stableSeedEligible: boolean` 标记）原子写入缓存。
   - **并发克隆冲突（`55006 object_in_use`）与模板缺失（`3D000`）自愈**：
     - 并发执行 `CREATE DATABASE "${name}" TEMPLATE "aw_tpl_<id>"` 收到 `55006` 时，执行有界抖动退避重试（`POSTGRESQL_TEMPLATE_BUSY_MAX_ATTEMPTS = 6`，50–300ms 退避）；
     - 重试耗尽或收到 `3D000`（模板库被外部重启/清理缺失）时，立即安全降级为常规 `create database "${name}"`（`clonedFromTemplate = undefined`），由 `createPostgresqlHarnessDatabase` 走原 `drop schema` + `createPostgresqlTestDatabase` + `snapshotSchema` 路径。
   - **严格保留 `bootstrap: 'required'` 语义与 per-DB 快照隔离（修订 P0-7、R2 P0-1）**：
     - 模板克隆命中时，`createPostgresqlHarnessDatabase` 跳过 `drop schema` 与 `createPostgresqlTestDatabase` DDL/种子重放，直接创建 `createPostgresqlDatabaseClient(applicationRuntime, { liveSchema: persistenceSchemaBinding })`，**绝不在此处调用 `registerLegacyDaemonTestFixture(client)`**（保持仅在 `beforeEach` 且 `options.bootstrap !== 'required'` 时登记）；
     - 为每个数据库**深拷贝** `seeds` 对象数组（`staticSnapshot.seeds.map((s) => ({ ...s }))`）避免 `seed.stableIdentity` 在多库间共享别名，仅对 `stableSeedEligible === true` 的大种子表（当前仅 `aw_meta_schema_history` 1 张）在克隆库上执行 1 次 `seedIdentity(query, seed)`（< 2ms）刷新当前库的 `ctid:xmin`。

### 2.4 缓存 `installMockRuntime()` 编译二进制

涉及文件：`packages/backend/tests/helpers/releaseUpgrade/daemon.ts`
- `installMockRuntime()` 将 `entrySource`、`fixture` 路径、`await fixtureFileDigest(fixture)`、`Bun.version`、`Bun.revision`、`process.platform`、`process.arch` 作为 `inputs`，调用 `materializeTestFixture({ kind: 'matrix-mock-opencode', executable: true, inputs, destination: outfile, build })`；`build` 在隔离临时目录内写 `matrix-mock-entry.ts` 并执行原 `Bun.spawn([process.execPath, 'build', entry, '--compile', '--target', 'bun', '--outfile', destination])`。未设 `AW_TEST_FIXTURE_CACHE_DIR` 时自动直接编译。

### 2.5 `rfc294Gates.ts` 索引化、Argon2id 优化与慢测清理（修订 P0-5、P1-9、P2-2、P2-3、P2-4）

1. **`packages/backend/tests/architecture/rfc294Gates.ts` + `rfc376-structural-guards.test.ts`（修订 P0-5、R2 P2-1）**：
   - 为 `resolveUnit(units, path)` 建立 `WeakMap<readonly SourceUnit[], { exact: Map<string, { unit: SourceUnit; index: number }>; suffix: Map<string, { unit: SourceUnit; index: number }> }>`（按 `units` 原顺序首次写入），查找全部 4 个 `attempts` 的 `exact` 与 `suffix` 命中并返回 **`index` 最小者**，保证与原 `units.find((u) => attempts.includes(u.path) || attempts.some((a) => u.path.endsWith('/' + a)))` 100% 逐项等价，时间复杂度 $O(N) \to O(1)$。
   - 用 `WeakMap<SourceUnit, Map<string, ImportBinding>>` 与 `WeakMap<SourceUnit, Map<string, ts.Declaration>>` 缓存 `importBindings(unit)` 与 `namedDeclarations(unit)`。
   - **绝不按外层名称缓存 `sensitiveIdentityName`**：改为仅缓存 `resolveNamedDeclaration(units, unit, name)` 的非环解析结果以及已解析声明体自身（按 `${target.unit.path}:${target.declaration.pos}`）的静态检查结果，且**绝不缓存因命中递归环（`seen`）而提前返回的 `undefined`**（防 `type A = B | OwnedTaskTx; type B = A` 环路缓存投毒），对每个 `ts.TypeReferenceNode` 始终完整遍历 `node.typeArguments` 与完整限定名（`Ns.Alias`）。
   - 在 `rfc376-structural-guards.test.ts` 中将已计算的 `OBSERVED` 传入 `reportGateSets`，不再重跑整套 `gateViolationSets(CORPUS)`。
2. **`packages/backend/src/auth/passwords.ts` + `packages/backend/tests/helpers/userFixture.ts`（修订 P2-3）**：
   - `passwords.ts` 导出 `HASH_OPTS`（只读常量）并用相同 `HASH_OPTS` 预生成字面量 `DUMMY_ARGON2ID_HASH`（精确参数 `$argon2id$v=19$m=19456,t=2,p=1$...`），`verifyPasswordDummy` 直接 `await Bun.password.verify(plaintext, DUMMY_ARGON2ID_HASH)`；在 `rfc103-login-timing.test.ts` 锁定该常量参数头与正反验密行为。
   - `userFixture.ts` 新增测试专用 `fixturePasswordHash(plaintext)`：复用 `passwords.ts` 的相同长度上下界校验与 `HASH_OPTS` 生成缓存键（不硬编码 `'m=19456,t=2,p=1'`），进程内 `Map<string, Promise<string>>` + 可选 `AW_TEST_FIXTURE_CACHE_DIR`（`kind: 'test-user-argon2id'`）复用真实 `hashPassword(plaintext)` 结果。生产 `hashPassword()` 每次仍生成随机盐，零改动。
3. **消除 30s 硬编码睡眠与局部慢测优化（修订 P1-9、P2-2、P2-4）**：
   - `packages/backend/src/main.ts`（`packages/backend/src/cli/stop.ts:31-36` 已接受 `timeoutMs?: number`）：为 `stop` 子命令解析 `--timeout <ms>`（拒绝缺参、`NaN`、小数、`<= 0` 及非纯数字字符串并返回非 0 退出码；默认保持 `30_000`）；`rfc319-stop-not-graceful.test.ts` 用 `--timeout 500` 测真实非优雅停机退出码 1，并新增单测锁定默认值 `30_000` 及非法 `--timeout` 拒绝分支。
   - `rfc361-execution-contract-providers.test.ts`：为 `createExecutionContractProgramFixtureAdapter` 增加可选 `timeoutMs = 30_000`（断言默认 `30_000`），用 `timeoutMs: 300` 验证真实超时终止与工作区清理。
   - `rfc254-stub-differential.test.ts`：仅在非录制模式（`!RECORDING`）以 4-worker 受限并发池跑隔离 `Bun.spawn` 捕获；`UPDATE_STUB_GOLDENS=1` 录制模式保持串行防写竞态；保留全部黄金对比与 `minDurationMs` 断言。
   - `rfc311-task-page-filtered-fastpath.test.ts`（修订 P1-9）：将 `insertForest` 改为 3 次批量插入（替代 210 次逐行 `insertOne`），并将 9 条纯只读过滤矩阵断言合并到 1 个 `test()`（显式超时）以便在 `describeEachProvider` 的单次 `beforeEach` 内共享 1 份预置只读森林，零断言删减。
   - `rfc311-perf-guards.test.ts`（修订 P1-9、R2 P1-1）：将 6 条纯只读 `list` 路径合并进 1 个 `test('read-only list paths on shared SMALL/LARGE corpora', ..., 180_000)`，在同一 `describeEachProvider` `beforeEach` 生命周期内分别只种 1 次 `SMALL`（200 行，连测全部 6 条只读路径）与 1 次 `LARGE`（500 行，连测全部 6 条只读路径）；保留 2 条修改数据的 `sweep` 路径为各自独立 `test()`，同时保持顶层 `const GUARDED = [...]` AST 声明（第 845–893 行守卫检查）与 `MEASURED` / `comparisons` 完整记录（第 826–834 行 `afterAll` 检查），不改变批插、9 次 P95 采样与全部 `EXPLAIN` 断言。

---

## 3. Track A7–A8：重复扫描合并、纯 Node 前端与 E2E 夹具复用

### 3.1 共享语料与共享 `ts.Program` 守卫合并（修订 P0-4、P1-8）

1. **扩展 RFC-624 共享迁移引用语料（修订 R2 P1-2）**：
   - 将 `rfc624-migration-reference-guard.test.ts` 的扫描根从 4 根扩展为 **5 根**（新增仓库根 `tests/`，覆盖 `tests/perf/run.ts`，与 RFC-617..622 保持完全一致，绝不丢失仓库根 `tests/` 扫描覆盖）。
   - 将 RFC-584 / 585 / 586 / 588 / 590 / 591 / 592 / 593 / 594 / 617 / 618 / 619 / 620 / 621 / 622 等采用相同 `resolveMigrationSpecifiers` 模式的边界守卫的旧路径扫描登记进 `MIGRATION_REFERENCE_RULES`，由 `rfc624-migration-reference-guard.test.ts` 单次遍历 6,500+ 文件完成全部规则断言（每条独立 `test()` 名称与 RFC 编号不变）。
   - 各原文件保留其独有的文件存在性、导出清单、自定义单文件规则与全部负夹具；对其余自定义单文件 AST 检查（如 `rfc594`、`rfc620`、`rfc472`–`rfc478` 等）在调用 `ts.createSourceFile` 前增加数学无损预过滤（`!text.includes(needle) && !text.includes('\\u')`）。
   - 同步更新 `architecture/guard-manifest.json`：**仅对已迁出全部全仓扫描（不再包含 `walk(...)` 语料遍历）的文件**改为 `corpusScanner: false, minCorpusFiles: null`；对仍保留二次 `walk(...)` 扫描的文件（如 `rfc584`/`585`/`586`/`618`/`620`/`621`/`622`）严格维持 `corpusScanner: true` 及其剩余实测 `minCorpusFiles`，确保满足 `rfc317-guard-corpus-floor.test.ts` 的双向精确契约。
2. **修复 `rfc400-collaboration-task-participants.test.ts` 根集（修订 P0-4）**：
   - 将 `ts.createProgram` 根文件从全部 ~1,700 文件收窄为 **全部匹配 `/^packages\/backend\/src\/modules\/[^/]+\/public\//` 的单元**（覆盖全仓所有 bounded context 的 `public/` 与负夹具中的 `modules/probe/public/*`，TS 经 `resolveModuleNames` 自动追踪全部传递导入，保证 `publicExports >= 500` 与全部正反用例 100% 等价）。
3. **新增共享 `ts.Program` 守卫 `packages/backend/tests/architecture/rfc629-shared-program-guards.test.ts`（修订 P1-8、R2 P0-4）**：
   - 为在不混入前端 `.tsx` 的前提下为 `packages/backend`、`packages/shared` 与 `packages/frontend` 全部保留真实 `ts.TypeChecker`（支持 `rfc374` 的完整 **R1–R4**，含 `detectNodeRunIdOrder` 与 `detectNodeRunOrderById`）：
     - **后端 + shared 纯 `.ts` `ts.Program`（1 次构建，基于 `packages/backend/tsconfig.json` 并包含 `packages/shared/src/**/*.ts`）**：零 `.tsx`、纯 `.ts`，供 `rfc359-w5-t18-bare-transaction`、`rfc359-w5-unattended-void-promise`、`rfc395-neutral-query-boundary`、`scheduler-audit-s10-async-transaction-decorative` 各自按原目录范围筛选 `program.getSourceFiles()` 运行，并供 `rfc374-node-run-order-guard` 在 `backend + shared` 上用真实 `TypeChecker` 完整执行 **R1–R4**；
     - **前端独立 `ts.Program`（1 次构建，基于 `packages/frontend/tsconfig.json`）**：在 `packages/frontend/src/**`（含 `.tsx`）上用真实 `TypeChecker` 完整执行 `rfc374-node-run-order-guard` 的 **R1–R4**；
     - **`rfc395-d4-mint-order-boundary`**：直接复用上述两份 `ts.Program` 已解析好的全部 `backend + shared + frontend` `SourceFile` AST，零额外文件读取与解析。
   - 各原文件保留全部独立负夹具、纯函数单测与行为测试（特别是 `scheduler-audit-s10-async-transaction-decorative.test.ts` 保留其 SQLite 行为测试以维持 `rfc359-w5-t19f-test-engine-hardcoding.test.ts:384` 的精确登记，且 `rfc374-node-run-order-guard.test.ts` 保留在 `architecture/guard-manifest.json` 以满足第 377 行自检），同步更新 `guard-manifest.json` 并登记 `rfc629-shared-program-guards.test.ts`（含 `corpusScanner: true`、`minCorpusFiles` 语料下限与负夹具）。
   - `architecture/rfc294-review-module-layer-rules.test.ts`：移除与 `rfc376-structural-guards.test.ts` 完全重复的 live-corpus `moduleLayerViolations` 扫描，保留全部独立负对照用例，同步更新 `guard-manifest.json`（`corpusScanner: false, minCorpusFiles: null`）。

### 3.2 前端纯 Node 测试迁入 `source-guards`（修订 P1-11）

- `packages/frontend/vitest.config.ts`：将实测在 `environment: 'node', setupFiles: []` 下 100% 通过的纯 Node `.test.ts` 文件加入 `sourceGuardFiles`（保持单列表同时用于 `source-guards.include` 与 `dom.exclude`）；同步更新 `packages/backend/tests/rfc624-test-execution-contracts.test.ts:19-24,159` 使守卫校验 `source-guards.include` 与 `dom.exclude` 的精确一致性及非空下限，且包含原 4 个文件。

### 3.3 E2E 同配置守护进程复用、轮询收紧与长文件拆分（修订 P1-3、P2-1、R2 P2-2）

- `e2e/auth-isolation.spec.ts`：8 个纯 `fetch` 用例共享 1 个 `beforeAll` `startDaemon({ stubMode: 'basic' })`（每例独立用户名/任务名）。
- `e2e/rfc250-interaction-integrity.spec.ts`（修订 P2-1）：拆为 `clarify` 组（1 个 `beforeAll` daemon）与默认组（5 条用例共享 1 个 `beforeAll` daemon），并在用例 6 的 `finally` 中恢复 `await setDaemonLanguage('en-US')` 防全局语言配置污染后续用例或重试。
- `e2e/identity-access.spec.ts`（修订 R2 P2-2）：保留用例 1（`authMode: 'bootstrap'`）独立 daemon；用例 2–6 共享 1 个默认 `beforeAll` daemon（独立用户名，并在创建额外 admin 的用例的 `finally` 中禁用/清理，确保 IAM-30 的 `humanAdmins.length === 1` 断言不受前序用例影响）。（注：`e2e/intent-builder.spec.ts:27-32` 已为同配置用例共享 `beforeAll` daemon，无需重复改造。）
- `e2e/rfc396-graph-development.spec.ts` 与 `e2e/rfc396-graph-care-repair.spec.ts`（修订 P1-3、R2 P2-2）：
  - 收紧轮询间隔 `[1_000, 2_500, 5_000]` → `[200, 500, 1_000]`；
  - 将 `e2e/rfc396-graph-development.spec.ts`（4 条用例，macOS 307s）抽取公共辅助至 `e2e/helpers/rfc396GraphDevelopment.ts` 并拆分为 `e2e/rfc396-graph-development.spec.ts`（2 条）与 `e2e/rfc396-graph-development-recovery.spec.ts`（2 条，含重启 daemon 的恢复用例独立拥有自己的生命周期；若环境变量 `RFC396_E2E_HOME` 已设置则按 spec 标识分目录隔离，防双 worker 并发写冲突），同步更新 `architecture/e2e-capability-ledger.json` 中移出用例的 `{ file, test }` 路径以保持 `rfc319-capability-ledger.test.ts` 全绿！

---

## 4. Track A9 + B1–B2：CI 流水线、路径感知与跨 OS 分层设计

### 4.1 扩展 `classify-ci-changes.ts`（修订 P0-6、P1-6、P1-7）

涉及文件：`scripts/ci/classify-ci-changes.ts`

新增 3 个输出（全部 fail-closed）：

1. **`runFrontendFull: boolean`**（`GITHUB_OUTPUT`: `run_frontend_full=true|false`）：
   - `mode === 'docs-only'` → `false`。
   - fail-closed（空 diff / 无效路径 / API 不可用 / `workflow_dispatch mode=full`）→ **`true`**。
   - 否则：变更集中任一文件命中 `FRONTEND_FULL_TRIGGER_EXACT_PATHS`（`package.json`、`bun.lock`、`bunfig.toml`、`tsconfig.base.json`、`eslint.config.js`、`.prettierrc`、`.prettierignore`、`.github/workflows/ci.yml`、`.github/workflows/ci-work.yml`）或 `FRONTEND_FULL_TRIGGER_DIR_PREFIXES`（`packages/frontend/`、`packages/shared/`、`scripts/ci/`）→ **`true`**；否则 **`false`**。
   - **安全网（修订 P1-7、R2 P1-4）**：新增 `packages/backend/tests/architecture/rfc629-ci-optimization-invariants.test.ts`（正式登记于 `architecture/guard-manifest.json`，含 `corpusScanner: true`、`minCorpusFiles` 与负夹具），用 TypeScript AST 扫描全部 `packages/frontend/tests/**/*.test.ts*` **以及 `packages/frontend/src/**/*.test.ts*`**，并沿相对/`@/` 导入递归追踪 `packages/frontend/tests/` 与 `packages/frontend/src/` 内的本地辅助模块，解析 `import` / `export` / 动态 `import()` 说明符及 `node:fs` / `path.{join,resolve}` 路径参数（精确识别相对越界路径 `../../backend`、`../../../e2e`、`../../../docs`、repo-relative 路径及 `@/util/hash` 别名，不误判 UI 演示字符串），锁定全部跨包前端测试均已登记在 `scripts/ci/run-frontend-contract-tests.ts` 的 `FRONTEND_CROSS_PACKAGE_TESTS` 中！
2. **`runE2e: boolean`**（`GITHUB_OUTPUT`: `run_e2e=true|false`）：
   - `mode === 'docs-only'` → `false`。
   - fail-closed 或 `workflow_dispatch mode=full` → **`true`**（`workflow_dispatch mode=auto` 按累计 diff 推导，无有效 diff 时同样 fail-closed 为 `true`）。
   - **精确边界（修订 P0-6、R2 P2-3）**：`isBackendTestOnlyPath(path)` 直接复用 `scripts/ci/backend-shards.ts` 的 `isValidBackendTestPath(path)`（精确匹配 `^packages/backend/tests/.*\.test\.ts$`），**显式排除** `packages/backend/tests/helpers/**`、`packages/backend/tests/fixtures/**`、`packages/backend/tests/migration-freeze.ts` 等可能被 `e2e/` 导入的共享文件！
   - 仅当累计 diff 中**每一个文件**都满足 `isDocsOnlyPath(path) || isBackendTestOnlyPath(path)` 时 `runE2e = false`；否则 `true`。注意：当改动仅触及 `packages/backend/tests/rfc395-*.test.ts` 等迁移测试文件时，`mode === 'full'` 且 `runE2e === false` 合法并正交（`test-backend-migration` 照跑 28 片真 PG，`build-binary*`/`e2e*` 跳过，`ci-required` 按 `RUN_E2E` 精确校验）；并在 `rfc629-ci-optimization-invariants.test.ts` 锁死 `e2e/` 中没有任何文件导入/读取 `packages/backend/tests/` 下任意 `*.test.*` 或 `*.spec.*` 文件。
3. **`gitleaksBaseSha: string`**（`GITHUB_OUTPUT`: `gitleaks_base_sha=<40-char sha | ''>`）：等于已解析的合法 40 位 `baseSha`，fail-closed 时为 `''`。

### 4.2 跨 OS E2E 分层与 `OS_CORE_E2E_SPECS`（修订 P1-2、P1-4、P1-10）

涉及文件：`scripts/ci/e2e-shards.ts`、`scripts/ci/plan-e2e-shards.ts`、`scripts/ci/refresh-e2e-timings.ts`、`.github/workflows/ci-work.yml`、`.github/workflows/e2e-cross-os-nightly.yml`、`.github/workflows/ci-timings.yml`

1. **`OS_CORE_E2E_SPECS`（19 个 spec）** 导出于 `scripts/ci/e2e-shards.ts`（单点权威）：
   - `e2e/main.spec.ts`、`e2e/system-mocks.spec.ts`、`e2e/crash-recovery.spec.ts`、`e2e/ops-local-recovery.spec.ts`、`e2e/rfc294-human-gate-restart.spec.ts`、`e2e/rfc294-webhook-runtime-failures.spec.ts`、`e2e/webhook-mr-runtime-races.spec.ts`、`e2e/task-lifecycle-states.spec.ts`、`e2e/runtime-scenario-matrix.spec.ts`、`e2e/commit-push.spec.ts`、`e2e/commit-push-rejection.spec.ts`、`e2e/rfc319-worktree-and-commit.spec.ts`、`e2e/rfc321-code-push-credentials.spec.ts`、`e2e/repo-group-launch.spec.ts`、`e2e/repo-governance.spec.ts`、`e2e/rfc253-script-node.spec.ts`、`e2e/rfc264-unicode-names.spec.ts`、`e2e/rfc396-graph-care-repair.spec.ts`、`e2e/rfc319-canvas-editing-ops.spec.ts`。
   - 不改任何 spec 的 Playwright `tag:`（RFC-319 `@nightly` 唯一 tag 守卫 100% 不变）。
   - `filterE2EDiscoveryByTier(discovered, tier: 'pr-full' | 'os-core')` 在 `os-core` 下 fail-closed 要求全部 19 个 spec 都出现在 Playwright 发现结果中，并在 `E2EShardPlan` 写入 `tier: 'pr-full' | 'os-core'`（历史无该字段视为 `'pr-full'`）。
2. **`e2e-cross-os-nightly.yml`（修订 P1-2）**：
   - `cron: '30 4 * * *'` + `workflow_dispatch`，包含：`build-binary-macos`、`build-binary-windows`、`e2e-macos-full`（3 片 × 3 worker，`--tier=pr-full`）、`e2e-windows-full`（4 片 × 4 worker，`--tier=pr-full`，**完整携带 `AW_E2E_WINDOWS_EXCLUDE: 'focus rings are not clipped anywhere|rfc250-workflow-camera'` 并合入单条 `--grep-invert "$AW_E2E_TIER_EXCLUDE|$AW_E2E_WINDOWS_EXCLUDE"`**）、`test-frontend-windows`（3 片全量 Vitest）、`gitleaks-full-history`（`fetch-depth: 0` 完整历史扫）。
3. **`workflow-source.ts` + `refresh-e2e-timings.ts` 严格校验来源、`plan.tier` 与精确文件集（修订 P1-10、R2 P0-3）**：
   - 在 `scripts/ci/workflow-source.ts` 新增 `E2E_CROSS_OS_NIGHTLY_PATH = '.github/workflows/e2e-cross-os-nightly.yml'` 与 `resolveCrossOsNightlyE2ESource(readSourceFile)`（校验 `schedule` + `workflow_dispatch` 与作业集合含 `e2e-macos-full` / `e2e-windows-full`）。
   - 在 `scripts/ci/refresh-backend-timings.ts` 导出 `CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES`（`workflowName: 'e2e-cross-os-nightly'`, `workflowPath: E2E_CROSS_OS_NIGHTLY_PATH`, `events: ['schedule', 'workflow_dispatch']`）。
   - `refresh-e2e-timings.ts` 新增可选标志 `--source=ci|cross-os-nightly`（默认 `ci`）与 `--merge-base <existing.json>`：
     - 来源 `CI`（`resolveCiWorkSource`）：`assertE2EShardTopology` 支持 `3/2/2`（现行：`e2e` 3 片 `pr-full`、`e2e-macos` 2 片 `os-core`、`e2e-windows` 2 片 `os-core`）、`3/3/4`（历史）与 `3/4/4`（历史）；对 `3/2/2` 强制断言 `linux` 的 `plan.tier === 'pr-full'`、`macos`/`windows` 的 `plan.tier === 'os-core'` 且测量文件集合与 `OS_CORE_E2E_SPECS` 逐项相等，并强制要求提供 `--merge-base` 以保留非 `os-core` 项（缺 `--merge-base` 即 fail-closed 抛错）。
     - 来源 `e2e-cross-os-nightly`（`resolveCrossOsNightlyE2ESource`）：`assertCrossOsNightlyE2ETopology` 校验 `e2e-macos-full` 3 片 + `e2e-windows-full` 4 片，强制断言全部 `plan.tier === 'pr-full'`，全量替换 `platforms.macos` / `platforms.windows` 并经 `--merge-base` 保留 `platforms.linux`。
     - 历史 `CI` 的 `3/3/4` 与 `3/4/4`（`plan.tier` 缺省或 `'pr-full'`）保持 100% 兼容。
4. **`ci-timings.yml` 精确匹配可复用作业名与历史向后兼容（修订 P1-4、R2 P0-3）**：
   - `workflows: [CI, backend-full-nightly, e2e-cross-os-nightly]`，并发组按 `github.event.workflow_run.name` 隔离。
   - 当 `SOURCE_WORKFLOW = CI` 且 `core_count > 0 && e2e_count == 0` 时：查询 `gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${SOURCE_RUN}/jobs?per_page=100" --paginate`，按可复用工作流前缀正则 `^Full CI / (Playwright e2e|e2e($|-)|Build production binary|build-binary($|-))` 筛选全部 E2E/构建作业，要求匹配作业数 `>= 6` 且**全部匹配作业 `conclusion == "skipped"`** 时才允许进入 `core-only-ci`；否则 fail-closed 报错退出 1！
   - 在 `core-ci` 分支调用 `scripts/ci/refresh-e2e-timings.ts` 时，检测所检出 `head_sha` 的脚本是否支持 `--merge-base`（`grep -q -- '--merge-base' scripts/ci/refresh-e2e-timings.ts`）：支持时传 `--merge-base .github/e2e-test-timings.json`，对历史 pre-RFC-629 的 `CI` 提交沿用原 3 参数调用，绝不破坏在途历史 run！
   - 在 `cross-os-e2e-nightly` 分支调用 `bun scripts/ci/refresh-e2e-timings.ts --source=cross-os-nightly --merge-base .github/e2e-test-timings.json "$RUNNER_TEMP/measured-e2e" "$SOURCE_RUN" "$RUNNER_TEMP/timing-review/e2e-test-timings.json"`。

### 4.3 `ci.yml` / `ci-work.yml` / `windows-platform.yml` / `build-binary.ts` 精确改动（修订 P0-1、P1-1、P1-5、P1-11、P1-12）

1. **删除 `.github/workflows/ci-feedback.yml`**。
2. **`ci.yml`**：
   - `detect-changes` 输出 `mode`、`base_sha`、`links_base_sha`、`run_frontend_full`、`run_e2e`、`gitleaks_base_sha`、`reason`。
   - `full-ci` 透传 `run_migration_full`、`links_base_sha`、`run_frontend_full`、`run_e2e`、`gitleaks_base_sha`。
   - `ci-required` 接收 `RUN_E2E: ${{ needs['detect-changes'].outputs.run_e2e }}`：在 `standard | full` 模式下，正交校验 `RUN_E2E`（`'true'` 要求 6 个 `build-binary*`/`e2e*` 全 `success`，`'false'` 要求全部 `skipped`，其他任何值报错）。
3. **`ci-work.yml`（保持 14 个 `CI_WORK_JOB_IDS` 不变）**：
   - **`test-frontend`（修订 P0-1）**：使用合法动态矩阵轴（不在 job 级 `if:` 引用 `matrix`）：
     ```yaml
     strategy:
       fail-fast: false
       matrix:
         os: [ubuntu-latest]
         shard: ${{ fromJSON(inputs.run_frontend_full && '[1, 2, 3]' || '[1]') }}
     ```
     内部两个互斥步：
     - `if: ${{ inputs.run_frontend_full }}` → `bun run --filter @agent-workflow/frontend test -- --shard=${{ matrix.shard }}/3`（保持 `rfc349-functional-evidence.test.ts:83-85` 精确命令串！）
     - `if: ${{ !inputs.run_frontend_full }}` → `bun scripts/ci/run-frontend-contract-tests.ts`（运行全部 19 个跨包前端契约测试）。
   - **`lint`（修订 P1-12）**：
     - 保留 Prettier 缓存；新增非类型感知 ESLint 缓存（`path: node_modules/.cache/eslint`，key 含 `eslint.config.js`、`bun.lock`、`package.json`、`packages/*/package.json`、`${{ github.sha }}`；`lint:promises` 仍无缓存）；新增 `tsc` 增量缓存（`path: node_modules/.cache/tsc`，key 为 `tsc-v1-${{ runner.os }}-bun-1.4.3-${{ hashFiles('bun.lock', 'package.json', 'packages/*/package.json', 'tsconfig.base.json', 'packages/*/tsconfig.json') }}-${{ github.sha }}` + 同前缀 `restore-keys`），配合 `packages/{backend,frontend,shared,system-mocks}/tsconfig.json` 开启 `incremental: true` 与 `tsBuildInfoFile: "../../node_modules/.cache/tsc/<pkg>.tsbuildinfo"`。
     - 并行化 `scripts/depcheck.ts:314`（`Promise.all(PACKAGES.map(...))`）；在 `lint` job 中将快检步骤（`format:check`、`depcheck`、`shared test`、`system-mocks test`）并行跑，随后并行跑 `lint` + `typecheck`（严格捕获每路退出码，任一失败即整步退出 1）。
   - **`test-backend`（修订 P1-5）**：12 片（`BACKEND_CORE_SHARDS = 12`）；`scripts/ci/refresh-backend-timings.ts` 与 `scripts/ci/compose-backend-timings.ts` 同步兼容现行 `12` 片与历史 `16` 片 core 产物。
   - **`test-backend-postgresql`（修订 R2 P0-2）**：设置 `AW_TEST_FIXTURE_CACHE_DIR=$RUNNER_TEMP/aw-test-fixtures`；测试步执行 `bun scripts/ci/run-postgresql-gate.ts --concurrency=3`：
     - 由于 `TEST_BACKEND_POSTGRESQL_FILES` 中有 3 个文件（`rfc357-postgresql-page.integration.test.ts`、`rfc359-engine-capabilities.test.ts`、`rfc359-w6-t26-postgresql-plan-audit.test.ts`）直接连接 `AW_TEST_POSTGRESQL_URL` / `RFC357_DATABASE_URL` 并在原地 `DROP SCHEMA CASCADE`，`run-postgresql-gate.ts` 启动前必须为每个并发槽位 `slot ∈ [0..concurrency-1]` 在 PG 实例上创建独立临时数据库 `aw_pg_gate_${process.pid}_${slot}`（并在 `finally` 踢掉残留连接并 `DROP DATABASE IF EXISTS`），向每个 worker 子进程将 `AW_TEST_POSTGRESQL_URL`、`RFC357_DATABASE_URL`（以及已定义的 `RFC359_DATABASE_URL`）改写为该槽位专属库 URL！
     - 借助 §2.3 #2 去掉 `pathname` 的集群级 `aw_tpl_<id>` 模板键，3 个槽位 worker 里的 `describeEachProvider` 文件依然共享同一模板库，同时 3 个直连库测试彻底零 `DROP SCHEMA` 竞争；汇总全部 16 文件输出并执行 `(skip).*real PostgreSQL` fail-closed 检查；
     - P0 变异执行 `bun scripts/rfc359-p0-mutations.ts --providers sqlite,postgresql --concurrency 4 --output-dir test-results/rfc359-p0-mutations`（先跑各 provider 的 `current-before`，再以 4-worker 并发池跑 15 个只读 `--preload` 变异阶段，最后跑 `current-after`，结果按规范 `(provider, phase)` 排序写入 `results.json`）。
   - **`scans`（修订 P1-12、R2 P2-3）**：
     - `fetch-depth: 205`（确保 `MAX_ANCESTOR_DISTANCE = 200` 处的基点提交及其父提交均在本地，避免 200 步边界误触发 `--unshallow`）；`shellcheck` 改用预装原生 `shellcheck --severity=error` 扫全仓 `.sh`（排除 `node_modules`/`dist`/`.git`，`command -v shellcheck` 缺失即报错）；`actionlint`（固定版本）与 `gitleaks`（`8.30.1`）二进制按版本号缓存；
     - `gitleaks` 增量检查逻辑：当 `GITLEAKS_BASE_SHA` 非空且 `git cat-file -e "${GITLEAKS_BASE_SHA}^{commit}"`、`git merge-base --is-ancestor "${GITLEAKS_BASE_SHA}" HEAD` 且 `count=$(git rev-list --count "${GITLEAKS_BASE_SHA}..HEAD")` 满足 `count > 0` 时，运行 `gitleaks detect --source . --log-opts="${GITLEAKS_BASE_SHA}..HEAD" --no-banner --redact --verbose`；否则先执行 `if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then git fetch --unshallow; fi`，再全历史扫描。
   - **`build-binary*` & `scripts/build-binary.ts`（修订 P1-1）**：
     - 3 个 `build-binary*` job 条件改为 `if: ${{ !cancelled() && inputs.run_e2e }}`；`Install current opencode` 加 `if: runner.os != 'Windows'`。
     - `scripts/build-binary.ts` 不并发两个同进程 `Bun.build({ compile })`（避免共享 `process.cwd()` 写 `.bun-build` 冲突与双倍 200 MB 内存峰值）：改为阶段 1 并行 `Promise.all([buildFrontend(), buildManagedProcessLauncherSource(), buildGitCredentialHelperSource()])`；阶段 2 并行 `[buildDaemonBinary(prod), spawn(stub in isolated tmpCwd1)]`；阶段 3 并行 `[buildDaemonBinary(e2e), spawn(systemMockTool in isolated tmpCwd2)]`；阶段 4 并行执行 4 个 `--version` smoke 校验。
   - **`e2e*`**：条件改为 `if: ${{ !cancelled() && inputs.run_e2e && needs.<build>.result == 'success' }}`；`e2e`（Ubuntu 3 片 × 4 worker，`--tier=pr-full`），`e2e-macos`（macOS 2 片 × 3 worker，`--tier=os-core`），`e2e-windows`（Windows 2 片 × 4 worker，`--tier=os-core`，保留 `AW_E2E_WINDOWS_EXCLUDE`）。
4. **`windows-platform.yml`**：在 `push.paths` 与 `pull_request.paths` 同步加入 `'e2e/harness.ts'` 与 `'packages/frontend/tests/e2e-harness.test.ts'`，并在测试步骤中执行 `bun run --filter @agent-workflow/frontend test -- tests/e2e-harness.test.ts`。

---

## 5. 关键边界与风险防护

1. **PG `TEMPLATE` 并发冲突 (`55006`) 与模板失效 (`3D000`)**：有界 6 次退避重试，仍冲突或模板缺失自动退回常规建库，零偶发红灯；`bootstrap: 'required'` 隔离与非模板路径完全一致。
2. **跨包前端契约清单防漂移**：`rfc629-ci-optimization-invariants.test.ts` 用 AST 精确检测所有相对/别名/repo 越界引用，漏登记直接失败。
3. **`OS_CORE_E2E_SPECS` 与 `plan.tier` 防漂移**：`filterE2EDiscoveryByTier` 要求全部 19 个 spec 实际被发现；`refresh-e2e-timings.ts` 严格核对 `plan.tier` 与精确文件集合，缺 `--merge-base` 拒绝部分更新。
4. **共享语料守卫防空转**：`rfc624-migration-reference-guard.test.ts` 与 `rfc629-shared-program-guards.test.ts` 均强制 `minCorpusFiles` 与空语料/伪造违规负夹具，并在 `architecture/guard-manifest.json` 同步登记。
5. **既有守卫同步清单（修订 P1-11、R2 P1-5）**：
   - `root-test-entrypoint.test.ts`：移除已删 `ci-feedback.yml` 读取；校验 `lint` 全部 3 个质量缓存（`prettier` + `eslint` + `tsc`）及并发脚本对 `format:check`/`lint`/`typecheck` 的每 PID 显式 `wait` 退出码检查；更新 `test-frontend`（Ubuntu-only + 动态 `matrix.shard`）、`e2e-macos`/`e2e-windows`（2 片）、`build-binary*`/`e2e*`（`inputs.run_e2e`）、`ci-required`（正交 `RUN_E2E`）与 `ci-timings.yml` 三来源校验；
   - `rfc615-ci-calculation-admission.test.ts`：兼容 `test-frontend.strategy.matrix.shard` 动态表达式（不把表达式字符串 `.length` 误当分片数），更新计算作业数断言；
   - `rfc627-backend-shard-planner.test.ts`（第 102–118 行）：改为校验 `ci-work.yml:test-backend-postgresql` 调用 `scripts/ci/run-postgresql-gate.ts` 且该脚本直接从 `scripts/ci/backend-shards.ts` 导入 `TEST_BACKEND_POSTGRESQL_FILES` 作为单点权威；
   - 其余同步更新：`architecture/rfc319-ci-topology.test.ts`、`ci-e2e-shards.test.ts`、`ci-e2e-timing-refresh.test.ts`、`ci-backend-timing-refresh.test.ts`、`rfc627-ci-change-classification.test.ts`、`rfc624-test-execution-contracts.test.ts`、`rfc349-functional-evidence.test.ts`、`architecture/e2e-capability-ledger.json`（`rfc319-capability-ledger.test.ts`）与 `architecture/guard-manifest.json`，全部不放宽任何 fail-closed 判据。

---

## 6. 设计门审查与修订记录

### 第三轮（2026-11-28，只读 subagent，只审功能）：`PASS WITH FINDINGS`（0 P0 / 2 P1 / 3 P2）

全部 5 项 findings 已采纳并直接融入实现（设计门收口通过）：
- **R3-P1-1**：`ci-work.yml` 声明 `run_frontend_full` 与 `run_e2e` 为 `type: boolean, required: false, default: true`；`ci.yml:full-ci.with` 使用 fail-closed 布尔转换 `${{ needs['detect-changes'].outputs.run_frontend_full != 'false' }}` 与 `${{ needs['detect-changes'].outputs.run_e2e != 'false' }}`。
- **R3-P1-2**：`rfc624MigrationSpecifiers.ts` 与 `MigrationReferenceRule` 在同一 `ts.createSourceFile` 遍历中新增可选 `oldPrefixes?: readonly string[]`（覆盖 RFC-590 的 `modules/task-catalog/public/`）与 `forbiddenNamedImports`（覆盖 RFC-622 的 `modules/source-control/composition/repositoryCandidate` 禁导符号），并配正反负夹具。
- **R3-P2-1**：`installMockRuntime` 的 `build(destination)` 在临时目录编译至带平台后缀文件名（Windows 含 `.exe`）后再 `rename` 到 `destination`，消除 Windows 自动加 `.exe` 导致 `lstat(artifact)` 失败。
- **R3-P2-2**：`refresh-e2e-timings.ts` 对 `3/2/2` 与 `0/3/4` 均强制要求 `--merge-base`（缺失即 fail-closed 报错）；`ci-timings.yml` 按每行一个 `conclusion` 聚合分页结果，避免多页 `--paginate --jq` 输出多个计数。
- **R3-P2-3**：`eachProvider.ts:registerPostgresql` 内联汇总多库 `drop()` 错误（确保主库与全部附库均尝试释放），零新增模块级自由变量。

### 第二轮（2026-11-28，只读 subagent，只审功能）：`FAIL`（4 P0 / 5 P1 / 3 P2）

全部 12 项 findings 均已逐条核对源码并全部采纳修订：

| 编号 | 级别 | 问题描述 | 处置位置 |
| --- | --- | --- | --- |
| R2-P0-1 | P0 | `eachProvider.ts` 在覆写 `process.env[urlEnv]` 后复用给 `index>=1` 会导致 URL 污染与多库泄露；模板库缺 `generationId: GENERATION_ID`；`options.now` 字段不存在；`pg_terminate_backend` 需轮询归零；`seeds` 需 per-DB 深拷贝 | §2.3 #1、#3 捕获覆写前 `baseUrl`、收集并清理 `additionalFileDatabases`、模板库使用 `GENERATION_ID`、轮询 `pg_stat_activity` 归零、深拷贝 `seeds`、移除无效 `options.now` |
| R2-P0-2 | P0 | `TEST_BACKEND_POSTGRESQL_FILES` 中 3 个文件直连默认库原地 `DROP SCHEMA CASCADE`，3-worker 共用同一库会必然竞态失败 | §4.3 `run-postgresql-gate.ts` 为每个 worker 槽位建临时库 `aw_pg_gate_${pid}_${slot}` 并重写 URL 环境变量；§2.3 #2 模板键去 `pathname` 供 3 worker 共享单模板 |
| R2-P0-3 | P0 | `ci-timings.yml` 查询 `.name == "e2e"` 在 `Full CI / ...` 前缀下零命中；历史 pre-RFC-629 `CI` run 不认 `--merge-base`；`workflow-source.ts` 与 `refresh-e2e-timings.ts` 缺 `e2e-cross-os-nightly` + `3/2/2` 接线 | §4.2 #3、#4 改用 `^Full CI / ...` 匹配 ≥6 作业全 `skipped`；条件传 `--merge-base` 兼容历史；补齐 `resolveCrossOsNightlyE2ESource` 与 `CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES` |
| R2-P0-4 | P0 | `rfc374` 在 `shared + frontend` 上依赖 `ts.TypeChecker`（并含 R4），不能退化为无 checker 的 `ts.createSourceFile` | §3.1 #3 将 `packages/shared/src/**/*.ts` 并入后端 `ts.Program`、另建独立 `frontendProgram`（`packages/frontend/tsconfig.json`），完整运行 R1–R4，由 `rfc395-d4` 复用两者 `SourceFile` |
| R2-P1-1 | P1 | `rfc311-perf-guards.test.ts` 的 `test.each` 在 `describeEachProvider` 的 `beforeEach` 间会被清库，无法跨 `test.each` 共享种子 | §2.5 #3 将 6 条只读 `list` 合并为 1 个 `test()` 共享 `SMALL`/`LARGE`，保留 2 条 `sweep` 独立 `test()`、顶层 `GUARDED` 与 `MEASURED` |
| R2-P1-2 | P1 | RFC-617..622 扫含仓根 `tests/` 的 5 根，原 `rfc624` 仅 4 根；保留二次 `walk` 的文件不能把 `guard-manifest.json` 置 `corpusScanner: false` | §3.1 #1 扩为 5 根（加仓根 `tests/`），仅对迁出全部 `walk` 的文件置 `corpusScanner: false` |
| R2-P1-3 | P1 | `runSchemaHistoryCommand` 默认 `metaTables = HISTORY_META_TABLES` 会破坏直接检查 live epoch-2 目录的调用方 | §2.1 #5 默认 `metaTables = undefined`，由 `scripts/schema-history.ts` 显式传 `EPOCH2_META_TABLES` / `HISTORY_META_TABLES` |
| R2-P1-4 | P1 | 前端测试也存在于 `packages/frontend/src/**/__tests__/*.test.*` 且可能经本地 helper 跨包读取 | §4.1 #1 扫描 `tests/` + `src/**/*.test.*` 并沿相对/`@/` 导入递归追踪本地 helper |
| R2-P1-5 | P1 | 明确列出 `rfc627-backend-shard-planner.test.ts:102-118`、`root-test-entrypoint.test.ts` 并行 `lint` 退出码/`build-binary*` `if:` 与 `rfc615` 动态矩阵兼容方案 | §5 #5 与 `plan.md` T7 逐项明文落定 |
| R2-P2-1 | P2 | `resolveUnit` 双索引须按最小原下标优先；`sensitiveIdentityName` 不得缓存因环路 `seen` 提前返回的 `undefined` | §2.5 #1 补齐最小 `index` 仲裁与环路非缓存约束 |
| R2-P2-2 | P2 | `intent-builder` 已共享 daemon；`identity-access` IAM-30 需防 admin 残留；`rfc396` 拆分需隔离 `RFC396_E2E_HOME` | §3.3 全部对齐修订 |
| R2-P2-3 | P2 | `isValidBackendTestPath` 为 `.ts$`；`proposal.md` 降级措辞对齐；`plan.md` 补 `executionContractFixtureAdapter.ts` 与 `workflow-source.ts`；`scans` 用 `fetch-depth: 205` 与 `count > 0` | `proposal.md` §4、§4.1 #2、§4.3 #3 与 `plan.md` T2/T5 全部对齐 |

### 第一轮（2026-11-28，只读 subagent，只审功能）：`FAIL`（7 P0 / 12 P1 / 4 P2）

全部 23 项 findings 经逐条核对源码均属实并已全部采纳修订：

| 编号 | 级别 | 问题描述 | 处置位置 |
| --- | --- | --- | --- |
| P0-1 | P0 | `ci-work.yml:test-frontend` 在 job 级 `if:` 引用 `matrix.shard` 违反 GitHub Actions / `actionlint` 规则 | §4.3 改为动态 `strategy.matrix.shard: ${{ fromJSON(inputs.run_frontend_full && '[1, 2, 3]' || '[1]') }}` |
| P0-2 | P0 | `readSchemaHistoryFiles` 跳过多 catalog 会导致 `scripts/schema-history.ts --check` 漏检全部 60 个 PG catalog | §2.1 #5 在 `runSchemaHistoryCommand --check` 显式逐版本调用 `readHistoryPostgresqlCatalogs` 校验全部 catalog 并传入 `metaTables` |
| P0-3 | P0 | `new URL('postgresql://...').origin` 恒为 `"null"`；SQLite/PG 缓存键遗漏 `contract.digest`、双计划 digest、完整 `metaDigest` 与 `Bun.revision` | §2.2 #3、§2.3 #2 改用完整 URL 组件 + 全部 artifact/plan/`metaDigest` + `Bun.version`/`Bun.revision` |
| P0-4 | P0 | `rfc400` 仅传 `collaboration/public/*` + `task-execution/public/*` 会漏检其余全部模块与 `probe/public/*` 负夹具 | §3.1 #2 改为传全部 `/^packages\/backend\/src\/modules\/[^/]+\/public\//` 单元作为 `createProgram` 根 |
| P0-5 | P0 | `rfc294Gates` 按 `${unit.path}\0${name}` 缓存 `sensitiveIdentityName` 会漏检 `Promise<OwnedTaskTx>` 泛型参数；`resolveUnit` 丢后缀回退 | §2.5 #1 禁止按外层名缓存 `sensitiveIdentityName`，仅缓存符号解析与声明体，始终遍历 `typeArguments`；`resolveUnit` 保留精确+后缀双索引 |
| P0-6 | P0 | `isBackendTestOnlyPath` 用 `packages/backend/tests/` 前缀会漏跑被 `e2e/` 导入的 `helpers/`、`fixtures/`、`migration-freeze.ts` | §4.1 #2 严格收窄为匹配 `BACKEND_TEST_PATH_PATTERN` 的测试文件，并补 `e2e/` 不引 `*.test.*` 守卫 |
| P0-7 | P0 | `eachProvider.ts` 改动破坏 `rfc359-w31`/`w39` 的 `new Function` 自由变量与同步 `resetPostgresqlGenerationWriteCache`，且在模板创建处调 `registerLegacyDaemonTestFixture` 泄露至 `bootstrap: 'required'` | §2.2 #4、§2.3 #3 保持 `registerPostgresql` 签名与 `beforeEach` 登记边界不变，模板克隆归位 `createPostgresqlFileDatabase` 且限 `options.now === undefined`，避免新增 `*_TIMEOUT_MS` 常量 |
| P1-1 | P1 | `build-binary.ts` 同进程并行两个 `Bun.build({ compile })` 共享 `cwd` 且双倍内存峰值 | §4.3 改为 `[prod, stub(tmpCwd1)]` 与 `[e2e, mockTool(tmpCwd2)]` 分阶段并行，并重叠前端与辅助源编译 |
| P1-2 | P1 | `e2e-cross-os-nightly.yml` 的 `e2e-windows-full` 漏传 `AW_E2E_WINDOWS_EXCLUDE` | §4.2 #2 显式补齐并合入单条 `--grep-invert` |
| P1-3 | P1 | 拆分 `e2e/rfc396-graph-development.spec.ts` 需同步 `architecture/e2e-capability-ledger.json` 且注意第 793 行原地重启 daemon | §3.3 抽 helper、独立生命周期并同步更新 `e2e-capability-ledger.json` |
| P1-4 | P1 | `ci-timings.yml` 仅凭 `e2e_count == 0` 进 `core-only-ci` 会掩盖 E2E 上传全失败 | §4.2 #4 先查 `jobs` API，仅 `e2e` 结论为 `skipped` 才允许 `core-only-ci` |
| P1-5 | P1 | `compose-backend-timings.ts` 遗漏 `16 → 12` 历史兼容 | §4.3 与 `plan.md` T5 纳入 `compose-backend-timings.ts` 同步兼容 `12` 与历史 `16` |
| P1-6 | P1 | `mode=full && run_e2e=false`（仅改迁移测试）与 `workflow_dispatch` 行为需明文锁定 | §4.1 #2、§4.3 #2 明确正交语义并补单测 |
| P1-7 | P1 | `rfc629-ci-optimization-invariants.test.ts` 命中 `guard-manifest.json` 命名模式；纯文本匹配遗漏相对路径与 `@/util/hash` 且易误报 | §4.1 #1 正式登记 `guard-manifest.json` 并改用 AST 精确检测导入与 `fs`/`path` 越界路径 |
| P1-8 | P1 | `rfc374` 含前端 `.tsx` 与其他 4 个纯后端 `ts.Program` 不可混入同一 `Program`；`scheduler-audit-s10` 行为测试与 `rfc374` 账本项须保留 | §3.1 #3 改为严格隔离的纯后端 `ts.Program` + 独立多包 AST 语料，保留原文件行为测试与精确 `guard-manifest.json` 变更 |
| P1-9 | P1 | `describeEachProvider` 的 `beforeEach` 使 `rfc311-task-page-filtered-fastpath` 跨 `test()` 无法共享库；`rfc311-perf-guards` 已有分块插表 | §2.5 #3 改将过滤矩阵合并为单 `test()` + 批量 `insertForest`；`rfc311-perf-guards` 改为 6 条只读 `list` 路径共享 `SMALL`/`LARGE` 种子 |
| P1-10 | P1 | `refresh-e2e-timings.ts` 合并刷新需校验 `plan.tier` 与精确 `OS_CORE_E2E_SPECS` 集合 | §4.2 #3 强制校验 `plan.tier` 与精确文件集合 |
| P1-11 | P1 | `plan.md` 遗漏 `rfc624-test-execution-contracts.test.ts`、`rfc349-functional-evidence.test.ts` 与 `e2e-capability-ledger.json` 等守卫同步点 | §5 #5 与 `plan.md` T4/T7 全部补齐 |
| P1-12 | P1 | 非浅克隆下 `git fetch --unshallow` 报 128；`tsc` 缓存键未定稿 | §4.3 #3 改先检 `git rev-parse --is-shallow-repository` 与 `rev-list --count`，并明确完整 `tsc-v1-...` 缓存键 |
| P2-1 | P2 | `e2e/rfc250-interaction-integrity.spec.ts` 用例 6 改全局语言 `zh-CN` | §3.3 在 `finally` 恢复 `en-US` |
| P2-2 | P2 | `cli/stop.ts` 已支持 `timeoutMs`，补齐 `main.ts` `--timeout` 非法参数拒绝 | §2.5 #3 明文约束非法参数校验与单测 |
| P2-3 | P2 | `userFixture.ts` 复用 `passwords.ts` 共享 `HASH_OPTS` 与完整上下界校验 | §2.5 #2 明文采用共享 `HASH_OPTS` |
| P2-4 | P2 | `rfc254-stub-differential.test.ts` 录制模式 `UPDATE_STUB_GOLDENS=1` 须保持串行 | §2.5 #3 明确仅非录制模式并行 |
