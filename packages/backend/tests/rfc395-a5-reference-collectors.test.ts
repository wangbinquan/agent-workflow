// RFC-395 II-a A5: compare the shared collector with byte-copied HEAD traversals,
// including duplicate order, malformed selectors and id-cache authority.
import { describe, expect, test } from 'bun:test'
import {
  decodeWorkflowReferenceDocument,
  collectWorkflowDependencyRefs,
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  collectAgentDependencyRefs,
  decodeAgentReferenceDocumentForExport,
  agentReferenceIds,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { headReferenceTraversals } from './helpers/rfc395A5HeadTraversals'
import { directRefsOf } from '../src/services/resourcePackage/closure'
import { assertCanonicalWorkflowAgentIds } from '../src/modules/resource-catalog/infrastructure/workflowPersistence'
import { ValidationError } from '../src/util/errors'

function oracle(
  group: keyof typeof headReferenceTraversals,
): Record<string, (...args: unknown[]) => unknown> {
  const frozen = headReferenceTraversals[group]
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    frozen.functions.join('\n').replace(/^export /gm, ''),
  )
  return new Function(
    'ValidationError',
    'WorkflowDefinitionSchema',
    'migrateWorkflowDefinitionToLatest',
    `${js}\nreturn { ${frozen.names.join(', ')} };`,
  )(ValidationError, WorkflowDefinitionSchema, migrateWorkflowDefinitionToLatest)
}

const definitions = [
  { nodes: [] },
  {
    nodes: [
      { id: 'a1', kind: 'agent-single', agentId: 'a' },
      { id: 'w1', kind: 'call-workflow', workflowName: 'same', workflowId: 'owner-b' },
      { id: 'a2', kind: 'agent-single', agentId: 'a' },
      { id: 'w2', kind: 'call-workflow', workflowName: 'same', workflowId: 'owner-a' },
      { id: 'g', kind: 'call-workgroup', workgroupName: 'room', workgroupId: 'g1' },
      { id: 'extra', kind: 'io-input', agentId: 'historical-extra' },
    ],
  },
  {
    nodes: [
      { id: 'empty', kind: 'agent-single', agentId: '' },
      { id: 'missing', kind: 'agent-single', agentName: 'name-is-not-id' },
      { id: 'w', kind: 'call-workflow', workflowName: '', workflowId: '' },
      { id: 'g', kind: 'call-workgroup', workgroupName: 'later' },
    ],
  },
] as const

describe('RFC-395 II-a A5 reference traversal oracle', () => {
  test('canonical validation keeps public sorted errors and Intent authored-order errors', () => {
    const definition = {
      nodes: [
        { id: 'z', kind: 'agent-single', agentId: '' },
        { id: 'a', kind: 'agent-single' },
      ],
    } as unknown as WorkflowDefinition
    const errorOf = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        const failure = error as ValidationError
        return { code: failure.code, message: failure.message, details: failure.details }
      }
      throw new Error('expected canonical-id failure')
    }
    const missing = collectWorkflowDependencyRefs(definition, { includeMissingAgentIds: true })
      .filter((ref) => ref.resourceType === 'agent' && ref.value.length === 0)
      .map((ref) => ref.nodeId)
    expect(missing).toEqual(['z', 'a'])
    expect(errorOf(() => oracle('intent').assertCanonicalAgentIds!(definition))).toEqual({
      code: 'workflow-agent-id-required',
      message: 'agent-single nodes require a canonical agentId',
      details: { nodeIds: missing },
    })
    expect(errorOf(() => assertCanonicalWorkflowAgentIds(definition))).toEqual(
      errorOf(() => oracle('canonical').assertCanonicalWorkflowAgentIds!(definition)),
    )
  })
  test('package source decoders retain malformed-array and scalar policies', () => {
    for (const raw of [
      {},
      { skills: 'null', dependsOn: 'null', mcp: 'false', plugins: '{broken' },
      {
        skills: '[{"kind":"managed","skillId":"s"},{"kind":"unknown","skillId":"ignored"}]',
        dependsOn: '["b",1,"b"]',
        mcp: '["m",null]',
        plugins: [],
      },
      {
        skills: [
          { kind: 'project', name: 'local' },
          { kind: 'managed', skillId: 's' },
        ],
        dependsOn: ['b', '', 'b'],
        mcp: ['m'],
        plugins: ['p'],
      },
    ]) {
      expect<unknown>(directRefsOf('agent', raw)).toEqual(
        oracle('closure').directRefsOf!('agent', raw),
      )
    }
    expect(() => decodeAgentReferenceDocumentForExport({ skills: 'null' })).toThrow(TypeError)
    expect(
      decodeAgentReferenceDocumentForExport({
        skills: '[{"kind":"project","name":"local"},{"skillId":3}]',
        dependsOn: '["b",3,"b"]',
        mcp: '[null]',
        plugins: '[]',
      }),
    ).toEqual({
      skills: [
        { kind: 'project', name: 'local' },
        { kind: 'managed', skillId: '3' },
      ],
      dependsOn: ['b', '3', 'b'],
      mcp: ['null'],
      plugins: [],
    })
  })
  for (const [index, definition] of definitions.entries()) {
    test(`definition ${index}: every forward projection preserves HEAD order and duplicates`, () => {
      const refs = collectWorkflowDependencyRefs(definition)
      const agents = refs.filter((ref) => ref.resourceType === 'agent').map((ref) => ref.value)
      const typed = definition as unknown as WorkflowDefinition
      expect<unknown>(agents).toEqual(oracle('intent').workflowAgentIds!(typed))
      expect<unknown>(new Set(agents)).toEqual(oracle('validation').agentReferences!(typed))
      expect<unknown>(new Set(agents)).toEqual(oracle('legacy').extractWorkflowAgentRefs!(typed))
      expect<unknown>(collectWorkflowCallRefs(typed)).toEqual(
        oracle('calls').collectWorkflowCallRefs!(typed),
      )
      expect<unknown>(collectWorkgroupCallRefs(typed)).toEqual(
        oracle('calls').collectWorkgroupCallRefs!(typed),
      )
      for (const [type, kind, field] of [
        ['workflow', 'call-workflow', 'workflowName'],
        ['workgroup', 'call-workgroup', 'workgroupName'],
      ] as const) {
        expect<unknown>(
          refs.filter((ref) => ref.resourceType === type).map((ref) => ref.value),
        ).toEqual(oracle('intent').workflowCallNames!(typed, kind, field))
      }
      const preserved = collectWorkflowDependencyRefs(definition, { allStringSelectors: true })
      expect<unknown>({
        agentIds: new Set(
          preserved.filter((ref) => ref.resourceType === 'agent').map((ref) => ref.value),
        ),
        workflowIds: new Set(
          preserved.flatMap((ref) =>
            ref.resourceType === 'workflow' && ref.idCache !== undefined ? [ref.idCache] : [],
          ),
        ),
        workflowNames: new Set(
          preserved
            .filter((ref) => ref.resourceType === 'workflow' && ref.selectorDefined !== false)
            .map((ref) => ref.value),
        ),
        workgroupIds: new Set(
          preserved.flatMap((ref) =>
            ref.resourceType === 'workgroup' && ref.idCache !== undefined ? [ref.idCache] : [],
          ),
        ),
        workgroupNames: new Set(
          preserved
            .filter((ref) => ref.resourceType === 'workgroup' && ref.selectorDefined !== false)
            .map((ref) => ref.value),
        ),
      }).toEqual(oracle('package').workflowGrandfatheredReferences!(typed))
    })
  }
  test('package workflow closure preserves the any-kind agentId projection from HEAD', () => {
    const recorded = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      edges: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentId: 'agent-a' },
        { id: 'extra', kind: 'input', agentId: 'historical-extra' },
        { id: 'call', kind: 'call-workflow', workflowName: 'later', workflowId: 'cached' },
        { id: 'again', kind: 'agent-single', agentId: 'agent-a' },
      ],
    }
    for (const definition of [recorded, JSON.stringify(recorded)]) {
      const row = { definition }
      const actual = directRefsOf('workflow', row)
      expect<unknown>(actual).toEqual(oracle('closure').directRefsOf!('workflow', row))
      expect(actual).toEqual([
        { type: 'agent', id: 'agent-a' },
        { type: 'agent', id: 'historical-extra' },
        { type: 'agent', id: 'agent-a' },
      ])
    }
  })
  test('source definition decoder stays pure and distinguishes malformed source documents', () => {
    expect(decodeWorkflowReferenceDocument('{broken')).toBeUndefined()
    expect(decodeWorkflowReferenceDocument('null')).toBeUndefined()
    expect(decodeWorkflowReferenceDocument(JSON.stringify(definitions[1]))).toEqual(definitions[1])
  })
  test('paths identify authored selectors; caches never replace names', () => {
    expect<unknown>(collectWorkflowDependencyRefs(definitions[1])[1]).toEqual({
      resourceType: 'workflow',
      selectorKind: 'name',
      namespace: 'workflow',
      value: 'same',
      idCache: 'owner-b',
      nodeId: 'w1',
      nodePath: 'nodes[1]',
      referencePath: 'nodes[1].workflowName',
    })
    expect<unknown>(
      collectWorkflowDependencyRefs(definitions[1], { agentOnAnyNode: true })
        .filter((ref) => ref.resourceType === 'agent')
        .map((ref) => ref.value),
    ).toEqual(['a', 'a', 'historical-extra'])
  })
  test('agent kinds keep per-kind ordinals, duplicates, project names and empty ids', () => {
    const refs = {
      skills: [
        { kind: 'managed' as const, skillId: 's' },
        { kind: 'project' as const, name: 'local' },
        { kind: 'managed' as const, skillId: 's' },
      ],
      dependsOn: ['b', '', 'b', 'a'],
      mcp: ['m', 'm'],
      plugins: ['p', 'p'],
    }
    const actual = collectAgentDependencyRefs(refs)
    expect<unknown>(
      actual
        .filter((ref) => ref.resourceType === 'skill')
        .map((ref) => [ref.selectorKind, ref.value, ref.ordinal]),
    ).toEqual([
      ['id', 's', 0],
      ['project-name', 'local', 1],
      ['id', 's', 2],
    ])
    expect<unknown>(agentReferenceIds(refs, 'agent')).toEqual(refs.dependsOn)
    expect<unknown>(agentReferenceIds(refs, 'mcp')).toEqual(refs.mcp)
    expect<unknown>(agentReferenceIds(refs, 'plugin')).toEqual(refs.plugins)
    expect<unknown>(
      actual
        .filter((ref) => ref.selectorKind === 'id')
        .map((ref) => ({ type: ref.resourceType, id: ref.value })),
    ).toEqual(
      oracle('closure').directRefsOf!(
        'agent',
        Object.fromEntries(
          Object.entries(refs).map(([key, value]) => [key, JSON.stringify(value)]),
        ),
      ),
    )
  })
})
