import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { EvidenceDownloadQueries } from '../../application/evidenceDownloads'

/** Owns local presence checks and lazy byte streams with inclusive range ends. */
export function createFileEvidenceDownloadQueries(deps: {
  blobPath(ref: string): string
}): EvidenceDownloadQueries {
  return Object.freeze({
    async open(ref: string) {
      const path = deps.blobPath(ref)
      const blob = Bun.file(path)
      if (!(await blob.exists())) return null
      return Object.freeze({
        openAll: () => Readable.toWeb(createReadStream(path)),
        open: (start: number, endInclusive: number) =>
          Readable.toWeb(createReadStream(path, { start, end: endInclusive })),
      })
    },
  })
}
