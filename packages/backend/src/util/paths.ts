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
  get lock() {
    return join(appHome(), '.daemon.lock')
  },
  /** Runtime info written by `start` (host/port/url/startedAt) for `status` to read. */
  get daemonInfo() {
    return join(appHome(), '.daemon.info')
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
  /**
   * Path to bundled drizzle migrations folder. In dev: backend/db/migrations.
   * In production single-binary build (M5), this resolves to the embedded path
   * via Bun.embeddedFiles (P-5-05).
   */
  get migrationsDir() {
    return resolve(import.meta.dirname, '..', '..', 'db', 'migrations')
  },
}
