import { randomUUID } from 'node:crypto'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type {
  EvidenceStagingFactory,
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '../application/ports/evidenceStaging'
import { assertEvidenceRelativePath } from '../infrastructure/crewstation/evidenceArtifacts'

/** Content and executable adapters share one selected staging namespace. */
export function composeCrewStationEvidenceStaging(input: {
  readonly helper: WorkspaceHelper
  readonly evidence: EvidenceArtifactPort
  readonly reference: (taskId: string, path: string) => string
}) {
  const taskId = 'development:shared'
  const namespace: EvidenceStagingNamespace = { kind: 'evidence-staging-namespace', reference: {} }
  const stages = new WeakMap<
    object,
    { id: string; safe: boolean; retained: boolean; closed: boolean; written: boolean }
  >()
  const requireStage = (reference: EvidenceStagingReference) => {
    const stage = stages.get(reference.reference)
    if (reference.namespace.reference !== namespace.reference || !stage || stage.closed)
      throw new Error('hosted-evidence-staging-owner-mismatch')
    return stage
  }
  const path = (id: string) => `/work/evidence-staging/${id}`
  const allocate = (id: string) =>
    input.helper.call(
      taskId,
      'evidence-files',
      { method: 'allocate', id },
      { operationId: `evidence-allocate:${id}` },
    )
  const factory: EvidenceStagingFactory = {
    namespace,
    async create() {
      const stage = { id: randomUUID(), safe: true, retained: false, closed: false, written: false }
      const reference: EvidenceStagingReference = {
        kind: 'evidence-staging',
        namespace,
        reference: {},
      }
      stages.set(reference.reference, stage)
      await allocate(stage.id)
      return {
        reference,
        async writeText({ relativeName, text }) {
          requireStage(reference)
          assertEvidenceRelativePath(relativeName)
          stage.written = true
          await input.helper.call(taskId, 'development-workspace', {
            path: `${path(stage.id)}/${relativeName}`,
            method: 'writeText',
            args: [text],
          })
        },
        importTree: (budget) =>
          input.evidence.importStagedTree(
            input.reference(taskId, path(requireStage(reference).id)),
            budget,
          ),
        async putDocument(text) {
          requireStage(reference)
          stage.written = true
          const file = `${path(stage.id)}/manifest-${randomUUID()}.json`
          await input.helper.call(taskId, 'development-workspace', {
            path: file,
            method: 'writeText',
            args: [text],
          })
          return input.evidence.putBlobFromFile(input.reference(taskId, file))
        },
        async close() {
          if (stage.closed) return
          if (!stage.safe || stage.retained) return
          await input.helper.call(
            taskId,
            'evidence-files',
            { method: 'dispose', id: stage.id },
            { operationId: `evidence-dispose:${stage.id}` },
          )
          stage.closed = true
        },
      }
    },
  }
  return {
    namespace,
    factory,
    async begin(reference: EvidenceStagingReference, stableId?: string) {
      const stage = requireStage(reference)
      if (stableId !== undefined && stage.id !== stableId) {
        // Mutation retries reopen the same durable sink. Keep it until owner
        // retention has released the CS execution receipt and its output.
        if (!/^[a-f0-9]{64}$/.test(stableId)) throw new Error('hosted-evidence-operation-invalid')
        if (stage.written || !stage.safe)
          throw new Error('hosted-evidence-staging-already-populated')
        await allocate(stableId)
        await input.helper.call(
          taskId,
          'evidence-files',
          { method: 'dispose', id: stage.id },
          { operationId: `evidence-dispose:${stage.id}` },
        )
        stage.id = stableId
        stage.retained = true
      }
      stage.safe = false
      return { taskId, path: path(stage.id), id: stage.id }
    },
    settled(reference: EvidenceStagingReference) {
      requireStage(reference).safe = true
    },
  }
}
