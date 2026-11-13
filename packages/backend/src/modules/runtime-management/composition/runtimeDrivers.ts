// RFC-492 (RFC-294 §4.7): bootstrap's entry to the runtime driver family, which now lives in this module's
// `infrastructure/drivers/`. Re-exports only: the startup declaration self-check (`bootstrap/daemonApplication.ts`) and
// the managed-injection name-conflict judgment bootstrap puts into Resource Catalog's task-execution policy bundle
// (`bootstrap/taskExecutionResourceDependencies.ts`).
export { getRuntimeDriver, RUNTIME_KINDS } from '../infrastructure/drivers'
export { assertRuntimeDeclarations } from '../infrastructure/drivers/selfCheck'
export {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '../infrastructure/drivers/injectionIdentity'
