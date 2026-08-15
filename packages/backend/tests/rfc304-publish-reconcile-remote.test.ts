// RFC-304 §7 T22b — reading a batch back from the code host.
//
// This is the half of publish recovery that touches reality, and its failure
// modes are all "adopted the wrong thing":
//
//   match by time/author  ⇒ a human who replies quickly gets their comment
//                           adopted as one of ours;
//   match every marker    ⇒ findings from EARLIER rounds count as part of this
//                           batch, so entries this batch never sent are marked
//                           already-posted and stay permanently unpublished
//                           while the ledger reports success;
//   read only drafts      ⇒ a crash AFTER bulk_publish looks like nothing was
//                           posted, and the whole batch is resent onto an MR
//                           that already displays it — which is precisely the
//                           duplicate-comment bug the intent mechanism exists
//                           to prevent, reintroduced by an incomplete read.
//
// So identity is a fingerprint marker carried in the body, scoped to the
// batch's own fingerprints, read from every surface the host can hold them in.

import { describe, expect, test } from 'bun:test'
import { planPublishRecovery } from '../src/modules/code-capability/domain/publishIntent'
import {
  duplicateFingerprints,
  fingerprintOf,
  observeBatch,
  readBackSurfaces,
  withFingerprintMarker,
  type RemoteComment,
} from '../src/modules/code-capability/domain/publishReconcileRemote'

const posted = (fingerprint: string, externalId: string, body = 'some remark'): RemoteComment => ({
  externalId,
  body: withFingerprintMarker(body, fingerprint),
})

describe('RFC-304 T22b — the fingerprint marker round-trips', () => {
  test('a marked body yields its fingerprint back', () => {
    const body = withFingerprintMarker('Unchecked error on line 12.', 'fp-abc123')
    expect(fingerprintOf(body)).toBe('fp-abc123')
    // The reader still sees the remark; the marker is an HTML comment.
    expect(body).toContain('Unchecked error on line 12.')
  })

  test("a human's comment has no fingerprint", () => {
    // The failure this prevents: matching by author and timestamp would adopt a
    // fast human reply as one of our findings.
    expect(fingerprintOf('I disagree, this is intentional.')).toBeNull()
  })

  test('a malformed or foreign marker is not accepted', () => {
    expect(fingerprintOf('<!-- aw-finding: -->')).toBeNull()
    expect(fingerprintOf('<!-- other-tool:fp-1 -->')).toBeNull()
  })

  test('markers survive surrounding whitespace', () => {
    expect(fingerprintOf('body\n\n<!--   aw-finding:fp-1   -->')).toBe('fp-1')
  })
})

describe('RFC-304 T22b — observing one batch', () => {
  test('only the batch’s own fingerprints are reported', () => {
    // The MR also carries findings from earlier rounds. Counting those as part
    // of this batch would mark entries "already posted" that this batch never
    // sent — they would stay unpublished forever while the ledger says done.
    const observation = observeBatch(
      ['fp-a', 'fp-b'],
      [posted('fp-a', 'note-1'), posted('fp-old', 'note-0'), posted('fp-b', 'note-2')],
    )
    expect(observation.present).toEqual({ 'fp-a': 'note-1', 'fp-b': 'note-2' })
    expect(observation.present['fp-old']).toBeUndefined()
  })

  test('unmarked comments are ignored entirely', () => {
    const observation = observeBatch(
      ['fp-a'],
      [{ externalId: 'note-9', body: 'looks fine to me' }, posted('fp-a', 'note-1')],
    )
    expect(observation.present).toEqual({ 'fp-a': 'note-1' })
  })

  test('nothing posted ⇒ an empty observation, which plans a full resend', () => {
    const observation = observeBatch(['fp-a', 'fp-b'], [])
    expect(observation.present).toEqual({})
    const plan = planPublishRecovery(
      {
        batchId: 'b1',
        roundId: 'r1',
        epoch: 1,
        state: 'pending',
        fingerprints: ['fp-a', 'fp-b'],
        externalIds: {},
      },
      observation,
    )
    expect(plan.action).toBe('resend')
  })

  test('the crash-after-publish case adopts every id without resending', () => {
    // The window the whole intent mechanism exists for: the comments are on the
    // MR, the ledger has no ids for them.
    const observation = observeBatch(
      ['fp-a', 'fp-b'],
      [posted('fp-a', 'note-1'), posted('fp-b', 'note-2')],
    )
    const plan = planPublishRecovery(
      {
        batchId: 'b1',
        roundId: 'r1',
        epoch: 1,
        state: 'pending',
        fingerprints: ['fp-a', 'fp-b'],
        externalIds: {},
      },
      observation,
    )
    expect(plan.action).toBe('adopt')
    expect(plan.action === 'adopt' && plan.externalIds).toEqual({
      'fp-a': 'note-1',
      'fp-b': 'note-2',
    })
  })

  test('a half-posted batch resends only what is missing', () => {
    const observation = observeBatch(['fp-a', 'fp-b', 'fp-c'], [posted('fp-b', 'note-2')])
    const plan = planPublishRecovery(
      {
        batchId: 'b1',
        roundId: 'r1',
        epoch: 1,
        state: 'pending',
        fingerprints: ['fp-a', 'fp-b', 'fp-c'],
        externalIds: {},
      },
      observation,
    )
    expect(plan.action).toBe('complete')
    expect(plan.action === 'complete' && plan.resend).toEqual(['fp-a', 'fp-c'])
  })

  test('a duplicate settles on the first, deterministically', () => {
    const observation = observeBatch(['fp-a'], [posted('fp-a', 'note-1'), posted('fp-a', 'note-2')])
    expect(observation.present['fp-a']).toBe('note-1')
  })
})

describe('RFC-304 T22b — which surfaces each host must be read from', () => {
  test('GitLab needs BOTH drafts and notes', () => {
    // A crash before bulk_publish leaves drafts; a crash after leaves ordinary
    // notes. Reading only drafts makes the second case look like "nothing was
    // posted" and resends the whole batch onto an MR that already shows it.
    expect(readBackSurfaces('gitlab')).toEqual(['draft_notes', 'notes'])
  })

  test('GitHub needs one — its submit is one request', () => {
    expect(readBackSurfaces('github')).toEqual(['review_comments'])
  })
})

describe('RFC-304 T22b — duplicates are reported, not hidden', () => {
  test('a fingerprint appearing twice is surfaced', () => {
    // It means an earlier recovery resent something that had landed. The
    // platform cannot delete a published comment on the author's behalf, so the
    // operator needs to know the MR now shows the same remark twice.
    const dupes = duplicateFingerprints([
      posted('fp-a', 'note-1'),
      posted('fp-a', 'note-2'),
      posted('fp-b', 'note-3'),
    ])
    expect(dupes).toEqual(['fp-a'])
  })

  test('a clean read-back reports none', () => {
    expect(duplicateFingerprints([posted('fp-a', 'note-1'), posted('fp-b', 'note-2')])).toEqual([])
  })

  test('unmarked comments never count as duplicates of each other', () => {
    const dupes = duplicateFingerprints([
      { externalId: '1', body: 'looks good' },
      { externalId: '2', body: 'looks good' },
    ])
    expect(dupes).toEqual([])
  })
})
