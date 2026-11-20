import { bindMcpDiagnosticsRuntime, createMcpDiagnosticsApplication } from './mcpDiagnostics'
import type { composeLocalMcpDiagnostics } from './localMcpDiagnostics'
import { composeMcpRuntimeTestProvider } from './mcpRuntimeTestPersistence'
import { createHostedMcpProbe } from '../infrastructure/crewstation/mcpProbe'
import {
  createCrewStationMcpDiagnosticsEffects,
  reconcileWhenFenceHeld,
  type HostedInput,
} from '../infrastructure/crewstation/mcpDiagnosticsEffects'
// RFC-519: the hosted effects live in infrastructure/crewstation.
export { createCrewStationMcpDiagnosticsEffects } from '../infrastructure/crewstation/mcpDiagnosticsEffects'

/** Resource Catalog retains admission, ACL, turn/session leases and UI events;
 * only its selected execution and workspace effects differ. */
export function createCrewStationMcpDiagnostics(
  input: HostedInput,
): typeof composeLocalMcpDiagnostics {
  // RFC-488: a test fixture selects the local family in bootstrap; this family is hosted only.
  return (options) => {
    const selected = {
      ...options,
      ...composeMcpRuntimeTestProvider(input.db, (tx) =>
        input.fence.assertHeld(tx, input.fence.current()),
      ),
    }
    const effects = createCrewStationMcpDiagnosticsEffects(input, selected)
    const runtime = bindMcpDiagnosticsRuntime(
      createMcpDiagnosticsApplication({ ...selected, effects, maintainOnRead: false }),
      options,
    )
    // Configuration/ACL changes may be accepted by a standby service slot.
    // Their durable invalidation is drained by the active background owner.
    const reconcileDurableIntents = reconcileWhenFenceHeld(input.fence, () =>
      runtime.reconcileDurableIntents(),
    )
    return Object.freeze({
      ...runtime,
      reconcileDurableIntents,
      reconciliation: Object.freeze({ reconcileDurableIntents }),
      // No hosted entry spawns in the service slot (RFC-370 §3.3), the probe included.
      probeRunner: createHostedMcpProbe({ helper: input.helper }),
    })
  }
}
