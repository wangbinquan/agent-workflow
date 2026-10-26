import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
import { statSync } from 'node:fs'
import {
  withNativeTransaction,
  nativeTransactionHandle,
} from '@/platform/persistence/nativeTransaction'
import { postgresqlHistoryConnection, sqliteHistoryConnection } from './schema/history/connection'
import { Database } from 'bun:sqlite'
import { sqliteGenerationLayout } from './sqliteGenerationDirectory'
import { unpublishedSqliteInstallation } from './unpublishedInstallation'
import { maybePreMigrationBackup } from '@/platform/background/providerBackupScheduler'
import { PostgresqlDatabaseConfigSchema, SqliteDatabaseConfigSchema } from '@agent-workflow/shared'
// RFC-349 — bootstrap/operations resolver for the verified live database
// generation. The durable pointer is authoritative; config only supplies the
// selected provider's mechanism settings and may never silently override it.

import { unhandledDatabaseProvider, type DatabaseProvider } from './databaseProviders'
import type { DatabaseConfig, DatabaseRuntimeTelemetry } from '@agent-workflow/shared'
import { DbCorruptionError, openDb, type DbClient, type OpenDbOptions } from '@/db/client'
import { quickCheckDbFile } from '@/db/integrity'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createPostgresqlDatabaseOperationalAdapter,
  createSqliteDatabaseOperationalAdapter,
  type DatabaseOperationalAdapter,
} from './databaseOperationalAdapter'
import {
  readDatabaseGenerationFromArtifacts,
  type DatabaseGenerationArtifactReader,
  type ResolvedDatabaseGeneration,
  type DatabaseGenerationBootstrapCandidate,
} from './generationValidation'
import {
  createPostgresqlDatabaseRuntime,
  type InstrumentedPostgresqlDatabaseRuntime,
  type PostgresqlPoolOptions,
  type PostgresqlPool,
  type PostgresqlTransactionConnection,
} from './postgresqlRuntime'
import {
  createPostgresqlDatabaseClient,
  type PostgresqlDatabaseClient,
} from './postgresqlDatabaseClient'
import type { LogicalSchemaContract } from './schemaContract'
import type { PostgresqlMigrationHistory } from './postgresqlMigrationSequence'
import { existsSync } from 'node:fs'
import { canonicalSchemaJson, digestSchemaContract } from './schema/canonical'
import { dirname, join, relative, resolve } from 'node:path'
import {
  readGenerationPointerV2,
  writeGenerationPointerV2,
  type GenerationPointerV2,
} from './generationPointerV2'
import { schemaHistoryRuntime, runtimeHistoryAdmission } from './schema/history/runtime'
import {
  installHistoryHead,
  applyHistoryVersion,
  readSchemaHistoryRows,
} from './schema/history/apply'
import { admitHistory } from './schema/history/admission'
import { metaTableName } from './schema/history/meta'

export interface Epoch2ProviderReceipt {
  readonly baselineId: '0000_rfc395_epoch2'
  readonly contractDigest: string
  readonly planDigest: string
  readonly applied: boolean
  readonly activeTableCount: number
  readonly successorContractDigest?: string
  readonly installedSeeds?: { readonly rows: number; readonly tables: number }
}
function operationalGeneration(
  pointer: GenerationPointerV2,
  logicalDigest: string,
): ResolvedDatabaseGeneration {
  const p = pointer.payload
  return {
    source: 'epoch2-pointer',
    pointer,
    payload: {
      version: 1,
      generationId: p.generationId,
      provider: p.provider,
      operationId: p.operationId,
      schemaDigest: logicalDigest,
      manifestDigest: p.manifestDigest,
      activatedAt: p.activatedAt,
    },
  }
}
export function pointerConfiguration(
  config: DatabaseConfig,
  pointer: GenerationPointerV2,
): DatabaseConfig {
  const location = pointer.payload.database
  if (location.kind === 'sqlite-file')
    return (
      SqliteDatabaseConfigSchema.safeParse(config).data ??
      SqliteDatabaseConfigSchema.parse({ provider: 'sqlite' })
    )
  if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(location.profileRef))
    throw new Error('epoch2-postgresql-profile-must-reference-env')
  return PostgresqlDatabaseConfigSchema.parse({
    ...(PostgresqlDatabaseConfigSchema.safeParse(config).data ?? {}),
    provider: 'postgresql',
    urlEnv: location.profileRef.slice(4),
  })
}
function pointerSqlitePath(
  options: ResolveDatabaseProviderRuntimeOptions,
  pointer: GenerationPointerV2,
): string {
  return pointer.payload.database.kind === 'sqlite-file'
    ? resolve(dirname(options.generationPointerPath), pointer.payload.database.relativePath)
    : options.sqlitePath
}

export class DatabaseProviderRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'database-provider-config-generation-mismatch'
      | 'database-provider-local-path-missing',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseProviderRuntimeError'
  }
}

export type ResolvedDatabaseProviderRuntime =
  | Readonly<{
      provider: 'sqlite'
      readonly sqlitePath: string
      generation: ResolvedDatabaseGeneration
      operations: DatabaseOperationalAdapter
      telemetry(): DatabaseRuntimeTelemetry
      /** Bootstrap-only mechanism factory; application/transport never receives this handle. */
      openClient(input: Omit<OpenDbOptions, 'path'>): DbClient
      close(): Promise<void>
    }>
  | Readonly<{
      provider: 'postgresql'
      generation: ResolvedDatabaseGeneration
      runtime: InstrumentedPostgresqlDatabaseRuntime
      operations: DatabaseOperationalAdapter
      telemetry(): DatabaseRuntimeTelemetry
      /** Bootstrap-only mechanism factory; application/transport never receives this handle. */
      openClient(): PostgresqlDatabaseClient
      close(): Promise<void>
    }>

export interface ResolveDatabaseProviderRuntimeOptions {
  readonly config: DatabaseConfig
  readonly sqlitePath: string
  readonly generationPointerPath: string
  readonly operationsRoot: string
  readonly contract: LogicalSchemaContract
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Infrastructure test seam; production uses Bun.SQL. */
  readonly postgresqlPoolFactory?: (options: PostgresqlPoolOptions) => PostgresqlPool
}

/** The host loads generation artifacts before entering this synchronous
 * mechanism boundary. External providers need no local installation paths. */
export interface ResolveDatabaseProviderRuntimeFromArtifactsOptions extends Omit<
  ResolveDatabaseProviderRuntimeOptions,
  'generationPointerPath' | 'operationsRoot' | 'sqlitePath'
> {
  readonly generationArtifacts: DatabaseGenerationArtifactReader
  readonly sqlitePath?: string
}

export function resolveDatabaseProviderSelection(options: {
  readonly config: DatabaseConfig
  readonly generationPointerPath: string
  readonly operationsRoot: string
  readonly contract: LogicalSchemaContract
}): ResolvedDatabaseGeneration {
  const pointer = readGenerationPointerV2(options.generationPointerPath)
  pointerConfiguration(options.config, pointer)
  return operationalGeneration(pointer, options.contract.digest)
}

function selectDatabaseProviderGeneration(options: {
  readonly config: DatabaseConfig
  readonly contract: LogicalSchemaContract
  readonly generationArtifacts: DatabaseGenerationArtifactReader
}): ResolvedDatabaseGeneration {
  const generation = readDatabaseGenerationFromArtifacts(options.generationArtifacts, {
    expectedSchemaDigest: options.contract.digest,
  })
  if (generation.payload.provider !== options.config.provider) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      `database provider config is ${options.config.provider} but the verified live generation is ${generation.payload.provider}`,
    )
  }
  return generation
}

export type SqliteDatabaseProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'sqlite' }
>
export type PostgresqlDatabaseProviderRuntime = Extract<
  ResolvedDatabaseProviderRuntime,
  { readonly provider: 'postgresql' }
>

/**
 * RFC-359 W3-T16 —— 按 provider 收窄已解析的运行时。provider 字面量比较只许出现在
 * `platform/persistence/`（design §7 守卫 2）；bootstrap 拿到 union 后用这一处收窄，
 * 自己不再写 `provider === '…'` 分支。
 */
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: 'sqlite',
): SqliteDatabaseProviderRuntime
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: 'postgresql',
): PostgresqlDatabaseProviderRuntime
export function requireDatabaseProviderRuntime(
  runtime: ResolvedDatabaseProviderRuntime,
  provider: DatabaseProvider,
): ResolvedDatabaseProviderRuntime {
  if (runtime.provider !== provider) {
    throw new Error(
      `database-provider-runtime-mismatch: expected ${provider}, resolved ${runtime.provider}`,
    )
  }
  return runtime
}

/**
 * `requireDatabaseProviderRuntime` 的**配置孪生**：把 `DatabaseConfig` 这个按 provider 判别的
 * 联合收窄到已选中的那一支。
 *
 * RFC-359 AC-10：这段判定原本手写在 `cli/start.ts` 里（`requirePostgresqlConfig`，
 * `config.database.provider !== 'postgresql'` 就抛）。判定本身没问题——会话装配确实需要
 * 「运行时选了 PG，配置也必须是 PG 那一支」这条不变量——但它住错了地方：daemon 入口不该
 * 自己拼品牌比较，而紧挨着的 `requireDatabaseProviderRuntime` 早就把同一个形状做在了
 * 这一层。搬过来之后两条收窄用同一个名字家族、同一种错误文案，入口只剩调用。
 */
export function requireDatabaseConfig(
  config: DatabaseConfig,
  provider: 'sqlite',
): Extract<DatabaseConfig, { provider: 'sqlite' }>
export function requireDatabaseConfig(
  config: DatabaseConfig,
  provider: 'postgresql',
): Extract<DatabaseConfig, { provider: 'postgresql' }>
export function requireDatabaseConfig(
  config: DatabaseConfig,
  provider: DatabaseProvider,
): DatabaseConfig {
  if (config.provider !== provider) {
    throw new Error(
      `database-provider-config-mismatch: expected ${provider}, configured ${config.provider}`,
    )
  }
  return config
}

function composeSqliteProviderRuntime(
  options: { readonly sqlitePath?: string },
  generation: ResolvedDatabaseGeneration,
  initialClient: DbClient | null,
): SqliteDatabaseProviderRuntime {
  const path = options.sqlitePath
  if (path === undefined) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-local-path-missing',
      'the verified SQLite generation requires a local database path',
    )
  }
  let client = initialClient
  return Object.freeze({
    provider: 'sqlite' as const,
    sqlitePath: path,
    generation,
    operations: createSqliteDatabaseOperationalAdapter({
      path,
      generationId: generation.payload.generationId,
    }),
    telemetry: () => Object.freeze({ version: 1, provider: 'sqlite', poolWait: null }),
    openClient(input: Omit<OpenDbOptions, 'path'>) {
      return (client ??= openDb({ ...input, path, generationId: generation.payload.generationId }))
    },
    async close() {
      client?.$client.close()
      client = null
    },
  })
}

function composePostgresqlProviderRuntime(
  options: { readonly contract: LogicalSchemaContract },
  generation: ResolvedDatabaseGeneration,
  runtime: InstrumentedPostgresqlDatabaseRuntime,
): PostgresqlDatabaseProviderRuntime {
  let client: PostgresqlDatabaseClient | null = null
  return Object.freeze({
    provider: 'postgresql' as const,
    generation,
    runtime,
    operations: createPostgresqlDatabaseOperationalAdapter({ runtime, contract: options.contract }),
    telemetry: runtime.telemetry,
    openClient: () => (client ??= createPostgresqlDatabaseClient(runtime)),
    close: () => runtime.close(),
  })
}

type PreparedDatabaseProviderMechanism =
  | { readonly provider: 'sqlite'; readonly client: DbClient }
  | { readonly provider: 'postgresql'; readonly runtime: InstrumentedPostgresqlDatabaseRuntime }

/** Transfer an actually prepared mechanism only after the strict pointer read. */
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: Extract<PreparedDatabaseProviderMechanism, { readonly provider: 'sqlite' }>,
): SqliteDatabaseProviderRuntime
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: Extract<PreparedDatabaseProviderMechanism, { readonly provider: 'postgresql' }>,
): PostgresqlDatabaseProviderRuntime
export function adoptPreparedDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
  prepared: PreparedDatabaseProviderMechanism,
): ResolvedDatabaseProviderRuntime {
  const generation = resolveDatabaseProviderSelection(options)
  if (prepared.provider !== generation.payload.provider) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'prepared database mechanism differs from the verified generation',
    )
  }
  if (prepared.provider === 'sqlite') {
    return composeSqliteProviderRuntime(
      {
        sqlitePath:
          generation.source === 'epoch2-pointer'
            ? pointerSqlitePath(options, generation.pointer)
            : options.sqlitePath,
      },
      generation,
      prepared.client,
    )
  }
  if (prepared.runtime.generationId !== generation.payload.generationId) {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'prepared PostgreSQL runtime differs from the verified generation',
    )
  }
  return composePostgresqlProviderRuntime(options, generation, prepared.runtime)
}

export function resolveDatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions,
): ResolvedDatabaseProviderRuntime {
  const pointer = readGenerationPointerV2(options.generationPointerPath)
  const config = pointerConfiguration(options.config, pointer)
  const generation = operationalGeneration(pointer, options.contract.digest)
  return runtimeMechanisms[config.provider].resolve(
    { ...options, config },
    generation,
    pointerSqlitePath(options, pointer),
  )
}

// Exhaustive native mechanisms: callers share pointer, admission and restore policy.
// Adding a provider requires its location, unpublished-store and runtime answers here.
const runtimeMechanisms: Readonly<
  Record<
    DatabaseProvider,
    {
      resolve(
        options: ResolveDatabaseProviderRuntimeOptions,
        generation: ResolvedDatabaseGeneration,
        sqlitePath: string,
      ): ResolvedDatabaseProviderRuntime
      location(
        config: DatabaseConfig,
        sqlitePath: string,
        appHome: string,
      ): GenerationPointerV2['payload']['database']
      unpublished(appHome: string): ReturnType<typeof unpublishedSqliteInstallation>
      localPath(runtime: ResolvedDatabaseProviderRuntime, fallback: string): string
    }
  >
> = {
  sqlite: {
    resolve: (_options, generation, sqlitePath) =>
      composeSqliteProviderRuntime({ sqlitePath }, generation, null),
    location: (_config, path, appHome) => ({
      kind: 'sqlite-file',
      relativePath: relative(appHome, path),
    }),
    unpublished: unpublishedSqliteInstallation,
    localPath: (runtime) => requireDatabaseProviderRuntime(runtime, 'sqlite').sqlitePath,
  },
  postgresql: {
    resolve: (options, generation) =>
      composePostgresqlProviderRuntime(
        options,
        generation,
        createPostgresqlDatabaseRuntime({
          config: requireDatabaseConfig(options.config, 'postgresql'),
          generationId: generation.payload.generationId,
          env: options.env,
          poolFactory: options.postgresqlPoolFactory,
        }),
      ),
    location: (config) => ({
      kind: 'postgresql-target',
      profileRef: `env:${requireDatabaseConfig(config, 'postgresql').urlEnv}`,
    }),
    unpublished: () => null,
    localPath: (_runtime, fallback) => fallback,
  },
}

/** Restore planning in an empty home must not install an empty business database. */
export function resolveDatabaseProviderRuntimeForRestore(
  options: ResolveDatabaseProviderRuntimeOptions,
): ResolvedDatabaseProviderRuntime {
  if (existsSync(options.generationPointerPath)) return resolveDatabaseProviderRuntime(options)
  const head = schemaHistoryRuntime().head()
  const generationId = `dbg_${crypto.randomUUID()}`
  const appHome = dirname(options.generationPointerPath)
  const path = sqliteGenerationLayout(generationId, appHome).databasePath
  const mechanism = runtimeMechanisms[options.config.provider]
  const payload: GenerationPointerV2['payload'] = {
    version: 2,
    schemaEpoch: 2,
    generationId,
    provider: options.config.provider,
    role: 'installed',
    database: mechanism.location(options.config, path, appHome),
    contractDigest: head.contract.contract.digest,
    planDigest: head[options.config.provider].digest,
    operationId: null,
    manifestDigest: null,
    activatedAt: Date.now(),
    previous: null,
  }
  return mechanism.resolve(
    options,
    operationalGeneration(
      { payload, digest: digestSchemaContract(payload) },
      options.contract.digest,
    ),
    path,
  )
}

/** Resolve an already installed generation. Schema preparation still belongs
 * to the existing migration owner; this entry does not run migrations. */
export function resolveDatabaseProviderRuntimeFromArtifacts(
  options: ResolveDatabaseProviderRuntimeFromArtifactsOptions,
): ResolvedDatabaseProviderRuntime {
  const generation = selectDatabaseProviderGeneration(options)
  if (generation.payload.provider === 'sqlite') {
    return composeSqliteProviderRuntime(options, generation, null)
  }
  if (generation.payload.provider !== 'postgresql') {
    return unhandledDatabaseProvider(generation.payload.provider)
  }
  if (options.config.provider !== 'postgresql') {
    throw new DatabaseProviderRuntimeError(
      'database-provider-config-generation-mismatch',
      'verified PostgreSQL generation has no PostgreSQL runtime configuration',
    )
  }
  const runtime = createPostgresqlDatabaseRuntime({
    config: options.config,
    generationId: generation.payload.generationId,
    env: options.env,
    poolFactory: options.postgresqlPoolFactory,
  })
  return composePostgresqlProviderRuntime(options, generation, runtime)
}

interface PrepareDatabaseProviderRuntimeOptions extends ResolveDatabaseProviderRuntimeOptions {
  readonly candidate: DatabaseGenerationBootstrapCandidate
  readonly history: PostgresqlMigrationHistory
  readonly sqliteOptions: Omit<OpenDbOptions, 'path'>
  readonly beforeSqliteOpen?: () => void | Promise<void>
  readonly requireUpgradeLock: () => void | Promise<void>
  readonly advancePointer: () => void | Promise<void>
}

type PreparedDatabaseProviderSchema =
  | {
      readonly provider: 'sqlite'
      readonly runtime: SqliteDatabaseProviderRuntime
      readonly databaseConfig: DatabaseConfig
      readonly describeSchemaOutcome: () => string
      readonly openBootstrapClient: () => PersistenceDb
    }
  | {
      readonly provider: 'postgresql'
      readonly runtime: PostgresqlDatabaseProviderRuntime
      readonly databaseConfig: DatabaseConfig
      readonly receipt: Epoch2ProviderReceipt
      /**
       * RFC-359 AC-10 —— `db migrate` 要对用户说的那句话，**在这里就定下来**。
       *
       * 原来是 `cli/migrate.ts` 自己 `if (prepared.provider === 'postgresql')` 再分别拼：
       * PG 读 `receipt`、SQLite 报库文件路径。那是典型的「调用方按品牌再问一遍」——
       * 而这里是**品牌已经确定**的地方（本目录是白名单层），一次性把答案连同措辞定下来，
       * 调用方就只剩「拿来输出」。第三个 provider 必须在这里回答它的那句话，
       * 而不是静默继承 SQLite 的那句。
       */
      readonly describeSchemaOutcome: () => string
      /**
       * RFC-359 AC-10 —— bootstrap 要用的那个客户端，**也在品牌已知处交出来**。
       *
       * 原来是 `main.ts` 自己 `if (runtime.provider === 'postgresql') … else …`，两支的唯一
       * 差别是 `openClient` 的**入参个数**（SQLite 那支还要再 `await resolveMigrationsFolder()`
       * 一次——而 prepare 阶段早已用同一个值把库打开了，那次求值的结果**直接被丢弃**：
       * 已 adopt 的 SQLite runtime 里 `client` 非空，`openClient(input)` 根本不看 `input`）。
       * 由这里交出来之后，调用方连「哪个 provider 要传什么」都不必知道。
       */
      readonly openBootstrapClient: () => PersistenceDb
    }

export async function prepareEpoch2DatabaseProviderRuntime(
  options: ResolveDatabaseProviderRuntimeOptions & {
    readonly sqliteOptions: Omit<OpenDbOptions, 'path'>
    readonly backupOnMigration?: boolean
    readonly beforeSqliteOpen?: () => void | Promise<void>
    readonly requireUpgradeLock?: () => void | Promise<void>
  },
): Promise<PreparedDatabaseProviderSchema> {
  const binding = schemaHistoryRuntime()
  const head = binding.head()
  const existing = existsSync(options.generationPointerPath)
    ? readGenerationPointerV2(options.generationPointerPath)
    : null
  if (!existing) await options.requireUpgradeLock?.()
  const config = existing ? pointerConfiguration(options.config, existing) : options.config
  const appHome = dirname(options.generationPointerPath)
  const unpublished = !existing ? runtimeMechanisms[config.provider].unpublished(appHome) : null
  let generationId =
    existing?.payload.generationId ?? unpublished?.generationId ?? `dbg_${crypto.randomUUID()}`
  const sqlitePath = existing
    ? pointerSqlitePath(options, existing)
    : (unpublished?.path ?? sqliteGenerationLayout(generationId, appHome).databasePath)
  const now = Date.now()
  const publish = () =>
    existing ??
    writeGenerationPointerV2({
      pointerPath: options.generationPointerPath,
      payload: {
        version: 2,
        schemaEpoch: 2,
        generationId,
        provider: config.provider,
        role: 'installed',
        database: runtimeMechanisms[config.provider].location(config, sqlitePath, appHome),
        contractDigest: head.contract.contract.digest,
        planDigest: head[config.provider].digest,
        operationId: null,
        manifestDigest: null,
        activatedAt: now,
        previous: null,
      },
    })
  if (config.provider === 'sqlite') {
    const path = sqlitePath
    let integrityChecked = false
    const developmentIntegrity = options.sqliteOptions.developmentIntegrity
    const integrityIdentity = () => {
      const file = statSync(path)
      return JSON.stringify([
        resolve(path),
        file.dev,
        file.ino,
        file.birthtimeMs,
        head.contract.digest,
      ])
    }
    if (existsSync(path)) {
      if (!options.sqliteOptions.skipIntegrityCheck) {
        const reused = developmentIntegrity?.validatedDatabase === integrityIdentity()
        const started = Date.now()
        if (developmentIntegrity)
          console.info(
            reused
              ? '[dev] reusing database integrity check for source reload'
              : '[dev] checking database integrity before startup (PRAGMA quick_check)',
          )
        const integrity = reused ? { ok: true, errors: [] } : quickCheckDbFile(path)
        if (!integrity.ok) {
          if (developmentIntegrity) developmentIntegrity.validatedDatabase = undefined
          await maybePreMigrationBackup({
            appHome,
            dbPath: path,
            enabled: options.backupOnMigration !== false,
            recordedVersion: null,
          })
          throw new DbCorruptionError(path, integrity.errors)
        }
        if (developmentIntegrity && !reused)
          console.info(`[dev] startup database quick_check completed in ${Date.now() - started}ms`)
        integrityChecked = true
      }
      const reader = new Database(path, { readonly: true })
      let installed: number
      try {
        installed =
          (await readSchemaHistoryRows(sqliteHistoryConnection(reader))).at(-1)?.version ?? -1
      } finally {
        reader.close()
      }
      const pending = (binding.history?.() ?? [head]).filter(
        (version) => version.contract.version > installed,
      )
      if (pending.length) await options.requireUpgradeLock?.()
      // Epoch-1 order: the hook follows the upgrade lock and precedes every write open.
      await options.beforeSqliteOpen?.()
      await maybePreMigrationBackup({
        appHome,
        dbPath: path,
        enabled: options.backupOnMigration !== false,
        recordedVersion: installed,
      })
      if (pending.length) {
        const database = new Database(path)
        try {
          for (const version of pending)
            await applyHistoryVersion(sqliteHistorySession(database), {
              version,
              metaTables: binding.metaTables,
            })
        } finally {
          database.close()
        }
      }
    } else await options.beforeSqliteOpen?.()
    const client = openDb({
      ...options.sqliteOptions,
      path,
      generationId,
      skipIntegrityCheck: integrityChecked || options.sqliteOptions.skipIntegrityCheck,
    })
    try {
      if (developmentIntegrity && integrityChecked)
        developmentIntegrity.validatedDatabase = integrityIdentity()
      const generation = operationalGeneration(publish(), options.contract.digest)
      const runtime = composeSqliteProviderRuntime({ sqlitePath: path }, generation, client)
      return {
        provider: 'sqlite',
        runtime,
        databaseConfig: config,
        describeSchemaOutcome: () => `migrations applied (database: ${path})\n`,
        openBootstrapClient: () => client,
      }
    } catch (error) {
      client.$client.close()
      throw error
    }
  }
  let runtime = createPostgresqlDatabaseRuntime({
    config,
    generationId,
    env: options.env,
    poolFactory: options.postgresqlPoolFactory,
  })
  try {
    const receipt = await preparePostgresqlEpoch2(
      runtime,
      generationId,
      'apply',
      existing ? 'pointer' : 'unpublished',
      options.requireUpgradeLock,
    )
    generationId = receipt.generationId
    runtime = selectedPostgresqlRuntime(runtime, generationId)
    const adopted = composePostgresqlProviderRuntime(
      options,
      operationalGeneration(publish(), options.contract.digest),
      runtime,
    )
    return {
      provider: 'postgresql',
      runtime: adopted,
      databaseConfig: config,
      receipt,
      describeSchemaOutcome: () => describePostgresqlSchemaOutcome(receipt, generationId),
      openBootstrapClient: () => adopted.openClient(),
    }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

export async function prepareDatabaseProviderRuntime(
  options: PrepareDatabaseProviderRuntimeOptions,
): Promise<PreparedDatabaseProviderSchema> {
  return await prepareEpoch2DatabaseProviderRuntime(options)
}
export type PreparedPostgresqlProviderSchema = Extract<
  PreparedDatabaseProviderSchema,
  { readonly provider: 'postgresql' }
>

async function preparePostgresqlEpoch2(
  runtime: InstrumentedPostgresqlDatabaseRuntime,
  generationId: string,
  mode: 'apply' | 'verify',
  selection: 'pointer' | 'unpublished' | 'hosted',
  requireUpgradeLock?: () => void | Promise<void>,
  hosted?: Extract<ResolvedDatabaseGeneration, { source: 'hosted-installation' }>,
): Promise<Epoch2ProviderReceipt & { readonly generationId: string }> {
  const binding = schemaHistoryRuntime()
  const head = binding.head()
  const pool = runtime.providerPool()
  const present = await pool.unsafe(
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('agent_workflow', 'agent_workflow_meta') AND table_type = 'BASE TABLE'",
  )
  const fresh = present.length === 0
  let applied = fresh
  if (fresh && mode === 'apply') {
    await requireUpgradeLock?.()
    // Install the identity receipt in the same transaction as the fresh head.
    const installationPool: Pick<PostgresqlPool, 'reserve'> = hosted
      ? {
          async reserve() {
            const connection = await pool.reserve()
            return {
              unsafe: (sql, values) => connection.unsafe(sql, values),
              release: () => connection.release(),
              begin: (body) =>
                withNativeTransaction(postgresqlHistoryConnection(connection), async () => {
                  const tx = nativeTransactionHandle(connection)
                  const result = await body(tx)
                  await recordHostedIdentity(tx, generationId, hosted)
                  return result
                }),
            }
          },
        }
      : pool
    await installHistoryHead(postgresqlHistorySession(installationPool), {
      version: head,
      metaTables: binding.metaTables,
      generationId,
      installPath: selection === 'hosted' ? 'hosted-installation' : 'new-install',
    })
  } else if (
    !present.some(
      (row) => row.table_schema === 'agent_workflow_meta' && row.table_name === 'schema_history',
    )
  ) {
    throw new Error(
      'epoch-1 or uninstalled database: run db migration plan / migrate-for-deployment before starting the daemon',
    )
  }
  if (hosted) await assertHostedIdentity(pool, hosted, mode === 'apply')
  if (!fresh && mode === 'apply') {
    const connection = await pool.reserve()
    let installed: number
    try {
      installed =
        (await readSchemaHistoryRows(postgresqlHistoryConnection(connection))).at(-1)?.version ?? -1
    } finally {
      connection.release()
    }
    for (const version of binding.history?.() ?? [head]) {
      if (version.contract.version > installed) {
        await requireUpgradeLock?.()
        applied =
          (await applyHistoryVersion(postgresqlHistorySession(pool), {
            version,
            metaTables: binding.metaTables,
          })) || applied
      }
    }
  }
  const admitted = await admitHistory(postgresqlHistorySession(pool), runtimeHistoryAdmission())
  const active = await pool.unsafe(
    `SELECT g.generation_id, g.role, g.operation_id, w.generation_id AS marker, w.first_live_write_at FROM ${metaTableName('postgresql', 'generations')} g LEFT JOIN ${metaTableName('postgresql', 'first_write')} w ON w.generation_id = g.generation_id WHERE g.state = 'active'`,
  )
  if (active.length !== 1 || (selection === 'pointer' && active[0]?.generation_id !== generationId))
    throw new Error('epoch2-active-generation-mismatch')
  const selected = active[0]!
  if (
    selection === 'unpublished' &&
    (selected.role !== 'installed' ||
      selected.operation_id !== null ||
      selected.marker == null ||
      selected.first_live_write_at !== null)
  )
    throw new Error('epoch2-unpublished-installation-not-adoptable')
  const seedRows = head.contract.contract.contributions.flatMap(
    (entry) => entry.seeds?.flatMap((seed) => seed.rows.map(() => seed.table)) ?? [],
  )
  return {
    generationId: String(selected.generation_id),
    baselineId: '0000_rfc395_epoch2',
    contractDigest: admitted.contract.contract.digest,
    planDigest: admitted.postgresql.digest,
    applied,
    activeTableCount: admitted.contract.contract.tables.length,
    ...(admitted.contract.version > head.contract.version
      ? { successorContractDigest: admitted.contract.contract.digest }
      : {}),
    ...(fresh ? { installedSeeds: { rows: seedRows.length, tables: new Set(seedRows).size } } : {}),
  }
}

export async function prepareHostedPostgresqlProviderRuntime(input: {
  readonly config: DatabaseConfig
  readonly contract: LogicalSchemaContract
  readonly generation: ResolvedDatabaseGeneration
  readonly history?: PostgresqlMigrationHistory
  readonly schema: 'apply' | 'verify'
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly postgresqlPoolFactory?: (options: PostgresqlPoolOptions) => PostgresqlPool
}): Promise<PreparedPostgresqlProviderSchema> {
  if (
    input.config.provider !== 'postgresql' ||
    input.generation.payload.provider !== 'postgresql' ||
    input.generation.source !== 'hosted-installation'
  )
    throw new Error('hosted-provider-must-be-postgresql')
  let runtime = createPostgresqlDatabaseRuntime({
    config: input.config,
    generationId: input.generation.payload.generationId,
    env: input.env,
    poolFactory: input.postgresqlPoolFactory,
  })
  try {
    const receipt = await preparePostgresqlEpoch2(
      runtime,
      input.generation.payload.generationId,
      input.schema,
      'hosted',
      undefined,
      input.generation,
    )
    runtime = selectedPostgresqlRuntime(runtime, receipt.generationId)
    const generation: ResolvedDatabaseGeneration = {
      ...input.generation,
      payload: { ...input.generation.payload, generationId: receipt.generationId },
    }
    const adopted = composePostgresqlProviderRuntime(input, generation, runtime)
    return {
      provider: 'postgresql',
      runtime: adopted,
      databaseConfig: input.config,
      receipt,
      describeSchemaOutcome: () => describePostgresqlSchemaOutcome(receipt, runtime.generationId),
      openBootstrapClient: () => adopted.openClient(),
    }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

async function recordHostedIdentity(
  connection: Pick<PostgresqlTransactionConnection, 'unsafe'>,
  generationId: string,
  generation: Extract<ResolvedDatabaseGeneration, { source: 'hosted-installation' }>,
): Promise<void> {
  await connection.unsafe(
    `INSERT INTO ${metaTableName('postgresql', 'migration_records')} (run_id,unit_id,ordinal,kind,table_name,record_json,record_digest) VALUES ($1,'hosted-installation-identity',0,'source-metadata',NULL,$2,$3) ON CONFLICT (run_id,unit_id,ordinal) DO NOTHING`,
    [
      generationId,
      canonicalSchemaJson(generation.identity),
      digestSchemaContract(generation.identity),
    ],
  )
}

async function assertHostedIdentity(
  pool: PostgresqlPool,
  generation: Extract<ResolvedDatabaseGeneration, { source: 'hosted-installation' }>,
  record: boolean,
): Promise<void> {
  const rows = await pool.unsafe(
    `SELECT g.generation_id, g.source_generation_id, g.state, r.record_json, r.record_digest FROM ${metaTableName('postgresql', 'generations')} g LEFT JOIN ${metaTableName('postgresql', 'migration_records')} r ON r.run_id=g.generation_id AND r.unit_id='hosted-installation-identity' AND r.ordinal=0`,
  )
  const active = rows.filter((row) => row.state === 'active')
  if (active.length !== 1) throw new Error('epoch2-active-generation-mismatch')
  const seen = new Set<string>()
  let current = active[0]
  const accepted = async () => {
    if (record && active[0]!.record_json == null)
      await recordHostedIdentity(pool, String(active[0]!.generation_id), generation)
  }
  while (current && !seen.has(String(current.generation_id))) {
    const id = String(current.generation_id)
    seen.add(id)
    if (current.record_json != null) {
      let identity: unknown
      try {
        identity = JSON.parse(String(current.record_json))
      } catch {
        throw new Error('postgresql-generation-conflict')
      }
      if (
        current.record_digest === digestSchemaContract(identity) &&
        canonicalSchemaJson(identity) === canonicalSchemaJson(generation.identity)
      )
        return await accepted()
      break
    }
    // An explicit hosted restore or an epoch-1 conversion retains the derived
    // installation id in its generation lineage. It proves the same identity.
    if (id === generation.payload.generationId) return await accepted()
    if (current.source_generation_id === generation.payload.generationId) return await accepted()
    current = rows.find((row) => row.generation_id === current?.source_generation_id)
  }
  throw new Error('postgresql-generation-conflict')
}

function describePostgresqlSchemaOutcome(
  receipt: Epoch2ProviderReceipt,
  generationId: string,
): string {
  return (
    `PostgreSQL schema ${receipt.applied ? 'applied' : 'verified'} ` +
    `(generation: ${generationId}, active tables: ${receipt.activeTableCount}` +
    (receipt.successorContractDigest === undefined
      ? ')\n'
      : `; the database already carries the newer expand-only schema ${receipt.successorContractDigest})\n`)
  )
}

function selectedPostgresqlRuntime(
  runtime: InstrumentedPostgresqlDatabaseRuntime,
  generationId: string,
): InstrumentedPostgresqlDatabaseRuntime {
  return {
    ...runtime,
    generationId,
    health: async () => ({ ...(await runtime.health()), generationId }),
    readiness: async () => ({ ...(await runtime.readiness()), generationId }),
  }
}

/** Operations use the selected pointer without rewriting the user's config. */
export function selectedDatabaseConfiguration(
  config: DatabaseConfig,
  generation: ResolvedDatabaseGeneration,
): DatabaseConfig {
  return generation.source === 'epoch2-pointer'
    ? pointerConfiguration(config, generation.pointer)
    : config
}
export function selectedSqlitePath(
  runtime: ResolvedDatabaseProviderRuntime,
  fallback: string,
): string {
  return runtimeMechanisms[runtime.provider].localPath(runtime, fallback)
}
export function currentSqlitePath(pointerPath: string, fallback: string): string {
  if (!existsSync(pointerPath)) return fallback
  const pointer = readGenerationPointerV2(pointerPath)
  if (pointer.payload.database.kind !== 'sqlite-file') return fallback
  return resolve(dirname(pointerPath), pointer.payload.database.relativePath)
}

/** A completed same-epoch move retains its exact source pointer for rollback. */
export function retainedSqlitePath(pointerPath: string, fallback: string): string {
  if (!existsSync(pointerPath)) return fallback
  const pointer = readGenerationPointerV2(pointerPath)
  if (pointer.payload.database.kind === 'sqlite-file')
    return currentSqlitePath(pointerPath, fallback)
  const operation = pointer.payload.operationId
  if (!operation) return fallback
  const previous = join(dirname(pointerPath), `.${operation}-previous-pointer.json`)
  return existsSync(previous) ? currentSqlitePath(previous, fallback) : fallback
}
