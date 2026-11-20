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

import {
  createFileEvidenceDocumentCommands,
  createFileEvidenceDocumentCommandsOnFirstWrite,
} from '../infrastructure/local/fileEvidenceDocumentCommands'

export { createFileEvidenceDocumentCommands, createFileEvidenceDocumentCommandsOnFirstWrite }
