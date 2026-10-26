import { createHash } from 'node:crypto'
import proofs from '../fixtures/rfc395-serialized-insert-source-locks.json'

export function reviewedSerializedInsertSites<
  T extends { readonly table: string; readonly line: number },
>(path: string, text: string, sites: readonly T[], readSource: (path: string) => string): T[] {
  const proof = proofs.entries.find((entry) => entry.path === path)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (
    !proof ||
    hash(text) !== proof.sha256 ||
    proof.dependencies.some((entry) => hash(readSource(entry.path)) !== entry.sha256)
  )
    return []
  return sites.filter((site) =>
    proof.sites.some((entry) => entry.table === site.table && entry.line === site.line),
  )
}
