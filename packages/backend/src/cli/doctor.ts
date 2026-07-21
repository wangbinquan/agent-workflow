// `agent-workflow doctor` — run all health checks without starting daemon.
// Mirrors design.md §11.3.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretBox } from '@/auth/secretBox'
import { loadConfig } from '@/config'
import { quickCheckDbFile } from '@/db/integrity'
import { countEmbeddedSqlMigrations, IS_EMBEDDED } from '@/embed'
import { capabilitiesFromVersion, MIN_GIT_VERSION, parseGitVersion } from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'

export interface CheckResult {
  name: string
  ok: boolean
  message: string
}

export interface DoctorResult {
  ok: boolean
  checks: CheckResult[]
}

export async function doctorCommand(): Promise<DoctorResult> {
  const checks: CheckResult[] = []

  // 1. opencode binary
  let opencodePath: string | undefined
  try {
    if (existsSync(Paths.config)) opencodePath = loadConfig(Paths.config).opencodePath
  } catch {
    // ignore — separate check below catches config issues
  }
  // RFC-143: probe opencode via its driver (single source for probe + minVersion).
  const ocDriver = getRuntimeDriver('opencode')
  const probe = await ocDriver.probe(ocDriver.defaultBinary({ opencodePath })[0]!)
  if (probe.version === null) {
    checks.push({
      name: 'opencode binary',
      ok: false,
      message: `'${probe.binary}' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config`,
    })
  } else if (!probe.compatible) {
    checks.push({
      name: 'opencode version',
      ok: false,
      message:
        probe.incompatibleReason ??
        `${probe.version} is older than required minimum ${ocDriver.minVersion}`,
    })
  } else {
    checks.push({
      name: 'opencode version',
      ok: true,
      message: `${probe.version} (>= ${ocDriver.minVersion})`,
    })
  }

  // 2. git binary
  checks.push(await checkGit())

  // 3. app home writable
  checks.push(checkAppHome())

  // 4. config loads
  checks.push(checkConfig())

  // 5. token file (if present) has mode 0600
  checks.push(checkTokenFileMode())

  // 6. migrations present
  checks.push(checkMigrations())

  // 7. RFC-108 T16 (AR-20): lifecycle health — surface recoverable/parked tasks
  // + open alerts so an operator running `doctor` sees a stuck fleet without
  // opening the UI. Informational (never fails doctor — these are recoverable
  // runtime states, not setup errors).
  checks.push(checkLifecycleHealth())

  // 8. RFC-213: DB integrity (fails doctor on corruption) + backup health (info)
  // + sealed-credential decryptability (AC-12: cross-machine restore brick).
  checks.push(checkDbIntegrity())
  checks.push(checkBackups())
  checks.push(checkSealedCredentials())

  const ok = checks.every((c) => c.ok)
  return { ok, checks }
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
    const uri = `file:${Paths.db.replace(/\?/g, '%3f').replace(/#/g, '%23')}?immutable=1`
    db = new Database(uri, { readonly: true })
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

export interface LifecycleHealthCounts {
  interrupted: number
  failed: number
  awaitingReview: number
  awaitingHuman: number
  quarantined: number
  openAlerts: number
}

/**
 * Pure decision for the lifecycle-health check (no DB), so tests cover the
 * summary wording directly. Always `ok: true` — a stuck fleet is a recoverable
 * runtime state, not a `doctor` failure; the message just makes it visible.
 */
export function evaluateLifecycleHealth(c: LifecycleHealthCounts): CheckResult {
  const notable = c.interrupted + c.awaitingReview + c.awaitingHuman + c.quarantined + c.openAlerts
  if (notable === 0) {
    return { name: 'lifecycle', ok: true, message: 'no parked / interrupted tasks, no open alerts' }
  }
  const parts = [
    `${c.interrupted} interrupted (resumable)`,
    `${c.awaitingReview} awaiting-review`,
    `${c.awaitingHuman} awaiting-human`,
    `${c.quarantined} auto-recovery-quarantined`,
    `${c.openAlerts} open alert${c.openAlerts === 1 ? '' : 's'}`,
  ]
  return { name: 'lifecycle', ok: true, message: parts.join(', ') }
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

/**
 * Pure decision half of the git check — exported for tests. RFC-130 D7 raised
 * the platform floor from 2.5.0 (worktree era) to 2.38.0: every node run
 * merge-backs via `git merge-tree --write-tree`, which pre-2.38 git rejects.
 */
export function evaluateGitCheck(rawVersionOutput: string): CheckResult {
  const v = parseGitVersion(rawVersionOutput)
  if (v === null) {
    return {
      name: 'git',
      ok: false,
      message: `unparseable git output: ${rawVersionOutput.trim()}`,
    }
  }
  if (!capabilitiesFromVersion(v).supportsMergeTreeWriteTree) {
    return {
      name: 'git version',
      ok: false,
      message: `${v.raw} is older than required ${MIN_GIT_VERSION} (isolated merge-back needs \`git merge-tree --write-tree\`, RFC-130 D7)`,
    }
  }
  return { name: 'git version', ok: true, message: `${v.raw} (>=${MIN_GIT_VERSION})` }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const proc = Bun.spawn({ cmd: ['git', '--version'], stdout: 'pipe', stderr: 'pipe' })
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (exitCode !== 0) {
      return { name: 'git', ok: false, message: 'git --version failed' }
    }
    return evaluateGitCheck(out)
  } catch (err) {
    return { name: 'git', ok: false, message: `git not executable: ${(err as Error).message}` }
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

function checkConfig(): CheckResult {
  if (!existsSync(Paths.config)) {
    return { name: 'config', ok: true, message: '(not yet created; defaults will apply)' }
  }
  try {
    const cfg = loadConfig(Paths.config)
    return { name: 'config', ok: true, message: `loaded ($schema_version=${cfg.$schema_version})` }
  } catch (err) {
    return { name: 'config', ok: false, message: (err as Error).message }
  }
}

function checkTokenFileMode(): CheckResult {
  if (!existsSync(Paths.tokenFile)) {
    return { name: 'token file', ok: true, message: '(will be created on first daemon start)' }
  }
  try {
    const mode = statSync(Paths.tokenFile).mode & 0o777
    if (mode !== 0o600) {
      return {
        name: 'token file mode',
        ok: false,
        message: `${Paths.tokenFile} has mode ${mode.toString(8)} (expected 600)`,
      }
    }
    return { name: 'token file mode', ok: true, message: 'mode 600 ✓' }
  } catch (err) {
    return { name: 'token file', ok: false, message: (err as Error).message }
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

/**
 * Pure decision for the `migrations folder` check — no fs / no IS_EMBEDDED
 * lookup, so tests can cover every combination directly (an installed single
 * binary can't be exercised in dev tests because `bun --compile` rewrites
 * `import.meta.dirname` and `IS_EMBEDDED` only flips inside the embedded
 * runtime). Exported for `cli-doctor-migrations.test.ts`.
 */
export function evaluateMigrationsStatus(input: {
  embedded: boolean
  embeddedSqlCount: number
  fsExists: boolean
  fsSqlCount: number
  fsPath: string
}): CheckResult {
  if (input.embedded) {
    if (input.embeddedSqlCount === 0) {
      return {
        name: 'migrations folder',
        ok: false,
        message:
          'single binary ships zero embedded migrations — build is broken (check scripts/build-binary.ts MIGRATION_FILES generation)',
      }
    }
    return {
      name: 'migrations folder',
      ok: true,
      message: `${input.embeddedSqlCount} migration${input.embeddedSqlCount === 1 ? '' : 's'} embedded in binary`,
    }
  }
  if (!input.fsExists) {
    return {
      name: 'migrations folder',
      ok: false,
      message: `${input.fsPath} missing; run \`bun run --filter '@agent-workflow/backend' db:generate\``,
    }
  }
  if (input.fsSqlCount === 0) {
    return {
      name: 'migrations folder',
      ok: false,
      message: 'no .sql migrations found; run db:generate',
    }
  }
  return {
    name: 'migrations folder',
    ok: true,
    message: `${input.fsSqlCount} migration${input.fsSqlCount === 1 ? '' : 's'} bundled`,
  }
}

export function formatDoctor(r: DoctorResult): string {
  const lines: string[] = []
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.message}`)
  }
  lines.push(r.ok ? '\nall checks passed' : '\none or more checks failed')
  return lines.join('\n') + '\n'
}
