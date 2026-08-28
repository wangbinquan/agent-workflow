// RFC-282 B2 — the resolution layer lives in services/execution/ and all six
// scheduler entries go through it.
//
// §7-7 (registered behavior change): the RFC-170 skill-quarantine gate and
// the RFC-223 canonical-path gate used to THROW out of the resolver — runScope
// turned that into a TASK-level failure, unlike every sibling fence
// (mcp-not-found / plugin-disabled…) which fails just the node. Both now
// return `{kind:'failed'}`. The first test here was written against the old
// throw (red under the new code in the throw direction) and flipped with the
// change — the typed shape IS the new contract.
//
// 设计门 P2-9 regression lock: a zero-resource synthetic agent (commit-push /
// merge) must ALWAYS resolve ok — B2's wiring made those two entries go
// through the resolver, so a new failure mode here would break every task's
// commit step.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import { resolveInjection } from '../src/services/execution/resolveInjection'
import { buildCommitAgent } from '../src/services/commitPush'
import { buildMergeAgent } from '../src/services/mergeAgent'
import {
  activateBootReverifyForTest,
  markSkillBootVerified,
  resetSkillBootVerifyForTest,
} from '../src/services/skillBootVerify'
import { skillFilesRel } from '../src/services/skillIdentityPaths'
import { createLogger } from '../src/util/log'
import type { Agent } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')
const log = createLogger('rfc282-b2')

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + ulid(),
    name: 'root',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Agent
}

describe('RFC-282 B2 — §7-7 skill gates are typed failures (node-level attribution)', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetSkillBootVerifyForTest()
  })

  test('quarantined managed skill → {kind:failed, skill-quarantined} (was a THROW → task-level)', async () => {
    const skillId = ulid()
    await db.insert(skills).values({
      id: skillId,
      name: 'quarantined-skill',
      description: '',
      managedPath: skillFilesRel(skillId),
      contentVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    // Boot-reverify active with an EMPTY verified set ⇒ this skill is
    // quarantined for the boot epoch (RFC-170 T9).
    activateBootReverifyForTest()
    const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
    const result = await resolveInjection(db, agent, { appHome: '/tmp/aw', log })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.message).toBe('skill-quarantined')
    expect(result.summary).toContain('quarantined-skill')
  })

  test('non-canonical managed path → {kind:failed, skill-path-not-canonical} (was a THROW)', async () => {
    const skillId = ulid()
    await db.insert(skills).values({
      id: skillId,
      name: 'legacy-path-skill',
      description: '',
      managedPath: `skills/legacy-name/files`, // pre-identity-migration shape
      contentVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    activateBootReverifyForTest()
    markSkillBootVerified(skillId)
    const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
    const result = await resolveInjection(db, agent, { appHome: '/tmp/aw', log })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.message).toBe('skill-path-not-canonical')
  })

  test('the resolver no longer throws domain errors for these gates (typed-only surface)', async () => {
    const skillId = ulid()
    await db.insert(skills).values({
      id: skillId,
      name: 'q2',
      description: '',
      managedPath: skillFilesRel(skillId),
      contentVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    activateBootReverifyForTest()
    const agent = mkAgent({ skills: [{ kind: 'managed', skillId }] })
    // A throw here would reject; typed failure resolves.
    await expect(resolveInjection(db, agent, { appHome: '/tmp/aw', log })).resolves.toMatchObject({
      kind: 'failed',
    })
  })
})

describe('RFC-282 B2 — zero-resource synthetic agents always resolve ok (P2-9 lock)', () => {
  test('commit-push and merge synthetic agents → ok with empty faces', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    for (const agent of [buildCommitAgent(), buildMergeAgent()]) {
      const result = await resolveInjection(db, agent, { appHome: '/tmp/aw', log })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('unreachable')
      expect(result.spec.dependents).toEqual([])
      expect(result.spec.skills).toEqual([])
      expect(result.spec.mcps).toEqual([])
      expect(result.spec.plugins).toEqual([])
      expect(result.spec.agent).toBe(agent)
    }
  })
})

describe('RFC-282 B2 — all six TaskExecution entries go through the one resolver', () => {
  test('TaskExecution has six resolveInjection call sites and zero hand-written empty-array bypasses', () => {
    const text = [
      readFileSync(resolve(SRC, 'modules/task-execution/composition/wrapperMechanics.ts'), 'utf8'),
      readFileSync(resolve(SRC, 'modules/task-execution/composition/nodeMechanics.ts'), 'utf8'),
    ].join('\n')
    expect(text.split('await resolveInjection(').length - 1).toBe(6)
    // the commit-push / merge bypass shape (four hand-written empty arrays)
    expect(text).not.toContain('skills: [],\n          dependents: [],')
    expect(text).not.toContain('skills: [],\n      dependents: [],')
    // the resolver itself no longer lives in either execution composition file
    expect(text).not.toContain('function prepareNodeRunInjection')
    expect(text).not.toContain('async function resolveSkills')
  })

  test('the writeSem call sites (commit/merge) thread the scope signal (§9-5)', () => {
    const sites = [
      {
        text: readFileSync(
          resolve(SRC, 'modules/task-execution/composition/wrapperMechanics.ts'),
          'utf8',
        ),
        marker: 'commit-push injection resolve failed',
      },
      {
        text: readFileSync(
          resolve(SRC, 'modules/task-execution/composition/nodeMechanics.ts'),
          'utf8',
        ),
        marker: 'merge injection resolve failed',
      },
    ]
    for (const { text, marker } of sites) {
      const idx = text.indexOf(marker)
      expect(idx).toBeGreaterThan(0)
      const before = text.slice(Math.max(0, idx - 700), idx)
      expect(before).toContain('signal: state.opts.signal')
    }
  })
})
