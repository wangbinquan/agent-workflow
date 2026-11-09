// RFC-427: the CLI commands' dependency assembly, moved verbatim from `main.ts` — the entry root only parses arguments,
// selects the deployment and dispatches. `bootstrap/` never imports `cli/` (RFC-393), so the CLI handler types
// (`UserCommandIdentityHandle`, `PackageCommandBootstrap`) are checked structurally where `main.ts` hands these results
// to the handlers.
import { composeRepositoryBackupPreparation } from './repositoryBackupPreparation'
import { createLocalDoctorDiagnosticsFactory } from './doctorDiagnostics'
import { logicalSchemaContract } from './persistenceSchema'
import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { resolveDatabaseProviderRuntimeForRestore } from '@/platform/persistence/databaseProviderRuntime'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { createSecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import { createAuthRuntimeFor } from '@/auth/composition'
import { loadConfig } from '@/config'
import {
  composeDoctorApplication,
  formatDoctor,
} from '@/modules/system-operations/composition/doctorDiagnostics'
import { composeFileCliConfiguration } from '@/modules/system-operations/composition/cliConfiguration'
import { composeLegacyAssetMigrationReport } from '@/modules/development-automation/composition/migrationReport'
import {
  composeLocalSystemOperations,
  prepareDatabaseProviderForBoot,
} from '@/modules/system-operations/composition'
import { composeLocalDatabaseMigrationOperations } from '@/modules/system-operations/composition/databaseMigration'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import {
  composePostgresqlResourcePackageCatalog,
  composePostgresqlResourcePackageProvider,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { createResourcePackageAtomicApplyOperations } from '@/modules/resource-catalog/composition/resourcePackageAtomicApply'
import { createPostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/code-capability/composition/capabilityTemplateOperations'
import { createResourcePackagePluginInstaller } from '@/modules/resource-catalog/composition/resourcePackagePluginInstaller'
import { createPostgresqlResourcePackageExecutionAdapter } from '@/modules/resource-catalog/composition/resourcePackageExecution'
import { Paths } from '@/util/paths'

export async function composeUserCommandBootstrap() {
  const provider = await resolveCommandProvider()
  // Residual fence: the bootstrap carries exactly these two provider values, so this is
  // unreachable today; a third one widens `provider.provider` and stops this compiling
  // rather than silently letting a new provider fall through the composition below.
  // RFC-359 AC-10：收窄的对象不再是可辨识联合（bootstrap 客户端已由白名单层交出，
  // 这里不按品牌分叉），所以围栏喂给 `never` 汇的是**那个 provider 值**本身。
  if (provider.provider !== 'sqlite' && provider.provider !== 'postgresql') {
    return unhandledDatabaseProvider(provider.provider)
  }
  const identityAccess = createIdentityAccessRuntime({ db: provider.db })
  const auth = createAuthRuntimeFor({
    db: provider.db,
    // A standalone CLI has no live HTTP/WS credential cache to invalidate.
    onCredentialRevoked: () => undefined,
  })
  const operations = composeIdentityUserOperations({ identityAccess, auth })
  const localOperator = await identityAccess.localOperator.forUser(SYSTEM_USER_ID)
  if (localOperator === null) {
    identityAccess.shutdown()
    throw new Error('local-system-operator-not-active')
  }
  const identity = Object.freeze({
    operations,
    commandContext: () => localOperator.commandContext(),
    queryContext: () => localOperator.queryContext(),
  })

  return {
    auth,
    identity,
    async shutdown() {
      identityAccess.shutdown()
      await provider.runtime.close()
    },
  }
}

async function resolveCommandProvider() {
  const config = loadConfig(Paths.config)
  const contract = logicalSchemaContract
  const prepared = await prepareDatabaseProviderForBoot({
    config: config.database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
    configPath: Paths.config,
    lockPath: Paths.lock,
    sqliteOptions: {},
  })
  const runtime = prepared.runtime
  try {
    // RFC-359 AC-10 —— bootstrap 客户端由 `prepareDatabaseProviderForBoot`（白名单层、品牌
    // 已知处）交出来，这里不再按品牌分叉。原来两支的唯一差别是 `openClient` 的入参个数，
    // 而 SQLite 那支还会**多算一次** `await resolveMigrationsFolder()` 然后把结果丢掉：
    // prepare 阶段早已用同一个值把库打开并 adopt 进 runtime，`openClient(input)` 此时
    // 根本不看 `input`。
    return Object.freeze({
      provider: runtime.provider,
      runtime,
      db: prepared.openBootstrapClient(),
    })
  } catch (error) {
    await runtime.close()
    throw error
  }
}

export async function composePackageCommandBootstrap() {
  const provider = await resolveCommandProvider()
  // Residual fence: the bootstrap carries exactly these two provider values, so this is
  // unreachable today; a third one widens `provider.provider` and stops this compiling
  // rather than silently letting a new provider fall through the composition below.
  // RFC-359 AC-10：收窄的对象不再是可辨识联合（bootstrap 客户端已由白名单层交出，
  // 这里不按品牌分叉），所以围栏喂给 `never` 汇的是**那个 provider 值**本身。
  if (provider.provider !== 'sqlite' && provider.provider !== 'postgresql') {
    return unhandledDatabaseProvider(provider.provider)
  }
  const identityAccess = createIdentityAccessRuntime({ db: provider.db })
  type PostgresqlResourcePackageProviderInput = Parameters<
    typeof composePostgresqlResourcePackageProvider
  >[0]
  type PackageAuthority = Parameters<
    PostgresqlResourcePackageProviderInput['authorityResolver']['resolve']
  >[0]
  const actorsByAuthority = new WeakMap<PackageAuthority, Actor>()
  const authorityResolver: PostgresqlResourcePackageProviderInput['authorityResolver'] =
    Object.freeze({
      resolve(authority: PackageAuthority) {
        const actor = actorsByAuthority.get(authority)
        if (actor === undefined) throw new Error('foreign-resource-package-authority')
        return actor
      },
    })
  const box = createSecretBox(Paths.secretKeyFile)
  // RFC-359 —— 资源包 apply **一台引擎两个 provider**。此处此前是一个
  // `provider === 'sqlite' ? … : …`：SQLite 走 `commitResourcePackage` + 同步事务里的
  // legacy 参与者，PostgreSQL 走 journal + prestage/compensate 的原子 apply。两份做的是
  // 同一件事，而判据只跑 SQLite 那一份（见 `rfc359-w13-…-conformance`）。现在只剩后者，
  // 装配所需的四件依赖本来就是中立的，此前就已经算在分叉之外。
  const resourcePackageProvider = composePostgresqlResourcePackageProvider({
    db: provider.db,
    appHome: Paths.root,
    authorityResolver,
    mcpLifecycle: createMcpTransactionLifecycle(),
    capabilityTemplates: createPostgresqlCapabilityTemplatePackageMutationOwner({
      db: provider.db,
    }),
    pluginInstaller: createResourcePackagePluginInstaller(),
  })
  const catalog = composePostgresqlResourcePackageCatalog({
    provider: resourcePackageProvider,
    execution: createPostgresqlResourcePackageExecutionAdapter({
      box,
      provider: resourcePackageProvider,
      atomicApply: createResourcePackageAtomicApplyOperations({
        db: provider.db,
        box,
      }),
    }),
  })
  const identity = Object.freeze({
    async resolveLocalIdentityByUsername(username: string) {
      const user = await identityAccess.userDirectory.findByUsername(username)
      if (user === null) return null
      if (user.status !== 'active') return Object.freeze({ status: user.status, identity: null })
      const local = await identityAccess.localOperator.forUser(user.id)
      return Object.freeze({
        status: user.status,
        identity:
          local === null
            ? null
            : Object.freeze({
                actor: local.actor,
                commandContext() {
                  const context = local.commandContext()
                  actorsByAuthority.set(context.authority, local.actor)
                  return context
                },
                queryContext() {
                  const context = local.queryContext()
                  actorsByAuthority.set(context.authority, local.actor)
                  return context
                },
              }),
      })
    },
  })
  return {
    identity,
    catalog,
    async shutdown() {
      identityAccess.shutdown()
      await provider.runtime.close()
    },
  }
}

/** `backup`: the local system operations over the configured provider; the runtime closes if composition fails. */
export async function composeBackupCommandOperations() {
  const provider = await resolveCommandProvider()
  try {
    return composeLocalSystemOperations({
      repositoryBackupPreparationFactory: composeRepositoryBackupPreparation,
      contract: logicalSchemaContract,
      providerRuntime: provider.runtime,
    })
  } catch (error) {
    await provider.runtime.close()
    throw error
  }
}

/** `restore` (epoch-2 archives): the local system operations over the provider a restore targets. */
export function composeRestoreCommandOperations() {
  const contract = logicalSchemaContract
  const providerRuntime = resolveDatabaseProviderRuntimeForRestore({
    config: loadConfig(Paths.config).database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
  })
  return composeLocalSystemOperations({
    repositoryBackupPreparationFactory: composeRepositoryBackupPreparation,
    contract,
    providerRuntime,
  })
}

/** `doctor`: the local diagnostics and the report the command prints (RFC-474: the report moved here from `cli/doctor.ts`). */
export async function runDoctorCommand() {
  const result = await composeDoctorApplication({
    diagnostics: createLocalDoctorDiagnosticsFactory(logicalSchemaContract),
  }).run()
  return { ok: result.ok, output: formatDoctor(result) }
}

/** `db …`: the local database migration operations. */
export function composeLocalDatabaseMigrationCommandOperations() {
  return composeLocalDatabaseMigrationOperations(logicalSchemaContract)
}

/** `config get|set` (RFC-474): the installation's configuration file; the daemon need not run. */
export function composeConfigCommandPersistence() {
  return composeFileCliConfiguration(Paths.config)
}

/** `migration-report` (RFC-474): the schema contract and the legacy asset analysis over the client the command opens. */
export function composeMigrationReportCommandDependencies() {
  return Object.freeze({
    contract: logicalSchemaContract,
    analysis: composeLegacyAssetMigrationReport,
  })
}
