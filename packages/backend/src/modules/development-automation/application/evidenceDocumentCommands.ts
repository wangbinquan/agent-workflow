import type { EvidenceBudget, EvidenceBundleRecord } from '../domain/evidence'

/** The caller owns canonical content and budgets; completion means durable content. */
export interface EvidenceDocumentCommands {
  writeDocument(input: {
    readonly relativePath: string
    readonly content: string
    readonly budget: EvidenceBudget
  }): EvidenceBundleRecord | Promise<EvidenceBundleRecord>
}
