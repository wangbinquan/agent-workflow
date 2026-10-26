// Schema-only composition exit for the live registry.
export {
  schemaContribution,
  applicationConfiguration,
  hostedDatabaseBackups,
  hostedExecutionControl,
  lifecycleAlerts,
  lifecycleRepairAudit,
  maintenanceRuns,
  maintenanceState,
  recoveryEvents,
} from '../infrastructure/persistence/schema'

export { EPOCH2_META_TABLES } from '../infrastructure/persistence/migrationMetaTables'
