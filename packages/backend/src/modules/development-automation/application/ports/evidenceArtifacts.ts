import type { EvidenceBudget, EvidenceBundleRecord, EvidenceEntry } from '../../domain/evidence'
import type { EvidenceContentQueries } from '../pipelineEvidenceRead'
import type { EvidenceDocumentQueries } from '../evidenceDocuments'
import type { EvidenceDownloadQueries } from '../evidenceDownloads'
import type { MissionInputBlobPersistence } from '../missionInputUploadOperations'
import type { AttemptContextStorePort } from './attemptContextStore'

/** Complete content receiver: refs stay opaque; staging/materialization belong to adapters. */
export interface EvidenceArtifactPort extends MissionInputBlobPersistence {
  readonly contents: EvidenceContentQueries
  readonly documents: EvidenceDocumentQueries
  readonly downloads: EvidenceDownloadQueries
  readonly contexts: AttemptContextStorePort
  putBlobFromFile(
    absolutePath: string,
  ): Promise<{ readonly sha256: string; readonly bytes: number }>
  importStagedTree(stagedRoot: string, budget: EvidenceBudget): Promise<EvidenceBundleRecord>
  getBundle(bundleRef: string): EvidenceBundleRecord | null | Promise<EvidenceBundleRecord | null>
  materializeBundle(
    bundleRef: string,
    destination: string,
  ): EvidenceEntry[] | Promise<EvidenceEntry[]>
  materializeBlob(blobRef: string, destination: string): boolean | Promise<boolean>
  hasBlob(blobRef: string): boolean | Promise<boolean>
}
