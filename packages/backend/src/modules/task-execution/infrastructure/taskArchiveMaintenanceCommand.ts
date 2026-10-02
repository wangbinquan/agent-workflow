// Standalone compatibility; composition chooses content and the shared coordinator owns archive rules.
export { createDrizzleTaskArchiveMaintenanceCommand } from '../composition/taskArchiveMaintenance'
export { ARCHIVED_TABLES, ARCHIVE_EXEMPT_TABLES } from './taskArchiveContentCoordinator'
