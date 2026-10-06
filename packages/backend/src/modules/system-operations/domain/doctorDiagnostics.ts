// Sole original Doctor result and decision rules.
import { capabilitiesFromVersion, MIN_GIT_VERSION, parseGitVersion } from '@/services/gitVersion'

export interface CheckResult {
  name: string
  ok: boolean
  message: string
}

export interface DoctorResult {
  ok: boolean
  checks: CheckResult[]
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
