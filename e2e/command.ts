// Shared process boundary for Playwright fixtures.
//
// E2E setup must never rely on a shell command string: repo paths and branch
// names are dynamic, and an unbounded synchronous child can otherwise wedge an
// entire Playwright shard. Keep every Git/SQLite invocation parameterized,
// non-interactive, and covered by a hard deadline here.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** Run a non-shell CLI probe with the same hard deadline as every fixture command. */
export function runCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
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

// ---------------------------------------------------------------------------
// RFC-287 T11（G5）—— 用**真实远端**代替 `file://`。
//
// 为什么必须换：产品侧从此把 `file://` 判为非法参数（用户面不再支持从本地路径
// 直接跑任务）。而 e2e 全程走公共 HTTP 面，等于用户真实路径——它继续用 `file://`
// 就意味着「拒绝」这条规则在最像用户的那条通道上被绕过，锁也就成了摆设。
//
// 换成什么：统一 system-mocks 包里的 smart-HTTP CGI。globalSetup 只起一个网关，
// 每个 worker 通过环境变量拿到同一根 URL；请求日志与故障注入也因此覆盖 Git。
// ---------------------------------------------------------------------------

/** globalSetup 起服务后写进来的 URL；worker 进程从环境变量读。 */
const GIT_HTTP_BASE_ENV = 'AW_SYSTEM_MOCK_GIT_BASE_URL'

/** 服务根：所有夹具仓都在系统临时目录下。 */
function gitHttpRoot(): string {
  return realpathSync(tmpdir())
}

/**
 * 夹具仓的**可克隆远端 URL**。替代此前遍布各 spec 的 `pathToFileURL(repoPath).href`。
 *
 * 路径必须落在系统临时目录下（e2e 的夹具仓都是 `mkdtemp` 出来的）；不在的话直接
 * 抛错而不是悄悄退回 `file://`——退回去等于把这条规则又绕过一次。
 */
export function repoRemoteUrl(repoPath: string): string {
  const gitBaseUrl = process.env[GIT_HTTP_BASE_ENV]
  if (gitBaseUrl === undefined || gitBaseUrl.length === 0) {
    throw new Error(
      `repoRemoteUrl: ${GIT_HTTP_BASE_ENV} is unset — Playwright globalSetup must start system mocks`,
    )
  }
  const base = gitHttpRoot()
  const real = realpathSync(repoPath)
  if (!real.startsWith(base)) {
    throw new Error(
      `repoRemoteUrl: ${repoPath} is not under the git-daemon base path (${base}); ` +
        'e2e fixture repos must live in the system temp dir',
    )
  }
  const rel = real.slice(base.length).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${gitBaseUrl.replace(/\/$/, '')}/${rel}`
}
