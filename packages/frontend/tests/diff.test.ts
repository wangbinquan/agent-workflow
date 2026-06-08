// Sanity-check the DiffViewer's diff parser + per-line classifier.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  __testLineClass as cls,
  __testSplitByFile as split,
  splitByRepo,
} from '../src/components/DiffViewer'

const TWO_FILE = `diff --git a/foo.ts b/foo.ts
index 1111111..2222222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-old
+new
diff --git a/bar.ts b/bar.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/bar.ts
@@ -0,0 +1 @@
+hi
`

describe('splitByFile', () => {
  test('splits on each diff --git boundary', () => {
    const blocks = split(TWO_FILE)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.header).toBe('foo.ts')
    expect(blocks[1]?.header).toBe('bar.ts')
  })

  test('renames render with arrow in header', () => {
    const renamed = `diff --git a/old.ts b/new.ts\nsimilarity index 90%\n`
    const blocks = split(renamed)
    expect(blocks[0]?.header).toBe('old.ts → new.ts')
  })

  test('preamble before first diff is bucketed under "(preamble)"', () => {
    const blocks = split('garbage\ndiff --git a/x b/x\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.header).toBe('(preamble)')
    expect(blocks[1]?.header).toBe('x')
  })
})

describe('lineClass', () => {
  test('+ and - lines colored as add/del', () => {
    expect(cls('+new')).toBe('diff__add')
    expect(cls('-gone')).toBe('diff__del')
  })

  test('hunk markers and file path markers separately classed', () => {
    expect(cls('@@ -1,2 +1,2 @@')).toBe('diff__hunk')
    expect(cls('+++ b/foo.ts')).toBe('diff__meta')
    expect(cls('--- a/foo.ts')).toBe('diff__meta')
  })

  test('context lines fall through to ctx', () => {
    expect(cls(' unchanged')).toBe('diff__ctx')
    expect(cls('')).toBe('diff__ctx')
  })

  test('metadata lines (index/new file/rename) are meta', () => {
    expect(cls('index abc..def 100644')).toBe('diff__meta')
    expect(cls('new file mode 100644')).toBe('diff__meta')
    expect(cls('rename from old')).toBe('diff__meta')
  })
})

// RFC-066 multi-repo: getTaskDiff concatenates each repo's diff behind a
// `# === Repo: <name> ===` marker. splitByRepo segments on those so the file
// column can be grouped per repo (and same-path files across repos stay
// distinct). These lock the segmentation that the old flat splitByFile got
// wrong (first marker → junk "(preamble)" tab; later markers swallowed into the
// previous repo's last file).
describe('splitByRepo', () => {
  test('a diff with no marker is one null-repo group, identical to splitByFile', () => {
    const groups = splitByRepo(TWO_FILE)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.repo).toBeNull()
    // Byte-identical block list → single-repo rendering is unchanged.
    expect(groups[0]?.blocks).toEqual(split(TWO_FILE))
  })

  const MULTI = `# === Repo: repo-a ===
diff --git a/src/index.ts b/src/index.ts
index 1111..2222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-a old
+a new
# === Repo: repo-b ===
diff --git a/src/index.ts b/src/index.ts
index 3333..4444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-b old
+b new
`

  test('segments into one group per repo, in order', () => {
    const groups = splitByRepo(MULTI)
    expect(groups.map((g) => g.repo)).toEqual(['repo-a', 'repo-b'])
  })

  test('the second repo marker is NOT swallowed into the first repo block', () => {
    const groups = splitByRepo(MULTI)
    expect(groups[0]?.blocks).toHaveLength(1)
    expect(groups[0]?.blocks[0]?.header).toBe('src/index.ts')
    expect(groups[0]?.blocks[0]?.lines.join('\n')).not.toContain('Repo: repo-b')
    expect(groups[0]?.blocks[0]?.lines.join('\n')).toContain('+a new')
  })

  test('same-path file in each repo lands in its own group', () => {
    const groups = splitByRepo(MULTI)
    expect(groups[1]?.blocks).toHaveLength(1)
    expect(groups[1]?.blocks[0]?.header).toBe('src/index.ts')
    expect(groups[1]?.blocks[0]?.lines.join('\n')).toContain('+b new')
  })

  test('a marker-looking CONTENT line (carries a diff prefix) is not a boundary', () => {
    const withContent = `# === Repo: only ===
diff --git a/readme.md b/readme.md
@@ -1 +1,2 @@
 # heading
+# === Repo: not-a-real-marker ===
`
    const groups = splitByRepo(withContent)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.repo).toBe('only')
    expect(groups[0]?.blocks).toHaveLength(1)
  })

  // Cross-package lock: the frontend parser and the backend emitter must agree
  // on the marker format. If either side changes the literal, this fails loudly
  // instead of silently un-grouping every multi-repo diff.
  test('parser format matches the backend getTaskDiff emitter', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const backend = readFileSync(path.resolve(here, '../../backend/src/services/task.ts'), 'utf8')
    // Backend builds: `# === Repo: ${<expr>} ===` — robust to variable renames.
    expect(backend).toMatch(/# === Repo: \$\{[^}]+\} ===/)
    // And the frontend groups a diff that uses that exact shape.
    const groups = splitByRepo(
      '# === Repo: some-repo ===\ndiff --git a/x b/x\n@@ -1 +1 @@\n-p\n+q\n',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.repo).toBe('some-repo')
  })
})
