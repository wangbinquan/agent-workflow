import type { Actor } from '@/auth/actor'
import type { CompleteObservationReport } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type { observationReports } from '@/db/schema'
import type {
  CompleteObservationManifest,
  CompleteObservationReportRequest,
  CompleteObservationStoredReport,
} from '../ports/completeObservationReport'

export const completeObservationActorScope = (actor: Actor) =>
  sha256Hex(
    JSON.stringify([
      actor.user.id,
      actor.user.status,
      actor.source,
      actor.purpose ?? null,
      actor.patId ?? null,
      actor.authorityRevision ?? 0,
      [...actor.permissions].sort(),
    ]),
  )
export function encodeCompleteReportRequest(request: CompleteObservationReportRequest) {
  return JSON.stringify({
    ...request,
    actor: { ...request.actor, permissions: [...request.actor.permissions].sort() },
  })
}
export function decodeCompleteReport(
  row: typeof observationReports.$inferSelect,
): CompleteObservationStoredReport {
  const encoded = JSON.parse(row.request) as Omit<CompleteObservationReportRequest, 'actor'> & {
    actor: Omit<Actor, 'permissions'> & {
      permissions: Actor['permissions'] extends ReadonlySet<infer P> ? P[] : never
    }
  }
  if (!Array.isArray(encoded.actor.permissions))
    throw new Error('Complete report original actor document invalid')
  const request = {
    ...encoded,
    actor: { ...encoded.actor, permissions: new Set(encoded.actor.permissions) },
  }
  if (completeObservationActorScope(request.actor) !== row.actorScope)
    throw new Error('Complete report accepted actor changed')
  const report = JSON.parse(row.report) as CompleteObservationReport
  if (
    report.state !== row.state ||
    (report.state === 'ready' ? report.header.reportId : report.reportId) !== row.id
  )
    throw new Error('Complete report cache identity changed')
  return {
    id: row.id,
    requestKey: row.requestKey,
    actorScope: row.actorScope,
    generation: row.generation,
    owner: row.owner,
    request,
    report,
    manifest:
      row.manifest === null ? null : (JSON.parse(row.manifest) as CompleteObservationManifest),
  }
}
export interface CompleteReportProgress {
  pages: string
  rows: string
  counts: string
  receipts: string
  digest: string
}
export const completeReportEmptyProgress = (): CompleteReportProgress => ({
  pages: '0',
  rows: '0',
  counts: '0',
  receipts: '0',
  digest: '0'.repeat(64),
})
