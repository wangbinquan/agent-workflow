// RFC-304 §6 — normalizing the code host's `mr.diff` answer.
//
// This layer sits between two external API shapes and the line numbers every
// review comment is placed by, so its failure mode is not an exception — it is
// a comment that lands on the wrong line, or a file that was never read while
// the overview says the MR was reviewed.
//
// The cases below are the ones where a plausible reading of each API is wrong:
// GitLab sets both paths on an added file (so the booleans, not the paths, say
// which side exists), and GitHub simply omits `patch` for both binary files and
// files it declined to render.

import { describe, expect, test } from 'bun:test'
import {
  normalizeMrDiff,
  omittedFiles,
  readMrDiffResponse,
  toUnifiedDiff,
} from '../src/modules/code-capability/domain/mrDiffNormalize'
import { parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'
import { resolveAnchor } from '../src/modules/code-capability/domain/anchorResolve'

const HUNK = `@@ -10,3 +10,4 @@
 context
-removed
+added
+also added
 context2
`

describe('RFC-304 — GitLab diff entries', () => {
  test('a modified file keeps both sides', () => {
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK },
    ])
    expect(files[0]).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', omission: 'none' })
  })

  test('an added file has NO old side even though GitLab sends one', () => {
    // GitLab sets old_path === new_path on an added file. Trusting the paths
    // would give it a phantom old side, and an old-side finding would anchor
    // onto a file that never existed at that revision.
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'src/new.ts', new_path: 'src/new.ts', new_file: true, diff: HUNK },
    ])
    expect(files[0]?.oldPath).toBeNull()
    expect(files[0]?.newPath).toBe('src/new.ts')
  })

  test('a deleted file has no new side', () => {
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'src/gone.ts', new_path: 'src/gone.ts', deleted_file: true, diff: HUNK },
    ])
    expect(files[0]?.newPath).toBeNull()
    expect(files[0]?.oldPath).toBe('src/gone.ts')
  })

  test('a rename keeps each side its own path', () => {
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'src/old.ts', new_path: 'src/new.ts', renamed_file: true, diff: HUNK },
    ])
    expect(files[0]).toMatchObject({ oldPath: 'src/old.ts', newPath: 'src/new.ts' })
  })

  test('an empty diff body is an omission, not an unchanged file', () => {
    // A binary file arrives as a changed file with `diff: ''`. Recording it as a
    // normal file with no hunks would make it indistinguishable from a file the
    // MR never touched.
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'img.png', new_path: 'img.png', diff: '' },
    ])
    expect(files[0]?.omission).toBe('binary')
    expect(omittedFiles(files)).toEqual([{ path: 'img.png', omission: 'binary' }])
  })

  test('the deprecated /changes shape is accepted too', () => {
    // Older deployments only expose /changes, which nests the array. The action
    // registry already falls back to it, so this layer has to accept what comes
    // back — otherwise the fallback silently yields an empty diff.
    const files = normalizeMrDiff('gitlab', {
      changes: [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK }],
    })
    expect(files).toHaveLength(1)
  })
})

describe('RFC-304 — GitHub file entries', () => {
  test('status drives which side exists', () => {
    const files = normalizeMrDiff('github', [
      { filename: 'src/added.ts', status: 'added', patch: HUNK, additions: 2, deletions: 0 },
      { filename: 'src/gone.ts', status: 'removed', patch: HUNK, additions: 0, deletions: 2 },
    ])
    expect(files.find((f) => f.newPath === 'src/added.ts')?.oldPath).toBeNull()
    expect(files.find((f) => f.oldPath === 'src/gone.ts')?.newPath).toBeNull()
  })

  test('a rename reads its old path from previous_filename', () => {
    const files = normalizeMrDiff('github', [
      {
        filename: 'src/new.ts',
        previous_filename: 'src/old.ts',
        status: 'renamed',
        patch: HUNK,
        additions: 1,
        deletions: 0,
      },
    ])
    expect(files[0]).toMatchObject({ oldPath: 'src/old.ts', newPath: 'src/new.ts' })
  })

  test('a missing patch with no line counts reads as binary', () => {
    const files = normalizeMrDiff('github', [
      { filename: 'img.png', status: 'modified', additions: 0, deletions: 0 },
    ])
    expect(files[0]?.omission).toBe('binary')
  })

  test('a missing patch WITH line counts reads as too-large', () => {
    // GitHub drops `patch` on a file whose diff exceeds its size limit and says
    // nothing about why. The counts are the only signal, and the distinction is
    // worth keeping: "this file is an image" and "this file was too big to read"
    // mean very different things to someone reading the overview.
    const files = normalizeMrDiff('github', [
      { filename: 'dist/bundle.js', status: 'modified', additions: 9000, deletions: 8000 },
    ])
    expect(files[0]?.omission).toBe('too-large')
    expect(omittedFiles(files)).toEqual([{ path: 'dist/bundle.js', omission: 'too-large' }])
  })
})

describe('RFC-304 — a diff response is refused before it is trusted', () => {
  const body = JSON.stringify([{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK }])

  test('a clean response yields files', () => {
    const result = readMrDiffResponse('gitlab', { ok: true, body, truncated: false })
    expect(result.ok && result.files).toHaveLength(1)
  })

  test('a TRUNCATED response is refused, never parsed', () => {
    // The critical one. The client bounds every response and appends a notice to
    // a body it cut mid-stream, so a large MR yields JSON that is not JSON.
    // Parsing it throws on a syntax position that names no cause; catching that
    // and falling back to "no files" is worse still — the round then completes,
    // reviews nothing, and posts an overview in the voice of a finished review.
    const result = readMrDiffResponse('gitlab', {
      ok: true,
      body: `${body.slice(0, 40)}\n[truncated: response exceeded 262144 bytes]`,
      truncated: true,
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('truncated')
    expect(!result.ok && result.message).toContain('too large')
  })

  test('truncation is judged by the flag, not by whether the body happens to parse', () => {
    // A cut can land on a byte boundary that still parses — an array cut after a
    // complete element closes cleanly under some encoders. Trusting the parse
    // would then review a prefix of the MR and call it the whole thing.
    const result = readMrDiffResponse('gitlab', { ok: true, body: '[]', truncated: true })
    expect(!result.ok && result.reason).toBe('truncated')
  })

  test('a failed call is refused with the host’s own code', () => {
    const result = readMrDiffResponse('github', {
      ok: false,
      code: 'code-host-auth-failed',
      message: 'Bad credentials',
    })
    expect(!result.ok && result.reason).toBe('call-failed')
    expect(!result.ok && result.message).toContain('code-host-auth-failed')
    expect(!result.ok && result.message).toContain('Bad credentials')
  })

  test('a non-JSON body is refused rather than throwing', () => {
    const result = readMrDiffResponse('gitlab', {
      ok: true,
      body: '<html>502 Bad Gateway</html>',
      truncated: false,
    })
    expect(!result.ok && result.reason).toBe('unparsable')
  })

  test('valid JSON of the wrong shape is an empty diff, not a refusal', () => {
    // Distinct from unparsable on purpose: an MR that genuinely touches nothing
    // and a host that changed its response shape both arrive as "no files", and
    // neither is a reason to fail the round.
    const result = readMrDiffResponse('github', {
      ok: true,
      body: '{"message":"Not Found"}',
      truncated: false,
    })
    expect(result.ok && result.files).toEqual([])
  })
})

describe('RFC-304 — a shape the host changed never throws', () => {
  test('a non-array body yields no files', () => {
    expect(normalizeMrDiff('github', { message: 'Not Found' })).toEqual([])
    expect(normalizeMrDiff('gitlab', null)).toEqual([])
    expect(normalizeMrDiff('gitlab', 'nope')).toEqual([])
  })

  test('entries that are not objects, or carry no path, are skipped', () => {
    const files = normalizeMrDiff('gitlab', [
      null,
      'string',
      { old_path: '', new_path: '' },
      { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK },
    ])
    expect(files).toHaveLength(1)
  })

  test('an MR that touches nothing yields no files and no omissions', () => {
    expect(normalizeMrDiff('github', [])).toEqual([])
    expect(omittedFiles([])).toEqual([])
  })
})

describe('RFC-304 — ordering is stable so re-runs shard identically', () => {
  test('files come back sorted by path, not in the host order', () => {
    // Both hosts may reorder between calls. `split-diff` must produce identical
    // shards for identical input (constitution R5); without a stable order a
    // re-run reshuffles which reviewer sees which file, and the same MR yields
    // different findings.
    const first = normalizeMrDiff('github', [
      { filename: 'src/z.ts', status: 'modified', patch: HUNK, additions: 1, deletions: 1 },
      { filename: 'src/a.ts', status: 'modified', patch: HUNK, additions: 1, deletions: 1 },
    ])
    const reversed = normalizeMrDiff('github', [
      { filename: 'src/a.ts', status: 'modified', patch: HUNK, additions: 1, deletions: 1 },
      { filename: 'src/z.ts', status: 'modified', patch: HUNK, additions: 1, deletions: 1 },
    ])
    expect(first.map((f) => f.newPath)).toEqual(['src/a.ts', 'src/z.ts'])
    expect(first).toEqual(reversed)
  })

  test('a deleted file sorts under its old path rather than last', () => {
    const files = normalizeMrDiff('github', [
      { filename: 'src/b.ts', status: 'modified', patch: HUNK, additions: 1, deletions: 1 },
      { filename: 'src/a.ts', status: 'removed', patch: HUNK, additions: 0, deletions: 3 },
    ])
    expect(files.map((f) => f.newPath ?? f.oldPath)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('RFC-304 — the reassembled diff feeds the one parser', () => {
  test('paths survive the round trip into hunks', () => {
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK },
    ])
    const [hunk] = parseDiffHunks(toUnifiedDiff(files))
    expect(hunk).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', newStart: 10 })
  })

  test('a path that itself starts with a/ is not shortened', () => {
    // The synthesized header reads `--- a/a/b/c.ts`; the parser strips only the
    // first segment. Getting this wrong loses a directory level and then nothing
    // in that tree ever anchors.
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'a/b/c.ts', new_path: 'a/b/c.ts', diff: HUNK },
    ])
    const [hunk] = parseDiffHunks(toUnifiedDiff(files))
    expect(hunk?.newPath).toBe('a/b/c.ts')
  })

  test('an added file reassembles with /dev/null on its old side', () => {
    const files = normalizeMrDiff('github', [
      {
        filename: 'src/new.ts',
        status: 'added',
        patch: '@@ -0,0 +1,2 @@\n+one\n+two\n',
        additions: 2,
        deletions: 0,
      },
    ])
    const [hunk] = parseDiffHunks(toUnifiedDiff(files))
    expect(hunk?.oldPath).toBeNull()
    expect(hunk?.newPath).toBe('src/new.ts')
  })

  test('a patch with no trailing newline does not glue onto the next file', () => {
    // GitHub's `patch` ends without a newline. Concatenating as-is would make
    // the next file's `--- a/...` header the tail of the previous hunk's last
    // line, and that file would vanish from the diff entirely.
    const files = normalizeMrDiff('github', [
      {
        filename: 'src/a.ts',
        status: 'modified',
        patch: '@@ -1,1 +1,2 @@\n x\n+y',
        additions: 1,
        deletions: 0,
      },
      {
        filename: 'src/b.ts',
        status: 'modified',
        patch: '@@ -1,1 +1,2 @@\n p\n+q',
        additions: 1,
        deletions: 0,
      },
    ])
    const hunks = parseDiffHunks(toUnifiedDiff(files))
    expect(hunks.map((h) => h.newPath)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('omitted files contribute no hunks, so findings on them degrade', () => {
    // The intended outcome, stated as a test: a reviewer may still say something
    // about a binary file, and it must come out degraded rather than anchored to
    // a line nobody can see.
    const files = normalizeMrDiff('gitlab', [
      { old_path: 'img.png', new_path: 'img.png', diff: '' },
      { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: HUNK },
    ])
    const hunks = parseDiffHunks(toUnifiedDiff(files))
    expect(hunks.map((h) => h.newPath)).toEqual(['src/a.ts'])
    const verdict = resolveAnchor({ file: 'img.png', line: 1 }, hunks)
    expect(verdict.anchored).toBe(false)
    expect(!verdict.anchored && verdict.reason).toBe('file-not-in-diff')
  })

  test('a diff of only omitted files reassembles to nothing, not to garbage', () => {
    const files = normalizeMrDiff('github', [
      { filename: 'img.png', status: 'modified', additions: 0, deletions: 0 },
    ])
    expect(toUnifiedDiff(files)).toBe('')
    expect(parseDiffHunks(toUnifiedDiff(files))).toEqual([])
  })
})
