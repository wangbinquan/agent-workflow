// RFC-304 T43 — reading a reply as "push it", or refusing to.
//
// This decision ends in a push to somebody's branch, so the tests are written
// from both directions and the negative one matters more:
//
//   false positive — the platform pushes because a sentence contained the word
//                    "apply". Somebody's branch gains a commit they never
//                    approved, and the next thing they learn about it is a CI
//                    failure.
//   false negative — the platform stays silent on a real confirmation. The
//                    person believes they approved it, waits, and stops
//                    trusting the mechanism.
//
// Between those, the stale-artifact cases are the subtle ones: a yes is only a
// yes to the thing that was shown, and the branch can move in between.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CONFIRM_KEYWORDS,
  judgeConfirmation,
  parseConfirmation,
  patchArtifactMarker,
  readPatchArtifactMarker,
  shortDigest,
  type ConfirmationContext,
} from '../src/modules/code-capability/domain/patchConfirmation'

const DIGEST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const HEAD = 'feedfacefeedfacefeedfacefeedfacefeedface'

const ctx = (over: Partial<ConfirmationContext> = {}): ConfirmationContext => ({
  pending: { digest: DIGEST, baseSha: HEAD, generation: 3 },
  currentGeneration: 3,
  currentHeadSha: HEAD,
  ...over,
})

describe('RFC-304 T43 — recognising the command', () => {
  test('the documented keywords are the implemented ones', () => {
    expect([...DEFAULT_CONFIRM_KEYWORDS]).toEqual(['/aw apply', '/aw push'])
  })

  test('a bare command confirms', () => {
    expect(parseConfirmation('/aw apply')).toEqual({ confirmed: true, digest: null })
    expect(parseConfirmation('/aw push')).toEqual({ confirmed: true, digest: null })
  })

  test('case and surrounding whitespace do not change the meaning', () => {
    // People type `/AW Apply`, and comment boxes add newlines.
    expect(parseConfirmation('\n  /AW Apply  \n').confirmed).toBe(true)
  })

  test('a sentence that merely CONTAINS the command does not confirm', () => {
    // The platform's own posted diff says "reply with /aw apply to push this",
    // and someone will quote it. A substring match would push on the quote.
    expect(parseConfirmation('you can reply /aw apply when you are happy')).toEqual({
      confirmed: false,
      reason: 'not-a-command',
    })
    expect(parseConfirmation('> reply with /aw apply').confirmed).toBe(false)
  })

  test('ordinary approving prose does NOT confirm', () => {
    // "apply", "lgtm" and "ok" all appear constantly in review threads. Making
    // any of them a keyword would push on a comment that was agreeing with
    // something else entirely.
    for (const body of ['lgtm', 'ok, apply it', 'please apply', '+1', 'looks good, ship it']) {
      expect(parseConfirmation(body).confirmed).toBe(false)
    }
  })

  test('a digest after the command is read; prose after it is not', () => {
    const named = parseConfirmation(`/aw apply ${shortDigest(DIGEST)}`)
    expect(named).toEqual({ confirmed: true, digest: shortDigest(DIGEST) })
    // Otherwise every "/aw apply thanks!" becomes a digest mismatch.
    expect(parseConfirmation('/aw apply thanks!')).toEqual({ confirmed: true, digest: null })
  })

  test('the keyword set is configurable', () => {
    expect(parseConfirmation('!ship', ['!ship']).confirmed).toBe(true)
    expect(parseConfirmation('/aw apply', ['!ship']).confirmed).toBe(false)
  })
})

describe('RFC-304 T43 — the artifact marker', () => {
  test('a posted comment carries the short digest, invisibly', () => {
    const marker = patchArtifactMarker(DIGEST)
    // An HTML comment: the reader never sees it, and it survives a quote.
    expect(marker.startsWith('<!--')).toBe(true)
    expect(marker).toContain(shortDigest(DIGEST))
    expect(readPatchArtifactMarker(`some body\n\n${marker}`)).toBe(shortDigest(DIGEST))
  })

  test('a comment with no marker is not one of ours', () => {
    expect(readPatchArtifactMarker('just a normal review comment')).toBeNull()
  })
})

describe('RFC-304 T43 — what a confirmation is a confirmation TO', () => {
  test('a matching confirmation pushes exactly the pending artifact', () => {
    const verdict = judgeConfirmation('/aw apply', ctx())
    expect(verdict).toEqual({ decision: 'push', artifactDigest: DIGEST })
  })

  test('an explicit digest that matches also pushes', () => {
    expect(judgeConfirmation(`/aw apply ${shortDigest(DIGEST)}`, ctx()).decision).toBe('push')
  })

  test('an explicit digest that does NOT match refuses, and says which one is waiting', () => {
    // The only way to say "I mean that one" when two are in flight, so a
    // mismatch has to be loud rather than pushing whatever is pending.
    const verdict = judgeConfirmation('/aw apply deadbeef1234', ctx())
    expect(verdict.decision).toBe('refuse')
    expect(verdict.decision === 'refuse' && verdict.message).toContain(shortDigest(DIGEST))
  })

  test('a confirmation with nothing pending explains itself rather than going quiet', () => {
    // A yes that produces no reply at all is the worst outcome: the person
    // believes they approved it and waits.
    const verdict = judgeConfirmation('/aw apply', ctx({ pending: null }))
    expect(verdict.decision).toBe('refuse')
    expect(verdict.decision === 'refuse' && verdict.message).toContain('no change waiting')
  })

  test('a superseded generation refuses — the diff described code that has moved', () => {
    const verdict = judgeConfirmation('/aw apply', ctx({ currentGeneration: 4 }))
    expect(verdict.decision).toBe('refuse')
    expect(verdict.decision === 'refuse' && verdict.message).toContain('changed after that diff')
  })

  test('a moved head refuses even when the generation still agrees', () => {
    // The two disagree exactly when an event has arrived at the code host but
    // the platform has not processed it yet — which is the window this guard
    // exists for, and why it is not folded into the generation check.
    const verdict = judgeConfirmation('/aw apply', ctx({ currentHeadSha: 'cafebabe'.repeat(5) }))
    expect(verdict.decision).toBe('refuse')
    expect(verdict.decision === 'refuse' && verdict.message).toContain('moved')
    // Both shas are named, so the author can see what happened without digging.
    expect(verdict.decision === 'refuse' && verdict.message).toContain(HEAD.slice(0, 12))
  })

  test('an ordinary comment is ignored — no push, and no reply either', () => {
    // A thread that answered "that was not a command" to every unrelated
    // comment would be unusable.
    expect(judgeConfirmation('I think this is the wrong fix', ctx())).toEqual({
      decision: 'ignore',
    })
  })

  test('an ordinary comment is ignored even when nothing is pending', () => {
    expect(judgeConfirmation('nice', ctx({ pending: null })).decision).toBe('ignore')
  })
})
