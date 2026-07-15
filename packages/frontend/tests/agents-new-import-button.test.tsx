// RFC-018 T4 — source-code-layer guard for the Import-from-agent.md wiring.
// Locks two invariants:
//   1. /agents/new wires AgentImportDialog + mergeAgentImport and exposes
//      the Import button with the testid the dialog integration tests rely on.
//   2. /agents/$name (edit route) source code does NOT reference
//      AgentImportDialog. The import flow is new-route only; if a future
//      refactor pulls the dialog into the edit route this test goes red so
//      we re-evaluate the UX (the edit form is a snapshot of an existing
//      agent; importing on top is destructive).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const newRoutePath = resolve(__dirname, '../src/routes/agents.new.tsx')
const detailRoutePath = resolve(__dirname, '../src/routes/agents.detail.tsx')

describe('agents new-route import wiring (source layer)', () => {
  test('agents.new.tsx imports AgentImportDialog + merge helper', () => {
    const src = readFileSync(newRoutePath, 'utf-8')
    expect(src).toContain("from '@/components/AgentImportDialog'")
    expect(src).toContain("from '@/lib/agent-import-merge'")
  })

  test('agents.new.tsx exposes the Import button with stable testid', () => {
    const src = readFileSync(newRoutePath, 'utf-8')
    expect(src).toContain('data-testid="agent-import-open"')
    expect(src).toContain('ref={importTriggerRef}')
    expect(src).toContain("t('agentForm.importButton')")
  })

  test('agents.new.tsx wires AgentImportDialog with mergeAgentImport callback', () => {
    const src = readFileSync(newRoutePath, 'utf-8')
    expect(src).toContain('<AgentImportDialog')
    expect(src).toContain('mergeAgentImport(prev, res)')
    expect(src).toContain('triggerRef={importTriggerRef}')
    expect(src).toContain('onViewForm={setActiveTab}')
  })

  test('agents.detail.tsx does NOT import AgentImportDialog', () => {
    const src = readFileSync(detailRoutePath, 'utf-8')
    expect(src.includes('AgentImportDialog')).toBe(false)
    expect(src.includes('agent-import-merge')).toBe(false)
  })
})
