// RFC-370 §9.2 V9 — the hosted maintenance Worker's composition root.
//
// The platform Worker (`platform/background/maintenanceWorker.ts`) never
// imports a deployment or business module. A hosted deployment starts this
// entry instead: it registers the CrewStation effect module under the
// symbolic name its descriptor carries, then runs the ordinary platform
// Worker. Registration completes synchronously while this module evaluates,
// before the supervisor's first init message can arrive.
import { registerMaintenanceWorkerEffectModule } from '@/platform/background/maintenanceWorkerEffects'
import '@/platform/background/maintenanceWorker'

registerMaintenanceWorkerEffectModule(
  'aw:crewstation-maintenance',
  () => import('./crewstationMaintenance'),
)
