// `agent-workflow start` — daemon foreground entry.

import { createSecretBox } from '@/auth/secretBox'
import { setSandboxProvider } from '@/services/sandbox'
import { setPushCredentialResolver } from '@/services/gitCredential'
import { getSandboxStatus } from '@/services/sandbox/probe'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { openDb, DbCorruptionError } from '@/db/client'
import { cachedRepos, tasks } from '@/db/schema'
import { eq } from 'drizzle-orm'
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
import { buildScheduleLaunch } from '@/services/scheduleLaunch'
import { startScheduledTaskLoop } from '@/services/scheduledTaskScheduler'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { startEventsArchiver } from '@/services/eventsArchive'
import { startSubmoduleRefreshLoop } from '@/services/submoduleRefresh'
import { startWorktreeGc } from '@/services/gc'
import {
  startBackupScheduler,
  startWalCheckpointLoop,
  maybePreMigrationBackup,
} from '@/services/backupScheduler'
import { applyPendingRestoreIfAny } from '@/services/pendingRestore'
import { registerTerminalTaskHook } from '@/services/lifecycle'
import { startLifecycleInvariantsLoop } from '@/services/lifecycleInvariants'
import { sealOpenHumanGatesForTask } from '@/services/terminalSweep'
import { startStuckTaskDetectorLoop } from '@/services/stuckTaskDetector'
import { startBatchImportGc } from '@/services/repoBatchImport'
import { startPluginGenerationGc } from '@/services/pluginGenerationGc'
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
import { isBootstrapRequired } from '@/services/authLoginPolicy'
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface StartOptions {
  port?: number
  host?: string
}

/**
 * RFC-208 — ceiling for the mandatory boot probes (opencode + git).
 *
 * Generous: a cold binary on a slow/networked volume can legitimately take a
 * few seconds. The point is not to be tight, it is to be FINITE — an unbounded
 * probe leaves the daemon holding the PID lock while never listening, and a
 * restart cannot recover from that.
 */
export const BOOT_PROBE_TIMEOUT_MS = 20_000

/** RFC-213 — human-facing fail-closed message: list backups + the restore command. */
function formatDbCorruptionGuidance(err: DbCorruptionError): string {
  const lines = [
    '',
    '✖ agent-workflow: database corruption detected — refusing to start.',
    `  db:          ${err.dbPath}`,
    `  quick_check: ${err.checkErrors.slice(0, 3).join('; ')}`,
    '',
  ]
  let backups: string[] = []
  try {
    backups = readdirSync(Paths.backupsDir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => join(Paths.backupsDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    /* no backups dir */
  }
  if (backups.length === 0) {
    lines.push(`  No backups found under ${Paths.backupsDir}.`)
    lines.push('  If you have a backup tarball elsewhere: agent-workflow restore <tarball>')
  } else {
    lines.push('  Available backups (newest first):')
    for (const b of backups.slice(0, 5)) lines.push(`    ${b}`)
    lines.push('')
    lines.push(`  Recover with: agent-workflow restore ${backups[0]}`)
  }
  lines.push('  (Last resort, unsafe: AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1 agent-workflow start)')
  lines.push('')
  return lines.join('\n')
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

  // 2.5 — RFC-213: resolve the migrations folder and apply a staged ("hot")
  // restore BEFORE anything reads state. We hold the lock (acquired above), so
  // exactly one process consumes it; the DB is not open yet. Impl-gate P2-12
  // (2026-07-22): this used to run AFTER loadConfig, so the config.json the
  // restore just brought back only took effect one restart later — moved ahead
  // of loadConfig so the applying boot already runs on the restored config.
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
  // A failure inside applyPendingRestoreIfAny self-heals (impl-gate P1-1): the
  // staged dir is quarantined and the boot continues on the untouched DB. The
  // catch below only guards truly unexpected filesystem-level throws.
  try {
    const applied = await applyPendingRestoreIfAny({
      appHome: Paths.root,
      dbPath: Paths.db,
      migrationsFolder,
    })
    if (applied) log.warn('staged restore applied on boot', { db: Paths.db })
  } catch (err) {
    lock.release()
    console.error(
      `agent-workflow: staged restore failed unexpectedly — refusing to boot with an unknown DB state.\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n` +
        `  The pre-restore safety backup (if taken) is under ${join(Paths.root, 'backups')}/.\n` +
        `  To abandon the staged restore and boot normally: rm -rf ${join(Paths.root, '.restore-pending')}`,
    )
    process.exit(1)
  }

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
  // RFC-208: bound the probe. `opencode` on PATH is frequently a wrapper
  // (nvm/asdf/mise shim, corporate proxy script) that can hang; unbounded, the
  // daemon holds the PID lock and NEVER reaches `listen`, which is the one
  // failure in this codebase that a restart cannot clear — the next `start`
  // just reports "another daemon is already running".
  //
  // Bounded, but still FAIL-CLOSED: a timed-out required-runtime probe reports
  // version null below and exits after releasing the lock. Continuing to listen
  // would serve a daemon that cannot run its mandatory runtime.
  const probe = await ocDriver.probe(ocDriver.defaultBinary(config)[0]!, {
    timeoutMs: BOOT_PROBE_TIMEOUT_MS,
  })
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

  // 4.5 — RFC-205: probe the OS sandbox mechanism once and install the daemon
  // provider (mode from config). Soft like the claude probe: 'warn' (default)
  // boots regardless and degrades loudly per task; 'enforce' makes task LAUNCH
  // refuse while the daemon itself stays up (Settings must stay reachable to
  // lower the mode).
  {
    const sandboxStatus = await getSandboxStatus()
    setSandboxProvider({ mode: config.sandboxMode, status: sandboxStatus, appHome: Paths.root })
    if (config.sandboxMode === 'off') {
      log.info('sandbox off (config)', {})
    } else if (sandboxStatus.available) {
      log.info('sandbox mechanism ready', { mechanism: sandboxStatus.mechanism })
    } else {
      log.warn('sandbox mechanism UNAVAILABLE', {
        mode: config.sandboxMode,
        detail: sandboxStatus.detail,
      })
    }
  }

  // 5. DB — open + apply migrations. dbVersion = number of SQL files in the
  // bundled migrations folder (== the highest version we've applied, since
  // openDb() applies all pending migrations on startup). The migrations folder
  // itself (and any staged restore) was already resolved/applied at step 2.5.

  // RFC-213/RFC-223: raw pre-migration safety backup BEFORE openDb applies
  // migrations. A pending migration without its rollback generation is fatal;
  // backupOnMigration=false is the operator's explicit opt-out.
  await maybePreMigrationBackup({
    appHome: Paths.root,
    dbPath: Paths.db,
    migrationsFolder,
    enabled: config.backupOnMigration,
  })

  let db: ReturnType<typeof openDb>
  try {
    db = openDb({
      path: Paths.db,
      migrationsFolder,
      synchronous: config.sqliteSynchronous,
      skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',
    })
  } catch (err) {
    if (err instanceof DbCorruptionError) {
      // RFC-213 fail-closed: never serve a corrupt DB. Print the available
      // backups + the exact restore command, then exit non-zero. The DB is
      // unwritable, so this does NOT record a recovery_event.
      lock.release()
      process.stderr.write(formatDbCorruptionGuidance(err))
      process.exit(1)
    }
    throw err
  }
  const dbVersion = existsSync(migrationsFolder)
    ? readdirSync(migrationsFolder).filter((f) => f.endsWith('.sql')).length
    : 0
  log.info('db ready', { path: Paths.db, dbVersion })

  // 5a. RFC-223 PR-5: the ONE fail-closed skill identity barrier. It must be
  // the first production DB/FS behavior after migrations: recover every
  // legacy/current structural op while locks remain evidence, migrate
  // skills/{name} -> skills/{id}, and prove DB/FS/FK consistency before users,
  // orphan reaping, reconcilers, seeders, schedulers, fusion, or HTTP can run.
  {
    const { runSkillIdentityMigrationBarrier } = await import('@/services/skillIdentityMigration')
    const report = runSkillIdentityMigrationBarrier(db, { appHome: Paths.root })
    if (report.recoveredOperations > 0 || report.removedHusks > 0 || report.migratedSkills > 0) {
      log.info('skill identity migration barrier complete', { ...report })
    }
  }
  // Activate the boot-epoch availability gate while its verified set is still
  // empty. Every persisted skill stays hidden from all consumers and HTTP until
  // the per-skill background reverify explicitly admits it (or quarantines it).
  {
    const { activateBootReverify } = await import('@/services/skillBootVerify')
    activateBootReverify()
  }

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

  // 5b2/5b3（已退役）—— RFC-132 的两个 boot 垫片（legacy immediate rounds /
  // legacy cross stop）由 RFC-217 T8 收编为一次性 migration 0107（垫片模块
  // 随之删除）；migration 恰好一次的语义取代 boot-once 幂等重放。

  // 5b4. RFC-165 (R3-2-r4): backfill workspace tombstones for terminal tasks
  // whose directory vanished before the tombstone columns existed (pre-165 GC
  // deleted dirs without stamping anything). Revive paths (resume / retry /
  // sync / repair / auto-resume) then 410 deterministically instead of
  // resurrecting a ghost. Must run BEFORE the HTTP server serves revive
  // routes and before auto-resume (step 8+) — 幂等 + best-effort.
  try {
    const { reconcileLegacyPrunedWorkspaces } = await import('@/services/gc')
    await reconcileLegacyPrunedWorkspaces(db)
  } catch (err) {
    log.warn('legacy pruned-workspace reconcile on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b5. RFC-165 (§9): heal stored path-mode scheduled launch payloads to their
  // faithful file:// form (fetchBeforeLaunch:true / missing dirs → disabled with
  // an explanatory lastError). MUST run before the HTTP server serves the
  // scheduled read/edit routes AND before the scheduler ticker fires — 幂等 +
  // best-effort.
  try {
    const { healScheduledLaunchPayloads } = await import('@/services/scheduledTasks')
    const healed = await healScheduledLaunchPayloads(db)
    if (healed.converted > 0 || healed.disabled > 0) {
      log.info('scheduled launch payloads healed', healed)
    }
  } catch (err) {
    log.warn('scheduled payload heal on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5b5. RFC-170 T6 (Codex re-review F9): recover fusion DECISION half-states left
  // by a crash mid-approve/mid-reject (multi-tx decisions). Roll forward an
  // 'applying' whose version already committed, roll back the rest, and fail a
  // 'running'+currentTaskId=null (reject that never attached its task). Best-effort.
  try {
    const { recoverFusionDecisions } = await import('@/services/fusion')
    const r = recoverFusionDecisions(db)
    if (r.rolledForward + r.rolledBack + r.rejectFailed > 0) {
      log.info('fusion decision recovery on boot', r)
    }
  } catch (err) {
    log.warn('fusion decision recovery on boot failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 5c. RFC-101: backfill a v1 snapshot for any managed skill predating skill
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

  // 6c. RFC-204 — seal repo credentials at rest. Idempotent and network-free
  // (it never re-clones), so it is safe on every boot and cannot stall an
  // upgrade on an unreachable remote.
  ensureCredentialsSealed(db, secretBox)
  // RFC-205 G1 — push credential resolver: the mirror origin is
  // credential-free now, so the framework's own auto-push leases the secret
  // per push (askpass file, never argv/env/on-disk-config). Agents can't reach
  // it: no resolver in their process, no credential in the worktree's origin.
  setPushCredentialResolver(async (taskId) => {
    const rows = await db
      .select({ urlEnc: cachedRepos.urlEnc, url: cachedRepos.url })
      .from(cachedRepos)
      .innerJoin(tasks, eq(tasks.cachedRepoId, cachedRepos.id))
      .where(eq(tasks.id, taskId))
      .limit(1)
    const row = rows[0]
    if (row === undefined) return null
    if (row.urlEnc !== null) {
      try {
        return secretBox.unseal(row.urlEnc)
      } catch {
        return null
      }
    }
    return row.url !== '' ? row.url : null
  })

  // 7. HTTP server.
  const app = createApp({
    token,
    configPath: Paths.config,
    daemonInfoPath: Paths.daemonInfo,
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

  // 7b. RFC-170 §invariant④ (T-BOOT): AFTER HTTP opens, re-verify every managed
  //     snapshot's integrity in the background (re-hash vs content_hash). A durable
  //     'snapshot-authoritative' flag can't prove the snapshot didn't corrupt
  //     offline (G6-4), so this pass gates availability THIS boot: passing skills
  //     enter the in-memory bootVerifiedSet (injectable/visible), corrupt ones are
  //     quarantined. Runs after serving starts (no boot barrier — a big legit tree
  //     is just "available later"); best-effort, never crashes the daemon.
  void (async () => {
    try {
      // RFC-170 T4a: first, lazily backfill a v1 snapshot for any legacy managed
      // skill created before version tracking (version_state='legacy-unbackfilled',
      // no skill_versions row) — else the availability gate would hide it after an
      // upgrade — and sweep orphaned husk rows (no files, no versions) that would
      // otherwise squat their name invisibly forever. Per-skill best-effort; see
      // backfillLegacySkillVersions.
      const { backfillLegacySkillVersions } = await import('@/services/skillVersion')
      const bf = backfillLegacySkillVersions(db, { appHome: Paths.root })
      const { runBootSnapshotReverify } = await import('@/services/skillBootVerify')
      const r = runBootSnapshotReverify(db, { appHome: Paths.root })
      log.info('boot snapshot reverify', {
        ...r,
        legacyBackfilled: bf.backfilled,
        husksRemoved: bf.husksRemoved,
      })
    } catch (err) {
      log.warn('boot snapshot reverify failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()

  // 8. Background tickers (P-4-04 limits + P-4-09 worktree GC + P-5-01 events archival
  //    + RFC-033 batch-import retention GC).
  const limitsTicker = startLimitsTicker(db)
  const gcTicker = startWorktreeGc(db, () => loadConfig(Paths.config), undefined, Paths.root)
  const archiveTicker = startEventsArchiver(db, () => loadConfig(Paths.config), Paths.logsDir)
  // RFC-213: scheduled backup + retention (disabled by default — backupIntervalMs=0).
  const backupTicker = startBackupScheduler({
    db,
    intervalMs: config.backupIntervalMs,
    retentionCount: config.backupRetentionCount,
    retentionDays: config.backupRetentionDays,
    maxTotalBytes: config.backupMaxTotalBytes,
    appHome: Paths.root,
  })
  // RFC-213 G4c: bound -wal growth (disabled by default — walCheckpointIntervalMs=0).
  const walCheckpointTicker = startWalCheckpointLoop({
    db,
    intervalMs: config.walCheckpointIntervalMs,
  })
  // RFC-210 G7: keep cached mirrors (and their submodules) from going stale when
  // nobody launches a task against them. Reads its own enable flag each tick.
  const submoduleRefreshTicker = startSubmoduleRefreshLoop(
    db,
    () => loadConfig(Paths.config),
    undefined,
    Paths.root,
  )
  const batchImportCfg = loadConfig(Paths.config)
  const batchImportGcTicker = startBatchImportGc(
    undefined,
    batchImportCfg.repoBatchImportRetentionMs,
  )
  const pluginGenerationGcTicker = startPluginGenerationGc({ db, pluginsDir: Paths.pluginsDir })
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

  // RFC-202 T2: when a task reaches an unrevivable terminal status
  // (done/canceled), sweep its open clarify/review gates so they leave the
  // inbox for good. Registered here (not imported by lifecycle.ts) to avoid
  // a lifecycle → clarify/review module cycle.
  registerTerminalTaskHook((hookDb, taskId, to) => {
    sealOpenHumanGatesForTask(hookDb, taskId, `task-${to}`)
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
  // RFC-159 — scheduled-task background loop. Fires each due schedule as its owner,
  // building deps live (buildStartTaskDeps) so scheduled launches match manual ones.
  const scheduledTaskTicker = startScheduledTaskLoop({
    db,
    loadConfig: () => loadConfig(Paths.config),
    buildLaunch: buildScheduleLaunch(db, Paths.config),
  })

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
    backupTicker.stop()
    walCheckpointTicker.stop()
    submoduleRefreshTicker.stop()
    batchImportGcTicker.stop()
    pluginGenerationGcTicker.stop()
    memoryDistillTicker.stop()
    lifecycleInvariantsTicker.stop()
    stuckDetectorTicker.stop()
    fusionReconcileTicker.stop()
    autoRepairTicker.stop()
    heartbeatKillTicker.stop()
    orphanReconcileTicker.stop()
    scheduledTaskTicker.stop()
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

  // RFC-221 — the daemon token is only a first-admin bootstrap credential.
  // Once handoff commits, never print it as a browser login URL again.
  const browserUrl = readyBrowserUrl(baseUrl, token, isBootstrapRequired(db))
  process.stdout.write(
    `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
  )

  await new Promise<void>(() => {
    /* never resolves */
  })
}

export function readyBrowserUrl(
  baseUrl: string,
  token: string,
  bootstrapRequired: boolean,
): string {
  return bootstrapRequired ? `${baseUrl}?token=${token}` : baseUrl
}
