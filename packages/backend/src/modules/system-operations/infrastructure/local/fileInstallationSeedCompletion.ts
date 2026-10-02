import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstallationSeedCompletionPort } from '../../application/ports/installationSeedCompletion'

export function createFileInstallationSeedCompletion(
  markerPath: string,
): InstallationSeedCompletionPort {
  return {
    hasCompleted: () => existsSync(markerPath),
    recordCompleted(completedAt) {
      mkdirSync(dirname(markerPath), { recursive: true })
      writeFileSync(markerPath, `${String(completedAt)}\n`, { mode: 0o600 })
    },
  }
}
