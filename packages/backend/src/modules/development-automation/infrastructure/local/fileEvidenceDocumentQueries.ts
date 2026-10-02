import { readFileSync } from 'node:fs'
import type { EvidenceDocumentQueries } from '../../application/evidenceDocuments'

/** Retains the original bundle lookup, missing-entry and file-read behavior. */
export function createFileEvidenceDocumentQueries(deps: {
  getBundle(ref: string): {
    readonly entries: readonly { readonly relativePath: string; readonly sha256: string }[]
  } | null
  blobPath(ref: string): string
}): EvidenceDocumentQueries {
  return Object.freeze({
    readText(input: Parameters<EvidenceDocumentQueries['readText']>[0]) {
      const bundle = deps.getBundle(input.bundleRef)
      const entry = bundle?.entries.find((item) => item.relativePath === input.relativePath)
      if (bundle === null || bundle === undefined || entry === undefined) return null
      return readFileSync(deps.blobPath(entry.sha256), 'utf8')
    },
  })
}
