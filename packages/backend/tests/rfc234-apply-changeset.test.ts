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
import { canonicalIntentJson, parseIntentChangeset } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  mcps,
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
  permissions: new Set(),
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
            $schema_version: 4,
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
                $schema_version: 4,
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
