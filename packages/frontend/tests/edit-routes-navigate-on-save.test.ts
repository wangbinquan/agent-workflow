// Source-layer guard: the agent/skill edit routes must navigate back to the
// corresponding list page after a successful save. Locks the UX decision made
// in the 2026-05-16 conversation — stale "stay on page after save" behavior
// re-appearing would silently regress this. The runtime route components are
// non-trivial to JSDOM-render (TanStack Router + React Query + many child
// components), so we assert at the source level.
//
// skills.detail re-anchor (RFC-201): metadata plus every dirty file now form one
// route-owned composite draft. A save captures one revision plan, owns a single
// busy lease, and advances the server-issued composite token step-by-step. It
// stays in place; a later file failure must not hide an earlier successful step.
// Behavior coverage: skills-detail-save-channels.test.tsx.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const agentDetailPath = resolve(__dirname, '../src/routes/agents.detail.tsx')
const skillDetailPath = resolve(__dirname, '../src/routes/skills.detail.tsx')
const skillCompositePath = resolve(__dirname, '../src/lib/skill-composite-draft.ts')

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

  test('skills.detail captures one composite plan and saves it sequentially in place', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    const block = extractBetween(src, 'const handleSave = useCallback', 'const handleRecheck')

    expect(block).toContain('const current = compositeRef.current')
    expect(block).toContain('saveBusyReleaseRef.current !== undefined')
    expect(block).toContain('const plan = captureSkillSavePlan(current)')
    expect(block).toContain('const releaseBusy = beginBusy(name)')
    expect(block).toContain('for (const step of plan)')
    expect(block).toContain('token = await writeStep(step, token, requestId)')
    expect(block).not.toMatch(/navigate\(/)
  })

  test('skill composite plan owns metadata + dirty files and every write is token-fenced', () => {
    const src = readFileSync(skillDetailPath, 'utf-8')
    const composite = readFileSync(skillCompositePath, 'utf-8')
    const plan = extractBetween(
      composite,
      'export function captureSkillSavePlan',
      'export function isDefinitiveSkillWriteError',
    )

    expect(plan).toContain('aggregate.valid || aggregate.busy || aggregate.outcomeUnknown')
    expect(plan).toContain('state.metadata.dirty')
    expect(plan).toContain('Object.entries(state.files)')
    expect(plan).toContain('.filter(([, scope]) => scope.dirty)')
    expect(plan).toContain(
      '`${left.path}\\0${left.op}`.localeCompare(`${right.path}\\0${right.op}`)',
    )

    const writeStep = extractBetween(src, 'const writeStep = useCallback', 'const handleSave')
    expect(writeStep).toContain('{ ...step.submitted, expectedToken }')
    expect(writeStep).toContain('{ content: step.submitted.content, expectedToken }')
    expect(writeStep).toContain('expectedToken=${encodeURIComponent(expectedToken)}')
    expect(src).not.toContain('const saveMeta = useMutation')
    expect(src).not.toContain('const saveContent = useMutation')
  })
})

function extractBetween(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle)
  if (start === -1) throw new Error(`could not find '${startNeedle}'`)
  const end = src.indexOf(endNeedle, start)
  if (end === -1) throw new Error(`could not find '${endNeedle}' after '${startNeedle}'`)
  return src.slice(start, end)
}

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
