import {
  evaluateLifecycleHealth,
  evaluateGitCheck,
  evaluateSshCheck,
  evaluateMigrationsStatus,
  type CheckResult,
  type LifecycleHealthCounts,
} from '../../domain/doctorDiagnostics'
import type {
  DoctorDiagnosticsFamily,
  DoctorDiagnosticsFactory,
  DoctorRuntimeSelectionRef,
} from '../../application/ports/doctorDiagnostics'
// `agent-workflow doctor` — run all health checks without starting daemon.
// Complete original native helpers; shared Doctor policy belongs to system-operations.

import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import type { DatabaseProvider } from '@/platform/persistence/schemaContract'
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretBox } from '@/auth/secretBox'
import { statMetadataIsAuthoritative } from '@/util/fileTrust'
import type { Config } from '@agent-workflow/shared'
import { composeFileDoctorConfigurationQueries } from '@/modules/system-operations/composition/doctorConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { quickCheckDbFile } from '@/db/integrity'
import { countEmbeddedSqlMigrations, IS_EMBEDDED } from '@/embed'
import {
  resolveDatabaseProviderRuntime,
  requireDatabaseProviderRuntime,
  type ResolvedDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

function safeDoctorCount(value: unknown): number {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export async function checkPostgresqlLifecycleHealth(
  runtime: PostgresqlDatabaseRuntime,
): Promise<CheckResult> {
  try {
    const rows = await runtime
      .providerPool()
      .unsafe(
        'SELECT ' +
          "count(*) FILTER (WHERE status = 'interrupted') AS interrupted, " +
          "count(*) FILTER (WHERE status = 'failed') AS failed, " +
          "count(*) FILTER (WHERE status = 'awaiting_review') AS awaiting_review, " +
          "count(*) FILTER (WHERE status = 'awaiting_human') AS awaiting_human, " +
          'count(*) FILTER (WHERE auto_recovery_suspended = TRUE) AS quarantined, ' +
          '(SELECT count(*) FROM agent_workflow.lifecycle_alerts WHERE resolved_at IS NULL) AS open_alerts ' +
          'FROM agent_workflow.tasks',
      )
    const row = rows[0] ?? {}
    return evaluateLifecycleHealth({
      interrupted: safeDoctorCount(row.interrupted),
      failed: safeDoctorCount(row.failed),
      awaitingReview: safeDoctorCount(row.awaiting_review),
      awaitingHuman: safeDoctorCount(row.awaiting_human),
      quarantined: safeDoctorCount(row.quarantined),
      openAlerts: safeDoctorCount(row.open_alerts),
    })
  } catch (error) {
    return {
      name: 'lifecycle',
      ok: true,
      message: `(unavailable: ${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

export async function checkPostgresqlSealedCredentials(
  runtime: PostgresqlDatabaseRuntime,
): Promise<CheckResult> {
  try {
    const rows = await runtime
      .providerPool()
      .unsafe(
        'SELECT url_enc AS "urlEnc" FROM agent_workflow.cached_repos WHERE url_enc IS NOT NULL AND url_enc != \'\'',
      )
    if (rows.length === 0) {
      return { name: 'repo credentials', ok: true, message: 'no sealed credentials' }
    }
    if (!existsSync(Paths.secretKeyFile)) {
      return {
        name: 'repo credentials',
        ok: false,
        message: `${rows.length} sealed repo credential(s) but secret.key is MISSING — re-launch those repos to re-enter (restored from another machine?)`,
      }
    }
    const box = createSecretBox(Paths.secretKeyFile)
    let bricked = 0
    for (const row of rows) {
      try {
        box.unseal(String(row.urlEnc ?? ''))
      } catch {
        bricked += 1
      }
    }
    if (bricked > 0) {
      return {
        name: 'repo credentials',
        ok: false,
        message: `${bricked}/${rows.length} sealed repo credential(s) cannot be decrypted (lost/mismatched secret.key) — re-launch those repos to re-enter`,
      }
    }
    return { name: 'repo credentials', ok: true, message: `${rows.length} sealed, all decryptable` }
  } catch (error) {
    return {
      name: 'repo credentials',
      ok: true,
      message: `(unavailable: ${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/** RFC-349: inspect the verified live provider. A retained pre-cutover SQLite
 * file is recovery evidence after PostgreSQL activation, not the live DB. */
/**
 * 各引擎自己那一组体检项。
 *
 * RFC-359 AC-10：原来是 `if (resolved.provider === 'sqlite') return […]` 加一道
 * `unhandledDatabaseProvider` 穷尽性围栏——「这个引擎要体检哪几项」这件事本来就该由**引擎
 * 各自声明一次**，而不是让 `doctor` 现场按品牌拐一下。改成按 provider 查表，形状与
 * `cli/start.ts` 的 `PRE_OPEN_STAGED_RESTORE` / `composeDaemonProviderSession` 一致：
 * `satisfies Record<DatabaseProvider, …>` 就是 forcing function，少一个 provider 编译不过，
 * 于是也不再需要那道手写的 never 汇。
 *
 * 句柄收窄走白名单层的 `requireDatabaseProviderRuntime`（与 `cli/start.ts` 同一个名字家族），
 * 品牌不符即抛——这一支本来就只会在自己那一格里被取到。
 */
const ENGINE_HEALTH_CHECKS = {
  sqlite: async (): Promise<readonly CheckResult[]> => [
    checkLifecycleHealth(),
    checkSealedCredentials(),
  ],
  postgresql: async (
    resolved: ResolvedDatabaseProviderRuntime,
  ): Promise<readonly CheckResult[]> => {
    const runtime = requireDatabaseProviderRuntime(resolved, 'postgresql').runtime
    return [
      await checkPostgresqlLifecycleHealth(runtime),
      await checkPostgresqlSealedCredentials(runtime),
    ]
  },
} satisfies Record<
  DatabaseProvider,
  (resolved: ResolvedDatabaseProviderRuntime) => Promise<readonly CheckResult[]>
>

export async function checkConfiguredDatabase(
  configuration?: ApplicationConfigurationQueries,
): Promise<CheckResult[]> {
  let config: Config
  try {
    config = await (configuration ?? composeFileDoctorConfigurationQueries(Paths.config)).read()
  } catch (error) {
    return [
      {
        name: 'database provider',
        ok: false,
        message: `configuration unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]
  }
  // RFC-359 AC-10 —— 判据与文案是同一件事，一起由引擎声明：`absentLocalStoreMessage` 为
  // `null` 就表示「这个引擎没有本地库文件这回事」，于是连 `existsSync` 都不必做。
  // 原来问的是 `storage === 'embedded-file'` 且那句话里写死了「SQLite」——`storage` 比品牌名
  // 好一档，但仍是两值枚举，第三个 provider 只能落进其中一边。
  const absentLocalStore = databaseProviderTraits(config.database.provider).absentLocalStoreMessage
  if (absentLocalStore !== null && !existsSync(Paths.db)) {
    return [
      {
        name: 'database provider',
        ok: true,
        message: absentLocalStore,
      },
      checkLifecycleHealth(),
      checkSealedCredentials(),
    ]
  }

  let resolved: ReturnType<typeof resolveDatabaseProviderRuntime>
  try {
    const contract = buildLogicalSchemaContract()
    resolved = resolveDatabaseProviderRuntime({
      config: config.database,
      sqlitePath: Paths.db,
      generationPointerPath: Paths.databaseGenerationPointer,
      operationsRoot: Paths.databaseMigrationsDir,
      contract,
    })
  } catch (error) {
    return [
      {
        name: 'database provider',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
    ]
  }

  try {
    const report = await resolved.operations.doctor()
    const details = report.checks
      .map((check) => `${check.code}=${check.ok ? 'ok' : check.message}`)
      .join(', ')
    const providerCheck: CheckResult = {
      name: 'database provider',
      ok: report.ok,
      message:
        `${report.provider} generation ${report.generationId}: ${details}` +
        // RFC-359 AC-10：提示语由各引擎自己声明一句（没有可给的就是 null），
        // 不再由调用方先问存储形态再自己拼。
        (report.ok ? '' : (databaseProviderTraits(report.provider).failureRecoveryHint ?? '')),
    }
    return [providerCheck, ...(await ENGINE_HEALTH_CHECKS[resolved.provider](resolved))]
  } finally {
    await resolved.close()
  }
}

/**
 * RFC-213 AC-12 — after a cross-machine restore, `cached_repos` URLs sealed with
 * the OLD machine's secret.key can no longer be decrypted (the backup correctly
 * excludes secret.key). Surface that LOUDLY (fails doctor) so the operator knows
 * to re-launch those repos and re-enter credentials, rather than hit silent
 * clone failures. Read-only + immutable so a bare-WAL / stopped daemon still works.
 */
export function checkSealedCredentials(): CheckResult {
  if (!existsSync(Paths.db)) {
    return { name: 'repo credentials', ok: true, message: '(no database yet)' }
  }
  let db: Database | null = null
  try {
    // Plain read-only (sidecars persist after checkpoint+close). Not the
    // `file:…?immutable=1` URI — bun:sqlite rejects it on Linux.
    db = new Database(Paths.db, { readonly: true })
    const rows = db
      .query(
        "SELECT url_enc AS urlEnc FROM cached_repos WHERE url_enc IS NOT NULL AND url_enc != ''",
      )
      .all() as { urlEnc: string }[]
    if (rows.length === 0) {
      return { name: 'repo credentials', ok: true, message: 'no sealed credentials' }
    }
    if (!existsSync(Paths.secretKeyFile)) {
      return {
        name: 'repo credentials',
        ok: false,
        message: `${rows.length} sealed repo credential(s) but secret.key is MISSING — re-launch those repos to re-enter (restored from another machine?)`,
      }
    }
    const box = createSecretBox(Paths.secretKeyFile)
    let bricked = 0
    for (const r of rows) {
      try {
        box.unseal(r.urlEnc)
      } catch {
        bricked++
      }
    }
    if (bricked > 0) {
      return {
        name: 'repo credentials',
        ok: false,
        message: `${bricked}/${rows.length} sealed repo credential(s) cannot be decrypted (lost/mismatched secret.key) — re-launch those repos to re-enter`,
      }
    }
    return { name: 'repo credentials', ok: true, message: `${rows.length} sealed, all decryptable` }
  } catch (err) {
    // cached_repos absent (old schema) / DB unreadable — informational.
    return {
      name: 'repo credentials',
      ok: true,
      message: `(unavailable: ${(err as Error).message})`,
    }
  } finally {
    db?.close()
  }
}

/**
 * RFC-213 — read-only DB integrity check. Uses quickCheckDbFile, which opens the
 * DB with `{ readonly: true }` and NEVER writes (a corruption report must not
 * mutate the very file it is diagnosing). A corrupt DB FAILS doctor.
 */
export function checkDbIntegrity(): CheckResult {
  if (!existsSync(Paths.db)) {
    return { name: 'db integrity', ok: true, message: '(no database yet)' }
  }
  const r = quickCheckDbFile(Paths.db)
  if (r.ok) return { name: 'db integrity', ok: true, message: 'quick_check ok' }
  return {
    name: 'db integrity',
    ok: false,
    message: `CORRUPT (${r.errors.slice(0, 2).join('; ')}) — recover: agent-workflow restore <backup>`,
  }
}

/** RFC-213 — backup health (informational; never fails doctor). */
export function checkBackups(): CheckResult {
  let files: string[] = []
  try {
    files = readdirSync(Paths.backupsDir).filter((f) => f.endsWith('.tar.gz'))
  } catch {
    /* no backups dir yet */
  }
  if (files.length === 0) {
    return {
      name: 'backups',
      ok: true,
      message: 'none yet — create one with `agent-workflow backup`',
    }
  }
  const stated = files
    .map((f) => {
      const p = join(Paths.backupsDir, f)
      const s = statSync(p)
      return { mtime: s.mtimeMs, size: s.size }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const totalMb = (stated.reduce((n, x) => n + x.size, 0) / 1024 / 1024).toFixed(1)
  const newest = new Date(stated[0]!.mtime).toISOString()
  return {
    name: 'backups',
    ok: true,
    message: `${stated.length} backup${stated.length === 1 ? '' : 's'}, newest ${newest}, ${totalMb} MB total`,
  }
}

function checkLifecycleHealth(): CheckResult {
  if (!existsSync(Paths.db)) {
    return { name: 'lifecycle', ok: true, message: '(no database yet)' }
  }
  let dbh: Database | null = null
  try {
    dbh = new Database(Paths.db, { readonly: true })
    const taskCount = (status: string): number =>
      (dbh!.query('SELECT count(*) AS n FROM tasks WHERE status = ?').get(status) as { n: number })
        .n
    const counts: LifecycleHealthCounts = {
      interrupted: taskCount('interrupted'),
      failed: taskCount('failed'),
      awaitingReview: taskCount('awaiting_review'),
      awaitingHuman: taskCount('awaiting_human'),
      quarantined: (
        dbh.query('SELECT count(*) AS n FROM tasks WHERE auto_recovery_suspended = 1').get() as {
          n: number
        }
      ).n,
      openAlerts: (
        dbh.query('SELECT count(*) AS n FROM lifecycle_alerts WHERE resolved_at IS NULL').get() as {
          n: number
        }
      ).n,
    }
    return evaluateLifecycleHealth(counts)
  } catch (err) {
    // DB locked / pre-migration / missing column — informational, never fatal.
    return { name: 'lifecycle', ok: true, message: `(unavailable: ${(err as Error).message})` }
  } finally {
    dbh?.close()
  }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: ['git', '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode !== 0) {
      return { name: 'git', ok: false, message: 'git --version failed' }
    }
    return evaluateGitCheck(out)
  } catch (err) {
    return { name: 'git', ok: false, message: `git not executable: ${(err as Error).message}` }
  }
}

async function checkSsh(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: ['ssh', '-V'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // `ssh -V` prints the version banner to STDERR and exits 0.
    const [err, out, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    const banner = (err.trim() || out.trim()).split('\n')[0] ?? ''
    return evaluateSshCheck(exitCode === 0 ? banner : null, process.platform)
  } catch {
    return evaluateSshCheck(null, process.platform)
  }
}

function checkAppHome(): CheckResult {
  try {
    const exists = existsSync(Paths.root)
    if (!exists) {
      return {
        name: 'app home',
        ok: true,
        message: `${Paths.root} (will be created on first daemon start)`,
      }
    }
    const st = statSync(Paths.root)
    if (!st.isDirectory()) {
      return { name: 'app home', ok: false, message: `${Paths.root} exists but is not a directory` }
    }
    return { name: 'app home', ok: true, message: Paths.root }
  } catch (err) {
    return { name: 'app home', ok: false, message: (err as Error).message }
  }
}

export async function checkConfig(
  configuration?: ApplicationConfigurationQueries,
  checkLocalPresence = configuration === undefined,
): Promise<CheckResult> {
  if (checkLocalPresence && !existsSync(Paths.config)) {
    return { name: 'config', ok: true, message: '(not yet created; defaults will apply)' }
  }
  try {
    const cfg = await (configuration ?? composeFileDoctorConfigurationQueries(Paths.config)).read()
    return { name: 'config', ok: true, message: `loaded ($schema_version=${cfg.$schema_version})` }
  } catch (err) {
    return {
      name: 'config',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * RFC-254 T7 / D19 — report the protection that is ACTUALLY in force on each
 * at-rest secret, per platform.
 *
 * The previous version asserted mode 600 unconditionally. Windows does not
 * carry POSIX permission bits — `statSync().mode & 0o777` there reports
 * something like 666 regardless of the ACL — so on any Windows box that had
 * ever started the daemon, `doctor` failed on a file that was not actually
 * insecure. Reporting a protection the platform does not implement is the
 * mirror of the mistake D19 forbids: it must say which one is in force, not
 * pretend every platform has the same one.
 */
function checkSecretFileProtection(platform: NodeJS.Platform = process.platform): CheckResult {
  // Every at-rest secret the daemon writes into the app home. The control file
  // carries the shutdown nonce (RFC-254 T7) and belongs in this list for the
  // same reason the token does.
  const secrets: Array<[string, string]> = [
    ['token', Paths.tokenFile],
    ['control (shutdown nonce)', Paths.controlFile],
  ]
  const present = secrets.filter(([, path]) => existsSync(path))
  if (present.length === 0) {
    return {
      name: 'secret file protection',
      ok: true,
      message: '(created on first daemon start)',
    }
  }

  if (!statMetadataIsAuthoritative(platform)) {
    // Honest, not reassuring: the mode bits exist but mean nothing here, so the
    // confidentiality comes from the per-user ACL on the app home. Say that,
    // and say it is not verified by this check.
    return {
      name: 'secret file protection',
      ok: true,
      message:
        `per-user ACL on ${Paths.root} (win32 has no POSIX mode bits; ` +
        `this check does not verify the DACL — see docs/audit-backlog.md) ` +
        `[${present.map(([label]) => label).join(', ')}]`,
    }
  }

  const wrong: string[] = []
  for (const [label, path] of present) {
    try {
      const mode = statSync(path).mode & 0o777
      if (mode !== 0o600) wrong.push(`${label} has mode ${mode.toString(8)} (expected 600)`)
    } catch (err) {
      wrong.push(`${label}: ${(err as Error).message}`)
    }
  }
  if (wrong.length > 0) {
    return { name: 'secret file protection', ok: false, message: wrong.join('; ') }
  }
  return {
    name: 'secret file protection',
    ok: true,
    message: `mode 600 ✓ [${present.map(([label]) => label).join(', ')}]`,
  }
}

function checkMigrations(): CheckResult {
  if (IS_EMBEDDED) {
    return evaluateMigrationsStatus({
      embedded: true,
      embeddedSqlCount: countEmbeddedSqlMigrations(),
      fsExists: false,
      fsSqlCount: 0,
      fsPath: Paths.migrationsDir,
    })
  }
  const fsExists = existsSync(Paths.migrationsDir)
  const fsSqlCount = fsExists
    ? readdirSync(Paths.migrationsDir).filter((f) => f.endsWith('.sql')).length
    : 0
  return evaluateMigrationsStatus({
    embedded: false,
    embeddedSqlCount: 0,
    fsExists,
    fsSqlCount,
    fsPath: Paths.migrationsDir,
  })
}

export function createLocalDoctorDiagnostics(input: {
  readonly configuration?: ApplicationConfigurationQueries
}): DoctorDiagnosticsFamily {
  const selected = input.configuration
  const configuration = selected ?? composeFileDoctorConfigurationQueries(Paths.config)
  return {
    async loadRuntimeConfiguration() {
      if (selected !== undefined || existsSync(Paths.config)) {
        return (await configuration.read()).opencodePath
      }
      return undefined
    },
    async probeRuntime(selection: DoctorRuntimeSelectionRef) {
      const opencodePath = selection as Config['opencodePath']
      const ocDriver = getRuntimeDriver('opencode')
      return await ocDriver.probe(ocDriver.defaultBinary({ opencodePath })[0]!)
    },
    git() {
      return checkGit()
    },
    ssh() {
      return checkSsh()
    },
    home() {
      return checkAppHome()
    },
    configuration() {
      return checkConfig(configuration, selected === undefined)
    },
    installation() {
      return checkSecretFileProtection()
    },
    migrations() {
      return checkMigrations()
    },
    database() {
      return checkConfiguredDatabase(configuration)
    },
    backups() {
      return checkBackups()
    },
  }
}

export function createLocalDoctorDiagnosticsFactory(): DoctorDiagnosticsFactory {
  return {
    create(input) {
      return createLocalDoctorDiagnostics(input)
    },
  }
}
