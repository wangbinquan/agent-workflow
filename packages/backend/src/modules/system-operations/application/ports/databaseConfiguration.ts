// RFC-370 A-T2 — database activation reads/writes configuration through its
// owner-owned port. The migration protocol does not select a file or a host.
import type { DatabaseConfig } from '@agent-workflow/shared'

export interface DatabaseConfigurationPort {
  read(): DatabaseConfig | Promise<DatabaseConfig>
  write(database: DatabaseConfig): void | Promise<void>
}
