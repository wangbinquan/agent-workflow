// RFC-376 G11: lock the target DAG and public contexts to the approved design, without inventories.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TARGET_CONTEXT_EDGES, TARGET_PUBLIC_CONTEXTS } from './rfc294Target'
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const DESIGN = readFileSync(
  resolve(REPO_ROOT, 'design/RFC-294-backend-layered-target-architecture/design.md'),
  'utf8',
)
function designEdges(design: string): Array<{
  fromContext: string
  toContext: string
  role: string
  contract: string
}> {
  const mermaid = /```mermaid\nflowchart LR\n([\s\S]*?)\n```/.exec(design)?.[1]
  if (mermaid === undefined) throw new Error('RFC-294 context Mermaid block not found')
  const aliases = new Map<string, string>()
  for (const match of mermaid.matchAll(/\b([A-Z]+)\["([a-z0-9-]+)"\]/g))
    aliases.set(match[1]!, match[2]!)
  const edges: Array<{ fromContext: string; toContext: string; role: string; contract: string }> =
    []
  for (const line of mermaid.split('\n')) {
    const required =
      /^\s*([A-Z]+)(?:\[[^\]]+\])?\s+-\.\s+"implements ([^"]+)"\s+\.->\s+([A-Z]+)/.exec(line)
    if (required !== null) {
      edges.push({
        fromContext: aliases.get(required[1]!) ?? required[1]!,
        toContext: aliases.get(required[3]!) ?? required[3]!,
        role: 'required-implementation',
        contract: required[2]!,
      })
      continue
    }
    const offered = /^\s*([A-Z]+)(?:\[[^\]]+\])?\s+-->\s+([A-Z]+)/.exec(line)
    if (offered !== null) {
      edges.push({
        fromContext: aliases.get(offered[1]!) ?? offered[1]!,
        toContext: aliases.get(offered[2]!) ?? offered[2]!,
        role: 'offered-consumption',
        contract: 'exact-public-entrypoint',
      })
    }
  }
  const matrixLine = design
    .split('\n')
    .find((line) => line.startsWith('| IA `public/types` type-only'))
  if (matrixLine === undefined) throw new Error('RFC-294 authority type-only matrix not found')
  const contexts = [...matrixLine.matchAll(/`([a-z][a-z0-9-]+)`/g)]
    .map((match) => match[1]!)
    .filter((value) => value !== 'public' && value !== 'types')
  for (const fromContext of contexts) {
    edges.push({
      fromContext,
      toContext: 'identity-access',
      role: 'authority-type-only',
      contract: 'identity-access/public/types:AuthorizationSubjectRef+opaque-authority',
    })
  }
  return edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function designPublicContexts(design: string): string[] {
  const table = /### 3\.4 各模块最小 public surface\n[\s\S]*?\n\| 模块[\s\S]*?\n(.*?)\n\n/s.exec(
    design,
  )?.[1]
  if (table === undefined) throw new Error('RFC-294 §3.4 public-surface table not found')
  const excluded = new Set(['resource 子模块', 'resource-catalog/package', 'platform/contracts'])
  return [
    ...new Set(
      table
        .split('\n')
        .map((line) => /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1]?.replaceAll('`', '').trim())
        .filter(
          (value): value is string =>
            value !== undefined && !/^:?-{3,}:?$/.test(value) && !excluded.has(value),
        )
        .map((value) => (value === 'resource-catalog/core' ? 'resource-catalog' : value)),
    ),
  ].sort()
}

function parityErrors(design: string): string[] {
  const expected = TARGET_CONTEXT_EDGES.map(({ fromContext, toContext, role, contract }) => ({
    fromContext,
    toContext,
    role,
    contract,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const errors: string[] = []
  try {
    if (JSON.stringify(designEdges(design)) !== JSON.stringify(expected))
      errors.push('target edge mismatch')
    if (
      JSON.stringify(designPublicContexts(design)) !==
      JSON.stringify([...TARGET_PUBLIC_CONTEXTS].sort())
    )
      errors.push('public context mismatch')
  } catch (error) {
    errors.push(String(error))
  }
  return errors
}
describe('RFC-376 G11 design parity', () => {
  test('design DAG and public contexts equal the independent target constants', () => {
    expect(parityErrors(DESIGN)).toEqual([])
  })
  test('design corpus has the complete offered, required and authority denominator', () => {
    expect(designEdges(DESIGN)).toHaveLength(69)
    expect(designPublicContexts(DESIGN)).toHaveLength(18)
  })
  test('in-memory design mutations add and remove edges, rename a context, or delete the IA row', () => {
    const fixture = `
\`\`\`mermaid
flowchart LR
 A["task-execution"] --> B["identity-access"]
\`\`\`
| IA \`public/types\` type-only | \`task-execution\` |
### 3.4 各模块最小 public surface
| 模块 | surface |
| --- | --- |
| task-execution | types |

`
    expect(designEdges(fixture)).toHaveLength(2)
    expect(designEdges(fixture.replace(' A[', ' B --> A\n A['))).toHaveLength(3)
    expect(designEdges(fixture.replace(/ A.* --> B.*\n/, '\n'))).toHaveLength(1)
    expect(designEdges(fixture.replace('task-execution', 'renamed-context'))[0]?.fromContext).toBe(
      'renamed-context',
    )
    expect(() => designEdges(fixture.replace(/\| IA[^\n]*\n/, ''))).toThrow(
      'authority type-only matrix',
    )
    const mutateDiagram = (mutate: (diagram: string) => string): string =>
      DESIGN.replace(/```mermaid\nflowchart LR\n[\s\S]*?\n```/, mutate)
    const mutations = [
      mutateDiagram((diagram) => diagram.replace('flowchart LR', 'flowchart LR\n  TE --> IA')),
      mutateDiagram((diagram) => diagram.replace(/^.* --> .*\n/m, '')),
      mutateDiagram((diagram) => diagram.replace('["task-execution"]', '["renamed-context"]')),
      DESIGN.replace(/^\| IA[^\n]*\n/m, ''),
    ]
    mutations.forEach((changed, index) =>
      expect(parityErrors(changed).length, `design mutation ${index}`).toBeGreaterThan(0),
    )
  })
  test('malformed design blocks cannot produce an empty green result', () => {
    expect(() => designEdges('export const fixture = {};')).toThrow('Mermaid block')
    expect(() => designPublicContexts('export const fixture = {};')).toThrow('public-surface table')
  })
})
