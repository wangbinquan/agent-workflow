// RFC-348 D5 (AC-4 / AC-18) — RFC-306 branch ports through the intent seams.
//
// Before this RFC `branchPorts` sat in CreateAgentSchema but not in the intent
// payload: a create could not declare one, the dump never showed one, and an
// intent UPDATE wiped a stored one (resolve always sends `frontmatterExtra`, so
// prepareAgentUpdate took its explicit-extra path and skipped the sidecar
// merge). User ruling ①: omitting `branchPorts` / `outputKinds` / `role` /
// `outputWrapperPortNames` on an update keeps the stored value; `[]` / `{}` /
// `'normal'` / `{}` clear.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { canonicalIntentJson, parseIntentChangeset } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, users } from '../src/db/schema'
import { getAgentById } from '../src/services/agent'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import {
  buildIntentDumpForTest as buildIntentDump,
  intentResourceCatalogBinding,
} from './helpers/intentResourceCatalogBinding'
import { buildAgentFence, type IntentContextManifest } from '../src/services/intent/manifest'
import { intentResourceVisibility } from '../src/services/intent/resourceCatalog'
import { validateDraftChangeset } from '../src/services/intent/resolveChangeset'
import { createIntentSession } from '../src/services/intent/session'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'
import { composeSqliteIntentPersistence } from '../src/modules/intent/composition/persistence'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPersistence,
} from '../src/modules/intent/public/operations'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '../src/modules/resource-catalog/composition/intentContextAuthorization'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_bports_000000000'

let db: DbClient
let appHome: string
let persistence: IntentPersistence

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  persistence = composeSqliteIntentPersistence({
    db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-bports-'))
  mkdirSync(join(appHome, 'skills'), { recursive: true })
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

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

const deps = (): ApplyIntentDeps => ({
  db,
  appHome,
  actor,
  ...intentApplyResourceBinding(db, actor),
})

const dumpAuxiliary: IntentDumpAuxiliaryQueries = Object.freeze({
  runtimeInventory: Object.freeze({
    async list(): Promise<
      readonly { readonly name: string; readonly protocol: 'opencode'; readonly enabled: boolean }[]
    > {
      return [{ name: 'opencode', protocol: 'opencode', enabled: true }]
    },
    async resolveDefault(): Promise<{ readonly name: string; readonly protocol: 'opencode' }> {
      return { name: 'opencode', protocol: 'opencode' }
    },
  }),
  async loadAgentPorts() {
    return new Map()
  },
  platformInventory: Object.freeze({
    async listRows() {
      return []
    },
  }),
})

function createSession(message: string) {
  const catalog = intentResourceCatalogBinding(db, actor, appHome)
  return createIntentSession(persistence, intentResourceVisibility(catalog), actor, { message })
}

const createOp = (payload: Record<string, unknown>) => ({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:brancher',
      payload: {
        name: 'brancher',
        description: 'routes',
        outputs: ['ok', 'needs_fix'],
        bodyMd: 'You decide.',
        ...payload,
      },
    },
  ],
})

async function createAgent(payload: Record<string, unknown>): Promise<string> {
  const { session } = await createSession('make a router agent')
  const draft = installDraft(session.id, createOp(payload), [])
  const receipt = await applyIntentChangeset(deps(), {
    sessionId: session.id,
    clientMutationId: ulid(),
    ...draft,
    decisions: [],
  })
  const id = receipt.applied[0]?.resourceId
  if (id === undefined) throw new Error('create did not apply')
  return id
}

async function updateAgent(id: string, payload: Record<string, unknown>): Promise<void> {
  const existing = await getAgentById(db, id)
  if (existing === null) throw new Error('agent missing')
  const { session } = await createSession('tweak the router agent')
  const manifest: IntentContextManifest = [
    {
      handle: 'res#agent#1',
      resourceType: 'agent',
      resourceId: id,
      root: true,
      detail: true,
      fence: buildAgentFence(existing),
      dumpHash: 'x',
    },
  ]
  const changeset = {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'agent',
        target: 'res#agent#1',
        payload: {
          name: 'brancher',
          description: 'routes (edited)',
          outputs: ['ok', 'needs_fix'],
          bodyMd: 'You decide, carefully.',
          ...payload,
        },
      },
    ],
  }
  const draft = installDraft(session.id, changeset, manifest)
  await applyIntentChangeset(deps(), {
    sessionId: session.id,
    clientMutationId: ulid(),
    ...draft,
    decisions: [],
  })
}

describe('RFC-348 — agent branchPorts through the intent seams', () => {
  test('create declares branch ports; the draft validator rejects an undeclared one', async () => {
    const id = await createAgent({ branchPorts: ['needs_fix'] })
    const agent = await getAgentById(db, id)
    expect(agent?.branchPorts).toEqual(['needs_fix'])

    const bad = parseIntentChangeset(JSON.stringify(createOp({ branchPorts: ['nope'] })))
    if (!bad.ok) throw new Error(bad.errors.join('; '))
    const report = validateDraftChangeset([], bad.changeset)
    expect(report.errors.join('\n')).toContain('agent-branch-port-undeclared')
    expect(report.errors.join('\n')).toContain('nope')
  })

  test('an update that OMITS the sidecars keeps every stored value (user ruling ①)', async () => {
    const id = await createAgent({
      branchPorts: ['needs_fix'],
      outputKinds: { ok: 'markdown' },
      role: 'aggregator',
      outputWrapperPortNames: { ok: 'done' },
    })
    await updateAgent(id, {})
    const agent = await getAgentById(db, id)
    expect(agent?.description).toBe('routes (edited)')
    expect(agent?.branchPorts).toEqual(['needs_fix'])
    expect(agent?.outputKinds).toEqual({ ok: 'markdown' })
    expect(agent?.role).toBe('aggregator')
    expect(agent?.outputWrapperPortNames).toEqual({ ok: 'done' })
  })

  test('the explicit clear forms still clear: [] / {} / normal / {}', async () => {
    const id = await createAgent({
      branchPorts: ['needs_fix'],
      outputKinds: { ok: 'markdown' },
      role: 'aggregator',
      outputWrapperPortNames: { ok: 'done' },
    })
    await updateAgent(id, {
      branchPorts: [],
      outputKinds: {},
      role: 'normal',
      outputWrapperPortNames: {},
    })
    const agent = await getAgentById(db, id)
    expect(agent?.branchPorts ?? []).toEqual([])
    expect(Object.keys(agent?.outputKinds ?? {})).toEqual([])
    expect(agent?.role === undefined || agent?.role === 'normal').toBe(true)
    expect(Object.keys(agent?.outputWrapperPortNames ?? {})).toEqual([])
  })

  test('a mounted agent dumps its branch ports so the next turn can echo them back', async () => {
    const id = await createAgent({ branchPorts: ['needs_fix'] })
    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [{ resourceType: 'agent', resourceId: id }],
      ...dumpAuxiliary,
    })
    const mounted = dump.seedFiles.find(
      (f) => f.path.startsWith('mounted/') && f.content.includes('brancher'),
    )
    expect(mounted).toBeDefined()
    expect(mounted?.content).toContain('branchPorts:')
    expect(mounted?.content).toContain('needs_fix')
  })
})

// impl-gate r2 #1 — "omit = keep" must be checked at DRAFT time against the
// outputs the update declares, or dropping an output while keeping a stored
// branch port surfaces only at apply.
describe('RFC-348 — draft validation sees the stored branch ports of a mounted agent', () => {
  test('an update that drops an output but omits branchPorts is rejected at draft time', async () => {
    const id = await createAgent({ branchPorts: ['needs_fix'] })
    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [{ resourceType: 'agent', resourceId: id }],
      ...dumpAuxiliary,
    })
    expect(dump.agentBranchPorts.get(id)).toEqual(['needs_fix'])
    const handle = dump.manifest.find((e) => e.resourceId === id)?.handle
    if (handle === undefined) throw new Error('mounted agent has no handle')
    const parsed = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: 'update',
            resourceType: 'agent',
            target: handle,
            payload: {
              name: 'brancher',
              description: 'routes',
              outputs: ['ok'], // needs_fix dropped
              bodyMd: 'You decide.',
            },
          },
        ],
      }),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    const report = validateDraftChangeset(dump.manifest, parsed.changeset, {
      agentBranchPorts: dump.agentBranchPorts,
    })
    expect(report.errors.join('\n')).toContain('agent-branch-port-undeclared')
    expect(report.errors.join('\n')).toContain('needs_fix')
    expect(report.errors.join('\n')).toContain('the update omits branchPorts')
    // without the context the same draft would pass — the turn engine must supply it
    expect(validateDraftChangeset(dump.manifest, parsed.changeset).errors).toEqual([])
    const engineSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'services', 'intent', 'turnEngine.ts'),
      'utf8',
    )
    expect(engineSource).toContain('agentBranchPorts: dump.agentBranchPorts')
  })
})
