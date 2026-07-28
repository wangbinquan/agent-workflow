// RFC-234 (T1) — locks the intent changeset contract (design §3):
// handle/tempRef-only reference grammar (no raw ids/names — Codex design-gate
// P1-1), create/update exclusivity, tempRef declaration closure, skill file
// path safety + size invariants (§3.2, design-gate P1-6), and the
// questions/requests port payloads.

import { describe, expect, test } from 'bun:test'
import {
  INTENT_LIMITS,
  IntentChangesetSchema,
  IntentMountRequestsSchema,
  IntentQuestionsSchema,
  canonicalIntentJson,
  collectChangesetRefs,
  collectIntentWorkflowAgentRefs,
  intentHandleType,
  parseIntentChangeset,
} from '../src/schemas/intentChangeset'

const agentCreate = (over: Record<string, unknown> = {}) => ({
  opId: 'op-1',
  action: 'create',
  resourceType: 'agent',
  tempRef: '$new:auditor',
  payload: {
    name: 'auditor',
    description: 'audits diffs',
    outputs: ['findings'],
    bodyMd: 'You audit.',
    ...over,
  },
})

const changeset = (ops: unknown[]) => ({ $schema_version: 1, ops })

describe('IntentChangesetSchema', () => {
  test('accepts a minimal create + update pair and resolves refs', () => {
    const cs = changeset([
      agentCreate(),
      {
        opId: 'op-2',
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
              { id: 'n2', kind: 'agent-single', agentRef: 'res#agent#2' },
            ],
            edges: [],
          },
        },
      },
    ])
    const parsed = IntentChangesetSchema.safeParse(cs)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(collectChangesetRefs(parsed.data)).toEqual(['$new:auditor', 'res#agent#2'])
  })

  test('rejects raw ULID / agentId / agentName in workflow nodes', () => {
    const byId = changeset([
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'workflow',
        tempRef: '$new:flow',
        payload: {
          name: 'f',
          description: '',
          definition: {
            $schema_version: 4,
            inputs: [],
            nodes: [{ id: 'n1', kind: 'agent-single', agentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
            edges: [],
          },
        },
      },
    ])
    expect(IntentChangesetSchema.safeParse(byId).success).toBe(false)

    const { violations } = collectIntentWorkflowAgentRefs({
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'sneaky' },
        { id: 'b', kind: 'agent-single' },
        { id: 'c', kind: 'input' },
      ],
    })
    expect(violations).toEqual([
      { nodeId: 'a', reason: 'agent-name-forbidden' },
      { nodeId: 'b', reason: 'agent-ref-missing' },
    ])
  })

  test('update target handle type must match resourceType; create/update fields exclusive', () => {
    const mismatch = changeset([
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'agent',
        target: 'res#workflow#1',
        payload: { name: 'x', description: '', outputs: [], bodyMd: '' },
      },
    ])
    expect(IntentChangesetSchema.safeParse(mismatch).success).toBe(false)

    const both = changeset([{ ...agentCreate(), target: 'res#agent#1' }])
    expect(IntentChangesetSchema.safeParse(both).success).toBe(false)

    expect(intentHandleType('res#mcp#12')).toBe('mcp')
    expect(intentHandleType('res#user#1')).toBeNull()
  })

  test('undeclared tempRef reference is rejected; duplicates rejected', () => {
    const undeclared = changeset([agentCreate({ dependsOn: ['$new:missing'] })])
    expect(IntentChangesetSchema.safeParse(undeclared).success).toBe(false)

    const dupOp = changeset([agentCreate(), agentCreate()])
    expect(IntentChangesetSchema.safeParse(dupOp).success).toBe(false)
  })

  test('workgroup payload: placeholder humans only, leader must be agent member', () => {
    const wg = (members: unknown[], leader?: string) =>
      changeset([
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workgroup',
          tempRef: '$new:squad',
          payload: {
            name: 'squad',
            description: '',
            instructions: '',
            mode: 'leader_worker',
            leaderDisplayName: leader,
            members,
          },
        },
      ])
    const ok = wg(
      [
        { memberType: 'agent', agentRef: 'res#agent#1', displayName: 'lead', roleDesc: '' },
        { memberType: 'human', displayName: 'reviewer', roleDesc: 'approves' },
      ],
      'lead',
    )
    expect(IntentChangesetSchema.safeParse(ok).success).toBe(true)

    // A human member carrying a userId is out-of-schema (identity isolation).
    const withUser = wg([{ memberType: 'human', displayName: 'r', roleDesc: '', userId: 'u_1' }])
    expect(IntentChangesetSchema.safeParse(withUser).success).toBe(false)

    const humanLeader = wg([{ memberType: 'human', displayName: 'boss', roleDesc: '' }], 'boss')
    expect(IntentChangesetSchema.safeParse(humanLeader).success).toBe(false)
  })

  test('skill files: traversal, SKILL.md, duplicates and totals rejected', () => {
    const skill = (files: unknown[]) =>
      changeset([
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'skill',
          tempRef: '$new:sk',
          payload: { name: 'sk', description: '', bodyMd: 'body', files },
        },
      ])
    expect(
      IntentChangesetSchema.safeParse(skill([{ path: 'a/../b.md', content: 'x' }])).success,
    ).toBe(false)
    expect(
      IntentChangesetSchema.safeParse(skill([{ path: '/abs.md', content: 'x' }])).success,
    ).toBe(false)
    expect(
      IntentChangesetSchema.safeParse(skill([{ path: 'SKILL.md', content: 'x' }])).success,
    ).toBe(false)
    expect(
      IntentChangesetSchema.safeParse(
        skill([
          { path: 'ref/a.md', content: 'x' },
          { path: 'ref/A.md', content: 'y' },
        ]),
      ).success,
    ).toBe(false)
    expect(
      IntentChangesetSchema.safeParse(skill([{ path: 'scripts/run.sh', content: 'echo ok' }]))
        .success,
    ).toBe(true)
  })

  test('size invariant: max legal payload parses; oversize rejected with guidance', () => {
    // 8 files × 128 KiB = 1 MiB (per-skill cap) still under the 2 MiB changeset cap.
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `ref/f${i}.md`,
      content: 'a'.repeat(INTENT_LIMITS.maxSkillFileBytes),
    }))
    const big = changeset([
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:big',
        payload: { name: 'big', description: '', bodyMd: 'b', files },
      },
    ])
    const ok = parseIntentChangeset(JSON.stringify(big))
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.bytes).toBeLessThanOrEqual(INTENT_LIMITS.maxChangesetBytes)
    }

    // Two such skills push canonical JSON over 2 MiB → structured rejection.
    const tooBig = changeset([
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:big1',
        payload: { name: 'big1', description: '', bodyMd: 'b', files },
      },
      {
        opId: 'op-2',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:big2',
        payload: { name: 'big2', description: '', bodyMd: 'b', files },
      },
      {
        opId: 'op-3',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:big3',
        payload: { name: 'big3', description: '', bodyMd: 'b', files },
      },
    ])
    const rejected = parseIntentChangeset(JSON.stringify(tooBig))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.errors[0]).toContain('changeset-too-large')
    }
  })

  test('canonicalIntentJson is key-order independent', () => {
    expect(canonicalIntentJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalIntentJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    )
  })
})

// Live-run regression (deepseek 2026-07-28): IntentOpSchema is a plain
// 12-branch union — zod v3 collapses its failure to `ops.0: Invalid input`,
// which the model self-fix loop cannot act on. formatChangesetIssues must
// recurse into the closest branch and name the offending fields.
describe('kind grammar at parse time', () => {
  test('invalid inputs[].kind / outputKinds values fail with the RFC-060 message', () => {
    const result = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'agent',
            tempRef: '$new:a',
            payload: {
              name: 'a',
              description: '',
              outputs: ['findings'],
              outputKinds: { findings: 'nonsense-kind' },
              inputs: [{ name: 'diff', kind: 'git-diff' }],
              bodyMd: 'x',
            },
          },
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.some((e) => e.includes('registered base kind'))).toBe(true)
    expect(
      result.errors.some((e) => e.includes('outputKinds.findings') || e.includes('inputs.0.kind')),
    ).toBe(true)
  })
})

describe('formatChangesetIssues', () => {
  test('union failures surface field-level paths instead of Invalid input', () => {
    const result = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'agent',
            tempRef: '$new:auditor',
            // name missing + outputs wrong type → the agent-create branch
            payload: { description: 'x', outputs: 'findings', bodyMd: '' },
          },
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors.some((e) => e === 'ops.0: Invalid input')).toBe(false)
    expect(result.errors.some((e) => e.includes('ops.0.payload.name'))).toBe(true)
    expect(result.errors.some((e) => e.includes('ops.0.payload.outputs'))).toBe(true)
  })
})

describe('port payloads', () => {
  test('questions: bounds + duplicate ids', () => {
    const q = (id: string) => ({ id, question: 'pick', options: ['a', 'b'], multiSelect: false })
    expect(IntentQuestionsSchema.safeParse([q('q1'), q('q2')]).success).toBe(true)
    expect(IntentQuestionsSchema.safeParse([q('q1'), q('q1')]).success).toBe(false)
    expect(IntentQuestionsSchema.safeParse([]).success).toBe(false)
    expect(
      IntentQuestionsSchema.safeParse([
        { id: 'q1', question: 'one option', options: ['only'], multiSelect: false },
      ]).success,
    ).toBe(false)
  })

  test('mount requests: suggestion shape only', () => {
    expect(
      IntentMountRequestsSchema.safeParse([
        { resourceType: 'workflow', name: 'code-audit', reason: 'user mentioned it' },
      ]).success,
    ).toBe(true)
    expect(IntentMountRequestsSchema.safeParse([{ resourceType: 'user', name: 'x' }]).success).toBe(
      false,
    )
  })
})
