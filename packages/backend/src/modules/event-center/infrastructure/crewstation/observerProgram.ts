// RFC-370 M2 — the task-image receiver of custom event observer programs.
import { canonicalJson } from '@agent-workflow/shared'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  CustomObserverProgramFactory,
  CustomObserverProgramResult,
} from '../../application/ports/customObserverProgram'
import { sha256Hex } from '@/util/hash'

/** The ordinary observer policy owns envelopes, cursor validation and dedupe;
 * only the selected task-image receiver resolves interpreters or runs scripts. */
export function createCrewStationObserverProgramFactory(
  helper: WorkspaceHelper,
): CustomObserverProgramFactory {
  return {
    create(input) {
      const id = sha256Hex(canonicalJson(input))
      const taskId = `observer:${input.sourceRef.id}`
      const program = Object.freeze({})
      const workspace = Object.freeze({})
      let allocated = false
      let prepared = false
      let written = false
      let inputJson: string | undefined
      let unsafeWriter = false
      const requireWorkspace = (ref: object) => {
        if (ref !== workspace || !allocated)
          throw new Error('custom-observer-workspace-reference-mismatch')
      }
      return {
        async resolveProgram() {
          const available = await helper.call<boolean>(taskId, 'observer-resolve', {
            language: input.draft.program.language,
          })
          return available ? program : null
        },
        allocateWorkspace() {
          allocated = true
          return workspace
        },
        prepareWorkspace(ref) {
          requireWorkspace(ref)
          prepared = true
        },
        writeInput(ref, json) {
          requireWorkspace(ref)
          inputJson = json
        },
        writeProgram(ref) {
          requireWorkspace(ref)
          written = true
        },
        async run(ref, selected) {
          requireWorkspace(ref)
          if (selected !== program) throw new Error('custom-observer-program-reference-mismatch')
          if (!prepared || !written || inputJson === undefined)
            throw new Error('custom-observer-workspace-not-prepared')
          unsafeWriter = true
          const result = await helper.call<CustomObserverProgramResult>(
            taskId,
            'observer-run',
            { id, input, envelopeJson: inputJson },
            {
              operationId: `observer:${id}`,
              // The inner managed process owns the diagnostic timeout. Leave
              // enough time to reap and flush its truthful terminal receipt.
              timeoutMs: input.draft.program.timeoutMs + 30_000,
            },
          )
          unsafeWriter = result.outcome === 'child-unkillable'
          return result
        },
        async disposeWorkspace(ref) {
          requireWorkspace(ref)
          if (unsafeWriter) return
          await helper.call(
            taskId,
            'observer-dispose',
            { id },
            { operationId: `observer:${id}:dispose` },
          )
        },
      }
    },
  }
}
