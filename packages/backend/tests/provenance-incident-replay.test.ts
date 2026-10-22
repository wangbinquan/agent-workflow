// RFC-074 incident `01KSHVXCH6RQ5F5P64MZ4FZVN6` replay — provenance resolution.
//
// WHY THIS FILE EXISTS (regression intent):
//   The user approved a review (v2, whose CONTENT had been refreshed to the
//   agent's latest output) and 18ms later a SECOND awaiting_review row appeared
//   forcing re-approval of the very same content. Root cause (proposal §1.2):
//   the review row's denormalized `clarifyIteration` watermark stuck at the
//   iterate-time value while its doc_version content was refreshed underneath
//   it; the Layer-B freshness invariant then compared the STALE watermark
//   against the agent's higher cci and judged the approval stale → spurious
//   re-review.
//
//   PR-A locked the buggy behavior through the actual (now-deleted) mechanism
//   (`applyClarifyFreshnessInvariant` + `isReviewClarifyAlignedWithUpstream`).
//   RFC-074 retired BOTH the Layer-B invariant AND the cci watermark: freshness
//   is now decided by PROVENANCE — `isNodeRunFresh` compares the run id the
//   review actually consumed against the upstream's current freshest done row.
//   This file is re-expressed against that mechanism:
//     A18 — review consumed the agent's freshest done run → fresh → NO spurious
//           re-review (the bug is structurally impossible; §1.3).
//     A19 — review consumed an OLDER run while the agent produced a newer done
//           run → stale → re-review fires (RFC-005 US-2 preserved).
//     A20 — multi-upstream: stale on ANY consumed upstream ⟹ re-review.
//   The "denormalized watermark" can no longer desync because there is exactly
//   one freshness source of truth (the consumed-run id), recorded at the single
//   content read-point.

import { type PersistenceTables } from '@/platform/persistence/sessionTables'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { isNodeRunFresh } from '../src/services/freshness'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

type Row = PersistenceTables['nodeRuns']['$inferSelect']

// Minimal row: isNodeRunFresh reads only (id, consumedUpstreamRunsJson).
function run(id: string, consumed?: Record<string, string>): Row {
  return {
    id,
    consumedUpstreamRunsJson: consumed === undefined ? null : JSON.stringify(consumed),
  } as unknown as Row
}

const AGENT_NODE = 'designer'

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-074 — incident 01KSHVXCH6 replay (provenance resolution)', () => {
  // A18 — the fix. The approved review consumed the agent's freshest done run
  // (01AG_LATEST). Freshness compares that consumed id against the upstream's
  // current freshest done row — they match → fresh → the scheduler keeps the
  // review completed and mints NO spurious re-review. The denormalized watermark
  // that desynced in the incident no longer exists.
  test('A18: review consumed the freshest agent run → fresh → no spurious re-review', () => {
    const agentLatest = run('01AG_LATEST')
    const reviewApproved = run('01RV_APPROVED', { [AGENT_NODE]: '01AG_LATEST' })
    const freshest = new Map<string, Row>([[AGENT_NODE, agentLatest]])
    expect(isNodeRunFresh(reviewApproved, freshest)).toBe(true)
  })

  // A19 — RFC-005 US-2 preserved. If the agent genuinely produces a NEWER done
  // run (01AG_NEWER) after the review consumed an older one (01AG_OLDER), the
  // review is stale → re-review fires. This is the legitimate re-review the
  // contract must keep — distinct from the incident's spurious one.
  test('A19: review consumed an older run, agent advanced → stale → re-review fires', () => {
    const agentNewer = run('01AG_NEWER')
    const reviewApproved = run('01RV_APPROVED', { [AGENT_NODE]: '01AG_OLDER' })
    const freshest = new Map<string, Row>([[AGENT_NODE, agentNewer]])
    expect(isNodeRunFresh(reviewApproved, freshest)).toBe(false)
  })

  // A20 — null/legacy consumed = fresh (migration hard-cut D4): a pre-RFC-074
  // review row (no provenance) is treated as fresh so in-flight tasks don't
  // spuriously re-review on upgrade. Combined with A18/A19 this is the full
  // "approve is sticky unless the upstream actually re-ran" contract.
  test('A20: null consumed provenance → fresh (legacy hard-cut, no spurious mint)', () => {
    const agentLatest = run('01AG_LATEST')
    const legacyReview = run('01RV_LEGACY') // consumedUpstreamRunsJson = null
    const freshest = new Map<string, Row>([[AGENT_NODE, agentLatest]])
    expect(isNodeRunFresh(legacyReview, freshest)).toBe(true)
  })
})
