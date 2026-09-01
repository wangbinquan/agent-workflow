// RFC-282 D3 — the RFC-271 codec's three unwired domains (call /
// importSelector / intent) are now on production paths, and the leftover
// second spellings are gone. 对拍 (决策 19): every key/wire the swap touched
// is asserted byte-identical against the OLD hand-rolled spelling, hardcoded
// here so a codec drift cannot silently rewrite persisted/mapped identities.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  decodeCallRef,
  encodeCallRef,
  decodeIntentRef,
  encodeIntentRef,
  importRefSelectorKey,
  intentHandleType,
  isIntentTempRef,
} from '@agent-workflow/shared'
import { allocateHandle, createHandleAllocator } from '../src/services/intent/manifest'
import {
  resolveAgentRefsUsable,
  type AgentReferenceResolver,
} from '../src/modules/resource-catalog/application/agents/agentReferences'

const SHARED_SRC = resolve(import.meta.dir, '..', '..', 'shared', 'src')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

describe('RFC-282 D3 — importSelector domain', () => {
  test('importRefSelectorKey bytes are unchanged vs the pre-codec spelling (对拍)', () => {
    const cases = [
      { type: 'skill', name: 'review-checklist', ownerUsername: 'alice' },
      { type: 'agent', name: 'auditor' },
      { type: 'mcp', name: 'github' },
    ] as const
    for (const selector of cases) {
      const legacy = JSON.stringify([
        selector.type,
        selector.name,
        (selector as { ownerUsername?: string }).ownerUsername ?? null,
      ])
      expect(importRefSelectorKey(selector as never)).toBe(legacy)
    }
  })
})

describe('RFC-282 D3 — intent domain', () => {
  test('allocateHandle mints byte-identical wire vs the pre-codec spelling (对拍)', () => {
    const alloc = createHandleAllocator()
    expect(allocateHandle(alloc, 'agent', 'A1')).toBe('res#agent#1')
    expect(allocateHandle(alloc, 'agent', 'A2')).toBe('res#agent#2')
    expect(allocateHandle(alloc, 'skill', 'S1')).toBe('res#skill#1')
    // idempotent per resource
    expect(allocateHandle(alloc, 'agent', 'A1')).toBe('res#agent#1')
  })

  test('createHandleAllocator seeds counters through the codec (round-trip)', () => {
    const alloc = createHandleAllocator([
      {
        handle: 'res#agent#7',
        resourceType: 'agent',
        resourceId: 'A7',
        root: true,
        detail: true,
      },
    ] as never)
    expect(allocateHandle(alloc, 'agent', 'A8')).toBe('res#agent#8')
  })

  test('intentHandleType / isIntentTempRef behave exactly as the regex readers did', () => {
    expect(intentHandleType('res#workflow#12')).toBe('workflow')
    expect(intentHandleType('res#nope#1')).toBeNull()
    expect(intentHandleType('$new:thing')).toBeNull()
    expect(isIntentTempRef('$new:my-agent')).toBe(true)
    expect(isIntentTempRef('res#agent#1')).toBe(false)
    expect(isIntentTempRef('$new:BAD CAPS')).toBe(false)
  })

  test('encode/decode round-trip is byte-exact for both variants', () => {
    for (const wire of ['res#agent#3', 'res#workgroup#999', '$new:auditor-2']) {
      const ast = decodeIntentRef(wire)
      expect(ast).not.toBeNull()
      expect(encodeIntentRef(ast!)).toBe(wire)
    }
  })
})

describe('RFC-282 D3 — call domain', () => {
  test('call codec round-trips the closure selector wire', () => {
    const wire = { nodeId: 'call-1', name: 'child-wf', idHint: '01ABC' }
    const ast = decodeCallRef('workflow', wire)
    expect(ast.k).toBe('call')
    expect(encodeCallRef(ast)).toEqual(wire)
  })

  test('freezeCallClosure walks on the call codec (source wiring)', () => {
    const text = readFileSync(resolve(BACKEND_SRC, 'services/execution/closure.ts'), 'utf8')
    expect(text).toContain('decodeCallRef')
    // Both walk layers (root seed + BFS descend) and the workgroup pass go
    // through the wire→AST converters; the freeze walk reads AST fields.
    expect(text.split('workflowCallAst(').length - 1).toBeGreaterThanOrEqual(3)
    expect(text.split('workgroupCallAst(').length - 1).toBeGreaterThanOrEqual(3)
    expect(text.split('.authoritativeName').length - 1).toBeGreaterThanOrEqual(4)
    // childClosureSubset's v1 name-keyed fallback legitimately still reads the
    // wire field (stored v1 closures have no edge keys) — freeze itself does not.
    const freezeBody = text.slice(text.indexOf('export async function freezeCallClosure'))
    expect(freezeBody).not.toMatch(/\.workflowName\b/)
    expect(freezeBody).not.toMatch(/\.workgroupName\b/)
  })
})

describe('RFC-282 D3 — leftover second spellings are gone', () => {
  test('agentRefs skill de-dup behavior is unchanged after the m:/p: key removal', async () => {
    const managedA = ulid()
    const managedB = ulid()
    const resolver: AgentReferenceResolver = {
      async resolveUsableById(_actor, _type, tokens) {
        const ids = [...new Set(tokens)]
        return { ids, byToken: new Map(ids.map((id) => [id, id])), missing: [] }
      },
      assertNoMissing(missing) {
        if (missing.length > 0) throw new Error('identity resolver produced missing references')
      },
    }
    const resolved = await resolveAgentRefsUsable(resolver, null, {
      mcp: [],
      plugins: [],
      dependsOn: [],
      skills: [
        { kind: 'managed', skillId: managedA },
        { kind: 'project', name: 'local-notes' },
        { kind: 'managed', skillId: managedA }, // dup managed
        { kind: 'project', name: 'local-notes' }, // dup project
        { kind: 'managed', skillId: managedB },
      ],
    })
    expect(resolved.skills).toEqual([
      { kind: 'managed', skillId: managedA },
      { kind: 'project', name: 'local-notes' },
      { kind: 'managed', skillId: managedB },
    ])
  })

  test('the hand-rolled m:/p: prefix pair no longer exists in agentRefs', () => {
    const text = readFileSync(
      resolve(BACKEND_SRC, 'modules/resource-catalog/application/agents/agentReferences.ts'),
      'utf8',
    )
    expect(text).not.toContain('`m:${')
    expect(text).not.toContain('`p:${')
  })

  test('the unimplemented RefResolver interface is deleted from shared', () => {
    const text = readFileSync(resolve(SHARED_SRC, 'ref/resolution.ts'), 'utf8')
    expect(text).not.toContain('export interface RefResolver')
  })
})
