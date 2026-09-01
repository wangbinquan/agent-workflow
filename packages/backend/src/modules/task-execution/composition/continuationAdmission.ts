// SQLite compatibility seam. New provider-aware bootstrap code injects
// TaskExecutionIntentPersistence instead of exporting a transaction handle.
export { submitTaskContinuationTx } from '../infrastructure/sqliteTaskExecutionIntentAdmission'
