// RFC-253 — the script node's pure oracles.
//
// These lock the decisions the design gate forced into their current shape, so
// a future refactor that quietly reverts one goes red with a named reason:
//   - the sensitive projection must cover INBOUND EDGES and WRAPPER PLACEMENT,
//     not just the node's own fields (design-gate P1): rewiring a script's
//     inputs or dropping it into a 50-iteration loop changes what the host
//     executes without touching a byte of the body;
//   - dependency grammars are PER LANGUAGE and pins are exact (F10 / P1);
//   - a spilled port value must never also be present inline (a truncated
//     half-value read as if whole is worse than an absent one).

import { describe, expect, test } from 'bun:test'
import {
  declaredScriptOutputs,
  normalizeScriptDependencies,
  planScriptPortEnv,
  scriptDependencyIssue,
  scriptEnvSuffix,
  scriptOutputMode,
  scriptPortEnvCollisions,
  scriptReservedEnvKeyIssue,
  serializeScriptDepsEnvKeyV1,
  serializeScriptSensitiveProjectionV1,
  SCRIPT_ENV_INLINE_LIMIT,
  SCRIPT_ENV_TOTAL_LIMIT,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src/index'

function scriptNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 's1',
    kind: 'script',
    language: 'python',
    script: 'print(1)',
    ...extra,
  } as WorkflowNode
}

function defWith(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges }
}

describe('port → environment variable mapping', () => {
  test('folds to a POSIX identifier and prefixes a digit-leading name', () => {
    expect(scriptEnvSuffix('report')).toBe('REPORT')
    expect(scriptEnvSuffix('my-port.v2')).toBe('MY_PORT_V2')
    expect(scriptEnvSuffix('2nd')).toBe('_2ND')
  })

  test('collisions are detected so the validator can reject them at save time', () => {
    expect(scriptPortEnvCollisions(['my-port', 'my_port'])).toEqual([
      { suffix: 'MY_PORT', portNames: ['my-port', 'my_port'] },
    ])
    expect(scriptPortEnvCollisions(['a', 'b'])).toEqual([])
  })

  test('a value past the single-value ceiling spills and is NOT also inline', () => {
    const big = 'x'.repeat(SCRIPT_ENV_INLINE_LIMIT + 1)
    const plan = planScriptPortEnv({ small: 'ok', big })
    expect(plan.inline.AW_PORT_SMALL).toBe('ok')
    expect(plan.inline.AW_PORT_BIG).toBeUndefined()
    expect(plan.spilled).toEqual([{ portName: 'big', envName: 'AW_PORT_FILE_BIG', value: big }])
  })

  test('the aggregate ceiling spills later values once the budget is spent', () => {
    // Three values that each fit alone but together exceed the total budget.
    const chunk = 'y'.repeat(SCRIPT_ENV_INLINE_LIMIT)
    const count = Math.ceil(SCRIPT_ENV_TOTAL_LIMIT / SCRIPT_ENV_INLINE_LIMIT) + 1
    const inputs: Record<string, string> = {}
    for (let i = 0; i < count; i++) inputs[`p${String(i).padStart(2, '0')}`] = chunk
    const plan = planScriptPortEnv(inputs)
    expect(plan.spilled.length).toBeGreaterThan(0)
    expect(Object.keys(plan.inline).length).toBeLessThan(count)
    // Deterministic: the same inputs always split the same way, so "did my
    // value spill?" has a stable answer.
    expect(planScriptPortEnv(inputs)).toEqual(plan)
  })

  test('multi-byte characters are counted as UTF-8 bytes, not code units', () => {
    // 2 bytes per char in UTF-8, so half the ceiling in chars still fits.
    const half = 'é'.repeat(SCRIPT_ENV_INLINE_LIMIT / 2 - 1)
    expect(planScriptPortEnv({ p: half }).spilled).toEqual([])
    const over = 'é'.repeat(SCRIPT_ENV_INLINE_LIMIT / 2 + 8)
    expect(planScriptPortEnv({ p: over }).spilled.length).toBe(1)
  })
})

describe('output shape', () => {
  test('no declared ports ⇒ single-port mode with the fixed stdout outlet', () => {
    expect(scriptOutputMode(scriptNode())).toBe('single')
    expect(declaredScriptOutputs(scriptNode())).toEqual([{ name: 'stdout' }])
  })

  test('declared ports ⇒ envelope mode, deduped for stable rendering', () => {
    const node = scriptNode({
      outputs: [{ name: 'files', kind: 'list<string>' }, { name: 'files' }, { name: 'summary' }],
    })
    expect(scriptOutputMode(node)).toBe('envelope')
    expect(declaredScriptOutputs(node)).toEqual([
      { name: 'files', kind: 'list<string>' },
      { name: 'summary' },
    ])
  })
})

describe('dependency specs', () => {
  test('accepts exact pins in each language grammar', () => {
    expect(scriptDependencyIssue('python', 'requests==2.32.3')).toBeNull()
    expect(scriptDependencyIssue('python', 'pandas[performance]==2.2.2')).toBeNull()
    expect(scriptDependencyIssue('node', 'lodash@4.17.21')).toBeNull()
    expect(scriptDependencyIssue('node', '@scope/pkg@1.2.3')).toBeNull()
  })

  test('rejects unpinned specs with a message that says what to do', () => {
    for (const [lang, spec] of [
      ['python', 'requests'],
      ['python', 'requests>=2.0'],
      ['node', 'lodash'],
      ['node', 'lodash@^4'],
    ] as const) {
      expect(scriptDependencyIssue(lang, spec)).toContain('exact version')
    }
  })

  test('rejects every shape that would fetch code from somewhere else', () => {
    for (const spec of [
      '-r requirements.txt',
      '--index-url=https://evil.test/simple',
      'git+https://evil.test/pkg.git',
      '../../etc/passwd',
      'pkg; rm -rf /',
      'requests==2.32.3 ; sys_platform == "linux"',
    ]) {
      expect(scriptDependencyIssue('python', spec)).not.toBeNull()
    }
  })

  test('bash cannot declare dependencies at all', () => {
    expect(scriptDependencyIssue('bash', 'anything==1.0')).not.toBeNull()
  })

  test('the environment key is order- and duplicate-insensitive but version-sensitive', () => {
    const base = {
      language: 'python' as const,
      interpreterPath: '/usr/bin/python3',
      interpreterVersion: 'Python 3.12.1',
    }
    const a = serializeScriptDepsEnvKeyV1({ ...base, specs: ['b==2', 'a==1', 'a==1'] })
    const b = serializeScriptDepsEnvKeyV1({ ...base, specs: ['a==1', 'b==2'] })
    expect(a).toBe(b)
    const other = serializeScriptDepsEnvKeyV1({
      ...base,
      interpreterVersion: 'Python 3.13.0',
      specs: ['a==1', 'b==2'],
    })
    expect(other).not.toBe(a)
    expect(normalizeScriptDependencies([' b==2 ', 'a==1', 'a==1'])).toEqual(['a==1', 'b==2'])
  })
})

describe('reserved environment keys', () => {
  test('refuses the keys that would undo the platform guarantees', () => {
    for (const key of ['PATH', 'HOME', 'PYTHONPATH', 'NODE_OPTIONS', 'TMPDIR']) {
      expect(scriptReservedEnvKeyIssue(key)).not.toBeNull()
    }
    expect(scriptReservedEnvKeyIssue('AW_PORT_X')).not.toBeNull()
    expect(scriptReservedEnvKeyIssue('GIT_AUTHOR_NAME')).not.toBeNull()
  })

  test('ordinary keys pass', () => {
    expect(scriptReservedEnvKeyIssue('API_TOKEN')).toBeNull()
    expect(scriptReservedEnvKeyIssue('MY_SETTING')).toBeNull()
  })
})

describe('sensitive projection (the scripts:author gate oracle)', () => {
  const base = defWith([
    scriptNode(),
    { id: 'a1', kind: 'agent-single', agentId: 'AG1', promptTemplate: 'x' } as WorkflowNode,
  ])

  test('unchanged definition ⇒ identical bytes', () => {
    expect(serializeScriptSensitiveProjectionV1(base)).toBe(
      serializeScriptSensitiveProjectionV1(defWith([...base.nodes])),
    )
  })

  test('editing anything the host executes changes the projection', () => {
    const variants: Array<[string, WorkflowDefinition]> = [
      ['body', defWith([scriptNode({ script: 'print(2)' }), base.nodes[1]!])],
      ['language', defWith([scriptNode({ language: 'bash' }), base.nodes[1]!])],
      [
        'dependencies',
        defWith([scriptNode({ dependencies: ['requests==2.32.3'] }), base.nodes[1]!]),
      ],
      ['env', defWith([scriptNode({ env: { API_TOKEN: 'x' } }), base.nodes[1]!])],
      ['network', defWith([scriptNode({ network: 'deny' }), base.nodes[1]!])],
      ['readonly', defWith([scriptNode({ readonly: true }), base.nodes[1]!])],
      ['outputs', defWith([scriptNode({ outputs: [{ name: 'x' }] }), base.nodes[1]!])],
      ['added node', defWith([...base.nodes, scriptNode({ id: 's2' })])],
      ['removed node', defWith([base.nodes[1]!])],
    ]
    for (const [label, def] of variants) {
      expect(
        serializeScriptSensitiveProjectionV1(def),
        `${label} must be inside the gated projection`,
      ).not.toBe(serializeScriptSensitiveProjectionV1(base))
    }
  })

  test('rewiring an inbound edge changes the projection (design-gate P1)', () => {
    // The edge names AND fills AW_PORT_DATA; repointing it at another source
    // changes what the already-authorized body will process.
    const withEdge = defWith(base.nodes as WorkflowNode[], [
      {
        id: 'e1',
        source: { nodeId: 'a1', portName: 'out' },
        target: { nodeId: 's1', portName: 'data' },
      },
    ])
    const repointed = defWith(base.nodes as WorkflowNode[], [
      {
        id: 'e1',
        source: { nodeId: 'a1', portName: 'other' },
        target: { nodeId: 's1', portName: 'data' },
      },
    ])
    expect(serializeScriptSensitiveProjectionV1(withEdge)).not.toBe(
      serializeScriptSensitiveProjectionV1(base),
    )
    expect(serializeScriptSensitiveProjectionV1(repointed)).not.toBe(
      serializeScriptSensitiveProjectionV1(withEdge),
    )
  })

  test('wrapper placement and iteration ceiling are inside the projection', () => {
    const loop = {
      id: 'w1',
      kind: 'wrapper-loop',
      nodeIds: ['s1'],
      maxIterations: 3,
    } as WorkflowNode
    const inLoop = defWith([...base.nodes, loop])
    const moreIterations = defWith([...base.nodes, { ...loop, maxIterations: 50 } as WorkflowNode])
    expect(serializeScriptSensitiveProjectionV1(inLoop)).not.toBe(
      serializeScriptSensitiveProjectionV1(base),
    )
    expect(serializeScriptSensitiveProjectionV1(moreIterations)).not.toBe(
      serializeScriptSensitiveProjectionV1(inLoop),
    )
  })

  test('cosmetic edits do NOT require the permission', () => {
    const moved = defWith([
      scriptNode({ position: { x: 500, y: 900 }, title: 'renamed' }),
      base.nodes[1]!,
    ])
    const otherNodeEdited = defWith([
      scriptNode(),
      { ...(base.nodes[1] as object), promptTemplate: 'totally different' } as WorkflowNode,
    ])
    const reordered = defWith([base.nodes[1]!, scriptNode()])
    for (const def of [moved, otherNodeEdited, reordered]) {
      expect(serializeScriptSensitiveProjectionV1(def)).toBe(
        serializeScriptSensitiveProjectionV1(base),
      )
    }
  })

  test('env key order does not change the projection', () => {
    const one = defWith([scriptNode({ env: { A: '1', B: '2' } })])
    const two = defWith([scriptNode({ env: { B: '2', A: '1' } })])
    expect(serializeScriptSensitiveProjectionV1(one)).toBe(
      serializeScriptSensitiveProjectionV1(two),
    )
  })
})
