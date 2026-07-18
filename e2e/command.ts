// Shared process boundary for Playwright fixtures.
//
// E2E setup must never rely on a shell command string: repo paths and branch
// names are dynamic, and an unbounded synchronous child can otherwise wedge an
// entire Playwright shard. Keep every Git/SQLite invocation parameterized,
// non-interactive, and covered by a hard deadline here.

import { execFileSync } from 'node:child_process'

const COMMAND_TIMEOUT_MS = 15_000

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
  execFileSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  })
}
