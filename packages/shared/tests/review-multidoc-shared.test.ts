// RFC-079 — pure-function oracles for review multi-document mode.
//
// Locks the user-observable contracts of design.md §2/§3 + proposal A2/A5/A6:
//   - which review inputs enter multi-doc mode (list<markdownish>),
//   - accepted-subset is order-preserving + accepted-only (C2),
//   - "must decide all" gate, and title extraction fallbacks (A6).
// These back the source-level regression locks; if they go red the
// multi-document semantics drifted.

import { describe, expect, test } from 'bun:test'

import {
  acceptedSubsetPaths,
  allDocumentsDecided,
  computeAcceptedSubset,
  extractDocTitle,
  isMultiDocMember,
  isMultiDocReviewInput,
  isNonMarkdownListReviewInput,
  type SelectableDoc,
} from '../src/reviewMultiDoc'

describe('isMultiDocReviewInput', () => {
  test('list of markdown documents → multi-doc', () => {
    expect(isMultiDocReviewInput('list<path<md>>')).toBe(true)
    expect(isMultiDocReviewInput('list<path<markdown>>')).toBe(true)
    expect(isMultiDocReviewInput('list<markdown>')).toBe(true)
  })

  test('single document kinds → NOT multi-doc (single-doc path)', () => {
    expect(isMultiDocReviewInput('markdown')).toBe(false)
    expect(isMultiDocReviewInput('path<md>')).toBe(false)
    expect(isMultiDocReviewInput('markdown_file')).toBe(false) // folds to path<md>
  })

  test('non-markdown lists → NOT multi-doc', () => {
    expect(isMultiDocReviewInput('list<string>')).toBe(false)
    expect(isMultiDocReviewInput('list<path<txt>>')).toBe(false)
    expect(isMultiDocReviewInput('list<list<path<md>>>')).toBe(false)
  })

  test('malformed kinds → false (not a throw)', () => {
    expect(isMultiDocReviewInput('list<')).toBe(false)
    expect(isMultiDocReviewInput('')).toBe(false)
    expect(isMultiDocReviewInput('LIST<path<md>>')).toBe(false)
  })
})

describe('isNonMarkdownListReviewInput (validator reject path)', () => {
  test('list but inner not markdownish → true', () => {
    expect(isNonMarkdownListReviewInput('list<string>')).toBe(true)
    expect(isNonMarkdownListReviewInput('list<path<txt>>')).toBe(true)
  })
  test('markdownish list or non-list → false', () => {
    expect(isNonMarkdownListReviewInput('list<path<md>>')).toBe(false)
    expect(isNonMarkdownListReviewInput('markdown')).toBe(false)
    expect(isNonMarkdownListReviewInput('garbage<')).toBe(false)
  })
})

describe('extractDocTitle', () => {
  test('first ATX heading wins', () => {
    expect(extractDocTitle('# 用例：登录失败锁定\n\nbody', 'cases/tc_001.md')).toBe(
      '用例：登录失败锁定',
    )
    // Heading wins even when prose precedes it (the heading is the most
    // title-like line; well-formed case docs lead with `# TC-x`).
    expect(extractDocTitle('intro\n## Section\n', 'a.md')).toBe('Section')
    expect(extractDocTitle('### Deep\nbody', 'a.md')).toBe('Deep')
  })

  test('heading with trailing hashes is trimmed', () => {
    expect(extractDocTitle('## Title ##\n', 'a.md')).toBe('Title')
  })

  test('leading blank lines then heading', () => {
    expect(extractDocTitle('\n\n#   Padded Heading  \nbody', 'a.md')).toBe('Padded Heading')
  })

  test('no heading → first non-empty line', () => {
    expect(extractDocTitle('\n\nplain first line\nmore', 'cases/x.md')).toBe('plain first line')
  })

  test('empty body → filename basename', () => {
    expect(extractDocTitle('', 'cases/sub/tc_042.md')).toBe('tc_042.md')
    expect(extractDocTitle('   \n  \n', 'tc_007.md')).toBe('tc_007.md')
  })
})

describe('acceptedSubsetPaths / computeAcceptedSubset (C2: order-preserving, accepted-only)', () => {
  const rows: SelectableDoc[] = [
    { itemIndex: 2, itemPath: 'cases/c.md', selection: 'accepted' },
    { itemIndex: 0, itemPath: 'cases/a.md', selection: 'accepted' },
    { itemIndex: 1, itemPath: 'cases/b.md', selection: 'not_accepted' },
    { itemIndex: 3, itemPath: 'cases/d.md', selection: 'unselected' },
    { itemIndex: 4, itemPath: 'cases/e.md', selection: 'accepted' },
  ]

  test('keeps only accepted, sorted by itemIndex', () => {
    expect(acceptedSubsetPaths(rows)).toEqual(['cases/a.md', 'cases/c.md', 'cases/e.md'])
  })

  test('wire form is newline-joined', () => {
    expect(computeAcceptedSubset(rows)).toBe('cases/a.md\ncases/c.md\ncases/e.md')
  })

  test('nothing accepted → empty string', () => {
    expect(
      computeAcceptedSubset([{ itemIndex: 0, itemPath: 'x.md', selection: 'not_accepted' }]),
    ).toBe('')
    expect(computeAcceptedSubset([])).toBe('')
  })

  test('accepted row missing a path is skipped (defensive)', () => {
    expect(
      acceptedSubsetPaths([
        { itemIndex: 0, itemPath: null, selection: 'accepted' },
        { itemIndex: 1, itemPath: 'ok.md', selection: 'accepted' },
      ]),
    ).toEqual(['ok.md'])
  })
})

describe('allDocumentsDecided (A5: must decide all)', () => {
  test('all accepted/not_accepted → true', () => {
    expect(
      allDocumentsDecided([
        { itemIndex: 0, itemPath: 'a', selection: 'accepted' },
        { itemIndex: 1, itemPath: 'b', selection: 'not_accepted' },
      ]),
    ).toBe(true)
  })
  test('any unselected/NULL → false', () => {
    expect(
      allDocumentsDecided([
        { itemIndex: 0, itemPath: 'a', selection: 'accepted' },
        { itemIndex: 1, itemPath: 'b', selection: 'unselected' },
      ]),
    ).toBe(false)
    expect(allDocumentsDecided([{ itemIndex: 0, itemPath: 'a', selection: null }])).toBe(false)
  })
  test('empty set → vacuously true', () => {
    expect(allDocumentsDecided([])).toBe(true)
  })
})

describe('isMultiDocMember', () => {
  test('item_index present → member (incl. 0)', () => {
    expect(isMultiDocMember({ itemIndex: 0 })).toBe(true)
    expect(isMultiDocMember({ itemIndex: 5 })).toBe(true)
  })
  test('NULL/undefined item_index → single-doc row', () => {
    expect(isMultiDocMember({ itemIndex: null })).toBe(false)
    expect(isMultiDocMember({ itemIndex: undefined })).toBe(false)
  })
})
