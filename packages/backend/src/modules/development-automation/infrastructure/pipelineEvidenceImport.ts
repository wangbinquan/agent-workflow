// Explicit physical-input bridge for existing callers and original fixtures.
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type { EvidenceBudget } from '../domain/evidence'
import { canonicalStringify } from '../domain/canonicalJson'
import {
  importPipelineEvidenceWithStaging,
  type PipelineCollectEnvelopeLike,
} from '../application/pipelineEvidenceImport'
import { createLocalEvidenceStagingNamespace } from './local/evidenceStaging'
export type {
  ImportPipelineEvidenceResult,
  PipelineCollectEnvelopeLike,
} from '../application/pipelineEvidenceImport'

export function importPipelineEvidence(
  deps: { readonly evidence: EvidenceArtifactPort },
  input: {
    readonly stagedRoot: string
    readonly envelope: PipelineCollectEnvelopeLike
    readonly expectedHeadSha: string
    readonly expectedTargetSha: string
    readonly budget: EvidenceBudget
  },
) {
  const { stagedRoot, ...business } = input
  const staging = createLocalEvidenceStagingNamespace(deps.evidence).adopt(stagedRoot)
  return importPipelineEvidenceWithStaging({ ...business, staging })
}

export function createPipelineImportAdapter(
  evidence: EvidenceArtifactPort,
  budget: EvidenceBudget,
) {
  return {
    async import(input: Omit<Parameters<typeof importPipelineEvidence>[1], 'budget'>) {
      const out = await importPipelineEvidence({ evidence }, { ...input, budget })
      if (!out.ok) return out
      return {
        ok: true as const,
        manifestJson: canonicalStringify(out.manifest),
        manifestRef: out.manifestRef,
      }
    },
  }
}
