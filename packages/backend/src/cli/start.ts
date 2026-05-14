// `agent-workflow start` — daemon foreground entry.

import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { acquireLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { MIN_OPENCODE_VERSION, probeOpencode } from '@/util/opencode'
import { Paths } from '@/util/paths'
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'

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
    log.error('opencode too old', { found: probe.version, required: MIN_OPENCODE_VERSION })
    console.error(
      `agent-workflow: opencode ${probe.version} is older than the required ${MIN_OPENCODE_VERSION}.\n` +
        `  run "opencode upgrade" or set 'opencodePath' to a newer binary.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('opencode probe ok', { version: probe.version, binary: probe.binary })

  // 5. DB — open + apply migrations. dbVersion = number of SQL files in the
  // bundled migrations folder (== the highest version we've applied, since
  // openDb() applies all pending migrations on startup).
  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  const dbVersion = existsSync(Paths.migrationsDir)
    ? readdirSync(Paths.migrationsDir).filter((f) => f.endsWith('.sql')).length
    : 0
  log.info('db ready', { path: Paths.db, dbVersion })

  // 6. Token (generate-on-first-run, chmod 600).
  const token = ensureTokenFile(Paths.tokenFile)
  log.info('token ready', { tokenFile: Paths.tokenFile })

  // 7. HTTP server.
  const app = createApp({
    token,
    configPath: Paths.config,
    opencodeVersion: probe.version,
    dbVersion,
    db,
  })

  const bindHost = opts.host ?? config.bindHost
  const bindPort = opts.port ?? config.bindPort ?? 0
  const server = Bun.serve({
    port: bindPort,
    hostname: bindHost,
    fetch: app.fetch,
  })

  const baseUrl = `http://${server.hostname}:${server.port}/`
  log.info('listening', { url: baseUrl })

  // Write runtime info file for `status` / `stop` subcommands to discover us.
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

  // 8. Graceful shutdown.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    server.stop(true)
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      // best-effort
    }
    lock.release()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('exit', () => lock.release())

  await new Promise<void>(() => {
    /* never resolves */
  })
}
