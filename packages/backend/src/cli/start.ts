// `agent-workflow start` — daemon foreground entry.

import { createSecretBox } from '@/auth/secretBox'
import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { openDb } from '@/db/client'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { createApp } from '@/server'
import { startLimitsTicker } from '@/services/limits'
import { reapOrphanRuns } from '@/services/orphans'
import { startEventsArchiver } from '@/services/eventsArchive'
import { startWorktreeGc } from '@/services/gc'
import { startBatchImportGc } from '@/services/repoBatchImport'
import {
  setMemoryDistillLangProvider,
  startMemoryDistillLoop,
} from '@/services/memoryDistillScheduler'
import { acquireLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import {
  MAX_OPENCODE_VERSION_EXCLUSIVE,
  MIN_OPENCODE_VERSION,
  probeOpencode,
} from '@/util/opencode'
import { Paths } from '@/util/paths'
import { buildWebSocketAdapter } from '@/ws/server'
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface StartOptions {
  port?: number
  host?: string
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
  // 1. Logger — must come before lock so failures land in stdout/file.
  configureLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    logFile: Paths.daemonLog,
  })
  const log = createLogger('daemon')

  // 2. Single-instance lock.
  let lock: Lock
  try {
    lock = acquireLock(Paths.lock)
  } catch (err) {
    if (err instanceof DaemonLockHeldError) {
      log.error('another daemon is already running', { pid: err.pid, lock: err.lockPath })
      console.error(
        `agent-workflow: another daemon is already running (PID ${err.pid})\n` +
          `  lock file: ${err.lockPath}\n` +
          `  if it is stale, remove the lock file manually and try again`,
      )
      process.exit(1)
    }
    throw err
  }
  log.info('lock acquired', { pid: lock.pid, lock: lock.path })

  // 3. Load config; honor logLevel if user set non-default in config.
  const config = loadConfig(Paths.config)
  if (config.logLevel !== 'info') {
    configureLogger({ level: config.logLevel })
  }
  log.info('config loaded', { path: Paths.config, language: config.language, theme: config.theme })

  // 4. opencode version probe — daemon refuses to start on incompatible version.
  const probe = await probeOpencode(config.opencodePath)
  if (probe.version === null) {
    log.error('opencode binary not found or unreadable', { binary: probe.binary })
    console.error(
      `agent-workflow: cannot execute "${probe.binary}".\n` +
        `  install opencode (>=${MIN_OPENCODE_VERSION}) and ensure it is on PATH,\n` +
        `  or set 'opencodePath' in ${Paths.config}.`,
    )
    lock.release()
    process.exit(1)
  }
  if (!probe.compatible) {
    log.error('opencode incompatible', {
      found: probe.version,
      requiredRange: `${MIN_OPENCODE_VERSION}..<${MAX_OPENCODE_VERSION_EXCLUSIVE}`,
      reason: probe.incompatibleReason,
    })
    console.error(
      `agent-workflow: opencode ${probe.version} is incompatible.\n` +
        `  required range: ${MIN_OPENCODE_VERSION} <= version < ${MAX_OPENCODE_VERSION_EXCLUSIVE}\n` +
        `  reason: ${probe.incompatibleReason ?? 'unknown'}\n` +
        `  to recover: \`npm install -g opencode-ai@1.15.5\` (or any 1.14.x / 1.15.x) or set 'opencodePath' in ${Paths.config}.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('opencode probe ok', { version: probe.version, binary: probe.binary })

  // 5. DB — open + apply migrations. dbVersion = number of SQL files in the
  // bundled migrations folder (== the highest version we've applied, since
  // openDb() applies all pending migrations on startup).
  //
  // P-5-05: in the compiled single-binary, the .sql files + meta/_journal.json
  // live inside the executable. drizzle's migrator needs a filesystem path,
  // so we extract them once per start into ~/.agent-workflow/runtime/migrations
  // and point the migrator there.
  let migrationsFolder = Paths.migrationsDir
  if (IS_EMBEDDED) {
    migrationsFolder = join(Paths.root, 'runtime', 'migrations')
    const extracted = await extractMigrationsTo(migrationsFolder)
    log.info('extracted embedded migrations', { count: extracted, dir: migrationsFolder })
  }
  const db = openDb({ path: Paths.db, migrationsFolder })
  const dbVersion = existsSync(migrationsFolder)
    ? readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql')).length
    : 0
  log.info('db ready', { path: Paths.db, dbVersion })

  // RFC-036 bootstrap hint: if no real user has been created yet, log a
  // one-shot pointer to the CLI so admins know how to leave single-user mode.
  try {
    const { countNonSystemUsers } = await import('@/services/users')
    if ((await countNonSystemUsers(db)) === 0) {
      log.info(
        'first multi-user run? create your admin via `agent-workflow user create --admin --username <name>`',
      )
    }
  } catch {
    /* users service may not be available in degraded mode; ignore */
  }

  // 5b. P-4-07: reap orphan runs from the previous (crashed/SIGKILLed) daemon
  // process. Any task/node_run left in 'running' is flipped to 'interrupted'
  // with task.error_message = 'daemon-restart' so the UI surfaces what
  // happened.
  try {
    const reap = await reapOrphanRuns(db)
    if (reap.tasks > 0 || reap.runs > 0) {
      log.warn('reaped orphan runs from previous daemon', {
        tasks: reap.tasks,
        runs: reap.runs,
      })
    }
  } catch (err) {
    log.warn('orphan reap failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // 5c. RFC-017: reconcile registered skill_sources up-front so the first
  // /api/skills hit (likely the SPA's skills query) sees the current set of
  // child skills. Per-source failures are already swallowed into
  // lastScanError; never abort daemon start on them.
  try {
    const { reconcileAllSources } = await import('@/services/skill-source')
    await reconcileAllSources(db)
  } catch (err) {
    log.warn('skill-source reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 6. Token (generate-on-first-run, chmod 600).
  const token = ensureTokenFile(Paths.tokenFile)
  log.info('token ready', { tokenFile: Paths.tokenFile })

  // 6b. RFC-036 secret box (generate-on-first-run, chmod 600). Used to seal
  // OIDC client_secret values at rest. Losing the file makes every
  // previously-stored secret unreadable — flag it in backup docs.
  const secretBox = createSecretBox(Paths.secretKeyFile)
  log.info('secret box ready', { keyFile: Paths.secretKeyFile })

  // 7. HTTP server.
  const app = createApp({
    token,
    configPath: Paths.config,
    opencodeVersion: probe.version,
    dbVersion,
    db,
    secretBox,
  })

  const bindHost = opts.host ?? config.bindHost
  const bindPort = opts.port ?? config.bindPort ?? 0
  const ws = buildWebSocketAdapter({ daemonToken: token, db })
  const server = Bun.serve({
    port: bindPort,
    hostname: bindHost,
    // Bun's default idleTimeout is 10s — far too short for endpoints that
    // synchronously await `npm install` (POST /api/plugins/:id/check-update
    // and /upgrade can legitimately block for up to
    // DEFAULT_INSTALL_TIMEOUT_MS = 60s). When the inbound socket is idle
    // longer than the timeout Bun closes it, the daemon's response never
    // reaches the client, and Vite surfaces "socket hang up" while the npm
    // child keeps running orphaned. 255s is Bun's hard maximum and gives
    // ~4× headroom over the install ceiling without changing endpoint
    // semantics. See tests/cli-start-idle-timeout.test.ts.
    idleTimeout: 255,
    async fetch(req: Request, srv): Promise<Response> {
      // `tryUpgrade` is async because RFC-036 token resolution may need a
      // DB round-trip to validate a session token / PAT. The Bun fetch
      // handler natively accepts a Promise<Response> so awaiting here keeps
      // upgrade ordering deterministic (upgrade decision happens before
      // any Hono route runs).
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return await app.fetch(req)
      return upgraded
    },
    websocket: ws.handlers,
  })

  const baseUrl = `http://${server.hostname}:${server.port}/`
  log.info('listening', { url: baseUrl })

  // 8. Background tickers (P-4-04 limits + P-4-09 worktree GC + P-5-01 events archival
  //    + RFC-033 batch-import retention GC).
  const limitsTicker = startLimitsTicker(db)
  const gcTicker = startWorktreeGc(db, () => loadConfig(Paths.config))
  const archiveTicker = startEventsArchiver(db, () => loadConfig(Paths.config), Paths.logsDir)
  const batchImportCfg = loadConfig(Paths.config)
  const batchImportGcTicker = startBatchImportGc(
    undefined,
    batchImportCfg.repoBatchImportRetentionMs,
  )
  // RFC-050: register an ambient provider so enqueueDistillJob callers
  // pick up the current `config.memoryDistillLang` without us having to
  // thread configPath through review.ts / clarify.ts / taskFeedback.ts.
  // Re-reads config on every call so admin edits to the config file
  // (e.g. via `PUT /api/config`) flow through without a daemon restart.
  setMemoryDistillLangProvider(() => {
    try {
      return loadConfig(Paths.config).memoryDistillLang ?? null
    } catch {
      return null
    }
  })

  // RFC-041 — distill queue worker. Honors `memoryDistillerEnabled`
  // (default true); when false the handle is a no-op shell.
  const memoryDistillTicker = startMemoryDistillLoop({
    db,
    enabled: batchImportCfg.memoryDistillerEnabled !== false,
    model: batchImportCfg.memoryDistillModel ?? null,
    // RFC-044: per-source byte budget for the new distiller context blocks.
    // Undefined falls back to DEFAULT_SOURCE_CONTEXT_BUDGET inside runDistill.
    sourceContextBudget: batchImportCfg.memoryDistillSourceContext,
  })

  // 9. Graceful shutdown (P-4-06).
  //
  // SIGTERM/SIGINT:
  //   - stop accepting new HTTP requests
  //   - abort all running tasks (their AbortControllers SIGTERM their child
  //     opencode processes via runner.ts; the scheduler then marks rows
  //     canceled/interrupted)
  //   - poll for ~30s; any task still in 'running' after the budget is
  //     flipped to 'interrupted' so the next daemon start surfaces it as
  //     daemon-restart instead of leaving stale rows.
  //
  // CRITICAL: signal handlers must be installed BEFORE the "ready" line is
  // printed to stdout. The test/launcher races: it reads the URL from stdout
  // and immediately sends SIGTERM — if the handler hasn't been registered
  // yet, Node's default terminate runs and `.daemon.info` outlives us.
  const removeDaemonInfo = (): void => {
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      // already removed or never written
    }
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    limitsTicker.stop()
    gcTicker.stop()
    archiveTicker.stop()
    batchImportGcTicker.stop()
    memoryDistillTicker.stop()
    removeDaemonInfo()
    server.stop(true)
    try {
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(db, 30_000)
    } catch (err) {
      log.warn('graceful shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    lock.release()
    process.exit(0)
  }
  process.on('SIGTERM', () => {
    // unlink synchronously the instant the signal fires; the async shutdown
    // continues in the background.
    removeDaemonInfo()
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    removeDaemonInfo()
    void shutdown('SIGINT')
  })
  // Belt-and-suspenders for paths the signal handlers can't reach (uncaught
  // exception, explicit process.exit elsewhere). on('exit') is synchronous
  // and runs on every normal termination path.
  process.on('exit', () => {
    removeDaemonInfo()
    lock.release()
  })

  // Write runtime info file for `status` / `stop` subcommands to discover us.
  // Must be AFTER signal handlers so a racing SIGTERM never leaves the file
  // behind.
  writeFileSync(
    Paths.daemonInfo,
    JSON.stringify(
      {
        pid: lock.pid,
        host: server.hostname,
        port: server.port,
        url: baseUrl,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  // Browser-facing URL with token included; printed exactly once on stdout
  // and never written to the persistent log (per design.md §10.2).
  const browserUrl = `${baseUrl}?token=${token}`
  process.stdout.write(
    `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
  )

  await new Promise<void>(() => {
    /* never resolves */
  })
}
