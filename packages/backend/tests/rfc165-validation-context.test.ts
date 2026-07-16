// LOCKS: RFC-165 T7 (R3-3) — the ONE production validation context.
//
// WHY: validateWorkflowDef's ctx.plugins is optional (undefined ⇒ plugin
// checks silently no-op, a pre-RFC-031 compatibility affordance for tests
// and YAML import). Production launch/sync paths hand-rolled `{agents,
// skills}` objects and therefore never validated plugin references — a
// workflow whose agent names a missing/disabled plugin passed the launch
// gate and died at spawn time. buildWorkflowValidationContext(db) is now the
// single assembly point (agents + skills + plugins, all live); these locks
// pin every production caller to it so a new call site can't quietly regress
// to the partial context.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { buildWorkflowValidationContext } from '../src/services/workflow.validator'

const ROOT = join(import.meta.dir, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-165 T7 — buildWorkflowValidationContext', () => {
  test('assembles agents + skills + plugins (plugins NEVER absent)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const ctx = await buildWorkflowValidationContext(db)
    expect(Array.isArray(ctx.agents)).toBe(true)
    expect(Array.isArray(ctx.skills)).toBe(true)
    // The load-bearing bit: plugins is an ARRAY (empty is fine), not
    // undefined — undefined is what silently disables the plugin checks.
    expect(Array.isArray(ctx.plugins)).toBe(true)
  })

  test('consistency lock: every production workflow validator caller uses the helper', () => {
    // Files that gate launches / syncs on either validator entry point. Each
    // must load its ctx via the canonical loader (or its legacy alias) — a hand-rolled
    // `{ agents: …, skills: … }` literal next to validateWorkflowDef( is
    // exactly the regression this pins down.
    const productionCallers = [
      'src/services/task.ts',
      'src/routes/tasks.ts',
      'src/routes/workflows.ts',
      'src/services/workflow.validator.ts',
    ]
    for (const rel of productionCallers) {
      const src = read(rel)
      if (!/\bvalidateWorkflow(?:Def|Definition)\(/.test(src)) continue
      expect(
        /\b(?:load|build)WorkflowValidationContext\(/.test(src),
        `${rel} must use the helper`,
      ).toBe(true)
      // No partial hand-rolled context objects at the call sites.
      expect(
        /validateWorkflow(?:Def|Definition)\([^)]*\{\s*\n?\s*agents:/m.test(src),
        `${rel} hand-rolls a partial validation ctx`,
      ).toBe(false)
    }
  })
})
