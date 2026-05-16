// Pure-function tests for RFC-013 `resolveReviewView`. The historical-version
// detail page's branch logic (banner / hide controls / fetch from versions
// endpoint) is driven entirely off the discriminated union this returns, so
// the table below is the contract the page is allowed to depend on.

import { describe, expect, it } from 'vitest'
import type { DocVersion } from '@agent-workflow/shared'
import { resolveReviewView } from '@/lib/review/readonly'

const CURRENT_ID = 'dv_current'

function v(id: string, idx: number, decision: DocVersion['decision'] = 'pending'): DocVersion {
  return {
    id,
    taskId: 't',
    reviewNodeId: 'r',
    reviewNodeRunId: 'run',
    sourceNodeId: 's',
    sourcePortName: 'p',
    versionIndex: idx,
    reviewIteration: 0,
    bodyPath: 'x',
    commentsJson: '[]',
    decision,
    decisionReason: null,
    promptSnapshot: null,
    agentSnapshot: null,
    sourceFilePath: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

describe('resolveReviewView', () => {
  it('returns current when versionQuery is undefined', () => {
    expect(resolveReviewView(undefined, CURRENT_ID, [v(CURRENT_ID, 1)])).toEqual({
      mode: 'current',
    })
  })

  it('returns current when versionQuery is empty string', () => {
    expect(resolveReviewView('', CURRENT_ID, [v(CURRENT_ID, 1)])).toEqual({ mode: 'current' })
  })

  it('returns current when versionQuery === currentVersionId', () => {
    expect(resolveReviewView(CURRENT_ID, CURRENT_ID, [v(CURRENT_ID, 1)])).toEqual({
      mode: 'current',
    })
  })

  it('returns historical with hydrated decision + index when versions array matches', () => {
    const versions = [v('a', 1, 'rejected'), v('b', 2, 'iterated'), v(CURRENT_ID, 3, 'pending')]
    expect(resolveReviewView('b', CURRENT_ID, versions)).toEqual({
      mode: 'historical',
      vid: 'b',
      decision: 'iterated',
      versionIndex: 2,
    })
  })

  it('returns historical (unhydrated) when versions still loading (undefined)', () => {
    expect(resolveReviewView('something', CURRENT_ID, undefined)).toEqual({
      mode: 'historical',
      vid: 'something',
    })
  })

  it('returns invalid when versions loaded but vid is unknown', () => {
    const versions = [v(CURRENT_ID, 1)]
    expect(resolveReviewView('bogus', CURRENT_ID, versions)).toEqual({
      mode: 'invalid',
      requested: 'bogus',
    })
  })

  it('returns invalid for unknown vid even when versions array is empty (post-load)', () => {
    expect(resolveReviewView('xyz', CURRENT_ID, [])).toEqual({
      mode: 'invalid',
      requested: 'xyz',
    })
  })
})
