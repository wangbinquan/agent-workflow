// Source-layer guard: the agent/skill edit routes must navigate back to the
// corresponding list page after a successful save. Locks the UX decision made
// in the 2026-05-16 conversation — stale "stay on page after save" behavior
// re-appearing would silently regress this. The runtime route components are
// non-trivial to JSDOM-render (TanStack Router + React Query + many child
// components), so we assert at the source level: the onSuccess callback for
// each save mutation must contain a `navigate({ to: '/agents' })` /
// `navigate({ to: '/skills' })` call.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const agentDetailPath = resolve(__dirname, '../src/routes/agents.detail.tsx')
const skillDetailPath = resolve(__dirname, '../src/routes/skills.detail.tsx')

describe('edit routes navigate to list on save (source layer)', () => {
  test('agents.detail save.onSuccess navigates to /agents', () => {
    const src = readFileSync(agentDetailPath, 'utf-8')
    const block = extractMutationBlock(src, 'save')
    expect(block).toMatch(/navigate\(\s*\{\s*to:\s*'\/agents'\s*\}\s*\)/)
  })

  test('skills.detail saveMeta.onSuccess navigates to /skills', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    const block = extractMutationBlock(src, 'saveMeta')
    expect(block).toMatch(/navigate\(\s*\{\s*to:\s*'\/skills'\s*\}\s*\)/)
  })

  test('skills.detail saveContent.onSuccess navigates to /skills', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    const block = extractMutationBlock(src, 'saveContent')
    expect(block).toMatch(/navigate\(\s*\{\s*to:\s*'\/skills'\s*\}\s*\)/)
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
