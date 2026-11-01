// Read-only boot projection. Keep converter/application dependencies out of runtime entries.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessAlive } from '@/util/process'
import {
  foldAutoUpgradeSession,
  type AutoUpgradeRecord,
} from '../../domain/epochSwitch/autoUpgrade'

export interface ActiveAutoUpgrade {
  pid: number
  parent: number | null
  operationId: string | null
}
export const autoUpgradeRoot = (appHome: string) =>
  join(appHome, 'database-migrations', 'auto-upgrade')
export function readActiveAutoUpgrade(appHome: string): ActiveAutoUpgrade | null {
  const path = join(autoUpgradeRoot(appHome), 'active.json')
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as ActiveAutoUpgrade
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0)
      throw new Error('auto-upgrade-active-invalid')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
export function liveAutoUpgrade(appHome: string): ActiveAutoUpgrade | null {
  const active = readActiveAutoUpgrade(appHome)
  return active && isProcessAlive(active.pid) ? active : null
}
export function readAutoUpgradeSessions(appHome: string) {
  const root = join(autoUpgradeRoot(appHome), 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^dbm_e2_[A-Za-z0-9_-]+$/.test(e.name))
    .flatMap((e) => {
      const records = readdirSync(join(root, e.name))
        .filter((name) => /^\d{4,}-[a-z0-9-]+\.json$/.test(name)) // kinds include `rfc349-finalized`
        .map(
          (name) => JSON.parse(readFileSync(join(root, e.name, name), 'utf8')) as AutoUpgradeRecord,
        )
        .sort((a, b) => a.sequence - b.sequence)
      return records.length ? [foldAutoUpgradeSession(records)] : []
    })
    .sort((a, b) => a.sessionSequence - b.sessionSequence)
}
