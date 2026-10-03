import type {
  CompleteObservationCohortBuild,
  CompleteObservationSpool,
  CompleteObservationStoredReport,
  CompleteObservationTransferItem,
  CompleteObservationReportRow,
  CompleteObservationReportCount,
} from '../ports/completeObservationReport'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import type { CompleteObservationReportHeader } from '@agent-workflow/shared'
import { completeWorkingTraversal } from './completeWorkingTraversal'

/** The same original TEMP remains open until every output row and receipt is sealed. */
export async function sealCompleteObservationReport(input: {
  readonly report: CompleteObservationStoredReport
  readonly rows: CompleteWorkingRows
  readonly build: CompleteObservationCohortBuild
  readonly header: CompleteObservationReportHeader
  readonly spool: CompleteObservationSpool
  readonly signal?: AbortSignal
}) {
  async function* items(): AsyncIterable<CompleteObservationTransferItem> {
    for await (const row of completeWorkingTraversal<CompleteObservationReportRow>(
      input.rows,
      input.build.rowsNamespace,
      input.signal,
    ))
      yield { kind: 'row', row: row.document }
    for await (const row of completeWorkingTraversal<CompleteObservationReportCount>(
      input.rows,
      input.build.countsNamespace,
      input.signal,
    ))
      yield { kind: 'count', count: row.document }
    yield { kind: 'receipt', key: 'task-source', document: input.build.taskSource }
    for await (const row of completeWorkingTraversal(
      input.rows,
      input.build.receiptsNamespace,
      input.signal,
    ))
      yield { kind: 'receipt', key: row.key, document: row.document }
  }
  return input.spool.seal({
    reportId: input.report.id,
    owner: input.report.owner,
    requestKey: input.report.requestKey,
    header: input.header,
    summary: input.build.summary,
    items: items(),
    signal: input.signal,
  })
}
