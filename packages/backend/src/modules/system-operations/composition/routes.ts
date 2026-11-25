// RFC-576: the HTTP bindings of system-operations live in `inbound/http`; the assembly root takes their mount functions
// from here (RFC-439's shape). Nothing but re-exports.
export { mountBackupRoutes } from '../inbound/http/backupRoutes'
export { mountDaemonRoutes } from '../inbound/http/daemonRoutes'
export { mountDatabaseMigrationRoutes } from '../inbound/http/databaseMigrationRoutes'
export { mountMaintenanceDiskRoutes } from '../inbound/http/maintenanceDiskRoutes'
export { mountMaintenanceRoutes } from '../inbound/http/maintenanceRoutes'
export { mountOverviewRoutes } from '../inbound/http/overviewRoutes'
export { mountRestoreRoutes } from '../inbound/http/restoreRoutes'
