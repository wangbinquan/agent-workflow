// RFC-053 PR-C P-2 — kind behavior matrix tests.
//
// Locks the table itself (every NodeKind × every dimension) + the
// compile-time invariant (exhaustiveness via `satisfies Record<NodeKind, _>`).
// PR-C consumers (retryNode + the fixup script) query the table; this file
// catches drift between table values and the documented intent.

import { describe, expect, test } from 'bun:test'
import {
  NODE_KIND_BEHAVIORS,
  isProcessNodeKind,
  nodeKindParticipatesInRetryCascade,
  type NodeKind,
  type NodeKindBehavior,
} from '@agent-workflow/shared'

describe('RFC-053 PR-C — NODE_KIND_BEHAVIORS matrix', () => {
  test('process kinds (agent / wrapper) get the "live process" row', () => {
    const processKinds: NodeKind[] = ['agent-single', 'agent-multi', 'wrapper-git', 'wrapper-loop']
    for (const k of processKinds) {
      const b = NODE_KIND_BEHAVIORS[k]
      expect({ k, ...b }).toEqual({
        k,
        retryCascade: 'mint-placeholder',
        limits: 'enforce-time-budget',
        orphanReap: 'mark-interrupted',
        gc: 'gc-with-task',
        shutdown: 'graceful-abort',
      })
    }
  })

  test('non-process kinds (input / output / review / clarify) get the "user-pending" row', () => {
    const nonProcessKinds: NodeKind[] = ['input', 'output', 'review', 'clarify']
    for (const k of nonProcessKinds) {
      const b = NODE_KIND_BEHAVIORS[k]
      expect({ k, ...b }).toEqual({
        k,
        retryCascade: 'skip',
        limits: 'opt-out',
        orphanReap: 'leave-alone',
        gc: 'gc-with-task',
        shutdown: 'no-op',
      })
    }
  })

  test('every NodeKind has an entry (exhaustiveness via satisfies Record)', () => {
    const expectedKinds: NodeKind[] = [
      'agent-single',
      'agent-multi',
      'input',
      'output',
      'wrapper-git',
      'wrapper-loop',
      // RFC-060 — wrapper-fanout joins the wrapper-* row.
      'wrapper-fanout',
      'review',
      'clarify',
      // RFC-056 — cross-agent clarify joins the non-process row.
      'clarify-cross-agent',
    ]
    const tableKeys = Object.keys(NODE_KIND_BEHAVIORS).sort()
    expect(tableKeys).toEqual(expectedKinds.sort())
  })

  test('every behavior dimension is filled for every kind', () => {
    for (const k of Object.keys(NODE_KIND_BEHAVIORS) as NodeKind[]) {
      const b: NodeKindBehavior = NODE_KIND_BEHAVIORS[k]
      expect(b.retryCascade).toBeOneOf(['mint-placeholder', 'skip'])
      expect(b.limits).toBeOneOf(['enforce-time-budget', 'opt-out'])
      expect(b.orphanReap).toBeOneOf(['mark-interrupted', 'leave-alone'])
      expect(b.gc).toBeOneOf(['gc-with-task', 'pin'])
      expect(b.shutdown).toBeOneOf(['graceful-abort', 'no-op'])
    }
  })

  test('nodeKindParticipatesInRetryCascade matches table retryCascade', () => {
    for (const k of Object.keys(NODE_KIND_BEHAVIORS) as NodeKind[]) {
      const fromTable = NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder'
      expect({ k, derived: nodeKindParticipatesInRetryCascade(k) }).toEqual({
        k,
        derived: fromTable,
      })
    }
  })

  test('legacy isProcessNodeKind (RFC-052 ship) agrees with the table', () => {
    // RFC-052 added isProcessNodeKind as a hardcoded check; PR-C makes
    // NODE_KIND_BEHAVIORS authoritative. If anyone changes one without
    // updating the other, this test fails immediately.
    for (const k of Object.keys(NODE_KIND_BEHAVIORS) as NodeKind[]) {
      const tableSays = NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder'
      expect({ k, legacy: isProcessNodeKind(k), table: tableSays }).toEqual({
        k,
        legacy: tableSays,
        table: tableSays,
      })
    }
  })
})

describe('RFC-053 PR-C — retryNode uses the table (RFC-052 cascade behavior preserved)', () => {
  test('mint-placeholder kinds: agent-single, agent-multi, wrapper-git, wrapper-loop', () => {
    expect(nodeKindParticipatesInRetryCascade('agent-single')).toBe(true)
    expect(nodeKindParticipatesInRetryCascade('agent-multi')).toBe(true)
    expect(nodeKindParticipatesInRetryCascade('wrapper-git')).toBe(true)
    expect(nodeKindParticipatesInRetryCascade('wrapper-loop')).toBe(true)
  })

  test('skip kinds: input, output, review, clarify (the RFC-052 fix)', () => {
    expect(nodeKindParticipatesInRetryCascade('input')).toBe(false)
    expect(nodeKindParticipatesInRetryCascade('output')).toBe(false)
    expect(nodeKindParticipatesInRetryCascade('review')).toBe(false)
    expect(nodeKindParticipatesInRetryCascade('clarify')).toBe(false)
  })
})
