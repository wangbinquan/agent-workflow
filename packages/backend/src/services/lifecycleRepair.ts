// RFC-349 compatibility facade. Provider-neutral recovery callers consume
// TaskRecoveryOperations; legacy Diagnose Panel behavior remains isolated in
// the SQLite persistence adapter during transport cutover.
export * from '@/platform/persistence/sqlite/taskLifecycleRepair'
