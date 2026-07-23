// RFC-223 (PR-1) — locks the typed `AgentSkillRef` (persistent, DB/wire) and
// the portable `AgentSkillSelector` (name-based, agent.md / YAML export) as two
// SEPARATE schemas, plus the resolver-driven conversions between them.
//
// Why separate: an offline parser has no DB and cannot mint a skillId, so the
// portable form is name-based; the import boundary resolves it to an id ref
// against the actor's ACL-visible set (or DEMOTES to a project ref — RFC-178).

import { describe, expect, test } from 'bun:test'
import {
  AgentSkillRefSchema,
  AgentSkillSelectorSchema,
  agentSkillRefName,
  skillRefToSelector,
  skillSelectorToRef,
  type AgentSkillRef,
} from '../src/schemas/agent'

describe('AgentSkillRefSchema (persistent ref)', () => {
  test('accepts managed{skillId} and project{name}', () => {
    expect(AgentSkillRefSchema.safeParse({ kind: 'managed', skillId: 'sid-1' }).success).toBe(true)
    expect(AgentSkillRefSchema.safeParse({ kind: 'project', name: 'local' }).success).toBe(true)
  })

  test('rejects a mixed / malformed ref', () => {
    // managed must carry skillId (not name); project must carry name (not skillId).
    expect(AgentSkillRefSchema.safeParse({ kind: 'managed', name: 'x' }).success).toBe(false)
    expect(AgentSkillRefSchema.safeParse({ kind: 'project', skillId: 'x' }).success).toBe(false)
    expect(AgentSkillRefSchema.safeParse({ kind: 'other', skillId: 'x' }).success).toBe(false)
  })

  test('agentSkillRefName reads the display token regardless of kind', () => {
    expect(agentSkillRefName({ kind: 'managed', skillId: 'sid-1' })).toBe('sid-1')
    expect(agentSkillRefName({ kind: 'project', name: 'local' })).toBe('local')
  })
})

describe('AgentSkillSelectorSchema (portable selector)', () => {
  test('accepts managed{name, ownerUsername?} and project{name}', () => {
    expect(AgentSkillSelectorSchema.safeParse({ kind: 'managed', name: 'lint' }).success).toBe(true)
    expect(
      AgentSkillSelectorSchema.safeParse({ kind: 'managed', name: 'lint', ownerUsername: 'alice' })
        .success,
    ).toBe(true)
    expect(AgentSkillSelectorSchema.safeParse({ kind: 'project', name: 'local' }).success).toBe(
      true,
    )
  })

  test('a selector carries NO skillId (it is not a persistent ref)', () => {
    // The selector is intentionally id-free; skillId only exists on the ref.
    const parsed = AgentSkillSelectorSchema.parse({ kind: 'managed', name: 'lint' })
    expect('skillId' in parsed).toBe(false)
  })
})

describe('selector ⇄ ref conversion (resolver-driven)', () => {
  test('selector → ref: a managed name resolves to a skillId', () => {
    const ref = skillSelectorToRef({ kind: 'managed', name: 'lint' }, (name) =>
      name === 'lint' ? 'sid-lint' : undefined,
    )
    expect(ref).toEqual({ kind: 'managed', skillId: 'sid-lint' })
  })

  test('selector → ref: an unresolved managed name DEMOTES to a project ref (RFC-178)', () => {
    const ref = skillSelectorToRef({ kind: 'managed', name: 'ghost' }, () => undefined)
    expect(ref).toEqual({ kind: 'project', name: 'ghost' })
  })

  test('selector → ref: a project selector stays a project ref', () => {
    const ref = skillSelectorToRef({ kind: 'project', name: 'local' }, () => 'never')
    expect(ref).toEqual({ kind: 'project', name: 'local' })
  })

  test('ref → selector: a managed id resolves back to name (+ owner)', () => {
    const sel = skillRefToSelector({ kind: 'managed', skillId: 'sid-lint' }, (id) =>
      id === 'sid-lint' ? { name: 'lint', ownerUsername: 'alice' } : undefined,
    )
    expect(sel).toEqual({ kind: 'managed', name: 'lint', ownerUsername: 'alice' })
  })

  test('ref → selector: a project ref stays a project selector', () => {
    const sel = skillRefToSelector({ kind: 'project', name: 'local' }, () => undefined)
    expect(sel).toEqual({ kind: 'project', name: 'local' })
  })

  test('round-trip: ref → selector → ref is stable under a consistent resolver', () => {
    const byId = new Map([['sid-lint', { name: 'lint' }]])
    const byName = new Map([['lint', 'sid-lint']])
    const original: AgentSkillRef = { kind: 'managed', skillId: 'sid-lint' }
    const selector = skillRefToSelector(original, (id) => byId.get(id))
    const back = skillSelectorToRef(selector, (name) => byName.get(name))
    expect(back).toEqual(original)
  })
})
