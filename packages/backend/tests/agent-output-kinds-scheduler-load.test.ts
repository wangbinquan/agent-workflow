// Regression lock — scheduler hydrates `agent.outputKinds` on the agent-load
// path that feeds runNode (services/runner.ts).
//
// Bug recap (task 01KS045BYZ9H52K3H2D10DBV6D, agent `doc`):
//   - DB row had `frontmatter_extra = {"outputKinds":{"docpath":"markdown_file"}}`.
//   - scheduler.ts carried its OWN `loadAgent` that mirrored agent.ts/rowToAgent
//     but missed the lift of `outputKinds` from frontmatter_extra to top-level.
//   - runner.ts gates `agentOutputKinds` on `opts.agent.outputKinds !== undefined`
//     — so the file-first markdown_file guidance (prompt.ts
//     `buildMarkdownFilePortGuidance`) was silently skipped, and the emitted
//     `node_runs.prompt_text` ended with bare `- docpath` instead of
//     `- docpath (markdown_file — write the file first, ...)` + the two-step
//     block.
//
// Locks:
//   1. Behavior — createAgent({ outputKinds }) round-trips through getAgentById so
//      Agent.outputKinds is at the top level (what runner.ts checks). This is
//      the same shape every consumer in the codebase expects (review, frontend
//      AgentForm, scheduler).
//   2. Source-text — scheduler.ts is wired to the canonical `getAgentById`
//      loader and does not reintroduce a local agent-loading function. A
//      future duplicate would either re-skip outputKinds (re-causing this
//      bug) or drift on the rest of the row→Agent contract.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createInMemoryDb } from '../src/db/client'
import { createAgent, getAgentById } from '../src/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

describe('scheduler agent-load hydrates outputKinds (regression for task 01KS045BYZ9H52K3H2D10DBV6D)', () => {
  test('createAgent({ outputKinds }) → getAgentById surfaces outputKinds at top level', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const created = await createAgent(db, {
      name: 'doc',
      description: '',
      outputs: ['docpath'],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      outputKinds: { docpath: 'markdown_file' },
      bodyMd: '',
    })

    const loaded = await getAgentById(db, created.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.outputKinds).toEqual({ docpath: 'markdown_file' })
    // outputKinds must NOT also leak back into frontmatterExtra — the runner /
    // editor read it from the lifted top-level only.
    expect((loaded?.frontmatterExtra as Record<string, unknown>).outputKinds).toBeUndefined()
  })

  test('scheduler.ts uses the canonical getAgentById loader (no duplicate agent loader)', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf8')

    // RFC-127 借壳 imports buildBorrowedAgent alongside getAgentById from the SAME
    // canonical module — match getAgentById in the agent-service import (don't pin the
    // exact named list) so the "no duplicate loader" intent survives co-imports.
    expect(src).toMatch(/import \{[^}]*\bgetAgentById\b[^}]*\} from '@\/services\/agent'/)
    expect(src).toContain('await getAgentById(db, agentIdRef)')

    // No local re-declaration. A scheduler-private agent loader would either
    // bypass outputKinds (the original bug) or drift on the rest of the
    // row→Agent contract (mcp / plugins / dependsOn parsing).
    expect(src).not.toMatch(/async function loadAgent\s*\(/)
    expect(src).not.toMatch(/JSON\.parse\(row\.frontmatterExtra\)/)
  })
})
