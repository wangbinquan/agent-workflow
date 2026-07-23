// RFC-223 PR-6 — regression locks for the runtime-independent managed
// injection identity guard.
//
// Once global name uniqueness is relaxed, two distinct ids may carry the same
// display name. OpenCode / Claude Code still use that name as their injected
// registry key, so the shared hydration boundary must fail before either
// runtime stages files or builds a subprocess. Project skills are deliberately
// outside this managed set; disabled MCPs are not injected and must not block.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Agent, AgentSkillRef } from '@agent-workflow/shared'
import { sql } from 'drizzle-orm'
import { resolve } from 'node:path'
import type { Logger } from '@/util/log'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, skills } from '../src/db/schema'
import { createAgent, getAgentById } from '../src/services/agent'
import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '../src/services/runtime/injectionIdentity'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import { prepareNodeRunInjection } from '../src/services/scheduler'
import { skillFilesRel } from '../src/services/skillIdentityPaths'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOG,
}

async function seedAgent(
  db: DbClient,
  name: string,
  opts: {
    dependsOn?: string[]
    runtime?: string
    skills?: AgentSkillRef[]
    mcp?: string[]
    ownerUserId?: string
  } = {},
): Promise<Agent> {
  return createAgent(
    db,
    {
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
      permission: {},
      skills: opts.skills ?? [],
      dependsOn: opts.dependsOn ?? [],
      mcp: opts.mcp ?? [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    },
    opts.ownerUserId === undefined ? undefined : { ownerUserId: opts.ownerUserId },
  )
}

async function seedManagedSkill(
  db: DbClient,
  id: string,
  name: string,
  ownerUserId: string,
): Promise<void> {
  await db.insert(skills).values({
    id,
    name,
    description: '',
    sourceKind: 'managed',
    managedPath: skillFilesRel(id),
    ownerUserId,
  })
}

async function seedMcp(
  db: DbClient,
  id: string,
  name: string,
  enabled: boolean,
  ownerUserId: string,
): Promise<void> {
  await db.insert(mcps).values({
    id,
    name,
    description: '',
    type: 'local',
    config: JSON.stringify({ command: ['echo'] }),
    enabled,
    ownerUserId,
  })
}

async function prepareRoot(db: DbClient, rootId: string) {
  const root = await getAgentById(db, rootId)
  if (root === null) throw new Error(`missing root id ${rootId}`)
  return prepareNodeRunInjection(db, '/tmp/aw-rfc223-pr6', root, NOOP_LOG)
}

function expectDuplicateFailure(
  result: Awaited<ReturnType<typeof prepareRoot>>,
  kind: 'agent' | 'managed-skill' | 'mcp',
  name: string,
): void {
  expect(result.kind).toBe('failed')
  if (result.kind !== 'failed') throw new Error('expected failed')
  expect(result.message).toStartWith('duplicate-name-in-closure:')
  expect(result.message).toContain(`${kind} name '${name}'`)
}

describe('RFC-223 PR-6 managed injection identity guard', () => {
  test('finds distinct ids sharing a name within each managed namespace', () => {
    expect(
      findManagedInjectionNameConflict({
        agents: [
          { id: 'agent-a', name: 'shared' },
          { id: 'agent-b', name: 'shared' },
        ],
        managedSkills: [],
        mcps: [],
      }),
    ).toEqual({
      kind: 'agent',
      name: 'shared',
      firstId: 'agent-a',
      secondId: 'agent-b',
    })

    expect(
      findManagedInjectionNameConflict({
        agents: [],
        managedSkills: [
          { id: 'skill-a', name: 'lint' },
          { id: 'skill-b', name: 'lint' },
        ],
        mcps: [],
      })?.kind,
    ).toBe('managed-skill')

    expect(
      findManagedInjectionNameConflict({
        agents: [],
        managedSkills: [],
        mcps: [
          { id: 'mcp-a', name: 'docs', enabled: true },
          { id: 'mcp-b', name: 'docs', enabled: true },
        ],
      })?.kind,
    ).toBe('mcp')
  })

  test('allows same-id repeats, cross-kind equal labels, and disabled MCP duplicates', () => {
    expect(
      findManagedInjectionNameConflict({
        agents: [
          { id: 'agent-a', name: 'shared' },
          { id: 'agent-a', name: 'shared' },
        ],
        managedSkills: [{ id: 'skill-a', name: 'shared' }],
        mcps: [
          { id: 'mcp-a', name: 'shared', enabled: true },
          { id: 'mcp-b', name: 'shared', enabled: false },
        ],
      }),
    ).toBeNull()
  })

  test('formatted failure is actionable and keeps the stable error code', () => {
    const conflict = findManagedInjectionNameConflict({
      agents: [
        { id: 'agent-a', name: 'auditor' },
        { id: 'agent-b', name: 'auditor' },
      ],
      managedSkills: [],
      mcps: [],
    })
    if (conflict === null) throw new Error('expected conflict')
    const message = formatManagedInjectionNameConflict(conflict)
    expect(message).toStartWith('duplicate-name-in-closure:')
    expect(message).toContain("agent name 'auditor'")
    expect(message).toContain("'agent-a'")
    expect(message).toContain("'agent-b'")
  })
})

describe('RFC-223 PR-6 scheduler wiring is shared by both runtimes', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
  })

  test('opencode and Claude Code roots both fail before spawn on duplicate closure names', async () => {
    const depOne = await seedAgent(db, 'dep-one', { ownerUserId: 'owner-a' })
    const depTwo = await seedAgent(db, 'dep-two', { ownerUserId: 'owner-b' })
    const roots = [
      await seedAgent(db, 'root-opencode', {
        dependsOn: [depOne.id, depTwo.id],
        runtime: 'opencode',
      }),
      await seedAgent(db, 'root-claude', {
        dependsOn: [depOne.id, depTwo.id],
        runtime: 'claude-code',
      }),
    ]

    // Simulate the post-PR-8 schema while PR-6 still lands safely beforehand:
    // relax the current global index, then create two different ids named
    // `dep-one`. The roots already persist their closure refs by id.
    await db.run(sql`DROP INDEX IF EXISTS agents_name_unique`)
    await db.run(sql`UPDATE agents SET name = 'dep-one' WHERE id = ${depTwo.id}`)

    for (const root of roots) {
      expectDuplicateFailure(await prepareRoot(db, root.id), 'agent', 'dep-one')
    }
  })

  test('managed skill collisions fail in both runtimes, while a project skill with the same label is allowed', async () => {
    await seedManagedSkill(db, 'skill-one-id', 'skill-one', 'owner-a')
    await seedManagedSkill(db, 'skill-two-id', 'skill-two', 'owner-b')
    const duplicateRefs: AgentSkillRef[] = [
      { kind: 'managed', skillId: 'skill-one-id' },
      { kind: 'managed', skillId: 'skill-two-id' },
    ]
    const roots = [
      await seedAgent(db, 'skill-root-opencode', {
        runtime: 'opencode',
        skills: duplicateRefs,
      }),
      await seedAgent(db, 'skill-root-claude', {
        runtime: 'claude-code',
        skills: duplicateRefs,
      }),
    ]

    // The pre-PR-8 schema still has legacy name-keyed skill_versions FKs.
    // Disable their enforcement in this synthetic post-PR-8 fixture before
    // removing the global name index; PR-8 migrates those FKs to ids first.
    await db.run(sql`PRAGMA foreign_keys = OFF`)
    await db.run(sql`DROP INDEX IF EXISTS skills_name_unique`)
    await db.run(sql`UPDATE skills SET name = 'skill-one' WHERE id = 'skill-two-id'`)

    for (const root of roots) {
      expectDuplicateFailure(await prepareRoot(db, root.id), 'managed-skill', 'skill-one')
    }

    await seedManagedSkill(db, 'project-boundary-id', 'shared-label', 'owner-c')
    for (const [rootName, runtime] of [
      ['project-root-opencode', 'opencode'],
      ['project-root-claude', 'claude-code'],
    ] as const) {
      const root = await seedAgent(db, rootName, {
        runtime,
        skills: [
          { kind: 'managed', skillId: 'project-boundary-id' },
          { kind: 'project', name: 'shared-label' },
        ],
      })
      const result = await prepareRoot(db, root.id)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected ok')
      expect(result.resolvedSkills.map(({ name, sourceKind }) => ({ name, sourceKind }))).toEqual([
        { name: 'shared-label', sourceKind: 'managed' },
        { name: 'shared-label', sourceKind: 'project' },
      ])
    }
  })

  test('enabled MCP collisions fail in both runtimes, while disabled duplicates are ignored', async () => {
    await seedMcp(db, 'mcp-one-id', 'mcp-one', true, 'owner-a')
    await seedMcp(db, 'mcp-two-id', 'mcp-two', true, 'owner-b')
    await seedMcp(db, 'mcp-disabled-id', 'mcp-disabled', false, 'owner-c')
    const enabledRefs = ['mcp-one-id', 'mcp-two-id']
    const disabledBoundaryRefs = ['mcp-one-id', 'mcp-disabled-id']

    const enabledRoots: Agent[] = []
    const disabledRoots: Agent[] = []
    for (const [rootName, runtime, refs, bucket] of [
      ['mcp-root-opencode', 'opencode', enabledRefs, enabledRoots],
      ['mcp-root-claude', 'claude-code', enabledRefs, enabledRoots],
      ['disabled-root-opencode', 'opencode', disabledBoundaryRefs, disabledRoots],
      ['disabled-root-claude', 'claude-code', disabledBoundaryRefs, disabledRoots],
    ] as const) {
      bucket.push(await seedAgent(db, rootName, { runtime, mcp: refs }))
    }

    await db.run(sql`DROP INDEX IF EXISTS mcps_name_unique`)
    await db.run(sql`UPDATE mcps SET name = 'mcp-one' WHERE id = 'mcp-two-id'`)
    await db.run(sql`UPDATE mcps SET name = 'mcp-one' WHERE id = 'mcp-disabled-id'`)

    for (const root of enabledRoots) {
      expectDuplicateFailure(await prepareRoot(db, root.id), 'mcp', 'mcp-one')
    }
    for (const root of disabledRoots) {
      const result = await prepareRoot(db, root.id)
      expect(result.kind).toBe('ok')
    }
  })
})
