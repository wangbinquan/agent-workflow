import type {
  CompleteObservationManifest,
  CompleteObservationTransferItem,
  CompleteObservationTransferPage,
} from '../ports/completeObservationReport'
export const completeReportInitialDigest = '0'.repeat(64)
export function completeReportTransferPage(
  reportId: string,
  ordinal: string,
  previousDigest: string,
  items: readonly CompleteObservationTransferItem[],
  hash: (text: string) => string,
): CompleteObservationTransferPage {
  if (
    !items.length ||
    items.length > 500 ||
    !/^(0|[1-9]\d*)$/.test(ordinal) ||
    !/^[a-f0-9]{64}$/.test(previousDigest)
  )
    throw new Error('Complete transfer page identity invalid')
  return {
    reportId,
    ordinal,
    previousDigest,
    digest: hash(JSON.stringify([reportId, ordinal, previousDigest, items])),
    items,
  }
}
export function assertCompleteReportTransferPage(
  page: CompleteObservationTransferPage,
  id: string,
  ordinal: string,
  previousDigest: string,
  hash: (text: string) => string,
) {
  if (
    page.reportId !== id ||
    page.ordinal !== ordinal ||
    page.previousDigest !== previousDigest ||
    page.digest !== completeReportTransferPage(id, ordinal, previousDigest, page.items, hash).digest
  )
    throw new Error('Complete sealed page identity, population or digest changed')
}
export function assertCompleteReportManifest(
  actual: {
    readonly pages: bigint
    readonly rows: bigint
    readonly counts: bigint
    readonly receipts: bigint
    readonly digest: string
  },
  manifest: CompleteObservationManifest,
) {
  for (const key of ['pages', 'rows', 'counts', 'receipts'] as const)
    if (String(actual[key]) !== manifest[key])
      throw new Error('Complete sealed population missing: ' + key)
  if (actual.digest !== manifest.digest) throw new Error('Complete sealed final digest changed')
}
