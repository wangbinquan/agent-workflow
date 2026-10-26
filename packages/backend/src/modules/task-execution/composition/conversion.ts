import { readOnlyProbes as taskProbes } from '../infrastructure/migration/probes'
import { readOnlyProbes as runProbes } from '../infrastructure/runSelection/table/probes'
export const readOnlyProbes = [...taskProbes, ...runProbes]
export { conversion as taskConversion } from '../infrastructure/migration/task'
export { conversion as runConversion } from '../infrastructure/migration/run'
