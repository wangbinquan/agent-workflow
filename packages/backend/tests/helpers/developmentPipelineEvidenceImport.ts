// Explicit physical-input bridge for existing callers and original fixtures.
// RFC-584: moved verbatim from development-automation infrastructure/pipelineEvidenceImport.ts — only contract tests use it; no production entry reaches it.
import type { EvidenceArtifactPort } from '@/modules/development-automation/application/ports/evidenceArtifacts'
import type { EvidenceBudget } from '@/modules/development-automation/domain/evidence'
import { canonicalStringify } from '@/modules/development-automation/domain/canonicalJson'
import {
  importPipelineEvidenceWithStaging,
  type PipelineCollectEnvelopeLike,
} from '@/modules/development-automation/application/pipelineEvidenceImport'
import { createLocalEvidenceStagingNamespace } from '@/modules/development-automation/infrastructure/local/evidenceStaging'
export type {
  ImportPipelineEvidenceResult,
  PipelineCollectEnvelopeLike,
} from '@/modules/development-automation/application/pipelineEvidenceImport'

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
