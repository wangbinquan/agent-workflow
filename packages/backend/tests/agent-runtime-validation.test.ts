// RFC-111 (Codex audit F6 gate): createAgent / updateAgent must reject a pinned
// runtime NAME that doesn't resolve to a runtimes row. Without it a typo'd /
// unknown / deleted runtime saves as a pin but silently falls back to built-in
// opencode at dispatch (resolveAgentRuntime) — a hard-to-detect runtime + profile
// drift. The F6 agent.md import widened the exposure (authors can pin arbitrary
// names), which is why this guard landed alongside it.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import type { CreateAgent } from '@agent-workflow/shared'
import { createAgent, updateAgent } from '../src/services/agent'
import {
  createRuntime,
  seedBuiltinRuntimes,
  setRuntimeEnabled,
} from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const base: Omit<CreateAgent, 'name' | 'runtime'> = {
  description: 'x',
  outputs: [],
  syncOutputsOnIterate: false,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'b',
}

describe('RFC-111/F6: agent runtime reference validation', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db) // built-in opencode + claude-code rows
  })

  test('createAgent rejects an unknown / typo runtime name', async () => {
    await expect(createAgent(db, { ...base, name: 'a', runtime: 'claude_code' })).rejects.toThrow(
      /unknown runtime/,
    )
  })

  test('createAgent accepts a registered runtime, and omitted runtime (inherit)', async () => {
    await expect(
      createAgent(db, { ...base, name: 'a1', runtime: 'opencode' }),
    ).resolves.toBeDefined()
    // createAgent's runtime is string|undefined (no null) — omitting it = inherit.
    await expect(createAgent(db, { ...base, name: 'a2' })).resolves.toBeDefined()
  })

  test('updateAgent rejects repointing to an unknown runtime', async () => {
    await createAgent(db, { ...base, name: 'a', runtime: 'opencode' })
    await expect(updateAgent(db, 'a', { runtime: 'nope' })).rejects.toThrow(/unknown runtime/)
  })

  test('updateAgent allows clearing the pin to null (inherit)', async () => {
    await createAgent(db, { ...base, name: 'a', runtime: 'opencode' })
    const cleared = await updateAgent(db, 'a', { runtime: null })
    expect(cleared.runtime).toBeUndefined()
  })

  // RFC-118: a disabled runtime stays registered but can't be a NEW pin.
  test('RFC-118: createAgent rejects a NEW pin to a disabled runtime', async () => {
    await createRuntime(db, { name: 'oc-x', protocol: 'opencode' })
    await setRuntimeEnabled(db, 'oc-x', false, 'opencode')
    await expect(createAgent(db, { ...base, name: 'a', runtime: 'oc-x' })).rejects.toThrow(
      /disabled runtime/,
    )
  })

  // RFC-118 D6: KEEPING an already-pinned, now-disabled runtime is allowed so the
  // agent's OTHER fields stay editable (mirrors RFC-099 "only validate NEW refs").
  test('RFC-118: updateAgent allows re-saving an already-pinned now-disabled runtime', async () => {
    await createRuntime(db, { name: 'oc-y', protocol: 'opencode' })
    await createAgent(db, { ...base, name: 'a', runtime: 'oc-y' })
    await setRuntimeEnabled(db, 'oc-y', false, 'opencode') // disabled AFTER the agent pinned it
    const updated = await updateAgent(db, 'a', { runtime: 'oc-y', description: 'edited' })
    expect(updated.runtime).toBe('oc-y')
    expect(updated.description).toBe('edited')
  })

  test('RFC-118: updateAgent rejects CHANGING the pin to a disabled runtime', async () => {
    await createRuntime(db, { name: 'oc-z', protocol: 'opencode' })
    await setRuntimeEnabled(db, 'oc-z', false, 'opencode')
    await createAgent(db, { ...base, name: 'a', runtime: 'opencode' })
    await expect(updateAgent(db, 'a', { runtime: 'oc-z' })).rejects.toThrow(/disabled runtime/)
  })
})
