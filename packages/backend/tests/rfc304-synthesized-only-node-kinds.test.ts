// RFC-304 — `code-round` is synthesized by the platform and must never be
// authorable by a user.
//
// Why this file exists: "not authorable" is enforced by FOUR independent
// mechanisms, and each of them fails open on its own —
//   1. the palette parks the kind in section 'internal' (frontend; locked in
//      packages/frontend/tests/palette.test.ts),
//   2. INTENT.md withholds it instead of teaching its node form (locked in
//      rfc234-intent-doc.test.ts),
//   3. the validator rejects it in any submitted definition (locked HERE),
//   4. `SYNTHESIZED_ONLY_NODE_KINDS` is the single list all three consult.
//
// #3 is the one that actually stops a determined caller: the palette only hides
// the node from the editor, and INTENT.md only guides a model. A hand-written
// YAML import, a crafted `PUT /api/workflows/:id`, or a copied definition would
// otherwise sail straight through — and the resulting task would be dispatched
// with no code-capability round record behind it, i.e. a shape nobody can
// explain from the logs.
//
// The tests enumerate SYNTHESIZED_ONLY_NODE_KINDS rather than naming
// 'code-round', so a future synthesized kind is covered the day it is added —
// the RFC-243/253/269 drift (three kinds left untaught for months) came from
// hand-copied kind lists.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { SYNTHESIZED_ONLY_NODE_KINDS, isSynthesizedOnlyNodeKind } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

const CTX = { agents: [], skills: [] }

function defWith(nodes: unknown[]): WorkflowDefinition {
  return {
    $schema_version: 5,
    inputs: [],
    nodes,
    edges: [],
  } as unknown as WorkflowDefinition
}

describe('RFC-304 — synthesized-only node kinds are rejected by the validator', () => {
  test('the list is non-empty and code-round is on it', () => {
    // A guard against the list being emptied by a refactor: every test below
    // would vacuously pass if it were.
    expect(SYNTHESIZED_ONLY_NODE_KINDS.length).toBeGreaterThan(0)
    expect(SYNTHESIZED_ONLY_NODE_KINDS as readonly string[]).toContain('code-round')
    expect(isSynthesizedOnlyNodeKind('code-round')).toBe(true)
    expect(isSynthesizedOnlyNodeKind('agent-single')).toBe(false)
    // Raw-surface tolerance: rows and wire payloads carry plain strings.
    expect(isSynthesizedOnlyNodeKind(undefined)).toBe(false)
    expect(isSynthesizedOnlyNodeKind('nope')).toBe(false)
  })

  for (const kind of SYNTHESIZED_ONLY_NODE_KINDS) {
    test(`a user-authored '${kind}' node is rejected`, () => {
      const { issues } = validateWorkflowDef(defWith([{ id: 'n1', kind }]), CTX)
      const hit = issues.find((issue) => issue.code === 'code-round-not-authorable')
      expect(hit).toBeDefined()
      // The message must name the offending node — a definition can be large
      // and "something is wrong somewhere" is not actionable.
      expect(hit?.message).toContain('n1')
      expect(hit?.pointer).toBe('n1')
    })

    test(`'${kind}' is rejected even when the definition is otherwise valid`, () => {
      // The rule must not depend on other errors being present: a definition
      // whose ONLY problem is the synthesized kind still fails.
      const { issues } = validateWorkflowDef(
        defWith([
          { id: 'in', kind: 'input', inputKey: 'description' },
          { id: 'n1', kind },
        ]),
        CTX,
      )
      expect(issues.some((issue) => issue.code === 'code-round-not-authorable')).toBe(true)
    })
  }

  test('an ordinary definition is NOT flagged by this rule', () => {
    // Reverse assertion — without it the rule could match everything and the
    // tests above would still pass.
    const { issues } = validateWorkflowDef(
      defWith([{ id: 'in', kind: 'input', inputKey: 'description' }]),
      CTX,
    )
    expect(issues.some((issue) => issue.code === 'code-round-not-authorable')).toBe(false)
  })
})
