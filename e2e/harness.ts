// Spawn the separately compiled agent-workflow e2e binary against a temp
// $AGENT_WORKFLOW_HOME for Playwright e2e (P-5-07).
//
// The binary serves both the API and the embedded frontend on the same
// origin — same shape as production — so the test browser only needs the
// daemon URL + token. No vite dev server, no CORS plumbing.
//
// Local: `bun run build:binary:e2e` first, then `bun run e2e`.
// CI:    the `e2e` job downloads the test-only artifact from `build-binary`.
//
// Note: this file runs in Playwright's Node runtime (not Bun), so it uses
// node:child_process rather than Bun.spawn.

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { captureRouteHits, harnessLogLevel } from './route-journal'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

export interface DaemonHandle {
  /** Base URL printed by the daemon, e.g. http://127.0.0.1:53212 — no trailing token / slash. */
  baseUrl: string
  /** Credential selected by authMode; a real administrator session by default. */
  token: string
  /**
   * One-time token printed by a fresh daemon. The default admin-session mode
   * retires it before returning; bootstrap mode deliberately leaves it active.
   * Ready-home restarts expose null because the daemon no longer prints it.
   */
  bootstrapToken: string | null
  /** Temp $AGENT_WORKFLOW_HOME for this session — wipes on teardown unless `keepHome=true`. */
  home: string
  /** Resolved path to the stub-opencode shim. */
  stubOpencode: string
  /** Stop the daemon and (unless `keepHome=true`) remove the temp home. */
  stop: () => Promise<void>
  /**
   * RFC-054 W1-3 — directly send a signal to the daemon child process.
   * Used by crash-recovery.spec.ts to SIGKILL mid-task (vs. the graceful
   * SIGTERM path that `stop()` walks). The promise resolves after the
   * child has actually exited (or after `fallbackTimeoutMs` SIGKILL
   * fallback; default 5s — bump to ≥ 35s when sending SIGTERM so the
   * 30s graceful-shutdown budget can complete).
   */
  killChild: (signal?: NodeJS.Signals, fallbackTimeoutMs?: number) => Promise<void>
  /**
   * RFC-254 T7 — ask the daemon to DRAIN, the way `agent-workflow stop` does.
   *
   * On POSIX this is SIGTERM, identical to `killChild('SIGTERM')`. On Windows
   * there is no SIGTERM: Node accepts the name but delivers `TerminateProcess`,
   * a hard kill, so a spec that asked for a graceful shutdown there would
   * silently be testing a crash instead — and would then assert the WRONG
   * terminal state. This routes through the loopback control endpoint on that
   * platform, which is what the product does.
   */
  requestGracefulShutdown: (timeoutMs?: number) => Promise<void>
  /** True if the home dir was provided externally (don't wipe on stop). */
  keepHome: boolean
}

export interface SpawnOptions {
  /**
   * Path to the agent-workflow binary. Defaults to
   * dist/agent-workflow-e2e-<plat>-<arch>.
   * If the file does not exist, harness throws — tell the engineer to build first.
   *
   * RFC-254 T32: may also be a COMMAND ARRAY (`[interpreter, script, …]`), in
   * which case element 0 is spawned and the rest are prepended to the daemon
   * args. Real runs always pass a single compiled artifact; the array form
   * exists for fixtures, which otherwise have to fabricate a fake executable —
   * and a `#!/usr/bin/env node` file is not executable on Windows, so those
   * fixtures failed there with `spawn EFTYPE`. Handing over argv instead of a
   * fake binary keeps the fixture platform-independent and never touches a
   * shell.
   */
  binary?: string | readonly string[]
  /**
   * Which behaviour the compiled stub should take. Defaults to `basic` (the
   * fixed-output stub used by main.spec.ts + review.spec.ts). Tests that need
   * round-driven behaviour (clarify.spec.ts) ask for `clarify`, and so on.
   */
  stubMode?: StubMode
  /**
   * Extra env vars merged into the daemon (and inherited by every opencode
   * subprocess). The clarify e2e uses CLARIFY_STUB_STATE +
   * CLARIFY_STUB_ASK_SHARDS to drive the round-driven stub.
   */
  extraEnv?: Record<string, string>
  /**
   * Test-local config fields merged over the harness defaults. Binding and
   * authentication-owned fields remain fixed by the harness.
   */
  configOverrides?: Record<string, unknown>
  /**
   * RFC-054 W1-3 — reuse an existing AGENT_WORKFLOW_HOME directory instead
   * of mkdtemp-ing a fresh one. Required for crash-recovery: kill daemon A,
   * spawn daemon B against the same home so the SQLite db + worktrees are
   * preserved. When set, `stop()` does NOT remove the directory.
   */
  home?: string
  /**
   * Ordinary browser tests auto-complete first-admin bootstrap and receive a
   * real administrator session. Bootstrap-specific tests can opt out and use
   * the fresh daemon credential directly.
   */
  authMode?: 'admin-session' | 'bootstrap'
  /**
   * `stub` (default) points both built-in runtime rows at the compiled,
   * deterministic stand-in. `live` points them at the supplied real CLIs and
   * never requires/loads the stub artifact. The latter is opt-in release
   * verification and may make real provider calls.
   */
  runtimeMode?: 'stub' | 'live'
  /** Runtime binaries used only when runtimeMode='live'. PATH names are valid. */
  runtimeBinaries?: { opencode?: string; claudeCode?: string }
  /** Optional model values written to the isolated runtime rows after boot. */
  runtimeModels?: { opencode?: string | null; claudeCode?: string | null }
}

// RFC-254 T26 — must stay in lockstep with scripts/build-binary.ts; the two are
// locked together by rfc224-e2e-compiled-seam.test.ts because a divergence here
// means the harness looks for an artifact the build never produced.
function platformSuffix(): string {
  const raw = process.platform
  const plat = raw === 'darwin' ? 'macos' : raw === 'win32' ? 'windows' : raw
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  return `${plat}-${arch}`
}

function executableExtension(): string {
  return process.platform === 'win32' ? '.exe' : ''
}

export function defaultBinaryPath(): string {
  if (process.env.AGENT_WORKFLOW_E2E_BINARY) return process.env.AGENT_WORKFLOW_E2E_BINARY
  return resolve(repoRoot, 'dist', `agent-workflow-e2e-${platformSuffix()}${executableExtension()}`)
}

/** Production artifact used by the opt-in pre-release live-runtime sweep. */
export function defaultProductionBinaryPath(): string {
  return resolve(repoRoot, 'dist', `agent-workflow-${platformSuffix()}${executableExtension()}`)
}

/**
 * RFC-254 T28b — the compiled e2e model stand-in.
 *
 * There is ONE artifact for every behaviour; `AW_STUB_MODE` selects between the
 * modes in `packages/system-mocks/src/runtime/`. It is compiled rather than scripted because
 * `opencodePath` has to name something the OS can execute, and Windows cannot
 * execute a `#!/bin/sh` file — nor a `.cmd` shim, which would hand the argv back
 * to cmd.exe to re-tokenize.
 */
export function defaultStubPath(): string {
  if (process.env.AGENT_WORKFLOW_E2E_STUB) return process.env.AGENT_WORKFLOW_E2E_STUB
  return resolve(repoRoot, 'dist', `stub-opencode-${platformSuffix()}${executableExtension()}`)
}

/** Behaviours the compiled stub can be asked for. Mirrors system-mocks runtime dispatch. */
export type StubMode =
  | 'basic'
  // RFC-306 — emits `<port … active="false">` on demand (see mode-branch.ts).
  | 'branch'
  | 'clarify'
  | 'clarify-inline'
  | 'commit'
  | 'cross-clarify'
  // RFC-310 — capability-aware digital employee Agent stand-in. The daemon,
  // execution kernel, workspace validator and delivery chain remain real.
  | 'development'
  // RFC-319 B28 —— 唯一能把一次融合推到「待审批」的模式：它同时留下改过的
  // 技能文件与 `.agent-workflow/fusion/result.json` 清单，审批面才有东西可看。
  | 'fusion'
  | 'intent'
  // RFC-326 — every declared port gets the same markup-rich design document
  // (title / inline code / repeated word / fenced code / HTML comment), so the
  // review-gate MCP + highlight e2e has a real document to anchor into.
  | 'review-doc'
  | 'runtime-scenario'
  | 'slow'
  | 'workflow-matrix'
  | 'business-workflows'
  | 'business-workgroups'
  | 'workgroup-matrix'

/** Compiled test-only entry for SCIP indexers and local MCP stdio. */
export function defaultSystemMockToolPath(): string {
  if (process.env.AGENT_WORKFLOW_E2E_SYSTEM_MOCK_TOOL)
    return process.env.AGENT_WORKFLOW_E2E_SYSTEM_MOCK_TOOL
  return resolve(repoRoot, 'dist', `system-mock-tool-${platformSuffix()}${executableExtension()}`)
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    // The name has to mean what it says now: the stub arrives via
    // `actions/download-artifact`, which does NOT preserve the +x bit (ci.yml
    // restores it explicitly). Checking only `isFile` would let a missing
    // `chmod` through, and the symptom would be EACCES deep inside the runner
    // instead of this function's actionable "run build:binary:e2e" message.
    // Windows has no execute bit; `X_OK` there is equivalent to `F_OK`.
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const DAEMON_START_ATTEMPTS = 3
const STARTUP_KILL_TIMEOUT_MS = 1_000
const CHILD_EXIT_GRACE_MS = 1_000
// Windows 上这个预算必须更宽：编译二进制每次启动都要把**嵌入的迁移**解包到
// `~/.agent-workflow/runtime/migrations`，代价是 O(迁移条数) 次文件写、且每一次都被
// AV 过滤器扫描。RFC-254 时 171 个文件就要 ~23.5s、把这条 30s 预算撑爆过一次；今天
// 迁移已经 209 条（解包 223 个文件），2026-08-25 主干实测同一分片里
// `extracted embedded migrations count=223 ms=26885 / 16959 / 16163`——27s 顶着 30s，
// 任何抖动都会变成「timed out after 30s waiting for daemon ready line」，而红的那几条
// 用例与提交者的改动毫无关系（本次是 rfc225 / rfc199 / rfc223 / rfc244 / rfc294 五份
// 互不相干的 spec 同时中枪）。
//
// 注意这不是「把超时调大掩盖慢」：解包本身已经按 RFC-254 优化过（目录一次性建好 +
// 有界并发），慢的是 Windows 的每文件 AV 扫描，产品侧没有更多可压的空间；而这段成本
// **随每条新迁移线性增长**，预算不跟着走就是一枚定时炸弹。POSIX 上解包只要 1~2s，
// 维持 30s 不变，好让真正的启动挂起仍然能被这条预算逮住。
const READY_TIMEOUT_MS = process.platform === 'win32' ? 90_000 : 30_000
const OUTPUT_TAIL_BYTES = 32 * 1024

type DaemonChild = ChildProcessByStdio<null, Readable, Readable>

function appendOutputTail(current: string, chunk: string): string {
  const next = current + chunk
  return next.length <= OUTPUT_TAIL_BYTES ? next : next.slice(-OUTPUT_TAIL_BYTES)
}

function isPortCollisionError(error: unknown): boolean {
  return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message)
}

/**
 * Wait for a child that has ALREADY been asked to exit by some other means.
 *
 * Split out of `signalChildAndWait` so the RFC-254 T7 control-endpoint path can
 * reuse the same waiting discipline without also sending a signal — on Windows
 * a signal is exactly what must not be sent.
 */
async function waitForChildExit(child: DaemonChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolveExit) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', finish)
      resolveExit()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) finish()
  })
}

/** The control endpoint a daemon publishes for `stop` (RFC-254 T7). */
function readControlEndpoint(path: string): { url: string; nonce: string } | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { url?: string; nonce?: string }
    if (typeof parsed.url !== 'string' || typeof parsed.nonce !== 'string') return null
    return { url: parsed.url, nonce: parsed.nonce }
  } catch {
    return null
  }
}

async function signalChildAndWait(
  child: DaemonChild,
  signal: NodeJS.Signals,
  fallbackTimeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolveExit) => {
    const timers: { fallback?: NodeJS.Timeout; hardStop?: NodeJS.Timeout } = {}
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timers.fallback !== undefined) clearTimeout(timers.fallback)
      if (timers.hardStop !== undefined) clearTimeout(timers.hardStop)
      child.off('exit', finish)
      resolveExit()
    }

    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) {
      finish()
      return
    }

    try {
      child.kill(signal)
    } catch {
      finish()
      return
    }

    if (settled) return
    timers.fallback = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        finish()
        return
      }
      // SIGKILL is asynchronous on Node's ChildProcess API. Wait briefly for
      // the exit event before allowing the caller to remove the child's home.
      timers.hardStop = setTimeout(finish, CHILD_EXIT_GRACE_MS)
    }, fallbackTimeoutMs)
  })
}

function removeOwnedHome(home: string, keepHome: boolean): void {
  if (keepHome) return
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // best-effort; startup/teardown must still report the original failure
  }
}

/**
 * RFC-319 —— 把 system-mock 的 npm registry 接进 daemon 的 npm 子进程。
 *
 * `services/pluginInstaller.ts` 装 npm / git 源插件时 spawn 的是**真的**
 * `npm install`，环境直接继承 daemon 进程的 `process.env`
 * （`pluginInstaller.ts` 的 `runCommand`）。globalSetup 早就把
 * `AW_SYSTEM_MOCK_NPM_REGISTRY_URL` 放进了 worker 的 env，但 npm 只认
 * `npm_config_*`——没有这一步翻译，任何走 npm 源的用例都会去打**真实的**
 * registry.npmjs.org：既是网络依赖，也让 CI 上的结果不可复现。
 *
 * 两个变量都只在 mock 套件在跑时才出现，所以没开 mock 的调用方（以及今天
 * 全部既有 spec——e2e 里没有任何一条会 spawn npm/npx）拿到的 env 逐字节不变。
 * cache 落在本次 daemon 的临时 home 里：既不污染开发机 / CI runner 的
 * `~/.npm`，也随 `removeOwnedHome` 一起清掉。
 */
function mockNpmRegistryEnv(home: string): Record<string, string> {
  const registry = process.env.AW_SYSTEM_MOCK_NPM_REGISTRY_URL
  if (registry === undefined || registry === '') return {}
  return { npm_config_registry: registry, npm_config_cache: join(home, '.npm-cache') }
}

interface ReadyDaemon {
  baseUrl: string
  bootstrapToken: string | null
}

async function waitForDaemonReady(child: DaemonChild): Promise<ReadyDaemon> {
  child.stderr.setEncoding('utf-8')
  child.stdout.setEncoding('utf-8')

  let stdoutTail = ''
  let stderrTail = ''
  const onStderr = (chunk: string): void => {
    stderrTail = appendOutputTail(stderrTail, chunk)
    if (process.env.E2E_VERBOSE) process.stderr.write(`[daemon stderr] ${chunk}`)
  }
  child.stderr.on('data', onStderr)
  child.stderr.on('error', () => {
    /* ignore */
  })

  return new Promise<ReadyDaemon>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectReady(
        new Error(
          `e2e/harness: timed out after ${READY_TIMEOUT_MS / 1_000}s waiting for daemon ready line\n` +
            `  stdout so far:\n${stdoutTail}\n  stderr so far:\n${stderrTail}`,
        ),
      )
    }, READY_TIMEOUT_MS)

    const onData = (chunk: string): void => {
      if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
      stdoutTail = appendOutputTail(stdoutTail, chunk)
      const match = stdoutTail.match(
        /agent-workflow ready[^\n]*\n\s+(https?:\/\/[^\s?]+)(?:\?token=([A-Za-z0-9]+))?\r?\n/,
      )
      if (match === null) return
      const baseUrl = match[1]
      if (baseUrl === undefined) return
      cleanup()
      resolveReady({
        baseUrl: baseUrl.replace(/\/$/, ''),
        bootstrapToken: match[2] ?? null,
      })
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      rejectReady(
        new Error(
          `e2e/harness: daemon closed with code ${code ?? 'null'} signal ${signal ?? 'null'} before printing ready line\n` +
            `  stdout: ${stdoutTail}\n  stderr: ${stderrTail}`,
        ),
      )
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectReady(
        new Error(`e2e/harness: failed to spawn daemon: ${error.message}`, { cause: error }),
      )
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
    }

    child.stdout.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

const E2E_ADMIN = {
  username: 'e2e_admin',
  displayName: 'E2E Administrator',
  // RFC-320 task admission freezes the creator's complete Git identity.
  // Keep the canonical browser actor launch-capable so task-seeding specs
  // exercise their own behavior instead of failing at the profile precondition.
  email: 'e2e-admin@example.com',
  password: 'E2EAdministrator123!',
} as const
const E2E_OPENCODE_MODEL = 'test/model'

async function authenticatedAdminToken(ready: ReadyDaemon): Promise<string> {
  if (ready.bootstrapToken !== null) {
    const bootstrap = await fetch(`${ready.baseUrl}/api/auth/bootstrap/admin`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ready.bootstrapToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(E2E_ADMIN),
    })
    if (!bootstrap.ok) {
      throw new Error(
        `e2e/harness: failed to create bootstrap administrator (${bootstrap.status}): ${await bootstrap.text()}`,
      )
    }
  }

  const login = await fetch(`${ready.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_ADMIN.username, password: E2E_ADMIN.password }),
  })
  if (!login.ok) {
    throw new Error(
      `e2e/harness: failed to login administrator (${login.status}): ${await login.text()}`,
    )
  }
  const body = (await login.json()) as { sessionToken?: unknown }
  if (typeof body.sessionToken !== 'string') {
    throw new Error('e2e/harness: administrator login returned no session token')
  }
  return body.sessionToken
}

async function seedRuntimeModel(
  ready: ReadyDaemon,
  token: string,
  runtime: 'opencode' | 'claude-code',
  model: string | null,
): Promise<void> {
  const response = await fetch(`${ready.baseUrl}/api/runtimes/${runtime}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model }),
  })
  if (!response.ok) {
    throw new Error(
      `e2e/harness: failed to seed runtime '${runtime}' (${response.status}): ${await response.text()}`,
    )
  }
}

/**
 * Resolve an ephemeral loopback port in the Node parent before spawning the
 * compiled Bun daemon. Bun 1.3.13 on macOS rejects `Bun.serve({ port: 0 })`
 * with EADDRINUSE, so passing zero through the config/CLI makes every browser
 * gate fail before a page opens. The socket is held until the port is known and
 * then closed immediately before spawn; each isolated daemon still receives a
 * fresh OS-selected port.
 */
async function allocateLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  })
  if (port === null) throw new Error('e2e/harness: failed to allocate a loopback port')
  return port
}

type PortAllocator = () => Promise<number>

async function startDaemonWithPortAllocator(
  opts: SpawnOptions,
  portAllocator: PortAllocator,
): Promise<DaemonHandle> {
  const binarySpec = opts.binary ?? defaultBinaryPath()
  // Element 0 is what gets spawned and what must be executable; any remaining
  // elements are argv the daemon args are appended to (see SpawnOptions.binary).
  const binaryCmd: readonly string[] = typeof binarySpec === 'string' ? [binarySpec] : binarySpec
  const binary = binaryCmd[0] ?? ''
  const binaryPrefixArgs = binaryCmd.slice(1)
  if (!isExecutableFile(binary)) {
    throw new Error(
      `e2e/harness: binary not found at ${binary}\n` +
        `  Run \`bun run build:binary:e2e\` to produce it, or set AGENT_WORKFLOW_E2E_BINARY.`,
    )
  }

  const runtimeMode = opts.runtimeMode ?? 'stub'
  const stubOpencode =
    runtimeMode === 'stub' ? defaultStubPath() : (opts.runtimeBinaries?.opencode ?? 'opencode')
  const claudeCodeBinary =
    runtimeMode === 'stub' ? stubOpencode : (opts.runtimeBinaries?.claudeCode ?? 'claude')
  if (runtimeMode === 'stub' && !isExecutableFile(stubOpencode)) {
    throw new Error(
      `e2e/harness: compiled stub-opencode not found at ${stubOpencode}\n` +
        `  Run \`bun run build:binary:e2e\` to produce it, or set AGENT_WORKFLOW_E2E_STUB.`,
    )
  }
  const stubMode: StubMode = opts.stubMode ?? 'basic'

  // RFC-054 W1-3 — accept an existing home so the crash-recovery spec can
  // SIGKILL daemon A and spawn daemon B against the same SQLite + worktrees.
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'aw-e2e-'))
  const keepHome = opts.home !== undefined
  let child: DaemonChild | undefined

  try {
    mkdirSync(home, { recursive: true })
    const configPath = join(home, 'config.json')

    for (let attempt = 1; attempt <= DAEMON_START_ATTEMPTS; attempt += 1) {
      const bindPort = await portAllocator()

      // Pre-seed config.json so the daemon picks the stub binary on its
      // version-probe path — no PATH gymnastics required. Re-write it on each
      // retry because a port may be claimed after the probe socket is closed.
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            $schema_version: 1,
            maxConcurrentNodes: 4,
            multiProcessSubprocessConcurrency: 4,
            defaultPerTaskMaxDurationMs: 60 * 60 * 1000,
            defaultPerTaskMaxTotalTokens: 0,
            defaultPerNodeTimeoutMs: 30 * 60 * 1000,
            worktreeAutoGc: { enabled: false },
            eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
            largeOutputThresholdBytes: 1_048_576,
            ...(opts.configOverrides ?? {}),
            // Explicit harness runtime selection is authoritative. A broad
            // configOverrides fixture must not accidentally turn a declared
            // stub run into a provider call (or vice versa).
            opencodePath: stubOpencode,
            claudeCodePath: claudeCodeBinary,
            bindHost: '127.0.0.1',
            bindPort,
            language: 'en-US',
            theme: 'light',
            // RFC-319 R1：只有开了 `AW_E2E_ROUTE_JOURNAL` 才提到 debug，
            // 否则与今天逐字节相同。start.ts:375-378 的
            // `if (config.logLevel !== 'info')` 决定了写非 info 才会改级别。
            logLevel: harnessLogLevel(),
          },
          null,
          2,
        ),
        'utf-8',
      )

      const attemptChild: DaemonChild = spawn(
        binary,
        [...binaryPrefixArgs, 'start', '--host', '127.0.0.1', '--port', String(bindPort)],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            AGENT_WORKFLOW_HOME: home,
            LANG: 'en_US.UTF-8',
            ...mockNpmRegistryEnv(home),
            ...(opts.extraEnv ?? {}),
            // LAST, so it wins. Placed first it was overridable by `extraEnv`,
            // which is the one remaining way to run a different stub than the
            // one the spec declared — and unlike `dispatch.ts`'s unknown-mode
            // check, that failure is silent.
            ...(runtimeMode === 'stub' ? { AW_STUB_MODE: stubMode } : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      child = attemptChild

      try {
        const ready = await waitForDaemonReady(attemptChild)

        const token =
          opts.authMode === 'bootstrap'
            ? ready.bootstrapToken
            : await authenticatedAdminToken(ready)
        if (token === null) {
          throw new Error('e2e/harness: bootstrap auth requested for an already-initialized home')
        }
        if (opts.authMode !== 'bootstrap') {
          if (runtimeMode === 'stub') {
            await seedRuntimeModel(ready, token, 'opencode', E2E_OPENCODE_MODEL)
          }
          if (opts.runtimeModels?.opencode !== undefined) {
            await seedRuntimeModel(ready, token, 'opencode', opts.runtimeModels.opencode)
          }
          if (opts.runtimeModels?.claudeCode !== undefined) {
            await seedRuntimeModel(ready, token, 'claude-code', opts.runtimeModels.claudeCode)
          }
        }

        // Keep draining stdout so the child never blocks on a full pipe.
        attemptChild.stdout.on('data', (chunk: string) => {
          if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
        })

        const startedChild = attemptChild
        const stop = async (): Promise<void> => {
          await signalChildAndWait(startedChild, 'SIGTERM', 5_000)
          // RFC-319 R1：必须排在 removeOwnedHome 之前——日志就在那个 home 里。
          // 未开启采集时是一个 env 判断后立即返回的空操作。
          captureRouteHits(home)
          removeOwnedHome(home, keepHome)
        }

        // RFC-054 W1-3 — direct signal helper for crash-recovery spec. Sends
        // `signal` (default SIGKILL) and waits for the child to exit. Pass
        // ≥ 35s with SIGTERM when the daemon's 30s graceful budget must run.
        const requestGracefulShutdown = async (timeoutMs = 35_000): Promise<void> => {
          if (process.platform !== 'win32') {
            await signalChildAndWait(startedChild, 'SIGTERM', timeoutMs)
            return
          }
          const control = readControlEndpoint(join(home, '.daemon.control'))
          if (control === null) {
            throw new Error(
              `e2e/harness: no control endpoint under ${home}. On Windows a graceful ` +
                `shutdown cannot be requested with a signal, so this spec cannot run ` +
                `against a daemon that did not publish one (RFC-254 T7).`,
            )
          }
          const response = await fetch(`${control.url}/shutdown`, {
            method: 'POST',
            headers: { 'x-agent-workflow-control': control.nonce },
          })
          if (response.status !== 202) {
            throw new Error(`e2e/harness: control shutdown refused (${response.status})`)
          }
          await waitForChildExit(startedChild, timeoutMs)
        }
        const killChild = async (
          signal: NodeJS.Signals = 'SIGKILL',
          fallbackTimeoutMs: number = 5_000,
        ): Promise<void> => signalChildAndWait(startedChild, signal, fallbackTimeoutMs)

        return {
          baseUrl: ready.baseUrl,
          token,
          bootstrapToken: ready.bootstrapToken,
          home,
          stubOpencode,
          stop,
          killChild,
          requestGracefulShutdown,
          keepHome,
        }
      } catch (error) {
        await signalChildAndWait(attemptChild, 'SIGKILL', STARTUP_KILL_TIMEOUT_MS)
        child = undefined
        if (attempt < DAEMON_START_ATTEMPTS && isPortCollisionError(error)) continue
        throw error
      }
    }

    throw new Error(`e2e/harness: exhausted ${DAEMON_START_ATTEMPTS} daemon start attempts`)
  } catch (error) {
    if (child !== undefined) {
      await signalChildAndWait(child, 'SIGKILL', STARTUP_KILL_TIMEOUT_MS)
    }
    removeOwnedHome(home, keepHome)
    throw error
  }
}

export async function startDaemon(opts: SpawnOptions = {}): Promise<DaemonHandle> {
  return startDaemonWithPortAllocator(opts, allocateLoopbackPort)
}

/** Test-only seam: lifecycle tests inject deterministic ports without binding sockets. */
export const harnessTestApi = {
  e2eAdmin: E2E_ADMIN,
  startDaemonWithPortAllocator,
}
