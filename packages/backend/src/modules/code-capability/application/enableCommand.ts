// RFC-304 T31b — turning a capability on, with readiness that means something.
//
// The existing `enableCapability` service already writes the cell and arms or
// retracts the trigger. What it could not do is establish whether the cell is
// actually ready: it took the facts as an argument, and its only callers were
// tests handing in `ready`. This closes that loop — the facts are observed, the
// verdict is derived, and the answer returned to the page is what a round would
// actually find.

import type { DbClient } from '@/db/client'
import { gatherReadinessFacts } from '@/modules/code-capability/application/readinessFacts'
import { repairActionsFor } from '@/modules/code-capability/domain/repairActions'
import { parseCodeCapabilityId } from '@/modules/code-capability/domain/stageContract'
import type {
  EnableCapabilityInput,
  EnableCapabilityResult,
  EnableCommand,
} from '@/modules/code-capability/public/commands'
import { enableCapability } from '@/services/codeCapabilityEnable'

export interface EnableCommandDeps {
  db: DbClient
  /** The webhook endpoint this repository's events arrive on. */
  endpointId: string
  provider?: 'gitlab' | 'github'
  now?: () => number
}

export function createEnableCommand(deps: EnableCommandDeps): EnableCommand {
  return {
    async enable(input: EnableCapabilityInput): Promise<EnableCapabilityResult> {
      // Parsed, never trusted: `capability` arrives from an HTTP body, and a
      // typo must be refused by name rather than saved as a cell for a
      // capability the platform does not ship — which would sit in the matrix
      // forever looking like a feature that never runs.
      const capability = parseCodeCapabilityId(input.capability)
      if (capability === undefined) {
        return {
          ok: false,
          code: 'unknown-capability',
          message: `'${input.capability}' is not a capability this platform ships`,
        }
      }

      const templateId = input.templateId ?? null
      const facts = await gatherReadinessFacts({
        db: deps.db,
        repoId: input.repoId,
        capability,
        endpointId: deps.endpointId,
        templateId,
        enabled: input.enabled,
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
      })

      // A binding that does not exist is refused rather than saved: saving it
      // would produce a cell whose readiness says `framework-missing`, sending
      // somebody to restore a framework when the real problem is that they
      // picked a binding id that was never there.
      if (templateId !== null && templateId !== '' && !facts.frameworkExists && !facts.hasBinding) {
        return {
          ok: false,
          code: 'unknown-binding',
          message: `no binding '${templateId}' exists, so this capability was not enabled`,
        }
      }

      // `enabled` is destructured OUT of the facts: the cell takes it as its own
      // field, and `UpsertCellInput.facts` is deliberately `Omit<…, 'enabled'>`
      // so a caller cannot pass one value in the facts and a different one
      // beside them. A cast here would have hidden exactly that.
      const { enabled: _enabled, ...factsWithoutEnabled } = facts
      const result = await enableCapability({
        db: deps.db,
        endpointId: deps.endpointId,
        ownerUserId: input.actorUserId,
        repoId: input.repoId,
        capability,
        templateId,
        enabled: input.enabled,
        facts: factsWithoutEnabled,
        // Bumped per write so a later dependency change (an agent deleted, a
        // framework removed) can be told apart from this write's own state.
        dependencyRevision: 1,
        now: (deps.now ?? Date.now)(),
        // Widened deliberately at the boundary: the PUBLIC contract is closed
        // (so a caller cannot send a key that silently does nothing), while
        // storage is a JSON column. Doing the widening here, once, keeps the
        // closed shape from leaking into the storage type and back out.
        ...(input.triggerConfig !== undefined
          ? { triggerConfig: { ...input.triggerConfig } as Record<string, unknown> }
          : {}),
      })

      return {
        ok: true,
        row: {
          repoId: result.cell.repoId,
          capability: result.cell.capability,
          enabled: result.cell.enabled,
          readiness: result.cell.readiness,
          issues: result.cell.readinessIssues,
          repairActions: repairActionsFor(result.cell.readinessIssues),
          templateId: result.cell.templateId,
        },
      }
    },
  }
}
