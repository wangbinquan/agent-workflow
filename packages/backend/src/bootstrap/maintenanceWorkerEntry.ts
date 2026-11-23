// RFC-370 §9.2 V9 — the hosted maintenance Worker's composition root.
//
// RFC-541: it is its own thin root over the shared runtime and graph. Its effect
// descriptor names `aw:crewstation-maintenance`; the loader it hands the effects
// scope maps that name to the CrewStation effects module (still loaded on demand)
// and imports any other module by name. No Worker-wide registration remains.
import { runMaintenanceWorker } from '@/platform/background/maintenanceWorkerRuntime'
import { openMaintenanceWorkerEffectsScope } from './maintenanceWorkerEffects'
import { composeMaintenanceWorkerGraph } from './maintenanceWorkerGraph'

runMaintenanceWorker({
  composeGraph: composeMaintenanceWorkerGraph,
  openEffectsScope: (input) =>
    openMaintenanceWorkerEffectsScope({
      ...input,
      importModule: (specifier) =>
        specifier === 'aw:crewstation-maintenance'
          ? import('./crewstationMaintenance')
          : import(specifier),
    }),
})
