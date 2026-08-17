// RFC-304 §5 — resolving a stage's `agentSlot` to a concrete agent.
//
// This is the group layer doing its job: the platform fixes the stage sequence,
// a team points the `reviewer` slot at its own agent. The interesting content
// is entirely in the failure messages, because the four ways this goes wrong
// need four DIFFERENT fixes and land on different screens:
//
//   no cell            → the repository has no capability configuration at all
//   no binding         → the cell exists but nothing is selected
//   slot unmapped      → a binding is selected but this slot is blank
//   agent deleted      → something WAS chosen and has since vanished
//
// Collapsing them into "not configured" sends someone to the wrong place, and
// the last one especially: a dangling reference is repaired, not filled in.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { capabilityTemplates, agents } from '../src/db/schema'
import { resolveReviewerAgent } from '../src/services/codeReviewAgentCaller'
import { upsertCapabilityCell } from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const REPO = 'repo-1'

const facts = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

const ask = (db: DbClient) =>
  resolveReviewerAgent(db, { repoId: REPO, capability: 'mr-review', slot: 'reviewer' })

describe('RFC-304 — resolving the reviewer slot', () => {
  let db: DbClient
  let agentId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    agentId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: 'reviewer-agent',
      bodyMd: 'You review code.',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
  afterEach(() => db.$client.close())

  const bindWith = async (agentBySlotJson: string) => {
    await db.insert(capabilityTemplates).values({
      id: 'binding-1',
      name: 'team binding',
      agentBySlotJson,
      createdAt: NOW,
      updatedAt: NOW,
      capability: 'mr-review',
    })
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      templateId: 'binding-1',
      enabled: true,
      facts,
      dependencyRevision: 1,
      now: NOW,
    })
  }

  test('a bound slot resolves to that agent', async () => {
    await bindWith(JSON.stringify({ reviewer: agentId }))
    const result = await ask(db)
    expect(result.ok).toBe(true)
    expect(result.ok && result.agent.name).toBe('reviewer-agent')
  })

  test('resolves THIS capability’s cell, not whichever one sorts first', async () => {
    // The bug this locks (fixed 2026-08-16): the query filtered on `repoId`
    // alone with `limit(1)`, so a repository running two capabilities resolved
    // the binding from whichever cell came back first. `mr-review` would then
    // run its stage with `mr-monitor`'s agent — silently, while every error
    // message claimed to be reading "the 'mr-review' cell".
    //
    // Invisible to any test that seeds ONE capability per repository, which is
    // every other test in this file.
    const otherAgentId = ulid()
    await db.insert(agents).values({
      id: otherAgentId,
      name: 'monitor-agent',
      bodyMd: 'You watch pipelines.',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityTemplates).values({
      id: 'binding-monitor',
      name: 'monitor binding',
      agentBySlotJson: JSON.stringify({ reviewer: otherAgentId }),
      createdAt: NOW,
      updatedAt: NOW,
      capability: 'mr-monitor',
    })
    // Written FIRST, so it is the row a repo-only query is most likely to hit.
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-monitor',
      templateId: 'binding-monitor',
      enabled: true,
      facts,
      dependencyRevision: 1,
      now: NOW,
    })
    await bindWith(JSON.stringify({ reviewer: agentId }))

    const result = await ask(db)
    expect(result.ok).toBe(true)
    expect(result.ok && result.agent.name).toBe('reviewer-agent')
  })

  test('a repository with no cell says so, naming the capability', async () => {
    const result = await ask(db)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('no capability configuration')
    expect(!result.ok && result.message).toContain('mr-review')
  })

  test('a cell with no binding is a DIFFERENT message from no cell', async () => {
    // Same screen, different field: one means "configure this repo", the other
    // means "you configured it but chose no binding".
    await upsertCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      templateId: null,
      enabled: true,
      facts: { ...facts, hasBinding: false },
      dependencyRevision: 1,
      now: NOW,
    })
    const result = await ask(db)
    expect(!result.ok && result.message).toContain('no binding selected')
  })

  test('a binding with the slot unmapped names the slot', async () => {
    await bindWith(JSON.stringify({ fixer: agentId }))
    const result = await ask(db)
    expect(!result.ok && result.message).toContain("'reviewer' slot")
    expect(!result.ok && result.message).toContain('bind one')
  })

  test('an empty slot value counts as unmapped, not as an agent id', async () => {
    await bindWith(JSON.stringify({ reviewer: '' }))
    expect(!(await ask(db)).ok).toBe(true)
  })

  test('a slot pointing at a DELETED agent is a dangling reference, not a blank', async () => {
    // The distinction that matters most: this is repaired, not filled in, and a
    // message saying "none bound" would have someone looking at an empty field
    // that is not empty.
    await bindWith(JSON.stringify({ reviewer: 'agent-that-never-existed' }))
    const result = await ask(db)
    expect(!result.ok && result.message).toContain('no longer exists')
    expect(!result.ok && result.message).toContain('agent-that-never-existed')
    expect(!result.ok && result.message).toContain('rebind')
  })

  test('an unreadable slot mapping refuses rather than throwing', async () => {
    await bindWith('{not json')
    const result = await ask(db)
    expect(!result.ok && result.message).toContain('not readable')
  })

  test('a deleted binding is distinguished from an unmapped slot', async () => {
    await bindWith(JSON.stringify({ reviewer: agentId }))
    await db.delete(capabilityTemplates)
    const result = await ask(db)
    expect(!result.ok && result.message).toContain('no longer exists')
  })

  test('every refusal says what to do, not just what is wrong', async () => {
    // The whole reason these are four messages. A refusal that names a state
    // without naming an action is a dead end for whoever reads it.
    const cases: string[] = []
    cases.push(((await ask(db)) as { message: string }).message)
    await bindWith(JSON.stringify({ fixer: agentId }))
    cases.push(((await ask(db)) as { message: string }).message)
    for (const message of cases) {
      expect(message.length).toBeGreaterThan(40)
      expect(message).toMatch(/configur|bind|rebind/)
    }
  })
})
