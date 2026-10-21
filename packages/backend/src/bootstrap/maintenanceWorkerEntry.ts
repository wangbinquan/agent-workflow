// RFC-370 §9.2 V9 — the hosted maintenance Worker's composition root.
//
// Register the hosted effects module and load the same thin Worker root.
// Registration completes synchronously before the first init message arrives.
import { registerMaintenanceWorkerEffectModule } from '@/platform/background/maintenanceWorkerEffects'
import './maintenanceWorker'

registerMaintenanceWorkerEffectModule(
  'aw:crewstation-maintenance',
  () => import('./crewstationMaintenance'),
)
