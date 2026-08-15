// Capability protection for the intent builder's privileged-node surface
// (RFC-234 apply × RFC-253 scripts:author × RFC-269 code-host-calls:author ×
// RFC-270 privileged lens), added after the Codex implementation gate on
// commit f734a897/ee3fd7f2.
//
// WHY A DEDICATED FILE, and why these assert BEHAVIOUR rather than prose:
// the first cut of this work was covered almost entirely by "does INTENT.md
// contain this sentence" tests. Those lock the prompt, which matters — the
// prompt IS the spec the generating model reads — but they cannot catch the
// thing that actually went wrong: a doc sentence that is individually true and
// still steers the model into a changeset the apply pipeline refuses. Only
// driving `applyIntentChangeset` for real shows that.
//
// The matrix below is organised as: normal (it works for who it should) →
// boundary (the exact line between allowed and refused) → abnormal (it fails
// closed, and fails with nothing written).
//
// The boundary group is the valuable one and it is NOT symmetric, which is
// why it is enumerated field by field:
//   - the sensitive projection of a script node covers id, language, script,
//     outputs, dependencies, env, readonly, inbound edges and wrapper
//     ancestry (shared/scriptNode.ts serializeScriptSensitiveProjectionV1);
//   - but rehydration only restores `script` / `env` / `dependencies`
//     (SCRIPT_REDACTED_FIELDS) — and for code-host `params` / `request`.
// So the DIFFERENCE between those two sets is exactly the set of fields a
// permissionless author may not touch even though they can see them. Sending a
// garbage value for a REDACTED field is fine (it gets overwritten from
// storage); changing a projected-but-not-rehydrated field is a 403. Nothing
// states that rule in one place, so it is enumerated here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  INTENT_REDACTED,
  SYSTEM_DOMAIN_POINTS,
  WORKFLOW_SCHEMA_VERSION,
  grantableMatrixPoints,
  resolveEffectiveAccountPermissions,
  resolveTokenPermissions,
  canonicalIntentJson,
  parseIntentChangeset,
  type Permission,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, users, workflows } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import { createIntentSession } from '../src/services/intent/session'
import type { IntentContextManifest } from '../src/services/intent/manifest'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const PLAIN = 'user_plain_priv_0000000000'
const BOSS = 'user_manager_priv_00000000'

let db: DbClient
let appHome: string

/** Resolve the same preset + per-account grants used by production. */
function actorOf(
  id: string,
  role: 'user' | 'manager' | 'admin',
  additionalPermissions: ReadonlyArray<Permission> = [],
): Actor {
  return {
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    permissions: resolveEffectiveAccountPermissions({ role, additionalPermissions }),
  }
}
const plain = actorOf(PLAIN, 'user')
const boss = actorOf(BOSS, 'user', ['scripts:author', 'code-host-calls:author'])

async function seedUser(id: string, role: 'user' | 'manager' | 'admin' = 'user'): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
}

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

function deps(actor: Actor): ApplyIntentDeps {
  return { db, appHome, actor }
}

/** As STORED: a real env value, which only ever gets there through the confirm
 *  UI's secret slot — a changeset may never carry one (RFC-253 T28). */
const SCRIPT_NODE = {
  id: 'sc1',
  kind: 'script',
  language: 'python',
  script: 'print("secret business logic")',
  dependencies: ['requests==2.32.3'],
  env: { TOKEN: 'real-value-in-storage' },
  readonly: true,
} as const

/** As EMITTED in a changeset: no env at all, so the create-path cases exercise
 *  the author gate rather than tripping the (separately tested) secret-carrier
 *  rule first. */
const { env: _storedEnv, ...SCRIPT_NODE_NO_ENV } = SCRIPT_NODE

const CODE_HOST_NODE = {
  id: 'ch1',
  kind: 'code-host-call',
  provider: 'gitlab',
  action: 'comment.create',
  params: { mr: '7', body: 'hello' },
  allowDestructive: false,
  timeoutMs: 30_000,
} as const

/** The definition a mounted workflow actually holds in storage. */
function storedDefinition(extra: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [{ id: 'in1', kind: 'input', inputKey: 'k' }, { ...SCRIPT_NODE }, ...extra],
    edges: [],
  }
}

/** What a permissionless author is SHOWN in `mounted/` — privileged fields
 *  replaced by the redaction marker (dumpBuilder: maskWorkflowScriptEnv +
 *  redactPrivilegedNodes, both with INTENT_REDACTED). */
function shownScriptNode(): Record<string, unknown> {
  return {
    ...SCRIPT_NODE,
    script: INTENT_REDACTED,
    dependencies: [INTENT_REDACTED],
    env: { TOKEN: INTENT_REDACTED },
  }
}

/**
 * What the author must actually SEND back: the redacted keys OMITTED.
 *
 * Echoing the marker back is refused before the author gate is even reached —
 * `findNonSentinelSecretCarriers` treats any string containing INTENT_REDACTED
 * as a corrupt credential (intentSecretSlots.ts:388), and script `env`
 * additionally has to be the `‹secret›` sentinel or empty. Omitting the key
 * instead lands on the rehydrate branch that restores it from storage
 * (privilegedNodeRedaction.ts:266-278: absent in `next` + present in
 * `previous` ⇒ assign the stored value), so the sensitive projection is
 * unchanged and the gate passes.
 */
function sentScriptNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { script: _s, dependencies: _d, env: _e, ...rest } = SCRIPT_NODE
  return { ...rest, ...extra }
}

async function seedWorkflow(
  name: string,
  ownerUserId: string,
  definition: Record<string, unknown>,
  visibility: 'public' | 'private' = 'private',
): Promise<{ id: string; version: number }> {
  const id = ulid()
  const now = Date.now()
  await db.insert(workflows).values({
    id,
    name,
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    ownerUserId,
    visibility,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  } as typeof workflows.$inferInsert)
  return { id, version: 1 }
}

function manifestFor(id: string, version: number): IntentContextManifest {
  return [
    {
      handle: 'res#workflow#1',
      resourceType: 'workflow',
      resourceId: id,
      root: true,
      detail: true,
      fence: { kind: 'workflow', version },
      dumpHash: 'x',
    },
  ]
}

function updateBundle(nodes: unknown[], name = 'target-flow'): unknown {
  return {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'workflow',
        target: 'res#workflow#1',
        payload: {
          name,
          description: '',
          definition: { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes, edges: [] },
        },
      },
    ],
  }
}

function createBundle(nodes: unknown[], name = 'new-flow'): unknown {
  return {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'workflow',
        tempRef: '$new:wf',
        payload: {
          name,
          description: '',
          definition: { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes, edges: [] },
        },
      },
    ],
  }
}

async function applyAs(
  actor: Actor,
  bundle: unknown,
  manifest: IntentContextManifest = [],
  decisions: unknown[] = [],
): Promise<unknown> {
  const { session } = await createIntentSession(db, actor, { message: 'do a thing' })
  const draft = installDraft(session.id, bundle, manifest)
  return applyIntentChangeset(deps(actor), {
    sessionId: session.id,
    clientMutationId: ulid(),
    ...draft,
    decisions: decisions as never,
  })
}

/** Read back the stored definition of a workflow row. */
async function storedNodes(id: string): Promise<Array<Record<string, unknown>>> {
  const row = (await db.select().from(workflows).where(eq(workflows.id, id)))[0]
  return (JSON.parse(row!.definition) as { nodes: Array<Record<string, unknown>> }).nodes
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-priv-'))
  mkdirSync(join(appHome, 'skills'), { recursive: true })
  await seedUser(PLAIN, 'user')
  await seedUser(BOSS, 'user')
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// NORMAL — the capability works for any effective authority that holds the point.
// ---------------------------------------------------------------------------
describe('normal: an author-permitted account can create privileged nodes via intent', () => {
  test('a user with an explicit grant creates a workflow carrying a script node', async () => {
    const receipt = (await applyAs(boss, createBundle([{ ...SCRIPT_NODE_NO_ENV }]))) as {
      applied: Array<{ resourceId: string }>
    }
    expect(receipt.applied.length).toBe(1)
    const nodes = await storedNodes(receipt.applied[0]!.resourceId)
    expect(nodes.find((n) => n.kind === 'script')?.script).toBe(SCRIPT_NODE.script)
  })

  test('a user with an explicit grant creates a workflow carrying a code-host-call node', async () => {
    const receipt = (await applyAs(boss, createBundle([{ ...CODE_HOST_NODE }]))) as {
      applied: Array<{ resourceId: string }>
    }
    const nodes = await storedNodes(receipt.applied[0]!.resourceId)
    expect(nodes.find((n) => n.kind === 'code-host-call')?.action).toBe('comment.create')
  })

  test('both kinds in one bundle land together', async () => {
    const receipt = (await applyAs(
      boss,
      createBundle([{ ...SCRIPT_NODE_NO_ENV }, { ...CODE_HOST_NODE }]),
    )) as { applied: Array<{ resourceId: string }> }
    const kinds = (await storedNodes(receipt.applied[0]!.resourceId)).map((n) => n.kind)
    expect(kinds).toContain('script')
    expect(kinds).toContain('code-host-call')
  })

  test('admin holds both points too', () => {
    const admin = actorOf('user_admin_priv_000000000', 'admin')
    expect(admin.permissions.has('scripts:author')).toBe(true)
    expect(admin.permissions.has('code-host-calls:author')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ABNORMAL — a plain user is refused, and refused with NOTHING written.
// This is the direct answer to "can an ordinary user create these via intent".
// ---------------------------------------------------------------------------
describe('abnormal: a plain user cannot create privileged nodes via intent', () => {
  test('the default user preset lacks both points but explicit grants add them', () => {
    expect(plain.permissions.has('scripts:author')).toBe(false)
    expect(plain.permissions.has('code-host-calls:author')).toBe(false)
    expect(boss.user.role).toBe('user')
    expect(boss.permissions.has('scripts:author')).toBe(true)
    expect(boss.permissions.has('code-host-calls:author')).toBe(true)
  })

  test('a script node is refused with script-author-forbidden and zero rows', async () => {
    await expect(applyAs(plain, createBundle([{ ...SCRIPT_NODE_NO_ENV }]))).rejects.toMatchObject({
      code: 'script-author-forbidden',
    })
    expect((await db.select().from(workflows)).length).toBe(0)
  })

  test('a code-host-call node is refused with code-host-author-forbidden', async () => {
    await expect(applyAs(plain, createBundle([{ ...CODE_HOST_NODE }]))).rejects.toMatchObject({
      code: 'code-host-author-forbidden',
    })
    expect((await db.select().from(workflows)).length).toBe(0)
  })

  // All-or-nothing: the refusal must not leave the innocent half of the bundle
  // behind. This is what makes "a withheld node costs the user the whole turn"
  // true, and therefore why INTENT.md withholds the FORM rather than relying on
  // the gate alone.
  test('one privileged node takes the whole bundle down, including innocent ops', async () => {
    const bundle = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:a',
          payload: {
            name: 'innocent-agent',
            description: 'nothing privileged here',
            outputs: ['out'],
            bodyMd: 'hi',
          },
        },
        {
          opId: 'op-2',
          action: 'create',
          resourceType: 'workflow',
          tempRef: '$new:wf',
          payload: {
            name: 'flow-with-script',
            description: '',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [{ ...SCRIPT_NODE_NO_ENV }],
              edges: [],
            },
          },
        },
      ],
    }
    await expect(applyAs(plain, bundle)).rejects.toMatchObject({
      code: 'script-author-forbidden',
    })
    expect((await db.select().from(workflows)).length).toBe(0)
    // the agent op ran EARLIER in the same transaction and must be rolled back
    const { agents } = await import('../src/db/schema')
    expect((await db.select().from(agents)).length).toBe(0)
  })

  test('a privileged node nested inside a wrapper is still refused', async () => {
    const bundle = createBundle([
      { ...SCRIPT_NODE_NO_ENV },
      { id: 'w1', kind: 'wrapper-git', nodeIds: ['sc1'] },
    ])
    await expect(applyAs(plain, bundle)).rejects.toMatchObject({
      code: 'script-author-forbidden',
    })
    expect((await db.select().from(workflows)).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// BOUNDARY — the exact line for a plain user editing a workflow that ALREADY
// contains a privileged node. This is the Codex P1-2 surface: the promise is
// "you may edit everything else", and both halves of it need locking.
// ---------------------------------------------------------------------------
describe('boundary: a plain user updating a workflow that already has a script node', () => {
  async function mounted(
    definition: Record<string, unknown> = storedDefinition(),
  ): Promise<{ id: string; manifest: IntentContextManifest }> {
    const wf = await seedWorkflow('target-flow', PLAIN, definition)
    return { id: wf.id, manifest: manifestFor(wf.id, wf.version) }
  }

  // ── the ALLOWED half ──

  test('copying the masked node back verbatim succeeds and storage keeps the real body', async () => {
    const { id, manifest } = await mounted()
    await applyAs(
      plain,
      updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()], 'target-flow'),
      manifest,
    )
    const node = (await storedNodes(id)).find((n) => n.kind === 'script')!
    // rehydration restored the true values — the marker never reached storage
    expect(node.script).toBe(SCRIPT_NODE.script)
    expect(node.env).toEqual({ TOKEN: 'real-value-in-storage' })
    expect(node.dependencies).toEqual(['requests==2.32.3'])
  })

  test('editing an UNRELATED part of the same workflow succeeds', async () => {
    const { id, manifest } = await mounted()
    await applyAs(
      plain,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          sentScriptNode(),
          { id: 'out1', kind: 'output', ports: [] },
        ],
        'target-flow',
      ),
      manifest,
    )
    const nodes = await storedNodes(id)
    expect(nodes.some((n) => n.id === 'out1')).toBe(true)
    expect(nodes.find((n) => n.kind === 'script')?.script).toBe(SCRIPT_NODE.script)
  })

  test('moving the privileged node (position only) succeeds', async () => {
    const { id, manifest } = await mounted()
    await applyAs(
      plain,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          { ...sentScriptNode(), position: { x: 999, y: 888 } },
        ],
        'target-flow',
      ),
      manifest,
    )
    const node = (await storedNodes(id)).find((n) => n.kind === 'script')!
    expect(node.position).toEqual({ x: 999, y: 888 })
    expect(node.script).toBe(SCRIPT_NODE.script)
  })

  // Sending garbage for a REHYDRATED field is harmless — storage wins. This is
  // deliberate: the author cannot read those fields, so they cannot be expected
  // to round-trip them faithfully, and the platform must not punish them for it.
  test('a wrong value in a rehydrated field is overwritten, not refused', async () => {
    const { id, manifest } = await mounted()
    await applyAs(
      plain,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          // `env` is deliberately NOT included here: it has its own closed
          // carrier rule (a literal value is refused earlier, and that is
          // covered by its own test below), so including it would test the
          // secret scanner rather than rehydration.
          {
            ...sentScriptNode(),
            script: 'print("attacker body")',
            dependencies: ['evil==1.0.0'],
          },
        ],
        'target-flow',
      ),
      manifest,
    )
    const node = (await storedNodes(id)).find((n) => n.kind === 'script')!
    expect(node.script).toBe(SCRIPT_NODE.script)
    expect(node.env).toEqual({ TOKEN: 'real-value-in-storage' })
    expect(node.dependencies).toEqual(['requests==2.32.3'])
  })

  // ── the REFUSED half ──

  // THE regression Codex P1-2 caught: "MUST NOT emit them" made the model drop
  // the node, and dropping it is refused, so the user could no longer edit the
  // workflow at all.
  test('DELETING the script node is refused', async () => {
    const { id, manifest } = await mounted()
    await expect(
      applyAs(
        plain,
        updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }], 'target-flow'),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'script-author-forbidden' })
    expect((await storedNodes(id)).some((n) => n.kind === 'script')).toBe(true)
  })

  // Every field that is in the sensitive projection but NOT in
  // SCRIPT_REDACTED_FIELDS: visible to the author, still untouchable.
  const untouchable: Array<[string, Record<string, unknown>]> = [
    ['language', { language: 'bash' }],
    ['readonly', { readonly: false }],
    ['outputs', { outputs: [{ name: 'extra' }] }],
    ['id', { id: 'renamed' }],
    // `clarify` rather than `agent-single`: the latter would be rejected by the
    // intent schema's agentRef rule first, hiding the gate we mean to exercise.
    ['kind', { kind: 'clarify' }],
  ]
  for (const [field, patch] of untouchable) {
    test(`changing \`${field}\` is refused even though the author can see it`, async () => {
      const { id, manifest } = await mounted()
      await expect(
        applyAs(
          plain,
          updateBundle(
            [
              { id: 'in1', kind: 'input', inputKey: 'k' },
              { ...sentScriptNode(), ...patch },
            ],
            'target-flow',
          ),
          manifest,
        ),
      ).rejects.toMatchObject({ code: 'script-author-forbidden' })
      const node = (await storedNodes(id)).find((n) => n.kind === 'script')!
      expect(node.language).toBe('python')
      expect(node.script).toBe(SCRIPT_NODE.script)
    })
  }

  // Inbound edges decide the AW_PORT_* variables the script receives, so they
  // are part of the executable surface even though they live outside the node.
  test('adding an inbound edge to the script node is refused', async () => {
    const wf = await seedWorkflow('target-flow', PLAIN, storedDefinition())
    const bundle = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'update',
          resourceType: 'workflow',
          target: 'res#workflow#1',
          payload: {
            name: 'target-flow',
            description: '',
            definition: {
              $schema_version: WORKFLOW_SCHEMA_VERSION,
              inputs: [],
              nodes: [{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()],
              edges: [
                {
                  id: 'e1',
                  source: { nodeId: 'in1', portName: 'k' },
                  target: { nodeId: 'sc1', portName: 'k' },
                },
              ],
            },
          },
        },
      ],
    }
    await expect(applyAs(plain, bundle, manifestFor(wf.id, wf.version))).rejects.toMatchObject({
      code: 'script-author-forbidden',
    })
  })

  // Wrapper ancestry decides whether and how many times the script runs.
  test('moving the script node into a wrapper is refused', async () => {
    const { manifest } = await mounted()
    await expect(
      applyAs(
        plain,
        updateBundle(
          [
            { id: 'in1', kind: 'input', inputKey: 'k' },
            sentScriptNode(),
            { id: 'w1', kind: 'wrapper-git', nodeIds: ['sc1'] },
          ],
          'target-flow',
        ),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'script-author-forbidden' })
  })

  // ── the rule that makes "copy it back verbatim" impossible to follow ──
  //
  // Found by writing this suite, not by reading the doc: the redaction marker
  // is refused as a corrupt credential BEFORE the author gate is reached
  // (findNonSentinelSecretCarriers, intentSecretSlots.ts:388), and it is what
  // `mounted/` shows for every redacted field. So "echo the marker back" — the
  // instruction the first fix for Codex P1-2 gave — is itself unfollowable, and
  // the only workable instruction is "omit the key". These two tests pin the
  // real behaviour so the doc cannot drift back.
  test('echoing the redaction marker back is refused (so the doc must say OMIT)', async () => {
    const { manifest } = await mounted()
    await expect(
      applyAs(
        plain,
        updateBundle(
          [{ id: 'in1', kind: 'input', inputKey: 'k' }, shownScriptNode()],
          'target-flow',
        ),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'intent-draft-invalid' })
  })

  test('a literal env value is refused as a closed secret carrier (RFC-253 T28)', async () => {
    const { manifest } = await mounted()
    await expect(
      applyAs(
        plain,
        updateBundle(
          [
            { id: 'in1', kind: 'input', inputKey: 'k' },
            sentScriptNode({ env: { TOKEN: 'plaintext-credential' } }),
          ],
          'target-flow',
        ),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'intent-draft-invalid' })
  })

  test('ADDING a brand-new script node to an existing workflow is refused', async () => {
    const { manifest } = await mounted()
    await expect(
      applyAs(
        plain,
        updateBundle(
          [
            { id: 'in1', kind: 'input', inputKey: 'k' },
            sentScriptNode(),
            { ...SCRIPT_NODE_NO_ENV, id: 'sc2', script: 'print("new")' },
          ],
          'target-flow',
        ),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'script-author-forbidden' })
  })
})

describe('boundary: the same rules for a code-host-call node', () => {
  async function mountedCodeHost(): Promise<{ id: string; manifest: IntentContextManifest }> {
    const wf = await seedWorkflow('ch-flow', PLAIN, {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [{ id: 'in1', kind: 'input', inputKey: 'k' }, { ...CODE_HOST_NODE }],
      edges: [],
    })
    return { id: wf.id, manifest: manifestFor(wf.id, wf.version) }
  }

  /** Same rule as the script node: omit the redacted keys, never echo them. */
  function sentCodeHost(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const { params: _p, ...rest } = CODE_HOST_NODE
    return { ...rest, ...extra }
  }

  test('copying the masked node back keeps the real params in storage', async () => {
    const { id, manifest } = await mountedCodeHost()
    await applyAs(
      plain,
      updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }, sentCodeHost()], 'ch-flow'),
      manifest,
    )
    const node = (await storedNodes(id)).find((n) => n.kind === 'code-host-call')!
    expect(node.params).toEqual({ mr: '7', body: 'hello' })
  })

  test('deleting it is refused', async () => {
    const { manifest } = await mountedCodeHost()
    await expect(
      applyAs(
        plain,
        updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }], 'ch-flow'),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'code-host-author-forbidden' })
  })

  // provider / action / allowDestructive / timeoutMs are projected but never
  // rehydrated — they decide WHAT the platform sends with the admin token.
  const untouchable: Array<[string, Record<string, unknown>]> = [
    ['provider', { provider: 'github' }],
    ['action', { action: 'mr.merge' }],
    ['allowDestructive', { allowDestructive: true }],
    ['timeoutMs', { timeoutMs: 1000 }],
  ]
  for (const [field, patch] of untouchable) {
    test(`changing \`${field}\` is refused`, async () => {
      const { id, manifest } = await mountedCodeHost()
      await expect(
        applyAs(
          plain,
          updateBundle(
            [{ id: 'in1', kind: 'input', inputKey: 'k' }, sentCodeHost(patch)],
            'ch-flow',
          ),
          manifest,
        ),
      ).rejects.toMatchObject({ code: 'code-host-author-forbidden' })
      const node = (await storedNodes(id)).find((n) => n.kind === 'code-host-call')!
      expect(node.provider).toBe('gitlab')
      expect(node.action).toBe('comment.create')
    })
  }

  test('a user with the grant MAY change what an ungranted user may not', async () => {
    const wf = await seedWorkflow('ch-flow', BOSS, {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [{ id: 'in1', kind: 'input', inputKey: 'k' }, { ...CODE_HOST_NODE }],
      edges: [],
    })
    await applyAs(
      boss,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          { ...CODE_HOST_NODE, action: 'mr.approve', params: { mr: '9' } },
        ],
        'ch-flow',
      ),
      manifestFor(wf.id, wf.version),
    )
    const node = (await storedNodes(wf.id)).find((n) => n.kind === 'code-host-call')!
    expect(node.action).toBe('mr.approve')
    expect(node.params).toEqual({ mr: '9' })
  })
})

// ---------------------------------------------------------------------------
// The gate must not over-reach. Everything above proves it says NO in the right
// places; this proves it stays silent everywhere else — which is the larger
// surface by far, and the one whose breakage would make the intent builder
// useless for ordinary users rather than merely restricted.
//
// Both gates short-circuit on "no node of this kind on either side"
// (scriptAuthorGate.ts:70-75, codeHostAuthorGate.ts:54-59), so these are the
// tests that would catch that short-circuit being lost.
// ---------------------------------------------------------------------------
describe('normal: the author gates do not touch ordinary work', () => {
  test('a plain user creates an ordinary workflow', async () => {
    const receipt = (await applyAs(
      plain,
      createBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'topic' },
          { id: 'out1', kind: 'output', ports: [] },
        ],
        'ordinary-flow',
      ),
    )) as { applied: unknown[] }
    expect(receipt.applied.length).toBe(1)
    expect((await db.select().from(workflows)).length).toBe(1)
  })

  test('a plain user creates a workflow with an empty node list', async () => {
    const receipt = (await applyAs(plain, createBundle([], 'empty-flow'))) as {
      applied: unknown[]
    }
    expect(receipt.applied.length).toBe(1)
  })

  test('a plain user updates a workflow that has no privileged node', async () => {
    const wf = await seedWorkflow('plain-flow', PLAIN, {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [{ id: 'in1', kind: 'input', inputKey: 'k' }],
      edges: [],
    })
    await applyAs(
      plain,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          { id: 'out1', kind: 'output', ports: [] },
        ],
        'plain-flow',
      ),
      manifestFor(wf.id, wf.version),
    )
    expect((await storedNodes(wf.id)).some((n) => n.id === 'out1')).toBe(true)
  })

  test('a plain user may delete an ORDINARY node from a workflow that also has a script', async () => {
    // The privileged node stays untouched; the deletion targets a normal node.
    // If the gate compared whole definitions instead of the sensitive
    // projection, this legitimate edit would 403.
    const wf = await seedWorkflow(
      'mixed-flow',
      PLAIN,
      storedDefinition([{ id: 'out1', kind: 'output', ports: [] }]),
    )
    await applyAs(
      plain,
      updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()], 'mixed-flow'),
      manifestFor(wf.id, wf.version),
    )
    const nodes = await storedNodes(wf.id)
    expect(nodes.some((n) => n.id === 'out1')).toBe(false)
    expect(nodes.find((n) => n.kind === 'script')?.script).toBe(SCRIPT_NODE.script)
  })

  test('a plain user may rename a workflow that contains a script node', async () => {
    const wf = await seedWorkflow('old-name', PLAIN, storedDefinition())
    await applyAs(
      plain,
      updateBundle(
        [{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()],
        'a new human name',
      ),
      manifestFor(wf.id, wf.version),
    )
    const row = (await db.select().from(workflows).where(eq(workflows.id, wf.id)))[0]
    expect(row!.name).toBe('a new human name')
  })
})

// ---------------------------------------------------------------------------
// The nested-field ambiguity. `env` is an OBJECT whose VALUES carry the marker,
// so "omit what is redacted" has two readings: drop `env`, or drop `TOKEN`
// inside it. Only one of them is safe, and the doc now says which — these tests
// pin the actual tolerance so the wording can be checked against reality.
// ---------------------------------------------------------------------------
describe('boundary: how much of a redacted nested field may be sent', () => {
  async function mountedScript(): Promise<{ id: string; manifest: IntentContextManifest }> {
    const wf = await seedWorkflow('env-flow', PLAIN, storedDefinition())
    return { id: wf.id, manifest: manifestFor(wf.id, wf.version) }
  }

  test('omitting the whole `env` field restores it from storage', async () => {
    const { id, manifest } = await mountedScript()
    await applyAs(
      plain,
      updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()], 'env-flow'),
      manifest,
    )
    expect((await storedNodes(id)).find((n) => n.kind === 'script')?.env).toEqual({
      TOKEN: 'real-value-in-storage',
    })
  })

  // Tolerated, because rehydration keys off the FIELD being absent-or-different
  // rather than off its shape — but the doc still says "omit the field", since
  // this form only works by accident of the same overwrite.
  test('an emptied `env` object is also overwritten from storage, not refused', async () => {
    const { id, manifest } = await mountedScript()
    await applyAs(
      plain,
      updateBundle(
        [{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode({ env: {} })],
        'env-flow',
      ),
      manifest,
    )
    expect((await storedNodes(id)).find((n) => n.kind === 'script')?.env).toEqual({
      TOKEN: 'real-value-in-storage',
    })
  })

  // The reading the doc must steer away from: keeping the inner key and its
  // marker. This is refused, and by the SECRET scanner rather than the author
  // gate — so the error would not even mention permissions.
  test('keeping the inner key with its marker is refused', async () => {
    const { manifest } = await mountedScript()
    await expect(
      applyAs(
        plain,
        updateBundle(
          [
            { id: 'in1', kind: 'input', inputKey: 'k' },
            sentScriptNode({ env: { TOKEN: INTENT_REDACTED } }),
          ],
          'env-flow',
        ),
        manifest,
      ),
    ).rejects.toMatchObject({ code: 'intent-draft-invalid' })
  })

  test('the doc resolves the ambiguity explicitly', async () => {
    const { buildIntentDoc } = await import('../src/services/intent/intentDoc')
    const doc = buildIntentDoc({
      sessionTitle: 't',
      turns: [],
      currentDraftJson: null,
      validationErrors: [],
      pendingQuestions: [],
      hiddenDependencyNote: null,
      unavailableMountNote: null,
      envelopeNonce: 'aabbccdd11223344',
      langDirective: 'x',
      privileges: { mayAuthorScripts: false, mayAuthorCodeHostCalls: false },
    })
    expect(doc).toMatch(/OMIT these WHOLE FIELDS/)
    expect(doc).toMatch(/drop the whole/)
    expect(doc).toMatch(/do not send it\s+emptied/)
  })
})

// ---------------------------------------------------------------------------
// The other authentication channel.
//
// Everything above drives a `source: 'session'` actor. A PAT is the second way
// into this platform, and it resolves permissions through a different function
// (resolveTokenPermissions) — so "a plain user cannot author these" is only
// half an answer until the token path is checked too.
//
// It turns out to be the STRONGER half: both author points sit in
// SYSTEM_DOMAIN_POINTS, which resolveTokenPermissions deletes unconditionally
// (permission.ts:490) — so no token carries them whatever its owner's role or
// grant matrix. `intent:read` / `intent:write` are system-domain as well, so a
// token cannot even open an intent session. Asserting every preset plus an
// explicitly granted user makes that airtight rather than incidental.
// ---------------------------------------------------------------------------
describe('abnormal: no PAT can author privileged nodes, at any role', () => {
  for (const role of ['user', 'manager', 'admin'] as const) {
    test(`a ${role}'s token with EVERY grantable point still lacks both author points`, () => {
      const accountPermissions = resolveEffectiveAccountPermissions({
        role,
        additionalPermissions: [],
      })
      const perms = resolveTokenPermissions({
        accountPermissions,
        matrix: [...grantableMatrixPoints(accountPermissions)],
      })
      expect(perms.has('scripts:author')).toBe(false)
      expect(perms.has('code-host-calls:author')).toBe(false)
    })

    test(`a ${role}'s token cannot open an intent session at all`, () => {
      const accountPermissions = resolveEffectiveAccountPermissions({
        role,
        additionalPermissions: [],
      })
      const perms = resolveTokenPermissions({
        accountPermissions,
        matrix: [...grantableMatrixPoints(accountPermissions)],
      })
      expect(perms.has('intent:read')).toBe(false)
      expect(perms.has('intent:write')).toBe(false)
    })
  }

  test('the author points are system-domain, which is WHY tokens never carry them', () => {
    expect(SYSTEM_DOMAIN_POINTS).toContain('scripts:author')
    expect(SYSTEM_DOMAIN_POINTS).toContain('code-host-calls:author')
  })

  test('a user explicitly granted both author points still loses them on a PAT', () => {
    const accountPermissions = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: ['scripts:author', 'code-host-calls:author'],
    })
    const perms = resolveTokenPermissions({
      accountPermissions,
      matrix: [...grantableMatrixPoints(accountPermissions)],
    })
    expect(perms.has('scripts:author')).toBe(false)
    expect(perms.has('code-host-calls:author')).toBe(false)
  })

  test('neither author point is even offerable in a token matrix', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      const offerable = grantableMatrixPoints(
        resolveEffectiveAccountPermissions({ role, additionalPermissions: [] }),
      )
      expect(offerable).not.toContain('scripts:author')
      expect(offerable).not.toContain('code-host-calls:author')
    }
  })
})

// ---------------------------------------------------------------------------
// Codex round-2 P2 — the omission list must follow the WITHHELD kind.
//
// Rehydration is keyed on the lens, i.e. on what the actor may NOT author. The
// dump's masking is not: `maskWorkflowScriptEnv` redacts script `env` for
// EVERYONE (RFC-253 T28 — env is a closed secret carrier regardless of
// permissions). So for an actor who may author scripts but not code-host calls,
// the two diverge: they still SEE `env: {TOKEN: "‹redacted›"}`, but nothing
// will restore it. Telling them to "omit `env`" therefore does not preserve the
// field — it deletes a stored credential, through a save the gate correctly
// allows. Silent data loss, no error.
//
// The first test proves the deletion mechanism; the second pins the doc fix.
// ---------------------------------------------------------------------------
describe('boundary: omitting a field only restores it when the actor may NOT author that kind', () => {
  test('an actor WITH scripts:author who omits `env` deletes it (mechanism proof)', async () => {
    const wf = await seedWorkflow('boss-flow', BOSS, storedDefinition())
    await applyAs(
      boss,
      updateBundle([{ id: 'in1', kind: 'input', inputKey: 'k' }, sentScriptNode()], 'boss-flow'),
      manifestFor(wf.id, wf.version),
    )
    const node = (await storedNodes(wf.id)).find((n) => n.kind === 'script')!
    // No rehydration happens for an authorized actor — the omission is taken
    // literally. This is correct behaviour for someone who may edit the node;
    // it is only dangerous when the DOC tells them to omit.
    expect(node.env).toBeUndefined()
  })

  test('the same actor without the omission keeps the stored value', async () => {
    const wf = await seedWorkflow('boss-flow-2', BOSS, storedDefinition())
    await applyAs(
      boss,
      updateBundle(
        [
          { id: 'in1', kind: 'input', inputKey: 'k' },
          { ...sentScriptNode(), env: { TOKEN: '‹secret›' } },
        ],
        'boss-flow-2',
      ),
      manifestFor(wf.id, wf.version),
      [
        {
          opId: 'op-1',
          slots: [
            { slotId: 'secret:op-1:/definition/nodes/1/env/TOKEN', value: 'real-value-in-storage' },
          ],
        },
      ],
    )
    const node = (await storedNodes(wf.id)).find((n) => n.kind === 'script')!
    expect(node.env).toEqual({ TOKEN: 'real-value-in-storage' })
  })
})
