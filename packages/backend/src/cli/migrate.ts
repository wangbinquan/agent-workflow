// `agent-workflow migrate` — manually apply pending DB migrations.
// The daemon's `start` command already does this on boot; this subcommand
// exists as a recovery / debug fallback when the daemon won't start due to
// a failed migration that needs inspection.

import { unhandledDatabaseProvider } from '@/platform/persistence/databaseProviders'
import { loadConfig } from '@/config'
import { prepareDatabaseProviderForBoot } from '@/modules/system-operations/composition'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'

export async function migrateCommand(): Promise<{ output: string }> {
  const config = loadConfig(Paths.config)
  const contract = buildLogicalSchemaContract()
  const prepared = await prepareDatabaseProviderForBoot({
    config: config.database,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
    configPath: Paths.config,
    lockPath: Paths.lock,
    sqliteOptions: { migrationsFolder: await resolveMigrationsFolder() },
  })
  const provider = prepared.runtime
  // Residual fence: a third variant on ResolvedDatabaseProviderRuntime widens
  // this and stops compiling, instead of falling into the SQLite path below.
  if (provider.provider !== 'sqlite' && provider.provider !== 'postgresql') {
    return unhandledDatabaseProvider(provider)
  }
  // RFC-359 AC-10 —— 要说的那句话在**品牌已经确定的地方**（`prepareDatabaseProviderForBoot`，
  // platform/persistence 白名单层）就定稿了，这里只负责输出，不再按品牌分叉。
  //
  // `finally` 里关闭，两条旧路径的语义都保住：
  // · PG 原本就是 `finally` 关——拼消息途中抛也要关；
  // · SQLite 原本是「先关再返回」。`finally` 在函数真正返回给调用方之前执行，所以这条
  //   照旧成立。这很重要：生产 CLI 随后就退出（泄漏无害），但**进程内的测试 harness 会复用
  //   进程**，而 Windows 上一个泄漏的 bun:sqlite 句柄会让 db.sqlite（连同 -wal/-shm）保持
  //   打开、锁住所在目录，调用方的 `rm(tempDir)` 就 EBUSY（POSIX 允许 unlink 打开的文件，
  //   Windows 不允许）。RFC-254 T31（cli.test.ts 的 teardown）。
  try {
    return { output: prepared.describeSchemaOutcome() }
  } finally {
    await provider.close()
  }
}
