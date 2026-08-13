// Shared process boundary for Playwright fixtures.
//
// E2E setup must never rely on a shell command string: repo paths and branch
// names are dynamic, and an unbounded synchronous child can otherwise wedge an
// entire Playwright shard. Keep every Git/SQLite invocation parameterized,
// non-interactive, and covered by a hard deadline here.

import { execFileSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
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
// 换成什么：本机 `git daemon`（git 自带，三个 CI 平台都有），`--base-path` 指向
// 系统临时目录，URL 用相对路径，于是任何 mkdtemp 出来的夹具仓都能直接被服务，
// 不需要额外软链或搬运。`--enable=receive-pack` 让 commit&push 一类用例照跑。
//
// 每个 Playwright worker 是独立进程，各自起一个 daemon；端口随机挑并在冲突时重试，
// 进程退出时收尾。
// ---------------------------------------------------------------------------

/** globalSetup 起服务后写进来的端口；worker 进程从环境变量读。 */
const GIT_HTTP_PORT_ENV = 'AW_E2E_GIT_HTTP_PORT'
let gitHttpServer: Server | null = null

/** 服务根：所有夹具仓都在系统临时目录下。 */
function gitHttpRoot(): string {
  return realpathSync(tmpdir())
}

/**
 * 起一个把请求转给 `git http-backend`（CGI）的本机 HTTP 服务，**在 Playwright 的
 * globalSetup 里调用一次**，端口经环境变量下发给各 worker。
 *
 * 为什么是 smart HTTP 而不是别的：
 *   · `git://` **不在后端接受的 scheme 里**（只认 ssh/http/https/file + scp 形式），
 *     用它会被启动接口 422 挡掉——而「为了跑测试去放宽产品接受的 URL 形态」是
 *     capability 扩张，不能顺手做；
 *   · dumb HTTP（静态目录 + update-server-info）只支持 clone/fetch，而 commit&push
 *     一类用例要**推**到同一个 repoUrl 上，必须 receive-pack。
 * 用 `node:http` 而非 `Bun.serve`：e2e 跑在 Playwright 的 node 运行时里。
 *
 * ⚠️ **不要在起了本服务的那个进程里用同步 git 调用去访问它**（`execFileSync`
 * 克隆自己）：同步调用阻塞事件循环 → 服务永远响应不了 → 死锁（量延迟时实撞）。
 * e2e 里天然不触发——服务在 globalSetup 进程，git 跑在 worker 与 daemon 进程。
 *
 * 代价：相比 `file://`，每次克隆约 **+224ms**（本机实测 118ms → 342ms，主要是
 * 每请求 spawn 一个 CGI 进程）。换来的是 e2e 与真实用户走同一条协议路径。
 * 放在 globalSetup 而不是首次取 URL 时懒启动：`listen` 是异步的，而调用点遍布
 * 31 处同步表达式，懒启动要么把它们全改成 await，要么用同步等待阻塞事件循环
 * ——后者会让 listen 的回调永远发不出来（实撞）。
 */
export async function startGitHttpServer(): Promise<number> {
  const root = gitHttpRoot()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        // 夹具仓要能被推：http-backend 只在这个开关下放行 receive-pack。
        GIT_HTTP_RECEIVE_PACK: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
        REMOTE_USER: 'e2e',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    req.pipe(child.stdin)
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('close', () => {
      const out = Buffer.concat(chunks)
      // CGI：头部与正文以空行分隔；把头逐条搬到 HTTP 响应上。
      const crlf = out.indexOf('\r\n\r\n')
      const headEnd = crlf === -1 ? out.indexOf('\n\n') : crlf
      const sepLen = crlf === -1 ? 2 : 4
      if (headEnd === -1) {
        res.writeHead(500)
        res.end()
        return
      }
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of out.subarray(0, headEnd).toString('utf8').split(/\r?\n/)) {
        const idx = line.indexOf(':')
        if (idx <= 0) continue
        const k = line.slice(0, idx).trim()
        const v = line.slice(idx + 1).trim()
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200
        else headers[k] = v
      }
      res.writeHead(status, headers)
      res.end(out.subarray(headEnd + sepLen))
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    // 端口 0 = 让内核挑一个空闲的，省掉自己随机重试的那套。
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('git http server: unexpected address shape'))
        return
      }
      resolve(addr.port)
    })
  })
  gitHttpServer = server
  process.env[GIT_HTTP_PORT_ENV] = String(port)
  return port
}

/**
 * 夹具仓的**可克隆远端 URL**。替代此前遍布各 spec 的 `pathToFileURL(repoPath).href`。
 *
 * 路径必须落在系统临时目录下（e2e 的夹具仓都是 `mkdtemp` 出来的）；不在的话直接
 * 抛错而不是悄悄退回 `file://`——退回去等于把这条规则又绕过一次。
 */
export function repoRemoteUrl(repoPath: string): string {
  const port = process.env[GIT_HTTP_PORT_ENV]
  if (port === undefined || port.length === 0) {
    throw new Error(
      `repoRemoteUrl: ${GIT_HTTP_PORT_ENV} is unset — Playwright globalSetup must call startGitHttpServer()`,
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
  return `http://127.0.0.1:${port}/${rel}`
}

/** Playwright teardown 用；进程退出时也会兜底收。 */
export function stopGitHttpServer(): void {
  if (gitHttpServer === null) return
  gitHttpServer.close()
  gitHttpServer = null
  delete process.env[GIT_HTTP_PORT_ENV]
}

process.on('exit', stopGitHttpServer)
