// RFC-022: pure helper `buildDependencyTree`. Locks:
//   1. Linear A → B → C → D produces nested children in BFS-expansion order.
//   2. Diamond (top → mid1 → leaf; top → mid2 → leaf) keeps the *first*
//      sighting of `leaf` expanded; the second sighting becomes
//      duplicateRef = true with empty children.
//   3. Dangling name (in dependsOn but absent from `flat`) renders as a
//      placeholder leaf so the UI can render `<missing>` to alert the
//      operator.

import { describe, expect, test } from 'vitest'
import { buildDependencyTree, type DependencyTreeAgent } from '../src/lib/dependency-tree'

function mk(
  name: string,
  dependsOn: string[] = [],
  description = `desc:${name}`,
  skillCount = 0,
  readonly = false,
): DependencyTreeAgent {
  return { name, description, skillCount, readonly, dependsOn }
}

describe('buildDependencyTree', () => {
  test('linear closure expands in BFS order', () => {
    const flat = [mk('a', ['b']), mk('b', ['c']), mk('c', ['d']), mk('d')]
    const tree = buildDependencyTree(flat, 'a')
    expect(tree.name).toBe('a')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]!.name).toBe('b')
    expect(tree.children[0]!.children[0]!.name).toBe('c')
    expect(tree.children[0]!.children[0]!.children[0]!.name).toBe('d')
    expect(tree.children[0]!.children[0]!.children[0]!.children).toHaveLength(0)
    // None of these should be flagged duplicate.
    expect(tree.duplicateRef).toBe(false)
  })

  test('diamond collapses second sighting to duplicateRef leaf', () => {
    // top → mid1 → leaf
    // top → mid2 → leaf
    // expected: leaf renders expanded under mid1 (BFS visits it first),
    // and as a duplicateRef under mid2 with no children.
    const flat = [
      mk('top', ['mid1', 'mid2']),
      mk('mid1', ['leaf']),
      mk('mid2', ['leaf']),
      mk('leaf', [], 'desc:leaf', 3, true),
    ]
    const tree = buildDependencyTree(flat, 'top')
    expect(tree.children.map((c) => c.name)).toEqual(['mid1', 'mid2'])

    const leafViaMid1 = tree.children[0]!.children[0]
    const leafViaMid2 = tree.children[1]!.children[0]
    expect(leafViaMid1!.name).toBe('leaf')
    expect(leafViaMid1!.duplicateRef).toBe(false)
    // Even leaf nodes carry their skillCount + readonly so the chip
    // renders identically on the first sighting.
    expect(leafViaMid1!.skillCount).toBe(3)
    expect(leafViaMid1!.readonly).toBe(true)

    expect(leafViaMid2!.name).toBe('leaf')
    expect(leafViaMid2!.duplicateRef).toBe(true)
    expect(leafViaMid2!.children).toHaveLength(0)
    // Duplicate leaves still carry the same chips so the rendered row is
    // visually consistent (just with `↑ see above` instead of recursion).
    expect(leafViaMid2!.skillCount).toBe(3)
    expect(leafViaMid2!.readonly).toBe(true)
  })

  test('dangling name (in dependsOn but absent from flat) renders as missing placeholder', () => {
    const flat = [mk('top', ['ghost'])]
    const tree = buildDependencyTree(flat, 'top')
    expect(tree.children).toHaveLength(1)
    expect(tree.children[0]!.name).toBe('ghost')
    // Placeholder: empty description + zero skill count + not flagged
    // duplicate. The UI's renderer treats "no description AND zero skills
    // AND not duplicate" as the missing signal.
    expect(tree.children[0]!.description).toBe('')
    expect(tree.children[0]!.skillCount).toBe(0)
    expect(tree.children[0]!.duplicateRef).toBe(false)
    expect(tree.children[0]!.children).toHaveLength(0)
  })

  test('root with no dependsOn renders as a leaf', () => {
    const flat = [mk('lonely')]
    const tree = buildDependencyTree(flat, 'lonely')
    expect(tree.children).toHaveLength(0)
    expect(tree.duplicateRef).toBe(false)
  })

  test('cycle (introduced by malformed flat) terminates without infinite recursion', () => {
    // Defensive — the API wraps the same DB the save-time guard validates,
    // so cycles "shouldn't" reach the renderer. But CI fixtures / manual
    // closure-preview replies could include them. Red here = hung test.
    const flat = [mk('a', ['b']), mk('b', ['a'])]
    const tree = buildDependencyTree(flat, 'a')
    expect(tree.name).toBe('a')
    // First sighting of 'b' is expanded.
    expect(tree.children[0]!.name).toBe('b')
    // 'b' tries to expand 'a' again — duplicateRef short-circuits.
    expect(tree.children[0]!.children[0]!.name).toBe('a')
    expect(tree.children[0]!.children[0]!.duplicateRef).toBe(true)
    expect(tree.children[0]!.children[0]!.children).toHaveLength(0)
  })
})
