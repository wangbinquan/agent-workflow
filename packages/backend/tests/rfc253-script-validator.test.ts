// RFC-253 — script node static validation.
//
// The two "unsupported" rules are the interesting ones: they exist so a
// combination the runtime CANNOT honour is refused at save time instead of
// producing a node that silently never runs (fan-out) or a port whose content
// dangles once the isolated worktree is collected (path kinds). Both are
// non-goals in proposal §3; a future contributor who implements either must
// delete the rule deliberately, and these tests are where they will find out.

import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { validateWorkflowDefinition } from '@/services/workflow.validator'

function codesFor(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []): string[] {
  const definition: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges }
  return validateWorkflowDefinition(definition, { agents: [], skills: [] }).issues.map(
    (i) => i.code,
  )
}

function script(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 's1',
    kind: 'script',
    language: 'python',
    script: 'print(1)',
    ...extra,
  } as WorkflowNode
}

describe('script node validation', () => {
  test('a well-formed node produces no script issue', () => {
    expect(codesFor([script()]).filter((c) => c.startsWith('script-'))).toEqual([])
  })

  test('empty body and unknown language are reported', () => {
    expect(codesFor([script({ script: '   ' })])).toContain('script-body-empty')
    expect(codesFor([script({ language: 'ruby' })])).toContain('script-language-invalid')
  })

  test('a script inside wrapper-fanout is refused (non-goal, fail closed)', () => {
    const codes = codesFor([
      script(),
      {
        id: 'w1',
        kind: 'wrapper-fanout',
        nodeIds: ['s1'],
        inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
      } as WorkflowNode,
    ])
    expect(codes).toContain('script-in-fanout-unsupported')
  })

  test('a script inside wrapper-loop is fine', () => {
    const codes = codesFor([
      script(),
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['s1'], maxIterations: 3 } as WorkflowNode,
    ])
    expect(codes).not.toContain('script-in-fanout-unsupported')
  })

  test('path-valued output kinds are refused until the archival chain exists', () => {
    expect(codesFor([script({ outputs: [{ name: 'docs', kind: 'list<path<md>>' }] })])).toContain(
      'script-output-kind-path-unsupported',
    )
    expect(codesFor([script({ outputs: [{ name: 'docs', kind: 'path<md>' }] })])).toContain(
      'script-output-kind-path-unsupported',
    )
    expect(codesFor([script({ outputs: [{ name: 'docs', kind: 'list<string>' }] })])).not.toContain(
      'script-output-kind-path-unsupported',
    )
  })

  test('duplicate output ports are reported', () => {
    expect(codesFor([script({ outputs: [{ name: 'a' }, { name: 'a' }] })])).toContain(
      'script-output-name-duplicate',
    )
  })

  test('inbound ports that fold to the same env var are refused', () => {
    const codes = codesFor(
      [script(), { id: 'a1', kind: 'agent-single', agentId: 'AG1' } as WorkflowNode],
      [
        {
          id: 'e1',
          source: { nodeId: 'a1', portName: 'o' },
          target: { nodeId: 's1', portName: 'my-port' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a1', portName: 'o' },
          target: { nodeId: 's1', portName: 'my_port' },
        },
      ],
    )
    expect(codes).toContain('script-port-env-collision')
  })

  test('dependency problems are split into malformed vs unpinned', () => {
    expect(codesFor([script({ dependencies: ['requests'] })])).toContain(
      'script-dependency-version-unpinned',
    )
    expect(codesFor([script({ dependencies: ['git+https://evil.test/x.git'] })])).toContain(
      'script-dependency-malformed',
    )
    expect(
      codesFor([script({ dependencies: ['requests==2.32.3'] })]).filter((c) =>
        c.startsWith('script-dependency'),
      ),
    ).toEqual([])
  })

  test('bash cannot declare dependencies', () => {
    expect(
      codesFor([script({ language: 'bash', script: 'echo hi', dependencies: ['x==1'] })]),
    ).toContain('script-dependencies-unsupported')
  })

  test('reserved and malformed env keys are both reported', () => {
    expect(codesFor([script({ env: { PYTHONPATH: '/tmp' } })])).toContain('script-env-key-reserved')
    expect(codesFor([script({ env: { AW_PORT_X: '1' } })])).toContain('script-env-key-reserved')
    expect(codesFor([script({ env: { LD_PRELOAD: '/tmp/x.so' } })])).toContain(
      'script-env-key-invalid',
    )
    expect(codesFor([script({ env: { '1BAD': 'x' } })])).toContain('script-env-key-invalid')
    expect(
      codesFor([script({ env: { API_TOKEN: 'x' } })]).filter((c) => c.startsWith('script-env')),
    ).toEqual([])
  })
})
