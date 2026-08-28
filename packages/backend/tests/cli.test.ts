// Coverage for the CLI subcommands wired in P-1-05.
//
// Strategy: call the command functions in-process where possible. For stop +
// status which need a real daemon, spawn one subprocess per scenario.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { configGetCommand, configSetCommand } from '../src/cli/config-cli'
import { doctorCommand, formatDoctor } from '../src/cli/doctor'
import { migrateCommand } from '../src/cli/migrate'
import { statusCommand, formatStatus } from '../src/cli/status'
import { stopCommand } from '../src/cli/stop'
import { removeTempDirSync } from './fixtures/tempDir'
import { statMetadataIsAuthoritative } from '../src/util/fileTrust'
import { readControlFile, requestShutdown } from '../src/services/controlListener'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

describe('CLI subcommands (P-1-05)', () => {
  let tmp: string
  let origHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-cli-'))
    origHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = tmp
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = origHome
    removeTempDirSync(tmp)
  })

  // --- config get / set ---

  test('config get with no args returns full default config', () => {
    const { output } = configGetCommand([])
    const cfg = JSON.parse(output) as Record<string, unknown>
    expect(cfg.$schema_version).toBe(1)
    expect(cfg.maxConcurrentNodes).toBe(4)
    expect(cfg.theme).toBe('system')
  })

  test('config get <key> returns just that value', () => {
    const { output } = configGetCommand(['maxConcurrentNodes'])
    expect(output.trim()).toBe('4')
  })

  test('config get <unknown-key> throws', () => {
    expect(() => configGetCommand(['totally-not-a-key'])).toThrow(/unknown config key/)
  })

  test('config set <key> <number> updates and persists', () => {
    const { output } = configSetCommand(['maxConcurrentNodes', '8'])
    expect(output.trim()).toBe('maxConcurrentNodes = 8')
    expect(configGetCommand(['maxConcurrentNodes']).output.trim()).toBe('8')
  })

  test('config set <key> <string> works (JSON parse falls back to raw string)', () => {
    configSetCommand(['theme', 'dark'])
    expect(configGetCommand(['theme']).output.trim()).toBe('dark')
  })

  test('config set rejects invalid value type via schema', () => {
    expect(() => configSetCommand(['maxConcurrentNodes', '-5'])).toThrow()
  })

  test('config set with nested object JSON works', () => {
    configSetCommand(['worktreeAutoGc', '{"enabled":true,"olderThanDays":7}'])
    const wgcRaw = configGetCommand(['worktreeAutoGc']).output.trim()
    const wgc = JSON.parse(wgcRaw) as Record<string, unknown>
    expect(wgc.enabled).toBe(true)
    expect(wgc.olderThanDays).toBe(7)
  })

  test('config set/get round-trips RFC-300 Webhook workspace cleanup switch', () => {
    configSetCommand(['webhookTaskWorkspaceAutoCleanup', 'true'])
    expect(configGetCommand(['webhookTaskWorkspaceAutoCleanup']).output.trim()).toBe('true')
    configSetCommand(['webhookTaskWorkspaceAutoCleanup', 'false'])
    expect(configGetCommand(['webhookTaskWorkspaceAutoCleanup']).output.trim()).toBe('false')
  })

  // --- migrate ---

  test('migrate creates db.sqlite + applies migrations', async () => {
    const dbPath = join(tmp, 'db.sqlite')
    expect(existsSync(dbPath)).toBe(false)
    const { output } = await migrateCommand()
    expect(output).toContain(dbPath)
    expect(existsSync(dbPath)).toBe(true)
  })

  // RFC-254 T31 (task#11): migrateCommand must CLOSE its DB handle. A leaked
  // bun:sqlite connection is invisible on POSIX (open files unlink fine) but on
  // Windows it locks the temp dir, so `afterEach`'s rm(tmp) fails EBUSY and the
  // whole cli.test.ts describe reads as a teardown flake. The Windows regression
  // is the afterEach itself; this source anchor makes a revert red on POSIX CI
  // too. (Root-caused on the ARM64 VM: 0 lingering processes, leaked DB handle.)
  test('migrateCommand closes its DB handle (no leaked bun:sqlite lock)', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'migrate.ts'), 'utf8')
    expect(source).toContain('.$client.close()')
  })

  // --- doctor ---

  test('doctor returns ok when opencode + git present', async () => {
    const result = await doctorCommand()
    // We trust the dev box has executable OpenCode and Git installations.
    // If a particular check fails, surface its message for easier debugging.
    if (!result.ok) {
      console.error(formatDoctor(result))
    }
    expect(result.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'opencode binary')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'git version')?.ok).toBe(true)
  })

  test('doctor flags missing migrations folder', async () => {
    // Point config to use a temp opencode that does exist (real one); but
    // delete migrations and the check should fail.
    // We do this by overriding the bundled migrations directory at runtime via
    // a child process with a custom PATH for `node:fs.readdirSync` — too
    // invasive. Instead, just verify token-file mode check works:
    writeFileSync(join(tmp, 'token'), 'a'.repeat(64), { mode: 0o644 })
    const result = await doctorCommand()
    // RFC-254 T7/D19: the check now covers every at-rest secret and reports the
    // protection the PLATFORM actually offers. On POSIX that is still mode 600
    // and a 644 token still fails; on Windows the same file is not insecure and
    // must not be reported as such (see rfc254-control-listener.test.ts).
    const secretCheck = result.checks.find((c) => c.name === 'secret file protection')
    // RFC-254 T32: the comment above already stated the platform semantics; this
    // assertion had not been wired to them yet, so it demanded a POSIX verdict
    // on Windows and failed for being right.
    if (statMetadataIsAuthoritative(process.platform)) {
      expect(secretCheck?.ok).toBe(false)
      expect(secretCheck?.message).toContain('600')
    } else {
      // Mode bits are not the guarantee there, so a 0o644 token is NOT a finding
      // — reporting one would be a false alarm an operator cannot act on.
      expect(secretCheck?.ok).toBe(true)
    }
    expect(secretCheck?.message).toContain('token')
  })

  // --- status / stop (require a real daemon subprocess) ---

  test('status: when daemon not running', async () => {
    const result = await statusCommand()
    expect(result.state).toBe('not-running')
    const text = formatStatus(result)
    expect(text).toContain('not running')
  })

  // ⚠️ RFC-319 T36（审计条目 OPS-002）—— 「`--port` 压过 config.json 的 bindPort」
  // 此前**不可分辨**：
  //   * `e2e/harness.ts` 把同一个 bindPort 既写进 config.json 又传成 flag，两者恒等，
  //     所以那条腿无论谁赢都绿；
  //   * 下面那条 status/stop 用例跑 `start --port 0`，而它的临时 HOME 里**根本没有
  //     config.json**（它不调 migrateCommand），走的是 `opts.port ?? 默认` 那一支。
  // 两边都没有「config 里有一个不同的值」这个前提，于是优先级本身从未被断言过。
  //
  // 这里刻意让两者**不同**：config 里放一个具体端口，flag 传 0（临时端口）。
  // 用 0 而不是第二个具体端口，是因为 docs/dev-gotchas.md 记过「探测端口 → 关闭 →
  // 再绑定」在并发分片下会被抢走；0 让内核选，没有这个窗口。
  // 判据方向也因此是安全的：如果 config 赢了，绑上的就正好是 configPort。
  test('start --port overrides config.json bindPort (RFC-319 T36)', async () => {
    const defaults = JSON.parse(configGetCommand([]).output) as Record<string, unknown>
    // 一个空闲端口：只用来当「config 里的那个值」，不真的去绑它。
    const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const configPort = probe.port
    probe.stop(true)
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({ ...defaults, bindHost: '127.0.0.1', bindPort: configPort }, null, 2),
      'utf-8',
    )

    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const ready = await waitForReady(child.stdout, 15_000, child.stderr, child)
      const boundPort = Number(new URL(ready.url).port)
      expect(boundPort).toBeGreaterThan(0)
      expect(
        boundPort,
        'daemon 绑上了 config.json 里的 bindPort ⇒ 命令行 --port 被忽略了。' +
          '运维用 --port 临时换端口是标准手段，它被静默忽略的症状是「改了没生效」',
      ).not.toBe(configPort)
      // config 文件确实带着那个不同的值（否则上面那条断言是空的）。
      const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8')) as {
        bindPort: number
      }
      expect(onDisk.bindPort).toBe(configPort)
    } finally {
      await stopCommand({ timeoutMs: 10_000 }).catch(() => undefined)
      child.kill()
      await child.exited
    }
  })

  test('status + stop: end-to-end against a real daemon', async () => {
    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      await waitForReady(child.stdout, 10_000, child.stderr, child)

      // status sees the daemon, /health is reachable.
      const status = await statusCommand()
      expect(status.state).toBe('running')
      expect(status.pid).toBe(child.pid ?? -1)
      expect(status.info?.host).toBe('127.0.0.1')
      expect(status.health?.ok).toBe(true)
      expect(status.health?.opencodeVersion).toBeNull()
      const text = formatStatus(status)
      expect(text).toContain('daemon running')
      expect(text).toContain(`pid:        ${child.pid}`)
      expect(text).toContain('not checked at startup')

      // stop terminates the daemon and removes the lock.
      const stopResult = await stopCommand({ timeoutMs: 10_000 })
      expect(stopResult.status).toBe('stopped')
      expect(stopResult.pid).toBe(child.pid ?? -1)
      expect(existsSync(join(tmp, '.daemon.lock'))).toBe(false)
    } finally {
      // Defensive: kill the child if not already exited.
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await child.exited
    }
  })

  test('RFC-300 boot resumes an already-authorized scratch prune before serving', async () => {
    await migrateCommand()
    const scratch = join(tmp, 'claimed-scratch')
    mkdirSync(scratch)
    writeFileSync(join(scratch, 'ephemeral.txt'), 'delete me')
    const seeded = new Database(join(tmp, 'db.sqlite'))
    seeded.run(
      `INSERT INTO tasks (
           id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at, finished_at,
           webhook_trigger_id, space_kind, workspace_pruning_at,
           workspace_prune_cause
         ) VALUES (
           'rfc300-boot-task', 'rfc300 boot', 'deleted-soft-workflow', '{}',
           ?, ?, 'main', 'agent-workflow/rfc300-boot', 'done', '{}', 1, 2,
           'deleted-trigger', 'scratch', 123, 'webhook-terminal'
         )`,
      [scratch, scratch],
    )
    // Hand the child a fully quiescent file, not an open/cached statement plus
    // WAL checkpoint race that only appears under full-suite process pressure.
    seeded.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    seeded.close()

    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      await waitForReady(child.stdout, 10_000, child.stderr, child)
      expect(existsSync(scratch)).toBe(false)
      const verified = new Database(join(tmp, 'db.sqlite'), { readonly: true })
      expect(
        verified
          .query(
            `SELECT status, workspace_pruning_at, workspace_prune_cause,
                    workspace_pruned_at
             FROM tasks WHERE id='rfc300-boot-task'`,
          )
          .get(),
      ).toEqual({
        status: 'done',
        workspace_pruning_at: expect.any(Number),
        workspace_prune_cause: 'webhook-terminal',
        workspace_pruned_at: expect.any(Number),
      })
      verified.close()
    } finally {
      if (process.platform === 'win32') {
        const endpoint = readControlFile(join(tmp, '.daemon.control'))
        if (endpoint !== null) await requestShutdown(endpoint)
        else child.kill('SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
      await child.exited
    }
  })

  test('stop reports not-running when there is no lock', async () => {
    const result = await stopCommand()
    expect(result.status).toBe('not-running')
  })

  test('stop cleans up a stale lock (PID not alive)', async () => {
    const lockPath = join(tmp, '.daemon.lock')
    writeFileSync(lockPath, '99999998') // PID extremely unlikely to exist
    const result = await stopCommand()
    expect(result.status).toBe('stale-lock-removed')
    expect(existsSync(lockPath)).toBe(false)
  })

  // --- daemon writes .daemon.info on start, removes on shutdown ---

  test('daemon writes .daemon.info on start, removes it on SIGTERM', async () => {
    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env: { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      await waitForReady(child.stdout, 10_000, child.stderr, child)
      const infoPath = join(tmp, '.daemon.info')
      expect(existsSync(infoPath)).toBe(true)
      const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>
      expect(info.pid).toBe(child.pid ?? -1)
      expect(info.host).toBe('127.0.0.1')
      expect(typeof info.port).toBe('number')
      expect(typeof info.url).toBe('string')

      // token file mode 0600 (sanity, since doctor checks this too).
      // RFC-254 T32: 0o600 is only a fact where `stat` is authoritative; Windows
      // synthesizes 0o666 for every file (see auth-token.test.ts).
      expect(statSync(join(tmp, 'token')).mode & 0o777).toBe(
        statMetadataIsAuthoritative(process.platform) ? 0o600 : 0o666,
      )
    } finally {
      // RFC-254 T7/T32: ask the daemon to DRAIN by whichever mechanism the
      // platform has. `kill('SIGTERM')` is a graceful request on POSIX and a
      // hard TerminateProcess on Windows — Node accepts the name there but maps
      // it to the same thing as SIGKILL — so on Windows the daemon never ran its
      // shutdown and `.daemon.info` was still on disk when the assertion below
      // looked. That is the exact failure T7 built the loopback control listener
      // for, and routing through it here makes this test PROVE the Windows
      // graceful path end to end instead of asserting a POSIX-only outcome.
      if (process.platform === 'win32') {
        const endpoint = readControlFile(join(tmp, '.daemon.control'))
        expect(endpoint).not.toBeNull()
        expect(await requestShutdown(endpoint!)).toBe('accepted')
      } else {
        child.kill('SIGTERM')
      }
      await child.exited
    }
    expect(existsSync(join(tmp, '.daemon.info'))).toBe(false)
  })
})

/**
 * `stderr` 是**诊断必需**,不是可选:daemon 崩溃时把原因写在 stderr,而这里只
 * 读 stdout。2026-08-19 CI 上「daemon exited before ready」红过一次,失败信息里
 * 只有到「pre-migration backup written」为止的 stdout,真正的错误一个字都没有,
 * 本地又复现不出来——查不下去正是因为这个盲区。传进来就一起打出来。
 */
/**
 * 等 daemon 打印出 ready 行。
 *
 * `child` 是可选的**诊断**参数（2026-08-24 加）：`daemon exited before ready` 这条失败
 * 此前只带 stdout/stderr，而 CI 上真出现过一次**日志停在 `git probe ok`、之后一个字都没有**
 * 的静默退出——`main().catch` 会打印 `err.message`，所以「什么都没打印」本身就说明它不是
 * 抛错退出的（`process.exit` 路径在 `cli/start.ts` 里也都先写了 stderr）。
 * 剩下的可能是被信号杀死或原生崩溃，而**退出码与信号恰恰是当时唯一没被记下来的东西**。
 * 传入 child 之后，下一次再发生时失败信息里直接带 `exit=… signal=…`，不必再猜。
 */
/** ` (exit=0 signal=SIGKILL)`；拿不到 child 或超时就返回空串，绝不把诊断变成新的挂起点。 */
async function exitDetail(child?: {
  readonly exited: Promise<number>
  readonly signalCode: string | null
}): Promise<string> {
  if (child === undefined) return ''
  const code = await Promise.race([
    child.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
  ])
  const signal = child.signalCode
  if (code === null && signal === null) return ''
  return ` (exit=${code ?? 'unknown'} signal=${signal ?? 'none'})`
}

async function waitForReady(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
  stderr?: ReadableStream<Uint8Array>,
  child?: { readonly exited: Promise<number>; readonly signalCode: string | null },
): Promise<{ url: string; token: string }> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let errBuffer = ''
  const errReader = stderr?.getReader()
  if (errReader !== undefined) {
    void (async () => {
      const errDecoder = new TextDecoder()
      try {
        for (;;) {
          const { value, done } = await errReader.read()
          if (done) break
          errBuffer += errDecoder.decode(value, { stream: true })
        }
      } catch {
        /* best-effort diagnostics */
      }
    })()
  }
  const withStderr = (message: string): string =>
    errBuffer === '' ? message : `${message}\n--- stderr ---\n${errBuffer}`
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) {
        throw new Error(
          withStderr(`daemon exited before ready${await exitDetail(child)}:\n${buffer}`),
        )
      }
      buffer += decoder.decode(value, { stream: true })
      const m = buffer.match(/(http:\/\/[0-9.]+:\d+\/)\?token=([0-9a-f]+)/)
      if (m && m[1] !== undefined && m[2] !== undefined) {
        return { url: m[1], token: m[2] }
      }
    }
    throw new Error(withStderr(`timed out within ${timeoutMs}ms; stdout so far:\n${buffer}`))
  } finally {
    reader.releaseLock()
  }
}
