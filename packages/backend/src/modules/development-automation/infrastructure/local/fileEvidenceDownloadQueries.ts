import type { EvidenceDownloadQueries } from '../../application/evidenceDownloads'

/** Owns the original Bun file handle and inclusive-end slice translation. */
export function createFileEvidenceDownloadQueries(deps: {
  blobPath(ref: string): string
}): EvidenceDownloadQueries {
  return Object.freeze({
    async open(ref: string) {
      const blob = Bun.file(deps.blobPath(ref))
      if (!(await blob.exists())) return null
      return Object.freeze({
        openAll: () => blob.stream(),
        open: (start: number, endInclusive: number) => blob.slice(start, endInclusive + 1).stream(),
      })
    },
  })
}
