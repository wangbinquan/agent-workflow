// Source-layer guard: the agent/skill edit routes must navigate back to the
// corresponding list page after a successful save. Locks the UX decision made
// in the 2026-05-16 conversation — stale "stay on page after save" behavior
// re-appearing would silently regress this. The runtime route components are
// non-trivial to JSDOM-render (TanStack Router + React Query + many child
// components), so we assert at the source level.
//
// skills.detail re-anchor (RFC-151 impl gate): navigation moved OUT of the two
// save mutations into a coordinated handler — per-channel navigate was itself
// a bug (the first fulfilled PUT unmounted the page and masked the sibling
// channel's failure). The lock now asserts the corrected shape: navigate fires
// behind an all-channels-fulfilled check, and NEVER inside saveMeta /
// saveContent. Behavior coverage: skills-detail-save-channels.test.tsx.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const agentDetailPath = resolve(__dirname, '../src/routes/agents.detail.tsx')
const skillDetailPath = resolve(__dirname, '../src/routes/skills.detail.tsx')

describe('edit routes navigate to list on save (source layer)', () => {
  // RFC-169 D2 — INTENTIONAL FLIP: the split (master-detail) page saves in
  // place. agents.detail save.onSuccess must NOT navigate; it reseeds the draft
  // via commitSaved so the editor stays put and the list card refreshes.
  test('agents.detail save.onSuccess stays in place (no navigate) and reseeds', () => {
    const src = readFileSync(agentDetailPath, 'utf-8')
    const block = extractMutationBlock(src, 'save')
    expect(block).not.toMatch(/navigate\(/)
    expect(block).toContain('commitSaved(')
  })

  // RFC-169 D2 — INTENTIONAL FLIP: skills.detail also saves in place. The
  // coordinated all-channels-fulfilled handler reseeds via commitSaved and
  // best-effort refetches, but must NOT navigate.
  test('skills.detail coordinated save stays in place (commitSaved, no navigate) after ALL channels fulfil', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    const start = src.indexOf('const handleSave = async')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('const del = useMutation', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('Promise.allSettled')
    expect(block).toMatch(/every\(\(r\) => r\.status === 'fulfilled'\)\)/)
    expect(block).toContain('commitSaved(')
    expect(block).not.toMatch(/navigate\(/)
  })

  test('skills.detail save mutations must NOT navigate per-channel (failure-mask regression)', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    for (const varName of ['saveMeta', 'saveContent']) {
      const block = extractMutationBlock(src, varName)
      expect(block).not.toMatch(/navigate\(/)
    }
  })
})

function extractMutationBlock(src: string, varName: string): string {
  const start = src.indexOf(`const ${varName} = useMutation(`)
  if (start === -1) throw new Error(`could not find useMutation for ${varName}`)
  let depth = 0
  let i = src.indexOf('(', start)
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced useMutation for ${varName}`)
}
