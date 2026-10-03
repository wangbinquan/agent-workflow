import type { EvidenceArtifactPort } from '@/modules/development-automation/composition'
import type { EvidenceDocumentQueries } from '@/modules/development-automation/application/evidenceDocuments'
import type { EvidenceBudget } from '@/modules/development-automation/domain/evidence'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'

export type EvidenceEffect =
  | 'put-file'
  | 'put-blob'
  | 'import-tree'
  | 'materialize-blob'
  | 'materialize-bundle'

/** A complete prototype receiver with real bytes in a separately owned adapter root. */
export class GatedEvidenceArtifacts implements EvidenceArtifactPort {
  readonly #store: EvidenceStore
  readonly #gate: (
    effect: EvidenceEffect,
    reference: string,
    budget?: EvidenceBudget,
  ) => Promise<void>
  readonly #fallback?: EvidenceDocumentQueries
  #calls = 0

  constructor(
    root: string,
    gate: (effect: EvidenceEffect, reference: string, budget?: EvidenceBudget) => Promise<void>,
    fallback?: EvidenceDocumentQueries,
  ) {
    this.#store = new EvidenceStore(root)
    this.#gate = gate
    this.#fallback = fallback
  }

  get calls() {
    return this.#calls
  }
  get contents() {
    return this.#store.contents
  }
  get downloads() {
    return this.#store.downloads
  }
  get contexts() {
    return this.#store.contexts
  }
  get documents(): EvidenceDocumentQueries {
    const primary = this.#store.documents
    const fallback = this.#fallback
    return Object.freeze({
      async readText(input: Parameters<EvidenceDocumentQueries['readText']>[0]) {
        const content = await primary.readText(input)
        return content === null && fallback !== undefined ? await fallback.readText(input) : content
      },
    })
  }

  async putFile(absolutePath: string) {
    this.#calls += 1
    await this.#gate('put-file', absolutePath)
    return await this.#store.putFile(absolutePath)
  }
  async putBlobFromFile(absolutePath: string) {
    this.#calls += 1
    await this.#gate('put-blob', absolutePath)
    return await this.#store.putBlobFromFile(absolutePath)
  }
  async importStagedTree(stagedRoot: string, budget: EvidenceBudget) {
    this.#calls += 1
    await this.#gate('import-tree', stagedRoot, budget)
    return await this.#store.importStagedTree(stagedRoot, budget)
  }
  getBundle(bundleRef: string) {
    return this.#store.getBundle(bundleRef)
  }
  hasBlob(blobRef: string) {
    return this.#store.hasBlob(blobRef)
  }
  async materializeBlob(blobRef: string, destination: string) {
    this.#calls += 1
    await this.#gate('materialize-blob', blobRef)
    return this.#store.materializeBlob(blobRef, destination)
  }
  async materializeBundle(bundleRef: string, destination: string) {
    this.#calls += 1
    await this.#gate('materialize-bundle', bundleRef)
    return this.#store.materializeBundle(bundleRef, destination)
  }
}
