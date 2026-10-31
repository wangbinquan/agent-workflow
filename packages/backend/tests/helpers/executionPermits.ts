import { createExecutionPermitRegistry } from '@/modules/task-execution/engine/kernel/permits'

/** Legacy direct fixtures explicitly share one registry, as their old module imports did. */
export const testExecutionPermits = createExecutionPermitRegistry()
