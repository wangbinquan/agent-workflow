// RFC-130 §6 — pure-core unit tests for the built-in merge-conflict resolver.
//
// These lock the deterministic pieces of services/mergeAgent.ts: the built-in
// agent shape, the synthetic node-id helpers, the merge-tree conflict CLASSIFIER
// (the crux — silent conflict classes must not be mis-read as content), the
// prompt builder, and the framework's own resolution VERDICT (D6: success is
// judged by the framework from observed worktree state, never self-reported).
//
// The classifier fixtures are REAL `git merge-tree --write-tree` stdout captured
// from a content + modify/delete + binary three-way conflict — grounding the
// parser in observed git behavior, not a guessed format.

import { describe, expect, test } from 'bun:test'
import {
  buildMergeAgent,
  buildMergeResolvePrompt,
  classifyConflictLine,
  evaluateResolution,
  isMergeResolveNodeId,
  MERGE_AGENT_NAME,
  MERGE_RESOLUTION_PORT,
  mergeResolveNodeId,
  parseBinaryWarningPaths,
  parseConflictManifest,
  type MergeConflictManifest,
} from '../src/services/mergeAgent'

// Real stdout from `git merge-tree --write-tree` (git 2.x), verified empirically.
const REAL_MERGE_TREE_STDOUT = `586043a0a6f37c7d86f3a5f2618d912480056f42
100644 b1ecd4dd28cee6a6c0e77a63ba4f46f2a25dd314 1\tb.bin
100644 8c723280d3255022ebbbf4fb630f912ab8dab7b3 2\tb.bin
100644 985301c4bd7cf5e889a3ed3b68c77930869134e4 3\tb.bin
100644 b0e2aa073d506d038c20223e6b2c13ab4c4e76ae 1\tdel.txt
100644 a2f8359537fbcc6f3eb7bd52a13653f7474fb1b4 3\tdel.txt
100644 83db48f84ec878fbfb30b46d16630e944e34f205 1\tf.txt
100644 22228a707d53f626322933a6a57a487c00741c5c 2\tf.txt
100644 8545681321b3049a30dbf34d6a8caf989465657d 3\tf.txt

warning: Cannot merge binary files: b.bin (e5ffd2185a7ed68b7e34f5b4aaa06efa976b8d98 vs. 763b3c5214aab119de58b77e749705240be7d9b0)
Auto-merging b.bin
CONFLICT (content): Merge conflict in b.bin
CONFLICT (modify/delete): del.txt deleted in e5ffd2185a7ed68b7e34f5b4aaa06efa976b8d98 and modified in 763b3c5214aab119de58b77e749705240be7d9b0.  Version 763b3c5214aab119de58b77e749705240be7d9b0 of del.txt left in tree.
Auto-merging f.txt
CONFLICT (content): Merge conflict in f.txt`

describe('RFC-130 §6.1 — built-in merge agent shape', () => {
  test('buildMergeAgent has the framework-agent contract and NO readonly field', () => {
    const a = buildMergeAgent()
    expect(a.name).toBe(MERGE_AGENT_NAME)
    expect(a.name).toBe('aw-merge-resolver')
    expect(a.outputs).toEqual([MERGE_RESOLUTION_PORT])
    expect(a.id).toBe('__merge_agent__')
    expect(a.skills).toEqual([])
    expect(a.dependsOn).toEqual([])
    // RFC-130 PR-C removed readonly from the Agent type — it must not resurface.
    expect('readonly' in (a as Record<string, unknown>)).toBe(false)
    // No inline model — runtime frozen by the scheduler (RFC-117).
    expect((a as Record<string, unknown>).model).toBeUndefined()
  })
})

describe('RFC-130 §6.1 — merge-resolve node id helpers', () => {
  test('mergeResolveNodeId round-trips through isMergeResolveNodeId', () => {
    const id = mergeResolveNodeId('nodeX', 3)
    expect(id).toBe('__merge_resolve__:nodeX:3')
    expect(isMergeResolveNodeId(id)).toBe(true)
    expect(isMergeResolveNodeId('__merge_resolve__')).toBe(true)
    expect(isMergeResolveNodeId('nodeX')).toBe(false)
    expect(isMergeResolveNodeId('__commit_push__:nodeX')).toBe(false)
  })
})

describe('RFC-130 §6.2③ — merge-tree conflict classifier', () => {
  test('parseBinaryWarningPaths extracts the binary path from the warning line', () => {
    const bins = parseBinaryWarningPaths(REAL_MERGE_TREE_STDOUT)
    expect(bins.has('b.bin')).toBe(true)
    expect(bins.size).toBe(1)
  })

  test('classifyConflictLine maps each real CONFLICT line to the right class', () => {
    const bins = new Set(['b.bin'])
    expect(classifyConflictLine('CONFLICT (content): Merge conflict in f.txt', bins)).toEqual({
      path: 'f.txt',
      type: 'content',
    })
    // A content-reported binary path reclassifies to binary via the warning set.
    expect(classifyConflictLine('CONFLICT (content): Merge conflict in b.bin', bins)).toEqual({
      path: 'b.bin',
      type: 'binary',
    })
    expect(
      classifyConflictLine(
        'CONFLICT (modify/delete): del.txt deleted in abc and modified in def.  Version def of del.txt left in tree.',
        bins,
      ),
    ).toEqual({ path: 'del.txt', type: 'modify-delete' })
    expect(classifyConflictLine('CONFLICT (submodule): Merge conflict in sub', bins)).toEqual({
      path: 'sub',
      type: 'submodule',
    })
    // Non-CONFLICT lines are ignored.
    expect(classifyConflictLine('Auto-merging f.txt', bins)).toBeNull()
    expect(
      classifyConflictLine('warning: Cannot merge binary files: b.bin (a vs. b)', bins),
    ).toBeNull()
    expect(classifyConflictLine('', bins)).toBeNull()
  })

  test('parseConflictManifest yields the full 3-class manifest from real stdout', () => {
    const m = parseConflictManifest(REAL_MERGE_TREE_STDOUT, 'repo')
    // b.bin (binary, NOT content — the warning reclassifies), del.txt (modify-delete), f.txt (content)
    const byPath = Object.fromEntries(m.map((e) => [e.path, e.type]))
    expect(byPath['b.bin']).toBe('binary')
    expect(byPath['del.txt']).toBe('modify-delete')
    expect(byPath['f.txt']).toBe('content')
    expect(m.length).toBe(3)
    expect(m.every((e) => e.worktreeDirName === 'repo')).toBe(true)
  })

  test('a clean merge (no CONFLICT lines) yields an empty manifest', () => {
    expect(parseConflictManifest('586043a0\n', 'repo')).toEqual([])
  })
})

describe('RFC-130 §6.2② — merge-resolve prompt', () => {
  test('prompt enumerates every conflicted path + the output envelope', () => {
    const manifest: MergeConflictManifest = [
      { worktreeDirName: 'repo', path: 'f.txt', type: 'content' },
      { worktreeDirName: 'repo', path: 'del.txt', type: 'modify-delete' },
      { worktreeDirName: 'repo', path: 'b.bin', type: 'binary' },
    ]
    const p = buildMergeResolvePrompt({ manifest })
    expect(p).toContain('f.txt')
    expect(p).toContain('del.txt')
    expect(p).toContain('b.bin')
    expect(p).toContain(`<port name="${MERGE_RESOLUTION_PORT}">`)
    // Silent classes must be spelled out so the agent (blind to them) can act.
    expect(p.toLowerCase()).toContain('binary')
  })
})

describe('RFC-130 §6.2③ — framework resolution verdict (D6, self-check not self-report)', () => {
  const manifest: MergeConflictManifest = [
    { worktreeDirName: 'repo', path: 'f.txt', type: 'content' },
    { worktreeDirName: 'repo', path: 'del.txt', type: 'modify-delete' },
    { worktreeDirName: 'repo', path: 'b.bin', type: 'binary' },
  ]

  test('all resolved: content marker-free + delete chosen + binary present → resolved', () => {
    const v = evaluateResolution(manifest, [
      { worktreeDirName: 'repo', path: 'f.txt', present: true, content: 'line1\nMERGED\nline3\n' },
      { worktreeDirName: 'repo', path: 'del.txt', present: false, content: null }, // deleted — valid
      { worktreeDirName: 'repo', path: 'b.bin', present: true, content: null }, // one side chosen
    ])
    expect(v.resolved).toBe(true)
    expect(v.unresolved).toEqual([])
  })

  test('content path with residual markers → unresolved', () => {
    const v = evaluateResolution(manifest, [
      {
        worktreeDirName: 'repo',
        path: 'f.txt',
        present: true,
        content: 'line1\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\nline3\n',
      },
      { worktreeDirName: 'repo', path: 'del.txt', present: false, content: null },
      { worktreeDirName: 'repo', path: 'b.bin', present: true, content: null },
    ])
    expect(v.resolved).toBe(false)
    expect(v.unresolved.map((e) => e.path)).toEqual(['f.txt'])
  })

  test('content path missing from observed state → fail-closed unresolved', () => {
    const v = evaluateResolution(manifest, [
      // f.txt omitted entirely
      { worktreeDirName: 'repo', path: 'del.txt', present: false, content: null },
      { worktreeDirName: 'repo', path: 'b.bin', present: true, content: null },
    ])
    expect(v.resolved).toBe(false)
    expect(v.unresolved.map((e) => e.path)).toEqual(['f.txt'])
  })

  test('modify-delete kept WITH leftover markers → unresolved', () => {
    const v = evaluateResolution(
      [{ worktreeDirName: 'repo', path: 'del.txt', type: 'modify-delete' }],
      [
        {
          worktreeDirName: 'repo',
          path: 'del.txt',
          present: true,
          content: '<<<<<<< ours\n=======\nkeep\n>>>>>>> theirs\n',
        },
      ],
    )
    expect(v.resolved).toBe(false)
  })

  test('binary path absent (no side chosen) → unresolved', () => {
    const v = evaluateResolution(
      [{ worktreeDirName: 'repo', path: 'b.bin', type: 'binary' }],
      [{ worktreeDirName: 'repo', path: 'b.bin', present: false, content: null }],
    )
    expect(v.resolved).toBe(false)
  })
})
