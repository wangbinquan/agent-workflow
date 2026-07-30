// RFC-239 T4 — locks the deterministic change-group model (design §1.3): the
// same grouping drives the frontend overview sidebar AND the backend narrative
// input, so this matrix is the single behavioral contract for both.

import { describe, expect, test } from 'bun:test'
import {
  buildChangeGroups,
  moduleSegment,
  ROOT_MODULE_SEG,
  type ChangeGroupEntry,
} from '../src/changeGroups'

function entry(over: Partial<ChangeGroupEntry> & { filePath: string }): ChangeGroupEntry {
  return {
    kind: 'code',
    pureMove: false,
    severity: { breaking: 0, risky: 0 },
    ...over,
  }
}

function lines(added: number, removed = 0): { added: number; removed: number } {
  return { added, removed }
}

describe('moduleSegment', () => {
  test('strips one leading src and takes the first dir', () => {
    expect(moduleSegment('src/ui/Renderer.java')).toBe('ui')
    expect(moduleSegment('core/Engine.ts')).toBe('core')
    expect(moduleSegment('src/deep/nested/x.ts')).toBe('deep')
  })
  test('root files and bare src files map to (root)', () => {
    expect(moduleSegment('README.md')).toBe(ROOT_MODULE_SEG)
    expect(moduleSegment('src/main.ts')).toBe(ROOT_MODULE_SEG)
  })
})

describe('buildChangeGroups — category matrix', () => {
  test('code/doc/config/deps/moves/other each land in their group', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/ui/A.ts', textStats: lines(50) }),
      entry({ filePath: 'src/ui/B.ts', textStats: lines(10) }),
      entry({ filePath: 'src/core/C.ts', textStats: lines(30) }),
      entry({ filePath: 'src/core/D.ts', textStats: lines(5) }),
      entry({ filePath: 'src/core/E.ts', textStats: lines(1) }),
      entry({ filePath: 'docs/guide.md', kind: 'doc', textStats: lines(120) }),
      entry({ filePath: 'settings.yaml', kind: 'config', textStats: lines(4) }),
      entry({ filePath: 'package.json', kind: 'deps', textStats: lines(2) }),
      entry({ filePath: 'logo.png', kind: 'binary' }),
      entry({
        filePath: 'src/core/moved.ts',
        renamedFrom: 'src/old/moved.ts',
        pureMove: true,
      }),
    ])
    expect(groups.map((g) => g.key)).toEqual([
      'mod:ui',
      'mod:core',
      'deps',
      'docs',
      'config',
      'moves',
      'other',
    ])
    const ui = groups[0]
    expect(ui?.files.map((f) => f.filePath)).toEqual(['src/ui/A.ts', 'src/ui/B.ts'])
    expect(ui?.stats.lines).toEqual({ added: 60, removed: 0 })
  })

  test('≤4 code files collapse into one code group', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/ui/A.ts', textStats: lines(5) }),
      entry({ filePath: 'src/core/B.ts', textStats: lines(5) }),
      entry({ filePath: 'src/util/C.ts', textStats: lines(5) }),
      entry({ filePath: 'main.ts', textStats: lines(5) }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['code'])
    expect(groups[0]?.stats.files).toBe(4)
  })

  test('rename+edit files do NOT enter moves (pureMove=false groups normally)', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/ui/A.ts', textStats: lines(9) }),
      entry({ filePath: 'src/ui/B.ts', textStats: lines(9) }),
      entry({ filePath: 'src/ui/C.ts', textStats: lines(9) }),
      entry({ filePath: 'src/ui/D.ts', textStats: lines(9) }),
      entry({
        filePath: 'src/core/renamed.ts',
        renamedFrom: 'src/old/renamed.ts',
        pureMove: false,
        textStats: lines(3),
      }),
    ])
    expect(groups.some((g) => g.key === 'moves')).toBe(false)
    const core = groups.find((g) => g.key === 'mod:core')
    expect(core?.files[0]?.renamedFrom).toBe('src/old/renamed.ts')
  })

  test('>8 module groups fold the smallest into mod:__misc__ keeping the top 7', () => {
    const entries: ChangeGroupEntry[] = []
    // 10 modules; the folded tail (m7+m8+m9 = 6 lines) is strictly smaller than
    // every kept module so the misc group deterministically sorts last.
    const sizes = [100, 90, 80, 70, 60, 50, 40, 3, 2, 1]
    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i] ?? 0
      entries.push(
        entry({ filePath: `src/m${i}/a.ts`, textStats: lines(size / 2) }),
        entry({ filePath: `src/m${i}/b.ts`, textStats: lines(size / 2) }),
      )
    }
    const groups = buildChangeGroups(entries)
    const codeKeys = groups.filter((g) => g.category === 'code').map((g) => g.key)
    expect(codeKeys).toHaveLength(8)
    expect(codeKeys.slice(0, 7)).toEqual([
      'mod:m0',
      'mod:m1',
      'mod:m2',
      'mod:m3',
      'mod:m4',
      'mod:m5',
      'mod:m6',
    ])
    expect(codeKeys[7]).toBe('mod:__misc__')
    const misc = groups.find((g) => g.key === 'mod:__misc__')
    expect(misc?.stats.files).toBe(6) // m7+m8+m9 × 2 files
  })
})

describe('buildChangeGroups — ordering, weights, severity, multi-repo', () => {
  test('code groups order by magnitude desc; weight is relative to global max', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/big/a.ts', textStats: lines(90, 10) }),
      entry({ filePath: 'src/big/b.ts', textStats: lines(50) }),
      entry({ filePath: 'src/big/c.ts', textStats: lines(50) }),
      entry({ filePath: 'src/small/d.ts', textStats: lines(10) }),
      entry({ filePath: 'src/small/e.ts', textStats: lines(5) }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['mod:big', 'mod:small'])
    expect(groups[0]?.weight).toBe(1)
    expect(groups[1]?.weight).toBeCloseTo(15 / 200, 5)
  })

  test('files inside a group sort by severity presence, then magnitude, then path', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/ui/huge-safe.ts', textStats: lines(500) }),
      entry({
        filePath: 'src/ui/small-breaking.ts',
        textStats: lines(3),
        severity: { breaking: 1, risky: 0 },
      }),
      entry({
        filePath: 'src/ui/mid-risky.ts',
        textStats: lines(30),
        severity: { breaking: 0, risky: 2 },
      }),
      entry({ filePath: 'src/ui/tiny-safe.ts', textStats: lines(1) }),
      entry({ filePath: 'src/other/x.ts', textStats: lines(1) }),
    ])
    const ui = groups.find((g) => g.key === 'mod:ui')
    expect(ui?.files.map((f) => f.filePath)).toEqual([
      'src/ui/small-breaking.ts',
      'src/ui/mid-risky.ts',
      'src/ui/huge-safe.ts',
      'src/ui/tiny-safe.ts',
    ])
    expect(ui?.stats.severity).toEqual({ breaking: 1, risky: 2 })
  })

  test('no textStats anywhere → weights degrade to symbol counts', () => {
    const counts = (n: number) => ({ added: n, modified: 0, removed: 0, renamed: 0 })
    const groups = buildChangeGroups([
      entry({ filePath: 'src/big/a.ts', symbolCounts: counts(40) }),
      entry({ filePath: 'src/big/b.ts', symbolCounts: counts(40) }),
      entry({ filePath: 'src/big/c.ts', symbolCounts: counts(20) }),
      entry({ filePath: 'src/small/d.ts', symbolCounts: counts(10) }),
      entry({ filePath: 'src/small/e.ts', symbolCounts: counts(10) }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['mod:big', 'mod:small'])
    expect(groups[0]?.weight).toBe(1)
    expect(groups[1]?.weight).toBeCloseTo(20 / 100, 5)
  })

  test('multi-repo: per-repo blocks in first-appearance order, keys prefixed', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'src/ui/a.ts', repoLabel: 'main', textStats: lines(10) }),
      entry({ filePath: 'src/ui/b.ts', repoLabel: 'main', textStats: lines(10) }),
      entry({ filePath: 'src/ui/c.ts', repoLabel: 'main', textStats: lines(10) }),
      entry({ filePath: 'src/ui/d.ts', repoLabel: 'main', textStats: lines(10) }),
      entry({ filePath: 'src/ui/e.ts', repoLabel: 'main', textStats: lines(10) }),
      entry({ filePath: 'docs/x.md', repoLabel: 'helper', kind: 'doc', textStats: lines(99) }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['repo:main/mod:ui', 'repo:helper/docs'])
  })

  test('pure-move-only task still renders a visible weight sliver', () => {
    const groups = buildChangeGroups([
      entry({ filePath: 'b.ts', renamedFrom: 'a.ts', pureMove: true }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['moves'])
    expect(groups[0]?.weight).toBeGreaterThan(0)
  })
})
