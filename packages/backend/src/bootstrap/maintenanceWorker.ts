// RFC-389 — the maintenance Worker's thin entry root.
import { runMaintenanceWorker } from '@/platform/background/maintenanceWorkerRuntime'
import { composeMaintenanceWorkerGraph } from './maintenanceWorkerGraph'

runMaintenanceWorker({ composeGraph: composeMaintenanceWorkerGraph })
