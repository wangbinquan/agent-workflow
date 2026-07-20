import { describe, expect, test } from 'vitest'
import { declaredPorts, resolveKeyOf, tryParseKind, type WorkflowDefinition } from '../src'

describe('RFC-199 T11.3 — wrapper-git path-list contract', () => {
  test('git_diff is a grammar-valid list of wildcard paths with path-stable shard keys', () => {
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'git', kind: 'wrapper-git', nodeIds: [] }],
      edges: [],
    }
    const port = declaredPorts(definition.nodes[0]!, definition, new Map()).dataOutputs.find(
      (candidate) => candidate.name === 'git_diff',
    )

    expect(port).toEqual({ name: 'git_diff', kind: 'list<path<*>>' })
    const parsed = tryParseKind(port?.kind)
    expect(parsed).toEqual({ kind: 'list', item: { kind: 'path', ext: '*' } })
    if (parsed?.kind !== 'list') throw new Error('git_diff must remain a list kind')
    expect(resolveKeyOf(parsed.item)('src/editor.tsx', 7, parsed.item)).toBe('src/editor.tsx')
  })
})
