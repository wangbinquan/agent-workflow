import type { GraphDesignDocument, GraphEvidenceBinding } from '@agent-workflow/shared'
import { staleGraphReads } from './model'

export interface GraphEvidenceTarget {
  readonly document: GraphDesignDocument
  readonly basisDigest: string | null
  readonly candidateTreeOid: string | null
  readonly profileDigests: Readonly<Record<string, string>>
  readonly environmentDigest: string | null
  readonly commitSha: string | null
}

export function projectGraphEvidence(
  evidence: GraphEvidenceBinding,
  target: GraphEvidenceTarget,
): {
  readonly evidence: GraphEvidenceBinding
  readonly freshness: 'current' | 'stale' | 'unknown'
  readonly reasons: readonly string[]
} {
  const reasons = staleGraphReads(target.document, evidence.readSet).map((id) => `changed:${id}`)
  if (target.basisDigest !== null && evidence.basisDigest !== target.basisDigest)
    reasons.push('different-implementation-basis')
  if (evidence.candidateTreeOid !== null && target.candidateTreeOid !== evidence.candidateTreeOid)
    reasons.push('different-candidate-content')
  if (
    evidence.profileRef &&
    (target.profileDigests[`${evidence.profileRef.id}@${evidence.profileRef.revision}`] ??
      target.profileDigests[evidence.profileRef.id]) !== evidence.profileRef.digest
  )
    reasons.push('different-verification-profile')
  if (
    evidence.environmentDigest !== null &&
    target.environmentDigest !== evidence.environmentDigest
  )
    reasons.push('different-environment')
  if (evidence.ci && evidence.ci.sha !== target.commitSha) reasons.push('different-ci-sha')
  const incomplete =
    evidence.kind === 'execution' &&
    (!evidence.executionRef ||
      !evidence.artifactRef ||
      !evidence.artifactDigest ||
      !evidence.candidateTreeOid ||
      !evidence.environmentDigest ||
      !evidence.profileRef)
  return {
    evidence,
    freshness: reasons.length ? 'stale' : incomplete ? 'unknown' : 'current',
    reasons: incomplete ? [...reasons, 'execution-provenance-incomplete'] : reasons,
  }
}

export function graphObligationCoverage(
  document: GraphDesignDocument,
  evidence: readonly ReturnType<typeof projectGraphEvidence>[],
): readonly {
  readonly obligationId: string
  readonly state: 'passed' | 'failed' | 'pending'
  readonly evidenceIds: readonly string[]
}[] {
  return document.obligations.map((obligation) => {
    const relevant = evidence.filter(
      (item) =>
        item.freshness === 'current' &&
        item.evidence.obligationIds.includes(obligation.id) &&
        item.evidence.kind ===
          (obligation.verification.kind === 'manual' ? 'acceptance' : 'execution'),
    )
    const latest = [...relevant].sort(
      (a, b) =>
        b.evidence.recordedAt - a.evidence.recordedAt || b.evidence.id.localeCompare(a.evidence.id),
    )[0]
    return {
      obligationId: obligation.id,
      state:
        latest?.evidence.result === 'failed'
          ? 'failed'
          : latest?.evidence.result === 'passed'
            ? 'passed'
            : 'pending',
      evidenceIds: relevant.map((item) => item.evidence.id),
    }
  })
}
