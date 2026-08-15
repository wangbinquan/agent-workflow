// RFC-304 §6.1 — how a finding reads once it is on the MR, and how it is
// recognised the next time round.
//
// The fingerprint test is the one that earns its keep. A fingerprint that moves
// when the code does not is how a review bot gets muted: every push rebases the
// branch, every line number shifts, and a line-based identity republishes the
// entire previous review as brand-new findings. So the identity deliberately
// excludes the line number and includes the hunk's content instead.
//
// The overview tests are about not overclaiming. "Reviewed, 3 findings" beside
// a clipped diff and two unread files is a statement the round cannot support,
// and the author has no way to know unless it is said out loud.

import { describe, expect, test } from 'bun:test'
import {
  fingerprintFor,
  renderFindingComment,
  renderOverviewPrelude,
} from '../src/modules/code-capability/domain/reviewComment'
import { fingerprintOf } from '../src/modules/code-capability/domain/publishReconcileRemote'

const finding = (over: Partial<Parameters<typeof fingerprintFor>[0]> = {}) => ({
  file: 'src/a.ts',
  line: 12,
  severity: 'major' as const,
  title: 'unchecked index',
  body: 'This can be undefined when the list is empty.',
  ...over,
})

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('RFC-304 — a finding keeps its identity across rounds', () => {
  test('the same finding on a shifted line fingerprints the same', () => {
    // The load-bearing property. A rebase moves every line; if the identity
    // moved with it, the next round would republish the whole review as new.
    expect(fingerprintFor(finding({ line: 12 }), 'digest')).toBe(
      fingerprintFor(finding({ line: 480 }), 'digest'),
    )
  })

  test('changed code around the finding gives it a new identity', () => {
    // The other direction: if the hunk was rewritten, this is arguably a
    // different problem and treating it as the same would suppress a fresh one.
    expect(fingerprintFor(finding(), 'digest-a')).not.toBe(fingerprintFor(finding(), 'digest-b'))
  })

  test('a different point on the same line is a different finding', () => {
    expect(fingerprintFor(finding(), 'd')).not.toBe(
      fingerprintFor(finding({ title: 'missing await' }), 'd'),
    )
  })

  test('the same point in a different file is a different finding', () => {
    expect(fingerprintFor(finding(), 'd')).not.toBe(
      fingerprintFor(finding({ file: 'src/b.ts' }), 'd'),
    )
  })

  test('case and surrounding space in the title do not change identity', () => {
    expect(fingerprintFor(finding(), 'd')).toBe(
      fingerprintFor(finding({ title: '  Unchecked Index ' }), 'd'),
    )
  })

  test('a title containing quotes cannot forge another finding’s identity', () => {
    // Encoded, not joined — the rule recorded in dev-gotchas after this bit.
    expect(fingerprintFor(finding({ file: 'src/a.ts', title: 'x' }), 'd')).not.toBe(
      fingerprintFor(finding({ file: 'src/a.ts", "x', title: '' }), 'd'),
    )
  })

  test('the fingerprint is stable across calls', () => {
    expect(fingerprintFor(finding(), 'd')).toBe(fingerprintFor(finding(), 'd'))
  })

  test('the fingerprint is a PINNED value, not merely a reproducible one', () => {
    // A golden value, because this identity is persisted in the findings
    // ledger. Same-run reproducibility is not the property that matters — the
    // property is that a fingerprint computed today still matches one computed
    // by a build six months from now. If the algorithm is ever swapped, every
    // ledger row re-keys at once: the whole ledger detaches, every open finding
    // republishes as new, and nothing in the system reports an error while it
    // happens. This test is what makes that change loud.
    //
    // The value is sha256 of `JSON.stringify([file, lowercased title, digest])`
    // truncated to 16 hex chars. If you are here because this went red, the
    // question to answer first is NOT "what is the new value" but "what did I
    // change about the identity, and what happens to the rows already keyed by
    // the old one".
    expect(fingerprintFor(finding(), 'digest')).toBe('66553ecfdea3a2da')
  })

  test('the fingerprint is short enough to ride in every comment body', () => {
    // It is embedded in an HTML comment on every published finding.
    expect(fingerprintFor(finding(), 'd')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('RFC-304 — the rendered comment', () => {
  test('the marker round-trips so the next round can recognise it', () => {
    const fp = fingerprintFor(finding(), 'd')
    expect(fingerprintOf(renderFindingComment(finding(), fp))).toBe(fp)
  })

  test('severity and title lead, then the explanation', () => {
    const body = renderFindingComment(finding(), 'fp')
    expect(body).toContain('**Major — unchecked index**')
    expect(body).toContain('This can be undefined')
  })

  test('info renders as a note rather than as a severity word', () => {
    // "Info" beside "Blocker" reads like a severity scale nobody agreed to;
    // "Note" says what it is.
    expect(renderFindingComment(finding({ severity: 'info' }), 'fp')).toContain('**Note —')
  })
})

describe('RFC-304 — the overview does not overclaim', () => {
  const base = {
    posted: 3,
    carried: 0,
    truncated: 0,
    belowThreshold: 0,
    omitted: [],
    diffClipped: false,
    headSha: HEAD,
  }

  test('a clean round states the revision and the count', () => {
    const text = renderOverviewPrelude(base)
    expect(text).toContain('aaaaaaaa')
    expect(text).toContain('3 findings')
  })

  test('an empty review says so plainly instead of counting zero', () => {
    expect(renderOverviewPrelude({ ...base, posted: 0 })).toContain('no findings this round')
  })

  test('one finding is not pluralised', () => {
    expect(renderOverviewPrelude({ ...base, posted: 1 })).toContain('1 finding.')
  })

  test('findings carried in the overview still count toward the total', () => {
    // They were found; where they ended up is a placement detail, and excluding
    // them would undercount the review to the author.
    expect(renderOverviewPrelude({ ...base, posted: 2, carried: 2 })).toContain('4 findings')
  })

  test('cap-withheld findings are reported separately from below-threshold ones', () => {
    // The first WOULD have been shown; the second was deliberately filtered.
    // Merging them tells the author nothing actionable about either.
    const text = renderOverviewPrelude({ ...base, truncated: 5, belowThreshold: 9 })
    expect(text).toContain('5 further findings were withheld by the per-round limit')
    expect(text).toContain('9 below the configured severity threshold')
  })

  test('a clipped diff is disclosed', () => {
    expect(renderOverviewPrelude({ ...base, diffClipped: true })).toContain('too large')
  })

  test('files the host would not diff are named', () => {
    // Otherwise "reviewed" covers files nobody read.
    const text = renderOverviewPrelude({
      ...base,
      omitted: [{ path: 'img.png', omission: 'binary' }],
    })
    expect(text).toContain('img.png')
    expect(text).toContain('were not reviewed')
  })

  test('a clean round carries no caveat list at all', () => {
    expect(renderOverviewPrelude(base)).not.toContain('- ')
  })
})
