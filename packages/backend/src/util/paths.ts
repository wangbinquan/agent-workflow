// Resolved filesystem paths for the daemon.
// All persistent state lives under appHome() (default ~/.agent-workflow).
// Override with $AGENT_WORKFLOW_HOME for tests.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function appHome(): string {
  return process.env.AGENT_WORKFLOW_HOME ?? join(homedir(), '.agent-workflow')
}

export const Paths = {
  get root() {
    return appHome()
  },
  get db() {
    return join(appHome(), 'db.sqlite')
  },
  get config() {
    return join(appHome(), 'config.json')
  },
  get tokenFile() {
    return join(appHome(), 'token')
  },
  /**
   * RFC-036: AES-256-GCM key used to seal OIDC client_secret values at rest.
   * Generated lazily on first daemon start via auth/secretBox.ts; chmod 600.
   * Losing this file makes every previously-stored client_secret unreadable.
   */
  get secretKeyFile() {
    return join(appHome(), 'secret.key')
  },
  get lock() {
    return join(appHome(), '.daemon.lock')
  },
  /** Runtime info written by `start` (host/port/url/startedAt) for `status` to read. */
  get daemonInfo() {
    return join(appHome(), '.daemon.info')
  },
  /**
   * RFC-254 T7 — loopback control endpoint + shutdown nonce, written by `start`
   * and read by `stop`. Carries an AT-REST SECRET (the nonce): private mode on
   * POSIX, per-user ACL on Windows. Removed when the daemon exits.
   */
  get controlFile() {
    return join(appHome(), '.daemon.control')
  },
  /**
   * RFC-307 — marks that the demo content has been offered on this install.
   *
   * A file rather than a row because the fact is about the INSTALL, not the
   * domain: "we have already shown this person the samples". Checking whether
   * the demo rows exist would not do — a user who deletes them means it, and
   * re-seeding on the next restart would be the platform arguing.
   */
  get demoSeedMarker() {
    return join(appHome(), '.demo-seeded')
  },
  get logsDir() {
    return join(appHome(), 'logs')
  },
  get daemonLog() {
    return join(appHome(), 'logs', 'daemon.log')
  },
  get skillsDir() {
    return join(appHome(), 'skills')
  },
  /** RFC-031: framework-managed plugin install root; one subdir per plugin row id. */
  get pluginsDir() {
    return join(appHome(), 'plugins')
  },
  get worktreesDir() {
    return join(appHome(), 'worktrees')
  },
  get runsDir() {
    return join(appHome(), 'runs')
  },
  get snapshotsDir() {
    return join(appHome(), 'snapshots')
  },
  get backupsDir() {
    return join(appHome(), 'backups')
  },
  /** RFC-349: database-provider migration control plane. This state lives
   * outside either business database so it remains readable during freeze,
   * cutover and recovery. */
  get databaseMigrationsDir() {
    return join(appHome(), 'database-migrations')
  },
  /** RFC-349: the only boot-time authority for an explicit live generation.
   * Missing means the backwards-compatible legacy SQLite generation. */
  get databaseGenerationPointer() {
    return join(appHome(), 'database-generation.json')
  },
  /** RFC-311 T19：终态任务归档出库后的落盘根目录(每棵任务树一个子目录)。
   *  归档即从库里删除,界面 404 与不存在同形;这里是唯一的考古入口。 */
  get taskArchiveDir() {
    return join(appHome(), 'archive', 'tasks')
  },
  /**
   * Path to bundled drizzle migrations folder. In dev: backend/db/migrations.
   * In production single-binary build (M5), this resolves to the embedded path
   * via Bun.embeddedFiles (P-5-05).
   */
  get migrationsDir() {
    return resolve(import.meta.dirname, '..', '..', 'db', 'migrations')
  },
  /** RFC-349: PostgreSQL owns an independent immutable migration history; the
   * SQLite SQL chain is never replayed into PostgreSQL. */
  get postgresqlMigrationsDir() {
    return resolve(import.meta.dirname, '..', '..', 'db', 'postgresql-migrations')
  },
}
