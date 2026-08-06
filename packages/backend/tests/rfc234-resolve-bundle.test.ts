// RFC-234 §9.2/§9.3 (T6) — locks the slot/decision/resolution layer:
//  - server-issued slots are the ONLY addressable overlay surface (unknown
//    slot → 422, design-gate P1-3);
//  - secret sentinels must be filled, credential findings must be waived;
//  - copy decisions normalize update→create with bundle-wide rewiring
//    (design-gate P0-4 anchor: the copy gets a NEW id and every same-bundle
//    reference follows it);
//  - human placeholders bind or drop (identity enters only via decisions);
//  - topo order: skills→mcps→plugins→agents(dependsOn)→workflows/workgroups.

import { describe, expect, test } from 'bun:test'
import { parseIntentChangeset } from '@agent-workflow/shared'
import type { IntentContextManifest } from '../src/services/intent/manifest'
import { deriveIntentSlots, resolveIntentBundle } from '../src/services/intent/resolveChangeset'

const MANIFEST: IntentContextManifest = [
  {
    handle: 'res#workflow#1',
    resourceType: 'workflow',
    resourceId: '01WFWFWFWFWFWFWFWFWFWFWFWF',
    root: true,
    detail: true,
    fence: { kind: 'workflow', version: 3 },
    dumpHash: 'x',
  },
  {
    handle: 'res#agent#1',
    resourceType: 'agent',
    resourceId: '01AGAGAGAGAGAGAGAGAGAGAGAG',
    root: false,
    detail: true,
    fence: { kind: 'agent', updatedAt: 5, aclRevision: 0 },
    dumpHash: 'y',
  },
]

const OCCUPIED: ReadonlyMap<
  'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup',
  ReadonlySet<string>
> = new Map([
  ['agent', new Set(['taken-name'])],
  ['skill', new Set<string>()],
  ['mcp', new Set<string>()],
  ['plugin', new Set<string>()],
  ['workflow', new Set<string>()],
  ['workgroup', new Set<string>()],
])

function parse(cs: unknown) {
  const r = parseIntentChangeset(JSON.stringify(cs))
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.changeset
}

const FULL_BUNDLE = parse({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'skill',
      tempRef: '$new:checklist',
      payload: { name: 'checklist', description: '', bodyMd: '# c', files: [] },
    },
    {
      opId: 'op-2',
      action: 'create',
      resourceType: 'mcp',
      tempRef: '$new:gh',
      payload: {
        type: 'local',
        name: 'gh',
        description: '',
        config: { command: ['npx'], env: { TOKEN: '‹secret›' } },
      },
    },
    {
      opId: 'op-3',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:auditor',
      payload: {
        name: 'auditor',
        description: '',
        outputs: ['findings'],
        skills: ['$new:checklist'],
        mcp: ['$new:gh'],
        dependsOn: ['res#agent#1'],
        bodyMd: 'audit',
      },
    },
    {
      opId: 'op-4',
      action: 'update',
      resourceType: 'workflow',
      target: 'res#workflow#1',
      payload: {
        name: 'audit-flow',
        description: '',
        definition: {
          $schema_version: 4,
          inputs: [],
          nodes: [
            { id: 'n1', kind: 'agent-single', agentRef: '$new:auditor' },
            { id: 'n2', kind: 'agent-single', agentRef: 'res#agent#1' },
          ],
          edges: [],
        },
      },
    },
    {
      opId: 'op-5',
      action: 'create',
      resourceType: 'workgroup',
      tempRef: '$new:squad',
      payload: {
        name: 'squad',
        description: '',
        instructions: '',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        members: [
          { memberType: 'agent', agentRef: '$new:auditor', displayName: 'lead', roleDesc: '' },
          { memberType: 'human', displayName: 'approver', roleDesc: 'approves' },
        ],
      },
    },
  ],
})

describe('deriveIntentSlots', () => {
  test('issues secret / humanBinding / finalName slots deterministically', () => {
    const { slots, report } = deriveIntentSlots(MANIFEST, FULL_BUNDLE)
    expect(report.errors).toEqual([])
    const ids = slots.map((s) => s.slotId)
    expect(ids).toContain('secret:op-2:/config/env/TOKEN')
    expect(ids).toContain('human:op-5:approver')
    expect(ids).toContain('name:op-3')
    // deterministic: second derivation is identical
    expect(deriveIntentSlots(MANIFEST, FULL_BUNDLE).slots).toEqual(slots)
  })
})

describe('resolveIntentBundle', () => {
  const baseDecisions = [
    { opId: 'op-2', slots: [{ slotId: 'secret:op-2:/config/env/TOKEN', value: 'real-secret' }] },
    {
      opId: 'op-5',
      slots: [{ slotId: 'human:op-5:approver', value: 'user_APPROVER0000000000000' }],
    },
  ]

  test('happy path: overlay + rewiring + topo order', () => {
    const bundle = resolveIntentBundle({
      manifest: MANIFEST,
      changeset: FULL_BUNDLE,
      decisions: baseDecisions,
      occupiedNames: OCCUPIED,
    })
    const order = bundle.ops.map((o) => `${o.resourceType}:${o.action}`)
    expect(order).toEqual([
      'skill:create',
      'mcp:create',
      'agent:create',
      'workflow:update',
      'workgroup:create',
    ])
    const agentOp = bundle.ops.find((o) => o.opId === 'op-3')
    const skillId = bundle.finalIdByRef.get('$new:checklist')
    const mcpId = bundle.finalIdByRef.get('$new:gh')
    const agentId = bundle.finalIdByRef.get('$new:auditor')
    expect((agentOp?.payload.skills as Array<{ skillId: string }>)[0]?.skillId).toBe(skillId)
    expect((agentOp?.payload.mcp as string[])[0]).toBe(mcpId)
    expect((agentOp?.payload.dependsOn as string[])[0]).toBe('01AGAGAGAGAGAGAGAGAGAGAGAG')

    const wfOp = bundle.ops.find((o) => o.opId === 'op-4')
    const nodes = (wfOp?.payload.definition as { nodes: Array<Record<string, unknown>> }).nodes
    expect(nodes[0]?.agentId).toBe(agentId)
    expect(nodes[0]?.agentRef).toBeUndefined()
    expect(nodes[1]?.agentId).toBe('01AGAGAGAGAGAGAGAGAGAGAGAG')
    expect(wfOp?.manifestEntry?.fence).toEqual({ kind: 'workflow', version: 3 })

    // secrets overlay landed and never leaked into other ops
    const mcpOp = bundle.ops.find((o) => o.opId === 'op-2')
    expect((mcpOp?.payload.config as { env: Record<string, string> }).env.TOKEN).toBe('real-secret')

    // human binding materialized
    const wgOp = bundle.ops.find((o) => o.opId === 'op-5')
    const members = wgOp?.payload.members as Array<Record<string, unknown>>
    expect(members.find((m) => m.memberType === 'human')?.userId).toBe('user_APPROVER0000000000000')
  })

  test('copy decision normalizes update→create and rewires the bundle', () => {
    const cs = parse({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'update',
          resourceType: 'agent',
          target: 'res#agent#1',
          payload: { name: 'tuned-agent', description: '', outputs: ['out'], bodyMd: 'x' },
        },
        {
          opId: 'op-2',
          action: 'update',
          resourceType: 'workflow',
          target: 'res#workflow#1',
          payload: {
            name: 'flow',
            description: '',
            definition: {
              $schema_version: 4,
              inputs: [],
              nodes: [{ id: 'n1', kind: 'agent-single', agentRef: 'res#agent#1' }],
              edges: [],
            },
          },
        },
      ],
    })
    const bundle = resolveIntentBundle({
      manifest: MANIFEST,
      changeset: cs,
      decisions: [{ opId: 'op-1', applyMode: 'copy' }],
      occupiedNames: OCCUPIED,
    })
    const agentOp = bundle.ops.find((o) => o.opId === 'op-1')
    expect(agentOp?.action).toBe('create')
    expect(agentOp?.fromCopy).toBe(true)
    expect(agentOp?.resourceId).not.toBe('01AGAGAGAGAGAGAGAGAGAGAGAG')
    // the workflow (kept as modify) now points at the COPY, not the original
    const wfOp = bundle.ops.find((o) => o.opId === 'op-2')
    const nodes = (wfOp?.payload.definition as { nodes: Array<Record<string, unknown>> }).nodes
    expect(nodes[0]?.agentId).toBe(agentOp?.resourceId)
  })

  test('violations: unknown slot / unfilled secret / unwaived finding / name conflict', () => {
    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: FULL_BUNDLE,
        decisions: [
          ...baseDecisions,
          { opId: 'op-1', slots: [{ slotId: 'secret:op-9:/nope', value: 'x' }] },
        ],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/intent-slot-unknown|was not issued/)

    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: FULL_BUNDLE,
        decisions: [baseDecisions[1] as never],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/intent-secret-required|must be filled/)

    const withCred = parse({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:leaky',
          payload: {
            name: 'leaky',
            description: '',
            outputs: [],
            bodyMd: 'use --token=ghp_AAAABBBBCCCCDDDDEEEEFFFF111122223333', // gitleaks:allow — deliberate fake credential fixture
          },
        },
      ],
    })
    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: withCred,
        decisions: [],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/requires an explicit waiver/)
    // an explicit waiver lets it through
    const { slots } = deriveIntentSlots(MANIFEST, withCred)
    const waiver = slots.find((s) => s.kind === 'secretWaiver')
    expect(waiver).toBeDefined()
    const ok = resolveIntentBundle({
      manifest: MANIFEST,
      changeset: withCred,
      decisions: [{ opId: 'op-1', slots: [{ slotId: waiver?.slotId ?? '', value: 'waived' }] }],
      occupiedNames: OCCUPIED,
    })
    expect(ok.ops.length).toBe(1)

    const clash = parse({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:x',
          payload: { name: 'taken-name', description: '', outputs: [], bodyMd: 'x' },
        },
      ],
    })
    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: clash,
        decisions: [],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/intent-name-conflict|is taken/)
    // finalName slot resolves the clash without regenerating
    const renamed = resolveIntentBundle({
      manifest: MANIFEST,
      changeset: clash,
      decisions: [{ opId: 'op-1', slots: [{ slotId: 'name:op-1', value: 'free-name' }] }],
      occupiedNames: OCCUPIED,
    })
    expect((renamed.ops[0]?.payload as { name: string }).name).toBe('free-name')
  })
})

// RFC-253 T28 — script-node env is a slot-addressed carrier, mirroring MCP env:
// the model may only emit the sentinel, the confirm UI supplies real values,
// and the sentinel itself must never survive into the resolved definition.
describe('RFC-253 T28 — script-node env slots', () => {
  const scriptFlow = (env: Record<string, string>) =>
    parse({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:etl',
          payload: {
            name: 'etl',
            description: '',
            definition: {
              $schema_version: 4,
              inputs: [],
              nodes: [{ id: 's1', kind: 'script', language: 'python', script: 'print(1)', env }],
              edges: [],
            },
          },
        },
      ],
    })

  test('a sentinel env value issues a secret slot; empty issues none', () => {
    const { slots, report } = deriveIntentSlots(
      MANIFEST,
      scriptFlow({ API_TOKEN: '‹secret›', EMPTY: '' }),
    )
    expect(report.errors).toEqual([])
    const ids = slots.map((s) => s.slotId)
    expect(ids).toContain('secret:op-1:/definition/nodes/0/env/API_TOKEN')
    expect(ids.filter((id) => id.includes('/env/'))).toHaveLength(1)
  })

  test('the filled slot value lands in the resolved definition', () => {
    const bundle = resolveIntentBundle({
      manifest: MANIFEST,
      changeset: scriptFlow({ API_TOKEN: '‹secret›' }),
      decisions: [
        {
          opId: 'op-1',
          slots: [
            {
              slotId: 'secret:op-1:/definition/nodes/0/env/API_TOKEN',
              value: 'real-env-secret',
            },
          ],
        },
      ],
      occupiedNames: OCCUPIED,
    })
    const wfOp = bundle.ops.find((o) => o.opId === 'op-1')
    const nodes = (wfOp?.payload.definition as { nodes: Array<Record<string, unknown>> }).nodes
    expect((nodes[0]?.env as Record<string, string>).API_TOKEN).toBe('real-env-secret')
    expect(JSON.stringify(wfOp?.payload)).not.toContain('‹secret›')
  })

  test('an unfilled script env slot blocks the confirm', () => {
    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: scriptFlow({ API_TOKEN: '‹secret›' }),
        decisions: [],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/intent-secret-required|must be filled/)
  })

  test('a literal env value is refused at draft time with its pointer', () => {
    const { report } = deriveIntentSlots(MANIFEST, scriptFlow({ API_TOKEN: 'literal-value' }))
    expect(
      report.errors.some(
        (e) =>
          e.includes('intent-secret-value-forbidden') &&
          e.includes('/payload/definition/nodes/0/env/API_TOKEN'),
      ),
    ).toBe(true)
    expect(() =>
      resolveIntentBundle({
        manifest: MANIFEST,
        changeset: scriptFlow({ API_TOKEN: 'literal-value' }),
        decisions: [],
        occupiedNames: OCCUPIED,
      }),
    ).toThrow(/draft has blocking validation errors/)
  })
})
