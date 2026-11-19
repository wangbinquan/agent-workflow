export {
  createLocalEvidenceArtifactPort,
  createLocalGraphDevelopmentArtifactPort,
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
  type LocalEvidenceStagingNamespace,
} from '../infrastructure/local/evidenceStaging'
export type {
  EvidenceStagingFactory,
  EvidenceStagingLease,
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '../application/ports/evidenceStaging'

import type { EvidenceDocumentCommands } from '../application/evidenceDocumentCommands'
import type { EvidenceArtifactPort } from '../application/ports/evidenceArtifacts'
import type { EvidenceStagingFactory } from '../application/ports/evidenceStaging'
import {
  createLocalEvidenceStagingFactory,
  createLocalEvidenceStagingNamespace,
} from '../infrastructure/local/evidenceStaging'
import {
  createFileEvidenceDocumentCommands,
  createFileEvidenceDocumentCommandsOnFirstWrite,
} from '../infrastructure/local/fileEvidenceDocumentCommands'
import { selectedRequirementMaterializerContent } from '../application/evidenceStaging'

/** Owner composition selects the writer, artifact receiver and staging together. */
export function composeRequirementMaterializerContent(input: {
  readonly evidence: EvidenceArtifactPort
  readonly stagingRoot: string
  readonly staging?: EvidenceStagingFactory
  readonly documentCommands?: EvidenceDocumentCommands
}): {
  readonly staging: EvidenceStagingFactory
  readonly documentCommands: EvidenceDocumentCommands
} {
  if (input.staging !== undefined) {
    return selectedRequirementMaterializerContent({
      staging: input.staging,
      documentCommands: input.documentCommands,
    })
  }
  const documentCommands =
    input.documentCommands ??
    createFileEvidenceDocumentCommands({
      evidence: input.evidence,
      stagingRoot: input.stagingRoot,
    })
  const staging = createLocalEvidenceStagingFactory(
    createLocalEvidenceStagingNamespace(input.evidence),
    {
      kind: 'requirement',
      root: input.stagingRoot,
    },
  )
  return { staging, documentCommands }
}

export { createFileEvidenceDocumentCommands, createFileEvidenceDocumentCommandsOnFirstWrite }
