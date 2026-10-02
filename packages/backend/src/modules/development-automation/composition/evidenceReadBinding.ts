import type { EvidenceDocumentQueries } from '../application/evidenceDocuments'
import type { EvidenceDownloadQueries } from '../application/evidenceDownloads'
import type { EvidenceContentQueries } from '../application/pipelineEvidenceRead'

/** All read faces share one bootstrap selection; writes are a separate seam. */
export interface EvidenceReadBinding {
  readonly contents: EvidenceContentQueries
  readonly documents: EvidenceDocumentQueries
  readonly downloads: EvidenceDownloadQueries
}
