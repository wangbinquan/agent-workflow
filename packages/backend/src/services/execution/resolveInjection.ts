// RFC-349 compatibility export. Production task execution resolves injection
// through the provider-neutral TaskExecutionResourceBinding; the legacy
// SQLite oracle lives in task-execution infrastructure for focused tests.
export * from '@/modules/task-execution/infrastructure/legacyTaskExecutionInjectionResolver'
