import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { readOnlyProbes as taskProbes } from '../infrastructure/migration/probes'
import { readOnlyProbes as runProbes } from '../infrastructure/runSelection/table/probes'
import { conversion as task } from '../infrastructure/migration/task'
import { taskSettlement } from '../infrastructure/migration/settlement'
export const readOnlyProbes = [...taskProbes, ...runProbes]
/** RFC-626 §3.2.3: the task conversion also says how ending a task rewrites this module's rows. */
export const taskConversion: ConversionContribution = { ...task, settlement: taskSettlement }
export { conversion as runConversion } from '../infrastructure/migration/run'
