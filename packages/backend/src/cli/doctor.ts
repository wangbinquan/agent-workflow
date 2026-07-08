// `agent-workflow doctor` — run all health checks without starting daemon.
// Mirrors design.md §11.3.

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { loadConfig } from '@/config'
import { countEmbeddedSqlMigrations, IS_EMBEDDED } from '@/embed'
import { capabilitiesFromVersion, MIN_GIT_VERSION, parseGitVersion } from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'
import { isWindows } from '@/util/platform'

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

  // 5. token file (if present) is restricted to the current user.
  // POSIX: mode 0600; Windows: icacls ACL has no Everyone/Users group.
  checks.push(checkTokenFileMode())

  // 6. migrations present
  checks.push(checkMigrations())

  // 7. RFC-windows PR-2 T10: Windows long-path support (informational — the
  // daemon uses the `\\?\` prefix fallback via util/platform.toLongPath when
  // LongPathsEnabled is off, so this never fails doctor, only surfaces the
  // registry state). POSIX skips (no MAX_PATH limit).
  checks.push(checkLongPaths())

  // 8. RFC-108 T16 (AR-20): lifecycle health — surface recoverable/parked tasks
  // + open alerts so an operator running `doctor` sees a stuck fleet without
  // opening the UI. Informational (never fails doctor — these are recoverable
  // runtime states, not setup errors).
  checks.push(checkLifecycleHealth())

  const ok = checks.every((c) => c.ok)
  return { ok, checks }
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
    if (isWindows()) {
      // RFC-windows PR-2 T9: Windows has no unix mode — verify via icacls that
      // no broad group (Everyone / BUILTIN\Users / Authenticated Users) has
      // access. The daemon's secureFile() restricts to the current user only.
      return evaluateWindowsAclCheck(Paths.tokenFile, 'token file')
    }
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

/**
 * Windows ACL decision: parse `icacls <path>` output and assert no broad
 * group is present. Pure decision half so tests cover the verdict without
 * spawning icacls. Exported for the PR-2 ACL oracle.
 */
export function evaluateWindowsAclDecision(icaclsOutput: string, label: string): CheckResult {
  // Broad principals that would grant access beyond the current user. Each
  // carries a readable label for the doctor message (regex `.source` would
  // leak backslash escapes into the user-facing string).
  const BROAD: ReadonlyArray<{ re: RegExp; name: string }> = [
    { re: /BUILTIN\\Users/i, name: 'BUILTIN\\Users' },
    { re: /\bEveryone\b/i, name: 'Everyone' },
    { re: /Authenticated Users/i, name: 'Authenticated Users' },
    { re: /\bINTERACTIVE\b/i, name: 'INTERACTIVE' },
  ]
  const hit = BROAD.find((b) => b.re.test(icaclsOutput))
  if (hit !== undefined) {
    return {
      name: `${label} acl`,
      ok: false,
      message: `${label} grants access to ${hit.name} (expected current-user only)`,
    }
  }
  return { name: `${label} acl`, ok: true, message: 'restricted to current user ✓' }
}

/** Windows: run `icacls <path>` and evaluate. POSIX: never called. */
function evaluateWindowsAclCheck(path: string, label: string): CheckResult {
  try {
    const res = Bun.spawnSync(['icacls', path])
    if (res.exitCode !== 0) {
      return {
        name: `${label} acl`,
        ok: false,
        message: `icacls failed: ${res.stderr.toString().trim()}`,
      }
    }
    return evaluateWindowsAclDecision(res.stdout.toString(), label)
  } catch (err) {
    return { name: `${label} acl`, ok: false, message: (err as Error).message }
  }
}

/**
 * Windows long-path check: reads the `LongPathsEnabled` registry value.
 * Informational — `ok: true` regardless (the daemon falls back to the `\\?\`
 * prefix via util/platform.toLongPath when this is off). POSIX skips.
 */
export function checkLongPaths(): CheckResult {
  if (!isWindows()) {
    return { name: 'long paths', ok: true, message: '(POSIX: no MAX_PATH limit)' }
  }
  try {
    const res = Bun.spawnSync([
      'reg',
      'query',
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
      '/v',
      'LongPathsEnabled',
    ])
    const out = res.stdout.toString()
    const m = out.match(/LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
    const enabled = m !== null && parseInt(m[1]!, 16) === 1
    return {
      name: 'long paths',
      ok: true,
      message: enabled
        ? 'LongPathsEnabled=1 (deep worktrees OK)'
        : 'LongPathsEnabled=0 (using \\\\?\\ prefix fallback; deep worktrees OK but enabling is recommended)',
    }
  } catch {
    return {
      name: 'long paths',
      ok: true,
      message: '(registry probe unavailable; using \\\\?\\ fallback)',
    }
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
