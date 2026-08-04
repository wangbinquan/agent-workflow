// Shared process boundary for Playwright fixtures.
//
// E2E setup must never rely on a shell command string: repo paths and branch
// names are dynamic, and an unbounded synchronous child can otherwise wedge an
// entire Playwright shard. Keep every Git/SQLite invocation parameterized,
// non-interactive, and covered by a hard deadline here.

import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMAND_TIMEOUT_MS = 15_000

// THIS FILE IS LOADED BY NODE. Playwright runs the specs (and everything they
// import) on its own Node runner, so nothing here may import a `bun:` module or
// touch the `Bun` global — both exist only inside the Bun runtime, and the
// failure is not a graceful one: the suite dies at LOAD time, before a single
// test runs, with "Only URLs with a scheme in: file, data, and node are
// supported by the default ESM loader". Bun-only work goes in a child process
// (see `runSqlite`).
const SQLITE_EXEC = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sqlite-exec.ts')

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
  // RFC-254 T29 — Bun's embedded SQLite rather than the `sqlite3` CLI. Two
  // reasons, in order of importance:
  //
  //   1. The CLI is NOT on the windows-latest runner image (verified against
  //      the published software list), so every fixture that plants state this
  //      way would fail there. Bun ships SQLite in-process on every platform.
  //   2. It removes a system dependency whose default `busy_timeout = 0` was
  //      the direct cause of a nightly e2e flake: the daemon holds the write
  //      lock (its own connection sets 5 s), and the CLI would not wait for it.
  //
  // It runs in a Bun CHILD because this module itself is loaded by Node — see
  // the note at the top of the file. `bun` is already a hard prerequisite of
  // the repo, so this adds no dependency the suite did not already have.
  //
  // The SQL travels on stdin, not in argv: fixture statements embed repo paths
  // and branch names, and a command line is the wrong place for either.
  sqliteExec(['exec', dbPath], sql)
}

/**
 * Read rows out of a fixture database.
 *
 * Before RFC-254 T29 there was no way to do this: the helper could only execute
 * SQL, so a fixture that needed an answer back had to `SELECT writefile(...)` —
 * a function of the `sqlite3` CLI's fileio extension, not of SQLite — into a
 * temp file and parse it as TSV. That trick died with the CLI, and it should
 * have: results come back as rows now, and `params` are bound rather than
 * interpolated into the statement.
 */
export function querySqlite<T>(dbPath: string, sql: string, params: string[] = []): T[] {
  return JSON.parse(sqliteExec(['query', dbPath, ...params], sql)) as T[]
}

function sqliteExec(args: string[], sql: string): string {
  return execFileSync(process.env.AGENT_WORKFLOW_E2E_BUN ?? 'bun', ['run', SQLITE_EXEC, ...args], {
    encoding: 'utf8',
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
  })
}
