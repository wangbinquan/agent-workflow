import { rimrafDir } from './helpers/cleanup'
// RFC-087 — END-TO-END lock for the AST comment/string masking WIRING in the real
// gitBackend pipeline (computeFromWorktree → augmentClassEdges →
// maskCommentsAndStrings → computeClassEdges). The unit tests cover the mask
// function (mask.test.ts) and the edge matcher (class-graph tests) separately;
// this proves they are actually composed in production for a language the old
// hand lexer got WRONG (Python `#` comments + docstrings were never stripped, so
// a class name mentioned only there leaked as a phantom 'references' edge).
//
// Negative: D appears in C ONLY inside a `#` comment + a docstring → NO C→D edge.
// Positive control: E references D in real code → the E→D edge DOES form, so the
// negative assertion isn't vacuously passing.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFromWorktree } from '../src/services/structuralDiff/gitBackend'
import { runGit } from '../src/util/git'

describe('RFC-087 masking integration (computeFromWorktree, Python #/docstring)', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rimrafDir(d)
  })

  test('a class named only in a Python comment/docstring produces NO classEdge; a real reference does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc087-mask-'))
    dirs.push(dir)
    await runGit(dir, ['init', '-q', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    writeFileSync(join(dir, 'README.md'), '# repo\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])

    // New file: D, C (mentions D ONLY in a comment + docstring), E (real use of D).
    writeFileSync(
      join(dir, 'm.py'),
      [
        'class D:',
        '    def work(self):',
        '        return 1',
        '',
        'class C:',
        '    # this class collaborates with D somehow',
        '    """C also documents D in its docstring"""',
        '    def run(self):',
        '        return 1',
        '',
        'class E:',
        '    def go(self):',
        '        return D().work()',
        '',
      ].join('\n'),
    )

    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })

    const has = (fromLeaf: string, toLeaf: string): boolean =>
      diff.classEdges.some((e) => e.from.endsWith(`::${fromLeaf}`) && e.to.endsWith(`::${toLeaf}`))

    // The masking fix: C only names D in a comment + docstring → no phantom edge.
    expect(has('C', 'D')).toBe(false)
    // Positive control: E uses D in real code → edge forms (test isn't vacuous).
    expect(has('E', 'D')).toBe(true)
  })
})
