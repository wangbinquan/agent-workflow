// RFC-166 — leader/peer roster capability-card injection (design §3 + §11).
//
// Locks:
//  1. renderRosterBlock embeds an AGENT member's capability card (indented
//     under its bullet) when agentCards holds an entry for its memberId — the
//     leader coordinates against real description/inputs/outputs, not just the
//     group roleDesc, which is preserved on the header line.
//  2. HUMAN members NEVER get a card, even if agentCards erroneously holds an
//     entry keyed by the human's memberId (prompt-isolation double-lock §11 —
//     a human's userId must never leak into a prompt).
//  3. Without agentCards the roster is byte-identical to RFC-164 (backward compat).
//  4. buildRosterAgentCards: one card per agent member (getAgent +
//     renderAgentCapabilityCard), skips humans, yields no card for a dangling
//     agentName, dedupes repeated agentNames, and never contains a user id.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  renderAgentCapabilityCard,
  type CreateAgent,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { renderRosterBlock } from '../src/services/workgroupContext'
import { buildRosterAgentCards } from '../src/services/workgroupRunner'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: 'be kind',
    goal: 'fix payments',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'coder-a',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
      {
        id: 'm-pm',
        memberType: 'human',
        agentName: null,
        userId: 'u-pm-SECRET',
        displayName: 'pm',
        roleDesc: '把关',
      },
    ],
    ...overrides,
  }
}

function agentPayload(name: string, over: Partial<CreateAgent> = {}): CreateAgent {
  return {
    name,
    description: `${name} does work`,
    outputs: ['patch'],
    outputKinds: { patch: 'string' },
    inputs: [{ name: 'diff', kind: 'string', required: true }],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `You are ${name}.`,
    ...over,
  } as CreateAgent
}

describe('renderRosterBlock — RFC-166 capability card injection (pure)', () => {
  test('embeds an agent member card (description/inputs/outputs) + keeps roleDesc', () => {
    const card = renderAgentCapabilityCard(
      {
        name: 'coder-a',
        description: 'writes the patch',
        inputs: [{ name: 'diff', kind: 'string', required: true }],
        outputs: ['patch'],
        outputKinds: { patch: 'string' },
        role: 'normal',
        bodyMd: 'You implement features.',
      },
      { promptBudget: 240 },
    )
    const block = renderRosterBlock(cfg(), {
      excludeMemberId: 'm-lead',
      agentCards: new Map([['m-coder', card]]),
    })
    expect(block).toContain('@coder') // roster row = displayName
    expect(block).toContain('实现') // group roleDesc preserved on the header line
    expect(block).toContain('### coder-a') // card = agent's real name
    expect(block).toContain('writes the patch')
    expect(block).toContain('- inputs: diff (string, required)')
    expect(block).toContain('- outputs: patch (string)')
    // card lines are indented two spaces under the member bullet
    expect(block).toContain('\n  ### coder-a')
  })

  test('human member never gets a card even if agentCards holds one for its id', () => {
    // Prompt-isolation double-lock: renderRosterBlock skips the card lookup for
    // human members, so even a (wrongly) keyed entry is inert.
    const leakyCard = 'CARD-MARKER-SHOULD-NOT-APPEAR'
    const block = renderRosterBlock(cfg(), {
      agentCards: new Map([['m-pm', leakyCard]]),
    })
    expect(block).toContain('@pm (human)')
    expect(block).not.toContain('CARD-MARKER-SHOULD-NOT-APPEAR')
    expect(block).not.toContain('u-pm-SECRET')
  })

  test('no agentCards → byte-identical to RFC-164 roster (backward compat)', () => {
    const withEmpty = renderRosterBlock(cfg(), { agentCards: new Map() })
    const without = renderRosterBlock(cfg())
    expect(withEmpty).toBe(without)
    // classic one-line-per-member shape, no cards
    expect(without).toBe(
      [
        '## Workgroup roster',
        '',
        '- @planner (agent) — 协调',
        '- @coder (agent) — 实现',
        '- @pm (human) — 把关',
      ].join('\n'),
    )
  })
})

describe('buildRosterAgentCards — RFC-166 preload (DB)', () => {
  async function seed(db: DbClient) {
    await createAgent(db, agentPayload('planner', { description: 'plans the work' }))
    await createAgent(db, agentPayload('coder-a', { description: 'writes the patch' }))
  }

  test('one card per agent member; human skipped; content present; no user id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const cards = await buildRosterAgentCards(db, cfg())
    expect(cards.has('m-lead')).toBe(true)
    expect(cards.has('m-coder')).toBe(true)
    expect(cards.has('m-pm')).toBe(false) // human never carries a card
    expect(cards.get('m-coder')).toContain('writes the patch')
    expect(cards.get('m-coder')).toContain('- outputs: patch (string)')
    // prompt isolation: no user id anywhere in the rendered cards
    for (const card of cards.values()) {
      expect(card).not.toContain('u-pm-SECRET')
      expect(card).not.toContain('ownerUserId')
    }
  })

  test('dangling agentName (deleted agent) yields no card', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const c = cfg({
      members: [
        {
          id: 'm-x',
          memberType: 'agent',
          agentName: 'ghost',
          userId: null,
          displayName: 'x',
          roleDesc: '',
        },
      ],
      leaderMemberId: 'm-x',
    })
    const cards = await buildRosterAgentCards(db, c)
    expect(cards.has('m-x')).toBe(false)
  })

  test('repeated agentName is de-duped (one DB read, both members carded)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)
    const c = cfg({
      members: [
        {
          id: 'm-a',
          memberType: 'agent',
          agentName: 'coder-a',
          userId: null,
          displayName: 'a',
          roleDesc: '',
        },
        {
          id: 'm-b',
          memberType: 'agent',
          agentName: 'coder-a',
          userId: null,
          displayName: 'b',
          roleDesc: '',
        },
      ],
      leaderMemberId: 'm-a',
    })
    const cards = await buildRosterAgentCards(db, c)
    expect(cards.get('m-a')).toBe(cards.get('m-b'))
    expect(cards.get('m-a')).toContain('writes the patch')
  })
})
