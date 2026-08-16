// RFC-304 T41/T42 — choosing between a suggestion and a patch, and rendering it.
//
// The failure this file is really about is silent and expensive: a suggestion
// whose declared range does not match the lines it carries. Nothing errors. The
// host renders an apply button, the reviewer clicks it, and the file loses lines
// nobody meant to touch — an automated edit the reviewer believes they read.
//
// So the assertions here are about the RANGE as much as the text: how wide it
// is, which line it anchors to, and what happens to the untouched lines in
// between and after. The `decideForm` half is the cheaper property: it only has
// to send anything it cannot express down the patch path, and say why.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SUGGESTION_OPTIONS,
  changeSpanOf,
  decideForm,
  renderSuggestion,
} from '../src/modules/code-capability/domain/suggestionForm'

/** A one-file unified diff, built from explicit hunk text. */
const diff = (path: string, hunks: string[]): string =>
  [`--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n')

describe('RFC-304 T41 — reading a change as one contiguous replacement', () => {
  test('a single replaced line is a one-line span', () => {
    const span = changeSpanOf(
      diff('src/a.ts', ['@@ -10,3 +10,3 @@', ' before', '-const x = 1', '+const x = 2', ' after']),
    )

    expect(span).not.toBeNull()
    expect(span?.path).toBe('src/a.ts')
    expect(span?.startLine).toBe(11)
    expect(span?.endLine).toBe(11)
    expect(span?.replacement).toEqual(['const x = 2'])
  })

  test('trailing context is NOT part of the span', () => {
    // A hunk carries three lines of trailing context by convention. Including
    // them would make the suggestion claim to replace lines it does not change
    // — which clobbers anything else that edited them in the meantime.
    const span = changeSpanOf(
      diff('src/a.ts', ['@@ -1,5 +1,5 @@', ' one', '-two', '+TWO', ' three', ' four', ' five']),
    )

    expect(span?.startLine).toBe(2)
    expect(span?.endLine).toBe(2)
    expect(span?.replacement).toEqual(['TWO'])
  })

  test('two edits in one file span from the first to the last, carrying what is between', () => {
    // The reason the rule is a SPAN and not a hunk count. Dropping the
    // untouched middle lines would delete them on apply.
    const span = changeSpanOf(
      diff('src/a.ts', [
        '@@ -1,6 +1,6 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        ' four',
        '-five',
        '+FIVE',
        ' six',
      ]),
    )

    expect(span?.startLine).toBe(2)
    expect(span?.endLine).toBe(5)
    expect(span?.replacement).toEqual(['TWO', 'three', 'four', 'FIVE'])
  })

  test('a pure insertion replaces the line it follows, re-emitting it', () => {
    // A suggestion has no way to say "insert without replacing". Getting this
    // wrong deletes the anchor line.
    const span = changeSpanOf(diff('src/a.ts', ['@@ -3,2 +3,3 @@', ' keep', '+added', ' tail']))

    expect(span?.startLine).toBe(3)
    expect(span?.endLine).toBe(3)
    expect(span?.replacement).toEqual(['keep', 'added'])
  })

  test('a deletion is a span whose replacement is empty', () => {
    const span = changeSpanOf(diff('src/a.ts', ['@@ -4,3 +4,2 @@', ' a', '-gone', ' b']))

    expect(span?.startLine).toBe(5)
    expect(span?.endLine).toBe(5)
    expect(span?.replacement).toEqual([])
  })

  test('`\\ No newline at end of file` is not content', () => {
    // It annotates the previous line. Carried through as a line, it appends a
    // literal backslash to the file.
    const span = changeSpanOf(
      diff('src/a.ts', ['@@ -1,1 +1,1 @@', '-last', '\\ No newline at end of file', '+LAST']),
    )

    expect(span?.replacement).toEqual(['LAST'])
  })

  test('SEPARATED hunks are refused — the lines between them are not in the diff', () => {
    // The worst failure available here, and the reason this case exists. Two
    // hunks forty lines apart carry no record of the lines between them, so a
    // suggestion assembled from their content would replace lines 2–52 with
    // ten lines: the reviewer clicks apply and forty lines they never saw are
    // gone. Returning null sends it down the patch path instead, where the
    // whole diff is shown and explicitly confirmed.
    const separated = changeSpanOf(
      diff('src/a.ts', [
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        '@@ -50,3 +50,3 @@',
        ' fifty',
        '-fiftyone',
        '+FIFTYONE',
      ]),
    )

    expect(separated).toBeNull()
    expect(
      decideForm(
        diff('src/a.ts', [
          '@@ -1,3 +1,3 @@',
          ' one',
          '-two',
          '+TWO',
          '@@ -50,3 +50,3 @@',
          ' fifty',
          '-fiftyone',
          '+FIFTYONE',
        ]),
      ).kind,
    ).toBe('patch')
  })

  test('ADJACENT hunks are fine — nothing is missing between them', () => {
    // The other side of the rule. Refusing these too would push ordinary
    // two-edit changes onto the slow path for no reason.
    const span = changeSpanOf(
      diff('src/a.ts', [
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        '@@ -3,2 +3,2 @@',
        '-three',
        '+THREE',
        ' four',
      ]),
    )

    expect(span).not.toBeNull()
    expect(span?.startLine).toBe(2)
    expect(span?.endLine).toBe(3)
    expect(span?.replacement).toEqual(['TWO', 'THREE'])
  })

  test('a two-file change is not a span at all', () => {
    const two = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
    ].join('\n')

    expect(changeSpanOf(two)).toBeNull()
  })

  test('an empty or unreadable diff is not a span', () => {
    expect(changeSpanOf('')).toBeNull()
    expect(changeSpanOf('   \n  ')).toBeNull()
  })
})

describe('RFC-304 T41 — the form decision', () => {
  test('a small one-file change becomes a suggestion', () => {
    const form = decideForm(diff('src/a.ts', ['@@ -1,1 +1,1 @@', '-a', '+A']))
    expect(form.kind).toBe('suggestion')
  })

  test('a multi-file change becomes a patch, and says which limit it hit', () => {
    // The reason reaches the author. An unexplained slower path reads as the
    // platform being broken.
    const form = decideForm(
      [
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+A',
        '--- a/y.ts',
        '+++ b/y.ts',
        '@@ -1,1 +1,1 @@',
        '-b',
        '+B',
      ].join('\n'),
    )

    expect(form.kind).toBe('patch')
    expect(form.kind === 'patch' && form.reason).toContain('more than one file')
  })

  test('a change wider than the threshold becomes a patch', () => {
    // A forty-line suggestion is not reviewed, it is accepted: the reader
    // cannot hold before and after in their head, and the one-click apply that
    // makes the form good is what makes an unreviewable one dangerous.
    const lines = ['@@ -1,30 +1,30 @@']
    for (let i = 1; i <= 30; i += 1) lines.push(`-line ${String(i)}`, `+LINE ${String(i)}`)
    const form = decideForm(diff('src/a.ts', lines))

    expect(form.kind).toBe('patch')
    expect(form.kind === 'patch' && form.reason).toContain('30 lines')
    expect(form.kind === 'patch' && form.reason).toContain('src/a.ts')
  })

  test('the boundary is inclusive — exactly the threshold still suggests', () => {
    // Off-by-one here silently moves a whole class of ordinary edits onto the
    // slow path, and nobody would notice because both paths "work".
    const width = DEFAULT_SUGGESTION_OPTIONS.maxSpanLines
    const lines = [`@@ -1,${String(width)} +1,${String(width)} @@`]
    for (let i = 1; i <= width; i += 1) lines.push(`-line ${String(i)}`, `+LINE ${String(i)}`)

    expect(decideForm(diff('src/a.ts', lines)).kind).toBe('suggestion')
  })

  test('the threshold is configurable', () => {
    const lines = ['@@ -1,3 +1,3 @@', '-a', '+A', '-b', '+B', '-c', '+C']
    expect(decideForm(diff('src/a.ts', lines), { maxSpanLines: 2 }).kind).toBe('patch')
    expect(decideForm(diff('src/a.ts', lines), { maxSpanLines: 3 }).kind).toBe('suggestion')
  })
})

describe('RFC-304 T42 — rendering, per host', () => {
  const span = { path: 'src/a.ts', startLine: 10, endLine: 13, replacement: ['x', 'y', 'z', 'w'] }

  test('GitLab carries the range in the fence, relative to the anchored line', () => {
    // `-0+3` means "0 above, 3 below". Omitting the header would make the host
    // replace ONE line with four — silently, with an apply button on it.
    const out = renderSuggestion('gitlab', span)

    expect(out.anchorLine).toBe(10)
    expect(out.body).toContain('```suggestion:-0+3')
    expect(out.body).toContain('x\ny\nz\nw')
    expect(out.startLine).toBeNull()
  })

  test('GitHub carries the range on the comment, not in the fence', () => {
    const out = renderSuggestion('github', span)

    expect(out.body).toContain('```suggestion\n')
    expect(out.body).not.toContain('suggestion:-')
    // The comment addresses `start_line`..`line`; the body is just content.
    expect(out.startLine).toBe(10)
    expect(out.anchorLine).toBe(13)
  })

  test('a single-line GitHub suggestion sends NO start_line', () => {
    // GitHub rejects a multi-line comment whose start equals its end, so a
    // one-line fix would fail to post at all.
    const out = renderSuggestion('github', {
      path: 'src/a.ts',
      startLine: 7,
      endLine: 7,
      replacement: ['one'],
    })

    expect(out.startLine).toBeNull()
    expect(out.anchorLine).toBe(7)
  })

  test('a single-line GitLab suggestion is `-0+0`', () => {
    const out = renderSuggestion('gitlab', {
      path: 'src/a.ts',
      startLine: 7,
      endLine: 7,
      replacement: ['one'],
    })

    expect(out.body).toContain('```suggestion:-0+0')
  })

  test('a deletion renders as an empty suggestion block, not a missing one', () => {
    // The fence with nothing inside is how both hosts express "remove these
    // lines". Skipping the block would post a bare comment with no button.
    const out = renderSuggestion('gitlab', {
      path: 'src/a.ts',
      startLine: 4,
      endLine: 4,
      replacement: [],
    })

    expect(out.body).toContain('```suggestion:-0+0\n\n```')
  })

  test('a note is placed above the block, where a reader sees it first', () => {
    const out = renderSuggestion('github', span, '  Use the shared helper here.  ')

    expect(out.body.startsWith('Use the shared helper here.\n\n```suggestion')).toBe(true)
  })

  test('an empty note adds no blank preamble', () => {
    expect(renderSuggestion('github', span, '   ').body.startsWith('```suggestion')).toBe(true)
  })
})
