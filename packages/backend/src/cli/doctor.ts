// `agent-workflow doctor` — run all health checks without starting daemon.
// Mirrors design.md §11.3.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createSecretBox } from '@/auth/secretBox'
import { statMetadataIsAuthoritative } from '@/util/fileTrust'
import { loadConfig } from '@/config'
import { quickCheckDbFile } from '@/db/integrity'
import { countEmbeddedSqlMigrations, IS_EMBEDDED } from '@/embed'
import { capabilitiesFromVersion, MIN_GIT_VERSION, parseGitVersion } from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

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
  // RFC-227: this is an availability probe only. OpenCode versions are
  // telemetry; protocol behavior is checked by Runtime Test / actual use.
  const ocDriver = getRuntimeDriver('opencode')
  const probe = await ocDriver.probe(ocDriver.defaultBinary({ opencodePath })[0]!)
  if (probe.ran !== true) {
    checks.push({
      name: 'opencode binary',
      ok: false,
      message: `'${probe.binary}' not found or not executable; install opencode and ensure PATH or set 'opencodePath' in config`,
    })
  } else {
    checks.push({
      name: 'opencode binary',
      ok: true,
      message:
        probe.version === null
          ? `${probe.binary} (version not reported; protocol test required)`
          : `${probe.version} (reported version; protocol test required)`,
    })
  }

  // 2. git binary (required) + ssh (optional, advisory — RFC-254 T21)
  checks.push(await checkGit())
  checks.push(await checkSsh())

  // 3. app home writable
  checks.push(checkAppHome())

  // 4. config loads
  checks.push(checkConfig())

  // 5. at-rest secrets carry the protection this platform actually offers
  checks.push(checkSecretFileProtection())

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

/**
 * RFC-254 T21 — ssh is an OPTIONAL prerequisite: only `ssh://` git remotes need
 * it (`util/git.ts` sets GIT_SSH_COMMAND, which assumes `ssh` on PATH), while
 * https remotes go through T20's credential subcommand. So this check is
 * ADVISORY — always `ok: true` — and just surfaces presence plus a
 * platform-specific install hint, rather than failing doctor over a feature the
 * operator may never use. Pure half exported for tests.
 */
export function evaluateSshCheck(
  sshVersion: string | null,
  platform: NodeJS.Platform,
): CheckResult {
  if (sshVersion !== null && sshVersion !== '') {
    return { name: 'ssh (optional)', ok: true, message: `${sshVersion} — ssh:// remotes available` }
  }
  const hint =
    platform === 'win32'
      ? 'not found — ssh:// git remotes will fail (https remotes are unaffected). Windows 10+ ships an OpenSSH client: enable it via Settings → Apps → Optional Features → OpenSSH Client.'
      : 'not found — ssh:// git remotes will fail (https remotes are unaffected). Install openssh-client.'
  return { name: 'ssh (optional)', ok: true, message: hint }
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
