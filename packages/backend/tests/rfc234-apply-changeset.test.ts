// RFC-234 §9 (T6) — apply pipeline behavior locks:
//  happy multi-type bundle (skill+mcp+agent+workflow+workgroup+plugin) lands
//  atomically with correct cross-wiring/provenance/epoch close; duplicate
//  clientMutationId replays the receipt with zero side effects (P0-6);
//  a stale fence or an in-tx crash yields ZERO visible resources with staged
//  side effects compensated (P0-5); a post-commit crash converges forward.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  ROLE_PERMISSIONS,
  WORKFLOW_SCHEMA_VERSION,
  canonicalIntentJson,
  parseIntentChangeset,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  mcps,
  resourceGrants,
  plugins,
  skills,
  users,
  workflows,
  workgroups,
} from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import {
  applyIntentChangeset,
  convergeIntentApplyJournal,
  type ApplyIntentDeps,
} from '../src/services/intent/applyChangeset'
import { createIntentSession } from '../src/services/intent/session'
import type { IntentContextManifest } from '../src/services/intent/manifest'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_apply_0000000000'
const APPROVER = 'user_approver_apply_000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

async function seedUser(id: string, username: string): Promise<void> {
  await db.insert(users).values({
    id,
    username,
    displayName: username,
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
}

async function seedAgent(name: string): Promise<{ id: string; updatedAt: number }> {
  const id = ulid()
  const now = Date.now()
  await db.insert(agents).values({
    id,
    name,
    description: 'existing',
    outputs: JSON.stringify(['out']),
    ownerUserId: OWNER,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
  } as typeof agents.$inferInsert)
  return { id, updatedAt: now }
}

/** Install the confirmed draft + manifest into the session exactly like the
 *  turn engine does (canonical json + sha256 hash + matching epoch). */
function installDraft(
  sessionId: string,
  changeset: unknown,
  manifest: IntentContextManifest,
): { draftRevision: number; draftHash: string } {
  const parsed = parseIntentChangeset(JSON.stringify(changeset))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const draftId = ulid()
  db.insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftRevision: 1, draftHash }
}

function deps(over: Partial<ApplyIntentDeps> = {}): ApplyIntentDeps {
  return { db, appHome, actor, ...over }
}

function filePluginFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-intent-plugin-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }),
  )
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
  return `file://${dir}`
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-apply-'))
  mkdirSync(join(appHome, 'skills'), { recursive: true })
  await seedUser(OWNER, 'owner')
  await seedUser(APPROVER, 'approver')
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

function fullBundle(existingAgentId: string, pluginSpec: string): unknown {
  return {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'skill',
        tempRef: '$new:checklist',
        payload: {
          name: 'review-checklist',
          description: 'how to review',
          bodyMd: '# Checklist',
          files: [{ path: 'ref/extra.md', content: 'extra' }],
        },
      },
      {
        opId: 'op-2',
        action: 'create',
        resourceType: 'mcp',
        tempRef: '$new:gh',
        payload: {
          type: 'local',
          name: 'gh-mcp',
          description: 'github',
          config: { command: ['npx'], env: { TOKEN: '‹secret›' } },
        },
      },
      {
        opId: 'op-3',
        action: 'create',
        resourceType: 'plugin',
        tempRef: '$new:lint',
        payload: { name: 'lint-plugin', spec: pluginSpec, description: 'lints' },
      },
      {
        opId: 'op-4',
        action: 'create',
        resourceType: 'agent',
        tempRef: '$new:auditor',
        payload: {
          name: 'auditor',
          description: 'audits diffs',
          outputs: ['findings'],
          skills: ['$new:checklist'],
          mcp: ['$new:gh'],
          plugins: ['$new:lint'],
          dependsOn: [],
          bodyMd: 'You audit.',
        },
      },
      {
        opId: 'op-5',
        action: 'create',
        resourceType: 'workflow',
        tempRef: '$new:flow',
        payload: {
          name: 'audit-flow',
          description: '',
          definition: {
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [
              { id: 'n1', kind: 'agent-single', agentRef: '$new:auditor', promptTemplate: 'go' },
              { id: 'n2', kind: 'agent-single', agentRef: `res#agent#1`, promptTemplate: 'go' },
            ],
            edges: [],
          },
        },
      },
      {
        opId: 'op-6',
        action: 'create',
        resourceType: 'workgroup',
        tempRef: '$new:squad',
        payload: {
          name: 'audit-squad',
          description: '',
          instructions: 'work',
          mode: 'leader_worker',
          leaderDisplayName: 'lead',
          members: [
            { memberType: 'agent', agentRef: '$new:auditor', displayName: 'lead', roleDesc: '' },
            { memberType: 'human', displayName: 'approver', roleDesc: 'approves' },
          ],
        },
      },
    ],
  }
  void existingAgentId
}

function manifestWithAgent(existingAgentId: string, updatedAt: number): IntentContextManifest {
  return [
    {
      handle: 'res#agent#1',
      resourceType: 'agent',
      resourceId: existingAgentId,
      root: true,
      detail: true,
      fence: { kind: 'agent', updatedAt, aclRevision: 0 },
      dumpHash: 'x',
    },
  ]
}

const happyDecisions = [
  { opId: 'op-2', slots: [{ slotId: 'secret:op-2:/config/env/TOKEN', value: 'real-token-value' }] },
  { opId: 'op-6', slots: [{ slotId: 'human:op-6:approver', value: APPROVER }] },
]

describe('applyIntentChangeset', () => {
  test('happy bundle: six resources land atomically with wiring + provenance + epoch close', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'build audit pipeline' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: happyDecisions,
    })
    expect(receipt.applied.length).toBe(6)
    expect(receipt.commitSeq).toBe(1)

    const byOp = new Map(receipt.applied.map((a) => [a.opId, a]))
    const skillRow = db
      .select()
      .from(skills)
      .where(eq(skills.id, byOp.get('op-1')?.resourceId ?? ''))
      .get()
    expect(skillRow?.reservationState).toBe('ready')
    expect(skillRow?.ownerUserId).toBe(OWNER)
    expect(skillRow?.visibility).toBe('private')
    expect(
      readFileSync(join(appHome, 'skills', skillRow?.id ?? '', 'files', 'SKILL.md'), 'utf8'),
    ).toContain('# Checklist')

    const mcpRow = db
      .select()
      .from(mcps)
      .where(eq(mcps.id, byOp.get('op-2')?.resourceId ?? ''))
      .get()
    expect(JSON.parse(mcpRow?.config ?? '{}').env.TOKEN).toBe('real-token-value')

    const pluginRow = db
      .select()
      .from(plugins)
      .where(eq(plugins.id, byOp.get('op-3')?.resourceId ?? ''))
      .get()
    expect(pluginRow?.sourceKind).toBe('file')

    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.id, byOp.get('op-4')?.resourceId ?? ''))
      .get()
    expect(JSON.parse(agentRow?.mcp ?? '[]')).toEqual([byOp.get('op-2')?.resourceId])
    expect(JSON.parse(agentRow?.plugins ?? '[]')).toEqual([byOp.get('op-3')?.resourceId])
    expect(JSON.parse(agentRow?.skills ?? '[]')).toEqual([
      { kind: 'managed', skillId: byOp.get('op-1')?.resourceId },
    ])

    const wfRow = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, byOp.get('op-5')?.resourceId ?? ''))
      .get()
    const def = JSON.parse(wfRow?.definition ?? '{}') as { nodes: Array<Record<string, unknown>> }
    expect(def.nodes[0]?.agentId).toBe(byOp.get('op-4')?.resourceId)
    expect(def.nodes[1]?.agentId).toBe(existing.id)

    const wgRow = db
      .select()
      .from(workgroups)
      .where(eq(workgroups.id, byOp.get('op-6')?.resourceId ?? ''))
      .get()
    expect(wgRow?.leaderMemberId).not.toBeNull()

    const provenance = await db.select().from(intentProvenance)
    expect(provenance.length).toBe(6)
    expect(new Set(provenance.map((p) => p.commitId)).size).toBe(1)

    const freshSession = db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, session.id))
      .get()
    expect(freshSession?.commitSeq).toBe(1)
    expect(freshSession?.contextRevision).toBe(1)
    expect(freshSession?.currentDraftId).toBeNull()

    const journal = db.select().from(intentApplyJournal).get()
    expect(journal?.state).toBe('committed')
  })

  test('RFC-302 create persists confirmed draft geometry exactly and replay never re-layouts', async () => {
    const existing = await seedAgent('geometry-agent')
    const { session } = await createIntentSession(db, actor, { message: 'keep reviewed geometry' })
    const position = { x: 1_234, y: -321 }
    const size = { width: 333, height: 211 }
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:geometry-flow',
            payload: {
              name: 'Geometry flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [
                  {
                    id: 'worker',
                    kind: 'agent-single',
                    agentRef: 'res#agent#1',
                    promptTemplate: 'go',
                    position,
                    size,
                  },
                ],
                edges: [],
              },
            },
          },
        ],
      },
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    const clientMutationId = ulid()
    const first = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId,
      ...draft,
      decisions: [],
    })
    const workflowId = first.applied[0]?.resourceId ?? ''
    const readGeometry = () => {
      const row = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
      const definition = JSON.parse(row?.definition ?? '{}') as {
        nodes: Array<{ position?: unknown; size?: unknown }>
      }
      return { position: definition.nodes[0]?.position, size: definition.nodes[0]?.size }
    }
    expect(readGeometry()).toEqual({ position, size })

    const replay = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId,
      ...draft,
      decisions: [],
    })
    expect(replay).toEqual(first)
    expect(readGeometry()).toEqual({ position, size })
  })

  test('RFC-302 legacy draft without geometry applies verbatim and is never lazily upgraded', async () => {
    const existing = await seedAgent('legacy-geometry-agent')
    const { session } = await createIntentSession(db, actor, { message: 'apply an old draft' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:legacy-geometry-flow',
            payload: {
              name: 'Legacy geometry flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [
                  {
                    id: 'worker',
                    kind: 'agent-single',
                    agentRef: 'res#agent#1',
                    promptTemplate: 'go',
                  },
                ],
                edges: [],
              },
            },
          },
        ],
      },
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    const result = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })
    const workflowId = result.applied[0]?.resourceId ?? ''
    const row = db.select().from(workflows).where(eq(workflows.id, workflowId)).get()
    const definition = JSON.parse(row?.definition ?? '{}') as {
      nodes: Array<Record<string, unknown>>
    }
    expect(definition.nodes[0]).not.toHaveProperty('position')
    expect(definition.nodes[0]).not.toHaveProperty('size')
  })

  test('duplicate clientMutationId replays the receipt with zero side effects', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    const mutationId = ulid()
    const first = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: mutationId,
      ...draft,
      decisions: happyDecisions,
    })
    const second = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: mutationId,
      ...draft,
      decisions: happyDecisions,
    })
    expect(second).toEqual(first)
    expect((await db.select().from(agents)).length).toBe(2) // existing + one created
    expect((await db.select().from(intentApplyJournal)).length).toBe(1)
  })

  test('stale agent fence: bundle lands NOTHING and staged skill is compensated', async () => {
    const existing = await seedAgent('fence-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const cs = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'skill',
          tempRef: '$new:sk',
          payload: { name: 'sk', description: '', bodyMd: 'b', files: [] },
        },
        {
          opId: 'op-2',
          action: 'update',
          resourceType: 'agent',
          target: 'res#agent#1',
          payload: {
            name: 'fence-agent',
            description: 'tuned',
            outputs: ['out'],
            bodyMd: 'new body',
          },
        },
      ],
    }
    // Manifest fence deliberately stale (updatedAt - 1).
    const draft = installDraft(
      session.id,
      cs,
      manifestWithAgent(existing.id, existing.updatedAt - 1),
    )
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      }),
    ).rejects.toThrow()
    expect((await db.select().from(skills)).length).toBe(0)
    const agentRow = db.select().from(agents).where(eq(agents.id, existing.id)).get()
    expect(agentRow?.description).toBe('existing')
    expect(db.select().from(intentApplyJournal).get()?.state).toBe('failed')
  })

  test('in-tx crash rolls everything back and compensates prestaged effects', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    await expect(
      applyIntentChangeset(
        deps({
          faults: {
            inTxAfterOps: () => {
              throw new Error('boom-in-tx')
            },
          },
        }),
        { sessionId: session.id, clientMutationId: ulid(), ...draft, decisions: happyDecisions },
      ),
    ).rejects.toThrow(/boom-in-tx/)
    expect((await db.select().from(skills)).length).toBe(0)
    expect((await db.select().from(mcps)).length).toBe(0)
    expect((await db.select().from(plugins)).length).toBe(0)
    expect((await db.select().from(workflows)).length).toBe(0)
    expect((await db.select().from(workgroups)).length).toBe(0)
    expect((await db.select().from(agents)).length).toBe(1) // only the seed
    expect(db.select().from(intentApplyJournal).get()?.state).toBe('failed')
    expect((await db.select().from(intentProvenance)).length).toBe(0)
  })

  test('post-commit crash: resources visible, convergence replays roll-forward', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    await expect(
      applyIntentChangeset(
        deps({
          faults: {
            afterTxBeforeRollForward: () => {
              throw new Error('boom-post-commit')
            },
          },
        }),
        { sessionId: session.id, clientMutationId: ulid(), ...draft, decisions: happyDecisions },
      ),
    ).rejects.toThrow(/boom-post-commit/)
    // Committed: the bundle IS visible even though roll-forward crashed…
    expect(db.select().from(intentApplyJournal).get()?.state).toBe('committed')
    expect((await db.select().from(skills)).length).toBe(1)
    // …and convergence replays the idempotent tail.
    const converged = await convergeIntentApplyJournal(db, appHome)
    expect(converged.rolledForward).toBe(1)
    expect(converged.failed).toBe(0)
    // Second convergence is a no-op replay, not an error.
    const again = await convergeIntentApplyJournal(db, appHome)
    expect(again.rolledForward).toBe(1)
  })

  test('baseline-stale claim: epoch moved → rejected before any journal claim side effect', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    db.update(intentSessions)
      .set({ contextRevision: 5 })
      .where(eq(intentSessions.id, session.id))
      .run()
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: happyDecisions,
      }),
    ).rejects.toMatchObject({ code: 'intent-baseline-stale' })
    expect((await db.select().from(intentApplyJournal)).length).toBe(0)
    // Wrong draft hash likewise refuses without a claim.
    db.update(intentSessions)
      .set({ contextRevision: 0 })
      .where(eq(intentSessions.id, session.id))
      .run()
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        draftRevision: draft.draftRevision,
        draftHash: 'sha256:' + '0'.repeat(64),
        decisions: happyDecisions,
      }),
    ).rejects.toMatchObject({ code: 'intent-draft-hash-mismatch' })
    expect((await db.select().from(intentApplyJournal)).length).toBe(0)
  })

  // Codex impl-gate P0-1 — foreign-owner update MUST be copy-only. A mounted
  // public agent owned by another user: 'modify' (the default) is refused with
  // zero writes; an explicit 'copy' lands a NEW resource owned by the actor
  // and never touches the original row.
  test('foreign-owner update: modify forbidden, copy lands a new resource', async () => {
    const foreignId = ulid()
    const now = Date.now()
    await db.insert(agents).values({
      id: foreignId,
      name: 'foreign-agent',
      description: 'someone else owns this',
      outputs: JSON.stringify(['out']),
      ownerUserId: APPROVER,
      visibility: 'public',
      createdAt: now,
      updatedAt: now,
    } as typeof agents.$inferInsert)
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'update',
          resourceType: 'agent',
          target: 'res#agent#1',
          payload: {
            name: 'foreign-agent',
            description: 'hijacked',
            outputs: ['out'],
            bodyMd: 'mine now',
          },
        },
      ],
    }
    const draft = installDraft(session.id, changeset, [
      {
        handle: 'res#agent#1',
        resourceType: 'agent',
        resourceId: foreignId,
        root: true,
        detail: true,
        fence: { kind: 'agent', updatedAt: now, aclRevision: 0 },
        dumpHash: 'x',
      },
    ])
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      }),
    ).rejects.toMatchObject({ code: 'intent-foreign-modify-forbidden' })
    const untouched = db.select().from(agents).where(eq(agents.id, foreignId)).get()
    expect(untouched?.description).toBe('someone else owns this')

    const receipt = await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [
        { opId: 'op-1', applyMode: 'copy', slots: [{ slotId: 'name:op-1', value: 'my-copy' }] },
      ],
    })
    expect(receipt.applied[0]?.fromCopy).toBe(true)
    const copied = db
      .select()
      .from(agents)
      .where(eq(agents.id, receipt.applied[0]?.resourceId ?? ''))
      .get()
    expect(copied?.ownerUserId).toBe(OWNER)
    expect(copied?.name).toBe('my-copy')
    expect(db.select().from(agents).where(eq(agents.id, foreignId)).get()?.description).toBe(
      'someone else owns this',
    )
  })

  // Codex impl-gate P1-3 — a superseded (non-current) draft revision cannot
  // commit even when its hash and epoch both still match.
  test('superseded draft revision is refused at claim', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    // A newer draft becomes current (same epoch — no rebase).
    db.update(intentSessions)
      .set({ currentDraftId: ulid() })
      .where(eq(intentSessions.id, session.id))
      .run()
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: happyDecisions,
      }),
    ).rejects.toMatchObject({ code: 'intent-draft-superseded' })
    expect((await db.select().from(intentApplyJournal)).length).toBe(0)
  })

  // Codex impl-gate P1-5 — a server-issued finalName slot value must satisfy
  // the per-type canonical grammar; arbitrary strings are refused.
  test('finalName slot value is validated against the type grammar', async () => {
    const existing = await seedAgent('existing-agent')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      fullBundle(existing.id, filePluginFixture()),
      manifestWithAgent(existing.id, existing.updatedAt),
    )
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [
          ...happyDecisions,
          { opId: 'op-1', slots: [{ slotId: 'name:op-1', value: '../../evil name' }] },
        ],
      }),
    ).rejects.toMatchObject({ code: 'intent-slot-value-invalid' })
    expect((await db.select().from(skills)).length).toBe(0)
  })

  // Live-run regression (deepseek 2026-07-28): a payload that passes the
  // intent schema but fails the CANONICAL service schema (here: a workflow
  // definition whose edge lacks source/target — intent keeps edges loose)
  // used to escape as an unhandled ZodError → HTTP 500. It must map to the
  // typed op-addressed 'intent-op-canonical-invalid' and settle the journal.
  test('canonical schema rejection maps to intent-op-canonical-invalid, not 500', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:wf',
            payload: {
              name: 'bad-edge-flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [{ id: 'n1', kind: 'output' }],
                edges: [{ id: 'e1' }],
              },
            },
          },
        ],
      },
      [],
    )
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      }),
    ).rejects.toMatchObject({ code: 'intent-op-canonical-invalid' })
    expect((await db.select().from(workflows)).length).toBe(0)
    expect(db.select().from(intentApplyJournal).get()?.state).toBe('failed')
  })

  // Design-gate P2-2 crash matrix: the three pre-commit breakpoints not
  // covered above (afterPluginInstall / afterSkillStage / beforeTx). Every
  // one must settle `failed` with ZERO visible resources — prestaged plugin
  // installs and skill stages are compensated inline. A replay of the same
  // clientMutationId must then return the ORIGINAL failure (never re-run).
  for (const point of ['afterPluginInstall', 'afterSkillStage', 'beforeTx'] as const) {
    test(`pre-commit crash at ${point}: failed + zero visible + failed-replay`, async () => {
      const existing = await seedAgent('existing-agent')
      const { session } = await createIntentSession(db, actor, { message: 'x' })
      const draft = installDraft(
        session.id,
        fullBundle(existing.id, filePluginFixture()),
        manifestWithAgent(existing.id, existing.updatedAt),
      )
      const clientMutationId = ulid()
      await expect(
        applyIntentChangeset(
          deps({
            faults: {
              [point]: () => {
                throw new Error(`boom-${point}`)
              },
            },
          }),
          { sessionId: session.id, clientMutationId, ...draft, decisions: happyDecisions },
        ),
      ).rejects.toThrow(new RegExp(`boom-${point}`))
      expect((await db.select().from(skills)).length).toBe(0)
      expect((await db.select().from(mcps)).length).toBe(0)
      expect((await db.select().from(plugins)).length).toBe(0)
      expect((await db.select().from(workflows)).length).toBe(0)
      expect((await db.select().from(workgroups)).length).toBe(0)
      expect((await db.select().from(agents)).length).toBe(1)
      expect(db.select().from(intentApplyJournal).get()?.state).toBe('failed')
      // Idempotent replay of a failed journal: original error, no side effects.
      await expect(
        applyIntentChangeset(deps(), {
          sessionId: session.id,
          clientMutationId,
          ...draft,
          decisions: happyDecisions,
        }),
      ).rejects.toMatchObject({ code: 'intent-apply-failed-replay' })
      expect((await db.select().from(agents)).length).toBe(1)
    })
  }
})

// ---------------------------------------------------------------------------
// RFC-243 §5.3 in the intent CREATE path.
//
// call-workflow / call-workgroup select their target by NAME, and a name is not
// an authorization. Every other workflow INSERT re-checks that the writer can
// actually see the referenced row — createWorkflow (services/workflow.ts:200),
// copyWorkflow (:278), the save path (:526) — but the intent create path only
// ever checked agent refs. It was unreachable while INTENT.md withheld the two
// call kinds; documenting them is exactly what makes it reachable, so the check
// and the docs have to land together.
//
// Name domain stays dangle-tolerant: an unresolvable name is launch-time's
// problem, not an ACL violation.
// ---------------------------------------------------------------------------
describe('intent create path enforces call-ref visibility (RFC-243 §5.3)', () => {
  const OTHER = 'user_other_apply_000000000'

  async function seedWorkflow(
    name: string,
    ownerUserId: string,
    visibility: 'public' | 'private',
  ): Promise<string> {
    const id = ulid()
    const now = Date.now()
    await db.insert(workflows).values({
      id,
      name,
      description: '',
      definition: JSON.stringify({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      version: 1,
      ownerUserId,
      visibility,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    } as typeof workflows.$inferInsert)
    return id
  }

  async function seedWorkgroup(
    name: string,
    ownerUserId: string,
    visibility: 'public' | 'private',
  ): Promise<string> {
    const id = ulid()
    const now = Date.now()
    await db.insert(workgroups).values({
      id,
      name,
      description: '',
      instructions: 'work',
      mode: 'leader_worker',
      ownerUserId,
      visibility,
      createdAt: now,
      updatedAt: now,
    } as typeof workgroups.$inferInsert)
    return id
  }

  function callBundle(node: Record<string, unknown>): unknown {
    return {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:caller',
          payload: {
            name: 'caller-flow',
            description: '',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [node],
              edges: [],
            },
          },
        },
      ],
    }
  }

  async function applyCall(node: Record<string, unknown>): Promise<unknown> {
    const { session } = await createIntentSession(db, actor, { message: 'call something' })
    const draft = installDraft(session.id, callBundle(node), [])
    return applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })
  }

  test('call-workflow naming another user’s private workflow is refused, nothing lands', async () => {
    await seedUser(OTHER, 'other')
    await seedWorkflow('secret-flow', OTHER, 'private')

    await expect(
      applyCall({ id: 'n1', kind: 'call-workflow', workflowName: 'secret-flow' }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    // all-or-nothing: the caller workflow must not exist either
    expect((await db.select().from(workflows)).length).toBe(1) // only the seeded one
  })

  test('call-workgroup naming another user’s private workgroup is refused', async () => {
    await seedUser(OTHER, 'other')
    await seedWorkgroup('secret-squad', OTHER, 'private')

    await expect(
      applyCall({
        id: 'n1',
        kind: 'call-workgroup',
        workgroupName: 'secret-squad',
        goalTemplate: 'do it',
      }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect((await db.select().from(workgroups)).length).toBe(1)
  })

  test('a workflow the actor owns is referenceable', async () => {
    await seedWorkflow('my-flow', OWNER, 'private')
    const receipt = (await applyCall({
      id: 'n1',
      kind: 'call-workflow',
      workflowName: 'my-flow',
    })) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
    expect((await db.select().from(workflows)).length).toBe(2)
  })

  test('a public workflow is referenceable', async () => {
    await seedUser(OTHER, 'other')
    await seedWorkflow('shared-flow', OTHER, 'public')
    const receipt = (await applyCall({
      id: 'n1',
      kind: 'call-workflow',
      workflowName: 'shared-flow',
    })) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
  })

  test('an unresolvable name stays dangle-tolerant (launch validates it, not ACL)', async () => {
    const receipt = (await applyCall({
      id: 'n1',
      kind: 'call-workflow',
      workflowName: 'does-not-exist-anywhere',
    })) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Codex impl-gate P2 — the call-ref fence must not depend on op ORDER.
//
// The first cut relied on same-connection in-tx visibility: a target created
// EARLIER in the same transaction is visible to the fence, so it passed. But
// nothing orders call refs — they are not part of the resolver's dependency
// graph and INTENT.md never says "emit the target first" — so the identical
// logical bundle would 403 or succeed depending on op order alone, and only
// when someone else's private resource happened to hold that name.
//
// The fix excludes names this bundle is creating. These tests pin BOTH
// directions plus the collision case that made it observable.
// ---------------------------------------------------------------------------
describe('call-ref fence is order-independent (RFC-243 §5.3)', () => {
  const OTHER2 = 'user_other2_apply_00000000'

  async function seedForeignPrivateWorkflow(name: string): Promise<void> {
    await db.insert(users).values({
      id: OTHER2,
      username: 'other2',
      displayName: 'other2',
      role: 'user',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as typeof users.$inferInsert)
    await db.insert(workflows).values({
      id: ulid(),
      name,
      description: '',
      definition: JSON.stringify({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      version: 1,
      ownerUserId: OTHER2,
      visibility: 'private',
      builtin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as typeof workflows.$inferInsert)
  }

  /** Two creates: a caller referencing `child-flow` by name, and `child-flow`
   *  itself. `callerFirst` flips only their order in `ops`. */
  function pairBundle(callerFirst: boolean): unknown {
    const caller = {
      opId: callerFirst ? 'op-1' : 'op-2',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:caller',
      payload: {
        name: 'caller-flow',
        description: '',
        definition: {
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [{ id: 'n1', kind: 'call-workflow', workflowName: 'child-flow' }],
          edges: [],
        },
      },
    }
    const child = {
      opId: callerFirst ? 'op-2' : 'op-1',
      action: 'create',
      resourceType: 'workflow',
      tempRef: '$new:child',
      payload: {
        name: 'child-flow',
        description: '',
        definition: { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes: [], edges: [] },
      },
    }
    return { $schema_version: 1, ops: callerFirst ? [caller, child] : [child, caller] }
  }

  async function applyPair(callerFirst: boolean): Promise<unknown> {
    const { session } = await createIntentSession(db, actor, { message: 'compose' })
    const draft = installDraft(session.id, pairBundle(callerFirst), [])
    return applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })
  }

  for (const callerFirst of [true, false]) {
    test(`bundle-internal target resolves with caller ${callerFirst ? 'BEFORE' : 'AFTER'} it`, async () => {
      const receipt = (await applyPair(callerFirst)) as { applied: unknown[] }
      expect(receipt.applied.length).toBe(2)
      expect((await db.select().from(workflows)).length).toBe(2)
    })
  }

  // The collision that made the ordering bug observable at all: someone else
  // already owns a private workflow with the name this bundle is creating.
  for (const callerFirst of [true, false]) {
    test(`a foreign private same-name row does not change the verdict (caller ${callerFirst ? 'first' : 'last'})`, async () => {
      await seedForeignPrivateWorkflow('child-flow')
      const receipt = (await applyPair(callerFirst)) as { applied: unknown[] }
      expect(receipt.applied.length).toBe(2)
      // the actor's own child row exists alongside the foreign one
      const rows = await db.select().from(workflows)
      expect(rows.filter((r) => r.name === 'child-flow').length).toBe(2)
    })
  }

  // The exclusion must be scoped to names this bundle CREATES — a reference to
  // someone else's private workflow that the bundle does NOT create is still
  // refused, in either order.
  test('excluding bundle names does not open a hole for unrelated foreign refs', async () => {
    await seedForeignPrivateWorkflow('someone-elses-flow')
    const { session } = await createIntentSession(db, actor, { message: 'compose' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:caller',
            payload: {
              name: 'caller-flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [{ id: 'n1', kind: 'call-workflow', workflowName: 'someone-elses-flow' }],
                edges: [],
              },
            },
          },
        ],
      },
      [],
    )
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
  })

  // D1: the error echoes only the name the author typed — never an id, owner
  // or description of the row they cannot see.
  test('the refusal discloses only the typed name', async () => {
    await seedForeignPrivateWorkflow('secret-name')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:caller',
            payload: {
              name: 'caller-flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [{ id: 'n1', kind: 'call-workflow', workflowName: 'secret-name' }],
                edges: [],
              },
            },
          },
        ],
      },
      [],
    )
    const err = (await applyIntentChangeset(deps(), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    }).catch((e: unknown) => e)) as { message: string; details?: unknown }
    expect(err.message).toContain('secret-name')
    expect(err.message).not.toContain(OTHER2)
    expect(JSON.stringify(err.details ?? {})).not.toContain(OTHER2)
  })

  // A call node nested inside a wrapper still contributes its ref: the
  // extractor walks `nodes[]` flat, and wrappers only list ids.
  test('a call node inside a wrapper is still fenced', async () => {
    await seedForeignPrivateWorkflow('nested-target')
    const { session } = await createIntentSession(db, actor, { message: 'x' })
    const draft = installDraft(
      session.id,
      {
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'create',
            resourceType: 'workflow',
            tempRef: '$new:caller',
            payload: {
              name: 'caller-flow',
              description: '',
              definition: {
                $schema_version: WORKFLOW_SCHEMA_VERSION,
                inputs: [],
                nodes: [
                  { id: 'n1', kind: 'call-workflow', workflowName: 'nested-target' },
                  { id: 'w1', kind: 'wrapper-loop', nodeIds: ['n1'], maxIterations: 2 },
                ],
                edges: [],
              },
            },
          },
        ],
      },
      [],
    )
    await expect(
      applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [],
      }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
  })
})

// ---------------------------------------------------------------------------
// The rest of the call-ref ACL surface: the workgroup half (symmetric with the
// workflow half above, and separately implemented, so separately tested), the
// grant path, and the resource-admin bypass.
//
// These matter because the fence is the ONLY place per-resource use rights are
// checked for a call node — launch validates the workflow itself, not its
// closure (RFC-099 D3) — so an over-tight fence blocks legitimate composition
// and an over-loose one lets an author adopt a reference they cannot see.
// ---------------------------------------------------------------------------
describe('call-ref fence: workgroup half, grants and admin bypass', () => {
  const OWNER3 = 'user_owner3_apply_00000000'

  async function seedOtherUser(id: string): Promise<void> {
    await db.insert(users).values({
      id,
      username: id,
      displayName: id,
      role: 'user',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as typeof users.$inferInsert)
  }

  async function seedPrivateWorkgroup(name: string, ownerUserId: string): Promise<string> {
    const id = ulid()
    await db.insert(workgroups).values({
      id,
      name,
      description: '',
      instructions: 'work',
      mode: 'leader_worker',
      ownerUserId,
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as typeof workgroups.$inferInsert)
    return id
  }

  async function seedPrivateWorkflow(name: string, ownerUserId: string): Promise<string> {
    const id = ulid()
    await db.insert(workflows).values({
      id,
      name,
      description: '',
      definition: JSON.stringify({
        $schema_version: WORKFLOW_SCHEMA_VERSION,
        inputs: [],
        nodes: [],
        edges: [],
      }),
      version: 1,
      ownerUserId,
      visibility: 'private',
      builtin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as typeof workflows.$inferInsert)
    return id
  }

  function callerWith(node: Record<string, unknown>): unknown {
    return {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:caller',
          payload: {
            name: 'caller-flow',
            description: '',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [node],
              edges: [],
            },
          },
        },
      ],
    }
  }

  async function applyWith(a: Actor, node: Record<string, unknown>): Promise<unknown> {
    const { session } = await createIntentSession(db, a, { message: 'compose' })
    const draft = installDraft(session.id, callerWith(node), [])
    return applyIntentChangeset(deps({ actor: a }), {
      sessionId: session.id,
      clientMutationId: ulid(),
      ...draft,
      decisions: [],
    })
  }

  const wgNode = (name: string): Record<string, unknown> => ({
    id: 'n1',
    kind: 'call-workgroup',
    workgroupName: name,
    goalTemplate: 'do it',
  })

  // One test per order, each on the beforeEach-provided database. An earlier
  // draft looped both orders inside a single test and rebuilt `db` mid-test,
  // which silently detached the run from the fixture appHome and made a failure
  // in the second iteration impossible to attribute.
  for (const callerFirst of [true, false]) {
    test(`a bundle-created workgroup is referenceable with caller ${callerFirst ? 'BEFORE' : 'AFTER'} it`, async () => {
      const caller = {
        opId: callerFirst ? 'op-1' : 'op-2',
        action: 'create',
        resourceType: 'workflow',
        tempRef: '$new:caller',
        payload: {
          name: 'caller-flow',
          description: '',
          definition: {
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [wgNode('squad')],
            edges: [],
          },
        },
      }
      const squad = {
        opId: callerFirst ? 'op-2' : 'op-1',
        action: 'create',
        resourceType: 'workgroup',
        tempRef: '$new:squad',
        payload: {
          name: 'squad',
          description: '',
          instructions: 'work',
          mode: 'free_collab',
          members: [{ memberType: 'human', displayName: 'someone', roleDesc: 'helps' }],
        },
      }
      const { session } = await createIntentSession(db, actor, { message: 'compose' })
      const draft = installDraft(
        session.id,
        { $schema_version: 1, ops: callerFirst ? [caller, squad] : [squad, caller] },
        [],
      )
      const receipt = (await applyIntentChangeset(deps(), {
        sessionId: session.id,
        clientMutationId: ulid(),
        ...draft,
        decisions: [
          { opId: squad.opId, slots: [{ slotId: `human:${squad.opId}:someone`, value: APPROVER }] },
        ],
      })) as { applied: unknown[] }
      expect(receipt.applied.length).toBe(2)
      expect((await db.select().from(workgroups)).length).toBe(1)
    })
  }

  test("another user's private workgroup is refused", async () => {
    await seedOtherUser(OWNER3)
    await seedPrivateWorkgroup('their-squad', OWNER3)
    await expect(applyWith(actor, wgNode('their-squad'))).rejects.toMatchObject({
      code: 'acl-missing-refs',
    })
  })

  // An explicit grant is the supported way to share a private resource, so it
  // must open the fence — otherwise the ACL model has a hole in the other
  // direction: shared-with-me resources would be uncomposable.
  test('an explicit grant makes a private workgroup referenceable', async () => {
    await seedOtherUser(OWNER3)
    const wgId = await seedPrivateWorkgroup('granted-squad', OWNER3)
    await db.insert(resourceGrants).values({
      resourceType: 'workgroup',
      resourceId: wgId,
      userId: OWNER,
      addedBy: OWNER3,
      addedAt: Date.now(),
    } as typeof resourceGrants.$inferInsert)
    const receipt = (await applyWith(actor, wgNode('granted-squad'))) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
  })

  test('an explicit grant makes a private workflow referenceable', async () => {
    await seedOtherUser(OWNER3)
    const wfId = await seedPrivateWorkflow('granted-flow', OWNER3)
    await db.insert(resourceGrants).values({
      resourceType: 'workflow',
      resourceId: wfId,
      userId: OWNER,
      addedBy: OWNER3,
      addedAt: Date.now(),
    } as typeof resourceGrants.$inferInsert)
    const receipt = (await applyWith(actor, {
      id: 'n1',
      kind: 'call-workflow',
      workflowName: 'granted-flow',
    })) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
  })

  // RFC-222: manager and admin share every row-level ACL bypass, so the fence
  // must not stop them composing against a resource they can already see.
  for (const role of ['manager', 'admin'] as const) {
    test(`a ${role} may reference another user's private workflow`, async () => {
      await seedOtherUser(OWNER3)
      await seedPrivateWorkflow('their-flow', OWNER3)
      const elevated: Actor = {
        user: { id: OWNER, username: 'owner', displayName: 'Owner', role, status: 'active' },
        source: 'session',
        permissions: new Set(ROLE_PERMISSIONS[role]),
      }
      const receipt = (await applyWith(elevated, {
        id: 'n1',
        kind: 'call-workflow',
        workflowName: 'their-flow',
      })) as { applied: unknown[] }
      expect(receipt.applied.length).toBe(1)
    })
  }
})
