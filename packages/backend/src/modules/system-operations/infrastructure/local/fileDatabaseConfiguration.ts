// RFC-370 A-T2 — preserve the standalone config file contract behind the
// database configuration port. Patch only the database field, never replace
// unrelated settings with a previously captured config snapshot.
import { applyConfigPatch, loadConfig } from '@/platform/configuration/fileConfiguration'
import type { DatabaseConfigurationPort } from '../../application/ports/databaseConfiguration'

export function createFileDatabaseConfiguration(path: string) {
  return Object.freeze({
    read: () => loadConfig(path).database,
    write(database) {
      applyConfigPatch(path, { database })
    },
  } satisfies DatabaseConfigurationPort)
}
