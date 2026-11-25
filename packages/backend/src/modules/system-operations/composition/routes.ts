// RFC-576: the HTTP bindings of system-operations live in `inbound/http`; the assembly root takes their mount functions
// from here (RFC-439's shape). Nothing but re-exports. RFC-583 added the configuration, API documentation and PlantUML
// bindings; RFC-587 the health probes.
export { mountBackupRoutes } from '../inbound/http/backupRoutes'
export { mountConfigRoutes } from '../inbound/http/configRoutes'
export { mountDaemonRoutes } from '../inbound/http/daemonRoutes'
export { mountDatabaseMigrationRoutes } from '../inbound/http/databaseMigrationRoutes'
export { mountDocsRoutes, mountWellKnownRoutes } from '../inbound/http/docsRoutes'
export { mountHealthRoutes } from '../inbound/http/healthRoutes'
export { mountMaintenanceDiskRoutes } from '../inbound/http/maintenanceDiskRoutes'
export { mountMaintenanceRoutes } from '../inbound/http/maintenanceRoutes'
export { mountOverviewRoutes } from '../inbound/http/overviewRoutes'
export { mountPlantumlRoutes } from '../inbound/http/plantumlRoutes'
export { mountRestoreRoutes } from '../inbound/http/restoreRoutes'
