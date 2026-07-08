// `agent-workflow start` — daemon foreground entry.

import { createSecretBox } from '@/auth/secretBox'
import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { openDb } from '@/db/client'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { createApp } from '@/server'
import { startFusionReconcileLoop } from '@/services/fusion'
import { startLimitsTicker } from '@/services/limits'
import { reapOrphanRuns } from '@/services/orphans'
import { autoResumeInterruptedTasks } from '@/services/autoResume'
import { startAutoRepairLoop } from '@/services/autoRepair'
import { startHeartbeatKillLoop } from '@/services/autoKill'
import { startOrphanReconcileLoop } from '@/services/orphanReconcile'
import { resumeTask } from '@/services/task'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { startEventsArchiver } from '@/services/eventsArchive'
import { startWorktreeGc } from '@/services/gc'
import { startLifecycleInvariantsLoop } from '@/services/lifecycleInvariants'
import { startStuckTaskDetectorLoop } from '@/services/stuckTaskDetector'
import { startBatchImportGc } from '@/services/repoBatchImport'
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import {
  setMemoryDistillLangProvider,
  startMemoryDistillLoop,
} from '@/services/memoryDistillScheduler'
import { acquireLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import { tasksListBroadcaster, TASKS_LIST_CHANNEL } from '@/ws/broadcaster'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { getRuntimeDriver } from '@/services/runtime'
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
  // RFC-143: opencode is the hard-required boot runtime — probe it via its
  // driver (the exit-on-incompatible gate stays here, a boot-policy call).
  const ocDriver = getRuntimeDriver('opencode')
  const probe = await ocDriver.probe(ocDriver.defaultBinary(config)[0]!)
  if (probe.version === null) {
    log.error('opencode binary not found or unreadable', { binary: probe.binary })
    console.error(
      `agent-workflow: cannot execute "${probe.binary}".\n` +
        `  install opencode (>=${ocDriver.minVersion}) and ensure it is on PATH,\n` +
        `  or set 'opencodePath' in ${Paths.config}.`,
    )
    lock.release()
    process.exit(1)
  }
  if (!probe.compatible) {
    log.error('opencode incompatible', {
      found: probe.version,
      requiredMinimum: ocDriver.minVersion,
      reason: probe.incompatibleReason,
    })
    console.error(
      `agent-workflow: opencode ${probe.version} is incompatible.\n` +
        `  required: version >= ${ocDriver.minVersion}\n` +
        `  reason: ${probe.incompatibleReason ?? 'unknown'}\n` +
        `  to recover: \`npm install -g opencode-ai@latest\` (or any version >= ${ocDriver.minVersion}) or set 'opencodePath' in ${Paths.config}.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('opencode probe ok', { version: probe.version, binary: probe.binary })

  // 4b. git version probe — RFC-130 D7: every node run merge-backs via
  // `git merge-tree --write-tree` (git >= 2.38). On older git the daemon boots
  // fine and every task dies at merge-back (AFTER its agent already ran) with a
  // cryptic `merge-back-failed: git merge-tree: usage: ...` — refuse at boot
  // instead, same hard-gate policy as the opencode probe above. Side effect:
  // populates the RFC-034 capability cache read by resolveSubmoduleParams
  // (submodule --jobs / worktree guards), which was never probed at boot before.
  const gitCaps = await detectGitCapabilities()
  const gitGateError = mergeTreeGateError(gitCaps)
  if (gitGateError !== null) {
    log.error('git incompatible', {
      found: gitCaps.version?.raw ?? null,
      requiredMinimum: MIN_GIT_VERSION,
    })
    console.error(
      `agent-workflow: ${gitGateError}\n` +
        `  upgrade git to >= ${MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('git probe ok', { version: gitCaps.version?.raw ?? null })

  // RFC-111 D10: claude-code is an OPTIONAL second runtime — probe it SOFT
  // (warn only, NEVER refuse to start). A missing/old claude only fails nodes
  // whose agent selected it; opencode-only installs are unaffected. We probe
  // when claude is the configured default (the clearest "claude is needed"
  // signal available before the DB opens); per-agent claude selection surfaces
  // as a clear spawn-time failure on the node itself.
  if (config.defaultRuntime === 'claude-code') {
    const ccDriver = getRuntimeDriver('claude-code')
    const claudeProbe = await ccDriver.probe(ccDriver.defaultBinary(config)[0]!)
    if (!claudeProbe.compatible) {
      log.warn('claude-code default runtime unavailable (nodes selecting it will fail)', {
        binary: claudeProbe.binary,
        found: claudeProbe.version,
        requiredMinimum: ccDriver.minVersion,
        reason: claudeProbe.incompatibleReason ?? 'not found',
      })
    } else {
      log.info('claude-code probe ok', {
        version: claudeProbe.version,
        binary: claudeProbe.binary,
      })
    }
  }

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

  // 5b2. RFC-132 PR-D' 步骤0: reconcile 升级前遗留的 immediate 反问 round（answered 但没打
  // dispatched_at）—— 补 sealed+dispatched 并把 trigger_run_id 绑到【已存在】的 continuation
  // run，令统一注入器 buildClarifyQueueContext 能重新注入用户答案。必须在任何 resume 之前跑
  // （否则 continuation 恢复时注入空 → 丢答案，design §13 更正①）。幂等 + best-effort（自带 log）。
  try {
    const { reconcileLegacyImmediateRounds } = await import('@/services/clarifyMigration')
    await reconcileLegacyImmediateRounds(db)
  } catch (err) {
    log.warn('legacy immediate clarify reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b3. RFC-132 T7: reconcile 升级前遗留的 cross 'stop'。resolveCrossNodeStopped 现只读
  // questioner 节点的 node 级 directive；未镜像到 node 级的 legacy cross stop 会"复活"（cross
  // 节点不再 short-circuit）。补 node 级 'stop'（幂等 + 不覆盖已有 row，含用户 re-enable）。
  // 同样在 resume 之前跑。幂等 + best-effort（自带 log）。
  try {
    const { reconcileLegacyCrossPersistentStop } = await import('@/services/clarifyMigration')
    await reconcileLegacyCrossPersistentStop(db)
  } catch (err) {
    log.warn('legacy cross persistent-stop reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
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

  // 5d. RFC-101: backfill a v1 snapshot for any managed skill predating skill
  // versioning, and re-sync a live files/ left stale by a crash between the
  // version-archive tx and the live-files copy. Idempotent + best-effort.
  try {
    const { reconcileSkillLiveFiles } = await import('@/services/skillVersion')
    reconcileSkillLiveFiles(db, { appHome: Paths.root })
  } catch (err) {
    log.warn('skill-version reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5e. RFC-101: ensure the built-in skill-fusion agent + workflow exist (so a
  // fusion launch never has to seed them on the hot path, and they show up in
  // the workflows list). Idempotent; createFusion also lazy-seeds defensively.
  try {
    const { seedFusionResources } = await import('@/services/fusion')
    await seedFusionResources(db)
  } catch (err) {
    log.warn('fusion resource seed on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5f. RFC-112/153: on FIRST startup (empty runtimes table) seed opencode /
  // claude-code as ordinary rows so agents / config.defaultRuntime can reference
  // them by name and the Settings list shows them out of the box. RFC-153: they
  // are editable + deletable now; a deleted row is NOT re-seeded (seed no-ops on a
  // non-empty table). migrateConfigIntoBuiltins then backfills binary from config.
  try {
    const { seedBuiltinRuntimes, migrateConfigIntoBuiltins } =
      await import('@/services/runtimeRegistry')
    await seedBuiltinRuntimes(db)
    // RFC-113 (idempotent): config defaults land on the built-in runtime rows
    // (§3.1). RFC-115 removed the one-time agent-param re-home pass — the agent
    // contract dropped its model/variant/temperature/steps/maxSteps columns
    // (migration 0057), so generation params now live solely on the runtimes.
    await migrateConfigIntoBuiltins(db, config)
  } catch (err) {
    log.warn('builtin runtime seed/migration on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // RFC-115 (Codex impl-gate): fail-loud guard for the config-only skip-upgrade
  // data-loss path — OUTSIDE the warn-and-continue try above so it actually
  // aborts boot (symmetric with migration 0057's agents guard). If raw config
  // still has the 6 dropped generation defaults but every built-in runtime
  // profile is NULL, RFC-113's config→runtime backfill never ran and continuing
  // would silently change every inherited runtime's default model.
  {
    const { assertConfigDefaultsMigrated } = await import('@/services/runtimeRegistry')
    await assertConfigDefaultsMigrated(db, Paths.config)
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
  const gcTicker = startWorktreeGc(db, () => loadConfig(Paths.config), undefined, Paths.root)
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
    // RFC-117: distiller runtime profile (per-feature name → default → deprecated model).
    runtimeName: batchImportCfg.memoryDistillRuntime ?? null,
    defaultRuntime: batchImportCfg.defaultRuntime ?? null,
    model: batchImportCfg.memoryDistillModel ?? null,
    // RFC-044: per-source byte budget for the new distiller context blocks.
    // Undefined falls back to DEFAULT_SOURCE_CONTEXT_BUDGET inside runDistill.
    sourceContextBudget: batchImportCfg.memoryDistillSourceContext,
  })

  // RFC-053 P-3 — lifecycle invariant scan. Boot-time scan (~5s after the
  // listener comes up) catches historic stuck tasks; hourly incremental
  // scan keeps the open-alerts feed live. New findings broadcast on the
  // tasks-list channel so the UI banner / detail diagnose panel can react.
  const broadcastAlert = (
    row: { taskId: string; rule: string; severity: 'warning' | 'error' },
    transition: 'new' | 'promoted',
  ): void => {
    tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
      type: 'lifecycle.alert',
      taskId: row.taskId,
      rule: row.rule,
      severity: row.severity,
      transition,
    })
  }
  const lifecycleInvariantsTicker = startLifecycleInvariantsLoop({
    db,
    onAlert: broadcastAlert,
  })

  // RFC-053 P-6 — stuck-task detector. Runs every 5 min looking for tasks
  // that are parked in a non-terminal status past their threshold without
  // matching evidence (S1: awaiting_review w/o pending dv; S2:
  // awaiting_human w/o open clarify_session; S3: running w/ no active
  // node_runs; S4: pending > 5 min). Shares the lifecycle_alerts table
  // and the WS lifecycle.alert event so banner UI reacts uniformly.
  const stuckDetectorTicker = startStuckTaskDetectorLoop({
    db,
    onAlert: broadcastAlert,
  })

  // RFC-101: settle running fusions (engine task done → awaiting_approval) so
  // the inbox badge lights up without a client poll.
  const fusionReconcileTicker = startFusionReconcileLoop({ db, appHome: Paths.root })

  // RFC-108 T19 (AR-04) — closed auto-repair loop (DEFAULT OFF). Free until an
  // operator enables a rule in config.autoRepair (each tick early-outs in O(1)).
  const autoRepairTicker = startAutoRepairLoop({
    db,
    appHome: Paths.root,
    configPath: Paths.config,
  })

  // RFC-108 T20 (AR-05a) — heartbeat stalled-child auto-kill (DEFAULT OFF).
  const heartbeatKillTicker = startHeartbeatKillLoop({ db, configPath: Paths.config })

  // RFC-108 T17 (AR-10) — periodic post-boot orphan reconciler (reap-to-
  // interrupted is the safe-on default; auto-resume stays behind T18's opt-in).
  const orphanReconcileTicker = startOrphanReconcileLoop({ db, configPath: Paths.config })

  // RFC-108 T18 (AR-03) — boot auto-resume (DEFAULT OFF, decision D1). Closes
  // the daemon-restart loop: every task `reapOrphanRuns` just flipped to
  // `interrupted` is re-driven automatically, but only through the breaker +
  // quarantine + driver-lease + recovery audit (autoResumeInterruptedTasks).
  // Non-blocking — never hold the ready line on N resumes; resumeTask's CAS
  // ownership claim keeps it safe against the scheduler / a human racing in.
  if (config.autoResumeOnBoot) {
    const resumeDeps = {
      db,
      ...(config.opencodePath ? { opencodeCmd: [config.opencodePath] } : {}),
      ...(config.subagentLiveCapture !== undefined
        ? { subagentLiveCapture: config.subagentLiveCapture }
        : {}),
      ...resolveLaunchRuntimeConfig(Paths.config),
    }
    void autoResumeInterruptedTasks({
      db,
      breaker: {
        maxPerWindow: config.maxAutoRecoveriesPerWindow,
        windowMs: config.autoRecoveryWindowMs,
      },
      resume: (taskId) => resumeTask(db, taskId, resumeDeps).then(() => undefined),
    }).catch((err) =>
      log.warn('boot auto-resume failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

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
    lifecycleInvariantsTicker.stop()
    stuckDetectorTicker.stop()
    fusionReconcileTicker.stop()
    autoRepairTicker.stop()
    heartbeatKillTicker.stop()
    orphanReconcileTicker.stop()
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
