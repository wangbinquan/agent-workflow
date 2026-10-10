import type { Actor } from '@/auth/actor'
import type {
  CompleteObservationReportPage,
  CompleteObservationSection,
} from '@agent-workflow/shared'
import type {
  CompleteObservationManifest,
  CompleteObservationReportRequest,
  CompleteObservationStoredReport,
  CompleteObservationTransferPage,
} from './completeObservationReport'
export interface CompleteObservationReportCache {
  readonly generation: string
  ensure(
    request: CompleteObservationReportRequest,
    requestKey: string,
    actorScope: string,
    owner: string,
    id: string,
  ): Promise<CompleteObservationStoredReport>
  get(id: string): Promise<CompleteObservationStoredReport | undefined>
  claim(id: string, owner: string): Promise<CompleteObservationStoredReport>
  renew(id: string, owner: string): Promise<boolean>
  phase(id: string, owner: string, phase: string): Promise<void>
  stage(id: string, owner: string, page: CompleteObservationTransferPage): Promise<void>
  stageBatch(
    id: string,
    owner: string,
    pages: readonly CompleteObservationTransferPage[],
  ): Promise<void>
  publish(id: string, owner: string, manifest: CompleteObservationManifest): Promise<void>
  unavailable(id: string, owner: string, gaps: readonly string[]): Promise<void>
  fail(id: string, owner: string, error: string): Promise<void>
  assertReadable(actor: Actor, report: CompleteObservationStoredReport): Promise<void>
  page<T>(
    report: CompleteObservationStoredReport,
    query: {
      readonly section: CompleteObservationSection
      readonly parent: string | null
      readonly after: string | null
      readonly limit: number
    },
  ): Promise<CompleteObservationReportPage<T>>
}
