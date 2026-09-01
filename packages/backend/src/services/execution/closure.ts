// RFC-349 compatibility export. New launches use the async atomic
// TaskExecutionResourceBinding; the stored-closure codec and legacy SQLite
// characterization walk remain isolated in task-execution infrastructure.
export * from '@/modules/task-execution/infrastructure/legacyCallClosure'
