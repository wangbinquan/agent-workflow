// Shared process boundary for Playwright fixtures.
//
// E2E setup must never rely on a shell command string: repo paths and branch
// names are dynamic, and an unbounded synchronous child can otherwise wedge an
// entire Playwright shard. Keep every Git/SQLite invocation parameterized,
// non-interactive, and covered by a hard deadline here.

import { execFileSync } from 'node:child_process'

const COMMAND_TIMEOUT_MS = 15_000

// Fixture SQL runs against the DB file of a LIVE daemon, which holds the same
// file in WAL with `PRAGMA busy_timeout = 5000` (packages/backend/src/db/client.ts).
// The `sqlite3` CLI defaults to busy_timeout = 0, so before this every daemon
// write that overlapped a fixture write failed the shard instantly with
// "stepping, database is locked (5)" (nightly e2e-webkit run 30440683412).
// Kept under COMMAND_TIMEOUT_MS so a genuinely wedged writer still surfaces as
// our own deadline rather than a SIGTERM with no SQLite diagnosis.
const SQLITE_BUSY_TIMEOUT_MS = 10_000

function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    SSH_ASKPASS_REQUIRE: 'never',
  }
}

export function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: nonInteractiveGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  })
}

export function initGitRepo(
  repoPath: string,
  options: { email?: string; message?: string; name?: string } = {},
): void {
  runGit(['init', '-b', 'main', '-q'], repoPath)
  runGit(['config', 'user.email', options.email ?? 'e2e@example.com'], repoPath)
  runGit(['config', 'user.name', options.name ?? 'e2e'], repoPath)
  runGit(['add', '.'], repoPath)
  runGit(
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-q',
      '-m',
      options.message ?? 'initial',
    ],
    repoPath,
  )
}

export function initBareGitRepo(repoPath: string): void {
  runGit(['init', '--bare', '-b', 'main', '-q', repoPath])
}

export function cloneBareGitRepo(sourcePath: string, destinationPath: string): void {
  runGit(['clone', '--bare', sourcePath, destinationPath])
}

export function runSqlite(dbPath: string, sql: string): void {
  // Prepended rather than passed as `-cmd .timeout`: the pragma is ordered
  // with the caller's own statements on the same connection, so a caller that
  // opens an explicit transaction (`BEGIN IMMEDIATE`) still acquires its write
  // lock under this timeout. Statement grouping stays the caller's choice.
  execFileSync('sqlite3', [dbPath, `PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};\n${sql}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  })
}
